// @ts-check

import { WikimediaTimedTextAdapter } from "../worker/wikimedia-timedtext-adapter.js";

/** @typedef {{readonly fileRevisionId:string,readonly timedTextRevisionId:string,readonly timedTextUrl:string,readonly attribution:string,readonly fileLicense:{readonly identifiers:readonly string[],readonly references:readonly string[],readonly expiresAt:string|null},readonly timedTextLicense:{readonly identifiers:readonly string[],readonly references:readonly string[],readonly expiresAt:string|null}}} TestEvidence */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error("Expected " + String(expected) + ", received " + String(actual) + "."); }

function command() { return { ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", language: "en" }; }
/** @returns {TestEvidence} */
function resolved() { return { fileRevisionId: "file-revision-a", timedTextRevisionId: "text-revision-a", timedTextUrl: "https://commons.wikimedia.org/timedtext/a.vtt", attribution: "Creator, source, supported license", fileLicense: { identifiers: ["injected-supported-license"], references: ["https://commons.wikimedia.org/file-license"], expiresAt: null }, timedTextLicense: { identifiers: ["injected-supported-license"], references: ["https://commons.wikimedia.org/text-license"], expiresAt: null } }; }

/** @param {"supported" | "missing" | "ambiguous" | "conflict" | "unsupported"} [assessment] @param {typeof fetch} [fetch] @param {Partial<ReturnType<typeof resolved>>} [evidence] */
function adapter(assessment = "supported", fetch = async () => new Response("WEBVTT\n\n00:00.000 --> 00:02.000\nCadence", { status: 200, headers: { "content-type": "text/vtt" } }), evidence = {}) {
  return new WikimediaTimedTextAdapter({
    targets: { find: async () => ({ ok: true, value: { ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", providerIdentity: "commons-file-a" } }) },
    evidence: { resolve: async () => ({ ok: true, value: { ...resolved(), ...evidence } }) },
    fetch, validateDestination: (url) => ({ ok: true, value: new URL(url) }),
    assessLicense: () => assessment === "supported" ? ({ ok: true, value: { supported: true } }) : ({ ok: false, error: { kind: assessment } }),
    digest: async () => ({ ok: true, value: "sha256:text" }), now: () => "2026-07-22T12:00:00.000Z",
    maximumBytes: 1000, supportedMediaTypes: new Set(["text/vtt", "text/plain"]),
  });
}

Deno.test("Wikimedia adapter acquires only server-resolved rights-cleared TimedText", async () => {
  const result = await adapter().retrieve(command());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.fileRevisionId, "file-revision-a");
    assertEquals(result.value.timedTextRevisionId, "text-revision-a");
    assertEquals(result.value.attribution, "Creator, source, supported license");
  }
});

Deno.test("Wikimedia adapter rejects browser license, URL, revision, and media assertions", async () => {
  let calls = 0;
  const result = await adapter("supported", async () => { calls += 1; return new Response("video"); }).retrieve({ ...command(), timedTextUrl: "https://attacker.example/text", fileLicense: {}, mediaUrl: "https://commons.wikimedia.org/video.webm" });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "WikimediaCommandInvalid");
  assertEquals(calls, 0);
});

Deno.test("Wikimedia file and TimedText license failures remain metadata-only", async () => {
  const cases = /** @type {const} */ ([["missing", "WikimediaLicenseMissing"], ["ambiguous", "WikimediaLicenseAmbiguous"], ["conflict", "WikimediaLicenseConflict"], ["unsupported", "WikimediaLicenseUnsupported"]]);
  for (const [assessment, kind] of cases) {
    const result = await adapter(assessment).retrieve(command());
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, kind);
  }
  const expired = await adapter("supported", undefined, { timedTextLicense: { ...resolved().timedTextLicense, expiresAt: "2026-07-22T11:59:59.000Z" } }).retrieve(command());
  if (expired.ok) throw new Error("Expected failure.");
  assertEquals(expired.error.kind, "WikimediaTimedTextExpired");
});
