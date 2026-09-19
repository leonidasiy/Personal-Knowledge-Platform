// @ts-check

import {
  DiscoveryRuntime,
  renderDiscoverRoute,
  toDiscoverRouteModel,
} from "../src/startup/discovery-runtime.js";
import {
  friendlyDiscoveryFailure,
  renderYouTubeConnection,
} from "../src/startup/youtube-connection.js";
import { DiscoveryGatewayClient } from "../src/features/discovery/gateway.js";
import { MemoryPersistence } from "../src/persistence/memory.js";
import { RECORD_KINDS } from "../src/persistence/contracts.js";

/** @import { PersistenceEnvelope, PersistenceFailure, RecordKind, Result } from "../src/persistence/contracts.js" */
const APP_DOCUMENT = await Deno.readTextFile(
  new URL("../index.html", import.meta.url),
);
const COPY_TEXT = APP_DOCUMENT.match(
  /<script id="app-copy" type="application\/json">([\s\S]*?)<\/script>/,
)?.[1];
if (COPY_TEXT === undefined) throw new Error("App copy fixture is missing.");
const DISCOVERY_MARKUP =
  /** @type {{discoverMarkup:import("../src/routes/discover.js").DiscoverMarkup}} */ (
    JSON.parse(COPY_TEXT)
  ).discoverMarkup;
/** @template T @param {T} actual @param {T} expected */
function equal(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}
/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class FakePersistence {
  #memory = new MemoryPersistence();
  failNextWrite = false;
  /** @type {readonly PersistenceEnvelope[]|null} */ injectedRead = null;
  /** @param {readonly PersistenceEnvelope[]} records @returns {Promise<Result<readonly PersistenceEnvelope[],PersistenceFailure>>} */
  appendBatch(records) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return Promise.resolve({
        ok: false,
        error: {
          kind: "PersistenceWriteFailed",
          recordId: records[0]?.id ?? "batch",
        },
      });
    }
    return this.#memory.appendBatch(records);
  }
  /** @param {string} owner @param {RecordKind} kind */
  list(owner, kind) {
    return this.injectedRead !== null && kind === "discovery_source"
      ? Promise.resolve(
        /** @type {const} */ ({ ok: true, value: this.injectedRead }),
      )
      : this.#memory.list(owner, kind);
  }
}

function cursorCodec() {
  /** @type {Map<string,unknown>} */ const values = new Map();
  return {
    encode: /** @param {unknown} value */ (value) => {
      const token = `cursor-${values.size + 1}`;
      values.set(token, value);
      return { ok: /** @type {const} */ (true), value: token };
    },
    decode: /** @param {string} token */ (token) =>
      values.has(token)
        ? { ok: /** @type {const} */ (true), value: values.get(token) }
        : {
          ok: /** @type {const} */ (false),
          error: {
            kind: /** @type {const} */ ("DiscoveryPageCursorInvalid"),
            reason: "unknown",
          },
        },
  };
}

