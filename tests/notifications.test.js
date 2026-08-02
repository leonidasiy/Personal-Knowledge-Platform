// @ts-check

import { NotificationController } from "../src/features/notifications/controller.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

class FakeTimers {
  nowMs = 0;
  nextId = 1;
  /** @type {Map<number, { readonly callback: () => void, readonly dueAt: number }>} */
  timers = new Map();

  /** @param {() => void} callback @param {number} delayMs */
  set(callback, delayMs) {
    const id = this.nextId++;
    this.timers.set(id, { callback, dueAt: this.nowMs + delayMs });
    return id;
  }

  /** @param {number} id */
  clear(id) {
    this.timers.delete(id);
  }

  /** @param {number} elapsedMs */
  advance(elapsedMs) {
    this.nowMs += elapsedMs;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= this.nowMs)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

function fixture() {
  const timers = new FakeTimers();
  let nextId = 1;
  /** @type {(import("../src/features/notifications/controller.js").AppNotification | null)[]} */
  const changes = [];
  const controller = new NotificationController({
    durationMs: 4_000,
    createId: () => `notification-${nextId++}`,
    now: () => timers.nowMs,
    setTimer: (callback, delayMs) => timers.set(callback, delayMs),
    clearTimer: (id) => timers.clear(id),
    onChange: (notification) => changes.push(notification),
  });
  return { controller, timers, changes };
}

Deno.test("notifications dismiss after four seconds and can close early", () => {
  const { controller, timers, changes } = fixture();
  const shown = controller.replace({ kind: "notice", message: "Saved." });
  assertEquals(shown?.id, "notification-1");
  timers.advance(3_999);
  assertEquals(controller.current()?.message, "Saved.");
  timers.advance(1);
  assertEquals(controller.current(), null);
  assertEquals(changes.length, 2);

  const next = controller.replace({ kind: "error", message: "Try again." });
  controller.dismiss(next?.id);
  assertEquals(controller.current(), null);
});

Deno.test("hover or focus pause preserves remaining notification time", () => {
  const { controller, timers } = fixture();
  const shown = controller.replace({ kind: "notice", message: "Saved." });
  if (shown === null) throw new Error("Notification was not shown.");
  timers.advance(1_500);
  controller.pause(shown.id);
  timers.advance(9_000);
  assertEquals(controller.current()?.id, shown.id);
  controller.resume(shown.id);
  timers.advance(2_499);
  assertEquals(controller.current()?.id, shown.id);
  timers.advance(1);
  assertEquals(controller.current(), null);
});

Deno.test("a stale timer cannot dismiss a newer notification", () => {
  const { controller, timers } = fixture();
  const first = controller.replace({ kind: "notice", message: "First." });
  timers.advance(1_000);
  const second = controller.replace({ kind: "notice", message: "Second." });
  if (first === null || second === null) {
    throw new Error("Notifications were not shown.");
  }
  controller.dismiss(first.id);
  assertEquals(controller.current()?.id, second.id);
  timers.advance(2_999);
  assertEquals(controller.current()?.id, second.id);
  timers.advance(1_001);
  assertEquals(controller.current(), null);
});

Deno.test("rerender synchronization does not restart an identical timeout", () => {
  const { controller, timers } = fixture();
  controller.replace({ kind: "error", message: "Unavailable." });
  timers.advance(2_000);
  const same = controller.replace({ kind: "error", message: "Unavailable." });
  assertEquals(same?.id, "notification-1");
  timers.advance(2_000);
  assertEquals(controller.current(), null);
});
