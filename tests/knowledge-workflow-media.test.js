// @ts-check

import * as mediaModule from "../src/features/knowledge-workflows/media.js";
import { createCloudflareImageDerivative } from "../worker/knowledge-workflow-media-transform.js";

const { createMediaPipeline, selectFallbackAsset, validateFallbackPack } = mediaModule;

/** @typedef {{ readonly kind: string, readonly field?: string }} FutureFailure */
/** @typedef {{ readonly id: string, readonly path: string, readonly mediaType: string, readonly width: number, readonly height: number, readonly userAttested: true }} FutureFallbackAsset */
/** @typedef {{ readonly entries: readonly FutureFallbackAsset[], readonly resolve: (reference: { readonly assetId: string, readonly path: string }) => { readonly ok: true, readonly value: FutureFallbackAsset } | { readonly ok: false, readonly error: FutureFailure } }} FutureFallbackManifest */
const futureMedia = /** @type {Record<string, unknown>} */ (mediaModule);

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function candidate(overrides = {}) {
  return { url: "https://cdn.example.test/lesson.png", kind: "image", educationallyConnected: true, mediaTypeHint: "image/png", rights: { storage: "allowed", display: "allowed", transformation: "allowed", attribution: "Creator / CC BY", originEvidence: "source-evidence-1" }, ...overrides };
}

/** @param {Record<string, unknown>} overrides */
function pipeline(overrides = {}) {
  /** @type {Record<string, unknown>} */ const stored = {};
  const dependencies = {
    fetch: async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
    resolveAddresses: async () => /** @type {const} */ ({ ok: true, value: ["203.0.113.10"] }),
    publicEgress: { fetch: async () => ({ ok: true, value: new Response(png, { status: 200, headers: { "content-type": "image/png" } }) }) },
    trustedRead: { read: async () => ({ ok: true, value: new Response(png, { status: 200, headers: { "content-type": "image/png" } }) }) },
    digest: async () => ({ ok: true, value: "sha256:image" }),
    quarantine: { put: async (/** @type {{ readonly key: string }} */ { key }) => { stored.originalKey = key; return { ok: true, value: null }; }, remove: async (/** @type {string} */ key) => { stored.removed = key; return { ok: true, value: null }; } },
    derivatives: { create: async (/** @type {{ readonly bytes: Uint8Array, readonly mediaType: string }} */ { bytes, mediaType }) => ({ ok: true, value: { bytes, mediaType } }) },
    repository: { save: async (/** @type {import("../src/features/knowledge-workflows/media.js").MediaAsset} */ asset, /** @type {import("../src/features/knowledge-workflows/media.js").MediaDerivative} */ derivative, /** @type {Uint8Array} */ bytes) => { stored.asset = asset; stored.derivative = derivative; stored.bytes = bytes; return { ok: true, value: null }; }, read: async () => ({ ok: true, value: { bytes: png, mediaType: "image/png", revoked: false } }), revoke: async () => ({ ok: true, value: null }) },
    createId: (() => { let index = 0; return () => `id-${++index}`; })(),
    now: () => "2026-08-13T00:00:00.000Z",
    logger: () => {},
    ...overrides,
  };
  return { stored, pipeline: createMediaPipeline(/** @type {import("../src/features/knowledge-workflows/media.js").MediaDependencies} */ (/** @type {unknown} */ (dependencies))) };
}

Deno.test("media pipeline validates origin, signature, quarantines originals, and serves only derivatives", async () => {
  const fixture = pipeline();
  const ingested = await fixture.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", sourceUrl: "https://example.test/lesson", allowedOrigins: ["https://cdn.example.test"], candidate: candidate() });
  assertEquals(ingested.ok, true);
  if (!ingested.ok) return;
  assertEquals(ingested.value.asset.privateOriginalKey.startsWith("private-quarantine/"), true);
  assertEquals(ingested.value.derivative.privateObjectKey.startsWith("private-derivatives/"), true);
  const served = await fixture.pipeline.serve({ ownerId: "owner-a", assetId: ingested.value.asset.assetId, variant: "feed" });
  assertEquals(served.ok, true);
  const blocked = await fixture.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", sourceUrl: "https://example.test/lesson", allowedOrigins: [], candidate: candidate({ url: "https://unrelated.example.test/image.png" }) });
  assertEquals(blocked.ok, false);
  if (!blocked.ok) assertEquals(blocked.error.kind, "MediaOriginNotAllowed");
});

