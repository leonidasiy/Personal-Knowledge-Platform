// @ts-check

import { catalogFixtures } from "../src/features/catalog/fixture.js";
import { DailyLearningRepository } from "../src/features/daily-learning/repository.js";
import { ExposureRepository } from "../src/features/exposure/repository.js";
import { ExposureService } from "../src/features/exposure/service.js";
import { PreferenceRepository } from "../src/features/preference/repository.js";
import { PreferenceService } from "../src/features/preference/service.js";
import { FixturePromptRuntime } from "../src/features/prompt-bank/fixture-runtime.js";
import { StudyRepository } from "../src/features/study/repository.js";
import { StudyService } from "../src/features/study/service.js";
import { IndexedDbPersistence } from "../src/persistence/indexeddb.js";
import { restoreLocalState } from "../src/startup/restore-local-state.js";

/** @import { PersistenceEnvelope, PersistenceFailure, RecordKind } from "../src/persistence/contracts.js" */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

class FixturePersistence extends IndexedDbPersistence {
  /** @type {readonly PersistenceEnvelope[]} */
  #records;
  /** @type {RecordKind | null} */
  #failedReadKind;
  appendCalls = 0;

  /** @param {readonly PersistenceEnvelope[]} records @param {RecordKind | null} [failedReadKind] */
  constructor(records, failedReadKind = null) {
    super();
    this.#records = records;
    this.#failedReadKind = failedReadKind;
  }

  /** @override @param {string} ownerId @param {RecordKind} kind @returns {Promise<{readonly ok:true,readonly value:readonly PersistenceEnvelope[]}|{readonly ok:false,readonly error:PersistenceFailure}>} */
  async list(ownerId, kind) {
    if (kind === this.#failedReadKind) {
      return {
        ok: /** @type {const} */ (false),
        error: {
          kind: /** @type {const} */ ("PersistenceReadFailed"),
          recordKind: kind,
        },
      };
    }
    return {
      ok: /** @type {const} */ (true),
      value: Object.freeze(
        this.#records.filter((record) =>
          record.ownerId === ownerId && record.kind === kind
        ),
      ),
    };
  }

  /** @override @param {PersistenceEnvelope} record */
  async append(record) {
    this.appendCalls += 1;
    return await super.append(record);
  }
}

Deno.test("restore read failures stay named and perform no migration write", async () => {
  const persistence = new FixturePersistence([], "daily_learning_settings");
  const restored = await restoreLocalState(
    setupDependencies("owner-a", persistence),
  );
  assertEquals(restored.ok, false);
  if (restored.ok) return;
  assertEquals(restored.error.kind, "LocalStateReadFailed");
  if (restored.error.kind === "LocalStateReadFailed") {
    assertEquals(restored.error.persistenceKind, "PersistenceReadFailed");
  }
  assertEquals(persistence.appendCalls, 0);
});

Deno.test("unsupported quarantine schema interrupts restore without rewriting prior records", async () => {
  const persistence = new FixturePersistence([
    envelope(
      "review_quarantine",
      "future-quarantine",
      "2026-07-20T00:13:00.000Z",
      {
        ownerId: "owner-a",
        recordIds: ["review-a"],
        idempotencyKey: "future-quarantine",
        createdAt: "2026-07-20T00:13:00.000Z",
        version: 2,
      },
    ),
  ]);
  const restored = await restoreLocalState(
    setupDependencies("owner-a", persistence),
  );
  assertEquals(restored.ok, false);
  if (restored.ok) return;
  assertEquals(restored.error.kind, "LocalStateCorrupt");
  if (restored.error.kind === "LocalStateCorrupt") {
    assertEquals(restored.error.recordKind, "review_quarantine");
    assertEquals(restored.error.recordId, "future-quarantine");
  }
  assertEquals(persistence.appendCalls, 0);
});

Deno.test("malformed migration timestamps fail without persistence writes", async () => {
  const invalidStudy = {
    ownerId: "owner-a",
    candidateId: catalogFixtures[0].id,
    contentVersion: 1,
    idempotencyKey: "invalid-study",
    occurredAt: "not-a-timestamp",
  };
  const persistence = new FixturePersistence([
    envelope(
      "manual_study",
      invalidStudy.idempotencyKey,
      invalidStudy.occurredAt,
      invalidStudy,
    ),
  ]);
  const restored = await restoreLocalState(
    setupDependencies("owner-a", persistence),
  );
  assertEquals(restored.ok, false);
  if (restored.ok) return;
  assertEquals(restored.error.kind, "LocalStateCorrupt");
  if (restored.error.kind === "LocalStateCorrupt") {
    assertEquals(restored.error.recordKind, "manual_study");
    assertEquals(restored.error.recordId, "invalid-study");
  }
  assertEquals(persistence.appendCalls, 0);
});

