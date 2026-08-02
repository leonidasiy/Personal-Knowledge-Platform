// @ts-check

import { DiscoveryXmlParser } from "../src/features/discovery/xml-parser.js";

/** @import { DiscoveryXmlLimits, XmlAttributePort, XmlDocumentPort, XmlElementPort, XmlNodePort } from "../src/features/discovery/xml-parser.js" */

const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
const CONTEXT = Object.freeze({
  sourceRecordId: "source-registration-1",
  documentUrl: "https://acquisition.test/sources/music/feed.xml",
  acquiredAt: "2026-07-21T08:00:00.000Z",
});
const LIMITS = Object.freeze({
  maxDocumentChars: 10_000,
  maxDepth: 12,
  maxItems: 20,
  maxTotalAttributes: 50,
  maxTextChars: 5_000,
});

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      "Expected " + String(expected) + ", received " + String(actual) + ".",
    );
  }
}

/**
 * @param {string} value
 * @returns {XmlNodePort}
 */
function text(value) {
  return Object.freeze({
    nodeType: 3,
    nodeName: "#text",
    localName: null,
    namespaceURI: null,
    nodeValue: value,
    childNodes: Object.freeze([]),
  });
}

/**
 * @param {string} name
 * @param {readonly XmlNodePort[]} [children]
 * @param {Readonly<Record<string, string>>} [attributeValues]
 * @param {string | null} [namespaceURI]
 * @returns {XmlElementPort}
 */
function element(
  name,
  children = [],
  attributeValues = {},
  namespaceURI = null,
) {
  /** @type {XmlAttributePort[]} */
  const attributes = Object.entries(attributeValues).map(([key, value]) =>
    Object.freeze({
      name: key,
      localName: key,
      namespaceURI: null,
      value,
    })
  );
  return Object.freeze({
    nodeType: /** @type {const} */ (1),
    nodeName: name,
    localName: name.includes(":") ? name.split(":").at(-1) ?? name : name,
    namespaceURI,
    nodeValue: null,
    childNodes: Object.freeze([...children]),
    attributes: Object.freeze(attributes),
  });
}

/**
 * @param {string} name
 * @param {string} value
 * @param {Readonly<Record<string, string>>} [attributes]
 * @param {string | null} [namespaceURI]
 */
function leaf(name, value, attributes = {}, namespaceURI = null) {
  return element(name, [text(value)], attributes, namespaceURI);
}

/** @param {XmlElementPort} root @returns {XmlDocumentPort} */
function documentWith(root) {
  return Object.freeze({ documentElement: root });
}

/**
 * @param {XmlDocumentPort | null} document
 * @param {DiscoveryXmlLimits} [limits]
 * @param {{ count: number }} [calls]
 */
function parserFor(document, limits = LIMITS, calls = { count: 0 }) {
  return new DiscoveryXmlParser({
    limits,
    createDomParser: () => ({
      parseFromString: () => {
        calls.count += 1;
        return document;
      },
    }),
  });
}

/** @param {XmlElementPort} root */
function parseRoot(root) {
  return parserFor(documentWith(root)).parse("<feed-document/>", CONTEXT);
}

/** @param {{ readonly ok: boolean, readonly error?: { readonly kind: string } }} result */
function errorKind(result) {
  return result.ok ? null : result.error?.kind ?? null;
}

/** @param {readonly XmlElementPort[]} [items] */
function rssRoot(items = []) {
  return element("rss", [
    element("channel", [
      leaf("title", "Counterpoint Journal"),
      leaf("link", "https://publisher.test/journal#latest"),
      leaf("lastBuildDate", "Mon, 21 Jul 2026 08:00:00 GMT"),
      ...items,
    ]),
  ], { version: "2.0" });
}