const rssSource = Object.freeze({
  sourceId: "feed-key",
  authoritativeIdentity: "feed-key",
  identityEvidence: Object.freeze([{
    reference: "https://publisher.example/",
    provenance: "rss-channel-link:unspecified",
  }]),
  adapterId: "rss-atom",
  adapterVersion: "normalized-v1",
  submittedUrl: "https://publisher.example/feed",
  canonicalUrl: "https://publisher.example/",
});
const rssItem = Object.freeze({
  itemId: "entry-1",
  identityEvidence: Object.freeze([{
    reference: "entry-1",
    provenance: "rss-guid:false",
  }]),
  title: "Discovered lesson",
  canonicalUrl: "https://publisher.example/lesson",
  contentDigest: "sha256-entry",
  publisherLabel: "Publisher",
  publishedAt: "2026-07-21T00:00:00.000Z",
  podcast: Object.freeze({
    namespaceEvidencePresent: true,
    namespaceUri: "https://podcastindex.org/namespace/1.0",
    namespaceContractReference:
      "https://podcasting2.org/docs/podcast-namespace/tags/transcript",
    feedLanguageSelector: "rss/channel/language",
    transcripts: Object.freeze([Object.freeze({
      url: "https://publisher.example/lesson.vtt",
      type: "text/vtt",
      language: "en",
      languageSource: /** @type {const} */ ("feed"),
      rel: null,
      sourceIndex: 0,
    })]),
    enclosure: Object.freeze({
      url: "https://publisher.example/lesson.mp3",
      type: "audio/mpeg",
      declaredLength: 1_024,
    }),
  }),
});
/** @param {string} seed */
function starterInventory(seed = "session-a") {
  const references = [
    ["starter-a", "https://publisher.example/starter-a"],
    ["starter-b", "https://publisher.example/starter-b"],
    ["starter-c", "https://publisher.example/starter-c"],
    ["starter-d", "https://publisher.example/starter-d"],
  ];
  return {
    source: {
      sourceId: "starter-source",
      authoritativeIdentity: "attributed-starter-fixture-v1",
      identityEvidence: [{
        reference: "https://publisher.example/starters",
        provenance: "Authoritative fixture directory",
      }],
      adapterId: "bundled-attributed-starters",
      adapterVersion: "v1",
      submittedUrl: "https://publisher.example/starters",
      canonicalUrl: "https://publisher.example/starters",
    },
    items: references.map(([itemId, canonicalUrl]) => ({
      itemId,
      identityEvidence: [{
        reference: canonicalUrl,
        provenance: "Publisher fixture resource",
      }],
      title: `Starter ${itemId}`,
      canonicalUrl,
      contentDigest: `${itemId}:metadata-v1`,
      publisherLabel: "Fixture publisher",
      publishedAt: null,
      podcast: null,
    })),
    sessionSeed: seed,
  };
}

/** @param {FakePersistence} persistence @param {{readonly starterInventory?:unknown,readonly now?:string}} [options] */
function setup(persistence = new FakePersistence(), options = {}) {
  let sequence = 0;
  const runtime = new DiscoveryRuntime({
    ownerId: "owner-a",
    persistence,
    clock: {
      now: () => ({
        ok: true,
        value: options.now ?? "2026-07-21T02:00:00.000Z",
      }),
    },
    createId: () => `runtime-${++sequence}`,
    cursorCodec: cursorCodec(),
    starterInventory: options.starterInventory ?? starterInventory(),
  });
  return { runtime, persistence };
}

/** @param {string|null} selectedItemId @param {boolean} [starterOnly] */
function route(selectedItemId = null, starterOnly) {
  return {
    name: "discover",
    cursor: null,
    selectedItemId,
    online: true,
    ...(starterOnly === undefined ? {} : { starterOnly }),
  };
}

Deno.test("empty restore installs attributed starter recommendations", async () => {
  const { runtime } = setup();
  equal((await runtime.load()).ok, true);
  const result = runtime.renderModel(route());
  if (!result.ok) throw new Error(result.error.kind);
  equal(result.value.page.items.length, 4);
  const model = {
    ...toDiscoverRouteModel(result.value, (value) => value),
    markup: DISCOVERY_MARKUP,
  };
  equal(model.maxVisibleItems, 20);
  assert(
    renderDiscoverRoute(model).includes("Starter starter-"),
    "Expected attributed starter recommendations.",
  );
});

Deno.test("starter ordering is stable within a session and varies by injected seed", async () => {
  const orders = new Set();
  for (const seed of ["a", "b", "c", "d", "e", "f"]) {
    const { runtime } = setup(new FakePersistence(), {
      starterInventory: starterInventory(seed),
    });
    equal((await runtime.load()).ok, true);
    const first = runtime.renderModel(route());
    const second = runtime.renderModel(route());
    if (!first.ok || !second.ok) throw new Error("Starter projection failed.");
    const firstOrder = first.value.page.items.map((item) => item.canonicalUrl)
      .join("|");
    equal(
      firstOrder,
      second.value.page.items.map((item) => item.canonicalUrl).join("|"),
    );
    orders.add(firstOrder);
  }
  assert(orders.size > 1, "Injected seeds must permit different ordering.");
});

