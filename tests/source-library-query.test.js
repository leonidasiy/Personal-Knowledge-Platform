// @ts-check

import { SourceCatalogQueryService } from "../src/features/source-library/query.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {string} id @param {string} approvedAt @param {"active" | "disabled"} [state] */
function source(id, approvedAt, state = "active") {
  return Object.freeze({
    id,
    ownerId: "owner-a",
    submittedUrl: `https://publisher.example/${id}`,
    canonicalUrl: `https://publisher.example/${id}`,
    title: `Source ${id}`,
    description: id === "source-2" ? "Harmony and rhythm" : "Music theory",
    adapter: Object.freeze({
      id: "adapter-from-registry",
      version: "1",
      granularity: "publisher-root",
      capabilities: Object.freeze(["metadata"]),
    }),
    interestAreaIds: Object.freeze(["area-a"]),
    identityEvidence: Object.freeze([{
      attribute: "canonical-link",
      value: `https://publisher.example/${id}`,
      provenanceUrl: `https://publisher.example/${id}`,
      observedAt: "2026-07-22T08:00:00.000Z",
    }]),
    state,
    approvedAt,
    updatedAt: approvedAt,
    revision: 1,
  });
}

const sources = Object.freeze([
  source("source-3", "2026-07-22T10:00:00.000Z"),
  source("source-2", "2026-07-22T09:00:00.000Z"),
  source("source-1", "2026-07-22T08:00:00.000Z"),
  source("disabled", "2026-07-22T11:00:00.000Z", "disabled"),
]);

/** @param {Partial<{ readonly catalogRevision: string, readonly decodeFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure, readonly semanticFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure, readonly privateDerivedCount: number, readonly onSemanticRanker: () => void, readonly semanticHits: readonly { readonly sourceId: string, readonly ownerId: string, readonly score: number, readonly modelId: string, readonly modelVersion: string, readonly dimensions: number }[] }>} [options] */
function fixture(options = {}) {
  const active = sources.filter((candidate) => candidate.state === "active");
  return new SourceCatalogQueryService({
    repository: {
      browseActive: ({ ownerId, limit, after }) => {
        const start = after === null
          ? 0
          : active.findIndex((candidate) => candidate.id === after.sourceId) +
            1;
        return Promise.resolve({
          ok: true,
          value: {
            items: ownerId === "owner-a"
              ? active.slice(start, start + limit)
              : [],
            interestAreas: [{
              id: "area-a",
              ownerId: "owner-a",
              title: "Configured area",
              provenance: "owner configuration",
            }],
            catalogRevision: options.catalogRevision ?? "revision-1",
          },
        });
      },
      keywordSearch: ({ ownerId, query, limit }) =>
        Promise.resolve({
          ok: true,
          value: active.filter((candidate) =>
            candidate.ownerId === ownerId &&
            `${candidate.title} ${candidate.description}`.toLowerCase()
              .includes(query.toLowerCase())
          ).slice(0, limit).map((candidate, index) => ({
            source: candidate,
            score: 1 - index / 10,
          })),
        }),
      knowledgeKeywordSearch: ({ ownerId, query, limit }) => Promise.resolve({
        ok: true,
        value: ownerId === "owner-a" && query.toLowerCase().includes("cadence")
          ? [{ knowledge: { knowledgeId: "knowledge-cadence", sourceId: "source-2", sourceTitle: "Source source-2", summary: "A cadence resolves harmonic tension.", sourceUrl: "https://publisher.example/source-2", evidenceAnchorIds: ["anchor-cadence"], questionLocked: true }, score: 1, matchedBy: /** @type {const} */ ("exact") }].slice(0, limit)
          : [],
      }),
      knowledgeSemanticCandidates: ({ ownerId, limit }) => Promise.resolve({
        ok: true,
        value: { candidates: ownerId === "owner-a" ? [{ knowledge: { knowledgeId: "knowledge-cadence", sourceId: "source-2", sourceTitle: "Source source-2", summary: "A cadence resolves harmonic tension.", sourceUrl: "https://publisher.example/source-2", evidenceAnchorIds: ["anchor-cadence"], questionLocked: true }, sourceRevision: 1 }].slice(0, limit) : [], privateDerivedCount: options.privateDerivedCount ?? 0 },
      }),
      activeByIds: ({ ownerId, sourceIds }) =>
        Promise.resolve({
          ok: true,
          value: active.filter((candidate) =>
            candidate.ownerId === ownerId && sourceIds.includes(candidate.id)
          ),
        }),
      suppressed: ({ ownerId, canonicalIdentities }) =>
        Promise.resolve({
          ok: true,
          value: ownerId === "owner-a"
            ? canonicalIdentities.filter((identity) =>
              identity.endsWith("/rejected")
            )
            : [],
        }),
    },
    cursorCodec: {
      encode: (value) =>
        Promise.resolve({
          ok: true,
          value: btoa(JSON.stringify(value)),
        }),
      decode: (value) => {
        if (options.decodeFailure !== undefined) {
          return Promise.resolve({ ok: false, error: options.decodeFailure });
        }
        return Promise.resolve({ ok: true, value: JSON.parse(atob(value)) });
      },
    },
    semanticRanker: { rank: ({ scope }) => { options.onSemanticRanker?.(); return options.semanticFailure === undefined ? Promise.resolve({ ok: true, value: { matches: scope === "knowledge" ? [{ id: "knowledge-cadence", score: 0.84 }] : (options.semanticHits ?? [{ sourceId: "source-2", score: 0.9 }]).map((hit) => ({ id: hit.sourceId, score: hit.score })) } }) : Promise.resolve({ ok: false, error: options.semanticFailure }); } },
    maximumSemanticCandidates: 20,
    maximumPageSize: 2,
    maximumQueryLength: 20,
    fusionVersion: "rrf-v1",
  });
}

