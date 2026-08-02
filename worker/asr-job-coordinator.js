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
 *   readonly model: { readonly id: string, readonly version: string },
 *   readonly timeoutMs: number,
 * }} AsrJobCommand
 */

/** @typedef {{ readonly transcript: string, readonly excerpt: string | null, readonly contentDigest: string }} AsrJobResult */
/** @typedef {{ readonly pairingId: string, readonly ownerId: string, readonly verifier: string, readonly lastSeenAt: number | null }} PairingRecord */
/** @typedef {"waiting_for_local_worker" | "leased" | "completed"} AsrJobState */
/**
 * @typedef {{
 *   readonly command: AsrJobCommand,
 *   readonly state: AsrJobState,
 *   readonly createdAt: number,
 *   readonly pairingId: string | null,
 *   readonly companionId: string | null,
 *   readonly leaseToken: string | null,
 *   readonly leaseExpiresAt: number | null,
 *   readonly result: AsrJobResult | null,
 * }} AsrJobRecord
 */

/**
 * @typedef {{
 *   readonly evidenceId: string,
 *   readonly ownerId: string,
 *   readonly transcriptionPermitted: boolean,
 *   readonly derivedTranscriptPermitted: boolean,
 *   readonly excerptPermitted: boolean,
 * }} PersistedAudioRights
 */

/**
 * @typedef {(
 *   { readonly kind: "AsrPairingCommandInvalid", readonly field: string }
 *   | { readonly kind: "AsrPairingConflict" }
 *   | { readonly kind: "AsrJobCommandInvalid", readonly field: string }
 *   | { readonly kind: "PodcastTranscriptionPermissionMissing" }
 *   | { readonly kind: "PodcastEnclosureLimitExceeded", readonly limit: "bytes" | "duration" | "timeout" }
 *   | { readonly kind: "TranscriptRetentionNotPermitted" }
 *   | { readonly kind: "DerivedCardRightsNotPermitted" }
 *   | { readonly kind: "AsrJobSourceForbidden", readonly reason: "youtube-provenance" | "youtube-url" }
 *   | { readonly kind: "AsrJobConflict" }
 *   | { readonly kind: "AsrJobUnknown" }
 *   | { readonly kind: "AsrJobLeaseConflict" }
 *   | { readonly kind: "AsrJobResultInvalid", readonly field: string }
 *   | { readonly kind: "LocalWorkerUnavailable", readonly jobId: string, readonly state: "waiting_for_local_worker" }
 *   | { readonly kind: "LocalWorkerAuthenticationFailed" }
 *   | { readonly kind: "LocalWorkerModelMismatch", readonly requiredId: string, readonly requiredVersion: string }
 *   | { readonly kind: "AsrRepositoryUnavailable" }
 *   | { readonly kind: "AsrDigestUnavailable" }
 * )} AsrCoordinatorFailure
 */

/**
 * Atomic repository operations are the deployment boundary. A durable Worker
 * implementation must preserve the same compare-and-transition semantics.
 *
 * @typedef {{
 *   readonly savePairing: (record: PairingRecord) => Result<true, AsrCoordinatorFailure>,
 *   readonly pairing: (pairingId: string) => Result<PairingRecord | null, AsrCoordinatorFailure>,
 *   readonly touchPairing: (pairingId: string, seenAt: number) => Result<true, AsrCoordinatorFailure>,
 *   readonly createJob: (record: AsrJobRecord) => Result<true, AsrCoordinatorFailure>,
 *   readonly claimNext: (request: { readonly ownerId: string, readonly pairingId: string, readonly companionId: string, readonly now: number, readonly leaseExpiresAt: number, readonly leaseToken: string }) => Result<AsrJobRecord | null, AsrCoordinatorFailure>,
 *   readonly complete: (request: { readonly ownerId: string, readonly pairingId: string, readonly companionId: string, readonly jobId: string, readonly leaseToken: string, readonly now: number, readonly result: AsrJobResult }) => Result<AsrJobRecord, AsrCoordinatorFailure>,
 *   readonly job: (ownerId: string, jobId: string) => Result<AsrJobRecord | null, AsrCoordinatorFailure>,
 * }} AsrJobRepository
 */

