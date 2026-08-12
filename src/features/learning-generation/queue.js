// @ts-check

import { isNonEmptyText } from "./contracts.js";

/** @import { LearningLogger, LearningReviewQueue, LearningReviewQueueFailure, LearningReviewQueueRepositoryPort, Result } from "./contracts.js" */

export class LearningReviewQueueService {
  #repository;
  #logger;

  /** @param {{ readonly repository: LearningReviewQueueRepositoryPort, readonly logger: LearningLogger }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.repository?.listQueue !== "function" || typeof dependencies.logger !== "function") {
      throw new TypeError("Learning-review queue dependencies are invalid.");
    }
    this.#repository = dependencies.repository;
    this.#logger = dependencies.logger;
  }

  /** @param {unknown} ownerId @returns {Promise<Result<LearningReviewQueue, LearningReviewQueueFailure>>} */
  async list(ownerId) {
    if (!isNonEmptyText(ownerId)) return this.#fail({ kind: "LearningReviewQueueCommandInvalid", field: "ownerId" });
    this.#logger({ event: "learning-review-queue-entry" });
    const result = await this.#repository.listQueue(ownerId.trim());
    if (!result.ok) return this.#fail(result.error);
    this.#logger({ event: "learning-review-queue-success", itemCount: result.value.tasks.length });
    return result;
  }

  /** @param {LearningReviewQueueFailure} failure @returns {Result<never, LearningReviewQueueFailure>} */
  #fail(failure) {
    this.#logger({ event: "learning-review-queue-failure", failureKind: failure.kind });
    return { ok: false, error: failure };
  }
}

export {};
