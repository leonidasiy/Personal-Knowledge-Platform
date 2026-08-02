// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/** @typedef {"learner-notes" | "publisher-transcript" | "user-original"} EvidenceSourceKind */
/** @typedef {"note" | "transcript" | "excerpt" | "derived-text"} EvidenceContentForm */
/** @typedef {"private-local" | "rights-cleared"} EvidenceRetention */
/** @typedef {"active" | "revoked" | "deleted"} EvidenceStatus */

/**
 * @typedef {{
 *   readonly kind: string,
 *   readonly value: string
 * }} EvidenceAnchor
 */

/**
 * @typedef {{
 *   readonly label: string,
 *   readonly sourceUrl: string
 * }} EvidenceAttribution
 */

/**
 * @typedef {{
 *   readonly basis: string,
 *   readonly reference: string,
 *   readonly assessedAt: string,
 *   readonly expiresAt: string | null,
 *   readonly storageAllowed: true,
 *   readonly displayAllowed: true,
 *   readonly transformationAllowed: true
 * }} EvidenceRightsBasis
 */

/**
 * @typedef {{
 *   readonly method: string,
 *   readonly sourceReference: string,
 *   readonly acquiredAt: string,
 *   readonly digest: string
 * }} EvidenceProvenance
 */

/**
 * @typedef {{
 *   readonly recordId: string,
 *   readonly ownerId: string,
 *   readonly evidenceId: string,
 *   readonly contentVersion: number,
 *   readonly sourceKind: EvidenceSourceKind,
 *   readonly contentForm: EvidenceContentForm,
 *   readonly retention: EvidenceRetention,
 *   readonly status: "active",
 *   readonly content: string,
 *   readonly anchors: readonly EvidenceAnchor[],
 *   readonly attribution: EvidenceAttribution | null,
 *   readonly rights: EvidenceRightsBasis,
 *   readonly provenance: readonly EvidenceProvenance[],
 *   readonly reason: null,
 *   readonly replacesVersion: number | null,
 *   readonly occurredAt: string,
 *   readonly idempotencyKey: string
 * }} ActiveEvidenceContent
 */

/**
 * @typedef {{
 *   readonly recordId: string,
 *   readonly ownerId: string,
 *   readonly evidenceId: string,
 *   readonly contentVersion: number,
 *   readonly sourceKind: EvidenceSourceKind,
 *   readonly contentForm: EvidenceContentForm,
 *   readonly retention: EvidenceRetention,
 *   readonly status: "revoked" | "deleted",
 *   readonly content: null,
 *   readonly anchors: readonly [],
 *   readonly attribution: null,
 *   readonly rights: null,
 *   readonly provenance: readonly [],
 *   readonly reason: string,
 *   readonly replacesVersion: number,
 *   readonly occurredAt: string,
 *   readonly idempotencyKey: string
 * }} EvidenceContentTombstone
 */

/** @typedef {ActiveEvidenceContent | EvidenceContentTombstone} EvidenceContentRecord */

/**
 * @typedef {{
 *   readonly kind: "EvidenceCommandInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "EvidenceSourceKindUnknown",
 *   readonly sourceKind: string
 * } | {
 *   readonly kind: "EvidenceAttributionMissing",
 *   readonly evidenceId: string
 * } | {
 *   readonly kind: "EvidenceAttributionAmbiguous",
 *   readonly evidenceId: string
 * } | {
 *   readonly kind: "EvidenceRightsMissing",
 *   readonly field: string
 * } | {
 *   readonly kind: "EvidenceRightsNotPermitted",
 *   readonly field: string
 * } | {
 *   readonly kind: "EvidenceRightsExpired",
 *   readonly evidenceId: string,
 *   readonly expiresAt: string
 * } | {
 *   readonly kind: "EvidenceProvenanceInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "EvidenceContentMissing",
 *   readonly evidenceId: string
 * } | {
 *   readonly kind: "EvidenceContentAmbiguous",
 *   readonly evidenceId: string
 * } | {
 *   readonly kind: "EvidenceOwnerMismatch",
 *   readonly ownerId: string,
 *   readonly evidenceId: string
 * } | {
 *   readonly kind: "EvidenceVersionStale",
 *   readonly evidenceId: string,
 *   readonly expected: number,
 *   readonly actual: number
 * } | {
 *   readonly kind: "EvidenceConflict",
 *   readonly evidenceId: string,
 *   readonly field: string
 * } | {
 *   readonly kind: "EvidenceIdFactoryInvalid",
 *   readonly operation: string
 * }} EvidenceFailure
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
export function isNonEmptyText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value @returns {value is EvidenceSourceKind} */
export function isEvidenceSourceKind(value) {
  return value === "learner-notes" || value === "publisher-transcript" ||
    value === "user-original";
}

/** @param {unknown} value @returns {value is EvidenceContentForm} */
export function isEvidenceContentForm(value) {
  return value === "note" || value === "transcript" || value === "excerpt" ||
    value === "derived-text";
}

/** @param {EvidenceSourceKind} sourceKind @param {EvidenceContentForm} contentForm */
export function contentFormMatchesSource(sourceKind, contentForm) {
  if (sourceKind === "learner-notes") return contentForm === "note";
  if (sourceKind === "publisher-transcript") {
    return contentForm === "transcript" || contentForm === "excerpt";
  }
  return contentForm === "derived-text";
}
