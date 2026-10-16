// @ts-check

import { R2SourceContentStore } from "../worker/source-content-r2.js";
import { URL_CAPTURE_TYPE, packUrlCapture } from "../src/features/knowledge-workflows/url-capture.js";
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
  async get(key) { const found = this.puts.find((entry) => entry.key === key); return found === undefined ? null : { customMetadata: found.options.customMetadata, arrayBuffer: async () => found.value.buffer.slice(found.value.byteOffset, found.value.byteOffset + found.value.byteLength) }; }
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
  const imageBundle = await new R2SourceContentStore({ bucket, capacity: usage.port, capacityOwnerId: "owner-a" }).stage({ ...command(), objectId: "opaque-images", mediaType: "application/x-knowledge-images" });
  assertEquals(imageBundle.ok, true);
  assertEquals(bucket.puts[1].options.httpMetadata.contentType, "application/x-knowledge-images");
});

Deno.test("R2 retains a parsed URL capture with its original bytes and content type", async () => {
  const packed=packUrlCapture({sourceUrl:"https://example.org/article",responseUrl:"https://example.org/article",pdf:new TextEncoder().encode("%PDF-fixture"),images:[]});
  if(!packed.ok)throw new Error(packed.error.kind);
  const bucket=new Bucket(),usage=capacity();
  const store=new R2SourceContentStore({bucket,capacity:usage.port,capacityOwnerId:"owner-a"});
  const result=await store.stage({...command(),mediaType:URL_CAPTURE_TYPE,content:packed.value});
  if(!result.ok)throw new Error(result.error.kind);
  assertEquals(bucket.puts[0].options.httpMetadata.contentType,URL_CAPTURE_TYPE);
  const read=await store.read("owner-a",result.value.objectKey);
  if(!read.ok)throw new Error(read.error.kind);
  assertEquals(read.value.length,packed.value.length);
  assertEquals(read.value.join(","),packed.value.join(","));
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

Deno.test("R2 content reads return owned bytes and account for missing objects", async () => {
  const usage = capacity();
  const store = new R2SourceContentStore({
    bucket: { put: async () => {}, delete: async () => {}, get: async (key) => key.endsWith("missing") ? null : { customMetadata: { owner: "owner-a" }, arrayBuffer: async () => new Uint8Array([7, 8]).buffer } },
    capacity: usage.port, capacityOwnerId: "owner-a",
  });
  const found = await store.read("owner-a", "source-content/owned");
  if (!found.ok) throw new Error(found.error.kind);
  assertEquals(found.value.join(","), "7,8");
  const missing = await store.read("owner-a", "source-content/missing");
  if (missing.ok || missing.error.kind !== "SourceContentNotFound") throw new Error("Expected missing object.");
  assertEquals(/** @type {{outcome:string}} */ (usage.reconciliations[1]).outcome, "completed");
});

Deno.test("R2 source content refuses another owner's object before reading bytes", async () => {
  let arrayBufferReads = 0;
  const usage = capacity();
  const store = new R2SourceContentStore({
    bucket: { put: async () => {}, delete: async () => {}, get: async () => ({ customMetadata: { owner: "owner-b" }, arrayBuffer: async () => { arrayBufferReads += 1; return new Uint8Array([7]).buffer; } }) },
    capacity: usage.port, capacityOwnerId: "owner-a",
  });
  const result = await store.read("owner-a", "source-content/opaque-a");
  if (result.ok || result.error.kind !== "SourceContentOwnerMismatch") throw new Error("Expected owner mismatch.");
  assertEquals(arrayBufferReads, 0);
  assertEquals(/** @type {{outcome:string}} */ (usage.reconciliations[0]).outcome, "completed");
});

Deno.test("R2 source content fails closed when ownership metadata is absent", async () => {
  let arrayBufferReads = 0;
  const store = new R2SourceContentStore({
    bucket: { put: async () => {}, delete: async () => {}, get: async () => ({ customMetadata: {}, arrayBuffer: async () => { arrayBufferReads += 1; return new Uint8Array([7]).buffer; } }) },
    capacity: capacity().port, capacityOwnerId: "owner-a",
  });
  const result = await store.read("owner-a", "source-content/opaque-a");
  if (result.ok || result.error.kind !== "SourceContentOwnerMismatch") throw new Error("Expected metadata owner rejection.");
  assertEquals(arrayBufferReads, 0);
});
