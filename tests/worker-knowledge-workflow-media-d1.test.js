// @ts-check

import { D1KnowledgeMediaRepository } from "../worker/knowledge-workflow-media-d1.js";
import { quoteHash } from "../worker/webpage-facts.js";

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

const asset = { ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", assetId: "media:a", sourceUrl: "https://example.test/a.png", origin: "https://example.test", kind: /** @type {const} */ ("image"), mediaType: "image/png", byteCount: 3, digest: "sha256:image", privateOriginalKey: "private-quarantine/owner-a/run-a/media:a/original", attribution: "Creator / CC BY", createdAt: "2026-08-13T00:00:00.000Z" };
const derivative = { ownerId: "owner-a", assetId: "media:a", derivativeId: "derivative:a", variant: /** @type {const} */ ("feed"), mediaType: "image/png", byteCount: 3, privateObjectKey: "private-derivatives/owner-a/media:a/feed", deliveryToken: "media:a:feed", createdAt: "2026-08-13T00:00:00.000Z" };

Deno.test("D1 media repository persists private metadata, reads owner-scoped derivatives, and revokes", async () => {
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), character => character.charCodeAt(0));
  const point = { summary: "Ratios compare quantities.", normalizedHash: "ratio", evidenceAnchors: [{ url: "https://example.test/", selector: "p" }] };
  const digest = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  const binding = { kind: /** @type {const} */ ("webpage-support"), ownerId: asset.ownerId, runId: asset.runId, sourceRevision: 1, factHash: await quoteHash(JSON.stringify(point)), imageId: "image:a", originalDigest: digest, evidence: "Visible quantity labels." };
  const fixture = database([{ point_json: JSON.stringify(point), private_object_key: derivative.privateObjectKey, media_type: "image/png", byte_count: bytes.length, digest, binding_json: JSON.stringify(binding), run_id: asset.runId, source_revision: 1, original_digest: digest, original_byte_count: bytes.length, private_original_key: asset.privateOriginalKey, revoked_at: null }]);
  /** @type {string[]} */ const bucketWrites = [];
  const repository = new D1KnowledgeMediaRepository({ database: fixture, bucket: { put: async (key) => { bucketWrites.push(key); }, get: async () => ({ arrayBuffer: async () => bytes.buffer }), delete: async () => {} }, logger: () => {} });
  const saved = await repository.save({ ...asset, byteCount: bytes.length, digest, binding }, { ...derivative, byteCount: bytes.length }, bytes);
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
  const legacy = new D1KnowledgeMediaRepository({ database: database([{ private_object_key: derivative.privateObjectKey, media_type: "image/png", binding_json: null }]), bucket: { put: async () => {}, get: async () => { throw new Error("Unverified legacy media must not read objects."); }, delete: async () => {} }, logger: () => {} });
  const unverified = await legacy.read({ ownerId: "owner-a", assetId: "media:a", variant: "feed" });
  assertEquals(unverified.ok, false);
  if (!unverified.ok) assertEquals(unverified.error.kind, "MediaBindingUnverified");
});
