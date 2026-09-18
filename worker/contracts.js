// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly email: string
 * }} AccessIdentity
 */

/**
 * @typedef {{
 *   readonly sourceUrl: string,
 *   readonly requestId: string,
 *   readonly etag: string | null,
 *   readonly lastModified: string | null
 * }} RssAcquisitionCommand
 */

/**
 * @typedef {{
 *   readonly kind: "atom-id" | "atom-link" | "rss-channel-link" | "rss-guid" | "rss-link",
 *   readonly value: string,
 *   readonly canonicalUrl: string | null,
 *   readonly isPermaLink: boolean | null
 * }} FeedIdentityEvidence
 */

/**
 * @typedef {{
 *   readonly identityKey: string,
 *   readonly identityEvidence: readonly FeedIdentityEvidence[],
 *   readonly title: string,
 *   readonly canonicalUrl: string,
 *   readonly contentDigest: string,
 *   readonly publisherLabel: string,
 *   readonly publishedAt: string | null
 *   readonly podcast: null | {
 *     readonly namespaceEvidencePresent: boolean,
 *     readonly namespaceUri: string | null,
 *     readonly namespaceContractReference: string | null,
 *     readonly feedLanguageSelector: string | null,
 *     readonly transcripts: readonly {
 *       readonly url: string,
 *       readonly type: string,
 *       readonly language: string | null,
 *       readonly languageSource: "transcript" | "feed" | null,
 *       readonly rel: string | null,
 *       readonly sourceIndex: number
 *     }[],
 *     readonly enclosure: {
 *       readonly url: string,
 *       readonly type: string,
 *       readonly declaredLength: number
 *     }
 *   }
 * }} NormalizedFeedItem
 */

/**
 * @typedef {{
 *   readonly identityKey: string,
 *   readonly identityEvidence: readonly FeedIdentityEvidence[],
 *   readonly title: string,
 *   readonly canonicalUrl: string,
 *   readonly publisherLabel: string,
 *   readonly publishedAt: string | null
 * }} NormalizedFeedSource
 */

/**
 * @typedef {{
 *   readonly status: "acquired",
 *   readonly submittedUrl: string,
 *   readonly canonicalUrl: string,
 *   readonly mediaType: string,
 *   readonly byteCount: number,
 *   readonly digest: string,
 *   readonly retrievedAt: string,
 *   readonly etag: string | null,
 *   readonly lastModified: string | null,
 *   readonly redirects: readonly string[],
 *   readonly feed: {
 *     readonly format: "rss2" | "atom",
 *     readonly source: NormalizedFeedSource,
 *     readonly items: readonly NormalizedFeedItem[]
 *   }
 * } | {
 *   readonly status: "not-modified",
 *   readonly submittedUrl: string,
 *   readonly canonicalUrl: string,
 *   readonly retrievedAt: string,
 *   readonly redirects: readonly string[]
 * }} RssAcquisitionResult
 */

