// @ts-check

import { LearningGenerationStatusService } from "../src/features/learning-generation/status.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

Deno.test("status service validates identity and returns a content-free projection", async () => {
  const service = new LearningGenerationStatusService({
    repository: { getStatus: async () => ({ ok: true, value: { id: "generation-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", status: "completed", localOnly: false, policyVersion: "policy-v1", providerRequestId: "request-a", failureKind: null, taskCounts: { published: 1, pendingReview: 0, rejected: 0, hidden: 0 }, createdAt: "2026-08-12T12:00:00.000Z" } }) },
    logger: () => {},
  });
  const invalid = await service.get({ ownerId: "owner-a" });
  assertEquals(invalid.ok, false);
  if (!invalid.ok) assertEquals(invalid.error.kind, "LearningGenerationStatusCommandInvalid");
  const result = await service.get({ ownerId: "owner-a", generationId: "generation-a" });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals("contentDigest" in result.value, false);
});

