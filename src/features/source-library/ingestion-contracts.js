// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly registryIds: readonly string[] }} RightsRegistryEvidenceContext */

/** @typedef {"allowed" | "denied" | "unknown"} EvidenceOutcome */
/** @typedef {"sitemap" | "navigation"} StructuralEvidenceKind */

/**
 * Server-owned permission evidence resolved before any remote body is acquired.
 * @typedef {{
 *   readonly registryId: string,
 *   readonly registryVersion: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly canonicalRootUrl: string,
 *   readonly capabilities: {
 *     readonly storage: CapabilityEvidence,
 *     readonly display: CapabilityEvidence,
 *     readonly transformation: CapabilityEvidence
 *   },
 *   readonly crawlEvidence: {
 *     readonly robots: "allowed" | "denied" | "unavailable" | "malformed",
 *     readonly robotsEvidenceReference: string,
 *     readonly terms: "allowed" | "denied" | "unknown",
 *     readonly termsEvidenceReference: string,
 *     readonly access: "public" | "denied" | "authentication-required" | "paywall",
 *     readonly accessEvidenceReference: string,
 *     readonly structuralEvidence: readonly StructuralDepthEvidence[]
 *   },
 *   readonly attributionText: string,
 *   readonly evidenceDigest: string,
 *   readonly assessorId: string,
 *   readonly assessorVersion: string,
 *   readonly observedAt: string,
 *   readonly expiresAt: string | null
 * }} ServerRightsGrant
 */

/**
 * @typedef {{
 *   readonly ordinal: number,
 *   readonly url: string,
 *   readonly depth: number,
 *   readonly state: "pending" | "visited",
 *   readonly discoveredFromUrl: string | null
 * }} SourceIngestionFrontierEntry
 */

/**
 * @typedef {{
 *   readonly version: number,
 *   readonly nextOrdinal: number,
 *   readonly pagesProcessed: number,
 *   readonly decodedBytes: number,
 *   readonly redirects: number,
 *   readonly frontier: readonly SourceIngestionFrontierEntry[]
 * }} SourceIngestionCursor
 */

/**
 * @typedef {{
 *   readonly reservationId: string,
 *   readonly accountScope: string,
 *   readonly ownerId: string,
 *   readonly jobId: string,
 *   readonly utcDay: string,
 *   readonly reservedMilliseconds: number,
 *   readonly reservedAt: string,
 *   readonly nextEligibleAt: string
 * }} BrowserRunReservation
 */

/**
 * @typedef {{
 *   readonly canonicalUrl: string,
 *   readonly status: number,
 *   readonly title: string,
 *   readonly description: string,
 *   readonly readableText: string,
 *   readonly visibleLinks: readonly string[],
 *   readonly redirectChain: readonly string[],
 *   readonly peerAddress: string,
 *   readonly observedAt: string
 * }} BrowserRunObservedPage
 */

/**
 * @typedef {{
 *   readonly pages: readonly BrowserRunObservedPage[],
 *   readonly nextCursor: SourceIngestionCursor | null,
 *   readonly measuredMilliseconds: number,
 *   readonly stopReason: string | null
 * }} BrowserRunAcquisitionBatch
 */

/**
 * @typedef {{
 *   readonly version: string,
 *   readonly initialDepth: number,
 *   readonly maximumDepth: number,
 *   readonly maximumPages: number,
 *   readonly maximumDecodedBytes: number,
 *   readonly maximumConcurrency: number,
 *   readonly maximumDurationMs: number,
 *   readonly maximumRedirects: number,
 *   readonly refreshIntervalMs: number
 * }} SourceIngestionPolicy
 */

/**
 * @typedef {{
 *   readonly kind: StructuralEvidenceKind,
 *   readonly evidenceUrl: string,
 *   readonly requiredDepth: number,
 *   readonly observedAt: string
 * }} StructuralDepthEvidence
 */

