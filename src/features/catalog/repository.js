// @ts-check

import { validateCandidate } from "./contracts.js";

/** @import { CatalogCandidate, CatalogFailure, Result } from "./contracts.js" */

export class CatalogRepository {
  /** @type {Map<string, CatalogCandidate>} */
  #byId = new Map();

  /**
   * @param {readonly CatalogCandidate[]} candidates
   * @returns {Result<CatalogRepository, CatalogFailure>}
   */
  static create(candidates) {
    const repository = new CatalogRepository();

    for (const candidate of candidates) {
      const validation = validateCandidate(candidate);
      if (!validation.ok) {
        return validation;
      }
      if (repository.#byId.has(candidate.id)) {
        return {
          ok: false,
          error: { kind: "CandidateDuplicate", candidateId: candidate.id },
        };
      }
      repository.#byId.set(candidate.id, candidate);
    }

    return { ok: true, value: repository };
  }

  /**
   * @param {string} candidateId
   * @returns {Result<CatalogCandidate, CatalogFailure>}
   */
  get(candidateId) {
    const candidate = this.#byId.get(candidateId);
    return candidate
      ? { ok: true, value: candidate }
      : { ok: false, error: { kind: "CandidateMissing", candidateId } };
  }

  /** @returns {readonly CatalogCandidate[]} */
  list() {
    return Object.freeze([...this.#byId.values()]);
  }
}
