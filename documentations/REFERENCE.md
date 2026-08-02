# Product And Architecture Reference

## Approved Milestone 0 Decisions

Source: user decision submitted on 2026-07-19.

- Architecture: hybrid target with database-first delivery.
- Learning emphasis: broad coverage across music knowledge, with preferences learned from explicit choices and use.
- Content strategy: platform discovery from public sources first.
- Audience: private single-user product with account-ready ownership contracts.
- Implementation tests: revise before implementation.
- Service gate: present a thorough cost analysis before requesting any API key, hosted account, or external-service
  credential.

Milestone 0 is approved after incorporating these decisions and the uploaded-content workflow below.

## Approved Milestone 1 Decisions

Source: user decision and revision instruction submitted on 2026-07-19.

- Initial planning selected free-tier Cloudflare hosting, Supabase, and R2. The
  implemented hosted architecture later consolidated application data on
  Cloudflare D1 and private R2 behind one Worker.
- Discovery: RSS, YouTube, and Brave Search.
- Private uploads: local-only processing, with 0% sent to external speech transcription.
- Public-source AI: provider-neutral integration with `deepseek-v4-flash` as the exploration default.
- Embeddings: local during exploration.
- Budget: USD 10/month application ceiling, always below USD 20; DeepSeek has a separate USD 2/month hard cap.
- Workload model: 500 accepted public items, 5 uploaded-media hours, 650 MB/hour, and 12-month original retention.
- Tests: revised again for podcasts, local processing, provider switching, and privacy, then explicitly auto-approved by
  the user's instruction to proceed.

Milestone 1 is approved. No credential is required for the fixture-backed Milestone 2A implementation.

## Product Invariants

- Preference, mastery, and exposure are separate state dimensions.
- A preference response never changes mastery or review scheduling.
- A quiz result never creates a content preference.
- A view never proves learning.
- Diminution after exposure or successful recall is gradual, configurable, bounded, and reversible when recall becomes
  due.
- Public discovery creates attributed candidates; public availability alone does not prove storage, transformation, or
  republication rights.
- Music is the first domain, not a closed taxonomy. Knowledge labels and relationships are discovered from evidence.

## Public Discovery

The discovery pipeline operates within injected source and budget policies:

1. Discover public candidates through approved APIs, feeds, indexes, or source adapters.
2. Preserve discovery method, canonical URL, retrieval time, redirects, source metadata, content version, and rights
   evidence.
3. Create link-only candidates when access is valid but copying or transformation rights are unknown.
4. Apply access, embed, storage, transformation, and attribution rules independently.
5. Recheck changed, removed, restricted, or deleted sources and mark dependent material stale when its evidence no
   longer verifies.

Unknown, inaccessible, disallowed, changed, and removed sources remain distinct outcomes.

### YouTube Connection Boundary

- Public search uses a server-held API key restricted to YouTube Data API v3
  through the Cloudflare Access-protected Worker. It requests no Google account
  access or OAuth scope.
- The key remains server-only and never enters browser persistence, responses,
  logs, exports, D1, or R2.
- Search returns only bounded official link/embed metadata. Descriptions,
  captions, audio, and video are not retained or processed.
- Search requests and general Data API reads reserve distinct atomic ledgers using the quota day in
  `America/Los_Angeles`. OAuth does not increase quota or allow public caption downloads.
- Missing/rejected key, policy acceptance, search exhaustion, general-read
  exhaustion, provider quota, upstream failure, and malformed responses remain
  distinct outcomes. YouTube failure cannot make saved discovery, starter
  content, Library, or Review unavailable.

### Central Search Boundary

- Milestones 3D and 3E use one normalized, versioned educational search intent
  across Brave Search, Taddy, and YouTube, followed by provider-specific
  encoding.
- Web documents, podcast feeds/channels, and individual educational YouTube
  videos use hybrid source granularity.
- Provider filters come from injected capabilities. Source type and source level
  require provider evidence and are never inferred from URL paths or aliases.
- Canonical deduplication happens before the aggregate result limit. Partial
  provider failures remain visible without discarding usable results.
- Search stores metadata and links only. Explicit Library approval is necessary
  but not sufficient for bounded ingestion; Taddy feeds remain metadata-only
  until a separate eligibility workflow grants `bounded-ingestion`.

## Podcast Discovery And Local Transcription

