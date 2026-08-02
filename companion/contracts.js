// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly jobId: string,
 *   readonly ownerId: string,
 *   readonly source: {
 *     readonly provenance: string,
 *     readonly provenanceId: string,
 *     readonly feedUrl: string,
 *     readonly canonicalItemUrl: string,
 *     readonly enclosureUrl: string,
 *   },
 *   readonly rights: {
 *     readonly evidenceId: string,
 *     readonly transcriptionPermitted: boolean,
 *     readonly derivedTranscriptPermitted: boolean,
 *     readonly excerptPermitted: boolean,
 *   },
 *   readonly media: {
 *     readonly declaredBytes: number,
 *     readonly declaredDurationSeconds: number,
 *     readonly declaredMediaType: string,
 *   },
 *   readonly timeoutMs: number,
 * }} CompanionCommand
 */

/**
 * @typedef {{ readonly token: string }} PrivateTemporaryFile
 *
 * @typedef {{ readonly actualBytes: number }} DownloadedMedia
 *
 * @typedef {{ readonly transcript: string, readonly excerpt: string | null }} TranscriptionOutput
 *
 * @typedef {{ readonly uploadId: string }} UploadedDerivatives
 */

/**
 * @typedef {{
 *   readonly uploadId: string,
 *   readonly completedAt: string,
 *   readonly temporaryMediaDeleted: true,
 * }} CompanionCompletion
 */

/**
 * @typedef {{ readonly kind: "CompanionCommandInvalid", readonly field: string }
 * | { readonly kind: "CompanionSourceForbidden", readonly reason: "youtube-provenance" | "youtube-url" }
 * | { readonly kind: "CompanionPermissionMissing", readonly permission: "transcription" | "derived-transcript" }
 * | { readonly kind: "CompanionEnclosureUrlInvalid" }
 * | { readonly kind: "CompanionDeclaredBytesExceeded", readonly declaredBytes: number, readonly maximumBytes: number }
 * | { readonly kind: "CompanionDeclaredDurationExceeded", readonly declaredDurationSeconds: number, readonly maximumDurationSeconds: number }
 * | { readonly kind: "CompanionDownloadedBytesExceeded", readonly actualBytes: number, readonly maximumBytes: number }
 * | { readonly kind: "CompanionCancelled", readonly stage: CompanionStage }
 * | { readonly kind: "CompanionTimedOut", readonly stage: CompanionStage }
 * | { readonly kind: "CompanionTemporaryStorageFailed" }
 * | { readonly kind: "CompanionDownloadFailed" }
 * | { readonly kind: "CompanionMediaSignatureRejected" }
 * | { readonly kind: "CompanionTranscriptionFailed" }
 * | { readonly kind: "CompanionTranscriptInvalid" }
 * | { readonly kind: "CompanionUploadFailed" }
 * | { readonly kind: "CompanionRecoveryLimitExceeded", readonly maximumRecords: number }
 * | { readonly kind: "CompanionDependencyRejected", readonly stage: CompanionStage }
 * | { readonly kind: "TemporaryMediaDeletionFailed", readonly precedingFailureKind: string | null }} CompanionFailure
 */

/** @typedef {"temporary-storage" | "download" | "signature" | "transcription" | "upload" | "orchestration"} CompanionStage */

/**
 * @typedef {{
 *   readonly maximumBytes: number,
 *   readonly maximumDurationSeconds: number,
 *   readonly maximumTimeoutMs: number,
 * }} CompanionLimits
 */

/**
 * @typedef {{
 *   readonly now: () => number,
 *   readonly wait: (delayMs: number, signal: AbortSignal) => Promise<"elapsed" | "cancelled">,
 * }} CompanionClock
 */

/**
 * @typedef {{
 *   readonly isYouTubeUrl: (url: URL) => boolean,
 * }} CompanionSourcePolicy
 */

/**
 * Operational ports must stop work and settle their returned promise after
 * their supplied AbortSignal is aborted.
 *
 * @typedef {{
 *   readonly createPrivate: (jobId: string, signal: AbortSignal) => Promise<Result<PrivateTemporaryFile, { readonly kind: "TemporaryStorageUnavailable" }>>,
 * }} CompanionTemporaryStorage
 */

/**
 * @typedef {{
 *   readonly enclosureUrl: string,
 *   readonly destination: PrivateTemporaryFile,
 *   readonly maximumBytes: number,
 *   readonly signal: AbortSignal,
 * }} CompanionDownloadRequest
 */

/**
 * @typedef {{
 *   readonly download: (request: CompanionDownloadRequest) => Promise<Result<DownloadedMedia, { readonly kind: "DownloadUnavailable" | "DownloadRejected" }>>,
 * }} CompanionDownloader
 */

