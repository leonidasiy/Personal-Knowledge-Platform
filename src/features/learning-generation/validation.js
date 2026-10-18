// @ts-check

import {
  isNonEmptyText,
  isPositiveInteger,
  isRecord,
} from "./contracts.js";
import { limitChoiceOptions } from "../knowledge-workflows/quiz-pair.js";

/** @import { LearningChoice, LearningDraft, LearningSymbolicStimulus, LearningTask, LearningTaskAssembly, LearningTaskKind, LearningValidationContext, LearningValidationFailure, Result } from "./contracts.js" */

const freeze = Object.freeze;
const factualKinds = new Set(["single-choice", "multiple-choice", "fill-blank"]);
const taskKinds = new Set([
  "single-choice",
  "multiple-choice",
  "fill-blank",
  "short-response",
  "case-study",
  "symbolic-midi",
  "notation",
]);

/**
 * Validate untrusted drafts and attach trusted source identity, provenance,
 * review classification, and publication status.
 * @param {unknown} drafts
 * @param {unknown} context
 * @returns {Result<readonly LearningTask[], LearningValidationFailure>}
 */
export function validateDrafts(drafts, context) {
  const checkedContext = validateContext(context);
  if (!checkedContext.ok) return checkedContext;
  if (!Array.isArray(drafts)) return invalidDraft("document");
  const ids = new Set();
  /** @type {LearningTask[]} */
  const tasks = [];
  for (const value of drafts) {
    const draft = parseDraft(value);
    if (!draft.ok) return draft;
    if (ids.has(draft.value.id)) return invalidDraft("duplicate-id");
    ids.add(draft.value.id);
    const task = validateDraft(draft.value, checkedContext.value);
    if (!task.ok) return task;
    tasks.push(task.value);
  }
  return { ok: true, value: freeze(tasks) };
}

/** @param {unknown} value @returns {Result<LearningValidationContext, LearningValidationFailure>} */
function validateContext(value) {
  if (!isRecord(value)) return invalidContext("document");
  for (const field of [
    "ownerId",
    "sourceId",
    "itemId",
    "itemVersionId",
    "contentDigest",
    "generatorVersion",
    "policyVersion",
    "samplingVersion",
    "generatedAt",
  ]) {
    if (!isNonEmptyText(value[field])) return invalidContext(field);
  }
  for (const field of ["sourceRevision", "factualSamplingRatePercent"]) {
    if (typeof value[field] !== "number" || !Number.isInteger(value[field])) {
      return invalidContext(field);
    }
  }
  const checked = /** @type {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly itemId: string, readonly itemVersionId: string, readonly contentDigest: string, readonly generatorVersion: string, readonly policyVersion: string, readonly samplingVersion: string, readonly factualSamplingRatePercent: number, readonly generatedAt: string, readonly units: readonly unknown[] }} */ (value);
  if (checked.sourceRevision < 1) return invalidContext("sourceRevision");
  if (checked.factualSamplingRatePercent < 0 || checked.factualSamplingRatePercent > 100) {
    return { ok: false, error: { kind: "LearningSamplingPolicyInvalid", field: "factualSamplingRatePercent" } };
  }
  if (!Number.isFinite(Date.parse(checked.generatedAt))) {
    return invalidContext("generatedAt");
  }
  if (!Array.isArray(checked.units) || checked.units.length === 0) return invalidContext("units");
  const units = [];
  for (const unit of checked.units) {
    if (!isRecord(unit) || !isNonEmptyText(unit.id) || !isNonEmptyText(unit.text) ||
      !Array.isArray(unit.sourceAnchorIds) || unit.sourceAnchorIds.length === 0 ||
      unit.sourceAnchorIds.some((id) => !isNonEmptyText(id))) {
      return invalidContext("units");
    }
    units.push(freeze({
      id: unit.id,
      sourceAnchorIds: freeze([.../** @type {string[]} */ (unit.sourceAnchorIds)]),
      text: unit.text,
    }));
  }
  return {
    ok: true,
    value: freeze(/** @type {LearningValidationContext} */ ({
      ownerId: checked.ownerId.trim(),
      sourceId: checked.sourceId.trim(),
      sourceRevision: checked.sourceRevision,
      itemId: checked.itemId.trim(),
      itemVersionId: checked.itemVersionId.trim(),
      contentDigest: checked.contentDigest.trim(),
      generatorVersion: checked.generatorVersion.trim(),
      policyVersion: checked.policyVersion.trim(),
      samplingVersion: checked.samplingVersion.trim(),
      factualSamplingRatePercent: checked.factualSamplingRatePercent,
      generatedAt: checked.generatedAt,
      units: freeze(units),
    })),
  };
}

/** @param {unknown} value @returns {Result<LearningDraft, LearningValidationFailure>} */
function parseDraft(value) {
  if (!isRecord(value)) return invalidDraft("document");
  if (!isNonEmptyText(value.id)) return invalidDraft("id");
  if (typeof value.kind !== "string") return invalidDraft("kind");
  if (!taskKinds.has(value.kind)) {
    return { ok: false, error: { kind: "LearningTaskKindUnsupported", value: value.kind } };
  }
  const draft = /** @type {LearningDraft} */ (value);
  return { ok: true, value: draft };
}

