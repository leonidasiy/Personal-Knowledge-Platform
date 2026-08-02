// @ts-check

import { D1ManualMaterialRepository } from "../worker/manual-material-d1.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => StatementPort, readonly first: () => Promise<unknown | null>, readonly run: () => Promise<{ readonly success: boolean, readonly meta?: { readonly changes?: number } }>, readonly all: () => Promise<{ readonly success: boolean, readonly results: readonly unknown[] }> }} StatementPort */

class Statement {
  /** @type {readonly (string | number | null)[]} */
  bindings = [];
  /** @param {Database} database @param {string} query */
  constructor(database, query) { this.database = database; this.query = query; }
  /** @param {...(string | number | null)} values */
  bind(...values) { this.bindings = values; return this; }
  async first() { return this.database.first(this.query); }
  async run() { return { success: true, meta: { changes: 1 } }; }
  async all() { return { success: true, results: [] }; }
}
class Database {
  /** @type {(Record<string, unknown> | null)[]} */
  rows = [];
  batchChanges = 1;
  /** @type {StatementPort[][]} */
  batches = [];
  /** @param {string} query */
  prepare(query) { return new Statement(this, query); }
  /** @param {readonly StatementPort[]} statements */
  async batch(statements) { this.batches.push([...statements]); return statements.map(() => ({ success: true, meta: { changes: this.batchChanges } })); }
  /** @param {string} _query */
  first(_query) { return this.rows.shift() ?? null; }
}

const reference = Object.freeze({ id: "content-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", objectKey: "source-content/a", contentDigest: "sha256:a", rightsAssessmentId: "rights-a", state: /** @type {const} */ ("processing-ready"), createdAt: "2026-07-22T12:00:00.000Z" });
const rights = Object.freeze({ id: "rights-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", capabilities: Object.freeze([{ capability: "storage", outcome: /** @type {const} */ ("allowed") }]), evidence: Object.freeze([{ reference: "attestation-a", observedAt: "2026-07-22T12:00:00.000Z" }]), assessedAt: "2026-07-22T12:00:00.000Z", expiresAt: null });

Deno.test("manual-material D1 lookup enforces owner, item version, state, and revision", async () => {
  const database = new Database();
  database.rows.push({ state: "active", revision: 1 });
  const result = await new D1ManualMaterialRepository(database).find({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a" });
  assertEquals(result.ok, true);
  database.rows.push(null, { owner_id: "owner-b", revision: 1, state: "active" });
  const mismatch = await new D1ManualMaterialRepository(database).find({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a" });
  if (mismatch.ok) throw new Error("Expected failure.");
  assertEquals(mismatch.error.kind, "ManualUploadOwnerMismatch");
});

Deno.test("manual-material D1 commit is conditional and atomic", async () => {
  const database = new Database();
  const result = await new D1ManualMaterialRepository(database).persist({ fingerprint: "fingerprint-a", idempotencyKey: "upload-a", rightsAssessment: rights, contentReference: reference });
  assertEquals(result.ok, true);
  assertEquals(database.batches[0].length, 3);
  for (const statement of database.batches[0]) assertEquals((/** @type {Statement} */ (statement)).query.includes("WHERE EXISTS"), true);
  database.batchChanges = 0;
  const stale = await new D1ManualMaterialRepository(database).persist({ fingerprint: "fingerprint-a", idempotencyKey: "upload-a", rightsAssessment: rights, contentReference: reference });
  if (stale.ok) throw new Error("Expected failure.");
  assertEquals(stale.error.kind, "ManualUploadSourceItemMismatch");
});

Deno.test("manual-material replay reconstructs immutable processing state", async () => {
  const database = new Database();
  database.rows.push({ command_fingerprint: "fingerprint-a", owner_id: reference.ownerId, content_reference_id: reference.id, source_id: reference.sourceId, source_revision: reference.sourceRevision, item_id: reference.itemId, item_version_id: reference.itemVersionId, object_key: reference.objectKey, content_digest: reference.contentDigest, rights_assessment_id: reference.rightsAssessmentId, state: reference.state, created_at: reference.createdAt });
  const result = await new D1ManualMaterialRepository(database).replay("owner-a", "upload-a");
  assertEquals(result.ok, true);
  if (result.ok && result.value !== null) assertEquals(result.value.reference.state, "processing-ready");
});
