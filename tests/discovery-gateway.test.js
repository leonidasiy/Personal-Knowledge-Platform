// @ts-check

import { DiscoveryGatewayClient } from "../src/features/discovery/gateway.js";

/** @template T @param {T} actual @param {T} expected */
function equal(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}

const capabilities = Object.freeze([Object.freeze({
  id: "web",
  label: "Web",
  resultKind: "web",
  priority: 1,
  enabled: true,
}), Object.freeze({
  id: "youtube",
  label: "YouTube videos",
  resultKind: "video",
  priority: 2,
  enabled: true,
})]);

const searchResult = Object.freeze({
  ownerId: "owner-a",
  result: Object.freeze({
    items: Object.freeze([Object.freeze({
      providerId: "web",
      resultKind: "web",
      sourceLevel: "site",
      title: "Harmony lessons",
      description: "An educational tutorial in functional harmony.",
      canonicalUrl: "https://music.example/",
      publisherLabel: null,
      publishedAt: null,
      identityEvidence: Object.freeze([Object.freeze({
        attribute: "provider-result-page",
        value: "https://music.example/lessons/harmony",
        provenanceUrl: "https://music.example/lessons/harmony",
      })]),
    })]),
    providerFailures: Object.freeze([]),
    submittedQuery: "harmony",
    providerQuery: "harmony",
    policyVersion: "source-quality-v1",
  }),
});

Deno.test("central discovery gateway reads configured capabilities", async () => {
  /** @type {{readonly request:Request,readonly init:RequestInit}|null} */ let captured = null;
  const client = new DiscoveryGatewayClient({
    fetch: /** @type {typeof fetch} */ (async (input, init) => {
      captured = { request: new Request(input, init), init: init ?? {} };
      return Response.json({ ownerId: "owner-a", result: capabilities });
    }),
    baseUrl: "https://app.example/",
    timeoutMs: 1_000,
  });
  const result = await client.capabilities();
  equal(result.ok, true);
  if (!result.ok || captured === null) return;
  const request = /** @type {{readonly request:Request,readonly init:RequestInit}} */ (captured);
  equal(new URL(request.request.url).pathname, "/api/discovery/search/capabilities");
  equal(request.request.method, "GET");
  equal(request.init.credentials, "same-origin");
  equal(result.value.length, 2);
});

Deno.test("central discovery gateway submits one bounded provider-filtered command", async () => {
  /** @type {{readonly request:Request,readonly init:RequestInit}|null} */ let captured = null;
  const client = new DiscoveryGatewayClient({
    fetch: /** @type {typeof fetch} */ (async (input, init) => {
      captured = { request: new Request(input, init), init: init ?? {} };
      return Response.json(searchResult);
    }),
    baseUrl: "https://app.example/",
    timeoutMs: 1_000,
  });
  const result = await client.search({
    query: " harmony ",
    providerIds: ["web", "youtube"],
    limit: 10,
  });
  equal(result.ok, true);
  if (!result.ok || captured === null) return;
  const request = /** @type {{readonly request:Request,readonly init:RequestInit}} */ (captured);
  equal(new URL(request.request.url).pathname, "/api/discovery/search");
  equal(request.request.method, "POST");
  equal(request.init.cache, "no-store");
  equal(
    await request.request.text(),
    JSON.stringify({ query: " harmony ", providerIds: ["web", "youtube"], limit: 10 }),
  );
  equal(result.value.items[0].description, "An educational tutorial in functional harmony.");
  equal(result.value.policyVersion, "source-quality-v1");
});

Deno.test("central discovery gateway rejects malformed commands and responses", async () => {
  let calls = 0;
  const client = new DiscoveryGatewayClient({
    fetch: /** @type {typeof fetch} */ (async () => {
      calls += 1;
      return Response.json({ result: { items: [{}] } });
    }),
    baseUrl: "https://app.example/",
    timeoutMs: 1_000,
  });
  equal((await client.search({ query: "", providerIds: ["web"], limit: 10 })).ok, false);
  equal((await client.search({ query: "music", providerIds: [], limit: 10 })).ok, false);
  equal((await client.search({ query: "music", providerIds: ["web"], limit: 0 })).ok, false);
  equal(calls, 0);
  const invalid = await client.search({ query: "music", providerIds: ["web"], limit: 10 });
  equal(invalid.ok, false);
  if (!invalid.ok) equal(invalid.error.kind, "DiscoveryGatewayResponseInvalid");
});

