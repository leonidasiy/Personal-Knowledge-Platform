// @ts-check

/** @import { DailyLearningSettings, DailyRecallCohort, DailyResponseFact, DailyStudySet, RecallCandidateRef } from "../features/daily-learning/contracts.js" */
/** @import { DailyLearningRepository } from "../features/daily-learning/repository.js" */
/** @import { ExposureCommand } from "../features/exposure/contracts.js" */
/** @import { ExposureService } from "../features/exposure/service.js" */
/** @import { PreferenceCommand } from "../features/preference/contracts.js" */
/** @import { PreferenceService } from "../features/preference/service.js" */
/** @import { GeneratedPrompt, PromptGenerationEvent } from "../features/prompt-bank/contracts.js" */
/** @import { FixturePromptRuntime } from "../features/prompt-bank/fixture-runtime.js" */
/** @import { RecallCommand } from "../features/recall/contracts.js" */
/** @import { StudyCommand, StudyEvent } from "../features/study/contracts.js" */
/** @import { StudyRepository } from "../features/study/repository.js" */
/** @import { StudyService } from "../features/study/service.js" */
/** @import { IndexedDbPersistence } from "../persistence/indexeddb.js" */
/** @import { PersistenceEnvelope, PersistenceFailure, RecordKind } from "../persistence/contracts.js" */

/**
 * @typedef {{
 *   readonly dailySettings: DailyLearningSettings | null,
 *   readonly responseFacts: readonly DailyResponseFact[],
 *   readonly recallCommands: readonly RecallCommand[],
 *   readonly recallSourceRecords: ReadonlyMap<string, string>,
 *   readonly incompatibleRecallRecords: readonly IncompatibleRecallRecord[],
 *   readonly migratedRecallCount: number,
 *   readonly openResponses: ReadonlyMap<string, {
 *     readonly response: string,
 *     readonly explanation: string,
 *   }>,
 * }} RestoredLocalState
 */

/**
 * @typedef {{
 *   readonly recordId: string,
 *   readonly recordKind: "grade_finalization" | "review_event",
 *   readonly idempotencyKey: string,
 *   readonly reason: "LegacyRecallEvidenceMissing" | "RecallDuplicateConflict",
 * }} IncompatibleRecallRecord
 */

/**
 * @typedef {{
 *   readonly command: RecallCommand,
 *   readonly recordId: string,
 *   readonly recordKind: "grade_finalization" | "review_event",
 *   readonly migrated: boolean,
 * }} RecallEntry
 */

/**
 * @typedef {{
 *   ok: true,
 *   value: RestoredLocalState,
 * } | {
 *   ok: false,
 *   error: {
 *     readonly kind: "LocalStateReadFailed",
 *     readonly persistenceKind: PersistenceFailure["kind"],
 *   } | {
 *     readonly kind: "LocalStateCorrupt",
 *     readonly recordKind: RecordKind,
 *     readonly recordId: string,
 *   },
 * }} RestoreLocalStateResult
 */

const RESTORE_KINDS = /** @type {const} */ ([
  "daily_learning_settings",
  "daily_study_set",
  "manual_study",
  "prompt_generation",
  "daily_recall_cohort",
  "review_quarantine",
  "grade_finalization",
  "preference_event",
  "qualified_exposure",
  "review_event",
]);

/**
 * @param {{
 *   readonly ownerId: string,
 *   readonly persistence: IndexedDbPersistence,
 *   readonly dailyLearningRepository: DailyLearningRepository,
 *   readonly promptRuntime: FixturePromptRuntime,
 *   readonly preferenceService: PreferenceService,
 *   readonly exposureService: ExposureService,
 *   readonly studyRepository: StudyRepository,
 *   readonly studyService: StudyService,
 * }} dependencies
 * @returns {Promise<RestoreLocalStateResult>}
 */
