// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly candidateId: string,
 *   readonly contentVersion: number,
 *   readonly idempotencyKey: string,
 *   readonly occurredAt: string
 * }} StudyCommand
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly candidateId: string,
 *   readonly contentVersion: number,
 *   readonly idempotencyKey: string,
 *   readonly occurredAt: string,
 *   readonly provenance: "manual-study"
 * }} StudyEvent
 */

/**
 * @typedef {{ readonly kind: "StudyCommandInvalid", readonly field: string }
 * | { readonly kind: "StudyAlreadyRecorded", readonly idempotencyKey: string }
 * | { readonly kind: "StudyCandidateUnknown", readonly candidateId: string }
 * | { readonly kind: "StudyPersistenceFailed", readonly recordId: string }} StudyFailure
 */

/**
 * @typedef {{ readonly kind: "StudyWriteUnavailable" }} StudyWriteFailure
 * @typedef {(command: StudyCommand) => Promise<Result<true, StudyWriteFailure>>} StudyEventWriter
 */

/**
 * @param {unknown} value
 * @returns {Result<StudyCommand, Extract<StudyFailure, { kind: "StudyCommandInvalid" }>>}
 */
export function validateStudyCommand(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("document");
  }
  const command =
    /** @type {{ ownerId?: unknown, candidateId?: unknown, contentVersion?: unknown, idempotencyKey?: unknown, occurredAt?: unknown }} */ (
      value
    );
  if (typeof command.ownerId !== "string" || command.ownerId.trim() === "") {
    return invalid("ownerId");
  }
  if (
    typeof command.candidateId !== "string" ||
    command.candidateId.trim() === ""
  ) {
    return invalid("candidateId");
  }
  if (
    typeof command.contentVersion !== "number" ||
    !Number.isInteger(command.contentVersion) ||
    command.contentVersion < 1
  ) {
    return invalid("contentVersion");
  }
  if (
    typeof command.idempotencyKey !== "string" ||
    command.idempotencyKey.trim() === ""
  ) {
    return invalid("idempotencyKey");
  }
  if (
    typeof command.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(command.occurredAt))
  ) {
    return invalid("occurredAt");
  }
  return {
    ok: true,
    value: Object.freeze({
      ownerId: command.ownerId,
      candidateId: command.candidateId,
      contentVersion: command.contentVersion,
      idempotencyKey: command.idempotencyKey,
      occurredAt: command.occurredAt,
    }),
  };
}

/**
 * @param {string} field
 * @returns {Result<never, Extract<StudyFailure, { kind: "StudyCommandInvalid" }>>}
 */
function invalid(field) {
  return { ok: false, error: { kind: "StudyCommandInvalid", field } };
}

export {};
