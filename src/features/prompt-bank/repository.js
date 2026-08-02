// @ts-check

const freeze = Object.freeze;

/** @import { GeneratedPrompt, PromptBankFailure, PromptGenerationEvent, Result } from "./contracts.js" */

export class PromptBankRepository {
  /** @type {PromptGenerationEvent[]} */
  #events = [];

  /**
   * @param {PromptGenerationEvent} event
   * @returns {Result<PromptGenerationEvent, PromptBankFailure>}
   */
  record(event) {
    if (
      this.#events.some((existing) =>
        existing.ownerId === event.ownerId &&
        existing.idempotencyKey === event.idempotencyKey
      )
    ) {
      return {
        ok: false,
        error: {
          kind: "PromptGenerationAlreadyRecorded",
          idempotencyKey: event.idempotencyKey,
        },
      };
    }
    const frozen = freeze({
      ...event,
      prompts: freeze([...event.prompts]),
    });
    this.#events.push(frozen);
    return { ok: true, value: frozen };
  }

  /**
   * @param {string} ownerId
   * @returns {readonly PromptGenerationEvent[]}
   */
  listEvents(ownerId) {
    return freeze(
      this.#events.filter((event) => event.ownerId === ownerId),
    );
  }

  /**
   * @param {string} ownerId
   * @returns {readonly GeneratedPrompt[]}
   */
  listPrompts(ownerId) {
    return freeze(
      this.#events
        .filter((event) => event.ownerId === ownerId)
        .flatMap((event) => event.prompts),
    );
  }
}
