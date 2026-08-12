// @ts-check

import { D1LearningGenerationRepository, isD1LearningGenerationDatabase } from "../worker/learning-generation-d1.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

/** @returns {import("../src/features/learning-generation/contracts.js").LearningGenerationRecord} */
function record() {
  const unit = /** @type {import("../src/features/learning-generation/contracts.js").LearningUnit} */ ({ id: "unit-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", contentDigest: "sha256:a", ordinal: 1, text: "The evidence.", startOffset: 0, endOffset: 13, wordCount: 2, sourceAnchorIds: /** @type {[string]} */ (["unit-a:anchor"]), provenance: "deterministic-unitization", policyVersion: "unit-v1" });
  const task = /** @type {import("../src/features/learning-generation/contracts.js").LearningTask} */ ({ id: "task-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", contentDigest: "sha256:a", version: 1, kind: "short-response", prompt: "Explain.", explanation: "Evidence.", unitIds: /** @type {[string]} */ (["unit-a"]), sourceAnchorIds: /** @type {[string]} */ (["unit-a:anchor"]), choices: null, correctChoiceIds: null, blankId: null, acceptedAnswers: null, expectedConcepts: ["evidence"], minimumWords: 1, stimulus: null, responseKind: "text", generatorVersion: "generator-v1", policyVersion: "policy-v1", provenance: "provider-draft", reviewRequired: true, status: "pending-review", reviewDecision: null, reviewedAt: null, revision: 1, generatedAt: "2026-08-12T12:00:00.000Z" });
  return { id: "generation-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", contentDigest: "sha256:a", sourceKind: "public-text", rightsEvidenceId: "rights-a", attribution: { label: "Publisher", sourceUrl: "https://publisher.example/item" }, policyVersion: "policy-v1", units: [unit], tasks: [task], status: "completed", localOnly: false, providerRequestId: "request-a", failureKind: null, idempotencyKey: "generation-a", createdAt: "2026-08-12T12:00:00.000Z" };
}

class Statement {
  /** @param {Database} database @param {string} query */
  constructor(database, query) { this.database = database; this.query = query; /** @type {(string | number | null)[]} */ (this.bindings = []); }
  /** @param {...(string | number | null)} values */
  bind(...values) { this.bindings = values; return this; }
  async first() { return this.database.first(this.query, this.bindings); }
  async all() { return { success: true, results: this.database.all(this.query, this.bindings) }; }
  async run() { return { success: true, meta: { changes: 1 } }; }
}

class Database {
  /** @type {string[]} */ queries = [];
  /** @type {Statement[][]} */ batches = [];
  /** @type {number | null} */ revokedThrough = null;
  /** @type {unknown | null} */ statusRow = null;
  /** @type {unknown[]} */ taskRows = [];
  /** @type {unknown[]} */ queueSourceRows = [];
  /** @type {unknown[]} */ queueGenerationRows = [];
  /** @type {unknown[]} */ queueTaskRows = [];
  /** @type {unknown | null} */ reviewRow = null;
  /** @type {unknown | null} */ reviewAfterRace = null;
  /** @type {number} */ reviewConditionalChanges = 1;
  /** @type {boolean} */ reviewBatchAttempted = false;
  /** @param {string} query */
  prepare(query) { this.queries.push(query); return new Statement(this, query); }
  /** @param {readonly Statement[]} statements */
  /** @param {readonly unknown[]} statements */
  async batch(statements) {
    this.batches.push(/** @type {Statement[]} */ ([...statements]));
    if (statements.some((statement) => /** @type {Statement} */ (statement).query.startsWith("UPDATE learning_generation_tasks SET"))) this.reviewBatchAttempted = true;
    return statements.map((statement) => ({ success: true, meta: { changes: /** @type {Statement} */ (statement).query.startsWith("UPDATE learning_generation_tasks SET") ? this.reviewConditionalChanges : 1 } }));
  }
  /** @param {string} query @param {readonly (string|number|null)[]} _bindings */
  /** @param {string} query @param {readonly (string | number | null)[]} _bindings @returns {unknown | null} */
  first(query, _bindings) {
    if (query.startsWith("SELECT MAX(source_revision)")) return this.revokedThrough === null ? null : { revoked_through: this.revokedThrough };
    if (query.startsWith("SELECT generation_id, command_fingerprint")) return null;
    if (query.startsWith("SELECT t.task_json, t.status, t.revision") || query.startsWith("SELECT status, revision FROM learning_generation_tasks")) return this.reviewBatchAttempted ? this.reviewAfterRace : this.reviewRow;
    return this.statusRow;
  }
  /** @param {string} query @param {readonly (string|number|null)[]} _bindings */
  all(query, _bindings) {
    if (query.startsWith("SELECT status, COUNT")) return this.taskRows;
    if (query.includes("FROM library_sources s")) return this.queueSourceRows;
    if (query.includes("FROM learning_generation_jobs g")) return this.queueGenerationRows;
    if (query.includes("FROM learning_generation_tasks t")) return this.queueTaskRows;
    return [];
  }
}

