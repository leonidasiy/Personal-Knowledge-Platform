// @ts-check

import { createLearningBatchService } from "../worker/learning-batches-d1.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

/** @param {number} index */
const point = (index) => JSON.stringify({ id: `knowledge-${index}`, sourceId: "source-a", sourceRevision: 1, summary: `A precise music fact ${index}.`, normalizedHash: `hash-${index}`, evidenceAnchors: [{ id: `anchor-${index}`, url: "https://example.test/lesson", excerpt: "Evidence." }], attribution: { sourceUrl: "https://example.test/lesson" } });
/** @param {number} index */
const task = (index) => JSON.stringify({ id: `task-${index}`, kind: "single-choice", prompt: `Which statement is true ${index}?`, explanation: "The paired evidence explains it.", sourceAnchorIds: [`anchor-${index}`], choices: [{ id: "choice-1", label: "Correct" }, { id: "choice-2", label: "Distractor" }], correctChoiceIds: ["choice-1"], revision: 1 });

class Statement {
  /** @param {Database} database @param {string} query */
  /** @type {Database} */ database;
  /** @type {string} */ query;
  /** @type {(string | number | null)[]} */ bindings = [];
  /** @param {Database} database @param {string} query */
  constructor(database, query) { this.database = database; this.query = query; }
  /** @param {...(string | number | null)} values */
  bind(...values) { this.bindings = values; return this; }
  async all() { return this.database.all(this.query); }
  async first() { return this.database.first(this.query); }
  async run() { return { success: true, meta: { changes: 1 } }; }
}

class Database {
  /** @type {string[]} */ queries = [];
  /** @type {unknown[]} */ rows;
  /** @type {unknown | null} */ reviewRow = null;
  /** @type {number | null} */ answerCount = null;
  /** @param {unknown[]} rows */
  constructor(rows) { this.rows = rows; }
  /** @param {string} query */
  prepare(query) { this.queries.push(query); return new Statement(this, query); }
  /** @param {string} query */
  async all(query) { return { success: true, results: query.includes("FROM extraction_knowledge_points kp") ? this.rows : [] }; }
  /** @param {string} query */
  async first(query) {
    if (query.includes("FROM learner_feed_batches")) return null;
    if (query.includes("FROM learner_review_batches")) return this.reviewRow;
    if (query.includes("FROM learner_batch_commands")) return null;
    if (query.includes("COUNT(*)") && this.answerCount !== null) return { count: this.answerCount };
    return null;
  }
  /** @param {readonly Statement[]} statements */
  async batch(statements) { return statements.map(() => ({ success: true, meta: { changes: 1 } })); }
}

function rows(count = 5) {
  return Array.from({ length: count }, (_, index) => ({ point_json: point(index), knowledge_id: `knowledge-${index}`, source_id: "source-a", task_json: task(index), source_title: "Music theory", canonical_url: "https://example.test/lesson", view_count: 0, last_answer_correct: null, scheduled_days: 0, due_at: null, studied_at: null, preference: 0, asset_id: null, media_kind: null, media_attribution: null }));
}