export async function restoreLocalState(dependencies) {
  /** @type {DailyLearningSettings | null} */
  let dailySettings = null;
  /** @type {DailyResponseFact[]} */
  const responseFacts = [];
  /** @type {RecallEntry[]} */
  const recallEntries = [];
  /** @type {IncompatibleRecallRecord[]} */
  const incompatibleRecallRecords = [];
  const quarantinedRecallRecordIds = new Set();
  /** @type {Map<string, { readonly response: string, readonly explanation: string }>} */
  const openResponses = new Map();

  for (const kind of RESTORE_KINDS) {
    const listed = await dependencies.persistence.list(
      dependencies.ownerId,
      kind,
    );
    if (!listed.ok) {
      return {
        ok: false,
        error: {
          kind: "LocalStateReadFailed",
          persistenceKind: listed.error.kind,
        },
      };
    }
    const ordered = orderEnvelopes(kind, listed.value);
    for (const envelope of ordered) {
      const parsed = parsePayload(envelope);
      if (parsed === null) return corrupt(kind, envelope.id);

      if (kind === "review_quarantine") {
        if (!isReviewQuarantine(parsed)) return corrupt(kind, envelope.id);
        const event = parsed;
        if (
          !matchesEnvelope(
            envelope,
            event.ownerId,
            event.idempotencyKey,
            event.createdAt,
          )
        ) return corrupt(kind, envelope.id);
        for (const recordId of event.recordIds) {
          quarantinedRecallRecordIds.add(recordId);
        }
        continue;
      }

      if (kind === "daily_learning_settings") {
        if (!isDailySettings(parsed)) return corrupt(kind, envelope.id);
        const event = /** @type {DailyLearningSettings} */ (parsed);
        if (
          envelope.ownerId !== event.ownerId ||
          envelope.id !==
            `daily-settings:${event.ownerId}:${event.revision}` ||
          envelope.recordedAt !== event.updatedAt
        ) return corrupt(kind, envelope.id);
        const replayed = dependencies.dailyLearningRepository.recordSettings(
          event,
        );
        if (!replayed.ok) return corrupt(kind, envelope.id);
        dailySettings = replayed.value;
        continue;
      }

      if (kind === "daily_study_set") {
        if (!isDailyStudySet(parsed)) return corrupt(kind, envelope.id);
        const event = /** @type {DailyStudySet} */ (parsed);
        if (
          !matchesEnvelope(
            envelope,
            event.ownerId,
            event.idempotencyKey,
            event.createdAt,
          )
        ) return corrupt(kind, envelope.id);
        const replayed = dependencies.dailyLearningRepository.recordStudySet(
          event,
        );
        if (!replayed.ok) return corrupt(kind, envelope.id);
        continue;
      }

      if (kind === "prompt_generation") {
        if (!isPromptGenerationEvent(parsed)) return corrupt(kind, envelope.id);
        const event = /** @type {PromptGenerationEvent} */ (parsed);
        const studyFact = dependencies.studyRepository
          .list(event.ownerId, event.contentId)
          .find((/** @type {StudyEvent} */ fact) =>
            fact.contentVersion === event.contentVersion
          );
        if (
          studyFact === undefined ||
          Date.parse(studyFact.occurredAt) + 10 * 60_000 !==
            Date.parse(event.eligibleAt) ||
          Date.parse(event.generatedAt) < Date.parse(event.eligibleAt) ||
          !matchesEnvelope(
            envelope,
            event.ownerId,
            event.idempotencyKey,
            event.generatedAt,
          )
        ) return corrupt(kind, envelope.id);
        const replayed = dependencies.promptRuntime.restore(event);
        if (!replayed.ok) return corrupt(kind, envelope.id);
        continue;
      }

      if (kind === "daily_recall_cohort") {
        if (!isDailyRecallCohort(parsed)) return corrupt(kind, envelope.id);
        const event = /** @type {DailyRecallCohort} */ (parsed);
        const studySet = dependencies.dailyLearningRepository.getStudySet(
          event.ownerId,
          event.studySetId,
        );
        const generated = new Map(
          dependencies.promptRuntime.listPrompts(event.ownerId).map((
            /** @type {GeneratedPrompt} */ prompt,
          ) => [prompt.id, prompt]),
        );
        if (
          !matchesEnvelope(
            envelope,
            event.ownerId,
            event.idempotencyKey,
            event.createdAt,
          ) ||
          studySet === null ||
          studySet.learningDay !== event.learningDay ||
          studySet.recallLimit !== event.limit ||
          event.prompts.length > event.limit ||
          event.prompts.some((/** @type {RecallCandidateRef} */ prompt) => {
            const source = generated.get(prompt.promptId);
            return source === undefined ||
              source.version !== prompt.promptVersion ||
              source.contentId !== prompt.contentId ||
              source.eligibleAt !== prompt.eligibleAt ||
              Date.parse(prompt.eligibleAt) > Date.parse(event.createdAt) ||
              Date.parse(prompt.dueAt) > Date.parse(event.createdAt) ||
              !dependencies.studyRepository
                .list(event.ownerId, prompt.contentId)
                .some((/** @type {StudyEvent} */ fact) =>
                  fact.occurredAt === prompt.sourceStudiedAt &&
                  fact.contentVersion === source.contentVersion
                );
          })
        ) return corrupt(kind, envelope.id);
        const replayed = dependencies.dailyLearningRepository.recordCohort(
          event,
        );
        if (!replayed.ok) return corrupt(kind, envelope.id);
        continue;
      }

      if (kind === "grade_finalization") {
        if (!isGradeFinalization(parsed)) return corrupt(kind, envelope.id);
        const event =
          /** @type {{ readonly fact: DailyResponseFact, readonly status: "correct" | "incorrect" | "review-required", readonly response: string, readonly explanation: string, readonly recallCommand: RecallCommand | null }} */
          (parsed);
        const studySet = dependencies.dailyLearningRepository.getStudySet(
          event.fact.ownerId,
          event.fact.studySetId,
        );
        const cohort = dependencies.dailyLearningRepository.getCohort(
          event.fact.ownerId,
          event.fact.studySetId,
        );
        if (
          studySet === null || cohort === null ||
          cohort.id !== event.fact.cohortId ||
          !cohort.prompts.some((/** @type {RecallCandidateRef} */ prompt) =>
            prompt.promptId === event.fact.promptId &&
            prompt.promptVersion === event.fact.promptVersion
          ) ||
          envelope.ownerId !== event.fact.ownerId ||
          envelope.id !== `grade:${event.fact.id}` ||
          envelope.recordedAt !== event.fact.respondedAt ||
          !gradeEvidenceConsistent(event) ||
          (
            event.recallCommand !== null &&
            (
              event.recallCommand.ownerId !== event.fact.ownerId ||
              event.recallCommand.promptId !== event.fact.promptId ||
              event.recallCommand.reviewedAt !== event.fact.respondedAt
            )
          )
        ) return corrupt(kind, envelope.id);
        responseFacts.push(event.fact);
        if (event.recallCommand != null) {
          if (!quarantinedRecallRecordIds.has(envelope.id)) {
            const normalized = normalizeRecallCommand(
              event.recallCommand,
              event.fact.correct,
            );
            if (normalized.ok) {
              recallEntries.push({
                command: normalized.value,
                recordId: envelope.id,
                recordKind: "grade_finalization",
                migrated: normalized.migrated,
              });
            } else {
              incompatibleRecallRecords.push({
                recordId: envelope.id,
                recordKind: "grade_finalization",
                idempotencyKey: event.recallCommand.idempotencyKey,
                reason: normalized.error.kind,
              });
            }
          }
        }
        if (event.status === "review-required") {
          openResponses.set(event.fact.promptId, {
            response: event.response,
            explanation: event.explanation,
          });
        } else {
          openResponses.delete(event.fact.promptId);
        }
        continue;
      }

      if (kind === "preference_event") {
        if (!isPreferenceCommand(parsed)) return corrupt(kind, envelope.id);
        const event = /** @type {PreferenceCommand} */ (parsed);
        if (
          !matchesEnvelope(
            envelope,
            event.ownerId,
            event.idempotencyKey,
            event.occurredAt,
          ) ||
          !dependencies.preferenceService.record(event).ok
        ) return corrupt(kind, envelope.id);
        continue;
      }

      if (kind === "qualified_exposure") {
        if (!isExposureCommand(parsed)) return corrupt(kind, envelope.id);
        const event = /** @type {ExposureCommand} */ (parsed);
        if (
          !matchesEnvelope(
            envelope,
            event.ownerId,
            event.idempotencyKey,
            event.occurredAt,
          ) ||
          !dependencies.exposureService.record(event).ok
        ) return corrupt(kind, envelope.id);
        continue;
      }

      if (kind === "manual_study") {
        if (!isStudyCommand(parsed)) return corrupt(kind, envelope.id);
        const event = /** @type {StudyCommand} */ (parsed);
        if (
          !matchesEnvelope(
            envelope,
            event.ownerId,
            event.idempotencyKey,
            event.occurredAt,
          ) ||
          !dependencies.studyService.restore(event).ok
        ) return corrupt(kind, envelope.id);
        continue;
      }

      if (!isRecallCommand(parsed)) return corrupt(kind, envelope.id);
      const event = /** @type {RecallCommand} */ (parsed);
      if (
        !matchesEnvelope(
          envelope,
          event.ownerId,
          event.idempotencyKey,
          event.reviewedAt,
        )
      ) return corrupt(kind, envelope.id);
      if (quarantinedRecallRecordIds.has(envelope.id)) continue;
      const normalized = normalizeRecallCommand(event, null);
      if (normalized.ok) {
        recallEntries.push({
          command: normalized.value,
          recordId: envelope.id,
          recordKind: "review_event",
          migrated: normalized.migrated,
        });
      } else {
        incompatibleRecallRecords.push({
          recordId: envelope.id,
          recordKind: "review_event",
          idempotencyKey: event.idempotencyKey,
          reason: normalized.error.kind,
        });
      }
    }
  }

  const normalizedEntries = deduplicateRecallEntries(
    recallEntries,
    incompatibleRecallRecords,
  );
  const recallSourceRecords = new Map(
    normalizedEntries.map((entry) => [
      entry.command.idempotencyKey,
      entry.recordId,
    ]),
  );

  return {
    ok: true,
    value: Object.freeze({
      dailySettings,
      responseFacts: Object.freeze(responseFacts),
      recallCommands: Object.freeze(
        normalizedEntries.map((entry) => entry.command),
      ),
      recallSourceRecords,
      incompatibleRecallRecords: Object.freeze(incompatibleRecallRecords),
      migratedRecallCount: normalizedEntries.filter((entry) => entry.migrated)
        .length,
      openResponses,
    }),
  };
}

