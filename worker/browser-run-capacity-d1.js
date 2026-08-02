// @ts-check

import { isIsoDateTime, isNonEmptyText, isPositiveInteger, isRecord } from "../src/features/source-library/ingestion-contracts.js";

/** @import { BrowserRunReservation, Result, SourceIngestionFailure } from "../src/features/source-library/ingestion-contracts.js" */

/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly run: () => Promise<D1Result>, readonly first: () => Promise<unknown | null> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement, readonly batch: (statements: readonly D1Statement[]) => Promise<readonly D1Result[]> }} D1DatabasePort */

const freeze = Object.freeze;

export class D1BrowserRunCapacityLedger {
  #dependencies;

  /** @param {{ readonly database: D1DatabasePort, readonly now: () => string, readonly createId: () => string, readonly policy: { readonly accountScope: string, readonly dailyLimitMilliseconds: number, readonly maximumConcurrentSessions: number, readonly minimumLaunchIntervalMilliseconds: number, readonly reservationMilliseconds: number } }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.database.batch !== "function" ||
      typeof dependencies.now !== "function" || typeof dependencies.createId !== "function" || !validPolicy(dependencies.policy)) {
      throw new TypeError("Browser Run capacity dependencies are invalid.");
    }
    this.#dependencies = dependencies;
  }

  /** @param {unknown} command @returns {Promise<Result<BrowserRunReservation, SourceIngestionFailure>>} */
  async reserve(command) {
    if (!isRecord(command) || !isNonEmptyText(command.ownerId) || !isNonEmptyText(command.jobId) ||
      Object.keys(command).some((field) => field !== "ownerId" && field !== "jobId")) {
      return fail({ kind: "BrowserRunConfigurationInvalid" });
    }
    const policy = this.#dependencies.policy;
    const ownerId = /** @type {string} */ (command.ownerId).trim();
    const jobId = /** @type {string} */ (command.jobId).trim();
    const existing = await this.#existingReservation(policy.accountScope, ownerId, jobId);
    if (existing.ok === false) return existing;
    if (existing.value !== null) return { ok: true, value: existing.value };

    const reservedAt = this.#dependencies.now();
    if (!isIsoDateTime(reservedAt)) throw new TypeError("Browser Run capacity clock returned an invalid time.");
    const reservationId = this.#dependencies.createId();
    if (!isNonEmptyText(reservationId)) throw new TypeError("Browser Run capacity ID factory returned an invalid ID.");
    const utcDay = reservedAt.slice(0, 10);
    const nextEligibleAt = new Date(Date.parse(reservedAt) + policy.minimumLaunchIntervalMilliseconds).toISOString();
    const reservation = freeze({ reservationId, accountScope: policy.accountScope, ownerId, jobId, utcDay, reservedMilliseconds: policy.reservationMilliseconds, reservedAt, nextEligibleAt });
    try {
      const results = await this.#dependencies.database.batch([
        this.#dependencies.database.prepare(
          "INSERT INTO source_browser_run_daily_capacity (account_scope, utc_day, reserved_milliseconds, active_sessions, next_acquisition_at, updated_at) VALUES (?, ?, 0, 0, ?, ?) ON CONFLICT(account_scope, utc_day) DO NOTHING",
        ).bind(policy.accountScope, utcDay, "1970-01-01T00:00:00.000Z", reservedAt),
        this.#dependencies.database.prepare(
          "INSERT INTO source_browser_run_reservations (account_scope, reservation_id, owner_id, job_id, utc_day, reserved_milliseconds, charged_milliseconds, daily_limit_milliseconds, maximum_concurrent_sessions, minimum_launch_interval_milliseconds, reserved_at, next_eligible_at, state, closed_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', NULL)",
        ).bind(policy.accountScope, reservationId, reservation.ownerId, reservation.jobId, utcDay, policy.reservationMilliseconds, policy.dailyLimitMilliseconds, policy.maximumConcurrentSessions, policy.minimumLaunchIntervalMilliseconds, reservedAt, nextEligibleAt),
      ]);
      if (results.length !== 2 || results.some((result) => !result.success)) return fail({ kind: "BrowserRunCapacityPersistenceFailed" });
      return { ok: true, value: reservation };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.message.includes("browser-run-daily-budget-exceeded")) return fail({ kind: "BrowserRunDailyBudgetExceeded" });
      if (error.message.includes("browser-run-concurrency-exceeded")) return fail({ kind: "BrowserRunConcurrencyExceeded" });
      if (error.message.includes("browser-run-launch-throttled")) {
        const retry = await this.#nextRetryAt(utcDay);
        return retry.ok ? fail({ kind: "BrowserRunLaunchThrottled", retryAt: retry.value }) : retry;
      }
      if (error.message.includes("UNIQUE") || error.message.includes("constraint")) {
        const replay = await this.#existingReservation(policy.accountScope, ownerId, jobId);
        if (replay.ok === false) return replay;
        return replay.value === null ? fail({ kind: "BrowserRunCapacityConflict" }) : { ok: true, value: replay.value };
      }
      return fail({ kind: "BrowserRunCapacityPersistenceFailed" });
    }
  }

  /** @param {unknown} command @returns {Promise<Result<null, SourceIngestionFailure>>} */
  async reconcile(command) {
    if (!isRecord(command) || !validReservation(command.reservation) ||
      !["completed", "partial", "uncertain", "not-started"].includes(String(command.outcome)) ||
      typeof command.measuredMilliseconds !== "number" || !Number.isInteger(command.measuredMilliseconds) || command.measuredMilliseconds < 0) {
      return fail({ kind: "BrowserRunConfigurationInvalid" });
    }
    const reservation = /** @type {BrowserRunReservation} */ (command.reservation);
    const closedAt = this.#dependencies.now();
    if (!isIsoDateTime(closedAt)) throw new TypeError("Browser Run capacity clock returned an invalid time.");
    const uncertain = command.outcome === "uncertain";
    const charged = uncertain ? reservation.reservedMilliseconds : command.outcome === "not-started" ? 0 : Math.min(command.measuredMilliseconds, reservation.reservedMilliseconds);
    try {
      const result = await this.#dependencies.database.prepare(
        "UPDATE source_browser_run_reservations SET charged_milliseconds = ?, state = ?, closed_at = ? WHERE account_scope = ? AND reservation_id = ? AND owner_id = ? AND job_id = ? AND state = 'active'",
      ).bind(charged, uncertain ? "uncertain" : "closed", closedAt, reservation.accountScope, reservation.reservationId, reservation.ownerId, reservation.jobId).run();
      if (!result.success) return fail({ kind: "BrowserRunUsageReconciliationFailed" });
      if (result.meta?.changes !== 1) return fail({ kind: "BrowserRunCapacityConflict" });
      return { ok: true, value: null };
    } catch (error) {
      if (error instanceof Error) return fail({ kind: "BrowserRunUsageReconciliationFailed" });
      throw error;
    }
  }

  /** @param {string} utcDay @returns {Promise<Result<string, SourceIngestionFailure>>} */
  async #nextRetryAt(utcDay) {
    try {
      const row = await this.#dependencies.database.prepare(
        "SELECT next_acquisition_at FROM source_browser_run_daily_capacity WHERE account_scope = ? AND utc_day = ?",
      ).bind(this.#dependencies.policy.accountScope, utcDay).first();
      return isRecord(row) && isIsoDateTime(row.next_acquisition_at)
        ? { ok: true, value: row.next_acquisition_at }
        : fail({ kind: "BrowserRunCapacityPersistenceFailed" });
    } catch (error) {
      if (error instanceof Error) return fail({ kind: "BrowserRunCapacityPersistenceFailed" });
      throw error;
    }
  }

  /** @param {string} accountScope @param {string} ownerId @param {string} jobId @returns {Promise<Result<BrowserRunReservation | null, SourceIngestionFailure>>} */
  async #existingReservation(accountScope, ownerId, jobId) {
    try {
      const row = await this.#dependencies.database.prepare(
        "SELECT reservation_id, account_scope, owner_id, job_id, utc_day, reserved_milliseconds, reserved_at, next_eligible_at FROM source_browser_run_reservations WHERE account_scope = ? AND owner_id = ? AND job_id = ?",
      ).bind(accountScope, ownerId, jobId).first();
      if (row === null) return { ok: true, value: null };
      if (!isRecord(row) || !isNonEmptyText(row.reservation_id) || !isNonEmptyText(row.account_scope) ||
        !isNonEmptyText(row.owner_id) || !isNonEmptyText(row.job_id) || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.utc_day)) ||
        !isPositiveInteger(row.reserved_milliseconds) || !isIsoDateTime(row.reserved_at) || !isIsoDateTime(row.next_eligible_at)) {
        throw new TypeError("Stored Browser Run reservation is invalid.");
      }
      return {
        ok: true,
        value: freeze({
          reservationId: row.reservation_id.trim(),
          accountScope: row.account_scope.trim(),
          ownerId: row.owner_id.trim(),
          jobId: row.job_id.trim(),
          utcDay: String(row.utc_day),
          reservedMilliseconds: row.reserved_milliseconds,
          reservedAt: row.reserved_at,
          nextEligibleAt: row.next_eligible_at,
        }),
      };
    } catch (error) {
      if (error instanceof TypeError) throw error;
      if (error instanceof Error) return fail({ kind: "BrowserRunCapacityPersistenceFailed" });
      throw error;
    }
  }
}

/** @param {unknown} value */
function validPolicy(value) {
  return isRecord(value) && isNonEmptyText(value.accountScope) &&
    isPositiveInteger(value.dailyLimitMilliseconds) && isPositiveInteger(value.maximumConcurrentSessions) &&
    isPositiveInteger(value.minimumLaunchIntervalMilliseconds) && isPositiveInteger(value.reservationMilliseconds) &&
    value.reservationMilliseconds <= value.dailyLimitMilliseconds;
}

/** @param {unknown} value @returns {value is BrowserRunReservation} */
function validReservation(value) {
  return isRecord(value) && isNonEmptyText(value.reservationId) && isNonEmptyText(value.accountScope) &&
    isNonEmptyText(value.ownerId) && isNonEmptyText(value.jobId) && /^\d{4}-\d{2}-\d{2}$/.test(String(value.utcDay)) &&
    isPositiveInteger(value.reservedMilliseconds) && isIsoDateTime(value.reservedAt) && isIsoDateTime(value.nextEligibleAt);
}

/** @param {SourceIngestionFailure} error @returns {Result<never, SourceIngestionFailure>} */
function fail(error) { return { ok: false, error }; }

export {};
