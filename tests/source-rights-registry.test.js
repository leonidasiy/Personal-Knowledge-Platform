// @ts-check

import { D1SourceRightsRegistry } from "../worker/source-rights-registry-d1.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

const now = "2026-07-22T12:00:00.000Z";
const job = Object.freeze({ ownerId: "owner-a", jobId: "job-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://publisher.example/course/", cursor: { version: 1, nextOrdinal: 0, pagesProcessed: 0, decodedBytes: 0, redirects: 0, frontier: [] } });

function evidence() {
  return JSON.stringify({
    ...Object.fromEntries(["storage", "display", "transformation"].map((name) => [name, { evidenceReference: `https://publisher.example/rights#${name}`, observedAt: "2026-07-22T10:00:00.000Z", expiresAt: null }])),
    crawl: { robots: "allowed", robotsEvidenceReference: "https://publisher.example/robots.txt", terms: "allowed", termsEvidenceReference: "https://publisher.example/terms", access: "public", accessEvidenceReference: "https://publisher.example/course/", structuralEvidence: [] },
  });
}

function row(overrides = {}) {
  return {
    owner_id: "owner-a", registry_id: "registry-a", registry_version: "registry-v1",
    source_id: "source-a", source_revision: 1, canonical_root_url: "https://publisher.example/course/",
    storage_outcome: "allowed", display_outcome: "allowed", transformation_outcome: "allowed",
    attribution_text: "Publisher course", evidence_json: evidence(), evidence_digest: "sha256:evidence",
    assessor_id: "rights-review", assessor_version: "1", observed_at: "2026-07-22T10:00:00.000Z",
    expires_at: null, state: "active", ...overrides,
  };
}

/** @param {readonly unknown[] | null} rows @param {boolean} [unavailable] */
function registry(rows, unavailable = false) {
  return new D1SourceRightsRegistry({ database: { prepare: () => { const statement = { bind: () => statement, all: async () => { if (unavailable) throw new Error("offline"); return rows === null ? {} : { results: rows }; } }; return statement; } }, now: () => now });
}

Deno.test("rights registry resolves one exact active attributed grant", async () => {
  const result = await registry([row()]).resolve(job);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.registryId, "registry-a");
    assertEquals(result.value.capabilities.transformation.outcome, "allowed");
  }
});

Deno.test("rights registry names missing, unavailable, malformed, and conflicting evidence", async () => {
  const cases = [
    [registry([]), "RightsRegistryRecordMissing"],
    [registry([], true), "RightsRegistryUnavailable"],
    [registry(null), "RightsRegistrySchemaInvalid"],
    [registry([row({ evidence_json: "{" })]), "RightsRegistrySchemaInvalid"],
    [registry([row(), row({ registry_id: "registry-b" })]), "RightsRegistryEvidenceConflicting"],
  ];
  for (const [subject, kind] of cases) {
    const result = await /** @type {D1SourceRightsRegistry} */ (subject).resolve(job);
    if (result.ok) throw new Error("Expected rights failure.");
    assertEquals(result.error.kind, kind);
  }
});

Deno.test("rights registry names identity, lifecycle, capability, and attribution failures", async () => {
  const cases = [
    [row({ owner_id: "owner-b" }), "RightsRegistryOwnerMismatch"],
    [row({ source_id: "source-b" }), "RightsRegistrySourceMismatch"],
    [row({ source_revision: 2 }), "RightsRegistryRevisionMismatch"],
    [row({ canonical_root_url: "https://publisher.example/other/" }), "RightsRegistryRootMismatch"],
    [row({ state: "revoked" }), "RightsRegistryEvidenceRevoked"],
    [row({ expires_at: now }), "RightsRegistryEvidenceExpired"],
    [row({ attribution_text: " " }), "RightsRegistryAttributionMissing"],
    [row({ evidence_json: JSON.stringify({ storage: JSON.parse(evidence()).storage, crawl: JSON.parse(evidence()).crawl }) }), "RightsRegistryCapabilityMissing"],
  ];
  for (const [entry, kind] of cases) {
    const result = await registry([entry]).resolve(job);
    if (result.ok) throw new Error("Expected rights failure.");
    assertEquals(result.error.kind, kind);
  }
});

Deno.test("rights registry rejects an invalid authoritative job before D1", async () => {
  let calls = 0;
  const subject = new D1SourceRightsRegistry({ database: { prepare: () => { calls += 1; throw new Error("must not query"); } }, now: () => now });
  const result = await subject.resolve(/** @type {typeof job} */ (/** @type {unknown} */ ({ ...job, rootUrl: "http://publisher.example" })));
  if (result.ok) throw new Error("Expected failure.");
  assertEquals(result.error.kind, "RightsRegistrySchemaInvalid");
  assertEquals(calls, 0);
});
