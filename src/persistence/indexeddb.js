// @ts-check

import { isRecordKind, validateEnvelope } from "./contracts.js";

/** @import { PersistenceEnvelope, PersistenceFailure, RecordKind, Result } from "./contracts.js" */

const DATABASE_NAME = "resonance-learning";
const DATABASE_VERSION = 1;
const STORE_NAME = "records";
const OWNER_KIND_INDEX = "by-owner-kind";

/** @returns {Promise<Result<IDBDatabase, PersistenceFailure>>} */
function openDatabase() {
  if (!("indexedDB" in globalThis)) {
    return Promise.resolve({
      ok: false,
      error: { kind: "PersistenceUnavailable" },
    });
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex(OWNER_KIND_INDEX, ["ownerId", "kind"], {
          unique: false,
        });
      }
    };
    request.onsuccess = () => resolve({ ok: true, value: request.result });
    request.onerror = () =>
      resolve({
        ok: false,
        error: {
          kind: "PersistenceOpenFailed",
          context: request.error?.name ?? "Unknown open failure",
        },
      });
    request.onblocked = () =>
      resolve({
        ok: false,
        error: {
          kind: "PersistenceOpenFailed",
          context: "Database upgrade blocked",
        },
      });
  });
}

export class IndexedDbPersistence {
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
    const batchIds = new Set();
    for (const envelope of envelopes) {
      const validation = validateEnvelope(envelope);
      if (!validation.ok) return validation;
      if (batchIds.has(envelope.id)) {
        return {
          ok: false,
          error: { kind: "PersistenceDuplicate", recordId: envelope.id },
        };
      }
      batchIds.add(envelope.id);
    }
    if (envelopes.length === 0) {
      return { ok: true, value: Object.freeze([]) };
    }
    const opened = await openDatabase();
    if (!opened.ok) return opened;

    return new Promise((resolve) => {
      const transaction = opened.value.transaction(STORE_NAME, "readwrite");
      /** @type {PersistenceFailure | null} */
      let failure = null;
      const store = transaction.objectStore(STORE_NAME);
      for (const envelope of envelopes) {
        const request = store.add(envelope);
        request.onerror = () => {
          if (failure !== null) return;
          const duplicate = request.error?.name === "ConstraintError";
          failure = duplicate
            ? { kind: "PersistenceDuplicate", recordId: envelope.id }
            : { kind: "PersistenceWriteFailed", recordId: envelope.id };
        };
      }
      transaction.oncomplete = () => {
        opened.value.close();
        resolve({
          ok: true,
          value: Object.freeze(
            envelopes.map((envelope) => structuredClone(envelope)),
          ),
        });
      };
      transaction.onabort = () => {
        opened.value.close();
        resolve({
          ok: false,
          error: failure ?? {
            kind: "PersistenceWriteFailed",
            recordId: envelopes[0].id,
          },
        });
      };
    });
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
    const opened = await openDatabase();
    if (!opened.ok) return opened;

    return new Promise((resolve) => {
      const transaction = opened.value.transaction(STORE_NAME, "readonly");
      const index = transaction.objectStore(STORE_NAME).index(OWNER_KIND_INDEX);
      const request = index.getAll(IDBKeyRange.only([ownerId, kind]));
      request.onsuccess = () =>
        resolve({
          ok: true,
          value: Object.freeze(
            /** @type {PersistenceEnvelope[]} */ (request.result).map((
              record,
            ) => structuredClone(record)),
          ),
        });
      request.onerror = () =>
        resolve({
          ok: false,
          error: { kind: "PersistenceReadFailed", recordKind: kind },
        });
      transaction.oncomplete = () => opened.value.close();
      transaction.onabort = () => opened.value.close();
    });
  }

  /**
   * @param {string} ownerId
   * @returns {Promise<Result<number, PersistenceFailure>>}
   */
  async eraseOwner(ownerId) {
    const opened = await openDatabase();
    if (!opened.ok) return opened;

    return new Promise((resolve) => {
      const transaction = opened.value.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      let erased = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) return;
        const record = /** @type {PersistenceEnvelope} */ (cursor.value);
        if (record.ownerId === ownerId) {
          cursor.delete();
          erased += 1;
        }
        cursor.continue();
      };
      request.onerror = () =>
        resolve({
          ok: false,
          error: { kind: "PersistenceEraseFailed", ownerId },
        });
      transaction.oncomplete = () => {
        opened.value.close();
        resolve({ ok: true, value: erased });
      };
      transaction.onabort = () => {
        opened.value.close();
        resolve({
          ok: false,
          error: { kind: "PersistenceEraseFailed", ownerId },
        });
      };
    });
  }
}
