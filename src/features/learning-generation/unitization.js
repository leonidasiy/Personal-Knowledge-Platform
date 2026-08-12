// @ts-check

import {
  isNonEmptyText,
  isPositiveInteger,
  isRecord,
} from "./contracts.js";

/** @import { LearningUnit, LearningUnitizationCommand, LearningUnitizationFailure, LearningUnitizationPolicy, LearningUnitizationResult, Result } from "./contracts.js" */

const freeze = Object.freeze;
const sentenceEndings = new Set([".", "!", "?", "。", "！", "？"]);

/**
 * Deterministically split one source item into bounded, source-anchored units.
 * Offsets refer to the normalized LF text returned by this function.
 * @param {unknown} value
 * @returns {Result<LearningUnitizationResult, LearningUnitizationFailure>}
 */
export function unitize(value) {
  const command = validateCommand(value);
  if (!command.ok) return command;
  if (command.value.content.trim() === "") {
    return { ok: false, error: { kind: "LearningContentEmpty" } };
  }
  if (!validUnicode(command.value.content)) {
    return { ok: false, error: { kind: "LearningContentEncodingInvalid" } };
  }
  const normalized = command.value.content.replace(/\r\n?/g, "\n");
  if (normalized.length > command.value.policy.maximumContentCharacters) {
    return {
      ok: false,
      error: {
        kind: "LearningUnitizationLimitExceeded",
        field: "content",
        maximum: command.value.policy.maximumContentCharacters,
        actual: normalized.length,
      },
    };
  }

  const ranges = paragraphRanges(normalized).flatMap((paragraph) =>
    sentenceRanges(normalized, paragraph.start, paragraph.end)
  );
  /** @type {{ readonly start: number, readonly end: number }[]} */
  const boundedRanges = [];
  for (const range of ranges) {
    const bounded = splitRange(normalized, range, command.value.policy);
    if (!bounded.ok) return bounded;
    boundedRanges.push(...bounded.value);
  }
  if (boundedRanges.length === 0) {
    return { ok: false, error: { kind: "LearningContentEmpty" } };
  }
  if (boundedRanges.length > command.value.policy.maximumUnits) {
    return {
      ok: false,
      error: {
        kind: "LearningUnitizationLimitExceeded",
        field: "units",
        maximum: command.value.policy.maximumUnits,
        actual: boundedRanges.length,
      },
    };
  }

  /** @type {LearningUnit[]} */
  const units = [];
  for (const [index, range] of boundedRanges.entries()) {
    const ordinal = index + 1;
    const id = unitId(command.value, ordinal);
    const anchorId = `${id}:anchor`;
    const text = normalized.slice(range.start, range.end);
    const wordCount = words(text).length;
    if (
      text === "" || range.start < 0 || range.end <= range.start ||
      normalized.slice(range.start, range.end) !== text || wordCount < 1
    ) {
      return { ok: false, error: { kind: "LearningUnitAnchorInvalid", unitId: id } };
    }
    units.push(freeze({
      id,
      ownerId: command.value.ownerId,
      sourceId: command.value.sourceId,
      sourceRevision: command.value.sourceRevision,
      itemId: command.value.itemId,
      itemVersionId: command.value.itemVersionId,
      contentDigest: command.value.contentDigest,
      ordinal,
      text,
      startOffset: range.start,
      endOffset: range.end,
      wordCount,
      sourceAnchorIds: freeze(/** @type {[string]} */ ([anchorId])),
      provenance: "deterministic-unitization",
      policyVersion: command.value.policy.version,
    }));
  }
  return {
    ok: true,
    value: freeze({
      ownerId: command.value.ownerId,
      sourceId: command.value.sourceId,
      sourceRevision: command.value.sourceRevision,
      itemId: command.value.itemId,
      itemVersionId: command.value.itemVersionId,
      contentDigest: command.value.contentDigest,
      policyVersion: command.value.policy.version,
      units: freeze(units),
    }),
  };
}

/** @param {unknown} value @returns {Result<LearningUnitizationCommand, LearningUnitizationFailure>} */
function validateCommand(value) {
  if (!isRecord(value)) return invalidCommand("command");
  for (const field of [
    "ownerId",
    "sourceId",
    "itemId",
    "itemVersionId",
    "contentDigest",
  ]) {
    if (!isNonEmptyText(value[field])) return invalidCommand(field);
  }
  if (typeof value.content !== "string") return invalidCommand("content");
  if (!isPositiveInteger(value.sourceRevision)) {
    return invalidCommand("sourceRevision");
  }
  if (value.sourceKind !== "public-text" && value.sourceKind !== "manual-transcript") {
    return invalidCommand("sourceKind");
  }
  const policy = validatePolicy(value.policy);
  if (!policy.ok) return policy;
  const checked = /** @type {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly itemId: string, readonly itemVersionId: string, readonly contentDigest: string, readonly sourceKind: "public-text" | "manual-transcript", readonly content: string }} */ (value);
  return {
    ok: true,
    value: freeze(/** @type {LearningUnitizationCommand} */ ({
      ownerId: checked.ownerId.trim(),
      sourceId: checked.sourceId.trim(),
      sourceRevision: checked.sourceRevision,
      itemId: checked.itemId.trim(),
      itemVersionId: checked.itemVersionId.trim(),
      contentDigest: checked.contentDigest.trim(),
      sourceKind: checked.sourceKind,
      content: checked.content,
      policy: policy.value,
    })),
  };
}

