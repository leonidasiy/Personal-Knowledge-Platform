# Test Specification

## Milestone 3F.1 Feed Reveal And Hosted Shell Correction

**Status: approved 2026-08-06. Library Alternative B is deferred to separate
sub-milestone 3F.2.**

### Feed Progressive Reveal

- A Feed with hidden frozen assignments renders an automatic reveal sentinel.
  Entering the configured viewport margin reveals exactly one next assignment
  without calling ranking, moving focus, or writing study state.
- Repeated observer notifications cannot reveal more than one item for the same
  rendered sentinel. Rerender and route change disconnect the prior observer.
- No hidden assignment creates no reveal observer or control.
- Missing or failed observer capability exposes the keyboard-operable Load more
  fallback; normal automatic operation does not show that button.
- Passive exposure observation remains independent and retains its dwell and
  visibility thresholds.

### Hosted Shell And Discover Detail

- A deterministic two-version scenario begins with a controlled legacy cached
  application shell, publishes a changed build, reloads, and converges to the
  current document, entry module, styles, manifest, and Worker version.
- Navigations and entry assets use network-first freshness with current-cache
  write-through and exact offline fallback. Immutable generated chunks remain
  cacheable. API requests and authenticated payloads never enter the shell
  cache.
- After convergence, a central search result click retains the current query,
  filters, limit, and result collection; it performs no replacement search and
  renders the exact selected item without historical persisted rows.
- Unknown IDs remain explicitly unavailable. Current offline results remain
  inspectable without claiming unavailable network actions.
- Network failure with a cached shell succeeds offline; network and cache
  failure emits the existing typed, content-free offline failure.

### Delivery

- Pass focused Feed, offline-shell, build, and browser-acceptance regressions,
  strict checking, the full suite, production budgets, hosted desktop/mobile
  acceptance, and independent validation before deployment.
- Preserve redacted evidence: no query text, source content, credentials,
  Access cookies, or raw provider payloads in retained logs or screenshots.

### Candidate Validation

- Focused build, Feed, frontend, and offline-shell regressions: `41/41` passed.
- Strict repository check: passed.
- Full repository suite: `526/526` passed after the executable two-version and
  stale-observer lifecycle regressions were strengthened.
- Production build: `182,485` raw / `57,948` gzip aggregate JavaScript and
  `23,993` raw / `5,355` gzip CSS. The user approved the `182,500` raw ceiling;
  gzip and CSS budgets are unchanged.
- Independent validation passed after closing stale-observer lifecycle gaps.
  Hosted desktop/mobile acceptance remains required after deployment.

## Milestone 3F Autonomous Browser Acceptance And Discovery State Repair

**Status: design and original tests approved 2026-08-01; Option B interactive
Access session and its revised tests approved 2026-08-05; implementation and
independent validation completed 2026-08-05.**

### Discovery State Regression

- After a central search, selecting a returned ID renders that exact current
  item rather than `Item unavailable` or a persisted starter item.
- Detail, Back to results, hash navigation, and top-level route navigation
  preserve the current query, provider filters, limit, and result collection
  for the browser session without another provider request.
- A second query or filter change atomically replaces the prior live result set.
  No prior persisted or central result may reappear.
- Empty, partial, failed, and unknown-selection states remain explicit.
  Suppressed identities remain hidden without changing the active dataset.

### Browser Harness Contract

- Validate target URL, installed Chrome path, result directory, timeouts, and
  the canonical isolated storage-state path before launching a browser.
- Bootstrap storage state in a headed isolated context only after the canonical
  Worker succeeds with a valid Worker version. Enforce `0700` on its directory,
  `0600` on its file, and Git exclusion for both.
- Return distinct named failures for missing, unreadable, malformed, or expired
  session state; invalid target; browser launch/setup failure; Access
  redirect/rejection; navigation timeout; unexpected console error; failed
  same-origin module/API response; assertion failure; artifact write failure;
  cleanup failure; and redaction failure.
- Never include cookies, Access tokens, raw response bodies, or query text in
  results, exceptions, console output, logs, screenshots, or filenames.