Deno.test("central discovery gateway names authentication, quota, provider, and timeout failures", async () => {
  const cases = /** @type {const} */ ([
    [401, {}, "DiscoveryGatewayUnauthenticated"],
    [403, {}, "DiscoveryGatewayUnauthorized"],
    [429, {}, "DiscoveryGatewayRateLimited"],
    [503, { error: "CentralSearchAllProvidersFailed" }, "DiscoveryGatewayRejected"],
  ]);
  for (const [status, body, expected] of cases) {
    const client = new DiscoveryGatewayClient({
      fetch: /** @type {typeof fetch} */ (async () => Response.json(body, { status })),
      baseUrl: "https://app.example/",
      timeoutMs: 1_000,
    });
    const result = await client.search({ query: "music", providerIds: ["web"], limit: 10 });
    equal(result.ok, false);
    if (!result.ok) equal(result.error.kind, expected);
  }
  const timed = new DiscoveryGatewayClient({
    fetch: /** @type {typeof fetch} */ ((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })),
    baseUrl: "https://app.example/",
    timeoutMs: 1,
  });
  const timedResult = await timed.capabilities();
  equal(timedResult.ok, false);
  if (!timedResult.ok) equal(timedResult.error.kind, "DiscoveryGatewayTimedOut");
});

Deno.test("gateway retrieves only a bounded rights-approved publisher excerpt", async () => {
  /** @type {Request[]} */ const sent = [];
  const client = new DiscoveryGatewayClient({
    fetch: /** @type {typeof fetch} */ (async (input, init) => {
      sent.push(new Request(input, init));
      if (String(input).endsWith("/authorize")) return Response.json({ stored: true }, { status: 201 });
      return Response.json({ result: {
        canonicalUrl: "https://publisher.example/transcript.txt",
        text: "A suspension prepares and resolves dissonance.",
        retentionMode: "excerpt",
        rightsExpiresAt: "2027-07-21T23:59:59.999Z",
      } });
    }),
    baseUrl: "https://app.example/",
    timeoutMs: 1_000,
  });
  const result = await client.retrievePublisherTranscript({
    id: "request-1",
    url: "https://publisher.example/transcript.txt",
    lang: "en",
    evidenceId: "license-page-1",
    basis: "Publisher license",
    rights: "https://publisher.example/license",
    credit: "Publisher transcript",
    expires: "2027-07-21T23:59:59.999Z",
    start: 12,
    count: 100,
  });
  equal(result.ok, true);
  equal(sent.length, 2);
  const body = /** @type {Record<string,unknown>} */ (JSON.parse(await sent[1].text()));
  const retention = /** @type {Record<string,unknown>} */ (body.retention);
  equal(retention.mode, "excerpt");
  equal(retention.characterCount, 100);
});

Deno.test("gateway rejects YouTube transcript URLs before outbound work", async () => {
  let calls = 0;
  const client = new DiscoveryGatewayClient({
    fetch: /** @type {typeof fetch} */ (async () => {
      calls += 1;
      return Response.error();
    }),
    baseUrl: "https://app.example/",
    timeoutMs: 1_000,
  });
  const result = await client.retrievePublisherTranscript({
    id: "request-1",
    url: "https://www.youtube.com/watch?v=video-1",
    lang: "en",
    evidenceId: "rights-1",
    basis: "Publisher license",
    rights: "https://publisher.example/license",
    credit: "Publisher",
    expires: "2027-07-21T00:00:00Z",
    start: 0,
    count: 100,
  });
  equal(result.ok, false);
  equal(calls, 0);
});

Deno.test("raw gateway accepts empty results and rejects superseded assessment fields", async () => {
  const empty = {...searchResult.result,items:[]};
  for (const [value,expected] of [[empty,true],[{...empty,assessments:[]},false],[{...empty,selectionOutcome:"NoEligibleCoreSources"},false],[{...empty,items:[{...searchResult.result.items[0],canonicalUrl:"https://secret@host.example/"}]},false]]) {
    const client=new DiscoveryGatewayClient({fetch:async()=>Response.json({result:value}),baseUrl:"https://app.example/",timeoutMs:1000});
    equal((await client.search({query:"harmony",providerIds:["web"],limit:1})).ok,expected);
  }
});
