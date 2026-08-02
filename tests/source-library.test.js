// @ts-check

import { SourceLibraryRepository } from "../src/features/source-library/repository.js";
import { SourceLibraryService } from "../src/features/source-library/service.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {SourceLibraryRepository} repository */
function service(repository) {
  let id = 1;
  let minute = 0;
  return new SourceLibraryService({
    repository,
    createId: () => String(id++),
    now: () => `2026-07-22T08:${String(minute++).padStart(2, "0")}:00.000Z`,
    ingestionPolicyVersion: "bounded-source-v1",
  });
}

const approval = Object.freeze({
  ownerId: "owner-a",
  submittedUrl: "https://publisher.example/learn?ref=discovery",
  canonicalUrl: "https://publisher.example/learn",
  title: "Publisher learning collection",
  description: "A source selected from attributed discovery evidence.",
  identityStatus: "resolved",
  identityEvidence: Object.freeze([{
    attribute: "canonical-link",
    value: "https://publisher.example/learn",
    provenanceUrl: "https://publisher.example/learn",
    observedAt: "2026-07-22T07:55:00.000Z",
  }]),
  adapter: Object.freeze({
    id: "adapter-from-registry",
    version: "1",
    granularity: "publisher-declared-root",
    capabilities: Object.freeze(["metadata", "bounded-pages"]),
  }),
  interestAreaIds: Object.freeze(["area-from-user-contract"]),
  idempotencyKey: "approve-1",
});

Deno.test("source approval atomically creates source, event, and ingestion job", async () => {
  const repository = new SourceLibraryRepository();
  const result = await service(repository).approve(approval);
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.reused, false);
  assertEquals(result.value.source.revision, 1);
  assertEquals(result.value.job?.policyVersion, "bounded-source-v1");
  assertEquals(repository.list("owner-a").length, 1);
  assertEquals(repository.listEvents("owner-a").length, 1);
  assertEquals(repository.listIngestionJobs("owner-a").length, 1);
});

