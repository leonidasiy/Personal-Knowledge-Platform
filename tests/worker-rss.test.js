// @ts-check

import { validatePublisherDestination } from "../worker/destination-policy.js";
import { parseNormalizedFeed } from "../worker/feed-parser.js";
import { createDiscoveryWorker } from "../worker/handler.js";
import { RssAtomAcquisitionAdapter } from "../worker/rss-atom-adapter.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const policy = Object.freeze({
  maximumBytes: 2_048,
  maximumRedirects: 1,
  timeoutMs: 1_000,
});
const digest = async (/** @type {Uint8Array} */ bytes) => ({
  ok: true,
  value: `sha256-${bytes.byteLength}`,
});
const command = Object.freeze({
  sourceUrl: "https://publisher.example/feed.xml",
  requestId: "request-1",
  etag: null,
  lastModified: null,
});
const rssDocument = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>Publisher Notes</title><link>https://publisher.example/</link>
<item><guid isPermaLink="false">episode-1</guid><title>Cadence study</title>
<link>https://publisher.example/episodes/1</link><pubDate>Mon, 20 Jul 2026 12:00:00 GMT</pubDate>
<description>Body that must not cross the Worker boundary.</description>
<enclosure url="https://publisher.example/audio.mp3" type="audio/mpeg" length="2048" />
</item></channel></rss>`;

Deno.test("destination policy accepts HTTPS publishers and rejects unsafe targets", () => {
  assertEquals(
    validatePublisherDestination("https://publisher.example/feed").ok,
    true,
  );
  for (
    const url of [
      "http://publisher.example/feed",
      "https://user:secret@publisher.example/feed",
      "https://publisher.example:444/feed",
      "https://localhost/feed",
      "https://127.0.0.1/feed",
      "https://169.254.1.1/feed",
      "https://[::1]/feed",
    ]
  ) assertEquals(validatePublisherDestination(url).ok, false);
});

Deno.test("RSS adapter acquires bounded XML with conditional headers and digest", async () => {
  let seenEtag = "";
  const adapter = new RssAtomAcquisitionAdapter({
    fetch: /** @type {typeof fetch} */ (async (_input, init) => {
      seenEtag = new Headers(init?.headers).get("if-none-match") ?? "";
      return new Response(rssDocument, {
        headers: {
          "content-type": "application/rss+xml; charset=utf-8",
          etag: '"next"',
        },
      });
    }),
    now: () => "2026-07-21T00:00:00.000Z",
    digest,
    policy,
  });
  const result = await adapter.acquire({ ...command, etag: '"previous"' });
  assertEquals(result.ok, true);
  assertEquals(seenEtag, '"previous"');
  if (result.ok && result.value.status === "acquired") {
    assertEquals(result.value.digest, `sha256-${rssDocument.length}`);
    assertEquals(result.value.etag, '"next"');
    assertEquals(result.value.feed.format, "rss2");
    assertEquals(
      result.value.feed.source.identityKey,
      "https://publisher.example/",
    );
    assertEquals(result.value.feed.items[0].identityKey, "episode-1");
    assertEquals(result.value.feed.items[0].publisherLabel, "Publisher Notes");
    assert(
      result.value.feed.items[0].contentDigest.startsWith("sha256-"),
      "Each normalized item must carry deterministic content evidence.",
    );
    assertEquals("documentText" in result.value, false);
    const podcast = result.value.feed.items[0].podcast;
    assert(podcast !== null, "RSS enclosure metadata must be retained.");
    if (podcast !== null) {
      assertEquals(podcast.namespaceEvidencePresent, false);
      assertEquals(podcast.namespaceUri, null);
      assertEquals(podcast.transcripts.length, 0);
      assertEquals(
        podcast.enclosure.url,
        "https://publisher.example/audio.mp3",
      );
    }
    const serialized = JSON.stringify(result.value);
    assertEquals(serialized.includes("Body that must not cross"), false);
    assertEquals(serialized.includes("audio.mp3"), true);
  }
});

Deno.test("RSS adapter projects bounded Podcasting 2.0 references without fetching them", async () => {
  const podcastDocument = `<?xml version="1.0"?>