Deno.test("invalid starter inventory is a named load failure", async () => {
  const { runtime, persistence } = setup(new FakePersistence(), {
    starterInventory: { ...starterInventory(), items: [] },
  });
  const loaded = await runtime.load();
  equal(loaded.ok, false);
  if (!loaded.ok) equal(loaded.error.kind, "DiscoveryStarterInventoryInvalid");
  for (
    const kind of RECORD_KINDS.filter((kind) => kind.startsWith("discovery_"))
  ) {
    const records = await persistence.list("owner-a", kind);
    if (!records.ok) throw new Error(records.error.kind);
    equal(records.value.length, 0);
  }
});

Deno.test("saved discovery remains available when starter inventory is unavailable", async () => {
  const persistence = new FakePersistence();
  const installed = setup(persistence);
  equal((await installed.runtime.load()).ok, true);
  const recovered = setup(persistence, { starterInventory: null });
  equal((await recovered.runtime.load()).ok, true);
  const rendered = recovered.runtime.renderModel(route());
  if (!rendered.ok) throw new Error(rendered.error.kind);
  equal(rendered.value.page.items.length, 4);
});

Deno.test("online default projection excludes persisted nonstarter search rows", async () => {
  const persistence = new FakePersistence();
  const installed = setup(persistence);
  equal((await installed.runtime.load()).ok, true);
  await persistence.appendBatch([
    {
      id: "discovery_source:stale-search",
      ownerId: "owner-a",
      kind: /** @type {const} */ ("discovery_source"),
      payloadJson: JSON.stringify({
        id: "stale-search",
        ownerId: "owner-a",
        identity: "https://search.example/stale",
        evidence: [{ reference: "https://search.example/stale", provenance: "search" }],
        adapterId: "search-adapter",
        adapterVersion: "v1",
        submittedUrl: "https://search.example/stale",
        canonicalUrl: "https://search.example/stale",
        observedAt: "2026-07-22T00:00:00.000Z",
      }),
      recordedAt: "2026-07-22T00:00:00.000Z",
    },
    {
      id: "discovery_item_version:stale-search-item:1",
      ownerId: "owner-a",
      kind: /** @type {const} */ ("discovery_item_version"),
      payloadJson: JSON.stringify({
        id: "stale-search-item",
        ownerId: "owner-a",
        sourceId: "stale-search",
        version: 1,
        identityEvidence: [{ reference: "https://search.example/stale", provenance: "search" }],
        title: "Stale search result",
        canonicalUrl: "https://search.example/stale",
        contentDigest: "stale-search-v1",
        publisherLabel: "Search provider",
        publishedAt: null,
        podcastReferenceLabel: null,
        expiresAt: null,
        observedAt: "2026-07-22T00:00:00.000Z",
      }),
      recordedAt: "2026-07-22T00:00:00.000Z",
    },
  ]);
  const recovered = setup(persistence);
  equal((await recovered.runtime.load()).ok, true);
  const rendered = recovered.runtime.renderModel(route(null, true));
  if (!rendered.ok) throw new Error(rendered.error.kind);
  equal(rendered.value.page.items.length, 4);
  assert(
    rendered.value.page.items.every((item) => item.canonicalUrl.startsWith("https://publisher.example/starter-")),
    "Online default Discover must exclude persisted search rows.",
  );
});

Deno.test("Discover preserves actionable nested YouTube failures", () => {
  const cases = /** @type {const} */ ([
    [
      "YouTubePolicyAcceptanceRequired",
      "Accept the YouTube API Services policy",
    ],
    ["YouTubeCredentialMissing", "not configured"],
    ["YouTubeCredentialRejected", "deployment owner"],
    ["YouTubeSearchQuotaExceeded", "search limit"],
    ["YouTubeGeneralQuotaExceeded", "result-detail limit"],
    ["YouTubeProviderQuotaExceeded", "project quota"],
    ["YouTubeUpstreamUnavailable", "temporarily unavailable"],
  ]);
  for (const [failureKind, expected] of cases) {
    assert(
      friendlyDiscoveryFailure({
        kind: "DiscoveryGatewayRejected",
        failureKind,
      }, DISCOVERY_MARKUP).includes(expected),
      `${failureKind} needs distinct recovery guidance.`,
    );
  }
});

