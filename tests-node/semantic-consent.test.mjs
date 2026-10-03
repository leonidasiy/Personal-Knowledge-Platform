import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { D1SourceLibraryRepository } from "../worker/source-library-d1.js";

/** @param {DatabaseSync} database */
function d1Port(database) {
  return {
    prepare(query) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return database.prepare(query).get(...bindings) ?? null; },
        async all() { return { success: true, results: database.prepare(query).all(...bindings) }; },
        async run() { const result = database.prepare(query).run(...bindings); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
    async batch(statements) { return await Promise.all(statements.map((statement) => statement.run())); },
  };
}

test("production semantic candidates permit only literal JSON true on active uploaded knowledge", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE library_sources (owner_id TEXT, source_id TEXT, state TEXT, title TEXT, canonical_url TEXT, revision INTEGER); CREATE TABLE extraction_knowledge_points (owner_id TEXT, run_id TEXT, source_id TEXT, source_revision INTEGER, knowledge_id TEXT, point_json TEXT, created_at TEXT); CREATE TABLE knowledge_workflow_materials (owner_id TEXT, run_id TEXT, material_json TEXT); CREATE TABLE learner_knowledge_state (owner_id TEXT, knowledge_id TEXT, studied_at TEXT);");
  database.exec("CREATE TABLE knowledge_workflow_runs (owner_id TEXT, run_id TEXT, source_id TEXT, source_revision INTEGER, state TEXT); CREATE TABLE knowledge_workflow_quizzes (owner_id TEXT, run_id TEXT, source_id TEXT, source_revision INTEGER, knowledge_id TEXT, status TEXT); CREATE TABLE learning_generation_tasks (owner_id TEXT, item_id TEXT, status TEXT);");
  const source = database.prepare("INSERT INTO library_sources VALUES (?, ?, ?, ?, ?, 1)");
  const point = database.prepare("INSERT INTO extraction_knowledge_points VALUES (?, ?, ?, ?, ?, ?, ?)");
  const material = database.prepare("INSERT INTO knowledge_workflow_materials VALUES (?, ?, ?)");
  for (const [owner, id, state, value] of [["owner-a", "false", "active", false], ["owner-a", "missing", "active", undefined], ["owner-a", "string", "active", "true"], ["owner-a", "true", "active", true], ["owner-a", "disabled", "disabled", false], ["owner-b", "foreign", "active", true]]) {
    source.run(owner, id, state, `source ${id}`, `https://app.example/${owner}/${id}`);
    database.prepare("INSERT INTO knowledge_workflow_runs VALUES (?, ?, ?, 1, 'completed')").run(owner, `run-${id}`, id);
    database.prepare("INSERT INTO knowledge_workflow_quizzes VALUES (?, ?, ?, 1, ?, 'published')").run(owner, `run-${id}`, id, `knowledge-${id}`);
    database.prepare("INSERT INTO learning_generation_tasks VALUES (?, ?, 'published')").run(owner, `knowledge-${id}`);
    point.run(owner, `run-${id}`, id, 1, `knowledge-${id}`, JSON.stringify({ summary: `summary ${id}`, attribution: { sourceUrl: `https://app.example/${owner}/${id}` }, evidenceAnchors: [{ id: `anchor-${id}` }] }), "2026-09-08T00:00:00.000Z");
    material.run(owner, `run-${id}`, JSON.stringify(value === undefined ? { provenance: {} } : { provenance: { processingAllowed: value } }));
  }
  const result = await new D1SourceLibraryRepository(d1Port(database)).knowledgeSemanticCandidates({ ownerId: "owner-a", limit: 20 });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assert.deepEqual(result.value.candidates.map((candidate) => candidate.knowledge.knowledgeId), ["knowledge-true"]);
  assert.equal(result.value.privateDerivedCount, 3);
  database.close();
});
