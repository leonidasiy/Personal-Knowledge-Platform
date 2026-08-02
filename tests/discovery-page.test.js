// @ts-check

import { MemoryPersistence } from "../src/persistence/memory.js";
import { createDiscoveryPage } from "../src/startup/discovery-page.js";

const APP_DOCUMENT = await Deno.readTextFile(
  new URL("../index.html", import.meta.url),
);
const COPY_TEXT = APP_DOCUMENT.match(
  /<script id="app-copy" type="application\/json">([\s\S]*?)<\/script>/,
)?.[1];
if (COPY_TEXT === undefined) throw new Error("App copy fixture is missing.");
const MARKUP =
  /** @type {{discoverMarkup:import("../src/routes/discover.js").DiscoverMarkup}} */ (
    JSON.parse(COPY_TEXT)
  ).discoverMarkup;
const STARTERS = JSON.parse(
  await Deno.readTextFile(
    new URL("../assets/discovery-starters.json", import.meta.url),
  ),
);

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const librarySource = Object.freeze({
  id: "source-a",
  ownerId: "owner-a",
  submittedUrl: "https://learningmusic.ableton.com/",
  canonicalUrl: "https://learningmusic.ableton.com/",
  title: "Ableton Learning Music",
  description: "Music learning source.",
  adapter: Object.freeze({
    id: "starter-adapter",
    version: "1",
    granularity: "publisher-root",
    capabilities: Object.freeze(["metadata"]),
  }),
  interestAreaIds: Object.freeze(["area-a"]),
  identityEvidence: Object.freeze([]),
  state: "active",
  approvedAt: "2026-07-22T08:00:00.000Z",
  updatedAt: "2026-07-22T08:00:00.000Z",
  revision: 1,
});

