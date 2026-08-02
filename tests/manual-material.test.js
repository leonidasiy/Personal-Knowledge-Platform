// @ts-check

import { ManualMaterialService } from "../src/features/source-library/manual-material.js";

/** @typedef {{ readonly fingerprint: string, readonly idempotencyKey: string, readonly rightsAssessment: import("../src/features/source-library/ingestion-contracts.js").SourceRightsAssessment, readonly contentReference: import("../src/features/source-library/ingestion-contracts.js").SourceContentReference }} PersistCommand */
/** @typedef {{ readonly find?: (query: { readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly itemId: string, readonly itemVersionId: string }) => Promise<{ readonly ok: true, readonly value: { readonly state: "active" | "disabled" } } | { readonly ok: false, readonly error: import("../src/features/source-library/ingestion-contracts.js").SourceIngestionFailure }> }} SetupOverrides */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

function command() { return { ownerId: "owner-a", sourceId: "youtube-video-source", sourceRevision: 1, itemId: "video-a", itemVersionId: "metadata-v1", mediaType: "text/plain", content: "A transcript the learner is permitted to use.", rightsAttestation: { storageAllowed: true, transformationAllowed: true, basis: "learner-attested lawful copy", reference: "attestation-a" }, idempotencyKey: "upload-a" }; }

/** @param {SetupOverrides} [overrides] */
function setup(overrides = {}) {
  /** @type {{ readonly fingerprint: string, readonly reference: import("../src/features/source-library/ingestion-contracts.js").SourceContentReference } | null} */
  let replay = null;
  /** @type {PersistCommand | null} */
  let persisted = null;
  /** @type {{ readonly objectId: string }[]} */
  const staged = [];
  /** @type {string[]} */
  const removed = [];
  let sequence = 0;
  const service = new ManualMaterialService({
    sourceItems: { find: overrides.find ?? (async () => ({ ok: true, value: { state: "active" } })) },
    repository: { replay: async () => ({ ok: true, value: replay }), persist: async (input) => { persisted = input; replay = { fingerprint: input.fingerprint, reference: input.contentReference }; return { ok: true, value: input.contentReference }; } },
    contentStore: { stage: async (input) => { staged.push(input); return { ok: true, value: { objectKey: `source-content/${input.objectId}` } }; }, remove: async (key) => { removed.push(key); return { ok: true, value: null }; } },
    digest: async (bytes) => ({ ok: true, value: `sha256:${bytes.byteLength}` }), createId: () => String(++sequence),
    now: () => "2026-07-22T12:00:00.000Z", supportedMediaTypes: new Set(["text/plain", "text/vtt"]), maximumBytes: 100, maximumCharacters: 90,
  });
  return { service, staged, removed, getPersisted: () => persisted };
}

Deno.test("manual material requires exact source item, attestation, and stops at processing-ready", async () => {
  const { service, staged, getPersisted } = setup();
  const result = await service.upload(command());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.status, "processing-ready");
  assertEquals(result.value.reused, false);
  assertEquals(staged.length, 1);
  const persisted = getPersisted();
  if (persisted === null) throw new Error("Expected persisted material.");
  assertEquals(persisted.contentReference.itemVersionId, "metadata-v1");
  assertEquals("quiz" in result.value, false);
  assertEquals("lesson" in result.value, false);
});

Deno.test("manual material replay is idempotent and changed content conflicts", async () => {
  const { service, staged } = setup();
  const first = await service.upload(command());
  const replay = await service.upload(command());
  assertEquals(first.ok, true);
  assertEquals(replay.ok, true);
  if (replay.ok) assertEquals(replay.value.reused, true);
  assertEquals(staged.length, 1);
  const conflict = await service.upload({ ...command(), content: "Changed transcript." });
  assertEquals(conflict.ok, false);
  if (!conflict.ok) assertEquals(conflict.error.kind, "ManualUploadIdempotencyConflict");
});

Deno.test("manual material failures remain distinct", async () => {
  const cases = [
    [{ ...command(), rightsAttestation: null }, "UploadRightsAttestationMissing"],
    [{ ...command(), mediaType: "application/pdf" }, "ManualUploadContentTypeUnsupported"],
    [{ ...command(), content: "x".repeat(91) }, "ManualUploadTextLimitExceeded"],
    [{ ...command(), content: "broken \uD800 text" }, "ManualUploadEncodingInvalid"],
    [{ ...command(), content: "é".repeat(60) }, "ManualUploadByteLimitExceeded"],
  ];
  for (const [input, kind] of cases) {
    const result = await setup().service.upload(input);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, kind);
  }
  const disabled = await setup({ find: async () => ({ ok: true, value: { state: "disabled" } }) }).service.upload(command());
  if (disabled.ok) throw new Error("Expected failure.");
  assertEquals(disabled.error.kind, "ManualUploadSourceDisabled");
});
