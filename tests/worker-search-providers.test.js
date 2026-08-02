// @ts-check

import { createBraveSearchProvider } from "../worker/brave-search-adapter.js";
import { createTaddySearchProvider } from "../worker/taddy-search-adapter.js";
import { createYouTubeSearchProvider } from "../worker/youtube-search-provider.js";

/** @template T @param {T} actual @param {T} expected */
function equal(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

const command = Object.freeze({
  providerId: "web",
  query: "vocal technique tutorial lesson course educational",
  limit: 8,
});

Deno.test("Brave provider forwards the augmented query and returns site roots", async () => {
  /** @type {URL|null} */ let requestedUrl = null;
  /** @type {Headers|null} */ let requestedHeaders = null;
  const provider = createBraveSearchProvider(
    {
      providerId: "web",
      label: "Web",
      resultKind: "web",
      priority: 1,
      enabled: true,
      maximumResults: 20,
      apiVersion: "2023-10-11",
    },
    {
      credential: () => ({ ok: true, value: "brave-secret" }),
      fetch: async (input, init) => {
        requestedUrl = new URL(String(input));
        requestedHeaders = new Headers(init?.headers);
        return Response.json({
          web: {
            results: [{
              title: "Singing lessons for healthy technique",
              url: "https://voice.example/articles/breath-support?ref=search",
              description: "A practical tutorial for vocalists.",
            }, {
              title: "Duplicate singing course",
              url: "https://voice.example/courses/foundations",
              description: "Educational course material.",
            }],
          },
        });
      },
    },
  );
  const result = await provider.search(command);
  equal(result.ok, true);
  if (!result.ok || requestedUrl === null || requestedHeaders === null) return;
  const braveUrl = /** @type {URL} */ (requestedUrl);
  const braveHeaders = /** @type {Headers} */ (requestedHeaders);
  equal(braveUrl.searchParams.get("q"), command.query);
  equal(braveUrl.searchParams.get("count"), "8");
  equal(braveUrl.searchParams.get("safesearch"), "strict");
  equal(braveHeaders.get("x-subscription-token"), "brave-secret");
  equal(result.value.length, 1);
  equal(result.value[0].canonicalUrl, "https://voice.example/");
  equal(result.value[0].sourceLevel, "site");
  equal(
    result.value[0].identityEvidence[0].provenanceUrl,
    "https://voice.example/articles/breath-support?ref=search",
  );
});

Deno.test("Brave provider reports credential, quota, and document failures", async () => {
  const missing = createBraveSearchProvider(
    {
      providerId: "web",
      label: "Web",
      resultKind: "web",
      priority: 1,
      enabled: false,
      maximumResults: 20,
      apiVersion: "2023-10-11",
    },
    {
      credential: () => ({
        ok: false,
        error: { kind: "SearchProviderCredentialMissing" },
      }),
      fetch,
    },
  );
  const missingResult = await missing.search(command);
  equal(missingResult.ok, false);
  if (!missingResult.ok) {
    equal(missingResult.error.kind, "SearchProviderCredentialMissing");
  }
  const quota = createBraveSearchProvider(
    { providerId: missing.descriptor.id, label: missing.descriptor.label, resultKind: missing.descriptor.resultKind, priority: missing.descriptor.priority, enabled: true, maximumResults: 20, apiVersion: "2023-10-11" },
    {
      credential: () => ({ ok: true, value: "secret" }),
      fetch: async () => new Response(null, { status: 429 }),
    },
  );
  const quotaResult = await quota.search(command);
  equal(quotaResult.ok, false);
  if (!quotaResult.ok) equal(quotaResult.error.kind, "SearchProviderQuotaExceeded");
  const invalid = createBraveSearchProvider(
    { providerId: missing.descriptor.id, label: missing.descriptor.label, resultKind: missing.descriptor.resultKind, priority: missing.descriptor.priority, enabled: true, maximumResults: 20, apiVersion: "2023-10-11" },
    {
      credential: () => ({ ok: true, value: "secret" }),
      fetch: async () => Response.json({ web: { results: [{}] } }),
    },
  );
  const invalidResult = await invalid.search(command);
  equal(invalidResult.ok, false);
  if (!invalidResult.ok) equal(invalidResult.error.kind, "SearchProviderResponseInvalid");
});

Deno.test("Taddy provider sends one bounded series-only educational GraphQL query", async () => {
  /** @type {URL|null} */ let requestedUrl = null;
  /** @type {Headers|null} */ let requestedHeaders = null;
  /** @type {unknown} */ let requestedBody = null;
  const provider = createTaddySearchProvider(
    {
      providerId: "podcasts",
      label: "Podcasts",
      resultKind: "podcast",
      priority: 2,
      enabled: true,
      maximumResults: 6,
      timeoutMs: 5_000,
    },
    {
      credentials: () => ({
        ok: true,
        value: { userId: "user-7", apiKey: "taddy-secret" },
      }),
      timeoutSignal: () => new AbortController().signal,
      fetch: async (input, init) => {
        requestedUrl = new URL(String(input));
        requestedHeaders = new Headers(init?.headers);
        requestedBody = JSON.parse(String(init?.body));
        return Response.json({
          data: { search: {
            podcastSeries: [{
              uuid: "6bdfd429-f58b-427d-8072-353d478aa15f",
              name: "Song Exploder lessons",
              description: "An educational course in song analysis.",
              websiteUrl: "https://show.example/song-exploder",
              rssUrl: "https://feeds.example/song-exploder.xml",
              authorName: "Example Radio",
              isBlocked: false,
              feedRefreshDetails: {
                uuid: "9f9d9083-e718-47cd-b7f1-62abdd18d270",
                priority: "HIGH",
                priorityReason: null,
                dateLastRefreshed: 1785242096,
              },
            }],
            rankingDetails: [{
              uuid: "6bdfd429-f58b-427d-8072-353d478aa15f",
              rankingScore: 0.875,
            }],
          } },
        });
      },
    },
  );
  const result = await provider.search({ ...command, providerId: "podcasts" });
  equal(result.ok, true);
  if (!result.ok || requestedUrl === null || requestedHeaders === null) return;
  const podcastUrl = /** @type {URL} */ (requestedUrl),
    podcastHeaders = /** @type {Headers} */ (requestedHeaders),
    body = /** @type {Record<string,unknown>} */ (requestedBody);
  equal(podcastUrl.href, "https://api.taddy.org/");
  equal(podcastHeaders.get("x-user-id"), "user-7");
  equal(podcastHeaders.get("x-api-key"), "taddy-secret");
  equal(podcastHeaders.get("content-type"), "application/json");
  equal(JSON.stringify(body.variables), JSON.stringify({ term: command.query, limit: 6 }));
  const query = String(body.query);
  equal(query.includes("filterForTypes:PODCASTSERIES"), true);
  equal(query.includes("isSafeMode:true"), true);
  equal(query.includes("podcastEpisodes"), false);
  equal(query.includes("audioUrl"), false);
  equal(query.includes("imageUrl"), false);
  equal(query.includes("transcript"), false);
  equal(result.value[0].canonicalUrl, "https://feeds.example/song-exploder.xml");
  equal(result.value[0].sourceLevel, "feed");
  equal(result.value[0].identityEvidence.some((entry) => entry.attribute === "taddy-series-uuid"), true);
  equal(result.value[0].identityEvidence.some((entry) => entry.attribute === "taddy-ranking-score"), true);
  equal(result.value[0].identityEvidence.some((entry) => entry.attribute === "taddy-feed-refresh-priority"), true);
});

Deno.test("Taddy provider maps transport and GraphQL failures distinctly", async () => {
  const configuration = {
    providerId: "podcasts",
    label: "Podcasts",
    resultKind: "podcast",
    priority: 2,
    enabled: true,
    maximumResults: 20,
    timeoutMs: 5_000,
  };
  const credentials = () => ({
    ok: /** @type {const} */ (true),
    value: { userId: "user-7", apiKey: "secret" },
  });
  const cases = [
    ["SearchProviderCredentialMissing", () => createTaddySearchProvider(configuration, {
      credentials: () => ({ ok: false, error: { kind: /** @type {const} */ ("SearchProviderCredentialMissing") } }),
      timeoutSignal: () => new AbortController().signal,
      fetch,
    })],
    ["SearchProviderCredentialRejected", () => createTaddySearchProvider(configuration, {
      credentials, timeoutSignal: () => new AbortController().signal,
      fetch: async () => new Response(null, { status: 401 }),
    })],
    ["SearchProviderQuotaExceeded", () => createTaddySearchProvider(configuration, {
      credentials, timeoutSignal: () => new AbortController().signal,
      fetch: async () => new Response(null, { status: 429 }),
    })],
    ["SearchProviderUpstreamRejected", () => createTaddySearchProvider(configuration, {
      credentials, timeoutSignal: () => new AbortController().signal,
      fetch: async () => new Response(null, { status: 502 }),
    })],
    ["SearchProviderNetworkFailed", () => createTaddySearchProvider(configuration, {
      credentials, timeoutSignal: () => new AbortController().signal,
      fetch: async () => { throw new TypeError("network unavailable"); },
    })],
    ["SearchProviderTimedOut", () => createTaddySearchProvider(configuration, {
      credentials, timeoutSignal: () => AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
      fetch: async (_input, init) => { throw init?.signal?.reason; },
    })],
    ["SearchProviderGraphqlRejected", () => createTaddySearchProvider(configuration, {
      credentials, timeoutSignal: () => new AbortController().signal,
      fetch: async () => Response.json({ errors: [{ code: "BAD_USER_INPUT", message: "invalid" }], data: { search: null } }),
    })],
    ["SearchProviderCredentialRejected", () => createTaddySearchProvider(configuration, {
      credentials, timeoutSignal: () => new AbortController().signal,
      fetch: async () => Response.json({ errors: [{ code: "API_KEY_INVALID", message: "invalid key" }] }),
    })],
    ["SearchProviderQuotaExceeded", () => createTaddySearchProvider(configuration, {
      credentials, timeoutSignal: () => new AbortController().signal,
      fetch: async () => Response.json({ errors: [{ code: "API_RATE_LIMIT_EXCEEDED", message: "quota" }] }),
    })],
    ["SearchProviderResponseInvalid", () => createTaddySearchProvider(configuration, {
      credentials, timeoutSignal: () => new AbortController().signal,
      fetch: async () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    })],
  ];
  for (const [expected, create] of cases) {
    const result = await /** @type {()=>ReturnType<typeof createTaddySearchProvider>} */ (create)()
      .search({ ...command, providerId: "podcasts" });
    equal(result.ok, false);
    if (!result.ok) equal(result.error.kind, expected);
  }
});

Deno.test("Taddy provider fails closed for blocked, private, duplicate, invalid, or missing feeds", async () => {
  const configuration = { providerId: "podcasts", label: "Podcasts", resultKind: "podcast", priority: 2, enabled: true, maximumResults: 20, timeoutMs: 5_000 };
  const series = {
    uuid: "6bdfd429-f58b-427d-8072-353d478aa15f",
    name: "Music course",
    description: "Tutorial",
    websiteUrl: "https://show.example/",
    rssUrl: "https://feeds.example/show.xml",
    authorName: "Teacher",
    isBlocked: false,
    feedRefreshDetails: { uuid: "9f9d9083-e718-47cd-b7f1-62abdd18d270", priority: "REGULAR", priorityReason: null, dateLastRefreshed: 1785242096 },
  };
  const cases = [
    ["SearchProviderFeedBlocked", { ...series, isBlocked: true }],
    ["SearchProviderFeedPrivate", { ...series, feedRefreshDetails: { ...series.feedRefreshDetails, priority: "NEVER", priorityReason: "PRIVATE_PODCAST_FEED" } }],
    ["SearchProviderFeedDuplicate", { ...series, feedRefreshDetails: { ...series.feedRefreshDetails, priority: "LOW", priorityReason: "DUPLICATE_FEED" } }],
    ["SearchProviderFeedInvalid", { ...series, feedRefreshDetails: { ...series.feedRefreshDetails, priority: "LOW", priorityReason: "FEED_URL_NOT_WORKING" } }],
    ["SearchProviderFeedInvalid", { ...series, rssUrl: "http://feeds.example/show.xml" }],
    ["SearchProviderFeedMissing", { ...series, rssUrl: null }],
  ];
  for (const [expected, item] of cases) {
    const provider = createTaddySearchProvider(configuration, {
      credentials: () => ({ ok: true, value: { userId: "user-7", apiKey: "secret" } }),
      timeoutSignal: () => new AbortController().signal,
      fetch: async () => Response.json({ data: { search: {
        podcastSeries: [item],
        rankingDetails: [{ uuid: series.uuid, rankingScore: 0.5 }],
      } } }),
    });
    const result = await provider.search({ ...command, providerId: "podcasts" });
    equal(result.ok, false);
    if (!result.ok) equal(result.error.kind, expected);
  }
});

Deno.test("Taddy provider rejects a malformed mixed batch atomically", async () => {
  const provider = createTaddySearchProvider(
    { providerId: "podcasts", label: "Podcasts", resultKind: "podcast", priority: 2, enabled: true, maximumResults: 20, timeoutMs: 5_000 },
    {
      credentials: () => ({ ok: true, value: { userId: "user-7", apiKey: "secret" } }),
      timeoutSignal: () => new AbortController().signal,
      fetch: async () => Response.json({ data: { search: {
        podcastSeries: [{
          uuid: "6bdfd429-f58b-427d-8072-353d478aa15f", name: "Valid lesson", description: "Course",
          websiteUrl: null, rssUrl: "https://feeds.example/valid.xml", authorName: null, isBlocked: false,
          feedRefreshDetails: { uuid: "9f9d9083-e718-47cd-b7f1-62abdd18d270", priority: "REGULAR", priorityReason: null, dateLastRefreshed: 1785242096 },
        }, { uuid: "not-a-uuid" }],
        rankingDetails: [{ uuid: "6bdfd429-f58b-427d-8072-353d478aa15f", rankingScore: 0.5 }],
      } } }),
    },
  );
  const result = await provider.search({ ...command, providerId: "podcasts" });
  equal(result.ok, false);
  if (!result.ok) equal(result.error.kind, "SearchProviderResponseInvalid");
});

Deno.test("YouTube provider forwards the centralized query without modifying it", async () => {
  /** @type {unknown} */ let received = null;
  const provider = createYouTubeSearchProvider(
    {
      providerId: "youtube",
      label: "YouTube videos",
      resultKind: "video",
      priority: 3,
      enabled: true,
    },
    {
      adapter: {
        search: async (input) => {
          received = input;
          return {
            ok: /** @type {const} */ (true),
            value: [{
              videoId: "video-1",
              title: "Vocaloid tuning tutorial",
              publisherLabel: "Music Teacher",
              publishedAt: "2026-07-01T00:00:00.000Z",
              canonicalUrl: "https://www.youtube.com/watch?v=video-1",
              embedUrl: "https://www.youtube-nocookie.com/embed/video-1",
              madeForKids: false,
              refreshBy: "2026-08-01T00:00:00.000Z",
            }],
          };
        },
      },
    },
  );
  const result = await provider.search({ ...command, providerId: "youtube" });
  equal(JSON.stringify(received), JSON.stringify({ query: command.query }));
  equal(result.ok, true);
  if (!result.ok) return;
  equal(result.value[0].sourceLevel, "video");
  equal(result.value[0].canonicalUrl, "https://www.youtube.com/watch?v=video-1");
});

Deno.test("YouTube provider maps quota and response failures", async () => {
  const create = (/** @type {string} */ kind) => createYouTubeSearchProvider(
    {
      providerId: "youtube",
      label: "YouTube videos",
      resultKind: "video",
      priority: 3,
      enabled: true,
    },
    { adapter: { search: async () => ({ ok: false, error: { kind } }) } },
  );
  const quota = await create("YouTubeProviderQuotaExceeded").search({
    ...command,
    providerId: "youtube",
  });
  equal(quota.ok, false);
  if (!quota.ok) equal(quota.error.kind, "SearchProviderQuotaExceeded");
  const invalid = await create("YouTubeResponseInvalid").search({
    ...command,
    providerId: "youtube",
  });
  equal(invalid.ok, false);
  if (!invalid.ok) equal(invalid.error.kind, "SearchProviderResponseInvalid");
});
