// @ts-check

/** @import { ContentExtentEvidence, ContentExtentPolicy, ContentLengthBand, ContentSegment, PromptBankFailure, Result } from "./contracts.js" */

/**
 * @param {ContentExtentEvidence} evidence
 * @param {ContentExtentPolicy} policy
 * @returns {Result<ContentLengthBand, PromptBankFailure>}
 */
export function classifyLength(evidence, policy) {
  const policyValidation = validatePolicy(policy);
  if (!policyValidation.ok) return policyValidation;
  if (
    evidence.ownerId.trim() === "" || evidence.contentId.trim() === "" ||
    evidence.evidenceVersion.trim() === "" || evidence.provenance.trim() === ""
  ) {
    return invalidEvidence("identity");
  }
  for (
    const [field, value] of [
      ["contentVersion", evidence.contentVersion],
      ["wordCount", evidence.wordCount],
      ["sentenceCount", evidence.sentenceCount],
      ["paragraphCount", evidence.paragraphCount],
    ]
  ) {
    if (!Number.isInteger(value) || value < 1) return invalidEvidence(field);
  }
  if (
    evidence.sourceKind === "audio-video" &&
    (evidence.transcriptSource === null ||
      evidence.transcriptSource.trim() === "")
  ) {
    return {
      ok: false,
      error: {
        kind: "MaterialLengthEvidenceMissing",
        contentId: evidence.contentId,
      },
    };
  }
  if (evidence.wordCount > policy.maxUnitWords) {
    return {
      ok: false,
      error: {
        kind: "MaterialLengthBandUnknown",
        contentId: evidence.contentId,
      },
    };
  }
  if (
    evidence.wordCount <= policy.shortMaxWords &&
    evidence.sentenceCount <= policy.shortMaxSentences
  ) {
    return { ok: true, value: "short" };
  }
  if (
    evidence.wordCount <= policy.mediumMaxWords &&
    evidence.paragraphCount <= policy.mediumMaxParagraphs
  ) {
    return { ok: true, value: "medium" };
  }
  return { ok: true, value: "long" };
}

/**
 * @param {ContentLengthBand} band
 * @param {number} distinctAnchorCount
 * @returns {Result<number, PromptBankFailure>}
 */
export function adaptiveYield(band, distinctAnchorCount) {
  if (!Number.isInteger(distinctAnchorCount) || distinctAnchorCount < 0) {
    return {
      ok: false,
      error: { kind: "PromptYieldPolicyInvalid", field: "anchorCount" },
    };
  }
  const minimum = band === "long" ? 2 : 1;
  const maximum = band === "short" ? 1 : band === "medium" ? 3 : 6;
  if (distinctAnchorCount < minimum) {
    return {
      ok: false,
      error: {
        kind: "PromptYieldEvidenceMismatch",
        required: minimum,
        available: distinctAnchorCount,
      },
    };
  }
  return {
    ok: true,
    value: Math.min(maximum, Math.max(minimum, distinctAnchorCount)),
  };
}

/**
 * @param {readonly ContentSegment[]} segments
 * @param {ContentExtentPolicy} policy
 * @returns {Result<readonly ContentSegment[], PromptBankFailure>}
 */
export function validateSegments(segments, policy) {
  const policyValidation = validatePolicy(policy);
  if (!policyValidation.ok) return policyValidation;
  if (segments.length > policy.maxSegmentsPerCommand) {
    return {
      ok: false,
      error: {
        kind: "MaterialSegmentationLimitExceeded",
        maximum: policy.maxSegmentsPerCommand,
        actual: segments.length,
      },
    };
  }
  let previousEnd = 0;
  const ids = new Set();
  for (const segment of segments) {
    const size = segment.endWord - segment.startWord;
    if (
      segment.id.trim() === "" || ids.has(segment.id) ||
      !Number.isInteger(segment.startWord) ||
      !Number.isInteger(segment.endWord) ||
      segment.startWord < previousEnd || size < 1 ||
      size > policy.maxUnitWords ||
      segment.sourceAnchorIds.length === 0
    ) {
      return {
        ok: false,
        error: {
          kind: "MaterialSegmentationInvalid",
          segmentId: segment.id,
        },
      };
    }
    ids.add(segment.id);
    previousEnd = segment.endWord;
  }
  return { ok: true, value: Object.freeze([...segments]) };
}

/**
 * @param {ContentExtentPolicy} policy
 * @returns {Result<true, PromptBankFailure>}
 */
function validatePolicy(policy) {
  const values = [
    policy.shortMaxWords,
    policy.shortMaxSentences,
    policy.mediumMaxWords,
    policy.mediumMaxParagraphs,
    policy.maxUnitWords,
    policy.maxSegmentsPerCommand,
  ];
  if (
    policy.version.trim() === "" ||
    values.some((value) => !Number.isInteger(value) || value < 1)
  ) {
    return {
      ok: false,
      error: { kind: "PromptYieldPolicyInvalid", field: "extentPolicy" },
    };
  }
  if (
    policy.shortMaxWords >= policy.mediumMaxWords ||
    policy.mediumMaxWords >= policy.maxUnitWords
  ) {
    return {
      ok: false,
      error: { kind: "PromptYieldPolicyInvalid", field: "wordBoundaries" },
    };
  }
  return { ok: true, value: true };
}

/**
 * @param {string} field
 * @returns {Result<never, PromptBankFailure>}
 */
function invalidEvidence(field) {
  return {
    ok: false,
    error: { kind: "MaterialLengthEvidenceInvalid", field },
  };
}
