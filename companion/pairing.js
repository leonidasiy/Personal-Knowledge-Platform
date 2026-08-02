// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */
/** @typedef {{ readonly kind: "CompanionPairingInvalid", readonly field: string } | { readonly kind: "LocalWorkerUnavailable" } | { readonly kind: "LocalWorkerAuthenticationFailed" }} PairingClientFailure */

/**
 * Keep the app-generated secret in the companion closure and attach it only to
 * authenticated control-plane calls. It is never returned by this API.
 *
 * @param {unknown} rawCredential
 * @param {unknown} rawModel
 * @param {{
 *   readonly pull: (request: { readonly pairingId: string, readonly companionId: string, readonly secret: Uint8Array, readonly modelId: string, readonly modelVersion: string }) => Promise<Result<unknown, { readonly kind: string }>>,
 *   readonly submit: (request: { readonly pairingId: string, readonly companionId: string, readonly secret: Uint8Array, readonly modelId: string, readonly modelVersion: string, readonly jobId: string, readonly leaseToken: string, readonly result: unknown }) => Promise<Result<unknown, { readonly kind: string }>>,
 * }} transport
 * @returns {Result<{ readonly pull: () => Promise<Result<unknown, PairingClientFailure | { readonly kind: string }>>, readonly submit: (jobId: string, leaseToken: string, result: unknown) => Promise<Result<unknown, PairingClientFailure | { readonly kind: string }>> }, PairingClientFailure>}
 */
export function createPairingClient(rawCredential, rawModel, transport) {
  if (!isRecord(rawCredential)) return invalid("credential");
  if (!nonBlank(rawCredential.pairingId)) return invalid("pairingId");
  if (!nonBlank(rawCredential.companionId)) return invalid("companionId");
  if (!(rawCredential.secret instanceof Uint8Array) || rawCredential.secret.byteLength < 32) return invalid("secret");
  if (!isRecord(rawModel) || !nonBlank(rawModel.id)) return invalid("model.id");
  if (!nonBlank(rawModel.version)) return invalid("model.version");
  if (typeof transport.pull !== "function" || typeof transport.submit !== "function") throw new TypeError("Pairing transport is invalid.");
  const pairingId = /** @type {string} */ (rawCredential.pairingId);
  const companionId = /** @type {string} */ (rawCredential.companionId);
  const modelId = rawModel.id;
  const modelVersion = rawModel.version;
  const secret = rawCredential.secret.slice();
  return {
    ok: true,
    value: Object.freeze({
      pull: () => invoke(() => transport.pull({ pairingId, companionId, secret: secret.slice(), modelId, modelVersion })),
      submit: (
        /** @type {string} */ jobId,
        /** @type {string} */ leaseToken,
        /** @type {unknown} */ result,
      ) => {
        if (!nonBlank(jobId)) return Promise.resolve(invalid("jobId"));
        if (!nonBlank(leaseToken)) return Promise.resolve(invalid("leaseToken"));
        return invoke(() => transport.submit({ pairingId, companionId, secret: secret.slice(), modelId, modelVersion, jobId, leaseToken, result }));
      },
    }),
  };
}

/**
 * @param {() => Promise<Result<unknown, { readonly kind: string }>>} operation
 * @returns {Promise<Result<unknown, PairingClientFailure | { readonly kind: string }>>}
 */
async function invoke(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error) return /** @type {const} */ ({ ok: false, error: { kind: "LocalWorkerUnavailable" } });
    throw error;
  }
}
/** @param {string} field @returns {Result<never, PairingClientFailure>} */
function invalid(field) { return { ok: false, error: { kind: "CompanionPairingInvalid", field } }; }
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function nonBlank(value) { return typeof value === "string" && value.trim() !== ""; }

export {};
