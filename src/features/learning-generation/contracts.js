// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {"public-text" | "manual-transcript"} LearningSourceKind */

/**
 * @typedef {{
 *   readonly version: string,
 *   readonly maximumContentCharacters: number,
 *   readonly maximumWordsPerUnit: number,
 *   readonly maximumUnits: number,
 *   readonly maximumExcerptCharacters: number
 * }} LearningUnitizationPolicy
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly itemVersionId: string,
 *   readonly contentDigest: string,
 *   readonly sourceKind: LearningSourceKind,
 *   readonly content: string,
 *   readonly policy: LearningUnitizationPolicy
 * }} LearningUnitizationCommand
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly itemVersionId: string,
 *   readonly contentDigest: string,
 *   readonly ordinal: number,
 *   readonly text: string,
 *   readonly startOffset: number,
 *   readonly endOffset: number,
 *   readonly wordCount: number,
 *   readonly sourceAnchorIds: readonly [string],
 *   readonly provenance: "deterministic-unitization",
 *   readonly policyVersion: string
 * }} LearningUnit
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly itemVersionId: string,
 *   readonly contentDigest: string,
 *   readonly policyVersion: string,
 *   readonly units: readonly LearningUnit[]
 * }} LearningUnitizationResult
 */

/**
 * @typedef {{ readonly kind: "LearningUnitizationCommandInvalid", readonly field: string }
 * | { readonly kind: "LearningUnitizationPolicyInvalid", readonly field: string }
 * | { readonly kind: "LearningContentEmpty" }
 * | { readonly kind: "LearningContentEncodingInvalid" }
 * | { readonly kind: "LearningUnitizationLimitExceeded", readonly field: "content" | "units" | "words" | "excerpt", readonly maximum: number, readonly actual: number }
 * | { readonly kind: "LearningUnitAnchorInvalid", readonly unitId: string }} LearningUnitizationFailure
 */

/** @typedef {"single-choice" | "multiple-choice" | "fill-blank" | "short-response" | "case-study" | "symbolic-midi" | "notation"} LearningTaskKind */

/** @typedef {{ readonly id: string, readonly label: string }} LearningChoice */

/**
 * @typedef {{
 *   readonly representation: "midi" | "notation",
 *   readonly ticksPerBeat: number,
 *   readonly events: readonly { readonly pitch: number, readonly startTick: number, readonly durationTicks: number, readonly velocity: number }[],
 *   readonly clef: string | null,
 *   readonly timeSignature: string | null
 * }} LearningSymbolicStimulus
 */

/**
 * Untrusted provider output. Task-specific fields are checked by validation;
 * the provider is never treated as an authority for identity or provenance.
 * @typedef {{
 *   readonly id: unknown,
 *   readonly kind: unknown,
 *   readonly prompt: unknown,
 *   readonly explanation: unknown,
 *   readonly unitIds: unknown,
 *   readonly sourceAnchorIds: unknown,
 *   readonly choices?: unknown,
 *   readonly correctChoiceIds?: unknown,
 *   readonly blankId?: unknown,
 *   readonly acceptedAnswers?: unknown,
 *   readonly expectedConcepts?: unknown,
 *   readonly minimumWords?: unknown,
 *   readonly stimulus?: unknown,
 *   readonly responseKind?: unknown
 * }} LearningDraft
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly itemVersionId: string,
 *   readonly contentDigest: string,
 *   readonly generatorVersion: string,
 *   readonly policyVersion: string,
 *   readonly samplingVersion: string,
 *   readonly factualSamplingRatePercent: number,
 *   readonly generatedAt: string,
 *   readonly units: readonly { readonly id: string, readonly sourceAnchorIds: readonly string[], readonly text: string }[]
 * }} LearningValidationContext
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly itemVersionId: string,
 *   readonly contentDigest: string,
 *   readonly version: number,
 *   readonly kind: LearningTaskKind,
 *   readonly prompt: string,
 *   readonly explanation: string,
 *   readonly unitIds: readonly [string, ...string[]],
 *   readonly sourceAnchorIds: readonly [string, ...string[]],
 *   readonly choices: readonly LearningChoice[] | null,
 *   readonly correctChoiceIds: readonly [string, ...string[]] | null,
 *   readonly blankId: string | null,
 *   readonly acceptedAnswers: readonly [string, ...string[]] | null,
 *   readonly blanks?: readonly { readonly id: string, readonly acceptedAnswers: readonly [string, ...string[]] }[] | null,
 *   readonly expectedConcepts: readonly [string, ...string[]] | null,
 *   readonly minimumWords: number | null,
 *   readonly stimulus: LearningSymbolicStimulus | string | null,
 *   readonly responseKind: "text" | null,
 *   readonly generatorVersion: string,
 *   readonly policyVersion: string,
 *   readonly provenance: "provider-draft",
 *   readonly reviewRequired: boolean,
 *   readonly status: "pending-review" | "published" | "rejected" | "hidden",
 *   readonly reviewDecision: "approved" | "rejected" | null,
 *   readonly reviewedAt: string | null,
 *   readonly revision: number,
 *   readonly generatedAt: string
 * }} LearningTask
 */