Deno.test("Discover preserves actionable source validation failures", () => {
  const cases = /** @type {const} */ ([
    ["DiscoveryDestinationForbidden", "address is not allowed"],
    ["DiscoveryPayloadTooLarge", "exceeds the limit"],
    ["DiscoveryXmlMalformed", "not a supported feed"],
  ]);
  for (const [failureKind, expected] of cases) {
    assert(
      friendlyDiscoveryFailure({ kind: failureKind }, DISCOVERY_MARKUP)
        .includes(expected),
      `${failureKind} needs distinct recovery guidance.`,
    );
  }
});

Deno.test("Discover preserves provider quota variants across the gateway", async () => {
  const client = new DiscoveryGatewayClient({
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response(JSON.stringify({ error: "YouTubeGeneralQuotaExceeded" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })),
    baseUrl: "https://worker.example/",
    timeoutMs: 1_000,
  });
  const result = await client.search({
    query: "harmony",
    providerIds: ["youtube"],
    limit: 10,
  });
  equal(result.ok, false);
  if (!result.ok) {
    equal(result.error.kind, "DiscoveryGatewayRejected");
    if (result.error.kind === "DiscoveryGatewayRejected") {
      equal(result.error.failureKind, "YouTubeGeneralQuotaExceeded");
    }
  }
});

Deno.test("Discover renders versioned YouTube API policy states", () => {
  const accepted = renderYouTubeConnection(
    { status: "accepted" },
    false,
    DISCOVERY_MARKUP,
  );
  assert(
    accepted === "",
    "Accepted policy has no Discover banner; information lives in Settings.",
  );
  const pending = renderYouTubeConnection(
    { status: "pending" },
    false,
    DISCOVERY_MARKUP,
  );
  assert(
    pending.includes("Enable YouTube search") &&
      pending.includes("Google Privacy Policy") &&
      pending.includes("Google security settings") &&
      !pending.includes("Connect YouTube"),
    "Pending policy must expose the required policy links and acceptance action.",
  );
  const unavailable = renderYouTubeConnection(
    { status: "unavailable" },
    false,
    DISCOVERY_MARKUP,
  );
  assert(
    unavailable.includes("YouTube policy preference is unavailable") &&
      !unavailable.includes("Connect YouTube") &&
      !unavailable.includes("Disconnect YouTube"),
    "Unavailable policy storage must not claim search is enabled.",
  );
});

Deno.test("production starter asset satisfies the attributed inventory contract", async () => {
  const document = JSON.parse(
    await Deno.readTextFile(
      new URL("../assets/discovery-starters.json", import.meta.url),
    ),
  );
  equal(Object.hasOwn(document, "sessionSeed"), false);
  const { runtime } = setup(new FakePersistence(), {
    starterInventory: { ...document, sessionSeed: "asset-test-session" },
  });
  equal((await runtime.load()).ok, true);
  const rendered = runtime.renderModel(route());
  if (!rendered.ok) throw new Error(rendered.error.kind);
  equal(rendered.value.page.items.length, 4);
  assert(
    rendered.value.page.items.every((item) =>
      item.publisherLabel !== null && URL.canParse(item.canonicalUrl) &&
      new URL(item.canonicalUrl).protocol === "https:"
    ),
    "Production starters must retain attributed HTTPS source links.",
  );
  const routeModel = toDiscoverRouteModel(rendered.value, (value) => value);
  equal(
    new Set(
      routeModel.items.map((item) => item.candidate.canonicalIdentity),
    ).size,
    4,
  );
});

Deno.test("retired provider-specific acquisition commands are absent", () => {
  const { runtime } = setup();
  equal("acquireRss" in runtime, false);
  equal("searchYouTube" in runtime, false);
});

