// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly contentId: string,
 *   readonly contentVersion: number,
 *   readonly knowledgeUnitIds: readonly [string, ...string[]],
 *   readonly sourceAnchorIds: readonly [string, ...string[]],
 *   readonly generatorVersion: string,
 *   readonly version: number,
 *   readonly scorerVersion: string,
 *   readonly provenance: string
 * }} QuestionMetadata
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly label: string
 * }} Choice
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly prompt: string,
 *   readonly kind: "single-choice",
 *   readonly choices: readonly Choice[],
 *   readonly correctChoiceIds: readonly [string],
 *   readonly explanation: string
 * } & QuestionMetadata} SingleChoiceQuestion
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly prompt: string,
 *   readonly kind: "multiple-choice",
 *   readonly choices: readonly Choice[],
 *   readonly correctChoiceIds: readonly [string, ...string[]],
 *   readonly explanation: string
 * } & QuestionMetadata} MultipleChoiceQuestion
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly prompt: string,
 *   readonly kind: "fill-blank",
 *   readonly blankId: string,
 *   readonly acceptedAnswers: readonly [string, ...string[]],
 *   readonly explanation: string
 * } & QuestionMetadata} FillBlankQuestion
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly prompt: string,
 *   readonly kind: "free-response",
 *   readonly expectedConcepts: readonly [string, ...string[]],
 *   readonly minimumWords: number,
 *   readonly explanation: string
 * } & QuestionMetadata} OpenResponseQuestion
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly prompt: string,
 *   readonly kind: "case-study",
 *   readonly stimulus: string,
 *   readonly childQuestionIds: readonly [string, ...string[]],
 *   readonly explanation: string
 * } & QuestionMetadata} CaseStudyQuestion
 */

/** @typedef {SingleChoiceQuestion | MultipleChoiceQuestion | FillBlankQuestion | OpenResponseQuestion | CaseStudyQuestion} Question */

/**
 * @typedef {{
 *   readonly kind: "choice",
 *   readonly selectedChoiceIds: readonly string[]
 * } | {
 *   readonly kind: "fill",
 *   readonly blankId: string,
 *   readonly text: string
 * } | {
 *   readonly kind: "text",
 *   readonly text: string
 * } | {
 *   readonly kind: "case-study",
 *   readonly childResponses: readonly {
 *     readonly questionId: string,
 *     readonly response: Exclude<QuestionResponse, { readonly kind: "case-study" }>
 *   }[]
 * }} QuestionResponse
 */

/**
 * @typedef {{
 *   readonly status: "correct" | "incorrect" | "review-required",
 *   readonly matchedConcepts: readonly string[],
 *   readonly explanation: string
 * }} Grade
 */

/**
 * @typedef {{ readonly kind: "QuestionInvalid", readonly field: string }
 * | { readonly kind: "QuestionKindUnsupported", readonly value: string }
 * | { readonly kind: "QuestionReferenceUnknown", readonly questionId: string }
 * | { readonly kind: "ResponseKindMismatch", readonly expected: "choice" | "fill" | "text" | "case-study" }
 * | { readonly kind: "ResponseInvalid", readonly field: string }
 * | { readonly kind: "ChoiceUnknown", readonly choiceId: string }} QuestionFailure
 */

export {};
