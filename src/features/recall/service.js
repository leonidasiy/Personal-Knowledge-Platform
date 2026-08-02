// @ts-check

import { validateRecallCommand } from "./contracts.js";

/** @import { RecallCommand, RecallEvent, RecallFailure, RecallOutcome, RecallPrompt, RecallScheduler, Result } from "./contracts.js" */
/** @import { RecallRepository } from "./repository.js" */

export class RecallService {
  /** @type {RecallRepository} */
  #repository;
  /** @type {ReadonlyMap<string, RecallPrompt>} */
  #prompts;
  /** @type {RecallScheduler} */
  #scheduler;
  /** @type {() => string} */
  #createId;

  /**
   * @param {RecallRepository} repository
   * @param {ReadonlyMap<string, RecallPrompt>} prompts
   * @param {RecallScheduler} scheduler
   * @param {() => string} createId
   */
  constructor(repository, prompts, scheduler, createId) {
    this.#repository = repository;
    this.#prompts = prompts;
    this.#scheduler = scheduler;
    this.#createId = createId;
  }

  /**
   * @param {RecallCommand} command
   * @returns {Result<RecallOutcome, RecallFailure>}
   */
  answer(command) {
    const prepared = this.prepare(command);
    return prepared.ok ? this.commit(prepared.value) : prepared;
  }

  /**
   * @param {RecallCommand} command
   * @returns {Result<RecallOutcome, RecallFailure>}
   */
  prepare(command) {
    const validation = validateRecallCommand(command);
    if (!validation.ok) return validation;

    const prompt = this.#prompts.get(command.promptId);
    if (prompt === undefined) {
      return {
        ok: false,
        error: { kind: "RecallPromptUnknown", promptId: command.promptId },
      };
    }
    if (prompt.status === "retired") {
      return {
        ok: false,
        error: { kind: "RecallPromptRetired", promptId: command.promptId },
      };
    }
    if (
      !prompt.choices.some((choice) => choice.id === command.selectedChoiceId)
    ) {
      return {
        ok: false,
        error: {
          kind: "RecallAnswerInvalid",
          choiceId: command.selectedChoiceId,
        },
      };
    }

    const correct = command.selectedChoiceId === prompt.correctChoiceId;
    const rating = correct
      ? /** @type {const} */ ("good")
      : /** @type {const} */ ("again");
    const previous = this.#repository.getMemory(
      command.ownerId,
      prompt.knowledgeUnitId,
    );
    const scheduled = this.#scheduler.schedule({
      memory: previous,
      rating,
      reviewedAt: command.reviewedAt,
    });
    if (!scheduled.ok) return scheduled;

    /** @type {RecallEvent} */
    const event = Object.freeze({
      id: this.#createId(),
      ownerId: command.ownerId,
      promptId: command.promptId,
      knowledgeUnitId: prompt.knowledgeUnitId,
      selectedChoiceId: command.selectedChoiceId,
      correct,
      rating,
      idempotencyKey: command.idempotencyKey,
      reviewedAt: command.reviewedAt,
      provenance: "active-recall",
    });
    const memory = Object.freeze({
      ownerId: command.ownerId,
      knowledgeUnitId: prompt.knowledgeUnitId,
      dueAt: scheduled.value.dueAt,
      stability: scheduled.value.stability,
      difficulty: scheduled.value.difficulty,
      scheduledDays: scheduled.value.scheduledDays,
      schedulerState: scheduled.value.schedulerState,
      schedulerVersion: scheduled.value.schedulerVersion,
      reviewCount: (previous?.reviewCount ?? 0) + 1,
    });
    return { ok: true, value: Object.freeze({ event, memory }) };
  }

  /**
   * @param {RecallOutcome} outcome
   * @returns {Result<RecallOutcome, RecallFailure>}
   */
  commit(outcome) {
    return this.#repository.record(outcome.event, outcome.memory);
  }
}