/**
 * @typedef {{
 *   readonly outcome: EvidenceOutcome,
 *   readonly evidenceReference: string,
 *   readonly observedAt: string,
 *   readonly expiresAt: string | null
 * }} CapabilityEvidence
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly rootUrl: string,
 *   readonly robots: "allowed" | "denied" | "unavailable" | "malformed",
 *   readonly robotsEvidenceReference: string,
 *   readonly terms: "allowed" | "denied" | "unknown",
 *   readonly termsEvidenceReference: string,
 *   readonly access: "public" | "denied" | "authentication-required" | "paywall",
 *   readonly accessEvidenceReference: string,
 *   readonly rights: {
 *     readonly storage: CapabilityEvidence,
 *     readonly display: CapabilityEvidence,
 *     readonly transformation: CapabilityEvidence
 *   },
 *   readonly structuralEvidence: readonly StructuralDepthEvidence[]
 * }} SourcePolicyAssessmentCommand
 */

/**
 * @typedef {{
 *   readonly policyVersion: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly rootUrl: string,
 *   readonly selectedDepth: number,
 *   readonly depthReason: "policy-default" | "sitemap-evidence" | "navigation-evidence",
 *   readonly depthEvidence: StructuralDepthEvidence | null,
 *   readonly maximumPages: number,
 *   readonly maximumDecodedBytes: number,
 *   readonly maximumConcurrency: number,
 *   readonly maximumDurationMs: number,
 *   readonly maximumRedirects: number,
 *   readonly refreshIntervalMs: number,
 *   readonly assessedAt: string
 * }} SourceCrawlPlan
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly jobId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly leaseToken: string,
 *   readonly leasedAt: string,
 *   readonly leaseExpiresAt: string
 * }} SourceIngestionLease
 */

/**
 * Authoritative source/job data loaded by the Worker after Access authentication.
 * It is never accepted from a browser command.
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly jobId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly rootUrl: string,
 *   readonly cursor: SourceIngestionCursor
 * }} TrustedSourceIngestionJob
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly versionId: string,
 *   readonly canonicalUrl: string,
 *   readonly title: string,
 *   readonly description: string,
 *   readonly contentDigest: string,
 *   readonly provenance: readonly { readonly method: string, readonly reference: string }[],
 *   readonly observedAt: string,
 *   readonly publishedAt: string | null
 * }} SourceItemVersion
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string | null,
 *   readonly itemVersionId: string | null,
 *   readonly capabilities: readonly { readonly capability: string, readonly outcome: EvidenceOutcome }[],
 *   readonly evidence: readonly { readonly reference: string, readonly observedAt: string }[],
 *   readonly assessedAt: string,
 *   readonly expiresAt: string | null
 * }} SourceRightsAssessment
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly policyVersion: string,
 *   readonly selectedDepth: number,
 *   readonly evidence: readonly StructuralDepthEvidence[],
 *   readonly outcome: "eligible" | "metadata-only" | "partial",
 *   readonly assessedAt: string
 * }} SourceCrawlAssessment
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly itemVersionId: string,
 *   readonly objectKey: string,
 *   readonly contentDigest: string,
 *   readonly rightsAssessmentId: string,
 *   readonly state: "processing-ready" | "revoked",
 *   readonly createdAt: string
 * }} SourceContentReference
 */

/**
 * @typedef {{
 *   readonly lease: SourceIngestionLease,
 *   readonly crawlAssessment: SourceCrawlAssessment,
 *   readonly rightsAssessments: readonly SourceRightsAssessment[],
 *   readonly items: readonly SourceItemVersion[],
 *   readonly contentReferences: readonly SourceContentReference[],
 *   readonly state: "completed" | "partial",
 *   readonly generationState: "not-requested" | "queued",
 *   readonly stopReason: string | null,
 *   readonly pagesProcessed: number,
 *   readonly decodedBytes: number,
 *   readonly resumeCursor: SourceIngestionCursor | null,
 *   readonly committedAt: string
 * }} SourceIngestionCommit
 */

