// @ts-check

import { IndexedDbPersistence } from "../src/persistence/indexeddb.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

const envelope = Object.freeze({
  id: "event-1",
  ownerId: "owner-a",
  kind: /** @type {const} */ ("preference_event"),
  payloadJson: JSON.stringify({ choice: "more" }),
  recordedAt: "2026-07-19T00:00:00.000Z",
});

function installFakeIndexedDb() {
  /** @type {IDBRequest<IDBValidKey>[]} */
  const addRequests = [];
  const transaction = /** @type {IDBTransaction} */ (
    /** @type {unknown} */ ({
      error: null,
      oncomplete: null,
      onabort: null,
      onerror: null,
      objectStore: () => ({
        add: () => {
          const request = /** @type {IDBRequest<IDBValidKey>} */ (
            /** @type {unknown} */ ({
              error: null,
              onsuccess: null,
              onerror: null,
            })
          );
          addRequests.push(request);
          return request;
        },
      }),
    })
  );
  let closed = false;
  let openCalls = 0;
  const database = /** @type {IDBDatabase} */ (
    /** @type {unknown} */ ({
      objectStoreNames: { contains: () => true },
      transaction: () => transaction,
      close: () => {
        closed = true;
      },
    })
  );
  const openRequest = /** @type {IDBOpenDBRequest} */ (
    /** @type {unknown} */ ({
      result: database,
      error: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
    })
  );
  const factory = /** @type {IDBFactory} */ (
    /** @type {unknown} */ ({
      open: () => {
        openCalls += 1;
        return openRequest;
      },
    })
  );
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: factory,
  });
  return {
    openRequest,
    transaction,
    addRequests,
    get closed() {
      return closed;
    },
    get openCalls() {
      return openCalls;
    },
  };
}

async function allowPromiseContinuation() {
  await Promise.resolve();
  await Promise.resolve();
}

Deno.test("IndexedDB append resolves success only after transaction commit", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  try {
    const fake = installFakeIndexedDb();
    const persistence = new IndexedDbPersistence();
    const pending = persistence.append(envelope);
    fake.openRequest.onsuccess?.call(fake.openRequest, new Event("success"));
    await allowPromiseContinuation();

    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await allowPromiseContinuation();
    assertEquals(settled, false);

    fake.transaction.oncomplete?.call(fake.transaction, new Event("complete"));
    const outcome = await pending;
    assertEquals(outcome.ok, true);
    assertEquals(fake.closed, true);
  } finally {
    if (original === undefined) {
      delete /** @type {{ indexedDB?: IDBFactory }} */ (globalThis).indexedDB;
    } else {
      Object.defineProperty(globalThis, "indexedDB", original);
    }
  }
});

Deno.test("IndexedDB append reports an abort after request success as failure", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  try {
    const fake = installFakeIndexedDb();
    const persistence = new IndexedDbPersistence();
    const pending = persistence.append(envelope);
    fake.openRequest.onsuccess?.call(fake.openRequest, new Event("success"));
    await allowPromiseContinuation();
    fake.transaction.onabort?.call(fake.transaction, new Event("abort"));

    const outcome = await pending;
    assertEquals(outcome.ok, false);
    if (!outcome.ok) assertEquals(outcome.error.kind, "PersistenceWriteFailed");
    assertEquals(fake.closed, true);
  } finally {
    if (original === undefined) {
      delete /** @type {{ indexedDB?: IDBFactory }} */ (globalThis).indexedDB;
    } else {
      Object.defineProperty(globalThis, "indexedDB", original);
    }
  }
});

Deno.test("IndexedDB batch resolves only after its single transaction commits", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  try {
    const fake = installFakeIndexedDb();
    const persistence = new IndexedDbPersistence();
    const pending = persistence.appendBatch([
      { ...envelope, id: "source-1", kind: "discovery_source" },
      { ...envelope, id: "run-1", kind: "discovery_run" },
    ]);
    fake.openRequest.onsuccess?.call(fake.openRequest, new Event("success"));
    await allowPromiseContinuation();
    assertEquals(fake.addRequests.length, 2);

    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await allowPromiseContinuation();
    assertEquals(settled, false);

    fake.transaction.oncomplete?.call(fake.transaction, new Event("complete"));
    const outcome = await pending;
    assertEquals(outcome.ok, true);
    if (outcome.ok) assertEquals(outcome.value.length, 2);
    assertEquals(fake.closed, true);
  } finally {
    if (original === undefined) {
      delete /** @type {{ indexedDB?: IDBFactory }} */ (globalThis).indexedDB;
    } else {
      Object.defineProperty(globalThis, "indexedDB", original);
    }
  }
});

