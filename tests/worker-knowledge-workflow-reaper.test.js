// @ts-check

import { createKnowledgeWorkflowRestrictionReaper } from "../worker/knowledge-workflow-reaper.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

/** @typedef {{ readonly bind: (...values: readonly (string | number)[]) => TestStatement, readonly all: () => Promise<{ readonly success: boolean, readonly results: readonly unknown[] }> }} TestStatement */

Deno.test("restriction reaper purges due rows in bounded order", async () => {
  /** @type {string[]} */ const queries = [];
  /** @type {TestStatement} */ let statement;
  statement = {
    bind: (..._values) => statement,
    async all() { return { success: true, results: [{ owner_id: "owner-a", run_id: "run-a", knowledge_id: "knowledge-a", restricted_until: "2026-08-12T00:00:00.000Z" }] }; },
  };
  /** @type {{ readonly knowledgeId: string }[]} */ const purges = [];
  const reaper = createKnowledgeWorkflowRestrictionReaper({ database: { prepare(query) { queries.push(query); return statement; } }, quizRepository: { async purge(command) { purges.push(command); return { ok: true, value: null }; } }, now: () => "2026-08-13T00:00:00.000Z", logger: () => {} });
  const result = await reaper.run();
  assertEquals(result.ok, true);
  assertEquals(purges.length, 1);
  assertEquals(purges[0].knowledgeId, "knowledge-a");
  assertEquals(queries.length, 1);
});

Deno.test("restriction reaper reports malformed rows instead of purging them", async () => {
  let purgeCalls = 0;
  /** @type {TestStatement} */ let statement;
  statement = { bind: (..._values) => statement, async all() { return { success: true, results: [{ owner_id: "owner-a", run_id: "run-a", knowledge_id: "", restricted_until: "2026-08-12T00:00:00.000Z" }] }; } };
  const reaper = createKnowledgeWorkflowRestrictionReaper({ database: { prepare() { return statement; } }, quizRepository: { async purge(_command) { purgeCalls += 1; return { ok: true, value: null }; } }, now: () => "2026-08-13T00:00:00.000Z", logger: () => {} });
  const result = await reaper.run();
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "WorkflowRestrictionReaperRowInvalid");
  assertEquals(purgeCalls, 0);
});