/**
 * @typedef {{ readonly kind: "LearningGenerationContextInvalid", readonly field: string }
 * | { readonly kind: "LearningSamplingPolicyInvalid", readonly field: string }
 * | { readonly kind: "LearningDraftSchemaInvalid", readonly field: string }
 * | { readonly kind: "LearningDraftUngrounded", readonly field: string }
 * | { readonly kind: "LearningAnswerInvalid", readonly field: string }
 * | { readonly kind: "LearningTaskKindUnsupported", readonly value: string }
 * | { readonly kind: "LearningSymbolicStimulusInvalid", readonly field: string }} LearningValidationFailure
 */

/**
 * @typedef {{
 *   readonly sourceKind: "public-text" | "manual-transcript",
 *   readonly excerpt: string,
 *   readonly unitIds: readonly [string, ...string[]],
 *   readonly sourceAnchorIds: readonly [string, ...string[]],
 *   readonly instruction: string,
 *   readonly maximumOutputTokens: number
 * }} LearningProviderCommand
 */

/** @typedef {{ readonly inputTokens: number, readonly outputTokens: number }} LearningProviderUsage */

/**
 * @typedef {{
 *   readonly drafts: readonly unknown[],
 *   readonly usage: LearningProviderUsage,
 *   readonly requestId: string
 * }} LearningProviderResult
 */

/**
 * @typedef {{ readonly kind: "LearningProviderConfigurationInvalid", readonly field: string }
 * | { readonly kind: "LearningProviderCredentialMissing" }
 * | { readonly kind: "LearningManualExternalProcessingProhibited" }
 * | { readonly kind: "LearningProviderInputInvalid", readonly field: string }
 * | { readonly kind: "LearningProviderTimeout" }
 * | { readonly kind: "LearningProviderUnavailable" }
 * | { readonly kind: "LearningProviderRejected", readonly status: number }
 * | { readonly kind: "LearningProviderRateLimited" }
 * | { readonly kind: "LearningProviderResponseInvalid", readonly field: string }} LearningProviderFailure
 */

/** @typedef {(entry: { readonly event: string, readonly failureKind?: string, readonly durationMs?: number, readonly itemCount?: number }) => void} LearningLogger */

/** @typedef {{ readonly label: string, readonly sourceUrl: string }} LearningAttribution */

/**
 * @typedef {{
 *   readonly kind: "public",
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly evidenceId: string,
 *   readonly status: "active" | "revoked",
 *   readonly storageAllowed: boolean,
 *   readonly displayAllowed: boolean,
 *   readonly transformationAllowed: boolean,
 *   readonly assessedAt: string,
 *   readonly expiresAt: string | null,
 *   readonly attribution: LearningAttribution
 * } | {
 *   readonly kind: "manual",
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly evidenceId: string,
 *   readonly status: "active" | "revoked",
 *   readonly storageAllowed: boolean,
 *   readonly transformationAllowed: boolean,
 *   readonly attestationReference: string,
 *   readonly attestationBasis: string,
 *   readonly assessedAt: string,
 *   readonly expiresAt: string | null
 * }} LearningRightsGrant
 */

/**
 * @typedef {{
 *   readonly version: string,
 *   readonly unitization: LearningUnitizationPolicy,
 *   readonly maximumProviderInputCharacters: number,
 *   readonly maximumProviderUnits: number,
 *   readonly maximumTasks: number,
 *   readonly maximumOutputTokens: number,
 *   readonly factualSamplingRatePercent: number,
 *   readonly samplingVersion: string,
 *   readonly providerInstruction: string,
 *   readonly monthlyBudgetUsd: number
 * }} LearningGenerationPolicy
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly itemVersionId: string,
 *   readonly contentDigest: string,
 *   readonly sourceKind: "public-text" | "manual-transcript",
 *   readonly content: string,
 *   readonly rights: LearningRightsGrant,
 *   readonly idempotencyKey: string,
 *   readonly policy: LearningGenerationPolicy
 * }} LearningGenerationCommand
 */

