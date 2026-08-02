// @ts-check

// @deno-types="../../../vendor/ts-fsrs/core.d.ts"
import {
  AGAIN,
  createEmptyCard,
  createFocusedScheduler,
  GOOD,
} from "../../../vendor/ts-fsrs/core.mjs";

/** @import { MemoryState, RecallFailure, RecallScheduler, Result, ScheduleRequest, ScheduleResult } from "./contracts.js" */

export const TS_FSRS_VERSION = "ts-fsrs@5.4.1/FSRS-6.0";

/**
 * @typedef {{
 *   readonly due: Date | string,
 *   readonly stability: number,
 *   readonly difficulty: number,
 *   readonly elapsed_days: number,
 *   readonly scheduled_days: number,
 *   readonly learning_steps: number,
 *   readonly reps: number,
 *   readonly lapses: number,
 *   readonly state: number,
 *   readonly last_review?: Date | string
 * }} VendorCard
 */

/**
 * @typedef {{
 *   readonly requestRetention: number,
 *   readonly maximumInterval: number,
 *   readonly enableFuzz: boolean,
 *   readonly enableShortTerm: boolean,
 *   readonly learningSteps: readonly string[],
 *   readonly relearningSteps: readonly string[]
 * }} TsFsrsConfiguration
 */

/**
 * @param {TsFsrsConfiguration} configuration
 * @returns {RecallScheduler}
 */
export function createTsFsrsScheduler(configuration) {
  validateConfiguration(configuration);
  const scheduleNext = createFocusedScheduler(
    configuration.requestRetention,
    configuration.maximumInterval,
    configuration.enableFuzz,
    configuration.enableShortTerm,
    configuration.learningSteps,
    configuration.relearningSteps,
  );

  return Object.freeze({
    /**
     * @param {ScheduleRequest} request
     * @returns {Result<ScheduleResult, RecallFailure>}
     */
    schedule(request) {
      const reviewedAt = new Date(request.reviewedAt);
      if (!Number.isFinite(reviewedAt.getTime())) {
        return {
          ok: false,
          error: {
            kind: "RecallSchedulerRejected",
            reason: "Review time is invalid.",
          },
        };
      }
      if (
        request.memory !== null &&
        request.memory.schedulerVersion !== TS_FSRS_VERSION
      ) {
        return {
          ok: false,
          error: {
            kind: "RecallSchedulerRejected",
            reason: "Memory state uses a different scheduler version.",
          },
        };
      }

      const restored = restoreCard(request.memory, reviewedAt);
      if (!restored.ok) return restored;

      try {
        const rating = request.rating === "good" ? GOOD : AGAIN;
        const card = scheduleNext(restored.value, reviewedAt, rating);
        return {
          ok: true,
          value: Object.freeze({
            dueAt: card.due.toISOString(),
            stability: card.stability,
            difficulty: card.difficulty,
            scheduledDays: card.scheduled_days,
            schedulerState: JSON.stringify(card),
            schedulerVersion: TS_FSRS_VERSION,
          }),
        };
      } catch {
        return {
          ok: false,
          error: {
            kind: "RecallSchedulerRejected",
            reason: "FSRS rejected the supplied memory state.",
          },
        };
      }
    },
  });
}

/**
 * @param {MemoryState | null} memory
 * @param {Date} reviewedAt
 * @returns {Result<VendorCard, RecallFailure>}
 */
function restoreCard(memory, reviewedAt) {
  if (memory === null) {
    const createCard = /** @type {(now: Date) => VendorCard} */ (
      createEmptyCard
    );
    return { ok: true, value: createCard(reviewedAt) };
  }
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(memory.schedulerState));
    if (!isVendorCard(parsed)) {
      return {
        ok: false,
        error: {
          kind: "RecallSchedulerRejected",
          reason: "Stored memory state is malformed.",
        },
      };
    }
    return { ok: true, value: parsed };
  } catch {
    return {
      ok: false,
      error: {
        kind: "RecallSchedulerRejected",
        reason: "Stored memory state is unreadable.",
      },
    };
  }
}

/**
 * @param {unknown} value
 * @returns {value is VendorCard}
 */
function isVendorCard(value) {
  if (typeof value !== "object" || value === null) return false;
  const card = /** @type {Record<string, unknown>} */ (value);
  return (
    (typeof card.due === "string" || card.due instanceof Date) &&
    typeof card.stability === "number" &&
    typeof card.difficulty === "number" &&
    typeof card.elapsed_days === "number" &&
    typeof card.scheduled_days === "number" &&
    typeof card.learning_steps === "number" &&
    typeof card.reps === "number" &&
    typeof card.lapses === "number" &&
    typeof card.state === "number" &&
    (card.last_review === undefined ||
      typeof card.last_review === "string" ||
      card.last_review instanceof Date)
  );
}

/** @param {TsFsrsConfiguration} configuration */
function validateConfiguration(configuration) {
  if (
    !Number.isFinite(configuration.requestRetention) ||
    configuration.requestRetention < 0.7 ||
    configuration.requestRetention > 0.99
  ) {
    throw new RangeError("FsrsRetentionInvalid");
  }
  if (
    !Number.isInteger(configuration.maximumInterval) ||
    configuration.maximumInterval < 1 ||
    configuration.maximumInterval > 36_500
  ) {
    throw new RangeError("FsrsIntervalInvalid");
  }
  if (
    typeof configuration.enableFuzz !== "boolean" ||
    typeof configuration.enableShortTerm !== "boolean"
  ) {
    throw new TypeError("FsrsFlagsInvalid");
  }
  if (
    !Array.isArray(configuration.learningSteps) ||
    !Array.isArray(configuration.relearningSteps)
  ) {
    throw new TypeError("FsrsStepsInvalid");
  }
}
