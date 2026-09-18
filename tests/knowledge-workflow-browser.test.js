// @ts-check

import { createKnowledgeWorkflowBrowser } from "../worker/knowledge-workflow-browser.js";
import { createRobotsGate } from "../src/features/knowledge-workflows/robots.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

const rootUrl = "https://example.test/learn";

/** @param {number} status @param {string} url @param {string} body @param {Record<string, string>} [headers] */
function response(status, url, body, headers = { "content-type": "text/html" }) {
  return {
    status: () => status,
    url: () => url,
    headers: () => headers,
    request: () => ({ redirectChain: () => [] }),
    text: async () => body,
  };
}

/** @param {Record<string, readonly unknown[]>} pages @param {{ readonly screenshot?: Uint8Array, readonly projections?: Record<string, { readonly title: string, readonly text: string, readonly links: readonly string[] }>, readonly robotsFetch?: { readonly status: number, readonly headers?: Record<string, string>, readonly body: string }, readonly browserRequest?: false | "invalid", readonly nativePage?: { readonly status: number, readonly headers?: Record<string, string>, readonly body: string }, readonly nativePages?: readonly { readonly status: number, readonly headers?: Record<string, string>, readonly body: string }[], readonly nativeChunkKind?: "array-buffer", readonly networkIdle?: boolean, readonly launchFailure?: boolean, readonly malformedResource?: "session" | "context" | "page", readonly identityFailure?: "user-agent" | "headers", readonly beforeGoto?: () => Promise<void> }} [options] */
function fixture(pages, options = {}) {
  const calls = /** @type {string[]} */ ([]);
  const events = /** @type {string[]} */ ([]);
  const logs = /** @type {Record<string, unknown>[]} */ ([]);
  const userAgents = /** @type {string[]} */ ([]);
  const extraHeaders = /** @type {Record<string, string>[]} */ ([]);
  const sleeps = /** @type {number[]} */ ([]);
  let addressResolutionCalls = 0;
  let networkIdleCalls = 0;
  let now = 0;
  let currentBody = "";
  let currentUrl = "";
  let currentScreenshot = options.screenshot ?? new Uint8Array([1, 2, 3]);
  const nativeFetchCalls = /** @type {RequestInit[]} */ ([]);
  const browserRequestCalls = /** @type {string[]} */ ([]);
  let pageGlobalFetchCalls = 0;
  const nativePage = options.nativePage;
  const nativePages = options.nativePages ?? (nativePage === undefined ? [] : [nativePage]);
  let nativePageCall = 0;
  const closes = { session: 0, context: 0, page: 0 };
  const malformedPage = { async close() { closes.page += 1; } };
  const page = {
    async setUserAgent(/** @type {string} */ value) { events.push("setUserAgent"); if (options.identityFailure === "user-agent") throw new Error("user-agent configuration failed"); userAgents.push(value); },
    async setExtraHTTPHeaders(/** @type {Record<string, string>} */ value) { events.push("setExtraHTTPHeaders"); if (options.identityFailure === "headers") throw new Error("header configuration failed"); extraHeaders.push({ ...value }); },
    async setRequestInterception() { events.push("setRequestInterception"); },
    on() { events.push("on"); },
    async goto(/** @type {string} */ url) {
      events.push("goto");
      if (options.beforeGoto !== undefined) await options.beforeGoto();
      calls.push(url);
      currentUrl = url;
      const values = pages[url] ?? [response(404, url, "missing")];
      const value = values[Math.min(pageIndexFor(url, calls), values.length - 1)];
      if (value === undefined) throw new Error("Missing browser response fixture.");
      if (typeof value === "object" && value !== null && "text" in value && typeof value.text === "function") currentBody = await value.text();
      else currentBody = "<html><body>Learning text.</body></html>";
      return value;
    },
    async content() { return currentBody === "" ? "<html><body>Learning text.</body></html>" : currentBody; },
    ...(options.networkIdle ? { async waitForNetworkIdle() { networkIdleCalls += 1; } } : {}),
    /** @param {unknown[]} arguments_ */
    async evaluate(...arguments_) {
      if (typeof arguments_[0] === "function" && String(arguments_[0]).includes("fetch(")) pageGlobalFetchCalls += 1;
      const projection = options.projections?.[currentUrl] ?? { title: "Fixture", text: "Learning text.", links: [] };
      return JSON.stringify({ renderedTitle: projection.title, renderedText: projection.text, visibleLinks: projection.links });
    },
    async screenshot() { return currentScreenshot; },
    async close() { closes.page += 1; },
  };
  /** @param {string} url @param {readonly string[]} urls */
  function pageIndexFor(url, urls) { return urls.filter((candidate) => candidate === url).length - 1; }
  const context = {
    async newPage() { return options.malformedResource === "page" ? malformedPage : page; },
    async close() { closes.context += 1; },
  };
  const browser = {
    async createBrowserContext() { return options.malformedResource === "context" ? { close: async () => { closes.context += 1; } } : context; },
    async close() { closes.session += 1; },
  };
  const launcher = {
    async limits() { return { activeSessions: [], allowedBrowserAcquisitions: 1, maxConcurrentSessions: 2, timeUntilNextAllowedBrowserAcquisition: 0 }; },
    async launch() { if (options.launchFailure) throw new Error("browser launch unavailable"); return options.malformedResource === "session" ? { close: async () => { closes.session += 1; } } : browser; },
  };
  const reader = createKnowledgeWorkflowBrowser({
    launcher,
    binding: {},
    ...(nativePages.length === 0 ? {} : {
      fetch: async (/** @type {RequestInfo | URL} */ _input, /** @type {RequestInit | undefined} */ init = {}) => {
        nativeFetchCalls.push(init);
        const currentNativePage = nativePages[Math.min(nativePageCall, Math.max(0, nativePages.length - 1))];
        nativePageCall += 1;
        if (currentNativePage === undefined) throw new Error("Missing native response fixture.");
        const body = options.nativeChunkKind === "array-buffer"
          ? new ReadableStream({ start(controller) { const bytes = new TextEncoder().encode(currentNativePage.body); controller.enqueue(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); controller.close(); } })
          : currentNativePage.body;
        return new Response(body, {
          status: currentNativePage.status,
          headers: currentNativePage.headers ?? { "content-type": "text/html" },
        });
      },
    }),
    ...(options.browserRequest === false ? {} : options.browserRequest === "invalid" ? { browserRequest: "invalid" } : {
      browserRequest: async (/** @type {{ readonly url: string }} */ command) => {
        browserRequestCalls.push(command.url);
        const value = options.robotsFetch === undefined
          ? (pages[command.url]?.[0] ?? response(404, command.url, "", { "content-type": "text/plain" }))
          : response(options.robotsFetch.status, command.url, options.robotsFetch.body, options.robotsFetch.headers ?? { "content-type": "text/plain" });
        return value;
      },
    }),
    resolveAddresses: async () => { addressResolutionCalls += 1; return { ok: true, value: ["93.184.216.34"] }; },
    nowMs: () => now,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    minimumInterRequestDelayMilliseconds: 50,
    maximumRetryAfterMilliseconds: 2_000,
    renderSettleMilliseconds: 0,
    logger: (/** @type {Record<string, unknown>} */ entry) => { logs.push(entry); },
  });
  return { reader, calls, events, logs, userAgents, extraHeaders, sleeps, nativeFetchCalls, browserRequestCalls, closes, get pageGlobalFetchCalls() { return pageGlobalFetchCalls; }, get networkIdleCalls() { return networkIdleCalls; }, get addressResolutionCalls() { return addressResolutionCalls; }, setNow: (/** @type {number} */ value) => { now = value; }, setScreenshot: (/** @type {Uint8Array} */ value) => { currentScreenshot = value; } };
}

