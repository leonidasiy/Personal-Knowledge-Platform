// @ts-check

import { isRecord, validateRssAcquisitionCommand } from "./contracts.js";

/** @import { AccessIdentity, Result, RssAcquisitionResult, WorkerFailure } from "./contracts.js" */
/** @import { LibrarySource, SourceCatalogPage, SourceIngestionJob, SourceLibraryFailure, SourceSearchHit, SourceSuppression } from "../src/features/source-library/contracts.js" */

/**
 * @param {{ readonly allowedOrigin: string, readonly maximumCommandBytes: number }} configuration
 * @param {{
 *   readonly authenticate: (request: Request) => Promise<Result<AccessIdentity, WorkerFailure>>,
 *   readonly acquireRss: (command: import("./contracts.js").RssAcquisitionCommand, ownerId: string) => Promise<Result<RssAcquisitionResult, WorkerFailure | { readonly kind: "TranscriptAuthorizationPersistenceFailed" }>>,
 *   readonly centralSearch?: null | {
 *     readonly capabilities: () => readonly { readonly id: string, readonly label: string, readonly resultKind: string, readonly priority: number, readonly enabled: boolean }[],
 *     readonly search: (command: unknown) => Promise<Result<unknown, { readonly kind: string }>>
 *   },
 *   readonly sourceLibrary?: null | {
 *     readonly approve: (command: unknown) => Promise<Result<{ readonly source: LibrarySource, readonly job: SourceIngestionJob | null, readonly reused: boolean }, SourceLibraryFailure>>,
 *     readonly revise: (command: unknown) => Promise<Result<LibrarySource, SourceLibraryFailure>>,
 *     readonly disable: (command: unknown) => Promise<Result<LibrarySource, SourceLibraryFailure>>,
 *     readonly restore: (command: unknown) => Promise<Result<LibrarySource, SourceLibraryFailure>>,
 *     readonly reject: (command: unknown) => Promise<Result<{ readonly suppression: SourceSuppression, readonly reused: boolean }, SourceLibraryFailure>>
 *   },
 *   readonly sourceCatalog?: null | {
 *     readonly browse: (command: unknown) => Promise<Result<SourceCatalogPage, SourceLibraryFailure>>,
 *     readonly search: (command: unknown) => Promise<Result<readonly SourceSearchHit[], SourceLibraryFailure>>,
 *     readonly suppressed: (command: unknown) => Promise<Result<readonly string[], SourceLibraryFailure>>,
 *     readonly active: (command: unknown) => Promise<Result<readonly string[], SourceLibraryFailure>>
 *   },
 *   readonly sourceIngestion?: null | { readonly run: (command: unknown) => Promise<Result<{ readonly state: "completed" | "partial", readonly itemsStored: number }, import("../src/features/source-library/ingestion-contracts.js").SourceIngestionFailure>> },
 *   readonly manualMaterial?: null | { readonly upload: (command: unknown) => Promise<Result<{ readonly status: "processing-ready", readonly reference: import("../src/features/source-library/ingestion-contracts.js").SourceContentReference, readonly reused: boolean }, import("../src/features/source-library/ingestion-contracts.js").SourceIngestionFailure>> },
 *   readonly wikimediaTimedText?: null | { readonly retrieve: (command: unknown) => Promise<Result<unknown, { readonly kind: string }>> }
 * }} dependencies
 */
