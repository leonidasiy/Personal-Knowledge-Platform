// @ts-check

import { createKnowledgeWorkflowSourceContentCleanup } from "../worker/knowledge-workflow-source-content.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

Deno.test("source-content cleanup removes live objects and revokes references", async () => {
  /** @type {string[]} */ const queries = [];
  /** @type {string[]} */ const removed = [];
  /** @type {import("../worker/knowledge-workflow-source-content.js").D1Statement} */ let statement;
  statement = {
    bind: (..._values) => statement,
    async all() { return { success: true, results: [{ object_key: "source-content/object-a" }] }; },
    async first() { return null; },
    async run() { return { success: true, meta: { changes: 1 } }; },
  };
  const database = {
    prepare(/** @type {string} */ query) { queries.push(query); return statement; },
    batch: async (/** @type {readonly unknown[]} */ statements) => statements.map(() => ({ success: true, meta: { changes: 1 } })),
  };
  const cleanup = createKnowledgeWorkflowSourceContentCleanup({ database, contentStore: { async remove(key) { removed.push(key); return { ok: true, value: null }; } }, logger: () => {} });
  const result = await cleanup.purge({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1 });
  assertEquals(result.ok, true);
  assertEquals(removed.join(","), "source-content/object-a");
  assertEquals(queries.some((query) => query.includes("UPDATE source_content_references")), true);
});

Deno.test("source-content cleanup fails closed for unsafe stored keys", async () => {
  /** @type {import("../worker/knowledge-workflow-source-content.js").D1Statement} */ let statement;
  statement = { bind: (..._values) => statement, async all() { return { success: true, results: [{ object_key: "../private" }] }; }, async first() { return null; }, async run() { return { success: true, meta: { changes: 1 } }; } };
  const cleanup = createKnowledgeWorkflowSourceContentCleanup({ database: { prepare: () => statement, batch: async () => [] }, contentStore: { async remove(_key) { return { ok: true, value: null }; } }, logger: () => {} });
  const result = await cleanup.purge({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1 });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgeWorkflowSourceContentCleanupFailed");
});