Deno.test("source catalog uses stable keyset pages and excludes disabled sources", async () => {
  const catalog = fixture();
  const first = await catalog.browse({ ownerId: "owner-a", limit: 2 });
  assertEquals(first.ok, true);
  if (!first.ok) throw new Error(first.error.kind);
  assertEquals(
    first.value.items.map((item) => item.id).join(","),
    "source-3,source-2",
  );
  assertEquals(typeof first.value.nextCursor, "string");

  const second = await catalog.browse({
    ownerId: "owner-a",
    limit: 2,
    cursor: first.value.nextCursor,
  });
  assertEquals(second.ok, true);
  if (!second.ok) throw new Error(second.error.kind);
  assertEquals(second.value.items.map((item) => item.id).join(","), "source-1");
  assertEquals(second.value.nextCursor, null);
});

Deno.test("catalog cursor failures remain distinct", async () => {
  const invalid = await fixture({
    decodeFailure: { kind: "SourceCursorInvalid" },
  }).browse({
    ownerId: "owner-a",
    limit: 1,
    cursor: "invalid",
  });
  assertEquals(invalid.ok, false);
  if (invalid.ok) throw new Error("Expected invalid cursor.");
  assertEquals(invalid.error.kind, "SourceCursorInvalid");

  const wrongOwner = btoa(JSON.stringify({
    ownerId: "owner-b",
    approvedAt: sources[0].approvedAt,
    sourceId: sources[0].id,
    catalogRevision: "revision-1",
  }));
  const mismatched = await fixture().browse({
    ownerId: "owner-a",
    limit: 1,
    cursor: wrongOwner,
  });
  assertEquals(mismatched.ok, false);
  if (mismatched.ok) throw new Error("Expected owner mismatch.");
  assertEquals(mismatched.error.kind, "SourceCursorOwnerMismatch");

  const stale = btoa(JSON.stringify({
    ownerId: "owner-a",
    approvedAt: sources[0].approvedAt,
    sourceId: sources[0].id,
    catalogRevision: "older",
  }));
  const changed = await fixture().browse({
    ownerId: "owner-a",
    limit: 1,
    cursor: stale,
  });
  assertEquals(changed.ok, false);
  if (changed.ok) throw new Error("Expected stale cursor.");
  assertEquals(changed.error.kind, "SourceCursorStale");
});

Deno.test("keyword search is bounded and validates the query", async () => {
  const catalog = fixture();
  const found = await catalog.search({
    ownerId: "owner-a",
    query: "harmony",
    mode: "keyword",
    limit: 2,
  });
  assertEquals(found.ok, true);
  if (!found.ok) throw new Error(found.error.kind);
  assertEquals(found.value[0].source.id, "source-2");

  const blank = await catalog.search({
    ownerId: "owner-a",
    query: " ",
    mode: "keyword",
    limit: 2,
  });
  assertEquals(blank.ok, false);
  if (blank.ok) throw new Error("Expected blank query failure.");
  assertEquals(blank.error.kind, "SourceSearchQueryInvalid");

  const long = await catalog.search({
    ownerId: "owner-a",
    query: "x".repeat(21),
    mode: "keyword",
    limit: 2,
  });
  assertEquals(long.ok, false);
  if (long.ok) throw new Error("Expected query length failure.");
  assertEquals(long.error.kind, "SourceSearchQueryTooLong");
});

