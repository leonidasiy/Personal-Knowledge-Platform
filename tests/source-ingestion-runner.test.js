// @ts-check

import { SourcePolicyEvaluator } from "../src/features/source-library/ingestion-policy.js";
import { SourceIngestionRunner } from "../worker/source-ingestion-runner.js";

/** @import { BrowserRunAcquisitionBatch, BrowserRunReservation, Result, ServerRightsGrant, SourceIngestionCommit, SourceIngestionCursor, SourceIngestionFailure, TrustedSourceIngestionJob } from "../src/features/source-library/ingestion-contracts.js" */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}

const now = "2026-07-22T12:00:00.000Z";
const cursor = Object.freeze({ version: 1, nextOrdinal: 0, pagesProcessed: 0, decodedBytes: 0, redirects: 0, frontier: Object.freeze([{ ordinal: 0, url: "https://publisher.example/course/", depth: 0, state: /** @type {const} */ ("pending"), discoveredFromUrl: null }]) });
/** @returns {TrustedSourceIngestionJob} */
function job() { return { ownerId: "owner-a", jobId: "job-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://publisher.example/course/", cursor }; }
/** @returns {import("../src/features/source-library/ingestion-contracts.js").CapabilityEvidence} */
function evidence() { return { outcome: "allowed", evidenceReference: "https://publisher.example/rights", observedAt: "2026-07-22T10:00:00.000Z", expiresAt: null }; }
/** @returns {ServerRightsGrant} */
function rights() {
  return {
    registryId: "registry-a", registryVersion: "1", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1,
    canonicalRootUrl: "https://publisher.example/course/", capabilities: { storage: evidence(), display: evidence(), transformation: evidence() },
    crawlEvidence: { robots: "allowed", robotsEvidenceReference: "https://publisher.example/robots.txt", terms: "allowed", termsEvidenceReference: "https://publisher.example/terms", access: "public", accessEvidenceReference: "https://publisher.example/course/", structuralEvidence: [] },
    attributionText: "Publisher", evidenceDigest: "sha256:rights", assessorId: "assessor", assessorVersion: "1", observedAt: "2026-07-22T10:00:00.000Z", expiresAt: null,
  };
}
/** @returns {BrowserRunReservation} */
function reservation() { return { reservationId: "reservation-a", accountScope: "browser-free", ownerId: "owner-a", jobId: "job-a", utcDay: "2026-07-22", reservedMilliseconds: 60_000, reservedAt: now, nextEligibleAt: "2026-07-22T12:00:20.000Z" }; }
/** @param {SourceIngestionCursor | null} [nextCursor] @returns {BrowserRunAcquisitionBatch} */
function batch(nextCursor = null) {
  return { pages: [{ canonicalUrl: "https://publisher.example/course/", status: 200, title: "Course", description: "Description", readableText: "A useful lesson.", visibleLinks: [], redirectChain: [], peerAddress: "8.8.8.8", observedAt: now }], nextCursor, measuredMilliseconds: 900, stopReason: nextCursor === null ? null : "BrowserRunExtractionLimitExceeded" };
}

/** @param {{ rightsResult?: Result<ServerRightsGrant, SourceIngestionFailure>, reserveResult?: Result<BrowserRunReservation, SourceIngestionFailure>, acquireResult?: Result<BrowserRunAcquisitionBatch, SourceIngestionFailure>, commitResult?: Result<{readonly state:"completed"|"partial"}, SourceIngestionFailure>, reconcileResult?: Result<null, SourceIngestionFailure> }} [overrides] */
function setup(overrides = {}) {
  const calls = { metadata: 0, reserve: 0, lease: 0, acquire: 0, reconcile: 0, stage: 0, remove: 0 };
  /** @type {SourceIngestionCommit[]} */ const commits = [];
  /** @type {readonly string[]} */ let stagedKeys = [];
  let sequence = 0;
  const policy = new SourcePolicyEvaluator({ policy: { version: "bounded-v1", initialDepth: 2, maximumDepth: 5, maximumPages: 5, maximumDecodedBytes: 1000, maximumConcurrency: 1, maximumDurationMs: 60_000, maximumRedirects: 2, refreshIntervalMs: 604_800_000 }, now: () => now });
  const runner = new SourceIngestionRunner({
    policy,
    repository: {
      loadRunnable: async () => ({ ok: true, value: job() }),
      lease: async (value) => { calls.lease += 1; return { ok: true, value }; },
      recordMetadataOnly: async () => { calls.metadata += 1; return { ok: true, value: null }; },
      commit: async (value) => { commits.push(value); return overrides.commitResult ?? { ok: true, value: { state: value.state } }; },
    },
    rightsRegistry: { resolve: async () => overrides.rightsResult ?? { ok: true, value: rights() } },
    capacity: {
      reserve: async () => { calls.reserve += 1; return overrides.reserveResult ?? { ok: true, value: reservation() }; },
      reconcile: async () => { calls.reconcile += 1; return overrides.reconcileResult ?? { ok: true, value: null }; },
    },
    acquirer: { acquire: async () => { calls.acquire += 1; return overrides.acquireResult ?? { ok: true, value: batch() }; } },
    contentStore: {
      stage: async (value) => { calls.stage += 1; const key = `source-content/${value.objectId}`; stagedKeys = [...stagedKeys, key]; return { ok: true, value: { objectKey: key } }; },
      remove: async () => { calls.remove += 1; return { ok: true, value: null }; },
    },
    digest: async (bytes) => ({ ok: true, value: `sha256:${bytes.byteLength}` }),
    createId: () => String(++sequence), now: () => now, leaseDurationMs: 300_000,
  });
  return { runner, calls, commits, getStagedKeys: () => stagedKeys };
}