- Load session state directly into the fresh browser context. Send no Access
  client headers, install no service-token request route, and do not persist a
  personal Chrome profile.
- Navigate Feed, Discover, Review, and Library at approved desktop and mobile
  viewports with no uncaught console error or failed same-origin module request.
- Run one generic bounded central search, select a result, return to the same
  collection, change filters, and confirm the old collection is replaced.
- Add one generated podcast acceptance source as `feed` plus `metadata`, confirm
  D1-backed Library persistence, remove it, and confirm unrelated sources and
  completed learning history remain.
- Keep screenshots and redacted operational logs in ignored artifact folders
  and remove artifacts older than 30 days.

### Regression And Delivery

- Keep Taddy metadata-only, YouTube manual-transcript-only, Library D1-only
  search, Access authentication, source suppression, and provider quotas
  unchanged.
- Pin the maintained browser dependency and keep it out of production browser
  artifacts.
- Pass the focused controller and harness tests, `deno task check`, the full
  suite, fixed production budgets, and independent validation before hosted
  acceptance.

## Milestone 3E Podcast Discovery Activation Recovery

**Status: Provider A and tests approved 2026-07-29; local implementation and
independent validation completed 2026-07-29; hosted activation checks approved
2026-08-01 and in progress.**

### Taddy Provider Contract

- Accept only a typed central provider command with the configured provider ID,
  the already-augmented educational query, and a bounded positive result limit.
- Send one bounded HTTPS GraphQL search request and, only when it returns IDs,
  one bounded `getMultiplePodcastSeries` safety/details request with
  `X-USER-ID` and `X-API-KEY` from injected Worker secrets. Never return, log,
  export, or persist either credential. A non-empty search therefore uses two
  Taddy requests; the 500-request free allowance conservatively supports 250
  such searches per month before any other Taddy use.
- Query only `PODCASTSERIES`, enable safe mode, use the already-augmented query,
  and request the smaller of the command and configured result limits. The
  second request retrieves only bounded feed identity and safety evidence. Do
  not request episode, audio, artwork, transcript, or hosted-media fields.
- Validate the complete response batch before returning results. Reject a
  malformed batch atomically with a named provider-response failure.
- Return show/feed-level evidence only. Accept an HTTPS RSS URL only when the
  provider supplies it. Private, blocked, duplicate, invalid, and missing feed
  states fail explicitly and are never treated as an active source.
- Preserve the provider UUID, ranking evidence, refresh priority, and canonical
  identity as bounded provenance without retaining provider-hosted media.
- Map missing credential, timeout, network, non-success status, GraphQL error,
  malformed JSON, invalid result, blocked/private feed, quota, and missing
  canonical identity to distinct named failures.

### Central Policy And Persistence

- Pass the same Worker-normalized and educationally augmented query used by all
  other providers; never send the raw submitted query as the provider query.
- Apply the shared versioned educational metadata policy before central
  deduplication and aggregate limiting.
- Advertise podcast capability only when both Taddy secrets and complete typed
  configuration are valid.
- Preserve partial success when another selected provider fails and preserve an
  explicit all-provider failure when none succeeds.
- On Add to Library, persist only generic local source metadata, canonical link
  or evidenced feed identity, and bounded provenance. Persist no Taddy title,
  publisher, publication date, artwork, audio, episode, or transcript metadata.
- Persist Taddy results without `bounded-ingestion`. Automatic acquisition must
  return `IngestionSourceAcquisitionProhibited` until a later approved Taddy
  eligibility workflow explicitly revalidates the feed and grants that
  capability.

### Regression And Delivery

- Keep Library search D1-only, YouTube consent scoped to YouTube selection, and
  YouTube manual-transcript-only acquisition unchanged.
- Keep central result filtering, rejection, approval, canonical deduplication,
  typed failure messages, keyboard operation, and loading protection working.
- Pass focused tests, `deno task check`, `deno task test`, the fixed production
  budgets, and independent validation before hosted deployment.

