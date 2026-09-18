// @ts-check

import {
  calculateKnowledgeWeight,
  completeKnowledgeBatch,
  selectKnowledgeBatch,
  validateBatchRefresh,
} from "../src/features/learning-generation/batches.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

/** @param {number} value @returns {import("../src/features/learning-generation/batches.js").KnowledgeSelectionCandidate} */
function candidate(value) {
  return {
    knowledgeId: `knowledge-${value}`,
    sourceId: "source-a",
    questionId: `question-${value}`,
    viewCount: value,
    lastAnswerCorrect: null,
    scheduledDays: 0,
    preference: 0,
  };
}

Deno.test("knowledge weighting lowers selection probability after views, correct answers, and longer intervals", () => {
  const baseline = calculateKnowledgeWeight(candidate(0), { now: "2026-08-19T00:00:00.000Z" });
  const viewed = calculateKnowledgeWeight({ ...candidate(0), viewCount: 3 }, { now: "2026-08-19T00:00:00.000Z" });
  const correct = calculateKnowledgeWeight({ ...candidate(0), lastAnswerCorrect: true }, { now: "2026-08-19T00:00:00.000Z" });
  const longInterval = calculateKnowledgeWeight({ ...candidate(0), scheduledDays: 30 }, { now: "2026-08-19T00:00:00.000Z" });
  if (!(baseline > viewed && baseline > correct && baseline > longInterval)) {
    throw new Error("Expected every completed learning signal to reduce Feed weight.");
  }
  assertEquals(calculateKnowledgeWeight({ ...candidate(0), lastAnswerCorrect: false }, { now: "2026-08-19T00:00:00.000Z" }) > 0, true);
});

Deno.test("knowledge batch is bounded to five and never repeats a knowledge point", () => {
  const result = selectKnowledgeBatch(
    Array.from({ length: 9 }, (_, index) => candidate(index)),
    { count: 5, random: () => 0.42, now: "2026-08-19T00:00:00.000Z" },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.length, 5);
  assertEquals(new Set(result.value.map((item) => item.knowledgeId)).size, 5);
});

Deno.test("batch selection is explicit when fewer than five eligible pairs exist", () => {
  const result = selectKnowledgeBatch(
    [candidate(1), candidate(2)],
    { count: 5, random: () => 0.1, now: "2026-08-19T00:00:00.000Z" },
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "KnowledgeBatchInsufficientCandidates");
    if (result.error.kind === "KnowledgeBatchInsufficientCandidates") assertEquals(result.error.available, 2);
  }
});

Deno.test("bottom sentinel completes every card atomically and locks its paired questions", () => {
  const batch = {
    batchId: "feed-2026-08-19",
    learningDay: "2026-08-19",
    items: [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)],
    completed: false,
  };
  const incomplete = completeKnowledgeBatch(batch, { reachedBottom: false });
  assertEquals(incomplete.ok, false);
  if (!incomplete.ok) assertEquals(incomplete.error.kind, "LearningBatchIncomplete");
  const completed = completeKnowledgeBatch(batch, { reachedBottom: true });
  assertEquals(completed.ok, true);
  if (!completed.ok) return;
  assertEquals(completed.value.batch.completed, true);
  assertEquals(completed.value.unlockedQuestionIds.length, 5);
  const repeated = completeKnowledgeBatch(completed.value.batch, { reachedBottom: true });
  assertEquals(repeated.ok, false);
  if (!repeated.ok) assertEquals(repeated.error.kind, "LearningBatchAlreadyClosed");
});

Deno.test("Feed refresh is blocked until the current batch is complete", () => {
  const batch = {
    batchId: "feed-2026-08-19",
    learningDay: "2026-08-19",
    items: [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)],
    completed: false,
  };
  const locked = validateBatchRefresh(batch, { requestedDay: "2026-08-19" });
  assertEquals(locked.ok, false);
  if (!locked.ok) assertEquals(locked.error.kind, "LearningBatchIncomplete");
  const nextDay = validateBatchRefresh({ ...batch, completed: true }, { requestedDay: "2026-08-20" });
  assertEquals(nextDay.ok, true);
});

Deno.test("already completed batches may be selected again on a later day", () => {
  const result = selectKnowledgeBatch(
    Array.from({ length: 5 }, (_, index) => ({ ...candidate(index), viewCount: 2 })),
    { count: 5, random: () => 0.9, now: "2026-08-20T00:00:00.000Z" },
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.length, 5);
});
