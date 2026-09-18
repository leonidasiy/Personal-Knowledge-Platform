// @ts-check

import { BACKFILL_CONFIRMATION, BACKFILL_VERIFICATION_MARKER, REPLAY_CONFIRMATION, REPLAY_VERIFICATION_MARKER, createKnowledgeWorkflowBackfill, createKnowledgeWorkflowReplay } from "../src/features/knowledge-workflows/backfill.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

const source = Object.freeze({ id: "source-a", ownerId: "owner-a", submittedUrl: "https://example.test/lesson", canonicalUrl: "https://example.test/lesson", title: "Lesson", description: "Description", adapter: Object.freeze({ id: "adapter", version: "1", granularity: "root", capabilities: Object.freeze(["metadata"]) }), interestAreaIds: Object.freeze(["area-a"]), identityEvidence: Object.freeze([]), state: /** @type {const} */ ("active"), approvedAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", revision: 1 });

function command() { return { ownerId: "owner-a", configDigests: { "knowledge-scraper": "sha256:config" }, confirmation: BACKFILL_CONFIRMATION, verificationMarker: BACKFILL_VERIFICATION_MARKER }; }

Deno.test("existing-Library backfill requires both explicit confirmation and local verification", async () => {
  const backfill = createKnowledgeWorkflowBackfill({ list: async () => ({ ok: true, value: [source] }), start: async () => ({ ok: true, value: { runId: "run-a", reused: false } }), marker: { read: async () => ({ ok: true, value: null }), write: async () => ({ ok: true, value: null }) }, profileFor: () => null, now: () => "2026-08-17T00:00:00.000Z", logger: () => {} });
  const missing = await backfill.run({ ...command(), confirmation: "" });
  assertEquals(missing.ok, false);
  if (!missing.ok) assertEquals(missing.error.kind, "BackfillConfirmationRequired");
  const unverified = await backfill.run({ ...command(), verificationMarker: "" });
  assertEquals(unverified.ok, false);
  if (!unverified.ok) assertEquals(unverified.error.kind, "BackfillVerificationRequired");
});

Deno.test("existing-Library backfill starts each source with a stable idempotency key and writes one completion marker", async () => {
  /** @type {unknown[]} */ const starts = [];
  /** @type {unknown[]} */ const markers = [];
  const backfill = createKnowledgeWorkflowBackfill({ list: async () => ({ ok: true, value: [source] }), start: async (value) => { starts.push(value); return { ok: true, value: { runId: "run-a", reused: false } }; }, marker: { read: async () => ({ ok: true, value: null }), write: async (value) => { markers.push(value); return { ok: true, value: null }; } }, profileFor: () => /** @type {import("../src/features/source-library/rights-profile.js").SourceRightsProfile} */ ({ profileId: "profile-a" }), now: () => "2026-08-17T00:00:00.000Z", logger: () => {} });
  const result = await backfill.run(command());
  assertEquals(result.ok, true);
  assertEquals(starts.length, 1);
  assertEquals(/** @type {Record<string, unknown>} */ (starts[0]).idempotencyKey, "knowledge-workflow-backfill:source-a:1");
  assertEquals(markers.length, 1);
});

Deno.test("existing-Library backfill skips active sources without a server-owned open-source profile", async () => {
  /** @type {unknown[]} */ const starts = [];
  /** @type {unknown[]} */ const markers = [];
  const backfill = createKnowledgeWorkflowBackfill({ list: async () => ({ ok: true, value: [source, { ...source, id: "source-open", canonicalUrl: "https://open.example/lesson" }] }), start: async (value) => { starts.push(value); return { ok: true, value: { runId: "run-open", reused: false } }; }, marker: { read: async () => ({ ok: true, value: null }), write: async (value) => { markers.push(value); return { ok: true, value: null }; } }, profileFor: (canonicalUrl) => canonicalUrl === "https://open.example/lesson" ? /** @type {import("../src/features/source-library/rights-profile.js").SourceRightsProfile} */ ({ profileId: "profile-open" }) : null, now: () => "2026-08-17T00:00:00.000Z", logger: () => {} });
  const result = await backfill.run(command());
  assertEquals(result.ok, true);
  assertEquals(starts.length, 1);
  assertEquals(/** @type {Record<string, unknown>} */ (starts[0]).sourceId, "source-open");
  assertEquals(/** @type {Record<string, unknown>} */ (markers[0]).sourceCount, 1);
});

Deno.test("completed existing-Library backfill is replayed without listing or starting sources", async () => {
  let listed = 0;
  let started = 0;
  const backfill = createKnowledgeWorkflowBackfill({ list: async () => { listed += 1; return { ok: true, value: [source] }; }, start: async () => { started += 1; return { ok: true, value: { runId: "run-a", reused: true } }; }, marker: { read: async () => ({ ok: true, value: { ownerId: "owner-a", backfillKey: "knowledge-workflow-backfill-v1:owner-a", sourceCount: 1, runIds: ["run-a"], createdAt: "2026-08-17T00:00:00.000Z" } }), write: async () => ({ ok: true, value: null }) }, profileFor: () => null, now: () => "2026-08-17T00:00:00.000Z", logger: () => {} });
  const result = await backfill.run(command());
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.status, "already-completed");
  assertEquals(listed, 0);
  assertEquals(started, 0);
});

Deno.test("existing-Library backfill resets learner content before its one-time source pass", async () => {
  let resetOwner = null;
  const backfill = createKnowledgeWorkflowBackfill({
    list: async () => ({ ok: true, value: [source] }),
    start: async () => ({ ok: true, value: { runId: "run-a", reused: false } }),
    reset: async (ownerId) => { resetOwner = ownerId; return { ok: true, value: null }; },
    marker: { read: async () => ({ ok: true, value: null }), write: async () => ({ ok: true, value: null }) },
    profileFor: () => /** @type {import("../src/features/source-library/rights-profile.js").SourceRightsProfile} */ ({ profileId: "profile-a" }),
    now: () => "2026-08-19T00:00:00.000Z",
    logger: () => {},
  });
  const result = await backfill.run(command());
  assertEquals(result.ok, true);
  assertEquals(resetOwner, "owner-a");
});

Deno.test("existing-Library replay resets generated descendants and starts every active source with explicit blockers", async () => {
  /** @type {unknown[]} */ const starts = [];
  /** @type {unknown[]} */ const invalidations = [];
  /** @type {string[]} */ const events = [];
  const audioSource = { ...source, id: "source-audio", canonicalUrl: "https://audio.example/episode", adapter: { ...source.adapter, capabilities: ["audio", "metadata"] } };
  const replay = createKnowledgeWorkflowReplay({
    list: async () => ({ ok: true, value: [source, audioSource] }),
    start: async (value) => { starts.push(value); return { ok: true, value: { runId: `run-${starts.length}`, reused: false } }; },
    reset: async (ownerId) => { events.push(`reset:${ownerId}`); return { ok: true, value: null }; },
    invalidateReuse: async (value) => { invalidations.push(value); return { ok: true, value: null }; },
    marker: { read: async () => ({ ok: true, value: null }), write: async () => { events.push("marker-write"); return { ok: true, value: null }; } },
    profileFor: () => null,
    now: () => "2026-08-20T00:00:00.000Z",
    logger: () => {},
  });
  const result = await replay.run({ ownerId: "owner-a", configDigests: { "knowledge-scraper": "sha256:config" }, confirmation: REPLAY_CONFIRMATION, verificationMarker: REPLAY_VERIFICATION_MARKER });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.sourceCount, 2);
  assertEquals(result.value.runIds.length, 2);
  assertEquals(starts.length, 2);
  assertEquals(invalidations.length, 2);
  assertEquals(events[0], "reset:owner-a");
  assertEquals(/** @type {Record<string, unknown>} */ (starts[0]).idempotencyKey, "knowledge-workflow-replay-v22:source-a:1");
  assertEquals(result.value.blockedSources.length, 2);
  assertEquals(result.value.blockedSources[1].reasonCode, "audio-video-transcription-unavailable");
});

