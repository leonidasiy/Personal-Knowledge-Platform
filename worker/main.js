// @ts-check

import { CloudflareAccessAuthenticator } from "./access-authenticator.js";
import { SourceLibraryService } from "../src/features/source-library/service.js";
import { SourceCatalogQueryService } from "../src/features/source-library/query.js";
import { isRecord } from "./contracts.js";
import { validatePublisherDestination } from "./destination-policy.js";
import { createDiscoveryWorker } from "./handler.js";
import { RssAtomAcquisitionAdapter } from "./rss-atom-adapter.js";
import { PublisherTranscriptAdapter } from "./transcript-adapter.js";
import {
  DurablePublisherTranscriptAuthorization,
  PublisherTranscriptAuthorizationDurableObject,
} from "./transcript-authorization.js";
import { YouTubeDiscoveryAdapter } from "./youtube-adapter.js";
import { createEducationalSearchPolicy } from "./educational-search-policy.js";
import { createCentralDiscoverySearch } from "./discovery-search.js";
import { instrumentCentralSearch } from "./search-observability.js";
import { createBraveSearchProvider } from "./brave-search-adapter.js";
import { createTaddySearchProvider } from "./taddy-search-adapter.js";
import { createYouTubeSearchProvider } from "./youtube-search-provider.js";
import { YouTubeOAuthService } from "./youtube-oauth.js";
import { D1SourceLibraryRepository } from "./source-library-d1.js";
import { D1ManualMaterialRepository } from "./manual-material-d1.js";
import { R2SourceContentStore } from "./source-content-r2.js";
import { SourcePolicyEvaluator } from "../src/features/source-library/ingestion-policy.js";
import { D1SourceIngestionRepository } from "./source-ingestion-d1.js";
import { D1SourceRightsRegistry } from "./source-rights-registry-d1.js";
import { D1BrowserRunCapacityLedger } from "./browser-run-capacity-d1.js";
import { D1R2CapacityLedger } from "./r2-capacity-d1.js";
import { BrowserRunPageAcquirer } from "./browser-run-page-acquirer.js";
import { SourceIngestionRunner } from "./source-ingestion-runner.js";
import { ManualMaterialService } from "../src/features/source-library/manual-material.js";
import { createSourceCursorCodec } from "./source-cursor.js";
import {
  DurableYouTubeOAuthStore,
  YouTubeOAuthDurableObject,
} from "./youtube-oauth-store.js";

/** @import { Result, WorkerFailure } from "./contracts.js" */

/**
 * @typedef {{
 *   readonly ALLOWED_ORIGIN?: unknown,
 *   readonly ACCESS_ISSUER?: unknown,
 *   readonly ACCESS_AUDIENCE?: unknown,
 *   readonly ACCESS_OWNER_EMAIL?: unknown,
 *   readonly ACCESS_OWNER_ID?: unknown,
 *   readonly TRANSCRIPT_LANGUAGES?: unknown,
 *   readonly YOUTUBE_QUOTA?: unknown,
 *   readonly YOUTUBE_QUOTA_LEDGER?: unknown,
 *   readonly YOUTUBE_SEARCH_DAILY_LIMIT?: unknown,
 *   readonly YOUTUBE_GENERAL_DAILY_LIMIT?: unknown,
 *   readonly YOUTUBE_API_KEY?: unknown,
 *   readonly BRAVE_SEARCH_API_KEY?: unknown,
 *   readonly TADDY_USER_ID?: unknown,
 *   readonly TADDY_API_KEY?: unknown,
 *   readonly YOUTUBE_OAUTH_CLIENT_ID?: unknown,
 *   readonly YOUTUBE_OAUTH_CLIENT_SECRET?: unknown,
 *   readonly YOUTUBE_OAUTH_REDIRECT_URI?: unknown,
 *   readonly YOUTUBE_OAUTH_SCOPES?: unknown,
 *   readonly YOUTUBE_OAUTH_KEY_VERSION?: unknown,
 *   readonly YOUTUBE_OAUTH_ENCRYPTION_KEY?: unknown,
 *   readonly YOUTUBE_OAUTH_STORE?: unknown,
 *   readonly YOUTUBE_OAUTH_LEDGER?: unknown,
 *   readonly TRANSCRIPT_AUTHORIZATION?: unknown,
 *   readonly TRANSCRIPT_AUTHORIZATION_LEDGER?: unknown,
 *   readonly SOURCE_LIBRARY_DB?: unknown,
 *   readonly SOURCE_INGESTION_POLICY_VERSION?: unknown,
 *   readonly SOURCE_CURSOR_SECRET?: unknown,
 *   readonly SOURCE_CONTENT_BUCKET?: unknown,
 *   readonly SOURCE_MANUAL_MAX_BYTES?: unknown,
 *   readonly SOURCE_MANUAL_MAX_CHARACTERS?: unknown,
 *   readonly SOURCE_MANUAL_MEDIA_TYPES?: unknown,
 *   readonly SOURCE_R2_ACCOUNT_SCOPE?: unknown,
 *   readonly SOURCE_R2_STORED_BYTES_LIMIT?: unknown,
 *   readonly SOURCE_R2_CLASS_A_MONTHLY_LIMIT?: unknown,
 *   readonly SOURCE_R2_CLASS_B_MONTHLY_LIMIT?: unknown,
 *   readonly SOURCE_R2_OBSERVATION_MAX_AGE_MS?: unknown,
 *   readonly SOURCE_BROWSER?: unknown,
 *   readonly SOURCE_BROWSER_ACCOUNT_SCOPE?: unknown,
 * }} DiscoveryWorkerEnvironment
 */

/**
 * The binding must implement an atomic reservation against durable storage.
 * A successful response is `{ "used": positiveInteger }`; HTTP 429 means the
 * configured daily ceiling was reached.
 *
 * @typedef {{
 *   readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
 * }} QuotaReservationBinding
 */

/**
 * @typedef {{
 *   readonly idFromName: (name: string) => unknown,
 *   readonly get: (id: unknown) => QuotaReservationBinding,
 * }} QuotaDurableObjectNamespace
 */

/** @typedef {{ readonly used: unknown }} QuotaRow */

/**
 * @typedef {{
 *   readonly exec: (query: string, ...bindings: readonly (string | number)[]) => Iterable<QuotaRow>,
 * }} QuotaSqlStorage
 */

/**
 * @typedef {{
 *   readonly sql: QuotaSqlStorage,
 *   readonly transactionSync: <T>(callback: () => T) => T,
 * }} QuotaDurableObjectStorage
 */

/** @typedef {{ readonly storage: QuotaDurableObjectStorage }} QuotaDurableObjectState */

/**
 * @typedef {{
 *   readonly kind: "DiscoveryDeploymentConfigurationMissing",
 *   readonly field: string,
 * } | {
 *   readonly kind: "DiscoveryDeploymentConfigurationInvalid",
 *   readonly field: string,
 * }} DiscoveryCompositionFailure
 */

/**
 * @typedef {{
 *   readonly fetch: typeof fetch,
 *   readonly now: () => Date,
 *   readonly subtle: SubtleCrypto,
 *   readonly randomBytes?: (length: number) => Uint8Array,
 *   readonly browserLauncher?: { readonly limits: (binding: unknown) => Promise<unknown>, readonly launch: (binding: unknown) => Promise<unknown> },
 * }} CloudflarePlatform
 */

/**
 * @typedef {{ readonly fetch: (request: Request) => Promise<Response> }} DiscoveryWorker
 */

/**
 * SQLite-backed daily quota ledger. One stable Durable Object serializes and
 * commits the OAuth-backed search and general-read reservations atomically.
 */
export class YouTubeQuotaDurableObject {
  /** @type {QuotaDurableObjectStorage} */
  #storage;
  /** @type {{ readonly search: number, readonly general: number }} */
  #limits;