Deno.test("knowledge browser applies a stable ordinary browser identity before navigation", async () => {
  const pageUrl = `${rootUrl}/identity`;
  const fixtureValue = fixture({ [pageUrl]: [response(200, pageUrl, "<html><body>Identity.</body></html>")] });
  const result = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  assertEquals(result.ok, true);
  assertEquals(fixtureValue.userAgents[0], "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36");
  assertEquals(JSON.stringify(fixtureValue.extraHeaders[0]), JSON.stringify({
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
  }));
  assertEquals(fixtureValue.events.slice(0, 5).join(","), "setUserAgent,setExtraHTTPHeaders,setRequestInterception,on,goto");
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser reports identity configuration failures before navigation", async () => {
  for (const identityFailure of ["user-agent", "headers"]) {
    const pageUrl = `${rootUrl}/${identityFailure}`;
    const fixtureValue = fixture({ [pageUrl]: [response(200, pageUrl, "<html><body>Never navigated.</body></html>")] }, { identityFailure: /** @type {"user-agent" | "headers"} */ (identityFailure) });
    const result = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "KnowledgeBrowserLaunchFailed");
    assertEquals(fixtureValue.calls.length, 0);
    await fixtureValue.reader.close();
  }
});

Deno.test("knowledge workflow production composition injects isolated robots requests without page execution", async () => {
  const source = await Deno.readTextFile(new URL("../worker/knowledge-workflow-entry.mjs", import.meta.url));
  assertEquals(source.includes("browserRequest: typeof this.env.SOURCE_BROWSER_REQUEST === \"function\" ? this.env.SOURCE_BROWSER_REQUEST : undefined"), true);
  assertEquals(source.includes("browserRequest: async ({ page"), false);
  assertEquals(source.includes("browserRequest: async ({ page, url, timeout }) => page.goto"), false);
  assertEquals(source.includes("browserRequest: async ({ page, url, timeout }) => page.evaluate"), false);
});