Deno.test("restore uses response sequence and keeps finalized open responses closed", async () => {
  const ownerId = "owner-a";
  const studiedAt = "2026-07-20T00:00:00.000Z";
  /** @type {import("../src/features/prompt-bank/contracts.js").PromptGenerationEvent[]} */
  const generations = [];
  const sourceRuntime = new FixturePromptRuntime({
    candidates: catalogFixtures,
    ownerId,
    now: () => "2026-07-20T00:10:00.000Z",
    write: async (event) => {
      generations.push(event);
      return { ok: true, value: true };
    },
  });
  const generated = await sourceRuntime.generateDue([{
    candidate: catalogFixtures[0],
    studiedAt,
  }]);
  const generation = generations[0];
  if (!generated.ok || generation === undefined) {
    throw new Error(generated.ok ? "generation missing" : generated.error.kind);
  }
  const prompt = generation.prompts[0];
  const settings = {
    ownerId,
    dailyStudyTarget: 2,
    dailyRecallLimit: 1,
    timeZone: "UTC",
    revision: 1,
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
  const studySet = {
    id: "set-1",
    ownerId,
    learningDay: "2026-07-20",
    ordinal: 1,
    items: catalogFixtures.slice(0, 2).map((candidate) => ({
      contentId: candidate.id,
      contentVersion: 1,
      promptIds: [candidate.quiz.id],
    })),
    studyTarget: 2,
    recallLimit: 1,
    settingsRevision: 1,
    selectorVersion: "test-selector-v1",
    idempotencyKey: "set-key",
    createdAt: "2026-07-20T00:11:00.000Z",
  };
  const studyCommand = {
    ownerId,
    candidateId: catalogFixtures[0].id,
    contentVersion: 1,
    idempotencyKey: "study-key",
    occurredAt: studiedAt,
  };
  const cohort = {
    id: "cohort-1",
    ownerId,
    learningDay: "2026-07-20",
    studySetId: studySet.id,
    prompts: [{
      promptId: prompt.id,
      promptVersion: prompt.version,
      contentId: prompt.contentId,
      eligibleAt: prompt.eligibleAt,
      dueAt: prompt.eligibleAt,
      generationSequence: 1,
      sourceStudiedAt: studiedAt,
    }],
    limit: 1,
    revision: 1,
    selectorVersion: "fair-due-v1",
    idempotencyKey: "cohort-key",
    createdAt: "2026-07-20T00:11:00.000Z",
  };
  const responseInstant = "2026-07-20T00:12:00.000Z";
  /**
   * @param {string} id
   * @param {number} sequence
   * @param {boolean} finalized
   * @param {boolean | null} correct
   */
  const fact = (id, sequence, finalized, correct) => ({
    id,
    ownerId,
    learningDay: "2026-07-20",
    studySetId: studySet.id,
    cohortId: cohort.id,
    promptId: prompt.id,
    promptVersion: prompt.version,
    respondedAt: responseInstant,
    context: /** @type {const} */ ("daily"),
    finalized,
    correct,
    responseSequence: sequence,
  });
  const recallCommand = {
    ownerId,
    promptId: prompt.id,
    selectedChoiceId: "legacy-answer-id",
    idempotencyKey: "review-key",
    reviewedAt: responseInstant,
  };
  const records = [
    envelope(
      "daily_learning_settings",
      `daily-settings:${ownerId}:1`,
      settings.updatedAt,
      settings,
    ),
    envelope(
      "daily_study_set",
      studySet.idempotencyKey,
      studySet.createdAt,
      studySet,
    ),
    envelope(
      "manual_study",
      studyCommand.idempotencyKey,
      studiedAt,
      studyCommand,
    ),
    envelope(
      "prompt_generation",
      generation.idempotencyKey,
      generation.generatedAt,
      generation,
    ),
    envelope(
      "daily_recall_cohort",
      cohort.idempotencyKey,
      cohort.createdAt,
      cohort,
    ),
    envelope("grade_finalization", "grade:z-pending", responseInstant, {
      fact: fact("z-pending", 1, false, null),
      status: "review-required",
      response: "pending",
      explanation: "review",
      recallCommand: null,
    }),
    envelope("grade_finalization", "grade:a-final", responseInstant, {
      fact: fact("a-final", 2, true, true),
      status: "correct",
      response: "final",
      explanation: "correct",
      recallCommand,
    }),
  ];
  const dependencies = setupDependencies(
    ownerId,
    new FixturePersistence(records),
  );
  const restored = await restoreLocalState(dependencies);
  assertEquals(restored.ok, true);
  if (!restored.ok) return;
  assertEquals(restored.value.openResponses.has(prompt.id), false);
  assertEquals(restored.value.responseFacts.length, 2);
  assertEquals(restored.value.recallCommands.length, 1);
  assertEquals(restored.value.migratedRecallCount, 1);
  assertEquals(
    restored.value.recallCommands[0]?.selectedChoiceId,
    `${prompt.id}-grade-correct`,
  );
  assertEquals(restored.value.incompatibleRecallRecords.length, 0);
  assertEquals(dependencies.persistence.appendCalls, 0);
});

Deno.test("restore isolates unsupported review events until a targeted quarantine exists", async () => {
  const reviewedAt = "2026-07-20T00:12:00.000Z";
  const legacy = {
    ownerId: "owner-a",
    promptId: "legacy-prompt",
    selectedChoiceId: "legacy-answer-id",
    idempotencyKey: "legacy-review",
    reviewedAt,
  };
  const review = envelope(
    "review_event",
    legacy.idempotencyKey,
    reviewedAt,
    legacy,
  );
  const initial = await restoreLocalState(
    setupDependencies("owner-a", new FixturePersistence([review])),
  );
  assertEquals(initial.ok, true);
  if (!initial.ok) return;
  assertEquals(initial.value.recallCommands.length, 0);
  assertEquals(initial.value.incompatibleRecallRecords.length, 1);
  assertEquals(
    initial.value.incompatibleRecallRecords[0]?.reason,
    "LegacyRecallEvidenceMissing",
  );

  const quarantine = envelope(
    "review_quarantine",
    "review-quarantine-1",
    "2026-07-20T00:13:00.000Z",
    {
      ownerId: "owner-a",
      recordIds: [legacy.idempotencyKey],
      idempotencyKey: "review-quarantine-1",
      createdAt: "2026-07-20T00:13:00.000Z",
      version: 1,
    },
  );
  const recovered = await restoreLocalState(
    setupDependencies(
      "owner-a",
      new FixturePersistence([review, quarantine]),
    ),
  );
  assertEquals(recovered.ok, true);
  if (!recovered.ok) return;
  assertEquals(recovered.value.recallCommands.length, 0);
  assertEquals(recovered.value.incompatibleRecallRecords.length, 0);
});

Deno.test("restore globally orders equivalent recall records and rejects conflicting duplicates", async () => {
  const later = {
    ownerId: "owner-a",
    promptId: "prompt-later",
    selectedChoiceId: "prompt-later-grade-correct",
    idempotencyKey: "review-later",
    reviewedAt: "2026-07-20T00:14:00.000Z",
  };
  const earlier = {
    ownerId: "owner-a",
    promptId: "prompt-earlier",
    selectedChoiceId: "prompt-earlier-grade-correct",
    idempotencyKey: "review-earlier",
    reviewedAt: "2026-07-20T00:12:00.000Z",
  };
  const duplicate = { ...earlier };
  const records = [
    envelope("review_event", later.idempotencyKey, later.reviewedAt, later),
    envelope(
      "review_event",
      earlier.idempotencyKey,
      earlier.reviewedAt,
      earlier,
    ),
    envelope(
      "review_event",
      earlier.idempotencyKey,
      earlier.reviewedAt,
      duplicate,
    ),
  ];
  const equivalent = await restoreLocalState(
    setupDependencies("owner-a", new FixturePersistence(records)),
  );
  assertEquals(equivalent.ok, true);
  if (!equivalent.ok) return;
  assertEquals(equivalent.value.recallCommands.length, 2);
  assertEquals(
    equivalent.value.recallCommands[0]?.idempotencyKey,
    earlier.idempotencyKey,
  );
  assertEquals(equivalent.value.incompatibleRecallRecords.length, 0);

  const conflict = {
    ...earlier,
    selectedChoiceId: "prompt-earlier-grade-incorrect",
  };
  const conflictRecords = [
    envelope(
      "review_event",
      earlier.idempotencyKey,
      earlier.reviewedAt,
      earlier,
    ),
    envelope(
      "review_event",
      earlier.idempotencyKey,
      earlier.reviewedAt,
      conflict,
    ),
  ];
  const conflicted = await restoreLocalState(
    setupDependencies("owner-a", new FixturePersistence(conflictRecords)),
  );
  assertEquals(conflicted.ok, true);
  if (!conflicted.ok) return;
  assertEquals(conflicted.value.recallCommands.length, 0);
  assertEquals(conflicted.value.incompatibleRecallRecords.length, 2);
  assertEquals(
    conflicted.value.incompatibleRecallRecords[0]?.reason,
    "RecallDuplicateConflict",
  );
});

Deno.test("restore rejects a cohort prompt without matching generated evidence", async () => {
  const ownerId = "owner-a";
  const settings = {
    ownerId,
    dailyStudyTarget: 1,
    dailyRecallLimit: 0,
    timeZone: "UTC",
    revision: 1,
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
  const studySet = {
    id: "set-1",
    ownerId,
    learningDay: "2026-07-20",
    ordinal: 1,
    items: [{
      contentId: catalogFixtures[0].id,
      contentVersion: 1,
      promptIds: [catalogFixtures[0].quiz.id],
    }],
    studyTarget: 1,
    recallLimit: 0,
    settingsRevision: 1,
    selectorVersion: "test-selector-v1",
    idempotencyKey: "set-key",
    createdAt: "2026-07-20T00:00:00.000Z",
  };
  const cohort = {
    id: "cohort-1",
    ownerId,
    learningDay: "2026-07-20",
    studySetId: studySet.id,
    prompts: [{
      promptId: "missing",
      promptVersion: 1,
      contentId: catalogFixtures[0].id,
      eligibleAt: studySet.createdAt,
      dueAt: studySet.createdAt,
      generationSequence: 1,
      sourceStudiedAt: studySet.createdAt,
    }],
    limit: 0,
    revision: 1,
    selectorVersion: "fair-due-v1",
    idempotencyKey: "cohort-key",
    createdAt: studySet.createdAt,
  };
  const records = [
    envelope(
      "daily_learning_settings",
      `daily-settings:${ownerId}:1`,
      settings.updatedAt,
      settings,
    ),
    envelope(
      "daily_study_set",
      studySet.idempotencyKey,
      studySet.createdAt,
      studySet,
    ),
    envelope(
      "daily_recall_cohort",
      cohort.idempotencyKey,
      cohort.createdAt,
      cohort,
    ),
  ];
  const restored = await restoreLocalState(
    setupDependencies(ownerId, new FixturePersistence(records)),
  );
  assertEquals(!restored.ok && restored.error.kind, "LocalStateCorrupt");
});

Deno.test("restore rejects generation before its eligibility boundary", async () => {
  const ownerId = "owner-a";
  const studiedAt = "2026-07-20T00:00:00.000Z";
  /** @type {import("../src/features/prompt-bank/contracts.js").PromptGenerationEvent[]} */
  const generations = [];
  const sourceRuntime = new FixturePromptRuntime({
    candidates: catalogFixtures,
    ownerId,
    now: () => "2026-07-20T00:10:00.000Z",
    write: async (event) => {
      generations.push(event);
      return { ok: true, value: true };
    },
  });
  await sourceRuntime.generateDue([{
    candidate: catalogFixtures[0],
    studiedAt,
  }]);
  const generation = generations[0];
  if (generation === undefined) throw new Error("generation missing");
  const generatedAt = "2026-07-20T00:09:59.999Z";
  const records = [
    envelope("manual_study", "study-key", studiedAt, {
      ownerId,
      candidateId: catalogFixtures[0].id,
      contentVersion: 1,
      idempotencyKey: "study-key",
      occurredAt: studiedAt,
    }),
    envelope(
      "prompt_generation",
      generation.idempotencyKey,
      generatedAt,
      { ...generation, generatedAt },
    ),
  ];
  const restored = await restoreLocalState(
    setupDependencies(ownerId, new FixturePersistence(records)),
  );
  assertEquals(!restored.ok && restored.error.kind, "LocalStateCorrupt");
});

Deno.test("restore preserves a legacy empty cohort and selects its nonempty successor", async () => {
  const ownerId = "owner-a";
  const studiedAt = "2026-07-20T00:00:00.000Z";
  /** @type {import("../src/features/prompt-bank/contracts.js").PromptGenerationEvent[]} */
  const generations = [];
  const sourceRuntime = new FixturePromptRuntime({
    candidates: catalogFixtures,
    ownerId,
    now: () => "2026-07-20T00:10:00.000Z",
    write: async (event) => {
      generations.push(event);
      return { ok: true, value: true };
    },
  });
  await sourceRuntime.generateDue([{
    candidate: catalogFixtures[0],
    studiedAt,
  }]);
  const generation = generations[0];
  const prompt = generation?.prompts[0];
  if (generation === undefined || prompt === undefined) {
    throw new Error("generation missing");
  }
  const settings = {
    ownerId,
    dailyStudyTarget: 2,
    dailyRecallLimit: 1,
    timeZone: "UTC",
    revision: 1,
    updatedAt: studiedAt,
  };
  const studySet = {
    id: "set-recovered",
    ownerId,
    learningDay: "2026-07-20",
    ordinal: 1,
    items: catalogFixtures.slice(0, 2).map((candidate) => ({
      contentId: candidate.id,
      contentVersion: 1,
      promptIds: [candidate.quiz.id],
    })),
    studyTarget: 2,
    recallLimit: 1,
    settingsRevision: 1,
    selectorVersion: "test-selector-v1",
    idempotencyKey: "set-recovered-key",
    createdAt: studiedAt,
  };
  const cohortBase = {
    ownerId,
    learningDay: studySet.learningDay,
    studySetId: studySet.id,
    limit: 1,
    selectorVersion: "fair-due-v1",
  };
  const records = [
    envelope(
      "daily_learning_settings",
      `daily-settings:${ownerId}:1`,
      studiedAt,
      settings,
    ),
    envelope("daily_study_set", studySet.idempotencyKey, studiedAt, studySet),
    envelope("manual_study", "study-recovered", studiedAt, {
      ownerId,
      candidateId: prompt.contentId,
      contentVersion: 1,
      idempotencyKey: "study-recovered",
      occurredAt: studiedAt,
    }),
    envelope(
      "prompt_generation",
      generation.idempotencyKey,
      generation.generatedAt,
      generation,
    ),
    envelope("daily_recall_cohort", "legacy-empty", studiedAt, {
      ...cohortBase,
      id: "legacy-empty",
      prompts: [],
      revision: 1,
      idempotencyKey: "legacy-empty",
      createdAt: studiedAt,
    }),
    envelope("daily_recall_cohort", "recovered-cohort", prompt.eligibleAt, {
      ...cohortBase,
      id: "recovered-cohort",
      prompts: [{
        promptId: prompt.id,
        promptVersion: prompt.version,
        contentId: prompt.contentId,
        eligibleAt: prompt.eligibleAt,
        dueAt: prompt.eligibleAt,
        generationSequence: 1,
        sourceStudiedAt: studiedAt,
      }],
      revision: 2,
      idempotencyKey: "recovered-cohort",
      createdAt: prompt.eligibleAt,
    }),
  ];
  const dependencies = setupDependencies(
    ownerId,
    new FixturePersistence(records),
  );
  const restored = await restoreLocalState(dependencies);
  assertEquals(restored.ok, true);
  if (!restored.ok) return;
  assertEquals(
    dependencies.dailyLearningRepository.getCohort(ownerId, studySet.id)
      ?.revision,
    2,
  );
  assertEquals(
    dependencies.studyRepository.list(ownerId, prompt.contentId).length,
    1,
  );
});

/** @param {string} ownerId @param {FixturePersistence} persistence */
function setupDependencies(ownerId, persistence) {
  const dailyLearningRepository = new DailyLearningRepository();
  const studyRepository = new StudyRepository();
  const knownCandidates = new Set(catalogFixtures.map((item) => item.id));
  return {
    ownerId,
    persistence,
    dailyLearningRepository,
    promptRuntime: new FixturePromptRuntime({
      candidates: catalogFixtures,
      ownerId,
      now: () => "2026-07-20T00:10:00.000Z",
      write: async () => ({ ok: true, value: true }),
    }),
    preferenceService: new PreferenceService(
      new PreferenceRepository(),
      new Set(catalogFixtures.map((item) => item.relationshipScopeId)),
      () => crypto.randomUUID(),
    ),
    exposureService: new ExposureService(
      new ExposureRepository(),
      knownCandidates,
      30_000,
      () => crypto.randomUUID(),
    ),
    studyRepository,
    studyService: new StudyService({
      repository: studyRepository,
      knownCandidates,
      createId: () => crypto.randomUUID(),
      writeEvent: async () => ({ ok: true, value: true }),
    }),
  };
}

/**
 * @param {RecordKind} kind
 * @param {string} id
 * @param {string} recordedAt
 * @param {unknown} payload
 * @returns {PersistenceEnvelope}
 */
function envelope(kind, id, recordedAt, payload) {
  return {
    id,
    ownerId: "owner-a",
    kind,
    payloadJson: JSON.stringify(payload),
    recordedAt,
  };
}
