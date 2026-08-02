// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

export const RECORD_KINDS = /** @type {const} */ ([
  "catalog",
  "feed_session",
  "qualified_exposure",
  "manual_study",
  "preference_event",
  "review_event",
  "review_quarantine",
  "memory_state",
  "daily_learning_settings",
  "daily_study_set",
  "prompt_generation",
  "daily_recall_cohort",
  "grade_finalization",
  "discovery_source",
  "discovery_run",
  "discovery_item_version",
  "discovery_rights_assessment",
  "discovery_triage",
  "discovery_evidence_association",
  "discovery_evidence_content",
]);

export const LOCAL_DATA_SCHEMA_VERSION = 5;

/** @typedef {(typeof RECORD_KINDS)[number]} RecordKind */

const RECORD_KIND_SET = new Set(RECORD_KINDS);

/**
 * @param {unknown} value
 * @returns {value is RecordKind}
 */
export function isRecordKind(value) {
  return typeof value === "string" &&
    RECORD_KIND_SET.has(/** @type {RecordKind} */ (value));
}

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly kind: RecordKind,
 *   readonly payloadJson: string,
 *   readonly recordedAt: string
 * }} PersistenceEnvelope
 */

/**
 * @typedef {{ readonly kind: "PersistenceUnavailable" }
 * | { readonly kind: "PersistenceOpenFailed", readonly context: string }
 * | { readonly kind: "PersistenceWriteFailed", readonly recordId: string }
 * | { readonly kind: "PersistenceDuplicate", readonly recordId: string }
 * | { readonly kind: "PersistenceReadFailed", readonly recordKind: RecordKind }
 * | { readonly kind: "PersistenceEraseFailed", readonly ownerId: string }
 * | { readonly kind: "PersistenceRecordKindInvalid", readonly recordId: string, readonly recordKind: string }
 * | { readonly kind: "PersistencePayloadInvalid", readonly recordId: string }} PersistenceFailure
 */

/**
 * @param {PersistenceEnvelope} envelope
 * @returns {Result<PersistenceEnvelope, PersistenceFailure>}
 */
export function validateEnvelope(envelope) {
  const recordId = typeof envelope.id === "string" ? envelope.id : "";
  if (!isRecordKind(envelope.kind)) {
    return {
      ok: false,
      error: {
        kind: "PersistenceRecordKindInvalid",
        recordId,
        recordKind: typeof envelope.kind === "string" ? envelope.kind : "",
      },
    };
  }
  if (
    typeof envelope.id !== "string" ||
    envelope.id.trim() === "" ||
    typeof envelope.ownerId !== "string" ||
    envelope.ownerId.trim() === "" ||
    typeof envelope.recordedAt !== "string" ||
    typeof envelope.payloadJson !== "string" ||
    !Number.isFinite(Date.parse(envelope.recordedAt))
  ) {
    return {
      ok: false,
      error: { kind: "PersistencePayloadInvalid", recordId },
    };
  }
  try {
    JSON.parse(envelope.payloadJson);
  } catch {
    return {
      ok: false,
      error: { kind: "PersistencePayloadInvalid", recordId },
    };
  }
  return { ok: true, value: envelope };
}
