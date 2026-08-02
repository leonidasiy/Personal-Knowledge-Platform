// @ts-check

import { DiscoveryXmlParserAdapter } from "../src/features/discovery/parser-adapter.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

const context = Object.freeze({
  ownerId: "owner-a",
  sourceId: "source-a",
  adapterId: "rss-atom",
  adapterVersion: "adapter-v1",
  provenance: Object.freeze({
    method: "worker",
    acquiredAt: "2026-07-21T00:00:00.000Z",
    byteCount: 10,
    digest: "document-digest",
    mediaType: "application/rss+xml",
    submittedUrl: "https://publisher.example/feed",
    canonicalUrl: "https://publisher.example/feed.xml",
    sourceLocator: "run-1",
  }),
});

function xmlDocument() {
  const evidence = Object.freeze([Object.freeze({
    kind: /** @type {const} */ ("rss-guid"),
    value: "stable-1",
    canonicalUrl: null,
    isPermaLink: false,
  })]);
  return Object.freeze({
    format: /** @type {const} */ ("rss2"),
    provenance: Object.freeze({
      sourceRecordId: "source-a",
      documentUrl: context.provenance.canonicalUrl,
      acquiredAt: context.provenance.acquiredAt,
    }),
    source: Object.freeze({
      id: "feed-id",
      canonicalUrl: context.provenance.canonicalUrl,
      publisherLabel: "Publisher",
      publishedAt: null,
      identityEvidence: evidence,
    }),
    items: Object.freeze([Object.freeze({
      id: "stable-1",
      title: "Cadence",
      canonicalUrl: "https://publisher.example/items/1",
      publisherLabel: "Publisher",
      publishedAt: "2026-07-20T00:00:00Z",
      identityEvidence: evidence,
    })]),
  });
}

Deno.test("XML adapter maps rich identities, item digest, and no retained source body", async () => {
  let digested = "";
  const adapter = new DiscoveryXmlParserAdapter({
    parser:
      /** @type {import("../src/features/discovery/parser-adapter.js").DiscoveryXmlParserPort} */ (/** @type {unknown} */ ({
        parse: () => ({ ok: true, value: xmlDocument() }),
      })),
    parserVersion: "bounded-dom-v1",
    digest: (value) => {
      digested = value;
      return Promise.resolve({ ok: true, value: "item-digest" });
    },
  });
  const result = await adapter.parse("<rss/>", context);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.items[0].contentDigest, "item-digest");
  assertEquals(result.value.items[0].boundedExcerpt, null);
  assertEquals(
    result.value.items[0].identity.evidence[0].reference,
    "rss-guid:stable-1",
  );
  assertEquals(digested.includes("Cadence"), true);
  assertEquals("documentText" in result.value, false);
  assertEquals("description" in result.value.items[0], false);
  assertEquals("transcript" in result.value.items[0], false);
});

Deno.test("XML adapter preserves every named parser security failure", async () => {
  for (
    const kind of [
      "DiscoveryDoctypeForbidden",
      "DiscoveryEntityForbidden",
      "DiscoveryXIncludeForbidden",
      "DiscoveryStylesheetForbidden",
      "DiscoveryParserUnavailable",
      "DiscoveryXmlMalformed",
      "DiscoveryFormatUnsupported",
    ]
  ) {
    const adapter = new DiscoveryXmlParserAdapter({
      parser:
        /** @type {import("../src/features/discovery/parser-adapter.js").DiscoveryXmlParserPort} */ (/** @type {unknown} */ ({
          parse: () => ({ ok: false, error: { kind } }),
        })),
      parserVersion: "bounded-dom-v1",
      digest: () => Promise.resolve({ ok: true, value: "unused" }),
    });
    const result = await adapter.parse("<rss/>", context);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, kind);
  }
});

Deno.test("XML adapter maps payload and item identity failure context", async () => {
  const cases = [
    [
      { kind: "DiscoveryPayloadTooLarge", limit: 3 },
      "DiscoveryPayloadTooLarge",
    ],
    [
      { kind: "DiscoveryIdentityAmbiguous", scope: "item", itemIndex: 4 },
      "DiscoveryIdentityAmbiguous",
    ],
    [
      {
        kind: "DiscoveryIdentityConflict",
        firstItemIndex: 0,
        secondItemIndex: 2,
      },
      "DiscoveryIdentityConflict",
    ],
  ];
  for (const [failure, expected] of cases) {
    const adapter = new DiscoveryXmlParserAdapter({
      parser:
        /** @type {import("../src/features/discovery/parser-adapter.js").DiscoveryXmlParserPort} */ (/** @type {unknown} */ ({
          parse: () => ({ ok: false, error: failure }),
        })),
      parserVersion: "bounded-dom-v1",
      digest: () => Promise.resolve({ ok: true, value: "unused" }),
    });
    const result = await adapter.parse("<rss/>", context);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, expected);
  }
});
