// @ts-check

import { isNonEmptyText } from "../src/features/learning-generation/contracts.js";

/** @import { LearningBudgetFailure, LearningBudgetReservation, LearningLogger, Result } from "../src/features/learning-generation/contracts.js" */

/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly first: () => Promise<unknown | null>, readonly run: () => Promise<D1Result> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement }} D1DatabasePort */

const HARD_CAP_USD = 2;

export class D1LearningBudgetLedger {
  #database;
  #logger;

  /** @param {{ readonly database: D1DatabasePort, readonly logger: LearningLogger }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.logger !== "function") throw new TypeError("D1 learning-budget dependencies are invalid.");
    this.#database = dependencies.database;
    this.#logger = dependencies.logger;
  }

  /** @param {unknown} input @returns {Promise<Result<LearningBudgetReservation, LearningBudgetFailure>>} */
  async reserve(input) {
    this.#logger({ event: "learning-budget-d1-reservation-entry" });
    if (!isRecord(input) || !isNonEmptyText(input.ownerId) || !isNonEmptyText(input.idempotencyKey) || !isMonth(input.month) || !isMoney(input.amountUsd) || !isMoney(input.capUsd) || input.capUsd <= 0 || input.capUsd > HARD_CAP_USD) return fail(this.#logger, "LearningBudgetReservationUnavailable");
    const command = /** @type {{ readonly ownerId: string, readonly idempotencyKey: string, readonly month: string, readonly amountUsd: number, readonly capUsd: number }} */ (input);
    try {
      const existing = await this.#database.prepare("SELECT reservation_id, owner_id, budget_month, idempotency_key, amount_usd, status, fingerprint FROM learning_generation_budget_reservations WHERE owner_id = ? AND budget_month = ? AND idempotency_key = ? LIMIT 1").bind(command.ownerId, command.month, command.idempotencyKey).first();
      const fingerprint = JSON.stringify([command.month, command.amountUsd, command.capUsd]);
      if (existing !== null) {
        const reservation = parseReservation(existing);
        if (reservation === null || !isRecord(existing) || existing.fingerprint !== fingerprint) return fail(this.#logger, "LearningBudgetReservationUnavailable");
        return { ok: true, value: reservation };
      }
      const reservation = Object.freeze({ reservationId: `budget:${encodeURIComponent(command.ownerId)}:${command.month}:${encodeURIComponent(command.idempotencyKey)}`, ownerId: command.ownerId, month: command.month, amountUsd: command.amountUsd });
      const result = await this.#database.prepare("INSERT INTO learning_generation_budget_reservations (owner_id, reservation_id, budget_month, idempotency_key, amount_usd, actual_usd, status, fingerprint) SELECT ?, ?, ?, ?, ?, NULL, 'reserved', ? WHERE (SELECT COALESCE(SUM(CASE WHEN status = 'completed' THEN actual_usd ELSE 0 END), 0) + COALESCE(SUM(CASE WHEN status IN ('reserved', 'uncertain') THEN amount_usd ELSE 0 END), 0) FROM learning_generation_budget_reservations WHERE owner_id = ? AND budget_month = ?) + ? <= ?").bind(command.ownerId, reservation.reservationId, command.month, command.idempotencyKey, command.amountUsd, fingerprint, command.ownerId, command.month, command.amountUsd, Math.min(HARD_CAP_USD, command.capUsd)).run();
      if (result.meta?.changes !== 1) return fail(this.#logger, "LearningBudgetExceeded");
      this.#logger({ event: "learning-budget-d1-reservation-success" });
      return { ok: true, value: reservation };
    } catch (error) { if (error instanceof Error) return fail(this.#logger, "LearningBudgetReservationUnavailable"); throw error; }
  }

  /** @param {unknown} input @returns {Promise<Result<true, LearningBudgetFailure>>} */
  async reconcile(input) {
    this.#logger({ event: "learning-budget-d1-reconciliation-entry" });
    if (!isRecord(input) || !isRecord(input.reservation) || !isNonEmptyText(input.reservation.reservationId) || !isNonEmptyText(input.reservation.ownerId) || !isMonth(input.reservation.month) || !isMoney(input.reservation.amountUsd) || !(input.actualUsd === null || isMoney(input.actualUsd)) || (input.outcome !== "completed" && input.outcome !== "failed" && input.outcome !== "uncertain")) return fail(this.#logger, "LearningBudgetReconciliationUnavailable");
    if (input.outcome === "completed" && input.actualUsd === null) return fail(this.#logger, "LearningBudgetReconciliationUnavailable");
    const reservation = /** @type {LearningBudgetReservation} */ (input.reservation);
    try {
      const row = await this.#database.prepare("SELECT reservation_id, owner_id, budget_month, amount_usd, status FROM learning_generation_budget_reservations WHERE owner_id = ? AND reservation_id = ? LIMIT 1").bind(reservation.ownerId, reservation.reservationId).first();
      if (!isRecord(row) || row.reservation_id !== reservation.reservationId || row.budget_month !== reservation.month || row.amount_usd !== reservation.amountUsd) return fail(this.#logger, "LearningBudgetReconciliationUnavailable");
      if (row.status !== "reserved") return { ok: true, value: true };
      if (input.outcome === "completed") {
        const actualUsd = /** @type {number} */ (input.actualUsd);
        const result = await this.#database.prepare("UPDATE learning_generation_budget_reservations SET status = 'completed', actual_usd = ? WHERE owner_id = ? AND reservation_id = ? AND status = 'reserved' AND (SELECT COALESCE(SUM(CASE WHEN status = 'completed' THEN actual_usd ELSE 0 END), 0) + COALESCE(SUM(CASE WHEN status IN ('reserved', 'uncertain') AND reservation_id <> ? THEN amount_usd ELSE 0 END), 0) FROM learning_generation_budget_reservations WHERE owner_id = ? AND budget_month = ?) + ? <= ?").bind(actualUsd, reservation.ownerId, reservation.reservationId, reservation.reservationId, reservation.ownerId, reservation.month, actualUsd, HARD_CAP_USD).run();
        if (result.meta?.changes !== 1) return fail(this.#logger, "LearningBudgetReconciliationUnavailable");
      } else {
        const status = input.outcome === "failed" ? "failed" : "uncertain";
        const result = await this.#database.prepare("UPDATE learning_generation_budget_reservations SET status = ?, actual_usd = ? WHERE owner_id = ? AND reservation_id = ? AND status = 'reserved'").bind(status, input.actualUsd, reservation.ownerId, reservation.reservationId).run();
        if (result.meta?.changes !== 1) return fail(this.#logger, "LearningBudgetReconciliationUnavailable");
      }
      this.#logger({ event: "learning-budget-d1-reconciliation-success" });
      return { ok: true, value: true };
    } catch (error) { if (error instanceof Error) return fail(this.#logger, "LearningBudgetReconciliationUnavailable"); throw error; }
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is number} */
function isMoney(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
/** @param {unknown} value @returns {value is string} */
function isMonth(value) { return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
/** @param {unknown} value @returns {LearningBudgetReservation | null} */
function parseReservation(value) { if (!isRecord(value) || !isNonEmptyText(value.reservation_id) || !isNonEmptyText(value.owner_id) || !isMonth(value.budget_month) || !isMoney(value.amount_usd)) return null; return Object.freeze({ reservationId: value.reservation_id, ownerId: value.owner_id, month: value.budget_month, amountUsd: value.amount_usd }); }
/** @param {LearningLogger} logger @param {LearningBudgetFailure["kind"]} kind @returns {Result<never, LearningBudgetFailure>} */
function fail(logger, kind) { logger({ event: "learning-budget-d1-failure", failureKind: kind }); return { ok: false, error: { kind } }; }

export {};
