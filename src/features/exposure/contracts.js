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
 *   readonly engagedMs: number,
 *   readonly idempotencyKey: string,
 *   readonly occurredAt: string
 * }} ExposureCommand
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly candidateId: string,
 *   readonly contentVersion: number,
 *   readonly engagedMs: number,
 *   readonly idempotencyKey: string,
 *   readonly occurredAt: string,
 *   readonly provenance: "qualified-view"
 * }} ExposureEvent
 */

/**
 * @typedef {{ readonly kind: "ExposureCommandInvalid", readonly field: string }
 * | { readonly kind: "ExposureCandidateUnknown", readonly candidateId: string }
 * | { readonly kind: "ExposureBelowThreshold", readonly minimumMs: number }
 * | { readonly kind: "ExposureAlreadyRecorded", readonly idempotencyKey: string }} ExposureFailure
 */

/**
 * @param {ExposureCommand} command
 * @returns {Result<ExposureCommand, ExposureFailure>}
 */
export function validateExposureCommand(command) {
  if (command.ownerId.trim() === "") {
    return { ok: false, error: { kind: "ExposureCommandInvalid", field: "ownerId" } };
  }
  if (command.candidateId.trim() === "") {
    return { ok: false, error: { kind: "ExposureCommandInvalid", field: "candidateId" } };
  }
  if (!Number.isInteger(command.contentVersion) || command.contentVersion < 1) {
    return {
      ok: false,
      error: { kind: "ExposureCommandInvalid", field: "contentVersion" },
    };
  }
  if (!Number.isFinite(command.engagedMs) || command.engagedMs < 0) {
    return { ok: false, error: { kind: "ExposureCommandInvalid", field: "engagedMs" } };
  }
  if (command.idempotencyKey.trim() === "") {
    return {
      ok: false,
      error: { kind: "ExposureCommandInvalid", field: "idempotencyKey" },
    };
  }
  if (!Number.isFinite(Date.parse(command.occurredAt))) {
    return { ok: false, error: { kind: "ExposureCommandInvalid", field: "occurredAt" } };
  }
  return { ok: true, value: command };
}
