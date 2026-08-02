// @ts-check

/** @typedef {{ readonly fetch: (request: Request) => Promise<Response> }} WorkerFetcher */
/** @typedef {{ readonly kind: string, readonly field?: string }} ApiCompositionFailure */
/** @typedef {{ readonly ok: true, readonly value: WorkerFetcher } | { readonly ok: false, readonly error: ApiCompositionFailure }} ApiCompositionResult */
/** @typedef {{ readonly kind: "UnifiedWorkerBindingInvalid", readonly field: "ASSETS" | "createApiWorker" }} UnifiedWorkerFailure */
/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/**
 * Keep static delivery outside API composition so asset requests do not spend
 * CPU on authentication, database clients, or provider adapters.
 *
 * @param {{
 *   readonly assets: unknown,
 *   readonly createApiWorker: unknown,
 * }} dependencies
 * @returns {Result<WorkerFetcher, UnifiedWorkerFailure>}
 */
export function createUnifiedWorkerRouter(dependencies) {
  if (!isWorkerFetcher(dependencies.assets)) {
    return {
      ok: false,
      error: { kind: "UnifiedWorkerBindingInvalid", field: "ASSETS" },
    };
  }
  if (typeof dependencies.createApiWorker !== "function") {
    return {
      ok: false,
      error: {
        kind: "UnifiedWorkerBindingInvalid",
        field: "createApiWorker",
      },
    };
  }

  const assets = dependencies.assets;
  const createApiWorker = /** @type {() => ApiCompositionResult} */ (
    dependencies.createApiWorker
  );
  return {
    ok: true,
    value: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname !== "/api" && !pathname.startsWith("/api/")) {
          return assets.fetch(request);
        }

        const composed = createApiWorker();
        if (composed.ok) return composed.value.fetch(request);
        return configurationFailureResponse(composed.error);
      },
    },
  };
}

/** @param {ApiCompositionFailure} failure */
function configurationFailureResponse(failure) {
  return new Response(JSON.stringify({
    error: failure.kind,
    ...(failure.field === undefined ? {} : { field: failure.field }),
  }), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** @param {unknown} value @returns {value is WorkerFetcher} */
function isWorkerFetcher(value) {
  return typeof value === "object" && value !== null &&
    "fetch" in value && typeof value.fetch === "function";
}