Deno.test("restore rejects malformed and cross-owner envelopes", async () => {
  for (
    const entry of [
      {
        id: "discovery_source:cross",
        ownerId: "owner-b",
        kind: /** @type {const} */ ("discovery_source"),
        payloadJson: JSON.stringify({ id: "cross", ownerId: "owner-b" }),
        recordedAt: "2026-07-21T00:00:00.000Z",
      },
      {
        id: "discovery_source:bad",
        ownerId: "owner-a",
        kind: /** @type {const} */ ("discovery_source"),
        payloadJson: JSON.stringify({
          id: "bad",
          ownerId: "owner-a",
          quiz: "leak",
        }),
        recordedAt: "2026-07-21T00:00:00.000Z",
      },
    ]
  ) {
    const persistence = new FakePersistence();
    persistence.injectedRead = [entry];
    const loaded = await setup(persistence).runtime.load();
    equal(loaded.ok, false);
    if (!loaded.ok) equal(loaded.error.kind, "DiscoveryRuntimeRecordInvalid");
  }
});

Deno.test("canonical duplicate projection keeps the newest eligible evidence record", async () => {
  const persistence = new FakePersistence();
  const canonicalUrl = "https://publisher.example/same-resource";
  const records = [
    {
      sourceId: "source-old",
      itemId: "item-old",
      observedAt: "2026-07-20T00:00:00.000Z",
    },
    {
      sourceId: "source-new",
      itemId: "item-new",
      observedAt: "2026-07-21T00:00:00.000Z",
    },
  ];
  await persistence.appendBatch(
    records.flatMap(({ sourceId, itemId, observedAt }) => [{
      id: `discovery_source:${sourceId}`,
      ownerId: "owner-a",
      kind: /** @type {const} */ ("discovery_source"),
      payloadJson: JSON.stringify({
        id: sourceId,
        ownerId: "owner-a",
        identity: sourceId,
        evidence: [{
          reference: `${canonicalUrl}#${sourceId}`,
          provenance: "test",
        }],
        adapterId: "test-adapter",
        adapterVersion: "v1",
        submittedUrl: canonicalUrl,
        canonicalUrl,
        observedAt,
      }),
      recordedAt: observedAt,
    }, {
      id: `discovery_item_version:${itemId}:1`,
      ownerId: "owner-a",
      kind: /** @type {const} */ ("discovery_item_version"),
      payloadJson: JSON.stringify({
        id: itemId,
        ownerId: "owner-a",
        sourceId,
        version: 1,
        identityEvidence: [{ reference: canonicalUrl, provenance: "test" }],
        title: itemId,
        canonicalUrl,
        contentDigest: `digest-${itemId}`,
        publisherLabel: sourceId,
        publishedAt: null,
        podcastReferenceLabel: null,
        expiresAt: null,
        observedAt,
      }),
      recordedAt: observedAt,
    }]),
  );
  const beforeSources = await persistence.list("owner-a", "discovery_source");
  const beforeItems = await persistence.list(
    "owner-a",
    "discovery_item_version",
  );
  const { runtime } = setup(persistence, { starterInventory: null });
  equal((await runtime.load()).ok, true);
  const projected = runtime.renderModel(route());
  if (!projected.ok) throw new Error(projected.error.kind);
  equal(projected.value.page.items.length, 1);
  equal(projected.value.page.items[0].itemId, "item-new");
  equal(projected.value.page.items[0].source.id, "source-new");
  const afterSources = await persistence.list("owner-a", "discovery_source");
  const afterItems = await persistence.list(
    "owner-a",
    "discovery_item_version",
  );
  if (
    !beforeSources.ok || !afterSources.ok || !beforeItems.ok || !afterItems.ok
  ) {
    throw new Error("Persistence fixture failed.");
  }
  equal(
    JSON.stringify(afterSources.value),
    JSON.stringify(beforeSources.value),
  );
  equal(JSON.stringify(afterItems.value), JSON.stringify(beforeItems.value));
});