/** @param {unknown} value @returns {Result<LearningUnitizationPolicy, LearningUnitizationFailure>} */
function validatePolicy(value) {
  if (!isRecord(value)) return invalidPolicy("policy");
  for (const field of [
    "maximumContentCharacters",
    "maximumWordsPerUnit",
    "maximumUnits",
    "maximumExcerptCharacters",
  ]) {
    if (!isPositiveInteger(value[field])) return invalidPolicy(field);
  }
  if (!isNonEmptyText(value.version)) return invalidPolicy("version");
  return {
    ok: true,
    value: freeze(/** @type {LearningUnitizationPolicy} */ ({
      version: value.version.trim(),
      maximumContentCharacters: value.maximumContentCharacters,
      maximumWordsPerUnit: value.maximumWordsPerUnit,
      maximumUnits: value.maximumUnits,
      maximumExcerptCharacters: value.maximumExcerptCharacters,
    })),
  };
}

/** @param {string} text @returns {{ readonly start: number, readonly end: number }[]} */
function paragraphRanges(text) {
  /** @type {{ readonly start: number, readonly end: number }[]} */
  const ranges = [];
  const matcher = /\S(?:[\s\S]*?\S)?(?=\n\s*\n|$)/g;
  for (const match of text.matchAll(matcher)) {
    if (match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/** @param {string} text @param {number} start @param {number} end @returns {{ readonly start: number, readonly end: number }[]} */
function sentenceRanges(text, start, end) {
  /** @type {{ readonly start: number, readonly end: number }[]} */
  const ranges = [];
  let current = start;
  for (let index = start; index < end; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (sentenceEndings.has(character) && (next === undefined || /\s/u.test(next))) {
      const trimmed = trimRange(text, current, index + 1);
      if (trimmed !== null) ranges.push(trimmed);
      current = index + 1;
    }
  }
  const trailing = trimRange(text, current, end);
  if (trailing !== null) ranges.push(trailing);
  return ranges;
}

/** @param {string} text @param {{ readonly start: number, readonly end: number }} range @param {LearningUnitizationPolicy} policy @returns {Result<readonly { readonly start: number, readonly end: number }[], LearningUnitizationFailure>} */
function splitRange(text, range, policy) {
  const matches = [...text.slice(range.start, range.end).matchAll(/\S+/gu)].map((match) => ({
    start: range.start + (match.index ?? 0),
    end: range.start + (match.index ?? 0) + match[0].length,
  }));
  /** @type {{ readonly start: number, readonly end: number }[]} */
  const ranges = [];
  let groupStart = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const first = matches[groupStart];
    const last = matches[index];
    if (first === undefined || last === undefined) {
      throw new TypeError("Unitization word range invariant is broken.");
    }
    const candidate = text.slice(first.start, last.end);
    const wordCount = index - groupStart + 1;
    if (wordCount > policy.maximumWordsPerUnit || candidate.length > policy.maximumExcerptCharacters) {
      if (index === groupStart) {
        return {
          ok: false,
          error: {
            kind: "LearningUnitizationLimitExceeded",
            field: wordCount > policy.maximumWordsPerUnit ? "words" : "excerpt",
            maximum: wordCount > policy.maximumWordsPerUnit
              ? policy.maximumWordsPerUnit
              : policy.maximumExcerptCharacters,
            actual: wordCount > policy.maximumWordsPerUnit ? wordCount : candidate.length,
          },
        };
      }
      ranges.push({ start: first.start, end: matches[index - 1].end });
      groupStart = index;
    }
  }
  const first = matches[groupStart];
  const last = matches[matches.length - 1];
  if (first !== undefined && last !== undefined) {
    const candidate = text.slice(first.start, last.end);
    if (candidate.length > policy.maximumExcerptCharacters) {
      return {
        ok: false,
        error: {
          kind: "LearningUnitizationLimitExceeded",
          field: "excerpt",
          maximum: policy.maximumExcerptCharacters,
          actual: candidate.length,
        },
      };
    }
    ranges.push({ start: first.start, end: last.end });
  }
  return { ok: true, value: freeze(ranges) };
}

/** @param {string} text @param {number} start @param {number} end @returns {{ readonly start: number, readonly end: number } | null} */
function trimRange(text, start, end) {
  while (start < end && /\s/u.test(text[start] ?? "")) start += 1;
  while (end > start && /\s/u.test(text[end - 1] ?? "")) end -= 1;
  return start === end ? null : { start, end };
}

/** @param {string} text @returns {readonly string[]} */
function words(text) {
  return [...text.matchAll(/\S+/gu)].map((match) => match[0]);
}

/** @param {LearningUnitizationCommand} command @param {number} ordinal */
function unitId(command, ordinal) {
  return `unit:${encodeURIComponent(command.sourceId)}:${encodeURIComponent(command.itemId)}:${encodeURIComponent(command.itemVersionId)}:${ordinal}`;
}

/** @param {string} value */
function validUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return false;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

/** @param {string} field @returns {Result<never, LearningUnitizationFailure>} */
function invalidCommand(field) {
  return { ok: false, error: { kind: "LearningUnitizationCommandInvalid", field } };
}

/** @param {string} field @returns {Result<never, LearningUnitizationFailure>} */
function invalidPolicy(field) {
  return { ok: false, error: { kind: "LearningUnitizationPolicyInvalid", field } };
}

export {};