/**
 * @param {RecallCommand} command
 * @param {boolean | null} evidencedCorrectness
 * @returns {{ readonly ok: true, readonly value: RecallCommand, readonly migrated: boolean } | { readonly ok: false, readonly error: { readonly kind: "LegacyRecallEvidenceMissing" } }}
 */
function normalizeRecallCommand(command, evidencedCorrectness) {
  const correctChoiceId = `${command.promptId}-grade-correct`;
  const incorrectChoiceId = `${command.promptId}-grade-incorrect`;
  if (
    command.selectedChoiceId === correctChoiceId ||
    command.selectedChoiceId === incorrectChoiceId
  ) {
    return { ok: true, value: command, migrated: false };
  }
  if (typeof evidencedCorrectness !== "boolean") {
    return {
      ok: false,
      error: { kind: "LegacyRecallEvidenceMissing" },
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      ...command,
      selectedChoiceId: evidencedCorrectness
        ? correctChoiceId
        : incorrectChoiceId,
    }),
    migrated: true,
  };
}

/**
 * @param {readonly RecallEntry[]} entries
 * @param {IncompatibleRecallRecord[]} incompatible
 * @returns {readonly RecallEntry[]}
 */
function deduplicateRecallEntries(entries, incompatible) {
  /** @type {Map<string, RecallEntry[]>} */
  const grouped = new Map();
  for (const entry of entries) {
    const group = grouped.get(entry.command.idempotencyKey) ?? [];
    group.push(entry);
    grouped.set(entry.command.idempotencyKey, group);
  }
  /** @type {RecallEntry[]} */
  const unique = [];
  for (const group of grouped.values()) {
    const first = group[0];
    if (first === undefined) continue;
    if (
      group.every((entry) => sameRecallCommand(first.command, entry.command))
    ) {
      unique.push(first);
      continue;
    }
    for (const entry of group) {
      incompatible.push({
        recordId: entry.recordId,
        recordKind: entry.recordKind,
        idempotencyKey: entry.command.idempotencyKey,
        reason: "RecallDuplicateConflict",
      });
    }
  }
  return Object.freeze(
    unique.sort((left, right) =>
      Date.parse(left.command.reviewedAt) -
        Date.parse(right.command.reviewedAt) ||
      left.recordId.localeCompare(right.recordId)
    ),
  );
}

