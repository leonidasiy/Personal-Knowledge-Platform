// @ts-check

const freeze = Object.freeze;

import { isRecord, validateSettingsCommand } from "./contracts.js";

/** @import { DailyLearningFailure, DailyLearningSettings, DailyRecallCohort, DailyResponseFact, DailyStudyProgress, DailyStudySelector, DailyStudySet, RecallAccuracy, RecallCandidateRef, Result, StudyCandidateRef } from "./contracts.js" */
/** @import { DailyLearningRepository } from "./repository.js" */
/** @import { RecallPrompt } from "../recall/contracts.js" */
/** @import { RecallRepository } from "../recall/repository.js" */
/** @import { StudyRepository } from "../study/repository.js" */
/** @import { FixturePromptRuntime } from "../prompt-bank/fixture-runtime.js" */
/** @import { GeneratedPrompt } from "../prompt-bank/contracts.js" */
/** @import { PersistenceEnvelope } from "../../persistence/contracts.js" */

/** @typedef {{ readonly kind: "RecallCohortPreparationFailed" | "RecallCohortPersistenceFailed" | "RecallCohortCommitFailed" }} CohortCompositionFailure */

export class DailyLearningService {
  /** @type {DailyLearningRepository} */
  #repository;
  /** @type {DailyStudySelector} */
  #selector;
  /** @type {() => string} */
  #createId;

  /**
   * @param {{ readonly repository: DailyLearningRepository, readonly selector: DailyStudySelector, readonly createId: () => string }} dependencies
   */
  constructor(dependencies) {
    if (
      !dependencies || typeof dependencies.createId !== "function" ||
      typeof dependencies.selector?.select !== "function" ||
      dependencies.selector.version.trim() === ""
    ) {
      throw new TypeError("DailyLearningDependenciesInvalid");
    }
    this.#repository = dependencies.repository;
    this.#selector = dependencies.selector;
    this.#createId = dependencies.createId;
  }