Deno.test("knowledge browser closes malformed launch resources exactly once before and after reader close", async () => {
  const pageUrl = `${rootUrl}/malformed-launch`;
  for (const malformedResource of ["session", "context", "page"]) {
    const fixtureValue = fixture({ [pageUrl]: [response(200, pageUrl, "never reached")] }, { malformedResource: /** @type {"session" | "context" | "page"} */ (malformedResource) });
    const result = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "KnowledgeBrowserLaunchFailed");
    assertEquals(fixtureValue.closes.session, 1);
    assertEquals(fixtureValue.closes.context, malformedResource === "session" ? 0 : 1);
    assertEquals(fixtureValue.closes.page, malformedResource === "page" ? 1 : 0);
    assertEquals((await fixtureValue.reader.close()).ok, true);
    assertEquals(fixtureValue.closes.session, 1);
    assertEquals(fixtureValue.closes.context, malformedResource === "session" ? 0 : 1);
    assertEquals(fixtureValue.closes.page, malformedResource === "page" ? 1 : 0);
  }
});

Deno.test("knowledge browser reads an HTML page and deduplicates a repeated URL", async () => {
  const pageUrl = `${rootUrl}/introduction`;
  const fixtureValue = fixture({ [pageUrl]: [response(200, pageUrl, "<html><title>Intro</title><body>Notes.</body></html>")] });
  const first = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  const second = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  assertEquals(first.ok, true);
  assertEquals(second.ok, true);
  if (first.ok && second.ok) {
    assertEquals(new TextDecoder().decode(first.value.bytes), "<html><title>Intro</title><body>Notes.</body></html>");
    assertEquals(first.value.responseUrl, pageUrl);
    assertEquals(second.value.bytes.byteLength, first.value.bytes.byteLength);
  }
  assertEquals(fixtureValue.calls.length, 1);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser uses fixed pacing between distinct navigations", async () => {
  const firstUrl = `${rootUrl}/one`;
  const secondUrl = `${rootUrl}/two`;
  const fixtureValue = fixture({
    [firstUrl]: [response(200, firstUrl, "<html><body>One.</body></html>")],
    [secondUrl]: [response(200, secondUrl, "<html><body>Two.</body></html>")],
  });
  assertEquals((await fixtureValue.reader.readPage({ rootUrl, url: firstUrl })).ok, true);
  assertEquals((await fixtureValue.reader.readPage({ rootUrl, url: secondUrl })).ok, true);
  assertEquals(fixtureValue.sleeps.join(","), "50");
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser settles a rendered page and returns DOM text and visible links", async () => {
  const pageUrl = `${rootUrl}/chapter-one`;
  const nextUrl = `${rootUrl}/chapter-two`;
  const fixtureValue = fixture({ [pageUrl]: [response(200, pageUrl, "<html><body>Shell.</body></html>")] }, {
    networkIdle: true,
    projections: { [pageUrl]: { title: "Rendered chapter", text: "Content inserted after page load.", links: [nextUrl] } },
  });
  const result = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.renderedTitle, "Rendered chapter");
    assertEquals(result.value.renderedText, "Content inserted after page load.");
    assertEquals(result.value.visibleLinks.join(","), nextUrl);
  }
  assertEquals(fixtureValue.networkIdleCalls, 1);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser keeps navigation inside the approved source subtree", async () => {
  const outsideUrl = "https://example.test/other-book/chapter";
  const fixtureValue = fixture({ [outsideUrl]: [response(200, outsideUrl, "outside")] });
  const result = await fixtureValue.reader.readPage({ rootUrl, url: outsideUrl });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgeBrowserNavigationRejected");
  assertEquals(fixtureValue.calls.length, 0);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser preserves Browser Run failure for an equivalent slash root", async () => {
  const fixtureValue = fixture({}, { launchFailure: true, nativePage: { status: 200, body: "<html><body>Root content.</body></html>" } });
  const result = await fixtureValue.reader.readPage({ rootUrl: `${rootUrl}/`, url: rootUrl });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgeBrowserLaunchFailed");
  assertEquals(fixtureValue.nativeFetchCalls.length, 0);
  await fixtureValue.reader.close();
});

