// @ts-check

import { CloudflareAccessAuthenticator } from "../worker/access-authenticator.js";
import { createDiscoveryWorker } from "../worker/handler.js";
import { YouTubeDiscoveryAdapter } from "../worker/youtube-adapter.js";
import { YouTubeQuotaLedger } from "../worker/youtube-quota.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

function segment(/** @type {unknown} */ value) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
}

/** @param {unknown} claims @param {unknown} [header] */
function accessRequest(claims, header = { alg: "RS256", kid: "key-1" }) {
  const token = `${segment(header)}.${segment(claims)}.${segment("signature")}`;
  return new Request("https://worker.example/api/discovery/rss", {
    headers: { "cf-access-jwt-assertion": token },
  });
}

const accessClaims = Object.freeze({
  iss: "https://team.cloudflareaccess.com",
  aud: ["audience-1"],
  exp: 2_000,
  email: "member@example.test",
});

Deno.test("Access authentication verifies signature, audience, time, and owner mapping", async () => {
  let verified = 0;
  const authenticator = new CloudflareAccessAuthenticator(
    {
      issuer: accessClaims.iss,
      audience: "audience-1",
      ownerByEmail: new Map([[accessClaims.email, "owner-a"]]),
    },
    {
      nowEpochSeconds: () => 1_000,
      keyFor: async () => ({ ok: true, value: { kty: "RSA" } }),
      verify: async () => {
        verified += 1;
        return true;
      },
    },
  );
  const result = await authenticator.authenticate(accessRequest(accessClaims));
  assertEquals(result.ok, true);
  assertEquals(verified, 1);
  if (result.ok) assertEquals(result.value.ownerId, "owner-a");
});

Deno.test("Access authentication names missing, invalid, audience, expiry, and unmapped failures", async () => {
  const make = (ownerByEmail = new Map([[accessClaims.email, "owner-a"]])) =>
    new CloudflareAccessAuthenticator(
      { issuer: accessClaims.iss, audience: "audience-1", ownerByEmail },
      {
        nowEpochSeconds: () => 1_000,
        keyFor: async () => ({ ok: true, value: { kty: "RSA" } }),
        verify: async () => true,
      },
    );
  const cases =
    /** @type {readonly { readonly request: Request, readonly expected: string, readonly authenticator: CloudflareAccessAuthenticator }[]} */ ([
      {
        request: new Request("https://worker.example"),
        expected: "DiscoveryAccessTokenMissing",
        authenticator: make(),
      },
      {
        request: new Request("https://worker.example", {
          headers: { "cf-access-jwt-assertion": "bad" },
        }),
        expected: "DiscoveryAccessTokenInvalid",
        authenticator: make(),
      },
      {
        request: accessRequest({ ...accessClaims, aud: "wrong" }),
        expected: "DiscoveryAccessAudienceMismatch",
        authenticator: make(),
      },
      {
        request: accessRequest({ ...accessClaims, exp: 999 }),
        expected: "DiscoveryAccessTokenInvalid",
        authenticator: make(),
      },
      {
        request: accessRequest(accessClaims),
        expected: "DiscoveryAccessIdentityUnmapped",
        authenticator: make(new Map()),
      },
    ]);
  for (const { request, expected, authenticator } of cases) {
    const result = await authenticator.authenticate(request);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, expected);
  }
});