Deno.test("individual-resource approval stores the exact discovered item version", async () => {
  const repository = new SourceLibraryRepository();
  const result = await service(repository).approve({
    ...approval,
    initialItem: {
      itemId: "video-a",
      versionId: "metadata-v1",
      canonicalUrl: "https://publisher.example/watch/a",
      title: "Video A",
      description: "Authoritative discovery metadata.",
      contentDigest: "sha256:metadata-a",
      provenance: [{ method: "provider-metadata", reference: "provider-item-a" }],
      observedAt: "2026-07-22T08:00:00.000Z",
      publishedAt: null,
    },
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const items = repository.listItemVersions("owner-a", result.value.source.id);
  assertEquals(items.length, 1);
  assertEquals(items[0].itemId, "video-a");
  const invalid = await service(new SourceLibraryRepository()).approve({ ...approval, initialItem: { itemId: "video-a" } });
  assertEquals(invalid.ok, false);
  if (!invalid.ok) assertEquals(invalid.error.kind, "SourceCatalogCommandInvalid");
});

Deno.test("approval retry and canonical reuse never duplicate ingestion", async () => {
  const repository = new SourceLibraryRepository();
  const sourceLibrary = service(repository);
  const first = await sourceLibrary.approve(approval);
  const retry = await sourceLibrary.approve(approval);
  const canonicalReuse = await sourceLibrary.approve({
    ...approval,
    idempotencyKey: "approve-2",
  });
  assertEquals(first.ok, true);
  assertEquals(retry.ok, true);
  assertEquals(canonicalReuse.ok, true);
  assertEquals(repository.list("owner-a").length, 1);
  assertEquals(repository.listIngestionJobs("owner-a").length, 1);

  const conflict = await sourceLibrary.approve({
    ...approval,
    title: "Conflicting retry",
  });
  assertEquals(conflict.ok, false);
  if (conflict.ok) throw new Error("Expected conflict.");
  assertEquals(conflict.error.kind, "SourceIdempotencyConflict");
});

Deno.test("source lifecycle is revisioned, owner-scoped, and preserves history", async () => {
  const repository = new SourceLibraryRepository();
  const sourceLibrary = service(repository);
  const approved = await sourceLibrary.approve(approval);
  if (!approved.ok) throw new Error(approved.error.kind);
  const sourceId = approved.value.source.id;
  const revised = await sourceLibrary.revise({
    ownerId: "owner-a",
    sourceId,
    expectedRevision: 1,
    idempotencyKey: "revise-1",
    title: "Updated source title",
    description: "Updated source description.",
    interestAreaIds: ["area-from-user-contract", "second-dynamic-area"],
  });
  assertEquals(revised.ok, true);
  if (!revised.ok) throw new Error(revised.error.kind);
  assertEquals(revised.value.revision, 2);
  assertEquals(revised.value.interestAreaIds.length, 2);
  const disabled = await sourceLibrary.disable({
    ownerId: "owner-a",
    sourceId,
    expectedRevision: 2,
    idempotencyKey: "disable-1",
  });
  assertEquals(disabled.ok, true);
  if (!disabled.ok) throw new Error(disabled.error.kind);
  assertEquals(disabled.value.state, "disabled");
  assertEquals(repository.listEvents("owner-a").length, 3);

  const stale = await sourceLibrary.restore({
    ownerId: "owner-a",
    sourceId,
    expectedRevision: 2,
    idempotencyKey: "restore-stale",
  });
  assertEquals(stale.ok, false);
  if (stale.ok) throw new Error("Expected stale revision.");
  assertEquals(stale.error.kind, "SourceRevisionStale");

  const wrongOwner = await sourceLibrary.restore({
    ownerId: "owner-b",
    sourceId,
    expectedRevision: 3,
    idempotencyKey: "restore-wrong-owner",
  });
  assertEquals(wrongOwner.ok, false);
  if (wrongOwner.ok) throw new Error("Expected owner mismatch.");
  assertEquals(wrongOwner.error.kind, "SourceOwnerMismatch");

  const restored = await sourceLibrary.restore({
    ownerId: "owner-a",
    sourceId,
    expectedRevision: 3,
    idempotencyKey: "restore-1",
  });
  assertEquals(restored.ok, true);
  if (!restored.ok) throw new Error(restored.error.kind);
  assertEquals(restored.value.state, "active");
  assertEquals(restored.value.revision, 4);
  assertEquals(repository.listEvents("owner-a").length, 4);
});

Deno.test("source identity failures stay distinct and create no records", async () => {
  for (
    const [identityStatus, kind] of [
      ["missing", "SourceIdentityMissing"],
      ["ambiguous", "SourceIdentityAmbiguous"],
      ["conflicting", "SourceIdentityConflict"],
    ]
  ) {
    const repository = new SourceLibraryRepository();
    const result = await service(repository).approve({
      ...approval,
      identityStatus,
      identityEvidence: identityStatus === "missing"
        ? []
        : approval.identityEvidence,
    });
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("Expected identity failure.");
    assertEquals(result.error.kind, kind);
    assertEquals(repository.list("owner-a").length, 0);
    assertEquals(repository.listIngestionJobs("owner-a").length, 0);
  }
});

Deno.test("source approval validates dynamic contracts without filename inference", async () => {
  const invalidCommands = [
    { ...approval, ownerId: "" },
    { ...approval, submittedUrl: "file:///tmp/source.html" },
    {
      ...approval,
      canonicalUrl: "https://user:secret@publisher.example/learn",
    },
    { ...approval, adapter: { ...approval.adapter, capabilities: [] } },
    { ...approval, interestAreaIds: [] },
    { ...approval, identityEvidence: [] },
  ];
  for (const command of invalidCommands) {
    const result = await service(new SourceLibraryRepository()).approve(
      command,
    );
    assertEquals(result.ok, false);
  }
});

Deno.test("source rejection stores one durable owner-scoped suppression", async () => {
  const repository = new SourceLibraryRepository();
  const sourceLibrary = service(repository);
  const command = {
    ownerId: "owner-a",
    canonicalIdentity: "https://publisher.example/learn",
    identityEvidence: approval.identityEvidence,
    idempotencyKey: "reject-1",
  };
  const rejected = await sourceLibrary.reject(command);
  const retried = await sourceLibrary.reject(command);
  const canonicalReuse = await sourceLibrary.reject({
    ...command,
    idempotencyKey: "reject-2",
  });
  assertEquals(rejected.ok, true);
  assertEquals(retried.ok, true);
  assertEquals(canonicalReuse.ok, true);
  if (!retried.ok || !canonicalReuse.ok) throw new Error("Expected reuse.");
  assertEquals(retried.value.reused, true);
  assertEquals(canonicalReuse.value.reused, true);
  assertEquals(repository.listSuppressions("owner-a").length, 1);
  assertEquals(repository.listSuppressions("owner-b").length, 0);

  const conflict = await sourceLibrary.reject({
    ...command,
    canonicalIdentity: "https://publisher.example/other",
  });
  assertEquals(conflict.ok, false);
  if (conflict.ok) throw new Error("Expected idempotency conflict.");
  assertEquals(conflict.error.kind, "SourceIdempotencyConflict");
});

Deno.test("source rejection requires evidence and creates no fallback identity", async () => {
  const repository = new SourceLibraryRepository();
  const rejected = await service(repository).reject({
    ownerId: "owner-a",
    canonicalIdentity: "guessed-from-a-filename",
    identityEvidence: [],
    idempotencyKey: "reject-missing-evidence",
  });
  assertEquals(rejected.ok, false);
  if (rejected.ok) throw new Error("Expected identity failure.");
  assertEquals(rejected.error.kind, "SourceIdentityMissing");
  assertEquals(repository.listSuppressions("owner-a").length, 0);
});
