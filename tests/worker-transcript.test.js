// @ts-check

import { PublisherTranscriptAdapter } from "../worker/transcript-adapter.js";

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

const command = Object.freeze({
  requestId: "transcript-1",
  transcriptUrl: "https://publisher.example/transcript.txt",
  language: "en",
  rights: Object.freeze({
    evidenceId: "rights-1",
    storage: "allowed",
    display: "allowed",
    transformation: "allowed",
    attribution: "allowed",
    attributionText: "Publisher transcript",
    expiresAt: "2026-07-22T00:00:00.000Z",
  }),
  jsonTextPath: null,
  retention: Object.freeze({ mode: "plain-text" }),
});

/**
 * @param {{
 *   readonly fetch?: typeof fetch,
 *   readonly maximumBytes?: number,
 *   readonly maximumRedirects?: number,
 *   readonly maximumTextCharacters?: number,
 *   readonly maximumExcerptCharacters?: number,
 *   readonly supportedLanguages?: ReadonlySet<string>,
 *   readonly digestFails?: boolean,
 * }} [options]
 */
function createAdapter(options = {}) {
  return new PublisherTranscriptAdapter({
    fetch: options.fetch ?? /** @type {typeof fetch} */
      (async () =>
        new Response("Publisher transcript text.", {
          headers: { "content-type": "text/plain" },
        })),
    validateDestination: (value) => {
      if (!URL.canParse(value)) {
        return { ok: false, error: { kind: "DestinationRejected" } };
      }
      const url = new URL(value);
      return url.protocol === "https:" &&
          !url.hostname.endsWith("youtube.example")
        ? { ok: true, value: url }
        : { ok: false, error: { kind: "DestinationRejected" } };
    },
    clock: () => new Date("2026-07-21T00:00:00.000Z"),
    digest: async (bytes) =>
      options.digestFails
        ? { ok: false, error: { kind: "DigestUnavailable" } }
        : { ok: true, value: `sha256-${bytes.byteLength}` },
    limits: Object.freeze({
      maximumBytes: options.maximumBytes ?? 128,
      maximumRedirects: options.maximumRedirects ?? 2,
      maximumTextCharacters: options.maximumTextCharacters ?? 256,
      maximumExcerptCharacters: options.maximumExcerptCharacters ?? 40,
      supportedLanguages: options.supportedLanguages ?? new Set(["en"]),
    }),
  });
}

Deno.test("publisher transcript validates unknown commands before fetch", async () => {
  let fetchCalls = 0;
  const adapter = createAdapter({
    fetch: /** @type {typeof fetch} */ (async () => {
      fetchCalls += 1;
      return new Response("unused");
    }),
  });
  const malformed = await adapter.retrieve({ ...command, language: 4 });
  assertEquals(malformed.ok, false);
  if (!malformed.ok) {
    assertEquals(malformed.error.kind, "PodcastTranscriptCommandInvalid");
  }
  const missing = await adapter.retrieve({
    ...command,
    transcriptUrl: null,
  });
  assertEquals(missing.ok, false);
  if (!missing.ok) {
    assertEquals(missing.error.kind, "PodcastTranscriptMissing");
  }
  assertEquals(fetchCalls, 0);
});

