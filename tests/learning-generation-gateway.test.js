// @ts-check

import { LearningGenerationBrowserGatewayClient } from "../src/features/learning-generation/browser-gateway.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

/** @param {(request: Request) => Promise<Response>} respond */
function gateway(respond) {
  return new LearningGenerationBrowserGatewayClient({ fetch: (input, init) => respond(new Request(input, init)), baseUrl: "https://app.example/", timeoutMs: 100 });
}

const task = {
  id: "task-a", sourceId: "source-a", kind: "short-response", prompt: "Explain.", explanation: "Evidence.", sourceAnchorIds: ["unit-a:anchor"], choices: null, correctChoiceIds: null, expectedConcepts: ["evidence"], minimumWords: 1, stimulus: null, responseKind: "text", status: "pending-review", revision: 1,
};

Deno.test("learning gateway parses queued source status and bounded pending task context", async () => {
  const result = await gateway(() => Promise.resolve(Response.json({ result: { sources: [{ sourceId: "source-a", title: "Harmony", status: "queued", generationId: null, pendingTaskCount: 0, reviewedTaskCount: 0, failureKind: null }], tasks: [] } }))).listQueue();
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.sources[0].status, "queued");
  assertEquals(result.value.tasks.length, 0);

  const generated = await gateway(() => Promise.resolve(Response.json({ result: { sources: [{ sourceId: "source-a", title: "Harmony", status: "ready-for-review", generationId: "generation-a", pendingTaskCount: 1, reviewedTaskCount: 0, failureKind: null }], tasks: [task] } }))).listQueue();
  assertEquals(generated.ok, true);
  if (!generated.ok) throw new Error(generated.error.kind);
  assertEquals(generated.value.tasks[0].prompt, "Explain.");
});

Deno.test("learning gateway posts a Keep or Discard decision without accepting a browser owner", async () => {
  /** @type {unknown} */ let body = null;
  const result = await gateway(async (request) => {
    body = await request.json();
    return Response.json({ result: { taskId: "task-a", status: "published", reviewDecision: "approved", reviewedAt: "2026-08-12T12:00:00.000Z", revision: 2 } });
  }).decide({ taskId: "task-a", expectedRevision: 1, decision: "approve", reviewedAt: "2026-08-12T12:00:00.000Z", idempotencyKey: "review-a" });
  assertEquals(result.ok, true);
  assertEquals(Object.hasOwn(/** @type {Record<string, unknown>} */ (body), "ownerId"), false);
  const invalid = await gateway(() => Promise.resolve(Response.json({ result: {} }))).decide({ ownerId: "attacker", taskId: "task-a", expectedRevision: 1, decision: "approve", reviewedAt: "2026-08-12T12:00:00.000Z", idempotencyKey: "review-a" });
  assertEquals(invalid.ok, false);
});

Deno.test("learning gateway preserves named queue availability and revision failures", async () => {
  const unavailable = await gateway(() => Promise.resolve(Response.json({ error: "LearningReviewQueuePersistenceFailed" }, { status: 503 }))).listQueue();
  assertEquals(unavailable.ok, false);
  if (!unavailable.ok) assertEquals(unavailable.error.kind, "LearningGatewayRejected");
  const stale = await gateway(() => Promise.resolve(Response.json({ error: "LearningReviewRevisionStale" }, { status: 409 }))).decide({ taskId: "task-a", expectedRevision: 1, decision: "reject", reviewedAt: "2026-08-12T12:00:00.000Z", idempotencyKey: "review-a" });
  assertEquals(stale.ok, false);
  if (!stale.ok) assertEquals(stale.error.kind, "LearningGatewayRejected");
});
