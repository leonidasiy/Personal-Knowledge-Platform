// @ts-check

import { ExposureRepository } from "../src/features/exposure/repository.js";
import { ExposureService } from "../src/features/exposure/service.js";

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
  const repository = new ExposureRepository();
  const service = new ExposureService(
    repository,
    new Set(["candidate-a"]),
    30_000,
    () => `exposure-${++sequence}`,
  );
  return { repository, service };
}

function command(ownerId = "owner-a", engagedMs = 30_000) {
  return {
    ownerId,
    candidateId: "candidate-a",
    contentVersion: 1,
    engagedMs,
    idempotencyKey: `${ownerId}-view`,
    occurredAt: "2026-07-19T11:00:00.000Z",
  };
}

Deno.test("only a qualified view appends exposure without preference or mastery", () => {
  const { repository, service } = setup();
  const result = service.record(command());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.provenance, "qualified-view");
  assertEquals("preference" in result.value, false);
  assertEquals("mastery" in result.value, false);
  assertEquals(repository.list("owner-a", "candidate-a").length, 1);
});

Deno.test("passive or short visibility is rejected without a write", () => {
  const { repository, service } = setup();
  const result = service.record(command("owner-a", 29_999));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "ExposureBelowThreshold");
  assertEquals(repository.list("owner-a", "candidate-a").length, 0);
});

Deno.test("qualified views are idempotent and owner scoped", () => {
  const { repository, service } = setup();
  assertEquals(service.record(command()).ok, true);
  const duplicate = service.record(command());
  assertEquals(duplicate.ok, false);
  if (!duplicate.ok) {
    assertEquals(duplicate.error.kind, "ExposureAlreadyRecorded");
  }
  assertEquals(repository.list("owner-b", "candidate-a").length, 0);
});

Deno.test("separate feed sessions can record repeated qualified views", () => {
  const { repository, service } = setup();
  assertEquals(service.record(command()).ok, true);
  const laterSession = {
    ...command(),
    idempotencyKey: "owner-a-view-session-2",
    occurredAt: "2026-07-20T11:00:00.000Z",
  };
  assertEquals(service.record(laterSession).ok, true);
  assertEquals(repository.list("owner-a", "candidate-a").length, 2);
});

Deno.test("unknown candidates and malformed commands return named failures", () => {
  const { service } = setup();
  const unknown = service.record({ ...command(), candidateId: "missing" });
  assertEquals(unknown.ok, false);
  if (!unknown.ok) assertEquals(unknown.error.kind, "ExposureCandidateUnknown");

  const invalid = service.record({ ...command(), ownerId: "" });
  assertEquals(invalid.ok, false);
  if (!invalid.ok) assertEquals(invalid.error.kind, "ExposureCommandInvalid");
});

Deno.test("failed durable writes can roll back only the matching exposure", () => {
  const { repository, service } = setup();
  assertEquals(service.record(command()).ok, true);
  assertEquals(repository.rollback("owner-a", "owner-a-view"), true);
  assertEquals(repository.list("owner-a", "candidate-a").length, 0);
  assertEquals(repository.rollback("owner-b", "owner-a-view"), false);
});
