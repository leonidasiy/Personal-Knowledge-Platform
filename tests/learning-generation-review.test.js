// @ts-check

import { LearningReviewService } from "../src/features/learning-generation/review.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

/** @returns {import("../src/features/learning-generation/contracts.js").LearningTask} */
function pendingTask() {
  return {
    id: "task-review",
    ownerId: "owner-a",
    sourceId: "source-a",
    sourceRevision: 1,
    itemId: "item-a",
    itemVersionId: "version-a",
    contentDigest: "sha256:a",
    version: 1,
    kind: "short-response",
    prompt: "Explain the fact.",
    explanation: "Use the cited evidence.",
    unitIds: ["unit-a"],
    sourceAnchorIds: ["anchor-a"],
    choices: null,
    correctChoiceIds: null,
    blankId: null,
    acceptedAnswers: null,
    expectedConcepts: ["fact"],
    minimumWords: 2,
    stimulus: null,
    responseKind: "text",
    generatorVersion: "generator-v1",
    policyVersion: "policy-v1",
    provenance: "provider-draft",
    reviewRequired: true,
    status: "pending-review",
    reviewDecision: null,
    reviewedAt: null,
    revision: 1,
    generatedAt: "2026-08-12T12:00:00.000Z",
  };
}

Deno.test("review approval publishes a pending task with an incremented revision", async () => {
  let stored = pendingTask();
  const service = new LearningReviewService({
    repository: {
      findTask: async () => ({ ok: true, value: stored }),
      applyDecision: async (command) => {
        stored = Object.freeze({
          ...stored,
          status: command.decision === "approve" ? "published" : "rejected",
          reviewDecision: command.decision === "approve" ? "approved" : "rejected",
          reviewedAt: command.reviewedAt,
          revision: stored.revision + 1,
        });
        return { ok: true, value: stored };
      },
      listVisible: async () => ({ ok: true, value: stored.status === "published" ? [stored] : [] }),
    },
    now: () => "2026-08-12T12:01:00.000Z",
    logger: () => {},
  });
  const result = await service.decide({
    ownerId: "owner-a",
    taskId: "task-review",
    expectedRevision: 1,
    decision: "approve",
    reviewedAt: "2026-08-12T12:01:00.000Z",
    idempotencyKey: "review-a",
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.status, "published");
  assertEquals(result.value.reviewDecision, "approved");
  assertEquals(result.value.revision, 2);
  const visible = await service.visible("owner-a");
  assertEquals(visible.ok, true);
  if (visible.ok) assertEquals(visible.value.length, 1);
});

Deno.test("review rejects stale, repeated, and malformed decisions without hiding the task", async () => {
  const task = pendingTask();
  const service = new LearningReviewService({
    repository: {
      findTask: async () => ({ ok: true, value: task }),
      applyDecision: async () => ({ ok: false, error: { kind: "LearningReviewPersistenceFailed" } }),
      listVisible: async () => ({ ok: true, value: [] }),
    },
    now: () => "2026-08-12T12:01:00.000Z",
    logger: () => {},
  });
  const stale = await service.decide({ ownerId: "owner-a", taskId: "task-review", expectedRevision: 2, decision: "approve", reviewedAt: "2026-08-12T12:01:00.000Z", idempotencyKey: "review-stale" });
  assertEquals(stale.ok, false);
  if (!stale.ok) assertEquals(stale.error.kind, "LearningReviewRevisionStale");

  const repeated = await service.decide({ ownerId: "owner-a", taskId: "task-review", expectedRevision: 1, decision: "approve", reviewedAt: "2026-08-12T12:01:00.000Z", idempotencyKey: "review-repeated" });
  assertEquals(repeated.ok, false);
  if (!repeated.ok) assertEquals(repeated.error.kind, "LearningReviewPersistenceFailed");

  const malformed = await service.decide({ ownerId: "owner-a", taskId: "task-review", expectedRevision: 1, decision: "unknown", reviewedAt: "bad", idempotencyKey: "review-invalid" });
  assertEquals(malformed.ok, false);
  if (!malformed.ok) assertEquals(malformed.error.kind, "LearningReviewCommandInvalid");
});
