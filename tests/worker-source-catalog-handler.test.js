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

/** @param {Partial<{ readonly browseFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure, readonly searchFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure, readonly rejectFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure }>} [options] */
function fixture(options = {}) {
  /** @type {Record<string, unknown>[]} */
  const commands = [];
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
  }, {
    authenticate: () =>
      Promise.resolve({
        ok: true,
        value: { ownerId: "owner-a", email: "member@example.test" },
      }),
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
  });
  return { worker, commands };
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