/** @param {number} revision @param {"pending-review"|"published"} status */
function reviewRow(revision, status) {
  const task = JSON.parse(JSON.stringify(record().tasks[0]));
  task.revision = revision;
  task.status = status;
  return { task_json: JSON.stringify(task), status, revision, generation_id: "generation-a", record_json: JSON.stringify(record()), generation_status: "completed" };
}

Deno.test("learning-generation migration creates normalized descendants, content-free tombstones, and durable budget tables", async () => {
  const sql = await Deno.readTextFile(new URL("../worker/migrations/0005_learning_generation.sql", import.meta.url));
  for (const table of ["learning_generation_jobs", "learning_generation_units", "learning_generation_tasks", "learning_generation_review_audits", "learning_generation_revocations", "learning_generation_tombstones", "learning_generation_facts", "learning_generation_budget_months", "learning_generation_budget_reservations"]) assertEquals(sql.includes(`CREATE TABLE ${table}`), true);
  const tombstones = sql.slice(sql.indexOf("CREATE TABLE learning_generation_tombstones"), sql.indexOf("CREATE TABLE learning_generation_facts"));
  assertEquals(tombstones.includes("content_digest"), false);
  assertEquals(tombstones.includes("prompt"), false);
  const queueSql = await Deno.readTextFile(new URL("../worker/migrations/0006_generation_queue_state.sql", import.meta.url));
  assertEquals(queueSql.includes("generation_state"), true);
  assertEquals(queueSql.includes("generation_failure"), true);
});

Deno.test("D1 generation repository persists bounded JSON rows and blocks revoked revisions", async () => {
  const database = new Database();
  assertEquals(isD1LearningGenerationDatabase(database), true);
  const repository = new D1LearningGenerationRepository({ database, logger: () => {} });
  const persisted = await repository.persist(record(), "fingerprint-a");
  assertEquals(persisted.ok, true);
  assertEquals(database.batches.length, 1);
  assertEquals(database.batches[0].length, 3);
  assertEquals(database.batches[0][0].query.includes("learning_generation_jobs"), true);
  database.revokedThrough = 1;
  const blocked = await repository.assertGenerationAllowed("owner-a", "source-a", 1);
  assertEquals(blocked.ok, false);
  if (!blocked.ok) assertEquals(blocked.error.kind, "LearningFreshRightsRequired");
});

Deno.test("D1 repository keeps owner-scoped status content-free", async () => {
  const database = new Database();
  database.statusRow = { generation_id: "generation-a", source_id: "source-a", source_revision: 1, item_id: "item-a", item_version_id: "version-a", status: "completed", local_only: 0, policy_version: "policy-v1", provider_request_id: "request-a", failure_kind: null, created_at: "2026-08-12T12:00:00.000Z" };
  database.taskRows = [{ status: "pending-review", count: 1 }];
  const result = await new D1LearningGenerationRepository({ database, logger: () => {} }).getStatus("owner-a", "generation-a");
  assertEquals(result.ok, true);
  if (result.ok && result.value !== null) assertEquals("contentDigest" in result.value, false);
});

