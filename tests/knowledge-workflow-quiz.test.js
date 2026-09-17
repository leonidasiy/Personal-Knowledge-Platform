// @ts-check

import { createQuizActorCritic } from "../src/features/knowledge-workflows/quiz.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

/** @returns {import("../src/features/knowledge-workflows/extraction.js").KnowledgePoint[]} */
function points() {
  return ["knowledge-a", "knowledge-b"].map((id) => ({ id, sourceId: "source-a", sourceRevision: 1, summary: `Summary ${id}`, normalizedHash: id, evidenceAnchors: [{ url: "https://example.test/a", selector: "#anchor" }], coverageGoalIds: [], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/a" }, extractionVersion: "knowledge-extraction-v1" }));
}

function setup() {
  /** @type {import("../src/features/knowledge-workflows/quiz.js").QuizAttempt[]} */
  const attempts = [];
  /** @type {unknown[]} */
  const published = [];
  /** @type {unknown[]} */
  const restricted = [];
  /** @type {unknown[]} */
  const purged = [];
  let generatorCalls = 0;
  let evaluatorCalls = 0;
  /** @type {import("../src/features/knowledge-workflows/quiz.js").QuizRepository} */
  const repository = {
      async appendAttempt(value) { attempts.push(value); return { ok: true, value: null }; },
      async publish(value) { published.push(value); return { ok: true, value: null }; },
      async restrict(value) { restricted.push(value); return { ok: true, value: null }; },
      async purge(value) { purged.push(value); return { ok: true, value: null }; },
  };
  const actor = createQuizActorCritic({
    generator: {
      async generate(command) {
        generatorCalls += 1;
        return { ok: true, value: { id: `draft-${generatorCalls}`, knowledgeId: command.knowledge.id, knowledgeRevision: command.knowledge.sourceRevision, kind: "single-choice", prompt: generatorCalls === 1 ? "What is the core concept?" : "Which statement best explains the core concept?", options: ["Correct", "Incorrect"], answer: "Correct", citedEvidenceUrls: ["https://example.test/a"] } };
      },
    },
    evaluator: {
      async evaluate(command) {
        evaluatorCalls += 1;
        const score = command.knowledge.id === "knowledge-a" ? (command.attempt === 1 ? 6 : 9) : 7;
        return { ok: true, value: { score, reasons: ["Tests the cited concept."], feedback: score < 8 ? "Make the prompt more specific." : "Grounded and relevant.", groundingProblems: [] } };
      },
    },
    repository,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
    maxAttempts: 3,
  });
  return { actor, repository, attempts, published, restricted, purged, get generatorCalls() { return generatorCalls; }, get evaluatorCalls() { return evaluatorCalls; } };
}

Deno.test("quiz actor-critic revises after feedback and continues sequentially", async () => {
  const fixture = setup();
  const result = await fixture.actor.run({ ownerId: "owner-a", runId: "run-a", points: points() });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.dispositions[0].status, "accepted");
  assertEquals(result.value.dispositions[0].attempts, 2);
  assertEquals(result.value.dispositions[1].status, "abandoned");
  assertEquals(result.value.dispositions[1].attempts, 3);
  assertEquals(fixture.published.length, 1);
  assertEquals(fixture.restricted.length, 1);
  assertEquals(fixture.purged.length, 0);
  assertEquals(fixture.generatorCalls, 5);
  assertEquals(fixture.evaluatorCalls, 5);
  assertEquals(fixture.attempts.filter((attempt) => attempt.knowledgeId === "knowledge-b").length, 3);
});

Deno.test("quiz actor-critic preserves corrective explanation and rejects malformed feedback", async () => {
  for (const explanation of ["The cited rule distinguishes these cases.", "", 42]) {
    const fixture = setup();
    const actor = createQuizActorCritic({
      generator: { async generate() { return { ok: true, value: { id: "draft-feedback", knowledgeId: "knowledge-a", knowledgeRevision: 1, kind: "single-choice", prompt: "Which case fits the rule?", options: ["A", "B"], answer: "A", explanation, citedEvidenceUrls: ["https://example.test/a"] } }; } },
      evaluator: { async evaluate() { return { ok: true, value: { score: 9, reasons: ["Supported distinction"], feedback: "Ready", groundingProblems: [] } }; } },
      repository: fixture.repository, now: () => "2026-09-08T00:00:00.000Z", logger: () => {}, maxAttempts: 3,
    });
    await actor.run({ ownerId: "owner-a", runId: "run-feedback", points: [points()[0]] });
    assertEquals(fixture.published.length, typeof explanation === "string" && explanation.length > 0 ? 1 : 0);
    if (fixture.published.length > 0) assertEquals(/** @type {{ draft: { explanation: string } }} */ (fixture.published[0]).draft.explanation, explanation);
  }
});

Deno.test("quiz actor-critic rejects ungrounded drafts before evaluator dispatch", async () => {
  const fixture = setup();
  const actor = createQuizActorCritic({
    generator: { async generate() { return { ok: true, value: { id: "draft-ungrounded", knowledgeId: "knowledge-a", knowledgeRevision: 1, kind: "single-choice", prompt: "General question", options: ["A", "B"], answer: "A", citedEvidenceUrls: ["https://other.test/unknown"] } }; } },
    evaluator: { async evaluate() { throw new Error("must not evaluate"); } },
    repository: fixture.repository,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
    maxAttempts: 3,
  });
  const result = await actor.run({ ownerId: "owner-a", runId: "run-b", points: [points()[0]] });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.dispositions[0].failureKind, "QuizAttemptLimitReached");
    assertEquals(fixture.attempts.length, 3);
    assertEquals(fixture.restricted.length, 1);
    assertEquals(fixture.purged.length, 0);
  }
});

