// @ts-check

import { LearningReviewQueueService } from "../src/features/learning-generation/queue.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

const queue = /** @type {import("../src/features/learning-generation/contracts.js").LearningReviewQueue} */ ({ sources: [{ sourceId: "source-a", title: "Harmony", status: "queued", generationId: null, pendingTaskCount: 0, reviewedTaskCount: 0, failureKind: null }], tasks: [] });

Deno.test("review queue service validates owner, returns bounded status, and logs lifecycle", async () => {
  /** @type {string[]} */ const events = [];
  const service = new LearningReviewQueueService({ repository: { listQueue: async (ownerId) => { assertEquals(ownerId, "owner-a"); return { ok: true, value: queue }; } }, logger: (entry) => events.push(entry.event) });
  const invalid = await service.list(" ");
  assertEquals(invalid.ok, false);
  const result = await service.list("owner-a");
  assertEquals(result.ok, true);
  assertEquals(JSON.stringify(events), JSON.stringify(["learning-review-queue-failure", "learning-review-queue-entry", "learning-review-queue-success"]));
});

Deno.test("review queue service preserves named repository failures", async () => {
  const service = new LearningReviewQueueService({ repository: { listQueue: async () => ({ ok: false, error: { kind: "LearningReviewQueuePersistenceFailed" } }) }, logger: () => {} });
  const result = await service.list("owner-a");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "LearningReviewQueuePersistenceFailed");
});
