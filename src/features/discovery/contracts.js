// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/** @typedef {"allowed" | "denied" | "unknown"} RightsState */
/** @typedef {"save-link" | "save-excerpt" | "defer" | "reject"} TriageKind */
/** @typedef {"publisher-transcript" | "learner-notes" | "user-original"} EvidenceSourceKind */

/**
 * @typedef {{
 *   readonly reference: string,
 *   readonly provenance: string
 * }} IdentityEvidence
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly revision: number,
 *   readonly authoritativeIdentity: string,
 *   readonly identityEvidence: readonly IdentityEvidence[],
 *   readonly adapterId: string,
 *   readonly adapterVersion: string,
 *   readonly submittedUrl: string,
 *   readonly canonicalUrl: string,
 *   readonly state: "enabled" | "disabled" | "deleted",
 *   readonly idempotencyKey: string,
 *   readonly occurredAt: string
 * }} DiscoverySourceRegistration
 */

/**
 * @typedef {{
 *   readonly method: string,
 *   readonly acquiredAt: string,
 *   readonly byteCount: number,
 *   readonly digest: string,
 *   readonly mediaType: string,
 *   readonly submittedUrl: string,
 *   readonly canonicalUrl: string,
 *   readonly sourceLocator: string
 * }} RetrievalProvenance
 */

/**
 * @typedef {{
 *   readonly status: "established" | "missing" | "ambiguous" | "conflicting",
 *   readonly key: string | null,
 *   readonly evidence: readonly IdentityEvidence[]
 * }} ParsedIdentity
 */

/**
 * @typedef {{
 *   readonly identity: ParsedIdentity,
 *   readonly title: string,
 *   readonly canonicalUrl: string,
 *   readonly contentDigest: string,
 *   readonly publisherLabel: string | null,
 *   readonly publishedAt: string | null,
 *   readonly boundedExcerpt: string | null
 * }} ParsedDiscoveryItem
 */

/**
 * @typedef {{
 *   readonly format: string,
 *   readonly parserVersion: string,
 *   readonly sourceIdentityEvidence: readonly IdentityEvidence[],
 *   readonly items: readonly ParsedDiscoveryItem[]
 * }} ParsedDiscoveryDocument
 */

/**
 * @typedef {{
 *   parse(document: unknown, context: {
 *     readonly ownerId: string,
 *     readonly sourceId: string,
 *     readonly adapterId: string,
 *     readonly adapterVersion: string,
 *     readonly provenance: RetrievalProvenance
 *   }): Promise<Result<ParsedDiscoveryDocument, DiscoveryFailure>>
 * }} DiscoveryDocumentParser
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly authoritativeIdentity: string,
 *   readonly identityEvidence: readonly IdentityEvidence[],
 *   readonly version: number,
 *   readonly title: string,
 *   readonly canonicalUrl: string,
 *   readonly contentDigest: string,
 *   readonly publisherLabel: string | null,
 *   readonly publishedAt: string | null,
 *   readonly boundedExcerpt: string | null,
 *   readonly provenance: RetrievalProvenance,
 *   readonly parserVersion: string,
 *   readonly observedAt: string
 * }} DiscoveredItemVersion
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly itemId: string,
 *   readonly itemVersion: number,
 *   readonly capability: string,
 *   readonly state: RightsState,
 *   readonly basis: string,
 *   readonly attribution: string | null,
 *   readonly assessedAt: string,
 *   readonly expiresAt: string | null,
 *   readonly idempotencyKey: string
 * }} RightsAssessment
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly itemId: string,
 *   readonly itemVersion: number,
 *   readonly decision: TriageKind,
 *   readonly expectedDecisionRevision: number,
 *   readonly decisionRevision: number,
 *   readonly decidedAt: string,
 *   readonly idempotencyKey: string
 * }} DiscoveryTriageDecision
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly itemId: string,
 *   readonly itemVersion: number,
 *   readonly evidenceId: string,
 *   readonly evidenceContentVersion: number,
 *   readonly sourceKind: EvidenceSourceKind,
 *   readonly acquisitionMethod: string,
 *   readonly retentionPolicy: string,
 *   readonly rightsAssessmentIds: readonly string[],
 *   readonly sourceAnchors: readonly string[],
 *   readonly associatedAt: string,
 *   readonly idempotencyKey: string
 * }} DiscoveryEvidenceAssociation
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly documentDigest: string,
 *   readonly itemVersions: readonly DiscoveredItemVersion[],
 *   readonly idempotencyKey: string,
 *   readonly importedAt: string,
 *   readonly replayed: boolean
 * }} DiscoveryImportResult
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly kind: "discovery-inbox",
 *   readonly revision: number,
 *   readonly offset: number,
 *   readonly limit: number
 * }} DiscoveryPageCursor
 */

