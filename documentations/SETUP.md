# Local Setup

## Prerequisites

- Deno 2.x
- Node.js/npm for the pinned build-only minifiers
- Python 3.x for the static development server
- A current browser with IndexedDB, service workers, and `IntersectionObserver`

No API key, hosted account, environment file, or billing method is required for
the local fixture-backed application.

## Build And Start

From the project root:

```sh
deno task build
deno task serve
```

Open `http://localhost:4173`.

The first build may resolve pinned build-only `esbuild@0.27.4` and `terser@5.44.1` packages through `npx`. No build
dependency or remote module ships in the browser. `deno task serve` serves only the bundled `dist/` application.

The prototype stores learning records in that browser profile. Use **Library > Export** before clearing browser
storage when the records need to be retained.

## Discovery Deployment Boundary

Local study and starter Discover content remain credential-free. Hosted source
work uses the deployed same-origin Cloudflare Worker, Cloudflare Access, and the
bindings in [`ENV.md`](ENV.md). The Worker serves Static Assets and `/api/*` on
its `workers.dev` origin. Do not put secrets in the browser bundle.

For YouTube, enable YouTube Data API v3 and create a server key restricted to that API. Store it interactively with
`npx wrangler secret put YOUTUBE_API_KEY`; never put the value in this repository or chat. The app does not request a
Google login or account permission. Search is metadata-and-link only, with separate search/general daily limits; it
does not retrieve YouTube media, captions, or transcripts.

Generic Browser Run deployment additionally requires installing the pinned
server-only package before `wrangler deploy`:

```sh
npm install
npx wrangler deploy
```

The Cloudflare entry module supplies Puppeteer to the typed composition port.
Local `deno task check` intentionally checks the provider-neutral core without
resolving this deployment-only npm package. Provision the D1 source catalog and
a dedicated private R2 bucket, then bind them as `SOURCE_LIBRARY_DB` and
`SOURCE_CONTENT_BUCKET`. Add the returned non-secret identifiers to
`wrangler.jsonc`, run all D1 migrations in order, and seed an attributed
interest area plus a current trusted R2 capacity observation before ingestion.
Protect the Worker by name with Cloudflare Access and allow only the owner's
account-member identity.

Milestone 3E replaces Podcast Index with the approved Taddy Free provider.
Configure `BRAVE_SEARCH_API_KEY`, `TADDY_USER_ID`, and `TADDY_API_KEY` with
`wrangler secret put` as described in [`ENV.md`](ENV.md). Do not place provider
values in checked-in files, browser configuration, chat, `.env`, or `.dev.vars`.
Taddy results remain show/feed-level evidence only: adding one to the Library
does not start acquisition or retrieve episode, artwork, audio, or transcript
content.

The local ASR companion has typed injected storage, downloader, signature,
transcriber, uploader, and deletion ports. A packaged model, runnable daemon,
production Durable Object adapter, and automatic pairing remain later work.

## Reset

Use **Library > Erase local data**. This removes only the fixed local owner's Resonance records from IndexedDB and
their owner-scoped display settings from Web Storage.
