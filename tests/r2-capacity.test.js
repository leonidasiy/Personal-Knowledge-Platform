// @ts-check

import { D1R2CapacityLedger } from "../worker/r2-capacity-d1.js";

/** @template T @param {T} actual @param {T} expected */
function equal(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

class Statement {
  /** @type {readonly (string|number|null)[]} */ bindings = [];
  /** @param {Database} database @param {string} query */
  constructor(database, query) { this.database = database; this.query = query; }
  /** @param {...(string|number|null)} values */
  bind(...values) { this.bindings = values; return this; }
  async run() { return this.database.run(this); }
  async first() { return this.database.first(this); }
}

class Database {
  storedBytes = 0;
  classA = 0;
  classB = 0;
  observedAt = "2026-07-23T00:00:00.000Z";
  /** @type {Map<string,{size:number,state:"stored"|"uncertain"}>} */ objects = new Map();
  /** @type {Map<string,{operation:string,key:string,bytes:number,state:string,outcome?:string,measured?:number}>} */ reservations = new Map();
  omitReconcileMetadata = false;
  /** @param {string} query */
  prepare(query) { return new Statement(this, query); }
  /** @param {readonly {readonly bind:(...values:readonly (string|number|null)[])=>unknown,readonly run:()=>Promise<{readonly success:boolean,readonly meta?:{readonly changes?:number}}>,readonly first:()=>Promise<unknown|null>}[]} statements */
  batch(statements) {
    return Promise.all(statements.map((statement) =>
      this.run(/** @type {Statement} */ (statement))
    ));
  }
  /** @param {Statement} statement */
  first(statement) {
    if (statement.query.includes("source_r2_account_capacity")) {
      return { stored_bytes: this.storedBytes, class_a_operations: this.classA, class_b_operations: this.classB, observed_at: this.observedAt };
    }
    if (statement.query.includes("source_r2_reservations")) {
      const reservation = this.reservations.get(String(statement.bindings.at(-1)));
      return reservation === undefined ? null : { state: reservation.state, outcome: reservation.outcome ?? null, measured_stored_bytes: reservation.measured ?? null };
    }
    const object = this.objects.get(String(statement.bindings.at(-1)));
    return object === undefined ? null : { byte_size: object.size, state: object.state };
  }
  /** @param {Statement} statement */
  run(statement) {
    if (statement.query.startsWith("INSERT INTO source_r2_monthly_capacity")) {
      return { success: true, meta: { changes: 1 } };
    }
    if (statement.query.startsWith("INSERT INTO source_r2_reservations")) {
      const [_scope, id, _owner, key, operation, bytes, _month, storedLimit, aLimit, bLimit, _reservedAt, staleAfter] = statement.bindings;
      const object = this.objects.get(String(key));
      if (Date.parse(this.observedAt) < Date.parse(String(staleAfter))) throw new Error("r2-capacity-observation-stale");
      if (object?.state === "uncertain") throw new Error("r2-capacity-usage-uncertain");
      if (operation === "write" && object !== undefined) throw new Error("r2-capacity-conflict");
      if ((operation === "read" || operation === "delete") && object === undefined) throw new Error("r2-capacity-conflict");
      const stored = this.storedBytes + (operation === "write" ? Number(bytes) : 0);
      const classA = this.classA + (operation === "read" ? 0 : 1);
      const classB = this.classB + (operation === "read" ? 1 : 0);
      if (stored > Number(storedLimit)) throw new Error("r2-storage-capacity-exceeded");
      if (classA > Number(aLimit)) throw new Error("r2-class-a-exceeded");
      if (classB > Number(bLimit)) throw new Error("r2-class-b-exceeded");
      this.storedBytes = stored; this.classA = classA; this.classB = classB;
      this.reservations.set(String(id), { operation: String(operation), key: String(key), bytes: Number(bytes), state: "active" });
      return { success: true, meta: { changes: 1 } };
    }
    const [outcome, measured, _closed, _state, _scope, id] = statement.bindings;
    const reservation = this.reservations.get(String(id));
    if (reservation === undefined || reservation.state !== "active") return { success: true, meta: { changes: 0 } };
    if (outcome === "uncertain") {
      reservation.state = "uncertain";
      reservation.outcome = String(outcome);
      reservation.measured = Number(measured);
      this.objects.set(reservation.key, { size: reservation.bytes, state: "uncertain" });
      return { success: true, meta: { changes: 1 } };
    }
    reservation.state = "closed";
    reservation.outcome = String(outcome);
    reservation.measured = Number(measured);
    if (outcome === "not-started") {
      if (reservation.operation === "write") this.storedBytes -= reservation.bytes;
      reservation.operation === "read" ? this.classB -= 1 : this.classA -= 1;
    } else if (reservation.operation === "write") {
      this.storedBytes += Number(measured) - reservation.bytes;
      this.objects.set(reservation.key, { size: Number(measured), state: "stored" });
    } else if (reservation.operation === "delete") {
      this.storedBytes -= this.objects.get(reservation.key)?.size ?? 0;
      this.objects.delete(reservation.key);
    }
    return this.omitReconcileMetadata ? { success: true } : { success: true, meta: { changes: 1 } };
  }
}

const policy = Object.freeze({ accountScope: "account-a", storedBytesLimit: 8 * 1024 ** 3, classAMonthlyLimit: 100_000, classBMonthlyLimit: 1_000_000, observationMaximumAgeMs: 86_400_000 });

/** @param {Database} database */
function ledger(database) {
  let id = 0;
  return new D1R2CapacityLedger({ database, policy, now: () => "2026-07-23T12:00:00.000Z", createId: () => `reservation-${++id}` });
}

/** @param {Database} database @param {"write"|"read"|"delete"} operation @param {number} bytes @param {string} [key] */
function reserve(database, operation, bytes, key = "source-content/item") {
  return ledger(database).reserve({ ownerId: "owner-a", objectKey: key, operation, expectedStoredBytes: bytes });
}

Deno.test("R2 ledger accepts exact application caps and rejects each one-over", async () => {
  const exact = new Database(); exact.storedBytes = policy.storedBytesLimit - 1; exact.classA = policy.classAMonthlyLimit - 1;
  equal((await reserve(exact, "write", 1)).ok, true);
  const storage = new Database(); storage.storedBytes = policy.storedBytesLimit;
  const storageOver = await reserve(storage, "write", 1);
  if (storageOver.ok) throw new Error("Expected storage cap.");
  equal(storageOver.error.kind, "R2StorageCapacityExceeded");
  const a = new Database(); a.classA = policy.classAMonthlyLimit;
  const aOver = await reserve(a, "write", 1);
  if (aOver.ok) throw new Error("Expected Class A cap.");
  equal(aOver.error.kind, "R2ClassAOperationsExceeded");
  const b = new Database(); b.classB = policy.classBMonthlyLimit; b.objects.set("source-content/item", { size: 1, state: "stored" });
  const bOver = await reserve(b, "read", 0);
  if (bOver.ok) throw new Error("Expected Class B cap.");
  equal(bOver.error.kind, "R2ClassBOperationsExceeded");
});

Deno.test("R2 ledger reconciles bytes and fails closed on uncertain usage", async () => {
  const database = new Database();
  const subject = ledger(database);
  const write = await subject.reserve({ ownerId: "owner-a", objectKey: "source-content/item", operation: "write", expectedStoredBytes: 5 });
  if (!write.ok) throw new Error(write.error.kind);
  equal((await subject.reconcile({ reservation: write.value, outcome: "completed", measuredStoredBytes: 7 })).ok, true);
  equal(database.storedBytes, 7);
  const uncertain = await subject.reserve({ ownerId: "owner-a", objectKey: "source-content/uncertain", operation: "write", expectedStoredBytes: 3 });
  if (!uncertain.ok) throw new Error(uncertain.error.kind);
  const result = await subject.reconcile({ reservation: uncertain.value, outcome: "uncertain", measuredStoredBytes: 0 });
  if (result.ok) throw new Error("Expected uncertain usage.");
  equal(result.error.kind, "R2CapacityUsageUncertain");
  const retry = await subject.reserve({ ownerId: "owner-a", objectKey: "source-content/uncertain", operation: "write", expectedStoredBytes: 3 });
  if (retry.ok) throw new Error("Expected uncertain retry rejection.");
  equal(retry.error.kind, "R2CapacityUsageUncertain");
});

Deno.test("R2 ledger verifies the reservation when D1 omits update metadata", async () => {
  const database = new Database();
  database.omitReconcileMetadata = true;
  const subject = ledger(database);
  const write = await subject.reserve({ ownerId: "owner-a", objectKey: "source-content/item", operation: "write", expectedStoredBytes: 5 });
  if (!write.ok) throw new Error(write.error.kind);
  const result = await subject.reconcile({ reservation: write.value, outcome: "completed", measuredStoredBytes: 5 });
  equal(result.ok, true);
  equal(database.storedBytes, 5);
});

Deno.test("R2 ledger rejects stale observations before capacity reservation", async () => {
  const database = new Database(); database.observedAt = "2026-07-20T00:00:00.000Z";
  const result = await reserve(database, "write", 1);
  if (result.ok) throw new Error("Expected stale observation.");
  equal(result.error.kind, "R2CapacityReservationStale");
});

Deno.test("R2 migration declares atomic guards and uncertain object state", async () => {
  const migration = await Deno.readTextFile(new URL("../worker/migrations/0004_r2_capacity.sql", import.meta.url));
  for (const evidence of ["source_r2_account_capacity", "source_r2_object_ledger", "source_r2_reservations", "r2-storage-capacity-exceeded", "r2-class-a-exceeded", "r2-class-b-exceeded", "r2-capacity-observation-stale", "write-uncertain"]) equal(migration.includes(evidence), true);
});
