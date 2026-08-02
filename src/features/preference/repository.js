// @ts-check

/** @import { PreferenceEvent, PreferenceFailure, Result } from "./contracts.js" */

export class PreferenceRepository {
  /** @type {PreferenceEvent[]} */
  #events = [];

  /**
   * @param {PreferenceEvent} event
   * @returns {Result<PreferenceEvent, PreferenceFailure>}
   */
  append(event) {
    const duplicate = this.#events.some((existing) =>
      existing.ownerId === event.ownerId &&
      existing.idempotencyKey === event.idempotencyKey
    );
    if (duplicate) {
      return {
        ok: false,
        error: {
          kind: "PreferenceAlreadyRecorded",
          idempotencyKey: event.idempotencyKey,
        },
      };
    }
    this.#events.push(Object.freeze(event));
    return { ok: true, value: event };
  }

  /**
   * @param {string} ownerId
   * @param {string} relationshipScopeId
   * @returns {readonly PreferenceEvent[]}
   */
  list(ownerId, relationshipScopeId) {
    return Object.freeze(
      this.#events.filter((event) =>
        event.ownerId === ownerId &&
        event.relationshipScopeId === relationshipScopeId
      ),
    );
  }

  /**
   * Remove an event after its durable write fails.
   *
   * @param {string} ownerId
   * @param {string} idempotencyKey
   * @returns {boolean}
   */
  rollback(ownerId, idempotencyKey) {
    const index = this.#events.findIndex((event) =>
      event.ownerId === ownerId &&
      event.idempotencyKey === idempotencyKey
    );
    if (index < 0) return false;
    this.#events.splice(index, 1);
    return true;
  }
}