Deno.test("runner resolves server rights, reserves capacity, stores Browser Run text, and commits", async () => {
  const fixture = setup();
  const result = await fixture.runner.run({ ownerId: "owner-a", jobId: "job-a" });
  if (!result.ok) throw new Error(`Expected success, received ${result.error.kind}.`);
  assertEquals(result.value.state, "completed");
  assertEquals(result.value.itemsStored, 1);
  assertEquals(fixture.calls.reserve, 1);
  assertEquals(fixture.calls.acquire, 1);
  assertEquals(fixture.calls.reconcile, 1);
  assertEquals(fixture.commits[0].items[0].provenance[0].method, "cloudflare-browser-run");
  assertEquals(fixture.commits[0].resumeCursor, null);
});

Deno.test("runner records missing rights metadata and performs no capacity or Browser work", async () => {
  const fixture = setup({ rightsResult: { ok: false, error: { kind: "RightsRegistryRecordMissing" } } });
  const result = await fixture.runner.run({ ownerId: "owner-a", jobId: "job-a" });
  if (result.ok) throw new Error("Expected missing rights failure.");
  assertEquals(result.error.kind, "RightsRegistryRecordMissing");
  assertEquals(fixture.calls.metadata, 1);
  assertEquals(fixture.calls.reserve, 0);
  assertEquals(fixture.calls.acquire, 0);
});

Deno.test("runner stops before leasing or Browser launch when capacity is unavailable", async () => {
  const fixture = setup({ reserveResult: { ok: false, error: { kind: "BrowserRunDailyBudgetExceeded" } } });
  const result = await fixture.runner.run({ ownerId: "owner-a", jobId: "job-a" });
  if (result.ok) throw new Error("Expected capacity failure.");
  assertEquals(result.error.kind, "BrowserRunDailyBudgetExceeded");
  assertEquals(fixture.calls.lease, 0);
  assertEquals(fixture.calls.acquire, 0);
});

Deno.test("runner persists the unchanged cursor after a named acquisition failure", async () => {
  const fixture = setup({ acquireResult: { ok: false, error: { kind: "BrowserRunBotAccessDenied" } } });
  const result = await fixture.runner.run({ ownerId: "owner-a", jobId: "job-a" });
  if (result.ok) throw new Error("Expected acquisition failure.");
  assertEquals(result.error.kind, "BrowserRunBotAccessDenied");
  assertEquals(fixture.calls.reconcile, 1);
  assertEquals(fixture.commits[0].state, "partial");
  assertEquals(fixture.commits[0].resumeCursor?.version, 1);
});

Deno.test("runner preserves a partial Browser cursor and its exact stop reason", async () => {
  const resumed = { ...cursor, version: 2, nextOrdinal: 1, pagesProcessed: 1, decodedBytes: 16 };
  const fixture = setup({ acquireResult: { ok: true, value: batch(resumed) } });
  const result = await fixture.runner.run({ ownerId: "owner-a", jobId: "job-a" });
  if (!result.ok) throw new Error("Expected partial success.");
  assertEquals(result.value.state, "partial");
  assertEquals(fixture.commits[0].resumeCursor?.version, 2);
  assertEquals(fixture.commits[0].stopReason, "BrowserRunExtractionLimitExceeded");
});

Deno.test("runner removes staged objects when immutable D1 commit fails", async () => {
  const fixture = setup({ commitResult: { ok: false, error: { kind: "IngestionPersistenceFailed" } } });
  const result = await fixture.runner.run({ ownerId: "owner-a", jobId: "job-a" });
  if (result.ok) throw new Error("Expected persistence failure.");
  assertEquals(result.error.kind, "IngestionPersistenceFailed");
  assertEquals(fixture.getStagedKeys().length, 1);
  assertEquals(fixture.calls.remove, 1);
});

Deno.test("runner rejects browser-shaped client commands before repository access", async () => {
  const fixture = setup();
  const result = await fixture.runner.run({ ownerId: "owner-a", jobId: "job-a", rootUrl: "https://attacker.example/" });
  if (result.ok) throw new Error("Expected invalid command.");
  assertEquals(result.error.kind, "SourceIngestionCommandInvalid");
  assertEquals(fixture.calls.reserve, 0);
});
