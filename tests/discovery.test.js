// @ts-check

import { DiscoveryProjection } from "../src/features/discovery/projection.js";
import { DiscoveryRepository } from "../src/features/discovery/repository.js";
import { DiscoveryService } from "../src/features/discovery/service.js";

/** @import { DiscoveryCursorCodec, DiscoveryDocumentParser, DiscoveryFailure, DiscoveryPageCursor, ParsedDiscoveryDocument, Result } from "../src/features/discovery/contracts.js" */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {Result<unknown, DiscoveryFailure>} result @param {DiscoveryFailure["kind"]} kind */
function assertFailure(result, kind) {
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, kind);
}

/** @param {string} digest @param {string} identity @param {string} title */
function parsedDocument(digest = "item-digest-1", identity = "entry:stable-1", title = "A discovered lesson") {
  return Object.freeze({
    format: "test-feed",
    parserVersion: "parser-v1",
    sourceIdentityEvidence: Object.freeze([{ reference: "feed-id", provenance: "document metadata" }]),
    items: Object.freeze([Object.freeze({
      identity: Object.freeze({
        status: "established",
        key: identity,
        evidence: Object.freeze([{ reference: identity, provenance: "persistent entry identifier" }]),
      }),
      title,
      canonicalUrl: "https://publisher.example/items/stable-1",
      contentDigest: digest,
      publisherLabel: "Publisher",
      publishedAt: "2026-07-20T00:00:00.000Z",
      boundedExcerpt: "A bounded excerpt.",
    })]),
  });
}

/** @param {ParsedDiscoveryDocument} document */
function parserFor(document) {
  let calls = 0;
  /** @type {DiscoveryDocumentParser} */
  const parser = {
    parse: () => {
      calls += 1;
      return Promise.resolve({ ok: true, value: document });
    },
  };
  return { parser, calls: () => calls };
}

/** @param {DiscoveryDocumentParser | null} suppliedParser */
function setup(suppliedParser = null) {
  let sequence = 0;
  const repository = new DiscoveryRepository();
  const fallback = parserFor(parsedDocument());
  const service = new DiscoveryService({
    repository,
    parser: suppliedParser ?? fallback.parser,
    supportedAdapters: new Set(["fixture-feed", "fixture-youtube"]),
    createId: () => `discovery-${++sequence}`,
    maximumDocumentBytes: 1024,
  });
  return { repository, service, parserCalls: fallback.calls };
}

function sourceCommand(ownerId = "owner-a") {
  return {
    ownerId,
    sourceId: "source-a",
    authoritativeIdentity: "source-identity-a",
    identityEvidence: [{ reference: "authoritative-feed-id", provenance: "feed body" }],
    adapterId: "fixture-feed",
    adapterVersion: "adapter-v1",
    submittedUrl: "https://publisher.example/feed",
    canonicalUrl: "https://publisher.example/feed.xml",
    idempotencyKey: `${ownerId}-register-source-a`,
    occurredAt: "2026-07-20T00:00:00.000Z",
  };
}

function importCommand(ownerId = "owner-a", digest = "document-digest-1", key = "import-1") {
  return {
    ownerId,
    sourceId: "source-a",
    sourceRevision: 1,
    adapterVersion: "adapter-v1",
    idempotencyKey: key,
    document: Object.freeze({ opaque: true }),
    provenance: {
      method: "authorized-fixture",
      acquiredAt: "2026-07-20T00:10:00.000Z",
      byteCount: 1024,
      digest,
      mediaType: "application/xml",
      submittedUrl: "https://publisher.example/feed",
      canonicalUrl: "https://publisher.example/feed.xml",
      sourceLocator: "worker-run-1",
    },
  };
}

/** @param {DiscoveryService} service */
async function seedItem(service) {
  const source = service.registerSource(sourceCommand());
  if (!source.ok) throw new Error(source.error.kind);
  const imported = await service.importDocument(importCommand());
  if (!imported.ok) throw new Error(imported.error.kind);
  const item = imported.value.itemVersions[0];
  if (!item) throw new Error("Expected imported item.");
  return item;
}

