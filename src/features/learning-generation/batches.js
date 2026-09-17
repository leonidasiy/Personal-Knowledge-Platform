// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly knowledgeId: string,
 *   readonly sourceId: string,
 *   readonly questionId: string,
 *   readonly viewCount: number,
 *   readonly lastAnswerCorrect: boolean | null,
 *   readonly scheduledDays: number,
 *   readonly preference: number
 * }} KnowledgeSelectionCandidate
 */

/**
 * @typedef {{
 *   readonly batchId: string,
 *   readonly learningDay: string,
 *   readonly items: readonly KnowledgeSelectionCandidate[],
 *   readonly completed: boolean
 * }} KnowledgeBatch
 */

/**
 * @typedef {{ readonly kind: "KnowledgeBatchSelectionInvalid", readonly field: string }
 * | { readonly kind: "KnowledgeBatchInsufficientCandidates", readonly required: number, readonly available: number }
 * | { readonly kind: "LearningBatchInvalid", readonly field: string }
 * | { readonly kind: "LearningBatchIncomplete" }
 * | { readonly kind: "LearningBatchAlreadyClosed" }
 * | { readonly kind: "LearningBatchRefreshSameDay", readonly learningDay: string }} LearningBatchFailure
 */

const MAX_BATCH_SIZE = 5;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function nonEmptyText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value @returns {value is number} */
function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} value @returns {value is number} */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {unknown} value @returns {value is KnowledgeSelectionCandidate} */
function isCandidate(value) {
  return isRecord(value) && nonEmptyText(value.knowledgeId) &&
    nonEmptyText(value.sourceId) && nonEmptyText(value.questionId) &&
    nonNegativeInteger(value.viewCount) &&
    (value.lastAnswerCorrect === null || typeof value.lastAnswerCorrect === "boolean") &&
    nonNegativeInteger(value.scheduledDays) && finiteNumber(value.preference) &&
    value.preference >= -1 && value.preference <= 1;
}

/** @param {unknown} value @returns {value is KnowledgeBatch} */
function isBatch(value) {
  return isRecord(value) && nonEmptyText(value.batchId) &&
    nonEmptyText(value.learningDay) && Array.isArray(value.items) &&
    value.items.length === MAX_BATCH_SIZE && value.items.every(isCandidate) &&
    typeof value.completed === "boolean";
}

/** @param {KnowledgeSelectionCandidate} candidate @param {{ readonly now: string }} context @returns {number} */
export function calculateKnowledgeWeight(candidate, context) {
  if (!isCandidate(candidate)) throw new TypeError("Knowledge selection candidate is invalid.");
  if (!isRecord(context) || !nonEmptyText(context.now) || !Number.isFinite(Date.parse(context.now))) {
    throw new TypeError("Knowledge selection clock is invalid.");
  }
  const viewFactor = 1 / (1 + candidate.viewCount);
  const answerFactor = candidate.lastAnswerCorrect === true
    ? 0.65
    : candidate.lastAnswerCorrect === false ? 1.05 : 1;
  const intervalFactor = 1 / (1 + candidate.scheduledDays / 7);
  const preferenceFactor = 1 + candidate.preference * 0.25;
  return Math.max(0.000001, viewFactor * answerFactor * intervalFactor * preferenceFactor);
}

/**
 * Select a weighted, duplicate-free Feed batch. The random function is
 * injected so the selection can be replayed and tested without ambient state.
 * @param {readonly KnowledgeSelectionCandidate[]} candidates
 * @param {{ readonly count: number, readonly random: () => number, readonly now: string }} options
 * @returns {Result<readonly KnowledgeSelectionCandidate[], LearningBatchFailure>}
 */
