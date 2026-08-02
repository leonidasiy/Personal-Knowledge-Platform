// @ts-check

import { decodeCursor, encodeCursor } from "./contracts.js";
import { rankCandidates } from "./ranker.js";

/** @import { CandidateAvailability, CandidateSourceEligibility, FeedCandidate, FeedFailure, FeedPage, FeedPolicy, FeedRequest, RankedFeedItem, Result } from "./contracts.js" */

export class FeedService {
  /** @type {readonly FeedCandidate[]} */
  #candidates;
  /** @type {FeedPolicy} */
  #policy;
  /** @type {() => string} */
  #createId;
  /** @type {CandidateAvailability} */
  #isCandidateAvailable;
  /** @type {CandidateSourceEligibility} */
  #isSourceEligible;
  /** @type {Map<string, { readonly ownerId: string, readonly items: readonly RankedFeedItem[] }>} */
  #sessions = new Map();

  /**
   * @param {readonly FeedCandidate[]} candidates
   * @param {FeedPolicy} policy
   * @param {() => string} createId
   * @param {CandidateAvailability} isCandidateAvailable
   * @param {CandidateSourceEligibility} isSourceEligible
   */
  constructor(
    candidates,
    policy,
    createId,
    isCandidateAvailable,
    isSourceEligible,
  ) {
    this.#candidates = Object.freeze([...candidates]);
    this.#policy = policy;
    this.#createId = createId;
    const stableCandidateIds = new Set(
      this.#candidates.map((candidate) => candidate.candidateId),
    );
    if (
      typeof isCandidateAvailable !== "function" ||
      typeof isSourceEligible !== "function"
    ) {
      throw new TypeError("Feed eligibility dependencies are invalid.");
    }
    this.#isCandidateAvailable = (candidateId) =>
      stableCandidateIds.has(candidateId) && isCandidateAvailable(candidateId);
    this.#isSourceEligible = isSourceEligible;
  }

  /**
   * @param {FeedRequest} request
   * @returns {Result<FeedPage, FeedFailure>}
   */
  getPage(request) {
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > this.#policy.maxPageSize
    ) {
      return {
        ok: false,
        error: { kind: "InvalidPageLimit", limit: request.limit },
      };
    }

    if (!Number.isFinite(Date.parse(request.now))) {
      return { ok: false, error: { kind: "CursorMalformed" } };
    }

    let sessionId = request.sessionId;
    let offset = 0;

    if (request.cursor !== undefined) {
      const decoded = decodeCursor(request.cursor);
      if (!decoded.ok) {
        return decoded;
      }
      if (decoded.value.ownerId !== request.ownerId) {
        return { ok: false, error: { kind: "CursorOwnerMismatch" } };
      }
      if (
        request.sessionId !== undefined &&
        decoded.value.sessionId !== request.sessionId
      ) {
        return { ok: false, error: { kind: "CursorSessionMismatch" } };
      }
      if (Date.parse(decoded.value.expiresAt) <= Date.parse(request.now)) {
        return {
          ok: false,
          error: { kind: "CursorExpired", expiredAt: decoded.value.expiresAt },
        };
      }
      sessionId = decoded.value.sessionId;
      offset = decoded.value.offset;
    }

    if (sessionId === undefined) {
      sessionId = this.#createId();
      /** @type {FeedCandidate[]} */
      const eligibleCandidates = [];
      for (const candidate of this.#candidates) {
        const eligibility = candidate.sourceId === null
          ? {
            ok: /** @type {const} */ (true),
            value: /** @type {const} */ (true),
          }
          : this.#isSourceEligible(
            request.ownerId,
            candidate.sourceId,
            candidate.candidateId,
          );
        if (!eligibility.ok) {
          if (eligibility.error.kind === "CandidateSourceDisabled") continue;
          return eligibility;
        }
        eligibleCandidates.push(candidate);
      }
      this.#sessions.set(sessionId, {
        ownerId: request.ownerId,
        items: rankCandidates(eligibleCandidates, this.#policy, request.now),
      });
    }

    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return { ok: false, error: { kind: "FeedSessionMissing", sessionId } };
    }
    if (session.ownerId !== request.ownerId) {
      return { ok: false, error: { kind: "CursorOwnerMismatch" } };
    }

    const items = Object.freeze(
      session.items.slice(offset, offset + request.limit),
    );
    const unavailable = items.find((item) =>
      !this.#isCandidateAvailable(item.candidateId)
    );
    if (unavailable !== undefined) {
      return {
        ok: false,
        error: {
          kind: "CandidateUnavailable",
          candidateId: unavailable.candidateId,
        },
      };
    }
    for (const item of items) {
      const candidate = this.#candidates.find((entry) =>
        entry.candidateId === item.candidateId
      );
      if (candidate === undefined) {
        return {
          ok: false,
          error: {
            kind: "CandidateUnavailable",
            candidateId: item.candidateId,
          },
        };
      }
      const eligibility = candidate.sourceId === null
        ? {
          ok: /** @type {const} */ (true),
          value: /** @type {const} */ (true),
        }
        : this.#isSourceEligible(
          request.ownerId,
          candidate.sourceId,
          candidate.candidateId,
        );
      if (!eligibility.ok) return eligibility;
    }
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < session.items.length;
    const nextCursor = hasMore
      ? encodeCursor({
        ownerId: request.ownerId,
        sessionId,
        offset: nextOffset,
        expiresAt: new Date(
          Date.parse(request.now) + this.#policy.cursorLifetimeMs,
        ).toISOString(),
      })
      : null;

    return {
      ok: true,
      value: Object.freeze({
        sessionId,
        items,
        nextCursor,
        hasMore,
        rankingVersion: this.#policy.version,
      }),
    };
  }
}
