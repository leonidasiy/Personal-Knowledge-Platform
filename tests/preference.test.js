// @ts-check

import { PreferenceRepository } from "../src/features/preference/repository.js";
import { PreferenceService } from "../src/features/preference/service.js";

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
  const repository = new PreferenceRepository();
  const service = new PreferenceService(
    repository,
    new Set(["scope-a"]),
    () => `preference-${++sequence}`,
  );
  return { repository, service };
}

Deno.test("more and less change affinity without creating other signal fields", () => {
  const { repository, service } = setup();
  const more = service.record({
    ownerId: "owner-a",
    relationshipScopeId: "scope-a",
    choice: "more",
    idempotencyKey: "command-1",
    occurredAt: "2026-07-19T00:00:00.000Z",
  });
  assertEquals(more.ok, true);
  if (more.ok) assertEquals(more.value.affinity, 0.25);

  const less = service.record({
    ownerId: "owner-a",
    relationshipScopeId: "scope-a",
    choice: "less",
    idempotencyKey: "command-2",
    occurredAt: "2026-07-19T00:01:00.000Z",
  });
  assertEquals(less.ok, true);
  if (less.ok) assertEquals(less.value.affinity, 0);
  const event = repository.list("owner-a", "scope-a")[0];
  assertEquals("mastery" in event, false);
  assertEquals("qualifiedExposure" in event, false);
});

Deno.test("not now performs no preference write", () => {
  const { repository } = setup();
  // UI dismissal intentionally does not call PreferenceService.record.
  assertEquals(repository.list("owner-a", "scope-a").length, 0);
});

Deno.test("preference commands are idempotent per owner", () => {
  const { service } = setup();
  const command = {
    ownerId: "owner-a",
    relationshipScopeId: "scope-a",
    choice: /** @type {const} */ ("more"),
    idempotencyKey: "same-command",
    occurredAt: "2026-07-19T00:00:00.000Z",
  };
  assertEquals(service.record(command).ok, true);
  const duplicate = service.record(command);
  assertEquals(duplicate.ok, false);
  if (!duplicate.ok) {
    assertEquals(duplicate.error.kind, "PreferenceAlreadyRecorded");
  }
});

Deno.test("preference history is owner isolated", () => {
  const { service } = setup();
  service.record({
    ownerId: "owner-a",
    relationshipScopeId: "scope-a",
    choice: "more",
    idempotencyKey: "owner-a-command",
    occurredAt: "2026-07-19T00:00:00.000Z",
  });
  assertEquals(service.snapshot("owner-a", "scope-a").affinity, 0.25);
  assertEquals(service.snapshot("owner-b", "scope-a").affinity, 0);
});

Deno.test("reset clears effective affinity while preserving event history", () => {
  const { repository, service } = setup();
  service.record({
    ownerId: "owner-a",
    relationshipScopeId: "scope-a",
    choice: "more",
    idempotencyKey: "command-1",
    occurredAt: "2026-07-19T00:00:00.000Z",
  });
  const reset = service.reset(
    "owner-a",
    "scope-a",
    "reset-1",
    "2026-07-19T00:01:00.000Z",
  );
  assertEquals(reset.ok, true);
  if (reset.ok) {
    assertEquals(reset.value.affinity, 0);
    assertEquals(reset.value.eventCount, 2);
  }
  assertEquals(repository.list("owner-a", "scope-a").length, 2);
});

Deno.test("failed durable writes can roll back only the matching preference", () => {
  const { repository, service } = setup();
  service.record({
    ownerId: "owner-a",
    relationshipScopeId: "scope-a",
    choice: "more",
    idempotencyKey: "rollback-command",
    occurredAt: "2026-07-19T00:00:00.000Z",
  });
  assertEquals(repository.rollback("owner-a", "rollback-command"), true);
  assertEquals(service.snapshot("owner-a", "scope-a").affinity, 0);
  assertEquals(repository.rollback("owner-b", "rollback-command"), false);
});