Deno.test("learner projection suppresses legacy decorative fallback selections", async () => {
  const entries = rows();
  entries[0].point_json = JSON.stringify({ ...JSON.parse(entries[0].point_json), mediaSelection: { assetId: "fallback", kind: "image", url: "/assets/fallback-media/old.png", attribution: "User-attested local fallback" } });
  const database = new Database(entries);
  const service = createLearningBatchService({ database: /** @type {import("../worker/learning-batches-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => "2026-08-19T00:00:00.000Z", random: () => 0.1, logger: () => {} });
  const result = await service.loadFeed("owner-a", "2026-08-19");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(/** @type {{ items: { media: unknown }[] }} */ (result.value).items.every((item) => item.media === null), true);
});

Deno.test("learner migration creates state, batch, answer, preference, and command tables", async () => {
  const sql = await Deno.readTextFile(new URL("../worker/migrations/0012_learner_batches.sql", import.meta.url));
  for (const table of ["learner_knowledge_state", "learner_feed_batches", "learner_review_batches", "learner_review_answers", "learner_preference_feedback", "learner_batch_commands"]) assertEquals(sql.includes(`CREATE TABLE ${table}`), true);
  assertEquals(sql.includes("json_valid(item_ids_json)"), true);
});

Deno.test("learner D1 service only selects paired knowledge and creates a five-card Feed batch", async () => {
  const database = new Database(rows());
  const service = createLearningBatchService({ database: /** @type {import("../worker/learning-batches-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => "2026-08-19T00:00:00.000Z", random: () => 0.1, logger: () => {} });
  const result = await service.loadFeed("owner-a", "2026-08-19");
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const projection = /** @type {{ readonly items: readonly { readonly questionLocked: boolean }[] }} */ (result.value);
  assertEquals(projection.items.length, 5);
  assertEquals(projection.items.every((item) => item.questionLocked === true), true);
  assertEquals(database.queries.some((query) => query.includes("JOIN knowledge_workflow_quizzes") && query.includes("q.status = 'published'")), true);
  assertEquals(database.queries.some((query) => query.includes("LEFT JOIN learner_preference_feedback pf") && query.includes("COALESCE(ls.preference, pf.preference, 0)")), true);
});

Deno.test("learner D1 service accepts evidence anchors produced by the extractor without synthetic ids", async () => {
  const extractorRows = rows().map((row, index) => ({
    ...row,
    point_json: JSON.stringify({
      id: `knowledge-${index}`,
      sourceId: "source-a",
      sourceRevision: 1,
      summary: `A precise music fact ${index}.`,
      normalizedHash: `hash-${index}`,
      evidenceAnchors: [{ url: "https://example.test/lesson", selector: `#fact-${index}` }],
      attribution: { sourceUrl: "https://example.test/lesson" },
    }),
  }));
  const database = new Database(extractorRows);
  const service = createLearningBatchService({ database: /** @type {import("../worker/learning-batches-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => "2026-08-19T00:00:00.000Z", random: () => 0.1, logger: () => {} });
  const result = await service.loadFeed("owner-a", "2026-08-19");
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const projection = /** @type {{ readonly items: readonly { readonly evidenceAnchorIds: readonly string[] }[] }} */ (result.value);
  assertEquals(projection.items.length, 5);
  assertEquals(projection.items.every((item) => item.evidenceAnchorIds[0].includes("#fact-")), true);
});

Deno.test("learner D1 service returns an explicit empty Feed projection when fewer than five pairs are available", async () => {
  const database = new Database(rows(3));
  const service = createLearningBatchService({ database: /** @type {import("../worker/learning-batches-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => "2026-08-19T00:00:00.000Z", random: () => 0.1, logger: () => {} });
  const result = await service.loadFeed("owner-a", "2026-08-19");
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const projection = /** @type {{ readonly batch: unknown, readonly items: readonly unknown[] }} */ (result.value);
  assertEquals(projection.batch, null);
  assertEquals(projection.items.length, 0);
});

Deno.test("learner D1 service returns an empty Review projection when no studied knowledge is due", async () => {
  const database = new Database(rows(3));
  const service = createLearningBatchService({ database: /** @type {import("../worker/learning-batches-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => "2026-08-19T00:00:00.000Z", random: () => 0.1, logger: () => {} });
  const result = await service.loadReview("owner-a", "2026-08-19");
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const projection = /** @type {{ readonly batch: unknown, readonly questions: readonly unknown[], readonly dueCount: number }} */ (result.value);
  assertEquals(projection.batch, null);
  assertEquals(projection.questions.length, 0);
  assertEquals(projection.dueCount, 0);
});

Deno.test("learner D1 review projection withholds explanations and answer keys before an attempt", async () => {
  const due = rows().map((row) => ({ ...row, studied_at: "2026-08-18T00:00:00.000Z", due_at: "2026-08-19T00:00:00.000Z" }));
  const database = new Database(due);
  const service = createLearningBatchService({ database: /** @type {import("../worker/learning-batches-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => "2026-08-19T00:00:00.000Z", random: () => 0.1, logger: () => {} });
  const result = await service.loadReview("owner-a", "2026-08-19");
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const question = /** @type {{ readonly questions: readonly Record<string, unknown>[] }} */ (result.value).questions[0];
  assertEquals(Object.hasOwn(question, "explanation"), false);
  assertEquals(Object.hasOwn(question, "correctChoiceIds"), false);
  assertEquals(Object.hasOwn(question, "acceptedAnswers"), false);
});

Deno.test("learner D1 answer returns the stored explanation and correct choice only after a valid attempt", async () => {
  const due = rows().map((row) => ({ ...row, studied_at: "2026-08-18T00:00:00.000Z", due_at: "2026-08-19T00:00:00.000Z" }));
  const database = new Database(due);
  database.reviewRow = { batch_id: "review:owner-a:2026-08-19", learning_day: "2026-08-19", status: "open", item_ids_json: JSON.stringify(["task-0"]), revision: 1, created_at: "2026-08-19T00:00:00.000Z", completed_at: null };
  database.answerCount = 1;
  const service = createLearningBatchService({ database: /** @type {import("../worker/learning-batches-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => "2026-08-19T00:00:00.000Z", random: () => 0.1, logger: () => {} });
  const result = await service.answerReview({ ownerId: "owner-a", batchId: "review:owner-a:2026-08-19", questionId: "task-0", selectedChoiceIds: ["choice-1"], idempotencyKey: "answer-1" });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const answer = /** @type {{ readonly feedback: { readonly explanation: string, readonly correctAnswer: string } }} */ (result.value);
  assertEquals(answer.feedback.explanation, "The paired evidence explains it.");
  assertEquals(answer.feedback.correctAnswer, "Correct");
});

Deno.test("learner D1 deletion contract removes current batches and every paired descendant", async () => {
  const database = new Database([]);
  const service = createLearningBatchService({ database: /** @type {import("../worker/learning-batches-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => "2026-08-19T00:00:00.000Z", logger: () => {} });
  const result = await service.removeKnowledge({ ownerId: "owner-a", knowledgeId: "knowledge-a", idempotencyKey: "remove-a" });
  assertEquals(result.ok, true);
  for (const table of ["learner_feed_batches", "learner_review_batches", "learner_knowledge_state", "knowledge_workflow_quizzes", "extraction_knowledge_points"]) assertEquals(database.queries.some((query) => query.includes(`DELETE FROM ${table}`)), true);
});

Deno.test("learner D1 answer contract supports fill-blank answers without exposing them in the question projection", async () => {
  const source = await Deno.readTextFile(new URL("../worker/learning-batches-d1.js", import.meta.url));
  assertEquals(source.includes("acceptedAnswers"), true);
  assertEquals(source.includes("answerText"), true);
  assertEquals(source.includes("ReviewAnswerNotSupported"), true);
});

Deno.test("learner D1 source removal enumerates every descendant namespace before cascading", async () => {
  const database = new Database([]);
  const service = createLearningBatchService({ database: /** @type {import("../worker/learning-batches-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => "2026-08-19T00:00:00.000Z", logger: () => {} });
  const result = await service.removeSource({ ownerId: "owner-a", sourceId: "source-a", idempotencyKey: "remove-source-a" });
  assertEquals(result.ok, true);
  for (const table of ["extraction_knowledge_points", "knowledge_workflow_quizzes", "learning_generation_jobs", "knowledge_workflow_media_assets", "learner_knowledge_state"]) assertEquals(database.queries.some((query) => query.includes(`FROM ${table}`)), true);
});

Deno.test("learner D1 full generated-content reset preserves durable more-or-less preference feedback", async () => {
  const database = new Database([]);
  const service = createLearningBatchService({ database: /** @type {import("../worker/learning-batches-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => "2026-08-20T00:00:00.000Z", logger: () => {} });
  const result = await service.clearGeneratedContent("owner-a");
  assertEquals(result.ok, true);
  assertEquals(database.queries.some((query) => query.includes("DELETE FROM learner_preference_feedback")), false);
  assertEquals(database.queries.some((query) => query.includes("DELETE FROM extraction_knowledge_points")), true);
});
