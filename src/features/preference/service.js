// @ts-check

import { validatePreferenceCommand } from "./contracts.js";

/** @import { PreferenceCommand, PreferenceEvent, PreferenceFailure, PreferenceSnapshot, Result } from "./contracts.js" */
/** @import { PreferenceRepository } from "./repository.js" */

export class PreferenceService {
  /** @type {PreferenceRepository} */
  #repository;
  /** @type {ReadonlySet<string>} */
  #knownScopes;
  /** @type {() => string} */
  #createId;

  /**
   * @param {PreferenceRepository} repository
   * @param {ReadonlySet<string>} knownScopes
   * @param {() => string} createId
   */
  constructor(repository, knownScopes, createId) {
    this.#repository = repository;
    this.#knownScopes = knownScopes;
    this.#createId = createId;
  }

  /**
   * @param {PreferenceCommand} command
   * @returns {Result<PreferenceSnapshot, PreferenceFailure>}
   */
  record(command) {
    const validation = validatePreferenceCommand(command);
    if (!validation.ok) return validation;
    if (!this.#knownScopes.has(command.relationshipScopeId)) {
      return {
        ok: false,
        error: {
          kind: "PreferenceScopeUnknown",
          relationshipScopeId: command.relationshipScopeId,
        },
      };
    }

    /** @type {PreferenceEvent} */
    const event = Object.freeze({
      id: this.#createId(),
      ...command,
      provenance: "explicit-user-action",
    });
    const appended = this.#repository.append(event);
    if (!appended.ok) return appended;
    return { ok: true, value: this.snapshot(command.ownerId, command.relationshipScopeId) };
  }

  /**
   * @param {string} ownerId
   * @param {string} relationshipScopeId
   * @param {string} idempotencyKey
   * @param {string} occurredAt
   * @returns {Result<PreferenceSnapshot, PreferenceFailure>}
   */
  reset(ownerId, relationshipScopeId, idempotencyKey, occurredAt) {
    if (!this.#knownScopes.has(relationshipScopeId)) {
      return {
        ok: false,
        error: { kind: "PreferenceScopeUnknown", relationshipScopeId },
      };
    }
    if (
      ownerId.trim() === ""
      || idempotencyKey.trim() === ""
      || !Number.isFinite(Date.parse(occurredAt))
    ) {
      return {
        ok: false,
        error: { kind: "PreferenceCommandInvalid", field: "reset" },
      };
    }

    const appended = this.#repository.append(Object.freeze({
      id: this.#createId(),
      ownerId,
      relationshipScopeId,
      choice: "reset",
      idempotencyKey,
      occurredAt,
      provenance: "explicit-user-action",
    }));
    if (!appended.ok) return appended;
    return { ok: true, value: this.snapshot(ownerId, relationshipScopeId) };
  }

  /**
   * @param {string} ownerId
   * @param {string} relationshipScopeId
   * @returns {PreferenceSnapshot}
   */
  snapshot(ownerId, relationshipScopeId) {
    /** @type {readonly PreferenceEvent[]} */
    const events = this.#repository.list(ownerId, relationshipScopeId);
    let lastReset = -1;
    for (let index = 0; index < events.length; index += 1) {
      if (events[index].choice === "reset") lastReset = index;
    }
    let sum = 0;
    for (const event of events.slice(lastReset + 1)) {
      sum += event.choice === "more" ? 1 : event.choice === "less" ? -1 : 0;
    }

    return Object.freeze({
      ownerId,
      relationshipScopeId,
      affinity: Math.max(-1, Math.min(1, sum * 0.25)),
      eventCount: events.length,
    });
  }
}