  /**
   * @param {QuotaDurableObjectState} state
   * @param {DiscoveryWorkerEnvironment} environment
   */
  constructor(state, environment) {
    if (
      !isQuotaStorage(state?.storage) ||
      typeof environment.YOUTUBE_SEARCH_DAILY_LIMIT !== "string" ||
      !positiveIntegerText(environment.YOUTUBE_SEARCH_DAILY_LIMIT) ||
      typeof environment.YOUTUBE_GENERAL_DAILY_LIMIT !== "string" ||
      !positiveIntegerText(environment.YOUTUBE_GENERAL_DAILY_LIMIT)
    ) {
      throw new TypeError(
        "YouTube quota Durable Object configuration is invalid.",
      );
    }
    this.#storage = state.storage;
    this.#limits = Object.freeze({
      search: Number(environment.YOUTUBE_SEARCH_DAILY_LIMIT),
      general: Number(environment.YOUTUBE_GENERAL_DAILY_LIMIT),
    });
    this.#storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS daily_quota (quota_day TEXT NOT NULL, bucket TEXT NOT NULL, used INTEGER NOT NULL CHECK (used >= 0), PRIMARY KEY (quota_day, bucket))",
    );
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/reservations") {
      return json({ error: "Not found." }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405, { Allow: "POST" });
    }
    const command = await readQuotaCommand(request, 512);
    if (!command.ok) return command.error;
    const used = this.#storage.transactionSync(() => {
      const rows = [...this.#storage.sql.exec(
        "SELECT used FROM daily_quota WHERE quota_day = ? AND bucket = ?",
        command.value.quotaDay,
        command.value.bucket,
      )];
      if (rows.length > 1) {
        throw new TypeError("Daily quota primary-key invariant is broken.");
      }
      const current = rows.length === 0 ? 0 : rows[0].used;
      if (
        typeof current !== "number" || !Number.isInteger(current) ||
        current < 0
      ) {
        throw new TypeError("Stored daily quota is invalid.");
      }
      const next = current + command.value.units;
      if (next > this.#limits[command.value.bucket]) return null;
      this.#storage.sql.exec(
        "INSERT INTO daily_quota (quota_day, bucket, used) VALUES (?, ?, ?) ON CONFLICT (quota_day, bucket) DO UPDATE SET used = excluded.used",
        command.value.quotaDay,
        command.value.bucket,
        next,
      );
      return next;
    });
    return used === null
      ? json({
        error: command.value.bucket === "search"
          ? "YouTubeSearchQuotaExceeded"
          : "YouTubeGeneralQuotaExceeded",
      }, 429)
      : json({ used }, 200);
  }
}

/**
 * @param {DiscoveryWorkerEnvironment} environment
 * @param {CloudflarePlatform} platform
 * @returns {Result<DiscoveryWorker, DiscoveryCompositionFailure>}
 */
