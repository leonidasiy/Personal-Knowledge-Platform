// @ts-check

import {
  createTranscriptReferencePolicy,
  PodcastNamespaceExtractor,
} from "../src/features/discovery/podcast-metadata.js";

const PODCAST_NAMESPACE = "https://podcastindex.org/namespace/1.0";
const PODCAST_SPEC =
  "https://podcasting2.org/docs/podcast-namespace/tags/transcript";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {string} name @param {string} value */
function attribute(name, value) {
  return Object.freeze({
    name,
    localName: name,
    namespaceURI: null,
    value,
  });
}

/**
 * @param {string} name
 * @param {string | null} namespaceURI
 * @param {readonly ReturnType<typeof attribute>[]} attributes
 * @param {readonly unknown[]} children
 */
function element(name, namespaceURI, attributes = [], children = []) {
  return Object.freeze({
    nodeType: 1,
    nodeName: name,
    localName: name.split(":").at(-1) ?? name,
    namespaceURI,
    nodeValue: null,
    attributes,
    childNodes: children,
  });
}

/** @param {Record<string, string>} values */
function transcript(values) {
  return element(
    "alt:transcript",
    PODCAST_NAMESPACE,
    Object.entries(values).map(([name, value]) => attribute(name, value)),
  );
}

/** @param {Record<string, string>} values */
function enclosure(values) {
  return element(
    "enclosure",
    null,
    Object.entries(values).map(([name, value]) => attribute(name, value)),
  );
}

/** @param {readonly unknown[]} children */
function item(children) {
  return element("item", null, [], children);
}

const provenance = Object.freeze({
  sourceRecordId: "source-1",
  itemId: "item-1",
  identityEvidence: Object.freeze([Object.freeze({
    reference: "rss-guid:episode-1",
    provenance: "rss:item/guid",
  })]),
  documentUrl: "https://publisher.example/feed.xml",
  acquiredAt: "2026-07-21T00:00:00.000Z",
  documentDigest: "feed-digest",
});

/**
 * @param {{
 *   readonly preferredTypes?: readonly string[],
 *   readonly preferredLanguage?: string | null,
 *   readonly preferredRel?: string | null,
 *   readonly digest?: (value: string) => Promise<{ readonly ok: true, readonly value: string }>
 * }} [options]
 */
function extractor(options = {}) {
  return new PodcastNamespaceExtractor({
    namespaceUri: PODCAST_NAMESPACE,
    namespaceContractReference: PODCAST_SPEC,
    parserVersion: "podcast-dom-v1",
    transcriptPolicy: createTranscriptReferencePolicy({
      version: "transcript-pref-v1",
      reference: PODCAST_SPEC,
      preferredTypes: options.preferredTypes ?? ["text/vtt", "text/plain"],
      preferredLanguage: options.preferredLanguage ?? "en",
      preferredRel: options.preferredRel ?? null,
    }),
    digest: options.digest ??
      (() => Promise.resolve({ ok: true, value: "metadata-digest" })),
  });
}

function context() {
  return Object.freeze({
    feedLanguage: Object.freeze({
      value: "en-US",
      selector: "rss/channel/language",
    }),
    provenance,
  });
}

Deno.test("podcast metadata preserves transcript, enclosure, selection, digest, and provenance", async () => {
  let digested = "";
  const parser = extractor({
    preferredLanguage: "es",
    digest: (value) => {
      digested = value;
      return Promise.resolve({ ok: true, value: "metadata-digest" });
    },
  });
  const result = await parser.extract(
    item([
      transcript({
        url: "https://publisher.example/episode.vtt#captions",
        type: "text/vtt",
        language: "es",
        rel: "captions",
      }),
      transcript({
        url: "https://publisher.example/episode.txt",
        type: "text/plain",
        language: "en",
      }),
      enclosure({
        url: "https://publisher.example/episode.mp3",
        type: "audio/mpeg",
        length: "43200000",
      }),
    ]),
    context(),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.selectedTranscript.url,
    "https://publisher.example/episode.vtt",
  );
  assertEquals(result.value.selectedTranscript.type, "text/vtt");
  assertEquals(result.value.selectedTranscript.language, "es");
  assertEquals(result.value.selectedTranscript.rel, "captions");
  assertEquals(result.value.transcripts.length, 2);
  assertEquals(result.value.enclosure.type, "audio/mpeg");
  assertEquals(result.value.enclosure.declaredLength, 43200000);
  assertEquals(result.value.selectorVersion, "transcript-pref-v1");
  assertEquals(result.value.selectorReference, PODCAST_SPEC);
  assertEquals(result.value.feedLanguageSelector, "rss/channel/language");
  assertEquals(result.value.parserVersion, "podcast-dom-v1");
  assertEquals(result.value.digest, "metadata-digest");
  assertEquals(result.value.provenance.itemId, "item-1");
  assertEquals(result.value.namespaceContractReference, PODCAST_SPEC);
  assertEquals(digested.includes("episode.mp3"), true);
  assertEquals("body" in result.value.selectedTranscript, false);
});

