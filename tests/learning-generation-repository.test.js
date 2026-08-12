// @ts-check

import { LearningGenerationRepository } from "../src/features/learning-generation/repository.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}

/** @returns {import("../src/features/learning-generation/contracts.js").LearningTask} */
function task() {
  return /** @type {import("../src/features/learning-generation/contracts.js").LearningTask} */ ({
    id: "task-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1,
    itemId: "item-a", itemVersionId: "version-a", contentDigest: "sha256:a", version: 1,
    kind: "single-choice", prompt: "What is the answer?", explanation: "The evidence states it.",
    unitIds: ["unit-a"], sourceAnchorIds: ["anchor-a"], choices: [{ id: "choice-a", label: "Answer" }],
    correctChoiceIds: ["choice-a"], blankId: null, acceptedAnswers: null, expectedConcepts: null,
    minimumWords: null, stimulus: null, responseKind: null, generatorVersion: "generator-v1",
    policyVersion: "policy-v1", provenance: "provider-draft", reviewRequired: false,
    status: "published", reviewDecision: null, reviewedAt: null, revision: 1,
    generatedAt: "2026-08-12T12:00:00.000Z",
  });
}

/** @returns {import("../src/features/learning-generation/contracts.js").LearningGenerationRecord} */
function record() {
  const unit = {
    id: "unit-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1,
    itemId: "item-a", itemVersionId: "version-a", contentDigest: "sha256:a", ordinal: 1,
    text: "The source evidence.", startOffset: 0, endOffset: 20, wordCount: 3,
    sourceAnchorIds: /** @type {[string]} */ (["anchor-a"]), provenance: /** @type {const} */ ("deterministic-unitization"), policyVersion: "unit-v1",
  };
  return /** @type {import("../src/features/learning-generation/contracts.js").LearningGenerationRecord} */ ({
    id: "generation-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1,
    itemId: "item-a", itemVersionId: "version-a", contentDigest: "sha256:a", sourceKind: "public-text",
    rightsEvidenceId: "rights-a", attribution: { label: "Publisher", sourceUrl: "https://publisher.example/item" },
    policyVersion: "policy-v1", units: [unit], tasks: [task()], status: "completed", localOnly: false,
    providerRequestId: "provider-a", failureKind: null, idempotencyKey: "generation-key-a",
    createdAt: "2026-08-12T12:00:00.000Z",
  });
}

Deno.test("generation repository persists and replays by owner-scoped idempotency", async () => {
  const repository = new LearningGenerationRepository({ logger: () => {} });
  const stored = await repository.persist(record(), "fingerprint-a");
  assertEquals(stored.ok, true);
  const replay = await repository.replay("owner-a", "generation-key-a");
  assertEquals(replay.ok, true);
  if (replay.ok && replay.value !== null) {
    assertEquals(replay.value.fingerprint, "fingerprint-a");
    assertEquals(replay.value.record.id, "generation-a");
  }
  const conflict = await repository.persist({ ...record(), id: "generation-b" }, "fingerprint-b");
  assertEquals(conflict.ok, false);
  if (!conflict.ok) assertEquals(conflict.error.kind, "LearningGenerationIdempotencyConflict");
});

Deno.test("repository applies owner-scoped review decisions and retains non-content audit facts", async () => {
  const repository = new LearningGenerationRepository({ logger: () => {} });
  await repository.persist({ ...record(), tasks: [{ ...task(), status: "pending-review", reviewRequired: true }] }, "fingerprint-a");
  const decided = await repository.applyDecision({
    ownerId: "owner-a", taskId: "task-a", expectedRevision: 1, decision: "approve",
    reviewedAt: "2026-08-12T12:01:00.000Z", idempotencyKey: "review-a",
  });
  assertEquals(decided.ok, true);
  if (decided.ok) assertEquals(decided.value.status, "published");
  const visible = await repository.listVisible("owner-a");
  assertEquals(visible.ok, true);
  if (visible.ok) assertEquals(visible.value.length, 1);
  const audits = await repository.listReviewAudits("owner-a");
  assertEquals(audits.ok, true);
  if (audits.ok) assertEquals(audits.value.length, 1);
});

Deno.test("revocation hides descendants, writes content-free tombstones, and preserves study facts", async () => {
  const repository = new LearningGenerationRepository({ logger: () => {} });
  await repository.persist(record(), "fingerprint-a");
  await repository.recordFact({ ownerId: "owner-a", taskId: "task-a", kind: "study-response", occurredAt: "2026-08-12T12:02:00.000Z", correct: true, scheduleStep: 1 });
  const revoked = await repository.revoke({
    ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1,
    idempotencyKey: "revoke-a", reason: "rights withdrawn", revokedAt: "2026-08-12T12:03:00.000Z",
  }, "revoke-fingerprint-a");
  assertEquals(revoked.ok, true);
  if (revoked.ok) {
    assertEquals(revoked.value.changedGenerations, 1);
    assertEquals(revoked.value.changedUnits, 1);
    assertEquals(revoked.value.changedTasks, 1);
    assertEquals(revoked.value.tombstones.length, 3);
    for (const tombstone of revoked.value.tombstones) {
      assertEquals(Object.hasOwn(tombstone, "contentDigest"), false);
      assertEquals(Object.hasOwn(tombstone, "text"), false);
      assertEquals(Object.hasOwn(tombstone, "prompt"), false);
    }
  }
  const visible = await repository.listVisible("owner-a");
  assertEquals(visible.ok, true);
  if (visible.ok) assertEquals(visible.value.length, 0);
  const facts = await repository.listFacts("owner-a");
  assertEquals(facts.ok, true);
  if (facts.ok) assertEquals(facts.value.length, 1);
  const allowedOldRevision = await repository.assertGenerationAllowed("owner-a", "source-a", 1);
  assertEquals(allowedOldRevision.ok, false);
  if (!allowedOldRevision.ok) assertEquals(allowedOldRevision.error.kind, "LearningFreshRightsRequired");
  const allowedFreshRevision = await repository.assertGenerationAllowed("owner-a", "source-a", 2);
  assertEquals(allowedFreshRevision.ok, true);
  const replay = await repository.revoke({
    ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1,
    idempotencyKey: "revoke-a", reason: "rights withdrawn", revokedAt: "2026-08-12T12:03:00.000Z",
  }, "revoke-fingerprint-a");
  assertEquals(replay.ok, true);
  if (replay.ok) assertEquals(replay.value.reused, true);
  const conflict = await repository.revoke({
    ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1,
    idempotencyKey: "revoke-a", reason: "different reason", revokedAt: "2026-08-12T12:03:00.000Z",
  }, "revoke-fingerprint-b");
  assertEquals(conflict.ok, false);
  if (!conflict.ok) assertEquals(conflict.error.kind, "LearningRevocationConflict");
});
