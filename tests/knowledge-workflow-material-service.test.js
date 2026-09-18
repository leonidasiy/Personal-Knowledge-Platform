// @ts-check

import { createKnowledgeWorkflowMaterialService } from "../src/features/knowledge-workflows/material-service.js";

/** @import { StoredMaterial } from "../src/features/knowledge-workflows/material-service.js" */

function input(overrides = {}) {
  return {
    ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1,
    sourceUrl: "https://example.test/learn", mediaType: "text/plain", fileName: "notes.txt",
    bytes: new TextEncoder().encode("A specific concept."), idempotencyKey: "material-a",
    rightsAttestation: { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis: "learner-provided copy", reference: "https://example.test/permission" },
    ...overrides,
  };
}

/** @param {Uint8Array} bytes */
async function digest(bytes) { return `sha256:${bytes.byteLength}`; }

/** @param {Record<string, unknown>} [run] @param {{ readonly kind: string } | Error | null} [statusFailure] */
function fixture(run = {}, statusFailure = null) {
  /** @type {Map<string, StoredMaterial>} */ const records = new Map();
  /** @type {string[]} */ const staged = [];
  /** @type {string[]} */ const removed = [];
  /** @type {unknown[]} */ const attached = [];
  const service = createKnowledgeWorkflowMaterialService({
    parser: (command) => import("../src/features/knowledge-workflows/material.js").then((module) => module.parseAuthorizedMaterial(command, { digest, maximumBytes: 10_000, maximumCharacters: 10_000 })),
    repository: {
      async replay(ownerId, idempotencyKey) { const value = records.get(`${ownerId}:${idempotencyKey}`); return { ok: true, value: value ?? null }; },
      async persist(record) { records.set(`${record.ownerId}:${record.idempotencyKey}`, record); return { ok: true, value: null }; },
      async remove(record) { records.delete(`${record.ownerId}:${record.idempotencyKey}`); return { ok: true, value: null }; },
    },
    contentStore: {
      async stage(command) { staged.push(command.objectId); return { ok: true, value: { objectKey: `source-content/${command.objectId}` } }; },
      async remove(key) { removed.push(key); return { ok: true, value: null }; },
    },
    workflow: {
      async status(command) { if (statusFailure instanceof Error) throw statusFailure; return statusFailure === null ? { ok: true, value: { ownerId: "owner-a", runId: command.runId, sourceId: "source-a", sourceRevision: 1, canonicalSourceIdentity: "https://example.test/learn", state: "awaiting-upload", ...run } } : { ok: false, error: statusFailure }; },
      async attachMaterial(command) { attached.push(command); return { ok: true, value: { runId: command.runId, state: "extraction-loop" } }; },
    },
    createId: () => "id-a",
    now: () => "2026-08-17T00:00:00.000Z",
    logger: () => {},
  });
  return { service, records, staged, removed, attached };
}

Deno.test("material service stages, records, and attaches authorized text without logging content", async () => {
  const fixtureValue = fixture();
  const result = await fixtureValue.service.upload(input());
  if (!result.ok) throw new Error(result.error.kind);
  if (result.value.status !== "attached" || fixtureValue.staged.length !== 1 || fixtureValue.attached.length !== 1) throw new Error("Expected material attachment.");
  const replay = await fixtureValue.service.upload(input());
  if (!replay.ok || !replay.value.reused) throw new Error("Expected idempotent material replay.");
});

Deno.test("material service refuses an idempotency conflict and cleans up failed attachment", async () => {
  const fixtureValue = fixture();
  const first = await fixtureValue.service.upload(input());
  if (!first.ok) throw new Error(first.error.kind);
  const conflict = await fixtureValue.service.upload(input({ bytes: new TextEncoder().encode("different") }));
  if (conflict.ok || conflict.error.kind !== "WorkflowMaterialIdempotencyConflict") throw new Error("Expected material idempotency conflict.");
});

Deno.test("material service accepts a matching idempotent replay after workflow progress", async () => {
  const run = { state: "awaiting-upload" };
  const fixtureValue = fixture(run);
  const first = await fixtureValue.service.upload(input());
  if (!first.ok) throw new Error(first.error.kind);
  run.state = "completed";
  const replay = await fixtureValue.service.upload(input());
  if (!replay.ok || !replay.value.reused || fixtureValue.staged.length !== 1 || fixtureValue.attached.length !== 1) throw new Error("Expected terminal idempotent replay without restaging or reattachment.");
});

for (const [label, command, run] of [
  ["owner", input({ ownerId: "owner-b" }), { ownerId: "owner-a" }],
  ["source", input({ sourceId: "source-b" }), { sourceId: "source-a" }],
  ["revision", input({ sourceRevision: 2 }), { sourceRevision: 1 }],
  ["canonical URL", input({ sourceUrl: "https://example.test/other" }), { canonicalSourceIdentity: "https://example.test/learn" }],
]) {
  Deno.test(`material service rejects a mismatched ${label} before storage`, async () => {
    const fixtureValue = fixture(/** @type {Record<string, unknown>} */ (run));
    const result = await fixtureValue.service.upload(command);
    if (result.ok || result.error.kind !== "WorkflowMaterialBindingInvalid") throw new Error("Expected binding failure.");
    if (fixtureValue.staged.length !== 0 || fixtureValue.records.size !== 0 || fixtureValue.attached.length !== 0) throw new Error("Mismatched material must not change the run or storage.");
  });
}

Deno.test("material service preserves a typed workflow status failure before storage", async () => {
  const fixtureValue = fixture({}, { kind: "WorkflowPersistenceFailed" });
  const result = await fixtureValue.service.upload(input());
  if (result.ok || result.error.kind !== "WorkflowMaterialStatusFailed" || result.error.cause !== "WorkflowPersistenceFailed") throw new Error("Expected status failure.");
  if (fixtureValue.staged.length !== 0) throw new Error("Status failure must not stage material.");
});

Deno.test("material service converts a rejected workflow status to a typed failure before storage", async () => {
  const fixtureValue = fixture({}, new TypeError("unavailable"));
  const result = await fixtureValue.service.upload(input());
  if (result.ok || result.error.kind !== "WorkflowMaterialStatusFailed" || result.error.cause !== "TypeError") throw new Error("Expected caught status failure.");
  if (fixtureValue.staged.length !== 0 || fixtureValue.records.size !== 0 || fixtureValue.attached.length !== 0) throw new Error("Rejected status must not change storage or the run.");
});

for (const [label, run] of [
  ["run", { runId: "run-b" }],
  ["canonical URL", { canonicalSourceIdentity: "not-a-url" }],
  ["state", { state: "completed" }],
]) {
  Deno.test(`material service rejects invalid ${label} status before storage`, async () => {
    const fixtureValue = fixture(/** @type {Record<string, unknown>} */ (run));
    const result = await fixtureValue.service.upload(input());
    const expected = label === "state" ? "WorkflowMaterialStateInvalid" : "WorkflowMaterialBindingInvalid";
    if (result.ok || result.error.kind !== expected) throw new Error("Expected typed status rejection.");
    if (fixtureValue.staged.length !== 0 || fixtureValue.records.size !== 0 || fixtureValue.attached.length !== 0) throw new Error("Invalid status must not change storage or the run.");
  });
}