Deno.test("source registration validates unknown input and preserves immutable revisions", () => {
  const { repository, service } = setup();
  assertFailure(service.registerSource(null), "DiscoveryCommandInvalid");
  assertFailure(service.registerSource({ ...sourceCommand(), adapterId: "missing" }), "DiscoveryAdapterUnknown");
  assertFailure(service.registerSource({ ...sourceCommand(), submittedUrl: "http://publisher.example/feed" }), "DiscoverySourceProtocolUnsupported");

  const created = service.registerSource(sourceCommand());
  assertEquals(created.ok, true);
  if (!created.ok) return;
  assertFailure(service.registerSource({ ...sourceCommand(), idempotencyKey: "second-command" }), "DiscoverySourceDuplicate");
  const disabled = service.reviseSource({
    ownerId: "owner-a",
    sourceId: "source-a",
    state: "disabled",
    expectedRevision: 1,
    idempotencyKey: "disable-source",
    occurredAt: "2026-07-20T01:00:00.000Z",
  });
  assertEquals(disabled.ok, true);
  if (!disabled.ok) return;
  assertEquals(created.value.state, "enabled");
  assertEquals(disabled.value.state, "disabled");
  assertEquals(disabled.value.revision, 2);
  assertFailure(service.reviseSource({
    ownerId: "owner-a", sourceId: "source-a", state: "deleted", expectedRevision: 1,
    idempotencyKey: "stale-delete", occurredAt: "2026-07-20T02:00:00.000Z",
  }), "DiscoveryVersionConflict");
  assertFailure(repository.getSource("owner-b", "source-a"), "DiscoverySourceOwnerMismatch");
  const secondOwner = service.registerSource(sourceCommand("owner-b"));
  assertEquals(secondOwner.ok, true);
  assertEquals(repository.getSource("owner-b", "source-a").ok, true);
});

Deno.test("document import is atomic, versioned, and idempotent before parser replay", async () => {
  const controlled = parserFor(parsedDocument());
  const { repository, service } = setup(controlled.parser);
  service.registerSource(sourceCommand());
  assertFailure(await service.importDocument({
    ...importCommand("owner-a", "oversized-document", "oversized-import"),
    provenance: {
      ...importCommand().provenance,
      digest: "oversized-document",
      byteCount: 1025,
    },
  }), "DiscoveryPayloadTooLarge");
  assertEquals(controlled.calls(), 0);
  const first = await service.importDocument(importCommand());
  assertEquals(first.ok, true);
  if (!first.ok) return;
  assertEquals(first.value.itemVersions.length, 1);
  assertEquals(first.value.itemVersions[0].version, 1);
  const replay = await service.importDocument(importCommand());
  assertEquals(replay.ok, true);
  if (!replay.ok) return;
  assertEquals(replay.value.replayed, true);
  assertEquals(controlled.calls(), 1);
  assertFailure(await service.importDocument(importCommand("owner-a", "different-digest", "import-1")), "DiscoveryVersionConflict");
  assertEquals(repository.snapshot("owner-a").items.length, 1);

  const changedParser = parserFor(parsedDocument("item-digest-2", "entry:stable-1", "Updated title"));
  const changedService = new DiscoveryService({
    repository,
    parser: changedParser.parser,
    supportedAdapters: new Set(["fixture-feed"]),
    createId: (() => { let id = 100; return () => `changed-${++id}`; })(),
    maximumDocumentBytes: 1024,
  });
  const changed = await changedService.importDocument(importCommand("owner-a", "document-digest-2", "import-2"));
  assertEquals(changed.ok, true);
  if (!changed.ok) return;
  assertEquals(changed.value.itemVersions[0].id, first.value.itemVersions[0].id);
  assertEquals(changed.value.itemVersions[0].version, 2);
  assertEquals(repository.snapshot("owner-a").items[0].title, "Updated title");
});

