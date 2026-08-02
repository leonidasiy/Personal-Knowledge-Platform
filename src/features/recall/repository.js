// @ts-check

const freeze = Object.freeze;

/** @import { MemoryState, RecallEvent, RecallFailure, RecallOutcome, Result } from "./contracts.js" */

export class RecallRepository {
  /** @type {RecallEvent[]} */
  #events = [];
  /** @type {Map<string, MemoryState>} */
  #memory = new Map();

  /**
   * @param {RecallEvent} event
   * @param {MemoryState} memory
   * @returns {Result<RecallOutcome, RecallFailure>}
   */
  record(event, memory) {
    const duplicate = this.#events.some((existing) =>
      existing.ownerId === event.ownerId &&
      existing.idempotencyKey === event.idempotencyKey
    );
    if (duplicate) {
      return {
        ok: false,
        error: {
          kind: "RecallAlreadyRecorded",
          idempotencyKey: event.idempotencyKey,
        },
      };
    }

    const frozenEvent = freeze(event);
    const frozenMemory = freeze(memory);
    this.#events.push(frozenEvent);
    this.#memory.set(
      this.#key(memory.ownerId, memory.knowledgeUnitId),
      frozenMemory,
    );
    return {
      ok: true,
      value: freeze({ event: frozenEvent, memory: frozenMemory }),
    };
  }

  /**
   * @param {string} ownerId
   * @param {string} knowledgeUnitId
   * @returns {MemoryState | null}
   */
  getMemory(ownerId, knowledgeUnitId) {
    return this.#memory.get(this.#key(ownerId, knowledgeUnitId)) ?? null;
  }

  /**
   * @param {string} ownerId
   * @returns {readonly RecallEvent[]}
   */
  listEvents(ownerId) {
    return freeze(
      this.#events.filter((event) => event.ownerId === ownerId),
    );
  }

  /**
   * @param {string} ownerId
   * @param {string} knowledgeUnitId
   * @returns {string}
   */
  #key(ownerId, knowledgeUnitId) {
    return `${ownerId}\u0000${knowledgeUnitId}`;
  }
}