/**
 * @typedef {(
 *   { readonly kind: "DiscoveryCommandInvalid", readonly field: string }
   *   | { readonly kind: "DiscoveryClientUnauthenticated" }
   *   | { readonly kind: "DiscoveryClientUnauthorized" }
 *   | { readonly kind: "DiscoveryAuthenticationFailed" }
 *   | { readonly kind: "DiscoveryRequestLoggingFailed", readonly causeKind: "DiscoveryRequestLogEntryInvalid" | "DiscoveryRequestLogTimestampInvalid" | "DiscoveryRequestLoggerResultInvalid" | "DiscoveryRequestLoggerThrew" }
 *   | { readonly kind: "DiscoveryAccessTokenMissing" }
 *   | { readonly kind: "DiscoveryAccessTokenInvalid" }
 *   | { readonly kind: "DiscoveryAccessAudienceMismatch" }
 *   | { readonly kind: "DiscoveryAccessIdentityUnmapped" }
 *   | { readonly kind: "DiscoveryOriginRejected" }
 *   | { readonly kind: "DiscoveryRequestTooLarge" }
 *   | { readonly kind: "DiscoverySourceUrlInvalid" }
 *   | { readonly kind: "DiscoverySourceProtocolUnsupported", readonly protocol: string }
 *   | { readonly kind: "DiscoveryDestinationForbidden", readonly reason: string }
 *   | { readonly kind: "DiscoveryRedirectRejected", readonly location: string }
 *   | { readonly kind: "DiscoveryRedirectLimitExceeded" }
 *   | { readonly kind: "DiscoveryFetchUnavailable" }
 *   | { readonly kind: "DiscoveryFetchTimedOut" }
 *   | { readonly kind: "DiscoveryHttpRejected", readonly status: number }
 *   | { readonly kind: "DiscoveryMediaTypeUnsupported", readonly mediaType: string }
 *   | { readonly kind: "DiscoveryPayloadTooLarge", readonly maximumBytes: number }
 *   | { readonly kind: "DiscoveryDigestUnavailable" }
 *   | { readonly kind: "DiscoveryDoctypeForbidden" }
 *   | { readonly kind: "DiscoveryEntityForbidden" }
 *   | { readonly kind: "DiscoveryXIncludeForbidden" }
 *   | { readonly kind: "DiscoveryStylesheetForbidden" }
 *   | { readonly kind: "DiscoveryXmlMalformed" }
 *   | { readonly kind: "DiscoveryFormatUnsupported" }
 *   | { readonly kind: "DiscoveryLimitExceeded", readonly limit: "depth" | "items" | "attributes" | "text" | "podcast-transcripts" }
 *   | { readonly kind: "DiscoveryFeedMetadataMissing", readonly field: string }
 *   | { readonly kind: "DiscoveryItemMalformed", readonly itemIndex: number, readonly field: string }
 *   | { readonly kind: "DiscoveryItemIdentityMissing", readonly itemIndex: number }
 *   | { readonly kind: "DiscoveryIdentityAmbiguous", readonly itemIndex: number | null }
 *   | { readonly kind: "DiscoveryIdentityConflict", readonly itemIndex: number }
 *   | { readonly kind: "DiscoveryPodcastMetadataMalformed", readonly itemIndex: number, readonly field: string }
 *   | { readonly kind: "DiscoveryPodcastTranscriptReferenceInvalid", readonly itemIndex: number, readonly transcriptIndex: number, readonly field: string }
 *   | { readonly kind: "DiscoveryPodcastEnclosureReferenceInvalid", readonly itemIndex: number, readonly field: string }
 *   | { readonly kind: "YouTubeCredentialMissing" }
 *   | { readonly kind: "YouTubeCredentialRejected" }
 *   | { readonly kind: "YouTubeCredentialRefreshUnavailable" }
 *   | { readonly kind: "YouTubeSearchQuotaExceeded" }
 *   | { readonly kind: "YouTubeGeneralQuotaExceeded" }
 *   | { readonly kind: "YouTubeProviderQuotaExceeded" }
 *   | { readonly kind: "YouTubeUpstreamUnavailable" }
 *   | { readonly kind: "YouTubeQuotaReservationInvalid", readonly field: "quotaDay" | "units" }
 *   | { readonly kind: "YouTubeResponseInvalid" }
 *   | { readonly kind: "YouTubeVideoUnavailable", readonly videoId: string }
 *   | { readonly kind: "YouTubeEmbedDisabled", readonly videoId: string }
 *   | { readonly kind: "YouTubeMadeForKidsUnknown", readonly videoId: string }
 * )} WorkerFailure
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Result<RssAcquisitionCommand, WorkerFailure>}
 */
export function validateRssAcquisitionCommand(value) {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: { kind: "DiscoveryCommandInvalid", field: "body" },
    };
  }
  if (typeof value.sourceUrl !== "string" || value.sourceUrl.trim() === "") {
    return {
      ok: false,
      error: { kind: "DiscoveryCommandInvalid", field: "sourceUrl" },
    };
  }
  if (typeof value.requestId !== "string" || value.requestId.trim() === "") {
    return {
      ok: false,
      error: { kind: "DiscoveryCommandInvalid", field: "requestId" },
    };
  }
  const etag = value.etag === undefined || value.etag === null
    ? null
    : typeof value.etag === "string" && value.etag.trim() !== ""
    ? value.etag
    : undefined;
  if (etag === undefined) {
    return {
      ok: false,
      error: { kind: "DiscoveryCommandInvalid", field: "etag" },
    };
  }
  const lastModified =
    value.lastModified === undefined || value.lastModified === null
      ? null
      : typeof value.lastModified === "string" &&
          value.lastModified.trim() !== ""
      ? value.lastModified
      : undefined;
  if (lastModified === undefined) {
    return {
      ok: false,
      error: { kind: "DiscoveryCommandInvalid", field: "lastModified" },
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      sourceUrl: value.sourceUrl,
      requestId: value.requestId,
      etag,
      lastModified,
    }),
  };
}

export {};