/** @param {RecallCommand} left @param {RecallCommand} right */
function sameRecallCommand(left, right) {
  return left.ownerId === right.ownerId &&
    left.promptId === right.promptId &&
    left.selectedChoiceId === right.selectedChoiceId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.reviewedAt === right.reviewedAt;
}

/**
 * @param {{ readonly fact: DailyResponseFact, readonly status: "correct" | "incorrect" | "review-required", readonly response: string, readonly explanation: string, readonly recallCommand: RecallCommand | null }} event
 */
function gradeEvidenceConsistent(event) {
  if (event.status === "review-required") {
    return !event.fact.finalized && event.fact.correct === null &&
      event.recallCommand === null;
  }
  return event.fact.finalized &&
    event.fact.correct === (event.status === "correct") &&
    event.recallCommand !== null;
}

/**
 * @param {unknown} value
 * @returns {value is { readonly ownerId: string, readonly recordIds: readonly string[], readonly idempotencyKey: string, readonly createdAt: string, readonly version: 1 }}
 */
function isReviewQuarantine(value) {
  return hasFields(value, [
    "ownerId",
    "idempotencyKey",
    "createdAt",
  ], ["version"]) && value.version === 1 &&
    Number.isFinite(Date.parse(String(value.createdAt))) &&
    Array.isArray(value.recordIds) && value.recordIds.length > 0 &&
    value.recordIds.every((recordId) =>
      typeof recordId === "string" && recordId.trim() !== ""
    ) && new Set(value.recordIds).size === value.recordIds.length;
}

