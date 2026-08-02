// @ts-check

/** @import { Result, WorkerFailure } from "./contracts.js" */

export class YouTubeQuotaLedger {
  /** @type {number} */
  #searchQueryDailyLimit;
  /** @type {number} */
  #generalReadDailyLimit;
  /** @type {Map<string, number>} */
  #searchQueryUsage = new Map();
  /** @type {Map<string, number>} */
  #generalReadUsage = new Map();

  /**
   * @param {{
   *   readonly searchQueryDailyLimit: number,
   *   readonly generalReadDailyLimit: number
   * }} configuration
   */
  constructor(configuration) {
    if (
      !isPositiveInteger(configuration.searchQueryDailyLimit) ||
      !isPositiveInteger(configuration.generalReadDailyLimit)
    ) {
      throw new TypeError("YouTube quota configuration is invalid.");
    }
    this.#searchQueryDailyLimit = configuration.searchQueryDailyLimit;
    this.#generalReadDailyLimit = configuration.generalReadDailyLimit;
  }

  /**
   * @param {{ readonly quotaDay: string }} reservation
   * @returns {Result<number, WorkerFailure>}
   */
  reserveSearchQuery(reservation) {
    const valid = validateQuotaDay(reservation.quotaDay);
    if (!valid.ok) return valid;
    return reserve(
      this.#searchQueryUsage,
      valid.value,
      1,
      this.#searchQueryDailyLimit,
      "YouTubeSearchQuotaExceeded",
    );
  }

  /**
   * @param {{ readonly quotaDay: string, readonly units: number }} reservation
   * @returns {Result<number, WorkerFailure>}
   */
  reserveGeneralRead(reservation) {
    const valid = validateQuotaDay(reservation.quotaDay);
    if (!valid.ok) return valid;
    if (!isPositiveInteger(reservation.units)) {
      return {
        ok: false,
        error: { kind: "YouTubeQuotaReservationInvalid", field: "units" },
      };
    }
    return reserve(
      this.#generalReadUsage,
      valid.value,
      reservation.units,
      this.#generalReadDailyLimit,
      "YouTubeGeneralQuotaExceeded",
    );
  }
}

/**
 * @param {Map<string, number>} usage
 * @param {string} quotaDay
 * @param {number} units
 * @param {number} limit
 * @param {"YouTubeSearchQuotaExceeded" | "YouTubeGeneralQuotaExceeded"} failureKind
 * @returns {Result<number, WorkerFailure>}
 */
function reserve(usage, quotaDay, units, limit, failureKind) {
  const used = usage.get(quotaDay) ?? 0;
  if (used + units > limit) {
    return { ok: false, error: { kind: failureKind } };
  }
  const next = used + units;
  usage.set(quotaDay, next);
  return { ok: true, value: next };
}

/** @param {string} quotaDay @returns {Result<string, WorkerFailure>} */
function validateQuotaDay(quotaDay) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(quotaDay);
  if (matched === null) {
    return {
      ok: false,
      error: { kind: "YouTubeQuotaReservationInvalid", field: "quotaDay" },
    };
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return {
      ok: false,
      error: { kind: "YouTubeQuotaReservationInvalid", field: "quotaDay" },
    };
  }
  return { ok: true, value: quotaDay };
}

/** @param {number} value */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}