Deno.test("canonical duplicate ties select the lexical item id deterministically", async () => {
  const persistence = new FakePersistence();
  const observedAt = "2026-07-21T00:00:00.000Z";
  const canonicalUrl = "https://publisher.example/tied-resource";
  for (const itemId of ["item-z", "item-a"]) {
    const sourceId = `source-${itemId}`;
    await persistence.appendBatch([{
      id: `discovery_source:${sourceId}`,
      ownerId: "owner-a",
      kind: "discovery_source",
      payloadJson: JSON.stringify({
        id: sourceId,
        ownerId: "owner-a",
        identity: sourceId,
        evidence: [{ reference: canonicalUrl, provenance: "test" }],
        adapterId: "test-adapter",
        adapterVersion: "v1",
        submittedUrl: canonicalUrl,
        canonicalUrl,
        observedAt,
      }),
      recordedAt: observedAt,
    }, {
      id: `discovery_item_version:${itemId}:1`,
      ownerId: "owner-a",
      kind: "discovery_item_version",
      payloadJson: JSON.stringify({
        id: itemId,
        ownerId: "owner-a",
        sourceId,
        version: 1,
        identityEvidence: [{ reference: canonicalUrl, provenance: "test" }],
        title: itemId,
        canonicalUrl,
        contentDigest: itemId,
        publisherLabel: null,
        publishedAt: null,
        podcastReferenceLabel: null,
        expiresAt: null,
        observedAt,
      }),
      recordedAt: observedAt,
    }]);
  }
  const { runtime } = setup(persistence, { starterInventory: null });
  equal((await runtime.load()).ok, true);
  const projected = runtime.renderModel(route());
  if (!projected.ok) throw new Error(projected.error.kind);
  equal(projected.value.page.items[0].itemId, "item-a");
});

Deno.test("concurrent starter loading commits and displays one starter set", async () => {
  const persistence = new FakePersistence();
  const first = setup(persistence).runtime;
  const second = setup(persistence).runtime;
  const loaded = await Promise.all([first.load(), second.load()]);
  equal(loaded.every((result) => result.ok), true);
  const sources = await persistence.list("owner-a", "discovery_source");
  const items = await persistence.list("owner-a", "discovery_item_version");
  if (!sources.ok || !items.ok) throw new Error("Persistence fixture failed.");
  equal(sources.value.length, 1);
  equal(items.value.length, 4);
  const projected = second.renderModel(route());
  if (!projected.ok) throw new Error(projected.error.kind);
  equal(projected.value.page.items.length, 4);
});

Deno.test("YouTube expiry is applied before canonical duplicate selection", async () => {
  const persistence = new FakePersistence();
  const canonicalUrl = "https://www.youtube.com/watch?v=shared-video";
  for (
    const entry of [
      {
        sourceId: "source-current",
        itemId: "item-current",
        observedAt: "2026-07-20T00:00:00.000Z",
        expiresAt: "2026-08-20T00:00:00.000Z",
      },
      {
        sourceId: "source-expired",
        itemId: "item-expired",
        observedAt: "2026-07-21T00:00:00.000Z",
        expiresAt: "2026-07-21T01:00:00.000Z",
      },
    ]
  ) {
    await persistence.appendBatch([{
      id: `discovery_source:${entry.sourceId}`,
      ownerId: "owner-a",
      kind: "discovery_source",
      payloadJson: JSON.stringify({
        id: entry.sourceId,
        ownerId: "owner-a",
        identity: entry.sourceId,
        evidence: [{ reference: canonicalUrl, provenance: "test" }],
        adapterId: "youtube-api",
        adapterVersion: "v3",
        submittedUrl: "https://www.youtube.com/",
        canonicalUrl: "https://www.youtube.com/",
        observedAt: entry.observedAt,
      }),
      recordedAt: entry.observedAt,
    }, {
      id: `discovery_item_version:${entry.itemId}:1`,
      ownerId: "owner-a",
      kind: "discovery_item_version",
      payloadJson: JSON.stringify({
        id: entry.itemId,
        ownerId: "owner-a",
        sourceId: entry.sourceId,
        version: 1,
        identityEvidence: [{ reference: canonicalUrl, provenance: "test" }],
        title: entry.itemId,
        canonicalUrl,
        contentDigest: entry.itemId,
        publisherLabel: "YouTube",
        publishedAt: null,
        podcastReferenceLabel: null,
        expiresAt: entry.expiresAt,
        observedAt: entry.observedAt,
      }),
      recordedAt: entry.observedAt,
    }]);
  }
  const { runtime } = setup(persistence, {
    starterInventory: null,
    now: "2026-07-21T02:00:00.000Z",
  });
  equal((await runtime.load()).ok, true);
  const projected = runtime.renderModel(route());
  if (!projected.ok) throw new Error(projected.error.kind);
  equal(projected.value.page.items.length, 1);
  equal(projected.value.page.items[0].itemId, "item-current");
});