export function createCloudflareDiscoveryWorker(environment, platform) {
  if (
    typeof platform.fetch !== "function" ||
    typeof platform.now !== "function" ||
    typeof platform.subtle?.digest !== "function"
  ) {
    throw new TypeError("Cloudflare platform dependencies are invalid.");
  }
  const configuration = parseEnvironment(environment);
  if (!configuration.ok) return configuration;

  /** @type {(bytes: Uint8Array) => Promise<Result<string, WorkerFailure>>} */
  const digest = async (bytes) => {
    try {
      const value = await platform.subtle.digest("SHA-256", bytes);
      return { ok: true, value: hex(new Uint8Array(value)) };
    } catch (error) {
      if (error instanceof Error) {
        return /** @type {const} */ ({
          ok: false,
          error: { kind: "DiscoveryDigestUnavailable" },
        });
      }
      throw error;
    }
  };
  const authenticator = new CloudflareAccessAuthenticator(
    {
      issuer: configuration.value.accessIssuer,
      audience: configuration.value.accessAudience,
      ownerByEmail: new Map([[
        configuration.value.ownerEmail,
        configuration.value.ownerId,
      ]]),
    },
    {
      nowEpochSeconds: () => Math.floor(platform.now().getTime() / 1_000),
      keyFor: (kid) =>
        accessKeyFor(
          configuration.value.accessIssuer,
          kid,
          platform.fetch,
        ),
      verify: (input) => verifyAccessSignature(input, platform.subtle),
    },
  );
  const rss = new RssAtomAcquisitionAdapter({
    fetch: platform.fetch,
    now: () => platform.now().toISOString(),
    digest,
    policy: {
      maximumBytes: 1_048_576,
      maximumRedirects: 3,
      timeoutMs: 15_000,
    },
  });
  const transcript = new PublisherTranscriptAdapter({
    fetch: platform.fetch,
    validateDestination: (url) => {
      const validated = validatePublisherDestination(url);
      return validated.ok
        ? validated
        : { ok: false, error: { kind: "DestinationRejected" } };
    },
    clock: platform.now,
    digest: async (bytes) => {
      const result = await digest(bytes);
      return result.ok
        ? result
        : { ok: false, error: { kind: "DigestUnavailable" } };
    },
    limits: {
      maximumBytes: 2_097_152,
      maximumRedirects: 3,
      maximumTextCharacters: 250_000,
      maximumExcerptCharacters: 8_000,
      supportedLanguages: configuration.value.transcriptLanguages,
    },
  });
  const authorization = new DurablePublisherTranscriptAuthorization(
    configuration.value.transcriptAuthorization,
  );
  if (
    configuration.value.sourceLibraryDatabase !== null &&
    typeof platform.randomBytes !== "function"
  ) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationInvalid",
        field: "platform.randomBytes",
      },
    };
  }
  const sourceRepository = configuration.value.sourceLibraryDatabase === null
    ? null
    : new D1SourceLibraryRepository(configuration.value.sourceLibraryDatabase);
  const sourceLibrary = sourceRepository === null
    ? null
    : new SourceLibraryService({
      repository: sourceRepository,
      createId: () =>
        hex(
          /** @type {(length: number) => Uint8Array} */ (platform.randomBytes)(
            16,
          ),
        ),
      now: () => platform.now().toISOString(),
      ingestionPolicyVersion: /** @type {string} */ (
        configuration.value.sourceIngestionPolicyVersion
      ),
    });
  const sourceCatalog = sourceRepository === null
    ? null
    : new SourceCatalogQueryService({
      repository: sourceRepository,
      cursorCodec: createSourceCursorCodec(
        /** @type {string} */ (configuration.value.sourceCursorSecret),
        platform.subtle,
      ),
      embedding: {
        create: () =>
          Promise.resolve({
            ok: false,
            error: {
              kind: /** @type {const} */ ("SourceEmbeddingUnavailable"),
            },
          }),
      },
      semanticIndex: {
        search: () =>
          Promise.resolve({
            ok: false,
            error: {
              kind: /** @type {const} */ ("SourceSemanticIndexUnavailable"),
            },
          }),
      },
      maximumPageSize: 50,
      maximumQueryLength: 200,
      fusionVersion: "rrf-v1",
    });
  const manualConfiguration = configuration.value.manualMaterial;
  const manualRepository = sourceRepository === null ||
      manualConfiguration === null
    ? null
    : new D1ManualMaterialRepository(/** @type {import("./source-library-d1.js").D1DatabasePort} */ (configuration.value.sourceLibraryDatabase));
  const manualContentStore = manualConfiguration === null
    ? null
    : new R2SourceContentStore({
      bucket: manualConfiguration.bucket,
      capacityOwnerId: configuration.value.ownerId,
      capacity: new D1R2CapacityLedger({
        database: /** @type {import("./r2-capacity-d1.js").D1DatabasePort} */ (
          /** @type {unknown} */ (configuration.value.sourceLibraryDatabase)
        ),
        now: () => platform.now().toISOString(),
        createId: () => hex(
          /** @type {(length:number)=>Uint8Array} */ (platform.randomBytes)(16),
        ),
        policy: manualConfiguration.capacityPolicy,
      }),
    });
  const manualMaterial = manualRepository === null || manualContentStore === null
    ? null
    : new ManualMaterialService({
      sourceItems: manualRepository,
      repository: manualRepository,
      contentStore: manualContentStore,
      digest: async (bytes) => {
        const result = await digest(bytes);
        return result.ok ? result : { ok: false, error: { kind: /** @type {const} */ ("ManualUploadDigestUnavailable") } };
      },
      createId: () => hex(/** @type {(length: number) => Uint8Array} */ (platform.randomBytes)(16)),
      now: () => platform.now().toISOString(),
      supportedMediaTypes: /** @type {NonNullable<typeof manualConfiguration>} */ (manualConfiguration).mediaTypes,
      maximumBytes: /** @type {NonNullable<typeof manualConfiguration>} */ (manualConfiguration).maximumBytes,
      maximumCharacters: /** @type {NonNullable<typeof manualConfiguration>} */ (manualConfiguration).maximumCharacters,
    });
  const browserConfiguration = configuration.value.browserRun;
  const sourceIngestion = sourceRepository === null || manualContentStore === null ||
      browserConfiguration === null || platform.browserLauncher === undefined
    ? null
    : new SourceIngestionRunner({
      policy: new SourcePolicyEvaluator({
        policy: browserRunSourcePolicy(/** @type {string} */ (configuration.value.sourceIngestionPolicyVersion)),
        now: () => platform.now().toISOString(),
      }),
      repository: new D1SourceIngestionRepository(/** @type {import("./source-ingestion-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (configuration.value.sourceLibraryDatabase))),
      rightsRegistry: new D1SourceRightsRegistry({ database: /** @type {import("./source-rights-registry-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (configuration.value.sourceLibraryDatabase)), now: () => platform.now().toISOString() }),
      capacity: new D1BrowserRunCapacityLedger({
        database: /** @type {import("./browser-run-capacity-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (configuration.value.sourceLibraryDatabase)),
        now: () => platform.now().toISOString(),
        createId: () => hex(/** @type {(length: number) => Uint8Array} */ (platform.randomBytes)(16)),
        policy: browserRunCapacityPolicy(browserConfiguration.accountScope),
      }),
      acquirer: new BrowserRunPageAcquirer({
        launcher: /** @type {import("./browser-run-page-acquirer.js").BrowserLauncher} */ (platform.browserLauncher),
        binding: browserConfiguration.binding,
        resolveAddresses: (hostname) => resolveAddresses(hostname, platform.fetch),
        now: () => platform.now().toISOString(),
        policy: browserRunAcquisitionPolicy(),
      }),
      contentStore: manualContentStore,
      digest: async (bytes) => {
        const result = await digest(bytes);
        return result.ok ? result : { ok: false, error: { kind: /** @type {const} */ ("CrawlDigestUnavailable") } };
      },
      createId: () => hex(/** @type {(length: number) => Uint8Array} */ (platform.randomBytes)(16)),
      now: () => platform.now().toISOString(),
      leaseDurationMs: 300_000,
    });
  const youtubeConfiguration = configuration.value.youtube;
  const youtubeAdapter = youtubeConfiguration.status === "unavailable"
    ? null
    : new YouTubeDiscoveryAdapter(
      { maximumResults: 20, quotaTimeZone: "America/Los_Angeles" },
      {
        fetch: platform.fetch,
        now: platform.now,
        apiKeyForSearch: () => ({ ok: true, value: youtubeConfiguration.apiKey }),
        reserveSearchQuery: ({ quotaDay }) =>
          reserveYouTubeQuota(youtubeConfiguration.quota, "search", quotaDay, 1),
        reserveGeneralRead: ({ quotaDay, units }) =>
          reserveYouTubeQuota(youtubeConfiguration.quota, "general", quotaDay, units),
      },
    );
  const centralSearch = createCentralDiscoverySearch(
    { maximumLimit: 20 },
    {
      policy: createEducationalSearchPolicy({
        version: "educational-v1",
        terms: Object.freeze(["tutorial", "lesson", "course", "educational"]),
        markers: Object.freeze(["learn", "tutorial", "lesson", "course", "educational", "guide", "explained", "how to"]),
        maximumSubmittedCharacters: 120,
        maximumProviderCharacters: 240,
      }),
      providers: Object.freeze([
        createBraveSearchProvider(
          {
            providerId: "web",
            label: "Web",
            resultKind: "web",
            priority: 1,
            enabled: configuration.value.braveApiKey !== null,
            maximumResults: 20,
            apiVersion: "2023-10-11",
          },
          {
            credential: () => configuration.value.braveApiKey === null
              ? { ok: false, error: { kind: /** @type {const} */ ("SearchProviderCredentialMissing") } }
              : { ok: true, value: configuration.value.braveApiKey },
            fetch: platform.fetch,
          },
        ),
        createTaddySearchProvider(
          {
            providerId: "podcasts",
            label: "Podcasts",
            resultKind: "podcast",
            priority: 2,
            enabled: configuration.value.taddy !== null,
            maximumResults: 20,
            timeoutMs: 8_000,
          },
          {
            credentials: () => configuration.value.taddy === null
              ? { ok: false, error: { kind: /** @type {const} */ ("SearchProviderCredentialMissing") } }
              : { ok: true, value: configuration.value.taddy },
            timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
            fetch: platform.fetch,
          },
        ),
        createYouTubeSearchProvider(
          {
            providerId: "youtube",
            label: "YouTube videos",
            resultKind: "video",
            priority: 3,
            enabled: youtubeAdapter !== null,
          },
          {
            adapter: youtubeAdapter ?? {
              search: async () => ({ ok: false, error: { kind: /** @type {const} */ ("YouTubeCredentialMissing") } }),
            },
          },
        ),
      ]),
    },
  );
  const observedCentralSearch = instrumentCentralSearch(
    centralSearch,
    (event) => console.info(JSON.stringify(event)),
  );
  const baseWorker = createDiscoveryWorker(
    {
      allowedOrigin: configuration.value.allowedOrigin,
      maximumCommandBytes: manualConfiguration === null
        ? 32_768
        : manualConfiguration.maximumBytes + 16_384,
    },
    {
      authenticate: (request) => authenticator.authenticate(request),
      acquireRss: async (command, ownerId) => {
        const acquired = await rss.acquire(command);
        if (!acquired.ok || acquired.value.status === "not-modified") {
          return acquired;
        }
        const result = acquired.value;
        const references = result.feed.items.flatMap((
          /** @type {import("./contracts.js").NormalizedFeedItem} */ item,
        ) =>
          item.podcast?.transcripts.map((
            /** @type {{ readonly url: string, readonly type: string, readonly language: string | null }} */ reference,
          ) =>
            Object.freeze({
              url: reference.url,
              type: reference.type,
              language: reference.language,
              itemIdentityKey: item.identityKey,
            })
          ) ?? []
        );
        const recorded = await authorization.recordReferences({
          ownerId,
          sourceRequestId: command.requestId,
          sourceUrl: result.canonicalUrl,
          observedAt: result.retrievedAt,
          references,
        });
        return recorded.ok ? acquired : recorded;
      },
      centralSearch: observedCentralSearch,
      sourceLibrary,
      sourceCatalog,
      sourceIngestion,
      manualMaterial,
    },
  );

  return {
    ok: true,
    value: Object.freeze({
      async fetch(request) {
        const requestUrl = new URL(request.url);
        const pathname = requestUrl.pathname;
        /* Legacy OAuth routes intentionally removed from the deployed graph.
        if (pathname.startsWith("/api/discovery/youtube/oauth/")) {
          return baseWorker.fetch(request);
        }
        */
        /* Historical OAuth implementation retained only until the legacy
         * export/delete migration is verified. It is not compiled as a route.
        if (pathname.startsWith("/api/discovery/youtube/oauth/")) {
          const authenticated = await authenticator.authenticate(request);
          if (!authenticated.ok) {
            return workerFailureResponse(authenticated.error);
          }
          const youtube = configuration.value.youtube;
          const oauth = await oauthService();
          if (youtube.status === "unavailable" || oauth === null) {
            return json({ error: "YouTubeCredentialMissing" }, 503);
          }
          if (pathname.endsWith("/start")) {
            if (request.method !== "POST") {
              return json({ error: "Method not allowed." }, 405, {
                Allow: "POST",
              });
            }
            const origin = request.headers.get("origin");
            if (
              origin !== null && origin !== configuration.value.allowedOrigin
            ) {
              return json({ error: "DiscoveryOriginRejected" }, 403);
            }
            const started = await oauth.start(authenticated.value.ownerId);
            return started.ok
              ? new Response(null, {
                status: 303,
                headers: {
                  location: started.value.authorizationUrl,
                  "cache-control": "no-store",
                },
              })
              : oauthFailureResponse(started.error.kind);
          }
          if (pathname.endsWith("/callback")) {
            if (request.method !== "GET") {
              return json({ error: "Method not allowed." }, 405, {
                Allow: "GET",
              });
            }
            const state = requestUrl.searchParams.get("state");
            const code = requestUrl.searchParams.get("code");
            if (
              state === null || code === null ||
              requestUrl.searchParams.has("error")
            ) {
              return oauthFailureResponse("OAuthInputInvalid");
            }
            const completed = await oauth.complete({
              ownerId: authenticated.value.ownerId,
              state,
              code,
            });
            return completed.ok
              ? new Response(null, {
                status: 303,
                headers: {
                  location:
                    `${configuration.value.allowedOrigin}/?youtube=connected#discover`,
                  "cache-control": "no-store",
                },
              })
              : oauthFailureResponse(completed.error.kind);
          }
          if (pathname.endsWith("/connection")) {
            if (request.method !== "GET") {
              return json({ error: "Method not allowed." }, 405, {
                Allow: "GET",
              });
            }
            const connection = await oauth.getConnection(
              authenticated.value.ownerId,
            );
            return connection.ok
              ? json({ connection: connection.value }, 200)
              : oauthFailureResponse(connection.error.kind);
          }
          if (pathname.endsWith("/disconnect")) {
            if (request.method !== "POST") {
              return json({ error: "Method not allowed." }, 405, {
                Allow: "POST",
              });
            }
            const origin = request.headers.get("origin");
            if (
              origin !== null && origin !== configuration.value.allowedOrigin
            ) return json({ error: "DiscoveryOriginRejected" }, 403);
            const revoked = await oauth.revoke(authenticated.value.ownerId);
            return revoked.ok
              ? json({ connection: revoked.value }, 200)
              : oauthFailureResponse(revoked.error.kind);
          }
          return json({ error: "Not found." }, 404);
        }
        */
        if (
          pathname !== "/api/discovery/publisher-transcript" &&
          pathname !== "/api/discovery/publisher-transcript/authorize"
        ) {
          return baseWorker.fetch(request);
        }
        const authenticated = await authenticator.authenticate(request);
        if (!authenticated.ok) {
          return workerFailureResponse(authenticated.error);
        }
        const command = await readTranscriptCommand(
          request,
          configuration.value.allowedOrigin,
          32_768,
        );
        if (!command.ok) return command.error;
        if (pathname.endsWith("/authorize")) {
          const authorizationCommand = validateAuthorizationRequest(
            command.value,
            authenticated.value.ownerId,
          );
          if (!authorizationCommand.ok) return authorizationCommand.error;
          const persisted = await authorization.authorize(
            authorizationCommand.value,
          );
          return persisted.ok
            ? json({ ownerId: authenticated.value.ownerId, stored: true }, 201)
            : authorizationFailureResponse(persisted.error.kind);
        }
        const lookup = validateTranscriptRetrievalRequest(command.value);
        if (!lookup.ok) return lookup.error;
        const resolved = await authorization.resolve(
          authenticated.value.ownerId,
          {
            evidenceId: lookup.value.evidenceId,
            transcriptUrl: lookup.value.transcriptUrl,
          },
        );
        if (!resolved.ok) {
          return authorizationFailureResponse(resolved.error.kind);
        }
        if (resolved.value.access !== "allowed") {
          return authorizationFailureResponse(
            "TranscriptAuthorizationAccessNotPermitted",
          );
        }
        const retrieved = await transcript.retrieve({
          requestId: lookup.value.requestId,
          transcriptUrl: lookup.value.transcriptUrl,
          language: lookup.value.language,
          rights: resolved.value,
          jsonTextPath: lookup.value.jsonTextPath,
          retention: lookup.value.retention,
        });
        return retrieved.ok
          ? json({
            ownerId: authenticated.value.ownerId,
            result: retrieved.value,
          }, 200)
          : transcriptFailureResponse(retrieved.error.kind);
      },
    }),
  };
}

