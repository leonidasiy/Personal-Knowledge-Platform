// @ts-check

import { renderDiscoverRoute } from "../src/routes/discover.js";

/** @import { DiscoverEvidenceStatus, DiscoverRouteItem, DiscoverRouteModel, DiscoverRouteState } from "../src/routes/discover.js" */

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

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      "Expected " + String(expected) + ", received " + String(actual) + ".",
    );
  }
}

/** @param {() => unknown} operation @param {string} message */
function assertThrows(operation, message) {
  try {
    operation();
  } catch (error) {
    assert(error instanceof TypeError, message + ": expected TypeError.");
    return;
  }
  throw new Error(message + ": expected an exception.");
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character] ?? character);
}

/**
 * @param {Partial<DiscoverRouteItem>} [overrides]
 * @returns {DiscoverRouteItem}
 */
function item(overrides = {}) {
  return Object.freeze({
    id: "observed-item-1",
    version: 1,
    title: "Voice leading in a cadence",
    sourceLabel: "YouTube",
    observedAtLabel: "Observed Jul 21, 2026",
    rightsLabel: "Link and metadata only",
    provenanceLabel: "Official YouTube Data API",
    sourceUrl: "https://www.youtube.com/watch?v=source-1",
    evidenceStatus: /** @type {const} */ ("link-only"),
    youtubeWatchUrl: "https://www.youtube.com/watch?v=source-1",
    triageDecision: null,
    triageRevision: 0,
    podcastReferenceLabel: null,
    candidate: Object.freeze({
      submittedUrl: "https://www.youtube.com/watch?v=source-1",
      canonicalUrl: "https://www.youtube.com/watch?v=source-1",
      canonicalIdentity: "https://www.youtube.com/watch?v=source-1",
      title: "Voice leading source",
      description: "A source selected from discovery.",
      adapter: Object.freeze({
        id: "youtube-data-api",
        version: "1",
        granularity: "individual-video",
        capabilities: Object.freeze(["metadata", "manual-transcript"]),
      }),
      identityEvidence: Object.freeze([{
        attribute: "video-id",
        value: "source-1",
        provenanceUrl: "https://www.youtube.com/watch?v=source-1",
        observedAt: "2026-07-21T08:00:00.000Z",
      }]),
      initialItem: Object.freeze({
        itemId: "video-source-1",
        versionId: "metadata-v1",
        canonicalUrl: "https://www.youtube.com/watch?v=source-1",
        title: "Voice leading source",
        description: "Provider metadata.",
        contentDigest: "digest-source-1",
        provenance: Object.freeze([{ method: "provider-metadata", reference: "source-1" }]),
        observedAt: "2026-07-21T08:00:00.000Z",
        publishedAt: null,
      }),
    }),
    ...overrides,
  });
}

/**
 * @param {DiscoverRouteState} state
 * @param {readonly DiscoverRouteItem[]} items
 * @param {Partial<DiscoverRouteModel>} [overrides]
 * @returns {DiscoverRouteModel}
 */
function model(state, items, overrides = {}) {
  const needsMessage = state === "partial" || state === "error" ||
    state === "offline";
  return Object.freeze({
    state,
    stateMessage: needsMessage ? state + " state detail" : null,
    page: /** @type {const} */ ("list"),
    items,
    selectedItemId: null,
    maxVisibleItems: 50,
    areas: Object.freeze([{ id: "area-a", title: "Music" }]),
    pendingId: null,
    canAct: true,
    search: Object.freeze({
      query: "",
      limit: 10,
      capabilities: Object.freeze([Object.freeze({
        id: "youtube",
        label: "YouTube videos",
        resultKind: "video",
        priority: 1,
        enabled: true,
      })]),
      selectedProviderIds: Object.freeze(["youtube"]),
      available: true,
    }),
    markup: DISCOVERY_MARKUP,
    escapeHtml,
    ...overrides,
  });
}

Deno.test("Discover renders every semantic run state explicitly", () => {
  /** @type {readonly [DiscoverRouteState, readonly DiscoverRouteItem[], readonly string[]][]} */
  const cases = [
    ["never-run", [], ["Explore learning sources"]],
    ["loading", [], ['role="status"', 'aria-busy="true"']],
    ["partial", [item()], ['role="status"', "partial state detail"]],
    ["error", [], ['role="alert"', "Discovery is unavailable"]],
    ["offline", [item()], ['role="status"', "offline state detail"]],
    ["empty", [], ["No results found"]],
    ["success", [item()], ['aria-label="Discovery results"', "1 shown"]],
  ];

  for (const [state, routeItems, expected] of cases) {
    const html = renderDiscoverRoute(model(state, routeItems));
    assert(
      html.includes('data-discovery-state="' + state + '"'),
      state + " must retain its semantic state marker.",
    );
    assert(
      html.includes('aria-labelledby="discover-title"'),
      state + " must retain the named route landmark.",
    );
    for (const marker of expected) {
      assert(html.includes(marker), state + " is missing " + marker + ".");
    }
  }
});

