// @ts-check

import { createDiscoveryWorker } from "../worker/handler.js";

const profile = Object.freeze({
  profileId: "example-public-v1",
  canonicalRootUrl: "https://example.test/learn/",
  origin: "https://example.test/",
  access: "public",
  attributionText: "Example attribution.",
  robotsUrl: "https://example.test/robots.txt",
  evidence: Object.freeze([]),
});

Deno.test("source approval starts the workflow with server-owned rights evidence", async () => {
  /** @type {Record<string, unknown> | null} */ let started = null;
  const source = { id: "source-a", ownerId: "owner-a", canonicalUrl: "https://example.test/learn/", revision: 1, state: "active" };
  const worker = createDiscoveryWorker({ allowedOrigin: "https://app.example", maximumCommandBytes: 4096 }, {
    authenticate: async () => ({ ok: true, value: { ownerId: "owner-a", email: "member@example.test" } }),
    acquireRss: async () => ({ ok: false, error: { kind: "DiscoveryFetchUnavailable" } }),
    sourceLibrary: {
      approve: async () => ({ ok: true, value: { source, job: null, reused: false } }),
      revise: async () => ({ ok: true, value: source }),
      disable: async () => ({ ok: true, value: source }),
      restore: async () => ({ ok: true, value: source }),
      reject: async () => ({ ok: true, value: { suppression: {}, reused: false } }),
    },
    knowledgeWorkflow: {
      start: async (command) => { started = /** @type {Record<string, unknown>} */ (command); return { ok: true, value: { runId: "run-a", reused: false } }; },
      status: async () => ({ ok: true, value: {} }),
      control: async () => ({ ok: true, value: {} }),
    },
    sourceRightsProfileFor: () => profile,
  });
  const response = await worker.fetch(new Request("https://worker.example/api/source-library/approve", { method: "POST", headers: { origin: "https://app.example" }, body: JSON.stringify({ identityStatus: "resolved", submittedUrl: "https://example.test/learn/", canonicalUrl: "https://example.test/learn/", title: "Example", description: "Example source", idempotencyKey: "approve-a", adapter: { id: "adapter", version: "1", granularity: "root", capabilities: ["metadata"] }, interestAreaIds: ["music"], identityEvidence: [] }) }));
  if (response.status !== 200) throw new Error(`Unexpected status ${response.status}`);
  const received = /** @type {Record<string, unknown> | null} */ (/** @type {unknown} */ (started));
  if (received === null || received["rightsProfile"] !== profile) throw new Error("The workflow did not receive the server-owned rights profile.");
});
