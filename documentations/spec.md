# Milestone 3F.2 Fixed Combined Library Search

## Goal

Make Library search one fixed Combined search that merges exact keyword
retrieval with a bounded, deterministic local semantic ranking over active
source metadata. Keep Library database-only: no live provider calls, no source
content sent to an external model, and no user-facing search-method selector.

## Design Decision

The Worker uses a versioned 64-dimensional feature-hash vector built from each
source title and short description. D1 scans at most 500 active sources for a
semantic request, ranks them by cosine similarity, and returns a named
`SourceSemanticIndexUnavailable` failure if the bounded local index cannot be
served. The existing query service performs authoritative active-source checks
and reciprocal-rank fusion with D1 FTS keyword results. This is intentionally
approximate semantic similarity, not pretrained language understanding; a
future hosted embedding/Vectorize index remains a separate cost and privacy
decision.

## Acceptance Criteria

- Library renders a single search input and no search-method selector.
- Omitted Library search mode defaults to `combined`; the page always sends the
  fixed mode and preserves the existing bounded query and limit validation.
- Combined results include keyword-only and local-semantic-only matches,
  deduplicate source IDs, and use deterministic reciprocal-rank fusion.
- Only active, owner-scoped sources can appear. Missing, disabled, stale, model,
  dimension, and over-capacity semantic evidence return named failures.
- Library search never calls Discover, Brave, Taddy, YouTube, RSS, or any other
  live provider.
- Semantic failures are visible as a truthful retry state; no keyword-only
  result is mislabeled as Combined.
- Existing source removal, chronological browsing, progressive reveal,
  suppressions, and preserved study/review history remain unchanged.
- Browser JavaScript remains within the approved `182,500` raw / `58,000` gzip
  aggregate ceilings; no new external browser dependency is added.

## Files In Scope

- `worker/local-semantic-index.js`
- `worker/source-library-d1.js`, `worker/main.js`, and source-catalog routing
- Library gateway, controller, and route projection
- Focused source-library, Worker, build, and hosted acceptance tests
- Current milestone documentation

## Files Out Of Scope

- Transformer model or Vectorize activation, external API credentials, and
  hosted semantic-provider cost review
- Source ingestion, learning-content generation, quiz generation, Feed ranking,
  Review scheduling, or Android packaging

## Test Plan And Results

- [x] Add route regression proving the method selector is absent.
- [x] Add gateway regression proving omitted mode becomes Combined.
- [x] Add local vector version, finite-dimension, morphology, and invalid-vector
      tests.
- [x] Add D1 semantic ranking bounds, owner scope, model identity, and result
      contract tests.
- [x] Add Worker route regression for default Combined mode.
- [x] Run focused tests, `deno task check`, full tests, and production build.
- [x] Run hosted browser acceptance for Library search and no-provider traffic.

Hosted smoke acceptance passed against Worker `97803204-e09c-49a3-9bf5-15d5043f8871`:
the Library issued exactly one `mode=combined` source-catalog request, showed
no search-method selector, returned a saved source, and emitted zero
`/api/discovery/*` provider requests.

## Logging And Privacy

Backend semantic logs contain only lifecycle event names, bounded result counts,
and named failure kinds. They never include queries, source descriptions,
vectors, credentials, or provider payloads. The local vector is derived and
used inside the Worker; it is not sent to the browser or an external service.