Deno.test("Discover renders exact evidence labels and selected detail", () => {
  /** @type {readonly [DiscoverEvidenceStatus, string][]} */
  const statuses = [
    ["link-only", "Link only"],
    ["learner-notes", "Your notes"],
    ["publisher-transcript", "Publisher transcript"],
    ["user-original", "Your original"],
  ];
  const routeItems = statuses.map(([evidenceStatus], index) =>
    item({
      id: "item-" + (index + 1),
      title: "Result " + (index + 1),
      evidenceStatus,
    })
  );
  const html = renderDiscoverRoute(model("success", routeItems, {
    page: "detail",
    selectedItemId: "item-3",
  }));

  for (const [, label] of statuses) {
    assert(html.includes("Evidence: " + label), label + " must label its row.");
  }
  assert(
    html.includes('data-selected-item-id="item-3"') &&
      html.includes('<h2 id="discover-detail-title">Result 3</h2>') &&
      html.includes('aria-current="true"'),
    "The immutable selected ID must control detail and current row.",
  );
  assert(
    html.includes("Evidence only. No quiz has been generated from this item."),
    "The detail must state the evidence-only milestone boundary.",
  );
});

Deno.test("Discover labels podcast references without claiming transcript rights", () => {
  const html = renderDiscoverRoute(model("success", [item({
    podcastReferenceLabel:
      "2 publisher transcript references; enclosure available",
  })], {
    page: "detail",
    selectedItemId: "observed-item-1",
  }));
  assert(
    html.includes("Podcast references"),
    "Podcast metadata must be visible.",
  );
  assert(
    html.includes("2 publisher transcript references; enclosure available"),
    "The bounded reference summary must be preserved.",
  );
  assert(
    html.includes("Evidence only. No quiz has been generated"),
    "Podcast availability must not imply learning rights.",
  );
});

Deno.test("Discover escapes every rendered remote field", () => {
  const calls = new Set();
  const hostile = '<img src=x onerror="alert(1)">';
  const routeItem = item({
    id: "id-" + hostile,
    title: hostile,
    sourceLabel: "source-" + hostile,
    observedAtLabel: "observed-" + hostile,
    rightsLabel: "rights-" + hostile,
    provenanceLabel: "provenance-" + hostile,
    youtubeWatchUrl: "https://www.youtube.com/watch?v=a&list=b",
  });
  const html = renderDiscoverRoute(model("partial", [routeItem], {
    page: "detail",
    selectedItemId: routeItem.id,
    stateMessage: "message-" + hostile,
    escapeHtml: (value) => {
      calls.add(value);
      return escapeHtml(value);
    },
  }));

  for (
    const value of [
      routeItem.title,
      routeItem.sourceLabel,
      routeItem.observedAtLabel,
      routeItem.rightsLabel,
      routeItem.provenanceLabel,
      "message-" + hostile,
    ]
  ) {
    assert(calls.has(value), value + " must pass through injected escaping.");
  }
  assert(!html.includes(hostile), "Unescaped remote markup must not render.");
  assert(
    html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;") &&
      html.includes("watch?v=a&amp;list=b"),
    "Escaped remote text and URL attributes must be retained.",
  );
});

Deno.test("Discover exposes only safe HTTPS YouTube watch links", () => {
  const safe = renderDiscoverRoute(model("success", [item()], {
    page: "detail",
    selectedItemId: "observed-item-1",
  }));
  assert(
    safe.includes('href="https://www.youtube.com/watch?v=source-1"') &&
      safe.includes('target="_blank"') &&
      safe.includes('rel="noopener noreferrer"') &&
      safe.includes("Watch on YouTube"),
    "A valid watch URL must be external-link safe and clearly named.",
  );

  for (
    const unsafeUrl of [
      "javascript:alert(1)",
      "http://www.youtube.com/watch?v=source-1",
      "https://example.test/watch?v=source-1",
      "https://www.youtube.com.evil.test/watch?v=source-1",
      "https://user:pass@www.youtube.com/watch?v=source-1",
      "not a URL",
    ]
  ) {
    const unsafe = renderDiscoverRoute(model("success", [item({
      youtubeWatchUrl: unsafeUrl,
    })], {
      page: "detail",
      selectedItemId: "observed-item-1",
    }));
    assert(
      unsafe.includes("Watch link unavailable") &&
        !unsafe.includes('href="' + unsafeUrl),
      unsafeUrl + " must never become an actionable link.",
    );
  }
});

