// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly relationshipScopeId: string,
 *   readonly choice: "more" | "less",
 *   readonly idempotencyKey: string,
 *   readonly occurredAt: string
 * }} PreferenceCommand
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly relationshipScopeId: string,
 *   readonly choice: "more" | "less" | "reset",
 *   readonly idempotencyKey: string,
 *   readonly occurredAt: string,
 *   readonly provenance: "explicit-user-action"
 * }} PreferenceEvent
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly relationshipScopeId: string,
 *   readonly affinity: number,
 *   readonly eventCount: number
 * }} PreferenceSnapshot
 */

/**
 * @typedef {{ readonly kind: "PreferenceScopeUnknown", readonly relationshipScopeId: string }
 * | { readonly kind: "PreferenceUnauthorized" }
 * | { readonly kind: "PreferenceAlreadyRecorded", readonly idempotencyKey: string }
 * | { readonly kind: "PreferenceCommandInvalid", readonly field: string }} PreferenceFailure
 */

/**
 * @param {PreferenceCommand} command
 * @returns {Result<PreferenceCommand, PreferenceFailure>}
 */
export function validatePreferenceCommand(command) {
  if (command.ownerId.trim() === "") {
    return { ok: false, error: { kind: "PreferenceCommandInvalid", field: "ownerId" } };
  }
  if (command.relationshipScopeId.trim() === "") {
    return {
      ok: false,
      error: { kind: "PreferenceCommandInvalid", field: "relationshipScopeId" },
    };
  }
  if (command.idempotencyKey.trim() === "") {
    return {
      ok: false,
      error: { kind: "PreferenceCommandInvalid", field: "idempotencyKey" },
    };
  }
  if (!Number.isFinite(Date.parse(command.occurredAt))) {
    return {
      ok: false,
      error: { kind: "PreferenceCommandInvalid", field: "occurredAt" },
    };
  }
  if (command.choice !== "more" && command.choice !== "less") {
    return { ok: false, error: { kind: "PreferenceCommandInvalid", field: "choice" } };
  }
  return { ok: true, value: command };
}
