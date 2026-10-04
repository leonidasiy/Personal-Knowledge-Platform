import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import {
  D1KnowledgeContentRepository,
  D1QuizRepository,
} from "../worker/knowledge-workflow-content-d1.js";
import { D1KnowledgeWorkflowRepository } from "../worker/knowledge-workflow-d1.js";
import { createKnowledgeWorkflowService } from "../src/features/knowledge-workflows/workflow.js";
import { createQuizActorCritic } from "../src/features/knowledge-workflows/quiz.js";
import { assembleQuizPair } from "../src/features/knowledge-workflows/quiz-pair.js";
import { createLearningBatchService } from "../worker/learning-batches-d1.js";

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const directory = new URL("../worker/migrations/", import.meta.url);
  for (
    const name of (await readdir(directory)).filter((name) =>
      name.endsWith(".sql")
    ).sort()
  ) db.exec(await readFile(new URL(name, directory), "utf8"));
  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          const s = db.prepare(sql);
          return {
            first: async () => s.get(...values) ?? null,
            all: async () => ({ success: true, results: s.all(...values) }),
            run: async () => ({
              success: true,
              meta: { changes: Number(s.run(...values).changes) },
            }),
            execute: () => ({
              success: true,
              meta: { changes: Number(s.run(...values).changes) },
            }),
          };
        },
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const result = statements.map((s) => s.execute());
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const now = () => "2026-10-02T12:00:00.000Z";
  db.prepare(
    "INSERT INTO library_sources (owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "owner",
    "source",
    "https://example.test/source",
    "https://example.test/source",
    "Synthetic source",
    "Offline test",
    "{}",
    "[]",
    "active",
    now(),
    now(),
    1,
  );
  const service = createKnowledgeWorkflowService(
    new D1KnowledgeWorkflowRepository({ database, logger: () => {} }),
    {
      now,
      createId: () => "run",
      logger: () => {},
    },
  );
  const created = await service.createRun({
    ownerId: "owner",
    sourceId: "source",
    sourceRevision: 1,
    canonicalSourceIdentity: "https://example.test/source",
    contentSignature: "content",
    configDigests: {},
    idempotencyKey: "create",
  });
  assert.ok(created.ok);
  return {
    db,
    database,
    now,
    repository: new D1QuizRepository({ database, logger: () => {}, now }),
  };
}

test("publication failure retries retain old attempts, publish once and cascade history on erase", async () => {
  const f = await fixture();
  try {
    const point = {
      id: "point",
      sourceId: "source",
      sourceRevision: 1,
      summary: "A cadence closes a phrase.",
      normalizedHash: "cadence",
      evidenceAnchors: [{
        url: "https://example.test/source",
        selector: "main",
      }],
      coverageGoalIds: [],
      mediaCandidates: [],
      attribution: { sourceUrl: "https://example.test/source" },
      extractionVersion: "v1",
    };
    let generations = 0, failPublication = true;
    assert.deepEqual(
      await new D1KnowledgeContentRepository({
        database: f.database,
        logger: () => {},
      }).appendKnowledgePoint(point, "owner", "run", f.now()),
      { ok: true, value: null },
    );
    const repository = {
      findPublished: (s) => f.repository.findPublished(s),
      appendAttempt: (a) => f.repository.appendAttempt(a),
      publish: (c) =>
        failPublication
          ? Promise.resolve({
            ok: false,
            error: { kind: "SyntheticPublicationFailure" },
          })
          : f.repository.publish(c),
      restrict: (c) => f.repository.restrict(c),
      discard: (c) => f.repository.discard(c),
      purge: (c) => f.repository.purge(c),
    };
    const actor = createQuizActorCritic({
      repository,
      now: f.now,
      logger: () => {},
      maxAttempts: 3,
      generator: {
        generate: async () => ({
          ok: true,
          value: {
            id: `draft-${++generations}`,
            knowledgeId: "point",
            knowledgeRevision: 1,
            kind: "single-choice",
            prompt: "What closes a phrase?",
            options: ["Cadence", "Pickup"],
            answer: "Cadence",
            explanation: "A cadence closes the phrase.",
            citedEvidenceUrls: ["https://example.test/source"],
          },
        }),
      },
      evaluator: {
        evaluate: async () => ({
          ok: true,
          value: {
            score: 9,
            reasons: ["Grounded"],
            feedback: "Keep",
            groundingProblems: [],
          },
        }),
      },
    });
    const command = { ownerId: "owner", runId: "run", points: [point] };
    const first = await actor.run(command);
    assert.equal(first.ok, false);
    const original = f.db.prepare(
      "SELECT * FROM knowledge_workflow_quiz_attempts",
    ).get();
    failPublication = false;
    assert.deepEqual(await actor.run(command), {
      ok: true,
      value: {
        dispositions: [{
          knowledgeId: "point",
          status: "accepted",
          publicationStatus: "published",
          attempts: 1,
          failureKind: null,
          restrictedUntil: null,
        }],
      },
    });
    assert.deepEqual(
      f.db.prepare("SELECT * FROM knowledge_workflow_quiz_attempts").get(),
      original,
    );
    assert.equal(
      f.db.prepare(
        "SELECT COUNT(*) AS n FROM knowledge_workflow_quiz_retry_attempts",
      ).get().n,
      2,
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM knowledge_workflow_quizzes").get()
        .n,
      1,
    );
    assert.deepEqual(await actor.run(command), {
      ok: true,
      value: {
        dispositions: [{
          knowledgeId: "point",
          status: "accepted",
          publicationStatus: "published",
          attempts: 1,
          failureKind: null,
          restrictedUntil: null,
        }],
      },
    });
    assert.equal(generations, 2);
    assert.deepEqual(
      await f.repository.findPublished({
        ownerId: "another-owner",
        runId: "run",
        knowledgeId: "point",
      }),
      { ok: true, value: null },
    );
    f.db.prepare(
      "DELETE FROM knowledge_workflow_quiz_attempts WHERE owner_id=? AND knowledge_id=?",
    ).run("owner", "point");
    assert.equal(
      f.db.prepare(
        "SELECT COUNT(*) AS n FROM knowledge_workflow_quiz_retry_attempts",
      ).get().n,
      0,
    );
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.db.close();
  }
});

