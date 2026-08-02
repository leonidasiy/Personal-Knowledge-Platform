// @ts-check

/** @import { Result, StudyEvent, StudyFailure } from "./contracts.js" */

export class StudyRepository {
  /** @type {StudyEvent[]} */
  #events = [];

  /**
   * @param {StudyEvent} event
   * @returns {Result<StudyEvent, Extract<StudyFailure, { kind: "StudyAlreadyRecorded" }>>}
   */
  append(event) {
    const duplicate = this.#events.some((existing) =>
      existing.ownerId === event.ownerId &&
      (
        existing.idempotencyKey === event.idempotencyKey ||
        (
          existing.candidateId === event.candidateId &&
          existing.contentVersion === event.contentVersion
        )
      )
    );
    if (duplicate) {
      return {
        ok: false,
        error: {
          kind: "StudyAlreadyRecorded",
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
   * @returns {readonly StudyEvent[]}
   */
  list(ownerId, candidateId) {
    return Object.freeze(
      this.#events.filter((event) =>
        event.ownerId === ownerId && event.candidateId === candidateId
      ),
    );
  }

  /**
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
