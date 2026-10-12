// @ts-check

import { createExtractionRunner } from "../src/features/knowledge-workflows/extraction.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

function setup() {
  let now = 0;
  /** @type {import("../src/features/knowledge-workflows/extraction.js").ExtractionScratchpad} */
  let scratchpad = {
    ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1,
    processedUrls: [], acceptedHashes: [], similarityEvidence: [], coverage: [], unresolvedGaps: [],
    consecutiveNoveltyZero: 0, revision: 1,
  };
  /** @type {import("../src/features/knowledge-workflows/extraction.js").KnowledgePoint[]} */
  const points = [];
  /** @type {import("../src/features/knowledge-workflows/extraction.js").ExtractionDependencies} */
  const dependencies = {
    rights: { status: "allowed", sourceId: "source-a", sourceRevision: 1 },
    robots: { status: "allowed" },
    planner: {
      async plan() { return { ok: true, value: { revision: 1, frontier: ["https://example.test/a"], coverageGoals: [{ id: "goal-a", priority: "high", description: "core concept" }], unresolvedGaps: [], stopDecision: { decision: "continue", rationale: "The root page is the first relevant page to observe.", evidenceUrls: ["https://example.test/a"], unresolvedGapIds: [] } } }; },
      /** @param {{ readonly observation: { readonly url: string, readonly links: readonly string[] }, readonly previous: { readonly revision: number, readonly coverageGoals: readonly { readonly id: string, readonly priority: "high" | "normal", readonly description: string }[] } }} command */
      async replan(command) { return { ok: true, value: { revision: command.previous.revision + 1, frontier: command.observation.links, coverageGoals: command.previous.coverageGoals, unresolvedGaps: [], stopDecision: { decision: command.observation.links.length === 0 ? "complete" : "continue", rationale: command.observation.links.length === 0 ? "The agent observed no remaining relevant links." : "The observed page exposed another relevant same-origin page.", evidenceUrls: [command.observation.url], unresolvedGapIds: [] } } }; },
    },
    acquirer: {
      /** @param {{ readonly url: string }} command */
      async fetchPage(command) {
        const page = command.url.endsWith("/a")
          ? { url: command.url, title: "A", byteCount: 100, redirects: 0, links: ["https://example.test/b"], observedAt: "2026-08-13T00:00:00.000Z", candidates: [{ summary: "Core concept", normalizedHash: "hash-a", evidenceAnchors: [{ url: command.url, selector: "#a", quoteDigest: "sha256:evidence-a" }], coverageGoalIds: ["goal-a"], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }] }
          : command.url.endsWith("/b")
          ? { url: command.url, title: "B", byteCount: 100, redirects: 0, links: ["https://example.test/c"], observedAt: "2026-08-13T00:00:00.000Z", candidates: [] }
          : { url: command.url, title: "C", byteCount: 100, redirects: 0, links: [], observedAt: "2026-08-13T00:00:00.000Z", candidates: [] };
        return { ok: true, value: page };
      },
    },
    scratchpad: {
      async load() { return { ok: true, value: scratchpad }; },
      /** @param {import("../src/features/knowledge-workflows/extraction.js").ExtractionScratchpad} value */
      async save(value) { scratchpad = value; return { ok: true, value: null }; },
    },
    knowledge: {
      /** @param {import("../src/features/knowledge-workflows/extraction.js").KnowledgePoint} value */
      async append(value) { points.push(value); return { ok: true, value: null }; },
    },
    now: () => "2026-08-13T00:00:00.000Z",
    nowMs: () => now,
    logger: () => {},
    policy: { maximumFrontier: 10, maximumPageBytes: 1_000, maximumRedirects: 2, maximumPages: 10, maximumDurationMs: 1_800_000 },
  };
  return {
    points,
    /** @param {number} milliseconds */
    advance(milliseconds) { now += milliseconds; },
    runner: createExtractionRunner(dependencies),
    dependencies,
  };
}

