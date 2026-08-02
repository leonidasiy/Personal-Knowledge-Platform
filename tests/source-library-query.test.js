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

/** @param {Partial<{ readonly catalogRevision: string, readonly decodeFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure, readonly embeddingFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure, readonly semanticFailure: import("../src/features/source-library/contracts.js").SourceLibraryFailure, readonly semanticHits: readonly { readonly sourceId: string, readonly ownerId: string, readonly score: number, readonly modelId: string, readonly modelVersion: string, readonly dimensions: number }[] }>} [options] */
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
    embedding: {
      create: () =>
        options.embeddingFailure === undefined
          ? Promise.resolve({
            ok: true,
            value: {
              vector: [0.2, 0.8],
              modelId: "local-model",
              modelVersion: "1",
              dimensions: 2,
            },
          })
          : Promise.resolve({ ok: false, error: options.embeddingFailure }),
    },
    semanticIndex: {
      search: () =>
        options.semanticFailure === undefined
          ? Promise.resolve({
            ok: true,
            value: options.semanticHits ?? [{
              sourceId: "source-2",
              ownerId: "owner-a",
              score: 0.9,
              modelId: "local-model",
              modelVersion: "1",
              dimensions: 2,
            }],
          })
          : Promise.resolve({ ok: false, error: options.semanticFailure }),
    },
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
    limit: 2,
  });
  assertEquals(stale.ok, false);
  if (stale.ok) throw new Error("Expected stale vector failure.");
  assertEquals(stale.error.kind, "SourceSemanticIndexOutOfSync");
});

Deno.test("combined search never masks semantic failure", async () => {
  const unavailable = await fixture({
    embeddingFailure: { kind: "SourceEmbeddingUnavailable" },
  }).search({
    ownerId: "owner-a",
    query: "theory",
    mode: "combined",
    limit: 2,
  });
  assertEquals(unavailable.ok, false);
  if (unavailable.ok) throw new Error("Expected embedding failure.");
  assertEquals(unavailable.error.kind, "SourceEmbeddingUnavailable");

  const combined = await fixture().search({
    ownerId: "owner-a",
    query: "source",
    mode: "combined",
    limit: 2,
  });
  assertEquals(combined.ok, true);
  if (!combined.ok) throw new Error(combined.error.kind);
  assertEquals(combined.value.length, 2);
  assertEquals(combined.value[0].source.id, "source-2");
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
