// @ts-check

import { SourceLibraryGatewayClient } from "../features/source-library/gateway.js";

/** @import { CandidateSourceEligibility, FeedCandidate } from "../features/feed/contracts.js" */

export { FixturePromptRuntime } from "../features/prompt-bank/fixture-runtime.js";
export { FeedService } from "../features/feed/service.js";
export { restoreLocalState } from "./restore-local-state.js";

/**
 * Resolve one immutable, owner-scoped source projection before Feed ranking.
 * Candidates without a Library source are project-owned material and never
 * invoke the returned source check.
 *
 * @param {{ readonly fetch: typeof fetch, readonly baseUrl: string, readonly ownerId: string, readonly candidates: readonly FeedCandidate[] }} dependencies
 */
export async function createFeedSourceEligibility(dependencies) {
  if (
    typeof dependencies.fetch !== "function" ||
    !URL.canParse(dependencies.baseUrl) ||
    typeof dependencies.ownerId !== "string" ||
    dependencies.ownerId.trim() === "" ||
    !Array.isArray(dependencies.candidates)
  ) throw new TypeError("Feed source eligibility dependencies are invalid.");
  const sourceIds = [
    ...new Set(
      dependencies.candidates.flatMap((candidate) =>
        candidate.sourceId === null ? [] : [candidate.sourceId]
      ),
    ),
  ];
  const unavailable = () => ({
    ok: /** @type {const} */ (false),
    error: { kind: /** @type {const} */ ("SourceEligibilityUnavailable") },
  });
  if (sourceIds.length === 0) {
    return {
      ok: /** @type {const} */ (true),
      value: /** @type {CandidateSourceEligibility} */ (unavailable),
    };
  }
  const gateway = new SourceLibraryGatewayClient({
    fetch: dependencies.fetch,
    baseUrl: dependencies.baseUrl,
    timeoutMs: 15_000,
  });
  const active = await gateway.active(sourceIds);
  if (!active.ok) return active;
  const activeSourceIds = new Set(active.value);
  /** @type {CandidateSourceEligibility} @param {string} ownerId @param {string} sourceId @param {string} candidateId */
  const eligibility = (ownerId, sourceId, candidateId) =>
    ownerId !== dependencies.ownerId
      ? unavailable()
      : activeSourceIds.has(sourceId)
      ? { ok: true, value: /** @type {const} */ (true) }
      : {
        ok: false,
        error: {
          kind: /** @type {const} */ ("CandidateSourceDisabled"),
          candidateId,
        },
      };
  return {
    ok: /** @type {const} */ (true),
    value: eligibility,
  };
}
