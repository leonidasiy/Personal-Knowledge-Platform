// @ts-check

import { LearningGenerationEnqueuer } from "../worker/learning-generation-enqueuer.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

const policy = {
  version: "generation-v1", unitization: { version: "unit-v1", maximumContentCharacters: 500, maximumWordsPerUnit: 30, maximumUnits: 5, maximumExcerptCharacters: 200 },
  maximumProviderInputCharacters: 200, maximumProviderUnits: 3, maximumTasks: 3, maximumOutputTokens: 120,
  factualSamplingRatePercent: 30, samplingVersion: "sampling-v1", providerInstruction: "Return grounded JSON.", monthlyBudgetUsd: 2,
};

Deno.test("generation enqueuer creates bounded public commands after content commit", async () => {
  /** @type {unknown[]} */ const commands = [];
  /** @type {unknown[]} */ const logs = [];
  const enqueuer = new LearningGenerationEnqueuer({
    generate: async (command) => { commands.push(command); return { ok: true, value: null }; },
    now: () => "2026-08-12T12:00:00.000Z", logger: (entry) => logs.push(entry), maximumItems: 2,
  });
  const result = await enqueuer.enqueue({
    ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, rightsEvidenceId: "rights-a",
    attribution: { label: "Publisher", sourceUrl: "https://publisher.example/course" }, policy,
    items: [
      { itemId: "item-a", itemVersionId: "version-a", contentDigest: "sha256:a", content: "A useful lesson." },
      { itemId: "item-b", itemVersionId: "version-b", contentDigest: "sha256:b", content: "Another useful lesson." },
    ],
  });
  assertEquals(result.ok, true);
  assertEquals(commands.length, 2);
  const first = /** @type {{ readonly sourceKind: string, readonly content: string, readonly rights: { readonly kind: string }, readonly idempotencyKey: string }} */ (/** @type {unknown} */ (commands[0]));
  assertEquals(first.sourceKind, "public-text");
  assertEquals(first.rights.kind, "public");
  assertEquals(first.content, "A useful lesson.");
  assertEquals(first.idempotencyKey.includes("item-a"), true);
  assertEquals(JSON.stringify(logs).includes("A useful lesson."), false);
});

Deno.test("generation enqueuer rejects an over-bounded batch before provider work", async () => {
  let calls = 0;
  const enqueuer = new LearningGenerationEnqueuer({ generate: async () => { calls += 1; return { ok: true, value: null }; }, now: () => "2026-08-12T12:00:00.000Z", logger: () => {}, maximumItems: 1 });
  const result = await enqueuer.enqueue({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, rightsEvidenceId: "rights-a", attribution: { label: "Publisher", sourceUrl: "https://publisher.example/course" }, policy, items: [{ itemId: "a", itemVersionId: "a", contentDigest: "sha256:a", content: "A." }, { itemId: "b", itemVersionId: "b", contentDigest: "sha256:b", content: "B." }] });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "LearningGenerationEnqueueLimitExceeded");
  assertEquals(calls, 0);
});