<rss version="2.0" xmlns:audio="https://podcastindex.org/namespace/1.0"><channel>
<title>Publisher Podcast</title><link>https://publisher.example/</link>
<language>en-US</language>
<item><guid isPermaLink="false">episode-podcast-1</guid>
<title>Harmonic rhythm</title><link>https://publisher.example/episodes/harmonic-rhythm</link>
<description>Source body that must not cross the Worker boundary.</description>
<audio:transcript url="https://publisher.example/transcripts/episode.vtt#cue" type="text/vtt" />
<audio:transcript url="https://publisher.example/transcripts/episode.txt" type="text/plain" language="fr" rel="captions" />
<enclosure url="https://cdn.publisher.example/audio/episode.mp3#media" type="audio/mpeg" length="43200000" />
</item></channel></rss>`;
  let fetchCalls = 0;
  /** @type {string[]} */
  const digested = [];
  const adapter = new RssAtomAcquisitionAdapter({
    fetch: /** @type {typeof fetch} */ (async () => {
      fetchCalls += 1;
      return new Response(podcastDocument, {
        headers: { "content-type": "application/rss+xml" },
      });
    }),
    now: () => "2026-07-21T00:00:00.000Z",
    digest: (bytes) => {
      digested.push(new TextDecoder().decode(bytes));
      return Promise.resolve({ ok: true, value: `sha256-${bytes.byteLength}` });
    },
    policy: { ...policy, maximumBytes: 4_096 },
  });
  const result = await adapter.acquire(command);
  assertEquals(result.ok, true);
  assertEquals(fetchCalls, 1);
  if (!result.ok || result.value.status !== "acquired") return;
  const podcast = result.value.feed.items[0].podcast;
  assert(podcast !== null, "Podcast references must be projected.");
  if (podcast === null) return;
  assertEquals(
    podcast.namespaceUri,
    "https://podcastindex.org/namespace/1.0",
  );
  assertEquals(podcast.namespaceEvidencePresent, true);
  assertEquals(podcast.feedLanguageSelector, "rss/channel/language");
  assertEquals(podcast.transcripts.length, 2);
  assertEquals(podcast.transcripts[0].language, "en-us");
  assertEquals(podcast.transcripts[0].languageSource, "feed");
  assertEquals(
    podcast.transcripts[0].url,
    "https://publisher.example/transcripts/episode.vtt",
  );
  assertEquals(podcast.transcripts[1].languageSource, "transcript");
  assertEquals(
    podcast.enclosure.url,
    "https://cdn.publisher.example/audio/episode.mp3",
  );
  assertEquals(podcast.enclosure.declaredLength, 43200000);
  assertEquals(digested.length, 2);
  assertEquals(digested[1].includes("episode.vtt"), true);
  const serialized = JSON.stringify(result.value);
  assertEquals(serialized.includes("Source body that must not cross"), false);
  assertEquals("body" in podcast.transcripts[0], false);
});

Deno.test("RSS adapter names malformed podcast references and enforces their bound", async () => {
  const transcript =
    `<podcast:transcript url="https://publisher.example/episode.vtt" type="text/vtt" />`;
  const cases = [
    {
      body:
        `<podcast:transcript url="http://publisher.example/episode.vtt" type="text/vtt" />
        <enclosure url="https://publisher.example/episode.mp3" type="audio/mpeg" length="1" />`,
      expected: "DiscoveryPodcastTranscriptReferenceInvalid",
    },
    {
      body: transcript,
      expected: "DiscoveryPodcastEnclosureReferenceInvalid",
    },
    {
      body: `<wrapper>${transcript}</wrapper>
        <enclosure url="https://publisher.example/episode.mp3" type="audio/mpeg" length="1" />`,
      expected: "DiscoveryPodcastMetadataMalformed",
    },
    {
      body: `${transcript.repeat(17)}
        <enclosure url="https://publisher.example/episode.mp3" type="audio/mpeg" length="1" />`,
      expected: "DiscoveryLimitExceeded",
    },
  ];
  for (const testCase of cases) {
    const document =
      `<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
      <title>Publisher</title><link>https://publisher.example/</link>
      <item><guid isPermaLink="false">episode</guid><title>Episode</title>
      <link>https://publisher.example/episode</link>${testCase.body}</item>
      </channel></rss>`;
    const adapter = new RssAtomAcquisitionAdapter({
      fetch: /** @type {typeof fetch} */ (async () =>
        new Response(document, {
          headers: { "content-type": "application/rss+xml" },
        })),
      now: () => "2026-07-21T00:00:00.000Z",
      digest,
      policy: { ...policy, maximumBytes: 8_192 },
    });
    const result = await adapter.acquire(command);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, testCase.expected);
  }
});

Deno.test("RSS adapter normalizes Atom identity evidence and excludes content", async () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <id>urn:publisher:music</id><title>Music Publisher</title>
    <link rel="alternate" href="https://publisher.example/music" />
    <updated>2026-07-21T00:00:00Z</updated>
    <entry><id>urn:publisher:item:1</id><title>Voice leading</title>
    <link href="https://publisher.example/music/voice-leading" />
    <published>2026-07-20T00:00:00Z</published><content>Private body</content></entry>
  </feed>`;
  const adapter = new RssAtomAcquisitionAdapter({
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response(atom, {
        headers: { "content-type": "application/atom+xml" },
      })),
    now: () => "2026-07-21T00:00:00.000Z",
    digest,
    policy,
  });
  const result = await adapter.acquire(command);
  assertEquals(result.ok, true);
  if (result.ok && result.value.status === "acquired") {
    assertEquals(result.value.feed.format, "atom");
    assertEquals(result.value.feed.source.identityKey, "urn:publisher:music");
    assertEquals(
      result.value.feed.items[0].identityKey,
      "urn:publisher:item:1",
    );
    assertEquals(
      result.value.feed.items[0].identityEvidence[0].kind,
      "atom-id",
    );
    assertEquals(result.value.feed.items[0].podcast, null);
    assertEquals(JSON.stringify(result.value).includes("Private body"), false);
  }
});