  /**
   * @param {unknown} command
   * @returns {Result<DailyLearningSettings, DailyLearningFailure>}
   */
  saveSettings(command) {
    const validation = validateSettingsCommand(command);
    if (!validation.ok) return validation;
    const current = this.#repository.getSettings(validation.value.ownerId);
    const actualRevision = current?.revision ?? 0;
    if (validation.value.expectedRevision !== actualRevision) {
      return {
        ok: false,
        error: {
          kind: "DailySettingsRevisionConflict",
          expected: validation.value.expectedRevision,
          actual: actualRevision,
        },
      };
    }
    return this.#repository.recordSettings(freeze({
      ownerId: validation.value.ownerId,
      dailyStudyTarget: validation.value.dailyStudyTarget,
      dailyRecallLimit: validation.value.dailyRecallLimit,
      timeZone: validation.value.timeZone,
      revision: actualRevision + 1,
      updatedAt: validation.value.updatedAt,
    }));
  }

  /**
   * @param {unknown} command
   * @returns {Result<DailyStudySet, DailyLearningFailure>}
   */
  createStudySet(command) {
    if (!isRecord(command)) return invalidAssignment("document");
    const ownerId = text(command.ownerId);
    const learningDay = text(command.learningDay);
    const idempotencyKey = text(command.idempotencyKey);
    const createdAt = text(command.createdAt);
    const candidates = command.candidates;
    if (ownerId === null) return invalidAssignment("ownerId");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(learningDay ?? "")) {
      return invalidAssignment("learningDay");
    }
    if (idempotencyKey === null) return invalidAssignment("idempotencyKey");
    if (createdAt === null || !Number.isFinite(Date.parse(createdAt))) {
      return invalidAssignment("createdAt");
    }
    if (
      !Array.isArray(candidates) ||
      !candidates.every(isStudyCandidateRef)
    ) {
      return invalidAssignment("candidates");
    }
    const settings = this.#repository.getSettings(ownerId);
    if (settings === null) return invalidAssignment("settings");
    const previous = /** @type {readonly DailyStudySet[]} */ (
      this.#repository.listStudySets(ownerId, learningDay)
    );
    /** @type {Set<string>} */
    const excludedContentIds = new Set();
    for (const set of previous) {
      for (const item of set.items) excludedContentIds.add(item.contentId);
    }
    const available = candidates.filter((candidate) =>
      !excludedContentIds.has(candidate.contentId)
    );
    if (available.length < settings.dailyStudyTarget) {
      return {
        ok: false,
        error: {
          kind: "DailyAssignmentInsufficientCandidates",
          required: settings.dailyStudyTarget,
          available: available.length,
        },
      };
    }
    const selected = this.#selector.select({
      ownerId,
      learningDay: /** @type {string} */ (learningDay),
      count: settings.dailyStudyTarget,
      candidates: available,
      excludedContentIds,
    });
    if (!validSelection(selected, available, settings.dailyStudyTarget)) {
      return {
        ok: false,
        error: {
          kind: "DailyAssignmentSelectionInvalid",
          reason: "Selector must return an exact, unique, eligible selection.",
        },
      };
    }
    return this.#repository.recordStudySet(freeze({
      id: this.#createId(),
      ownerId,
      learningDay: /** @type {string} */ (learningDay),
      ordinal: previous.length + 1,
      items: freeze([...selected]),
      studyTarget: settings.dailyStudyTarget,
      recallLimit: settings.dailyRecallLimit,
      settingsRevision: settings.revision,
      selectorVersion: this.#selector.version,
      idempotencyKey,
      createdAt,
    }));
  }

  /**
   * @param {unknown} command
   * @returns {Result<DailyRecallCohort, DailyLearningFailure>}
   */
  createRecallCohort(command) {
    if (!isRecord(command)) return invalidRecall("document");
    const ownerId = text(command.ownerId);
    const studySetId = text(command.studySetId);
    const idempotencyKey = text(command.idempotencyKey);
    const createdAt = text(command.createdAt);
    const eligiblePrompts = command.eligiblePrompts;
    if (ownerId === null) return invalidRecall("ownerId");
    if (studySetId === null) return invalidRecall("studySetId");
    if (idempotencyKey === null) return invalidRecall("idempotencyKey");
    if (createdAt === null || !Number.isFinite(Date.parse(createdAt))) {
      return invalidRecall("createdAt");
    }
    if (
      !Array.isArray(eligiblePrompts) ||
      !eligiblePrompts.every(isRecallCandidateRef)
    ) {
      return invalidRecall("eligiblePrompts");
    }
    const studySet = this.#repository.getStudySet(ownerId, studySetId);
    if (studySet === null) {
      return {
        ok: false,
        error: { kind: "DailyStudySetUnknown", studySetId },
      };
    }
    const existing = this.#repository.getCohort(ownerId, studySetId);
    const selectedAt = Date.parse(createdAt);
    const ineligible = eligiblePrompts.find((prompt) =>
      Date.parse(prompt.sourceStudiedAt) > Date.parse(prompt.eligibleAt) ||
      Date.parse(prompt.eligibleAt) > selectedAt ||
      Date.parse(prompt.dueAt) > selectedAt
    );
    if (ineligible !== undefined) {
      return {
        ok: false,
        error: {
          kind: "RecallAssignmentPromptIneligible",
          promptId: ineligible.promptId,
        },
      };
    }
    const sorted = fairPromptOrder(eligiblePrompts);
    const limit = Math.min(
      studySet.recallLimit,
      sorted.length,
      Math.max(0, studySet.items.length - 1),
    );
    if (limit >= studySet.items.length) {
      return {
        ok: false,
        error: {
          kind: "RecallAssignmentRatioInvalid",
          studySize: studySet.items.length,
          recallSize: limit,
        },
      };
    }
    return this.#repository.recordCohort(freeze({
      id: this.#createId(),
      ownerId,
      learningDay: studySet.learningDay,
      studySetId,
      prompts: freeze(sorted.slice(0, limit)),
      limit: studySet.recallLimit,
      revision: (existing?.revision ?? 0) + 1,
      selectorVersion: "fair-due-v1",
      idempotencyKey,
      createdAt,
    }));
  }

  /**
   * @param {{ readonly ownerId: string, readonly studySetId: string, readonly studiedContentIds: ReadonlySet<string>, readonly finalizedPromptIds: ReadonlySet<string> }} input
   * @returns {Result<true, DailyLearningFailure>}
   */
  evaluateNextSet(input) {
    const studySet = this.#repository.getStudySet(
      input.ownerId,
      input.studySetId,
    );
    if (studySet === null) {
      return {
        ok: false,
        error: {
          kind: "DailyStudySetUnknown",
          studySetId: input.studySetId,
        },
      };
    }
    const cohort = this.#repository.getCohort(
      input.ownerId,
      input.studySetId,
    );
    let remainingStudy = 0;
    for (const item of studySet.items) {
      if (!input.studiedContentIds.has(item.contentId)) remainingStudy += 1;
    }
    let remainingRecall = 0;
    for (const prompt of cohort?.prompts ?? []) {
      if (!input.finalizedPromptIds.has(prompt.promptId)) remainingRecall += 1;
    }
    if (remainingStudy > 0 || remainingRecall > 0) {
      return {
        ok: false,
        error: {
          kind: "NextStudySetLocked",
          remainingStudy,
          remainingRecall,
        },
      };
    }
    return { ok: true, value: true };
  }

  /**
   * @param {readonly DailyStudySet[]} studySets
   * @param {ReadonlySet<string>} studiedContentIds
   * @returns {Result<DailyStudyProgress, DailyLearningFailure>}
   */
  calculateProgress(studySets, studiedContentIds) {
    const assignedIds = new Set(
      studySets.flatMap((set) => set.items.map((item) => item.contentId)),
    );
    const studied =
      [...assignedIds].filter((id) => studiedContentIds.has(id)).length;
    if (studied > assignedIds.size) {
      return {
        ok: false,
        error: { kind: "DailyProjectionInvalid", field: "studied" },
      };
    }
    return {
      ok: true,
      value: freeze({ studied, assigned: assignedIds.size }),
    };
  }

  /**
   * @param {readonly DailyResponseFact[]} facts
   * @returns {Result<RecallAccuracy, DailyLearningFailure>}
   */
  calculateAccuracy(facts) {
    if (
      facts.some((fact) =>
        fact.ownerId.trim() === "" || fact.promptId.trim() === "" ||
        fact.studySetId.trim() === "" || fact.cohortId.trim() === "" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(fact.learningDay) ||
        fact.context !== "daily" ||
        !Number.isInteger(fact.promptVersion) || fact.promptVersion < 1 ||
        !Number.isFinite(Date.parse(fact.respondedAt)) ||
        !Number.isInteger(fact.responseSequence) || fact.responseSequence < 1
      )
    ) {
      return {
        ok: false,
        error: { kind: "DailyProjectionInvalid", field: "responses" },
      };
    }
    /** @type {Map<string, DailyResponseFact>} */
    const firstByPromptDay = new Map();
    for (const fact of facts) {
      if (!fact.finalized || fact.correct === null) continue;
      const key =
        `${fact.ownerId}\u0000${fact.learningDay}\u0000${fact.promptId}`;
      const current = firstByPromptDay.get(key);
      if (
        current === undefined ||
        fact.responseSequence < current.responseSequence ||
        (fact.responseSequence === current.responseSequence &&
          fact.id.localeCompare(current.id) < 0)
      ) firstByPromptDay.set(key, fact);
    }
    const selected = [...firstByPromptDay.values()];
    const correct = selected.filter((fact) => fact.correct).length;
    return {
      ok: true,
      value: freeze({
        correct,
        total: selected.length,
        percentage: selected.length === 0
          ? null
          : Math.round(correct / selected.length * 100),
      }),
    };
  }
}