export function createDiscoveryWorker(configuration, dependencies) {
  if (
    !URL.canParse(configuration.allowedOrigin) ||
    new URL(configuration.allowedOrigin).origin !==
      configuration.allowedOrigin ||
    !Number.isInteger(configuration.maximumCommandBytes) ||
    configuration.maximumCommandBytes < 1 ||
    typeof dependencies.authenticate !== "function" ||
    typeof dependencies.acquireRss !== "function" ||
    (dependencies.centralSearch != null &&
      (typeof dependencies.centralSearch.capabilities !== "function" ||
        typeof dependencies.centralSearch.search !== "function"))
  ) {
    throw new TypeError("Discovery Worker configuration is invalid.");
  }
  return Object.freeze({
    /** @param {Request} request */
    async fetch(request) {
      const authenticated = await dependencies.authenticate(request);
      if (!authenticated.ok) return failureResponse(authenticated.error);
      const url = new URL(request.url);
      const rssPath = url.pathname === "/api/discovery/rss";
      const centralSearchPath = url.pathname === "/api/discovery/search";
      const centralCapabilitiesPath =
        url.pathname === "/api/discovery/search/capabilities";
      const sourceAction = sourceLibraryAction(url.pathname);
      const sourceBrowse = url.pathname === "/api/source-library";
      const sourceSearch = url.pathname === "/api/source-library/search";
      const sourceSuppressionCheck =
        url.pathname === "/api/source-library/suppressions/check";
      const sourceActiveCheck =
        url.pathname === "/api/source-library/active/check";
      const sourceIngestion = url.pathname === "/api/source-library/ingestion/run";
      const manualMaterial = url.pathname === "/api/source-library/manual-material";
      const wikimediaTimedText = url.pathname === "/api/discovery/wikimedia/timedtext";
      if (
        !rssPath && !centralSearchPath &&
        !centralCapabilitiesPath && sourceAction === null && !sourceBrowse &&
        !sourceSearch && !sourceSuppressionCheck && !sourceActiveCheck &&
        !sourceIngestion && !manualMaterial && !wikimediaTimedText
      ) {
        return json({ error: "Not found." }, 404);
      }
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== configuration.allowedOrigin) {
        return failureResponse({ kind: "DiscoveryOriginRejected" });
      }
      if (centralCapabilitiesPath) {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
        }
        if (dependencies.centralSearch == null) {
          return json({ error: "CentralSearchUnavailable" }, 503);
        }
        return json({
          ownerId: authenticated.value.ownerId,
          result: dependencies.centralSearch.capabilities(),
        }, 200);
      }
      if (sourceBrowse || sourceSearch) {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
        }
        if (dependencies.sourceCatalog == null) {
          return sourceFailureResponse({ kind: "SourceCatalogReadFailed" });
        }
        const limit = Number(url.searchParams.get("limit"));
        const result = sourceBrowse
          ? await dependencies.sourceCatalog.browse({
            ownerId: authenticated.value.ownerId,
            limit,
            cursor: url.searchParams.get("cursor"),
          })
          : await dependencies.sourceCatalog.search({
            ownerId: authenticated.value.ownerId,
            limit,
            query: url.searchParams.get("q"),
            mode: url.searchParams.get("mode") ?? "combined",
          });
        return result.ok
          ? json(
            { ownerId: authenticated.value.ownerId, result: result.value },
            200,
          )
          : sourceFailureResponse(result.error);
      }
      if (sourceSuppressionCheck || sourceActiveCheck) {
        if (request.method !== "POST") {
          return json({ error: "Method not allowed." }, 405, { Allow: "POST" });
        }
        if (dependencies.sourceCatalog == null) {
          return sourceFailureResponse({ kind: "SourceCatalogReadFailed" });
        }
      }
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, 405, { Allow: "POST" });
      }
      const declaredLength = Number(request.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > configuration.maximumCommandBytes
      ) {
        return failureResponse({ kind: "DiscoveryRequestTooLarge" });
      }
      const text = await request.text();
      if (
        new TextEncoder().encode(text).byteLength >
          configuration.maximumCommandBytes
      ) {
        return failureResponse({ kind: "DiscoveryRequestTooLarge" });
      }
      let document;
      try {
        document = /** @type {unknown} */ (JSON.parse(text));
      } catch (error) {
        if (error instanceof SyntaxError) {
          return failureResponse({
            kind: "DiscoveryCommandInvalid",
            field: "body",
          });
        }
        throw error;
      }
      if (sourceAction !== null) {
        if (dependencies.sourceLibrary == null) {
          return sourceFailureResponse({
            kind: "SourceApprovalPersistenceFailed",
          });
        }
        if (!isRecord(document) || Object.hasOwn(document, "ownerId")) {
          return sourceFailureResponse({
            kind: "SourceCatalogCommandInvalid",
            field: Object.hasOwn(
                isRecord(document) ? document : {},
                "ownerId",
              )
              ? "ownerId"
              : "body",
          });
        }
        const ownedCommand = Object.freeze({
          ...document,
          ownerId: authenticated.value.ownerId,
        });
        const result = sourceAction === "approve"
          ? await dependencies.sourceLibrary.approve(ownedCommand)
          : sourceAction === "revise"
          ? await dependencies.sourceLibrary.revise(ownedCommand)
          : sourceAction === "disable"
          ? await dependencies.sourceLibrary.disable(ownedCommand)
          : sourceAction === "restore"
          ? await dependencies.sourceLibrary.restore(ownedCommand)
          : await dependencies.sourceLibrary.reject(ownedCommand);
        return result.ok
          ? json(
            { ownerId: authenticated.value.ownerId, result: result.value },
            200,
          )
          : sourceFailureResponse(result.error);
      }
      if (sourceIngestion || manualMaterial || wikimediaTimedText) {
        if (sourceIngestion) {
          if (!validSourceIngestionCommand(document)) {
            return json({ error: "SourceIngestionCommandInvalid" }, 400);
          }
          const result = await dependencies.sourceIngestion?.run(Object.freeze({
            ownerId: authenticated.value.ownerId,
            jobId: document.jobId,
          }));
          if (result === undefined) return json({ error: "SourceIngestionUnavailable" }, 503);
          return result.ok
            ? json({ ownerId: authenticated.value.ownerId, result: result.value }, 200)
            : ingestionFailureResponse(result.error);
        }
        if (wikimediaTimedText && !validWikimediaCommand(document)) {
          return json({ error: "WikimediaCommandInvalid" }, 400);
        }
        if (!isRecord(document) || Object.hasOwn(document, "ownerId")) {
          return json({ error: "SourceIngestionCommandInvalid" }, 400);
        }
        const ownedCommand = Object.freeze({ ...document, ownerId: authenticated.value.ownerId });
        const result = manualMaterial
          ? await dependencies.manualMaterial?.upload(ownedCommand)
          : await dependencies.wikimediaTimedText?.retrieve(ownedCommand);
        if (result === undefined) return json({ error: "SourceIngestionUnavailable" }, 503);
        return result.ok
          ? json({ ownerId: authenticated.value.ownerId, result: result.value }, 200)
          : ingestionFailureResponse(result.error);
      }
      if (sourceSuppressionCheck || sourceActiveCheck) {
        if (!isRecord(document) || Object.hasOwn(document, "ownerId")) {
          return sourceFailureResponse({
            kind: "SourceCatalogCommandInvalid",
            field: "body",
          });
        }
        const result = sourceActiveCheck
          ? await dependencies.sourceCatalog?.active({
            ...document,
            ownerId: authenticated.value.ownerId,
          })
          : await dependencies.sourceCatalog?.suppressed({
            ...document,
            ownerId: authenticated.value.ownerId,
          });
        if (result === undefined) {
          return sourceFailureResponse({ kind: "SourceCatalogReadFailed" });
        }
        return result.ok
          ? json(
            { ownerId: authenticated.value.ownerId, result: result.value },
            200,
          )
          : sourceFailureResponse(result.error);
      }
      if (centralSearchPath) {
        if (dependencies.centralSearch == null) {
          return json({ error: "CentralSearchUnavailable" }, 503);
        }
        const searched = await dependencies.centralSearch.search(document);
        return searched.ok
          ? json(
            { ownerId: authenticated.value.ownerId, result: searched.value },
            200,
          )
          : centralSearchFailureResponse(searched.error);
      }
      const command = validateRssAcquisitionCommand(document);
      if (!command.ok) return failureResponse(command.error);
      const acquired = await dependencies.acquireRss(
        command.value,
        authenticated.value.ownerId,
      );
      if (!acquired.ok) {
        return acquired.error.kind ===
            "TranscriptAuthorizationPersistenceFailed"
          ? json({ error: acquired.error.kind }, 503)
          : failureResponse(acquired.error);
      }
      return json(
        { ownerId: authenticated.value.ownerId, result: acquired.value },
        200,
      );
    },
  });
}

