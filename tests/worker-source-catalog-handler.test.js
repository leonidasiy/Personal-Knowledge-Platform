// @ts-check

import { createDiscoveryWorker } from "../worker/handler.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {Partial<{ readonly browseFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure, readonly searchFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure, readonly rejectFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure, readonly browseMode: "throw" | "hang" | "malformed" | "malformed-page", readonly authFailure: "DiscoveryClientUnauthenticated" | "DiscoveryAccessTokenInvalid" }>} [options] */
function fixture(options = {}) {
  /** @type {Record<string, unknown>[]} */
  const commands = [];
  /** @type {Record<string, unknown>[]} */
  const logs = [];
  const source = {
    id: "source-1",
    ownerId: "owner-a",
    submittedUrl: "https://publisher.example/learn",
    canonicalUrl: "https://publisher.example/learn",
    title: "Learning source",
    description: "Description",
    adapter: {
      id: "adapter",
      version: "1",
      granularity: "root",
      capabilities: ["metadata"],
    },
    interestAreaIds: ["area-a"],
    identityEvidence: [],
    state: /** @type {const} */ ("active"),
    approvedAt: "2026-07-22T08:00:00.000Z",
    updatedAt: "2026-07-22T08:00:00.000Z",
    revision: 1,
  };
  const worker = createDiscoveryWorker({
    allowedOrigin: "https://app.example",
    maximumCommandBytes: 4096,
    maximumBackendOperationMs: 5,
  }, {
    authenticate: () => options.authFailure === undefined
      ? Promise.resolve({
        ok: true,
        value: { ownerId: "owner-a", email: "member@example.test" },
      })
      : Promise.resolve({ ok: false, error: { kind: options.authFailure } }),
    createRequestId: () => "corr-source-catalog",
    requestLogger: (entry) => { logs.push(entry); return { ok: true, value: null }; },
    acquireRss: () =>
      Promise.resolve({
        ok: false,
        error: { kind: /** @type {const} */ ("DiscoveryFetchUnavailable") },
      }),
    sourceLibrary: {
      approve: () =>
        Promise.resolve({
          ok: true,
          value: { source, job: null, reused: true },
        }),
      revise: () => Promise.resolve({ ok: true, value: source }),
      disable: () =>
        Promise.resolve({
          ok: true,
          value: { ...source, state: /** @type {const} */ ("disabled") },
        }),
      restore: () => Promise.resolve({ ok: true, value: source }),
      reject: async (command) => {
        commands.push(/** @type {Record<string, unknown>} */ (command));
        if (options.rejectFailure !== undefined) {
          return { ok: false, error: options.rejectFailure };
        }
        return {
          ok: true,
          value: { suppression: { id: "suppression-1" }, reused: false },
        };
      },
    },
    sourceCatalog: {
      browse: async (command) => {
        commands.push(/** @type {Record<string, unknown>} */ (command));
        if (options.browseMode === "throw") throw new Error("D1 unavailable");
        if (options.browseMode === "hang") return await new Promise(() => {});
        if (options.browseMode === "malformed") return /** @type {never} */ ({ ok: true });
        if (options.browseMode === "malformed-page") return /** @type {never} */ ({ ok: true, value: { items: [{}], interestAreas: [], nextCursor: null } });
        if (options.browseFailure !== undefined) {
          return { ok: false, error: options.browseFailure };
        }
        return {
          ok: true,
          value: { items: [source], interestAreas: [], nextCursor: null },
        };
      },
      search: async (command) => {
        commands.push(/** @type {Record<string, unknown>} */ (command));
        if (options.searchFailure !== undefined) {
          return { ok: false, error: options.searchFailure };
        }
        if (/** @type {Record<string, unknown>} */ (command).scope === "knowledge") {
          return { ok: true, value: [{ knowledge: { knowledgeId: "knowledge-1", sourceId: source.id, sourceTitle: source.title, summary: "A cadence resolves tension.", sourceUrl: source.canonicalUrl, evidenceAnchorIds: ["anchor-1"], questionLocked: true }, score: 0.84, matchedBy: /** @type {const} */ ("semantic") }] };
        }
        return { ok: true, value: [{ source, score: 1 }] };
      },
      suppressed: async (command) => {
        commands.push(/** @type {Record<string, unknown>} */ (command));
        return { ok: true, value: ["identity-b"] };
      },
      active: async (command) => {
        commands.push(/** @type {Record<string, unknown>} */ (command));
        return { ok: true, value: ["source-1"] };
      },
    },
    sourceClassification: {
      updateManual: async (command) => {
        commands.push(/** @type {Record<string, unknown>} */ (command));
        if (/** @type {Record<string, unknown>} */ (command).ownerId !== "owner-a") return { ok: false, error: { kind: "SourceClassificationSourceMissing" } };
        return { ok: true, value: { ownerId: "owner-a", sourceId: "source-1", sourceRevision: 1, mainSubject: "music", topic: "Cadential harmony", classificationRevision: 2 } };
      },
    },
    sourceClassificationBackfill: { run: async (command) => { commands.push(/** @type {Record<string, unknown>} */ (command)); return { ok: true, value: { ownerId: "owner-a", counts: { scanned: 2, classified: 1, needsReview: 0, alreadyProcessed: 1, manualPreserved: 0 } } }; } },
  });
  return { worker, commands, logs };
}