/**
 * @param {DiscoveryWorkerEnvironment} environment
 * @returns {Result<{
 *   readonly allowedOrigin: string,
 *   readonly accessIssuer: string,
 *   readonly accessAudience: string,
 *   readonly ownerEmail: string,
 *   readonly ownerId: string,
 *   readonly transcriptLanguages: ReadonlySet<string>,
 *   readonly youtube: { readonly status: "unavailable" } | {
 *     readonly status: "configured",
 *     readonly apiKey: string,
 *     readonly quota: QuotaReservationBinding,
 *   },
 *   readonly braveApiKey: string | null,
 *   readonly taddy: { readonly userId: string, readonly apiKey: string } | null,
 *   readonly transcriptAuthorization: QuotaReservationBinding,
 *   readonly sourceLibraryDatabase: import("./source-library-d1.js").D1DatabasePort | null,
 *   readonly sourceIngestionPolicyVersion: string | null,
 *   readonly sourceCursorSecret: string | null,
 *   readonly manualMaterial: null | { readonly bucket: import("./source-content-r2.js").R2BucketPort, readonly maximumBytes: number, readonly maximumCharacters: number, readonly mediaTypes: ReadonlySet<string>, readonly capacityPolicy: {readonly accountScope:string,readonly storedBytesLimit:number,readonly classAMonthlyLimit:number,readonly classBMonthlyLimit:number,readonly observationMaximumAgeMs:number} },
 *   readonly browserRun: null | { readonly binding: object | Function, readonly accountScope: string },
 * }, DiscoveryCompositionFailure>}
 */
function parseEnvironment(environment) {
  const required = /** @type {const} */ ([
    "ALLOWED_ORIGIN",
    "ACCESS_ISSUER",
    "ACCESS_AUDIENCE",
    "ACCESS_OWNER_EMAIL",
    "ACCESS_OWNER_ID",
    "TRANSCRIPT_LANGUAGES",
  ]);
  for (const field of required) {
    if (environment[field] === undefined) {
      return {
        ok: false,
        error: { kind: "DiscoveryDeploymentConfigurationMissing", field },
      };
    }
    if (
      typeof environment[field] !== "string" || environment[field].trim() === ""
    ) {
      return {
        ok: false,
        error: { kind: "DiscoveryDeploymentConfigurationInvalid", field },
      };
    }
  }
  const transcriptAuthorization = resolveTranscriptAuthorizationBinding(
    environment,
  );
  if (!transcriptAuthorization.ok) return transcriptAuthorization;
  if (
    environment.SOURCE_LIBRARY_DB !== undefined &&
    !isD1Database(environment.SOURCE_LIBRARY_DB)
  ) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationInvalid",
        field: "SOURCE_LIBRARY_DB",
      },
    };
  }
  const manualMaterial = resolveManualMaterialConfiguration(environment);
  if (!manualMaterial.ok) return manualMaterial;
  const browserRun = resolveBrowserRunConfiguration(environment);
  if (!browserRun.ok) return browserRun;
  const braveApiKey = optionalSecret(environment.BRAVE_SEARCH_API_KEY);
  if (!braveApiKey.ok) {
    return { ok: false, error: { kind: "DiscoveryDeploymentConfigurationInvalid", field: "BRAVE_SEARCH_API_KEY" } };
  }
  const taddy = taddyCredentials(
    environment.TADDY_USER_ID,
    environment.TADDY_API_KEY,
  );
  if (!taddy.ok) {
    return { ok: false, error: { kind: "DiscoveryDeploymentConfigurationInvalid", field: taddy.error.field } };
  }
  if (
    environment.SOURCE_LIBRARY_DB !== undefined &&
    (typeof environment.SOURCE_CURSOR_SECRET !== "string" ||
      environment.SOURCE_CURSOR_SECRET.length < 32)
  ) {
    return {
      ok: false,
      error: {
        kind: environment.SOURCE_CURSOR_SECRET === undefined
          ? "DiscoveryDeploymentConfigurationMissing"
          : "DiscoveryDeploymentConfigurationInvalid",
        field: "SOURCE_CURSOR_SECRET",
      },
    };
  }
  if (
    environment.SOURCE_LIBRARY_DB !== undefined &&
    (typeof environment.SOURCE_INGESTION_POLICY_VERSION !== "string" ||
      environment.SOURCE_INGESTION_POLICY_VERSION.trim() === "")
  ) {
    return {
      ok: false,
      error: {
        kind: environment.SOURCE_INGESTION_POLICY_VERSION === undefined
          ? "DiscoveryDeploymentConfigurationMissing"
          : "DiscoveryDeploymentConfigurationInvalid",
        field: "SOURCE_INGESTION_POLICY_VERSION",
      },
    };
  }
  const allowedOrigin = /** @type {string} */ (environment.ALLOWED_ORIGIN);
  const accessIssuer = /** @type {string} */ (environment.ACCESS_ISSUER);
  if (!isOrigin(allowedOrigin)) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationInvalid",
        field: "ALLOWED_ORIGIN",
      },
    };
  }
  if (!isOrigin(accessIssuer)) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationInvalid",
        field: "ACCESS_ISSUER",
      },
    };
  }
  const transcriptLanguages = new Set(
    /** @type {string} */ (environment.TRANSCRIPT_LANGUAGES)
      .split(",").map((language) => language.trim()).filter((language) =>
        language !== ""
      ),
  );
  if (transcriptLanguages.size === 0) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationInvalid",
        field: "TRANSCRIPT_LANGUAGES",
      },
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      allowedOrigin,
      accessIssuer,
      accessAudience: /** @type {string} */ (environment.ACCESS_AUDIENCE),
      ownerEmail: /** @type {string} */ (environment.ACCESS_OWNER_EMAIL),
      ownerId: /** @type {string} */ (environment.ACCESS_OWNER_ID),
      transcriptLanguages,
      youtube: resolveYoutubeConfiguration(environment),
      braveApiKey: braveApiKey.value,
      taddy: taddy.value,
      transcriptAuthorization: transcriptAuthorization.value,
      sourceLibraryDatabase: environment.SOURCE_LIBRARY_DB === undefined
        ? null
        : environment.SOURCE_LIBRARY_DB,
      sourceIngestionPolicyVersion:
        typeof environment.SOURCE_INGESTION_POLICY_VERSION === "string"
          ? environment.SOURCE_INGESTION_POLICY_VERSION.trim()
          : null,
      sourceCursorSecret: typeof environment.SOURCE_CURSOR_SECRET === "string"
        ? environment.SOURCE_CURSOR_SECRET
        : null,
      manualMaterial: manualMaterial.value,
      browserRun: browserRun.value,
    }),
  };
}

