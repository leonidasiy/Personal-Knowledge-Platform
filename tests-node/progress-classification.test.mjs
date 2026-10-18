import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createLearningProgressService } from "../worker/learning-progress-d1.js";

test("progress and manual classification use real SQLite, isolate owners, preserve null history and reject stale edits", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE extraction_knowledge_points(owner_id TEXT, knowledge_id TEXT, point_json TEXT, source_id TEXT, source_revision INTEGER, PRIMARY KEY(owner_id,knowledge_id)); CREATE TABLE library_sources(owner_id TEXT, source_id TEXT, state TEXT, revision INTEGER); CREATE TABLE source_classifications(owner_id TEXT,source_id TEXT,source_revision INTEGER,main_subject TEXT,status TEXT); CREATE TABLE learning_generation_tasks(owner_id TEXT,task_id TEXT,item_id TEXT); CREATE TABLE learner_review_answers(owner_id TEXT,batch_id TEXT,question_id TEXT,answered_at TEXT,correct INTEGER,score REAL,PRIMARY KEY(owner_id,batch_id,question_id)); CREATE TABLE learner_feed_batches(owner_id TEXT,status TEXT,completed_at TEXT,item_ids_json TEXT);");
    db.exec(await readFile(new URL("../worker/migrations/0015_progress_classification.sql", import.meta.url), "utf8"));
    const events = [];
    const database = { prepare(query) {
      let values = [];
      return { bind(...v) { values = v; return this; }, async first() { return db.prepare(query).get(...values) ?? null; }, async all() { return { success: true, results: db.prepare(query).all(...values) }; }, async run() { const result = db.prepare(query).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; } };
    }, async batch() { throw new Error("Unexpected batch"); } };
    const service = createLearningProgressService({ database, now: () => "2026-09-19T12:00:00.000Z", logger: event => events.push(event) });
    const classification = { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "Harmony" };
    for (const owner of ["a", "b"]) {
      db.prepare("INSERT INTO library_sources VALUES(?,?,?,?)").run(owner, "s", "active", 1);
      db.prepare("INSERT INTO extraction_knowledge_points VALUES(?,?,?,?,?)").run(owner, "k", JSON.stringify({ classification }), "s", 1);
      db.prepare("INSERT INTO learning_generation_tasks VALUES(?,?,?)").run(owner, "q", "k");
    }
    db.prepare("INSERT INTO learner_review_answers(owner_id,batch_id,question_id,answered_at,correct,score) VALUES('a','legacy','q','2026-09-18T10:00:00.000Z',0,NULL)").run();
    const workflowQuestionId = `knowledge-workflow-task:run:${"knowledge:source:1:" + "a".repeat(64)}:${"b".repeat(200)}:choice`;
    db.prepare("INSERT INTO learner_review_answers VALUES('a','new',?,'2026-09-19T10:00:00.000Z',1,1,'k',80,1,0)").run(workflowQuestionId);
    db.prepare("INSERT INTO learner_review_answers(owner_id,batch_id,question_id,answered_at,correct,score) VALUES('b','foreign','q','2026-09-19T10:00:00.000Z',1,1)").run();
    db.prepare("INSERT INTO learner_feed_batches VALUES('a','completed','2026-09-18T09:00:00.000Z','[\"1\",\"2\",\"3\",\"4\",\"5\"]')").run();
    const progress = await service.loadProgress("a", 7, null);
    assert.equal(progress.ok, true);
    assert.equal(progress.value.attempts.count, 2);
    assert.deepEqual(progress.value.subjects, [{ id: "music", label: "Music & Performing Arts", accuracy: .5 }], "subject chart shows review accuracy");
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
    for (const [id, state, revision] of [["disabled", "disabled", 1], ["stale", "active", 2]]) {
      db.prepare("INSERT INTO library_sources VALUES('a',?,?,?)").run(id, state, revision);
      db.prepare("INSERT INTO extraction_knowledge_points VALUES('a',?,?,?,1)").run(id, JSON.stringify({ classification }), id);
    }
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO extraction_knowledge_points VALUES('a',?,?,'s',1)").run(`extra-${i}`, JSON.stringify({ classification }));
    db.prepare("INSERT INTO library_sources VALUES('a','unclassified-source','active',1)").run();
    db.prepare("INSERT INTO extraction_knowledge_points VALUES('a','unclassified',?,'unclassified-source',1)").run(JSON.stringify({ classification: { version: 1, primarySubject: null, secondarySubjects: [], subcategory: null } }));
    const inventory = await service.loadProgress("a", 7, null);
    assert.deepEqual(inventory.value.subjects.map(row => [row.id, row.accuracy]), [["music", null], ["mathematics", .5]], "unreviewed knowledge counts, manual classifications override metadata, disabled/stale/other-owner points excluded");
    assert.equal((await service.loadProgress("a", 90, null)).value.subjects[0].id, "music", "library inventory is independent of review period");
    db.prepare("INSERT INTO source_classifications VALUES('a','s',1,'computing','classified')").run();
    const canonical = await service.loadProgress("a", 7, null);
    assert.deepEqual(canonical.value.subjects.map(row => [row.id, row.accuracy]), [["computing", .5]], "current source classification supplies subjects even when point metadata is absent or legacy");
    assert.equal((await service.loadProgress("a", 7, "computing")).value.attempts.count, 2, "accuracy filters use the same canonical source subject");
    assert.equal((await service.loadProgress("a", 7, "music")).value.attempts.count, 0);
    assert.equal((await service.loadProgress("b", 7, "music")).value.subjects[0].accuracy, 1, "source classifications remain owner-isolated");
    db.prepare("UPDATE source_classifications SET source_revision=2 WHERE owner_id='a'").run();
    assert.deepEqual((await service.loadProgress("a", 7, null)).value.subjects.map(row => [row.id,row.accuracy]), [["music",null],["mathematics",.5]], "stale source classification cannot override current point metadata");
    db.prepare("UPDATE source_classifications SET source_revision=1 WHERE owner_id='a'").run();
    db.prepare("INSERT INTO library_sources VALUES('a','music-source','active',1)").run();
    db.prepare("INSERT INTO extraction_knowledge_points VALUES('a','music-point',?,'music-source',1)").run(JSON.stringify({ classification }));
    db.prepare("INSERT INTO learner_feed_batches VALUES('a','completed','2026-09-19T09:00:00.000Z',?)").run(JSON.stringify(["k", "extra-0", "music-point", "unclassified", "missing"]));
    db.prepare("INSERT INTO learner_feed_batches VALUES('b','completed','2026-09-19T09:00:00.000Z','[\"k\"]')").run();
    db.prepare("INSERT INTO learner_feed_batches VALUES('a','open',NULL,'[\"k\"]')").run();
    const computingActivity = (await service.loadProgress("a", 7, "computing")).value.activity.at(-1);
    assert.deepEqual(computingActivity, { date: "2026-09-19", studyBatches: 1, studyItems: 2, reviewAttempts: 1 }, "mixed batches count matching points and count the batch once using canonical source subjects");
    assert.equal((await service.loadProgress("a", 7, "music")).value.activity.at(-1).studyItems, 1, "point metadata remains the fallback for study classification");
    assert.equal((await service.loadProgress("a", 7, "physics")).value.activity.at(-1).studyBatches, 0, "no matching points means no matching study batch");
    const allActivity = (await service.loadProgress("a", 7, null)).value.activity;
    assert.equal(allActivity.reduce((n, row) => n + row.studyItems, 0), 10, "All subjects retains unknown, deleted and historical study items");
    assert.equal(allActivity.reduce((n, row) => n + row.studyBatches, 0), 2, "other owners and unfinished batches do not contribute");
    db.prepare("DELETE FROM extraction_knowledge_points WHERE owner_id='a'").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_classifications").get().n, 0, "corrections erased with point");
    db.exec("DROP TABLE learner_review_answers");
    assert.equal((await service.loadProgress("a", 7, null)).error.kind, "ProgressReadUnavailable");
  } finally { db.close(); }
});
