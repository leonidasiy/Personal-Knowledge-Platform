// @ts-check

import { createAgentHarness } from "../src/features/knowledge-workflows/harness.js";
import { createAgentMemoryStore } from "../src/features/knowledge-workflows/memory.js";
import { createContextCompactor } from "../src/features/knowledge-workflows/context.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function memoryRepository() {
  /** @type {import("../src/features/knowledge-workflows/memory.js").AgentMemoryNamespace[]} */
  const namespaces = [];
  return {
    /** @param {string} id */
    async findNamespace(id) { return namespaces.find((namespace) => namespace.id === id) ?? null; },
    /** @param {import("../src/features/knowledge-workflows/memory.js").AgentMemoryNamespace} namespace */
    async createNamespace(namespace) { namespaces.push(namespace); return null; },
    async appendRecord() { return null; },
    async listRecords() { return []; },
    async appendHandoff() { return null; },
  };
}

/** @param {readonly unknown[]} responses */
function model(responses) {
  let index = 0;
  return {
    async respond() {
      const response = responses[index];
      index += 1;
      if (response === undefined) throw new Error("Model fixture exhausted.");
      return response;
    },
  };
}

/** @param {readonly unknown[]} responses */
function setup(responses) {
  const memory = createAgentMemoryStore({
    repository: memoryRepository(),
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
  });
  return { memory, model: model(responses), events: /** @type {import("../src/features/knowledge-workflows/harness.js").AgentEvent[]} */ ([]), logs: [] };
}

Deno.test("harness pairs tool calls and results before returning a final response", async () => {
  const fixture = setup([
    {
      type: "tool-call",
      reasoningTrace: { provider: "test-model", fields: ["visible-reasoning-field"] },
      call: { id: "call-a", name: "evidence.lookup", input: { anchorId: "anchor-a" } },
    },
    { type: "final", reasoningTrace: null, output: { kind: "accepted", value: "done" } },
  ]);
  const namespace = await fixture.memory.createNamespace({ ownerId: "owner-a", runId: "run-a", role: "rights-assessor" });
  if (!namespace.ok) throw new Error("Expected memory namespace.");
  const harness = createAgentHarness({
    memory: fixture.memory,
    model: fixture.model,
    eventLedger: { append: async (event) => { fixture.events.push(event); return null; } },
    tools: new Map([["evidence.lookup", { execute: async () => ({ allowed: true }) }]]),
    maxTurns: 3,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
  });
  const result = await harness.run({ namespace: namespace.value, taskId: "task-a", input: { sourceId: "source-a" } });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.output.kind, "accepted");
  assertEquals(fixture.events.map((event) => event.kind).join(","), "model-response,tool-call,tool-result,model-response");
  assertEquals(fixture.events[0].reasoningTrace?.fields[0], "visible-reasoning-field");
  assertEquals(fixture.events[3].failureKind, "ReasoningTraceUnavailable");
});

Deno.test("harness rejects malformed model output and duplicate tool dispatch", async () => {
  const malformedFixture = setup([{ type: "final", output: null }]);
  const malformedNamespace = await malformedFixture.memory.createNamespace({ ownerId: "owner-a", runId: "run-b", role: "question-generator" });
  if (!malformedNamespace.ok) throw new Error("Expected memory namespace.");
  const malformed = createAgentHarness({
    memory: malformedFixture.memory,
    model: malformedFixture.model,
    eventLedger: { append: async () => null },
    tools: new Map(),
    maxTurns: 3,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
  });
  const malformedResult = await malformed.run({ namespace: malformedNamespace.value, taskId: "task-b", input: {} });
  assertEquals(malformedResult.ok, false);
  if (!malformedResult.ok) assertEquals(malformedResult.error.kind, "AgentOutputInvalid");

  const duplicateFixture = setup([
    { type: "tool-call", reasoningTrace: null, call: { id: "call-duplicate", name: "evidence.lookup", input: {} } },
    { type: "tool-call", reasoningTrace: null, call: { id: "call-duplicate", name: "evidence.lookup", input: {} } },
  ]);
  const duplicateNamespace = await duplicateFixture.memory.createNamespace({ ownerId: "owner-a", runId: "run-c", role: "knowledge-scraper" });
  if (!duplicateNamespace.ok) throw new Error("Expected memory namespace.");
  const duplicate = createAgentHarness({
    memory: duplicateFixture.memory,
    model: duplicateFixture.model,
    eventLedger: { append: async () => null },
    tools: new Map([["evidence.lookup", { execute: async () => ({ allowed: true }) }]]),
    maxTurns: 3,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
  });
  const duplicateResult = await duplicate.run({ namespace: duplicateNamespace.value, taskId: "task-c", input: {} });
  assertEquals(duplicateResult.ok, false);
  if (!duplicateResult.ok) assertEquals(duplicateResult.error.kind, "DuplicateDispatch");
});