/** @param {unknown} value @returns {Result<string|null,{readonly kind:"SecretInvalid"}>} */
function optionalSecret(value) {
  if (value === undefined) return { ok: true, value: null };
  return typeof value === "string" && value.trim() !== ""
    ? { ok: true, value }
    : { ok: false, error: { kind: "SecretInvalid" } };
}

/** @param {unknown} userId @param {unknown} apiKey @returns {Result<{readonly userId:string,readonly apiKey:string}|null,{readonly kind:"SecretPairInvalid",readonly field:string}>} */
function taddyCredentials(userId, apiKey) {
  if (userId === undefined && apiKey === undefined) return { ok: true, value: null };
  if (typeof userId !== "string" || userId.trim() === "") {
    return { ok: false, error: { kind: "SecretPairInvalid", field: "TADDY_USER_ID" } };
  }
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return { ok: false, error: { kind: "SecretPairInvalid", field: "TADDY_API_KEY" } };
  }
  return { ok: true, value: Object.freeze({ userId, apiKey }) };
}

/** @param {DiscoveryWorkerEnvironment} environment @returns {Result<null | { readonly binding: object | Function, readonly accountScope: string }, DiscoveryCompositionFailure>} */
function resolveBrowserRunConfiguration(environment) {
  if (environment.SOURCE_BROWSER === undefined) return { ok: true, value: null };
  if ((typeof environment.SOURCE_BROWSER !== "object" && typeof environment.SOURCE_BROWSER !== "function") || environment.SOURCE_BROWSER === null) {
    return { ok: false, error: { kind: "DiscoveryDeploymentConfigurationInvalid", field: "SOURCE_BROWSER" } };
  }
  if (environment.SOURCE_LIBRARY_DB === undefined) return { ok: false, error: { kind: "DiscoveryDeploymentConfigurationMissing", field: "SOURCE_LIBRARY_DB" } };
  if (environment.SOURCE_CONTENT_BUCKET === undefined) return { ok: false, error: { kind: "DiscoveryDeploymentConfigurationMissing", field: "SOURCE_CONTENT_BUCKET" } };
  if (typeof environment.SOURCE_BROWSER_ACCOUNT_SCOPE !== "string" || environment.SOURCE_BROWSER_ACCOUNT_SCOPE.trim() === "") {
    return { ok: false, error: { kind: environment.SOURCE_BROWSER_ACCOUNT_SCOPE === undefined ? "DiscoveryDeploymentConfigurationMissing" : "DiscoveryDeploymentConfigurationInvalid", field: "SOURCE_BROWSER_ACCOUNT_SCOPE" } };
  }
  return { ok: true, value: Object.freeze({ binding: environment.SOURCE_BROWSER, accountScope: environment.SOURCE_BROWSER_ACCOUNT_SCOPE.trim() }) };
}

/** Approved Sequence 3 Option B Free-plan limits, injected at the composition boundary. @param {string} version */
function browserRunSourcePolicy(version) {
  return Object.freeze({ version, initialDepth: 2, maximumDepth: 5, maximumPages: 5, maximumDecodedBytes: 1_000_000, maximumConcurrency: 1, maximumDurationMs: 60_000, maximumRedirects: 3, refreshIntervalMs: 604_800_000 });
}

/** Approved Sequence 3 account-level Browser Run reservation policy. @param {string} accountScope */
function browserRunCapacityPolicy(accountScope) {
  return Object.freeze({ accountScope, dailyLimitMilliseconds: 600_000, maximumConcurrentSessions: 1, minimumLaunchIntervalMilliseconds: 20_000, reservationMilliseconds: 60_000 });
}

/** Approved bounded DOM-extraction policy. */
function browserRunAcquisitionPolicy() {
  return Object.freeze({ maximumPagesPerRun: 5, maximumRunMilliseconds: 60_000, navigationTimeoutMilliseconds: 15_000, maximumHtmlBytes: 1_000_000, maximumTextCharacters: 250_000, maximumLinksPerPage: 100, maximumFrontierEntries: 500 });
}

/** @param {string} hostname @param {typeof fetch} fetchDependency @returns {Promise<import("../src/features/source-library/ingestion-contracts.js").Result<readonly string[], import("../src/features/source-library/ingestion-contracts.js").SourceIngestionFailure>>} */
async function resolveAddresses(hostname, fetchDependency) {
  if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(hostname)) return { ok: false, error: { kind: "CrawlDestinationRejected", reason: "hostname" } };
  try {
    const responses = await Promise.all(["A", "AAAA"].map((type) => fetchDependency(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, { headers: { accept: "application/dns-json" } })));
    const addresses = [];
    for (const response of responses) {
      if (!response.ok) return { ok: false, error: { kind: "CrawlFetchUnavailable" } };
      const document = /** @type {unknown} */ (await response.json());
      if (!isRecord(document) || (document.Status !== 0 && document.Status !== 3) || (document.Answer !== undefined && !Array.isArray(document.Answer))) return { ok: false, error: { kind: "CrawlFetchUnavailable" } };
      for (const answer of Array.isArray(document.Answer) ? document.Answer : []) {
        if (isRecord(answer) && (answer.type === 1 || answer.type === 28) && typeof answer.data === "string") addresses.push(answer.data);
      }
    }
    return { ok: true, value: Object.freeze(addresses) };
  } catch (error) {
    if (error instanceof Error) return { ok: false, error: { kind: "CrawlFetchUnavailable" } };
    throw error;
  }
}

/** @param {DiscoveryWorkerEnvironment} environment @returns {Result<null | { readonly bucket: import("./source-content-r2.js").R2BucketPort, readonly maximumBytes: number, readonly maximumCharacters: number, readonly mediaTypes: ReadonlySet<string>, readonly capacityPolicy: {readonly accountScope:string,readonly storedBytesLimit:number,readonly classAMonthlyLimit:number,readonly classBMonthlyLimit:number,readonly observationMaximumAgeMs:number} }, DiscoveryCompositionFailure>} */
function resolveManualMaterialConfiguration(environment) {
  if (environment.SOURCE_CONTENT_BUCKET === undefined) return { ok: true, value: null };
  if (!isR2Bucket(environment.SOURCE_CONTENT_BUCKET)) return { ok: false, error: { kind: "DiscoveryDeploymentConfigurationInvalid", field: "SOURCE_CONTENT_BUCKET" } };
  if (environment.SOURCE_LIBRARY_DB === undefined) return { ok: false, error: { kind: "DiscoveryDeploymentConfigurationMissing", field: "SOURCE_LIBRARY_DB" } };
  const bytes = typeof environment.SOURCE_MANUAL_MAX_BYTES === "string" && positiveIntegerText(environment.SOURCE_MANUAL_MAX_BYTES) ? Number(environment.SOURCE_MANUAL_MAX_BYTES) : null;
  const characters = typeof environment.SOURCE_MANUAL_MAX_CHARACTERS === "string" && positiveIntegerText(environment.SOURCE_MANUAL_MAX_CHARACTERS) ? Number(environment.SOURCE_MANUAL_MAX_CHARACTERS) : null;
  const mediaTypes = typeof environment.SOURCE_MANUAL_MEDIA_TYPES === "string" ? new Set(environment.SOURCE_MANUAL_MEDIA_TYPES.split(",").map((value) => value.trim().toLowerCase()).filter((value) => value.startsWith("text/"))) : new Set();
  const capacityFields = /** @type {const} */ ([
    "SOURCE_R2_ACCOUNT_SCOPE",
    "SOURCE_R2_STORED_BYTES_LIMIT",
    "SOURCE_R2_CLASS_A_MONTHLY_LIMIT",
    "SOURCE_R2_CLASS_B_MONTHLY_LIMIT",
    "SOURCE_R2_OBSERVATION_MAX_AGE_MS",
  ]);
  const invalidCapacity = capacityFields.find((field) =>
    typeof environment[field] !== "string" ||
    environment[field].trim() === "" ||
    (field !== "SOURCE_R2_ACCOUNT_SCOPE" &&
      !positiveIntegerText(environment[field]))
  );
  if (bytes === null || characters === null || mediaTypes.size === 0 || invalidCapacity !== undefined) {
    const field = bytes === null ? "SOURCE_MANUAL_MAX_BYTES" : characters === null ? "SOURCE_MANUAL_MAX_CHARACTERS" : mediaTypes.size === 0 ? "SOURCE_MANUAL_MEDIA_TYPES" : /** @type {NonNullable<typeof invalidCapacity>} */ (invalidCapacity);
    return { ok: false, error: { kind: environment[field] === undefined ? "DiscoveryDeploymentConfigurationMissing" : "DiscoveryDeploymentConfigurationInvalid", field } };
  }
  return { ok: true, value: Object.freeze({
    bucket: environment.SOURCE_CONTENT_BUCKET,
    maximumBytes: bytes,
    maximumCharacters: characters,
    mediaTypes,
    capacityPolicy: Object.freeze({
      accountScope: /** @type {string} */ (environment.SOURCE_R2_ACCOUNT_SCOPE).trim(),
      storedBytesLimit: Number(environment.SOURCE_R2_STORED_BYTES_LIMIT),
      classAMonthlyLimit: Number(environment.SOURCE_R2_CLASS_A_MONTHLY_LIMIT),
      classBMonthlyLimit: Number(environment.SOURCE_R2_CLASS_B_MONTHLY_LIMIT),
      observationMaximumAgeMs: Number(environment.SOURCE_R2_OBSERVATION_MAX_AGE_MS),
    }),
  }) };
}