Deno.test("RSS adapter rejects active XML constructs and malformed or unknown documents", async () => {
  const documents = [
    `<!DOCTYPE rss><rss version="2.0"><channel /></rss>`,
    `<!ENTITY x "value"><rss version="2.0"><channel /></rss>`,
    `<?xml-stylesheet href="https://publisher.example/style.xsl"?><rss version="2.0"><channel /></rss>`,
    `<rss xmlns:xi="http://www.w3.org/2001/XInclude" version="2.0"><channel /></rss>`,
    `<rss version="2.0"><channel><title>&private;</title></channel></rss>`,
    `<rss version="2.0"><channel>`,
    `<html><body /></html>`,
  ];
  const expected = [
    "DiscoveryDoctypeForbidden",
    "DiscoveryEntityForbidden",
    "DiscoveryStylesheetForbidden",
    "DiscoveryXIncludeForbidden",
    "DiscoveryEntityForbidden",
    "DiscoveryXmlMalformed",
    "DiscoveryFormatUnsupported",
  ];
  for (let index = 0; index < documents.length; index += 1) {
    const adapter = new RssAtomAcquisitionAdapter({
      fetch: /** @type {typeof fetch} */ (async () =>
        new Response(documents[index], {
          headers: { "content-type": "application/xml" },
        })),
      now: () =>
        "2026-07-21T00:00:00.000Z",
      digest,
      policy,
    });
    const result = await adapter.acquire(command);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, expected[index]);
  }
});