/** @param {{ readonly kind: string, readonly failures?: readonly unknown[] }} failure */
function centralSearchFailureResponse(failure) {
  const quotaOnly = failure.kind === "CentralSearchAllProvidersFailed" &&
    Array.isArray(failure.failures) && failure.failures.length > 0 &&
    failure.failures.every((entry) =>
      isRecord(entry) && isRecord(entry.failure) &&
      entry.failure.kind === "SearchProviderQuotaExceeded"
    );
  const status = failure.kind === "CentralSearchAllProvidersFailed"
    ? quotaOnly ? 429 : 503
    : failure.kind === "CentralSearchProviderDisabled"
    ? 409
    : 400;
  return json({ error: failure.kind }, status);
}

/** @param {unknown} value @returns {value is { readonly jobId: string }} */
function validSourceIngestionCommand(value) {
  return isRecord(value) && Object.keys(value).length === 1 &&
    typeof value.jobId === "string" && value.jobId.trim() !== "";
}

/** @param {unknown} value */
function validWikimediaCommand(value) {
  if (!isRecord(value)) return false;
  const fields = ["sourceId", "sourceRevision", "itemId", "itemVersionId", "language"];
  return Object.keys(value).length === fields.length && fields.every((field) =>
    Object.hasOwn(value, field)
  );
}

