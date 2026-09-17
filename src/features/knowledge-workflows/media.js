// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {{ readonly url: string, readonly kind: "image" | "screenshot", readonly educationallyConnected: boolean, readonly mediaTypeHint: string, readonly rights: { readonly storage: "allowed", readonly display: "allowed", readonly transformation: "allowed", readonly attribution: string, readonly originEvidence: string } }} MediaCandidate */
/** @typedef {{ readonly ownerId: string, readonly runId: string, readonly knowledgeId: string, readonly assetId: string, readonly sourceUrl: string, readonly origin: string, readonly kind: MediaCandidate["kind"], readonly mediaType: string, readonly byteCount: number, readonly digest: string, readonly privateOriginalKey: string, readonly attribution: string, readonly createdAt: string }} MediaAsset */
/** @typedef {{ readonly ownerId: string, readonly assetId: string, readonly derivativeId: string, readonly variant: "feed" | "thumbnail", readonly mediaType: string, readonly byteCount: number, readonly privateObjectKey: string, readonly deliveryToken: string, readonly createdAt: string }} MediaDerivative */
/** @typedef {{ readonly id: string, readonly path: string, readonly mediaType: "image/jpeg" | "image/png", readonly width: number, readonly height: number, readonly userAttested: true }} FallbackAsset */
/** @typedef {{ readonly kind: "FallbackManifestInvalid", readonly field: string } | { readonly kind: "FallbackManifestDuplicateId", readonly assetId: string } | { readonly kind: "FallbackManifestDuplicatePath", readonly path: string } | { readonly kind: "FallbackReferenceInvalid" } | { readonly kind: "FallbackAssetUnlisted" } | { readonly kind: "FallbackAssetMissing", readonly assetId: string } | { readonly kind: "FallbackAssetReadFailed", readonly assetId: string } | { readonly kind: "FallbackAssetMetadataMismatch", readonly assetId: string, readonly field: "mediaType" | "dimensions" }} FallbackManifestFailure */
/** @typedef {{ readonly entries: readonly FallbackAsset[], readonly resolve: (reference: { readonly assetId: string, readonly path: string }) => Result<FallbackAsset, FallbackManifestFailure> }} UserAttestedLocalManifest */

/** @typedef {{ readonly kind: "MediaPublicEgressUnavailable" | "MediaPublicEgressFailed" | "MediaPublicEgressRedirectUnsafe" | "MediaPublicEgressPrivateAddress" | "MediaPublicEgressLoopbackAddress" | "MediaPublicEgressLinkLocalAddress" | "MediaPublicEgressReservedAddress" | "MediaPublicEgressCredentialsRejected" | "MediaPublicEgressNonHttpsUrl" | "MediaPublicEgressPayloadTooLarge" | "MediaPublicEgressTimeout" | "MediaPublicEgressRedirectLimitExceeded" }} MediaPublicEgressFailure */
/** @typedef {{ readonly maximumBytes: number, readonly timeoutMilliseconds: number, readonly redirectLimit: number, readonly validateEveryRedirect: true, readonly publicAddressesOnly: true, readonly signal: AbortSignal }} MediaPublicEgressPolicy */
/** @typedef {{ readonly request: (request: Request, policy: MediaPublicEgressPolicy) => Promise<Result<{ readonly response: Response, readonly redirectHops: readonly string[] }, MediaPublicEgressFailure>> }} MediaPublicEgressCapability */
/** @typedef {{ readonly kind: "MediaTrustedReadFailed" }} MediaTrustedReadFailure */
/** @typedef {{ readonly kind: "MediaCommandInvalid", readonly field: string } | { readonly kind: "MediaEducationalRelevanceRequired" } | { readonly kind: "MediaRightsEvidenceRequired" } | { readonly kind: "MediaOriginNotAllowed" } | MediaPublicEgressFailure | MediaTrustedReadFailure | { readonly kind: "MediaNetworkRejected" } | { readonly kind: "MediaFetchFailed" } | { readonly kind: "MediaPayloadTooLarge" } | { readonly kind: "MediaMimeSignatureConflict" } | { readonly kind: "MediaUnsupportedType" } | { readonly kind: "MediaScriptableFormatRejected" } | { readonly kind: "MediaQuarantineFailed" } | { readonly kind: "MediaDerivativeProcessingFailed" } | { readonly kind: "MediaPersistenceFailed" } | { readonly kind: "MediaDerivativeNotFound" } | { readonly kind: "MediaDerivativeRevoked" } | { readonly kind: "MediaCleanupFailed" } | FallbackManifestFailure} MediaFailure */

