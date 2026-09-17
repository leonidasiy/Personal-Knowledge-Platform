// @ts-check
import { createPrivateDocumentReadService } from "../worker/private-document-read.js";

/** @typedef {{ readonly id: string, readonly ownerId: string, readonly origin: string, readonly state: string, readonly title: string, readonly revision: number, readonly canonicalUrl: string }} SourceFixture */
/** @typedef {{ readonly ownerId: string, readonly runId: string, readonly sourceId: string, readonly sourceRevision: number, readonly state: string }} RunFixture */
/** @typedef {{ readonly ownerId: string, readonly runId: string, readonly objectKey: string, readonly material: { readonly sourceId: string, readonly sourceRevision: number, readonly sourceUrl: string, readonly fileName: string, readonly mediaType: string } }} MaterialFixture */
/** @type {SourceFixture} */ const source = Object.freeze({ id: "source-a", ownerId: "owner-a", origin: "private-document", state: "active", title: "Week 3", revision: 1, canonicalUrl: "https://app.example/api/private-documents/source-a" });
/** @type {RunFixture} */ const run = Object.freeze({ ownerId: "owner-a", runId: "run-a", sourceId: "source-a", sourceRevision: 1, state: "awaiting-upload" });
/** @type {MaterialFixture} */ const material = Object.freeze({ ownerId: "owner-a", runId: "run-a", objectKey: "source-content/material-a", material: Object.freeze({ sourceId: "source-a", sourceRevision: 1, sourceUrl: "https://app.example/api/private-documents/source-a", fileName: "week3.pdf", mediaType: "application/pdf" }) });

/** @template T @param {T} value @returns {{ readonly ok: true, readonly value: T }} */
function ok(value) { return { ok: true, value }; }

/** @typedef {{ readonly ok: true, readonly value: SourceFixture | null }} SourceResult */
/** @typedef {{ readonly ok: true, readonly value: RunFixture | null }} WorkflowResult */
/** @typedef {{ readonly ok: true, readonly value: MaterialFixture | null }} MaterialResult */
/** @typedef {{ readonly ok: true, readonly value: Uint8Array } | { readonly ok: false, readonly error: unknown }} ContentResult */
/** @typedef {{ readonly source?: { readonly read: (ownerId: string, sourceId: string) => Promise<SourceResult> }, readonly workflow?: { readonly latest: (ownerId: string, sourceId: string, sourceRevision: number) => Promise<WorkflowResult> }, readonly material?: { readonly read: (ownerId: string, runId: string) => Promise<MaterialResult> }, readonly content?: { readonly read: (ownerId: string, objectKey: string) => Promise<ContentResult> } }} Overrides */

/** @param {Overrides} [overrides] */
function service(overrides = {}) {
  return createPrivateDocumentReadService({
    source: { read: async () => ok(source) },
    workflow: { latest: async () => ok(run) },
    material: { read: async () => ok(null) },
    content: { read: async () => ok(new Uint8Array([1, 2])) },
    ...overrides,
  });
}

Deno.test("private document reads owner-scoped pending metadata before attachment", async () => {
  const result = await service().read({ ownerId: "owner-a", sourceId: "source-a" });
  if (!result.ok || result.value.status !== "pending" || result.value.runId !== "run-a") throw new Error("Expected pending metadata.");
});

Deno.test("private document selects the latest workflow by owner, source, and revision", async () => {
  let received = "";
  const result = await service({ workflow: { latest: async (ownerId, sourceId, sourceRevision) => { received = `${ownerId}:${sourceId}:${sourceRevision}`; return ok(null); } } }).read({ ownerId: " owner-a ", sourceId: " source-a " });
  if (!result.ok || result.value.status !== "pending" || received !== "owner-a:source-a:1") throw new Error("Expected exact workflow selection.");
});

Deno.test("private document reads exact attachment bytes only after owner-scoped material lookup", async () => {
  const result = await service({ material: { read: async () => ok(material) } }).read({ ownerId: "owner-a", sourceId: "source-a" });
  if (!result.ok || result.value.status !== "attached" || result.value.bytes[1] !== 2 || result.value.mediaType !== "application/pdf") throw new Error("Expected exact attachment.");
});

for (const [label, sourceValue, kind] of /** @type {readonly [string, SourceFixture | null, string][]} */ ([
  ["missing source", null, "PrivateDocumentNotFound"],
  ["foreign source owner", { ...source, ownerId: "owner-b" }, "PrivateDocumentNotFound"],
  ["foreign source identifier", { ...source, id: "source-b" }, "PrivateDocumentNotFound"],
  ["web source", { ...source, origin: "web" }, "PrivateDocumentNotPrivate"],
  ["disabled source", { ...source, state: "disabled" }, "PrivateDocumentDisabled"],
])) Deno.test(`private document rejects ${label}`, async () => {
  const result = await service({ source: { read: async () => ok(sourceValue) } }).read({ ownerId: "owner-a", sourceId: "source-a" });
  if (result.ok || result.error.kind !== kind) throw new Error("Expected typed source rejection.");
});

for (const [label, runValue] of /** @type {readonly [string, RunFixture][]} */ ([
  ["foreign workflow owner", { ...run, ownerId: "owner-b" }],
  ["foreign workflow source", { ...run, sourceId: "source-b" }],
  ["stale workflow revision", { ...run, sourceRevision: 2 }],
])) Deno.test(`private document rejects ${label} before material or bytes`, async () => {
  let materialReads = 0;
  let contentReads = 0;
  const result = await service({ workflow: { latest: async () => ok(runValue) }, material: { read: async () => { materialReads += 1; return ok(material); } }, content: { read: async () => { contentReads += 1; return ok(new Uint8Array()); } } }).read({ ownerId: "owner-a", sourceId: "source-a" });
  if (result.ok || result.error.kind !== "PrivateDocumentWorkflowReadFailed" || materialReads !== 0 || contentReads !== 0) throw new Error("Expected workflow identity rejection before reads.");
});

for (const [label, materialValue] of /** @type {readonly [string, MaterialFixture][]} */ ([
  ["foreign material owner", { ...material, ownerId: "owner-b" }],
  ["foreign material run", { ...material, runId: "run-b" }],
  ["foreign material source", { ...material, material: { ...material.material, sourceId: "source-b" } }],
  ["stale material revision", { ...material, material: { ...material.material, sourceRevision: 2 } }],
  ["mismatched canonical URL", { ...material, material: { ...material.material, sourceUrl: "https://app.example/api/private-documents/other" } }],
])) Deno.test(`private document rejects ${label} before bytes`, async () => {
  let contentReads = 0;
  const result = await service({ material: { read: async () => ok(materialValue) }, content: { read: async () => { contentReads += 1; return ok(new Uint8Array()); } } }).read({ ownerId: "owner-a", sourceId: "source-a" });
  if (result.ok || result.error.kind !== "PrivateDocumentMaterialReadFailed" || contentReads !== 0) throw new Error("Expected material identity rejection before bytes.");
});

Deno.test("private document returns a typed content read failure", async () => {
  const result = await service({ material: { read: async () => ok(material) }, content: { read: async () => ({ ok: false, error: { kind: "StorageFailed" } }) } }).read({ ownerId: "owner-a", sourceId: "source-a" });
  if (result.ok || result.error.kind !== "PrivateDocumentContentReadFailed") throw new Error("Expected typed content failure.");
});
