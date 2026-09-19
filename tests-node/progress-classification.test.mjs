import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createLearningProgressService } from "../worker/learning-progress-d1.js";

test("progress and manual classification use real SQLite, isolate owners, preserve null history and reject stale edits", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE extraction_knowledge_points(owner_id TEXT, knowledge_id TEXT, point_json TEXT, PRIMARY KEY(owner_id,knowledge_id)); CREATE TABLE learning_generation_tasks(owner_id TEXT,task_id TEXT,item_id TEXT); CREATE TABLE learner_review_answers(owner_id TEXT,batch_id TEXT,question_id TEXT,answered_at TEXT,correct INTEGER,score REAL,PRIMARY KEY(owner_id,batch_id,question_id)); CREATE TABLE learner_feed_batches(owner_id TEXT,status TEXT,completed_at TEXT,item_ids_json TEXT);");
    db.exec(await readFile(new URL("../worker/migrations/0015_progress_classification.sql", import.meta.url), "utf8"));
    const events = [];
    const database = { prepare(query) {
      let values = [];
      return { bind(...v) { values = v; return this; }, async first() { return db.prepare(query).get(...values) ?? null; }, async all() { return { success: true, results: db.prepare(query).all(...values) }; }, async run() { const result = db.prepare(query).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; } };
    }, async batch() { throw new Error("Unexpected batch"); } };
    const service = createLearningProgressService({ database, now: () => "2026-09-19T12:00:00.000Z", logger: event => events.push(event) });
    const classification = { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "Harmony" };
    for (const owner of ["a", "b"]) {
      db.prepare("INSERT INTO extraction_knowledge_points VALUES(?,?,?)").run(owner, "k", JSON.stringify({ classification }));
      db.prepare("INSERT INTO learning_generation_tasks VALUES(?,?,?)").run(owner, "q", "k");
    }
    db.prepare("INSERT INTO learner_review_answers(owner_id,batch_id,question_id,answered_at,correct,score) VALUES('a','legacy','q','2026-09-18T10:00:00.000Z',0,NULL)").run();
    db.prepare("INSERT INTO learner_review_answers VALUES('a','new','q','2026-09-19T10:00:00.000Z',1,1,'k',80,1,0)").run();
    db.prepare("INSERT INTO learner_review_answers(owner_id,batch_id,question_id,answered_at,correct,score) VALUES('b','foreign','q','2026-09-19T10:00:00.000Z',1,1)").run();
    db.prepare("INSERT INTO learner_feed_batches VALUES('a','completed','2026-09-18T09:00:00.000Z','[\"1\",\"2\",\"3\",\"4\",\"5\"]')").run();
    const progress = await service.loadProgress("a", 7, null);
    assert.equal(progress.ok, true);
    assert.equal(progress.value.attempts.count, 2);
    assert.equal(progress.value.attempts.accuracy, .5);
    assert.equal(progress.value.intervals.at(-1).count, 1);
    assert.equal(Object.hasOwn(progress.value, "confidence"), false);
    assert.equal(progress.value.recovery.recovered, 1);
    assert.deepEqual(await service.loadProgress("a", 7, null), progress, "read/reload cannot add attempts");
    const edited = await service.correctClassification({ ownerId: "a", knowledgeId: "k", expectedRevision: 0, classification: { ...classification, primarySubject: "mathematics" } });
    assert.equal(edited.ok, true);
    assert.equal(edited.value.classificationRevision, 1);
    assert.equal((await service.loadProgress("a", 7, "music")).value.attempts.count, 0);
    assert.equal((await service.loadProgress("b", 7, "music")).value.attempts.count, 1);
    assert.equal((await service.correctClassification({ ownerId: "a", knowledgeId: "k", expectedRevision: 0, classification })).error.kind, "ClassificationConflict");
    assert.equal((await service.correctClassification({ ownerId: "stranger", knowledgeId: "k", expectedRevision: 0, classification })).error.kind, "ClassificationConflict");
    assert.equal((await service.correctClassification({ ownerId: "a", knowledgeId: "k", expectedRevision: 1, classification: { ...classification, primarySubject: "invented" } })).error.kind, "ClassificationCommandInvalid");
    assert.equal((await service.loadProgress("a", 6, null)).error.kind, "ProgressCommandInvalid");
    assert.equal(events.some(event => "classification" in event || "point_json" in event), false);
    db.prepare("DELETE FROM extraction_knowledge_points WHERE owner_id='a'").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_classifications").get().n, 0, "corrections erased with point");
    db.exec("DROP TABLE learner_review_answers");
    assert.equal((await service.loadProgress("a", 7, null)).error.kind, "ProgressReadUnavailable");
  } finally { db.close(); }
});