Deno.test("feed parser accepts predefined entities and enforces item and depth limits", () => {
  const accepted = parseNormalizedFeed(
    `<rss version="2.0"><channel><title><![CDATA[Form & analysis]]></title><link>https://publisher.example/</link></channel></rss>`,
    command.sourceUrl,
  );
  assertEquals(accepted.ok, true);
  if (accepted.ok) assertEquals(accepted.value.source.title, "Form & analysis");

  const item =
    `<item><guid isPermaLink="false">id</guid><title>Item</title><link>https://publisher.example/item</link></item>`;
  const tooMany = parseNormalizedFeed(
    `<rss version="2.0"><channel><title>Publisher</title><link>https://publisher.example/</link>${
      item.repeat(101)
    }</channel></rss>`,
    command.sourceUrl,
  );
  assertEquals(tooMany.ok, false);
  if (!tooMany.ok) assertEquals(tooMany.error.kind, "DiscoveryLimitExceeded");

  const tooDeep = parseNormalizedFeed(
    `${"<x>".repeat(25)}${"</x>".repeat(25)}`,
    command.sourceUrl,
  );
  assertEquals(tooDeep.ok, false);
  if (!tooDeep.ok) assertEquals(tooDeep.error.kind, "DiscoveryLimitExceeded");
});

Deno.test("RSS adapter rejects missing and ambiguous identity and unsafe item URLs", async () => {
  const documents = [
    `<rss version="2.0"><channel><title>Publisher</title><item><title>Missing</title></item></channel></rss>`,
    `<rss version="2.0"><channel><title>Publisher</title><link>https://publisher.example/</link><item><title>Ambiguous</title><guid>a</guid><guid>b</guid><link>https://publisher.example/a</link></item></channel></rss>`,
    `<rss version="2.0"><channel><title>Publisher</title><link>https://publisher.example/</link><item><title>Unsafe</title><link>http://127.0.0.1/private</link></item></channel></rss>`,
  ];
  const expected = [
    "DiscoveryFeedMetadataMissing",
    "DiscoveryIdentityAmbiguous",
    "DiscoveryItemMalformed",
  ];
  for (let index = 0; index < documents.length; index += 1) {
    const adapter = new RssAtomAcquisitionAdapter({
      fetch: /** @type {typeof fetch} */ (async () =>
        new Response(documents[index], {
          headers: { "content-type": "application/rss+xml" },
        })),
      now: () =>
        "2026-07-21T00:00:00.000Z",
      digest,
      policy,
    });
    const result = await adapter.acquire(command);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, expected[index]);
  }
});

Deno.test("RSS adapter validates every redirect and supports not-modified", async () => {
  let calls = 0;
  const adapter = new RssAtomAcquisitionAdapter({
    fetch: /** @type {typeof fetch} */ (async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/feed" },
        })
        : new Response(null, { status: 304 });
    }),
    now: () => "2026-07-21T00:00:00.000Z",
    digest,
    policy,
  });
  const result = await adapter.acquire(command);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "not-modified");
    assertEquals(result.value.redirects.length, 1);
  }
});

Deno.test("RSS adapter rejects unsafe redirects, media, status, and decoded size", async () => {
  const responses = [
    new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/feed" },
    }),
    new Response("html", { headers: { "content-type": "text/html" } }),
    new Response("missing", {
      status: 404,
      headers: { "content-type": "application/xml" },
    }),
    new Response("x".repeat(2_049), {
      headers: { "content-type": "application/xml" },
    }),
  ];
  const expected = [
    "DiscoveryRedirectRejected",
    "DiscoveryMediaTypeUnsupported",
    "DiscoveryHttpRejected",
    "DiscoveryPayloadTooLarge",
  ];
  for (const [index, response] of responses.entries()) {
    const adapter = new RssAtomAcquisitionAdapter({
      fetch: /** @type {typeof fetch} */ (async () => response.clone()),
      now: () => "2026-07-21T00:00:00.000Z",
      digest,
      policy,
    });
    const result = await adapter.acquire(command);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, expected[index]);
  }
});

