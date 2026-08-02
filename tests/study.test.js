// @ts-check

import { StudyRepository } from "../src/features/study/repository.js";
import { StudyService } from "../src/features/study/service.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

function setup() {
  let sequence = 0;
  let failWrite = false;
  let writes = 0;
  const repository = new StudyRepository();
  const service = new StudyService({
    repository,
    knownCandidates: new Set(["candidate-a"]),
    createId: () => `study-${++sequence}`,
    async writeEvent() {
      writes += 1;
      return failWrite
        ? {
          ok: false,
          error: { kind: /** @type {const} */ ("StudyWriteUnavailable") },
        }
        : { ok: true, value: /** @type {const} */ (true) };
    },
  });
  return {
    repository,
    service,
    failNextWrite() {
      failWrite = true;
    },
    get writes() {
      return writes;
    },
  };
}

function command(ownerId = "owner-a") {
  return Object.freeze({
    ownerId,
    candidateId: "candidate-a",
    contentVersion: 1,
    idempotencyKey: `manual-study:${ownerId}:candidate-a:v1`,
    occurredAt: "2026-07-20T10:00:00.000Z",
  });
}

Deno.test("manual study records deliberate completion without engagement time", async () => {
  const { repository, service } = setup();
  const result = await service.record(command());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.provenance, "manual-study");
  assertEquals("engagedMs" in result.value, false);
  assertEquals("preference" in result.value, false);
  assertEquals("review" in result.value, false);
  assertEquals(repository.list("owner-a", "candidate-a").length, 1);
});

Deno.test("manual study is idempotent and owner scoped", async () => {
  const { repository, service } = setup();
  assertEquals((await service.record(command())).ok, true);
  const duplicate = await service.record(command());
  assertEquals(duplicate.ok, false);
  if (!duplicate.ok) assertEquals(duplicate.error.kind, "StudyAlreadyRecorded");
  assertEquals(repository.list("owner-b", "candidate-a").length, 0);
  assertEquals((await service.record(command("owner-b"))).ok, true);
  assertEquals(repository.list("owner-b", "candidate-a").length, 1);
});

Deno.test("manual study rejects malformed and unknown candidates distinctly", async () => {
  const { repository, service } = setup();
  const malformed = await service.record({ ...command(), ownerId: "" });
  assertEquals(malformed.ok, false);
  if (!malformed.ok) assertEquals(malformed.error.kind, "StudyCommandInvalid");
  const unknown = await service.record({
    ...command(),
    candidateId: "missing",
  });
  assertEquals(unknown.ok, false);
  if (!unknown.ok) assertEquals(unknown.error.kind, "StudyCandidateUnknown");
  assertEquals(repository.list("owner-a", "candidate-a").length, 0);
});

Deno.test("manual study rollback removes only the failed owner event", async () => {
  const { repository, service } = setup();
  const saved = command();
  assertEquals((await service.record(saved)).ok, true);
  assertEquals(repository.rollback("owner-b", saved.idempotencyKey), false);
  assertEquals(repository.rollback("owner-a", saved.idempotencyKey), true);
  assertEquals(repository.list("owner-a", "candidate-a").length, 0);
});

Deno.test("manual study rolls back and names durable persistence failure", async () => {
  const harness = setup();
  harness.failNextWrite();
  const result = await harness.service.record(command());
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "StudyPersistenceFailed");
  assertEquals(harness.repository.list("owner-a", "candidate-a").length, 0);
  assertEquals(harness.writes, 1);
});

Deno.test("manual study restore replays without another durable write", () => {
  const harness = setup();
  const restored = harness.service.restore(command());
  assertEquals(restored.ok, true);
  assertEquals(harness.writes, 0);
  assertEquals(harness.repository.list("owner-a", "candidate-a").length, 1);
});

Deno.test("manual study stays hidden until its durable write completes", async () => {
  const repository = new StudyRepository();
  /** @type {(value: { ok: true, value: true }) => void} */
  let completeWrite = () => {};
  const service = new StudyService({
    repository,
    knownCandidates: new Set(["candidate-a"]),
    createId: () => "deferred-study",
    writeEvent: () =>
      new Promise((resolve) => {
        completeWrite = resolve;
      }),
  });
  const pending = service.record(command());
  assertEquals(repository.list("owner-a", "candidate-a").length, 0);
  completeWrite({ ok: true, value: true });
  assertEquals((await pending).ok, true);
  assertEquals(repository.list("owner-a", "candidate-a").length, 1);
});