/** Atomic boundary owns public DNS, redirect, and network policy for one request. */
/** @typedef {{ readonly fetch: (request: Request) => Promise<Result<Response, MediaPublicEgressFailure>> }} MediaPublicEgress */
/** Explicitly trusted same-origin/local fixture reads; never a remote fallback. */
/** @typedef {{ readonly read: (request: Request) => Promise<Result<Response, MediaTrustedReadFailure>> }} MediaTrustedRead */
/** @typedef {{ readonly publicEgress?: MediaPublicEgress, readonly trustedRead?: MediaTrustedRead, readonly digest: (bytes: Uint8Array) => Promise<Result<string, unknown>>, readonly quarantine: { readonly put: (object: { readonly key: string, readonly bytes: Uint8Array, readonly mediaType: string }) => Promise<Result<null, unknown>>, readonly remove: (key: string) => Promise<Result<null, unknown>> }, readonly derivatives: { readonly create: (command: { readonly assetId: string, readonly variant: "feed" | "thumbnail", readonly bytes: Uint8Array, readonly mediaType: string }) => Promise<Result<{ readonly bytes: Uint8Array, readonly mediaType: string }, unknown>> }, readonly repository: { readonly save: (asset: MediaAsset, derivative: MediaDerivative, bytes: Uint8Array) => Promise<Result<null, unknown>>, readonly read: (command: { readonly ownerId: string, readonly assetId: string, readonly variant: "feed" | "thumbnail" }) => Promise<Result<{ readonly bytes: Uint8Array, readonly mediaType: string, readonly revoked: boolean }, unknown>>, readonly revoke: (command: { readonly ownerId: string, readonly assetId: string }) => Promise<Result<null, unknown>> }, readonly createId: () => string, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly ownerId?: string, readonly runId?: string, readonly assetId?: string, readonly failureKind?: string }) => void, readonly maximumImageBytes?: number }} MediaDependencies */

const imageLimit = 20 * 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is MediaCandidate} */
function validCandidate(value) { return record(value) && text(value.url) && (value.kind === "image" || value.kind === "screenshot") && value.educationallyConnected === true && text(value.mediaTypeHint) && record(value.rights) && value.rights.storage === "allowed" && value.rights.display === "allowed" && value.rights.transformation === "allowed" && text(value.rights.attribution) && text(value.rights.originEvidence); }
/** @param {unknown} value @returns {value is string} */
function validTimestamp(value) { return text(value) && Number.isFinite(Date.parse(value)); }
/** @param {Uint8Array} bytes @returns {string | null} */
function signature(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length >= 6 && (new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a")) return "image/gif";
  return null;
}

/** @param {string} hostname @returns {MediaPublicEgressFailure | null} */
function forbiddenHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost")) return { kind: "MediaPublicEgressLoopbackAddress" };
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u)?.slice(1).map(Number);
  if (ipv4 !== undefined && ipv4.every((part) => part >= 0 && part <= 255)) {
    const [a, b, c] = ipv4;
    if (a === 127) return { kind: "MediaPublicEgressLoopbackAddress" };
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return { kind: "MediaPublicEgressPrivateAddress" };
    if (a === 169 && b === 254) return { kind: "MediaPublicEgressLinkLocalAddress" };
    if (a === 0 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113)) return { kind: "MediaPublicEgressReservedAddress" };
    return null;
  }
  if (!host.includes(":")) return null;
  if (host === "::1") return { kind: "MediaPublicEgressLoopbackAddress" };
  if (host.startsWith("fc") || host.startsWith("fd")) return { kind: "MediaPublicEgressPrivateAddress" };
  if (/^fe[89ab]/u.test(host)) return { kind: "MediaPublicEgressLinkLocalAddress" };
  if (host === "::" || host.startsWith("ff") || host.startsWith("2001:db8:")) return { kind: "MediaPublicEgressReservedAddress" };
  if (host.startsWith("::ffff:")) return forbiddenHost(host.slice(7));
  return null;
}

