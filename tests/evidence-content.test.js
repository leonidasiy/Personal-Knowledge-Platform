// @ts-check

import {
  decodeEvidenceContentRecord,
  EvidenceContentRepository,
  EvidenceContentService,
} from "../src/features/evidence/service.js";

/** @import { EvidenceFailure, Result } from "../src/features/evidence/contracts.js" */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {Result<unknown, EvidenceFailure>} result @param {EvidenceFailure["kind"]} kind */
function assertFailure(result, kind) {
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, kind);
}

function setup(createId = (() => {
  let sequence = 0;
  return () => `evidence-record-${++sequence}`;
})()) {
  const repository = new EvidenceContentRepository();
  const service = new EvidenceContentService({
    repository,
    createId,
    now: () => "2026-07-21T12:00:00.000Z",
    maximumContentCharacters: 120,
    maximumAnchors: 3,
    maximumProvenanceEntries: 2,
  });
  return { repository, service };
}

function command(
  sourceKind = "learner-notes",
  ownerId = "owner-a",
  evidenceId = "evidence-a",
) {
  const contentForm = sourceKind === "learner-notes"
    ? "note"
    : sourceKind === "publisher-transcript"
    ? "excerpt"
    : "derived-text";
  return {
    ownerId,
    evidenceId,
    contentVersion: 1,
    sourceKind,
    contentForm,
    content: "A rights-cleared evidence passage.",
    anchors: [{ kind: "discovery-item", value: "item-a@1" }],
    attribution: sourceKind === "publisher-transcript"
      ? {
        label: "Publisher",
        sourceUrl: "https://publisher.example/transcript",
      }
      : null,
    rights: {
      basis: sourceKind === "learner-notes"
        ? "learner-authored"
        : "documented permission",
      reference: "rights-record-a",
      assessedAt: "2026-07-21T10:00:00.000Z",
      expiresAt: "2026-08-21T00:00:00.000Z",
      storageAllowed: true,
      displayAllowed: true,
      transformationAllowed: true,
    },
    provenance: [{
      method: sourceKind === "learner-notes"
        ? "learner-authored"
        : "authorized-import",
      sourceReference: sourceKind === "learner-notes"
        ? "local-note-a"
        : "https://publisher.example/transcript",
      acquiredAt: "2026-07-21T10:00:00.000Z",
      digest: "sha256:evidence-a-v1",
    }],
    occurredAt: "2026-07-21T11:00:00.000Z",
    idempotencyKey: `${ownerId}-${evidenceId}-create`,
  };
}

Deno.test("learner notes are immutable, owner scoped, private-local evidence without learning fields", () => {
  const { repository, service } = setup();
  const input = command();
  const created = service.create(input);
  assertEquals(created.ok, true);
  if (!created.ok) return;
  assertEquals(created.value.retention, "private-local");
  assertEquals(created.value.status, "active");
  assertEquals(Object.isFrozen(created.value), true);
  assertEquals(Object.isFrozen(created.value.anchors), true);
  assert(
    !("quiz" in created.value),
    "Evidence records must not contain quiz fields.",
  );
  assert(
    !("prompt" in created.value),
    "Evidence records must not contain prompt fields.",
  );
  assert(
    !("study" in created.value),
    "Evidence records must not contain study fields.",
  );
  input.anchors[0].value = "mutated";
  const latest = repository.latest("owner-a", "evidence-a");
  if (latest.ok && latest.value.status === "active") {
    assertEquals(latest.value.anchors[0].value, "item-a@1");
  }

  const replay = service.create(command());
  assertEquals(replay.ok, true);
  if (replay.ok) assertEquals(replay.value.recordId, created.value.recordId);
  const history = repository.history("owner-a", "evidence-a");
  if (history.ok) assertEquals(history.value.length, 1);
});

Deno.test("publisher excerpts and user-original derived text retain rights-cleared provenance", () => {
  const { service } = setup();
  const publisher = service.create(
    command("publisher-transcript", "owner-a", "publisher-a"),
  );
  assertEquals(publisher.ok, true);
  if (publisher.ok) {
    assertEquals(publisher.value.retention, "rights-cleared");
    assertEquals(publisher.value.contentForm, "excerpt");
    assertEquals(publisher.value.attribution?.label, "Publisher");
  }
  const original = service.create(
    command("user-original", "owner-a", "original-a"),
  );
  assertEquals(original.ok, true);
  if (original.ok) {
    assertEquals(original.value.contentForm, "derived-text");
    assertEquals(original.value.provenance[0].method, "authorized-import");
  }
});