Deno.test("Worker authenticates before body parsing and returns no raw failures", async () => {
  let acquisitionCalls = 0;
  const worker = createDiscoveryWorker(
    { allowedOrigin: "https://app.example", maximumCommandBytes: 512 },
    {
      authenticate: async () => ({
        ok: false,
        error: { kind: "DiscoveryClientUnauthenticated" },
      }),
      acquireRss: async () => {
        acquisitionCalls += 1;
        return { ok: false, error: { kind: "DiscoveryFetchUnavailable" } };
      },
    },
  );
  const response = await worker.fetch(
    new Request("https://worker.example/api/discovery/rss", {
      method: "POST",
      body: "{",
    }),
  );
  assertEquals(response.status, 401);
  assertEquals(acquisitionCalls, 0);
  assertEquals((await response.json()).error, "DiscoveryClientUnauthenticated");
});

Deno.test("Worker validates origin, command, and successful owner-scoped response", async () => {
  const acquired = Object.freeze({
    status: /** @type {const} */ ("not-modified"),
    submittedUrl: command.sourceUrl,
    canonicalUrl: command.sourceUrl,
    retrievedAt: "2026-07-21T00:00:00.000Z",
    redirects: Object.freeze([]),
  });
  const worker = createDiscoveryWorker(
    { allowedOrigin: "https://app.example", maximumCommandBytes: 512 },
    {
      authenticate: async () => ({
        ok: true,
        value: { ownerId: "owner-a", email: "owner@example.test" },
      }),
      acquireRss: async () => ({ ok: true, value: acquired }),
    },
  );
  const rejected = await worker.fetch(
    new Request("https://worker.example/api/discovery/rss", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    }),
  );
  assertEquals(rejected.status, 403);
  const malformed = await worker.fetch(
    new Request("https://worker.example/api/discovery/rss", {
      method: "POST",
      headers: { origin: "https://app.example" },
      body: JSON.stringify({ sourceUrl: command.sourceUrl }),
    }),
  );
  assertEquals(malformed.status, 400);
  const accepted = await worker.fetch(
    new Request("https://worker.example/api/discovery/rss", {
      method: "POST",
      headers: { origin: "https://app.example" },
      body: JSON.stringify(command),
    }),
  );
  assertEquals(accepted.status, 200);
  const payload = await accepted.json();
  assert(
    payload.ownerId === "owner-a",
    "The verified owner must scope the response.",
  );
  assertEquals(payload.result.status, "not-modified");
  assertEquals(accepted.headers.get("cache-control"), "no-store");
});

Deno.test("Worker RSS response exposes normalized metadata without raw XML", async () => {
  const adapter = new RssAtomAcquisitionAdapter({
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response(rssDocument, {
        headers: { "content-type": "application/rss+xml" },
      })),
    now: () => "2026-07-21T00:00:00.000Z",
    digest,
    policy,
  });
  const worker = createDiscoveryWorker(
    { allowedOrigin: "https://app.example", maximumCommandBytes: 512 },
    {
      authenticate: async () => ({
        ok: true,
        value: { ownerId: "owner-a", email: "owner@example.test" },
      }),
      acquireRss: (rssCommand) => adapter.acquire(rssCommand),
    },
  );
  const response = await worker.fetch(
    new Request("https://worker.example/api/discovery/rss", {
      method: "POST",
      headers: {
        origin: "https://app.example",
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    }),
  );
  const text = await response.text();
  assertEquals(response.status, 200);
  assertEquals(text.includes("documentText"), false);
  assertEquals(text.includes("Body that must not cross"), false);
  assertEquals(text.includes("audio.mp3"), true);
  assertEquals(text.includes('"title":"Cadence study"'), true);
});
