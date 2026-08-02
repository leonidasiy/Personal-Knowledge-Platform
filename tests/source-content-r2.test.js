// @ts-check

import { R2SourceContentStore } from "../worker/source-content-r2.js";
/** @import { Result, SourceIngestionFailure } from "../src/features/source-library/ingestion-contracts.js" */
/** @typedef {{readonly reservationId:string,readonly accountScope:string,readonly ownerId:string,readonly objectKey:string,readonly operation:"write"|"delete",readonly expectedStoredBytes:number,readonly month:string,readonly reservedAt:string}} Reservation */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

class Bucket {
  /** @type {{ readonly key: string, readonly value: Uint8Array, readonly options: { readonly httpMetadata: { readonly contentType: string }, readonly customMetadata: Readonly<Record<string, string>> } }[]} */
  puts = [];
  /** @type {string[]} */
  deletes = [];
  failPut = false;
  failDelete = false;
  /** @param {string} key @param {Uint8Array} value @param {{ readonly httpMetadata: { readonly contentType: string }, readonly customMetadata: Readonly<Record<string, string>> }} options */
  async put(key, value, options) { if (this.failPut) throw new Error("put"); this.puts.push({ key, value, options }); }
  /** @param {string} key */
  async delete(key) { if (this.failDelete) throw new Error("delete"); this.deletes.push(key); }
}

function command() { return { objectId: "opaque-a", ownerId: "owner-a", sourceId: "source-a", itemId: "item-a", itemVersionId: "version-a", content: new TextEncoder().encode("private transcript"), contentDigest: "sha256:a", mediaType: "text/plain" }; }

/** @param {{readonly reserveFailure?:SourceIngestionFailure,readonly reconcileFailure?:SourceIngestionFailure}} [options] */
function capacity(options = {}) {
  /** @type {unknown[]} */ const reservations = [];
  /** @type {unknown[]} */ const reconciliations = [];
  return {
    reservations,
    reconciliations,
    port: {
      /** @param {unknown} value @returns {Promise<Result<Reservation,SourceIngestionFailure>>} */
      reserve: (value) => {
        reservations.push(value);
        if (options.reserveFailure !== undefined) {
          return Promise.resolve({ ok: false, error: options.reserveFailure });
        }
        return Promise.resolve({
          ok: /** @type {const} */ (true),
          value: {
            reservationId: "reservation-a",
            accountScope: "account-a",
            ownerId: "owner-a",
            objectKey: /** @type {{objectKey:string}} */ (value).objectKey,
            operation: /** @type {{operation:"write"|"delete"}} */ (value).operation,
            expectedStoredBytes: /** @type {{expectedStoredBytes:number}} */ (value).expectedStoredBytes,
            month: "2026-07",
            reservedAt: "2026-07-23T00:00:00.000Z",
          },
        });
      },
      /** @param {unknown} value @returns {Promise<Result<null,SourceIngestionFailure>>} */
      reconcile: (value) => {
        reconciliations.push(value);
        if (options.reconcileFailure !== undefined) {
          return Promise.resolve({ ok: false, error: options.reconcileFailure });
        }
        return Promise.resolve({ ok: /** @type {const} */ (true), value: null });
      },
    },
  };
}

Deno.test("R2 source content uses a server object ID and private owner metadata", async () => {
  const bucket = new Bucket();
  const usage = capacity();
  const result = await new R2SourceContentStore({
    bucket,
    capacity: usage.port,
    capacityOwnerId: "owner-a",
  }).stage(command());
  assertEquals(result.ok, true);
  assertEquals(bucket.puts[0].key, "source-content/opaque-a");
  assertEquals(bucket.puts[0].options.customMetadata.owner, "owner-a");
  assertEquals(bucket.puts[0].options.customMetadata.digest, "sha256:a");
  assertEquals(usage.reservations.length, 1);
  assertEquals(usage.reconciliations.length, 1);
  assertEquals(
    /** @type {{outcome:string,measuredStoredBytes:number}} */ (
      usage.reconciliations[0]
    ).outcome,
    "completed",
  );
  assertEquals(
    /** @type {{outcome:string,measuredStoredBytes:number}} */ (
      usage.reconciliations[0]
    ).measuredStoredBytes,
    command().content.byteLength,
  );
});

Deno.test("R2 source content marks provider failures uncertain and blocks false cleanup success", async () => {
  const bucket = new Bucket();
  bucket.failPut = true;
  const usage = capacity({
    reconcileFailure: { kind: "R2CapacityUsageUncertain" },
  });
  let result = await new R2SourceContentStore({
    bucket,
    capacity: usage.port,
    capacityOwnerId: "owner-a",
  }).stage(command());
  if (result.ok) throw new Error("Expected failure.");
  assertEquals(result.error.kind, "R2CapacityUsageUncertain");
  assertEquals(
    /** @type {{outcome:string}} */ (usage.reconciliations[0]).outcome,
    "uncertain",
  );
  bucket.failDelete = true;
  const removed = await new R2SourceContentStore({
    bucket,
    capacity: usage.port,
    capacityOwnerId: "owner-a",
  }).remove("source-content/opaque-a");
  if (removed.ok) throw new Error("Expected failure.");
  assertEquals(removed.error.kind, "R2CapacityUsageUncertain");
});

Deno.test("R2 source content stops before provider work when capacity rejects", async () => {
  const bucket = new Bucket();
  const usage = capacity({
    reserveFailure: { kind: "R2StorageCapacityExceeded" },
  });
  const result = await new R2SourceContentStore({
    bucket,
    capacity: usage.port,
    capacityOwnerId: "owner-a",
  }).stage(command());
  if (result.ok) throw new Error("Expected capacity failure.");
  assertEquals(result.error.kind, "R2StorageCapacityExceeded");
  assertEquals(bucket.puts.length, 0);
});
