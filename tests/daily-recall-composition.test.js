// @ts-check

import { DailyLearningRepository } from "../src/features/daily-learning/repository.js";
import {
  DailyLearningService,
  persistRecallCohort,
} from "../src/features/daily-learning/service.js";
import { RecallRepository } from "../src/features/recall/repository.js";
import { StudyRepository } from "../src/features/study/repository.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {{ readonly recallLimit: number, readonly now: string, readonly legacyEmpty?: boolean }} options */
function setup(options) {
  const ownerId = "owner-a", contentId = "content-a", promptId = "prompt-a";
  const studiedAt = "2026-07-28T00:00:00.000Z";
  const eligibleAt = "2026-07-28T00:10:00.000Z";
  const repository = new DailyLearningRepository();
  let id = 0;
  const service = new DailyLearningService({
    repository,
    selector: {
      version: "test-selector-v1",
      select: ({ candidates, count }) => candidates.slice(0, count),
    },
    createId: () => `daily-${++id}`,
  });
  const target = options.recallLimit === 0 ? 1 : 2;
  const settings = service.saveSettings({
    ownerId,
    dailyStudyTarget: target,
    dailyRecallLimit: options.recallLimit,
    timeZone: "UTC",
    expectedRevision: 0,
    updatedAt: studiedAt,
  });
  if (!settings.ok) throw new Error(settings.error.kind);
  const created = service.createStudySet({
    ownerId,
    learningDay: "2026-07-28",
    candidates: Array.from(
      { length: target },
      (_, index) => ({
        contentId: index === 0 ? contentId : `content-${index + 1}`,
        contentVersion: 1,
        promptIds: [index === 0 ? promptId : `prompt-${index + 1}`],
      }),
    ),
    idempotencyKey: "study-set-a",
    createdAt: studiedAt,
  });
  if (!created.ok) throw new Error(created.error.kind);
  const studyRepository = new StudyRepository();
  const studied = studyRepository.append({
    ownerId,
    candidateId: contentId,
    contentVersion: 1,
    idempotencyKey: "study-a",
    occurredAt: studiedAt,
  });
  if (!studied.ok) throw new Error(studied.error.kind);
  if (options.legacyEmpty) {
    const legacy = repository.recordCohort({
      id: "legacy-empty",
      ownerId,
      learningDay: "2026-07-28",
      studySetId: created.value.id,
      prompts: [],
      limit: options.recallLimit,
      revision: 1,
      selectorVersion: "fair-due-v1",
      idempotencyKey: `daily-cohort:${created.value.id}:1`,
      createdAt: studiedAt,
    });
    if (!legacy.ok) throw new Error(legacy.error.kind);
  }
  const generated = Object.freeze({
    id: promptId,
    ownerId,
    contentId,
    contentVersion: 1,
    knowledgeAnchorIds: Object.freeze(["anchor-a"]),
    kind: "single-choice",
    prompt: "Which answer is correct?",
    version: 1,
    generatedAt: eligibleAt,
    eligibleAt,
    generatorVersion: "test-generator-v1",
    policyVersion: "test-policy-v1",
    provenance: /** @type {const} */ ("fixture-generator"),
  });
  /** @type {Map<string, import("../src/features/recall/contracts.js").RecallPrompt>} */
  const prompts = new Map([[promptId, {
    id: promptId,
    contentId,
    knowledgeUnitId: "knowledge-a",
    prompt: generated.prompt,
    choices: Object.freeze([
      Object.freeze({ id: "correct", label: "Correct" }),
      Object.freeze({ id: "incorrect", label: "Incorrect" }),
    ]),
    correctChoiceId: "correct",
    status: "active",
  }]]);
  /** @type {import("../src/persistence/contracts.js").PersistenceEnvelope[]} */ const appended =
    [];
  let available = false;
  const dependencies = {
    ownerId,
    now: () => options.now,
    repository,
    service,
    promptRuntime: {
      listPrompts: () =>
        available ? Object.freeze([generated]) : Object.freeze([]),
    },
    prompts,
    studyRepository,
    recallRepository: new RecallRepository(),
    append: async (
      /** @type {import("../src/persistence/contracts.js").PersistenceEnvelope} */ envelope,
    ) => {
      appended.push(envelope);
      return true;
    },
  };
  return {
    appended,
    dependencies,
    repository,
    studySet: created.value,
    makeAvailable: () => available = true,
    promptId,
  };
}

Deno.test("positive recall defers an empty cohort until a prompt is eligible", async () => {
  const context = setup({ recallLimit: 1, now: "2026-07-28T00:09:59.999Z" });
  const result = await persistRecallCohort(
    context.studySet,
    context.dependencies,
  );
  assertEquals(result.ok, true);
  assertEquals(context.appended.length, 0);
  assertEquals(
    context.repository.getCohort("owner-a", context.studySet.id),
    null,
  );
});

Deno.test("the exact ten-minute boundary commits the newly eligible prompt", async () => {
  const context = setup({ recallLimit: 1, now: "2026-07-28T00:10:00.000Z" });
  context.makeAvailable();
  const result = await persistRecallCohort(
    context.studySet,
    context.dependencies,
  );
  assertEquals(result.ok, true);
  assertEquals(context.appended.length, 1);
  const cohort = context.repository.getCohort("owner-a", context.studySet.id);
  assertEquals(cohort?.prompts.length, 1);
  assertEquals(cohort?.prompts[0].promptId, context.promptId);
});

Deno.test("zero recall target persists the approved empty cohort", async () => {
  const context = setup({ recallLimit: 0, now: "2026-07-28T00:00:00.000Z" });
  const result = await persistRecallCohort(
    context.studySet,
    context.dependencies,
  );
  assertEquals(result.ok, true);
  assertEquals(context.appended.length, 1);
  assertEquals(
    context.repository.getCohort("owner-a", context.studySet.id)?.prompts
      .length,
    0,
  );
});

Deno.test("a positive-target legacy empty cohort is superseded without deletion", async () => {
  const context = setup({
    recallLimit: 1,
    now: "2026-07-28T00:10:00.000Z",
    legacyEmpty: true,
  });
  context.makeAvailable();
  const result = await persistRecallCohort(
    context.studySet,
    context.dependencies,
  );
  assertEquals(result.ok, true);
  assertEquals(context.appended.length, 1);
  const cohort = context.repository.getCohort("owner-a", context.studySet.id);
  assertEquals(cohort?.revision, 2);
  assertEquals(cohort?.prompts[0].promptId, context.promptId);
});