Deno.test("harness enforces the role-specific tool-call limit", async () => {
  const fixture = setup([
    { type: "tool-call", reasoningTrace: null, call: { id: "call-one", name: "evidence.lookup", input: {} } },
    { type: "tool-call", reasoningTrace: null, call: { id: "call-two", name: "evidence.lookup", input: {} } },
  ]);
  const namespace = await fixture.memory.createNamespace({ ownerId: "owner-a", runId: "run-tool-limit", role: "rights-assessor" });
  if (!namespace.ok) throw new Error("Expected memory namespace.");
  const harness = createAgentHarness({
    memory: fixture.memory,
    model: fixture.model,
    eventLedger: { append: async (event) => { fixture.events.push(event); return null; } },
    tools: new Map([["evidence.lookup", { execute: async () => ({ allowed: true }) }]]),
    maxTurns: 3,
    maxToolCalls: 1,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
  });
  const result = await harness.run({ namespace: namespace.value, taskId: "tool-limit", input: {} });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "ToolCallLimitExceeded");
});

function compactionCommand(tokenCount = 500_000) {
  return {
    ownerId: "owner-a", runId: "run-memory", role: "knowledge-scraper",
    context: {
      activeContract: { sourceId: "source-a" }, checkpoint: { id: "batch-1", state: "completed", revision: 1 },
      unresolvedIssues: [{ id: "gap-a" }], evidenceLinks: ["https://example.test/page-1"],
      recentTurns: [{ id: "turn-1", role: "model", tokenCount, eventIds: ["event-1"], recordIds: ["record-1"], summary: "source-supported details ".repeat(100) }],
      ledgerEventIds: ["event-1"], tokenCount, safeCheckpoint: true,
    },
  };
}

Deno.test("memory default is 500k independently of summary output and preserves exact recovery fields", async () => {
  let calls = 0;
  const compactor = createContextCompactor({ now: () => "2026-09-08T00:00:00Z", digest: (value) => `digest:${value.length}`, appendRecord: async () => null, logger: () => {},
    summarize: async (input) => { calls++; assertEquals(input.maxOutputTokens < 500_000, true); return { ok: true, value: { summary: "Source-supported summary." } }; },
  });
  const below = await compactor.compact(compactionCommand(499_999));
  assertEquals(below.ok, true);
  assertEquals(calls, 0);
  const exact = await compactor.compact(compactionCommand());
  assertEquals(exact.ok, true);
  if (!exact.ok) return;
  assertEquals(calls, 1);
  assertEquals(exact.value.record?.coveredRecordIds.join(), "record-1");
  assertEquals(JSON.stringify(exact.value.context.unresolvedIssues), '[{"id":"gap-a"}]');
  assertEquals(exact.value.context.evidenceLinks.join(), "https://example.test/page-1");
});