/**
 * @typedef {{
 *   encode(cursor: DiscoveryPageCursor): Result<string, DiscoveryFailure>,
 *   decode(cursor: string): Result<unknown, DiscoveryFailure>
 * }} DiscoveryCursorCodec
 */

/**
 * @typedef {{ readonly kind: "DiscoveryCommandInvalid", readonly field: string }
 * | { readonly kind: "DiscoveryAdapterUnknown", readonly adapterId: string }
 * | { readonly kind: "DiscoverySourceUrlInvalid", readonly field: string }
 * | { readonly kind: "DiscoverySourceProtocolUnsupported", readonly protocol: string }
 * | { readonly kind: "DiscoverySourceOwnerMismatch", readonly ownerId: string }
 * | { readonly kind: "DiscoverySourceDuplicate", readonly authoritativeIdentity: string }
 * | { readonly kind: "DiscoveryPayloadTooLarge", readonly maximum: number, readonly actual: number }
 * | { readonly kind: "DiscoveryDoctypeForbidden" }
 * | { readonly kind: "DiscoveryEntityForbidden" }
 * | { readonly kind: "DiscoveryXIncludeForbidden" }
 * | { readonly kind: "DiscoveryStylesheetForbidden" }
 * | { readonly kind: "DiscoveryParserUnavailable" }
 * | { readonly kind: "DiscoveryXmlMalformed" }
 * | { readonly kind: "DiscoveryFormatUnsupported" }
 * | { readonly kind: "DiscoveryLimitExceeded", readonly limit: "depth" | "items" | "attributes" | "text" }
 * | { readonly kind: "DiscoveryFeedMetadataMissing", readonly field: string }
 * | { readonly kind: "DiscoveryItemMalformed", readonly field: string }
 * | { readonly kind: "DiscoveryItemIdentityMissing", readonly itemIndex: number }
 * | { readonly kind: "DiscoveryIdentityAmbiguous", readonly itemIndex: number }
 * | { readonly kind: "DiscoveryIdentityConflict", readonly itemIndex: number }
 * | { readonly kind: "DiscoveryVersionConflict", readonly itemId: string }
 * | { readonly kind: "DiscoveryRightsUnknown", readonly itemId: string, readonly capability: string }
 * | { readonly kind: "DiscoveryRightsConflict", readonly itemId: string, readonly capability: string }
 * | { readonly kind: "DiscoveryItemVersionUnknown", readonly itemId: string, readonly version: number }
 * | { readonly kind: "DiscoveryTriageStale", readonly itemId: string, readonly expected: number, readonly actual: number }
 * | { readonly kind: "DiscoveryTriageConflict", readonly itemId: string }
 * | { readonly kind: "DiscoveryBatchPersistenceFailed", readonly operation: string }
 * | { readonly kind: "DiscoveryReadFailed", readonly ownerId: string }
 * | { readonly kind: "DiscoveryPageCursorInvalid", readonly reason: string }
 * | { readonly kind: "IndependentTranscriptMissing", readonly itemId: string }
 * | { readonly kind: "TranscriptRightsUnknown", readonly itemId: string }
 * | { readonly kind: "TranscriptStorageNotPermitted", readonly itemId: string }
 * | { readonly kind: "TranscriptTransformationNotPermitted", readonly itemId: string }
 * | { readonly kind: "UserContentRightsAttestationMissing", readonly itemId: string }
 * | { readonly kind: "LocalAsrYouTubeSourceDisallowed", readonly itemId: string }
 * | { readonly kind: "QuizEvidenceUnavailable", readonly itemId: string }
 * } DiscoveryFailure
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
export function isNonEmptyText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * @param {unknown} value
 * @returns {Result<string, DiscoveryFailure>}
 */
export function validateHttpsUrl(value) {
  if (!isNonEmptyText(value) || !URL.canParse(value)) {
    return {
      ok: false,
      error: { kind: "DiscoverySourceUrlInvalid", field: "url" },
    };
  }
  const protocol = new URL(value).protocol;
  if (protocol !== "https:") {
    return {
      ok: false,
      error: { kind: "DiscoverySourceProtocolUnsupported", protocol },
    };
  }
  return { ok: true, value };
}

/**
 * @param {unknown} value
 * @returns {Result<readonly IdentityEvidence[], DiscoveryFailure>}
 */
export function validateIdentityEvidence(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      error: { kind: "DiscoveryCommandInvalid", field: "identityEvidence" },
    };
  }
  /** @type {IdentityEvidence[]} */
  const evidence = [];
  for (const entry of value) {
    if (
      !isRecord(entry) || !isNonEmptyText(entry.reference) ||
      !isNonEmptyText(entry.provenance)
    ) {
      return {
        ok: false,
        error: { kind: "DiscoveryCommandInvalid", field: "identityEvidence" },
      };
    }
    evidence.push(
      Object.freeze({
        reference: entry.reference,
        provenance: entry.provenance,
      }),
    );
  }
  return { ok: true, value: Object.freeze(evidence) };
}

export {};