/** @param {RecordKind} kind @param {string} id @returns {RestoreLocalStateResult} */
function corrupt(kind, id) {
  return {
    ok: false,
    error: { kind: "LocalStateCorrupt", recordKind: kind, recordId: id },
  };
}

/** @param {PersistenceEnvelope} envelope @returns {unknown | null} */
function parsePayload(envelope) {
  try {
    return /** @type {unknown} */ (JSON.parse(envelope.payloadJson));
  } catch {
    return null;
  }
}

/**
 * @param {RecordKind} kind
 * @param {readonly PersistenceEnvelope[]} envelopes
 */
function orderEnvelopes(kind, envelopes) {
  return [...envelopes].sort((left, right) => {
    if (kind === "grade_finalization") {
      const leftSequence = gradeSequence(left);
      const rightSequence = gradeSequence(right);
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
    }
    return Date.parse(left.recordedAt) - Date.parse(right.recordedAt) ||
      left.id.localeCompare(right.id);
  });
}

/** @param {PersistenceEnvelope} envelope */
function gradeSequence(envelope) {
  const parsed = parsePayload(envelope);
  return isRecord(parsed) && isRecord(parsed.fact) &&
      typeof parsed.fact.responseSequence === "number"
    ? parsed.fact.responseSequence
    : Number.MAX_SAFE_INTEGER;
}

/** @param {unknown} value @returns {value is DailyLearningSettings} */
function isDailySettings(value) {
  return hasFields(
    value,
    ["ownerId", "timeZone", "updatedAt"],
    ["dailyStudyTarget", "dailyRecallLimit", "revision"],
  ) &&
    integerBetween(value.dailyStudyTarget, 1, 50) &&
    Number.isSafeInteger(value.dailyRecallLimit) && Number(value.dailyRecallLimit) >= 0 &&
    positiveInteger(value.revision) &&
    Number.isFinite(Date.parse(String(value.updatedAt)));
}

