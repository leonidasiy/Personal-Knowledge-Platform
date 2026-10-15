// @ts-check

import { D1BrowserRunCapacityLedger } from "../worker/browser-run-capacity-d1.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

class Statement {
  /** @type {readonly (string | number | null)[]} */
  bindings = [];
  /** @param {Database} database @param {string} query */
  constructor(database, query) { this.database = database; this.query = query; }
  /** @param {...(string | number | null)} values */
  bind(...values) { this.bindings = values; return this; }
  async run() { return this.database.run(this); }
  async first() {
    if (this.query.includes("FROM source_browser_run_reservations")) {
      const [scope, owner, job] = this.bindings;
      const record = [...this.database.reservations.values()].find((candidate) =>
        candidate.scope === scope && candidate.owner === owner && candidate.job === job,
      );
      return record === undefined ? null : {
        reservation_id: record.id,
        account_scope: record.scope,
        owner_id: record.owner,
        job_id: record.job,
        utc_day: record.day,
        reserved_milliseconds: record.amount,
        reserved_at: record.reservedAt,
        next_eligible_at: record.nextEligibleAt,
      };
    }
    return { next_acquisition_at: this.database.nextAcquisitionAt };
  }
}

class Database {
  reserved = 0;
  active = 0;
  nextAcquisitionAt = "1970-01-01T00:00:00.000Z";
  reservations = new Map();
  fail = false;
  reconciliationChanges = 1;
  /** @param {string} query */
  prepare(query) { return new Statement(this, query); }
  /** @param {readonly { readonly bind: (...values: readonly (string | number | null)[]) => unknown, readonly run: () => Promise<{ readonly success: boolean, readonly meta?: { readonly changes?: number } }>, readonly first: () => Promise<unknown | null> }[]} statements */
  async batch(statements) {
    if (this.fail) throw new Error("offline");
    const insert = /** @type {Statement} */ (statements[1]);
    const [scope, id, owner, job, day, amount, dailyLimit, maximumConcurrent, _interval, reservedAt, nextEligibleAt] = insert.bindings;
    if (this.reserved + Number(amount) > Number(dailyLimit)) throw new Error("browser-run-daily-budget-exceeded");
    if (this.active >= Number(maximumConcurrent)) throw new Error("browser-run-concurrency-exceeded");
    if (Date.parse(String(this.nextAcquisitionAt)) > Date.parse(String(reservedAt))) throw new Error("browser-run-launch-throttled");
    if (this.reservations.has(String(id))) throw new Error("UNIQUE constraint");
    this.reserved += Number(amount); this.active += 1; this.nextAcquisitionAt = String(nextEligibleAt);
    this.reservations.set(String(id), { id: String(id), scope, owner, job, day, amount, reservedAt: String(reservedAt), nextEligibleAt: String(nextEligibleAt), state: "active" });
    return [{ success: true, meta: { changes: 1 } }, { success: true, meta: { changes: 1 } }];
  }
  /** @param {Statement} statement */
  run(statement) {
    const [charged, state, _closedAt, scope, id, owner, job] = statement.bindings;
    const record = this.reservations.get(String(id));
    if (!record || record.state !== "active" || record.scope !== scope || record.owner !== owner || record.job !== job) return { success: true, meta: { changes: 0 } };
    this.reserved -= Number(record.amount) - Number(charged); this.active -= 1; record.state = state;
    return { success: true, meta: { changes: this.reconciliationChanges } };
  }
}

/** @param {Database} database @param {() => string} now @param {() => string} [createId] */
function ledger(database, now, createId = () => crypto.randomUUID()) {
  return new D1BrowserRunCapacityLedger({ database, now, createId, policy: { accountScope: "account-a", dailyLimitMilliseconds: 600_000, maximumConcurrentSessions: 1, minimumLaunchIntervalMilliseconds: 20_000, reservationMilliseconds: 60_000 } });
}

Deno.test("Browser Run capacity reserves and reconciles measured use", async () => {
  const database = new Database();
  database.reconciliationChanges = 2;
  const subject = ledger(database, () => "2026-07-22T12:00:00.000Z", () => "reservation-a");
  const reserved = await subject.reserve({ ownerId: "owner-a", jobId: "job-a" });
  if (!reserved.ok) throw new Error(reserved.error.kind);
  assertEquals(database.reserved, 60_000);
  const reconciled = await subject.reconcile({ reservation: reserved.value, measuredMilliseconds: 12_500, outcome: "completed" });
  assertEquals(reconciled.ok, true);
  assertEquals(database.reserved, 12_500);
  assertEquals(database.active, 0);
});