Deno.test("five-page extraction batches checkpoint before consumption and resume with a smaller tail", async () => {
  const fixture = setup();
  const urls = Array.from({ length: 7 }, (_, index) => `https://example.test/${index}`);
  /** @type {string[][]} */
  const calls = [];
  let paused = true;
  let plans = 0;
  /** @type {import("../src/features/knowledge-workflows/extraction.js").ExtractionDependencies} */
  const dependencies = {
    ...fixture.dependencies,
    stopRequested: () => paused,
    planner: {
      async plan() { plans++; return { ok: true, value: { revision: 1, frontier: urls, coverageGoals: [], unresolvedGaps: [], stopDecision: { decision: "continue", rationale: "Read supplied pages.", evidenceUrls: [], unresolvedGapIds: [] } } }; },
      async replan({ previous, scratchpad }) { return { ok: true, value: { ...previous, frontier: urls.filter((url) => !scratchpad.processedUrls.includes(url)), stopDecision: { decision: scratchpad.processedUrls.length === urls.length ? "complete" : "continue", rationale: "Track supplied inventory.", evidenceUrls: [], unresolvedGapIds: [] } } }; },
    },
    batchAcquirer: {
      key: "material-and-config-digest",
      async fetchBatch({ urls: batchUrls }) {
        calls.push([...batchUrls]);
        return { ok: true, value: batchUrls.map((url) => ({ url, title: url, byteCount: 10, redirects: 0, links: [], observedAt: fixture.dependencies.now(), notes: "Brief progress, no raw text.", candidates: url.endsWith("/0") ? [{ summary: "A supported relationship.", normalizedHash: "batch-point", evidenceAnchors: [{ url, selector: "page:1" }], coverageGoalIds: [], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }] : [] })) };
      },
    },
  };
  const command = { ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 };
  const first = await createExtractionRunner(dependencies).run(command);
  assertEquals(first.ok, true);
  if (!first.ok) return;
  assertEquals(first.value.pagesProcessed, 1);
  assertEquals(first.value.scratchpad.pendingBatch?.observations.length, 4);
  assertEquals(calls[0].length, 5);
  const changed = await createExtractionRunner({ ...dependencies, batchAcquirer: { ...dependencies.batchAcquirer, key: "changed-input", fetchBatch: async () => { throw new Error("Changed input must not be fetched."); } } }).run(command);
  assertEquals(changed.ok, false);
  if (!changed.ok) assertEquals(changed.error.kind, "ExtractionObservationInvalid");
  paused = false;
  const resumed = await createExtractionRunner(dependencies).run(command);
  assertEquals(resumed.ok, true);
  if (!resumed.ok) return;
  assertEquals(resumed.value.state, "completed");
  assertEquals(resumed.value.pagesProcessed, 7);
  assertEquals(JSON.stringify(calls.map((batch) => batch.length)), "[5,2]");
  assertEquals(plans, 1);
  assertEquals(fixture.points.length, 1);
  assertEquals(resumed.value.scratchpad.pendingBatch, undefined);
});

Deno.test("image-mode extraction can force one-page acquisition batches", async () => {
  const fixture = setup();
  const urls = ["https://example.test/one", "https://example.test/two", "https://example.test/three"];
  /** @type {number[]} */ const batchSizes = [];
  const runner = createExtractionRunner({
    ...fixture.dependencies,
    planner: {
      async plan() { return { ok: true, value: { revision: 1, frontier: urls, coverageGoals: [], unresolvedGaps: [], stopDecision: { decision: "continue", rationale: "Observe each supplied image.", evidenceUrls: [], unresolvedGapIds: [] } } }; },
      async replan({ previous, scratchpad }) { const remaining = urls.filter((url) => !scratchpad.processedUrls.includes(url)); return { ok: true, value: { ...previous, frontier: remaining, stopDecision: { decision: remaining.length === 0 ? "complete" : "continue", rationale: "Continue through each image.", evidenceUrls: [], unresolvedGapIds: [] } } }; },
    },
    batchAcquirer: {
      key: "image-mode",
      maximumBatchSize: 1,
      async fetchBatch({ urls: batch }) { batchSizes.push(batch.length); return { ok: true, value: batch.map((url) => ({ url, title: "Image", byteCount: 10, redirects: 0, links: [], observedAt: fixture.dependencies.now(), candidates: [] })) }; },
    },
  });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgeSetEmpty");
  assertEquals(JSON.stringify(batchSizes), JSON.stringify([1, 1, 1]));
});