/** @param {string} value @returns {MediaPublicEgressFailure | null} */
function validatePublicUrl(value) {
  let url;
  try { url = new URL(value); } catch (error) { return { kind: "MediaPublicEgressRedirectUnsafe" }; }
  if (url.username !== "" || url.password !== "") return { kind: "MediaPublicEgressCredentialsRejected" };
  if (url.protocol !== "https:") return { kind: "MediaPublicEgressNonHttpsUrl" };
  return forbiddenHost(url.hostname);
}

/**
 * Adapts a platform-owned atomic request capability. The injected capability
 * owns DNS-to-connection pinning; this module never resolves then raw-fetches.
 * @param {unknown} capability
 * @param {{ readonly maximumBytes?: number, readonly timeoutMilliseconds?: number, readonly redirectLimit?: number }} [options]
 * @returns {MediaPublicEgress}
 */
export function createMediaPublicEgress(capability, options = {}) {
  const maximumBytes = options.maximumBytes ?? imageLimit;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
  const redirectLimit = options.redirectLimit ?? 4;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > imageLimit || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0 || timeoutMilliseconds > 60_000 || !Number.isSafeInteger(redirectLimit) || redirectLimit < 0 || redirectLimit > 10) throw new TypeError("Media public egress policy is invalid.");
  const atomic = record(capability) && typeof capability.request === "function" ? /** @type {MediaPublicEgressCapability} */ (capability) : null;
  const failureKinds = new Set(["MediaPublicEgressUnavailable", "MediaPublicEgressFailed", "MediaPublicEgressRedirectUnsafe", "MediaPublicEgressPrivateAddress", "MediaPublicEgressLoopbackAddress", "MediaPublicEgressLinkLocalAddress", "MediaPublicEgressReservedAddress", "MediaPublicEgressCredentialsRejected", "MediaPublicEgressNonHttpsUrl", "MediaPublicEgressPayloadTooLarge", "MediaPublicEgressTimeout", "MediaPublicEgressRedirectLimitExceeded"]);
  return Object.freeze({
    /** @param {Request} request @returns {Promise<Result<Response, MediaPublicEgressFailure>>} */
    async fetch(request) {
      if (!(request instanceof Request) || request.method !== "GET") return { ok: false, error: { kind: "MediaPublicEgressFailed" } };
      const initialFailure = validatePublicUrl(request.url);
      if (initialFailure !== null) return { ok: false, error: initialFailure };
      if (atomic === null) return { ok: false, error: { kind: "MediaPublicEgressUnavailable" } };
      const controller = new AbortController();
      /** @type {ReturnType<typeof setTimeout> | undefined} */ let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(/** @type {const} */ ({ ok: false, error: { kind: "MediaPublicEgressTimeout" } })); }, timeoutMilliseconds); });
      /** @type {unknown} */ let result;
      try {
        result = await Promise.race([
          atomic.request(request, Object.freeze({ maximumBytes, timeoutMilliseconds, redirectLimit, validateEveryRedirect: true, publicAddressesOnly: true, signal: controller.signal })),
          timeout,
        ]);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { ok: false, error: { kind: controller.signal.aborted ? "MediaPublicEgressTimeout" : "MediaPublicEgressFailed" } };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (!record(result) || typeof result.ok !== "boolean") return { ok: false, error: { kind: "MediaPublicEgressFailed" } };
      if (!result.ok) {
        if (!record(result.error) || typeof result.error.kind !== "string" || !failureKinds.has(result.error.kind)) return { ok: false, error: { kind: "MediaPublicEgressFailed" } };
        return { ok: false, error: /** @type {MediaPublicEgressFailure} */ (result.error) };
      }
      if (!record(result.value) || !(result.value.response instanceof Response) || !Array.isArray(result.value.redirectHops) || !result.value.redirectHops.every((hop) => typeof hop === "string")) return { ok: false, error: { kind: "MediaPublicEgressFailed" } };
      const hops = /** @type {readonly string[]} */ (result.value.redirectHops);
      if (hops.length > redirectLimit) return { ok: false, error: { kind: "MediaPublicEgressRedirectLimitExceeded" } };
      for (const hop of hops) {
        const hopFailure = validatePublicUrl(hop);
        if (hopFailure !== null) return { ok: false, error: hopFailure };
      }
      const response = /** @type {Response} */ (result.value.response);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return { ok: false, error: { kind: "MediaPublicEgressPayloadTooLarge" } };
      /** @type {ReturnType<typeof setTimeout> | undefined} */ let bodyTimer;
      /** @type {ArrayBuffer | null} */ let buffer;
      try {
        buffer = await Promise.race([
          response.arrayBuffer(),
          new Promise((resolve) => { bodyTimer = setTimeout(() => resolve(null), timeoutMilliseconds); }),
        ]);
      } catch (error) {
        return { ok: false, error: { kind: "MediaPublicEgressFailed" } };
      } finally {
        if (bodyTimer !== undefined) clearTimeout(bodyTimer);
      }
      if (buffer === null) return { ok: false, error: { kind: "MediaPublicEgressTimeout" } };
      const bytes = new Uint8Array(buffer);
      if (bytes.byteLength > maximumBytes) return { ok: false, error: { kind: "MediaPublicEgressPayloadTooLarge" } };
      return { ok: true, value: new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers }) };
    },
  });
}
/** @param {MediaFailure} failure @param {MediaDependencies} dependencies @param {string | undefined} ownerId @param {string | undefined} assetId @returns {Result<never, MediaFailure>} */
function fail(failure, dependencies, ownerId, assetId) { dependencies.logger({ event: "media-failure", ownerId, assetId, failureKind: failure.kind }); return { ok: false, error: failure }; }