/**
 * Tests and non-Cloudflare compositions may inject a fetch-shaped quota port.
 * Production resolves one stable SQLite Durable Object for both quota buckets.
 *
 * @param {DiscoveryWorkerEnvironment} environment
 * @returns {Result<QuotaReservationBinding, DiscoveryCompositionFailure>}
 */
function resolveQuotaBinding(environment) {
  if (environment.YOUTUBE_QUOTA !== undefined) {
    return isQuotaBinding(environment.YOUTUBE_QUOTA)
      ? { ok: true, value: environment.YOUTUBE_QUOTA }
      : {
        ok: false,
        error: {
          kind: "DiscoveryDeploymentConfigurationInvalid",
          field: "YOUTUBE_QUOTA",
        },
      };
  }
  if (environment.YOUTUBE_QUOTA_LEDGER === undefined) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationMissing",
        field: "YOUTUBE_QUOTA_LEDGER",
      },
    };
  }
  if (!isQuotaNamespace(environment.YOUTUBE_QUOTA_LEDGER)) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationInvalid",
        field: "YOUTUBE_QUOTA_LEDGER",
      },
    };
  }
  try {
    const id = environment.YOUTUBE_QUOTA_LEDGER.idFromName(
      "youtube-api-daily-quota",
    );
    const stub = environment.YOUTUBE_QUOTA_LEDGER.get(id);
    return isQuotaBinding(stub) ? { ok: true, value: stub } : {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationInvalid",
        field: "YOUTUBE_QUOTA_LEDGER",
      },
    };
  } catch (error) {
    if (error instanceof Error) {
      return {
        ok: false,
        error: {
          kind: "DiscoveryDeploymentConfigurationInvalid",
          field: "YOUTUBE_QUOTA_LEDGER",
        },
      };
    }
    throw error;
  }
}

/** @param {DiscoveryWorkerEnvironment} environment */
function resolveYoutubeConfiguration(environment) {
  const fields = /** @type {const} */ ([
    "YOUTUBE_SEARCH_DAILY_LIMIT",
    "YOUTUBE_GENERAL_DAILY_LIMIT",
    "YOUTUBE_API_KEY",
  ]);
  if (
    fields.some((field) =>
      typeof environment[field] !== "string" || environment[field].trim() === ""
    )
  ) {
    return /** @type {const} */ ({ status: "unavailable" });
  }
  const searchLimit =
    /** @type {string} */ (environment.YOUTUBE_SEARCH_DAILY_LIMIT);
  const generalLimit =
    /** @type {string} */ (environment.YOUTUBE_GENERAL_DAILY_LIMIT);
  const quota = resolveQuotaBinding(environment);
  if (
    !positiveIntegerText(searchLimit) || !positiveIntegerText(generalLimit) ||
    !quota.ok
  ) {
    return /** @type {const} */ ({ status: "unavailable" });
  }
  return Object.freeze({
    status: /** @type {const} */ ("configured"),
    apiKey: /** @type {string} */ (environment.YOUTUBE_API_KEY),
    quota: quota.value,
  });
}

/** @param {DiscoveryWorkerEnvironment} environment @returns {Result<QuotaReservationBinding, DiscoveryCompositionFailure>} */
function resolveOAuthStoreBinding(environment) {
  if (environment.YOUTUBE_OAUTH_STORE !== undefined) {
    return isQuotaBinding(environment.YOUTUBE_OAUTH_STORE)
      ? { ok: true, value: environment.YOUTUBE_OAUTH_STORE }
      : {
        ok: false,
        error: {
          kind: "DiscoveryDeploymentConfigurationInvalid",
          field: "YOUTUBE_OAUTH_STORE",
        },
      };
  }
  if (!isQuotaNamespace(environment.YOUTUBE_OAUTH_LEDGER)) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationMissing",
        field: "YOUTUBE_OAUTH_LEDGER",
      },
    };
  }
  try {
    const id = environment.YOUTUBE_OAUTH_LEDGER.idFromName(
      "youtube-oauth-owner-connections",
    );
    const stub = environment.YOUTUBE_OAUTH_LEDGER.get(id);
    return isQuotaBinding(stub) ? { ok: true, value: stub } : {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationInvalid",
        field: "YOUTUBE_OAUTH_LEDGER",
      },
    };
  } catch (error) {
    if (error instanceof Error) {
      return {
        ok: false,
        error: {
          kind: "DiscoveryDeploymentConfigurationInvalid",
          field: "YOUTUBE_OAUTH_LEDGER",
        },
      };
    }
    throw error;
  }
}

/**
 * @param {DiscoveryWorkerEnvironment} environment
 * @returns {Result<QuotaReservationBinding, DiscoveryCompositionFailure>}
 */
function resolveTranscriptAuthorizationBinding(environment) {
  if (environment.TRANSCRIPT_AUTHORIZATION !== undefined) {
    return isQuotaBinding(environment.TRANSCRIPT_AUTHORIZATION)
      ? { ok: true, value: environment.TRANSCRIPT_AUTHORIZATION }
      : {
        ok: false,
        error: {
          kind: "DiscoveryDeploymentConfigurationInvalid",
          field: "TRANSCRIPT_AUTHORIZATION",
        },
      };
  }
  if (environment.TRANSCRIPT_AUTHORIZATION_LEDGER === undefined) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationMissing",
        field: "TRANSCRIPT_AUTHORIZATION_LEDGER",
      },
    };
  }
  if (!isQuotaNamespace(environment.TRANSCRIPT_AUTHORIZATION_LEDGER)) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationInvalid",
        field: "TRANSCRIPT_AUTHORIZATION_LEDGER",
      },
    };
  }
  try {
    const id = environment.TRANSCRIPT_AUTHORIZATION_LEDGER.idFromName(
      "publisher-transcript-rights",
    );
    const stub = environment.TRANSCRIPT_AUTHORIZATION_LEDGER.get(id);
    return isQuotaBinding(stub) ? { ok: true, value: stub } : {
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationInvalid",
        field: "TRANSCRIPT_AUTHORIZATION_LEDGER",
      },
    };
  } catch (error) {
    if (error instanceof Error) {
      return {
        ok: false,
        error: {
          kind: "DiscoveryDeploymentConfigurationInvalid",
          field: "TRANSCRIPT_AUTHORIZATION_LEDGER",
        },
      };
    }
    throw error;
  }
}

/**
 * @param {Request} request
 * @param {number} maximumBytes
 * @returns {Promise<Result<{ readonly bucket: "search" | "general", readonly quotaDay: string, readonly units: number }, Response>>}
 */
async function readQuotaCommand(request, maximumBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return {
      ok: false,
      error: json({ error: "QuotaCommandTooLarge" }, 413),
    };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    return {
      ok: false,
      error: json({ error: "QuotaCommandTooLarge" }, 413),
    };
  }
  /** @type {unknown} */
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        error: json({ error: "QuotaCommandInvalid", field: "body" }, 400),
      };
    }
    throw error;
  }
  if (
    !isRecord(document) ||
    Object.keys(document).sort().join(",") !== "bucket,quotaDay,units"
  ) {
    return {
      ok: false,
      error: json({ error: "QuotaCommandInvalid", field: "body" }, 400),
    };
  }
  if (document.bucket !== "search" && document.bucket !== "general") {
    return {
      ok: false,
      error: json({ error: "QuotaCommandInvalid", field: "bucket" }, 400),
    };
  }
  if (
    typeof document.quotaDay !== "string" || !validUtcDay(document.quotaDay)
  ) {
    return {
      ok: false,
      error: json({ error: "QuotaCommandInvalid", field: "quotaDay" }, 400),
    };
  }
  if (
    typeof document.units !== "number" ||
    !Number.isSafeInteger(document.units) ||
    document.units < 1
  ) {
    return {
      ok: false,
      error: json({ error: "QuotaCommandInvalid", field: "units" }, 400),
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      bucket: document.bucket,
      quotaDay: document.quotaDay,
      units: document.units,
    }),
  };
}

/**
 * @param {QuotaReservationBinding} binding
 * @param {"search" | "general"} bucket
 * @param {string} quotaDay
 * @param {number} units
 * @returns {Promise<Result<number, WorkerFailure>>}
 */
