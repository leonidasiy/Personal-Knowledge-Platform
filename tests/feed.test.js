// @ts-check

import { decodeCursor, encodeCursor } from "../src/features/feed/contracts.js";
import { rankCandidates } from "../src/features/feed/ranker.js";
import { FeedService } from "../src/features/feed/service.js";
import { createFeedSourceEligibility } from "../src/startup/local-runtime.js";

/** @import { FeedCandidate, FeedPolicy } from "../src/features/feed/contracts.js" */

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

/** @type {FeedPolicy} */
const policy = Object.freeze({
  maxPageSize: 2,
  cursorLifetimeMs: 60_000,
  preferenceWeight: 0.45,
  exposurePenalty: 0.12,
  masteryPenalty: 0.4,
  dueBoost: 2,
  explorationFloor: 0.08,
  version: "fixture-ranking-v1",
});

/** @type {readonly FeedCandidate[]} */
const candidates = Object.freeze([
  {
    candidateId: "a",
    sourceId: null,
    title: "A",
    knowledgeUnitIds: ["k-a"],
    eligible: true,
    signals: {
      preference: 0,
      qualifiedExposures: 0,
      mastery: null,
      dueAt: null,
    },
  },
  {
    candidateId: "b",
    sourceId: null,
    title: "B",
    knowledgeUnitIds: ["k-b"],
    eligible: true,
    signals: {
      preference: 0.5,
      qualifiedExposures: 0,
      mastery: null,
      dueAt: null,
    },
  },
  {
    candidateId: "c",
    sourceId: null,
    title: "C",
    knowledgeUnitIds: ["k-c"],
    eligible: true,
    signals: {
      preference: 0,
      qualifiedExposures: 1,
      mastery: 0.7,
      dueAt: null,
    },
  },
]);

const available = () => true;
const eligible = () => ({
  ok: /** @type {const} */ (true),
  value: /** @type {const} */ (true),
});

Deno.test("feed pages are bounded, stable, and duplicate-free", () => {
  const service = new FeedService(
    candidates,
    policy,
    () => "session-1",
    available,
    eligible,
  );
  const first = service.getPage({
    ownerId: "owner-a",
    limit: 2,
    now: "2026-07-19T00:00:00.000Z",
  });
  assertEquals(first.ok, true);
  if (!first.ok) return;
  assertEquals(first.value.items.length, 2);
  assertEquals(first.value.hasMore, true);
  assert(first.value.nextCursor !== null, "Expected a continuation cursor.");

  const second = service.getPage({
    ownerId: "owner-a",
    sessionId: first.value.sessionId,
    cursor: first.value.nextCursor ?? undefined,
    limit: 2,
    now: "2026-07-19T00:00:01.000Z",
  });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  const ids = [...first.value.items, ...second.value.items].map((item) =>
    item.candidateId
  );
  assertEquals(new Set(ids).size, ids.length);
  assertEquals(second.value.hasMore, false);
});

