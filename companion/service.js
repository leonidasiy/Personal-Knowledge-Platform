// @ts-check

import { validateCompanionCommand } from "./contracts.js";

/** @import { CompanionCommand, CompanionCompletion, CompanionDependencies, CompanionFailure, CompanionRecoveryDependencies, CompanionStage, PrivateTemporaryFile, Result } from "./contracts.js" */

/**
 * Execute one authorized local transcription job.
 *
 * @param {unknown} rawCommand
 * @param {AbortSignal} signal
 * @param {CompanionDependencies} dependencies
 * @returns {Promise<Result<CompanionCompletion, CompanionFailure>>}
 */
export async function executeCompanionJob(rawCommand, signal, dependencies) {
  const validated = validateCompanionCommand(rawCommand);
  if (!validated.ok) return validated;
  const command = validated.value;
  const preflight = validatePreflight(command, dependencies);
  if (!preflight.ok) return preflight;
  if (signal.aborted) {
    return cancelled("temporary-storage");
  }

  const deadline = dependencies.clock.now() + command.timeoutMs;
  const temporary = await runStage(
    "temporary-storage",
    signal,
    deadline,
    dependencies,
    (stageSignal) =>
      dependencies.temporaryStorage.createPrivate(
        command.jobId,
        stageSignal,
      ),
  );
  if (!temporary.ok) {
    return mapStageFailure(temporary.error, "CompanionTemporaryStorageFailed");
  }

  /** @type {Result<CompanionCompletion, CompanionFailure>} */
  let outcome;
  try {
    outcome = await processTemporaryMedia(
      command,
      temporary.value,
      signal,
      deadline,
      dependencies,
    );
  } catch (error) {
    if (error instanceof Error) {
      outcome = {
        ok: false,
        error: {
          kind: "CompanionDependencyRejected",
          stage: "orchestration",
        },
      };
    } else {
      throw error;
    }
  }

  /** @type {Result<true, { readonly kind: "TemporaryDeletionUnavailable" }> | null} */
  let deleted = null;
  try {
    deleted = await dependencies.temporaryDelete.remove(temporary.value);
  } catch (error) {
    if (error instanceof Error) {
      deleted = {
        ok: false,
        error: { kind: "TemporaryDeletionUnavailable" },
      };
    } else {
      throw error;
    }
  }
  if (!deleted.ok) {
    return {
      ok: false,
      error: {
        kind: "TemporaryMediaDeletionFailed",
        precedingFailureKind: outcome.ok ? null : outcome.error.kind,
      },
    };
  }
  return outcome;
}

/**
 * Startup gate for crash leftovers. Callers must not pull new work until this
 * returns success; a deletion failure is therefore blocking and retryable.
 *
 * @param {{ readonly maximumRecords: number }} configuration
 * @param {CompanionRecoveryDependencies} dependencies
 * @returns {Promise<Result<{ readonly deletedCount: number }, CompanionFailure>>}
 */
export async function recoverCompanionTemporaryMedia(configuration, dependencies) {
  if (!Number.isSafeInteger(configuration.maximumRecords) || configuration.maximumRecords < 1 ||
    typeof dependencies.privateJobTemporaryStorage?.listPrivateJobFiles !== "function" ||
    typeof dependencies.temporaryDelete?.remove !== "function") {
    throw new TypeError("Companion recovery configuration is invalid.");
  }
  /** @type {Result<readonly PrivateTemporaryFile[], { readonly kind: "TemporaryStorageUnavailable" }>} */
  let listed;
  try {
    listed = await dependencies.privateJobTemporaryStorage.listPrivateJobFiles();
  } catch (error) {
    if (error instanceof Error) return { ok: false, error: { kind: "CompanionTemporaryStorageFailed" } };
    throw error;
  }
  if (!listed.ok) return { ok: false, error: { kind: "CompanionTemporaryStorageFailed" } };
  if (listed.value.length > configuration.maximumRecords) {
    return { ok: false, error: { kind: "CompanionRecoveryLimitExceeded", maximumRecords: configuration.maximumRecords } };
  }
  const tokens = new Set();
  for (const file of listed.value) {
    if (typeof file !== "object" || file === null || Object.keys(file).length !== 1 ||
      typeof file.token !== "string" || file.token.trim() === "" || tokens.has(file.token)) {
      return { ok: false, error: { kind: "CompanionTemporaryStorageFailed" } };
    }
    tokens.add(file.token);
  }
  let deletionFailed = false;
  for (const file of listed.value) {
    try {
      const deleted = await dependencies.temporaryDelete.remove(file);
      if (!deleted.ok) deletionFailed = true;
    } catch (error) {
      if (error instanceof Error) deletionFailed = true;
      else throw error;
    }
  }
  return deletionFailed
    ? { ok: false, error: { kind: "TemporaryMediaDeletionFailed", precedingFailureKind: "restart-recovery" } }
    : { ok: true, value: { deletedCount: listed.value.length } };
}