/** @param {LearningDraft} draft @param {LearningValidationContext} context @returns {Result<LearningTask, LearningValidationFailure>} */
function validateDraft(draft, context) {
  if (!isNonEmptyText(draft.prompt)) return invalidDraft("prompt");
  if (!isNonEmptyText(draft.explanation)) return invalidDraft("explanation");
  const draftId = /** @type {string} */ (draft.id);
  const prompt = /** @type {string} */ (draft.prompt);
  const explanation = /** @type {string} */ (draft.explanation);
  const unitIds = stringList(draft.unitIds);
  const anchorIds = stringList(draft.sourceAnchorIds);
  if (!unitIds.ok) return unitIds;
  if (!anchorIds.ok) return anchorIds;
  if (unitIds.value.length === 0) return invalidDraft("unitIds");
  if (anchorIds.value.length === 0) return invalidDraft("sourceAnchorIds");
  const units = new Map(context.units.map((unit) => [unit.id, unit]));
  const evidence = [];
  const availableAnchors = new Set();
  for (const unitId of unitIds.value) {
    const unit = units.get(unitId);
    if (unit === undefined) return ungrounded("unitIds");
    evidence.push(unit.text);
    for (const anchor of unit.sourceAnchorIds) availableAnchors.add(anchor);
  }
  for (const anchorId of anchorIds.value) {
    if (!availableAnchors.has(anchorId)) return ungrounded("sourceAnchorIds");
  }
  const kind = /** @type {LearningTaskKind} */ (draft.kind);
  /** @type {LearningTaskAssembly} */
  const base = {
    id: draftId,
    ownerId: context.ownerId,
    sourceId: context.sourceId,
    sourceRevision: context.sourceRevision,
    itemId: context.itemId,
    itemVersionId: context.itemVersionId,
    contentDigest: context.contentDigest,
    version: /** @type {const} */ (1),
    kind,
    prompt,
    explanation,
    unitIds: /** @type {[string, ...string[]]} */ ([...unitIds.value]),
    sourceAnchorIds: /** @type {[string, ...string[]]} */ ([...anchorIds.value]),
    choices: null,
    correctChoiceIds: null,
    blankId: null,
    acceptedAnswers: null,
    expectedConcepts: null,
    minimumWords: null,
    stimulus: null,
    responseKind: null,
    generatorVersion: context.generatorVersion,
    policyVersion: context.policyVersion,
    provenance: /** @type {const} */ ("provider-draft"),
    reviewRequired: !factualKinds.has(kind) || sampled(context, draftId),
    status: "pending-review",
    reviewDecision: null,
    reviewedAt: null,
    revision: /** @type {const} */ (1),
    generatedAt: context.generatedAt,
  };
  if (kind === "single-choice" || kind === "multiple-choice") {
    const choices = parseChoices(draft.choices);
    if (!choices.ok) return choices;
    const correct = stringList(draft.correctChoiceIds);
    if (!correct.ok) return correct;
    if (correct.value.length === 0 || (kind === "single-choice" && correct.value.length !== 1)) {
      return invalidAnswer("correctChoiceIds");
    }
    const choiceIds = new Set(choices.value.map((choice) => choice.id));
    if (choiceIds.size !== choices.value.length || choices.value.length < 2 ||
      correct.value.some((id) => !choiceIds.has(id))) return invalidAnswer("choices");
    const evidenceText = normalize(evidence.join(" "));
    for (const correctId of correct.value) {
      const choice = choices.value.find((candidate) => candidate.id === correctId);
      if (choice === undefined || !containsPhrase(evidenceText, normalize(choice.label))) {
        return ungrounded("correctChoiceIds");
      }
    }
    const removed = correct.value.slice(3);
    const kept = correct.value.slice(0, 3);
    base.choices = freeze(limitChoiceOptions(choices.value.filter(choice => !removed.includes(choice.id)).map(choice => ({ ...choice, key: choice.id })), kept).map(({ id, label }) => freeze({ id, label })));
    base.correctChoiceIds = /** @type {[string, ...string[]]} */ (freeze(kept));
  } else if (kind === "fill-blank") {
    if (!isNonEmptyText(draft.blankId)) return invalidDraft("blankId");
    const blankId = /** @type {string} */ (draft.blankId);
    const answers = stringList(draft.acceptedAnswers);
    if (!answers.ok || answers.value.length === 0) return invalidAnswer("acceptedAnswers");
    const evidenceText = normalize(evidence.join(" "));
    if (!answers.value.some((answer) => containsPhrase(evidenceText, normalize(answer)))) {
      return ungrounded("acceptedAnswers");
    }
    base.blankId = blankId;
    base.acceptedAnswers = /** @type {[string, ...string[]]} */ (freeze([...answers.value]));
  } else if (kind === "short-response") {
    const concepts = stringList(draft.expectedConcepts);
    if (!concepts.ok || concepts.value.length === 0) return invalidAnswer("expectedConcepts");
    if (!isPositiveInteger(draft.minimumWords)) return invalidDraft("minimumWords");
    const minimumWords = /** @type {number} */ (draft.minimumWords);
    base.expectedConcepts = /** @type {[string, ...string[]]} */ (freeze([...concepts.value]));
    base.minimumWords = minimumWords;
    base.responseKind = "text";
  } else if (kind === "case-study") {
    if (!isNonEmptyText(draft.stimulus)) return invalidDraft("stimulus");
    base.stimulus = /** @type {string} */ (draft.stimulus);
    base.responseKind = "text";
  } else {
    const stimulus = validateStimulus(draft.stimulus, kind);
    if (!stimulus.ok) return stimulus;
    base.stimulus = stimulus.value;
    base.responseKind = "text";
  }
  if (!base.reviewRequired) base.status = "published";
  return { ok: true, value: freeze(/** @type {LearningTask} */ (base)) };
}