Deno.test("identity failures are distinct and leave no partial item projection", async () => {
  for (const [status, kind] of [
    ["missing", "DiscoveryItemIdentityMissing"],
    ["ambiguous", "DiscoveryIdentityAmbiguous"],
    ["conflicting", "DiscoveryIdentityConflict"],
  ]) {
    const malformed = {
      ...parsedDocument(),
      items: [{
        ...parsedDocument().items[0],
        identity: { status, key: null, evidence: [{ reference: "evidence", provenance: "fixture" }] },
      }],
    };
    const controlled = parserFor(/** @type {ParsedDiscoveryDocument} */ (malformed));
    const { repository, service } = setup(controlled.parser);
    service.registerSource(sourceCommand());
    const result = await service.importDocument(importCommand());
    assertFailure(result, /** @type {DiscoveryFailure["kind"]} */ (kind));
    assertEquals(repository.snapshot("owner-a").items.length, 0);
  }

  const duplicate = parsedDocument();
  const duplicateParser = parserFor({ ...duplicate, items: [duplicate.items[0], duplicate.items[0]] });
  const { repository, service } = setup(duplicateParser.parser);
  service.registerSource(sourceCommand());
  assertFailure(await service.importDocument(importCommand()), "DiscoveryIdentityConflict");
  assertEquals(repository.snapshot("owner-a").items.length, 0);
});

Deno.test("rights capabilities gate triage independently with stale and conflicting decisions", async () => {
  const { repository, service } = setup();
  const item = await seedItem(service);
  assertFailure(service.triage({
    ownerId: "owner-a", itemId: item.id, itemVersion: 1, decision: "save-link",
    expectedDecisionRevision: 0, decidedAt: "2026-07-20T01:00:00.000Z", idempotencyKey: "triage-1",
  }), "DiscoveryRightsUnknown");

  for (const capability of ["link", "metadata-storage"]) {
    const assessed = service.assessRights({
      ownerId: "owner-a", itemId: item.id, itemVersion: 1, capability,
      state: "allowed", basis: `rights evidence for ${capability}`, attribution: "Publisher",
      assessedAt: "2026-07-20T00:30:00.000Z", expiresAt: null, idempotencyKey: `rights-${capability}`,
      supersedesAssessmentId: null,
    });
    assertEquals(assessed.ok, true);
  }
  const saved = service.triage({
    ownerId: "owner-a", itemId: item.id, itemVersion: 1, decision: "save-link",
    expectedDecisionRevision: 0, decidedAt: "2026-07-20T01:00:00.000Z", idempotencyKey: "triage-1",
  });
  assertEquals(saved.ok, true);
  assertFailure(service.triage({
    ownerId: "owner-a", itemId: item.id, itemVersion: 1, decision: "defer",
    expectedDecisionRevision: 0, decidedAt: "2026-07-20T02:00:00.000Z", idempotencyKey: "triage-stale",
  }), "DiscoveryTriageStale");
  assertFailure(service.triage({
    ownerId: "owner-a", itemId: item.id, itemVersion: 1, decision: "reject",
    expectedDecisionRevision: 1, decidedAt: "2026-07-20T02:00:00.000Z", idempotencyKey: "triage-1",
  }), "DiscoveryTriageConflict");
  assertEquals(repository.latestTriage("owner-b", item.id), null);
  assertFailure(service.assessRights({
    ownerId: "owner-b", itemId: item.id, itemVersion: 1, capability: "link", state: "allowed",
    basis: "none", attribution: null, assessedAt: "2026-07-20T00:30:00.000Z", expiresAt: null,
    idempotencyKey: "owner-b-rights", supersedesAssessmentId: null,
  }), "DiscoverySourceOwnerMismatch");
});

Deno.test("Policy A associations require independent evidence and never create learning signals", async () => {
  const { repository, service } = setup();
  const item = await seedItem(service);
  const base = {
    ownerId: "owner-a", itemId: item.id, itemVersion: 1,
    evidenceId: "evidence-1", evidenceContentVersion: 1,
    sourceKind: "publisher-transcript", acquisitionMethod: "publisher-https",
    retentionPolicy: "rights-reviewed-excerpt", sourceAnchors: [],
    associatedAt: "2026-07-20T03:00:00.000Z", idempotencyKey: "associate-1",
    rightsAttested: false, youtubeSourced: false,
  };
  assertFailure(service.associateEvidence(base), "IndependentTranscriptMissing");
  for (const capability of ["excerpt-storage", "display", "transform", "attribution"]) {
    service.assessRights({
      ownerId: "owner-a", itemId: item.id, itemVersion: 1, capability, state: "allowed",
      basis: "publisher license", attribution: "Publisher", assessedAt: "2026-07-20T02:00:00.000Z",
      expiresAt: null, idempotencyKey: `evidence-right-${capability}`, supersedesAssessmentId: null,
    });
  }
  const associated = service.associateEvidence({ ...base, sourceAnchors: ["paragraph-1"] });
  assertEquals(associated.ok, true);
  if (!associated.ok) return;
  for (const forbidden of ["prompt", "quiz", "schedule", "study", "recall", "preference", "exposure"]) {
    assertEquals(forbidden in associated.value, false);
  }
  assertEquals(repository.listAssociations("owner-a").length, 1);
  assertEquals(repository.listAssociations("owner-b").length, 0);
  assertFailure(service.associateEvidence({
    ...base, sourceKind: "user-original", sourceAnchors: ["segment-1"],
    acquisitionMethod: "local-asr", youtubeSourced: true, rightsAttested: true, idempotencyKey: "youtube-asr",
  }), "LocalAsrYouTubeSourceDisallowed");
});