Deno.test("source catalog GET routes derive owner and validate query parameters", async () => {
  const { worker, commands } = fixture();
  const browse = await worker.fetch(
    new Request(
      "https://worker.example/api/source-library?limit=20&cursor=signed",
      { headers: { origin: "https://app.example" } },
    ),
  );
  assertEquals(browse.status, 200);
  assertEquals(browse.headers.get("x-resonance-request-id"), "corr-source-catalog");
  const browseBody = await browse.json();
  assertEquals(browseBody.ownerId, "owner-a");
  assertEquals(commands[0].ownerId, "owner-a");
  assertEquals(commands[0].limit, 20);
  assertEquals(commands[0].cursor, "signed");

  const search = await worker.fetch(
    new Request(
      "https://worker.example/api/source-library/search?q=harmony&mode=keyword&limit=10",
      { headers: { origin: "https://app.example" } },
    ),
  );
  assertEquals(search.status, 200);
  assertEquals(commands[1].query, "harmony");
  assertEquals(commands[1].mode, "keyword");

  const defaultCombined = await worker.fetch(
    new Request(
      "https://worker.example/api/source-library/search?q=motion&limit=10",
      { headers: { origin: "https://app.example" } },
    ),
  );
  assertEquals(defaultCombined.status, 200);
  assertEquals(commands[2].query, "motion");
  assertEquals(commands[2].mode, "combined");
});

Deno.test("knowledge search route derives owner, forwards scope, and validates knowledge results", async () => {
  const { worker, commands } = fixture();
  const response = await worker.fetch(new Request(
    "https://worker.example/api/source-library/search?q=cadence&mode=semantic&scope=knowledge&limit=10",
    { headers: { origin: "https://app.example" } },
  ));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ownerId, "owner-a");
  assertEquals(body.result[0].knowledge.knowledgeId, "knowledge-1");
  assertEquals(commands[0].scope, "knowledge");
  assertEquals(commands[0].ownerId, "owner-a");
});

Deno.test("source classification edit derives owner, forwards the source revision contract, and returns a typed conflict", async () => {
  const { worker, commands } = fixture();
  const response = await worker.fetch(new Request("https://worker.example/api/source-library/classification", {
    method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "source-1", sourceRevision: 1, expectedRevision: 1, mainSubject: "music", topic: "Cadential harmony" }),
  }));
  assertEquals(response.status, 200);
  assertEquals(JSON.stringify(commands.at(-1)), JSON.stringify({ sourceId: "source-1", sourceRevision: 1, expectedRevision: 1, mainSubject: "music", topic: "Cadential harmony", ownerId: "owner-a", classification: { mainSubject: "music", topic: "Cadential harmony" } }));
  const ownerOverride = await worker.fetch(new Request("https://worker.example/api/source-library/classification", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerId: "owner-b", sourceId: "source-1", sourceRevision: 1, expectedRevision: 1, mainSubject: "music", topic: "Cadential harmony" }) }));
  assertEquals(ownerOverride.status, 400);
});