/** @param {unknown} value @returns {value is DailyStudySet} */
function isDailyStudySet(value) {
  return hasFields(
    value,
    [
      "id",
      "ownerId",
      "learningDay",
      "selectorVersion",
      "idempotencyKey",
      "createdAt",
    ],
    ["ordinal", "studyTarget", "recallLimit", "settingsRevision"],
  ) &&
    Array.isArray(value.items) &&
    value.items.every((item) =>
      hasFields(item, ["contentId"], ["contentVersion"]) &&
      String(item.contentId).trim() !== "" &&
      positiveInteger(item.contentVersion) &&
      Array.isArray(item.promptIds) &&
      item.promptIds.every((id) => typeof id === "string" && id.trim() !== "")
    ) &&
    new Set(value.items.map((item) => isRecord(item) ? item.contentId : null))
        .size === value.items.length &&
    positiveInteger(value.ordinal) &&
    positiveInteger(value.studyTarget) &&
    value.items.length === value.studyTarget &&
    Number.isSafeInteger(value.recallLimit) && Number(value.recallLimit) >= 0 &&
    Number.isFinite(Date.parse(String(value.createdAt)));
}

/** @param {unknown} value @returns {value is DailyRecallCohort} */
function isDailyRecallCohort(value) {
  return hasFields(
    value,
    [
      "id",
      "ownerId",
      "learningDay",
      "studySetId",
      "selectorVersion",
      "idempotencyKey",
      "createdAt",
    ],
    ["limit", "revision"],
  ) &&
    Array.isArray(value.prompts) &&
    value.prompts.every(isRecallCandidateRef) &&
    new Set(
        value.prompts.map((prompt) =>
          isRecord(prompt) ? prompt.promptId : null
        ),
      ).size === value.prompts.length &&
    Number.isSafeInteger(value.limit) && Number(value.limit) >= 0 &&
    positiveInteger(value.revision) &&
    Number.isFinite(Date.parse(String(value.createdAt)));
}

/** @param {unknown} value @returns {value is PromptGenerationEvent} */
function isPromptGenerationEvent(value) {
  return hasFields(
    value,
    [
      "id",
      "ownerId",
      "contentId",
      "idempotencyKey",
      "generatedAt",
      "eligibleAt",
      "evidenceVersion",
      "policyVersion",
      "generatorVersion",
    ],
    ["contentVersion", "generationSequence"],
  ) &&
    (value.band === "short" || value.band === "medium" ||
      value.band === "long") &&
    Array.isArray(value.prompts) &&
    validPromptCount(value.band, value.prompts.length) &&
    new Set(
        value.prompts.map((prompt) => isRecord(prompt) ? prompt.id : null),
      ).size === value.prompts.length &&
    value.prompts.every((prompt) =>
      isRecord(prompt) &&
      typeof prompt.id === "string" &&
      prompt.id.trim() !== "" &&
      typeof prompt.ownerId === "string" &&
      prompt.ownerId === value.ownerId &&
      typeof prompt.contentId === "string" &&
      prompt.contentId === value.contentId &&
      prompt.contentVersion === value.contentVersion &&
      typeof prompt.version === "number" &&
      Number.isInteger(prompt.version) &&
      prompt.version > 0 &&
      prompt.kind !== undefined &&
      [
        "single-choice",
        "multiple-choice",
        "fill-blank",
        "free-response",
        "case-study",
      ].includes(String(prompt.kind)) &&
      typeof prompt.prompt === "string" &&
      prompt.prompt.trim() !== "" &&
      Array.isArray(prompt.knowledgeAnchorIds) &&
      prompt.knowledgeAnchorIds.length > 0 &&
      prompt.knowledgeAnchorIds.every((id) =>
        typeof id === "string" && id.trim() !== ""
      ) &&
      prompt.generatedAt === value.generatedAt &&
      prompt.eligibleAt === value.eligibleAt &&
      prompt.generatorVersion === value.generatorVersion &&
      prompt.policyVersion === value.policyVersion &&
      prompt.provenance === "fixture-generator"
    ) &&
    positiveInteger(value.contentVersion) &&
    positiveInteger(value.generationSequence) &&
    Number.isFinite(Date.parse(String(value.generatedAt))) &&
    Number.isFinite(Date.parse(String(value.eligibleAt))) &&
    Date.parse(String(value.generatedAt)) >=
      Date.parse(String(value.eligibleAt));
}