/**
 * @typedef {{
 *   readonly reservationId: string,
 *   readonly ownerId: string,
 *   readonly month: string,
 *   readonly amountUsd: number
 * }} LearningBudgetReservation
 */

/** @typedef {{ readonly inputCharacters: number, readonly maximumOutputTokens: number }} LearningCostEstimateInput */

/** @typedef {{ estimate(input: LearningCostEstimateInput): number, actual(usage: LearningProviderUsage): number }} LearningCostModel */

/** @typedef {{ readonly kind: "LearningBudgetExceeded" } | { readonly kind: "LearningBudgetReservationUnavailable" } | { readonly kind: "LearningBudgetReconciliationUnavailable" }} LearningBudgetFailure */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly taskId: string,
 *   readonly expectedRevision: number,
 *   readonly decision: "approve" | "reject",
 *   readonly reviewedAt: string,
 *   readonly idempotencyKey: string
 * }} LearningReviewCommand
 */

/** @typedef {{ readonly kind: "LearningReviewCommandInvalid", readonly field: string } | { readonly kind: "LearningReviewTaskUnknown", readonly taskId: string } | { readonly kind: "LearningReviewAlreadyDecided", readonly taskId: string } | { readonly kind: "LearningReviewRevisionStale", readonly expected: number, readonly actual: number } | { readonly kind: "LearningReviewIdempotencyConflict", readonly idempotencyKey: string } | { readonly kind: "LearningReviewPersistenceFailed" }} LearningReviewFailure */

/** @typedef {"queued" | "generating" | "ready-for-review" | "reviewed" | "failed" | "unavailable"} LearningReviewQueueStatus */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly sourceId: string,
 *   readonly kind: LearningTaskKind,
 *   readonly prompt: string,
 *   readonly explanation: string,
 *   readonly sourceAnchorIds: readonly [string, ...string[]],
 *   readonly choices: readonly LearningChoice[] | null,
 *   readonly correctChoiceIds: readonly [string, ...string[]] | null,
 *   readonly expectedConcepts: readonly [string, ...string[]] | null,
 *   readonly minimumWords: number | null,
 *   readonly stimulus: LearningSymbolicStimulus | string | null,
 *   readonly responseKind: "text" | null,
 *   readonly status: "pending-review",
 *   readonly revision: number
 * }} LearningReviewQueueTask
 */

/**
 * @typedef {{
 *   readonly sourceId: string,
 *   readonly title: string,
 *   readonly status: LearningReviewQueueStatus,
 *   readonly generationId: string | null,
 *   readonly pendingTaskCount: number,
 *   readonly reviewedTaskCount: number,
 *   readonly failureKind: string | null
 * }} LearningReviewQueueSource
 */

/** @typedef {{ readonly sources: readonly LearningReviewQueueSource[], readonly tasks: readonly LearningReviewQueueTask[] }} LearningReviewQueue */

/** @typedef {{ readonly kind: "LearningReviewQueueCommandInvalid", readonly field: string } | { readonly kind: "LearningReviewQueuePersistenceFailed" }} LearningReviewQueueFailure */

/**
 * @typedef {{
 *   readonly findTask: (ownerId: string, taskId: string) => Promise<Result<LearningTask | null, LearningReviewFailure>>,
 *   readonly applyDecision: (command: LearningReviewCommand) => Promise<Result<LearningTask, LearningReviewFailure>>,
 *   readonly listVisible: (ownerId: string) => Promise<Result<readonly LearningTask[], LearningReviewFailure>>
 * }} LearningReviewRepositoryPort
 */

/** @typedef {{ readonly listQueue: (ownerId: string) => Promise<Result<LearningReviewQueue, LearningReviewQueueFailure>> }} LearningReviewQueueRepositoryPort */

/** @typedef {{ readonly step: number, readonly dueAt: string, readonly fsrsState: string | null }} LearningScheduleMemory */

/** @typedef {{ readonly taskId: string, readonly previous: LearningScheduleMemory | null, readonly correct: boolean, readonly reviewedAt: string }} LearningScheduleRequest */

/** @typedef {{ readonly taskId: string, readonly step: number, readonly dueAt: string, readonly mode: "validation" | "fsrs", readonly corrective: boolean, readonly fsrsState: string | null }} LearningScheduleResult */

