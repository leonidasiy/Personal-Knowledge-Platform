// @ts-check

import { validateDrafts } from "../src/features/learning-generation/validation.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function context(overrides = {}) {
  return {
    ownerId: "owner-a",
    sourceId: "source-a",
    sourceRevision: 2,
    itemId: "item-a",
    itemVersionId: "version-a",
    contentDigest: "sha256:content-a",
    generatorVersion: "deepseek-v4-flash-adapter-v1",
    policyVersion: "learning-generation-v1",
    samplingVersion: "factual-sampling-v1",
    factualSamplingRatePercent: 0,
    generatedAt: "2026-08-12T12:00:00.000Z",
    units: [{
      id: "unit-a",
      sourceAnchorIds: ["anchor-a"],
      text: "A piano has 88 keys.",
    }],
    ...overrides,
  };
}

function factualDraft(overrides = {}) {
  return {
    id: "task-a",
    kind: "single-choice",
    prompt: "How many keys does a piano have?",
    explanation: "The cited source states the standard count.",
    unitIds: ["unit-a"],
    sourceAnchorIds: ["anchor-a"],
    choices: [{ id: "choice-a", label: "88" }, { id: "choice-b", label: "61" }],
    correctChoiceIds: ["choice-a"],
    ...overrides,
  };
}

Deno.test("validation accepts a grounded factual draft and auto-publishes an unsampled item", () => {
  const result = validateDrafts([factualDraft()], context());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.length, 1);
  assertEquals(result.value[0].status, "published");
  assertEquals(result.value[0].reviewRequired, false);
  assertEquals(result.value[0].provenance, "provider-draft");
});

Deno.test("validation applies the versioned 30 percent factual sample and reviews non-factual tasks", () => {
  const sampled = validateDrafts(
    [factualDraft({ id: "task-c" })],
    context({ factualSamplingRatePercent: 30 }),
  );
  assertEquals(sampled.ok, true);
  if (sampled.ok) {
    assertEquals(sampled.value[0].reviewRequired, true);
    assertEquals(sampled.value[0].status, "pending-review");
  }

  const open = validateDrafts([{
    id: "task-open",
    kind: "short-response",
    prompt: "Explain the cited fact.",
    explanation: "The learner must explain the cited fact.",
    unitIds: ["unit-a"],
    sourceAnchorIds: ["anchor-a"],
    expectedConcepts: ["88 keys"],
    minimumWords: 2,
  }], context({ factualSamplingRatePercent: 30 }));
  assertEquals(open.ok, true);
  if (open.ok) assertEquals(open.value[0].reviewRequired, true);
});

Deno.test("validation fails closed for ungrounded answers, unknown anchors, and unsafe symbolic events", () => {
  const ungrounded = validateDrafts([
    factualDraft({ choices: [{ id: "choice-a", label: "99" }, { id: "choice-b", label: "61" }] }),
  ], context());
  assertEquals(ungrounded.ok, false);
  if (!ungrounded.ok) assertEquals(ungrounded.error.kind, "LearningDraftUngrounded");

  const unknownAnchor = validateDrafts([
    factualDraft({ sourceAnchorIds: ["missing-anchor"] }),
  ], context());
  assertEquals(unknownAnchor.ok, false);
  if (!unknownAnchor.ok) assertEquals(unknownAnchor.error.kind, "LearningDraftUngrounded");

  const unsafeSymbolic = validateDrafts([{
    id: "task-midi",
    kind: "symbolic-midi",
    prompt: "Identify the note.",
    explanation: "Review the symbolic stimulus.",
    unitIds: ["unit-a"],
    sourceAnchorIds: ["anchor-a"],
    stimulus: {
      representation: "midi",
      ticksPerBeat: 480,
      events: [{ pitch: 200, startTick: 0, durationTicks: 120, velocity: 80 }],
      clef: null,
      timeSignature: "4/4",
    },
  }], context());
  assertEquals(unsafeSymbolic.ok, false);
  if (!unsafeSymbolic.ok) assertEquals(unsafeSymbolic.error.kind, "LearningSymbolicStimulusInvalid");
});
