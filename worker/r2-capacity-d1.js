// @ts-check

import {
  isIsoDateTime,
  isNonEmptyText,
  isPositiveInteger,
  isRecord,
} from "../src/features/source-library/ingestion-contracts.js";

/** @import { Result, SourceIngestionFailure } from "../src/features/source-library/ingestion-contracts.js" */
/** @typedef {{readonly success:boolean,readonly meta?:{readonly changes?:number}}} D1Result */
/** @typedef {{readonly bind:(...values:readonly (string|number|null)[])=>D1Statement,readonly run:()=>Promise<D1Result>,readonly first:()=>Promise<unknown|null>}} D1Statement */
/** @typedef {{readonly prepare:(query:string)=>D1Statement,readonly batch:(statements:readonly D1Statement[])=>Promise<readonly D1Result[]>}} D1DatabasePort */
/** @typedef {"write"|"read"|"delete"} R2Operation */
/** @typedef {{readonly reservationId:string,readonly accountScope:string,readonly ownerId:string,readonly objectKey:string,readonly operation:R2Operation,readonly expectedStoredBytes:number,readonly month:string,readonly reservedAt:string}} R2CapacityReservation */

const freeze = Object.freeze;

export class D1R2CapacityLedger {
  #dependencies;

  /** @param {{readonly database:D1DatabasePort,readonly now:()=>string,readonly createId:()=>string,readonly policy:{readonly accountScope:string,readonly storedBytesLimit:number,readonly classAMonthlyLimit:number,readonly classBMonthlyLimit:number,readonly observationMaximumAgeMs:number}}} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies?.database?.prepare !== "function" ||
      typeof dependencies.database.batch !== "function" ||
      typeof dependencies.now !== "function" ||
      typeof dependencies.createId !== "function" ||
      !validPolicy(dependencies.policy)
    ) throw new TypeError("R2 capacity dependencies are invalid.");
    this.#dependencies = dependencies;
  }

  /** @param {unknown} command @returns {Promise<Result<R2CapacityReservation,SourceIngestionFailure>>} */
  async reserve(command) {
    if (
      !isRecord(command) || !isNonEmptyText(command.ownerId) ||
      !validObjectKey(command.objectKey) ||
      !["write", "read", "delete"].includes(String(command.operation)) ||
      typeof command.expectedStoredBytes !== "number" ||
      !Number.isSafeInteger(command.expectedStoredBytes) ||
      command.expectedStoredBytes < 0 ||
      (command.operation === "write" && command.expectedStoredBytes < 1) ||
      (command.operation !== "write" && command.expectedStoredBytes !== 0) ||
      Object.keys(command).some((field) =>
        !["ownerId", "objectKey", "operation", "expectedStoredBytes"].includes(field)
      )
    ) return fail({ kind: "R2CapacityConflict" });

    const reservedAt = this.#dependencies.now();
    if (!isIsoDateTime(reservedAt)) {
      throw new TypeError("R2 capacity clock returned an invalid time.");
    }
    const reservationId = this.#dependencies.createId();
    if (!isNonEmptyText(reservationId)) {
      throw new TypeError("R2 capacity ID factory returned an invalid ID.");
    }
    const policy = this.#dependencies.policy;
    const reservation = freeze({
      reservationId,
      accountScope: policy.accountScope,
      ownerId: /** @type {string} */ (command.ownerId).trim(),
      objectKey: /** @type {string} */ (command.objectKey),
      operation: /** @type {R2Operation} */ (command.operation),
      expectedStoredBytes: command.expectedStoredBytes,
      month: reservedAt.slice(0, 7),
      reservedAt,
    });
    const staleAfter = new Date(
      Date.parse(reservedAt) - policy.observationMaximumAgeMs,
    ).toISOString();
    try {
      const results = await this.#dependencies.database.batch([
        this.#dependencies.database.prepare(
          "INSERT INTO source_r2_monthly_capacity (account_scope, usage_month, class_a_operations, class_b_operations, updated_at) VALUES (?, ?, 0, 0, ?) ON CONFLICT(account_scope, usage_month) DO NOTHING",
        ).bind(policy.accountScope, reservation.month, reservedAt),
        this.#dependencies.database.prepare(
          "INSERT INTO source_r2_reservations (account_scope, reservation_id, owner_id, object_key, operation, expected_stored_bytes, usage_month, stored_bytes_limit, class_a_limit, class_b_limit, reserved_at, observation_stale_after, state, outcome, measured_stored_bytes, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL)",
        ).bind(
        reservation.accountScope,
        reservation.reservationId,
        reservation.ownerId,
        reservation.objectKey,
        reservation.operation,
        reservation.expectedStoredBytes,
        reservation.month,
        policy.storedBytesLimit,
        policy.classAMonthlyLimit,
        policy.classBMonthlyLimit,
        reservation.reservedAt,
        staleAfter,
        ),
      ]);
      return results.length === 2 && results.every((result) => result.success)
        ? { ok: true, value: reservation }
        : fail({ kind: "R2CapacityPersistenceFailed" });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return fail(mapReservationFailure(error.message));
    }
  }

  /** @param {unknown} command @returns {Promise<Result<null,SourceIngestionFailure>>} */
  async reconcile(command) {
    if (
      !isRecord(command) || !validReservation(command.reservation) ||
      !["completed", "not-started", "uncertain"].includes(String(command.outcome)) ||
      typeof command.measuredStoredBytes !== "number" ||
      !Number.isSafeInteger(command.measuredStoredBytes) ||
      command.measuredStoredBytes < 0 ||
      (command.outcome === "completed" &&
        command.reservation.operation === "write" &&
        command.measuredStoredBytes < 1)
    ) return fail({ kind: "R2CapacityConflict" });
    const reservation = /** @type {R2CapacityReservation} */ (command.reservation);
    const outcome = /** @type {"completed"|"not-started"|"uncertain"} */ (
      command.outcome
    );
    const measuredStoredBytes = /** @type {number} */ (
      command.measuredStoredBytes
    );
    const closedAt = this.#dependencies.now();
    if (!isIsoDateTime(closedAt)) {
      throw new TypeError("R2 capacity clock returned an invalid time.");
    }
    try {
      const result = await this.#dependencies.database.prepare(
        "UPDATE source_r2_reservations SET outcome = ?, measured_stored_bytes = ?, closed_at = ?, state = ? WHERE account_scope = ? AND reservation_id = ? AND state = 'active'",
      ).bind(
        outcome,
        measuredStoredBytes,
        closedAt,
        outcome === "uncertain" ? "uncertain" : "closed",
        reservation.accountScope,
        reservation.reservationId,
      ).run();
      if (!result.success) return fail({ kind: "R2UsageReconciliationFailed" });
      if (result.meta?.changes !== 1) return fail({ kind: "R2CapacityConflict" });
      return outcome === "uncertain"
        ? fail({ kind: "R2CapacityUsageUncertain" })
        : { ok: true, value: null };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.message.includes("r2-capacity-conflict")) {
        return fail({ kind: "R2CapacityConflict" });
      }
      return fail({ kind: "R2UsageReconciliationFailed" });
    }
  }
}

