// @ts-check

import { DailyLearningRepository } from "../src/features/daily-learning/repository.js";
import { DailyLearningService } from "../src/features/daily-learning/service.js";

/** @import { DailyResponseFact, RecallCandidateRef } from "../src/features/daily-learning/contracts.js" */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

function setup() {
  let id = 0;
  const repository = new DailyLearningRepository();
  const service = new DailyLearningService({
    repository,
    selector: {
      version: "test-selector-v1",
      select: ({ candidates, count }) => candidates.slice(0, count),
    },
    createId: () => `daily-${++id}`,
  });
  return { repository, service };
}

const candidates = Object.freeze(
  Array.from({ length: 8 }, (_, index) =>
    Object.freeze({
      contentId: `content-${index + 1}`,
      contentVersion: 1,
      promptIds: Object.freeze([`prompt-${index + 1}`]),
    })),
);

/** @param {DailyLearningService} service */
function saveDefaults(service) {
  return service.saveSettings({
    ownerId: "owner-a",
    dailyStudyTarget: 5,
    dailyRecallLimit: 3,
    timeZone: "Asia/Hong_Kong",
    expectedRevision: 0,
    updatedAt: "2026-07-20T00:00:00.000Z",
  });
}

Deno.test("daily settings accept 5/3 and require an atomic valid pair", () => {
  const { service } = setup();
  const saved = saveDefaults(service);
  assertEquals(saved.ok, true);
  if (!saved.ok) return;
  assertEquals(saved.value.revision, 1);

  const invalid = service.saveSettings({
    ownerId: "owner-a",
    dailyStudyTarget: 1,
    dailyRecallLimit: 1,
    timeZone: "Asia/Hong_Kong",
    expectedRevision: 1,
    updatedAt: "2026-07-20T00:01:00.000Z",
  });
  assertEquals(invalid.ok, false);
  if (!invalid.ok) assertEquals(invalid.error.kind, "DailyTargetPairInvalid");

  const validOne = service.saveSettings({
    ownerId: "owner-a",
    dailyStudyTarget: 1,
    dailyRecallLimit: 0,
    timeZone: "Asia/Hong_Kong",
    expectedRevision: 1,
    updatedAt: "2026-07-20T00:02:00.000Z",
  });
  assertEquals(validOne.ok, true);
});

Deno.test("settings revision conflicts remain explicit", () => {
  const { service } = setup();
  saveDefaults(service);
  const stale = service.saveSettings({
    ownerId: "owner-a",
    dailyStudyTarget: 5,
    dailyRecallLimit: 2,
    timeZone: "Asia/Hong_Kong",
    expectedRevision: 0,
    updatedAt: "2026-07-20T00:03:00.000Z",
  });
  assertEquals(stale.ok, false);
  if (!stale.ok) {
    assertEquals(stale.error.kind, "DailySettingsRevisionConflict");
  }
});