/** @param {readonly XmlElementPort[]} [entries] */
function atomRoot(entries = []) {
  return element(
    "feed",
    [
      leaf("id", "urn:publisher:counterpoint", {}, ATOM_NAMESPACE),
      leaf("title", "Counterpoint Journal", {}, ATOM_NAMESPACE),
      element(
        "link",
        [],
        { rel: "alternate", href: "./counterpoint" },
        ATOM_NAMESPACE,
      ),
      leaf("updated", "2026-07-21T08:00:00Z", {}, ATOM_NAMESPACE),
      ...entries,
    ],
    {},
    ATOM_NAMESPACE,
  );
}

Deno.test("parser rejects invalid public inputs before DOM parsing", () => {
  const calls = { count: 0 };
  const parser = parserFor(documentWith(rssRoot()), LIMITS, calls);
  for (const input of [null, 4, {}, [], "", "   "]) {
    const result = parser.parse(input, CONTEXT);
    assertEquals(errorKind(result), "DiscoveryCommandInvalid");
  }
  assertEquals(
    errorKind(parser.parse("<rss/>", null)),
    "DiscoveryCommandInvalid",
  );
  assertEquals(
    errorKind(parser.parse("<rss/>", {
      ...CONTEXT,
      documentUrl: "http://acquisition.test/feed.xml",
    })),
    "DiscoverySourceUrlInvalid",
  );
  assertEquals(calls.count, 0);
});

Deno.test("parser rejects dangerous XML constructs before invoking the port", () => {
  const cases = [
    ["<!DOCTYPE rss><rss/>", "DiscoveryDoctypeForbidden"],
    [
      '<!ENTITY payload SYSTEM "file:///secret"><rss/>',
      "DiscoveryEntityForbidden",
    ],
    ["<rss>%payload;</rss>", "DiscoveryEntityForbidden"],
    ["<rss>&payload;</rss>", "DiscoveryEntityForbidden"],
    [
      '<rss xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///secret"/></rss>',
      "DiscoveryXIncludeForbidden",
    ],
    [
      '<?xml-stylesheet href="https://example.test/style.xsl"?><rss/>',
      "DiscoveryStylesheetForbidden",
    ],
  ];
  for (const [source, expectedKind] of cases) {
    const calls = { count: 0 };
    const parser = parserFor(documentWith(rssRoot()), LIMITS, calls);
    assertEquals(errorKind(parser.parse(source, CONTEXT)), expectedKind);
    assertEquals(calls.count, 0);
  }
});

Deno.test("RSS 2.0 preserves explicit identity evidence and omits bodies and rights", () => {
  const first = element("item", [
    leaf("title", "Hearing a suspension"),
    leaf("guid", "lesson:suspension:1", { isPermaLink: "false" }),
    leaf("link", "./lesson-1#analysis"),
    leaf("pubDate", "Mon, 21 Jul 2026 09:00:00 GMT"),
    leaf("description", "SECRET DESCRIPTION MUST NOT BE RETAINED"),
    leaf("content", "SECRET CONTENT MUST NOT BE RETAINED"),
  ]);
  const second = element("item", [
    leaf("title", "Species counterpoint"),
    leaf("link", "https://publisher.test/lessons/species"),
  ]);
  const result = parseRoot(rssRoot([first, second]));
  assert(result.ok, "A bounded RSS document must parse.");
  if (!result.ok) return;

  assertEquals(result.value.format, "rss2");
  assertEquals(result.value.provenance.sourceRecordId, "source-registration-1");
  assertEquals(result.value.source.id, "https://publisher.test/journal");
  assertEquals(result.value.source.publisherLabel, "Counterpoint Journal");
  assertEquals(
    result.value.source.publishedAt,
    "Mon, 21 Jul 2026 08:00:00 GMT",
  );
  assertEquals(result.value.items[0].id, "lesson:suspension:1");
  assertEquals(
    result.value.items[0].canonicalUrl,
    "https://acquisition.test/sources/music/lesson-1",
  );
  assertEquals(result.value.items[0].identityEvidence[0].kind, "rss-guid");
  assertEquals(result.value.items[0].identityEvidence[0].isPermaLink, false);
  assertEquals(
    result.value.items[1].id,
    "https://publisher.test/lessons/species",
  );

  const retained = JSON.stringify(result.value);
  for (
    const forbidden of [
      "SECRET DESCRIPTION",
      "SECRET CONTENT",
      "description",
      "content",
      "transcript",
      "rights",
      "license",
    ]
  ) {
    assert(
      !retained.toLowerCase().includes(forbidden.toLowerCase()),
      forbidden + " must not enter the parser projection.",
    );
  }
  assert(
    !result.value.items[0].id.includes("acquisition.test"),
    "The acquisition hostname must not replace explicit item identity.",
  );
});

