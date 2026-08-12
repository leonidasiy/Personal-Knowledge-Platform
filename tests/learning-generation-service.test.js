// @ts-check

import { LearningGenerationService } from "../src/features/learning-generation/service.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

const now = "2026-08-12T12:00:00.000Z";
const policy = Object.freeze({
  version: "learning-generation-v1",
  unitization: {
    version: "unitization-v1",
    maximumContentCharacters: 500,
    maximumWordsPerUnit: 30,
    maximumUnits: 10,
    maximumExcerptCharacters: 200,
  },
  maximumProviderInputCharacters: 200,
  maximumProviderUnits: 3,
  maximumTasks: 3,
  maximumOutputTokens: 120,
  factualSamplingRatePercent: 0,
  samplingVersion: "factual-sampling-v1",
  providerInstruction: "Return grounded JSON tasks only.",
  monthlyBudgetUsd: 2,
});

const rights = Object.freeze({
  kind: "public",
  ownerId: "owner-a",
  sourceId: "source-a",
  sourceRevision: 2,
  evidenceId: "rights-a",
  status: "active",
  storageAllowed: true,
  displayAllowed: true,
  transformationAllowed: true,
  assessedAt: now,
  expiresAt: null,
  attribution: { label: "Publisher", sourceUrl: "https://publisher.example/lesson" },
});

const manualRights = Object.freeze({
  kind: "manual",
  ownerId: "owner-a",
  sourceId: "source-a",
  sourceRevision: 2,
  evidenceId: "attestation-a",
  status: "active",
  storageAllowed: true,
  transformationAllowed: true,
  attestationReference: "attestation-reference-a",
  attestationBasis: "user supplied permitted transcript",
  assessedAt: now,
  expiresAt: null,
});

function command(overrides = {}) {
  return {
    ownerId: "owner-a",
    sourceId: "source-a",
    sourceRevision: 2,
    itemId: "item-a",
    itemVersionId: "version-a",
    contentDigest: "sha256:content-a",
    sourceKind: "public-text",
    content: "A piano has 88 keys.",
    rights,
    idempotencyKey: "generation-a",
    policy,
    ...overrides,
  };
}

Deno.test("generation service unitizes eligible public text, reserves budget, validates drafts, and persists publication", async () => {
  /** @type {unknown[]} */
  const providerCommands = [];
  /** @type {unknown[]} */
  const reservations = [];
  /** @type {unknown[]} */
  const reconciliations = [];
  /** @type {import("../src/features/learning-generation/contracts.js").LearningGenerationRecord[]} */
  const persisted = [];
  const service = new LearningGenerationService({
    repository: {
      replay: async () => ({ ok: true, value: null }),
      assertGenerationAllowed: async () => ({ ok: true, value: true }),
      persist: async (record) => {
        persisted.push(record);
        return { ok: true, value: record };
      },
    },
    provider: {
      generate: async (input) => {
        providerCommands.push(input);
        return {
          ok: true,
          value: {
            requestId: "provider-request-a",
            usage: { inputTokens: 20, outputTokens: 12 },
            drafts: [{
              id: "task-a",
              kind: "single-choice",
              prompt: "How many keys does a piano have?",
              explanation: "The source states the standard count.",
              unitIds: ["unit:source-a:item-a:version-a:1"],
              sourceAnchorIds: ["unit:source-a:item-a:version-a:1:anchor"],
              choices: [{ id: "choice-a", label: "88" }, { id: "choice-b", label: "61" }],
              correctChoiceIds: ["choice-a"],
            }],
          },
        };
      },
    },
    budget: {
      reserve: async (input) => {
        reservations.push(input);
        return { ok: true, value: { reservationId: "reservation-a", ownerId: input.ownerId, month: input.month, amountUsd: input.amountUsd } };
      },
      reconcile: async (input) => {
        reconciliations.push(input);
        return { ok: true, value: true };
      },
    },
    costModel: { estimate: () => 0.25, actual: () => 0.15 },
    createId: () => "generation-a",
    now: () => now,
    logger: () => {},
  });

  const result = await service.generate(command());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.status, "completed");
  assertEquals(result.value.tasks.length, 1);
  assertEquals(result.value.tasks[0].status, "published");
  assertEquals(providerCommands.length, 1);
  assertEquals(reservations.length, 1);
  assertEquals(reconciliations.length, 1);
  assertEquals(persisted.length, 1);
  assertEquals(persisted[0].providerRequestId, "provider-request-a");
});

Deno.test("manual transcripts are unitized locally without provider or budget work", async () => {
  let providerCalls = 0;
  let budgetCalls = 0;
  /** @type {import("../src/features/learning-generation/contracts.js").LearningGenerationRecord[]} */
  const records = [];
  const service = new LearningGenerationService({
    repository: {
      replay: async () => ({ ok: true, value: null }),
      assertGenerationAllowed: async () => ({ ok: true, value: true }),
      persist: async (record) => {
        records.push(record);
        return { ok: true, value: record };
      },
    },
    provider: { generate: async () => {
      providerCalls += 1;
      throw new Error("provider must not be called for manual material");
    } },
    budget: {
      reserve: async () => {
        budgetCalls += 1;
        throw new Error("budget must not be reserved for manual material");
      },
      reconcile: async () => ({ ok: true, value: true }),
    },
    costModel: { estimate: () => 0.25, actual: () => 0.15 },
    createId: () => "generation-manual",
    now: () => now,
    logger: () => {},
  });
  const result = await service.generate(command({ sourceKind: "manual-transcript", rights: manualRights, content: "A permitted private transcript." }));
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.localOnly, true);
    assertEquals(result.value.tasks.length, 0);
    assertEquals(result.value.units.length, 1);
  }
  assertEquals(providerCalls, 0);
  assertEquals(budgetCalls, 0);
  assertEquals(records.length, 1);
});