Deno.test("summary rejection, invalid output and persistence failure leave original context intact", async () => {
  for (const mode of ["throw", "invalid", "oversized", "nonshrinking", "persistence"]) {
    const command = compactionCommand();
    const original = JSON.stringify(command);
    let persisted = 0;
    const compactor = createContextCompactor({ thresholdTokens: 500_000, maxSummaryTokens: 100, now: () => "2026-09-08T00:00:00Z", digest: (value) => `digest:${value.length}`, logger: () => {},
      summarize: async () => {
        if (mode === "throw") throw new Error("provider rejected");
        return { ok: true, value: { summary: mode === "invalid" ? "" : mode === "oversized" ? "x".repeat(1_000) : mode === "nonshrinking" ? command.context.recentTurns[0].summary : "Valid summary." } };
      },
      appendRecord: async () => { persisted++; if (mode === "persistence") throw new Error("storage rejected"); return null; },
    });
    const result = await compactor.compact(command);
    assertEquals(result.ok, false);
    assertEquals(JSON.stringify(command), original);
    assertEquals(persisted, mode === "persistence" ? 1 : 0);
  }
});

Deno.test("context compaction preserves recovery state only at a safe checkpoint", async () => {
  /** @type {import("../src/features/knowledge-workflows/context.js").CompactionRecord[]} */
  const records = [];
  const compactor = createContextCompactor({
    thresholdTokens: 150_000,
    maxRecentTurns: 2,
    now: () => "2026-08-13T00:00:00.000Z",
    digest: (value) => `digest:${value.length}`,
    summarize: async () => ({ ok: true, value: { summary: "x" } }),
    appendRecord: async (record) => { records.push(record); return null; },
    logger: () => {},
  });
  const command = {
    ownerId: "owner-a",
    runId: "run-context",
    role: "knowledge-scraper",
    context: {
      activeContract: { sourceId: "source-a" },
      checkpoint: { id: "checkpoint-a", state: "extracting", revision: 2 },
      unresolvedIssues: [{ id: "gap-a" }],
      evidenceLinks: ["https://example.test/a"],
      recentTurns: [
        { id: "turn-a", role: "model", tokenCount: 10, eventIds: ["event-a"], summary: "old" },
        { id: "turn-b", role: "tool", tokenCount: 20, eventIds: ["event-b"], summary: "recent" },
        { id: "turn-c", role: "model", tokenCount: 30, eventIds: ["event-c"], summary: "latest" },
      ],
      ledgerEventIds: ["event-a", "event-b", "event-c"],
      tokenCount: 150_000,
      safeCheckpoint: true,
    },
  };
  const result = await compactor.compact(command);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.status, "compacted");
  assertEquals(result.value.context.recentTurns.slice(1).map((turn) => turn.id).join(","), "turn-b,turn-c");
  assertEquals(result.value.context.recentTurns[0].summary, "x");
  assertEquals(result.value.context.checkpoint.id, "checkpoint-a");
  assertEquals(result.value.context.ledgerEventIds.join(","), "event-a,event-b,event-c");
  assertEquals(result.value.record?.reversible, true);
  assertEquals(records.length, 1);
});

Deno.test("context compaction pauses instead of compacting during an unsafe turn", async () => {
  let persisted = false;
  const compactor = createContextCompactor({
    thresholdTokens: 150_000,
    now: () => "2026-08-13T00:00:00.000Z",
    digest: () => "digest",
    appendRecord: async () => { persisted = true; return null; },
    logger: () => {},
  });
  const result = await compactor.compact({
    ownerId: "owner-a",
    runId: "run-unsafe",
    role: "question-generator",
    context: {
      activeContract: { knowledgeId: "knowledge-a" },
      checkpoint: { id: "checkpoint-b", state: "generating", revision: 1 },
      unresolvedIssues: [],
      evidenceLinks: [],
      recentTurns: [],
      ledgerEventIds: ["event-x"],
      tokenCount: 150_001,
      safeCheckpoint: false,
    },
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "ContextLimitBeforeSafeCheckpoint");
  assertEquals(persisted, false);
});