Deno.test("authorized Browser Run success returns the rendered page", async () => {
  const pageUrl = `${rootUrl}/authorized`;
  const fixtureValue = fixture({ [pageUrl]: [response(200, pageUrl, "<html><body>Authorized learning content.</body></html>")] });
  const result = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.renderedText, "Learning text.");
  assertEquals(fixtureValue.nativeFetchCalls.length, 0);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser success and safe diagnostic logging remain green", async () => {
  const pageUrl = `${rootUrl}/safe-diagnostics`;
  const fixtureValue = fixture({ [pageUrl]: [response(200, pageUrl, "safe body")] });
  const result = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  assertEquals(result.ok, true);
  assertEquals(fixtureValue.logs.some((entry) => entry.event === "knowledge-browser-page-success"), true);
  for (const log of fixtureValue.logs) for (const value of Object.values(log)) {
    if (typeof value === "string") assertEquals(value.includes("safe body"), false);
  }
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser never invokes raw Worker fetch after Browser Run failure", async () => {
  const pageUrl = `${rootUrl}/native`;
  const fixtureValue = fixture({}, { launchFailure: true, nativePage: { status: 200, body: "must not be read" } });
  const result = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgeBrowserLaunchFailed");
  assertEquals(fixtureValue.calls.length, 0);
  assertEquals(fixtureValue.nativeFetchCalls.length, 0);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser stops on a hard access block without falling back to fetch", async () => {
  const pageUrl = `${rootUrl}/blocked`;
  const fixtureValue = fixture({ [pageUrl]: [response(403, pageUrl, "blocked")] });
  const result = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgePageBotAccessDenied");
  assertEquals(fixtureValue.calls.length, 1);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser records a bounded diagnostic for an upstream page status failure", async () => {
  const pageUrl = `${rootUrl}/upstream-error`;
  const fixtureValue = fixture({ [pageUrl]: [response(502, pageUrl, "upstream error")] });
  const result = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgePageFetchFailed");
  const failure = fixtureValue.logs.find((entry) => entry.event === "knowledge-browser-page-failure");
  assertEquals(failure?.diagnosticToken, "http-non-success");
  assertEquals(failure?.httpStatus, 502);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser reads robots.txt from the source origin before a nested source path", async () => {
  const robotsUrl = "https://example.test/robots.txt";
  const fixtureValue = fixture({ [rootUrl]: [response(200, rootUrl, "<html><body>Source.</body></html>")] }, { robotsFetch: { status: 200, body: "User-agent: *\nDisallow: /private\n" } });
  const result = await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(new TextDecoder().decode(result.value.bytes), "User-agent: *\nDisallow: /private\n");
  assertEquals(fixtureValue.calls.join(","), "https://example.test/");
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser requires the exact canonical origin robots URL", async () => {
  const fixtureValue = fixture({}, { robotsFetch: { status: 200, body: "User-agent: *\n" } });
  for (const robotsUrl of [
    "https://example.test/learn/robots.txt",
    "https://example.test/robots.txt?query=private",
    "https://example.test/robots.txt#fragment",
    "https://user:password@example.test/robots.txt",
  ]) {
    const result = await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "KnowledgeBrowserNavigationRejected");
  }
  assertEquals(fixtureValue.browserRequestCalls.length, 0);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser rejects credential-bearing HTTPS page and robots URLs before every side effect", async () => {
  const robotsUrl = "https://example.test/robots.txt";
  const cases = [
    { kind: "page", command: { rootUrl: "https://user:password@example.test/learn", url: `${rootUrl}/page` } },
    { kind: "page", command: { rootUrl, url: "https://user:password@example.test/learn/page" } },
    { kind: "robots", command: { sourceUrl: "https://user:password@example.test/learn", robotsUrl } },
    { kind: "robots", command: { sourceUrl: rootUrl, robotsUrl: "https://user:password@example.test/robots.txt" } },
  ];
  for (const testCase of cases) {
    const fixtureValue = fixture({ [rootUrl]: [response(200, rootUrl, "must not navigate")], [robotsUrl]: [response(200, robotsUrl, "must not request", { "content-type": "text/plain" })] });
    const result = testCase.kind === "page"
      ? await fixtureValue.reader.readPage(/** @type {{ readonly rootUrl: string, readonly url: string }} */ (testCase.command))
      : await fixtureValue.reader.readRobots(/** @type {{ readonly sourceUrl: string, readonly robotsUrl: string }} */ (testCase.command));
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "KnowledgeBrowserNavigationRejected");
    assertEquals(fixtureValue.addressResolutionCalls, 0);
    assertEquals(fixtureValue.calls.length, 0);
    assertEquals(fixtureValue.browserRequestCalls.length, 0);
    assertEquals(fixtureValue.nativeFetchCalls.length, 0);
    await fixtureValue.reader.close();
  }
});