/** @returns {DiscoveryCursorCodec} */
function cursorCodec() {
  /** @type {Map<string, DiscoveryPageCursor>} */
  const issued = new Map();
  return {
    encode: /** @param {DiscoveryPageCursor} cursor */ (cursor) => {
      const token = btoa(JSON.stringify(cursor));
      issued.set(token, cursor);
      return { ok: true, value: token };
    },
    decode: /** @param {string} token */ (token) => {
      const cursor = issued.get(token);
      return cursor
        ? { ok: true, value: cursor }
        : { ok: false, error: { kind: "DiscoveryPageCursorInvalid", reason: "tampered" } };
    },
  };
}

Deno.test("bounded inbox paging has stable exact boundaries and rejects invalid cursors", async () => {
  const first = parsedDocument("digest-a", "entry:a", "Alpha");
  const controlled = parserFor({
    ...first,
    items: [
      first.items[0],
      { ...first.items[0], identity: { status: "established", key: "entry:b", evidence: [{ reference: "entry:b", provenance: "id" }] }, contentDigest: "digest-b", title: "Beta", canonicalUrl: "https://publisher.example/b" },
      { ...first.items[0], identity: { status: "established", key: "entry:c", evidence: [{ reference: "entry:c", provenance: "id" }] }, contentDigest: "digest-c", title: "Gamma", canonicalUrl: "https://publisher.example/c" },
    ],
  });
  const { service, repository } = setup(controlled.parser);
  service.registerSource(sourceCommand());
  const imported = await service.importDocument(importCommand());
  if (!imported.ok) throw new Error(imported.error.kind);
  const projection = new DiscoveryProjection({ repository, cursorCodec: cursorCodec(), maximumPageSize: 2 });
  const page1 = projection.listInbox({ ownerId: "owner-a", pageSize: 2, cursor: null });
  assertEquals(page1.ok, true);
  if (!page1.ok || page1.value.nextCursor === null) return;
  assertEquals(page1.value.items.length, 2);
  const page2 = projection.listInbox({ ownerId: "owner-a", pageSize: 2, cursor: page1.value.nextCursor });
  assertEquals(page2.ok, true);
  if (!page2.ok) return;
  assertEquals(page2.value.items.length, 1);
  assertEquals(page2.value.nextCursor, null);
  assertFailure(projection.listInbox({ ownerId: "owner-b", pageSize: 2, cursor: page1.value.nextCursor }), "DiscoveryPageCursorInvalid");
  assertFailure(projection.listInbox({ ownerId: "owner-a", pageSize: 2, cursor: "tampered" }), "DiscoveryPageCursorInvalid");
  assertFailure(projection.listInbox({ ownerId: "owner-a", pageSize: 3, cursor: null }), "DiscoveryCommandInvalid");

  const firstItem = imported.value.itemVersions[0];
  service.assessRights({
    ownerId: "owner-a", itemId: firstItem.id, itemVersion: 1, capability: "link", state: "allowed",
    basis: "test", attribution: null, assessedAt: "2026-07-20T02:00:00.000Z", expiresAt: null,
    idempotencyKey: "advance-projection", supersedesAssessmentId: null,
  });
  assertFailure(projection.listInbox({ ownerId: "owner-a", pageSize: 2, cursor: page1.value.nextCursor }), "DiscoveryPageCursorInvalid");
  assertEquals(projection.listInbox({ ownerId: "owner-b", pageSize: 2, cursor: null }).ok, true);
});
