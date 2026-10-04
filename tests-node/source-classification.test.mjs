import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { D1SourceClassificationRepository } from "../worker/source-classification-d1.js";

/** @param {DatabaseSync} database */
function d1(database) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = database.prepare(sql);
          return {
            first: async () => statement.get(...values) ?? null,
            run: async () => {
              const result = statement.run(...values);
              return { success: true, meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
    async batch() { throw new Error("UnexpectedBatchCall"); },
  };
}

/** @returns {Promise<DatabaseSync>} */
async function databaseWithMigrations() {
  const database = new DatabaseSync(":memory:");
  const names = (await readdir(new URL("../worker/migrations/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) database.exec(await readFile(new URL(`../worker/migrations/${name}`, import.meta.url), "utf8"));
  database.prepare("INSERT INTO library_sources (owner_id, source_id, submitted_url, canonical_url, title, description, adapter_json, identity_evidence_json, state, approved_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)").run("owner-a", "source-a", "https://example.test/a", "https://example.test/a", "Harmony", "", "{}", "[]", "2026-10-04T00:00:00.000Z", "2026-10-04T00:00:00.000Z");
  database.prepare("INSERT INTO knowledge_workflow_runs (owner_id, run_id, source_id, source_revision, canonical_source_identity, content_signature, state, revision, idempotency_key, config_digests_json, extraction_started_at, extraction_deadline_at, decision_required, counts_json, failure_kind, reused, created_at, updated_at, run_json) VALUES ('owner-a','run-a','source-a',1,'https://example.test/a','sig','completed',1,'key','{}',NULL,NULL,NULL,'{}',NULL,0,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z','{}')").run();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM knowledge_workflow_runs WHERE owner_id = 'owner-a' AND run_id = 'run-a'").get().count, 1);
  database.prepare("INSERT INTO extraction_knowledge_points (owner_id, run_id, knowledge_id, source_id, source_revision, normalized_hash, point_json, created_at) VALUES ('owner-a','run-a','knowledge-a','source-a',1,'hash-a',?,'2026-10-04T00:00:00.000Z')").run(JSON.stringify({ summary: "A cadence resolves harmonic tension.", attribution: { sourceUrl: "https://example.test/a" }, evidenceAnchors: [{ url: "https://example.test/a", selector: "#a" }] }));
  database.prepare("INSERT INTO extraction_knowledge_points (owner_id, run_id, knowledge_id, source_id, source_revision, normalized_hash, point_json, created_at) VALUES ('owner-a','run-a','knowledge-b','source-a',1,'hash-b',?,'2026-10-04T00:00:00.000Z')").run(JSON.stringify({ summary: "A secondary dominant prepares resolution.", attribution: { sourceUrl: "https://example.test/a" }, evidenceAnchors: [{ url: "https://example.test/a", selector: "#b" }] }));
  return database;
}

test("source classification is owner scoped, insert once, manually revision checked, and retries preserve manual values", async () => {
  const database = await databaseWithMigrations();
  const repository = new D1SourceClassificationRepository({ database: d1(database), now: () => "2026-10-04T00:00:00.000Z", logger: () => {} });
  const legacyAudit = [{ knowledgeId: "knowledge-a", classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "cadences" } }];
  const first = await repository.persistAgent({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, classification: { mainSubject: "music", topic: "Cadential harmony" }, legacyAudit });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.inserted, true);
  assert.deepEqual(first.value.value.legacyAudit, legacyAudit);
  const wrongOwner = await repository.persistAgent({ ownerId: "owner-b", sourceId: "source-a", sourceRevision: 1, classification: { mainSubject: "arts", topic: "Wrong owner" }, legacyAudit: [] });
  assert.equal(wrongOwner.ok, false);
  if (!wrongOwner.ok) assert.equal(wrongOwner.error.kind, "SourceClassificationSourceMissing");
  const edited = await repository.updateManual({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, expectedRevision: 1, classification: { mainSubject: "music", topic: "Secondary dominants" } });
  assert.equal(edited.ok, true);
  const retry = await repository.persistAgent({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, classification: { mainSubject: "arts", topic: "Retry must not overwrite" }, legacyAudit: [] });
  assert.equal(retry.ok, true);
  if (retry.ok) {
    assert.equal(retry.value.inserted, false);
    assert.equal(retry.value.value.origin, "manual");
    assert.equal(retry.value.value.topic, "Secondary dominants");
  }
  const [raceA, raceB] = await Promise.all([
    repository.updateManual({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, expectedRevision: 2, classification: { mainSubject: "music", topic: "One winner" } }),
    repository.updateManual({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, expectedRevision: 2, classification: { mainSubject: "music", topic: "Other winner" } }),
  ]);
  assert.equal([raceA, raceB].filter((item) => item.ok).length, 1);
  assert.equal([raceA, raceB].filter((item) => !item.ok && item.error.kind === "SourceClassificationRevisionConflict").length, 1);
  database.close();
});

test("0019 indexes topic-only and content-only matches, refreshes edits, and keeps one row per point", async () => {
  const database = await databaseWithMigrations();
  const repository = new D1SourceClassificationRepository({ database: d1(database), now: () => "2026-10-04T00:00:00.000Z", logger: () => {} });
  await repository.persistAgent({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, classification: { mainSubject: "music", topic: "Xylophone taxonomy" }, legacyAudit: [] });
  const find = (term) => database.prepare("SELECT knowledge_id FROM knowledge_points_search_fts WHERE knowledge_points_search_fts MATCH ? AND owner_id = 'owner-a' ORDER BY knowledge_id").all(term).map((row) => row.knowledge_id);
  assert.deepEqual(find("xylophone"), ["knowledge-a", "knowledge-b"]);
  assert.deepEqual(find("cadence"), ["knowledge-a"]);
  assert.deepEqual(find("gamelan"), []);
  const edited = await repository.updateManual({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, expectedRevision: 1, classification: { mainSubject: "music", topic: "Gamelan taxonomy" } });
  assert.equal(edited.ok, true);
  assert.deepEqual(find("xylophone"), []);
  assert.deepEqual(find("gamelan"), ["knowledge-a", "knowledge-b"]);
  assert.deepEqual(find("dominant"), ["knowledge-b"]);
  assert.deepEqual(database.prepare("SELECT knowledge_id, source_id FROM knowledge_points_search_fts WHERE owner_id = 'owner-a' ORDER BY knowledge_id").all().map(({ knowledge_id, source_id }) => [knowledge_id, source_id]), [["knowledge-a", "source-a"], ["knowledge-b", "source-a"]]);
  database.close();
});

test("review issues keep named failure counts and cannot be written for another owner", async () => {
  const database = await databaseWithMigrations();
  const repository = new D1SourceClassificationRepository({ database: d1(database), now: () => "2026-10-04T00:00:00.000Z", logger: () => {} });
  assert.equal((await repository.recordReviewIssue({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, issueKind: "inference-failed" })).ok, true);
  assert.equal((await repository.recordReviewIssue({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, issueKind: "inference-failed" })).ok, true);
  const row = database.prepare("SELECT issue_kind, attempts FROM source_classification_review_issues WHERE owner_id = 'owner-a' AND source_id = 'source-a'").get();
  assert.deepEqual({ ...row }, { issue_kind: "inference-failed", attempts: 2 });
  const unauthorized = await repository.recordReviewIssue({ ownerId: "owner-b", sourceId: "source-a", sourceRevision: 1, issueKind: "inference-failed" });
  assert.equal(unauthorized.ok, false);
  if (!unauthorized.ok) assert.equal(unauthorized.error.kind, "SourceClassificationSourceMissing");
  database.close();
});
