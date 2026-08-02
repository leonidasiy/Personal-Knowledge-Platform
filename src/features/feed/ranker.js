// @ts-check

/** @import { FeedCandidate, FeedPolicy, RankedFeedItem } from "./contracts.js" */

/** @param {number} value */
function clampSignal(value) {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Rank eligible candidates without mutating their source records.
 *
 * @param {readonly FeedCandidate[]} candidates
 * @param {FeedPolicy} policy
 * @param {string} now
 * @returns {readonly RankedFeedItem[]}
 */
export function rankCandidates(candidates, policy, now) {
  const nowMs = Date.parse(now);

  return Object.freeze(
    candidates
      .filter((candidate) => candidate.eligible)
      .map((candidate) => {
        const preference = clampSignal(candidate.signals.preference);
        const mastery = candidate.signals.mastery === null
          ? 0
          : Math.max(0, Math.min(1, candidate.signals.mastery));
        const due = candidate.signals.dueAt !== null
          && Date.parse(candidate.signals.dueAt) <= nowMs;
        const rawScore = 1
          + preference * policy.preferenceWeight
          - candidate.signals.qualifiedExposures * policy.exposurePenalty
          - mastery * policy.masteryPenalty
          + (due ? policy.dueBoost : 0);
        const score = Math.max(policy.explorationFloor, rawScore);
        const whyShown = due
          ? "Your recall is due."
          : preference > 0
            ? "Related to learning you asked to see more often."
            : candidate.signals.qualifiedExposures === 0
              ? "New to your learning feed."
              : "Selected to keep your learning mix varied.";

        return Object.freeze({
          candidateId: candidate.candidateId,
          score,
          whyShown,
        });
      })
      .sort((left, right) =>
        right.score - left.score || left.candidateId.localeCompare(right.candidateId)
      ),
  );
}
