# Environment And Bindings

## Local Web Application

The local fixture-backed PWA needs no environment variables or credentials.
Discovery API requests use same-origin `/api/*` paths and are never cached by
the service worker.

## Cloudflare Worker

Hosted activation is provisioned. Configure these as Worker variables unless
marked secret:

| Name                              | Contract                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGIN`                  | Exact HTTPS origin serving the web application.                                           |
| `ACCESS_ISSUER`                   | Exact Cloudflare Access issuer origin used for JWT verification.                          |
| `ACCESS_AUDIENCE`                 | Access application audience tag.                                                          |
| `ACCESS_OWNER_EMAIL`              | Account-member identity authorized for this private deployment.                           |
| `ACCESS_OWNER_ID`                 | Stable logical owner identifier mapped from that identity.                                |
| `TRANSCRIPT_LANGUAGES`            | Comma-separated, explicitly approved publisher-transcript languages.                      |
| `SOURCE_LIBRARY_DB`               | D1 binding for the synchronized source catalog. Its migration must run before activation. |
| `SOURCE_INGESTION_POLICY_VERSION` | Required non-secret policy version whenever `SOURCE_LIBRARY_DB` is configured.            |
| `SOURCE_CURSOR_SECRET`            | Required 32+ character Worker secret used only to authenticate Library page cursors.      |
| `SOURCE_CONTENT_BUCKET`           | Optional private R2 binding. Enables rights-attested source material; never expose it publicly. |
| `SOURCE_MANUAL_MAX_BYTES`         | Required positive byte limit when the private source-content bucket is bound.             |
| `SOURCE_MANUAL_MAX_CHARACTERS`    | Required positive decoded-text limit with the bucket binding.                             |
| `SOURCE_MANUAL_MEDIA_TYPES`       | Comma-separated injected text formats allowed for manual material, such as `text/plain,text/vtt`. |
| `SOURCE_BROWSER`                  | Cloudflare Browser Run binding declared in `wrangler.jsonc`; required only for generic public-site acquisition. |
| `SOURCE_BROWSER_ACCOUNT_SCOPE`    | Stable non-secret identity for the account-wide Free-plan capacity ledger. |
| `SOURCE_R2_ACCOUNT_SCOPE`         | Stable non-secret identity for the dedicated private-bucket capacity ledger. |
| `SOURCE_R2_STORED_BYTES_LIMIT`    | Exact application storage cap; approved value is `8589934592`.             |
| `SOURCE_R2_CLASS_A_MONTHLY_LIMIT` | Exact monthly Class A cap; approved value is `100000`.                     |
| `SOURCE_R2_CLASS_B_MONTHLY_LIMIT` | Exact monthly Class B cap; approved value is `1000000`.                    |
| `SOURCE_R2_OBSERVATION_MAX_AGE_MS` | Maximum age of trusted bucket reconciliation; approved value is `86400000`. |
| `YOUTUBE_SEARCH_DAILY_LIMIT`      | Search-request bucket; checked-in default is `100`.                                       |
| `YOUTUBE_GENERAL_DAILY_LIMIT`     | General Data API unit bucket; checked-in default is `10000`.                              |
| `YOUTUBE_API_KEY`                 | **Secret.** Server-held key restricted to YouTube Data API v3.                            |
| `BRAVE_SEARCH_API_KEY`            | **Secret.** Server-held Brave Search API subscription token for web source discovery.     |
| `TADDY_USER_ID`                   | **Secret.** Taddy developer user identifier. Must be configured with its matching API key. |
| `TADDY_API_KEY`                   | **Secret.** Taddy Podcast API key. Must be configured with its matching user identifier.   |

Production also requires the `YOUTUBE_QUOTA_LEDGER` and
`TRANSCRIPT_AUTHORIZATION_LEDGER` Durable Object bindings declared in
`wrangler.jsonc`. The API key must never enter browser bundles, responses, logs,
exports, D1, or R2. `YOUTUBE_QUOTA` and `TRANSCRIPT_AUTHORIZATION` are injected
test/non-Cloudflare ports, not production settings.

Generic public-site acquisition additionally requires the `SOURCE_BROWSER`
binding, the pinned development dependency `@cloudflare/puppeteer@1.1.0`, D1,
and the private R2 bucket. The checked-in browser binding does not use a Browser
Run REST API token. The account scope is an application ledger key, not a
Cloudflare account ID or credential.

Before source approval is enabled, seed the initial owner-scoped interest area
in `interest_areas` from attributed deployment configuration. Source commands
accept dynamic area identifiers but never invent labels or provenance; an absent
or wrong-owner area returns `SourceInterestAreaMissing` before the D1 write
batch.

The Worker serves Static Assets and `/api/*` on one `workers.dev` hostname.
Cloudflare Access must authenticate the account member before RSS, transcript,
or YouTube work begins. Keep `.dev.vars` and `.env` files untracked.

Missing manual-material storage configuration disables only private uploads;
the Library and metadata-only source workflow remain available. Missing or
invalid YouTube configuration disables only YouTube search. Starter Discover
items, saved metadata, RSS, publisher
transcripts, the Library, and Review remain available. R2 is used only when the
optional private `SOURCE_CONTENT_BUCKET` binding is activated.

## Milestone 3E Provider Activation

The typed Brave Search and Taddy adapters are implemented. Store credentials
interactively without echoing their values:

```sh
npx wrangler secret put BRAVE_SEARCH_API_KEY
```

```sh
npx wrangler secret put TADDY_USER_ID
npx wrangler secret put TADDY_API_KEY
```

Brave is independently optional. Taddy is enabled only when both secrets are
valid. A missing optional provider is advertised as disabled without disabling
YouTube, saved Discovery evidence, or the Library. Taddy search is limited to
podcast-series metadata and eligible public HTTPS RSS identities. It requests no
episode, artwork, audio, or transcript fields and does not enable automatic
acquisition for approved podcast results.

## Cost Gate Before Credentials

- YouTube Data API use has no modeled recurring charge within the project's
  default quota. The API key does not grant account access, bypass quota, or
  grant transcript access.
- The selected Worker, Access, and Durable Object workload is modeled at USD
  0/month within Cloudflare Free limits for this single-user prototype. A paid
  Cloudflare plan is not required by the approved workload.
- No Google OAuth client, consent screen, refresh token, or YouTube account
  permission is part of this activation.
- Brave Search is approved at USD 5 per 1,000 requests with USD 5 monthly
  credits. Enforce an application request cap before activation.
- Taddy Free provides 500 API requests per month at USD 0. Its USD 75/month Pro
  tier is outside the approved ceiling and requires a separate cost decision.
- The previously modeled retained-original storage remains about USD 0.44/month;
  this revision does not add hosted media or transcription cost. The total
  remains below the USD 20/month application ceiling.

Store production secrets with `wrangler secret put`; do not place them in chat,
source control, `.env`, `.dev.vars`, or checked-in Wrangler variables.