### Hosted Acceptance

- Confirm Cloudflare Access still rejects unauthenticated API requests and the
  static application remains available after authenticated sign-in.
- Run one generic centralized search with Brave and Taddy selected. Confirm
  successful provider results or a named partial-provider failure without
  exposing credentials, queries, tokens, or raw provider responses.
- Add one podcast result to the Library, confirm owner-scoped D1 persistence and
  metadata-only capabilities, then deactivate the acceptance source while
  preserving existing study and review history.
- Record redacted endpoint category, status, duration, named failure, and Worker
  version in ignored local logs. Reject any log containing query text, Access
  tokens, credentials, or raw provider payloads.
- Roll back to the preceding Worker version if Access, API routing, centralized
  search, Library persistence, or static route acceptance fails.

### Milestone 3F.1 Completed Validation

- `38/38` browser-acceptance contract tests passed, including the exact
  expected `409 /api/source-library/approve` console exception boundary.
- `526/526` repository tests passed after the harness correction.
- `deno task check` and `git diff --check` passed.
- Hosted desktop/mobile acceptance passed against Worker
  `c2e752bf-868d-4dad-9b01-aef77b5e08fc`; no unexpected console or page errors
  remained and all retained evidence was redacted.

## Milestone 3F.2 Combined Library Search

### Proposed And Implemented Tests

- The Library route has no search-method selector and the gateway defaults an
  omitted mode to `combined`.
- The local feature-hash vector is versioned, finite, dimension-checked, and
  deterministic; related morphology receives a positive cosine score.
- D1 semantic ranking is owner-scoped, bounded to 500 active sources, returns
  only versioned raw semantic hits, and fails closed over the cap.
- The Worker source-catalog route defaults missing mode to Combined while
  preserving the legacy typed route contract.
- Existing query-service tests cover semantic-only, keyword-only, union,
  de-duplication, active-source revalidation, and named model/index failures.

### Completed Local Validation

- Focused source-library/Worker tests: `39/39` passed.
- Full repository tests: `530/530` passed.
- `deno task check` passed.
- Production browser build passed the existing raw/gzip budgets.

### Hosted Acceptance Completed

- Hosted smoke acceptance passed against Worker
  `97803204-e09c-49a3-9bf5-15d5043f8871`: one `mode=combined` Library request,
  zero Discover-provider requests, no selector, and one returned source.

## Milestone 3D Centralized Educational Source Search

**Status: approved for hosted activation, locally completed, and independently
validated 2026-07-28; hosted acceptance pending.** Provider A and Granularity A are implemented. The
educational query policy applies to the entire centralized search, with
provider-specific encoding after one shared normalization and augmentation
step.

### Educational Query Policy

- Normalize Unicode and whitespace, preserve the submitted query as local
  provenance, and create one bounded, versioned educational intent.
- Do not duplicate configured instructional terms case-insensitively.
- Reject empty, oversized input and oversized augmented output before quota or
  provider work.
- Send only provider-specific encodings of the augmented intent. Do not send the
  raw submitted query as a provider search query.
- Apply the same versioned educational metadata gate to every provider result.
  Preserve deterministic provider and result order among accepted results.
- Keep provider credentials out of browser state, responses, logs, exports,
  D1, and R2.

### Central Worker Search

- Strictly validate the query, unique configured provider IDs, and bounded
  integer result limit.
- Return named failures for unknown, disabled, duplicate, or empty provider
  selections before provider work.
- Run only selected enabled adapters from injected provider configuration.
- Deduplicate canonical URLs across providers before the aggregate limit using
  configured provider priority and a stable identifier tie-break.
- Require provider evidence for result kind and source level. Never infer them
  from a filename, URL path, or domain alias.
- Preserve usable results with typed partial-provider failures. Return a named
  aggregate failure when every selected provider fails.
- Preserve distinct authentication, owner, credential, quota, timeout,
  malformed-response, and upstream failures.

### Central Discover Interface

- Render exactly one labelled live-search form.
- Provide a keyboard-operable native `details` filter panel with configured
  provider checkboxes and a bounded result-count control.
