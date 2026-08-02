# Milestone 3F Autonomous Browser Acceptance And Discovery State Repair

## Goal

Give the agent a repeatable authenticated browser loop for the hosted product,
then use that loop to diagnose and repair Discovery search results that revert
to stale content or become unavailable when selected.

## Acceptance Criteria

- Use pinned `playwright-core` with the installed stable Google Chrome binary.
  Do not download another browser or copy a personal Chrome profile.
- Authenticate hosted automation through one 90-day Cloudflare Access service
  token permitted by an exact-token Service Auth policy for this application.
- Keep `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` only in ignored
  `.env.browser-acceptance`. Never print, log, persist, or bundle their values.
- Navigate Feed, Discover, Review, and Library at desktop and mobile viewports.
  Capture redacted screenshots, console categories, same-origin response
  statuses, timings, and Worker version without raw payloads or query text.
- Preserve the latest successful central-search query, selected providers,
  limit, items, and detail selection across Discover hash navigation and route
  changes for the current browser session without another provider request.
- A new query or filter submission atomically replaces the preceding live
  result set. Persisted starter or historical Discovery items must not replace
  it after navigation.
- Selecting a current result must render that exact result. Unknown IDs remain
  explicitly unavailable and must not resolve to another item.
- Permit one generated, reversible Library mutation only during release
  acceptance. Confirm the podcast source is `feed` plus `metadata`, then remove
  it while preserving unrelated sources and completed study/review history.
- Keep logs and screenshots under ignored `logs/` and `test-results/` for at
  most 30 days. Redaction failures are blocking test failures.
- Keep the deployed Taddy candidate online while repairing this pre-existing
  state defect. Pause further production mutations until local validation and
  independent review pass.
- Preserve the fixed browser budgets: `182,000` raw / `58,000` gzip JavaScript
  and `24,000` raw CSS. Stop for review if a correct fix cannot fit without
  compromising behavior, accessibility, privacy, or failure contracts.

## Architecture

### Browser Harness

- A feature-local browser acceptance module validates injected configuration,
  launches installed Chrome through Playwright, attaches Access service-token
  headers, and returns one named result variant per expected failure.
- The harness records only redacted operational evidence through an injected
  log sink. It never owns Cloudflare credentials or application business data.
- Fast deterministic controller tests remain the primary debugging loop. The
  hosted suite is a release-candidate gate, not a routine provider-quota test.

### Discovery Session State

- One composition-owned controller retains live central-search state for the
  browser session. Rendering a detail route resolves against the controller's
  current items before consulting persisted starter Discovery data.
- Hash and top-level route transitions reuse the controller. They do not
  recreate it, reload historical results, or issue a provider request.
- A successful search replaces the prior live collection atomically. A failed
  search keeps an explicit failure state without silently switching datasets.

## Files In Scope

- Discovery controller/composition state and focused route tests.
- One Playwright browser-acceptance feature, configuration, and tests.
- Ignored acceptance artifacts and activation documentation.
- Package metadata required for one pinned maintained dependency.

## Files Out Of Scope

- New Discovery layouts, ranking changes, semantic search, feed generation,
  podcast acquisition/transcription, Review scheduling changes, and Android
  packaging.
- Personal browser profile access, browser-extension automation, or broad
  Cloudflare service-token policies.

## Implementation Checklist

- [x] Capture the hosted stale-result and unavailable-detail symptoms.
- [x] Compare authenticated browser automation approaches and costs.
- [x] Approve Playwright, exact-token Access authentication, reversible hosted
      mutation, retention, and proposed tests.
- [ ] Build and run the deterministic failing Discovery regression.
- [ ] Identify and document the root cause before changing behavior.
- [ ] Implement the smallest state-lifecycle repair.
- [ ] Implement the typed, redacted Playwright acceptance harness.
- [ ] Run focused tests, strict checking, full tests, fixed budgets, and
      independent validation.
- [ ] Configure the exact-token Access policy and run hosted acceptance.
- [ ] Present the final Milestone 3F result before further product work.

## Design Check

This design fits the private single-user product and the existing Access
boundary. A service token is narrower and more revocable than copying a
personal browser session. Playwright is maintained, supports installed Chrome,
and is isolated from the browser production bundle as a development dependency.
The repair remains inside Discovery and composition boundaries; it does not
change provider policy, Library ownership, or learning-domain behavior.