Deno.test("knowledge browser reads robots bytes through the injected isolated request capability", async () => {
  const robotsUrl = "https://example.test/robots.txt";
  const fixtureValue = fixture({ [rootUrl]: [response(200, rootUrl, "source")] }, { robotsFetch: { status: 200, body: "User-agent: *\nDisallow: /private\n" } });
  const result = await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(new TextDecoder().decode(result.value.bytes), "User-agent: *\nDisallow: /private\n");
  assertEquals(fixtureValue.browserRequestCalls.join(","), robotsUrl);
  assertEquals(fixtureValue.pageGlobalFetchCalls, 0);
  assertEquals(fixtureValue.nativeFetchCalls.length, 0);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser rejects absent or invalid isolated request capabilities before caching robots bytes", async () => {
  const robotsUrl = "https://example.test/robots.txt";
  for (const browserRequest of [false, "invalid"]) {
    const fixtureValue = fixture({ [rootUrl]: [response(200, rootUrl, "source")] }, { browserRequest: /** @type {false | "invalid"} */ (browserRequest), nativePage: { status: 200, body: "must not be read" } });
    const first = await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl });
    const second = await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl });
    assertEquals(first.ok, false);
    if (!first.ok) assertEquals(first.error.kind, "KnowledgeRobotsRequestCapabilityUnavailable");
    assertEquals(second.ok, false);
    if (!second.ok) assertEquals(second.error.kind, "KnowledgeRobotsRequestCapabilityUnavailable");
    assertEquals(fixtureValue.nativeFetchCalls.length, 0);
    await fixtureValue.reader.close();
  }
});

Deno.test("knowledge browser rejects a robots redirect unless the final URL is exactly canonical and does not cache its body", async () => {
  const robotsUrl = "https://example.test/robots.txt";
  const redirectUrl = "https://example.test/robots.txt?redirected=1";
  const fixtureValue = fixture({
    [robotsUrl]: [response(200, redirectUrl, "must not be cached")],
  });
  const first = await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl });
  const second = await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl });
  assertEquals(first.ok, false);
  if (!first.ok) assertEquals(first.error.kind, "KnowledgeRobotsRedirectRejected");
  assertEquals(second.ok, false);
  if (!second.ok) assertEquals(second.error.kind, "KnowledgeRobotsRedirectRejected");
  assertEquals(fixtureValue.browserRequestCalls.filter((url) => url === robotsUrl).length, 2);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser clears lifecycle state and rejects every operation after close", async () => {
  const pageUrl = `${rootUrl}/lifecycle`;
  const robotsUrl = "https://example.test/robots.txt";
  const fixtureValue = fixture({
    [pageUrl]: [response(200, pageUrl, "page body")],
    [robotsUrl]: [response(200, robotsUrl, "User-agent: *\n", { "content-type": "text/plain" })],
  });
  assertEquals((await fixtureValue.reader.readPage({ rootUrl, url: pageUrl })).ok, true);
  assertEquals((await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl })).ok, true);
  assertEquals((await fixtureValue.reader.screenshot({ rootUrl, url: pageUrl })).ok, true);
  assertEquals((await fixtureValue.reader.close()).ok, true);
  for (const result of [
    await fixtureValue.reader.readPage({ rootUrl, url: pageUrl }),
    await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl }),
    await fixtureValue.reader.screenshot({ rootUrl, url: pageUrl }),
    await fixtureValue.reader.close(),
  ]) {
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "KnowledgeBrowserClosed");
  }
  assertEquals(fixtureValue.calls.filter((url) => url === pageUrl).length, 2);
});