Podcast speech is a public-source workflow, not a user-upload transcription setting:

1. Discover publisher pages and feeds through RSS, Taddy series metadata, Brave Search, or YouTube metadata.
2. Prefer a publisher-provided transcript with its URL, media type, language, retrieval time, and rights provenance.
3. When no publisher transcript exists, require a user action and evidence that transcription is permitted before
   fetching an RSS enclosure.
4. Queue eligible audio for a local Apple Silicon companion. Validate HTTPS redirects, destination hosts, media
   signatures, byte and duration limits, then run a pinned local ASR model.
5. Delete temporary audio on success, cancellation, and every failure. Keep the full local ASR transcript private and
   time-bounded unless explicit retention is approved.
6. Sync only permitted learning cards, short attributed excerpts, timestamps, source links, and transformation
   provenance.

YouTube is discovery and official embed/link only. The platform must not download, separate audio from, or transcribe
YouTube media without separate written permission. An RSS enclosure proves availability, not derivative-work rights.
An offline local worker leaves the job in an explicit `waiting_for_local_worker` state.

## Uploaded-Content Insight Workflow

An upload is a private, versioned **analysis subject**, not ordinary feed content. It may include any material the user
provides for deeper understanding, subject to injected security, quota, parser, and analysis capabilities.

### Stages

1. **Preflight:** show privacy, supported processing, limitations, estimated time, and estimated cost.
2. **Private intake:** authorize the owner, create a generated storage identifier, verify size and checksum, inspect the
   content signature, scan or sandbox it, and retain the filename only as provenance.
3. **Deterministic extraction:** run only registered extractors selected from detected content capabilities. Cache
   evidence by content hash, extractor version, and parameters.
4. **Evidence-backed analysis:** distinguish observed facts, inferences, and generated explanations. Every insight
   resolves to a time, page, measure, track, segment, or other validated source anchor.
5. **Knowledge linking:** relate observations to eligible platform knowledge and classify each connection from review
   and exposure evidence as retained, developing, unseen, or unknown.
6. **Preference prompt:** when unseen related material exists, ask **Show more related learning in your feed?** with
   **More like this**, **Less like this**, and **Not now**.

### Preference Semantics

- **More like this** increases future affinity and exploration for the evidence-backed relationship scope.
- **Less like this** reduces recommendation likelihood for that scope without hiding due reviews or deleting links.
- **Not now** writes no preference event.
- No response marks content viewed, changes mastery, or invents a global category preference.
- Resetting recommendations clears these preference events while preserving analysis, provenance, and learning history.

### Privacy And Processing

- Originals and derivatives are owner-private by default and never become public feed media automatically.
- Possession of an upload is not treated as proof of copyright ownership or redistribution rights.
- Unsupported material may remain privately stored with an explicit unsupported-analysis result.
- No upload bytes, text, metadata, or derived content may leave the platform without source-level informed consent that
  names the provider, data sent, retention terms, expected cost, and revocation consequences.
- Optional external analysis requires an approved provider, a per-job estimate, and an enforced budget ceiling.
- Uploaded content is untrusted data, never instructions. Analysis workers receive no arbitrary shell, storage, feed,
  or learner-state write access.
- Export and deletion cover originals, derivatives, embeddings, reports, links, and related personalization events
  according to the approved retention policy.

## Planned Exploration AI Boundary

- `deepseek-v4-flash` was selected for a future injected, provider-neutral
  text-generation adapter; it is not an active hosted dependency.
- Use non-thinking mode for bounded public-source normalization and quiz drafts.
- Never send personal uploads, private notes, learner profiles, review history, identifiers, or full unlicensed
  transcripts to DeepSeek.
- DeepSeek inputs may be processed and stored in mainland China and may be used for service improvement; this provider
  is therefore unsuitable for private material under the approved exploration policy.
- Validate every response against a typed schema and stored evidence. Empty, malformed, unsupported, ungrounded,
  unavailable, rate-limited, and budget-exceeded outcomes remain distinct.
- The core feed, recall, and fixture-backed learning loop work without any LLM credential.
- Provider replacement changes injected configuration and adapter behavior, not feature-owned domain contracts.

## Mobile Path

Ship and verify the responsive installable PWA first. Package the verified web application with Capacitor for the first
Android release. Reconsider a native UI only if measured audio, MIDI, offline, background-processing, or performance
requirements justify the additional codebase.
