// @ts-check

import { validateExposureCommand } from "./contracts.js";

/** @import { ExposureCommand, ExposureEvent, ExposureFailure, Result } from "./contracts.js" */
/** @import { ExposureRepository } from "./repository.js" */

export class ExposureService {
  /** @type {ExposureRepository} */
  #repository;
  /** @type {ReadonlySet<string>} */
  #knownCandidates;
  /** @type {number} */
  #minimumEngagedMs;
  /** @type {() => string} */
  #createId;

  /**
   * @param {ExposureRepository} repository
   * @param {ReadonlySet<string>} knownCandidates
   * @param {number} minimumEngagedMs
   * @param {() => string} createId
   */
  constructor(repository, knownCandidates, minimumEngagedMs, createId) {
    if (!Number.isFinite(minimumEngagedMs) || minimumEngagedMs <= 0) {
      throw new RangeError("minimumEngagedMs must be a positive finite number.");
    }
    this.#repository = repository;
    this.#knownCandidates = knownCandidates;
    this.#minimumEngagedMs = minimumEngagedMs;
    this.#createId = createId;
  }

  /**
   * @param {ExposureCommand} command
   * @returns {Result<ExposureEvent, ExposureFailure>}
   */
  record(command) {
    const validation = validateExposureCommand(command);
    if (!validation.ok) return validation;
    if (!this.#knownCandidates.has(command.candidateId)) {
      return {
        ok: false,
        error: {
          kind: "ExposureCandidateUnknown",
          candidateId: command.candidateId,
        },
      };
    }
    if (command.engagedMs < this.#minimumEngagedMs) {
      return {
        ok: false,
        error: {
          kind: "ExposureBelowThreshold",
          minimumMs: this.#minimumEngagedMs,
        },
      };
    }

    /** @type {ExposureEvent} */
    const event = Object.freeze({
      id: this.#createId(),
      ...command,
      provenance: "qualified-view",
    });
    return this.#repository.append(event);
  }
}