Deno.test("public availability never substitutes for independently evidenced rights", async () => {
  let fetchCalls = 0;
  const adapter = createAdapter({
    fetch: /** @type {typeof fetch} */ (async () => {
      fetchCalls += 1;
      return new Response("publicly available");
    }),
  });
  const cases = [
    ["storage", "unknown", "TranscriptRightsUnknown"],
    ["storage", "denied", "TranscriptStorageNotPermitted"],
    ["display", "denied", "TranscriptDisplayNotPermitted"],
    ["transformation", "denied", "TranscriptTransformationNotPermitted"],
    ["attribution", "denied", "TranscriptAttributionMissing"],
  ];
  for (const [capability, status, expected] of cases) {
    const result = await adapter.retrieve({
      ...command,
      rights: { ...command.rights, [capability]: status },
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, expected);
  }
  const expired = await adapter.retrieve({
    ...command,
    rights: {
      ...command.rights,
      expiresAt: "2026-07-21T00:00:00.000Z",
    },
  });
  assertEquals(expired.ok, false);
  if (!expired.ok) assertEquals(expired.error.kind, "TranscriptRightsExpired");
  const timestamp = await adapter.retrieve({
    ...command,
    rights: { ...command.rights, expiresAt: "not-a-date" },
  });
  assertEquals(timestamp.ok, false);
  if (!timestamp.ok) {
    assertEquals(timestamp.error.kind, "PodcastTranscriptTimestampInvalid");
  }
  assertEquals(fetchCalls, 0);
});

Deno.test("unsupported language and YouTube destination are rejected without fallback", async () => {
  let fetchCalls = 0;
  const adapter = createAdapter({
    fetch: /** @type {typeof fetch} */ (async () => {
      fetchCalls += 1;
      return new Response("unused");
    }),
  });
  const language = await adapter.retrieve({ ...command, language: "fr" });
  assertEquals(language.ok, false);
  if (!language.ok) {
    assertEquals(
      language.error.kind,
      "PodcastTranscriptLanguageUnsupported",
    );
  }
  const youtube = await adapter.retrieve({
    ...command,
    transcriptUrl: "https://watch.youtube.example/transcript",
  });
  assertEquals(youtube.ok, false);
  if (!youtube.ok) {
    assertEquals(youtube.error.kind, "PodcastTranscriptFetchFailed");
  }
  assertEquals(fetchCalls, 0);
});

Deno.test("publisher transcript manually validates redirects and returns provenance", async () => {
  let calls = 0;
  const adapter = createAdapter({
    fetch: /** @type {typeof fetch} */ (async (_input, init) => {
      calls += 1;
      assertEquals(init?.redirect, "manual");
      return calls === 1
        ? new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/transcript.txt" },
        })
        : new Response("A plain transcript.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
    }),
  });
  const result = await adapter.retrieve(command);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.text, "A plain transcript.");
    assertEquals(result.value.redirects.length, 1);
    assertEquals(
      result.value.canonicalUrl,
      "https://cdn.example/transcript.txt",
    );
    assertEquals(result.value.digest, "sha256-19");
    assertEquals(result.value.rightsEvidenceId, "rights-1");
  }
});

Deno.test("publisher transcript rejects unsafe and excessive redirects", async () => {
  const unsafe = createAdapter({
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/transcript" },
      })),
  });
  const unsafeResult = await unsafe.retrieve(command);
  assertEquals(unsafeResult.ok, false);
  if (!unsafeResult.ok) {
    assertEquals(unsafeResult.error.kind, "PodcastTranscriptFetchFailed");
  }

  const excessive = createAdapter({
    maximumRedirects: 0,
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example/transcript" },
      })),
  });
  const excessiveResult = await excessive.retrieve(command);
  assertEquals(excessiveResult.ok, false);
  if (!excessiveResult.ok) {
    assertEquals(excessiveResult.error.kind, "PodcastTranscriptFetchFailed");
  }
});

Deno.test("supported transcript types become plain text without scripts or markup", async () => {
  const fixtures = [
    {
      mediaType: "text/plain",
      body: "Plain text",
      command,
      expected: "Plain text",
    },
    {
      mediaType: "text/vtt",
      body: "WEBVTT\n\n00:00.000 --> 00:02.000\n<v Speaker>VTT text</v>",
      command,
      expected: "VTT text",
    },
    {
      mediaType: "application/x-subrip",
      body: "1\n00:00:00,000 --> 00:00:02,000\nSRT text",
      command,
      expected: "SRT text",
    },
    {
      mediaType: "application/json",
      body: JSON.stringify({ transcript: { body: "JSON text" } }),
      command: { ...command, jsonTextPath: ["transcript", "body"] },
      expected: "JSON text",
    },
    {
      mediaType: "text/html",
      body:
        "<html><script>alert('x')</script><body><p>HTML <b>text</b></p></body></html>",
      command,
      expected: "HTML text",
    },
  ];
  for (const fixture of fixtures) {
    const adapter = createAdapter({
      maximumBytes: 256,
      fetch: /** @type {typeof fetch} */ (async () =>
        new Response(fixture.body, {
          headers: { "content-type": fixture.mediaType },
        })),
    });
    const result = await adapter.retrieve(fixture.command);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.text, fixture.expected);
      assertEquals(result.value.text.includes("<script"), false);
      assertEquals(result.value.text.includes("<b>"), false);
      assertEquals(result.value.text.includes("alert('x')"), false);
    }
  }
});