Deno.test("IndexedDB batch reports the duplicate that aborts the transaction", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  try {
    const fake = installFakeIndexedDb();
    const persistence = new IndexedDbPersistence();
    const pending = persistence.appendBatch([
      { ...envelope, id: "source-1", kind: "discovery_source" },
      { ...envelope, id: "run-duplicate", kind: "discovery_run" },
    ]);
    fake.openRequest.onsuccess?.call(fake.openRequest, new Event("success"));
    await allowPromiseContinuation();
    Object.defineProperty(fake.addRequests[1], "error", {
      configurable: true,
      value: new DOMException("Duplicate", "ConstraintError"),
    });
    fake.addRequests[1].onerror?.call(
      fake.addRequests[1],
      new Event("error"),
    );
    fake.transaction.onabort?.call(fake.transaction, new Event("abort"));

    const outcome = await pending;
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.kind, "PersistenceDuplicate");
      if (outcome.error.kind === "PersistenceDuplicate") {
        assertEquals(outcome.error.recordId, "run-duplicate");
      }
    }
    assertEquals(fake.closed, true);
  } finally {
    if (original === undefined) {
      delete /** @type {{ indexedDB?: IDBFactory }} */ (globalThis).indexedDB;
    } else {
      Object.defineProperty(globalThis, "indexedDB", original);
    }
  }
});

Deno.test("IndexedDB batch abort reports failure for the uncommitted batch", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  try {
    const fake = installFakeIndexedDb();
    const persistence = new IndexedDbPersistence();
    const pending = persistence.appendBatch([
      { ...envelope, id: "source-1", kind: "discovery_source" },
      { ...envelope, id: "run-1", kind: "discovery_run" },
    ]);
    fake.openRequest.onsuccess?.call(fake.openRequest, new Event("success"));
    await allowPromiseContinuation();
    fake.transaction.onabort?.call(fake.transaction, new Event("abort"));

    const outcome = await pending;
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.kind, "PersistenceWriteFailed");
      if (outcome.error.kind === "PersistenceWriteFailed") {
        assertEquals(outcome.error.recordId, "source-1");
      }
    }
    assertEquals(fake.closed, true);
  } finally {
    if (original === undefined) {
      delete /** @type {{ indexedDB?: IDBFactory }} */ (globalThis).indexedDB;
    } else {
      Object.defineProperty(globalThis, "indexedDB", original);
    }
  }
});

Deno.test("IndexedDB rejects duplicate batch identifiers before opening storage", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  try {
    const fake = installFakeIndexedDb();
    const persistence = new IndexedDbPersistence();
    const outcome = await persistence.appendBatch([
      { ...envelope, id: "same", kind: "discovery_source" },
      { ...envelope, id: "same", kind: "discovery_run" },
    ]);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) assertEquals(outcome.error.kind, "PersistenceDuplicate");
    assertEquals(fake.openCalls, 0);
  } finally {
    if (original === undefined) {
      delete /** @type {{ indexedDB?: IDBFactory }} */ (globalThis).indexedDB;
    } else {
      Object.defineProperty(globalThis, "indexedDB", original);
    }
  }
});

Deno.test("IndexedDB returns the exact invalid-record-kind failure before opening storage", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  try {
    const fake = installFakeIndexedDb();
    const persistence = new IndexedDbPersistence();
    const invalid =
      /** @type {import("../src/persistence/contracts.js").PersistenceEnvelope} */ (
        /** @type {unknown} */ ({
          ...envelope,
          id: "invalid-kind",
          kind: "other",
        })
      );
    const outcome = await persistence.appendBatch([invalid]);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.kind, "PersistenceRecordKindInvalid");
      if (outcome.error.kind === "PersistenceRecordKindInvalid") {
        assertEquals(outcome.error.recordKind, "other");
      }
    }
    assertEquals(fake.openCalls, 0);
  } finally {
    if (original === undefined) {
      delete /** @type {{ indexedDB?: IDBFactory }} */ (globalThis).indexedDB;
    } else {
      Object.defineProperty(globalThis, "indexedDB", original);
    }
  }
});
