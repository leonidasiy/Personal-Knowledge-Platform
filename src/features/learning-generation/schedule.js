// @ts-check

import { isNonEmptyText, isRecord } from "./contracts.js";

/** @import { LearningFsrsPort, LearningLogger, LearningScheduleFailure, LearningScheduleMemory, LearningScheduleRequest, LearningScheduleResult, Result } from "./contracts.js" */

const TEN_MINUTES_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** @param {{ readonly fsrs: LearningFsrsPort, readonly logger: LearningLogger }} dependencies */
export function createLearningScheduler(dependencies) {
  if (typeof dependencies?.fsrs?.schedule !== "function" || typeof dependencies.logger !== "function") {
    throw new TypeError("Learning-scheduler dependencies are invalid.");
  }
  const fsrs = dependencies.fsrs;
  const logger = dependencies.logger;
  return Object.freeze({
    /** @param {unknown} input @returns {Result<LearningScheduleResult, LearningScheduleFailure>} */
    next(input) {
      const request = validateRequest(input);
      if (!request.ok) return fail(request.error, logger);
      const previous = request.value.previous;
      if (previous !== null && Date.parse(request.value.reviewedAt) < Date.parse(previous.dueAt)) {
        return fail({ kind: "LearningScheduleTooEarly", dueAt: previous.dueAt }, logger);
      }
      if (!request.value.correct) {
        const result = Object.freeze({ taskId: request.value.taskId, step: 0, dueAt: plus(request.value.reviewedAt, TEN_MINUTES_MS), mode: /** @type {const} */ ("validation"), corrective: true, fsrsState: null });
        logger({ event: "learning-schedule-success" });
        return { ok: true, value: result };
      }
      const step = previous?.step ?? 0;
      if (step < 0 || step > 4 || !Number.isInteger(step)) return fail({ kind: "LearningScheduleStepInvalid", step }, logger);
      if (step < 4) {
        const durations = [TEN_MINUTES_MS, DAY_MS, 3 * DAY_MS, 7 * DAY_MS];
        const result = Object.freeze({ taskId: request.value.taskId, step: step + 1, dueAt: plus(request.value.reviewedAt, durations[step]), mode: /** @type {const} */ ("validation"), corrective: false, fsrsState: previous?.fsrsState ?? null });
        logger({ event: "learning-schedule-success" });
        return { ok: true, value: result };
      }
      const scheduled = fsrs.schedule({ taskId: request.value.taskId, fsrsState: previous?.fsrsState ?? null, rating: "good", reviewedAt: request.value.reviewedAt });
      if (!scheduled.ok) return fail({ kind: "LearningScheduleFsrsRejected", reason: scheduled.error.kind }, logger);
      if (!isIsoDateTime(scheduled.value.dueAt) || !isNonEmptyText(scheduled.value.schedulerState)) return fail({ kind: "LearningScheduleFsrsResponseInvalid" }, logger);
      const result = Object.freeze({ taskId: request.value.taskId, step: 4, dueAt: scheduled.value.dueAt, mode: /** @type {const} */ ("fsrs"), corrective: false, fsrsState: scheduled.value.schedulerState });
      logger({ event: "learning-schedule-success" });
      return { ok: true, value: result };
    },
  });
}

/** @param {unknown} value @returns {Result<LearningScheduleRequest, LearningScheduleFailure>} */
function validateRequest(value) {
  if (!isRecord(value)) return invalid("command");
  if (!isNonEmptyText(value.taskId)) return invalid("taskId");
  if (typeof value.correct !== "boolean") return invalid("correct");
  if (!isNonEmptyText(value.reviewedAt) || !isIsoDateTime(value.reviewedAt)) return invalid("reviewedAt");
  if (value.previous !== null && !validMemory(value.previous)) return invalid("previous");
  const checked = /** @type {{ readonly taskId: string, readonly previous: LearningScheduleMemory | null, readonly correct: boolean, readonly reviewedAt: string }} */ (value);
  return { ok: true, value: Object.freeze({ taskId: checked.taskId.trim(), previous: checked.previous, correct: checked.correct, reviewedAt: checked.reviewedAt }) };
}

/** @param {unknown} value @returns {value is LearningScheduleMemory} */
function validMemory(value) {
  return isRecord(value) && typeof value.step === "number" && Number.isInteger(value.step) && value.step >= 0 && value.step <= 4 && isNonEmptyText(value.dueAt) && isIsoDateTime(value.dueAt) && (value.fsrsState === null || isNonEmptyText(value.fsrsState));
}

/** @param {string} value @param {number} milliseconds */
function plus(value, milliseconds) { return new Date(Date.parse(value) + milliseconds).toISOString(); }
/** @param {string} value */
function isIsoDateTime(value) { return isNonEmptyText(value) && Number.isFinite(Date.parse(value)); }
/** @param {string} field @returns {Result<never, LearningScheduleFailure>} */
function invalid(field) { return { ok: false, error: { kind: "LearningScheduleCommandInvalid", field } }; }
/** @param {LearningScheduleFailure} error @param {LearningLogger} logger @returns {Result<never, LearningScheduleFailure>} */
function fail(error, logger) { logger({ event: "learning-schedule-failure", failureKind: error.kind }); return { ok: false, error }; }

export {};