/** @param {MediaDependencies} dependencies @param {number} maximumImageBytes @param {{ readonly ownerId: string, readonly runId: string, readonly knowledgeId: string }} command @param {MediaCandidate} candidate @param {URL} candidateUrl @param {Uint8Array} bytes @returns {Promise<Result<{ readonly asset: MediaAsset, readonly derivative: MediaDerivative }, MediaFailure>>} */
async function persistImage(dependencies, maximumImageBytes, command, candidate, candidateUrl, bytes) {
  if (bytes.byteLength > maximumImageBytes) return fail({ kind: "MediaPayloadTooLarge" }, dependencies, command.ownerId, undefined);
  const detected = signature(bytes);
  if (detected === null) return fail({ kind: "MediaUnsupportedType" }, dependencies, command.ownerId, undefined);
  if (candidate.mediaTypeHint.split(";", 1)[0].trim().toLowerCase() !== detected) return fail({ kind: "MediaMimeSignatureConflict" }, dependencies, command.ownerId, undefined);
  const digest = await dependencies.digest(bytes);
  if (!digest.ok || !text(digest.value)) return fail({ kind: "MediaPersistenceFailed" }, dependencies, command.ownerId, undefined);
  const assetId = `media:${dependencies.createId()}`;
  const derivativeId = `derivative:${dependencies.createId()}`;
  const createdAt = dependencies.now();
  if (!validTimestamp(createdAt)) throw new TypeError("Media pipeline clock returned an invalid timestamp.");
  const originalKey = `private-quarantine/${command.ownerId}/${command.runId}/${assetId}/original`;
  const quarantined = await dependencies.quarantine.put({ key: originalKey, bytes, mediaType: detected });
  if (!quarantined.ok) return fail({ kind: "MediaQuarantineFailed" }, dependencies, command.ownerId, assetId);
  const derivative = await dependencies.derivatives.create({ assetId, variant: "feed", bytes, mediaType: detected });
  if (!derivative.ok) {
    const removed = await dependencies.quarantine.remove(originalKey);
    return removed.ok ? fail({ kind: "MediaDerivativeProcessingFailed" }, dependencies, command.ownerId, assetId) : fail({ kind: "MediaCleanupFailed" }, dependencies, command.ownerId, assetId);
  }
  const asset = Object.freeze({ ownerId: command.ownerId, runId: command.runId, knowledgeId: command.knowledgeId, assetId, sourceUrl: candidateUrl.href, origin: candidateUrl.origin, kind: candidate.kind, mediaType: detected, byteCount: bytes.byteLength, digest: digest.value, privateOriginalKey: originalKey, attribution: candidate.rights.attribution, createdAt });
  const privateObjectKey = `private-derivatives/${command.ownerId}/${assetId}/feed`;
  const savedDerivative = Object.freeze({ ownerId: command.ownerId, assetId, derivativeId, variant: "feed", mediaType: derivative.value.mediaType, byteCount: derivative.value.bytes.byteLength, privateObjectKey, deliveryToken: `${assetId}:feed`, createdAt });
  const saved = await dependencies.repository.save(asset, savedDerivative, derivative.value.bytes);
  if (!saved.ok) {
    const removed = await dependencies.quarantine.remove(originalKey);
    return removed.ok ? fail({ kind: "MediaPersistenceFailed" }, dependencies, command.ownerId, assetId) : fail({ kind: "MediaCleanupFailed" }, dependencies, command.ownerId, assetId);
  }
  dependencies.logger({ event: "media-ingest-success", ownerId: command.ownerId, runId: command.runId, assetId });
  return { ok: true, value: Object.freeze({ asset, derivative: savedDerivative }) };
}