Deno.test("existing-Library replay is idempotent after its completion marker is written", async () => {
  let resetCount = 0;
  let startCount = 0;
  const replay = createKnowledgeWorkflowReplay({
    list: async () => ({ ok: true, value: [] }),
    start: async () => { startCount += 1; return { ok: true, value: { runId: "unexpected", reused: false } }; },
    reset: async () => { resetCount += 1; return { ok: true, value: null }; },
    marker: {
      read: async (ownerId, backfillKey) => {
        assertEquals(ownerId, "owner-a");
        assertEquals(backfillKey, "knowledge-workflow-replay-v22:owner-a");
        return { ok: true, value: { ownerId: "owner-a", backfillKey: "knowledge-workflow-replay-v22:owner-a", sourceCount: 2, runIds: ["run-a", "run-b"], createdAt: "2026-08-20T00:00:00.000Z" } };
      },
      write: async () => ({ ok: true, value: null }),
    },
    profileFor: () => null,
    now: () => "2026-08-20T00:00:00.000Z",
    logger: () => {},
  });
  const result = await replay.run({ ownerId: "owner-a", confirmation: REPLAY_CONFIRMATION, verificationMarker: REPLAY_VERIFICATION_MARKER, configDigests: { workflow: "digest" } });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.status, "already-completed");
  assertEquals(resetCount, 0);
  assertEquals(startCount, 0);
});

Deno.test("repair replay ignores the previous replay marker and starts a new workflow generation", async () => {
  /** @type {string[]} */ const markerKeys = [];
  /** @type {unknown[]} */ const starts = [];
  const replay = createKnowledgeWorkflowReplay({
    list: async () => ({ ok: true, value: [source] }),
    start: async (value) => { starts.push(value); return { ok: true, value: { runId: "run-v3", reused: false } }; },
    reset: async () => ({ ok: true, value: null }),
    marker: {
      read: async (ownerId, backfillKey) => {
        markerKeys.push(`${ownerId}:${backfillKey}`);
        return backfillKey === "knowledge-workflow-replay-v4:owner-a"
          ? { ok: true, value: { ownerId, backfillKey, sourceCount: 1, runIds: ["old-run"], createdAt: "2026-08-20T00:00:00.000Z" } }
          : { ok: true, value: null };
      },
      write: async (marker) => {
        assertEquals(marker.backfillKey, "knowledge-workflow-replay-v22:owner-a");
        return { ok: true, value: null };
      },
    },
    profileFor: () => /** @type {import("../src/features/source-library/rights-profile.js").SourceRightsProfile} */ ({ profileId: "profile-a" }),
    now: () => "2026-08-24T00:00:00.000Z",
    logger: () => {},
  });
  const result = await replay.run({ ownerId: "owner-a", confirmation: REPLAY_CONFIRMATION, verificationMarker: REPLAY_VERIFICATION_MARKER, configDigests: { workflow: "digest" } });
  assertEquals(result.ok, true);
  assertEquals(markerKeys[0], "owner-a:knowledge-workflow-replay-v22:owner-a");
  assertEquals(starts.length, 1);
  assertEquals(/** @type {Record<string, unknown>} */ (starts[0]).idempotencyKey, "knowledge-workflow-replay-v22:source-a:1");
});