Deno.test("feed rejects invalid page limits", () => {
  const service = new FeedService(
    candidates,
    policy,
    () => "session-1",
    available,
    eligible,
  );
  const result = service.getPage({
    ownerId: "owner-a",
    limit: 3,
    now: "2026-07-19T00:00:00.000Z",
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "InvalidPageLimit");
});

Deno.test("feed rejects wrong-owner and expired cursors distinctly", () => {
  const cursor = encodeCursor({
    ownerId: "owner-a",
    sessionId: "session-1",
    offset: 1,
    expiresAt: "2026-07-19T00:01:00.000Z",
  });
  assertEquals(decodeCursor(cursor).ok, true);
  const service = new FeedService(
    candidates,
    policy,
    () => "unused",
    available,
    eligible,
  );
  const wrongOwner = service.getPage({
    ownerId: "owner-b",
    cursor,
    limit: 1,
    now: "2026-07-19T00:00:30.000Z",
  });
  assertEquals(wrongOwner.ok, false);
  if (!wrongOwner.ok) {
    assertEquals(wrongOwner.error.kind, "CursorOwnerMismatch");
  }

  const expired = service.getPage({
    ownerId: "owner-a",
    cursor,
    limit: 1,
    now: "2026-07-19T00:01:00.000Z",
  });
  assertEquals(expired.ok, false);
  if (!expired.ok) assertEquals(expired.error.kind, "CursorExpired");
});

Deno.test("disabled source descendants are excluded from new and continued Feed pages", () => {
  const sourced = candidates.map((candidate) => ({
    ...candidate,
    sourceId: `source-${candidate.candidateId}`,
  }));
  let disabled = new Set(["source-b"]);
  const service = new FeedService(
    sourced,
    policy,
    () => "source-session",
    available,
    (_ownerId, sourceId, candidateId) =>
      disabled.has(sourceId)
        ? { ok: false, error: { kind: "CandidateSourceDisabled", candidateId } }
        : { ok: true, value: true },
  );
  const first = service.getPage({
    ownerId: "owner-a",
    limit: 1,
    now: "2026-07-19T00:00:00.000Z",
  });
  assertEquals(first.ok, true);
  if (!first.ok) throw new Error(first.error.kind);
  assertEquals(
    first.value.items.some((item) => item.candidateId === "b"),
    false,
  );
  disabled = new Set(["source-b", "source-a", "source-c"]);
  const continued = service.getPage({
    ownerId: "owner-a",
    sessionId: first.value.sessionId,
    cursor: first.value.nextCursor ?? undefined,
    limit: 1,
    now: "2026-07-19T00:00:01.000Z",
  });
  assertEquals(continued.ok, false);
  if (continued.ok) throw new Error("Expected disabled source failure.");
  assertEquals(continued.error.kind, "CandidateSourceDisabled");
});

Deno.test("source eligibility read failure never falls back to eligible", () => {
  const service = new FeedService(
    candidates.map((candidate) => ({
      ...candidate,
      sourceId: `source-${candidate.candidateId}`,
    })),
    policy,
    () => "failed-source-session",
    available,
    () => ({ ok: false, error: { kind: "SourceEligibilityUnavailable" } }),
  );
  const result = service.getPage({
    ownerId: "owner-a",
    limit: 1,
    now: "2026-07-19T00:00:00.000Z",
  });
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("Expected eligibility failure.");
  assertEquals(result.error.kind, "SourceEligibilityUnavailable");
});

Deno.test("Feed composition resolves active Library sources before ranking", async () => {
  let body = "";
  const projection = await createFeedSourceEligibility({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      body = await request.text();
      return Response.json({ result: ["source-a"] });
    },
    baseUrl: "https://app.example/",
    ownerId: "owner-a",
    candidates: candidates.slice(0, 2).map((candidate) => ({
      ...candidate,
      sourceId: `source-${candidate.candidateId}`,
    })),
  });
  assertEquals(projection.ok, true);
  if (!projection.ok) throw new Error(projection.error.kind);
  assert(
    body.includes("source-a") && body.includes("source-b"),
    "All source identities must be checked together.",
  );
  assertEquals(projection.value("owner-a", "source-a", "a").ok, true);
  const disabled = projection.value("owner-a", "source-b", "b");
  assertEquals(disabled.ok, false);
  if (!disabled.ok) {
    assertEquals(disabled.error.kind, "CandidateSourceDisabled");
  }
  const wrongOwner = projection.value("owner-b", "source-a", "a");
  assertEquals(wrongOwner.ok, false);
  if (!wrongOwner.ok) {
    assertEquals(wrongOwner.error.kind, "SourceEligibilityUnavailable");
  }
});

Deno.test("ranking keeps preference, exposure, and mastery counterfactually separate", () => {
  const baseline =
    rankCandidates([candidates[0]], policy, "2026-07-19T00:00:00.000Z")[0];
  const preferred = rankCandidates(
    [
      {
        ...candidates[0],
        signals: { ...candidates[0].signals, preference: 1 },
      },
    ],
    policy,
    "2026-07-19T00:00:00.000Z",
  )[0];
  const exposed = rankCandidates(
    [
      {
        ...candidates[0],
        signals: { ...candidates[0].signals, qualifiedExposures: 1 },
      },
    ],
    policy,
    "2026-07-19T00:00:00.000Z",
  )[0];
  const mastered = rankCandidates(
    [
      { ...candidates[0], signals: { ...candidates[0].signals, mastery: 1 } },
    ],
    policy,
    "2026-07-19T00:00:00.000Z",
  )[0];
  assert(
    preferred.score > baseline.score,
    "Preference should increase affinity.",
  );
  assert(exposed.score < baseline.score, "Exposure should increase fatigue.");
  assert(
    mastered.score < baseline.score,
    "Mastery should reduce explanation frequency.",
  );
});

Deno.test("due recall remains eligible despite low preference and exposure", () => {
  const ranked = rankCandidates(
    [
      {
        ...candidates[0],
        signals: {
          preference: -1,
          qualifiedExposures: 10,
          mastery: 1,
          dueAt: "2026-07-18T00:00:00.000Z",
        },
      },
    ],
    policy,
    "2026-07-19T00:00:00.000Z",
  );
  assertEquals(ranked.length, 1);
  assertEquals(ranked[0].whyShown, "Your recall is due.");
  assert(
    ranked[0].score > policy.explorationFloor,
    "Due boost should restore eligibility.",
  );
});
