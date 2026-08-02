// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly method: string,
 *   readonly retrievedAt: string,
 *   readonly sourceLabel: string,
 *   readonly canonicalUrl: string
 * }} DiscoveryEvidence
 */

/**
 * @typedef {{
 *   readonly basis: string,
 *   readonly attributionRequired: boolean,
 *   readonly displayPermitted: boolean,
 *   readonly transformationPermitted: boolean
 * }} RightsEvidence
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly prompt: string,
 *   readonly kind: "single-choice" | "multiple-choice" | "fill-blank" | "free-response" | "case-study",
 *   readonly choices: readonly string[],
 *   readonly correctChoices: readonly number[],
 *   readonly acceptedAnswers: readonly string[],
 *   readonly expectedConcepts: readonly string[],
 *   readonly minimumWords: number,
 *   readonly stimulus: string | null,
 *   readonly explanation: string,
 *   readonly version: number
 * }} QuizVersion
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly librarySourceId: string | null,
 *   readonly title: string,
 *   readonly publisher: string,
 *   readonly summary: string,
 *   readonly durationLabel: string,
 *   readonly formatLabel: string,
 *   readonly artworkPath: string,
 *   readonly artworkCompactPath: string,
 *   readonly artworkWidth: number,
 *   readonly artworkHeight: number,
 *   readonly artworkCompactWidth: number,
 *   readonly knowledgeUnitIds: readonly string[],
 *   readonly discovery: DiscoveryEvidence,
 *   readonly rights: RightsEvidence,
 *   readonly quiz: QuizVersion
 * }} CatalogCandidate
 */

/**
 * @typedef {{ readonly kind: "CandidateMissing", readonly candidateId: string }
 * | { readonly kind: "CandidateDuplicate", readonly candidateId: string }
 * | { readonly kind: "CandidateMalformed", readonly field: string }
 * | { readonly kind: "ProvenanceIncomplete", readonly candidateId: string }
 * | { readonly kind: "RightsEvidenceMissing", readonly candidateId: string }} CatalogFailure
 */

/**
 * Validate an externally supplied candidate at the catalog boundary.
 *
 * @param {CatalogCandidate} candidate
 * @returns {Result<CatalogCandidate, CatalogFailure>}
 */
export function validateCandidate(candidate) {
  if (
    candidate.librarySourceId !== null &&
    (typeof candidate.librarySourceId !== "string" ||
      candidate.librarySourceId.trim() === "")
  ) {
    return {
      ok: false,
      error: { kind: "CandidateMalformed", field: "librarySourceId" },
    };
  }
  const requiredText = [
    ["id", candidate.id],
    ["title", candidate.title],
    ["publisher", candidate.publisher],
    ["summary", candidate.summary],
    ["artworkPath", candidate.artworkPath],
    ["artworkCompactPath", candidate.artworkCompactPath],
    ["discovery.method", candidate.discovery.method],
    ["discovery.retrievedAt", candidate.discovery.retrievedAt],
    ["discovery.sourceLabel", candidate.discovery.sourceLabel],
    ["discovery.canonicalUrl", candidate.discovery.canonicalUrl],
  ];

  for (const [field, value] of requiredText) {
    if (value.trim() === "") {
      return { ok: false, error: { kind: "CandidateMalformed", field } };
    }
  }

  if (
    !Number.isInteger(candidate.artworkWidth) ||
    !Number.isInteger(candidate.artworkHeight) ||
    !Number.isInteger(candidate.artworkCompactWidth) ||
    candidate.artworkWidth < 1 ||
    candidate.artworkHeight < 1 ||
    candidate.artworkCompactWidth < 1 ||
    candidate.artworkCompactWidth >= candidate.artworkWidth
  ) {
    return {
      ok: false,
      error: { kind: "CandidateMalformed", field: "artwork" },
    };
  }

  if (!URL.canParse(candidate.discovery.canonicalUrl)) {
    return {
      ok: false,
      error: { kind: "ProvenanceIncomplete", candidateId: candidate.id },
    };
  }

  if (
    candidate.rights.basis.trim() === "" ||
    !candidate.rights.displayPermitted ||
    !candidate.rights.transformationPermitted
  ) {
    return {
      ok: false,
      error: { kind: "RightsEvidenceMissing", candidateId: candidate.id },
    };
  }

  if (
    candidate.quiz.version < 1 || !Number.isInteger(candidate.quiz.version)
  ) {
    return {
      ok: false,
      error: { kind: "CandidateMalformed", field: "quiz" },
    };
  }
  const quiz = candidate.quiz;
  if (
    (quiz.kind === "single-choice" || quiz.kind === "multiple-choice") &&
    (
      quiz.choices.length < 2 || quiz.correctChoices.length < 1 ||
      quiz.correctChoices.some((index) =>
        !Number.isInteger(index) || index < 0 || index >= quiz.choices.length
      )
    )
  ) {
    return {
      ok: false,
      error: { kind: "CandidateMalformed", field: "quiz.choices" },
    };
  }
  if (
    quiz.kind === "fill-blank" &&
    (quiz.acceptedAnswers.length < 1 ||
      quiz.acceptedAnswers.some((answer) => answer.trim() === ""))
  ) {
    return {
      ok: false,
      error: { kind: "CandidateMalformed", field: "quiz.acceptedAnswers" },
    };
  }
  if (
    (quiz.kind === "free-response" || quiz.kind === "case-study") &&
    (
      quiz.expectedConcepts.length < 1 ||
      quiz.expectedConcepts.some((concept) => concept.trim() === "") ||
      !Number.isInteger(quiz.minimumWords) || quiz.minimumWords < 1 ||
      (quiz.kind === "case-study" && quiz.stimulus?.trim() === "")
    )
  ) {
    return {
      ok: false,
      error: { kind: "CandidateMalformed", field: "quiz.openResponse" },
    };
  }

  return { ok: true, value: candidate };
}
