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

Deno.test("knowledge append accepts D1 change counts that include search-index triggers", async () => {
  const fixture = database();
  const prepare = fixture.prepare;
  fixture.prepare = (query) => ({ ...prepare(query), bind() { return this; }, async run() { return { success: true, meta: { changes: 4 } }; } });
  const content = new D1KnowledgeContentRepository({ database: fixture, logger: () => {} });
  const point = { id: "knowledge-a", sourceId: "source-a", sourceRevision: 1, summary: "A supported claim.", normalizedHash: "hash-a", evidenceAnchors: [{ url: "https://example.test/a", selector: "#a" }] };
  const result = await content.appendKnowledgePoint(point, "owner-a", "run-a", "2026-09-18T00:00:00.000Z");
  assertEquals(result.ok, true);
  const command={ownerId:'owner-a',runId:'run-a',knowledgeId:'knowledge-a',sourceRevision:1,imageId:'image:1',score:0.8,model:'typesafe/jev',caption:'A supporting diagram.'};
  assertEquals((await content.attachCapturedImage(command)).ok,true);
  assertEquals((await content.attachCapturedImage({...command,score:0.79})).ok,false);
  fixture.prepare = (query) => ({ ...prepare(query), bind() { return this; }, async run() { return { success: true, meta: { changes: 0 } }; } });
  assertEquals((await content.attachCapturedImage(command)).ok,false);
});

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
  await quiz.restrict({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", restrictedUntil: "2026-12-12T00:00:00.000Z", reason: "three-failed-submissions" });
  const discarded = await quiz.discard({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", reason: "no-meaningful-quiz" });
  assertEquals(discarded.ok, true);
  assertEquals(fixture.preparedQueries.some((query) => query.includes("DELETE FROM knowledge_workflow_restrictions WHERE owner_id = ? AND run_id = ? AND knowledge_id = ?")), true);
});

Deno.test("publication rechecks and applies quiz limits after verification before pool insertion", async () => {
  const terms = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  for (const kind of ["single-choice", "multiple-choice", "fill-blank"]) {
    const fixture = database();
    const repository = new D1QuizRepository({ database: fixture, logger: () => {}, now: () => "2026-10-18T00:00:00.000Z" });
    const answers = terms.slice(0, 4);
    const draft = { id: "draft-limit", knowledgeId: "knowledge-a", knowledgeRevision: 1, kind, prompt: kind === "fill-blank" ? "____ then ____ then ____ then ____." : "Which statements apply?", options: kind === "fill-blank" ? [] : terms, answer: kind === "single-choice" ? "alpha" : answers, ...(kind === "fill-blank" ? { blanks: answers.map((answer, index) => ({ id: `blank-${index + 1}`, acceptedAnswers: [answer] })) } : {}), citedEvidenceUrls: ["https://example.test/a"] };
    const original = JSON.stringify(draft);
    const result = await repository.publish({ ownerId: "owner-a", runId: "run-a", knowledge: { id: "knowledge-a", sourceId: "source-a", sourceRevision: 1, summary: "Supported terms.", normalizedHash: "hash-a", evidenceAnchors: [{ url: "https://example.test/a", selector: "#a" }], coverageGoalIds: [], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/a" }, extractionVersion: "v1" }, draft: /** @type {import("../src/features/knowledge-workflows/quiz.js").QuestionDraft} */ (draft), score: 9, attempt: 1, status: "published" });
    assertEquals(result.ok, true);
    const bindings = /** @type {(readonly unknown[])[]} */ (fixture.queries);
    const task = JSON.parse(String(bindings[3][8]));
    assertEquals((task.choices?.length ?? 0) <= 5, true);
    assertEquals((task.correctChoiceIds?.length ?? 0) <= 3, true);
    assertEquals((task.blanks?.length ?? 0) <= 3, true);
    if (kind === "fill-blank") assertEquals(task.prompt.endsWith("delta."), true);
    assertEquals(JSON.stringify(draft), original);
  }
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

Deno.test("D1 quiz publication persists ordered blanks and rejects mismatched answers", async () => {
  const fixture = database();
  const repository = new D1QuizRepository({ database: fixture, logger: () => {}, now: () => "2026-09-18T00:00:00.000Z" });
  const knowledge = { id: "knowledge-a", sourceId: "source-a", sourceRevision: 1, summary: "The dominant resolves to the tonic.", normalizedHash: "hash-a", evidenceAnchors: [{ url: "https://example.test/a", selector: "#a" }], coverageGoalIds: [], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/a" }, extractionVersion: "v1" };
  const draft = { id: "draft-blanks", knowledgeId: "knowledge-a", knowledgeRevision: 1, kind: /** @type {const} */ ("fill-blank"), prompt: "A ____ resolves to the ____.", options: [], answer: ["dominant", "tonic"], blanks: [{ id: "blank-1", acceptedAnswers: ["dominant"] }, { id: "blank-2", acceptedAnswers: ["tonic"] }], explanation: "The dominant resolves to the tonic.", citedEvidenceUrls: ["https://example.test/a"] };
  const accepted = await repository.publish({ ownerId: "owner-a", runId: "run-a", knowledge, draft, score: 9, attempt: 1, status: "published" });
  assertEquals(accepted.ok, true);
  assertEquals(fixture.queries.some((bound) => Array.isArray(bound) && bound.some((value) => typeof value === "string" && value.includes('"blanks"'))), true);
  const rejected = await repository.publish({ ownerId: "owner-a", runId: "run-b", knowledge, draft: { ...draft, blanks: [{ id: "blank-1", acceptedAnswers: ["tonic"] }, ...draft.blanks.slice(1)] }, score: 9, attempt: 1, status: "published" });
  assertEquals(rejected.ok, false);
  if (!rejected.ok) assertEquals(rejected.error.kind, "QuizPublicationFailed");
});

Deno.test("D1 published quiz lookup is owner/run/point scoped and rejects corrupted or failed reads", async () => {
  const fixture=database();
  /** @type {unknown} */ let row=null;
  let broken=false;
  const prepare=fixture.prepare;
  fixture.prepare=(query)=>({...prepare(query),async first(){if(broken)throw new Error("DatabaseUnavailable");return row;},bind(...values){fixture.queries.push(values);return this;}});
  const repository=new D1QuizRepository({database:fixture,logger:()=>{},now:()=>"2026-10-02T00:00:00.000Z"});
  const scope={ownerId:"owner-a",runId:"run-a",knowledgeId:"knowledge-a"};
  assertEquals(JSON.stringify(await repository.findPublished(scope)),JSON.stringify({ok:true,value:null}));
  row={status:"published",attempt_number:4};
  assertEquals(JSON.stringify(await repository.findPublished(scope)),JSON.stringify({ok:true,value:{status:"published",attempt:4}}));
  assertEquals(fixture.preparedQueries.every(query=>query.includes("WHERE owner_id=? AND run_id=? AND knowledge_id=?")),true);
  assertEquals(JSON.stringify(fixture.queries[0]),JSON.stringify(["owner-a","run-a","knowledge-a"]));
  for (const invalid of [{status:"unknown",attempt_number:1},{status:"published",attempt_number:5}]){row=invalid;assertEquals((await repository.findPublished(scope)).ok,false);}
  broken=true;
  assertEquals((await repository.findPublished(scope)).ok,false);
});