Deno.test("YouTube quota ledgers keep search queries and general reads distinct", () => {
  const ledger = new YouTubeQuotaLedger({
    searchQueryDailyLimit: 2,
    generalReadDailyLimit: 3,
  });
  assertEquals(
    ledger.reserveSearchQuery({ quotaDay: "2026-07-21" }).ok,
    true,
  );
  assertEquals(
    ledger.reserveSearchQuery({ quotaDay: "2026-07-21" }).ok,
    true,
  );
  const searchExceeded = ledger.reserveSearchQuery({
    quotaDay: "2026-07-21",
  });
  assertEquals(searchExceeded.ok, false);
  if (!searchExceeded.ok) {
    assertEquals(searchExceeded.error.kind, "YouTubeSearchQuotaExceeded");
  }
  assertEquals(
    ledger.reserveGeneralRead({ quotaDay: "2026-07-21", units: 3 }).ok,
    true,
  );
  const generalExceeded = ledger.reserveGeneralRead({
    quotaDay: "2026-07-21",
    units: 1,
  });
  assertEquals(generalExceeded.ok, false);
  if (!generalExceeded.ok) {
    assertEquals(generalExceeded.error.kind, "YouTubeGeneralQuotaExceeded");
  }
  assertEquals(
    ledger.reserveSearchQuery({ quotaDay: "2026-07-22" }).ok,
    true,
  );
  const invalidDay = ledger.reserveGeneralRead({
    quotaDay: "2026-02-30",
    units: 1,
  });
  assertEquals(invalidDay.ok, false);
  if (!invalidDay.ok) {
    assertEquals(invalidDay.error.kind, "YouTubeQuotaReservationInvalid");
  }
});

