# Recent Changes

## 2026-08-06: Milestone 3F.1 Hosted Acceptance Complete

- Verified automatic Feed progressive reveal and network-first shell freshness
  against an established authenticated client.
- Passed `526/526` repository tests, `38/38` browser-contract tests, strict
  checking, and redacted desktop/mobile hosted acceptance against Worker
  `c2e752bf-868d-4dad-9b01-aef77b5e08fc`.
- Kept the browser release gate strict except for the exact idempotent source
  approval `409` console response; unrelated runtime errors remain failures.

## 2026-08-06: Milestone 3F.2 Combined Library Search

- Replaced the Library method selector with one fixed Combined search and a
  truthful local-search explanation.
- Added versioned local feature-hash vectors and bounded owner-scoped semantic
  ranking over active source metadata; merged it with D1 FTS using existing RRF
  fusion and named failures.
- Hosted smoke acceptance passed against Worker
  `97803204-e09c-49a3-9bf5-15d5043f8871` with one Combined request, zero live
  Discover provider requests, no selector, and a returned Library source.

## 2026-08-06: Autonomous Hosted Browser Acceptance

- Added a typed, redacted Playwright release gate using installed Chrome and
  an ignored, isolated Cloudflare Access session.
- Repaired live Discovery state so search results, filters, selections, and
  Discover-to-Library refreshes survive route navigation without reverting to
  stale persisted results.
- Corrected Brave mixed-transport handling and the live Taddy GraphQL contract,
  including its bounded follow-up safety check and nullable block status.
- Passed `524/524` tests, strict checking, production budgets, independent
  validation, and the hosted desktop/mobile journey against Worker
  `6e0768f8-1dd9-4b07-a42a-48ad31af5d8a`.
- Preserved content-free operational evidence and verified that credentials,
  raw queries, provider payloads, and Access cookies do not enter retained
  artifacts or tracked files.

## 2026-07-29: Taddy Podcast Discovery Candidate

- Recorded Podcast Index's free-email signup restriction without attempting an
  identity or temporary-email bypass.
- Compared Taddy, PodKit, Apple plus fyyd, Podchaser, Podscan, and Listen Notes
  against catalog/search capability, feed evidence, storage rights, provider
  freshness, and the current budget; Taddy Free was selected.
- Replaced Podcast Index with a typed Taddy GraphQL adapter restricted to safe
  show-level metadata, bounded HTTPS feed evidence, and named failure modes.
- Kept approved podcast feeds metadata-only and added an exact regression that
  prohibits automatic acquisition before a future eligibility workflow grants
  `bounded-ingestion`.
- Passed strict checking, `465/465` tests, fixed production budgets, and
  independent validation. Hosted activation awaits result approval and secrets.

## 2026-07-28: Centralized Educational Search Candidate

- Added one versioned Worker educational query and metadata policy used by
  Brave Search, Podcast Index, and official YouTube metadata.
- Added provider capabilities, typed partial failures, stable cross-provider
  ordering, canonical-URL deduplication, and approved source granularity.
- Replaced provider-specific Discover forms with one accessible live search and
  native expandable provider/result filters.
- Added selection-scoped YouTube consent and atomic validation of each provider
  batch before any result is retained or counted as successful.
- Retired the raw YouTube search endpoint and prohibited saved YouTube links
  from automatic acquisition; only generic local link/transcript instructions
  are stored durably.
- Removed redundant browser provider-acquisition code while preserving Worker
  RSS, rights, destination, redirect, and ingestion controls.
- Passed strict checking, `461/461` tests, and production budgets at `181,639`
  raw / `57,528` gzip JavaScript and `23,993` raw / `5,355` gzip CSS.
- Passed independent revalidation after closing consent, malformed-provider,
  legacy-route, automatic-ingestion, and official-metadata retention findings.
- Received Milestone 3D approval for provider-secret activation and hosted
  acceptance.

## 2026-07-28: Central Search Gate

- Approved Provider A: Brave Search, Podcast Index, and official YouTube
  metadata with hybrid source granularity.
- Extended the versioned educational query and metadata policy to every selected
  provider, not only YouTube.
- Approved centralized Worker, accessible filter UI, canonical deduplication,
  partial-provider failure, and bundle-reclamation tests.

## 2026-07-28: Hosted Discovery Corrections

- Corrected receiver-safe browser fetch invocation for Discovery and Library.
- Changed YouTube search to omit item-local ineligible results without failing
  eligible results from the same query.
- Deduplicated Discovery by canonical URL while preserving immutable evidence.
- Added deterministic starter identity and typed duplicate-race recovery across
  concurrent runtimes.
- Passed strict checking, `445/445` tests, independent validation, and the exact
  `182,000` raw / `57,564` gzip aggregate JavaScript budget.

## 2026-07-26: Hosted Activation

- Provisioned and bound the D1 source library and private R2 source-content
  bucket.
- Deployed the unified Access-protected Worker with Static Assets, Browser Run,
  Durable Objects, D1, R2, and restricted YouTube Data API configuration.
- Corrected migrations, asset routing, Access configuration, lazy-route loading,
  and hosted source-catalog connectivity.

## 2026-07-22 To 2026-07-23: Source Library And Acquisition

- Added source approval/rejection, chronological Library paging, keyword search,
  source deactivation, suppression, and history-preserving Review recovery.
- Added rights registry, bounded Browser Run acquisition, resumable D1 jobs,
  private R2 content, and Free-tier capacity accounting.
- Accepted Sequence 3 Option B local implementation and hosted activation cost
  boundary.

## 2026-07-20 To 2026-07-21: Learning Experience

- Accepted Studio Signal customization and Milestone 2C.
- Added configurable study targets, independent recall cohorts, delayed adaptive
  prompts, mixed question types, local grading, progress, accuracy, and a
  Library-owned Review queue.