/** @param {unknown} value @returns {Result<readonly LearningChoice[], LearningValidationFailure>} */
function parseChoices(value) {
  if (!Array.isArray(value) || value.length < 2) return invalidDraft("choices");
  /** @type {LearningChoice[]} */
  const choices = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !isNonEmptyText(candidate.id) || !isNonEmptyText(candidate.label)) {
      return invalidDraft("choices");
    }
    choices.push(freeze({ id: candidate.id.trim(), label: candidate.label.trim() }));
  }
  return { ok: true, value: freeze(choices) };
}

/** @param {unknown} value @param {LearningTaskKind} kind @returns {Result<LearningSymbolicStimulus, LearningValidationFailure>} */
function validateStimulus(value, kind) {
  if (!isRecord(value)) return invalidStimulus("document");
  if (value.representation !== (kind === "symbolic-midi" ? "midi" : "notation")) return invalidStimulus("representation");
  if (!isPositiveInteger(value.ticksPerBeat)) return invalidStimulus("ticksPerBeat");
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > 256) return invalidStimulus("events");
  const events = [];
  for (const event of value.events) {
    if (!isRecord(event) || !integerInRange(event.pitch, 0, 127) ||
      !nonNegativeInteger(event.startTick) || !isPositiveInteger(event.durationTicks) ||
      !integerInRange(event.velocity, 0, 127)) return invalidStimulus("events");
    events.push(freeze({ pitch: event.pitch, startTick: event.startTick, durationTicks: event.durationTicks, velocity: event.velocity }));
  }
  if (value.clef !== null && !isNonEmptyText(value.clef)) return invalidStimulus("clef");
  if (value.timeSignature !== null && !isNonEmptyText(value.timeSignature)) return invalidStimulus("timeSignature");
  return { ok: true, value: freeze(/** @type {LearningSymbolicStimulus} */ ({
    representation: value.representation,
    ticksPerBeat: value.ticksPerBeat,
    events: freeze(events),
    clef: value.clef === null ? null : value.clef.trim(),
    timeSignature: value.timeSignature === null ? null : value.timeSignature.trim(),
  })) };
}

/** @param {unknown} value @returns {Result<readonly string[], LearningValidationFailure>} */
function stringList(value) {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyText(item))) return invalidDraft("list");
  return { ok: true, value: freeze(/** @type {string[]} */ (value.map((item) => item.trim()))) };
}

/** @param {LearningValidationContext} context @param {string} taskId */
function sampled(context, taskId) {
  const key = [context.samplingVersion, context.ownerId, context.sourceId, context.itemId, context.itemVersionId, taskId].join("|");
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < context.factualSamplingRatePercent;
}

/** @param {string} value */
function normalize(value) {
  return value.toLocaleLowerCase("en-US").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** @param {string} haystack @param {string} needle */
function containsPhrase(haystack, needle) {
  return needle !== "" && ` ${haystack} `.includes(` ${needle} `);
}

/** @param {unknown} value @param {number} minimum @param {number} maximum */
function integerInRange(value, minimum, maximum) {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

/** @param {unknown} value */
function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** @param {string} field @returns {Result<never, LearningValidationFailure>} */
function invalidContext(field) {
  return { ok: false, error: { kind: "LearningGenerationContextInvalid", field } };
}

/** @param {string} field @returns {Result<never, LearningValidationFailure>} */
function invalidDraft(field) {
  return { ok: false, error: { kind: "LearningDraftSchemaInvalid", field } };
}

/** @param {string} field @returns {Result<never, LearningValidationFailure>} */
function invalidAnswer(field) {
  return { ok: false, error: { kind: "LearningAnswerInvalid", field } };
}

/** @param {string} field @returns {Result<never, LearningValidationFailure>} */
function ungrounded(field) {
  return { ok: false, error: { kind: "LearningDraftUngrounded", field } };
}

/** @param {string} field @returns {Result<never, LearningValidationFailure>} */
function invalidStimulus(field) {
  return { ok: false, error: { kind: "LearningSymbolicStimulusInvalid", field } };
}

export {};