Deno.test("missing transcript language uses only authoritative feed language", async () => {
  const result = await extractor({ preferredLanguage: "en-US" }).extract(
    item([
      transcript({
        url: "https://publisher.example/transcript.txt",
        type: "text/plain",
      }),
      enclosure({
        url: "https://publisher.example/episode.mp3",
        type: "audio/mpeg",
        length: "1",
      }),
    ]),
    context(),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.selectedTranscript.language, "en-us");
  assertEquals(result.value.selectedTranscript.languageSource, "feed");
});

Deno.test("alternate podcast namespace prefixes are accepted by namespace URI", async () => {
  const result = await extractor({ preferredLanguage: "en" }).extract(
    item([
      transcript({
        url: "https://publisher.example/transcript.vtt",
        type: "text/vtt",
        language: "en",
      }),
      enclosure({
        url: "https://publisher.example/episode.mp3",
        type: "audio/mpeg",
        length: "2",
      }),
    ]),
    context(),
  );
  assertEquals(result.ok, true);
});

Deno.test("malformed namespace structure is rejected without digesting", async () => {
  let digestCalls = 0;
  const nested = element("wrapper", null, [], [transcript({
    url: "https://publisher.example/transcript.vtt",
    type: "text/vtt",
  })]);
  const result = await extractor({
    digest: () => {
      digestCalls += 1;
      return Promise.resolve({ ok: true, value: "unused" });
    },
  }).extract(
    item([
      nested,
      enclosure({
        url: "https://publisher.example/episode.mp3",
        type: "audio/mpeg",
        length: "2",
      }),
    ]),
    context(),
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "PodcastNamespaceMalformed");
  assertEquals(digestCalls, 0);
});

Deno.test("unsafe and invalid transcript URLs return the named failure", async () => {
  for (
    const url of [
      "http://publisher.example/transcript.vtt",
      "https://user:secret@publisher.example/transcript.vtt",
      "not a url",
    ]
  ) {
    const result = await extractor().extract(
      item([
        transcript({ url, type: "text/vtt", language: "en" }),
        enclosure({
          url: "https://publisher.example/episode.mp3",
          type: "audio/mpeg",
          length: "2",
        }),
      ]),
      context(),
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.kind, "PodcastTranscriptReferenceInvalid");
    }
  }
});

Deno.test("missing transcript type returns the named failure", async () => {
  const result = await extractor().extract(
    item([
      transcript({
        url: "https://publisher.example/transcript.vtt",
        language: "en",
      }),
      enclosure({
        url: "https://publisher.example/episode.mp3",
        type: "audio/mpeg",
        length: "2",
      }),
    ]),
    context(),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "PodcastTranscriptReferenceInvalid");
    if (result.error.kind === "PodcastTranscriptReferenceInvalid") {
      assertEquals(result.error.field, "type");
    }
  }
});

Deno.test("invalid enclosure references return one named failure", async () => {
  for (
    const values of [
      {
        url: "http://publisher.example/episode.mp3",
        type: "audio/mpeg",
        length: "2",
      },
      { url: "https://publisher.example/episode.mp3", type: "", length: "2" },
      {
        url: "https://publisher.example/episode.mp3",
        type: "audio/mpeg",
        length: "2.5",
      },
    ]
  ) {
    const result = await extractor().extract(
      item([
        transcript({
          url: "https://publisher.example/transcript.vtt",
          type: "text/vtt",
          language: "en",
        }),
        enclosure(values),
      ]),
      context(),
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.kind, "PodcastEnclosureReferenceInvalid");
    }
  }
});

