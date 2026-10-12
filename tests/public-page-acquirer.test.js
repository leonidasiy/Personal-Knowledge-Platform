// @ts-check
import { PublicPageAcquirer } from "../worker/public-page-acquirer.js";
import { createAcquisitionClient } from "../worker/acquisition-client.js";
import { ACQUISITION_POLICY as policy } from "../worker/acquisition-policy.js";
/** @param {unknown} a @param {unknown} b */
function equal(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error("assertion failed");
  }
}
const root = "https://publisher.example/course/";
const cursor = {
  version: 1,
  nextOrdinal: 0,
  pagesProcessed: 0,
  decodedBytes: 0,
  redirects: 0,
  frontier: [{
    ordinal: 0,
    url: root,
    depth: 0,
    state: /** @type {const} */ ("pending"),
    discoveredFromUrl: null,
  }],
};
const job = {
  ownerId: "owner-a",
  jobId: "job-a",
  sourceId: "source-a",
  sourceRevision: 1,
  rootUrl: root,
  cursor,
};
const capability = {
  outcome: /** @type {const} */ ("allowed"),
  evidenceReference: "https://publisher.example/rights",
  observedAt: "2026-07-22T10:00:00.000Z",
  expiresAt: null,
};
const rights = {
  registryId: "rights-a",
  registryVersion: "1",
  ownerId: "owner-a",
  sourceId: "source-a",
  sourceRevision: 1,
  canonicalRootUrl: root,
  capabilities: {
    storage: capability,
    display: capability,
    transformation: capability,
  },
  attributionText: "Publisher",
  evidenceDigest: "sha256:rights",
  assessorId: "review",
  assessorVersion: "1",
  observedAt: "2026-07-22T10:00:00.000Z",
  expiresAt: null,
};
const plan = {
  policyVersion: "bounded-v1",
  ownerId: "owner-a",
  sourceId: "source-a",
  sourceRevision: 1,
  rootUrl: root,
  selectedDepth: 2,
  depthReason: /** @type {const} */ ("policy-default"),
  depthEvidence: null,
  maximumPages: 100,
  maximumDecodedBytes: 25_000_000,
  maximumConcurrency: 2,
  maximumDurationMs: 120_000,
  maximumRedirects: 3,
  refreshIntervalMs: 604_800_000,
  assessedAt: "2026-07-22T12:00:00.000Z",
};

Deno.test("public sibling acquirer preserves rights identity, frontier, caps and public peer provenance", async () => {
  let requests = 0;
  const client = createAcquisitionClient({
    binding: {
      fetch: async (/** @type {Request} */ req) => {
        requests++;
        const command = await req.json();
        return Response.json({
          ok: true,
          value: {
            peerAddress: "8.8.8.8",
            status: 200,
            headers: { "content-type": "text/html" },
            bodyBase64: btoa("<main>lesson</main>"),
            finalUrl: command.request.url,
            redirectHops: [],
            projection: {
              html: "<main>lesson</main>",
              renderedTitle: "Lesson",
              renderedText: "Readable lesson",
              visibleLinks: [root + "next", "https://other.example/"],
            },
          },
        });
      },
    },
    endpoint: "https://service.test/",
    token: "fixture-token-a",
    policy,
    createId: () => `fixture-id-${requests}-0000`,
  });
  const subject = new PublicPageAcquirer({
    client,
    policy,
    now: () => "2026-10-06T00:00:00.000Z",
    maximumPagesPerRun: 1,
    maximumFrontierEntries: 10,
    maximumRunMilliseconds: 30000,
    logger: () => {},
  });
  const result = await subject.acquire({ job, cursor, plan, rights });
  equal(result.ok, true);
  if (result.ok) {
    equal(result.value.pages.length, 1);
    equal(result.value.pages[0].peerAddress, "8.8.8.8");
    equal(result.value.nextCursor?.frontier.length, 2);
    equal(result.value.stopReason, "BrowserRunExtractionLimitExceeded");
  }
  const invalid = await subject.acquire({
    job,
    cursor,
    plan,
    rights: { ...rights, ownerId: "other" },
  });
  equal(invalid.ok, false);
  if (!invalid.ok) {
    equal(invalid.error.kind, "RightsRegistryEvidenceConflicting");
  }
  equal(requests, 1);
});
Deno.test("public sibling missing binding fails named without Cloudflare browser fallback", async () => {
  const client = createAcquisitionClient({
    binding: null,
    endpoint: null,
    token: null,
    policy,
    createId: () => "fixture-id-0000",
  });
  const subject = new PublicPageAcquirer({
    client,
    policy,
    now: () => "2026-10-06T00:00:00.000Z",
    maximumPagesPerRun: 1,
    maximumFrontierEntries: 10,
    maximumRunMilliseconds: 30000,
    logger: () => {},
  });
  const r = await subject.acquire({ job, cursor, plan, rights });
  equal(r.ok, false);
  if (!r.ok) equal(r.error.kind, "BrowserRunUnavailable");
});