Deno.test("extraction replans, commits cited knowledge, and preserves the agent-selected stop", async () => {
  const fixture = setup();
  const result = await fixture.runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.state, "completed");
  assertEquals(fixture.points.length, 1);
  assertEquals(fixture.points[0].evidenceAnchors[0].selector, "#a");
  assertEquals(Object.hasOwn(fixture.points[0], "classification"), false);
  assertEquals(result.value.scratchpad.consecutiveNoveltyZero, 2);
  assertEquals(result.value.scratchpad.processedUrls.join(","), "https://example.test/a,https://example.test/b,https://example.test/c");
  assertEquals(result.value.scratchpad.discoveredUrls?.join(","), "https://example.test/a,https://example.test/b,https://example.test/c");
});

Deno.test("extraction starts the planner frontier when a fresh persisted frontier is empty", async () => {
  const fixture = setup();
  /** @type {import("../src/features/knowledge-workflows/extraction.js").ExtractionScratchpad} */
  let persisted = {
    ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1,
    processedUrls: [], frontier: [], discoveredUrls: [], acceptedHashes: [],
    similarityEvidence: [], coverage: [], unresolvedGaps: [], pageNotes: [],
    consecutiveNoveltyZero: 0, revision: 1,
  };
  const runner = createExtractionRunner({
    ...fixture.dependencies,
    scratchpad: {
      async load() { return { ok: true, value: persisted }; },
      async save(value) { persisted = value; return { ok: true, value: null }; },
    },
  });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.state, "completed");
  assertEquals(result.value.scratchpad.processedUrls.join(","), "https://example.test/a,https://example.test/b,https://example.test/c");
});

Deno.test("extraction preserves every discovered branch when a replan declares completion early", async () => {
  const fixture = setup();
  const pages = new Map([
    ["https://example.test/a", ["https://example.test/b", "https://example.test/c"]],
    ["https://example.test/b", []],
    ["https://example.test/c", []],
  ]);
  const runner = createExtractionRunner({
    ...fixture.dependencies,
    planner: {
      async plan() { return { ok: true, value: { revision: 1, frontier: ["https://example.test/a"], coverageGoals: [{ id: "goal-a", priority: "high", description: "core concept" }], unresolvedGaps: [], stopDecision: { decision: "continue", rationale: "Observe the root before deciding whether the source is covered.", evidenceUrls: [], unresolvedGapIds: [] } } }; },
      async replan(command) { return { ok: true, value: { revision: command.previous.revision + 1, frontier: [], coverageGoals: command.previous.coverageGoals, unresolvedGaps: [], stopDecision: { decision: "complete", rationale: "The model incorrectly omitted discovered branches.", evidenceUrls: [command.observation.url], unresolvedGapIds: [] } } }; },
    },
    acquirer: {
      async fetchPage(command) {
        const links = pages.get(command.url);
        if (links === undefined) return { ok: false, error: { kind: "UnexpectedPage" } };
        return { ok: true, value: { url: command.url, title: command.url, byteCount: 100, redirects: 0, links, observedAt: "2026-08-13T00:00:00.000Z", candidates: command.url.endsWith("/a") ? [{ summary: "Core concept", normalizedHash: "hash-a", evidenceAnchors: [{ url: command.url, selector: "main" }], coverageGoalIds: ["goal-a"], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }] : [] } };
      },
    },
  });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.state, "completed");
  assertEquals(result.value.scratchpad.processedUrls.join(","), "https://example.test/a,https://example.test/b,https://example.test/c");
});