/**
 * Persist a cohort without exposing its repository projection before the
 * authoritative envelope commits.
 *
 * @param {DailyStudySet} studySet
 * @param {{
 *   readonly ownerId: string,
 *   readonly now: () => string,
 *   readonly repository: DailyLearningRepository,
 *   readonly service: DailyLearningService,
 *   readonly promptRuntime: FixturePromptRuntime,
 *   readonly prompts: ReadonlyMap<string, RecallPrompt>,
 *   readonly studyRepository: StudyRepository,
 *   readonly recallRepository: RecallRepository,
 *   readonly append: (envelope: PersistenceEnvelope) => Promise<boolean>
 * }} dependencies
 * @returns {Promise<Result<true, CohortCompositionFailure>>}
 */
export async function persistRecallCohort(studySet, dependencies) {
  const existing = dependencies.repository.getCohort(
    dependencies.ownerId,
    studySet.id,
  );
  if (
    existing !== null &&
    (existing.prompts.length > 0 || studySet.recallLimit === 0)
  ) return { ok: true, value: true };
  const createdAt = dependencies.now();
  const selectedAt = Date.parse(createdAt);
  const eligiblePrompts = dependencies.promptRuntime
    .listPrompts(dependencies.ownerId)
    .flatMap((
      /** @type {GeneratedPrompt} */ generated,
      /** @type {number} */ index,
    ) => {
      const studyFact = dependencies.studyRepository
        .list(dependencies.ownerId, generated.contentId)
        .at(0);
      const prompt = dependencies.prompts.get(generated.id);
      if (studyFact === undefined || prompt === undefined) return [];
      const dueAt = dependencies.recallRepository.getMemory(
        dependencies.ownerId,
        prompt.knowledgeUnitId,
      )?.dueAt ?? generated.eligibleAt;
      if (
        Date.parse(generated.eligibleAt) > selectedAt ||
        Date.parse(dueAt) > selectedAt
      ) return [];
      /** @type {RecallCandidateRef} */
      const candidate = {
        promptId: generated.id,
        promptVersion: generated.version,
        contentId: generated.contentId,
        eligibleAt: generated.eligibleAt,
        dueAt,
        generationSequence: index + 1,
        sourceStudiedAt: studyFact.occurredAt,
      };
      return [candidate];
    });
  if (eligiblePrompts.length === 0 && studySet.recallLimit > 0) {
    return { ok: true, value: true };
  }
  const cohort = dependencies.service.createRecallCohort({
    ownerId: dependencies.ownerId,
    studySetId: studySet.id,
    eligiblePrompts,
    idempotencyKey: `daily-cohort:${studySet.id}:${
      (existing?.revision ?? 0) + 1
    }`,
    createdAt,
  });
  if (!cohort.ok) {
    return { ok: false, error: { kind: "RecallCohortPreparationFailed" } };
  }
  dependencies.repository.rollbackCohort(
    dependencies.ownerId,
    cohort.value.idempotencyKey,
  );
  const persisted = await dependencies.append({
    id: cohort.value.idempotencyKey,
    ownerId: dependencies.ownerId,
    kind: "daily_recall_cohort",
    payloadJson: JSON.stringify(cohort.value),
    recordedAt: cohort.value.createdAt,
  });
  if (!persisted) {
    return { ok: false, error: { kind: "RecallCohortPersistenceFailed" } };
  }
  const committed = dependencies.repository.recordCohort(cohort.value);
  return committed.ok
    ? { ok: true, value: true }
    : { ok: false, error: { kind: "RecallCohortCommitFailed" } };
}

