// @ts-check

import { attachWorkerVersion } from "./version-metadata.js";

/** @typedef {{ readonly fetch: (request: Request) => Promise<Response> }} WorkerFetcher */
/** @typedef {{ readonly kind: string, readonly field?: string }} RouterFailure */
/** @typedef {{ readonly ok: true, readonly value: WorkerFetcher } | { readonly ok: false, readonly error: RouterFailure }} RouterResult */

/**
 * Composes a configured router with the deployment version metadata boundary.
 *
 * @param {RouterResult} routed
 * @param {Request} request
 * @param {unknown} metadata
 * @returns {Promise<Response>}
 */
export async function routeWithWorkerVersion(routed, request, metadata) {
  const response = routed.ok
    ? await routed.value.fetch(request)
    : configurationFailureResponse(routed.error);
  const attached = attachWorkerVersion(response, metadata);
  return attached.ok
    ? attached.value
    : Response.json(
      { error: attached.error.kind, field: attached.error.field },
      {
        status: 503,
        headers: { "cache-control": "no-store" },
      },
    );
}

/** @param {RouterFailure} failure */
function configurationFailureResponse(failure) {
  return new Response(
    JSON.stringify({
      error: failure.kind,
      ...(failure.field === undefined ? {} : { field: failure.field }),
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
