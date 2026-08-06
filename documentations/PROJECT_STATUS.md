# Project Status

## Current Phase

Milestone 3F.1 autonomous hosted browser acceptance is approved, deployed, and
independently validated. The selected provider boundary remains Brave Search
for web publisher roots, Taddy Free for podcast shows and evidenced feeds, and
official YouTube metadata for individual videos. One shared versioned
educational query and metadata policy runs before provider-specific encoding
and filters every provider's results.

The hosted application uses one Cloudflare Access-protected Worker with
Static Assets, D1, private R2, Browser Run, Durable Objects, and a restricted
YouTube Data API key. Milestone 3F passed strict checking, `524/524` tests,
independent validation, and the hosted desktop/mobile journey against Worker
`c2e752bf-868d-4dad-9b01-aef77b5e08fc`. The production build is `182,485` raw / `57,948` gzip
aggregate JavaScript plus `23,993` raw / `5,355` gzip CSS.

## Completed Product Capabilities

- Hybrid, database-first, single-user/account-ready architecture with Music as
  the first configurable knowledge area.
- Installable responsive PWA with Feed, Review, Library, Discover, Settings,
  offline shell, themes, accessible motion, optional sound, export, and reset.
- Explainable feed ranking with separate preference, exposure, study, mastery,
  and review signals.
- Configurable daily study sets, smaller independent recall cohorts, delayed
  prompt generation, mixed question types, local grading, FSRS scheduling, and
  daily/seven-day recall accuracy.
- Owner-scoped immutable local persistence with validation, replay, migration,
  quarantine/export recovery, IndexedDB, and rollback-safe composition.
- D1-backed Source Library with chronological paging, keyword search, source
  approval/rejection, suppression, deactivation, and preserved study history.
- Access-authenticated RSS/Atom acquisition, Podcasting 2.0 references,
  official YouTube metadata search, publisher transcript authorization, and
  evidence-only Discovery results.
- Centralized live search whose Worker normalizes and educationally augments
  every provider query, then filters every provider batch through the same
  versioned educational metadata policy.
- Rights-gated Browser Run acquisition with public-destination enforcement,
  bounded traversal, resumable cursors, private R2 staging, capacity ledgers,
  and fail-closed cleanup.
- Local companion contracts for rights-approved podcast ASR with bounded jobs,
  pinned model identity, expiring leases, and mandatory temporary-media
  deletion.
- Typed Playwright release acceptance with isolated Access authentication,
  redacted operational evidence, desktop/mobile route coverage, reversible
  Library mutation, and Worker-version verification.

## Active Work

- Implement Milestone 3F.2 fixed Combined Library search with deterministic
  keyword plus local semantic retrieval, explicit availability failures, and
  no live provider calls from Library.

## Later Work

- Package the local ASR companion and model with user-visible pairing/restart
  controls.
- Add rights-safe learning-content and quiz generation from approved sources.
- Activate semantic Library search only after its model/index and failure
  boundary are approved.
- Package the verified PWA with Capacitor for Android.