/** @typedef {{ readonly schedule: (input: { readonly taskId: string, readonly fsrsState: string | null, readonly rating: "good", readonly reviewedAt: string }) => Result<{ readonly dueAt: string, readonly schedulerState: string }, LearningScheduleFailure> }} LearningFsrsPort */

/** @typedef {{ readonly kind: "LearningScheduleCommandInvalid", readonly field: string } | { readonly kind: "LearningScheduleStepInvalid", readonly step: number } | { readonly kind: "LearningScheduleTooEarly", readonly dueAt: string } | { readonly kind: "LearningScheduleFsrsUnavailable" } | { readonly kind: "LearningScheduleFsrsRejected", readonly reason: string } | { readonly kind: "LearningScheduleFsrsResponseInvalid" }} LearningScheduleFailure */

/**
 * @typedef {{
 *   readonly reserve: (command: { readonly ownerId: string, readonly idempotencyKey: string, readonly month: string, readonly amountUsd: number, readonly capUsd: number }) => Promise<Result<LearningBudgetReservation, LearningBudgetFailure>>,
 *   readonly reconcile: (command: { readonly reservation: LearningBudgetReservation, readonly actualUsd: number | null, readonly outcome: "completed" | "failed" | "uncertain" }) => Promise<Result<true, LearningBudgetFailure>>
 * }} LearningBudgetPort
 */

/** @typedef {LearningUnitizationFailure | LearningValidationFailure | LearningProviderFailure | LearningBudgetFailure | { readonly kind: "LearningRightsMissing" } | { readonly kind: "LearningRightsRevoked" } | { readonly kind: "LearningRightsExpired", readonly expiresAt: string } | { readonly kind: "LearningOwnerMismatch" } | { readonly kind: "LearningSourceMismatch" } | { readonly kind: "LearningSourceRevisionStale", readonly expected: number, readonly actual: number } | { readonly kind: "LearningAttributionInvalid", readonly field: string } | { readonly kind: "LearningGenerationPolicyInvalid", readonly field: string } | { readonly kind: "LearningGenerationCommandInvalid", readonly field: string } | { readonly kind: "LearningProviderInputLimitExceeded", readonly maximum: number, readonly actual: number } | { readonly kind: "LearningBudgetEstimateInvalid" } | { readonly kind: "LearningBudgetReservationFailed" } | { readonly kind: "LearningBudgetReconciliationFailed" } | { readonly kind: "LearningGenerationPersistenceFailed" } | { readonly kind: "LearningGenerationIdempotencyConflict", readonly idempotencyKey: string } | { readonly kind: "LearningFreshRightsRequired", readonly sourceId: string, readonly sourceRevision: number }} LearningGenerationFailure */

/**
 * @typedef {{ readonly id: string, readonly fingerprint: string, readonly record: LearningGenerationRecord }} LearningGenerationReplay
 */

/** @typedef {{ readonly id: string, readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly itemId: string, readonly itemVersionId: string, readonly status: "completed" | "failed" | "revoked", readonly localOnly: boolean, readonly policyVersion: string, readonly providerRequestId: string | null, readonly failureKind: string | null, readonly taskCounts: Readonly<{ readonly published: number, readonly pendingReview: number, readonly rejected: number, readonly hidden: number }>, readonly createdAt: string }} LearningGenerationStatus */

/** @typedef {{ readonly kind: "LearningGenerationStatusCommandInvalid", readonly field: string } | { readonly kind: "LearningGenerationStatusNotFound", readonly generationId: string } | { readonly kind: "LearningGenerationStatusPersistenceFailed" }} LearningGenerationStatusFailure */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly itemVersionId: string,
 *   readonly contentDigest: string,
 *   readonly sourceKind: "public-text" | "manual-transcript",
 *   readonly rightsEvidenceId: string,
 *   readonly attribution: LearningAttribution | null,
 *   readonly policyVersion: string,
 *   readonly units: readonly LearningUnit[],
 *   readonly tasks: readonly LearningTask[],
 *   readonly status: "completed" | "failed" | "revoked",
 *   readonly localOnly: boolean,
 *   readonly providerRequestId: string | null,
 *   readonly failureKind: string | null,
 *   readonly idempotencyKey: string,
 *   readonly createdAt: string
 * }} LearningGenerationRecord
 */

/**
 * @typedef {{
 *   readonly replay: (ownerId: string, idempotencyKey: string) => Promise<Result<LearningGenerationReplay | null, LearningGenerationFailure>>,
 *   readonly persist: (record: LearningGenerationRecord, fingerprint: string) => Promise<Result<LearningGenerationRecord, LearningGenerationFailure>>,
 *   readonly assertGenerationAllowed: (ownerId: string, sourceId: string, sourceRevision: number) => Promise<Result<true, LearningGenerationFailure>>
 * }} LearningGenerationRepositoryPort
 */