Deno.test("YouTube timestamp fragments retain their existing safe watch behavior", () => {
  const url = "https://www.youtube.com/watch?v=source-1#t=30";
  const html = renderDiscoverRoute(model("success", [item({sourceUrl:url, youtubeWatchUrl:url})], {page:"detail",selectedItemId:"observed-item-1"}));
  assert(html.includes(`href="${url}"`), "Preserve safe timestamp fragments on YouTube watch links.");
});

Deno.test("Discovery exposes source extraction without manual subject or rejection controls", () => {
  const html = renderDiscoverRoute(model("success", [item()], {
    page: "detail",
    selectedItemId: "observed-item-1",
  }));
  for (
    const prohibited of [
      "Add my notes",
      "Publisher excerpt",
      "Upload my original",
      "Inbox decision",
      "Defer",
      "data-discovery-evidence-form=",
      "data-discovery-triage=",
      "Get transcript",
      "Quiz ready",
      "Start quiz",
      "Begin learning",
      'data-action="mark-studied"',
    ]
  ) {
    assert(!html.includes(prohibited), prohibited + " must not be rendered.");
  }
  assert(
    html.includes('aria-label="Source action"') &&
      html.includes("Watch on YouTube") &&
      html.includes("Upload video transcript") &&
      !html.includes("data-discovery-approve") &&
      !html.includes("data-discovery-reject"),
    "The attributed source and the two approved Library decisions must remain available.",
  );
  assert(
    html.includes(
      "does not download YouTube video, audio, captions, or transcripts",
    ),
    "YouTube candidates must state the manual-transcript boundary.",
  );
  assert(
    html.includes("data-discovery-open-upload") &&
      !html.includes("data-discovery-upload="),
    "YouTube detail must navigate to the existing rights-attested Upload panel.",
  );
});

Deno.test("Discover renders the actual feed approval contract with metadata-only capabilities", () => {
  const feedCandidate = item({
    id: "feed-observed-1",
    youtubeWatchUrl: null,
    candidate: Object.freeze({
      ...item().candidate,
      adapter: Object.freeze({
        id: "podcast-feed",
        version: "1",
        granularity: "feed",
        capabilities: Object.freeze(["metadata"]),
      }),
    }),
  });
  const html = renderDiscoverRoute(model("success", [feedCandidate], {
    page: "detail",
    selectedItemId: "feed-observed-1",
  }));
  assert(
    html.includes('data-discovery-approve="feed-observed-1"') &&
      html.includes('data-source-granularity="feed"') &&
      html.includes('data-source-capabilities="metadata"'),
    "A feed candidate must retain its exact approval attributes.",
  );
});

Deno.test("Discover navigates non-YouTube material to Upload without an inline form", () => {
  const source = item({
    youtubeWatchUrl: null,
    candidate: Object.freeze({
      ...item().candidate,
      initialItem: null,
    }),
  });
  const html = renderDiscoverRoute(model("success", [source], {
    page: "detail",
    selectedItemId: source.id,
  }));
  assert(
    html.includes('data-discovery-open-upload="observed-item-1"') &&
      !html.includes('name="content"') &&
      !html.includes('name="material"'),
    "Material input belongs to the existing Upload panel.",
  );
});

Deno.test("Discover exposes one filtered search command without transcript scraping", () => {
  const html = renderDiscoverRoute(model("never-run", []));
  assert(
    html.includes("data-discovery-search-form") &&
      html.includes('name="query" type="search"') &&
      html.includes('<details class="discover-filters">') &&
      html.includes('name="provider"') &&
      html.includes('name="limit"'),
    "Discovery must expose one bounded search command with expandable filters.",
  );
  assert(
    html.includes("Find a learning source") &&
      html.includes("Source types") &&
      html.includes("YouTube videos") &&
      !html.includes("RSS or Atom"),
    "Discovery controls must use learner-facing centralized-search language.",
  );
  assert(
    !html.includes("Get transcript") &&
      !html.includes("data-discovery-rss-form") &&
      !html.includes("data-discovery-youtube-form"),
    "No transcript scraping or retired provider-specific form may exist.",
  );
  assert(
    !html.includes("data-discovery-action"),
    "Discover must not render unbound retry or start controls.",
  );
});

