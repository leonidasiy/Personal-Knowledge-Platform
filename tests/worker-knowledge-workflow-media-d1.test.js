// @ts-check

import { D1KnowledgeMediaRepository } from "../worker/knowledge-workflow-media-d1.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

function database(/** @type {readonly unknown[]} */ rows = []) {
  /** @type {string[]} */ const queries = [];
  const statement = {
    /** @param {...(string | number | null)} _values */
    bind(..._values) { return statement; },
    async first() { return rows[0] ?? null; },
    async run() { return { success: true, meta: { changes: 1 } }; },
    async all() { return { success: true, results: rows }; },
  };
  return { queries, prepare(/** @type {string} */ query) { queries.push(query); return statement; }, batch: async (/** @type {readonly unknown[]} */ statements) => statements.map(() => ({ success: true, meta: { changes: 1 } })) };
}

const asset = { ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", assetId: "media:a", sourceUrl: "https://example.test/a.png", origin: "https://example.test", kind: "image", mediaType: "image/png", byteCount: 3, digest: "sha256:image", privateOriginalKey: "private-quarantine/owner-a/run-a/media:a/original", attribution: "Creator / CC BY", createdAt: "2026-08-13T00:00:00.000Z" };
const derivative = { ownerId: "owner-a", assetId: "media:a", derivativeId: "derivative:a", variant: "feed", mediaType: "image/png", byteCount: 3, privateObjectKey: "private-derivatives/owner-a/media:a/feed", deliveryToken: "media:a:feed", createdAt: "2026-08-13T00:00:00.000Z" };

Deno.test("D1 media repository persists private metadata, reads owner-scoped derivatives, and revokes", async () => {
  const fixture = database([{ private_object_key: derivative.privateObjectKey, media_type: "image/png", revoked_at: null }]);
  /** @type {string[]} */ const bucketWrites = [];
  const repository = new D1KnowledgeMediaRepository({ database: fixture, bucket: { put: async (key) => { bucketWrites.push(key); }, get: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }), delete: async () => {} }, logger: () => {} });
  const saved = await repository.save(asset, derivative, new Uint8Array([1, 2, 3]));
  assertEquals(saved.ok, true);
  assertEquals(bucketWrites[0], derivative.privateObjectKey);
  const read = await repository.read({ ownerId: "owner-a", assetId: "media:a", variant: "feed" });
  assertEquals(read.ok, true);
  if (read.ok) assertEquals(read.value.revoked, false);
  const revoked = await repository.revoke({ ownerId: "owner-a", assetId: "media:a" });
  assertEquals(revoked.ok, true);
  assertEquals(fixture.queries.some((query) => query.includes("revoked_at")), true);
});

Deno.test("D1 media repository fails closed on missing or malformed derivative rows", async () => {
  const missing = new D1KnowledgeMediaRepository({ database: database(), bucket: { put: async () => {}, get: async () => null, delete: async () => {} }, logger: () => {} });
  const result = await missing.read({ ownerId: "owner-a", assetId: "media:missing", variant: "feed" });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "MediaDerivativeNotFound");
});
