// @ts-check

import { isNonEmptyText, isRecord } from "./contracts.js";

/** @import { LearningBudgetFailure, LearningBudgetReservation, LearningLogger, Result } from "./contracts.js" */

const HARD_CAP_USD = 2;

/** @typedef {{ readonly ownerId: string, readonly month: string, committedUsd: number, reservedUsd: number }} BudgetBucket */
/** @typedef {{ readonly fingerprint: string, readonly reservation: LearningBudgetReservation, status: "reserved" | "completed" | "failed" | "uncertain" }} StoredReservation */

export class LearningBudgetLedger {
  /** @type {Map<string, BudgetBucket>} */
  #buckets = new Map();
  /** @type {Map<string, StoredReservation>} */
  #reservations = new Map();
  #logger;

  /** @param {{ readonly logger: LearningLogger }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.logger !== "function") throw new TypeError("Learning-budget dependencies are invalid.");
    this.#logger = dependencies.logger;
  }

  /** @param {unknown} input @returns {Promise<Result<LearningBudgetReservation, LearningBudgetFailure>>} */
  async reserve(input) {
    this.#logger({ event: "learning-budget-reservation-entry" });
    if (!isRecord(input) || !isNonEmptyText(input.ownerId) || !isNonEmptyText(input.idempotencyKey) || !isValidMonth(input.month) || !isMoney(input.amountUsd) || !isMoney(input.capUsd) || input.capUsd <= 0 || input.capUsd > HARD_CAP_USD) return this.#fail("LearningBudgetReservationUnavailable");
    const command = /** @type {{ readonly ownerId: string, readonly idempotencyKey: string, readonly month: string, readonly amountUsd: number, readonly capUsd: number }} */ (input);
    const key = scopedKey(command.ownerId, command.month, command.idempotencyKey);
    const fingerprint = JSON.stringify([command.month, command.amountUsd, command.capUsd]);
    const existing = this.#reservations.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) return this.#fail("LearningBudgetReservationUnavailable");
      this.#logger({ event: "learning-budget-reservation-replay" });
      return { ok: true, value: clone(existing.reservation) };
    }
    const bucket = this.#bucket(command.ownerId, command.month);
    if (bucket.committedUsd + bucket.reservedUsd + command.amountUsd > command.capUsd) return this.#fail("LearningBudgetExceeded");
    const reservation = Object.freeze({ reservationId: `budget:${encodeURIComponent(command.ownerId)}:${command.month}:${encodeURIComponent(command.idempotencyKey)}`, ownerId: command.ownerId, month: command.month, amountUsd: command.amountUsd });
    bucket.reservedUsd += command.amountUsd;
    this.#reservations.set(key, { fingerprint, reservation, status: "reserved" });
    this.#logger({ event: "learning-budget-reservation-success" });
    return { ok: true, value: clone(reservation) };
  }

  /** @param {unknown} input @returns {Promise<Result<true, LearningBudgetFailure>>} */
  async reconcile(input) {
    this.#logger({ event: "learning-budget-reconciliation-entry" });
    if (!isRecord(input) || !isRecord(input.reservation) || !isNonEmptyText(input.reservation.reservationId) || !isNonEmptyText(input.reservation.ownerId) || !isValidMonth(input.reservation.month) || !isMoney(input.reservation.amountUsd) || !(input.actualUsd === null || isMoney(input.actualUsd)) || (input.outcome !== "completed" && input.outcome !== "failed" && input.outcome !== "uncertain")) return this.#fail("LearningBudgetReconciliationUnavailable");
    if (input.outcome === "completed" && input.actualUsd === null) return this.#fail("LearningBudgetReconciliationUnavailable");
    const reservation = /** @type {LearningBudgetReservation} */ (input.reservation);
    const storedKey = findReservationKey(this.#reservations, reservation.reservationId);
    if (storedKey === null) return this.#fail("LearningBudgetReconciliationUnavailable");
    const stored = this.#reservations.get(storedKey);
    if (stored === undefined || stored.reservation.ownerId !== reservation.ownerId || stored.reservation.month !== reservation.month || stored.reservation.amountUsd !== reservation.amountUsd) return this.#fail("LearningBudgetReconciliationUnavailable");
    if (stored.status !== "reserved") return { ok: true, value: true };
    const bucket = this.#buckets.get(bucketKey(reservation.ownerId, reservation.month));
    if (bucket === undefined) throw new TypeError("Learning-budget bucket invariant is broken.");
    if (input.outcome === "failed") {
      bucket.reservedUsd -= reservation.amountUsd;
      stored.status = "failed";
      this.#logger({ event: "learning-budget-reconciliation-success" });
      return { ok: true, value: true };
    }
    if (input.outcome === "uncertain") {
      stored.status = "uncertain";
      this.#logger({ event: "learning-budget-reconciliation-success" });
      return { ok: true, value: true };
    }
    const actualUsd = /** @type {number} */ (input.actualUsd);
    const cap = Math.min(HARD_CAP_USD, bucket.committedUsd + bucket.reservedUsd + Math.max(0, actualUsd - reservation.amountUsd));
    if (bucket.committedUsd + actualUsd + bucket.reservedUsd - reservation.amountUsd > cap) {
      stored.status = "uncertain";
      return this.#fail("LearningBudgetReconciliationUnavailable");
    }
    bucket.reservedUsd -= reservation.amountUsd;
    bucket.committedUsd += actualUsd;
    stored.status = "completed";
    this.#logger({ event: "learning-budget-reconciliation-success" });
    return { ok: true, value: true };
  }

  /** @param {string} kind @returns {Result<never, LearningBudgetFailure>} */
  #fail(kind) {
    this.#logger({ event: "learning-budget-failure", failureKind: kind });
    return { ok: false, error: { kind: /** @type {LearningBudgetFailure["kind"]} */ (kind) } };
  }

  /** @param {string} ownerId @param {string} month @returns {BudgetBucket} */
  #bucket(ownerId, month) {
    const key = bucketKey(ownerId, month);
    const existing = this.#buckets.get(key);
    if (existing !== undefined) return existing;
    const created = { ownerId, month, committedUsd: 0, reservedUsd: 0 };
    this.#buckets.set(key, created);
    return created;
  }
}

/** @param {string} ownerId @param {string} month @param {string} idempotencyKey */
function scopedKey(ownerId, month, idempotencyKey) { return `${ownerId}\u0000${month}\u0000${idempotencyKey}`; }
/** @param {string} ownerId @param {string} month */
function bucketKey(ownerId, month) { return `${ownerId}\u0000${month}`; }
/** @template T @param {T} value @returns {T} */
function clone(value) { return structuredClone(value); }
/** @param {unknown} value @returns {value is number} */
function isMoney(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
/** @param {unknown} value @returns {value is string} */
function isValidMonth(value) { return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
/** @param {Map<string, StoredReservation>} reservations @param {string} reservationId @returns {string|null} */
function findReservationKey(reservations, reservationId) { for (const [key, value] of reservations) if (value.reservation.reservationId === reservationId) return key; return null; }

export {};