test("paired quiz publication and learner review keep answers private and update knowledge progress once", async () => {
  const f = await fixture();
  try {
    const point = { id: "point", sourceId: "source", sourceRevision: 1, summary: "A tonic is the tonal center.", normalizedHash: "tonic", evidenceAnchors: [{ url: "https://example.test/source", selector: "main" }], coverageGoalIds: [], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/source" }, extractionVersion: "v1" };
    const content = new D1KnowledgeContentRepository({ database: f.database, logger: () => {} });
    assert.deepEqual(await content.appendKnowledgePoint(point, "owner", "run", f.now()), { ok: true, value: null });
    f.db.prepare("UPDATE knowledge_workflow_runs SET state = 'completed' WHERE owner_id = 'owner' AND run_id = 'run'").run();
    const pair = assembleQuizPair({ knowledgeId: "point", knowledgeRevision: 1, canonicalAnswers: ["tonic"], citedEvidenceUrls: ["https://example.test/source"], multipleChoice: { prompt: "Which pitch is the tonal center?", options: [{ key: "choice-tonic", text: "Tonic" }, { key: "choice-dominant", text: "Dominant" }], correctOptionKeys: ["choice-tonic"], correctOptionAnswers: [{ key: "choice-tonic", canonicalAnswer: "tonic" }], explanation: "The tonic is the tonal center." }, fillBlank: { prompt: "The tonal center is the ____.", blanks: [{ id: "blank-1", canonicalAnswer: "tonic", acceptedAnswers: ["tonic", "tonic note"] }], explanation: "The tonic names the tonal center." } }, "quiz:source:point:r1");
    const draft = { id: pair.multipleChoice.id, knowledgeId: "point", knowledgeRevision: 1, kind: "single-choice", prompt: pair.multipleChoice.prompt, options: ["Tonic", "Dominant"], answer: "Tonic", explanation: pair.multipleChoice.explanation, citedEvidenceUrls: pair.citedEvidenceUrls, pairedQuiz: pair };
    f.db.exec("CREATE TRIGGER fail_pair_task BEFORE INSERT ON learning_generation_tasks WHEN NEW.task_id = 'knowledge-workflow-task:run:point' BEGIN SELECT RAISE(ABORT, 'synthetic pair publication failure'); END;");
    assert.equal((await f.repository.publish({ ownerId: "owner", runId: "run", knowledge: point, draft, score: 9, attempt: 1, status: "published" })).ok, false);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM knowledge_workflow_quizzes WHERE owner_id = 'owner' AND knowledge_id = 'point'").get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM learning_generation_jobs WHERE owner_id = 'owner' AND item_id = 'point'").get().n, 0);
    f.db.exec("DROP TRIGGER fail_pair_task;");
    assert.deepEqual(await f.repository.publish({ ownerId: "owner", runId: "run", knowledge: point, draft, score: 9, attempt: 1, status: "published" }), { ok: true, value: null });
    const taskId = "knowledge-workflow-task:run:point";
    f.db.prepare("INSERT INTO learner_knowledge_state (owner_id, knowledge_id, source_id, view_count, studied_at, updated_at) VALUES ('owner', 'point', 'source', 1, ?, ?)").run(f.now(), f.now());
    f.db.prepare("INSERT INTO learner_review_batches (owner_id, batch_id, learning_day, status, question_ids_json, revision, idempotency_key, created_at) VALUES ('owner', 'review-pair', '2026-10-02', 'open', ?, 1, 'pair-review', ?)").run(JSON.stringify([taskId]), f.now());
    const service = createLearningBatchService({ database: f.database, now: f.now, logger: () => {}, semanticGrader: async () => ({ ok: true, value: [true] }) });
    const loaded = await service.loadReview("owner", "2026-10-02");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const question = loaded.value.questions[0];
    assert.equal(question?.pairedVariants?.length, 2);
    assert.equal(JSON.stringify(question).includes("acceptedAnswers"), false);
    assert.equal(JSON.stringify(question).includes("correctChoiceIds"), false);
    assert.equal(JSON.stringify(question).includes("explanation"), false);
    const command = { ownerId: "owner", batchId: "review-pair", questionId: taskId, questionRevision: 1, selectedChoiceIds: ["choice-tonic"], pairedBlankAnswers: [{ id: "blank-1", text: "Tonic" }], idempotencyKey: "answer-pair" };
    f.db.exec("CREATE TRIGGER fail_pair_command BEFORE INSERT ON learner_batch_commands WHEN NEW.idempotency_key = 'answer-pair' BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END;");
    const failedWrite = await service.answerReview(command);
    assert.equal(failedWrite.ok, false);
    assert.equal(f.db.prepare("SELECT review_count FROM learner_knowledge_state WHERE owner_id = 'owner' AND knowledge_id = 'point'").get().review_count, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM learner_review_answers WHERE owner_id = 'owner' AND question_id = ?").get(taskId).n, 0);
    f.db.exec("DROP TRIGGER fail_pair_command;");
    const answer = await service.answerReview(command);
    assert.equal(answer.ok, true);
    assert.equal(f.db.prepare("SELECT review_count FROM learner_knowledge_state WHERE owner_id = 'owner' AND knowledge_id = 'point'").get().review_count, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM learner_review_answers WHERE owner_id = 'owner' AND question_id = ?").get(taskId).n, 1);
    assert.deepEqual(await service.answerReview(command), answer);
    assert.equal(f.db.prepare("SELECT review_count FROM learner_knowledge_state WHERE owner_id = 'owner' AND knowledge_id = 'point'").get().review_count, 1);
  } finally { f.db.close(); }
});

test("concurrent paired answers close a migrated five-question review batch exactly once", async () => {
  const f = await fixture();
  try {
    const content = new D1KnowledgeContentRepository({ database: f.database, logger: () => {} });
    const taskIds = [];
    const questions = [];
    for (let index = 1; index <= 5; index += 1) {
      const knowledgeId = `pair-${index}`;
      const answerText = `answer ${index}`;
      const point = { id: knowledgeId, sourceId: "source", sourceRevision: 1, summary: `Synthetic paired knowledge ${index}.`, normalizedHash: `pair-hash-${index}`, evidenceAnchors: [{ url: "https://example.test/source", selector: "main" }], coverageGoalIds: [], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/source" }, extractionVersion: "v1" };
      assert.deepEqual(await content.appendKnowledgePoint(point, "owner", "run", f.now()), { ok: true, value: null });
      const pair = assembleQuizPair({ knowledgeId, knowledgeRevision: 1, canonicalAnswers: [answerText], citedEvidenceUrls: ["https://example.test/source"], multipleChoice: { prompt: `Which option identifies ${knowledgeId}?`, options: [{ key: `choice-${index}-correct`, text: answerText }, { key: `choice-${index}-wrong`, text: "Other" }], correctOptionKeys: [`choice-${index}-correct`], correctOptionAnswers: [{ key: `choice-${index}-correct`, canonicalAnswer: answerText }], explanation: `${answerText} identifies ${knowledgeId}.` }, fillBlank: { prompt: `${knowledgeId} is ____ .`, blanks: [{ id: "blank-1", canonicalAnswer: answerText, acceptedAnswers: [answerText] }], explanation: `${answerText} identifies ${knowledgeId}.` } }, `quiz:source:${knowledgeId}:r1`);
      const draft = { id: pair.multipleChoice.id, knowledgeId, knowledgeRevision: 1, kind: "single-choice", prompt: pair.multipleChoice.prompt, options: [answerText, "Other"], answer: answerText, explanation: pair.multipleChoice.explanation, citedEvidenceUrls: pair.citedEvidenceUrls, pairedQuiz: pair };
      assert.deepEqual(await f.repository.publish({ ownerId: "owner", runId: "run", knowledge: point, draft, score: 9, attempt: 1, status: "published" }), { ok: true, value: null });
      const taskId = `knowledge-workflow-task:run:${knowledgeId}`;
      taskIds.push(taskId);
      questions.push({ taskId, knowledgeId, choiceId: `choice-${index}-correct`, answerText });
      f.db.prepare("INSERT INTO learner_knowledge_state (owner_id, knowledge_id, source_id, view_count, studied_at, updated_at) VALUES ('owner', ?, 'source', 1, ?, ?)").run(knowledgeId, f.now(), f.now());
    }
    f.db.prepare("UPDATE knowledge_workflow_runs SET state = 'completed' WHERE owner_id = 'owner' AND run_id = 'run'").run();
    f.db.prepare("INSERT INTO learner_review_batches (owner_id, batch_id, learning_day, status, question_ids_json, revision, idempotency_key, created_at) VALUES ('owner', 'review-race', '2026-10-02', 'open', ?, 1, 'review-race-key', ?)").run(JSON.stringify(taskIds), f.now());
    const service = createLearningBatchService({ database: f.database, now: f.now, logger: () => {} });
    const answer = (question, idempotencyKey) => service.answerReview({ ownerId: "owner", batchId: "review-race", questionId: question.taskId, questionRevision: 1, selectedChoiceIds: [question.choiceId], pairedBlankAnswers: [{ id: "blank-1", text: question.answerText }], idempotencyKey });

    for (const question of questions.slice(0, 3)) {
      const result = await answer(question, `answer-${question.taskId}`);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      if (result.ok) assert.equal(result.value.completed, false);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM learner_review_answers WHERE owner_id = 'owner' AND batch_id = 'review-race'").get().count, 3);

    const finalCommands = questions.slice(3).map((question) => answer(question, `answer-${question.taskId}`));
    const outcomes = await Promise.all(finalCommands);
    assert(outcomes.every((outcome) => outcome.ok), JSON.stringify(outcomes));
    assert.equal(outcomes.filter((outcome) => outcome.ok && outcome.value.completed).length, 1);
    const completedBatch = f.db.prepare("SELECT status, revision, completed_at FROM learner_review_batches WHERE owner_id = 'owner' AND batch_id = 'review-race'").get();
    assert.equal(completedBatch.status, "completed");
    assert.equal(completedBatch.revision, 2);
    assert.equal(completedBatch.completed_at, f.now());
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM learner_review_answers WHERE owner_id = 'owner' AND batch_id = 'review-race'").get().count, 5);

    const replay = await answer(questions[4], `answer-${questions[4].taskId}`);
    const original = outcomes[1];
    assert.deepEqual(replay, original);
    assert.equal(f.db.prepare("SELECT SUM(review_count) AS count FROM learner_knowledge_state WHERE owner_id = 'owner'").get().count, 5);
  } finally { f.db.close(); }
});

test("retry audit failure rolls back its legacy parent and reports persistence failure", async () => {
  const f = await fixture();
  try {
    f.db.exec(
      "CREATE TRIGGER reject_retry BEFORE INSERT ON knowledge_workflow_quiz_retry_attempts BEGIN SELECT RAISE(ABORT,'SyntheticAuditFailure'); END",
    );
    const result = await f.repository.appendAttempt({
      id: "new",
      ownerId: "owner",
      runId: "run",
      knowledgeId: "point",
      attempt: 1,
      draftId: null,
      score: null,
      feedback: null,
      failureKind: "QuizGeneratorFailed",
      createdAt: f.now(),
    });
    assert.deepEqual(result, {
      ok: false,
      error: { kind: "QuizPersistenceFailed" },
    });
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM knowledge_workflow_quiz_attempts")
        .get().n,
      0,
    );
  } finally {
    f.db.close();
  }
});
