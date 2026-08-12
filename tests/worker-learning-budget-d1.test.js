// @ts-check

import { D1LearningBudgetLedger } from "../worker/learning-budget-d1.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

class Statement {
  /** @type {(string|number|null)[]} */
  bindings = [];
  /** @param {Database} database @param {string} query */
  constructor(database, query) { this.database = database; this.query = query; }
  /** @param {...(string|number|null)} values */
  bind(...values) { this.bindings = values; return this; }
  async first() { return this.database.first(this.query); }
  async run() { this.database.runs.push(this.query); return { success: true, meta: { changes: 1 } }; }
}

class Database {
  /** @type {string[]} */ runs = [];
  /** @param {string} query */
  prepare(query) { return new Statement(this, query); }
  /** @param {readonly unknown[]} _statements */
  async batch(_statements) { return []; }
  /** @param {string} query */
  first(query) { return query.startsWith("SELECT reservation_id") ? null : null; }
}

Deno.test("D1 budget reservation is a conditional durable insert against the hard cap", async () => {
  const database = new Database();
  const result = await new D1LearningBudgetLedger({ database, logger: () => {} }).reserve({ ownerId: "owner-a", idempotencyKey: "reservation-a", month: "2026-08", amountUsd: 2, capUsd: 2 });
  assertEquals(result.ok, true);
  assertEquals(database.runs.length, 1);
  assertEquals(database.runs[0].includes("INSERT INTO learning_generation_budget_reservations"), true);
  assertEquals(database.runs[0].includes("SELECT"), true);
});

Deno.test("D1 budget reconciliation names over-cap actual usage without silently accepting it", async () => {
  const database = new Database();
  const result = await new D1LearningBudgetLedger({ database, logger: () => {} }).reconcile({ reservation: { reservationId: "budget:owner-a:2026-08:reservation-a", ownerId: "owner-a", month: "2026-08", amountUsd: 1 }, actualUsd: 2.01, outcome: "completed" });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "LearningBudgetReconciliationUnavailable");
});
