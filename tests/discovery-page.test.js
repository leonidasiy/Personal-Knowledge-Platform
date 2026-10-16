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

function starterSearchResult() {
  return { result: {
    items: STARTERS.items.slice(0, 3).map((/** @type {{title:string,publisherLabel:string,canonicalUrl:string}} */ item) => ({
      providerId: "web", resultKind: "web", sourceLevel: "site",
      title: item.publisherLabel, description: item.title, canonicalUrl: item.canonicalUrl,
      publisherLabel: item.publisherLabel, publishedAt: null, identityEvidence: [{ attribute: "provider-result-page", value: item.canonicalUrl, provenanceUrl: item.canonicalUrl }],
    })),
    providerFailures: [], submittedQuery: "starter-sources", providerQuery: "starter-sources", policyVersion: "raw-provider-v1",
  } };
}

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
  let moreAttempts = 0;
  /** @type {unknown} */ let centralSearchCommand = null;
  /** @type {Record<string,unknown>[]} */ const approvalCommands = [];
  /** @type {() => void} */
  let approveRelease = () => {};
  let holdApproval = false;
  let conflict = false;
  let acceptUpload = false;
  const prompts = /** @type {string[]} */([]);
  const promptedUrls = /** @type {(string|undefined)[]} */([]);
  const approvalGate = new Promise((resolve) => {
    approveRelease = () => resolve(undefined);
  });
  /** @type {string[]} */ const notices = [];
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ const destinations = [];
  const uploadTitles = /** @type {string[]} */ ([]);
  const uploadReasons = /** @type {string[]} */ ([]);
  let nextId = 0;
  /** @type {Parameters<typeof createDiscoveryPage>[0]} */
  const dependencies = {
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
        const searchCommand = /** @type {{readonly query?:unknown}} */ (centralSearchCommand);
        if (Object.hasOwn(/** @type {object} */ (centralSearchCommand), "cursors")) {
          if (++moreAttempts === 1) return Response.json({error:"FixtureUnavailable"},{status:503});
          const item = {providerId:"web",resultKind:"web",sourceLevel:"document",title:"Next counterpoint lesson",description:"Additional source.",canonicalUrl:"https://counterpoint.example/next",publisherLabel:null,publishedAt:null,identityEvidence:[{attribute:"canonical-url",value:"next",provenanceUrl:"https://counterpoint.example/next"}]};
          return Response.json({result:{items:[{...item,title:"Duplicate",canonicalUrl:"https://counterpoint.example/"},item],providerFailures:[],submittedQuery:"counterpoint",providerQuery:"counterpoint",policyVersion:"raw-provider-v1"}});
        }
        if (searchCommand.query === "starter-sources") return Response.json(starterSearchResult());
        if (searchCommand.query === "replacement-failure") {
          return Response.json({ error: "DiscoverySearchFailed" }, { status: 503 });
        }
        if (searchCommand.query === "orchestration") {
          return Response.json({ result: {
            items: [{
              providerId: "web", resultKind: "web", sourceLevel: "site",
              title: "Orchestration lesson archive", description: "Educational lessons.",
              canonicalUrl: "https://orchestration.example/", publisherLabel: null,
              publishedAt: null, identityEvidence: [{
                attribute: "provider-result-page", value: "https://orchestration.example/lessons/",
                provenanceUrl: "https://orchestration.example/lessons/",
              }],
            }], providerFailures: [{providerId:"secondary",failure:{kind:"SearchProviderTimedOut"}}], submittedQuery: "orchestration",
            providerQuery: "orchestration",
            policyVersion: "raw-provider-v1"
          } });
        }
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
            description: "Synthetic supplied harmony explanation",
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
          providerQuery: "counterpoint",
          policyVersion: "raw-provider-v1", nextCursors:{web:"1"}
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
      if (path === "/api/source-library/extract") {
        decisionRequests += 1;
        approvalCommands.push(
          /** @type {Record<string,unknown>} */ (await request.json()),
        );
        if (conflict) return Response.json({error:"SourceStateConflict"},{status:409});
        if (holdApproval) await approvalGate;
        return Response.json({
          result: { source: librarySource, reused: false },workflow:{runId:"run-a",reused:false},
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
    confirmUpload: (message,url) => { prompts.push(message);promptedUrls.push(url);return acceptUpload; },
    navigateToUpload: ({title, reason}) => { uploadTitles.push(title); uploadReasons.push(reason ?? ""); },
    navigateToLibrary: (sourceId) => destinations.push(sourceId),
    rerender: () => {},
  };
  const page = createDiscoveryPage(dependencies);
  const loaded = await page.load();
  assert(loaded.ok, "Starter discovery must load.");
  assert(oauthRequests === 0, "Page load must not call removed OAuth routes.");
  const writesAfterLoad = appendCalls;
  let list = page.render({ selectedItemId: null, online: true });
  assert(
    !list.includes("data-discovery-item-id") && !list.includes("Ableton Learning Music") && list.includes("empty-states.svg#discover") && list.includes('data-discovery-state="never-run"'),
    "Before a submitted search, show artwork without starter source cards.",
  );
  let invalidDetail = "";
  try {
    invalidDetail = page.render({ selectedItemId: " ", online: true });
  } catch {
    // The assertion below verifies that invalid decoded route IDs do not throw.
  }
  const initialFailedSearch = await page.search({
    query: "replacement-failure",
    providerIds: ["podcasts"],
    limit: 20,
  });
  assert(!initialFailedSearch.ok, "The initial fixture search must fail.");
  const requestsAfterInitialFailure = centralSearchRequests;
  await page.load();
  const restoredInitialFailure = page.render({ selectedItemId: null, online: true });
  assert(
    centralSearchRequests === requestsAfterInitialFailure &&
      restoredInitialFailure.includes('value="replacement-failure"') &&
      restoredInitialFailure.includes('value="20" selected') &&
      restoredInitialFailure.includes("Discovery could not complete the request."),
    "A route-only load must preserve the initial submitted failed search without another request.",
  );
  assert(
    invalidDetail.includes('role="alert"') &&
      invalidDetail.includes("Discovery could not complete the request."),
    "A whitespace-only selected item ID must render the explicit discovery error state.",
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
  const explicitSearch = await page.search({ query: "starter-sources", providerIds: ["web"], limit: 10 });
  assert(explicitSearch.ok, "Explicit search must supply the decision fixture.");
  list = page.render({ selectedItemId: null, online: true });
  const requestsBeforeNextSearch = centralSearchRequests;
  const missingDetail = page.render({
    selectedItemId: "persisted-search-result-that-is-not-visible",
    online: true,
  });
  assert(
    missingDetail.includes(MARKUP.missingDetail) &&
      !missingDetail.includes("Stale search result"),
    "A stale selection must remain unavailable without broadening the online list.",
  );
  const itemIds = [...list.matchAll(/data-discovery-item-id="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert(
    itemIds.length >= 3,
    "Controller fixture requires three source items.",
  );

  const selectedTitle = list.match(new RegExp(`data-discovery-item-id="${itemIds[0]}"[^>]*>[\\s\\S]*?<strong>([^<]+)</strong>`))?.[1];
  assert(selectedTitle !== undefined, "Selected source has a real title.");
  const scopeDetail = page.render({selectedItemId:itemIds[0],online:true});
  assert(scopeDetail.includes('name="extractionScope"') && scopeDetail.includes('value="page" selected') && scopeDetail.includes("Entire platform"), "Discover offers page-only extraction by default and platform extraction.");
  conflict = true;
  const errorsBeforePrompt=errors.length;
  await page.approve(itemIds[0]);
  assert(approvalCommands.at(-1)?.extractionScope === "page", "Default extraction submits page scope.");
  assert(prompts.length===1 && prompts[0].includes("Automatic processing could not start") && !prompts[0].includes("Library") && prompts[0].includes("Would you like to open"),"Conflict explains the cause and asks for manual upload.");
  assert(uploadTitles.length===0,"Declining upload must retain Discover.");
  assert(errors.length===errorsBeforePrompt,"The popup must not duplicate the failure as a toast.");
  assert(promptedUrls[0]!==undefined && promptedUrls[0].startsWith("https://"),"The confirmation receives the original source URL to open.");
  acceptUpload = true;
  await page.approve(itemIds[0], "platform");
  assert(approvalCommands.at(-1)?.extractionScope === "platform", "Platform extraction submits the explicit scope.");
  assert(page.render({selectedItemId:itemIds[0],online:true}).includes('value="platform" selected'), "A failed request preserves the scope selection.");
  assert(uploadTitles[0]===selectedTitle,"Confirming upload pre-fills the selected source title.");
  conflict = false;
  prompts.length=0;uploadTitles.length=0;uploadReasons.length=0;errors.length=0;approvalCommands.length=0;decisionRequests=0;
  const opened = page.openUpload(itemIds[0]);
  assert(opened.ok && uploadTitles[0] === selectedTitle, "Navigate directly with the actual selected title.");
  const missingUpload = page.openUpload("missing-source");
  assert(!missingUpload.ok && missingUpload.error.kind === "DiscoveryUploadSourceUnavailable" && uploadTitles.length === 1, "Missing identity must never select another source.");
  assert(appendCalls === writesAfterLoad && decisionRequests === 0 && manualUploads === 0, "Navigation must not save approval or upload material.");

  holdApproval = true;
  const first = page.approve(itemIds[0]);
  const repeated = page.approve(itemIds[0]);
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

  assert(!page.render({selectedItemId:itemIds[1],online:true}).includes("data-discovery-reject"), "Search results must not offer rejection.");
  const searched = await page.search({
    query: "counterpoint",
    providerIds: ["web", "podcasts", "youtube"],
    limit: 10,
  });
  assert(searched.ok, "Central search must succeed.");
  assert(
    centralSearchRequests === requestsBeforeNextSearch + 1 &&
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
  const searchedId = searchedHtml.match(
    /data-discovery-item-id="([^"]+)"[^>]*>[\s\S]*?Counterpoint course library/,
  )?.[1] ?? null;
  assert(searchedId !== null, "The searched result must expose a stable route ID.");
  const detail = page.render({ selectedItemId: searchedId, online: true });
  assert(
    detail.includes("Counterpoint course library") && !detail.includes("Item unavailable"),
    "A live central result must resolve before persisted starter data.",
  );
  const searchedIds = [...searchedHtml.matchAll(/data-discovery-item-id="([^"]+)"/g)]
    .map((match) => match[1]);
  const youtubeUpload = page.openUpload(searchedIds[1]);
  assert(youtubeUpload.ok && uploadTitles.at(-1) === "Official harmony tutorial title" && (uploadReasons.at(-1) ?? "").includes("transcript"), "YouTube handoff must use the video's exact title and request a permitted transcript.");
  const offlineYouTubeDetail = page.render({
    selectedItemId: searchedIds[1],
    online: false,
  });
  assert(
    offlineYouTubeDetail.includes('id="discover-offline-message"') &&
      offlineYouTubeDetail.includes(
        'aria-describedby="discover-offline-message"',
      ) &&
      offlineYouTubeDetail.includes("Watch link unavailable") &&
      !offlineYouTubeDetail.includes("Watch on YouTube</a>"),
    "An offline live YouTube detail must retain the offline notice and unavailable watch action.",
  );
  const selectedSearchHtml = page.render({
    selectedItemId: searchedIds[0],
    online: true,
  });
  assert(
    selectedSearchHtml.includes("Counterpoint course library") &&
      !selectedSearchHtml.includes("Ableton Learning Music"),
    "Selecting a live search result must preserve that search projection instead of restoring persisted rows.",
  );
  const approvalsBeforeUnsupported = approvalCommands.length;
  await page.approve(searchedIds[1]);
  await page.approve(searchedIds[2]);
  assert(approvalCommands.length === approvalsBeforeUnsupported, "Unsupported video/feed extraction must not persist provider preview metadata or start ingestion.");
  assert(errors.includes("Extraction is unavailable for this format. Explore the source or provide permitted learning material."), "Unsupported formats must explain their access boundary.");
  assert(searchedHtml.includes("Unreviewed provider results"), "Raw results must visibly disclose that they are unreviewed.");
  assert(searchedHtml.includes("Educational lessons in species counterpoint."), "Provider snippet must render unchanged.");
  assert(appendCalls === writesAfterLoad && manualUploads === 0, "Search and source selection must not extract or persist material.");
  const requestsAfterSearch = centralSearchRequests;
  await page.load();
  const restored = page.render({ selectedItemId: null, online: true });
  assert(centralSearchRequests === requestsAfterSearch, "Route loads must not search again.");
  assert(restored.includes('value="counterpoint"'), "Load must preserve the query.");
  assert(restored.includes('value="10" selected'), "Load must preserve the limit.");
  assert(restored.includes("Counterpoint course library"), "Load must preserve live results.");
  assert(restored.includes("data-discovery-more"), "A continuation must offer Load more.");
  await page.loadMore();
  const retry = page.render({selectedItemId:searchedIds[0],online:true});
  assert(retry.includes("Counterpoint course library") && retry.includes('role="alert"') && retry.includes("data-discovery-more"), "Failed pagination must preserve cards and allow retry.");
  await page.loadMore();
  const appended = page.render({selectedItemId:searchedIds[0],online:true});
  assert(appended.includes("Next counterpoint lesson") && appended.includes(`data-discovery-item-id="${searchedIds[0]}"`), "Pagination must append while preserving existing IDs and selection.");
  assert((appended.match(/data-discovery-item-id=/g) ?? []).length === 4 && !appended.includes("data-discovery-more"), "Pagination must deduplicate URLs and stop when exhausted.");
  assert(JSON.stringify(centralSearchCommand) === JSON.stringify({query:"counterpoint",limit:10,cursors:{web:"1"},providerIds:["web"]}), "Pagination must use the previous search and provider continuation.");
  const replaced = await page.search({ query: "orchestration", providerIds: ["web"], limit: 5 });
  assert(replaced.ok, "The replacement search must succeed.");
  const replacement = page.render({ selectedItemId: null, online: true });
  assert(!replacement.includes("Counterpoint course library") && replacement.includes("Orchestration lesson archive"), "A successful replacement must atomically replace results.");
  assert(!replacement.includes("SearchProviderTimedOut") && !replacement.includes("Available results are shown"),"Usable results must not display advisory provider failures.");
  const failedReplacement = await page.search({ query: "replacement-failure", providerIds: ["podcasts"], limit: 20 });
  assert(!failedReplacement.ok, "The fixture replacement must fail.");
  const afterFailedReplacement = page.render({ selectedItemId: null, online: true });
  assert(
    afterFailedReplacement.includes('value="orchestration"') &&
      afterFailedReplacement.includes('value="5" selected') &&
      afterFailedReplacement.includes("Orchestration lesson archive") &&
      !afterFailedReplacement.includes("Counterpoint course library"),
    "A failed replacement must preserve the last successful controls and results.",
  );
  const requestsBeforeReopen = centralSearchRequests;
  const reopened = createDiscoveryPage(dependencies);
  await reopened.load();
  const reopenedHtml = reopened.render({ selectedItemId: null, online: true });
  assert(centralSearchRequests === requestsBeforeReopen && !reopenedHtml.includes("data-discovery-item-id") && reopenedHtml.includes('data-discovery-state="never-run"') && reopenedHtml.includes('value=""'), "Reopening with the same saved data clears session results and query without issuing a search.");

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
          providerQuery: "harmony",
          policyVersion: "raw-provider-v1"
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
    navigateToUpload: () => {},
    navigateToLibrary: () => {},
    rerender: () => {},
  });
  await page.load();
  const initial = page.render({ selectedItemId: null, online: true });
  assert(!/value="youtube"[^>]*checked/.test(initial) && !initial.includes("I accept the"), "YouTube must require an explicit checkbox selection, with no initial policy text.");
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
  const requestsAfterBlockedSearch = centralRequests;
  await page.load();
  const restoredBlockedSearch = page.render({ selectedItemId: null, online: true });
  assert(
    centralRequests === requestsAfterBlockedSearch &&
      restoredBlockedSearch.includes('value="harmony"') &&
      restoredBlockedSearch.includes('value="10" selected') &&
      restoredBlockedSearch.includes("Accept the YouTube API Services policy before searching."),
    "A route-only load must preserve a policy-rejected submitted search without requesting discovery.",
  );
  const allowed = await page.search({
    query: "harmony",
    providerIds: ["web"],
    limit: 10,
  });
  assert(allowed.ok && centralRequests === 1, "Web-only search must not require YouTube consent.");
});