async function reserveYouTubeQuota(binding, bucket, quotaDay, units) {
  /** @type {Response} */
  let response;
  try {
    response = await binding.fetch(
      "https://youtube-quota.internal/reservations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bucket, quotaDay, units }),
      },
    );
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, error: { kind: "DiscoveryFetchUnavailable" } };
    }
    throw error;
  }
  if (response.status === 429) {
    return {
      ok: false,
      error: {
        kind: bucket === "search"
          ? "YouTubeSearchQuotaExceeded"
          : "YouTubeGeneralQuotaExceeded",
      },
    };
  }
  if (!response.ok) {
    return { ok: false, error: { kind: "DiscoveryFetchUnavailable" } };
  }
  /** @type {unknown} */
  let document;
  try {
    document = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, error: { kind: "YouTubeResponseInvalid" } };
    }
    throw error;
  }
  if (
    !isRecord(document) || typeof document.used !== "number" ||
    !Number.isInteger(document.used) || document.used < 1
  ) {
    return { ok: false, error: { kind: "YouTubeResponseInvalid" } };
  }
  return { ok: true, value: document.used };
}

/**
 * @param {{ readonly status: "unavailable" } | { readonly status: "configured", readonly clientId: string, readonly clientSecret: string, readonly redirectUri: string, readonly scopes: readonly string[], readonly keyVersion: string, readonly encryptionKey: string, readonly oauthStore: QuotaReservationBinding }} configuration
 * @param {CloudflarePlatform} platform
 */
async function createOAuthService(configuration, platform) {
  if (
    configuration.status === "unavailable" ||
    typeof platform.randomBytes !== "function"
  ) return null;
  const bytes = decodeBase64Url(configuration.encryptionKey);
  if (bytes === null || bytes.byteLength !== 32) return null;
  try {
    const key = await platform.subtle.importKey(
      "raw",
      bytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    const store = new DurableYouTubeOAuthStore(configuration.oauthStore);
    return new YouTubeOAuthService({
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      revocationEndpoint: "https://oauth2.googleapis.com/revoke",
      issuer: "https://accounts.google.com",
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      redirectUri: configuration.redirectUri,
      requestedScopes: configuration.scopes,
      transactionTtlMs: 10 * 60_000,
      keyVersion: configuration.keyVersion,
      encryptionKeys: new Map([[configuration.keyVersion, key]]),
    }, {
      fetch: platform.fetch,
      now: platform.now,
      subtle: platform.subtle,
      randomBytes: platform.randomBytes,
      transactions: store.transactions,
      connections: store.connections,
      verifyIdToken: (input) =>
        verifyGoogleIdToken(input, platform.fetch, platform.subtle),
    });
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

/**
 * Verify Google's signed ID token locally so no token enters an outbound URL.
 * @param {{ readonly token: string, readonly expectedIssuer: string, readonly expectedAudience: string, readonly now: Date }} input
 * @param {typeof fetch} fetchClient
 * @param {SubtleCrypto} subtle
 */
async function verifyGoogleIdToken(input, fetchClient, subtle) {
  try {
    const segments = input.token.split(".");
    if (segments.length !== 3) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthIdTokenVerificationFailed" },
      });
    }
    const header = parseBase64UrlJson(segments[0]);
    const claims = parseBase64UrlJson(segments[1]);
    if (
      !isRecord(header) || header.alg !== "RS256" ||
      typeof header.kid !== "string" || !isRecord(claims)
    ) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthIdTokenVerificationFailed" },
      });
    }
    const response = await fetchClient(
      "https://www.googleapis.com/oauth2/v3/certs",
      {
        headers: { accept: "application/json" },
      },
    );
    const keySet = response.ok
      ? /** @type {unknown} */ (await response.json())
      : null;
    const jwk = isRecord(keySet) && Array.isArray(keySet.keys)
      ? keySet.keys.find((key) => isRecord(key) && key.kid === header.kid)
      : undefined;
    if (!isRecord(jwk)) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthIdTokenVerificationFailed" },
      });
    }
    const verificationKey = await subtle.importKey(
      "jwk",
      /** @type {JsonWebKey} */ (jwk),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signature = decodeBase64Url(segments[2]);
    const verified = signature !== null && await subtle.verify(
      "RSASSA-PKCS1-v1_5",
      verificationKey,
      signature,
      new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
    );
    if (
      !verified ||
      !(claims.iss === input.expectedIssuer ||
        (input.expectedIssuer === "https://accounts.google.com" &&
          claims.iss === "accounts.google.com")) ||
      claims.aud !== input.expectedAudience ||
      typeof claims.exp !== "number" ||
      claims.exp <= Math.floor(input.now.getTime() / 1_000) ||
      typeof claims.sub !== "string" || claims.sub === "" ||
      typeof claims.email !== "string" || claims.email === "" ||
      claims.email_verified !== true || typeof claims.nonce !== "string" ||
      claims.nonce === ""
    ) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthIdTokenVerificationFailed" },
      });
    }
    return /** @type {const} */ ({
      ok: true,
      value: Object.freeze({
        subject: claims.sub,
        email: claims.email,
        emailVerified: true,
        nonce: claims.nonce,
      }),
    });
  } catch (error) {
    if (error instanceof Error) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthIdTokenVerificationFailed" },
      });
    }
    throw error;
  }
}

/** @param {string} value */
function parseBase64UrlJson(value) {
  const bytes = decodeBase64Url(value);
  if (bytes === null) return null;
  try {
    return /** @type {unknown} */ (JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ));
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

/** @param {string} kind */
function oauthFailureResponse(kind) {
  const status = kind === "OAuthConnectionMissing"
    ? 404
    : kind === "OAuthTransactionOwnerMismatch" ||
        kind === "OAuthIdTokenNonceMismatch"
    ? 403
    : kind === "OAuthTransactionMissing" ||
        kind === "OAuthTransactionExpired" || kind === "OAuthConnectionRevoked"
    ? 409
    : kind.endsWith("Unavailable") || kind.endsWith("PersistenceFailed")
    ? 503
    : kind === "OAuthTokenExchangeRejected" ||
        kind === "OAuthProviderRevocationFailed"
    ? 502
    : 400;
  return json({ error: kind }, status);
}

/** @param {string} value */
function validEncryptionKeyText(value) {
  const bytes = decodeBase64Url(value);
  return bytes !== null && bytes.byteLength === 32;
}

/** @param {string} value */
function decodeBase64Url(value) {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(
      normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
    );
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

/**
 * @param {string} issuer
 * @param {string} kid
 * @param {typeof fetch} fetchClient
 * @returns {Promise<Result<JsonWebKey, WorkerFailure>>}
 */
async function accessKeyFor(issuer, kid, fetchClient) {
  /** @type {Response} */
  let response;
  try {
    response = await fetchClient(new URL("/cdn-cgi/access/certs", issuer), {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, error: { kind: "DiscoveryFetchUnavailable" } };
    }
    throw error;
  }
  if (!response.ok) {
    return { ok: false, error: { kind: "DiscoveryFetchUnavailable" } };
  }
  /** @type {unknown} */
  let document;
  try {
    document = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, error: { kind: "DiscoveryAccessTokenInvalid" } };
    }
    throw error;
  }
  if (!isRecord(document) || !Array.isArray(document.keys)) {
    return { ok: false, error: { kind: "DiscoveryAccessTokenInvalid" } };
  }
  for (const key of document.keys) {
    if (isRecord(key) && key.kid === kid) {
      return { ok: true, value: /** @type {JsonWebKey} */ (key) };
    }
  }
  return { ok: false, error: { kind: "DiscoveryAccessTokenInvalid" } };
}

/**
 * @param {{ readonly key: JsonWebKey, readonly signingInput: Uint8Array, readonly signature: Uint8Array }} input
 * @param {SubtleCrypto} subtle
 */