Deno.test("quiz actor-critic rejects duplicate choice meanings and duplicate answers before evaluation", async () => {
  for (const draft of [
    { kind: "single-choice", options: ["Method A maps to term B", " method a maps to term b "], answer: "Method A maps to term B" },
    { kind: "multiple-choice", options: ["A applies to B", "C applies to D"], answer: ["A applies to B", "A applies to B"] },
  ]) {
    const fixture = setup();
    const actor = createQuizActorCritic({
      generator: { async generate() { return { ok: true, value: { id: "duplicate", knowledgeId: "knowledge-a", knowledgeRevision: 1, prompt: "Which mapping applies?", citedEvidenceUrls: ["https://example.test/a"], ...draft } }; } },
      evaluator: { async evaluate() { throw new Error("invalid draft reached evaluator"); } },
      repository: fixture.repository, now: () => "2026-09-17T00:00:00.000Z", logger: () => {}, maxAttempts: 3,
    });
    const result = await actor.run({ ownerId: "owner-a", runId: "run-duplicate-options", points: [points()[0]] });
    assertEquals(result.ok, true);
    assertEquals(fixture.published.length, 0);
    assertEquals(fixture.attempts.length, 3);
    assertEquals(fixture.attempts[0].failureKind, "QuizDraftSchemaInvalid");
  }
});

Deno.test("accepted quiz kinds are published directly after actor-critic approval", async () => {
  const fixture = setup();
  const actor = createQuizActorCritic({
    generator: { async generate(command) { return { ok: true, value: { id: "draft-response", knowledgeId: command.knowledge.id, knowledgeRevision: 1, kind: "short-response", prompt: "Explain the specific concept.", options: [], answer: "A specific explanation", citedEvidenceUrls: ["https://example.test/a"] } }; } },
    evaluator: { async evaluate() { return { ok: true, value: { score: 10, reasons: ["Precise"], feedback: "Ready for review.", groundingProblems: [] } }; } },
    repository: fixture.repository,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
    maxAttempts: 3,
  });
  const result = await actor.run({ ownerId: "owner-a", runId: "run-review", points: [points()[0]] });
  assertEquals(result.ok, true);
  assertEquals(fixture.published.length, 1);
  assertEquals(/** @type {{ readonly status: string }} */ (fixture.published[0]).status, "published");
  if (result.ok) assertEquals(result.value.dispositions[0].publicationStatus, "published");
});

Deno.test("malformed evaluator output consumes all three submissions before restriction and delayed purge", async () => {
  const fixture = setup();
  const actor = createQuizActorCritic({
    generator: { async generate(command) { return { ok: true, value: { id: `draft-${command.attempt}`, knowledgeId: command.knowledge.id, knowledgeRevision: 1, kind: "single-choice", prompt: "Specific?", options: ["yes", "no"], answer: "yes", citedEvidenceUrls: ["https://example.test/a"] } }; } },
    evaluator: { async evaluate() { return { ok: true, value: { score: 10 } }; } },
    repository: fixture.repository,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
    maxAttempts: 3,
  });
  const result = await actor.run({ ownerId: "owner-a", runId: "run-malformed", points: [points()[0]] });
  assertEquals(result.ok, true);
  assertEquals(fixture.attempts.length, 3);
  assertEquals(fixture.restricted.length, 1);
  assertEquals(fixture.purged.length, 0);
  if (!result.ok) return;
  const restrictedUntil = result.value.dispositions[0].restrictedUntil;
  if (restrictedUntil === null) throw new Error("Expected a restriction expiry.");
  const purged = await actor.purgeExpired({ ownerId: "owner-a", runId: "run-malformed", knowledgeId: "knowledge-a", restrictedUntil, before: restrictedUntil });
  assertEquals(purged.ok, true);
  assertEquals(fixture.purged.length, 1);
  const early = await actor.purgeExpired({ ownerId: "owner-a", runId: "run-malformed", knowledgeId: "knowledge-a", restrictedUntil, before: "2026-08-13T00:00:00.000Z" });
  assertEquals(early.ok, false);
  if (!early.ok) assertEquals(early.error.kind, "QuizPurgeBeforeRestrictionExpired");
});

Deno.test("quiz actor-critic abandons a duplicate knowledge point without evaluation", async () => {
  const fixture = setup();
  const actor = createQuizActorCritic({
    generator: { async generate() { return { ok: false, error: { kind: "QuizDuplicate" } }; } },
    evaluator: { async evaluate() { throw new Error("must not evaluate"); } },
    repository: fixture.repository,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
    maxAttempts: 3,
  });
  const result = await actor.run({ ownerId: "owner-a", runId: "run-duplicate", points: [points()[0]] });
  assertEquals(result.ok, true);
  assertEquals(fixture.published.length, 0);
});

Deno.test("quiz actor-critic abandons a duplicate publication race and continues", async () => {
  const fixture = setup();
  const actor = createQuizActorCritic({
    generator: { async generate(command) { return { ok: true, value: { id: "draft-race", knowledgeId: command.knowledge.id, knowledgeRevision: 1, kind: "single-choice", prompt: "Specific?", options: ["yes", "no"], answer: "yes", citedEvidenceUrls: ["https://example.test/a"] } }; } },
    evaluator: { async evaluate() { return { ok: true, value: { score: 9, reasons: ["Precise"], feedback: "Ready.", groundingProblems: [] } }; } },
    repository: { ...fixture.repository, async publish() { return { ok: false, error: { kind: "QuizDuplicate" } }; } },
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
    maxAttempts: 3,
  });
  const result = await actor.run({ ownerId: "owner-a", runId: "run-duplicate-race", points: [points()[0]] });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.dispositions[0].failureKind, "QuizDuplicate");
  assertEquals(fixture.restricted.length, 0);
});
