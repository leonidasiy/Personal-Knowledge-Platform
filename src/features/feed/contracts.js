// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly preference: number,
 *   readonly qualifiedExposures: number,
 *   readonly mastery: number | null,
 *   readonly dueAt: string | null
 * }} RankingSignals
 */

/**
 * @typedef {{
 *   readonly candidateId: string,
 *   readonly sourceId: string | null,
 *   readonly title: string,
 *   readonly knowledgeUnitIds: readonly string[],
 *   readonly eligible: boolean,
 *   readonly signals: RankingSignals
 * }} FeedCandidate
 */

/**
 * @typedef {{
 *   readonly candidateId: string,
 *   readonly score: number,
 *   readonly whyShown: string
 * }} RankedFeedItem
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly limit: number,
 *   readonly now: string,
 *   readonly sessionId?: string,
 *   readonly cursor?: string
 * }} FeedRequest
 */

/**
 * @typedef {{
 *   readonly sessionId: string,
 *   readonly items: readonly RankedFeedItem[],
 *   readonly nextCursor: string | null,
 *   readonly hasMore: boolean,
 *   readonly rankingVersion: string
 * }} FeedPage
 */

/**
 * @typedef {{
 *   readonly maxPageSize: number,
 *   readonly cursorLifetimeMs: number,
 *   readonly preferenceWeight: number,
 *   readonly exposurePenalty: number,
 *   readonly masteryPenalty: number,
 *   readonly dueBoost: number,
 *   readonly explorationFloor: number,
 *   readonly version: string
 * }} FeedPolicy
 */

/** @typedef {(candidateId: string) => boolean} CandidateAvailability */

/** @typedef {(ownerId: string, sourceId: string, candidateId: string) => Result<true, Extract<FeedFailure, { readonly kind: "SourceEligibilityUnavailable" | "CandidateSourceDisabled" }>>} CandidateSourceEligibility */

/**
 * @typedef {{ readonly kind: "InvalidPageLimit", readonly limit: number }
 * | { readonly kind: "CursorMalformed" }
 * | { readonly kind: "CursorExpired", readonly expiredAt: string }
 * | { readonly kind: "CursorOwnerMismatch" }
 * | { readonly kind: "CursorSessionMismatch" }
 * | { readonly kind: "FeedSessionMissing", readonly sessionId: string }
 * | { readonly kind: "SourceEligibilityUnavailable" }
 * | { readonly kind: "CandidateSourceDisabled", readonly candidateId: string }
 * | { readonly kind: "CandidateUnavailable", readonly candidateId: string }} FeedFailure
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sessionId: string,
 *   readonly offset: number,
 *   readonly expiresAt: string
 * }} CursorPayload
 */

/**
 * @param {CursorPayload} payload
 * @returns {string}
 */
export function encodeCursor(payload) {
  return btoa(JSON.stringify(payload));
}

/**
 * @param {string} encoded
 * @returns {Result<CursorPayload, FeedFailure>}
 */
export function decodeCursor(encoded) {
  try {
    const parsed = JSON.parse(atob(encoded));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.ownerId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0 ||
      typeof parsed.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.expiresAt))
    ) {
      return { ok: false, error: { kind: "CursorMalformed" } };
    }
    return {
      ok: true,
      value: {
        ownerId: parsed.ownerId,
        sessionId: parsed.sessionId,
        offset: parsed.offset,
        expiresAt: parsed.expiresAt,
      },
    };
  } catch {
    return { ok: false, error: { kind: "CursorMalformed" } };
  }
}