Deno.test("active command validation reports source, content, anchors, attribution, rights, expiry, and provenance failures", () => {
  const { service } = setup();
  assertFailure(service.create(null), "EvidenceCommandInvalid");
  assertFailure(
    service.create({ ...command(), sourceKind: "unknown" }),
    "EvidenceSourceKindUnknown",
  );
  assertFailure(
    service.create({ ...command(), contentForm: "transcript" }),
    "EvidenceCommandInvalid",
  );
  assertFailure(
    service.create({ ...command(), contentVersion: 2 }),
    "EvidenceCommandInvalid",
  );
  assertFailure(
    service.create({ ...command(), content: "x".repeat(121) }),
    "EvidenceCommandInvalid",
  );
  assertFailure(
    service.create({ ...command(), anchors: [] }),
    "EvidenceCommandInvalid",
  );
  assertFailure(
    service.create({
      ...command(),
      anchors: [command().anchors[0], command().anchors[0]],
    }),
    "EvidenceConflict",
  );
  assertFailure(
    service.create({
      ...command("publisher-transcript", "owner-a", "missing-attribution"),
      attribution: null,
    }),
    "EvidenceAttributionMissing",
  );
  assertFailure(
    service.create({
      ...command("publisher-transcript", "owner-a", "ambiguous-attribution"),
      attribution: [
        { label: "A", sourceUrl: "https://a.example" },
        { label: "B", sourceUrl: "https://b.example" },
      ],
    }),
    "EvidenceAttributionAmbiguous",
  );
  assertFailure(
    service.create({ ...command(), rights: null }),
    "EvidenceRightsMissing",
  );
  assertFailure(
    service.create({
      ...command(),
      rights: { ...command().rights, transformationAllowed: false },
    }),
    "EvidenceRightsNotPermitted",
  );
  assertFailure(
    service.create({
      ...command(),
      rights: { ...command().rights, expiresAt: "2026-07-21T11:59:59.000Z" },
    }),
    "EvidenceRightsExpired",
  );
  assertFailure(
    service.create({ ...command(), provenance: [] }),
    "EvidenceProvenanceInvalid",
  );
  assertFailure(
    service.create({
      ...command(),
      provenance: [{ ...command().provenance[0], digest: "" }],
    }),
    "EvidenceProvenanceInvalid",
  );
});

Deno.test("replace appends a version, keeps prior content immutable, and rejects stale or conflicting transitions", () => {
  const { repository, service } = setup();
  const created = service.create(command());
  if (!created.ok) throw new Error(created.error.kind);
  const replacement = {
    ...command(),
    contentVersion: 2,
    expectedVersion: 1,
    content: "A corrected learner-authored note.",
    provenance: [{
      ...command().provenance[0],
      digest: "sha256:evidence-a-v2",
    }],
    occurredAt: "2026-07-21T12:05:00.000Z",
    idempotencyKey: "replace-a",
  };
  const replaced = service.replace(replacement);
  assertEquals(replaced.ok, true);
  const replay = service.replace(replacement);
  assertEquals(replay.ok, true);
  if (replay.ok && replaced.ok) {
    assertEquals(replay.value.recordId, replaced.value.recordId);
  }
  const history = repository.history("owner-a", "evidence-a");
  if (!history.ok) throw new Error(history.error.kind);
  assertEquals(history.value.length, 2);
  if (history.value[0].status === "active") {
    assertEquals(history.value[0].content, created.value.content);
  }
  assertFailure(
    service.replace({
      ...replacement,
      contentVersion: 2,
      idempotencyKey: "stale",
      content: "Stale.",
    }),
    "EvidenceVersionStale",
  );
  assertFailure(
    service.replace({
      ...replacement,
      contentVersion: 3,
      expectedVersion: 2,
      sourceKind: "user-original",
      contentForm: "derived-text",
      idempotencyKey: "source-conflict",
    }),
    "EvidenceConflict",
  );
  assertFailure(
    service.replace({ ...replacement, content: "Conflicting replay." }),
    "EvidenceConflict",
  );
});

