// @ts-check

import { createAgentMemoryStore } from "../src/features/knowledge-workflows/memory.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function repository() {
  /** @type {import("../src/features/knowledge-workflows/memory.js").AgentMemoryNamespace[]} */
  const namespaces = [];
  /** @type {import("../src/features/knowledge-workflows/memory.js").AgentMemoryRecord[]} */
  const records = [];
  /** @type {import("../src/features/knowledge-workflows/memory.js").SharedHandoff[]} */
  const handoffs = [];
  return {
    namespaces,
    records,
    handoffs,
    /** @param {string} id */
    async findNamespace(id) {
      return namespaces.find((namespace) => namespace.id === id) ?? null;
    },
    /** @param {import("../src/features/knowledge-workflows/memory.js").AgentMemoryNamespace} namespace */
    async createNamespace(namespace) {
      namespaces.push(namespace);
      return null;
    },
    /** @param {import("../src/features/knowledge-workflows/memory.js").AgentMemoryRecord} record */
    async appendRecord(record) {
      records.push(record);
      return null;
    },
    /** @param {string} namespaceId */
    async listRecords(namespaceId) {
      return records.filter((record) => record.namespaceId === namespaceId);
    },
    /** @param {import("../src/features/knowledge-workflows/memory.js").SharedHandoff} handoff */
    async appendHandoff(handoff) {
      handoffs.push(handoff);
      return null;
    },
  };
}

function store() {
  return repository();
}

Deno.test("memory creates an isolated durable namespace and preserves provenance", async () => {
  const database = store();
  const memory = createAgentMemoryStore({
    repository: database,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
  });
  const created = await memory.createNamespace({ ownerId: "owner-a", runId: "run-a", role: "knowledge-scraper" });
  assertEquals(created.ok, true);
  if (!created.ok) return;
  assertEquals(created.value.ownerId, "owner-a");
  assertEquals(created.value.runId, "run-a");
  assertEquals(created.value.role, "knowledge-scraper");
  assertEquals(created.value.mode, "enabled");

  const appended = await memory.appendRecord(created.value, {
    id: "event-a",
    kind: "working-memory",
    visibility: "private",
    retention: "run",
    integrityVersion: 1,
    sourceEventId: "event-source-a",
    payload: { summary: "bounded" },
  });
  assertEquals(appended.ok, true);
  assertEquals(database.records.length, 1);
  assertEquals(database.records[0].sourceEventId, "event-source-a");
  assertEquals(database.records[0].occurredAt, "2026-08-13T00:00:00.000Z");
});

Deno.test("memory rejects foreign namespaces and disabled memory without explicit approval", async () => {
  const database = store();
  const memory = createAgentMemoryStore({
    repository: database,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
  });
  const created = await memory.createNamespace({ ownerId: "owner-a", runId: "run-a", role: "rights-assessor" });
  assertEquals(created.ok, true);
  if (!created.ok) return;

  const foreign = await memory.appendRecord(
    { ...created.value, ownerId: "owner-b" },
    {
      id: "event-foreign",
      kind: "working-memory",
      visibility: "private",
      retention: "run",
      integrityVersion: 1,
      sourceEventId: "event-source-b",
      payload: { summary: "must-not-write" },
    },
  );
  assertEquals(foreign.ok, false);
  if (!foreign.ok) assertEquals(foreign.error.kind, "AgentMemoryIsolationViolation");

  const disabled = await memory.createNamespace({
    ownerId: "owner-a",
    runId: "run-b",
    role: "question-evaluator",
    memoryMode: "disabled-by-task",
  });
  assertEquals(disabled.ok, false);
  if (!disabled.ok) assertEquals(disabled.error.kind, "MemoryModeDisabledWithoutApproval");

  const approved = await memory.createNamespace({
    ownerId: "owner-a",
    runId: "run-b",
    role: "question-evaluator",
    memoryMode: "disabled-by-task",
    humanApprovalId: "approval-a",
  });
  assertEquals(approved.ok, true);
  if (approved.ok) assertEquals(approved.value.mode, "disabled-by-task");
});

Deno.test("memory accepts same-run typed handoffs and rejects cross-owner or cross-run handoffs", async () => {
  const database = store();
  const memory = createAgentMemoryStore({
    repository: database,
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
  });
  const producer = await memory.createNamespace({ ownerId: "owner-a", runId: "run-a", role: "knowledge-scraper" });
  const consumer = await memory.createNamespace({ ownerId: "owner-a", runId: "run-a", role: "question-generator" });
  assertEquals(producer.ok, true);
  assertEquals(consumer.ok, true);
  if (!producer.ok || !consumer.ok) return;

  const accepted = await memory.shareHandoff({
    id: "handoff-a",
    producer: producer.value,
    consumer: consumer.value,
    sourceEventId: "observation-a",
    payload: { knowledgePointId: "point-a" },
  });
  assertEquals(accepted.ok, true);
  assertEquals(database.handoffs.length, 1);

  const foreign = await memory.shareHandoff({
    id: "handoff-b",
    producer: producer.value,
    consumer: { ...consumer.value, ownerId: "owner-b" },
    sourceEventId: "observation-b",
    payload: { knowledgePointId: "point-b" },
  });
  assertEquals(foreign.ok, false);
  if (!foreign.ok) assertEquals(foreign.error.kind, "SharedHandoffUnauthorized");

  const otherRun = await memory.shareHandoff({
    id: "handoff-c",
    producer: producer.value,
    consumer: { ...consumer.value, runId: "run-b" },
    sourceEventId: "observation-c",
    payload: { knowledgePointId: "point-c" },
  });
  assertEquals(otherRun.ok, false);
  if (!otherRun.ok) assertEquals(otherRun.error.kind, "SharedHandoffUnauthorized");
});