Deno.test("D1 repository projects queued source status and pending review tasks without source bodies", async () => {
  const database = new Database();
  database.queueSourceRows = [{ source_id: "source-a", title: "Harmony", adapter_json: JSON.stringify({ capabilities: ["metadata", "bounded-ingestion"] }), ingestion_state: "pending", ingestion_failure: null, generation_state: "not-requested", generation_failure: null, content_count: 0 }];
  const result = await new D1LearningGenerationRepository({ database, logger: () => {} }).listQueue("owner-a");
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.sources[0].status, "queued");
  assertEquals(result.value.sources[0].title, "Harmony");
  assertEquals(result.value.tasks.length, 0);
  assertEquals("content" in result.value, false);
});

Deno.test("D1 review queue reports generation as in progress after ingestion commits", async () => {
  const database = new Database();
  database.queueSourceRows = [{ source_id: "source-a", title: "Harmony", adapter_json: JSON.stringify({ capabilities: ["metadata", "bounded-ingestion"] }), ingestion_state: "completed", ingestion_failure: null, generation_state: "queued", generation_failure: null, content_count: 1 }];
  const result = await new D1LearningGenerationRepository({ database, logger: () => {} }).listQueue("owner-a");
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.sources[0].status, "generating");
  assertEquals(result.value.sources[0].failureKind, null);
});

Deno.test("D1 review queue keeps an enqueue failure visible beside partial output", async () => {
  const database = new Database();
  database.queueSourceRows = [{ source_id: "source-a", title: "Harmony", adapter_json: JSON.stringify({ capabilities: ["metadata", "bounded-ingestion"] }), ingestion_state: "completed", ingestion_failure: null, generation_state: "failed", generation_failure: "LearningGenerationEnqueueFailed", content_count: 1 }];
  database.queueGenerationRows = [{ generation_id: "generation-a", source_id: "source-a", status: "completed", failure_kind: null, created_at: "2026-08-12T12:00:00.000Z", pending_count: 1, reviewed_count: 0 }];
  const result = await new D1LearningGenerationRepository({ database, logger: () => {} }).listQueue("owner-a");
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.sources[0].status, "failed");
  assertEquals(result.value.sources[0].failureKind, "LearningGenerationEnqueueFailed");
});

Deno.test("D1 review decisions name a stale concurrent revision", async () => {
  const database = new Database();
  database.reviewRow = reviewRow(1, "pending-review");
  database.reviewAfterRace = reviewRow(2, "pending-review");
  database.reviewConditionalChanges = 0;
  const result = await new D1LearningGenerationRepository({ database, logger: () => {} }).applyDecision({ ownerId: "owner-a", taskId: "task-a", expectedRevision: 1, decision: "approve", reviewedAt: "2026-08-12T12:01:00.000Z", idempotencyKey: "review-race-a" });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "LearningReviewRevisionStale");
    if (result.error.kind === "LearningReviewRevisionStale") assertEquals(result.error.actual, 2);
  }
});

Deno.test("D1 review decisions name a concurrent already-decided task", async () => {
  const database = new Database();
  database.reviewRow = reviewRow(1, "pending-review");
  database.reviewAfterRace = reviewRow(2, "published");
  database.reviewConditionalChanges = 0;
  const result = await new D1LearningGenerationRepository({ database, logger: () => {} }).applyDecision({ ownerId: "owner-a", taskId: "task-a", expectedRevision: 1, decision: "approve", reviewedAt: "2026-08-12T12:01:00.000Z", idempotencyKey: "review-race-b" });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "LearningReviewAlreadyDecided");
});
