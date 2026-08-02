// @ts-check

import {
  createTsFsrsScheduler,
  TS_FSRS_VERSION,
} from "../src/features/recall/ts-fsrs-adapter.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const scheduler = createTsFsrsScheduler({
  requestRetention: 0.9,
  maximumInterval: 36_500,
  enableFuzz: false,
  enableShortTerm: true,
  learningSteps: ["1m", "10m"],
  relearningSteps: ["10m"],
});

Deno.test("pinned FSRS schedules a first good review at the approved learning step", () => {
  const reviewedAt = "2026-07-19T10:00:00.000Z";
  const result = scheduler.schedule({
    memory: null,
    rating: "good",
    reviewedAt,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.dueAt, "2026-07-19T10:10:00.000Z");
  assertEquals(result.value.schedulerVersion, TS_FSRS_VERSION);
  assert(result.value.stability > 0, "Stability should be positive.");
});

Deno.test("repeated success advances a card into a multi-day interval", () => {
  const firstAt = "2026-07-19T10:00:00.000Z";
  const first = scheduler.schedule({
    memory: null,
    rating: "good",
    reviewedAt: firstAt,
  });
  if (!first.ok) throw new Error(first.error.kind);
  const memory = {
    ownerId: "owner-a",
    knowledgeUnitId: "unit-a",
    ...first.value,
    reviewCount: 1,
  };
  const second = scheduler.schedule({
    memory,
    rating: "good",
    reviewedAt: first.value.dueAt,
  });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assert(
    second.value.scheduledDays >= 1,
    "Repeated success should schedule at least one day.",
  );
  assert(
    Date.parse(second.value.dueAt) > Date.parse(first.value.dueAt),
    "Due time should advance.",
  );
});

Deno.test("a lapse uses the injected relearning steps", () => {
  const first = scheduler.schedule({
    memory: null,
    rating: "good",
    reviewedAt: "2026-07-19T10:00:00.000Z",
  });
  if (!first.ok) throw new Error(first.error.kind);
  const learned = scheduler.schedule({
    memory: {
      ownerId: "owner-a",
      knowledgeUnitId: "unit-a",
      ...first.value,
      reviewCount: 1,
    },
    rating: "good",
    reviewedAt: first.value.dueAt,
  });
  if (!learned.ok) throw new Error(learned.error.kind);
  const lapseAt = learned.value.dueAt;
  const lapsed = scheduler.schedule({
    memory: {
      ownerId: "owner-a",
      knowledgeUnitId: "unit-a",
      ...learned.value,
      reviewCount: 2,
    },
    rating: "again",
    reviewedAt: lapseAt,
  });
  assertEquals(lapsed.ok, true);
  if (!lapsed.ok) return;
  assertEquals(
    lapsed.value.dueAt,
    new Date(Date.parse(lapseAt) + 10 * 60_000).toISOString(),
  );
});

Deno.test("long inactivity remains schedulable with finite output", () => {
  const first = scheduler.schedule({
    memory: null,
    rating: "good",
    reviewedAt: "2026-07-19T10:00:00.000Z",
  });
  if (!first.ok) throw new Error(first.error.kind);
  const result = scheduler.schedule({
    memory: {
      ownerId: "owner-a",
      knowledgeUnitId: "unit-a",
      ...first.value,
      reviewCount: 1,
    },
    rating: "good",
    reviewedAt: "2027-07-19T10:00:00.000Z",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assert(
      Number.isFinite(result.value.stability),
      "Stability must remain finite.",
    );
    assert(
      Date.parse(result.value.dueAt) > Date.parse("2027-07-19T10:00:00.000Z"),
      "Due time must advance.",
    );
  }
});

Deno.test("malformed and wrong-version memory return named failures", () => {
  const base = {
    ownerId: "owner-a",
    knowledgeUnitId: "unit-a",
    dueAt: "2026-07-20T00:00:00.000Z",
    stability: 1,
    difficulty: 5,
    scheduledDays: 1,
    schedulerState: "{",
    schedulerVersion: TS_FSRS_VERSION,
    reviewCount: 1,
  };
  const malformed = scheduler.schedule({
    memory: base,
    rating: "good",
    reviewedAt: "2026-07-20T00:00:00.000Z",
  });
  assertEquals(malformed.ok, false);
  if (!malformed.ok) {
    assertEquals(malformed.error.kind, "RecallSchedulerRejected");
  }

  const wrongVersion = scheduler.schedule({
    memory: { ...base, schedulerVersion: "different-scheduler" },
    rating: "good",
    reviewedAt: "2026-07-20T00:00:00.000Z",
  });
  assertEquals(wrongVersion.ok, false);
  if (!wrongVersion.ok) {
    assertEquals(wrongVersion.error.kind, "RecallSchedulerRejected");
  }
});

Deno.test("invalid adapter configuration fails at composition", () => {
  let threw = false;
  try {
    createTsFsrsScheduler({
      requestRetention: 1.2,
      maximumInterval: 36_500,
      enableFuzz: false,
      enableShortTerm: true,
      learningSteps: ["1m", "10m"],
      relearningSteps: ["10m"],
    });
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true);
});
