// @ts-check

import {
  adaptiveYield,
  classifyLength,
  validateSegments,
} from "../src/features/prompt-bank/policy.js";
import { PromptBankRepository } from "../src/features/prompt-bank/repository.js";
import { PromptBankService } from "../src/features/prompt-bank/service.js";

/** @import { ContentExtentEvidence, ContentExtentPolicy, PromptClock, PromptGenerator } from "../src/features/prompt-bank/contracts.js" */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @type {ContentExtentPolicy} */
const policy = Object.freeze({
  shortMaxWords: 100,
  shortMaxSentences: 2,
  mediumMaxWords: 400,
  mediumMaxParagraphs: 2,
  maxUnitWords: 800,
  maxSegmentsPerCommand: 4,
  version: "extent-policy-v1",
});

/** @param {Partial<ContentExtentEvidence>} [overrides] @returns {ContentExtentEvidence} */
function evidence(overrides = {}) {
  return {
    ownerId: "owner-a",
    contentId: "content-a",
    contentVersion: 1,
    sourceKind: "text",
    wordCount: 80,
    sentenceCount: 2,
    paragraphCount: 1,
    transcriptSource: null,
    anchors: [
      { id: "anchor-1", excerpt: "one" },
      { id: "anchor-2", excerpt: "two" },
      { id: "anchor-3", excerpt: "three" },
    ],
    evidenceVersion: "evidence-v1",
    provenance: "fixture metadata",
    ...overrides,
  };
}

Deno.test("length classification uses ordered structural boundaries", () => {
  assertEquals(classifyLength(evidence(), policy).ok, true);
  const medium = classifyLength(
    evidence({
      wordCount: 101,
      sentenceCount: 3,
      paragraphCount: 2,
    }),
    policy,
  );
  assertEquals(medium.ok && medium.value, "medium");
  const long = classifyLength(
    evidence({
      wordCount: 401,
      sentenceCount: 8,
      paragraphCount: 3,
    }),
    policy,
  );
  assertEquals(long.ok && long.value, "long");
  const oversized = classifyLength(evidence({ wordCount: 801 }), policy);
  assertEquals(oversized.ok, false);
  if (!oversized.ok) {
    assertEquals(oversized.error.kind, "MaterialLengthBandUnknown");
  }
});

Deno.test("audio and video extent requires an attributed transcript", () => {
  const missing = classifyLength(
    evidence({
      sourceKind: "audio-video",
      transcriptSource: null,
    }),
    policy,
  );
  assertEquals(missing.ok, false);
  if (!missing.ok) {
    assertEquals(missing.error.kind, "MaterialLengthEvidenceMissing");
  }
});

Deno.test("adaptive anchor yield is bounded by the approved bands", () => {
  assertEquals(adaptiveYield("short", 1).ok, true);
  const medium = adaptiveYield("medium", 9);
  assertEquals(medium.ok && medium.value, 3);
  const long = adaptiveYield("long", 6);
  assertEquals(long.ok && long.value, 6);
  const unsupported = adaptiveYield("long", 1);
  assertEquals(unsupported.ok, false);
  if (!unsupported.ok) {
    assertEquals(unsupported.error.kind, "PromptYieldEvidenceMismatch");
  }
});

Deno.test("segmentation is ordered, bounded to 800 words, and capped at four units", () => {
  const valid = validateSegments([
    { id: "s1", startWord: 0, endWord: 800, sourceAnchorIds: ["a"] },
    { id: "s2", startWord: 800, endWord: 1_200, sourceAnchorIds: ["b"] },
  ], policy);
  assertEquals(valid.ok, true);
  const tooMany = validateSegments(
    Array.from({ length: 5 }, (_, index) => ({
      id: `s${index}`,
      startWord: index * 100,
      endWord: (index + 1) * 100,
      sourceAnchorIds: [`a${index}`],
    })),
    policy,
  );
  assertEquals(tooMany.ok, false);
  if (!tooMany.ok) {
    assertEquals(tooMany.error.kind, "MaterialSegmentationLimitExceeded");
  }
});