/**
 * @typedef {{
 *   readonly now: () => number,
 *   readonly digest: (bytes: Uint8Array) => Promise<Result<string, { readonly kind: "DigestUnavailable" }>>,
 *   readonly randomBytes: (length: number) => Uint8Array,
 *   readonly equalVerifier: (left: string, right: string) => boolean,
 *   readonly isYouTubeUrl: (url: URL) => boolean,
 *   readonly rights: { readonly find: (ownerId: string, evidenceId: string) => Result<PersistedAudioRights | null, { readonly kind: "RightsRepositoryUnavailable" }> },
 *   readonly repository: AsrJobRepository,
 * }} AsrCoordinatorDependencies
 */

export class AsrJobCoordinator {
  /** @type {AsrCoordinatorDependencies} */
  #dependencies;
  /** @type {{ readonly leaseMs: number, readonly secretBytes: number, readonly maximumBytes: number, readonly maximumDurationSeconds: number, readonly maximumTimeoutMs: number, readonly model: { readonly id: string, readonly version: string } }} */
  #configuration;

  /**
   * @param {{ readonly leaseMs: number, readonly secretBytes: number, readonly maximumBytes: number, readonly maximumDurationSeconds: number, readonly maximumTimeoutMs: number, readonly model: { readonly id: string, readonly version: string } }} configuration
   * @param {AsrCoordinatorDependencies} dependencies
   */
  constructor(configuration, dependencies) {
    if (!positiveInteger(configuration.leaseMs) || configuration.secretBytes < 32 ||
      !positiveInteger(configuration.secretBytes) || !positiveInteger(configuration.maximumBytes) ||
      !positiveNumber(configuration.maximumDurationSeconds) || !positiveInteger(configuration.maximumTimeoutMs) ||
      !isRecord(configuration.model) || !nonBlank(configuration.model.id) || !nonBlank(configuration.model.version) ||
      typeof dependencies.now !== "function" ||
      typeof dependencies.digest !== "function" || typeof dependencies.randomBytes !== "function" ||
      typeof dependencies.equalVerifier !== "function" || typeof dependencies.isYouTubeUrl !== "function") {
      throw new TypeError("ASR job coordinator configuration is invalid.");
    }
    this.#configuration = Object.freeze({
      ...configuration,
      model: Object.freeze({ ...configuration.model }),
    });
    this.#dependencies = dependencies;
  }

  /**
   * Register an app-generated secret. Only its verifier is persisted.
   * @param {unknown} raw
   * @returns {Promise<Result<{ readonly pairingId: string }, AsrCoordinatorFailure>>}
   */
  async pair(raw) {
    if (!isRecord(raw)) return pairInvalid("command");
    if (!nonBlank(raw.ownerId)) return pairInvalid("ownerId");
    if (!nonBlank(raw.pairingId)) return pairInvalid("pairingId");
    if (!(raw.secret instanceof Uint8Array) || raw.secret.byteLength < this.#configuration.secretBytes) {
      return pairInvalid("secret");
    }
    const digested = await this.#dependencies.digest(raw.secret);
    if (!digested.ok) return { ok: false, error: { kind: "AsrDigestUnavailable" } };
    const record = Object.freeze({
      pairingId: raw.pairingId,
      ownerId: raw.ownerId,
      verifier: digested.value,
      lastSeenAt: null,
    });
    const saved = this.#dependencies.repository.savePairing(record);
    return saved.ok ? { ok: true, value: { pairingId: record.pairingId } } : saved;
  }

  /**
   * Create bounded metadata only. Rights and source validation precede writes.
   * @param {unknown} raw
   * @returns {Result<{ readonly jobId: string, readonly state: "waiting_for_local_worker" }, AsrCoordinatorFailure>}
   */
  create(raw) {
    const validated = validateJobCommand(raw, this.#dependencies.isYouTubeUrl, this.#configuration.model);
    if (!validated.ok) return validated;
    const command = validated.value;
    if (command.media.declaredBytes > this.#configuration.maximumBytes) {
      return { ok: false, error: { kind: "PodcastEnclosureLimitExceeded", limit: "bytes" } };
    }
    if (command.media.declaredDurationSeconds > this.#configuration.maximumDurationSeconds) {
      return { ok: false, error: { kind: "PodcastEnclosureLimitExceeded", limit: "duration" } };
    }
    if (command.timeoutMs > this.#configuration.maximumTimeoutMs) {
      return { ok: false, error: { kind: "PodcastEnclosureLimitExceeded", limit: "timeout" } };
    }
    const rights = this.#dependencies.rights.find(command.ownerId, command.rights.evidenceId);
    if (!rights.ok) return { ok: false, error: { kind: "AsrRepositoryUnavailable" } };
    if (!rights.value || !sameRights(command, rights.value) || !rights.value.transcriptionPermitted) {
      return { ok: false, error: { kind: "PodcastTranscriptionPermissionMissing" } };
    }
    if (!rights.value.derivedTranscriptPermitted) {
      return { ok: false, error: { kind: "TranscriptRetentionNotPermitted" } };
    }
    const created = this.#dependencies.repository.createJob(Object.freeze({
      command,
      state: "waiting_for_local_worker",
      createdAt: this.#dependencies.now(),
      pairingId: null,
      companionId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      result: null,
    }));
    return created.ok
      ? { ok: true, value: { jobId: command.jobId, state: "waiting_for_local_worker" } }
      : created;
  }

  /**
   * Authenticate first, then atomically claim one bounded command.
   * @param {unknown} raw
   * @returns {Promise<Result<{ readonly command: AsrJobCommand, readonly leaseToken: string, readonly leaseExpiresAt: number } | null, AsrCoordinatorFailure>>}
   */
  async pull(raw) {
    const auth = await this.#authenticate(raw);
    if (!auth.ok) return auth;
    const model = this.#validateModel(raw);
    if (!model.ok) return model;
    const leaseToken = hex(this.#dependencies.randomBytes(32));
    if (leaseToken.length !== 64) return pairInvalid("randomBytes");
    const now = this.#dependencies.now();
    const claimed = this.#dependencies.repository.claimNext({
      ownerId: auth.value.ownerId,
      pairingId: auth.value.pairingId,
      companionId: auth.value.companionId,
      now,
      leaseExpiresAt: now + this.#configuration.leaseMs,
      leaseToken,
    });
    if (!claimed.ok) return claimed;
    if (claimed.value === null) return { ok: true, value: null };
    return {
      ok: true,
      value: Object.freeze({
        command: claimed.value.command,
        leaseToken,
        leaseExpiresAt: /** @type {number} */ (claimed.value.leaseExpiresAt),
      }),
    };
  }

  /** @param {unknown} raw @returns {Promise<Result<{ readonly jobId: string, readonly state: "completed" }, AsrCoordinatorFailure>>} */
  async submit(raw) {
    const auth = await this.#authenticate(raw);
    if (!auth.ok) return auth;
    const model = this.#validateModel(raw);
    if (!model.ok) return model;
    if (!isRecord(raw) || !nonBlank(raw.jobId)) return resultInvalid("jobId");
    if (!nonBlank(raw.leaseToken)) return resultInvalid("leaseToken");
    const result = validateResult(raw.result);
    if (!result.ok) return result;
    const pending = this.#dependencies.repository.job(auth.value.ownerId, raw.jobId);
    if (!pending.ok) return pending;
    if (pending.value === null) return { ok: false, error: { kind: "AsrJobUnknown" } };
    if (result.value.excerpt !== null && !pending.value.command.rights.excerptPermitted) {
      return { ok: false, error: { kind: "DerivedCardRightsNotPermitted" } };
    }
    const completed = this.#dependencies.repository.complete({
      ownerId: auth.value.ownerId,
      pairingId: auth.value.pairingId,
      companionId: auth.value.companionId,
      jobId: raw.jobId,
      leaseToken: raw.leaseToken,
      now: this.#dependencies.now(),
      result: result.value,
    });
    if (!completed.ok) return completed;
    return { ok: true, value: { jobId: raw.jobId, state: "completed" } };
  }

  /** @param {string} ownerId @param {string} jobId @returns {Result<AsrJobRecord, AsrCoordinatorFailure>} */
  status(ownerId, jobId) {
    if (!nonBlank(ownerId) || !nonBlank(jobId)) return resultInvalid("jobId");
    const found = this.#dependencies.repository.job(ownerId, jobId);
    if (!found.ok || found.value === null) return found.ok ? { ok: false, error: { kind: "AsrJobUnknown" } } : found;
    if (found.value.state === "waiting_for_local_worker") {
      return { ok: false, error: { kind: "LocalWorkerUnavailable", jobId, state: "waiting_for_local_worker" } };
    }
    return { ok: true, value: found.value };
  }

  /** @param {unknown} raw */
  /**
   * @param {unknown} raw
   * @returns {Promise<Result<{ readonly ownerId: string, readonly pairingId: string, readonly companionId: string }, AsrCoordinatorFailure>>}
   */
  async #authenticate(raw) {
    if (!isRecord(raw) || !nonBlank(raw.pairingId) || !nonBlank(raw.companionId) ||
      !(raw.secret instanceof Uint8Array) || raw.secret.byteLength < this.#configuration.secretBytes) {
      return /** @type {Result<never, AsrCoordinatorFailure>} */ ({ ok: false, error: { kind: "LocalWorkerAuthenticationFailed" } });
    }
    const pairing = this.#dependencies.repository.pairing(raw.pairingId);
    if (!pairing.ok) return pairing;
    const digested = await this.#dependencies.digest(raw.secret);
    if (!digested.ok) return { ok: false, error: { kind: "AsrDigestUnavailable" } };
    if (!pairing.value || !this.#dependencies.equalVerifier(pairing.value.verifier, digested.value)) {
      return { ok: false, error: { kind: "LocalWorkerAuthenticationFailed" } };
    }
    const touched = this.#dependencies.repository.touchPairing(raw.pairingId, this.#dependencies.now());
    return touched.ok
      ? { ok: true, value: { ownerId: pairing.value.ownerId, pairingId: raw.pairingId, companionId: raw.companionId } }
      : touched;
  }

  /** @param {unknown} raw @returns {Result<true, AsrCoordinatorFailure>} */
  #validateModel(raw) {
    if (!isRecord(raw) || raw.modelId !== this.#configuration.model.id ||
      raw.modelVersion !== this.#configuration.model.version) {
      return {
        ok: false,
        error: {
          kind: "LocalWorkerModelMismatch",
          requiredId: this.#configuration.model.id,
          requiredVersion: this.#configuration.model.version,
        },
      };
    }
    return { ok: true, value: true };
  }
}