Deno.test("Discover reports stale selection and disables offline actions", () => {
  const stale = renderDiscoverRoute(model("success", [item()], {
    page: "detail",
    selectedItemId: "retired-item",
  }));
  assert(
    stale.includes('role="status"') &&
      stale.includes("Item unavailable") &&
      stale.includes('href="#discover"'),
    "A stale deep link must be explicit and recoverable.",
  );

  const offline = renderDiscoverRoute(model("offline", [item()], {
    page: "detail",
    selectedItemId: "observed-item-1",
    stateMessage: "Cached results are available. Network actions are disabled.",
  }));
  assert(
    offline.includes("Watch link unavailable") &&
      offline.includes('aria-describedby="discover-offline-message"') &&
      !offline.includes("Watch on YouTube</a>"),
    "Offline detail must not claim a queued network action.",
  );
});

Deno.test("Discover rejects invalid and unbounded route models", () => {
  assertThrows(
    () =>
      renderDiscoverRoute(model("success", [item(), item({ id: "two" })], {
        maxVisibleItems: 1,
      })),
    "An over-limit result set",
  );
  assertThrows(
    () =>
      renderDiscoverRoute(model("partial", [item()], {
        stateMessage: null,
      })),
    "A missing partial-state message",
  );
  assertThrows(
    () => renderDiscoverRoute(model("success", [item(), item()])),
    "Duplicate immutable item IDs",
  );
  assertThrows(
    () =>
      renderDiscoverRoute(model("success", [item()], {
        page: "detail",
        selectedItemId: null,
      })),
    "A detail route without an item ID",
  );
  assertEquals(
    renderDiscoverRoute(model("success", [item()])).includes(
      "Select a result",
    ),
    true,
  );
});

Deno.test("Discover describes the supported source search", () => {
  const html = renderDiscoverRoute(model("never-run", []));
  assert(html.includes('>Discover sources</h1>'), "Discover must identify the panel.");
  assert(html.includes("Search websites, podcast feeds, and videos."), "Discover must explain available sources.");
});

Deno.test("Explore source alone opens the validated source in a secure new tab and retains details", () => {
  const html = renderDiscoverRoute(model("success", [item({youtubeWatchUrl:null, sourceUrl:"https://publisher.example/actual?x=1&y=2"})]));
  assert(html.includes('href="#discover/item/observed-item-1"'), "Keep internal details/provenance access.");
  assert(/<a[^>]*href="https:\/\/publisher.example\/actual\?x=1&amp;y=2"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Explore source/.test(html), "Explore must be a separate external anchor.");
  assert(!/<a[^>]*href="#discover\/item[^>]*>(?:(?!<\/a>)[\s\S])*Explore source(?:(?!<\/a>)[\s\S])*<\/a>/.test(html), "Explore must not be inside the internal link.");
});
Deno.test("Explore source never links missing or unsafe URLs, including credential-bearing YouTube URLs", () => {
  for (const sourceUrl of ["", "not a URL", "javascript:alert(1)", "data:text/html,unsafe", "http://publisher.example/", "https://user:pass@publisher.example/", "https://publisher.example/#fragment"]) {
    const html = renderDiscoverRoute(model("success", [item({youtubeWatchUrl:null, sourceUrl})]));
    assert(!/<a[^>]*>Explore source/.test(html), "Unsafe or missing source must be unavailable: " + sourceUrl);
    assert(html.includes("Explore source unavailable"), "Explain unavailable action.");
  }
  const html = renderDiscoverRoute(model("success", [item({sourceUrl:"https://user:pass@www.youtube.com/watch?v=1", youtubeWatchUrl:"https://user:pass@www.youtube.com/watch?v=1"})], {page:"detail",selectedItemId:"observed-item-1"}));
  assert(!html.includes('href="https://user:pass@'), "YouTube must retain the credential guard as well.");
});
Deno.test("Explore is unavailable offline while detail and provenance remain accessible", () => {
  const html = renderDiscoverRoute(model("offline", [item()]));
  assert(html.includes("Explore source unavailable") && !/<a[^>]*>Explore source/.test(html), "Do not claim an offline network action.");
  assert(html.includes('href="#discover/item/observed-item-1"'), "Retain cached details.");
});

Deno.test("raw Discover routes YouTube processing to transcript upload while retaining Explore", () => {
  const sample=item();
  const html=renderDiscoverRoute(model("success",[sample],{page:"detail",selectedItemId:sample.id}));
  assert(html.includes("Unreviewed provider results"),"Explicit unreviewed notice");
  assert(html.includes("Upload video transcript") && html.includes("data-discovery-open-upload"), "Explicit transcript upload action");
  assert(!html.includes("data-discovery-approve"), "YouTube processing cannot start automatic extraction");
  assert(html.includes('target="_blank"'),"Safe Explore retained");
});