/** @param {unknown} value @returns {value is StudyCandidateRef} */
function isStudyCandidateRef(value) {
  return isRecord(value) && text(value.contentId) !== null &&
    Number.isInteger(value.contentVersion) &&
    /** @type {number} */ (value.contentVersion) > 0 &&
    Array.isArray(value.promptIds) &&
    value.promptIds.every((id) => typeof id === "string" && id.trim() !== "");
}

/** @param {unknown} value @returns {value is RecallCandidateRef} */
function isRecallCandidateRef(value) {
  return isRecord(value) && text(value.promptId) !== null &&
    text(value.contentId) !== null &&
    Number.isInteger(value.promptVersion) &&
    /** @type {number} */ (value.promptVersion) > 0 &&
    Number.isFinite(Date.parse(String(value.eligibleAt))) &&
    Number.isFinite(Date.parse(String(value.dueAt))) &&
    Number.isFinite(Date.parse(String(value.sourceStudiedAt))) &&
    Number.isInteger(value.generationSequence) &&
    /** @type {number} */ (value.generationSequence) > 0;
}

/**
 * @param {readonly StudyCandidateRef[]} selected
 * @param {readonly StudyCandidateRef[]} available
 * @param {number} target
 */
function validSelection(selected, available, target) {
  if (selected.length !== target) return false;
  const availableIds = new Set(available.map((item) => item.contentId));
  const selectedIds = selected.map((item) => item.contentId);
  return new Set(selectedIds).size === selectedIds.length &&
    selectedIds.every((id) => availableIds.has(id));
}

/** @param {readonly RecallCandidateRef[]} prompts */
function fairPromptOrder(prompts) {
  const ordered = [...prompts].sort((left, right) =>
    Date.parse(left.dueAt) - Date.parse(right.dueAt) ||
    left.generationSequence - right.generationSequence ||
    left.promptId.localeCompare(right.promptId)
  );
  /** @type {RecallCandidateRef[]} */
  const result = [];
  /** @type {Set<string>} */
  const used = new Set();
  while (result.length < ordered.length) {
    let appended = false;
    for (const prompt of ordered) {
      if (result.includes(prompt) || used.has(prompt.contentId)) continue;
      result.push(prompt);
      used.add(prompt.contentId);
      appended = true;
    }
    if (!appended) {
      used.clear();
    }
  }
  return result;
}

/** @param {unknown} value @returns {string | null} */
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** @param {string} field @returns {Result<never, DailyLearningFailure>} */
function invalidAssignment(field) {
  return { ok: false, error: { kind: "DailyAssignmentInvalid", field } };
}

/** @param {string} field @returns {Result<never, DailyLearningFailure>} */
function invalidRecall(field) {
  return { ok: false, error: { kind: "RecallAssignmentInvalid", field } };
}