export class MemoryAsrJobRepository {
  /** @type {Map<string, PairingRecord>} */ #pairings = new Map();
  /** @type {Map<string, AsrJobRecord>} */ #jobs = new Map();

  /** @param {PairingRecord} record @returns {Result<true, AsrCoordinatorFailure>} */
  savePairing(record) {
    if (this.#pairings.has(record.pairingId)) return { ok: false, error: /** @type {const} */ ({ kind: "AsrPairingConflict" }) };
    this.#pairings.set(record.pairingId, record);
    return { ok: true, value: /** @type {const} */ (true) };
  }
  /** @param {string} pairingId @returns {Result<PairingRecord | null, AsrCoordinatorFailure>} */
  pairing(pairingId) { return { ok: true, value: this.#pairings.get(pairingId) ?? null }; }
  /** @param {string} pairingId @param {number} seenAt @returns {Result<true, AsrCoordinatorFailure>} */
  touchPairing(pairingId, seenAt) {
    const found = this.#pairings.get(pairingId);
    if (!found) return { ok: false, error: /** @type {const} */ ({ kind: "LocalWorkerAuthenticationFailed" }) };
    this.#pairings.set(pairingId, Object.freeze({ ...found, lastSeenAt: seenAt }));
    return { ok: true, value: /** @type {const} */ (true) };
  }
  /** @param {AsrJobRecord} record @returns {Result<true, AsrCoordinatorFailure>} */
  createJob(record) {
    const key = jobKey(record.command.ownerId, record.command.jobId);
    if (this.#jobs.has(key)) return { ok: false, error: /** @type {const} */ ({ kind: "AsrJobConflict" }) };
    this.#jobs.set(key, record);
    return { ok: true, value: /** @type {const} */ (true) };
  }
  /** @param {{ readonly ownerId: string, readonly pairingId: string, readonly companionId: string, readonly now: number, readonly leaseExpiresAt: number, readonly leaseToken: string }} request @returns {Result<AsrJobRecord | null, AsrCoordinatorFailure>} */
  claimNext(request) {
    const candidates = [...this.#jobs.entries()].filter(([, record]) =>
      record.command.ownerId === request.ownerId &&
      (record.state === "waiting_for_local_worker" ||
        (record.state === "leased" && /** @type {number} */ (record.leaseExpiresAt) <= request.now))
    ).sort((left, right) => left[1].createdAt - right[1].createdAt);
    const selected = candidates[0];
    if (!selected) return { ok: true, value: null };
    const leased = Object.freeze({ ...selected[1], state: /** @type {const} */ ("leased"), pairingId: request.pairingId, companionId: request.companionId, leaseToken: request.leaseToken, leaseExpiresAt: request.leaseExpiresAt });
    this.#jobs.set(selected[0], leased);
    return { ok: true, value: leased };
  }
  /** @param {{ readonly ownerId: string, readonly pairingId: string, readonly companionId: string, readonly jobId: string, readonly leaseToken: string, readonly now: number, readonly result: AsrJobResult }} request @returns {Result<AsrJobRecord, AsrCoordinatorFailure>} */
  complete(request) {
    const key = jobKey(request.ownerId, request.jobId);
    const found = this.#jobs.get(key);
    if (!found) return { ok: false, error: /** @type {const} */ ({ kind: "AsrJobUnknown" }) };
    if (found.state === "completed") {
      return found.result?.contentDigest === request.result.contentDigest
        ? { ok: true, value: found }
        : { ok: false, error: /** @type {const} */ ({ kind: "AsrJobLeaseConflict" }) };
    }
    if (found.state !== "leased" || found.pairingId !== request.pairingId || found.companionId !== request.companionId ||
      found.leaseToken !== request.leaseToken || /** @type {number} */ (found.leaseExpiresAt) < request.now) {
      return { ok: false, error: /** @type {const} */ ({ kind: "AsrJobLeaseConflict" }) };
    }
    const completed = Object.freeze({ ...found, state: /** @type {const} */ ("completed"), result: request.result });
    this.#jobs.set(key, completed);
    return { ok: true, value: completed };
  }
  /** @param {string} ownerId @param {string} jobId @returns {Result<AsrJobRecord | null, AsrCoordinatorFailure>} */
  job(ownerId, jobId) { return { ok: true, value: this.#jobs.get(jobKey(ownerId, jobId)) ?? null }; }
}

/**
 * HTTP composition boundary for Access-authenticated app commands and
 * pairing-authenticated local companion commands.
 *
 * @param {{ readonly maximumBodyBytes: number }} configuration
 * @param {{
 *   readonly authenticateAccess: (request: Request) => Promise<Result<{ readonly ownerId: string }, { readonly kind: string }>>,
 *   readonly coordinator: Pick<AsrJobCoordinator, "pair" | "create" | "status" | "pull" | "submit">,
 * }} dependencies
 */
export function createAsrControlPlane(configuration, dependencies) {
  if (!positiveInteger(configuration.maximumBodyBytes) ||
    typeof dependencies.authenticateAccess !== "function" || !dependencies.coordinator) {
    throw new TypeError("ASR control-plane configuration is invalid.");
  }
  const accessPaths = new Set(["/api/asr/pair", "/api/asr/jobs", "/api/asr/status"]);
  const companionPaths = new Set(["/api/asr/companion/pull", "/api/asr/companion/submit"]);
  return Object.freeze({
    /** @param {Request} request */
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (!accessPaths.has(path) && !companionPaths.has(path)) return jsonResponse({ error: "Not found." }, 404);
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "POST" });

      /** @type {{ readonly ownerId: string } | null} */
      let identity = null;
      if (accessPaths.has(path)) {
        const authenticated = await dependencies.authenticateAccess(request);
        if (!authenticated.ok) return controlFailure(authenticated.error.kind);
        identity = authenticated.value;
      }
      const document = await readControlBody(request, configuration.maximumBodyBytes);
      if (!document.ok) return document.error;

      if (path === "/api/asr/pair") {
        const parsed = pairingHttpCommand(document.value);
        if (!parsed.ok) return controlFailure(parsed.error.kind);
        const paired = await dependencies.coordinator.pair({
          ownerId: /** @type {{ readonly ownerId: string }} */ (identity).ownerId,
          pairingId: parsed.value.pairingId,
          secret: parsed.value.secret,
        });
        return paired.ok
          ? jsonResponse({ pairingId: paired.value.pairingId }, 201)
          : controlFailure(paired.error.kind);
      }
      if (path === "/api/asr/jobs") {
        if (!isRecord(document.value) || document.value.ownerId !== identity?.ownerId) {
          return controlFailure("AsrOwnerMismatch");
        }
        const created = dependencies.coordinator.create(document.value);
        return created.ok ? jsonResponse(created.value, 202) : controlFailure(created.error.kind);
      }
      if (path === "/api/asr/status") {
        if (!isRecord(document.value) || Object.keys(document.value).length !== 1 || !nonBlank(document.value.jobId)) {
          return controlFailure("AsrJobStatusCommandInvalid");
        }
        const status = dependencies.coordinator.status(
          /** @type {{ readonly ownerId: string }} */ (identity).ownerId,
          document.value.jobId,
        );
        return status.ok
          ? jsonResponse({ jobId: status.value.command.jobId, state: status.value.state }, 200)
          : controlFailure(status.error.kind);
      }
      const companion = companionHttpCommand(document.value, path.endsWith("/submit"));
      if (!companion.ok) return controlFailure(companion.error.kind);
      if (path === "/api/asr/companion/pull") {
        const pulled = await dependencies.coordinator.pull(companion.value);
        return pulled.ok ? jsonResponse({ job: pulled.value }, 200) : controlFailure(pulled.error.kind);
      }
      const submitted = await dependencies.coordinator.submit(companion.value);
      return submitted.ok ? jsonResponse(submitted.value, 200) : controlFailure(submitted.error.kind);
    },
  });
}

/** @param {unknown} raw @returns {Result<{ readonly pairingId: string, readonly secret: Uint8Array }, { readonly kind: string }>} */
function pairingHttpCommand(raw) {
  if (!isRecord(raw) || Object.keys(raw).length !== 2 || !nonBlank(raw.pairingId) || !nonBlank(raw.secret)) {
    return { ok: false, error: { kind: "AsrPairingCommandInvalid" } };
  }
  const secret = base64UrlBytes(raw.secret);
  return secret !== null && secret.byteLength >= 32
    ? { ok: true, value: { pairingId: raw.pairingId, secret } }
    : { ok: false, error: { kind: "AsrPairingCommandInvalid" } };
}

/** @param {unknown} raw @param {boolean} submit @returns {Result<Record<string, unknown>, { readonly kind: string }>} */
function companionHttpCommand(raw, submit) {
  if (!isRecord(raw)) return { ok: false, error: { kind: "LocalWorkerAuthenticationFailed" } };
  const expected = submit ? 8 : 5;
  if (Object.keys(raw).length !== expected || !nonBlank(raw.pairingId) || !nonBlank(raw.companionId) ||
    !nonBlank(raw.secret) || !nonBlank(raw.modelId) || !nonBlank(raw.modelVersion) ||
    (submit && (!nonBlank(raw.jobId) || !nonBlank(raw.leaseToken) || !("result" in raw)))) {
    return { ok: false, error: { kind: "LocalWorkerAuthenticationFailed" } };
  }
  const secret = base64UrlBytes(raw.secret);
  if (secret === null || secret.byteLength < 32) return { ok: false, error: { kind: "LocalWorkerAuthenticationFailed" } };
  return { ok: true, value: { ...raw, secret } };
}

/** @param {Request} request @param {number} maximumBytes @returns {Promise<Result<unknown, Response>>} */
async function readControlBody(request, maximumBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return { ok: false, error: controlFailure("AsrControlRequestTooLarge") };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    return { ok: false, error: controlFailure("AsrControlRequestTooLarge") };
  }
  try {
    return { ok: true, value: /** @type {unknown} */ (JSON.parse(text)) };
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, error: controlFailure("AsrControlCommandInvalid") };
    throw error;
  }
}

/** @param {string} kind */
function controlFailure(kind) {
  const status = kind.includes("AccessToken") || kind === "LocalWorkerAuthenticationFailed"
    ? 401
    : kind.includes("OwnerMismatch") || kind.includes("NotPermitted") || kind.includes("PermissionMissing") ||
        kind.includes("SourceForbidden") || kind === "LocalWorkerModelMismatch"
    ? 403
    : kind.includes("TooLarge") || kind === "PodcastEnclosureLimitExceeded" || kind === "AsrControlRequestTooLarge"
    ? 413
    : kind === "AsrJobUnknown"
    ? 404
    : kind.includes("Conflict")
    ? 409
    : kind === "LocalWorkerUnavailable" || kind.includes("RepositoryUnavailable") || kind.includes("DigestUnavailable")
    ? 503
    : 400;
  const error = status === 401 ? "Authentication failed."
    : status === 403 ? "This action is not permitted."
    : status === 404 ? "The requested job was not found."
    : status === 409 ? "The job changed before this action completed."
    : status === 413 ? "The request is too large."
    : status === 503 ? "The local transcription service is unavailable."
    : "The request could not be processed.";
  return jsonResponse({ error, code: kind }, status);
}

/** @param {unknown} body @param {number} status @param {HeadersInit} [headers] */
function jsonResponse(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** @param {string} text */
function base64UrlBytes(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

/** @param {unknown} raw @param {(url: URL) => boolean} isYouTubeUrl @param {{ readonly id: string, readonly version: string }} model @returns {Result<AsrJobCommand, AsrCoordinatorFailure>} */
function validateJobCommand(raw, isYouTubeUrl, model) {
  if (!isRecord(raw)) return jobInvalid("command");
  if (Object.keys(raw).length !== 6) return jobInvalid("command");
  if (!nonBlank(raw.jobId)) return jobInvalid("jobId");
  if (!nonBlank(raw.ownerId)) return jobInvalid("ownerId");
  if (!isRecord(raw.source) || Object.keys(raw.source).length !== 5) return jobInvalid("source");
  for (const field of ["provenance", "provenanceId", "feedUrl", "canonicalItemUrl", "enclosureUrl"]) {
    if (!nonBlank(raw.source[field])) return jobInvalid(`source.${field}`);
  }
  if (/** @type {string} */ (raw.source.provenance).trim().toLowerCase().includes("youtube")) return { ok: false, error: { kind: "AsrJobSourceForbidden", reason: "youtube-provenance" } };
  for (const field of ["feedUrl", "canonicalItemUrl", "enclosureUrl"]) {
    try {
      const url = new URL(/** @type {string} */ (raw.source[field]));
      if (url.protocol !== "https:" || isYouTubeUrl(url)) return { ok: false, error: { kind: "AsrJobSourceForbidden", reason: "youtube-url" } };
    } catch (error) {
      if (error instanceof TypeError) return jobInvalid(`source.${field}`);
      throw error;
    }
  }
  if (!isRecord(raw.rights) || Object.keys(raw.rights).length !== 4 || !nonBlank(raw.rights.evidenceId)) return jobInvalid("rights");
  for (const field of ["transcriptionPermitted", "derivedTranscriptPermitted", "excerptPermitted"]) if (typeof raw.rights[field] !== "boolean") return jobInvalid(`rights.${field}`);
  if (!isRecord(raw.media) || Object.keys(raw.media).length !== 3 || !positiveInteger(raw.media.declaredBytes) ||
    !positiveNumber(raw.media.declaredDurationSeconds) || !nonBlank(raw.media.declaredMediaType)) return jobInvalid("media");
  if (!positiveInteger(raw.timeoutMs)) return jobInvalid("timeoutMs");
  return {
    ok: true,
    value: /** @type {AsrJobCommand} */ (Object.freeze({
      ...raw,
      model: Object.freeze({ ...model }),
    })),
  };
}

/** @param {unknown} raw @returns {Result<AsrJobResult, AsrCoordinatorFailure>} */
function validateResult(raw) {
  if (!isRecord(raw) || Object.keys(raw).length !== 3) return resultInvalid("result");
  if (!nonBlank(raw.transcript) || raw.transcript.length > 250_000) return resultInvalid("transcript");
  if (!(raw.excerpt === null || (nonBlank(raw.excerpt) && raw.excerpt.length <= 8_000))) return resultInvalid("excerpt");
  if (!nonBlank(raw.contentDigest) || !/^[0-9a-f]{64}$/.test(raw.contentDigest)) return resultInvalid("contentDigest");
  return { ok: true, value: /** @type {AsrJobResult} */ (Object.freeze({ ...raw })) };
}

/** @param {AsrJobCommand} command @param {PersistedAudioRights} rights */
function sameRights(command, rights) {
  return rights.ownerId === command.ownerId && rights.evidenceId === command.rights.evidenceId &&
    rights.transcriptionPermitted === command.rights.transcriptionPermitted &&
    rights.derivedTranscriptPermitted === command.rights.derivedTranscriptPermitted &&
    rights.excerptPermitted === command.rights.excerptPermitted;
}
/** @param {string} field @returns {Result<never, AsrCoordinatorFailure>} */
function pairInvalid(field) { return { ok: false, error: { kind: "AsrPairingCommandInvalid", field } }; }
/** @param {string} field @returns {Result<never, AsrCoordinatorFailure>} */
function jobInvalid(field) { return { ok: false, error: { kind: "AsrJobCommandInvalid", field } }; }
/** @param {string} field @returns {Result<never, AsrCoordinatorFailure>} */
function resultInvalid(field) { return { ok: false, error: { kind: "AsrJobResultInvalid", field } }; }
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function nonBlank(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value @returns {value is number} */
function positiveNumber(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }
/** @param {string} ownerId @param {string} jobId */
function jobKey(ownerId, jobId) { return `${ownerId}\u0000${jobId}`; }
/** @param {Uint8Array} bytes */
function hex(bytes) { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

export {};