Deno.test("legacy podcast item records migrate to bounded reference summaries", async () => {
  const persistence = new FakePersistence();
  const observedAt = "2026-07-21T02:00:00.000Z";
  await persistence.appendBatch([{
    id: "discovery_source:legacy-source",
    ownerId: "owner-a",
    kind: "discovery_source",
    payloadJson: JSON.stringify({
      id: "legacy-source",
      ownerId: "owner-a",
      identity: "legacy-podcast",
      evidence: rssSource.identityEvidence,
      adapterId: "rss-atom",
      adapterVersion: "normalized-v1",
      submittedUrl: rssSource.submittedUrl,
      canonicalUrl: rssSource.canonicalUrl,
      observedAt,
    }),
    recordedAt: observedAt,
  }, {
    id: "discovery_item_version:legacy-source|episode:1",
    ownerId: "owner-a",
    kind: "discovery_item_version",
    payloadJson: JSON.stringify({
      id: "legacy-source|episode",
      ownerId: "owner-a",
      sourceId: "legacy-source",
      version: 1,
      identityEvidence: rssItem.identityEvidence,
      title: rssItem.title,
      canonicalUrl: rssItem.canonicalUrl,
      contentDigest: rssItem.contentDigest,
      publisherLabel: rssItem.publisherLabel,
      publishedAt: rssItem.publishedAt,
      podcast: rssItem.podcast,
      observedAt,
    }),
    recordedAt: observedAt,
  }]);
  const { runtime } = setup(persistence, { starterInventory: null });
  equal((await runtime.load()).ok, true);
  const projected = runtime.renderModel(route());
  if (!projected.ok) throw new Error(projected.error.kind);
  equal(
    projected.value.page.items[0].podcastReferenceLabel,
    "1 publisher transcript reference; enclosure available",
  );
});

Deno.test("retired item evidence commands are absent and discovery stays link-only", async () => {
  const { runtime, persistence } = setup();
  await runtime.load();
  const first = runtime.renderModel(route());
  if (!first.ok) throw new Error(first.error.kind);
  const itemId = first.value.page.items[0].itemId;
  const selected = runtime.renderModel(route(itemId));
  if (!selected.ok) throw new Error(selected.error.kind);
  const projected = toDiscoverRouteModel(selected.value, (value) => value);
  equal(projected.items[0].evidenceStatus, "link-only");
  equal(projected.items[0].candidate.initialItem, null);
  equal("associateNotes" in runtime, false);
  equal("associateTranscript" in runtime, false);
  equal("associateOriginal" in runtime, false);
  const contents = await persistence.list(
    "owner-a",
    "discovery_evidence_content",
  );
  if (contents.ok) equal(contents.value.length, 0);
});

Deno.test("retired discovery decisions remain exportable but are not projected", async () => {
  const persistence = new FakePersistence();
  await persistence.appendBatch([{
    id: "discovery_triage:legacy-triage",
    ownerId: "owner-a",
    kind: "discovery_triage",
    payloadJson: JSON.stringify({
      id: "legacy-triage",
      ownerId: "owner-a",
      itemId: "legacy-item",
      itemVersion: 1,
      decision: "defer",
      revision: 1,
      idempotencyKey: "legacy-defer",
      decidedAt: "2026-07-21T01:00:00.000Z",
    }),
    recordedAt: "2026-07-21T01:00:00.000Z",
  }]);
  const { runtime } = setup(persistence);
  await runtime.load();
  equal("triage" in runtime, false);
  const triageRecords = await persistence.list("owner-a", "discovery_triage");
  if (!triageRecords.ok) throw new Error(triageRecords.error.kind);
  equal(triageRecords.value.length, 1);
  const tampered = runtime.renderModel({
    name: "discover",
    cursor: "forged",
    selectedItemId: null,
    online: true,
  });
  if (!tampered.ok) equal(tampered.error.kind, "DiscoveryPageCursorInvalid");
});
