# Milestone 3F.1 Feed Reveal And Hosted Shell Correction

## Goal

Correct the remaining hosted acceptance defects before new product work:
automatically reveal the next frozen Feed assignment near the scroll boundary,
and make established clients converge from a stale application shell to the
current Discover result-detail behavior.

## Acceptance Criteria

- Reveal exactly one already-assigned Feed item when the reveal sentinel enters
  the configured viewport margin. Do not rerank, fetch a new feed page, create a
  study fact, or move keyboard focus.
- Guard repeated observer notifications and disconnect the reveal observer on
  rerender or route change.
- When automatic observation is unavailable, expose the existing keyboard-
  operable Load more action as a fallback. Do not show it during normal
  automatic operation.
- Keep passive exposure observation independent from progressive reveal.
- Use a freshness-first strategy for the application document and entry assets
  while preserving cache fallback offline and immutable generated-chunk reuse.
- After an application update and reload, a controlled legacy client must load
  the current build and resolve a clicked central-search result without
  historical rows or `Item unavailable`.
- Preserve current unknown-result, offline, Access, API cache exclusion,
  redaction, and Worker-version behavior.
- Attempt safe JavaScript reclamation first. Stop for an explicit budget
  revision if the correction cannot remain within `182,000` raw / `58,000`
  gzip aggregate browser JavaScript without compromising behavior. The user
  approved a revised raw ceiling of `182,500` bytes. The guarded final build is
  `182,485` raw / `57,948` gzip bytes; gzip and CSS remain unchanged.

## Files In Scope

- Feed reveal composition in `src/app.js` and focused frontend tests.
- Service-worker request strategy and offline-shell tests.
- Hosted acceptance assertions only when needed to close the stale-client gap.
- Current milestone and validation documentation.

## Files Out Of Scope

- Library search-mode UI changes, embeddings, vector indexing, semantic
  ranking, or combined-search fallback.
- Rights-safe learning generation, model-provider activation, and Milestone 4.
- Feed ranking, assignment creation, study semantics, and Review scheduling.

## Deferred Sub-Milestone 3F.2

Library search will become one fixed Combined search with no method selector.
Implementation is deferred until a separate design approves the embedding
model, vector index and refresh lifecycle, privacy boundary, named failures,
quality evaluation, and marginal hosted cost. Keyword-only behavior must not be
silently presented as Combined.

## Implementation Checklist

- [x] Reproduce the missing Feed scroll path from the current composition.
- [x] Trace the exact legacy Discover fallback that produces historical rows
      plus `Item unavailable`.
- [x] Approve happy-path, boundary, failure, update, and hosted tests.
- [x] Add and run the first failing Feed reveal regression.
- [x] Implement the smallest Feed reveal correction and make the test pass.
- [x] Add and run the failing stale-shell update regression.
- [x] Implement the smallest freshness correction and make the test pass.
- [x] Run focused checks, full tests, build budgets, and independent validation.
- [x] Deploy and run hosted browser acceptance against an established client.
- [x] Present Milestone 3F.1 results before deployment or commit.

## Design Check

The Feed correction extends the existing bounded daily assignment and does not
change ranking or learning state. The shell correction addresses a deployment
freshness boundary rather than changing the already-correct current Discover
controller. Automatic reveal remains accessible through a fallback only when
the browser capability is absent. Library semantic activation is intentionally
separate because production currently has explicit unavailable embedding and
index adapters; forcing Combined before this follow-up would make all non-empty
searches fail.

## Completion Record

Hosted acceptance passed against Worker `c2e752bf-868d-4dad-9b01-aef77b5e08fc`
with authenticated desktop and mobile journeys, current shell/module loading,
automatic Feed reveal, stale-shell recovery, centralized Discover navigation,
Library persistence, and redacted response evidence. The browser harness keeps
the expected idempotent `409` source-approval conflict out of console failures
without suppressing any other runtime error.
