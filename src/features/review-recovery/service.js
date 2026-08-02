// @ts-check

const freeze = Object.freeze;

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly recordIds: readonly string[],
 *   readonly idempotencyKey: string,
 *   readonly createdAt: string,
 *   readonly version: 1
 * }} ReviewQuarantine
 */

/**
 * @typedef {{
 *   readonly kind: "ReviewRecoveryCommandInvalid",
 *   readonly field: "ownerId" | "recordIds" | "idempotencyKey" | "createdAt" | "version"
 * } | {
 *   readonly kind: "ReviewBackupExportFailed"
 * } | {
 *   readonly kind: "ReviewQuarantineWriteFailed"
 * } | {
 *   readonly kind: "ReviewRecoveryRouteUnavailable"
 * }} ReviewRecoveryFailure
 */

/**
 * @typedef {{
 *   readonly exportBackup: () => Promise<import("../../persistence/contracts.js").Result<true, { readonly kind: "ReviewBackupExportFailed" }>>,
 *   readonly prepareContinuation: () => import("../../persistence/contracts.js").Result<{ readonly commit: () => void }, { readonly kind: "ReviewRecoveryRouteUnavailable" }>,
 *   readonly persistQuarantine: (quarantine: ReviewQuarantine) => Promise<import("../../persistence/contracts.js").Result<true, { readonly kind: "ReviewQuarantineWriteFailed" }>>
 * }} ReviewRecoveryDependencies
 */

export class ReviewRecoveryService {
  /** @type {ReviewRecoveryDependencies} */
  #dependencies;
  /** @type {Promise<import("../../persistence/contracts.js").Result<ReviewQuarantine, ReviewRecoveryFailure>> | null} */
  #active = null;

  /** @param {ReviewRecoveryDependencies} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies.exportBackup !== "function" ||
      typeof dependencies.prepareContinuation !== "function" ||
      typeof dependencies.persistQuarantine !== "function"
    ) {
      throw new TypeError("Review recovery dependencies are invalid.");
    }
    this.#dependencies = dependencies;
  }

  /**
   * @param {unknown} command
   * @returns {Promise<import("../../persistence/contracts.js").Result<ReviewQuarantine, ReviewRecoveryFailure>>}
   */
  recover(command) {
    if (this.#active !== null) return this.#active;
    const validated = validateRecoveryCommand(command);
    if (!validated.ok) return Promise.resolve(validated);
    const operation = this.#run(validated.value).finally(() => {
      if (this.#active === operation) this.#active = null;
    });
    this.#active = operation;
    return operation;
  }

  /**
   * @param {ReviewQuarantine} quarantine
   * @returns {Promise<import("../../persistence/contracts.js").Result<ReviewQuarantine, Exclude<ReviewRecoveryFailure, { readonly kind: "ReviewRecoveryCommandInvalid" }>>>}
   */
  async #run(quarantine) {
    const exported = await this.#dependencies.exportBackup();
    if (!exported.ok) return exported;
    const continuation = this.#dependencies.prepareContinuation();
    if (!continuation.ok) return continuation;
    const persisted = await this.#dependencies.persistQuarantine(quarantine);
    if (!persisted.ok) return persisted;
    continuation.value.commit();
    return { ok: /** @type {const} */ (true), value: quarantine };
  }
}

/**
 * @param {unknown} value
 * @returns {import("../../persistence/contracts.js").Result<ReviewQuarantine, Extract<ReviewRecoveryFailure, { readonly kind: "ReviewRecoveryCommandInvalid" }>>}
 */
export function validateRecoveryCommand(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("ownerId");
  }
  const command = /** @type {Record<string, unknown>} */ (value);
  if (typeof command.ownerId !== "string" || command.ownerId.trim() === "") {
    return invalid("ownerId");
  }
  if (
    !Array.isArray(command.recordIds) ||
    command.recordIds.length === 0 ||
    command.recordIds.some((recordId) =>
      typeof recordId !== "string" || recordId.trim() === ""
    ) ||
    new Set(command.recordIds).size !== command.recordIds.length
  ) {
    return invalid("recordIds");
  }
  if (
    typeof command.idempotencyKey !== "string" ||
    command.idempotencyKey.trim() === ""
  ) {
    return invalid("idempotencyKey");
  }
  if (
    typeof command.createdAt !== "string" ||
    !Number.isFinite(Date.parse(command.createdAt))
  ) {
    return invalid("createdAt");
  }
  if (command.version !== 1) return invalid("version");
  return {
    ok: true,
    value: freeze({
      ownerId: command.ownerId,
      recordIds: freeze([...command.recordIds]),
      idempotencyKey: command.idempotencyKey,
      createdAt: command.createdAt,
      version: /** @type {const} */ (1),
    }),
  };
}

/**
 * @param {Extract<ReviewRecoveryFailure, { readonly kind: "ReviewRecoveryCommandInvalid" }>["field"]} field
 * @returns {import("../../persistence/contracts.js").Result<never, Extract<ReviewRecoveryFailure, { readonly kind: "ReviewRecoveryCommandInvalid" }>>}
 */
function invalid(field) {
  return {
    ok: /** @type {const} */ (false),
    error: {
      kind: /** @type {const} */ ("ReviewRecoveryCommandInvalid"),
      field,
    },
  };
}

export {};