Deno.test("revocation and deletion append tombstones and never silently reactivate content", () => {
  const { repository, service } = setup();
  service.create(command());
  const revoke = {
    ownerId: "owner-a",
    evidenceId: "evidence-a",
    contentVersion: 2,
    expectedVersion: 1,
    reason: "Permission withdrawn.",
    occurredAt: "2026-07-21T12:10:00.000Z",
    idempotencyKey: "revoke-a",
  };
  const revoked = service.revoke(revoke);
  assertEquals(revoked.ok, true);
  if (revoked.ok) {
    assertEquals(revoked.value.status, "revoked");
    assertEquals(revoked.value.content, null);
  }
  const replay = service.revoke(revoke);
  assertEquals(replay.ok, true);
  assertFailure(
    service.replace({
      ...command(),
      contentVersion: 3,
      expectedVersion: 2,
      idempotencyKey: "reactivate",
    }),
    "EvidenceConflict",
  );
  assertFailure(
    service.revoke({
      ...revoke,
      contentVersion: 3,
      expectedVersion: 2,
      idempotencyKey: "revoke-again",
    }),
    "EvidenceConflict",
  );
  const deleted = service.delete({
    ...revoke,
    contentVersion: 3,
    expectedVersion: 2,
    reason: "Learner requested deletion.",
    occurredAt: "2026-07-21T12:20:00.000Z",
    idempotencyKey: "delete-a",
  });
  assertEquals(deleted.ok, true);
  assertFailure(
    service.delete({
      ...revoke,
      contentVersion: 4,
      expectedVersion: 3,
      idempotencyKey: "delete-again",
    }),
    "EvidenceConflict",
  );
  const history = repository.history("owner-a", "evidence-a");
  if (history.ok) assertEquals(history.value.length, 3);
});

Deno.test("missing, wrong-owner, ambiguous, and stale evidence identities are distinct", () => {
  const { repository, service } = setup();
  assertFailure(
    repository.latest("owner-a", "missing"),
    "EvidenceContentMissing",
  );
  service.create(command("learner-notes", "owner-a", "shared"));
  assertFailure(
    repository.latest("owner-b", "shared"),
    "EvidenceOwnerMismatch",
  );
  service.create(command("learner-notes", "owner-b", "shared"));
  assertFailure(
    repository.latest("owner-c", "shared"),
    "EvidenceContentAmbiguous",
  );
  service.create(command("learner-notes", "owner-a", "stale"));
  assertFailure(
    service.revoke({
      ownerId: "owner-a",
      evidenceId: "stale",
      contentVersion: 3,
      expectedVersion: 2,
      reason: "Stale command.",
      occurredAt: "2026-07-21T12:10:00.000Z",
      idempotencyKey: "stale-command",
    }),
    "EvidenceVersionStale",
  );
});

Deno.test("invalid factories and conflicting create idempotency fail explicitly", () => {
  const invalid = setup(() => "").service.create(command());
  assertFailure(invalid, "EvidenceIdFactoryInvalid");
  const { service } = setup();
  service.create(command());
  assertFailure(
    service.create({ ...command(), content: "Different content." }),
    "EvidenceConflict",
  );
});

Deno.test("persisted active records and tombstones require the same strict contract", () => {
  const { service } = setup();
  const created = service.create(command());
  if (!created.ok) throw new Error(created.error.kind);
  const limits = {
    maximumContentCharacters: 120,
    maximumAnchors: 3,
    maximumProvenanceEntries: 2,
  };
  const decodedActive = decodeEvidenceContentRecord(
    JSON.parse(JSON.stringify(created.value)),
    limits,
  );
  assertEquals(decodedActive.ok, true);
  assertFailure(
    decodeEvidenceContentRecord(
      { ...created.value, retention: "remote" },
      limits,
    ),
    "EvidenceConflict",
  );
  const deleted = service.delete({
    ownerId: "owner-a",
    evidenceId: "evidence-a",
    contentVersion: 2,
    expectedVersion: 1,
    reason: "Delete retained content.",
    occurredAt: "2026-07-21T12:30:00.000Z",
    idempotencyKey: "decode-delete",
  });
  if (!deleted.ok) throw new Error(deleted.error.kind);
  assertEquals(
    decodeEvidenceContentRecord(
      JSON.parse(JSON.stringify(deleted.value)),
      limits,
    ).ok,
    true,
  );
  assertFailure(
    decodeEvidenceContentRecord(
      { ...deleted.value, content: "leaked" },
      limits,
    ),
    "EvidenceConflict",
  );
});
