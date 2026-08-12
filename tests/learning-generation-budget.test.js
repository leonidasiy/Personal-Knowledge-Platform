// @ts-check

import { LearningBudgetLedger } from "../src/features/learning-generation/budget.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}

const base = { ownerId: "owner-a", idempotencyKey: "reservation-a", month: "2026-08", amountUsd: 2, capUsd: 2 };

Deno.test("budget ledger accepts the exact two-dollar cap and rejects the first over-cap reservation", async () => {
  const ledger = new LearningBudgetLedger({ logger: () => {} });
  const reserved = await ledger.reserve(base);
  assertEquals(reserved.ok, true);
  const exceeded = await ledger.reserve({ ...base, idempotencyKey: "reservation-b", amountUsd: 0.01 });
  assertEquals(exceeded.ok, false);
  if (!exceeded.ok) assertEquals(exceeded.error.kind, "LearningBudgetExceeded");
  if (!reserved.ok) return;
  const reconciled = await ledger.reconcile({ reservation: reserved.value, actualUsd: 2, outcome: "completed" });
  assertEquals(reconciled.ok, true);
});

Deno.test("failed provider work releases a reservation and idempotency replay does not reserve twice", async () => {
  const ledger = new LearningBudgetLedger({ logger: () => {} });
  const first = await ledger.reserve({ ...base, amountUsd: 1 });
  const replay = await ledger.reserve({ ...base, amountUsd: 1 });
  assertEquals(replay.ok, true);
  if (!first.ok || !replay.ok) return;
  assertEquals(replay.value.reservationId, first.value.reservationId);
  const conflict = await ledger.reserve({ ...base, amountUsd: 1.1 });
  assertEquals(conflict.ok, false);
  if (!conflict.ok) assertEquals(conflict.error.kind, "LearningBudgetReservationUnavailable");
  const released = await ledger.reconcile({ reservation: first.value, actualUsd: null, outcome: "failed" });
  assertEquals(released.ok, true);
  const afterRelease = await ledger.reserve({ ...base, idempotencyKey: "reservation-c", amountUsd: 2 });
  assertEquals(afterRelease.ok, true);
});

Deno.test("reconciliation refuses actual usage that would breach the hard cap", async () => {
  const ledger = new LearningBudgetLedger({ logger: () => {} });
  const reserved = await ledger.reserve({ ...base, amountUsd: 1.5 });
  assertEquals(reserved.ok, true);
  if (!reserved.ok) return;
  const result = await ledger.reconcile({ reservation: reserved.value, actualUsd: 2.01, outcome: "completed" });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "LearningBudgetReconciliationUnavailable");
});
