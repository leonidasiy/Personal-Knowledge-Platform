// @ts-check

import { D1KnowledgeContentRepository, D1QuizRepository } from "../worker/knowledge-workflow-content-d1.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

function database() {
  /** @type {unknown[]} */ const queries = [];
  /** @type {string[]} */ const preparedQueries = [];
  /** @type {number[]} */ const batches = [];
  /** @type {import("../worker/knowledge-workflow-content-d1.js").D1Statement} */
  const statement = {
    bind(...values) { queries.push(values); return statement; },
    async first() { return null; },
    async all() { return { success: true, results: [] }; },
    async run() { return { success: true, meta: { changes: 1 } }; },
  };
  return { queries, preparedQueries, batches, prepare(/** @type {string} */ query) { preparedQueries.push(query); return statement; }, batch: async (/** @type {readonly unknown[]} */ statements) => { batches.push(statements.length); return statements.map(() => ({ success: true, meta: { changes: 1 } })); } };
}

Deno.test("knowledge append replays only an identical owner/run-scoped point after interrupted checkpoint", async () => {
  const point = { id: "knowledge-a", sourceId: "source-a", sourceRevision: 1, summary: "Bounded", normalizedHash: "hash-a", evidenceAnchors: [{ url: "https://example.test/a", selector: "#a" }], coverageGoalIds: [], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/a" }, extractionVersion: "v1" };
  let stored = JSON.stringify(point);
  const fixture = database();
  const original = fixture.prepare;
  fixture.prepare = (query) => ({ ...original(query), bind() { return this; }, async run() { return { success: true, meta: { changes: 0 } }; }, async first() { return { point_json: stored }; } });
  const content = new D1KnowledgeContentRepository({ database: fixture, logger: () => {} });
  assertEquals((await content.appendKnowledgePoint(point, "owner-a", "run-a", "2026-08-13T00:00:00.000Z")).ok, true);
  stored = JSON.stringify({ ...point, summary: "Conflicting content" });
  const conflict = await content.appendKnowledgePoint(point, "owner-a", "run-a", "2026-08-13T00:00:00.000Z");
  assertEquals(conflict.ok, false);
  if (!conflict.ok) assertEquals(conflict.error.kind, "KnowledgePersistenceConflict");
  assertEquals(fixture.preparedQueries.some((query) => query.includes("owner_id = ? AND run_id = ? AND knowledge_id = ?")), true);
});

Deno.test("D1 content repository writes scratchpads, knowledge, quiz attempts, restrictions, and tombstones", async () => {
  const fixture = database();
  const logger = () => {};
  const content = new D1KnowledgeContentRepository({ database: fixture, logger });
  const scratchpad = await content.loadScratchpad({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1 });
  assertEquals(scratchpad.ok, true);
  if (!scratchpad.ok) return;
  await content.saveScratchpad(scratchpad.value, "2026-08-13T00:00:00.000Z");
  await content.appendKnowledgePoint({ id: "knowledge-a", sourceId: "source-a", sourceRevision: 1, summary: "Bounded", normalizedHash: "hash-a", evidenceAnchors: [{ url: "https://example.test/a", selector: "#a" }], coverageGoalIds: [], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/a" }, extractionVersion: "v1" }, "owner-a", "run-a", "2026-08-13T00:00:00.000Z");
  const listed = await content.listKnowledgePoints({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1 });
  assertEquals(listed.ok, true);
  const quiz = new D1QuizRepository({ database: fixture, logger, now: () => "2026-08-13T00:00:00.000Z" });
  await quiz.appendAttempt({ id: "attempt-a", ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", attempt: 1, draftId: "draft-a", score: 9, feedback: "good", failureKind: null, createdAt: "2026-08-13T00:00:00.000Z" });
  await quiz.publish({ ownerId: "owner-a", runId: "run-a", knowledge: { id: "knowledge-a", sourceId: "source-a", sourceRevision: 1, summary: "Bounded", normalizedHash: "hash-a", evidenceAnchors: [{ url: "https://example.test/a", selector: "#a" }], coverageGoalIds: [], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/a" }, extractionVersion: "v1" }, draft: { id: "draft-a", knowledgeId: "knowledge-a", knowledgeRevision: 1, kind: "single-choice", prompt: "Specific?", options: ["yes", "no"], answer: "yes", citedEvidenceUrls: ["https://example.test/a"] }, score: 9, attempt: 1, status: "published" });
  assertEquals(fixture.batches.some((length) => length === 4), true);
  await quiz.restrict({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", restrictedUntil: "2026-09-12T00:00:00.000Z", reason: "three-failed-submissions" });
  await quiz.purge({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", before: "2026-09-12T00:00:00.000Z" });
  assertEquals(fixture.queries.length > 0, true);
  assertEquals(fixture.preparedQueries.some((query) => query.includes("DELETE FROM learning_generation_tasks")), true);
  assertEquals(fixture.preparedQueries.some((query) => query.includes("DELETE FROM learning_generation_units")), true);
  assertEquals(fixture.preparedQueries.some((query) => query.includes("DELETE FROM learning_generation_jobs")), true);
});

Deno.test("D1 quiz repository detects a duplicate draft for the same source revision", async () => {
  /** @type {string[]} */
  const preparedQueries = [];
  /** @type {unknown[]} */
  const bound = [];
  /** @type {import("../worker/knowledge-workflow-content-d1.js").D1Statement} */
  const statement = {
    bind(...values) { bound.push(values); return statement; },
    async first() { return { draft_fingerprint: "draft-fingerprint-1" }; },
    async all() { return { success: true, results: [{ draft_fingerprint: "draft-fingerprint-1" }] }; },
    async run() { return { success: true, meta: { changes: 1 } }; },
  };
  /** @type {import("../worker/knowledge-workflow-content-d1.js").D1DatabasePort} */
  const database = {
    prepare(query) { preparedQueries.push(query); return statement; },
    batch: async (statements) => statements.map(() => ({ success: true, meta: { changes: 1 } })),
  };
  const repository = new D1QuizRepository({ database, logger: () => {}, now: () => "2026-08-13T00:00:00.000Z" });
  const result = await repository.hasDuplicateDraft({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, knowledgeId: "knowledge-b", draft: { id: "draft-b", knowledgeId: "knowledge-b", knowledgeRevision: 1, kind: "single-choice", prompt: "Specific?", options: ["yes", "no"], answer: "yes", citedEvidenceUrls: ["https://example.test/a"] } });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, true);
  assertEquals(preparedQueries.some((query) => query.includes("draft_fingerprint")), true);
  assertEquals(bound.length > 0, true);
});