/** @typedef {{ readonly getStatus: (ownerId: string, generationId: string) => Promise<Result<LearningGenerationStatus | null, LearningGenerationStatusFailure>> }} LearningGenerationStatusRepositoryPort */

/**
 * A tombstone deliberately carries identity and version metadata only. It
 * must not contain source text, prompts, answers, explanations, or content
 * digests.
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly itemVersionId: string,
 *   readonly descendantKind: "generation" | "unit" | "task",
 *   readonly descendantId: string,
 *   readonly reason: string,
 *   readonly revokedAt: string
 * }} LearningRevocationTombstone
 */

/** @typedef {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly idempotencyKey: string, readonly reason: string, readonly revokedAt: string }} LearningRevocationCommand */

/** @typedef {{ readonly changedGenerations: number, readonly changedUnits: number, readonly changedTasks: number, readonly tombstones: readonly LearningRevocationTombstone[], readonly reused: boolean }} LearningRevocationResult */

/** @typedef {{ readonly kind: "LearningRevocationCommandInvalid", readonly field: string } | { readonly kind: "LearningRevocationConflict", readonly idempotencyKey: string } | { readonly kind: "LearningFreshRightsRequired", readonly sourceId: string, readonly sourceRevision: number } | { readonly kind: "LearningRevocationPersistenceFailed" }} LearningRevocationFailure */

/** @typedef {{ readonly ownerId: string, readonly taskId: string, readonly kind: "review-decision" | "study-response" | "schedule", readonly occurredAt: string, readonly correct: boolean | null, readonly scheduleStep: number | null }} LearningNonContentFact */

/** @typedef {{ readonly ownerId: string, readonly taskId: string, readonly decision: "approve" | "reject", readonly expectedRevision: number, readonly resultingRevision: number, readonly idempotencyKey: string, readonly occurredAt: string }} LearningReviewAudit */

/**
 * @typedef {{
 *   readonly revoke: (command: LearningRevocationCommand, fingerprint: string) => Promise<Result<LearningRevocationResult, LearningRevocationFailure>>,
 *   readonly listTombstones: (ownerId: string) => Promise<Result<readonly LearningRevocationTombstone[], LearningRevocationFailure>>,
 *   readonly recordFact: (fact: LearningNonContentFact) => Promise<Result<LearningNonContentFact, LearningRevocationFailure>>,
 *   readonly listFacts: (ownerId: string) => Promise<Result<readonly LearningNonContentFact[], LearningRevocationFailure>>,
 *   readonly listReviewAudits: (ownerId: string) => Promise<Result<readonly LearningReviewAudit[], LearningRevocationFailure>>
 * }} LearningRevocationRepositoryPort
 */

/**
 * Mutable construction shape used only while a validated task is assembled.
 * @typedef {{
 *   id: string,
 *   ownerId: string,
 *   sourceId: string,
 *   sourceRevision: number,
 *   itemId: string,
 *   itemVersionId: string,
 *   contentDigest: string,
 *   version: 1,
 *   kind: LearningTaskKind,
 *   prompt: string,
 *   explanation: string,
 *   unitIds: readonly [string, ...string[]],
 *   sourceAnchorIds: readonly [string, ...string[]],
 *   choices: readonly LearningChoice[] | null,
 *   correctChoiceIds: readonly [string, ...string[]] | null,
 *   blankId: string | null,
 *   acceptedAnswers: readonly [string, ...string[]] | null,
 *   expectedConcepts: readonly [string, ...string[]] | null,
 *   minimumWords: number | null,
 *   stimulus: LearningSymbolicStimulus | string | null,
 *   responseKind: "text" | null,
 *   generatorVersion: string,
 *   policyVersion: string,
 *   provenance: "provider-draft",
 *   reviewRequired: boolean,
 *   status: "pending-review" | "published" | "rejected" | "hidden",
 *   reviewDecision: "approved" | "rejected" | null,
 *   reviewedAt: string | null,
 *   revision: number,
 *   generatedAt: string
 * }} LearningTaskAssembly
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
export function isNonEmptyText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value @returns {value is string} */
export function isIsoDateTime(value) {
  return isNonEmptyText(value) && Number.isFinite(Date.parse(value));
}

/** @param {unknown} value @returns {value is number} */
export function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export {};