/**
 * @typedef {{
 *   readonly kind: "SourceIngestionCommandInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "CrawlPolicyMissing"
 * } | {
 *   readonly kind: "RobotsFetchUnavailable"
 * } | {
 *   readonly kind: "RobotsMalformed"
 * } | {
 *   readonly kind: "RobotsDenied"
 * } | {
 *   readonly kind: "PublicAccessDenied"
 * } | {
 *   readonly kind: "AuthenticationRequired"
 * } | {
 *   readonly kind: "PaywallDetected"
 * } | {
 *   readonly kind: "TermsUnknown"
 * } | {
 *   readonly kind: "TermsDenied"
 * } | {
 *   readonly kind: "ContentRightsUnknown",
 *   readonly capability: "storage" | "display" | "transformation"
 * } | {
 *   readonly kind: "ContentStorageDenied"
 * } | {
 *   readonly kind: "ContentDisplayDenied"
 * } | {
 *   readonly kind: "ContentTransformationDenied"
 * } | {
 *   readonly kind: "RightsEvidenceExpired",
 *   readonly capability: "storage" | "display" | "transformation"
 * } | {
 *   readonly kind: "RightsRegistryUnavailable"
 * } | {
 *   readonly kind: "RightsRegistrySchemaInvalid"
 * } | {
 *   readonly kind: "RightsRegistryRecordMissing"
 * } | {
 *   readonly kind: "RightsRegistryOwnerMismatch"
 * } | {
 *   readonly kind: "RightsRegistrySourceMismatch"
 * } | {
 *   readonly kind: "RightsRegistryRevisionMismatch"
 * } | {
 *   readonly kind: "RightsRegistryRootMismatch"
 * } | {
 *   readonly kind: "RightsRegistryCapabilityMissing"
 * } | {
 *   readonly kind: "RightsRegistryAttributionMissing"
 * } | {
 *   readonly kind: "RightsRegistryEvidenceExpired"
 * } | {
 *   readonly kind: "RightsRegistryEvidenceRevoked"
 * } | {
 *   readonly kind: "RightsRegistryEvidenceAmbiguous",
 *   readonly context: RightsRegistryEvidenceContext
 * } | {
 *   readonly kind: "RightsRegistryEvidenceConflicting",
 *   readonly context?: RightsRegistryEvidenceContext
 * } | {
 *   readonly kind: "RightsRegistryMetadataPersistenceFailed"
 * } | {
 *   readonly kind: "CrawlPageLimitExceeded",
 *   readonly maximum: number
 * } | {
 *   readonly kind: "CrawlDepthLimitExceeded",
 *   readonly maximum: number
 * } | {
 *   readonly kind: "CrawlByteLimitExceeded",
 *   readonly maximum: number
 * } | {
 *   readonly kind: "CrawlDurationLimitExceeded",
 *   readonly maximumMs: number
 * } | {
 *   readonly kind: "CrawlConcurrencyLimitExceeded",
 *   readonly maximum: number
 * } | {
 *   readonly kind: "CrawlRedirectLimitExceeded",
 *   readonly maximum: number
 * } | {
 *   readonly kind: "ManualUploadRequired",
 *   readonly reason: string
 * } | {
 *   readonly kind: "UploadRightsAttestationMissing"
 * } | {
 *   readonly kind: "IngestionJobLeaseConflict"
 * } | {
 *   readonly kind: "IngestionJobNotFound"
 * } | {
 *   readonly kind: "IngestionSourceAcquisitionProhibited"
 * } | {
 *   readonly kind: "IngestionEvidenceUnavailable"
 * } | {
 *   readonly kind: "IngestionSourceDisabled"
 * } | {
 *   readonly kind: "IngestionSourceRevisionStale"
 * } | {
 *   readonly kind: "IngestionItemIdentityMissing"
 * } | {
 *   readonly kind: "IngestionItemIdentityConflict"
 * } | {
 *   readonly kind: "IngestionPersistenceFailed"
 * } | {
 *   readonly kind: "CrawlDestinationRejected",
 *   readonly reason: string
 * } | {
 *   readonly kind: "CrawlFetchUnavailable"
 * } | {
 *   readonly kind: "CrawlResponseTypeUnsupported",
 *   readonly mediaType: string
 * } | {
 *   readonly kind: "CrawlDigestUnavailable"
 * } | {
 *   readonly kind: "IngestionCursorMissing"
 * } | {
 *   readonly kind: "IngestionCursorStateConflict"
 * } | {
 *   readonly kind: "IngestionCursorVersionStale"
 * } | {
 *   readonly kind: "IngestionFrontierLimitExceeded"
 * } | {
 *   readonly kind: "IngestionCheckpointPersistenceFailed"
 * } | {
 *   readonly kind: "BrowserRunBindingInvalid"
 * } | {
 *   readonly kind: "BrowserRunConfigurationInvalid"
 * } | {
 *   readonly kind: "BrowserRunCapacityPersistenceFailed"
 * } | {
 *   readonly kind: "BrowserRunCapacityConflict"
 * } | {
 *   readonly kind: "BrowserRunDailyBudgetExceeded"
 * } | {
 *   readonly kind: "BrowserRunConcurrencyExceeded"
 * } | {
 *   readonly kind: "BrowserRunLaunchThrottled",
 *   readonly retryAt: string
 * } | {
 *   readonly kind: "BrowserRunUsageReconciliationFailed"
 * } | {
 *   readonly kind: "BrowserRunPartialStatePersistenceFailed"
 * } | {
 *   readonly kind: "BrowserRunUnavailable"
 * } | {
 *   readonly kind: "BrowserRunLaunchFailed"
 * } | {
 *   readonly kind: "BrowserRunTimedOut"
 * } | {
 *   readonly kind: "BrowserRunNavigationRejected",
 *   readonly reason: string
 * } | {
 *   readonly kind: "BrowserRunRedirectLimitExceeded"
 * } | {
 *   readonly kind: "BrowserRunPeerAddressUnavailable"
 * } | {
 *   readonly kind: "BrowserRunPeerAddressRejected"
 * } | {
 *   readonly kind: "BrowserRunResponseInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "BrowserRunExtractionLimitExceeded",
 *   readonly field: "html" | "text" | "links" | "pages" | "duration"
 * } | {
 *   readonly kind: "BrowserRunBotAccessDenied"
 * } | {
 *   readonly kind: "BrowserRunSessionCloseFailed"
 * } | {
 *   readonly kind: "SourceContentObjectWriteFailed"
 * } | {
 *   readonly kind: "SourceContentObjectCleanupFailed"
 * } | {
 *   readonly kind: "R2StorageCapacityExceeded"
 * } | {
 *   readonly kind: "R2ClassAOperationsExceeded"
 * } | {
 *   readonly kind: "R2ClassBOperationsExceeded"
 * } | {
 *   readonly kind: "R2CapacityReservationStale"
 * } | {
 *   readonly kind: "R2CapacityConflict"
 * } | {
 *   readonly kind: "R2CapacityUsageUncertain"
 * } | {
 *   readonly kind: "R2CapacityPersistenceFailed"
 * } | {
 *   readonly kind: "R2UsageReconciliationFailed"
 * } | {
 *   readonly kind: "ManualUploadCommandInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "ManualUploadSourceNotFound"
 * } | {
 *   readonly kind: "ManualUploadItemNotFound"
 * } | {
 *   readonly kind: "ManualUploadSourceItemMismatch"
 * } | {
 *   readonly kind: "ManualUploadSourceDisabled"
 * } | {
 *   readonly kind: "ManualUploadRevisionStale"
 * } | {
 *   readonly kind: "ManualUploadOwnerMismatch"
 * } | {
 *   readonly kind: "ManualUploadContentTypeUnsupported"
 * } | {
 *   readonly kind: "ManualUploadEncodingInvalid"
 * } | {
 *   readonly kind: "ManualUploadByteLimitExceeded",
 *   readonly maximum: number
 * } | {
 *   readonly kind: "ManualUploadTextLimitExceeded",
 *   readonly maximum: number
 * } | {
 *   readonly kind: "ManualUploadDigestUnavailable"
 * } | {
 *   readonly kind: "ManualUploadIdempotencyConflict"
 * } | {
 *   readonly kind: "ManualUploadPersistenceFailed"
 * } | {
 *   readonly kind: "ManualUploadEvidenceRevoked"
 * } | import("../../../acquisition/contracts.ts").Failure } SourceIngestionFailure
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
export function isNonEmptyText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value @returns {value is string} */
export function isIsoDateTime(value) {
  return isNonEmptyText(value) && Number.isFinite(Date.parse(value));
}

/** @param {unknown} value @returns {value is number} */
export function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @param {unknown} value @returns {value is string} */
export function isPublicHttpsUrl(value) {
  if (!isNonEmptyText(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.username === "" &&
    url.password === "" && url.hash === "";
}

export {};