Deno.test("extraction completes when a covered frontier is exhausted", async () => {
  const fixture = setup();
  const runner = createExtractionRunner({ ...fixture.dependencies, planner: {
    async plan() { return { ok: true, value: { revision: 1, frontier: ["https://example.test/a"], coverageGoals: [{ id: "goal-a", priority: "high", description: "core concept" }], unresolvedGaps: [], stopDecision: { decision: "continue", rationale: "Observe the planned root page.", evidenceUrls: ["https://example.test/a"], unresolvedGapIds: [] } } }; },
    async replan() { return { ok: true, value: { revision: 2, frontier: [], coverageGoals: [{ id: "goal-a", priority: "high", description: "core concept" }], unresolvedGaps: [], stopDecision: { decision: "complete", rationale: "The only relevant page has been observed and the goal is covered.", evidenceUrls: ["https://example.test/a"], unresolvedGapIds: [] } } }; },
  }, acquirer: { async fetchPage(command) { return { ok: true, value: { url: command.url, title: "A", byteCount: 100, redirects: 0, links: [], observedAt: "2026-08-13T00:00:00.000Z", candidates: [{ summary: "Core concept", normalizedHash: "hash-a", evidenceAnchors: [{ url: command.url, selector: "#a" }], coverageGoalIds: ["goal-a"], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }] } }; } } });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.state, "completed");
  assertEquals(result.value.pagesProcessed, 1);
  assertEquals(fixture.points.length, 1);
});

Deno.test("extraction rejects an agent complete decision while relevant frontier work remains", async () => {
  const fixture = setup();
  const runner = createExtractionRunner({
    ...fixture.dependencies,
    planner: {
      async plan() { return { ok: true, value: { revision: 1, frontier: ["https://example.test/a"], coverageGoals: [], unresolvedGaps: [], stopDecision: { decision: "complete", rationale: "The agent incorrectly declared completion before observing the frontier.", evidenceUrls: [], unresolvedGapIds: [] } } }; },
      async replan() { throw new Error("must not replan"); },
    },
  });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "ExtractionCoverageIncomplete");
});

Deno.test("extraction persists bounded page notes and durable scraper memory checkpoints", async () => {
  const fixture = setup();
  /** @type {Record<string, unknown>[]} */ const records = [];
  const runner = createExtractionRunner({
    ...fixture.dependencies,
    memory: {
      async append(record) { records.push(record); return { ok: true, value: null }; },
    },
  });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(Array.isArray(result.value.scratchpad.pageNotes), true);
  assertEquals(result.value.scratchpad.pageNotes?.length, 3);
  assertEquals(records.some((record) => record.kind === "durable-fact"), true);
  assertEquals(records.some((record) => record.kind === "decision"), true);
  const accepted = records.find((record) => record.kind === "durable-fact" && typeof record.payload === "object" && record.payload !== null && "phase" in record.payload && record.payload.phase === "knowledge-accepted");
  if (accepted === undefined || typeof accepted.payload !== "object" || accepted.payload === null) throw new Error("Accepted knowledge memory was not recorded.");
  assertEquals(JSON.stringify(accepted.payload), JSON.stringify({ phase: "knowledge-accepted", knowledgeId: "knowledge:source-a:1:hash-a", normalizedHash: "hash-a", evidenceDigests: ["sha256:evidence-a"], coverageGoalIds: ["goal-a"], sourceUrl: "https://example.test/a" }));
  assertEquals(JSON.stringify(accepted.payload).includes("Core concept"), false);
});

Deno.test("extraction yields after one page and resumes from the persisted replanned frontier", async () => {
  const fixture = setup();
  const runner = createExtractionRunner({ ...fixture.dependencies, policy: { ...fixture.dependencies.policy, maximumPagesPerExecution: 1 } });
  const first = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(first.ok, true);
  if (!first.ok) return;
  assertEquals(first.value.state, "awaiting-time-limit-decision");
  assertEquals(first.value.pagesProcessed, 1);
  assertEquals(first.value.scratchpad.frontier?.join(","), "https://example.test/b");

  const second = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assertEquals(second.value.state, "awaiting-time-limit-decision");
  assertEquals(second.value.pagesProcessed, 2);
  assertEquals(second.value.scratchpad.frontier?.join(","), "https://example.test/c");

  const third = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(third.ok, true);
  if (third.ok) assertEquals(third.value.state, "completed");
  assertEquals(third.ok ? third.value.pagesProcessed : -1, 3);
});

