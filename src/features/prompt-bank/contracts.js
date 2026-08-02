// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/** @typedef {"short" | "medium" | "long"} ContentLengthBand */
/** @typedef {"single-choice" | "multiple-choice" | "fill-blank" | "free-response" | "case-study"} QuestionKind */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly excerpt: string
 * }} KnowledgeAnchor
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly contentId: string,
 *   readonly contentVersion: number,
 *   readonly sourceKind: "text" | "audio-video",
 *   readonly wordCount: number,
 *   readonly sentenceCount: number,
 *   readonly paragraphCount: number,
 *   readonly transcriptSource: string | null,
 *   readonly anchors: readonly KnowledgeAnchor[],
 *   readonly evidenceVersion: string,
 *   readonly provenance: string
 * }} ContentExtentEvidence
 */

/**
 * @typedef {{
 *   readonly shortMaxWords: number,
 *   readonly shortMaxSentences: number,
 *   readonly mediumMaxWords: number,
 *   readonly mediumMaxParagraphs: number,
 *   readonly maxUnitWords: number,
 *   readonly maxSegmentsPerCommand: number,
 *   readonly version: string
 * }} ContentExtentPolicy
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly startWord: number,
 *   readonly endWord: number,
 *   readonly sourceAnchorIds: readonly string[]
 * }} ContentSegment
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly contentId: string,
 *   readonly contentVersion: number,
 *   readonly knowledgeAnchorIds: readonly string[],
 *   readonly kind: QuestionKind,
 *   readonly prompt: string,
 *   readonly version: number,
 *   readonly generatedAt: string,
 *   readonly eligibleAt: string,
 *   readonly generatorVersion: string,
 *   readonly policyVersion: string,
 *   readonly provenance: "fixture-generator"
 * }} GeneratedPrompt
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly contentId: string,
 *   readonly contentVersion: number,
 *   readonly studiedAt: string
 * }} PromptStudyFact
 */

/**
 * @typedef {{
 *   readonly evidence: ContentExtentEvidence,
 *   readonly band: ContentLengthBand,
 *   readonly count: number,
 *   readonly generatedAt: string,
 *   readonly eligibleAt: string,
 *   readonly policyVersion: string
 * }} PromptGenerationInput
 */

/**
 * @typedef {{
 *   generate(input: PromptGenerationInput): readonly GeneratedPrompt[],
 *   readonly version: string
 * }} PromptGenerator
 */

/** @typedef {{ now(): Result<string, PromptBankFailure> }} PromptClock */
/** @typedef {(event: PromptGenerationEvent) => Promise<Result<true, PromptBankFailure>>} PromptEventWriter */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly contentId: string,
 *   readonly contentVersion: number,
 *   readonly band: ContentLengthBand,
 *   readonly prompts: readonly GeneratedPrompt[],
 *   readonly generationSequence: number,
 *   readonly idempotencyKey: string,
 *   readonly generatedAt: string,
 *   readonly eligibleAt: string,
 *   readonly evidenceVersion: string,
 *   readonly policyVersion: string,
 *   readonly generatorVersion: string
 * }} PromptGenerationEvent
 */

/**
 * @typedef {{ readonly kind: "MaterialLengthEvidenceMissing", readonly contentId: string }
 * | { readonly kind: "MaterialLengthEvidenceInvalid", readonly field: string }
 * | { readonly kind: "MaterialLengthEvidenceConflict", readonly field: string }
 * | { readonly kind: "MaterialLengthUnitUnsupported", readonly unit: string }
 * | { readonly kind: "MaterialLengthVersionMismatch", readonly expected: number, readonly actual: number }
 * | { readonly kind: "MaterialLengthBandUnknown", readonly contentId: string }
 * | { readonly kind: "MaterialSegmentationInvalid", readonly segmentId: string }
 * | { readonly kind: "MaterialSegmentationLimitExceeded", readonly maximum: number, readonly actual: number }
 * | { readonly kind: "PromptYieldPolicyInvalid", readonly field: string }
 * | { readonly kind: "PromptYieldEvidenceMismatch", readonly required: number, readonly available: number }
 * | { readonly kind: "PromptGenerationTooEarly", readonly eligibleAt: string }
 * | { readonly kind: "PromptSourceNotStudied", readonly contentId: string }
 * | { readonly kind: "PromptSourceOwnerMismatch", readonly ownerId: string }
 * | { readonly kind: "PromptSourceVersionMismatch", readonly expected: number, readonly actual: number }
 * | { readonly kind: "PromptGenerationAlreadyRecorded", readonly idempotencyKey: string }
 * | { readonly kind: "PromptGenerationOutputInvalid", readonly reason: string }
 * | { readonly kind: "PromptGenerationPersistenceFailed", readonly recordId: string }
 * | { readonly kind: "ClockUnavailable" }
 * | { readonly kind: "ClockInstantInvalid", readonly instant: string }
 * | { readonly kind: "ClockRegressionDetected", readonly studiedAt: string, readonly now: string }} PromptBankFailure
 */

export {};