Deno.test("semantic search filters through authoritative active D1 sources", async () => {
  const found = await fixture().search({
    ownerId: "owner-a",
    query: "rhythmic tension",
    mode: "semantic",
    externalProcessingAllowed: true,
    limit: 2,
  });
  assertEquals(found.ok, true);
  if (!found.ok) throw new Error(found.error.kind);
  assertEquals(found.value.length, 1);
  assertEquals(found.value[0].source.id, "source-2");

  const stale = await fixture({
    semanticHits: [{
      sourceId: "disabled",
      ownerId: "owner-a",
      score: 0.9,
      modelId: "local-model",
      modelVersion: "1",
      dimensions: 2,
    }],
  }).search({
    ownerId: "owner-a",
    query: "rhythm",
    mode: "semantic",
    externalProcessingAllowed: true,
    limit: 2,
  });
  assertEquals(stale.ok, false);
  if (stale.ok) throw new Error("Expected stale vector failure.");
  assertEquals(stale.error.kind, "SourceSemanticIndexOutOfSync");
});

Deno.test("combined search never masks semantic failure", async () => {
  const unavailable = await fixture({
    semanticFailure: { kind: "SourceSemanticIndexUnavailable" },
  }).search({
    ownerId: "owner-a",
    query: "theory",
    mode: "combined",
    externalProcessingAllowed: true,
    limit: 2,
  });
  assertEquals(unavailable.ok, false);
  if (unavailable.ok) throw new Error("Expected embedding failure.");
  assertEquals(unavailable.error.kind, "SourceSemanticIndexUnavailable");

  const combined = await fixture().search({
    ownerId: "owner-a",
    query: "source",
    mode: "combined",
    externalProcessingAllowed: true,
    limit: 2,
  });
  assertEquals(combined.ok, true);
  if (!combined.ok) throw new Error(combined.error.kind);
  assertEquals(combined.value.length, 2);
  assertEquals(combined.value[0].source.id, "source-2");
});

Deno.test("semantic and combined search require explicit external-processing consent before ranking", async () => {
  let calls = 0;
  for (const mode of /** @type {const} */ (["semantic", "combined"])) {
    const result = await fixture({ onSemanticRanker: () => calls += 1 }).search({ ownerId: "owner-a", query: "harmony", mode, limit: 2 });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "SourceSemanticConsentRequired");
  }
  assertEquals(calls, 0);
  const exact = await fixture({ onSemanticRanker: () => calls += 1 }).search({ ownerId: "owner-a", query: "harmony", mode: "keyword", limit: 2 });
  assertEquals(exact.ok, true);
  assertEquals(calls, 0);
});

Deno.test("knowledge search returns exact and thresholded semantic matches across sources", async () => {
  const exact = await fixture().search({ ownerId: "owner-a", query: "cadence", scope: "knowledge", mode: "keyword", limit: 2 });
  assertEquals(exact.ok, true);
  if (!exact.ok) throw new Error(exact.error.kind);
  assertEquals(exact.value[0].knowledge.knowledgeId, "knowledge-cadence");
  assertEquals(exact.value[0].matchedBy, "exact");

  const semantic = await fixture().search({ ownerId: "owner-a", query: "harmonic resolution", scope: "knowledge", mode: "semantic", externalProcessingAllowed: true, limit: 2 });
  assertEquals(semantic.ok, true);
  if (!semantic.ok) throw new Error(semantic.error.kind);
  assertEquals(semantic.value.length, 1);
  assertEquals(semantic.value[0].knowledge.sourceId, "source-2");
  assertEquals(semantic.value[0].score >= 0.6, true);
});

Deno.test("semantic knowledge search refuses external ranking when uploaded-derived knowledge exists", async () => {
  const result = await fixture({ privateDerivedCount: 1 }).search({ ownerId: "owner-a", query: "cadence", scope: "knowledge", mode: "semantic", externalProcessingAllowed: true, limit: 2 });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "SourceSemanticConsentRequired");
});

Deno.test("suppression checks are owner scoped, bounded, and deduplicated", async () => {
  const catalog = fixture();
  const result = await catalog.suppressed({
    ownerId: "owner-a",
    canonicalIdentities: [
      "https://publisher.example/rejected",
      "https://publisher.example/rejected",
      "https://publisher.example/visible",
    ],
  });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.join(","), "https://publisher.example/rejected");
  const over = await catalog.suppressed({
    ownerId: "owner-a",
    canonicalIdentities: Array.from(
      { length: 51 },
      (_, index) => `identity-${index}`,
    ),
  });
  assertEquals(over.ok, false);
});

Deno.test("active source checks are owner scoped, bounded, and exclude disabled sources", async () => {
  const catalog = fixture();
  const result = await catalog.active({
    ownerId: "owner-a",
    sourceIds: ["source-2", "disabled", "source-2"],
  });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.join(","), "source-2");
  const wrongOwner = await catalog.active({
    ownerId: "owner-b",
    sourceIds: ["source-2"],
  });
  assertEquals(wrongOwner.ok, true);
  if (!wrongOwner.ok) throw new Error(wrongOwner.error.kind);
  assertEquals(wrongOwner.value.length, 0);
});