Deno.test("extraction traverses a twelve-page content chain across bounded chunks", async () => {
  for (const maximumPagesPerExecution of [2, 5]) {
    const fixture = setup();
    const pages = Array.from({ length: 12 }, (_, index) => `https://example.test/page-${index + 1}`);
    /** @param {string} url @param {number} revision @param {boolean} [complete] @returns {{ readonly revision: number, readonly frontier: readonly string[], readonly coverageGoals: readonly { readonly id: string, readonly priority: "high" | "normal", readonly description: string }[], readonly unresolvedGaps: readonly { readonly id: string, readonly priority: "high" | "normal", readonly description: string }[], readonly stopDecision: import("../src/features/knowledge-workflows/extraction.js").ExtractionStopDecision }} */
    const planFor = (url, revision, complete = false) => ({
      revision,
      frontier: complete ? [] : [url],
      coverageGoals: [{ id: "goal-a", priority: "high", description: "all linked sections" }],
      unresolvedGaps: [],
      stopDecision: {
        decision: complete ? "complete" : "continue",
        rationale: complete ? "All twelve linked content pages were observed and the coverage goal is complete." : "The source inventory still contains another linked content page.",
        evidenceUrls: [url],
        unresolvedGapIds: [],
      },
    });
    const runner = createExtractionRunner({
      ...fixture.dependencies,
      planner: {
        async plan(command) {
          const next = pages.find((url) => !command.scratchpad.processedUrls.includes(url)) ?? pages.at(-1);
          return { ok: true, value: planFor(/** @type {string} */ (next), command.scratchpad.revision) };
        },
        async replan(command) {
          const next = command.observation.links.find((url) => !command.scratchpad.processedUrls.includes(url));
          return { ok: true, value: next === undefined ? planFor(command.observation.url, command.previous.revision + 1, true) : planFor(next, command.previous.revision + 1) };
        },
      },
      acquirer: {
        async fetchPage(command) {
          const index = pages.indexOf(command.url);
          const next = pages[index + 1];
          return { ok: true, value: { url: command.url, title: `Page ${index + 1}`, byteCount: 100, redirects: 0, links: next === undefined ? [] : [next], observedAt: "2026-08-13T00:00:00.000Z", candidates: [{ summary: `Section ${index + 1}`, normalizedHash: `hash-${index + 1}`, evidenceAnchors: [{ url: command.url, selector: "main" }], coverageGoalIds: ["goal-a"], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }] } };
        },
      },
      policy: { ...fixture.dependencies.policy, maximumFrontier: 20, maximumPages: 20, maximumPagesPerExecution },
    });
    let result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value.pagesProcessed, maximumPagesPerExecution);
    while (result.ok && result.value.state !== "completed") {
      const previousTotal = result.value.pagesProcessed;
      result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
      assertEquals(result.ok, true);
      if (!result.ok) return;
      assertEquals(result.value.pagesProcessed, Math.min(previousTotal + maximumPagesPerExecution, pages.length));
    }
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value.state, "completed");
    assertEquals(result.value.pagesProcessed, 12);
    assertEquals(result.value.scratchpad.processedUrls.length, 12);
    assertEquals(result.value.scratchpad.discoveredUrls?.length, 12);
    assertEquals(fixture.points.length, 12);
  }
});