Deno.test("composition can roll back daily projections after durable write failure", () => {
  const { repository, service } = setup();
  const settings = saveDefaults(service);
  if (!settings.ok) throw new Error(settings.error.kind);
  assertEquals(
    repository.rollbackSettings("owner-a", settings.value.revision),
    true,
  );
  assertEquals(repository.getSettings("owner-a"), null);

  saveDefaults(service);
  const studySet = service.createStudySet({
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    candidates,
    idempotencyKey: "set-write-failed",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  if (!studySet.ok) throw new Error(studySet.error.kind);
  assertEquals(
    repository.rollbackStudySet("owner-a", studySet.value.idempotencyKey),
    true,
  );
  assertEquals(repository.listStudySets("owner-a", "2026-07-20").length, 0);
});

Deno.test("study assignment is exact size and snapshots settings", () => {
  const { repository, service } = setup();
  saveDefaults(service);
  const result = service.createStudySet({
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    candidates,
    idempotencyKey: "set-1",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.items.length, 5);
  assertEquals(result.value.studyTarget, 5);
  assertEquals(result.value.recallLimit, 3);
  assertEquals(result.value.settingsRevision, 1);
  assertEquals(repository.listStudySets("owner-a", "2026-07-20").length, 1);
});

Deno.test("insufficient inventory creates no partial study set", () => {
  const { repository, service } = setup();
  saveDefaults(service);
  const result = service.createStudySet({
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    candidates: candidates.slice(0, 4),
    idempotencyKey: "set-short",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "DailyAssignmentInsufficientCandidates");
  }
  assertEquals(repository.listStudySets("owner-a", "2026-07-20").length, 0);
});

Deno.test("additional sets exclude every content identity already assigned that day", () => {
  const { service } = setup();
  service.saveSettings({
    ownerId: "owner-a",
    dailyStudyTarget: 2,
    dailyRecallLimit: 1,
    timeZone: "UTC",
    expectedRevision: 0,
    updatedAt: "2026-07-20T00:00:00.000Z",
  });
  const first = service.createStudySet({
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    candidates,
    idempotencyKey: "set-1",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  if (!first.ok) throw new Error(first.error.kind);
  const second = service.createStudySet({
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    candidates: [
      { ...candidates[0], contentVersion: 2 },
      ...candidates.slice(2),
    ],
    idempotencyKey: "set-2",
    createdAt: "2026-07-20T02:00:00.000Z",
  });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assertEquals(
    second.value.items.some((item) => item.contentId === "content-1"),
    false,
  );
  assertEquals(second.value.ordinal, 2);
});

Deno.test("recall cohort is capped, underfilled, stable, and smaller than study", () => {
  const { service } = setup();
  saveDefaults(service);
  const study = service.createStudySet({
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    candidates,
    idempotencyKey: "set-1",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  if (!study.ok) throw new Error(study.error.kind);
  const prompts = [
    prompt("p-2", "content-1", 2),
    prompt("p-1", "content-1", 1),
    prompt("p-3", "content-2", 3),
  ];
  const cohort = service.createRecallCohort({
    ownerId: "owner-a",
    studySetId: study.value.id,
    eligiblePrompts: prompts,
    idempotencyKey: "cohort-1",
    createdAt: "2026-07-20T01:10:00.000Z",
  });
  assertEquals(cohort.ok, true);
  if (!cohort.ok) return;
  assertEquals(cohort.value.prompts.length, 3);
  assertEquals(cohort.value.prompts[0].promptId, "p-1");
  assertEquals(cohort.value.prompts[1].promptId, "p-3");
  assertEquals(cohort.value.prompts[2].promptId, "p-2");
});

Deno.test("zero-prompt cohort makes the recall half of the gate vacuous", () => {
  const { service } = setup();
  service.saveSettings({
    ownerId: "owner-a",
    dailyStudyTarget: 1,
    dailyRecallLimit: 0,
    timeZone: "UTC",
    expectedRevision: 0,
    updatedAt: "2026-07-20T00:00:00.000Z",
  });
  const study = service.createStudySet({
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    candidates,
    idempotencyKey: "one",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  if (!study.ok) throw new Error(study.error.kind);
  const cohort = service.createRecallCohort({
    ownerId: "owner-a",
    studySetId: study.value.id,
    eligiblePrompts: [],
    idempotencyKey: "zero",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  if (!cohort.ok) throw new Error(cohort.error.kind);
  assertEquals(cohort.value.prompts.length, 0);
  const unlocked = service.evaluateNextSet({
    ownerId: "owner-a",
    studySetId: study.value.id,
    studiedContentIds: new Set(["content-1"]),
    finalizedPromptIds: new Set(),
  });
  assertEquals(unlocked.ok, true);
});

Deno.test("independent cohort gate requires every study and finalized response", () => {
  const { service } = setup();
  saveDefaults(service);
  const study = service.createStudySet({
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    candidates,
    idempotencyKey: "set",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  if (!study.ok) throw new Error(study.error.kind);
  const cohort = service.createRecallCohort({
    ownerId: "owner-a",
    studySetId: study.value.id,
    eligiblePrompts: [prompt("p-1", "old-a", 1), prompt("p-2", "old-b", 2)],
    idempotencyKey: "cohort",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  if (!cohort.ok) throw new Error(cohort.error.kind);
  const studied = new Set(study.value.items.map((item) => item.contentId));
  const locked = service.evaluateNextSet({
    ownerId: "owner-a",
    studySetId: study.value.id,
    studiedContentIds: studied,
    finalizedPromptIds: new Set(["p-1"]),
  });
  assertEquals(locked.ok, false);
  if (!locked.ok) assertEquals(locked.error.kind, "NextStudySetLocked");
  const unlocked = service.evaluateNextSet({
    ownerId: "owner-a",
    studySetId: study.value.id,
    studiedContentIds: studied,
    finalizedPromptIds: new Set(["p-1", "p-2"]),
  });
  assertEquals(unlocked.ok, true);
});

Deno.test("recall cohorts reject prompts not yet generated or due", () => {
  const { service } = setup();
  saveDefaults(service);
  const study = service.createStudySet({
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    candidates,
    idempotencyKey: "set",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  if (!study.ok) throw new Error(study.error.kind);
  const future = service.createRecallCohort({
    ownerId: "owner-a",
    studySetId: study.value.id,
    eligiblePrompts: [{
      ...prompt("future", "learned-content", 1),
      dueAt: "2026-07-20T02:00:00.001Z",
    }],
    idempotencyKey: "future-cohort",
    createdAt: "2026-07-20T02:00:00.000Z",
  });
  assertEquals(future.ok, false);
  if (!future.ok) {
    assertEquals(future.error.kind, "RecallAssignmentPromptIneligible");
  }
});

Deno.test("daily progress and first finalized attempt accuracy are derived", () => {
  const { service } = setup();
  saveDefaults(service);
  const study = service.createStudySet({
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    candidates,
    idempotencyKey: "set",
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  if (!study.ok) throw new Error(study.error.kind);
  const progress = service.calculateProgress(
    [study.value],
    new Set(["content-1", "content-2"]),
  );
  assertEquals(progress.ok, true);
  if (progress.ok) {
    assertEquals(progress.value.studied, 2);
    assertEquals(progress.value.assigned, 5);
  }
  const accuracy = service.calculateAccuracy([
    fact("a", "prompt-1", 1, true, false),
    fact("b", "prompt-1", 2, true, true),
    fact("c", "prompt-2", 3, false, null),
    fact("d", "prompt-2", 4, true, true),
  ]);
  assertEquals(accuracy.ok, true);
  if (accuracy.ok) {
    assertEquals(accuracy.value.correct, 1);
    assertEquals(accuracy.value.total, 2);
    assertEquals(accuracy.value.percentage, 50);
  }
});

Deno.test("daily accuracy rejects malformed learning-day attribution", () => {
  const { service } = setup();
  const result = service.calculateAccuracy([
    { ...fact("bad-day", "prompt-1", 1, true, true), learningDay: "today" },
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "DailyProjectionInvalid");
});

/**
 * @param {string} promptId
 * @param {string} contentId
 * @param {number} generationSequence
 * @returns {RecallCandidateRef}
 */
function prompt(promptId, contentId, generationSequence) {
  return {
    promptId,
    promptVersion: 1,
    contentId,
    eligibleAt: "2026-07-20T01:00:00.000Z",
    dueAt: "2026-07-20T01:00:00.000Z",
    generationSequence,
    sourceStudiedAt: "2026-07-20T00:50:00.000Z",
  };
}

/**
 * @param {string} id
 * @param {string} promptId
 * @param {number} responseSequence
 * @param {boolean} finalized
 * @param {boolean | null} correct
 * @returns {DailyResponseFact}
 */
function fact(id, promptId, responseSequence, finalized, correct) {
  return {
    id,
    ownerId: "owner-a",
    learningDay: "2026-07-20",
    studySetId: "set-a",
    cohortId: "cohort-a",
    promptId,
    promptVersion: 1,
    respondedAt: "2026-07-20T02:00:00.000Z",
    context: "daily",
    finalized,
    correct,
    responseSequence,
  };
}
