// @ts-check

import { isNonEmptyText, isPositiveInteger, isRecord } from "./contracts.js";

/** @import { LearningLogger, LearningReviewCommand, LearningReviewFailure, LearningReviewRepositoryPort, LearningTask, Result } from "./contracts.js" */

export class LearningReviewService {
  #repository;
  #now;
  #logger;

  /** @param {{ readonly repository: LearningReviewRepositoryPort, readonly now: () => string, readonly logger: LearningLogger }} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies?.repository?.findTask !== "function" ||
      typeof dependencies.repository.applyDecision !== "function" ||
      typeof dependencies.repository.listVisible !== "function" ||
      typeof dependencies.now !== "function" ||
      typeof dependencies.logger !== "function"
    ) throw new TypeError("Learning-review dependencies are invalid.");
    this.#repository = dependencies.repository;
    this.#now = dependencies.now;
    this.#logger = dependencies.logger;
  }

  /** @param {unknown} input @returns {Promise<Result<LearningTask, LearningReviewFailure>>} */
  async decide(input) {
    const command = validateCommand(input);
    if (!command.ok) return this.#fail(command.error);
    const current = this.#now();
    if (!isIsoDateTime(current)) throw new TypeError("Learning-review clock returned an invalid time.");
    const task = await this.#repository.findTask(command.value.ownerId, command.value.taskId);
    if (!task.ok) return this.#fail(task.error);
    if (task.value === null) return this.#fail({ kind: "LearningReviewTaskUnknown", taskId: command.value.taskId });
    if (task.value.status !== "pending-review") return this.#fail({ kind: "LearningReviewAlreadyDecided", taskId: command.value.taskId });
    if (task.value.revision !== command.value.expectedRevision) return this.#fail({ kind: "LearningReviewRevisionStale", expected: command.value.expectedRevision, actual: task.value.revision });
    const decided = await this.#repository.applyDecision(command.value);
    if (!decided.ok) return this.#fail(decided.error);
    this.#logger({ event: "learning-review-decision-success" });
    return decided;
  }

  /** @param {unknown} ownerId @returns {Promise<Result<readonly LearningTask[], LearningReviewFailure>>} */
  async visible(ownerId) {
    if (!isNonEmptyText(ownerId)) return this.#fail({ kind: "LearningReviewCommandInvalid", field: "ownerId" });
    const result = await this.#repository.listVisible(ownerId.trim());
    if (!result.ok) return this.#fail(result.error);
    return result;
  }

  /** @param {LearningReviewFailure} failure @returns {Result<never, LearningReviewFailure>} */
  #fail(failure) {
    this.#logger({ event: "learning-review-failure", failureKind: failure.kind });
    return { ok: false, error: failure };
  }
}

/** @param {unknown} value @returns {Result<LearningReviewCommand, LearningReviewFailure>} */
function validateCommand(value) {
  if (!isRecord(value)) return invalid("command");
  for (const field of ["ownerId", "taskId", "reviewedAt", "idempotencyKey"]) if (!isNonEmptyText(value[field])) return invalid(field);
  if (!isPositiveInteger(value.expectedRevision)) return invalid("expectedRevision");
  if (value.decision !== "approve" && value.decision !== "reject") return invalid("decision");
  const checked = /** @type {{ readonly ownerId: string, readonly taskId: string, readonly expectedRevision: number, readonly decision: "approve" | "reject", readonly reviewedAt: string, readonly idempotencyKey: string }} */ (value);
  if (!isIsoDateTime(checked.reviewedAt)) return invalid("reviewedAt");
  return { ok: true, value: Object.freeze({ ownerId: checked.ownerId.trim(), taskId: checked.taskId.trim(), expectedRevision: checked.expectedRevision, decision: checked.decision, reviewedAt: checked.reviewedAt, idempotencyKey: checked.idempotencyKey.trim() }) };
}

/** @param {string} value */
function isIsoDateTime(value) { return isNonEmptyText(value) && Number.isFinite(Date.parse(value)); }
/** @param {string} field @returns {Result<never, LearningReviewFailure>} */
function invalid(field) { return { ok: false, error: { kind: "LearningReviewCommandInvalid", field } }; }

export {};