Deno.test("YouTube search keeps only official link/embed metadata and refresh deadline", async () => {
  const responses = [
    new Response(
      JSON.stringify({
        items: [{
          id: { videoId: "video-1" },
          snippet: {
            title: "Harmony",
            channelTitle: "Publisher",
            publishedAt: "2026-07-01T00:00:00Z",
            description: "must be discarded",
          },
        }],
      }),
      { headers: { "content-type": "application/json" } },
    ),
    new Response(
      JSON.stringify({
        items: [{
          id: "video-1",
          status: { embeddable: true, madeForKids: false },
        }],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  ];
  /** @type {{ readonly kind: string, readonly quotaDay: string, readonly units: number }[]} */
  const reservations = [];
  /** @type {{ readonly url: URL, readonly authorization: string | null }[]} */
  const requests = [];
  const adapter = new YouTubeDiscoveryAdapter(
    { maximumResults: 10, quotaTimeZone: "America/Los_Angeles" },
    {
      fetch: /** @type {typeof fetch} */ (async (input, init) => {
        requests.push({
          url: new URL(String(input)),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return responses.shift() ?? Response.error();
      }),
      now: () => new Date("2026-07-21T00:00:00Z"),
      apiKeyForSearch: () => ({
        ok: true,
        value: "server-api-key",
      }),
      reserveSearchQuery: async ({ quotaDay }) => {
        reservations.push({ kind: "search", quotaDay, units: 1 });
        return { ok: true, value: 1 };
      },
      reserveGeneralRead: async ({ quotaDay, units }) => {
        reservations.push({ kind: "general", quotaDay, units });
        return { ok: true, value: units };
      },
    },
  );
  const result = await adapter.search({ query: "music harmony" });
  assertEquals(result.ok, true);
  assertEquals(
    JSON.stringify(reservations),
    JSON.stringify([
      { kind: "search", quotaDay: "2026-07-20", units: 1 },
      { kind: "general", quotaDay: "2026-07-20", units: 1 },
    ]),
  );
  assertEquals(requests.length, 2);
  assertEquals(requests[0].authorization, null);
  assertEquals(requests[1].authorization, null);
  assertEquals(requests[0].url.searchParams.get("key"), "server-api-key");
  assertEquals(requests[1].url.searchParams.get("key"), "server-api-key");
  if (result.ok) {
    assertEquals(
      result.value[0].canonicalUrl,
      "https://www.youtube.com/watch?v=video-1",
    );
    assertEquals(result.value[0].refreshBy, "2026-08-20T00:00:00.000Z");
    assertEquals("description" in result.value[0], false);
    assertEquals("statistics" in result.value[0], false);
  }
});

Deno.test("YouTube search omits ineligible videos and preserves eligible provider order", async () => {
  let requests = 0;
  const adapter = new YouTubeDiscoveryAdapter(
    { maximumResults: 10, quotaTimeZone: "America/Los_Angeles" },
    {
      fetch: /** @type {typeof fetch} */ (async (input) => {
        requests += 1;
        const ids = [
          "eligible-a",
          "missing",
          "disabled",
          "unknown",
          "eligible-b",
        ];
        return String(input).includes("/search")
          ? new Response(JSON.stringify({
            items: ids.map((videoId) => ({
              id: { videoId },
              snippet: {
                title: videoId,
                channelTitle: "Channel",
                publishedAt: "2026-07-01T00:00:00Z",
              },
            })),
          }))
          : new Response(JSON.stringify({
            items: [
              {
                id: "eligible-a",
                status: { embeddable: true, madeForKids: false },
              },
              {
                id: "disabled",
                status: { embeddable: false, madeForKids: false },
              },
              { id: "unknown", status: { embeddable: true } },
              {
                id: "eligible-b",
                status: { embeddable: true, madeForKids: true },
              },
            ],
          }));
      }),
      now: () => new Date("2026-07-21T00:00:00Z"),
      apiKeyForSearch: () => ({ ok: true, value: "server-api-key" }),
      reserveSearchQuery: async () => ({ ok: true, value: 1 }),
      reserveGeneralRead: async () => ({ ok: true, value: 1 }),
    },
  );
  const result = await adapter.search({ query: "rhythm" });
  assertEquals(result.ok, true);
  assertEquals(requests, 2);
  if (result.ok) {
    assertEquals(result.value.length, 2);
    assertEquals(result.value[0].videoId, "eligible-a");
    assertEquals(result.value[1].videoId, "eligible-b");
  }
});

Deno.test("YouTube search returns an empty result when every video is ineligible", async () => {
  const adapter = new YouTubeDiscoveryAdapter(
    { maximumResults: 10, quotaTimeZone: "America/Los_Angeles" },
    {
      fetch:
        /** @type {typeof fetch} */ (async (input) =>
          String(input).includes("/search")
            ? new Response(JSON.stringify({
              items: [{
                id: { videoId: "disabled" },
                snippet: {
                  title: "Disabled",
                  channelTitle: "Channel",
                  publishedAt: "2026-07-01T00:00:00Z",
                },
              }],
            }))
            : new Response(JSON.stringify({
              items: [{
                id: "disabled",
                status: { embeddable: false, madeForKids: false },
              }],
            }))),
      now: () => new Date("2026-07-21T00:00:00Z"),
      apiKeyForSearch: () => ({ ok: true, value: "server-api-key" }),
      reserveSearchQuery: async () => ({ ok: true, value: 1 }),
      reserveGeneralRead: async () => ({ ok: true, value: 1 }),
    },
  );
  const result = await adapter.search({ query: "vocaloid" });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.length, 0);
});

Deno.test("Empty YouTube search consumes no general-read quota", async () => {
  let generalReservations = 0;
  const adapter = new YouTubeDiscoveryAdapter(
    { maximumResults: 10, quotaTimeZone: "America/Los_Angeles" },
    {
      fetch:
        /** @type {typeof fetch} */ (async () =>
          new Response(JSON.stringify({ items: [] }))),
      now: () => new Date("2026-07-21T00:00:00Z"),
      apiKeyForSearch: () => ({ ok: true, value: "server-api-key" }),
      reserveSearchQuery: async () => ({ ok: true, value: 1 }),
      reserveGeneralRead: async () => {
        generalReservations += 1;
        return { ok: true, value: 1 };
      },
    },
  );
  const result = await adapter.search({ query: "unmatched topic" });
  assertEquals(result.ok, true);
  assertEquals(generalReservations, 0);
});

Deno.test("YouTube quota day follows Los Angeles midnight across DST boundaries", async () => {
  const instants = [
    "2026-03-08T07:59:59Z",
    "2026-03-08T08:00:00Z",
    "2026-11-01T06:59:59Z",
    "2026-11-01T07:00:00Z",
  ].map((value) => new Date(value));
  /** @type {string[]} */
  const quotaDays = [];
  const adapter = new YouTubeDiscoveryAdapter(
    { maximumResults: 10, quotaTimeZone: "America/Los_Angeles" },
    {
      fetch:
        /** @type {typeof fetch} */ (async () =>
          new Response(JSON.stringify({ items: [] }))),
      now: () => instants.shift() ?? new Date(NaN),
      apiKeyForSearch: () => ({ ok: true, value: "server-api-key" }),
      reserveSearchQuery: async ({ quotaDay }) => {
        quotaDays.push(quotaDay);
        return { ok: true, value: 1 };
      },
      reserveGeneralRead: async () => ({ ok: true, value: 1 }),
    },
  );
  for (const query of ["one", "two", "three", "four"]) {
    const result = await adapter.search({ query });
    assertEquals(result.ok, true);
  }
  assertEquals(
    JSON.stringify(quotaDays),
    JSON.stringify([
      "2026-03-07",
      "2026-03-08",
      "2026-10-31",
      "2026-11-01",
    ]),
  );
});

Deno.test("YouTube adapter preserves credential, quota, upstream, and response failures", async () => {
  const configuration = {
    maximumResults: 10,
    quotaTimeZone: "America/Los_Angeles",
  };
  let outbound = 0;
  const missingCredential = new YouTubeDiscoveryAdapter(configuration, {
    fetch: /** @type {typeof fetch} */ (async () => {
      outbound += 1;
      return Response.error();
    }),
    now: () => new Date("2026-07-21T00:00:00Z"),
    apiKeyForSearch: () => ({
      ok: false,
      error: { kind: "YouTubeCredentialMissing" },
    }),
    reserveSearchQuery: async () => ({ ok: true, value: 1 }),
    reserveGeneralRead: async () => ({ ok: true, value: 1 }),
  });
  const missing = await missingCredential.search({ query: "harmony" });
  assertEquals(missing.ok, false);
  if (!missing.ok) {
    assertEquals(missing.error.kind, "YouTubeCredentialMissing");
  }
  assertEquals(outbound, 0);

  const searchQuotaFailure = new YouTubeDiscoveryAdapter(configuration, {
    fetch: /** @type {typeof fetch} */ (async () => {
      outbound += 1;
      return Response.error();
    }),
    now: () => new Date("2026-07-21T00:00:00Z"),
    apiKeyForSearch: () => ({ ok: true, value: "server-api-key" }),
    reserveSearchQuery: async () => ({
      ok: false,
      error: { kind: "YouTubeSearchQuotaExceeded" },
    }),
    reserveGeneralRead: async () => ({ ok: true, value: 1 }),
  });
  const searchQuota = await searchQuotaFailure.search({ query: "harmony" });
  assertEquals(searchQuota.ok, false);
  if (!searchQuota.ok) {
    assertEquals(searchQuota.error.kind, "YouTubeSearchQuotaExceeded");
  }
  assertEquals(outbound, 0);

  const generalQuotaFailure = new YouTubeDiscoveryAdapter(configuration, {
    fetch: /** @type {typeof fetch} */ (async () => {
      outbound += 1;
      return new Response(JSON.stringify({
        items: [{
          id: { videoId: "video-1" },
          snippet: {
            title: "Title",
            channelTitle: "Publisher",
            publishedAt: "2026-07-01T00:00:00Z",
          },
        }],
      }));
    }),
    now: () => new Date("2026-07-21T00:00:00Z"),
    apiKeyForSearch: () => ({ ok: true, value: "server-api-key" }),
    reserveSearchQuery: async () => ({ ok: true, value: 1 }),
    reserveGeneralRead: async () => ({
      ok: false,
      error: { kind: "YouTubeGeneralQuotaExceeded" },
    }),
  });
  const generalQuota = await generalQuotaFailure.search({ query: "harmony" });
  assertEquals(generalQuota.ok, false);
  if (!generalQuota.ok) {
    assertEquals(generalQuota.error.kind, "YouTubeGeneralQuotaExceeded");
  }
  assertEquals(outbound, 1);

  const upstreamFailure = new YouTubeDiscoveryAdapter(configuration, {
    fetch: /** @type {typeof fetch} */ (async () => {
      throw new TypeError("network unavailable");
    }),
    now: () => new Date("2026-07-21T00:00:00Z"),
    apiKeyForSearch: () => ({ ok: true, value: "server-api-key" }),
    reserveSearchQuery: async () => ({ ok: true, value: 1 }),
    reserveGeneralRead: async () => ({ ok: true, value: 1 }),
  });
  const upstream = await upstreamFailure.search({ query: "harmony" });
  assertEquals(upstream.ok, false);
  if (!upstream.ok) {
    assertEquals(upstream.error.kind, "YouTubeUpstreamUnavailable");
  }

  const invalidResponse = new YouTubeDiscoveryAdapter(configuration, {
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response("not json", { status: 200 })),
    now: () =>
      new Date("2026-07-21T00:00:00Z"),
    apiKeyForSearch: () => ({ ok: true, value: "server-api-key" }),
    reserveSearchQuery: async () => ({ ok: true, value: 1 }),
    reserveGeneralRead: async () => ({ ok: true, value: 1 }),
  });
  const invalid = await invalidResponse.search({ query: "harmony" });
  assertEquals(invalid.ok, false);
  if (!invalid.ok) assertEquals(invalid.error.kind, "YouTubeResponseInvalid");
});

Deno.test("YouTube adapter distinguishes provider quota from a rejected API key", async () => {
  const adapterFor = (/** @type {Response} */ response) =>
    new YouTubeDiscoveryAdapter(
      { maximumResults: 10, quotaTimeZone: "America/Los_Angeles" },
      {
        fetch: /** @type {typeof fetch} */ (async () => response),
        now: () => new Date("2026-07-21T00:00:00Z"),
        apiKeyForSearch: () => ({
          ok: true,
          value: "server-api-key",
        }),
        reserveSearchQuery: async () => ({ ok: true, value: 1 }),
        reserveGeneralRead: async () => ({ ok: true, value: 1 }),
      },
    );
  const providerQuota = await adapterFor(
    new Response(
      JSON.stringify({
        error: { errors: [{ reason: "quotaExceeded" }] },
      }),
      { status: 403 },
    ),
  ).search({ query: "harmony" });
  assertEquals(providerQuota.ok, false);
  if (!providerQuota.ok) {
    assertEquals(providerQuota.error.kind, "YouTubeProviderQuotaExceeded");
  }
  const rejected = await adapterFor(
    new Response(
      JSON.stringify({
        error: { errors: [{ reason: "forbidden" }] },
      }),
      { status: 403 },
    ),
  ).search({ query: "harmony" });
  assertEquals(rejected.ok, false);
  if (!rejected.ok) {
    assertEquals(rejected.error.kind, "YouTubeCredentialRejected");
  }
});

Deno.test("Worker retires raw YouTube, caption, and media routes", async () => {
  const worker = createDiscoveryWorker(
    { allowedOrigin: "https://app.example", maximumCommandBytes: 512 },
    {
      authenticate: async () => ({
        ok: true,
        value: { ownerId: "owner-a", email: "member@example.test" },
      }),
      acquireRss: async () => ({
        ok: false,
        error: { kind: "DiscoveryFetchUnavailable" },
      }),
    },
  );
  const response = await worker.fetch(
    new Request("https://worker.example/api/discovery/youtube/search", {
      method: "POST",
      headers: { origin: "https://app.example" },
      body: JSON.stringify({ query: "harmony" }),
    }),
  );
  assertEquals(response.status, 404);
  const captionRoute = await worker.fetch(
    new Request("https://worker.example/api/discovery/youtube/captions", {
      method: "POST",
      headers: { origin: "https://app.example" },
      body: JSON.stringify({ videoId: "video-1" }),
    }),
  );
  assertEquals(captionRoute.status, 404);
});

Deno.test("Worker exposes one authenticated central search and provider capabilities", async () => {
  /** @type {unknown} */ let received = null;
  const worker = createDiscoveryWorker(
    { allowedOrigin: "https://app.example", maximumCommandBytes: 512 },
    {
      authenticate: async () => ({
        ok: true,
        value: { ownerId: "owner-a", email: "member@example.test" },
      }),
      acquireRss: async () => ({ ok: false, error: { kind: "DiscoveryFetchUnavailable" } }),
      centralSearch: {
        capabilities: () => Object.freeze([Object.freeze({
          id: "web",
          label: "Web",
          resultKind: "web",
          priority: 1,
          enabled: true,
        })]),
        search: async (command) => {
          received = command;
          return {
            ok: /** @type {const} */ (true),
            value: Object.freeze({
              items: Object.freeze([]),
              providerFailures: Object.freeze([]),
              submittedQuery: "harmony",
              providerQuery: "harmony tutorial lesson course educational",
              policyVersion: "educational-v1",
            }),
          };
        },
      },
    },
  );
  const capabilities = await worker.fetch(new Request(
    "https://worker.example/api/discovery/search/capabilities",
    { headers: { origin: "https://app.example" } },
  ));
  assertEquals(capabilities.status, 200);
  const capabilityBody = /** @type {Record<string,unknown>} */ (await capabilities.json());
  assertEquals(
    JSON.stringify(capabilityBody.result),
    JSON.stringify([{ id: "web", label: "Web", resultKind: "web", priority: 1, enabled: true }]),
  );
  const searched = await worker.fetch(new Request(
    "https://worker.example/api/discovery/search",
    {
      method: "POST",
      headers: { origin: "https://app.example" },
      body: JSON.stringify({ query: " harmony ", providerIds: ["web"], limit: 10 }),
    },
  ));
  assertEquals(searched.status, 200);
  assertEquals(
    JSON.stringify(received),
    JSON.stringify({ query: " harmony ", providerIds: ["web"], limit: 10 }),
  );
});

Deno.test("Worker names unavailable and invalid central search outcomes", async () => {
  const base = {
    authenticate: async () => ({
      ok: /** @type {const} */ (true),
      value: { ownerId: "owner-a", email: "member@example.test" },
    }),
    acquireRss: async () => ({ ok: /** @type {const} */ (false), error: { kind: /** @type {const} */ ("DiscoveryFetchUnavailable") } }),
  };
  const unavailable = createDiscoveryWorker(
    { allowedOrigin: "https://app.example", maximumCommandBytes: 512 },
    base,
  );
  const unavailableResponse = await unavailable.fetch(new Request(
    "https://worker.example/api/discovery/search",
    { method: "POST", body: JSON.stringify({ query: "music", providerIds: ["web"], limit: 10 }) },
  ));
  assertEquals(unavailableResponse.status, 503);
  const failed = createDiscoveryWorker(
    { allowedOrigin: "https://app.example", maximumCommandBytes: 512 },
    {
      ...base,
      centralSearch: {
        capabilities: () => [],
        search: async () => ({
          ok: /** @type {const} */ (false),
          error: { kind: /** @type {const} */ ("CentralSearchAllProvidersFailed"), failures: [] },
        }),
      },
    },
  );
  const failedResponse = await failed.fetch(new Request(
    "https://worker.example/api/discovery/search",
    { method: "POST", body: JSON.stringify({ query: "music", providerIds: ["web"], limit: 10 }) },
  ));
  assertEquals(failedResponse.status, 503);
  const body = /** @type {Record<string,unknown>} */ (await failedResponse.json());
  assertEquals(body.error, "CentralSearchAllProvidersFailed");
});