Deno.test("knowledge browser rejects concurrent operations without cross-operation state leakage", async () => {
  let release = /** @type {(() => void) | null} */ (null);
  /** @type {Promise<void>} */
  const hold = new Promise((resolve) => { release = () => resolve(); });
  let signalStarted = /** @type {(() => void) | null} */ (null);
  /** @type {Promise<void>} */
  const started = new Promise((resolve) => { signalStarted = () => resolve(); });
  const pageUrl = `${rootUrl}/concurrent`;
  const robotsUrl = "https://example.test/robots.txt";
  const fixtureValue = fixture({
    [pageUrl]: [response(200, pageUrl, "page body")],
    [robotsUrl]: [response(200, robotsUrl, "User-agent: *\n", { "content-type": "text/plain" })],
  }, { beforeGoto: async () => { if (signalStarted !== null) signalStarted(); await hold; } });
  const pagePromise = fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  await started;
  const concurrentPromise = Promise.all([
    fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl }),
    fixtureValue.reader.screenshot({ rootUrl, url: pageUrl }),
    fixtureValue.reader.close(),
  ]);
  if (release === null) throw new Error("Missing concurrency release.");
  release();
  const concurrent = await concurrentPromise;
  for (const result of concurrent) {
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "KnowledgeBrowserOperationConflict");
  }
  const page = await pagePromise;
  assertEquals(page.ok, true);
  if (page.ok) assertEquals(new TextDecoder().decode(page.value.bytes), "page body");
  assertEquals((await fixtureValue.reader.close()).ok, true);
});

Deno.test("knowledge browser reuses a successful host resolution across robots and page acquisition", async () => {
  const robotsUrl = "https://example.test/robots.txt";
  const pageUrl = `${rootUrl}/introduction`;
  const fixtureValue = fixture({
    [robotsUrl]: [response(200, robotsUrl, "User-agent: *\n", { "content-type": "text/plain" })],
    [pageUrl]: [response(200, pageUrl, "<html><body>Learning.</body></html>")],
  });
  assertEquals((await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl })).ok, true);
  assertEquals((await fixtureValue.reader.readPage({ rootUrl, url: pageUrl })).ok, true);
  assertEquals(fixtureValue.addressResolutionCalls, 1);
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser returns an explicit missing robots file for the gate to interpret", async () => {
  const robotsUrl = "https://example.test/robots.txt";
  const fixtureValue = fixture({ [robotsUrl]: [response(404, robotsUrl, "not found", { "content-type": "text/plain" })] });
  const result = await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, 404);
    assertEquals(new TextDecoder().decode(result.value.bytes), "not found");
  }
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser preserves a robots 403 even when the response body cannot be read", async () => {
  const robotsUrl = "https://example.test/robots.txt";
  const blockedResponse = response(403, robotsUrl, "origin refused robots access", { "content-type": "text/html" });
  let bodyReads = 0;
  blockedResponse.text = async () => { bodyReads += 1; if (bodyReads > 1) throw new Error("CloudFront body unavailable"); return "origin refused robots access"; };
  const fixtureValue = fixture({ [robotsUrl]: [blockedResponse] });
  const result = await fixtureValue.reader.readRobots({ sourceUrl: rootUrl, robotsUrl });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, 403);
    assertEquals(result.value.bytes.byteLength, 0);
  }
  assertEquals(bodyReads, 1);
  await fixtureValue.reader.close();
});

