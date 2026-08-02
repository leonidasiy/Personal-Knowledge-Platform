// @ts-check

import { RecallRepository } from "../src/features/recall/repository.js";
import { RecallService } from "../src/features/recall/service.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

const activePrompt = Object.freeze({
  id: "prompt-a",
  contentId: "content-a",
  knowledgeUnitId: "unit-a",
  prompt: "Which note resolves the suspension?",
  choices: Object.freeze([
    Object.freeze({ id: "choice-a", label: "The prepared dissonance" }),
    Object.freeze({ id: "choice-b", label: "The consonant resolution" }),
  ]),
  correctChoiceId: "choice-b",
  status: /** @type {const} */ ("active"),
});

function setup() {
  let sequence = 0;
  const repository = new RecallRepository();
  /** @type {import("../src/features/recall/contracts.js").RecallScheduler} */
  const scheduler = {
    schedule(request) {
      const days = request.rating === "good" ? 3 : 1;
      return {
        ok: true,
        value: {
          dueAt: new Date(Date.parse(request.reviewedAt) + days * 86_400_000)
            .toISOString(),
          stability: request.rating === "good" ? 2.4 : 0.4,
          difficulty: request.rating === "good" ? 4.8 : 7.1,
          scheduledDays: days,
          schedulerState: "test-double",
          schedulerVersion: "ts-fsrs@5.4.1-contract-test",
        },
      };
    },
  };
  const service = new RecallService(
    repository,
    new Map([[activePrompt.id, activePrompt]]),
    scheduler,
    () => `review-${++sequence}`,
  );
  return { repository, service };
}

function command(choiceId = "choice-b", ownerId = "owner-a") {
  return {
    ownerId,
    promptId: "prompt-a",
    selectedChoiceId: choiceId,
    idempotencyKey: `${ownerId}-${choiceId}`,
    reviewedAt: "2026-07-19T10:00:00.000Z",
  };
}

Deno.test("a correct answer records recall and schedules the memory independently", () => {
  const { repository, service } = setup();
  const result = service.answer(command());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.event.correct, true);
  assertEquals(result.value.event.rating, "good");
  assertEquals(result.value.memory.dueAt, "2026-07-22T10:00:00.000Z");
  assertEquals(result.value.memory.reviewCount, 1);
  assertEquals("preference" in result.value.event, false);
  assertEquals(repository.listEvents("owner-a").length, 1);
});

Deno.test("prepared recall stays hidden until explicitly committed", () => {
  const { repository, service } = setup();
  const prepared = service.prepare(command());
  assertEquals(prepared.ok, true);
  assertEquals(repository.listEvents("owner-a").length, 0);
  if (!prepared.ok) return;
  assertEquals(service.commit(prepared.value).ok, true);
  assertEquals(repository.listEvents("owner-a").length, 1);
});

Deno.test("an incorrect answer uses the again rating", () => {
  const { service } = setup();
  const result = service.answer(command("choice-a"));
  assertEquals(result.ok, true);
  if (!result.ok) assertEquals(result.error.kind, "RecallSchedulerRejected");
  if (result.ok) {
    assertEquals(result.value.event.correct, false);
    assertEquals(result.value.event.rating, "again");
    assertEquals(result.value.memory.scheduledDays, 1);
  }
});

Deno.test("recall commands are idempotent per owner", () => {
  const { service } = setup();
  assertEquals(service.answer(command()).ok, true);
  const duplicate = service.answer(command());
  assertEquals(duplicate.ok, false);
  if (!duplicate.ok) {
    assertEquals(duplicate.error.kind, "RecallAlreadyRecorded");
  }
});

Deno.test("memory and review history are isolated by owner", () => {
  const { repository, service } = setup();
  service.answer(command("choice-b", "owner-a"));
  assertEquals(repository.getMemory("owner-b", "unit-a"), null);
  assertEquals(repository.listEvents("owner-b").length, 0);
});

Deno.test("unknown, retired, and invalid answers return named failures", () => {
  const { repository, service } = setup();
  const unknown = service.answer({ ...command(), promptId: "missing" });
  assertEquals(unknown.ok, false);
  if (!unknown.ok) assertEquals(unknown.error.kind, "RecallPromptUnknown");

  const retiredService = new RecallService(
    repository,
    new Map([["prompt-a", { ...activePrompt, status: "retired" }]]),
    {
      schedule: () => ({
        ok: false,
        error: { kind: "RecallSchedulerRejected", reason: "unused" },
      }),
    },
    () => "unused",
  );
  const retired = retiredService.answer(command());
  assertEquals(retired.ok, false);
  if (!retired.ok) assertEquals(retired.error.kind, "RecallPromptRetired");

  const invalid = service.answer(command("missing-choice"));
  assertEquals(invalid.ok, false);
  if (!invalid.ok) assertEquals(invalid.error.kind, "RecallAnswerInvalid");
});

Deno.test("scheduler failures remain explicit and do not write a review", () => {
  const repository = new RecallRepository();
  const service = new RecallService(
    repository,
    new Map([[activePrompt.id, activePrompt]]),
    {
      schedule: () => ({
        ok: false,
        error: {
          kind: "RecallSchedulerUnavailable",
          schedulerVersion: "ts-fsrs@5.4.1",
        },
      }),
    },
    () => "review-never-created",
  );
  const result = service.answer(command());
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "RecallSchedulerUnavailable");
  assertEquals(repository.listEvents("owner-a").length, 0);
});

Deno.test("failed durable writes leave prepared review and memory hidden", () => {
  const { repository, service } = setup();
  const first = service.answer(command());
  if (!first.ok) throw new Error(first.error.kind);
  const previous = first.value.memory;

  const second = service.prepare({
    ...command(),
    idempotencyKey: "second-review",
    reviewedAt: "2026-07-22T10:00:00.000Z",
  });
  if (!second.ok) throw new Error(second.error.kind);
  assertEquals(second.value.memory.reviewCount, 2);
  assertEquals(repository.listEvents("owner-a").length, 1);
  assertEquals(repository.getMemory("owner-a", "unit-a"), previous);
});