/**
 * @typedef {{
 *   readonly validate: (request: {
 *     readonly file: PrivateTemporaryFile,
 *     readonly declaredMediaType: string,
 *     readonly signal: AbortSignal,
 *   }) => Promise<Result<true, { readonly kind: "SignatureUnavailable" | "SignatureMismatch" }>>,
 * }} CompanionSignatureValidator
 */

/**
 * @typedef {{
 *   readonly transcribe: (request: {
 *     readonly file: PrivateTemporaryFile,
 *     readonly signal: AbortSignal,
 *   }) => Promise<Result<TranscriptionOutput, { readonly kind: "TranscriptionUnavailable" | "TranscriptionRejected" }>>,
 * }} CompanionTranscriber
 */

/**
 * @typedef {{
 *   readonly jobId: string,
 *   readonly ownerId: string,
 *   readonly sourceProvenanceId: string,
 *   readonly rightsEvidenceId: string,
 *   readonly transcript: string,
 *   readonly excerpt: string | null,
 *   readonly signal: AbortSignal,
 * }} CompanionUploadRequest
 */

/**
 * @typedef {{
 *   readonly upload: (request: CompanionUploadRequest) => Promise<Result<UploadedDerivatives, { readonly kind: "UploadUnavailable" | "UploadRejected" }>>,
 * }} CompanionUploader
 */

/**
 * @typedef {{
 *   readonly remove: (file: PrivateTemporaryFile) => Promise<Result<true, { readonly kind: "TemporaryDeletionUnavailable" }>>,
 * }} CompanionTemporaryDelete
 */

/**
 * Restart recovery may enumerate only records created in the companion's
 * private job-temporary namespace. Filesystem-wide enumeration is not a port.
 *
 * @typedef {{
 *   readonly privateJobTemporaryStorage: {
 *     readonly listPrivateJobFiles: () => Promise<Result<readonly PrivateTemporaryFile[], { readonly kind: "TemporaryStorageUnavailable" }>>,
 *   },
 *   readonly temporaryDelete: CompanionTemporaryDelete,
 * }} CompanionRecoveryDependencies
 */

/**
 * @typedef {{
 *   readonly limits: CompanionLimits,
 *   readonly clock: CompanionClock,
 *   readonly sourcePolicy: CompanionSourcePolicy,
 *   readonly temporaryStorage: CompanionTemporaryStorage,
 *   readonly downloader: CompanionDownloader,
 *   readonly signatureValidator: CompanionSignatureValidator,
 *   readonly transcriber: CompanionTranscriber,
 *   readonly uploader: CompanionUploader,
 *   readonly temporaryDelete: CompanionTemporaryDelete,
 * }} CompanionDependencies
 */

/**
 * Validate an untrusted companion command without performing side effects.
 *
 * @param {unknown} value
 * @returns {Result<CompanionCommand, CompanionFailure>}
 */
export function validateCompanionCommand(value) {
  if (!isRecord(value)) return invalid("command");
  const source = value.source;
  const rights = value.rights;
  const media = value.media;
  if (!nonBlank(value.jobId)) return invalid("jobId");
  if (!nonBlank(value.ownerId)) return invalid("ownerId");
  if (!isRecord(source)) return invalid("source");
  for (
    const field of [
      "provenance",
      "provenanceId",
      "feedUrl",
      "canonicalItemUrl",
      "enclosureUrl",
    ]
  ) {
    if (!nonBlank(source[field])) return invalid(`source.${field}`);
  }
  if (!isRecord(rights)) return invalid("rights");
  if (!nonBlank(rights.evidenceId)) return invalid("rights.evidenceId");
  for (
    const field of [
      "transcriptionPermitted",
      "derivedTranscriptPermitted",
      "excerptPermitted",
    ]
  ) {
    if (typeof rights[field] !== "boolean") return invalid(`rights.${field}`);
  }
  if (!isRecord(media)) return invalid("media");
  if (!positiveInteger(media.declaredBytes)) {
    return invalid("media.declaredBytes");
  }
  if (!positiveNumber(media.declaredDurationSeconds)) {
    return invalid("media.declaredDurationSeconds");
  }
  if (!nonBlank(media.declaredMediaType)) {
    return invalid("media.declaredMediaType");
  }
  if (!positiveInteger(value.timeoutMs)) return invalid("timeoutMs");

  return {
    ok: true,
    value: /** @type {CompanionCommand} */ (value),
  };
}

/** @param {string} field @returns {Result<never, CompanionFailure>} */
function invalid(field) {
  return { ok: false, error: { kind: "CompanionCommandInvalid", field } };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function nonBlank(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @param {unknown} value */
function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