Deno.test("robots gate can continue after an origin robots 403 when the source page is reachable", async () => {
  const robotsUrl = "https://example.test/robots.txt";
  const fixtureValue = fixture({
    [robotsUrl]: [response(403, robotsUrl, "origin refused robots access", { "content-type": "text/html" })],
    [rootUrl]: [response(200, rootUrl, "<html><body>Public learning content.</body></html>")],
  });
  const gate = createRobotsGate({
    fetch: async () => new Response(null, { status: 500 }),
    fetchRobots: (command) => fixtureValue.reader.readRobots(command),
    verifyTargetReachable: async ({ sourceUrl, targetUrl }) => {
      const page = await fixtureValue.reader.readPage({ rootUrl: sourceUrl, url: targetUrl });
      return page.ok ? { ok: true, value: null } : { ok: false, error: { kind: page.error.kind } };
    },
    robotsUnavailablePolicy: "allow-403-if-target-reachable",
    resolveAddresses: async () => ({ ok: true, value: ["93.184.216.34"] }),
    now: () => "2026-08-18T00:00:00.000Z",
    logger: () => {},
  });
  const result = await gate.check({ rights: { status: "allowed", canonicalUrl: rootUrl } });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.httpStatus, 403);
    assertEquals(result.value.availability, "unavailable");
    assertEquals(result.value.content, "");
    assertEquals(result.value.matchedRule, null);
  }
  await fixtureValue.reader.close();
});

Deno.test("robots gate keeps an origin robots 403 blocked when the source page is not reachable", async () => {
  const robotsUrl = "https://example.test/robots.txt";
  const pageUrl = `${rootUrl}/blocked`;
  const fixtureValue = fixture({
    [robotsUrl]: [response(403, robotsUrl, "origin refused robots access", { "content-type": "text/html" })],
    [pageUrl]: [response(403, pageUrl, "blocked")],
  });
  const gate = createRobotsGate({
    fetch: async () => new Response(null, { status: 500 }),
    fetchRobots: (command) => fixtureValue.reader.readRobots(command),
    verifyTargetReachable: async ({ sourceUrl, targetUrl }) => {
      const page = await fixtureValue.reader.readPage({ rootUrl: sourceUrl, url: targetUrl });
      return page.ok ? { ok: true, value: null } : { ok: false, error: { kind: page.error.kind } };
    },
    robotsUnavailablePolicy: "allow-403-if-target-reachable",
    resolveAddresses: async () => ({ ok: true, value: ["93.184.216.34"] }),
    now: () => "2026-08-18T00:00:00.000Z",
    logger: () => {},
  });
  const result = await gate.check({ rights: { status: "allowed", canonicalUrl: rootUrl }, targetUrl: pageUrl });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "RobotsTargetUnavailable");
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser honors one bounded Retry-After retry", async () => {
  const pageUrl = `${rootUrl}/limited`;
  const fixtureValue = fixture({ [pageUrl]: [response(429, pageUrl, "limited", { "content-type": "text/html", "retry-after": "1" }), response(200, pageUrl, "<html><body>Recovered.</body></html>")] });
  const result = await fixtureValue.reader.readPage({ rootUrl, url: pageUrl });
  assertEquals(result.ok, true);
  assertEquals(fixtureValue.calls.length, 2);
  assertEquals(fixtureValue.sleeps.join(","), "1000,50");
  await fixtureValue.reader.close();
});

Deno.test("knowledge browser exposes bounded screenshot output and closes exactly once", async () => {
  const pageUrl = `${rootUrl}/visual`;
  const fixtureValue = fixture({ [pageUrl]: [response(200, pageUrl, "<html><body>Visual.</body></html>")] }, { screenshot: new Uint8Array([9, 8, 7]) });
  const screenshot = await fixtureValue.reader.screenshot({ rootUrl, url: pageUrl });
  assertEquals(screenshot.ok, true);
  if (screenshot.ok) assertEquals(screenshot.value.bytes.byteLength, 3);
  assertEquals((await fixtureValue.reader.close()).ok, true);
  const closed = await fixtureValue.reader.close();
  assertEquals(closed.ok, false);
  if (!closed.ok) assertEquals(closed.error.kind, "KnowledgeBrowserClosed");
});

Deno.test("robots gate can consume browser-acquired robots bytes", async () => {
  const gate = createRobotsGate({
    fetch: async () => new Response(null, { status: 500 }),
    fetchRobots: async () => ({ ok: true, value: { status: 200, bytes: new TextEncoder().encode("User-agent: *\nDisallow: /private\n") } }),
    resolveAddresses: async () => ({ ok: true, value: ["93.184.216.34"] }),
    now: () => "2026-08-18T00:00:00.000Z",
    logger: () => {},
  });
  const allowed = await gate.check({ rights: { status: "allowed", canonicalUrl: rootUrl } });
  assertEquals(allowed.ok, true);
  const denied = await gate.check({ rights: { status: "allowed", canonicalUrl: "https://example.test/private" } });
  assertEquals(denied.ok, false);
  if (!denied.ok) assertEquals(denied.error.kind, "RobotsDenied");
});