/** @param {MediaDependencies} dependencies */
export function createMediaPipeline(dependencies) {
  const maximumImageBytes = dependencies?.maximumImageBytes ?? imageLimit;
  if ((dependencies?.publicEgress !== undefined && typeof dependencies.publicEgress?.fetch !== "function") || (dependencies?.trustedRead !== undefined && typeof dependencies.trustedRead?.read !== "function") || typeof dependencies?.digest !== "function" || typeof dependencies?.quarantine?.put !== "function" || typeof dependencies?.quarantine?.remove !== "function" || typeof dependencies?.derivatives?.create !== "function" || typeof dependencies?.repository?.save !== "function" || typeof dependencies?.repository?.read !== "function" || typeof dependencies?.repository?.revoke !== "function" || typeof dependencies?.createId !== "function" || typeof dependencies?.now !== "function" || typeof dependencies?.logger !== "function" || !Number.isSafeInteger(maximumImageBytes) || maximumImageBytes <= 0 || maximumImageBytes > imageLimit) throw new TypeError("Media pipeline dependencies are invalid.");
  return Object.freeze({
    /** @param {unknown} command @returns {Promise<Result<{ readonly asset: MediaAsset, readonly derivative: MediaDerivative }, MediaFailure>>} */
    async ingest(command) {
      if (!record(command) || !text(command.ownerId) || !text(command.runId) || !text(command.knowledgeId) || !text(command.sourceUrl) || !URL.canParse(command.sourceUrl) || new URL(command.sourceUrl).protocol !== "https:" || !Array.isArray(command.allowedOrigins) || !command.allowedOrigins.every((origin) => text(origin) && URL.canParse(origin)) || !validCandidate(command.candidate)) return fail({ kind: "MediaCommandInvalid", field: "command" }, dependencies, undefined, undefined);
      const candidate = /** @type {MediaCandidate} */ (command.candidate);
      if (!candidate.educationallyConnected) return fail({ kind: "MediaEducationalRelevanceRequired" }, dependencies, command.ownerId, undefined);
      const sourceOrigin = new URL(command.sourceUrl).origin;
      let candidateUrl;
      try { candidateUrl = new URL(candidate.url, command.sourceUrl); } catch (error) { return fail({ kind: "MediaCommandInvalid", field: "candidate.url" }, dependencies, command.ownerId, undefined); }
      const allowedOrigins = new Set([sourceOrigin, ...command.allowedOrigins.map((origin) => new URL(origin).origin)]);
      if (!allowedOrigins.has(candidateUrl.origin) || candidateUrl.username !== "" || candidateUrl.password !== "") return fail({ kind: "MediaOriginNotAllowed" }, dependencies, command.ownerId, undefined);
      dependencies.logger({ event: "media-ingest-entry", ownerId: command.ownerId, runId: command.runId });
      const request = new Request(candidateUrl.href, { method: "GET", redirect: "error" });
      const trustedRead = candidateUrl.origin === sourceOrigin && dependencies.trustedRead !== undefined ? dependencies.trustedRead : null;
      let fetched;
      try {
        if (trustedRead !== null) fetched = await trustedRead.read(request);
        else if (dependencies.publicEgress === undefined) return fail({ kind: "MediaPublicEgressUnavailable" }, dependencies, command.ownerId, undefined);
        else fetched = await dependencies.publicEgress.fetch(request);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return fail({ kind: trustedRead === null ? "MediaPublicEgressFailed" : "MediaTrustedReadFailed" }, dependencies, command.ownerId, undefined);
      }
      if (!fetched.ok) return fail(fetched.error, dependencies, command.ownerId, undefined);
      const response = fetched.value;
      if (!response.ok || (response.url !== "" && response.url !== candidateUrl.href)) return fail({ kind: "MediaFetchFailed" }, dependencies, command.ownerId, undefined);
      const declared = (response.headers.get("content-type") ?? candidate.mediaTypeHint).split(";", 1)[0].trim().toLowerCase();
      if (declared === "image/svg+xml" || declared === "text/html" || declared === "application/xhtml+xml") return fail({ kind: "MediaScriptableFormatRejected" }, dependencies, command.ownerId, undefined);
      let bytes;
      try { bytes = new Uint8Array(await response.arrayBuffer()); } catch (error) { return fail({ kind: "MediaFetchFailed" }, dependencies, command.ownerId, undefined); }
      const detected = signature(bytes);
      if (detected !== null && declared !== detected) return fail({ kind: "MediaMimeSignatureConflict" }, dependencies, command.ownerId, undefined);
      return persistImage(dependencies, maximumImageBytes, /** @type {{ readonly ownerId: string, readonly runId: string, readonly knowledgeId: string }} */ (command), candidate, candidateUrl, bytes);
    },
    /** @param {unknown} command @returns {Promise<Result<{ readonly asset: MediaAsset, readonly derivative: MediaDerivative }, MediaFailure>>} */
    async ingestBytes(command) {
      if (!record(command) || !text(command.ownerId) || !text(command.runId) || !text(command.knowledgeId) || !text(command.sourceUrl) || !URL.canParse(command.sourceUrl) || new URL(command.sourceUrl).protocol !== "https:" || !validCandidate(command.candidate) || !(command.bytes instanceof Uint8Array)) return fail({ kind: "MediaCommandInvalid", field: "command" }, dependencies, undefined, undefined);
      const candidate = /** @type {MediaCandidate} */ (command.candidate);
      let candidateUrl;
      try { candidateUrl = new URL(candidate.url, command.sourceUrl); } catch (error) { return fail({ kind: "MediaCommandInvalid", field: "candidate.url" }, dependencies, command.ownerId, undefined); }
      if (candidateUrl.username !== "" || candidateUrl.password !== "" || candidateUrl.origin !== new URL(command.sourceUrl).origin) return fail({ kind: "MediaOriginNotAllowed" }, dependencies, command.ownerId, undefined);
      dependencies.logger({ event: "media-ingest-bytes-entry", ownerId: command.ownerId, runId: command.runId });
      return persistImage(dependencies, maximumImageBytes, /** @type {{ readonly ownerId: string, readonly runId: string, readonly knowledgeId: string }} */ (command), candidate, candidateUrl, command.bytes);
    },
    /** @param {unknown} command @returns {Promise<Result<{ readonly bytes: Uint8Array, readonly mediaType: string }, MediaFailure>>} */
    async serve(command) {
      if (!record(command) || !text(command.ownerId) || !text(command.assetId) || (command.variant !== "feed" && command.variant !== "thumbnail")) return fail({ kind: "MediaCommandInvalid", field: "command" }, dependencies, undefined, undefined);
      const found = await dependencies.repository.read({ ownerId: command.ownerId, assetId: command.assetId, variant: command.variant });
      if (!found.ok) return fail({ kind: "MediaDerivativeNotFound" }, dependencies, command.ownerId, command.assetId);
      if (found.value.revoked) return fail({ kind: "MediaDerivativeRevoked" }, dependencies, command.ownerId, command.assetId);
      return { ok: true, value: Object.freeze({ bytes: found.value.bytes, mediaType: found.value.mediaType }) };
    },
    /** @param {unknown} command @returns {Promise<Result<null, MediaFailure>>} */
    async revoke(command) {
      if (!record(command) || !text(command.ownerId) || !text(command.assetId) || !text(command.originalKey)) return fail({ kind: "MediaCommandInvalid", field: "command" }, dependencies, undefined, undefined);
      const revoked = await dependencies.repository.revoke({ ownerId: command.ownerId, assetId: command.assetId });
      if (!revoked.ok) return fail({ kind: "MediaPersistenceFailed" }, dependencies, command.ownerId, command.assetId);
      const removed = await dependencies.quarantine.remove(command.originalKey);
      return removed.ok ? { ok: true, value: null } : fail({ kind: "MediaCleanupFailed" }, dependencies, command.ownerId, command.assetId);
    },
  });
}

