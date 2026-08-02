// @ts-check

/** @import { ExposureEvent, ExposureFailure, Result } from "./contracts.js" */

export class ExposureRepository {
  /** @type {ExposureEvent[]} */
  #events = [];

  /**
   * @param {ExposureEvent} event
   * @returns {Result<ExposureEvent, ExposureFailure>}
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
          kind: "ExposureAlreadyRecorded",
          idempotencyKey: event.idempotencyKey,
        },
      };
    }
    const frozen = Object.freeze(event);
    this.#events.push(frozen);
    return { ok: true, value: frozen };
  }

  /**
   * @param {string} ownerId
   * @param {string} candidateId
   * @returns {readonly ExposureEvent[]}
   */
  list(ownerId, candidateId) {
    return Object.freeze(
      this.#events.filter((event) =>
        event.ownerId === ownerId && event.candidateId === candidateId
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