export function selectKnowledgeBatch(candidates, options) {
  if (!Array.isArray(candidates) || !candidates.every(isCandidate)) {
    return { ok: false, error: { kind: "KnowledgeBatchSelectionInvalid", field: "candidates" } };
  }
  if (!isRecord(options) || !Number.isSafeInteger(options.count) || options.count < 1 || options.count > MAX_BATCH_SIZE) {
    return { ok: false, error: { kind: "KnowledgeBatchSelectionInvalid", field: "count" } };
  }
  if (typeof options.random !== "function") {
    return { ok: false, error: { kind: "KnowledgeBatchSelectionInvalid", field: "random" } };
  }
  try {
    if (!nonEmptyText(options.now) || !Number.isFinite(Date.parse(options.now))) throw new TypeError("invalid clock");
    const ids = new Set();
    for (const item of candidates) {
      if (ids.has(item.knowledgeId)) return { ok: false, error: { kind: "KnowledgeBatchSelectionInvalid", field: "duplicateKnowledgeId" } };
      ids.add(item.knowledgeId);
    }
    if (candidates.length < options.count) {
      return { ok: false, error: { kind: "KnowledgeBatchInsufficientCandidates", required: options.count, available: candidates.length } };
    }
    const remaining = [...candidates];
    /** @type {KnowledgeSelectionCandidate[]} */
    const selected = [];
    while (selected.length < options.count) {
      const weights = remaining.map((item) => calculateKnowledgeWeight(item, { now: options.now }));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      if (!(total > 0)) return { ok: false, error: { kind: "KnowledgeBatchSelectionInvalid", field: "weight" } };
      const random = options.random();
      if (!Number.isFinite(random) || random < 0 || random >= 1) return { ok: false, error: { kind: "KnowledgeBatchSelectionInvalid", field: "random" } };
      let cursor = random * total;
      let selectedIndex = remaining.length - 1;
      for (let index = 0; index < weights.length; index += 1) {
        cursor -= weights[index];
        if (cursor < 0) {
          selectedIndex = index;
          break;
        }
      }
      selected.push(remaining[selectedIndex]);
      remaining.splice(selectedIndex, 1);
    }
    return { ok: true, value: Object.freeze(selected.map((item) => Object.freeze({ ...item }))) };
  } catch (error) {
    if (error instanceof TypeError) return { ok: false, error: { kind: "KnowledgeBatchSelectionInvalid", field: "clock" } };
    throw error;
  }
}

/**
 * @param {KnowledgeBatch} batch
 * @param {{ readonly reachedBottom: boolean }} command
 * @returns {Result<{ readonly batch: KnowledgeBatch, readonly unlockedQuestionIds: readonly string[] }, LearningBatchFailure>}
 */
export function completeKnowledgeBatch(batch, command) {
  if (!isBatch(batch)) return { ok: false, error: { kind: "LearningBatchInvalid", field: "batch" } };
  if (!isRecord(command) || typeof command.reachedBottom !== "boolean") return { ok: false, error: { kind: "LearningBatchInvalid", field: "reachedBottom" } };
  if (batch.completed) return { ok: false, error: { kind: "LearningBatchAlreadyClosed" } };
  if (!command.reachedBottom) return { ok: false, error: { kind: "LearningBatchIncomplete" } };
  const completed = Object.freeze({ ...batch, completed: true });
  return { ok: true, value: Object.freeze({ batch: completed, unlockedQuestionIds: Object.freeze(batch.items.map((item) => item.questionId)) }) };
}

/**
 * @param {KnowledgeBatch} batch
 * @param {{ readonly requestedDay: string }} command
 * @returns {Result<true, LearningBatchFailure>}
 */
export function validateBatchRefresh(batch, command) {
  if (!isBatch(batch)) return { ok: false, error: { kind: "LearningBatchInvalid", field: "batch" } };
  if (!isRecord(command) || !nonEmptyText(command.requestedDay)) return { ok: false, error: { kind: "LearningBatchInvalid", field: "requestedDay" } };
  if (!batch.completed) return { ok: false, error: { kind: "LearningBatchIncomplete" } };
  if (command.requestedDay < batch.learningDay) return { ok: false, error: { kind: "LearningBatchRefreshSameDay", learningDay: batch.learningDay } };
  return { ok: true, value: true };
}

export { MAX_BATCH_SIZE };