- Preserve selected filters and count across rerenders; prevent duplicate
  submissions while loading and announce busy state.
- Render accessible empty, partial, offline, unauthenticated, unavailable,
  malformed, and success states with nontechnical messages.
- Require YouTube policy acceptance only when YouTube is selected.
- Reject a malformed provider batch atomically; do not count it as a successful
  provider or retain a valid-looking subset from the malformed response.
- Preserve evidence-only results, provenance, Add to Library, Reject, manual
  YouTube transcript instructions, and canonical deduplication.
- Do not expose the retired provider-specific YouTube search route. Saved
  YouTube links remain manual-transcript-only and cannot enter automatic
  Browser Run acquisition.
- Do not durably retain expiring official YouTube title or publisher metadata;
  persist only the selected canonical link and generic local instructions.
- Keep Library keyword/semantic search D1-only with no live provider request.

### Reclamation And Delivery

- Remove the browser-only direct RSS parser/acquisition path while retaining all
  Worker RSS destination, redirect, XML, rights, and ingestion controls.
- Compare baseline and candidate artifacts with the same pinned toolchain.
  Record per-chunk and aggregate raw/gzip deltas, changed-cache transfer, CSS,
  initial transfer, largest lazy chunk, and changed asset count.
- Measure route and search timing separately from byte size.
- Keep the approved `182 KB raw / 58 KB gzip` aggregate limits unless safe
  reclamation cannot accommodate the candidate. Any revision requires explicit
  approval and a marginal provider/transfer cost report.
- Run focused tests, `deno task check`, `deno task test`, the production build,
  and independent validation before hosted acceptance.

## Validation Ledger

Detailed behavior is authoritative in `tests/`; this ledger retains milestone
approval and outcome without duplicating executable specifications.

| Milestone | Outcome |
| --- | --- |
| Milestone 3F autonomous browser acceptance | `524/524` full tests, `38/38` focused browser-contract tests, strict check, and production build passed; hosted desktop/mobile journey passed against Worker `6e0768f8-1dd9-4b07-a42a-48ad31af5d8a`; one exact site source was approved and disabled while completed Review history and unrelated Library sources remained; 8 redacted screenshots retained; JavaScript `181,935` raw / `57,807` gzip and CSS `23,993` raw / `5,355` gzip; independent validation found no remaining code or privacy blocker |
| Milestone 3E Taddy podcast discovery | Independent revalidation found no blocking issue after confirming the metadata-only ingestion gate; `465/465` full tests and `20/20` independently selected relevant tests passed; strict check and production build passed; browser artifacts remained `181,639` raw / `57,528` gzip JavaScript and `23,993` raw / `5,355` gzip CSS; hosted activation pending |
| Milestone 3D centralized educational search | Independent revalidation found no blocking issue; `461/461` full tests and `19/19` independently selected relevant tests passed; strict check and production build passed; `181,639` raw / `57,528` gzip aggregate JavaScript; `23,993` raw / `5,355` gzip CSS; hosted provider timing pending |
| Milestone 3 eligibility and canonical deduplication | `31/31` focused and `445/445` full tests passed; strict check passed; `182,000` raw / `57,564` gzip aggregate JavaScript |
| Hosted browser-fetch correction | `14/14` focused and `440/440` full tests passed; independent validation found no issue |
| Hosted recovery correction | `438/438` full tests passed; delayed Recall and source recovery validated |
| Source Library and bounded ingestion | D1 catalog, approval, suppression, Browser Run, R2 capacity, rights, and cursor suites passed before hosted activation |
| Milestone 2C learning and recall | `128/128` tests passed; configurable study sets, delayed prompts, mixed questions, accuracy, and Review queue accepted |
| Milestone 2B experience | `88/88` tests passed; Studio Signal customization accepted |
| Milestone 2A local loop | `44/44` tests passed; offline feed, preference, recall, persistence, export, and reset implemented |

Hosted browser checks remain listed in [`TESTING.md`](TESTING.md).