Deno.test("prompt generation rejects 1ms before and accepts the exact ten-minute boundary", async () => {
  const early = setup("2026-07-20T00:09:59.999Z");
  const tooSoon = await early.service.generate(command());
  assertEquals(tooSoon.ok, false);
  if (!tooSoon.ok) {
    assertEquals(tooSoon.error.kind, "PromptGenerationTooEarly");
  }
  assertEquals(early.repository.listPrompts("owner-a").length, 0);

  const exact = setup("2026-07-20T00:10:00.000Z");
  const generated = await exact.service.generate(command());
  assertEquals(generated.ok, true);
  if (generated.ok) assertEquals(generated.value.prompts.length, 1);
  assertEquals(exact.repository.listPrompts("owner-a").length, 1);
});

Deno.test("generation validates study owner and content version", async () => {
  const context = setup("2026-07-20T00:10:00.001Z");
  const ownerFailure = await context.service.generate({
    ...command(),
    ownerId: "owner-b",
  });
  assertEquals(ownerFailure.ok, false);
  if (!ownerFailure.ok) {
    assertEquals(ownerFailure.error.kind, "PromptSourceOwnerMismatch");
  }
  const versionFailure = await context.service.generate({
    ...command(),
    contentVersion: 2,
  });
  assertEquals(versionFailure.ok, false);
  if (!versionFailure.ok) {
    assertEquals(versionFailure.error.kind, "PromptSourceVersionMismatch");
  }
});

Deno.test("failed persistence exposes no generated prompt", async () => {
  const context = setup("2026-07-20T00:10:00.000Z", false);
  const result = await context.service.generate(command());
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "PromptGenerationPersistenceFailed");
  }
  assertEquals(context.repository.listPrompts("owner-a").length, 0);
});

Deno.test("duplicate generation stays explicit and idempotent", async () => {
  const context = setup("2026-07-20T00:10:00.001Z");
  assertEquals((await context.service.generate(command())).ok, true);
  const duplicate = await context.service.generate(command());
  assertEquals(duplicate.ok, false);
  if (!duplicate.ok) {
    assertEquals(duplicate.error.kind, "PromptGenerationAlreadyRecorded");
  }
  assertEquals(context.repository.listPrompts("owner-a").length, 1);
});

/** @param {string} now @param {boolean} [writeSucceeds] */
function setup(now, writeSucceeds = true) {
  const repository = new PromptBankRepository();
  /** @type {PromptClock} */
  const clock = { now: () => ({ ok: true, value: now }) };
  /** @param {import("../src/features/prompt-bank/contracts.js").PromptGenerationInput} input */
  function generate(input) {
    return Array.from({ length: input.count }, (_, index) => ({
      id: `${input.evidence.contentId}-prompt-${index + 1}`,
      ownerId: input.evidence.ownerId,
      contentId: input.evidence.contentId,
      contentVersion: input.evidence.contentVersion,
      knowledgeAnchorIds: [input.evidence.anchors[index].id],
      kind: /** @type {const} */ ("single-choice"),
      prompt: `Question ${index + 1}`,
      version: 1,
      generatedAt: input.generatedAt,
      eligibleAt: input.eligibleAt,
      generatorVersion: "fixture-generator-v1",
      policyVersion: input.policyVersion,
      provenance: /** @type {const} */ ("fixture-generator"),
    }));
  }
  /** @type {PromptGenerator} */
  const generator = {
    version: "fixture-generator-v1",
    generate,
  };
  const service = new PromptBankService({
    repository,
    policy,
    generator,
    clock,
    writer: () =>
      Promise.resolve(
        writeSucceeds ? { ok: true, value: /** @type {const} */ (true) } : {
          ok: false,
          error: {
            kind: /** @type {const} */ ("PromptGenerationPersistenceFailed"),
            recordId: "write",
          },
        },
      ),
    createId: () => "generation-1",
  });
  return { repository, service };
}

function command() {
  return {
    ownerId: "owner-a",
    contentId: "content-a",
    contentVersion: 1,
    evidence: evidence({ anchors: [{ id: "anchor-1", excerpt: "one" }] }),
    studyFact: {
      id: "study-1",
      ownerId: "owner-a",
      contentId: "content-a",
      contentVersion: 1,
      studiedAt: "2026-07-20T00:00:00.000Z",
    },
    idempotencyKey: "generate-content-a-v1",
  };
}