Deno.test("media pipeline persists already-acquired image bytes only for the source origin", async () => {
  const fixture = pipeline();
  const persisted = await fixture.pipeline.ingestBytes({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-bytes", sourceUrl: "https://example.test/lesson", candidate: candidate({ url: "https://example.test/diagram.png", kind: "screenshot" }), bytes: png });
  assertEquals(persisted.ok, true);
  assertEquals(fixture.stored.bytes instanceof Uint8Array, true);
  const blocked = await fixture.pipeline.ingestBytes({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-bytes-remote", sourceUrl: "https://example.test/lesson", candidate: candidate(), bytes: png });
  assertEquals(blocked.ok, false);
  if (!blocked.ok) assertEquals(blocked.error.kind, "MediaOriginNotAllowed");
});

Deno.test("media byte ingestion returns a typed failure for malformed candidate URLs", async () => {
  const fixture = pipeline();
  const result = await fixture.pipeline.ingestBytes({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-invalid-url", sourceUrl: "https://example.test/lesson", candidate: candidate({ url: "https://[invalid" }), bytes: png });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "MediaCommandInvalid");
});

Deno.test("media service rejects revoked and missing derivative delivery without exposing storage keys", async () => {
  const fixture = pipeline({ repository: { save: async () => ({ ok: true, value: null }), read: async (/** @type {{ readonly assetId: string }} */ command) => command.assetId === "missing" ? { ok: false, error: { kind: "not-found" } } : { ok: true, value: { bytes: png, mediaType: "image/png", revoked: true } }, revoke: async () => ({ ok: true, value: null }) } });
  const missing = await fixture.pipeline.serve({ ownerId: "owner-a", assetId: "missing", variant: "feed" });
  assertEquals(missing.ok, false);
  if (!missing.ok) assertEquals(missing.error.kind, "MediaDerivativeNotFound");
  const revoked = await fixture.pipeline.serve({ ownerId: "owner-a", assetId: "media:a", variant: "feed" });
  assertEquals(revoked.ok, false);
  if (!revoked.ok) assertEquals(revoked.error.kind, "MediaDerivativeRevoked");
});

Deno.test("media pipeline rejects scriptable formats, MIME conflicts, oversized input, and derivative cleanup failures", async () => {
  const html = pipeline({ trustedRead: { read: async () => ({ ok: true, value: new Response("<svg></svg>", { status: 200, headers: { "content-type": "image/svg+xml" } }) }) } });
  const svg = await html.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", sourceUrl: "https://example.test/lesson", allowedOrigins: [], candidate: candidate({ url: "https://example.test/image.svg", mediaTypeHint: "image/svg+xml" }) });
  assertEquals(svg.ok, false);
  if (!svg.ok) assertEquals(svg.error.kind, "MediaScriptableFormatRejected");
  const mismatch = pipeline({ trustedRead: { read: async () => ({ ok: true, value: new Response(png, { status: 200, headers: { "content-type": "image/jpeg" } }) }) } });
  const conflict = await mismatch.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", sourceUrl: "https://example.test/lesson", allowedOrigins: [], candidate: candidate({ url: "https://example.test/image.jpg", mediaTypeHint: "image/jpeg" }) });
  assertEquals(conflict.ok, false);
  if (!conflict.ok) assertEquals(conflict.error.kind, "MediaMimeSignatureConflict");
  const pack = Array.from({ length: 2 }, (_, index) => ({ id: `fallback-${index}`, path: `/assets/fallback-media/${index}.jpg`, mediaType: /** @type {const} */ ("image/jpeg"), width: 10, height: 10, userAttested: /** @type {const} */ (true) }));
  assertEquals(validateFallbackPack(pack).ok, true);
  const manifest = futureMedia.createUserAttestedLocalManifest;
  if (typeof manifest !== "function") throw new Error("Fallback manifest factory is unavailable.");
  const created = /** @type {(value: unknown) => { readonly ok: true, readonly value: FutureFallbackManifest } | { readonly ok: false, readonly error: FutureFailure }} */ (manifest)(pack);
  if (!created.ok) throw new Error(created.error.kind);
  assertEquals(selectFallbackAsset(/** @type {import("../src/features/knowledge-workflows/media.js").UserAttestedLocalManifest} */ (created.value), "knowledge-a"), selectFallbackAsset(/** @type {import("../src/features/knowledge-workflows/media.js").UserAttestedLocalManifest} */ (created.value), "knowledge-a"));
  assertEquals(validateFallbackPack([]).ok, false);
});

Deno.test("media acquisition rejects atomic egress failures before content read", async () => {
  let fetches = 0;
  const fixture = pipeline({
    publicEgress: { fetch: async () => ({ ok: false, error: { kind: "MediaPublicEgressRedirectUnsafe" } }) },
    trustedRead: undefined,
    fetch: async () => { fetches += 1; return new Response(png, { headers: { "content-type": "image/png" } }); },
  });
  const result = await fixture.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", sourceUrl: "https://example.test/lesson", allowedOrigins: [], candidate: candidate({ url: "https://example.test/image.png" }) });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "MediaPublicEgressRedirectUnsafe");
  assertEquals(fetches, 0);
});

Deno.test("remote media fails with a named failure when atomic public egress is absent", async () => {
  let rawFetches = 0;
  const fixture = pipeline({ publicEgress: undefined, trustedRead: undefined, fetch: async () => { rawFetches += 1; return new Response(png); } });
  const result = await fixture.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", sourceUrl: "https://example.test/lesson", allowedOrigins: ["https://cdn.example.test"], candidate: candidate() });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "MediaPublicEgressUnavailable");
  assertEquals(rawFetches, 0);
});

Deno.test("remote media uses only the injected atomic egress request boundary", async () => {
  let resolverCalls = 0;
  let rawFetches = 0;
  /** @type {Request[]} */ const requests = [];
  const fixture = pipeline({
    resolveAddresses: async () => { resolverCalls += 1; return { ok: true, value: ["93.184.216.34"] }; },
    fetch: async () => { rawFetches += 1; return new Response(png); },
    publicEgress: { fetch: async (/** @type {Request} */ request) => { requests.push(request); return { ok: true, value: new Response(png, { status: 200, headers: { "content-type": "image/png" } }) }; } },
  });
  const result = await fixture.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", sourceUrl: "https://example.test/lesson", allowedOrigins: ["https://cdn.example.test"], candidate: candidate() });
  assertEquals(result.ok, true);
  assertEquals(resolverCalls, 0);
  assertEquals(rawFetches, 0);
  assertEquals(requests.length, 1);
  assertEquals(requests[0].url, "https://cdn.example.test/lesson.png");
  assertEquals(requests[0].method, "GET");
  assertEquals(requests[0].redirect, "error");
});

Deno.test("atomic public egress receives the exact authorized request and preserves typed failures", async () => {
  /** @type {Request[]} */ const received = [];
  const fixture = pipeline({
    publicEgress: { fetch: async (/** @type {Request} */ request) => { received.push(request); return { ok: false, error: { kind: "MediaPublicEgressRedirectUnsafe" } }; } },
  });
  const result = await fixture.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", sourceUrl: "https://example.test/lesson", allowedOrigins: ["https://cdn.example.test"], candidate: candidate() });
  if (received.length !== 1) throw new Error("The public egress boundary did not receive exactly one request.");
  assertEquals(received[0].url, "https://cdn.example.test/lesson.png");
  assertEquals(received[0].method, "GET");
  assertEquals(received[0].redirect, "error");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "MediaPublicEgressRedirectUnsafe");
});

Deno.test("atomic public egress rejects private redirect destinations fail closed", async () => {
  let bytesRead = false;
  const fixture = pipeline({
    publicEgress: { fetch: async () => ({ ok: false, error: { kind: "MediaPublicEgressRedirectUnsafe" } }) },
    digest: async () => { bytesRead = true; return { ok: true, value: "sha256:unexpected" }; },
  });
  const result = await fixture.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", sourceUrl: "https://example.test/lesson", allowedOrigins: ["https://cdn.example.test"], candidate: candidate() });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "MediaPublicEgressRedirectUnsafe");
  assertEquals(bytesRead, false);
});

Deno.test("explicitly trusted same-origin and local fixture reads bypass public egress only", async () => {
  let publicCalls = 0;
  /** @type {Request[]} */ const trustedRequests = [];
  const fixture = pipeline({
    publicEgress: { fetch: async () => { publicCalls += 1; return { ok: false, error: { kind: "MediaPublicEgressUnavailable" } }; } },
    trustedRead: { read: async (/** @type {Request} */ request) => { trustedRequests.push(request); return { ok: true, value: new Response(png, { status: 200, headers: { "content-type": "image/png" } }) }; } },
  });
  const result = await fixture.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-a", sourceUrl: "https://example.test/lesson", allowedOrigins: [], candidate: candidate({ url: "/assets/fixture.png" }) });
  assertEquals(result.ok, true);
  assertEquals(publicCalls, 0);
  assertEquals(trustedRequests.length, 1);
  assertEquals(trustedRequests[0].url, "https://example.test/assets/fixture.png");
  const remote = await fixture.pipeline.ingest({ ownerId: "owner-a", runId: "run-a", knowledgeId: "knowledge-b", sourceUrl: "https://example.test/lesson", allowedOrigins: ["https://cdn.example.test"], candidate: candidate() });
  assertEquals(remote.ok, false);
  if (!remote.ok) assertEquals(remote.error.kind, "MediaPublicEgressUnavailable");
  assertEquals(publicCalls, 1);
});

Deno.test("Cloudflare Images derivative re-encodes to bounded WebP output", async () => {
  let outputOptions = /** @type {Record<string, unknown> | null} */ (null);
  const derivative = createCloudflareImageDerivative({
    input: () => ({
      transform: () => ({
        output: (options) => { outputOptions = options; return { response: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } }) }; },
      }),
      output: () => { throw new Error("raw input output is not allowed"); },
    }),
  });
  const result = await derivative({ assetId: "media-a", variant: "feed", bytes: png, mediaType: "image/png" });
  assertEquals(result.ok, true);
  assertEquals(outputOptions?.format, "image/webp");
  assertEquals(outputOptions?.anim, false);
  if (result.ok) assertEquals(result.value.mediaType, "image/webp");
});

Deno.test("production composes exactly one atomic media public egress without raw fetch or separate DNS", async () => {
  const source = await Deno.readTextFile("worker/knowledge-workflow-entry.mjs");
  assertEquals((source.match(/createMediaPublicEgress\(/gu) ?? []).length, 1);
  const mediaStart = source.indexOf("const media = createMediaPipeline({");
  const mediaEnd = source.indexOf("const imageSearch =", mediaStart);
  if (mediaStart < 0 || mediaEnd < 0) throw new Error("Production media composition was not found.");
  const composition = source.slice(mediaStart, mediaEnd);
  assertEquals((composition.match(/publicEgress/gu) ?? []).length, 1);
  assertEquals(composition.includes("workerFetch"), false);
  assertEquals(composition.includes("globalThis.fetch"), false);
  assertEquals(composition.includes("resolveAddresses"), false);
  const mediaSource = await Deno.readTextFile("src/features/knowledge-workflows/media.js");
  assertEquals(mediaSource.includes("dependencies.fetch("), false);
  assertEquals(mediaSource.includes("resolveAddresses"), false);
});

Deno.test("atomic media public egress validates every hop and preserves distinct named failures", async () => {
  const create = /** @type {(capability: unknown, policy?: { readonly maximumBytes?: number, readonly timeoutMilliseconds?: number, readonly redirectLimit?: number }) => { readonly fetch: (request: Request) => Promise<{ readonly ok: true, readonly value: Response } | { readonly ok: false, readonly error: FutureFailure }> }} */ (futureMedia.createMediaPublicEgress);
  /** @type {unknown} */ let next;
  /** @type {unknown[]} */ const policies = [];
  const egress = create({ request: async (/** @type {Request} */ _request, /** @type {unknown} */ policy) => { policies.push(policy); return next; } }, { maximumBytes: 12, timeoutMilliseconds: 25, redirectLimit: 2 });
  const response = () => new Response(png, { status: 200, headers: { "content-type": "image/png" } });
  const redirectCases = /** @type {const} */ ([
    ["https://10.0.0.1/image.png", "MediaPublicEgressPrivateAddress"],
    ["https://127.0.0.1/image.png", "MediaPublicEgressLoopbackAddress"],
    ["https://169.254.1.1/image.png", "MediaPublicEgressLinkLocalAddress"],
    ["https://192.0.2.1/image.png", "MediaPublicEgressReservedAddress"],
    ["https://user:secret@example.test/image.png", "MediaPublicEgressCredentialsRejected"],
    ["http://example.test/image.png", "MediaPublicEgressNonHttpsUrl"],
  ]);
  for (const [url, kind] of redirectCases) {
    next = { ok: true, value: { response: response(), redirectHops: ["https://safe.example.test/first", url] } };
    const result = await egress.fetch(new Request("https://example.test/start.png"));
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, kind);
  }
  next = { ok: true, value: { response: response(), redirectHops: ["https://one.example/a", "https://two.example/b", "https://three.example/c"] } };
  const redirectLimit = await egress.fetch(new Request("https://example.test/start.png"));
  if (redirectLimit.ok) throw new Error("Redirect limit was not enforced.");
  assertEquals(redirectLimit.error.kind, "MediaPublicEgressRedirectLimitExceeded");
  next = { ok: true, value: { response: response(), redirectHops: ["not a URL"] } };
  const unsafe = await egress.fetch(new Request("https://example.test/start.png"));
  if (unsafe.ok) throw new Error("Unsafe redirect was not rejected.");
  assertEquals(unsafe.error.kind, "MediaPublicEgressRedirectUnsafe");
  next = { ok: true, value: { response: new Response(new Uint8Array(13)), redirectHops: [] } };
  const oversized = await egress.fetch(new Request("https://example.test/start.png"));
  if (oversized.ok) throw new Error("Oversized response was not rejected.");
  assertEquals(oversized.error.kind, "MediaPublicEgressPayloadTooLarge");
  const timeout = create({ request: async () => await new Promise(() => {}) }, { maximumBytes: 12, timeoutMilliseconds: 1, redirectLimit: 2 });
  const timedOut = await timeout.fetch(new Request("https://example.test/start.png"));
  if (timedOut.ok) throw new Error("Timeout was not enforced.");
  assertEquals(timedOut.error.kind, "MediaPublicEgressTimeout");
  const bodyTimeout = create({ request: async () => ({ ok: true, value: { response: new Response(new ReadableStream()), redirectHops: [] } }) }, { maximumBytes: 12, timeoutMilliseconds: 1, redirectLimit: 2 });
  const bodyTimedOut = await bodyTimeout.fetch(new Request("https://example.test/start.png"));
  if (bodyTimedOut.ok) throw new Error("Response-body timeout was not enforced.");
  assertEquals(bodyTimedOut.error.kind, "MediaPublicEgressTimeout");
  next = { ok: false, error: { kind: "MediaPublicEgressRedirectUnsafe" } };
  const delegated = await egress.fetch(new Request("https://example.test/start.png"));
  if (delegated.ok) throw new Error("Platform failure was not preserved.");
  assertEquals(delegated.error.kind, "MediaPublicEgressRedirectUnsafe");
  assertEquals(policies.length > 0, true);
  const policy = /** @type {{ readonly validateEveryRedirect?: unknown, readonly publicAddressesOnly?: unknown, readonly redirectLimit?: unknown }} */ (policies[0]);
  assertEquals(policy.validateEveryRedirect, true);
  assertEquals(policy.publicAddressesOnly, true);
  assertEquals(policy.redirectLimit, 2);
  const unavailable = await create(undefined).fetch(new Request("https://example.test/start.png"));
  if (unavailable.ok) throw new Error("Missing platform egress was not rejected.");
  assertEquals(unavailable.error.kind, "MediaPublicEgressUnavailable");
});

Deno.test("fallbacks resolve only by exact stable ID and local path through the typed user attestation manifest", () => {
  const create = /** @type {(value: unknown) => { readonly ok: true, readonly value: FutureFallbackManifest } | { readonly ok: false, readonly error: FutureFailure }} */ (futureMedia.createUserAttestedLocalManifest);
  const created = create([{ id: "fallback-001", path: "/assets/fallback-media/example.jpg", mediaType: "image/jpeg", width: 10, height: 20, userAttested: true }]);
  assertEquals(created.ok, true);
  if (!created.ok) return;
  const resolved = created.value.resolve({ assetId: "fallback-001", path: "/assets/fallback-media/example.jpg" });
  assertEquals(resolved.ok, true);
  if (resolved.ok) assertEquals(resolved.value.id, "fallback-001");
  for (const path of ["https://example.test/a.jpg", "data:image/png;base64,AA==", "blob:https://example.test/id", "/assets/fallback-media/../secret.jpg", "/assets/fallback-media/%2e%2e/secret.jpg", "/assets/fallback-media/unlisted.jpg"]) {
    const rejected = created.value.resolve({ assetId: "fallback-001", path });
    assertEquals(rejected.ok, false);
    if (!rejected.ok) assertEquals(["FallbackReferenceInvalid", "FallbackAssetUnlisted"].includes(rejected.error.kind), true);
  }
  const mismatched = created.value.resolve({ assetId: "fallback-999", path: "/assets/fallback-media/example.jpg" });
  assertEquals(mismatched.ok, false);
  if (!mismatched.ok) assertEquals(mismatched.error.kind, "FallbackAssetUnlisted");
});

Deno.test("authoritative fallback manifest dynamically validates all 70 files and fails explicitly", async () => {
  const create = /** @type {(value: unknown) => { readonly ok: true, readonly value: FutureFallbackManifest } | { readonly ok: false, readonly error: FutureFailure }} */ (futureMedia.createUserAttestedLocalManifest);
  const validateFiles = /** @type {(manifest: FutureFallbackManifest, read: (path: string) => Promise<Uint8Array>) => Promise<{ readonly ok: true, readonly value: readonly FutureFallbackAsset[] } | { readonly ok: false, readonly error: FutureFailure }>} */ (futureMedia.validateUserAttestedLocalFiles);
  const source = JSON.parse(await Deno.readTextFile("assets/fallback-media/manifest.json"));
  const created = create(source);
  assertEquals(created.ok, true);
  if (!created.ok) return;
  assertEquals(created.value.entries.length, 70);
  const touched = new Set();
  const actual = await validateFiles(created.value, async (path) => {
    touched.add(path);
    return await Deno.readFile(`.${decodeURI(path)}`);
  });
  assertEquals(actual.ok, true);
  assertEquals(touched.size, 70);
  const first = created.value.entries[0];
  const missing = await validateFiles(created.value, async () => { throw new Deno.errors.NotFound("missing"); });
  assertEquals(missing.ok, false);
  if (!missing.ok) assertEquals(missing.error.kind, "FallbackAssetMissing");
  const duplicate = create([...source, { ...source[0], path: "/assets/fallback-media/duplicate.jpg", url: "/assets/fallback-media/duplicate.jpg" }]);
  assertEquals(duplicate.ok, false);
  if (!duplicate.ok) assertEquals(duplicate.error.kind, "FallbackManifestDuplicateId");
  const mismatched = create([{ ...first, width: first.width + 1 }]);
  if (!mismatched.ok) throw new Error("Structurally valid mismatch fixture was rejected early.");
  const metadata = await validateFiles(mismatched.value, (path) => Deno.readFile(`.${decodeURI(path)}`));
  assertEquals(metadata.ok, false);
  if (!metadata.ok) assertEquals(metadata.error.kind, "FallbackAssetMetadataMismatch");
});
