// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly contentId: string,
 *   readonly knowledgeUnitId: string,
 *   readonly prompt: string,
 *   readonly choices: readonly { readonly id: string, readonly label: string }[],
 *   readonly correctChoiceId: string,
 *   readonly status: "active" | "retired"
 * }} RecallPrompt
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly promptId: string,
 *   readonly selectedChoiceId: string,
 *   readonly idempotencyKey: string,
 *   readonly reviewedAt: string
 * }} RecallCommand
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly knowledgeUnitId: string,
 *   readonly dueAt: string,
 *   readonly stability: number,
 *   readonly difficulty: number,
 *   readonly scheduledDays: number,
 *   readonly schedulerState: string,
 *   readonly schedulerVersion: string,
 *   readonly reviewCount: number
 * }} MemoryState
 */

/**
 * @typedef {{
 *   readonly memory: MemoryState | null,
 *   readonly rating: "again" | "good",
 *   readonly reviewedAt: string
 * }} ScheduleRequest
 */

/**
 * @typedef {{
 *   readonly dueAt: string,
 *   readonly stability: number,
 *   readonly difficulty: number,
 *   readonly scheduledDays: number,
 *   readonly schedulerState: string,
 *   readonly schedulerVersion: string
 * }} ScheduleResult
 */

/**
 * @typedef {{
 *   schedule(request: ScheduleRequest): Result<ScheduleResult, RecallFailure>
 * }} RecallScheduler
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly promptId: string,
 *   readonly knowledgeUnitId: string,
 *   readonly selectedChoiceId: string,
 *   readonly correct: boolean,
 *   readonly rating: "again" | "good",
 *   readonly idempotencyKey: string,
 *   readonly reviewedAt: string,
 *   readonly provenance: "active-recall"
 * }} RecallEvent
 */

/**
 * @typedef {{
 *   readonly event: RecallEvent,
 *   readonly memory: MemoryState
 * }} RecallOutcome
 */

/**
 * @typedef {{ readonly kind: "RecallCommandInvalid", readonly field: string }
 * | { readonly kind: "RecallPromptUnknown", readonly promptId: string }
 * | { readonly kind: "RecallPromptRetired", readonly promptId: string }
 * | { readonly kind: "RecallAnswerInvalid", readonly choiceId: string }
 * | { readonly kind: "RecallAlreadyRecorded", readonly idempotencyKey: string }
 * | { readonly kind: "RecallSchedulerUnavailable", readonly schedulerVersion: string }
 * | { readonly kind: "RecallSchedulerRejected", readonly reason: string }} RecallFailure
 */

/**
 * @param {RecallCommand} command
 * @returns {Result<RecallCommand, RecallFailure>}
 */
export function validateRecallCommand(command) {
  if (command.ownerId.trim() === "") {
    return {
      ok: false,
      error: { kind: "RecallCommandInvalid", field: "ownerId" },
    };
  }
  if (command.promptId.trim() === "") {
    return {
      ok: false,
      error: { kind: "RecallCommandInvalid", field: "promptId" },
    };
  }
  if (command.selectedChoiceId.trim() === "") {
    return {
      ok: false,
      error: { kind: "RecallCommandInvalid", field: "selectedChoiceId" },
    };
  }
  if (command.idempotencyKey.trim() === "") {
    return {
      ok: false,
      error: { kind: "RecallCommandInvalid", field: "idempotencyKey" },
    };
  }
  if (!Number.isFinite(Date.parse(command.reviewedAt))) {
    return {
      ok: false,
      error: { kind: "RecallCommandInvalid", field: "reviewedAt" },
    };
  }
  return { ok: true, value: command };
}