Deno.test("missing and multiple enclosures are explicit invalid references", async () => {
  const validTranscript = transcript({
    url: "https://publisher.example/transcript.vtt",
    type: "text/vtt",
    language: "en",
  });
  for (
    const enclosures of [[], [
      enclosure({
        url: "https://publisher.example/one.mp3",
        type: "audio/mpeg",
        length: "1",
      }),
      enclosure({
        url: "https://publisher.example/two.mp3",
        type: "audio/mpeg",
        length: "2",
      }),
    ]]
  ) {
    const result = await extractor().extract(
      item([validTranscript, ...enclosures]),
      context(),
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.kind, "PodcastEnclosureReferenceInvalid");
    }
  }
});

Deno.test("selector refuses an ambiguous transcript choice", async () => {
  const result = await extractor().extract(
    item([
      transcript({
        url: "https://publisher.example/one.vtt",
        type: "text/vtt",
        language: "en",
      }),
      transcript({
        url: "https://publisher.example/two.vtt",
        type: "text/vtt",
        language: "en",
      }),
      enclosure({
        url: "https://publisher.example/episode.mp3",
        type: "audio/mpeg",
        length: "2",
      }),
    ]),
    context(),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "PodcastTranscriptSelectionUnavailable");
    if (result.error.kind === "PodcastTranscriptSelectionUnavailable") {
      assertEquals(result.error.reason, "ambiguous");
    }
  }
});

Deno.test("selector reports missing or unmatched transcript references", async () => {
  const enclosureNode = enclosure({
    url: "https://publisher.example/episode.mp3",
    type: "audio/mpeg",
    length: "2",
  });
  const missing = await extractor().extract(item([enclosureNode]), context());
  assertEquals(missing.ok, false);
  if (!missing.ok) {
    assertEquals(missing.error.kind, "PodcastTranscriptSelectionUnavailable");
    if (missing.error.kind === "PodcastTranscriptSelectionUnavailable") {
      assertEquals(missing.error.reason, "missing");
    }
  }

  const unmatched = await extractor({ preferredTypes: ["application/json"] })
    .extract(
      item([
        transcript({
          url: "https://publisher.example/transcript.vtt",
          type: "text/vtt",
          language: "en",
        }),
        enclosureNode,
      ]),
      context(),
    );
  assertEquals(unmatched.ok, false);
  if (!unmatched.ok) {
    assertEquals(unmatched.error.kind, "PodcastTranscriptSelectionUnavailable");
    if (unmatched.error.kind === "PodcastTranscriptSelectionUnavailable") {
      assertEquals(unmatched.error.reason, "no-match");
    }
  }
});

Deno.test("metadata extraction performs no fetch and retains unknown media types", async () => {
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    networkCalls += 1;
    return Promise.reject(new Error("Network access is forbidden."));
  };
  try {
    const result = await extractor({ preferredTypes: ["application/x-custom"] })
      .extract(
        item([
          transcript({
            url: "https://publisher.example/transcript.custom",
            type: "application/x-custom",
            language: "en",
          }),
          enclosure({
            url: "https://publisher.example/episode.custom",
            type: "audio/x-custom",
            length: "2",
          }),
        ]),
        context(),
      );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(
        result.value.selectedTranscript.type,
        "application/x-custom",
      );
      assertEquals(result.value.enclosure.type, "audio/x-custom");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(networkCalls, 0);
});

Deno.test("invalid provenance is rejected rather than inferred from URLs", async () => {
  const invalidContext = {
    feedLanguage: null,
    provenance: { ...provenance, identityEvidence: [] },
  };
  const result = await extractor().extract(
    item([
      transcript({
        url: "https://publisher.example/transcript.vtt",
        type: "text/vtt",
        language: "en",
      }),
      enclosure({
        url: "https://publisher.example/episode.mp3",
        type: "audio/mpeg",
        length: "2",
      }),
    ]),
    invalidContext,
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "PodcastNamespaceMalformed");
});
