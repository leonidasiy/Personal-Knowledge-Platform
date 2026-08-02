// @ts-check

/** @import { DueCandidate, MotionOutcome, ProgressFailure, ResolvedTheme, Result, ShownProgress, ThemeMode, ViewTransitionCapability } from "./contracts.js" */

/**
 * @param {ThemeMode} mode
 * @param {boolean} prefersDark
 * @returns {ResolvedTheme}
 */
export function resolveTheme(mode, prefersDark) {
  if (mode !== "system" && mode !== "light" && mode !== "dark") {
    throw new TypeError("ThemeModeInvalid");
  }
  if (typeof prefersDark !== "boolean") {
    throw new TypeError("ThemePreferenceInvalid");
  }
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}

/**
 * @param {number} studied
 * @param {number} shown
 * @returns {Result<ShownProgress, ProgressFailure>}
 */
export function createBoundedProgress(studied, shown) {
  if (!Number.isInteger(studied) || studied < 0) {
    return {
      ok: false,
      error: { kind: "ProgressInputInvalid", field: "studied" },
    };
  }
  if (!Number.isInteger(shown) || shown < 0) {
    return {
      ok: false,
      error: { kind: "ProgressInputInvalid", field: "shown" },
    };
  }
  if (studied > shown) {
    return {
      ok: false,
      error: { kind: "ProgressOutOfBounds", studied, shown },
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      studied,
      shown,
      ratio: shown === 0 ? 0 : studied / shown,
      label: `${studied}/${shown} studied`,
    }),
  };
}

/**
 * Counts unique, qualified candidate IDs only when they are currently shown.
 *
 * @param {readonly string[]} shownCandidateIds
 * @param {readonly string[]} qualifiedCandidateIds
 * @returns {Result<ShownProgress, ProgressFailure>}
 */
export function calculateShownProgress(
  shownCandidateIds,
  qualifiedCandidateIds,
) {
  const shownValidation = validateCandidateIds(
    shownCandidateIds,
    "shownCandidateIds",
  );
  if (!shownValidation.ok) return shownValidation;
  const qualifiedValidation = validateCandidateIds(
    qualifiedCandidateIds,
    "qualifiedCandidateIds",
  );
  if (!qualifiedValidation.ok) return qualifiedValidation;
  const shown = new Set(shownCandidateIds);
  const qualified = new Set(qualifiedCandidateIds);
  let studied = 0;
  for (const candidateId of shown) {
    if (qualified.has(candidateId)) studied += 1;
  }
  return createBoundedProgress(studied, shown.size);
}

/**
 * @param {readonly DueCandidate[]} candidates
 * @param {string} now
 * @returns {Result<number, ProgressFailure>}
 */
export function countReviewsDue(candidates, now) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    return { ok: false, error: { kind: "ProgressInputInvalid", field: "now" } };
  }
  if (!Array.isArray(candidates)) {
    return {
      ok: false,
      error: { kind: "ProgressInputInvalid", field: "candidates" },
    };
  }
  let due = 0;
  /** @type {Set<string>} */
  const seen = new Set();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.candidateId !== "string" ||
      candidate.candidateId.length === 0 ||
      (candidate.dueAt !== null &&
        (typeof candidate.dueAt !== "string" ||
          !Number.isFinite(Date.parse(candidate.dueAt))))
    ) {
      return {
        ok: false,
        error: { kind: "ProgressInputInvalid", field: `candidates[${index}]` },
      };
    }
    if (seen.has(candidate.candidateId)) continue;
    seen.add(candidate.candidateId);
    if (candidate.dueAt !== null && Date.parse(candidate.dueAt) <= nowMs) {
      due += 1;
    }
  }
  return { ok: true, value: due };
}

/**
 * Assigns a stable, presentation-only slot without interpreting candidate content.
 *
 * @param {string} candidateId
 * @param {number} slotCount
 * @returns {number}
 */
export function accentSlotFor(candidateId, slotCount) {
  if (typeof candidateId !== "string") {
    throw new TypeError("AccentCandidateInvalid");
  }
  if (!Number.isInteger(slotCount) || slotCount <= 0) {
    throw new RangeError("AccentSlotsInvalid");
  }
  let hash = 2166136261;
  for (const character of candidateId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % slotCount;
}

/**
 * Applies an update once, using a transition when eligible and reporting the
 * exact fallback state when transition infrastructure is unavailable.
 *
 * @param {{
 *   readonly update: () => void,
 *   readonly transitions: ViewTransitionCapability | null,
 *   readonly reducedMotion: boolean
 * }} command
 * @returns {Promise<MotionOutcome>}
 */
export async function applyPresentationUpdate(command) {
  if (
    typeof command !== "object" ||
    command === null ||
    typeof command.update !== "function" ||
    (command.transitions !== null &&
      typeof command.transitions.start !== "function") ||
    typeof command.reducedMotion !== "boolean"
  ) {
    throw new TypeError("PresentationCommandInvalid");
  }

  let applied = false;
  const applyOnce = () => {
    if (applied) return;
    applied = true;
    command.update();
  };

  if (command.reducedMotion || command.transitions === null) {
    applyOnce();
    return {
      kind: "TransitionFallbackApplied",
      error: {
        kind: "TransitionUnavailable",
        reason: command.reducedMotion ? "reduced-motion" : "unsupported",
      },
    };
  }

  /** @type {import("./contracts.js").ViewTransitionHandle} */
  let transition;
  try {
    transition = command.transitions.start(applyOnce);
  } catch {
    applyOnce();
    return {
      kind: "TransitionFallbackApplied",
      error: { kind: "TransitionStartFailed" },
    };
  }

  void transition.ready?.catch(() => undefined);
  void transition.updateCallbackDone?.catch(() => undefined);

  try {
    await transition.finished;
    applyOnce();
    return { kind: "TransitionApplied" };
  } catch {
    applyOnce();
    return {
      kind: "TransitionAppliedWithCompletionFailure",
      error: { kind: "TransitionCompletionFailed" },
    };
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {Result<true, ProgressFailure>}
 */
function validateCandidateIds(value, field) {
  if (
    !Array.isArray(value) ||
    value.some((candidateId) =>
      typeof candidateId !== "string" || candidateId.length === 0
    )
  ) {
    return { ok: false, error: { kind: "ProgressInputInvalid", field } };
  }
  return { ok: true, value: true };
}