/**
 * @param {CompanionCommand} command
 * @param {CompanionDependencies} dependencies
 * @returns {Result<true, CompanionFailure>}
 */
function validatePreflight(command, dependencies) {
  const provenance = command.source.provenance.trim().toLowerCase();
  if (provenance === "youtube") {
    return {
      ok: false,
      error: {
        kind: "CompanionSourceForbidden",
        reason: "youtube-provenance",
      },
    };
  }
  if (provenance !== "rss-enclosure") {
    return {
      ok: false,
      error: { kind: "CompanionCommandInvalid", field: "source.provenance" },
    };
  }

  /** @type {URL[]} */
  const sourceUrls = [];
  for (
    const value of [
      command.source.feedUrl,
      command.source.canonicalItemUrl,
      command.source.enclosureUrl,
    ]
  ) {
    try {
      sourceUrls.push(new URL(value));
    } catch (error) {
      if (error instanceof TypeError) {
        return { ok: false, error: { kind: "CompanionEnclosureUrlInvalid" } };
      }
      throw error;
    }
  }
  if (sourceUrls.some((url) => dependencies.sourcePolicy.isYouTubeUrl(url))) {
    return {
      ok: false,
      error: { kind: "CompanionSourceForbidden", reason: "youtube-url" },
    };
  }
  const enclosureUrl = sourceUrls[2];
  if (
    enclosureUrl.protocol !== "https:" ||
    enclosureUrl.username !== "" ||
    enclosureUrl.password !== ""
  ) {
    return { ok: false, error: { kind: "CompanionEnclosureUrlInvalid" } };
  }
  if (!command.rights.transcriptionPermitted) {
    return {
      ok: false,
      error: {
        kind: "CompanionPermissionMissing",
        permission: "transcription",
      },
    };
  }
  if (!command.rights.derivedTranscriptPermitted) {
    return {
      ok: false,
      error: {
        kind: "CompanionPermissionMissing",
        permission: "derived-transcript",
      },
    };
  }
  if (command.media.declaredBytes > dependencies.limits.maximumBytes) {
    return {
      ok: false,
      error: {
        kind: "CompanionDeclaredBytesExceeded",
        declaredBytes: command.media.declaredBytes,
        maximumBytes: dependencies.limits.maximumBytes,
      },
    };
  }
  if (
    command.media.declaredDurationSeconds >
      dependencies.limits.maximumDurationSeconds
  ) {
    return {
      ok: false,
      error: {
        kind: "CompanionDeclaredDurationExceeded",
        declaredDurationSeconds: command.media.declaredDurationSeconds,
        maximumDurationSeconds: dependencies.limits.maximumDurationSeconds,
      },
    };
  }
  if (command.timeoutMs > dependencies.limits.maximumTimeoutMs) {
    return {
      ok: false,
      error: { kind: "CompanionCommandInvalid", field: "timeoutMs" },
    };
  }
  return { ok: true, value: true };
}

/**
 * @param {CompanionCommand} command
 * @param {PrivateTemporaryFile} temporary
 * @param {AbortSignal} signal
 * @param {number} deadline
 * @param {CompanionDependencies} dependencies
 * @returns {Promise<Result<CompanionCompletion, CompanionFailure>>}
 */
