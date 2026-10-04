import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { D1SourceClassificationBackfillRepository } from "../worker/source-classification-backfill-d1.js";

test("D1 backfill adapter pages only the owner's active sources and current-revision points, and checkpoints idempotently", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE library_sources (owner_id TEXT, source_id TEXT, revision INTEGER, title TEXT, state TEXT, PRIMARY KEY(owner_id, source_id));
    CREATE TABLE extraction_knowledge_points (owner_id TEXT, source_id TEXT, source_revision INTEGER, knowledge_id TEXT, point_json TEXT);
    CREATE TABLE source_classifications (owner_id TEXT, source_id TEXT, source_revision INTEGER, origin TEXT, status TEXT);
    CREATE TABLE source_classification_backfill_checkpoints (owner_id TEXT, source_id TEXT, source_revision INTEGER, status TEXT, updated_at TEXT, PRIMARY KEY(owner_id, source_id, source_revision));
    INSERT INTO library_sources VALUES ('owner-a','s1',2,'Title','active'), ('owner-a','s2',1,'Other','active'), ('owner-b','s3',1,'Private','active');
    INSERT INTO extraction_knowledge_points VALUES ('owner-a','s1',1,'stale','{}'), ('owner-a','s1',2,'p1','{"summary":"current","attribution":{"sourceUrl":"https://example.test"}}'), ('owner-b','s3',1,'secret','{}');
  `);
  const database = {
    prepare(sql) {
      let values = [];
      return {
        bind(...bound) { values = bound; return this; },
        async all() { const result = sqlite.prepare(sql).all(...values); return { success: true, results: result }; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
  };
  const repository = new D1SourceClassificationBackfillRepository({ database, now: () => "2026-10-04T00:00:00.000Z", logger: () => {} });
  const sources = await repository.pageSources({ ownerId: "owner-a", afterSourceId: null, limit: 1 });
  assert.deepEqual(sources.value.sources.map(({ id }) => id), ["s1"]);
  assert.equal(sources.value.nextCursor, "s1");
  const points = await repository.pagePoints({ ownerId: "owner-a", sourceId: "s1", sourceRevision: 2, afterKnowledgeId: null, limit: 10 });
  assert.deepEqual(points.value.points.map(({ id }) => id), ["p1"]);
  assert.deepEqual(await repository.checkpoint({ ownerId: "owner-a", sourceId: "s1", sourceRevision: 2, status: "read" }), { ok: true, value: null });
  assert.deepEqual(await repository.checkpoint({ ownerId: "owner-a", sourceId: "s1", sourceRevision: 2, status: "completed" }), { ok: true, value: null });
  assert.deepEqual(await repository.checkpoint({ ownerId: "owner-a", sourceId: "s1", sourceRevision: 2, status: "read" }), { ok: true, value: "completed" });
  sqlite.close();
});