Deno.test("extraction rejects a non-positive per-execution page limit", () => {
  const fixture = setup();
  let threw = false;
  try {
    createExtractionRunner({ ...fixture.dependencies, policy: { ...fixture.dependencies.policy, maximumPagesPerExecution: 0 } });
  } catch (error) {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("extraction fails closed before acquisition and at the exact deadline", async () => {
  const fixture = setup();
  let fetches = 0;
  const blocked = createExtractionRunner({ ...fixture.dependencies, rights: { status: "awaiting-review", sourceId: "source-a", sourceRevision: 1 }, acquirer: { fetchPage: async () => { fetches += 1; throw new Error("must not fetch"); } } });
  const blockedResult = await blocked.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(blockedResult.ok, false);
  if (!blockedResult.ok) assertEquals(blockedResult.error.kind, "ExtractionRightsNotAllowed");
  assertEquals(fetches, 0);
  fixture.advance(1_800_000);
  const timed = await fixture.runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(timed.ok, true);
  if (timed.ok) assertEquals(timed.value.state, "awaiting-time-limit-decision");
});

Deno.test("extraction preserves a named browser access block for the workflow upload fallback", async () => {
  const fixture = setup();
  const runner = createExtractionRunner({
    ...fixture.dependencies,
    acquirer: { fetchPage: async () => ({ ok: false, error: { kind: "KnowledgePageBotAccessDenied", diagnosticToken: "native-http-403" } }) },
  });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "ExtractionAcquisitionFailed");
    if (result.error.kind === "ExtractionAcquisitionFailed") {
      assertEquals(result.error.causeKind, "KnowledgePageBotAccessDenied");
      assertEquals(result.error.diagnosticToken, "native-http-403");
    }
  }
});

Deno.test("extraction checks robots for each planned page before browser acquisition", async () => {
  const fixture = setup();
  let acquired = 0;
  /** @type {string[]} */ const checked = [];
  const runner = createExtractionRunner({
    ...fixture.dependencies,
    checkRobots: async (url) => {
      checked.push(url);
      return { ok: false, error: { kind: "RobotsDenied", rule: "/private" } };
    },
    acquirer: { fetchPage: async () => { acquired += 1; throw new Error("must not acquire a robots-denied page"); } },
  });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "ExtractionAcquisitionFailed");
    if (result.error.kind === "ExtractionAcquisitionFailed") assertEquals(result.error.causeKind, "RobotsDenied");
  }
  assertEquals(checked.join(","), "https://example.test/a");
  assertEquals(acquired, 0);
});

