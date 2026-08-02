// @ts-check

import { validateStudyCommand } from "./contracts.js";

/** @import { Result, StudyCommand, StudyEvent, StudyEventWriter, StudyFailure } from "./contracts.js" */
/** @import { StudyRepository } from "./repository.js" */

export class StudyService {
  /** @type {StudyRepository} */
  #repository;
  /** @type {ReadonlySet<string>} */
  #knownCandidates;
  /** @type {() => string} */
  #createId;
  /** @type {StudyEventWriter} */
  #writeEvent;

  /**
   * @param {{
   *   readonly repository: StudyRepository,
   *   readonly knownCandidates: ReadonlySet<string>,
   *   readonly createId: () => string,
   *   readonly writeEvent: StudyEventWriter
   * }} dependencies
   */
  constructor(dependencies) {
    if (
      typeof dependencies !== "object" ||
      dependencies === null ||
      !(dependencies.knownCandidates instanceof Set) ||
      typeof dependencies.createId !== "function" ||
      typeof dependencies.writeEvent !== "function"
    ) {
      throw new TypeError(
        "StudyService requires repository, candidate registry, ID factory, and event writer.",
      );
    }
    this.#repository = dependencies.repository;
    this.#knownCandidates = dependencies.knownCandidates;
    this.#createId = dependencies.createId;
    this.#writeEvent = dependencies.writeEvent;
  }

  /**
   * @param {StudyCommand} command
   * @returns {Promise<Result<StudyEvent, StudyFailure>>}
   */
  async record(command) {
    const appended = this.#append(command);
    if (!appended.ok) return appended;
    this.#repository.rollback(command.ownerId, command.idempotencyKey);
    const persisted = await this.#writeEvent(command);
    if (!persisted.ok) {
      return {
        ok: false,
        error: {
          kind: "StudyPersistenceFailed",
          recordId: command.idempotencyKey,
        },
      };
    }
    return this.#repository.append(appended.value);
  }

  /**
   * Replays an already durable command without writing it again.
   *
   * @param {StudyCommand} command
   * @returns {Result<StudyEvent, Exclude<StudyFailure, { kind: "StudyPersistenceFailed" }>>}
   */
  restore(command) {
    return this.#append(command);
  }

  /**
   * @param {StudyCommand} command
   * @returns {Result<StudyEvent, Exclude<StudyFailure, { kind: "StudyPersistenceFailed" }>>}
   */
  #append(command) {
    const validation = validateStudyCommand(command);
    if (!validation.ok) return validation;
    if (!this.#knownCandidates.has(validation.value.candidateId)) {
      return {
        ok: false,
        error: {
          kind: "StudyCandidateUnknown",
          candidateId: validation.value.candidateId,
        },
      };
    }
    return this.#repository.append(Object.freeze({
      id: this.#createId(),
      ...validation.value,
      provenance: "manual-study",
    }));
  }
}
