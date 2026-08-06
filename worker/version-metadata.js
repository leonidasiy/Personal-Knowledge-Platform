// @ts-check

/** @typedef {{ readonly id: string }} WorkerVersionMetadata */
/** @typedef {{ readonly kind: "WorkerVersionMetadataInvalid", readonly field: "id" }} WorkerVersionMetadataInvalid */
/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/**
 * Adds the deployment version identifier to a response after validating the
 * narrow metadata contract exposed by Cloudflare.
 *
 * @param {Response} response
 * @param {unknown} metadata
 * @returns {Result<Response, WorkerVersionMetadataInvalid>}
 */
export function attachWorkerVersion(response, metadata) {
  if (!isWorkerVersionMetadata(metadata)) {
    return {
      ok: false,
      error: { kind: "WorkerVersionMetadataInvalid", field: "id" },
    };
  }

  const headers = new Headers(response.headers);
  headers.set("x-resonance-worker-version", metadata.id);
  return {
    ok: true,
    value: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  };
}

/** @param {unknown} value @returns {value is WorkerVersionMetadata} */
function isWorkerVersionMetadata(value) {
  return typeof value === "object" && value !== null && "id" in value &&
    typeof value.id === "string" && value.id.trim() !== "";
}
