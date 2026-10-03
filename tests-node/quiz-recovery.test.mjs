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
