// @ts-check

import { createLearningScheduler } from "../src/features/learning-generation/schedule.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

Deno.test("scheduler follows exact 10-minute, 1-day, 3-day, and 7-day validation boundaries", () => {
  const scheduler = createLearningScheduler({
    fsrs: { schedule: () => ({ ok: true, value: { dueAt: "2026-08-30T12:00:00.000Z", schedulerState: "fsrs-state" } }) },
    logger: () => {},
  });
  const first = scheduler.next({ taskId: "task-a", previous: null, correct: true, reviewedAt: "2026-08-12T12:00:00.000Z" });
  assertEquals(first.ok, true);
  if (!first.ok) return;
  assertEquals(first.value.step, 1);
  assertEquals(first.value.dueAt, "2026-08-12T12:10:00.000Z");

  const second = scheduler.next({ taskId: "task-a", previous: first.value, correct: true, reviewedAt: first.value.dueAt });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assertEquals(second.value.step, 2);
  assertEquals(second.value.dueAt, "2026-08-13T12:10:00.000Z");

  const third = scheduler.next({ taskId: "task-a", previous: second.value, correct: true, reviewedAt: second.value.dueAt });
  assertEquals(third.ok, true);
  if (!third.ok) return;
  assertEquals(third.value.step, 3);
  assertEquals(third.value.dueAt, "2026-08-16T12:10:00.000Z");

  const fourth = scheduler.next({ taskId: "task-a", previous: third.value, correct: true, reviewedAt: third.value.dueAt });
  assertEquals(fourth.ok, true);
  if (!fourth.ok) return;
  assertEquals(fourth.value.step, 4);
  assertEquals(fourth.value.dueAt, "2026-08-23T12:10:00.000Z");
});

Deno.test("scheduler restarts the ladder after an incorrect response and delegates after the seven-day step", () => {
  let fsrsCalls = 0;
  const scheduler = createLearningScheduler({
    fsrs: { schedule: (input) => {
      fsrsCalls += 1;
      assertEquals(input.rating, "good");
      return { ok: true, value: { dueAt: "2026-09-23T12:10:00.000Z", schedulerState: "fsrs-state" } };
    } },
    logger: () => {},
  });
  const corrective = scheduler.next({
    taskId: "task-a",
    previous: { step: 3, dueAt: "2026-08-16T12:10:00.000Z", fsrsState: null },
    correct: false,
    reviewedAt: "2026-08-16T12:10:00.000Z",
  });
  assertEquals(corrective.ok, true);
  if (corrective.ok) {
    assertEquals(corrective.value.step, 0);
    assertEquals(corrective.value.corrective, true);
    assertEquals(corrective.value.dueAt, "2026-08-16T12:20:00.000Z");
  }

  const delegated = scheduler.next({
    taskId: "task-a",
    previous: { step: 4, dueAt: "2026-08-23T12:10:00.000Z", fsrsState: "prior-state" },
    correct: true,
    reviewedAt: "2026-08-23T12:10:00.000Z",
  });
  assertEquals(delegated.ok, true);
  if (delegated.ok) {
    assertEquals(delegated.value.mode, "fsrs");
    assertEquals(delegated.value.dueAt, "2026-09-23T12:10:00.000Z");
  }
  assertEquals(fsrsCalls, 1);
});