/** @param {string} message @returns {SourceIngestionFailure} */
function mapReservationFailure(message) {
  if (message.includes("r2-storage-capacity-exceeded")) return { kind: "R2StorageCapacityExceeded" };
  if (message.includes("r2-class-a-exceeded")) return { kind: "R2ClassAOperationsExceeded" };
  if (message.includes("r2-class-b-exceeded")) return { kind: "R2ClassBOperationsExceeded" };
  if (message.includes("r2-capacity-observation-stale")) return { kind: "R2CapacityReservationStale" };
  if (message.includes("r2-capacity-usage-uncertain")) return { kind: "R2CapacityUsageUncertain" };
  if (message.includes("r2-capacity-conflict") || message.includes("UNIQUE") || message.includes("constraint")) return { kind: "R2CapacityConflict" };
  return { kind: "R2CapacityPersistenceFailed" };
}

/** @param {unknown} value */
function validPolicy(value) {
  return isRecord(value) && isNonEmptyText(value.accountScope) &&
    isPositiveInteger(value.storedBytesLimit) &&
    isPositiveInteger(value.classAMonthlyLimit) &&
    isPositiveInteger(value.classBMonthlyLimit) &&
    isPositiveInteger(value.observationMaximumAgeMs);
}

/** @param {unknown} value @returns {value is R2CapacityReservation} */
function validReservation(value) {
  return isRecord(value) && isNonEmptyText(value.reservationId) &&
    isNonEmptyText(value.accountScope) && isNonEmptyText(value.ownerId) &&
    validObjectKey(value.objectKey) &&
    ["write", "read", "delete"].includes(String(value.operation)) &&
    typeof value.expectedStoredBytes === "number" &&
    Number.isSafeInteger(value.expectedStoredBytes) &&
    value.expectedStoredBytes >= 0 &&
    /^\d{4}-\d{2}$/.test(String(value.month)) &&
    isIsoDateTime(value.reservedAt);
}

/** @param {unknown} value */
function validObjectKey(value) {
  return typeof value === "string" && value.startsWith("source-content/") &&
    value.length <= 1_024 && !value.includes("..");
}

/** @param {SourceIngestionFailure} error @returns {Result<never,SourceIngestionFailure>} */
function fail(error) { return { ok: false, error }; }

export {};