Deno.test("explicit excerpt selection is bounded and stores only the selected text", async () => {
  const adapter = createAdapter({
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response("0123456789 transcript", {
        headers: { "content-type": "text/plain" },
      })),
  });
  const result = await adapter.retrieve({
    ...command,
    retention: { mode: "excerpt", startCharacter: 3, characterCount: 5 },
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.text, "34567");
    assertEquals(result.value.retentionMode, "excerpt");
  }
  const oversized = await adapter.retrieve({
    ...command,
    retention: { mode: "excerpt", startCharacter: 0, characterCount: 41 },
  });
  assertEquals(oversized.ok, false);
  if (!oversized.ok) {
    assertEquals(oversized.error.kind, "PodcastTranscriptTooLarge");
  }
});

Deno.test("publisher transcript returns distinct missing, fetch, and type failures", async () => {
  const cases = [
    {
      fetch:
        /** @type {typeof fetch} */ (async () =>
          new Response("missing", { status: 404 })),
      expected: "PodcastTranscriptMissing",
    },
    {
      fetch:
        /** @type {typeof fetch} */ (async () =>
          new Response("unavailable", { status: 503 })),
      expected: "PodcastTranscriptFetchFailed",
    },
    {
      fetch: /** @type {typeof fetch} */ (async () =>
        new Response("binary", {
          headers: { "content-type": "audio/mpeg" },
        })),
      expected: "PodcastTranscriptTypeUnsupported",
    },
  ];
  for (const testCase of cases) {
    const result = await createAdapter({ fetch: testCase.fetch }).retrieve(
      command,
    );
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, testCase.expected);
  }
});

Deno.test("publisher transcript enforces declared and streamed byte bounds", async () => {
  const declared = createAdapter({
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response("small", {
        headers: {
          "content-type": "text/plain",
          "content-length": "129",
        },
      })),
  });
  const declaredResult = await declared.retrieve(command);
  assertEquals(declaredResult.ok, false);
  if (!declaredResult.ok) {
    assertEquals(declaredResult.error.kind, "PodcastTranscriptTooLarge");
  }

  const streamed = createAdapter({
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response("x".repeat(129), {
        headers: { "content-type": "text/plain" },
      })),
  });
  const streamedResult = await streamed.retrieve(command);
  assertEquals(streamedResult.ok, false);
  if (!streamedResult.ok) {
    assertEquals(streamedResult.error.kind, "PodcastTranscriptTooLarge");
  }
});

Deno.test("publisher transcript distinguishes malformed and timestamp failures", async () => {
  const malformed = createAdapter({
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response("{", {
        headers: { "content-type": "application/json" },
      })),
  });
  const malformedResult = await malformed.retrieve({
    ...command,
    jsonTextPath: ["transcript"],
  });
  assertEquals(malformedResult.ok, false);
  if (!malformedResult.ok) {
    assertEquals(malformedResult.error.kind, "PodcastTranscriptMalformed");
  }

  const timestamp = createAdapter({
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response("WEBVTT\n00:bad --> 00:worse\nText", {
        headers: { "content-type": "text/vtt" },
      })),
  });
  const timestampResult = await timestamp.retrieve(command);
  assertEquals(timestampResult.ok, false);
  if (!timestampResult.ok) {
    assertEquals(
      timestampResult.error.kind,
      "PodcastTranscriptTimestampInvalid",
    );
  }

  const reversed = createAdapter({
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response("WEBVTT\n00:02.000 --> 00:01.000\nText", {
        headers: { "content-type": "text/vtt" },
      })),
  });
  const reversedResult = await reversed.retrieve(command);
  assertEquals(reversedResult.ok, false);
  if (!reversedResult.ok) {
    assertEquals(
      reversedResult.error.kind,
      "PodcastTranscriptTimestampInvalid",
    );
  }
});

Deno.test("digest failure is explicit and retained text is not returned", async () => {
  const result = await createAdapter({ digestFails: true }).retrieve(command);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "PodcastTranscriptDigestFailed");
  }
  assert(!result.ok, "Digest failure must block transcript retention.");
});