/** @param {string} pathname @returns {"approve" | "revise" | "disable" | "restore" | "reject" | null} */
function sourceLibraryAction(pathname) {
  const prefix = "/api/source-library/";
  if (!pathname.startsWith(prefix)) return null;
  const action = pathname.slice(prefix.length);
  return action === "approve" || action === "revise" || action === "disable" ||
      action === "restore" || action === "reject"
    ? action
    : null;
}

/** @param {WorkerFailure} failure */
function failureResponse(failure) {
  const status = failure.kind === "DiscoveryClientUnauthenticated" ||
      failure.kind === "DiscoveryAccessTokenMissing" ||
      failure.kind === "DiscoveryAccessTokenInvalid"
    ? 401
    : failure.kind === "DiscoveryClientUnauthorized" ||
        failure.kind === "DiscoveryOriginRejected" ||
        failure.kind === "DiscoveryAccessAudienceMismatch" ||
        failure.kind === "DiscoveryAccessIdentityUnmapped"
    ? 403
    : failure.kind === "YouTubeSearchQuotaExceeded" ||
        failure.kind === "YouTubeGeneralQuotaExceeded" ||
        failure.kind === "YouTubeProviderQuotaExceeded"
    ? 429
    : failure.kind === "DiscoveryRequestTooLarge" ||
        failure.kind === "DiscoveryPayloadTooLarge"
    ? 413
    : failure.kind === "DiscoveryFetchTimedOut"
    ? 504
    : failure.kind === "DiscoveryFetchUnavailable" ||
        failure.kind === "YouTubeCredentialMissing" ||
        failure.kind === "YouTubeCredentialRefreshUnavailable" ||
        failure.kind === "YouTubeUpstreamUnavailable"
    ? 503
    : failure.kind === "DiscoveryHttpRejected" ||
        failure.kind === "YouTubeCredentialRejected" ||
        failure.kind === "YouTubeResponseInvalid"
    ? 502
    : 400;
  return json({ error: failure.kind }, status);
}

/** @param {SourceLibraryFailure} failure */
function sourceFailureResponse(failure) {
  const status = failure.kind === "SourceOwnerMismatch" ||
      failure.kind === "SourceCursorOwnerMismatch"
    ? 403
    : failure.kind === "SourceNotFound"
    ? 404
    : failure.kind === "SourceIdentityMissing" ||
        failure.kind === "SourceIdentityAmbiguous" ||
        failure.kind === "SourceIdentityConflict" ||
        failure.kind === "SourceRevisionStale" ||
        failure.kind === "SourceStateConflict" ||
        failure.kind === "SourceInterestAreaMissing" ||
        failure.kind === "SourceIdempotencyConflict" ||
        failure.kind === "SourceCursorStale"
    ? 409
    : failure.kind === "SourceApprovalPersistenceFailed" ||
        failure.kind === "SourceCrawlEnqueueFailed" ||
        failure.kind === "SourceDisablePersistenceFailed" ||
        failure.kind === "SourceSuppressionFailed" ||
        failure.kind === "SourceCatalogReadFailed" ||
        failure.kind === "SourceKeywordSearchUnavailable" ||
        failure.kind === "SourceEmbeddingUnavailable" ||
        failure.kind === "SourceSemanticIndexUnavailable" ||
        failure.kind === "SourceSemanticIndexOutOfSync"
    ? 503
    : 400;
  return json({ error: failure.kind }, status);
}

/** @param {{ readonly kind: string }} failure */
function ingestionFailureResponse(failure) {
  const status = failure.kind === "ManualUploadOwnerMismatch" ? 403
    : failure.kind === "ManualUploadSourceNotFound" || failure.kind === "ManualUploadItemNotFound" ? 404
    : failure.kind === "IngestionJobLeaseConflict" || failure.kind === "IngestionSourceRevisionStale" || failure.kind === "ManualUploadRevisionStale" || failure.kind === "ManualUploadIdempotencyConflict" ? 409
    : failure.kind === "IngestionPersistenceFailed" || failure.kind === "ManualUploadPersistenceFailed" || failure.kind === "SourceContentObjectWriteFailed" || failure.kind === "SourceContentObjectCleanupFailed" || failure.kind.endsWith("FetchFailed") ? 503
    : 400;
  return json({ error: failure.kind }, status);
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