Deno.test("extraction rejects duplicate and ambiguous near-duplicate points", async () => {
  const fixture = setup();
  const runner = createExtractionRunner({
    rights: { status: "allowed", sourceId: "source-a", sourceRevision: 1 }, robots: { status: "allowed" },
    planner: { async plan() { return { ok: true, value: { revision: 1, frontier: ["https://example.test/a"], coverageGoals: [], unresolvedGaps: [], stopDecision: { decision: "continue", rationale: "Observe the candidate page.", evidenceUrls: ["https://example.test/a"], unresolvedGapIds: [] } } }; }, async replan() { return { ok: true, value: { revision: 2, frontier: [], coverageGoals: [], unresolvedGaps: [], stopDecision: { decision: "complete", rationale: "No remaining relevant pages are known.", evidenceUrls: ["https://example.test/a"], unresolvedGapIds: [] } } }; } },
    acquirer: { async fetchPage() { return { ok: true, value: { url: "https://example.test/a", title: "A", byteCount: 10, redirects: 0, links: [], observedAt: "2026-08-13T00:00:00.000Z", candidates: [{ summary: "Same", normalizedHash: "same", evidenceAnchors: [{ url: "https://example.test/a", selector: "#a" }], coverageGoalIds: [], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }, { summary: "Near", normalizedHash: "near", evidenceAnchors: [{ url: "https://example.test/a", selector: "#b" }], coverageGoalIds: [], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" }, similarity: { comparedLocalHash: "same", score: 0.99, decision: "ambiguous" } }] } }; } },
    scratchpad: { async load() { return { ok: true, value: { ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, processedUrls: [], acceptedHashes: ["same"], similarityEvidence: [], coverage: [], unresolvedGaps: [], consecutiveNoveltyZero: 0, revision: 1 } }; }, async save() { return { ok: true, value: null }; } },
    knowledge: { async append() { return { ok: true, value: null }; } }, now: () => "2026-08-13T00:00:00.000Z", nowMs: () => 0, logger: () => {}, policy: { maximumFrontier: 10, maximumPageBytes: 100, maximumRedirects: 2, maximumPages: 10, maximumDurationMs: 1_800_000 },
  });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgeDuplicateAmbiguous");
});

Deno.test("extraction rejects candidate evidence and coverage not grounded on the observed page", async () => {
  const fixture = setup();
  const runner = createExtractionRunner({
    ...fixture.dependencies,
    acquirer: { async fetchPage(command) { return { ok: true, value: { url: command.url, title: "A", byteCount: 10, redirects: 0, links: ["https://example.test/b"], observedAt: "2026-08-13T00:00:00.000Z", candidates: [{ summary: "Unsupported", normalizedHash: "unsupported", evidenceAnchors: [{ url: "https://example.test/b", selector: "main" }], coverageGoalIds: ["invented-goal"], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }] } }; } },
  });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "ExtractionObservationInvalid");
    if (result.error.kind === "ExtractionObservationInvalid") assertEquals(result.error.field, "evidenceAnchors");
  }
  assertEquals(fixture.points.length, 0);
});

Deno.test("extraction rejects candidate coverage absent from the active plan", async () => {
  const fixture = setup();
  const runner = createExtractionRunner({
    ...fixture.dependencies,
    acquirer: { async fetchPage(command) { return { ok: true, value: { url: command.url, title: "A", byteCount: 10, redirects: 0, links: [], observedAt: "2026-08-13T00:00:00.000Z", candidates: [{ summary: "Unsupported", normalizedHash: "unsupported", evidenceAnchors: [{ url: command.url, selector: "main" }], coverageGoalIds: ["invented-goal"], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }] } }; } },
  });
  const result = await runner.run({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://example.test", startedAtMs: 0, deadlineAtMs: 1_800_000 });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "ExtractionObservationInvalid");
    if (result.error.kind === "ExtractionObservationInvalid") assertEquals(result.error.field, "coverageGoalIds");
  }
  assertEquals(fixture.points.length, 0);
});

Deno.test("quality-dropped knowledge contributes no accepted hashes or coverage and completes after extraction continues", async () => {
  const fixture=setup();
  let reviews=0;
  const runner=createExtractionRunner({...fixture.dependencies,reviewer:{review:async()=>{reviews++;return {ok:true,value:null};}}});
  const result=await runner.run({ownerId:"owner-a",runId:"run-a",sourceId:"source-a",sourceRevision:1,rootUrl:"https://example.test",startedAtMs:0,deadlineAtMs:1_800_000});
  if(!result.ok)throw new Error(result.error.kind);
  assertEquals(result.value.state,"completed");assertEquals(result.value.pagesProcessed,3);assertEquals(result.value.knowledgePointCount,0);assertEquals(result.value.scratchpad.acceptedHashes.length,0);assertEquals(result.value.scratchpad.coverage.length,0);assertEquals(result.value.scratchpad.reviewedCandidateCount,1);assertEquals(fixture.points.length,0);assertEquals(reviews,1);
});

Deno.test("repaired knowledge acceptance uses its new identity and refuses altered captured source anchors", async () => {
  for(const foreign of [false,true]) {
    const fixture=setup();
    const runner=createExtractionRunner({...fixture.dependencies,reviewer:{review:async(point)=>({ok:true,value:{...point,id:"knowledge:source-a:1:repaired",summary:"A repaired central relationship",normalizedHash:"repaired",evidenceAnchors:foreign?[{url:"https://foreign.test/",selector:"#other"}]:point.evidenceAnchors}})}});
    const result=await runner.run({ownerId:"owner-a",runId:"run-a",sourceId:"source-a",sourceRevision:1,rootUrl:"https://example.test",startedAtMs:0,deadlineAtMs:1_800_000});
    assertEquals(result.ok,!foreign);
    if(result.ok)assertEquals(result.value.scratchpad.acceptedHashes.join(","),"repaired");else assertEquals(result.error.kind,"KnowledgePersistenceFailed");
    assertEquals(fixture.points.length,foreign?0:1);
  }
});
