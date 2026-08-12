// @ts-check

import { isNonEmptyText, isPositiveInteger, isRecord } from "./contracts.js";

/** @import { LearningLogger, LearningRevocationCommand, LearningRevocationFailure, LearningRevocationRepositoryPort, LearningRevocationResult, Result } from "./contracts.js" */

export class LearningRevocationService {
  #repository;
  #now;
  #logger;

  /** @param {{ readonly repository: Pick<LearningRevocationRepositoryPort, "revoke">, readonly now: () => string, readonly logger: LearningLogger }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.repository?.revoke !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") throw new TypeError("Learning-revocation dependencies are invalid.");
    this.#repository = dependencies.repository;
    this.#now = dependencies.now;
    this.#logger = dependencies.logger;
  }

  /** @param {unknown} input @returns {Promise<Result<LearningRevocationResult, LearningRevocationFailure>>} */
  async revoke(input) {
    const now = this.#now();
    if (!isIsoDateTime(now)) throw new TypeError("Learning-revocation clock returned an invalid time.");
    const command = validateCommand(input, now);
    if (!command.ok) return this.#fail(command.error);
    this.#logger({ event: "learning-revocation-entry" });
    const result = await this.#repository.revoke(command.value, fingerprintOf(command.value));
    if (!result.ok) return this.#fail(result.error);
    this.#logger({ event: "learning-revocation-success", durationMs: result.value.tombstones.length });
    return result;
  }

  /** @param {LearningRevocationFailure} failure @returns {Result<never, LearningRevocationFailure>} */
  #fail(failure) {
    this.#logger({ event: "learning-revocation-failure", failureKind: failure.kind });
    return { ok: false, error: failure };
  }
}

/** @param {unknown} value @param {string} now @returns {Result<LearningRevocationCommand, LearningRevocationFailure>} */
function validateCommand(value, now) {
  if (!isRecord(value)) return invalid("command");
  for (const field of ["ownerId", "sourceId", "idempotencyKey", "reason", "revokedAt"]) if (!isNonEmptyText(value[field])) return invalid(field);
  if (!isPositiveInteger(value.sourceRevision)) return invalid("sourceRevision");
  const checked = /** @type {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly idempotencyKey: string, readonly reason: string, readonly revokedAt: string }} */ (value);
  if (!isIsoDateTime(checked.revokedAt) || Date.parse(checked.revokedAt) > Date.parse(now)) return invalid("revokedAt");
  return { ok: true, value: Object.freeze({ ownerId: checked.ownerId.trim(), sourceId: checked.sourceId.trim(), sourceRevision: checked.sourceRevision, idempotencyKey: checked.idempotencyKey.trim(), reason: checked.reason.trim(), revokedAt: checked.revokedAt }) };
}

/** @param {LearningRevocationCommand} command */
function fingerprintOf(command) { return JSON.stringify([command.ownerId, command.sourceId, command.sourceRevision, command.reason, command.revokedAt]); }
/** @param {unknown} value @returns {value is string} */
function isIsoDateTime(value) { return isNonEmptyText(value) && Number.isFinite(Date.parse(value)); }
/** @param {string} field @returns {Result<never, LearningRevocationFailure>} */
function invalid(field) { return { ok: false, error: { kind: "LearningRevocationCommandInvalid", field } }; }

export {};