Deno.test("Browser Run capacity enforces exact daily and concurrency boundaries", async () => {
  const database = new Database();
  database.reserved = 540_000;
  let result = await ledger(database, () => "2026-07-22T12:00:00.000Z", () => "exact").reserve({ ownerId: "owner-a", jobId: "job-a" });
  assertEquals(result.ok, true);
  if (result.ok) await ledger(database, () => "2026-07-22T12:00:01.000Z").reconcile({ reservation: result.value, measuredMilliseconds: 60_000, outcome: "completed" });
  database.reserved = 540_001; database.active = 0; database.nextAcquisitionAt = "1970-01-01T00:00:00.000Z";
  result = await ledger(database, () => "2026-07-22T12:01:00.000Z", () => "over").reserve({ ownerId: "owner-a", jobId: "job-b" });
  if (result.ok) throw new Error("Expected daily limit.");
  assertEquals(result.error.kind, "BrowserRunDailyBudgetExceeded");
  database.reserved = 0; database.active = 1;
  result = await ledger(database, () => "2026-07-22T12:01:00.000Z", () => "concurrent").reserve({ ownerId: "owner-a", jobId: "job-c" });
  if (result.ok) throw new Error("Expected concurrency limit.");
  assertEquals(result.error.kind, "BrowserRunConcurrencyExceeded");
});

Deno.test("Browser Run capacity permits exactly 20 seconds and persists the earlier retry time", async () => {
  const database = new Database();
  database.nextAcquisitionAt = "2026-07-22T12:00:20.000Z";
  let result = await ledger(database, () => "2026-07-22T12:00:19.999Z", () => "early").reserve({ ownerId: "owner-a", jobId: "job-a" });
  if (result.ok) throw new Error("Expected launch throttle.");
  assertEquals(result.error.kind, "BrowserRunLaunchThrottled");
  if (result.error.kind === "BrowserRunLaunchThrottled") assertEquals(result.error.retryAt, "2026-07-22T12:00:20.000Z");
  result = await ledger(database, () => "2026-07-22T12:00:20.000Z", () => "exact").reserve({ ownerId: "owner-a", jobId: "job-a" });
  assertEquals(result.ok, true);
});

Deno.test("Browser Run uncertain use stays fully charged and duplicate reconciliation conflicts", async () => {
  const database = new Database();
  const subject = ledger(database, () => "2026-07-22T12:00:00.000Z", () => "reservation-a");
  const reserved = await subject.reserve({ ownerId: "owner-a", jobId: "job-a" });
  if (!reserved.ok) throw new Error(reserved.error.kind);
  const first = await subject.reconcile({ reservation: reserved.value, measuredMilliseconds: 1, outcome: "uncertain" });
  assertEquals(first.ok, true);
  assertEquals(database.reserved, 60_000);
  const duplicate = await subject.reconcile({ reservation: reserved.value, measuredMilliseconds: 1, outcome: "uncertain" });
  if (duplicate.ok) throw new Error("Expected conflict.");
  assertEquals(duplicate.error.kind, "BrowserRunCapacityConflict");
});

Deno.test("Browser Run capacity replays an owner and job reservation without a second charge", async () => {
  const database = new Database();
  const subject = ledger(database, () => "2026-07-22T12:00:00.000Z", () => "reservation-a");
  const first = await subject.reserve({ ownerId: "owner-a", jobId: "job-a" });
  const replay = await subject.reserve({ ownerId: "owner-a", jobId: "job-a" });
  if (!first.ok || !replay.ok) throw new Error("Expected idempotent reservations.");
  assertEquals(replay.value.reservationId, first.value.reservationId);
  assertEquals(database.reserved, 60_000);
  assertEquals(database.active, 1);
});

Deno.test("Browser Run capacity rejects invalid commands and names persistence failures", async () => {
  const database = new Database();
  let result = await ledger(database, () => "2026-07-22T12:00:00.000Z").reserve({ ownerId: "owner-a", jobId: "job-a", url: "https://client.example" });
  if (result.ok) throw new Error("Expected invalid command.");
  assertEquals(result.error.kind, "BrowserRunConfigurationInvalid");
  database.fail = true;
  result = await ledger(database, () => "2026-07-22T12:00:00.000Z").reserve({ ownerId: "owner-a", jobId: "job-a" });
  if (result.ok) throw new Error("Expected persistence failure.");
  assertEquals(result.error.kind, "BrowserRunCapacityPersistenceFailed");
});

Deno.test("Browser Run capacity migration keeps account/day accounting and owner/job idempotency", async () => {
  const migration = await Deno.readTextFile(
    new URL("../worker/migrations/0003_browser_run_acquisition.sql", import.meta.url),
  );
  for (const required of [
    "PRIMARY KEY (account_scope, utc_day)",
    "UNIQUE (account_scope, owner_id, job_id)",
    "browser-run-daily-budget-exceeded",
    "browser-run-concurrency-exceeded",
    "browser-run-launch-throttled",
  ]) assertEquals(migration.includes(required), true);
});