Deno.test("Atom preserves explicit feed and entry IDs with canonical HTTPS links", () => {
  const entry = element(
    "entry",
    [
      leaf("id", "tag:publisher.test,2026:entry-1", {}, ATOM_NAMESPACE),
      leaf("title", "Contrary motion", {}, ATOM_NAMESPACE),
      element(
        "link",
        [],
        { href: "../lessons/contrary#voice-leading" },
        ATOM_NAMESPACE,
      ),
      leaf("published", "2026-07-20T12:00:00Z", {}, ATOM_NAMESPACE),
      leaf(
        "summary",
        "A summary that is intentionally unprojected",
        {},
        ATOM_NAMESPACE,
      ),
    ],
    {},
    ATOM_NAMESPACE,
  );
  const result = parseRoot(atomRoot([entry]));
  assert(result.ok, "A bounded Atom document must parse.");
  if (!result.ok) return;

  assertEquals(result.value.format, "atom");
  assertEquals(result.value.source.id, "urn:publisher:counterpoint");
  assertEquals(
    result.value.source.canonicalUrl,
    "https://acquisition.test/sources/music/counterpoint",
  );
  assertEquals(result.value.items[0].id, "tag:publisher.test,2026:entry-1");
  assertEquals(
    result.value.items[0].canonicalUrl,
    "https://acquisition.test/sources/lessons/contrary",
  );
  assertEquals(result.value.items[0].publishedAt, "2026-07-20T12:00:00Z");
  assert(
    !JSON.stringify(result.value).includes("intentionally unprojected"),
    "Atom summaries must not be retained.",
  );
});

Deno.test("missing and ambiguous identities remain distinct", () => {
  const missing = element("item", [
    leaf("title", "No stable identity"),
  ]);
  assertEquals(
    errorKind(parseRoot(rssRoot([missing]))),
    "DiscoveryItemIdentityMissing",
  );

  const ambiguous = element("item", [
    leaf("title", "Two identities"),
    leaf("guid", "first", { isPermaLink: "false" }),
    leaf("guid", "second", { isPermaLink: "false" }),
    leaf("link", "https://publisher.test/two-identities"),
  ]);
  assertEquals(
    errorKind(parseRoot(rssRoot([ambiguous]))),
    "DiscoveryIdentityAmbiguous",
  );

  const noSourceIdentity = element("rss", [
    element("channel", [
      leaf("title", "Filename Cannot Identify This Feed"),
    ]),
  ], { version: "2.0" });
  assertEquals(
    errorKind(parseRoot(noSourceIdentity)),
    "DiscoveryFeedMetadataMissing",
  );
});

Deno.test("conflicting item IDs and canonical links fail explicitly", () => {
  const duplicateOne = element("item", [
    leaf("title", "First claim"),
    leaf("guid", "shared-id", { isPermaLink: "false" }),
    leaf("link", "https://publisher.test/first"),
  ]);
  const duplicateTwo = element("item", [
    leaf("title", "Second claim"),
    leaf("guid", "shared-id", { isPermaLink: "false" }),
    leaf("link", "https://publisher.test/second"),
  ]);
  assertEquals(
    errorKind(parseRoot(rssRoot([duplicateOne, duplicateTwo]))),
    "DiscoveryIdentityConflict",
  );

  const permalinkConflict = element("item", [
    leaf("title", "Conflicting permalink"),
    leaf("guid", "https://publisher.test/guid-target"),
    leaf("link", "https://publisher.test/link-target"),
  ]);
  assertEquals(
    errorKind(parseRoot(rssRoot([permalinkConflict]))),
    "DiscoveryIdentityConflict",
  );
});