Deno.test("source classification backfill derives the authenticated owner and rejects owner overrides", async () => {
  const { worker, commands } = fixture();
  const response = await worker.fetch(new Request("https://worker.example/api/source-library/classification/backfill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageSize: 25 }) }));
  assertEquals(response.status, 200);
  assertEquals(JSON.stringify(commands.at(-1)), JSON.stringify({ ownerId: "owner-a", pageSize: 25 }));
  const override = await worker.fetch(new Request("https://worker.example/api/source-library/classification/backfill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerId: "owner-b", pageSize: 25 }) }));
  assertEquals(override.status, 400);
});

Deno.test("source rejection derives owner and never accepts one from the client", async () => {
  const { worker, commands } = fixture();
  const accepted = await worker.fetch(
    new Request(
      "https://worker.example/api/source-library/reject",
      {
        method: "POST",
        headers: { origin: "https://app.example" },
        body: JSON.stringify({ canonicalIdentity: "identity-a" }),
      },
    ),
  );
  assertEquals(accepted.status, 200);
  assertEquals(commands[0].ownerId, "owner-a");

  const rejected = await worker.fetch(
    new Request(
      "https://worker.example/api/source-library/reject",
      {
        method: "POST",
        headers: { origin: "https://app.example" },
        body: JSON.stringify({
          ownerId: "owner-b",
          canonicalIdentity: "identity-a",
        }),
      },
    ),
  );
  assertEquals(rejected.status, 400);
  assertEquals(commands.length, 1);
});

Deno.test("catalog routes map unavailable and cursor failures without false success", async () => {
  const unavailable = fixture({
    searchFailure: { kind: "SourceKeywordSearchUnavailable" },
  }).worker;
  const search = await unavailable.fetch(
    new Request(
      "https://worker.example/api/source-library/search?q=harmony&mode=keyword&limit=10",
    ),
  );
  assertEquals(search.status, 503);
  assertEquals((await search.json()).error, "SourceKeywordSearchUnavailable");

  const wrongOwner = fixture({
    browseFailure: { kind: "SourceCursorOwnerMismatch" },
  }).worker;
  const page = await wrongOwner.fetch(
    new Request(
      "https://worker.example/api/source-library?limit=10&cursor=wrong-owner",
    ),
  );
  assertEquals(page.status, 403);

  const wrongMethod = await wrongOwner.fetch(
    new Request(
      "https://worker.example/api/source-library?limit=10",
      { method: "POST" },
    ),
  );
  assertEquals(wrongMethod.status, 405);
});

Deno.test("source catalog dependency timeout returns a bounded typed failure and lifecycle logs", async () => {
  const { worker, logs } = fixture({ browseMode: "hang" });
  let fallbackTimer;
  const fallback = new Promise((resolve) => { fallbackTimer = setTimeout(() => resolve(null), 100); });
  const response = await Promise.race([
    worker.fetch(new Request("https://worker.example/api/source-library?limit=10")),
    fallback,
  ]);
  clearTimeout(fallbackTimer);
  if (!(response instanceof Response)) throw new Error("The current handler did not return a bounded response.");
  assertEquals(response.status, 504);
  assertEquals((await response.json()).error, "SourceCatalogDependencyTimedOut");
  assertEquals(logs.some((entry) => entry.event === "dependency-failure" && entry.failureKind === "SourceCatalogDependencyTimedOut"), true);
  assertEquals(logs.some((entry) => entry.event === "request-failure" && entry.status === 504), true);
});

Deno.test("source catalog dependency exceptions and malformed results fail closed with diagnostics", async () => {
  const thrown = fixture({ browseMode: "throw" });
  const thrownResponse = await thrown.worker.fetch(new Request("https://worker.example/api/source-library?limit=10"));
  assertEquals(thrownResponse.status, 503);
  assertEquals((await thrownResponse.json()).error, "SourceCatalogDependencyFailed");
  assertEquals(thrown.logs.some((entry) => entry.failureKind === "SourceCatalogDependencyFailed"), true);

  const malformed = fixture({ browseMode: "malformed" });
  const malformedResponse = await malformed.worker.fetch(new Request("https://worker.example/api/source-library?limit=10"));
  assertEquals(malformedResponse.status, 503);
  assertEquals((await malformedResponse.json()).error, "SourceCatalogResponseInvalid");
  assertEquals(malformed.logs.some((entry) => entry.failureKind === "SourceCatalogResponseInvalid"), true);

  const malformedPage = fixture({ browseMode: "malformed-page" });
  const malformedPageResponse = await malformedPage.worker.fetch(new Request("https://worker.example/api/source-library?limit=10"));
  assertEquals(malformedPageResponse.status, 503);
  assertEquals((await malformedPageResponse.json()).error, "SourceCatalogResponseInvalid");
});

Deno.test("authentication failures are logged without owner or token data", async () => {
  const { worker, logs } = fixture({ authFailure: "DiscoveryAccessTokenInvalid" });
  const response = await worker.fetch(new Request("https://worker.example/api/source-library?limit=10"));
  assertEquals(response.status, 401);
  assertEquals(logs.some((entry) => entry.event === "request-auth-failure" && entry.failureKind === "DiscoveryAccessTokenInvalid"), true);
  assertEquals(logs.some((entry) => Object.hasOwn(entry, "ownerId")), false);
});

Deno.test("suppression checks are authenticated, owner-derived, and bounded commands", async () => {
  const { worker, commands } = fixture();
  const response = await worker.fetch(
    new Request(
      "https://worker.example/api/source-library/suppressions/check",
      {
        method: "POST",
        headers: { origin: "https://app.example" },
        body: JSON.stringify({
          canonicalIdentities: ["identity-a", "identity-b"],
        }),
      },
    ),
  );
  assertEquals(response.status, 200);
  assertEquals(commands[0].ownerId, "owner-a");
  assertEquals((await response.json()).result[0], "identity-b");
});

Deno.test("active source checks are authenticated and owner-derived", async () => {
  const { worker, commands } = fixture();
  const response = await worker.fetch(
    new Request(
      "https://worker.example/api/source-library/active/check",
      {
        method: "POST",
        headers: { origin: "https://app.example" },
        body: JSON.stringify({ sourceIds: ["source-1", "source-disabled"] }),
      },
    ),
  );
  assertEquals(response.status, 200);
  assertEquals(commands[0].ownerId, "owner-a");
  assertEquals((await response.json()).result[0], "source-1");
});
