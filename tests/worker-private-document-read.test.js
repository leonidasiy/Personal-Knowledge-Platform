// @ts-check

import { createDiscoveryWorker } from "../worker/handler.js";

/** @typedef {ReturnType<typeof import("../worker/private-document-read.js").createPrivateDocumentReadService>} ReadService */
/** @typedef {Extract<Awaited<ReturnType<ReadService["read"]>>, {ok: true}>["value"]} ReadValue */
/** @param {{ readonly response?: ReadValue, readonly failure?: import("../worker/private-document-read.js").PrivateDocumentReadFailure["kind"], readonly authenticated?: boolean }} [options] */
function fixture(options = {}) {
  let calls = 0;
  /** @type {ReadService} */
  const privateDocumentRead = {
    async read() {
      calls += 1;
      if (options.failure !== undefined) return { ok: /** @type {const} */ (false), error: { kind: options.failure } };
      return { ok: true, value: options.response ?? { status: "attached", title: "Week 3", sourceId: "source-a", runId: "run-a", bytes: new Uint8Array([1, 2, 3]), mediaType: "application/pdf", fileName: "week 3.pdf" } };
    },
  };
  return {
    calls: () => calls,
    worker: createDiscoveryWorker({ allowedOrigin: "https://app.example", maximumCommandBytes: 4096 }, {
      authenticate: async () => options.authenticated === false ? { ok: false, error: { kind: "DiscoveryClientUnauthenticated" } } : { ok: true, value: { ownerId: "owner-a", email: "member@example" } },
      acquireRss: async () => ({ ok: false, error: { kind: "DiscoveryFetchUnavailable" } }),
      privateDocumentRead,
    }),
  };
}

/** @param {Response} response @param {number} status */
function status(response, status) { if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}.`); }

Deno.test("private document GET serves an owner attachment with private headers", async () => {
  const value = fixture();
  const response = await value.worker.fetch(new Request("https://worker.example/api/private-documents/source-a", { headers: { origin: "https://app.example" } }));
  status(response, 200);
  if (response.headers.get("content-type") !== "application/pdf" || response.headers.get("x-content-type-options") !== "nosniff" || response.headers.get("cache-control") !== "private, no-store" || !response.headers.get("content-disposition")?.includes("attachment")) throw new Error("Expected safe attachment headers.");
  if ((await response.arrayBuffer()).byteLength !== 3 || value.calls() !== 1) throw new Error("Expected exact attachment bytes.");
});

Deno.test("private document GET returns pending metadata without attachment bytes", async () => {
  const value = fixture({ response: { status: "pending", title: "Week 3", sourceId: "source-a", runId: "run-a" } });
  const response = await value.worker.fetch(new Request("https://worker.example/api/private-documents/source-a"));
  status(response, 200);
  if (response.headers.get("cache-control") !== "private, no-store" || (await response.json()).result.status !== "pending") throw new Error("Expected private pending metadata.");
});

for (const [label, request, expected] of /** @type {const} */ ([
  ["wrong method", new Request("https://worker.example/api/private-documents/source-a", { method: "POST" }), 405],
  ["malformed source id", new Request("https://worker.example/api/private-documents/%E0%A4%A"), 400],
])) Deno.test(`private document GET rejects ${label}`, async () => { const value = fixture(); const response = await value.worker.fetch(request); status(response, expected); if (value.calls() !== 0) throw new Error("Read port must not run."); });

for (const [failure, expected] of /** @type {const} */ ([["PrivateDocumentNotFound", 404], ["PrivateDocumentNotPrivate", 403], ["PrivateDocumentContentReadFailed", 503]])) Deno.test(`private document GET maps ${failure}`, async () => { const value = fixture({ failure }); const response = await value.worker.fetch(new Request("https://worker.example/api/private-documents/source-a")); status(response, expected); });

Deno.test("authentication failure prevents private document port access", async () => { const value = fixture({ authenticated: false }); const response = await value.worker.fetch(new Request("https://worker.example/api/private-documents/source-a")); status(response, 401); if (value.calls() !== 0) throw new Error("Unauthenticated request reached private read port."); });