/**
 * @param {unknown} value
 * @returns {value is { readonly fact: DailyResponseFact, readonly status: "correct" | "incorrect" | "review-required", readonly response: string, readonly explanation: string, readonly recallCommand: RecallCommand | null }}
 */
function isGradeFinalization(value) {
  if (
    !isRecord(value) || !isRecord(value.fact) ||
    !["correct", "incorrect", "review-required"].includes(
      typeof value.status === "string" ? value.status : "",
    ) ||
    typeof value.response !== "string" ||
    typeof value.explanation !== "string" ||
    !(
      value.recallCommand === null ||
      value.recallCommand === undefined ||
      isRecallCommand(value.recallCommand)
    )
  ) return false;
  const fact = value.fact;
  return hasFields(
    fact,
    [
      "id",
      "ownerId",
      "learningDay",
      "studySetId",
      "cohortId",
      "promptId",
      "respondedAt",
    ],
    ["promptVersion", "responseSequence"],
  ) &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(fact.learningDay)) &&
    fact.context === "daily" &&
    typeof fact.finalized === "boolean" &&
    (typeof fact.correct === "boolean" || fact.correct === null) &&
    positiveInteger(fact.promptVersion) &&
    positiveInteger(fact.responseSequence) &&
    Number.isFinite(Date.parse(String(fact.respondedAt)));
}

/** @param {unknown} value @returns {value is PreferenceCommand} */
function isPreferenceCommand(value) {
  return hasFields(value, [
    "ownerId",
    "relationshipScopeId",
    "idempotencyKey",
    "occurredAt",
  ]) &&
    (value.choice === "more" || value.choice === "less");
}

/** @param {unknown} value @returns {value is ExposureCommand} */
function isExposureCommand(value) {
  return hasFields(
    value,
    ["ownerId", "candidateId", "idempotencyKey", "occurredAt"],
    ["contentVersion", "engagedMs"],
  );
}

/** @param {unknown} value @returns {value is StudyCommand} */
function isStudyCommand(value) {
  return hasFields(
    value,
    ["ownerId", "candidateId", "idempotencyKey", "occurredAt"],
    ["contentVersion"],
  ) &&
    !("engagedMs" in value);
}

/** @param {unknown} value @returns {value is RecallCommand} */
function isRecallCommand(value) {
  return hasFields(value, [
    "ownerId",
    "promptId",
    "selectedChoiceId",
    "idempotencyKey",
    "reviewedAt",
  ]);
}

/** @param {unknown} value */
function isRecallCandidateRef(value) {
  return hasFields(
    value,
    [
      "promptId",
      "contentId",
      "eligibleAt",
      "dueAt",
      "sourceStudiedAt",
    ],
    ["promptVersion", "generationSequence"],
  ) &&
    positiveInteger(value.promptVersion) &&
    positiveInteger(value.generationSequence) &&
    Number.isFinite(Date.parse(String(value.eligibleAt))) &&
    Number.isFinite(Date.parse(String(value.dueAt))) &&
    Number.isFinite(Date.parse(String(value.sourceStudiedAt)));
}

/**
 * @param {unknown} value
 * @param {readonly string[]} textFields
 * @param {readonly string[]} [numberFields]
 * @returns {value is Record<string, unknown>}
 */
function hasFields(value, textFields, numberFields = []) {
  return isRecord(value) &&
    textFields.every((field) =>
      typeof value[field] === "string" &&
      String(value[field]).trim() !== ""
    ) &&
    numberFields.every((field) => typeof value[field] === "number");
}

/** @param {unknown} band @param {number} count */
function validPromptCount(band, count) {
  return band === "short"
    ? count === 1
    : band === "medium"
    ? count >= 1 && count <= 3
    : band === "long" && count >= 2 && count <= 6;
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @param {unknown} value @param {number} minimum @param {number} maximum */
function integerBetween(value, minimum, maximum) {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= minimum && value <= maximum;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {PersistenceEnvelope} envelope
 * @param {string} ownerId
 * @param {string} idempotencyKey
 * @param {string} occurredAt
 */
function matchesEnvelope(envelope, ownerId, idempotencyKey, occurredAt) {
  return envelope.ownerId === ownerId &&
    envelope.id === idempotencyKey &&
    envelope.recordedAt === occurredAt;
}
