// @ts-check

import { createDiscoveryWorker } from "../worker/handler.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

/** @param {Partial<Parameters<typeof createDiscoveryWorker>[1]>} [overrides] */
function worker(overrides = {}) {
  return createDiscoveryWorker({ allowedOrigin: "https://app.example", maximumCommandBytes: 4096 }, {
    authenticate: overrides.authenticate ?? (async () => ({ ok: true, value: { ownerId: "owner-a", email: "owner@example.com" } })),
    acquireRss: async () => ({ ok: false, error: { kind: "DiscoveryFetchUnavailable" } }),
    sourceIngestion: overrides.sourceIngestion ?? null,
    manualMaterial: overrides.manualMaterial ?? null,
    wikimediaTimedText: overrides.wikimediaTimedText ?? null,
  });
}

/** @param {string} path @param {unknown} body */
function request(path, body) { return new Request(`https://app.example${path}`, { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify(body) }); }

Deno.test("ingestion routes authenticate before source, R2, or provider work", async () => {
  let work = 0;
  const denied = worker({ authenticate: async () => ({ ok: false, error: { kind: "DiscoveryClientUnauthenticated" } }), sourceIngestion: { run: async () => { work += 1; return { ok: true, value: { state: "completed", itemsStored: 1 } }; } } });
  const response = await denied.fetch(request("/api/source-library/ingestion/run", {}));
  assertEquals(response.status, 401);
  assertEquals(work, 0);
});

Deno.test("source ingestion accepts only a job ID and rejects browser evidence before work", async () => {
  let work = 0;
  const sourceIngestion = { run: async () => { work += 1; return /** @type {const} */ ({ ok: true, value: { state: "completed", itemsStored: 0 } }); } };
  let response = await worker({ sourceIngestion }).fetch(request("/api/source-library/ingestion/run", { jobId: "job-a", assessment: { rights: "allowed" } }));
  assertEquals(response.status, 400);
  assertEquals(work, 0);
  response = await worker({ sourceIngestion }).fetch(request("/api/source-library/ingestion/run", { jobId: "job-a" }));
  assertEquals(response.status, 200);
  assertEquals(work, 1);
});

Deno.test("manual material derives owner from Access and returns processing-ready only", async () => {
  let seenOwner = "";
  const response = await worker({ manualMaterial: { upload: async (command) => { seenOwner = /** @type {{ readonly ownerId: string }} */ (command).ownerId; return { ok: true, value: { status: "processing-ready", reused: false, reference: { id: "content-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", objectKey: "source-content/a", contentDigest: "sha256:a", rightsAssessmentId: "rights-a", state: "processing-ready", createdAt: "2026-07-22T12:00:00.000Z" } } }; } } }).fetch(request("/api/source-library/manual-material", { sourceId: "source-a" }));
  assertEquals(response.status, 200);
  assertEquals(seenOwner, "owner-a");
  const document = await response.json();
  assertEquals(document.result.status, "processing-ready");
  assertEquals("quiz" in document.result, false);
});

Deno.test("ingestion routes reject browser ownership and unavailable services explicitly", async () => {
  let response = await worker().fetch(request("/api/source-library/manual-material", { ownerId: "owner-b" }));
  assertEquals(response.status, 400);
  response = await worker().fetch(request("/api/source-library/manual-material", { sourceId: "source-a" }));
  assertEquals(response.status, 503);
});

Deno.test("Wikimedia route returns named license failures without provider fallback", async () => {
  const response = await worker({ wikimediaTimedText: { retrieve: async () => ({ ok: false, error: { kind: "WikimediaLicenseUnsupported" } }) } }).fetch(request("/api/discovery/wikimedia/timedtext", { sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", language: "en" }));
  assertEquals(response.status, 400);
  const document = await response.json();
  assertEquals(document.error, "WikimediaLicenseUnsupported");
});

Deno.test("Wikimedia route rejects browser-supplied rights and provider evidence before work", async () => {
  let work = 0;
  const wikimediaTimedText = { retrieve: async () => { work += 1; return /** @type {const} */ ({ ok: false, error: { kind: "WikimediaLicenseUnsupported" } }); } };
  const response = await worker({ wikimediaTimedText }).fetch(request("/api/discovery/wikimedia/timedtext", { sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", language: "en", timedTextUrl: "https://attacker.example/text", fileLicense: { outcome: "allowed" } }));
  assertEquals(response.status, 400);
  assertEquals(work, 0);
});