/** @param {string} value @returns {boolean} */
function localFallbackPath(value) {
  if (!text(value) || !value.startsWith("/assets/fallback-media/")) return false;
  let url;
  let decoded;
  try {
    url = new URL(value, "https://local-fallback.invalid");
    decoded = decodeURIComponent(url.pathname);
  } catch (error) {
    return false;
  }
  if (url.origin !== "https://local-fallback.invalid" || url.search !== "" || url.hash !== "" || url.pathname !== value || decoded.includes("\\") || decoded.includes("\0")) return false;
  const relative = decoded.slice("/assets/fallback-media/".length);
  return relative !== "" && !relative.includes("/") && relative !== "." && relative !== "..";
}

/** @param {unknown} value @returns {Result<UserAttestedLocalManifest, FallbackManifestFailure>} */
export function createUserAttestedLocalManifest(value) {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: { kind: "FallbackManifestInvalid", field: "entries" } };
  /** @type {FallbackAsset[]} */ const entries = [];
  const ids = new Set();
  const paths = new Set();
  for (const asset of value) {
    if (!record(asset) || typeof asset.id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(asset.id) || typeof asset.path !== "string" || !localFallbackPath(asset.path) || (asset.url !== undefined && asset.url !== asset.path) || (asset.mediaType !== "image/jpeg" && asset.mediaType !== "image/png") || typeof asset.width !== "number" || !Number.isSafeInteger(asset.width) || asset.width <= 0 || typeof asset.height !== "number" || !Number.isSafeInteger(asset.height) || asset.height <= 0 || asset.userAttested !== true) return { ok: false, error: { kind: "FallbackManifestInvalid", field: "entry" } };
    if (ids.has(asset.id)) return { ok: false, error: { kind: "FallbackManifestDuplicateId", assetId: asset.id } };
    if (paths.has(asset.path)) return { ok: false, error: { kind: "FallbackManifestDuplicatePath", path: asset.path } };
    ids.add(asset.id);
    paths.add(asset.path);
    entries.push(Object.freeze({ id: asset.id, path: asset.path, mediaType: asset.mediaType, width: asset.width, height: asset.height, userAttested: true }));
  }
  const frozenEntries = Object.freeze(entries);
  const byId = new Map(frozenEntries.map((asset) => [asset.id, asset]));
  return {
    ok: true,
    value: Object.freeze({
      entries: frozenEntries,
      /** @param {{ readonly assetId: string, readonly path: string }} reference */
      resolve(reference) {
        if (!record(reference) || !text(reference.assetId) || typeof reference.path !== "string" || !localFallbackPath(reference.path)) return { ok: false, error: { kind: "FallbackReferenceInvalid" } };
        const asset = byId.get(reference.assetId);
        return asset === undefined || asset.path !== reference.path ? { ok: false, error: { kind: "FallbackAssetUnlisted" } } : { ok: true, value: asset };
      },
    }),
  };
}

