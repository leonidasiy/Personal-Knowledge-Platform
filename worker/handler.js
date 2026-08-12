// @ts-check

import { isRecord, validateRssAcquisitionCommand } from "./contracts.js";

/** @import { AccessIdentity, Result, RssAcquisitionResult, WorkerFailure } from "./contracts.js" */
/** @import { LibrarySource, SourceCatalogPage, SourceIngestionJob, SourceLibraryFailure, SourceSearchHit, SourceSuppression } from "../src/features/source-library/contracts.js" */
/** @import { RightsApprovalFailure, RightsApprovalResult } from "../src/features/source-library/rights-approval.js" */

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
 *   readonly sourceRightsApproval?: null | {
 *     readonly approve: (command: unknown) => Promise<Result<RightsApprovalResult, RightsApprovalFailure>>
 *   },
 *   readonly sourceCatalog?: null | {
 *     readonly browse: (command: unknown) => Promise<Result<SourceCatalogPage, SourceLibraryFailure>>,
 *     readonly search: (command: unknown) => Promise<Result<readonly SourceSearchHit[], SourceLibraryFailure>>,
 *     readonly suppressed: (command: unknown) => Promise<Result<readonly string[], SourceLibraryFailure>>,
 *     readonly active: (command: unknown) => Promise<Result<readonly string[], SourceLibraryFailure>>
 *   },
 *   readonly sourceIngestion?: null | { readonly run: (command: unknown) => Promise<Result<{ readonly state: "completed" | "partial", readonly itemsStored: number }, import("../src/features/source-library/ingestion-contracts.js").SourceIngestionFailure>> },
 *   readonly waitUntil?: (promise: Promise<unknown>) => void,
 *   readonly manualMaterial?: null | { readonly upload: (command: unknown) => Promise<Result<{ readonly status: "processing-ready", readonly reference: import("../src/features/source-library/ingestion-contracts.js").SourceContentReference, readonly reused: boolean }, import("../src/features/source-library/ingestion-contracts.js").SourceIngestionFailure>> },
 *   readonly wikimediaTimedText?: null | { readonly retrieve: (command: unknown) => Promise<Result<unknown, { readonly kind: string }>> },
 *   readonly learningGeneration?: null | {
 *     readonly status: (command: unknown) => Promise<Result<unknown, { readonly kind: string }>>,
 *     readonly review: { readonly decide: (command: unknown) => Promise<Result<unknown, { readonly kind: string }>>, readonly queue?: (ownerId: string) => Promise<Result<unknown, { readonly kind: string }>> },
 *     readonly revoke: { readonly revoke: (command: unknown) => Promise<Result<unknown, { readonly kind: string }>> }
 *   }
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
        typeof dependencies.centralSearch.search !== "function")) ||
    (dependencies.waitUntil !== undefined && typeof dependencies.waitUntil !== "function")
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
      const sourceRightsApproval = url.pathname === "/api/source-library/rights/approve";
      const sourceBrowse = url.pathname === "/api/source-library";
      const sourceSearch = url.pathname === "/api/source-library/search";
      const sourceSuppressionCheck =
        url.pathname === "/api/source-library/suppressions/check";
      const sourceActiveCheck =
        url.pathname === "/api/source-library/active/check";
      const sourceIngestion = url.pathname === "/api/source-library/ingestion/run";
      const manualMaterial = url.pathname === "/api/source-library/manual-material";
      const wikimediaTimedText = url.pathname === "/api/discovery/wikimedia/timedtext";
      const learningStatus = url.pathname === "/api/learning-generation/status";
      const learningReviewQueue = url.pathname === "/api/learning-generation/review-queue";
      const learningReview = url.pathname === "/api/learning-generation/review";
      const learningRevocation = url.pathname === "/api/learning-generation/revoke";
      if (
        !rssPath && !centralSearchPath &&
        !centralCapabilitiesPath && sourceAction === null && !sourceRightsApproval && !sourceBrowse &&
        !sourceSearch && !sourceSuppressionCheck && !sourceActiveCheck &&
        !sourceIngestion && !manualMaterial && !wikimediaTimedText &&
        !learningStatus && !learningReviewQueue && !learningReview && !learningRevocation
      ) {
        return json({ error: "Not found." }, 404);
      }
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== configuration.allowedOrigin) {
        return failureResponse({ kind: "DiscoveryOriginRejected" });
      }
      if (learningStatus) {
        if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
        if (dependencies.learningGeneration == null) return json({ error: "LearningGenerationUnavailable" }, 503);
        const generationId = url.searchParams.get("generationId");
        if (generationId === null || generationId.trim() === "") return json({ error: "LearningGenerationCommandInvalid" }, 400);
        const result = await dependencies.learningGeneration.status({ ownerId: authenticated.value.ownerId, generationId });
        return result.ok ? json({ ownerId: authenticated.value.ownerId, result: result.value }, 200) : learningGenerationFailureResponse(result.error);
      }
      if (learningReviewQueue) {
        if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
        if (dependencies.learningGeneration?.review.queue === undefined) return json({ error: "LearningGenerationUnavailable" }, 503);
        const result = await dependencies.learningGeneration.review.queue(authenticated.value.ownerId);
        return result.ok ? json({ ownerId: authenticated.value.ownerId, result: result.value }, 200) : learningGenerationFailureResponse(result.error);
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
      if (sourceRightsApproval) {
        if (dependencies.sourceRightsApproval == null) return rightsApprovalFailureResponse({ kind: "RightsApprovalPersistenceFailed" });
        if (!isRecord(document) || Object.hasOwn(document, "ownerId")) return rightsApprovalFailureResponse({ kind: "RightsApprovalCommandInvalid", field: Object.hasOwn(isRecord(document) ? document : {}, "ownerId") ? "ownerId" : "body" });
        const result = await dependencies.sourceRightsApproval.approve(Object.freeze({ ...document, ownerId: authenticated.value.ownerId }));
        if (!result.ok) return rightsApprovalFailureResponse(result.error);
        if (result.value.requeued && !result.value.reused && result.value.jobId !== null && dependencies.sourceIngestion !== null && dependencies.sourceIngestion !== undefined) {
          const work = dependencies.sourceIngestion.run({ ownerId: authenticated.value.ownerId, jobId: result.value.jobId });
          const observed = work.then((outcome) => {
            if (!outcome.ok) console.error(JSON.stringify({ event: "source-rights-approval-automatic-ingestion-failure", failureKind: outcome.error.kind }));
            else console.info(JSON.stringify({ event: "source-rights-approval-automatic-ingestion-success", itemsStored: outcome.value.itemsStored }));
          }, (error) => {
            if (error instanceof Error) {
              console.error(JSON.stringify({ event: "source-rights-approval-automatic-ingestion-rejection", failureKind: "SourceIngestionUnexpectedFailure" }));
              return;
            }
            throw error;
          });
          if (dependencies.waitUntil === undefined) await observed;
          else dependencies.waitUntil(observed);
        }
        return json({ ownerId: authenticated.value.ownerId, result: result.value }, 200);
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
        if (result.ok && sourceAction === "disable" && dependencies.learningGeneration !== null && dependencies.learningGeneration !== undefined) {
          const revoked = await dependencies.learningGeneration.revoke.revoke({ ownerId: authenticated.value.ownerId, sourceId: result.value.id, sourceRevision: result.value.revision, idempotencyKey: `source-disable:${result.value.id}:${result.value.revision}`, reason: "source-disabled", revokedAt: result.value.updatedAt });
          if (!revoked.ok) return learningGenerationFailureResponse(revoked.error);
        }
        if (result.ok && sourceAction === "approve" && !result.value.reused && result.value.job !== null && dependencies.sourceIngestion !== null && dependencies.sourceIngestion !== undefined && result.value.source.adapter.capabilities.includes("bounded-ingestion")) {
          const work = dependencies.sourceIngestion.run({ ownerId: authenticated.value.ownerId, jobId: result.value.job.id });
          const observed = work.then((outcome) => {
            if (!outcome.ok) console.error(JSON.stringify({ event: "source-library-automatic-ingestion-failure", failureKind: outcome.error.kind }));
            else console.info(JSON.stringify({ event: "source-library-automatic-ingestion-success", itemsStored: outcome.value.itemsStored }));
          }, (error) => {
            if (error instanceof Error) {
              console.error(JSON.stringify({ event: "source-library-automatic-ingestion-rejection", failureKind: "SourceIngestionUnexpectedFailure" }));
              return;
            }
            throw error;
          });
          if (dependencies.waitUntil === undefined) await observed;
          else dependencies.waitUntil(observed);
        }
        return result.ok
          ? json(
            { ownerId: authenticated.value.ownerId, result: result.value },
            200,
          )
          : sourceFailureResponse(result.error);
      }
      if (learningReview || learningRevocation) {
        if (dependencies.learningGeneration == null) return json({ error: "LearningGenerationUnavailable" }, 503);
        if (!isRecord(document) || Object.hasOwn(document, "ownerId")) return json({ error: "LearningGenerationCommandInvalid" }, 400);
        const ownedCommand = Object.freeze({ ...document, ownerId: authenticated.value.ownerId });
        const result = learningReview
          ? await dependencies.learningGeneration.review.decide(ownedCommand)
          : await dependencies.learningGeneration.revoke.revoke(ownedCommand);
        if (!result.ok) return learningGenerationFailureResponse(result.error);
        if (learningRevocation) return json({ ownerId: authenticated.value.ownerId, result: result.value }, 200);
        const value = isRecord(result.value) ? result.value : null;
        if (value === null || !isNonEmptyText(value.id) || !isNonEmptyText(value.status) || typeof value.revision !== "number") return json({ error: "LearningGenerationResponseInvalid" }, 503);
        return json({ ownerId: authenticated.value.ownerId, result: { taskId: value.id, status: value.status, reviewDecision: value.reviewDecision ?? null, reviewedAt: value.reviewedAt ?? null, revision: value.revision } }, 200);
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

/** @param {RightsApprovalFailure} failure */
function rightsApprovalFailureResponse(failure) {
  const status = failure.kind === "RightsApprovalSourceNotFound"
    ? 404
    : failure.kind === "RightsApprovalSourceDisabled" || failure.kind === "RightsApprovalRevisionStale" || failure.kind === "RightsApprovalRootMismatch" || failure.kind === "RightsApprovalEvidenceConflict" || failure.kind === "RightsApprovalIdempotencyConflict"
    ? 409
    : failure.kind === "RightsApprovalPersistenceFailed"
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

/** @param {{ readonly kind: string }} failure */
function learningGenerationFailureResponse(failure) {
  const status = failure.kind === "LearningReviewTaskUnknown"
    ? 404
    : failure.kind === "LearningReviewRevisionStale" || failure.kind === "LearningReviewAlreadyDecided" || failure.kind === "LearningReviewIdempotencyConflict" || failure.kind === "LearningRevocationConflict" || failure.kind === "LearningFreshRightsRequired"
    ? 409
    : failure.kind.endsWith("PersistenceFailed") || failure.kind === "LearningProviderUnavailable" || failure.kind === "LearningProviderTimeout" || failure.kind === "LearningProviderCredentialMissing" || failure.kind === "LearningBudgetExceeded"
    ? 503
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

/** @param {unknown} value @returns {value is string} */
function isNonEmptyText(value) { return typeof value === "string" && value.trim() !== ""; }