Deno.test("Discovery controller writes only explicit Add or Reject decisions", async () => {
  const storage = new MemoryPersistence();
  let appendCalls = 0;
  let decisionRequests = 0;
  let rejectFails = false;
  let manualUploads = 0;
  let oauthRequests = 0;
  let centralSearchRequests = 0;
  /** @type {unknown} */ let centralSearchCommand = null;
  /** @type {Record<string,unknown>[]} */ const approvalCommands = [];
  /** @type {() => void} */
  let approveRelease = () => {};
  let holdApproval = false;
  const approvalGate = new Promise((resolve) => {
    approveRelease = () => resolve(undefined);
  });
  /** @type {string[]} */ const notices = [];
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ const destinations = [];
  let nextId = 0;
  const page = createDiscoveryPage({
    ownerId: "owner-a",
    persistence: {
      appendBatch: (records) => {
        appendCalls += 1;
        return storage.appendBatch(records);
      },
      list: storage.list.bind(storage),
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/discovery/search/capabilities") {
        return Response.json({ result: [
          { id: "web", label: "Web", resultKind: "web", priority: 1, enabled: true },
          { id: "podcasts", label: "Podcasts", resultKind: "podcast", priority: 2, enabled: true },
          { id: "youtube", label: "YouTube videos", resultKind: "video", priority: 3, enabled: true },
        ] });
      }
      if (path === "/api/discovery/search") {
        centralSearchRequests += 1;
        centralSearchCommand = await request.json();
        return Response.json({ result: {
          items: [{
            providerId: "web",
            resultKind: "web",
            sourceLevel: "site",
            title: "Counterpoint course library",
            description: "Educational lessons in species counterpoint.",
            canonicalUrl: "https://counterpoint.example/",
            publisherLabel: null,
            publishedAt: null,
            identityEvidence: [{
              attribute: "provider-result-page",
              value: "https://counterpoint.example/lessons/",
              provenanceUrl: "https://counterpoint.example/lessons/",
            }],
          }, {
            providerId: "youtube",
            resultKind: "video",
            sourceLevel: "video",
            title: "Official harmony tutorial title",
            description: null,
            canonicalUrl: "https://www.youtube.com/watch?v=harmony",
            publisherLabel: "Music Teacher",
            publishedAt: "2026-07-01T00:00:00.000Z",
            identityEvidence: [{
              attribute: "official-youtube-video",
              value: "harmony",
              provenanceUrl: "https://www.youtube.com/watch?v=harmony",
            }],
          }, {
            providerId: "podcasts",
            resultKind: "podcast",
            sourceLevel: "feed",
            title: "Official harmony podcast title",
            description: "Provider-authored podcast description.",
            canonicalUrl: "https://feeds.example/harmony.xml",
            publisherLabel: "Example Radio",
            publishedAt: null,
            identityEvidence: [{
              attribute: "taddy-series-uuid",
              value: "6bdfd429-f58b-427d-8072-353d478aa15f",
              provenanceUrl: "https://api.taddy.org/",
            }, {
              attribute: "podcast-feed",
              value: "https://feeds.example/harmony.xml",
              provenanceUrl: "https://feeds.example/harmony.xml",
            }],
          }],
          providerFailures: [],
          submittedQuery: "counterpoint",
          providerQuery: "counterpoint tutorial lesson course educational",
          policyVersion: "educational-v1",
        } });
      }
      if (path === "/api/discovery/youtube/oauth/connection") {
        oauthRequests += 1;
        return new Response(null, { status: 404 });
      }
      if (path === "/api/source-library" && request.method === "GET") {
        return Response.json({
          result: {
            items: [librarySource],
            interestAreas: [{
              id: "area-a",
              ownerId: "owner-a",
              title: "Music",
              provenance: "configured",
            }],
            nextCursor: null,
          },
        });
      }
      if (path === "/api/source-library/suppressions/check") {
        return Response.json({ result: [] });
      }
      if (path === "/api/source-library/approve") {
        decisionRequests += 1;
        approvalCommands.push(
          /** @type {Record<string,unknown>} */ (await request.json()),
        );
        if (holdApproval) await approvalGate;
        return Response.json({
          result: { source: librarySource, reused: false },
        });
      }
      if (path === "/api/source-library/reject") {
        decisionRequests += 1;
        if (rejectFails) {
          return Response.json(
            { error: "SourceSuppressionFailed" },
            { status: 503 },
          );
        }
        const body = /** @type {Record<string, unknown>} */ (
          await request.json()
        );
        return Response.json({
          result: {
            suppression: {
              id: "suppression-a",
              ownerId: "owner-a",
              canonicalIdentity: body.canonicalIdentity,
              identityEvidence: body.identityEvidence,
              idempotencyKey: body.idempotencyKey,
              createdAt: "2026-07-22T08:00:00.000Z",
            },
            reused: false,
          },
        });
      }
      if (path === "/api/source-library/manual-material") {
        manualUploads += 1;
        return Response.json({
          result: { status: "processing-ready", reused: false },
        });
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    },
    gatewayBaseUrl: "https://app.example/",
    policyStorage: {
      getItem: () => JSON.stringify({
        version: "youtube-api-services-v1",
        acceptedAt: "2026-07-22T07:59:00.000Z",
      }),
      setItem: () => {},
    },
    starterInventory: STARTERS,
    markup: MARKUP,
    escapeHtml: (value) => value,
    createId: () => `id-${++nextId}`,
    now: () => "2026-07-22T08:00:00.000Z",
    onNotice: (message) => notices.push(message),
    onError: (message) => errors.push(message),
    navigateToLibrary: (sourceId) => destinations.push(sourceId),
    rerender: () => {},
  });
  const loaded = await page.load();
  assert(loaded.ok, "Starter discovery must load.");
  assert(oauthRequests === 0, "Page load must not call removed OAuth routes.");
  const writesAfterLoad = appendCalls;
  const list = page.render({ selectedItemId: null, online: true });
  assert(
    list.includes("Ableton Learning Music"),
    "Starter source must render.",
  );
  assert(
    manualUploads === 0,
    "Ordinary source approval must not upload material.",
  );
  assert(
    appendCalls === writesAfterLoad && decisionRequests === 0,
    "Rendering or ignoring a result must write no decision.",
  );
  assert(
    list.includes("data-discovery-search-form") &&
      !list.includes("data-discovery-rss-form") &&
      !list.includes("data-discovery-youtube-form"),
    "Discover must expose one centralized search form.",
  );
  const itemIds = [...list.matchAll(/data-discovery-item-id="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert(
    itemIds.length >= 3,
    "Controller fixture requires three source items.",
  );

  holdApproval = true;
  const first = page.approve(itemIds[0], "area-a");
  const repeated = page.approve(itemIds[0], "area-a");
  await repeated;
  assert(
    decisionRequests === 1,
    `Approval must be single-flight; received ${decisionRequests} requests.`,
  );
  approveRelease();
  await first;
  assert(
    notices.includes("Source added to your Library.") &&
      destinations.includes("source-a"),
    "Successful approval must confirm and navigate to Library.",
  );

  await page.reject(itemIds[1]);
  const afterReject = page.render({ selectedItemId: null, online: true });
  assert(
    !afterReject.includes(`data-discovery-item-id="${itemIds[1]}"`),
    "Accepted suppression must hide the source immediately.",
  );

  rejectFails = true;
  await page.reject(itemIds[2]);
  const afterFailure = page.render({ selectedItemId: null, online: true });
  assert(
    afterFailure.includes(`data-discovery-item-id="${itemIds[2]}"`) &&
      errors.includes("The Library decision could not be saved."),
    "Rejected suppression must remain visible with an explicit failure.",
  );
  const searched = await page.search({
    query: "counterpoint",
    providerIds: ["web", "podcasts", "youtube"],
    limit: 10,
  });
  assert(searched.ok, "Central search must succeed.");
  assert(
    centralSearchRequests === 1 &&
      JSON.stringify(centralSearchCommand) === JSON.stringify({
        query: "counterpoint",
        providerIds: ["web", "podcasts", "youtube"],
        limit: 10,
      }) &&
      page.render({ selectedItemId: null, online: true }).includes(
        "Counterpoint course library",
      ),
    "Central search must send one typed command and render its source metadata.",
  );
  const searchedHtml = page.render({ selectedItemId: null, online: true });
  const searchedIds = [...searchedHtml.matchAll(/data-discovery-item-id="([^"]+)"/g)]
    .map((match) => match[1]);
  await page.approve(searchedIds[1], "area-a");
  const youtubeApproval = approvalCommands.at(-1);
  const initialItem = youtubeApproval?.initialItem;
  assert(
    youtubeApproval?.title === "Saved YouTube video" &&
      youtubeApproval.description ===
        "Saved video link. Upload a permitted transcript to create learning material." &&
      typeof initialItem === "object" && initialItem !== null &&
      "publishedAt" in initialItem && initialItem.publishedAt === null &&
      !JSON.stringify(youtubeApproval).includes("Official harmony tutorial title") &&
      !JSON.stringify(youtubeApproval).includes("Music Teacher"),
    "Library approval must retain the selected link without durable official YouTube metadata.",
  );
  await page.approve(searchedIds[2], "area-a");
  const podcastApproval = approvalCommands.at(-1);
  assert(
    podcastApproval?.title === "Saved podcast feed" &&
      podcastApproval.description ===
        "Saved podcast feed link. Review eligibility and rights before acquiring material." &&
      podcastApproval.initialItem === null &&
      JSON.stringify(podcastApproval.adapter) === JSON.stringify({
        id: "central-search:podcasts",
        version: "educational-v1",
        granularity: "feed",
        capabilities: ["metadata"],
      }) &&
      !JSON.stringify(podcastApproval).includes("Official harmony podcast title") &&
      !JSON.stringify(podcastApproval).includes("Provider-authored podcast description") &&
      !JSON.stringify(podcastApproval).includes("Example Radio") &&
      JSON.stringify(podcastApproval).includes("6bdfd429-f58b-427d-8072-353d478aa15f"),
    "Podcast approval must keep feed evidence without retaining provider preview metadata or enabling ingestion.",
  );
});

Deno.test("Central search requires YouTube consent only when YouTube is selected", async () => {
  const storage = new MemoryPersistence();
  let centralRequests = 0;
  /** @type {string[]} */ const errors = [];
  const page = createDiscoveryPage({
    ownerId: "owner-a",
    persistence: {
      appendBatch: storage.appendBatch.bind(storage),
      list: storage.list.bind(storage),
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/discovery/search/capabilities") {
        return Response.json({ result: [
          { id: "web", label: "Web", resultKind: "web", priority: 1, enabled: true },
          { id: "youtube", label: "YouTube videos", resultKind: "video", priority: 2, enabled: true },
        ] });
      }
      if (path === "/api/discovery/search") {
        centralRequests += 1;
        return Response.json({ result: {
          items: [],
          providerFailures: [],
          submittedQuery: "harmony",
          providerQuery: "harmony tutorial lesson course educational",
          policyVersion: "educational-v1",
        } });
      }
      if (path === "/api/source-library" && request.method === "GET") {
        return Response.json({ result: {
          items: [],
          interestAreas: [{
            id: "area-a",
            ownerId: "owner-a",
            title: "Music",
            provenance: "configured",
          }],
          nextCursor: null,
        } });
      }
      if (path === "/api/source-library/suppressions/check") {
        return Response.json({ result: [] });
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    },
    gatewayBaseUrl: "https://app.example/",
    policyStorage: { getItem: () => null, setItem: () => {} },
    starterInventory: STARTERS,
    markup: MARKUP,
    escapeHtml: (value) => value,
    createId: () => "consent-id",
    now: () => "2026-07-28T08:00:00.000Z",
    onNotice: () => {},
    onError: (message) => errors.push(message),
    navigateToLibrary: () => {},
    rerender: () => {},
  });
  await page.load();
  const blocked = await page.search({
    query: "harmony",
    providerIds: ["youtube"],
    limit: 10,
  });
  assert(!blocked.ok, "YouTube search must stop before consent.");
  assert(
    centralRequests === 0 &&
      errors.includes("Accept the YouTube API Services policy before searching.") &&
      page.render({ selectedItemId: null, online: true }).includes(
        "data-youtube-connection",
      ),
    "Blocked YouTube search must expose its consent workflow without a request.",
  );
  const allowed = await page.search({
    query: "harmony",
    providerIds: ["web"],
    limit: 10,
  });
  assert(allowed.ok && centralRequests === 1, "Web-only search must not require YouTube consent.");
});

Deno.test("Discovery source actions recover after a transient catalog failure", async () => {
  const storage = new MemoryPersistence();
  let browseCalls = 0;
  const page = createDiscoveryPage({
    ownerId: "owner-a",
    persistence: {
      appendBatch: storage.appendBatch.bind(storage),
      list: storage.list.bind(storage),
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/discovery/search/capabilities") {
        return Response.json({ result: [{
          id: "web",
          label: "Web",
          resultKind: "web",
          priority: 1,
          enabled: true,
        }] });
      }
      if (path === "/api/source-library" && request.method === "GET") {
        browseCalls += 1;
        return browseCalls === 1
          ? Response.json({ error: "SourceCatalogReadFailed" }, { status: 503 })
          : Response.json({
            result: {
              items: [],
              interestAreas: [{
                id: "area-a",
                ownerId: "owner-a",
                title: "Music",
                provenance: "configured",
              }],
              nextCursor: null,
            },
          });
      }
      if (path === "/api/source-library/suppressions/check") {
        return Response.json({ result: [] });
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    },
    gatewayBaseUrl: "https://app.example/",
    policyStorage: { getItem: () => null, setItem: () => {} },
    starterInventory: STARTERS,
    markup: MARKUP,
    escapeHtml: (value) => value,
    createId: () => `recovery-${browseCalls}`,
    now: () => "2026-07-28T08:00:00.000Z",
    onNotice: () => {},
    onError: () => {},
    navigateToLibrary: () => {},
    rerender: () => {},
  });
  await page.load();
  const list = page.render({ selectedItemId: null, online: true });
  const selectedItemId = list.match(/data-discovery-item-id="([^"]+)"/)?.[1] ??
    null;
  assert(
    selectedItemId !== null,
    "Recovery fixture must expose a starter result.",
  );
  assert(
    page.render({ selectedItemId, online: true }).includes(
      "Connect the private source service",
    ),
    "Failed catalog probe must keep mutations unavailable.",
  );
  await page.load();
  const recovered = page.render({ selectedItemId, online: true });
  assert(
    !recovered.includes("Connect the private source service") &&
      recovered.includes('<option value="area-a">Music</option>'),
    "A successful retry must restore configured source decisions.",
  );
});