Deno.test("only canonical HTTPS publisher links are accepted", () => {
  const insecure = element("item", [
    leaf("title", "Insecure link"),
    leaf("guid", "opaque-id", { isPermaLink: "false" }),
    leaf("link", "http://publisher.test/insecure"),
  ]);
  const result = parseRoot(rssRoot([insecure]));
  assertEquals(errorKind(result), "DiscoveryItemMalformed");
  if (!result.ok && result.error.kind === "DiscoveryItemMalformed") {
    assertEquals(result.error.field, "canonicalUrl");
  }
});

Deno.test("depth, item, attribute, text, and document bounds fail distinctly", () => {
  const documentLimited = parserFor(documentWith(rssRoot()), {
    ...LIMITS,
    maxDocumentChars: 5,
  }).parse("<rss/>", CONTEXT);
  assertEquals(errorKind(documentLimited), "DiscoveryPayloadTooLarge");

  let nested = leaf("level", "end");
  for (let index = 0; index < 5; index += 1) {
    nested = element("level", [nested]);
  }
  const depthLimited = parserFor(documentWith(nested), {
    ...LIMITS,
    maxDepth: 3,
  }).parse("<tree/>", CONTEXT);
  assertEquals(errorKind(depthLimited), "DiscoveryLimitExceeded");
  if (
    !depthLimited.ok && depthLimited.error.kind === "DiscoveryLimitExceeded"
  ) {
    assertEquals(depthLimited.error.limit, "depth");
  }

  const itemLimited = parserFor(
    documentWith(rssRoot([
      element("item", []),
      element("item", []),
    ])),
    {
      ...LIMITS,
      maxItems: 1,
    },
  ).parse("<rss/>", CONTEXT);
  assertEquals(errorKind(itemLimited), "DiscoveryLimitExceeded");
  if (!itemLimited.ok && itemLimited.error.kind === "DiscoveryLimitExceeded") {
    assertEquals(itemLimited.error.limit, "items");
  }

  const attributeLimited = parserFor(
    documentWith(element(
      "root",
      [],
      { one: "1", two: "2" },
    )),
    {
      ...LIMITS,
      maxTotalAttributes: 1,
    },
  ).parse("<root/>", CONTEXT);
  assertEquals(errorKind(attributeLimited), "DiscoveryLimitExceeded");
  if (
    !attributeLimited.ok &&
    attributeLimited.error.kind === "DiscoveryLimitExceeded"
  ) {
    assertEquals(attributeLimited.error.limit, "attributes");
  }

  const textLimited = parserFor(documentWith(leaf("root", "123456")), {
    ...LIMITS,
    maxTextChars: 5,
  }).parse("<root/>", CONTEXT);
  assertEquals(errorKind(textLimited), "DiscoveryLimitExceeded");
  if (!textLimited.ok && textLimited.error.kind === "DiscoveryLimitExceeded") {
    assertEquals(textLimited.error.limit, "text");
  }
});

Deno.test("malformed parser results and unknown formats do not project data", () => {
  assertEquals(
    errorKind(parserFor(null).parse("<rss/>", CONTEXT)),
    "DiscoveryXmlMalformed",
  );
  const parserError = element("parsererror", [text("malformed")]);
  assertEquals(
    errorKind(parseRoot(parserError)),
    "DiscoveryXmlMalformed",
  );
  assertEquals(
    errorKind(parseRoot(element("html", []))),
    "DiscoveryFormatUnsupported",
  );

  const unavailable = new DiscoveryXmlParser({
    limits: LIMITS,
    createDomParser: () => {
      throw new Error("not available");
    },
  });
  assertEquals(
    errorKind(unavailable.parse("<rss/>", CONTEXT)),
    "DiscoveryParserUnavailable",
  );
});