Deno.test("Discovery controller ignores stale central search completions", async () => {
  const storage = new MemoryPersistence();
  /** @type {(value:Response)=>void} */ let resolveFirst = () => {};
  /** @type {(value:Response)=>void} */ let resolveSecond = () => {};
  const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
  const secondResponse = new Promise((resolve) => { resolveSecond = resolve; });
  let requests = 0;
  /** @param {string} title */
  const result = (title) => Response.json({ result: {
    items: [{ providerId: "web", resultKind: "web", sourceLevel: "site", title, description: "Synthetic supplied explanation", canonicalUrl: `https://${title}.example/`, publisherLabel: null, publishedAt: null, identityEvidence: [{ attribute: "result", value: title, provenanceUrl: `https://${title}.example/` }] }],
    providerFailures: [], submittedQuery: title, providerQuery: title, policyVersion: "raw-provider-v1"
  } });
  const page = createDiscoveryPage({
    ownerId: "owner-a", persistence: { appendBatch: storage.appendBatch.bind(storage), list: storage.list.bind(storage) },
    fetch: async (input, init) => {
      const request = new Request(input, init); const path = new URL(request.url).pathname;
      if (path === "/api/discovery/search/capabilities") return Response.json({ result: [{ id: "web", label: "Web", resultKind: "web", priority: 1, enabled: true }] });
      if (path === "/api/discovery/search") return ++requests === 1 ? firstResponse : secondResponse;
      if (path === "/api/source-library" && request.method === "GET") return Response.json({ result: { items: [], interestAreas: [], nextCursor: null } });
      if (path === "/api/source-library/suppressions/check") return Response.json({ result: [] });
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    },
    gatewayBaseUrl: "https://app.example/", policyStorage: { getItem: () => null, setItem: () => {} }, starterInventory: STARTERS, markup: MARKUP, escapeHtml: (value) => value, createId: () => "race-id", now: () => "2026-08-01T00:00:00.000Z", onNotice: () => {}, onError: () => {}, navigateToUpload: () => {}, navigateToLibrary: () => {}, rerender: () => {},
  });
  await page.load();
  const first = page.search({ query: "first", providerIds: ["web"], limit: 5 });
  const second = page.search({ query: "second", providerIds: ["web"], limit: 5 });
  resolveSecond(result("second"));
  assert((await second).ok, "The latest search must succeed.");
  resolveFirst(result("first"));
  const stale = await first;
  assert(!stale.ok && /** @type {{readonly kind:string}} */ (stale.error).kind === "DiscoverySearchSuperseded", "An older completion must be superseded.");
  const html = page.render({ selectedItemId: null, online: true });
  assert(html.includes("second") && !html.includes("first"), "A stale completion must not replace the latest result.");
});

Deno.test("Discovery source actions recover after a transient catalog failure", async () => {
  const storage = new MemoryPersistence();
  let browseCalls = 0;
  let recoveryId = 0;
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
      if (path === "/api/discovery/search") return Response.json(starterSearchResult());
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
    createId: () => `recovery-${++recoveryId}`,
    now: () => "2026-07-28T08:00:00.000Z",
    onNotice: () => {},
    onError: () => {},
    navigateToUpload: () => {},
    navigateToLibrary: () => {},
    rerender: () => {},
  });
  await page.load();
  const searched = await page.search({ query: "starter-sources", providerIds: ["web"], limit: 10 });
  assert(searched.ok, "Recovery fixture must submit a search.");
  const list = page.render({ selectedItemId: null, online: true });
  const selectedItemId = list.match(/data-discovery-item-id="([^"]+)"/)?.[1] ??
    null;
  assert(
    selectedItemId !== null,
    "Recovery fixture must expose a searched result.",
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
      recovered.includes("Extract Knowledge Points") && !recovered.includes('name="interest-area"'),
    "A successful retry must restore configured source decisions.",
  );
});