async function processTemporaryMedia(
  command,
  temporary,
  signal,
  deadline,
  dependencies,
) {
  const downloaded = await runStage(
    "download",
    signal,
    deadline,
    dependencies,
    (stageSignal) =>
      dependencies.downloader.download({
        enclosureUrl: command.source.enclosureUrl,
        destination: temporary,
        maximumBytes: dependencies.limits.maximumBytes,
        signal: stageSignal,
      }),
  );
  if (!downloaded.ok) {
    return mapStageFailure(downloaded.error, "CompanionDownloadFailed");
  }
  if (
    !Number.isInteger(downloaded.value.actualBytes) ||
    downloaded.value.actualBytes < 0
  ) {
    return { ok: false, error: { kind: "CompanionDownloadFailed" } };
  }
  if (downloaded.value.actualBytes > dependencies.limits.maximumBytes) {
    return {
      ok: false,
      error: {
        kind: "CompanionDownloadedBytesExceeded",
        actualBytes: downloaded.value.actualBytes,
        maximumBytes: dependencies.limits.maximumBytes,
      },
    };
  }

  const signature = await runStage(
    "signature",
    signal,
    deadline,
    dependencies,
    (stageSignal) =>
      dependencies.signatureValidator.validate({
        file: temporary,
        declaredMediaType: command.media.declaredMediaType,
        signal: stageSignal,
      }),
  );
  if (!signature.ok) {
    return mapStageFailure(
      signature.error,
      "CompanionMediaSignatureRejected",
    );
  }

  const transcription = await runStage(
    "transcription",
    signal,
    deadline,
    dependencies,
    (stageSignal) =>
      dependencies.transcriber.transcribe({
        file: temporary,
        signal: stageSignal,
      }),
  );
  if (!transcription.ok) {
    return mapStageFailure(
      transcription.error,
      "CompanionTranscriptionFailed",
    );
  }
  if (
    typeof transcription.value.transcript !== "string" ||
    (transcription.value.excerpt !== null &&
      typeof transcription.value.excerpt !== "string")
  ) {
    return { ok: false, error: { kind: "CompanionTranscriptInvalid" } };
  }
  const transcript = transcription.value.transcript.trim();
  const excerpt = transcription.value.excerpt?.trim() ?? null;
  if (transcript === "" || excerpt === "") {
    return { ok: false, error: { kind: "CompanionTranscriptInvalid" } };
  }

  const uploaded = await runStage(
    "upload",
    signal,
    deadline,
    dependencies,
    (stageSignal) =>
      dependencies.uploader.upload({
        jobId: command.jobId,
        ownerId: command.ownerId,
        sourceProvenanceId: command.source.provenanceId,
        rightsEvidenceId: command.rights.evidenceId,
        transcript,
        excerpt: command.rights.excerptPermitted ? excerpt : null,
        signal: stageSignal,
      }),
  );
  if (!uploaded.ok) {
    return mapStageFailure(uploaded.error, "CompanionUploadFailed");
  }
  if (uploaded.value.uploadId.trim() === "") {
    return { ok: false, error: { kind: "CompanionUploadFailed" } };
  }
  return {
    ok: true,
    value: {
      uploadId: uploaded.value.uploadId,
      completedAt: new Date(dependencies.clock.now()).toISOString(),
      temporaryMediaDeleted: true,
    },
  };
}

/**
 * @template T
 * @template E
 * @param {CompanionStage} stage
 * @param {AbortSignal} signal
 * @param {number} deadline
 * @param {CompanionDependencies} dependencies
 * @param {(signal: AbortSignal) => Promise<Result<T, E>>} operation
 * @returns {Promise<Result<T, E | CompanionFailure>>}
 */
async function runStage(
  stage,
  signal,
  deadline,
  dependencies,
  operation,
) {
  if (signal.aborted) return cancelled(stage);
  const remaining = deadline - dependencies.clock.now();
  if (remaining <= 0) return timedOut(stage);

  const controller = new AbortController();
  const forwardCancellation = () => controller.abort();
  signal.addEventListener("abort", forwardCancellation, { once: true });
  const operationResult = operation(controller.signal).then(
    (result) => ({ kind: /** @type {const} */ ("operation"), result }),
    () => ({
      kind: /** @type {const} */ ("rejected"),
      result: /** @type {const} */ ({
        ok: false,
        error: {
          kind: /** @type {const} */ ("CompanionDependencyRejected"),
          stage,
        },
      }),
    }),
  );
  const clockResult = dependencies.clock.wait(remaining, controller.signal)
    .then((result) => ({ kind: /** @type {const} */ ("clock"), result }));
  const first = await Promise.race([operationResult, clockResult]);
  if (first.kind === "operation" || first.kind === "rejected") {
    controller.abort();
    signal.removeEventListener("abort", forwardCancellation);
    return first.result;
  }
  controller.abort();
  await operationResult;
  signal.removeEventListener("abort", forwardCancellation);
  return signal.aborted ? cancelled(stage) : timedOut(stage);
}

/**
 * @template T
 * @param {CompanionFailure | { readonly kind: string }} failure
 * @param {"CompanionTemporaryStorageFailed" | "CompanionDownloadFailed" | "CompanionMediaSignatureRejected" | "CompanionTranscriptionFailed" | "CompanionUploadFailed"} mappedKind
 * @returns {Result<T, CompanionFailure>}
 */
function mapStageFailure(failure, mappedKind) {
  if (
    failure.kind === "CompanionCancelled" ||
    failure.kind === "CompanionTimedOut" ||
    failure.kind === "CompanionDependencyRejected"
  ) {
    return {
      ok: false,
      error: /** @type {CompanionFailure} */ (failure),
    };
  }
  return { ok: false, error: { kind: mappedKind } };
}

/** @param {CompanionStage} stage @returns {Result<never, CompanionFailure>} */
function cancelled(stage) {
  return { ok: false, error: { kind: "CompanionCancelled", stage } };
}

/** @param {CompanionStage} stage @returns {Result<never, CompanionFailure>} */
function timedOut(stage) {
  return { ok: false, error: { kind: "CompanionTimedOut", stage } };
}