async function verifyAccessSignature(input, subtle) {
  try {
    const key = await subtle.importKey(
      "jwk",
      input.key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      input.signature,
      input.signingInput,
    );
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

/**
 * @param {Request} request
 * @param {string} allowedOrigin
 * @param {number} maximumBytes
 * @returns {Promise<Result<unknown, Response>>}
 */
async function readTranscriptCommand(request, allowedOrigin, maximumBytes) {
  if (request.method !== "POST") {
    return {
      ok: false,
      error: json({ error: "Method not allowed." }, 405, { Allow: "POST" }),
    };
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== allowedOrigin) {
    return {
      ok: false,
      error: json({ error: "DiscoveryOriginRejected" }, 403),
    };
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return {
      ok: false,
      error: json({ error: "DiscoveryRequestTooLarge" }, 413),
    };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    return {
      ok: false,
      error: json({ error: "DiscoveryRequestTooLarge" }, 413),
    };
  }
  try {
    return { ok: true, value: /** @type {unknown} */ (JSON.parse(text)) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        error: json({ error: "PodcastTranscriptCommandInvalid" }, 400),
      };
    }
    throw error;
  }
}

/** @param {unknown} value @param {string} ownerId @returns {Result<{ readonly ownerId: string, readonly evidenceId: string, readonly transcriptUrl: string, readonly access: "allowed" | "denied" | "unknown", readonly storage: "allowed" | "denied" | "unknown", readonly display: "allowed" | "denied" | "unknown", readonly transformation: "allowed" | "denied" | "unknown", readonly attribution: "allowed" | "denied" | "unknown", readonly attributionText: string, readonly evidenceBasis: string, readonly evidenceReference: string, readonly scope: string, readonly expiresAt: string }, Response>} */
function validateAuthorizationRequest(value, ownerId) {
  if (!isRecord(value)) return invalidTranscriptCommand("body");
  const fields = [
    "attributionText",
    "evidenceBasis",
    "evidenceId",
    "evidenceReference",
    "expiresAt",
    "transcriptUrl",
  ];
  if (Object.keys(value).sort().join(",") !== fields.sort().join(",")) {
    return invalidTranscriptCommand("body");
  }
  if (
    !nonBlankText(value.evidenceId) || !safeHttpsUrl(value.transcriptUrl) ||
    !nonBlankText(value.attributionText) ||
    !nonBlankText(value.evidenceBasis) ||
    !safeHttpsUrl(value.evidenceReference) ||
    !validTimestamp(value.expiresAt)
  ) return invalidTranscriptCommand("authorization");
  const allowed = "allowed";
  return {
    ok: true,
    value:
      /** @type {{ readonly ownerId: string, readonly evidenceId: string, readonly transcriptUrl: string, readonly access: "allowed", readonly storage: "allowed", readonly display: "allowed", readonly transformation: "allowed", readonly attribution: "allowed", readonly attributionText: string, readonly evidenceBasis: string, readonly evidenceReference: string, readonly scope: string, readonly expiresAt: string }} */ (
        Object.freeze({
          ownerId,
          ...value,
          access: allowed,
          storage: allowed,
          display: allowed,
          transformation: allowed,
          attribution: allowed,
          scope: "transcript-retention-and-transformation",
        })
      ),
  };
}

/** @param {unknown} value @returns {Result<{ readonly requestId: string, readonly evidenceId: string, readonly transcriptUrl: string, readonly language: string, readonly jsonTextPath: readonly string[] | null, readonly retention: { readonly mode: "plain-text" } | { readonly mode: "excerpt", readonly startCharacter: number, readonly characterCount: number } }, Response>} */
function validateTranscriptRetrievalRequest(value) {
  if (!isRecord(value)) return invalidTranscriptCommand("body");
  const fields = [
    "evidenceId",
    "jsonTextPath",
    "language",
    "requestId",
    "retention",
    "transcriptUrl",
  ];
  if (Object.keys(value).sort().join(",") !== fields.sort().join(",")) {
    return invalidTranscriptCommand("body");
  }
  if (
    !nonBlankText(value.requestId) || !nonBlankText(value.evidenceId) ||
    !safeHttpsUrl(value.transcriptUrl) || !nonBlankText(value.language) ||
    !(value.jsonTextPath === null ||
      (Array.isArray(value.jsonTextPath) && value.jsonTextPath.length > 0 &&
        value.jsonTextPath.length <= 8 &&
        value.jsonTextPath.every(nonBlankText))) ||
    !isRecord(value.retention)
  ) return invalidTranscriptCommand("body");
  const retention = value.retention;
  if (
    !(
      Object.keys(retention).length === 1 && retention.mode === "plain-text"
    ) && !(
      Object.keys(retention).sort().join(",") ===
        "characterCount,mode,startCharacter" &&
      retention.mode === "excerpt" &&
      Number.isSafeInteger(retention.startCharacter) &&
      Number(retention.startCharacter) >= 0 &&
      Number.isSafeInteger(retention.characterCount) &&
      Number(retention.characterCount) > 0
    )
  ) return invalidTranscriptCommand("retention");
  return {
    ok: true,
    value:
      /** @type {{ readonly requestId: string, readonly evidenceId: string, readonly transcriptUrl: string, readonly language: string, readonly jsonTextPath: readonly string[] | null, readonly retention: { readonly mode: "plain-text" } | { readonly mode: "excerpt", readonly startCharacter: number, readonly characterCount: number } }} */ (
        Object.freeze({ ...value })
      ),
  };
}

/** @param {string} field */
function invalidTranscriptCommand(field) {
  return /** @type {const} */ ({
    ok: false,
    error: json({ error: "PodcastTranscriptCommandInvalid", field }, 400),
  });
}

/** @param {unknown} value @returns {value is string} */
function nonBlankText(value) {
  return typeof value === "string" && value.trim() !== "" &&
    value.length <= 1_024;
}

/** @param {unknown} value @returns {value is string} */
function safeHttpsUrl(value) {
  return nonBlankText(value) && URL.canParse(value) &&
    new URL(value).protocol === "https:";
}

/** @param {unknown} value @returns {value is string} */
function validTimestamp(value) {
  return nonBlankText(value) && Number.isFinite(Date.parse(value));
}

/** @param {WorkerFailure} failure */
function workerFailureResponse(failure) {
  const status = failure.kind === "DiscoveryAccessTokenMissing" ||
      failure.kind === "DiscoveryAccessTokenInvalid"
    ? 401
    : failure.kind === "DiscoveryAccessAudienceMismatch" ||
        failure.kind === "DiscoveryAccessIdentityUnmapped"
    ? 403
    : 503;
  return json({ error: failure.kind }, status);
}

/** @param {string} kind */
function transcriptFailureResponse(kind) {
  const status =
    kind === "TranscriptRightsUnknown" || kind.endsWith("NotPermitted") ||
      kind === "TranscriptAttributionMissing"
      ? 403
      : kind === "PodcastTranscriptMissing"
      ? 404
      : kind === "PodcastTranscriptTooLarge"
      ? 413
      : kind === "PodcastTranscriptFetchFailed" ||
          kind === "PodcastTranscriptDigestFailed"
      ? 503
      : 400;
  return json({ error: kind }, status);
}

/** @param {string} kind */
function authorizationFailureResponse(kind) {
  const status = kind === "TranscriptAuthorizationMissing"
    ? 404
    : kind === "TranscriptAuthorizationReferenceMismatch"
    ? 409
    : kind === "TranscriptAuthorizationAccessNotPermitted"
    ? 403
    : 503;
  return json({ error: kind }, status);
}

/** @param {unknown} body @param {number} status @param {HeadersInit} [headers] */
function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/** @param {unknown} value @returns {value is QuotaReservationBinding} */
function isQuotaBinding(value) {
  return isRecord(value) && typeof value.fetch === "function";
}

/** @param {unknown} value @returns {value is import("./source-library-d1.js").D1DatabasePort} */
function isD1Database(value) {
  return isRecord(value) && typeof value.prepare === "function" &&
    typeof value.batch === "function";
}

/** @param {unknown} value @returns {value is import("./source-content-r2.js").R2BucketPort} */
function isR2Bucket(value) {
  return isRecord(value) && typeof value.put === "function" && typeof value.delete === "function";
}

/** @param {unknown} value @returns {value is QuotaDurableObjectNamespace} */
function isQuotaNamespace(value) {
  return isRecord(value) && typeof value.idFromName === "function" &&
    typeof value.get === "function";
}

/** @param {unknown} value @returns {value is QuotaDurableObjectStorage} */
function isQuotaStorage(value) {
  return isRecord(value) && isRecord(value.sql) &&
    typeof value.sql.exec === "function" &&
    typeof value.transactionSync === "function";
}

/** @param {string} value */
function positiveIntegerText(value) {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

/** @param {string} value */
function validUtcDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

/** @param {string} value */
function isOrigin(value) {
  return URL.canParse(value) && new URL(value).origin === value &&
    new URL(value).protocol === "https:";
}

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** @type {{ readonly fetch: (request: Request, environment: DiscoveryWorkerEnvironment) => Promise<Response> }} */
const worker = Object.freeze({
  async fetch(request, environment) {
    const composed = createCloudflareDiscoveryWorker(environment, {
      fetch: globalThis.fetch,
      now: () => new Date(),
      subtle: globalThis.crypto.subtle,
      randomBytes: (length) =>
        globalThis.crypto.getRandomValues(new Uint8Array(length)),
    });
    return composed.ok
      ? composed.value.fetch(request)
      : json({ error: composed.error.kind, field: composed.error.field }, 503);
  },
});

export default worker;

export {
  PublisherTranscriptAuthorizationDurableObject,
  YouTubeOAuthDurableObject,
};
