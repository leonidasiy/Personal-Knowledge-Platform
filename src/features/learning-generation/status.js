// @ts-check

import { isNonEmptyText, isRecord } from "./contracts.js";

/** @import { LearningGenerationStatus, LearningGenerationStatusFailure, LearningGenerationStatusRepositoryPort, LearningLogger, Result } from "./contracts.js" */

export class LearningGenerationStatusService {
  #repository;
  #logger;

  /** @param {{ readonly repository: LearningGenerationStatusRepositoryPort, readonly logger: LearningLogger }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.repository?.getStatus !== "function" || typeof dependencies.logger !== "function") throw new TypeError("Learning-generation status dependencies are invalid.");
    this.#repository = dependencies.repository;
    this.#logger = dependencies.logger;
  }

  /** @param {unknown} input @returns {Promise<Result<LearningGenerationStatus, LearningGenerationStatusFailure>>} */
  async get(input) {
    const command = validateCommand(input);
    if (!command.ok) return this.#fail(command.error);
    this.#logger({ event: "learning-generation-status-entry" });
    const result = await this.#repository.getStatus(command.value.ownerId, command.value.generationId);
    if (!result.ok) return this.#fail(result.error);
    if (result.value === null) return this.#fail({ kind: "LearningGenerationStatusNotFound", generationId: command.value.generationId });
    this.#logger({ event: "learning-generation-status-success" });
    return { ok: true, value: result.value };
  }

  /** @param {LearningGenerationStatusFailure} failure @returns {Result<never, LearningGenerationStatusFailure>} */
  #fail(failure) { this.#logger({ event: "learning-generation-status-failure", failureKind: failure.kind }); return { ok: false, error: failure }; }
}

/** @param {unknown} value @returns {Result<{ readonly ownerId: string, readonly generationId: string }, LearningGenerationStatusFailure>} */
function validateCommand(value) {
  if (!isRecord(value)) return invalid("command");
  if (!isNonEmptyText(value.ownerId)) return invalid("ownerId");
  if (!isNonEmptyText(value.generationId)) return invalid("generationId");
  return { ok: true, value: Object.freeze({ ownerId: value.ownerId.trim(), generationId: value.generationId.trim() }) };
}
/** @param {string} field @returns {Result<never, LearningGenerationStatusFailure>} */
function invalid(field) { return { ok: false, error: { kind: "LearningGenerationStatusCommandInvalid", field } }; }

export {};
