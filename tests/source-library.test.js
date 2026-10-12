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

Deno.test("legacy private document retry preserves its historical authorization", async () => {
 const command = { ownerId: "owner-a", title: "Legacy notes", fileName: "notes.txt", idempotencyKey: "legacy-private", applicationOrigin: "https://app.example/" };
 const created = await service(new SourceLibraryRepository()).createPrivateDocument(command);
 if (!created.ok) throw new Error(created.error.kind);
 const basis = "learner-attested lawful copy", reference = "legacy-grant";
 const legacy = { ...created.value.source, adapter: { ...created.value.source.adapter, capabilities: ["owner-private-document", "processing-attested"] }, identityEvidence: created.value.source.identityEvidence.map(entry => ({ ...entry, attribute: entry.attribute === "user-upload-authorization" ? "owner-attested-processing" : entry.attribute, value: entry.attribute === "processing-basis" ? basis : entry.attribute === "processing-reference" ? reference : entry.value })) };
 const repository = new SourceLibraryRepository();
 const seeded = await repository.approve({ source: legacy, event: { id: "legacy-event", ownerId: "owner-a", sourceId: legacy.id, kind: "approved", sourceRevision: 1, idempotencyKey: command.idempotencyKey, occurredAt: legacy.approvedAt }, job: null, fingerprint: JSON.stringify({ ...command, basis, reference }) });
 if (!seeded.ok) throw new Error(seeded.error.kind);
 const before = JSON.stringify(repository.list("owner-a")); const sourceLibrary = service(repository);
 for (const rightsAttestation of [undefined, { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis, reference }]) {
  const result = await sourceLibrary.createPrivateDocument({ ...command, rightsAttestation });
  if (!result.ok || !result.value.reused || result.value.source.id !== legacy.id) throw new Error(result.ok ? "Expected legacy reuse." : result.error.kind);
 }
 for (const change of [{ title: "Different" }, { fileName: "different.txt" }, { applicationOrigin: "https://other.example/" }]) {
  const result = await sourceLibrary.createPrivateDocument({ ...command, ...change });
  if (result.ok || result.error.kind !== "SourceIdempotencyConflict") throw new Error("Different legacy command accepted.");
 }
 assertEquals(JSON.stringify(repository.list("owner-a")), before);
 assertEquals(repository.listEvents("owner-a").length, 1);
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

Deno.test("public source approval cannot forge the reserved private document identity", async () => {
  const repository = new SourceLibraryRepository();
  const result = await service(repository).approve({ ...approval, adapter: { ...approval.adapter, id: "private-document" } });
  assertEquals(result.ok, false);
  if (!result.ok && result.error.kind === "SourceCatalogCommandInvalid") assertEquals(result.error.field, "adapter.id");
  else throw new Error("Expected a named adapter validation failure.");
  assertEquals(repository.list("owner-a").length, 0);
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

Deno.test("private document creation persists an owner-scoped HTTPS document identity without crawl capability", async () => {
  const repository = new SourceLibraryRepository();
  const result = await service(repository).createPrivateDocument({
    ownerId: "owner-a", title: "Week 3 student notes", fileName: "week3-student.pdf",
    applicationOrigin: "https://app.example/", idempotencyKey: "private-document-1",
    rightsAttestation: { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis: "learner-attested lawful copy", reference: "learner-attestation:1" },
  });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.source.origin, "private-document");
  assertEquals(result.value.source.identityEvidence.find((entry) => entry.attribute === "processing-reference")?.value, "user-upload:private-document-1");
  assertEquals(result.value.source.canonicalUrl, `https://app.example/api/private-documents/${encodeURIComponent(result.value.source.id)}`);
  assertEquals(result.value.source.adapter.capabilities.includes("bounded-ingestion"), false);
  assertEquals(result.value.source.interestAreaIds.length, 0);
  assertEquals(result.value.job, null);
  assertEquals(repository.listIngestionJobs("owner-a").length, 0);
  const replay = await service(repository).createPrivateDocument({
    ownerId: "owner-a", title: "Week 3 student notes", fileName: "week3-student.pdf",
    applicationOrigin: "https://app.example/", idempotencyKey: "private-document-1",
    rightsAttestation: { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis: "learner-attested lawful copy", reference: "learner-attestation:1" },
  });
  assertEquals(replay.ok, true);
  if (!replay.ok) throw new Error(replay.error.kind);
  assertEquals(replay.value.reused, true);
  assertEquals(repository.list("owner-a").length, 1);
});

Deno.test("private document creation records upload authority without checkbox and rejects title conflicts", async () => {
  const repository = new SourceLibraryRepository();
  const sourceLibrary = service(repository);
  const command = { ownerId: "owner-a", title: "Week 3", fileName: "week3.pdf", applicationOrigin: "https://app.example/", idempotencyKey: "private-document-2", rightsAttestation: { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis: "learner-attested lawful copy", reference: "learner-attestation:2" } };
  const missingRights = await sourceLibrary.createPrivateDocument({ ...command, rightsAttestation: { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: false, basis: "learner-attested lawful copy", reference: "learner-attestation:2" } });
  assertEquals(missingRights.ok, true);
  const created = await sourceLibrary.createPrivateDocument(command);
  assertEquals(created.ok, true);
  const changedGrant = await sourceLibrary.createPrivateDocument({ ...command, rightsAttestation: { ...command.rightsAttestation, reference: "different-grant" } });
  assertEquals(changedGrant.ok, true);
  const conflict = await sourceLibrary.createPrivateDocument({ ...command, title: "Other title" });
  assertEquals(conflict.ok, false);
  if (!conflict.ok) assertEquals(conflict.error.kind, "SourceIdempotencyConflict");
  assertEquals(repository.list("owner-a").length, 1);
});

Deno.test("Raw source approval preserves an absent provider snippet as empty text", async () => {
 const repository=new SourceLibraryRepository(); const sourceLibrary=service(repository);
 const command={ownerId:"owner-a",identityStatus:"resolved",submittedUrl:"https://publisher.example/lesson",canonicalUrl:"https://publisher.example/lesson",title:"Raw title",description:"",idempotencyKey:"raw-empty",adapter:{id:"submitted-link",version:"v1",granularity:"document",capabilities:["metadata"]},interestAreaIds:["area-a"],identityEvidence:[{attribute:"user-submitted-url",value:"https://publisher.example/lesson",provenanceUrl:"https://publisher.example/lesson",observedAt:"2026-10-05T00:00:00.000Z"}]};
 const result=await sourceLibrary.approve(command); if(!result.ok)throw new Error(result.error.kind);assertEquals(result.value.source.description,"");
 const tooLong=await sourceLibrary.approve({...command,title:"x".repeat(301),idempotencyKey:"too-long"});assertEquals(tooLong.ok,false);
});
