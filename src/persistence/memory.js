// @ts-check

import { isRecordKind, validateEnvelope } from "./contracts.js";

/** @import { PersistenceEnvelope, PersistenceFailure, RecordKind, Result } from "./contracts.js" */

export class MemoryPersistence {
  /** @type {Map<string, PersistenceEnvelope>} */
  #records = new Map();

  /**
   * @param {PersistenceEnvelope} envelope
   * @returns {Promise<Result<PersistenceEnvelope, PersistenceFailure>>}
   */
  async append(envelope) {
    const appended = await this.appendBatch([envelope]);
    return appended.ok ? { ok: true, value: envelope } : appended;
  }

  /**
   * @param {readonly PersistenceEnvelope[]} envelopes
   * @returns {Promise<Result<readonly PersistenceEnvelope[], PersistenceFailure>>}
   */
  async appendBatch(envelopes) {
    const staged = new Map(this.#records);
    for (const envelope of envelopes) {
      const validation = validateEnvelope(envelope);
      if (!validation.ok) return validation;
      if (staged.has(envelope.id)) {
        return {
          ok: false,
          error: { kind: "PersistenceDuplicate", recordId: envelope.id },
        };
      }
      staged.set(envelope.id, structuredClone(envelope));
    }
    this.#records = staged;
    return {
      ok: true,
      value: Object.freeze(
        envelopes.map((envelope) => structuredClone(envelope)),
      ),
    };
  }

  /**
   * @param {string} ownerId
   * @param {RecordKind} kind
   * @returns {Promise<Result<readonly PersistenceEnvelope[], PersistenceFailure>>}
   */
  async list(ownerId, kind) {
    if (!isRecordKind(kind)) {
      return {
        ok: false,
        error: {
          kind: "PersistenceRecordKindInvalid",
          recordId: "",
          recordKind: typeof kind === "string" ? kind : "",
        },
      };
    }
    return {
      ok: true,
      value: Object.freeze(
        [...this.#records.values()]
          .filter((record) =>
            record.ownerId === ownerId && record.kind === kind
          )
          .map((record) => structuredClone(record)),
      ),
    };
  }

  /**
   * @param {string} ownerId
   * @returns {Promise<Result<number, PersistenceFailure>>}
   */
  async eraseOwner(ownerId) {
    let erased = 0;
    for (const [id, record] of this.#records.entries()) {
      if (record.ownerId === ownerId) {
        this.#records.delete(id);
        erased += 1;
      }
    }
    return { ok: true, value: erased };
  }
}