/** @param {Uint8Array} bytes @returns {{ readonly mediaType: "image/jpeg" | "image/png", readonly width: number, readonly height: number } | null} */
function rasterMetadata(bytes) {
  if (bytes.length >= 24 && signature(bytes) === "image/png") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { mediaType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length < 12 || signature(bytes) !== "image/jpeg") return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 7) return null;
      return { mediaType: "image/jpeg", width: (bytes[offset + 5] << 8) | bytes[offset + 6], height: (bytes[offset + 3] << 8) | bytes[offset + 4] };
    }
    offset += length;
  }
  return null;
}

/** @param {UserAttestedLocalManifest} manifest @param {(path: string) => Promise<Uint8Array>} read @returns {Promise<Result<readonly FallbackAsset[], FallbackManifestFailure>>} */
export async function validateUserAttestedLocalFiles(manifest, read) {
  if (!record(manifest) || !Array.isArray(manifest.entries) || typeof manifest.resolve !== "function" || typeof read !== "function") return { ok: false, error: { kind: "FallbackManifestInvalid", field: "dependencies" } };
  for (const asset of manifest.entries) {
    /** @type {Uint8Array} */ let bytes;
    try { bytes = await read(asset.path); } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { ok: false, error: { kind: error.name === "NotFound" || error.name === "NotFoundError" ? "FallbackAssetMissing" : "FallbackAssetReadFailed", assetId: asset.id } };
    }
    const actual = bytes instanceof Uint8Array ? rasterMetadata(bytes) : null;
    if (actual === null || actual.mediaType !== asset.mediaType) return { ok: false, error: { kind: "FallbackAssetMetadataMismatch", assetId: asset.id, field: "mediaType" } };
    if (actual.width !== asset.width || actual.height !== asset.height) return { ok: false, error: { kind: "FallbackAssetMetadataMismatch", assetId: asset.id, field: "dimensions" } };
  }
  return { ok: true, value: manifest.entries };
}

/** @deprecated Use createUserAttestedLocalManifest. @param {unknown} value @returns {Result<readonly FallbackAsset[], MediaFailure>} */
export function validateFallbackPack(value) {
  const manifest = createUserAttestedLocalManifest(value);
  return manifest.ok ? { ok: true, value: manifest.value.entries } : manifest;
}

/** @param {UserAttestedLocalManifest} manifest @param {string} knowledgeId @returns {FallbackAsset} */
export function selectFallbackAsset(manifest, knowledgeId) {
  if (!record(manifest) || !Array.isArray(manifest.entries) || manifest.entries.length === 0 || typeof manifest.resolve !== "function" || !text(knowledgeId)) throw new TypeError("Fallback selection inputs are invalid.");
  let hash = 2166136261;
  for (const character of knowledgeId) { hash ^= character.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619); }
  const selected = manifest.entries[Math.abs(hash) % manifest.entries.length];
  const resolved = manifest.resolve({ assetId: selected.id, path: selected.path });
  if (!resolved.ok) throw new TypeError("Fallback manifest invariant failed.");
  return resolved.value;
}

export {};
