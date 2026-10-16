// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly dailyStudyTarget: number,
 *   readonly dailyRecallLimit: number,
 *   readonly timeZone: string,
 *   readonly revision: number,
 *   readonly updatedAt: string
 * }} DailyLearningSettings
 */

/**
 * @typedef {{
 *   readonly contentId: string,
 *   readonly contentVersion: number,
 *   readonly promptIds: readonly string[]
 * }} StudyCandidateRef
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly learningDay: string,
 *   readonly ordinal: number,
 *   readonly items: readonly StudyCandidateRef[],
 *   readonly studyTarget: number,
 *   readonly recallLimit: number,
 *   readonly settingsRevision: number,
 *   readonly selectorVersion: string,
 *   readonly idempotencyKey: string,
 *   readonly createdAt: string
 * }} DailyStudySet
 */

/**
 * @typedef {{
 *   readonly promptId: string,
 *   readonly promptVersion: number,
 *   readonly contentId: string,
 *   readonly eligibleAt: string,
 *   readonly dueAt: string,
 *   readonly generationSequence: number,
 *   readonly sourceStudiedAt: string
 * }} RecallCandidateRef
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly learningDay: string,
 *   readonly studySetId: string,
 *   readonly prompts: readonly RecallCandidateRef[],
 *   readonly limit: number,
 *   readonly revision: number,
 *   readonly selectorVersion: string,
 *   readonly idempotencyKey: string,
 *   readonly createdAt: string
 * }} DailyRecallCohort
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly learningDay: string,
 *   readonly studySetId: string,
 *   readonly cohortId: string,
 *   readonly promptId: string,
 *   readonly promptVersion: number,
 *   readonly respondedAt: string,
 *   readonly context: "daily",
 *   readonly finalized: boolean,
 *   readonly correct: boolean | null,
 *   readonly responseSequence: number
 * }} DailyResponseFact
 */

/**
 * @typedef {{
 *   readonly studied: number,
 *   readonly assigned: number
 * }} DailyStudyProgress
 */

/**
 * @typedef {{
 *   readonly correct: number,
 *   readonly total: number,
 *   readonly percentage: number | null
 * }} RecallAccuracy
 */

/**
 * @typedef {{ readonly kind: "DailySettingsInvalid", readonly field: string }
 * | { readonly kind: "DailyTargetOutOfRange", readonly target: number }
 * | { readonly kind: "DailyRecallLimitOutOfRange", readonly limit: number }
 * | { readonly kind: "DailySettingsRevisionConflict", readonly expected: number, readonly actual: number }
 * | { readonly kind: "DailySettingsAlreadyRecorded", readonly revision: number }
 * | { readonly kind: "DailyAssignmentInvalid", readonly field: string }
 * | { readonly kind: "DailyAssignmentInsufficientCandidates", readonly required: number, readonly available: number }
 * | { readonly kind: "DailyAssignmentSelectionInvalid", readonly reason: string }
 * | { readonly kind: "DailyAssignmentAlreadyRecorded", readonly idempotencyKey: string }
 * | { readonly kind: "DailyStudySetUnknown", readonly studySetId: string }
 * | { readonly kind: "RecallAssignmentInvalid", readonly field: string }
 * | { readonly kind: "RecallAssignmentPromptIneligible", readonly promptId: string }
 * | { readonly kind: "RecallAssignmentAlreadyRecorded", readonly idempotencyKey: string }
 * | { readonly kind: "NextStudySetLocked", readonly remainingStudy: number, readonly remainingRecall: number }
 * | { readonly kind: "DailyProjectionInvalid", readonly field: string }} DailyLearningFailure
 */

/**
 * @typedef {{
 *   select(input: {
 *     readonly ownerId: string,
 *     readonly learningDay: string,
 *     readonly count: number,
 *     readonly candidates: readonly StudyCandidateRef[],
 *     readonly excludedContentIds: ReadonlySet<string>
 *   }): readonly StudyCandidateRef[],
 *   readonly version: string
 * }} DailyStudySelector
 */

/**
 * @param {unknown} value
 * @returns {Result<Omit<DailyLearningSettings, "revision"> & { readonly expectedRevision: number }, DailyLearningFailure>}
 */
export function validateSettingsCommand(value) {
  if (!isRecord(value)) return invalidSettings("document");
  const ownerId = value.ownerId;
  const dailyStudyTarget = value.dailyStudyTarget;
  const dailyRecallLimit = value.dailyRecallLimit;
  const timeZone = value.timeZone;
  const expectedRevision = value.expectedRevision;
  const updatedAt = value.updatedAt;
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    return invalidSettings("ownerId");
  }
  if (
    typeof dailyStudyTarget !== "number" ||
    !Number.isInteger(dailyStudyTarget) || dailyStudyTarget < 1 ||
    dailyStudyTarget > 50
  ) {
    return {
      ok: false,
      error: {
        kind: "DailyTargetOutOfRange",
        target: typeof dailyStudyTarget === "number"
          ? dailyStudyTarget
          : Number.NaN,
      },
    };
  }
  if (
    typeof dailyRecallLimit !== "number" ||
    !Number.isSafeInteger(dailyRecallLimit) || dailyRecallLimit < 0
  ) {
    return {
      ok: false,
      error: {
        kind: "DailyRecallLimitOutOfRange",
        limit: typeof dailyRecallLimit === "number"
          ? dailyRecallLimit
          : Number.NaN,
      },
    };
  }
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    return invalidSettings("timeZone");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
  } catch {
    return invalidSettings("timeZone");
  }
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) || expectedRevision < 0
  ) {
    return invalidSettings("expectedRevision");
  }
  if (
    typeof updatedAt !== "string" ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    return invalidSettings("updatedAt");
  }
  return {
    ok: true,
    value: Object.freeze({
      ownerId,
      dailyStudyTarget,
      dailyRecallLimit,
      timeZone,
      expectedRevision,
      updatedAt,
    }),
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} field
 * @returns {Result<never, DailyLearningFailure>}
 */
function invalidSettings(field) {
  return { ok: false, error: { kind: "DailySettingsInvalid", field } };
}

export {};
