// @ts-check

import { BrowserRunPageAcquirer } from "../worker/browser-run-page-acquirer.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

const root = "https://publisher.example/course/";
const cursor = { version: 1, nextOrdinal: 0, pagesProcessed: 0, decodedBytes: 0, redirects: 0, frontier: [{ ordinal: 0, url: root, depth: 0, state: /** @type {const} */ ("pending"), discoveredFromUrl: null }] };
const job = { ownerId: "owner-a", jobId: "job-a", sourceId: "source-a", sourceRevision: 1, rootUrl: root, cursor };
const capability = { outcome: /** @type {const} */ ("allowed"), evidenceReference: "https://publisher.example/rights", observedAt: "2026-07-22T10:00:00.000Z", expiresAt: null };
const rights = { registryId: "rights-a", registryVersion: "1", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, canonicalRootUrl: root, capabilities: { storage: capability, display: capability, transformation: capability }, attributionText: "Publisher", evidenceDigest: "sha256:rights", assessorId: "review", assessorVersion: "1", observedAt: "2026-07-22T10:00:00.000Z", expiresAt: null };
const plan = { policyVersion: "bounded-v1", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, rootUrl: root, selectedDepth: 2, depthReason: /** @type {const} */ ("policy-default"), depthEvidence: null, maximumPages: 100, maximumDecodedBytes: 25_000_000, maximumConcurrency: 2, maximumDurationMs: 120_000, maximumRedirects: 3, refreshIntervalMs: 604_800_000, assessedAt: "2026-07-22T12:00:00.000Z" };

class Page {
  /** @type {Map<"request" | "popup", (value: unknown) => void | Promise<void>>} */
  listeners = new Map();
  closed = 0;
  intercept = false;
  projection = { title: "Course", description: "Description", text: "Readable lesson text", links: ["https://publisher.example/course/lesson"] };
  html = "<main>Readable lesson text</main>";
  response = response(root);
  /** @param {boolean} value */
  async setRequestInterception(value) { this.intercept = value; }
  /** @param {"request" | "popup"} event @param {(value: unknown) => void | Promise<void>} listener */
  on(event, listener) { this.listeners.set(event, listener); }
  /** @param {string} url */
  async goto(url) {
    const listener = this.listeners.get("request");
    if (listener) await listener(request(url));
    return this.response;
  }
  async content() { return this.html; }
  async evaluate() { return this.projection; }
  async close() { this.closed += 1; }
}

/** @param {string} url @param {string} [type] */
function request(url, type = "document") {
  return { url: () => url, resourceType: () => type, isNavigationRequest: () => type === "document", aborted: false, continued: false, async abort() { this.aborted = true; }, async continue() { this.continued = true; } };
}

/** @param {string} url @param {{ readonly redirectChain?: readonly { readonly url: () => string, readonly response: () => ReturnType<typeof response> | null }[], readonly status?: number, readonly mediaType?: string, readonly peer?: { readonly ip: string, readonly port: number } }} [options] */
function response(url, options = {}) {
  const redirectChain = options.redirectChain ?? [];
  return { url: () => url, status: () => options.status ?? 200, headers: () => ({ "content-type": options.mediaType ?? "text/html; charset=utf-8" }), remoteAddress: () => options.peer === undefined ? { ip: "8.8.8.8", port: 443 } : options.peer, request: () => ({ redirectChain: () => redirectChain }) };
}

/** @param {{ readonly page?: Page, readonly limits?: unknown, readonly launchError?: Error, readonly malformed?: "browser" | "context" | "page", readonly closeFailure?: "page" | "context" | "browser", readonly times?: readonly string[] }} [options] */
function setup(options = {}) {
  const page = options.page ?? new Page();
  const malformedContext = { closed: 0, async close() { this.closed += 1; } };
  const malformedPage = { closed: 0, async close() { this.closed += 1; } };
  const context = { closed: 0, async newPage() { return options.malformed === "page" ? malformedPage : page; }, async close() { this.closed += 1; if (options.closeFailure === "context") throw new Error("close"); } };
  const browser = { closed: 0, async createBrowserContext() { return options.malformed === "context" ? malformedContext : context; }, async close() { this.closed += 1; if (options.closeFailure === "browser") throw new Error("close"); } };
  if (options.closeFailure === "page") page.close = async () => { page.closed += 1; throw new Error("close"); };
  const times = [...(options.times ?? ["2026-07-22T12:00:00.000Z", "2026-07-22T12:00:00.010Z", "2026-07-22T12:00:00.020Z", "2026-07-22T12:00:00.030Z"])];
  const malformedBrowser = { closed: 0, async close() { this.closed += 1; } };
  const subject = new BrowserRunPageAcquirer({ launcher: { limits: async () => options.limits ?? { activeSessions: [], allowedBrowserAcquisitions: 1, maxConcurrentSessions: 3, timeUntilNextAllowedBrowserAcquisition: 0 }, launch: async () => { if (options.launchError) throw options.launchError; return /** @type {never} */ (options.malformed === "browser" ? malformedBrowser : browser); } }, binding: {}, resolveAddresses: async () => ({ ok: true, value: ["8.8.8.8"] }), now: () => times.shift() ?? "2026-07-22T12:00:00.030Z", policy: { maximumPagesPerRun: 5, maximumRunMilliseconds: 60_000, navigationTimeoutMilliseconds: 15_000, maximumHtmlBytes: 10_000, maximumTextCharacters: 5_000, maximumLinksPerPage: 10, maximumFrontierEntries: 100 } });
  return { subject, page, context, browser, malformedBrowser, malformedContext, malformedPage };
}

Deno.test("Browser Run adapter intercepts before navigation, expands the bounded frontier, and closes all resources", async () => {
  const page = new Page();
  page.projection = { ...page.projection, links: ["https://publisher.example/course/lesson", "mailto:editor@publisher.example"] };
  page.goto = async function (url) { const listener = this.listeners.get("request"); if (listener) await listener(request(url)); return response(url); };
  const { subject, context, browser } = setup({ page });
  const result = await subject.acquire({ job, cursor, plan, rights });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.pages[0].title, "Course");
    assertEquals(result.value.pages.length, 2);
    assertEquals(result.value.pages[0].visibleLinks.length, 1);
    assertEquals(result.value.nextCursor, null);
  }
  assertEquals(page.intercept, true);
  assertEquals(page.closed, 1); assertEquals(context.closed, 1); assertEquals(browser.closed, 1);
});

Deno.test("Browser Run adapter rejects cross-boundary navigation before extraction", async () => {
  const page = new Page();
  page.goto = async function () { const listener = this.listeners.get("request"); if (listener) await listener(request("https://other.example/private")); return this.response; };
  let evaluations = 0; page.evaluate = async () => { evaluations += 1; return page.projection; };
  const { subject } = setup({ page });
  const result = await subject.acquire({ job, cursor, plan, rights });
  if (result.ok) throw new Error("Expected navigation rejection.");
  assertEquals(result.error.kind, "BrowserRunNavigationRejected");
  assertEquals(evaluations, 0);
});

Deno.test("Browser Run adapter requires public peer and redirect-chain evidence", async () => {
  const cases = [
    [response(root, { peer: { ip: "127.0.0.1", port: 443 } }), "BrowserRunPeerAddressRejected"],
    [response(root, { peer: { ip: "", port: 0 } }), "BrowserRunPeerAddressUnavailable"],
    [response(root, { redirectChain: [{ url: () => "https://other.example/", response: () => response("https://other.example/") }] }), "BrowserRunNavigationRejected"],
  ];
  for (const [fixture, kind] of cases) {
    const page = new Page(); page.response = /** @type {ReturnType<typeof response>} */ (fixture);
    const result = await setup({ page }).subject.acquire({ job, cursor, plan, rights });
    if (result.ok) throw new Error("Expected evidence rejection.");
    assertEquals(result.error.kind, kind);
  }
});

Deno.test("Browser Run adapter enforces structural extraction caps before returning body", async () => {
  const page = new Page(); page.projection = { ...page.projection, text: "x".repeat(5_001) };
  const result = await setup({ page }).subject.acquire({ job, cursor, plan, rights });
  if (result.ok) throw new Error("Expected extraction limit.");
  assertEquals(result.error.kind, "BrowserRunExtractionLimitExceeded");
  if (result.error.kind === "BrowserRunExtractionLimitExceeded") assertEquals(result.error.field, "text");
});

Deno.test("Browser Run adapter maps provider capacity and cleanup failures explicitly", async () => {
  let result = await setup({ limits: { activeSessions: [], allowedBrowserAcquisitions: 0, maxConcurrentSessions: 3, timeUntilNextAllowedBrowserAcquisition: 20_000 } }).subject.acquire({ job, cursor, plan, rights });
  if (result.ok) throw new Error("Expected throttle.");
  assertEquals(result.error.kind, "BrowserRunLaunchThrottled");
  result = await setup({ launchError: new Error("429 Browser time limit exceeded for today") }).subject.acquire({ job, cursor, plan, rights });
  if (result.ok) throw new Error("Expected daily limit.");
  assertEquals(result.error.kind, "BrowserRunDailyBudgetExceeded");
  result = await setup({ closeFailure: "browser" }).subject.acquire({ job, cursor, plan, rights });
  if (result.ok) throw new Error("Expected close failure.");
  assertEquals(result.error.kind, "BrowserRunSessionCloseFailed");
});

Deno.test("Browser Run adapter closes every resource after a non-Error provider failure", async () => {
  const page = new Page();
  page.goto = async () => { throw "provider-disconnected"; };
  const { subject, context, browser } = setup({ page });
  const result = await subject.acquire({ job, cursor, plan, rights });
  if (result.ok) throw new Error("Expected provider failure.");
  assertEquals(result.error.kind, "BrowserRunUnavailable");
  assertEquals(page.closed, 1);
  assertEquals(context.closed, 1);
  assertEquals(browser.closed, 1);
});

Deno.test("Browser Run adapter closes each acquired malformed launcher resource exactly once", async () => {
  for (const malformed of ["browser", "context", "page"]) {
    const fixture = setup({ malformed: /** @type {"browser" | "context" | "page"} */ (malformed) });
    const result = await fixture.subject.acquire({ job, cursor, plan, rights });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "BrowserRunLaunchFailed");
    if (malformed === "browser") assertEquals(fixture.malformedBrowser.closed, 1);
    if (malformed === "context") { assertEquals(fixture.malformedContext.closed, 1); assertEquals(fixture.browser.closed, 1); }
    if (malformed === "page") { assertEquals(fixture.malformedPage.closed, 1); assertEquals(fixture.context.closed, 1); assertEquals(fixture.browser.closed, 1); }
  }
});

Deno.test("Browser Run adapter rejects client-shaped commands and mismatched rights before launch", async () => {
  let launches = 0;
  const fixture = setup();
  const subject = new BrowserRunPageAcquirer({ launcher: { limits: async () => ({ activeSessions: [], allowedBrowserAcquisitions: 1, maxConcurrentSessions: 3, timeUntilNextAllowedBrowserAcquisition: 0 }), launch: async () => { launches += 1; return /** @type {never} */ (fixture.browser); } }, binding: {}, resolveAddresses: async () => ({ ok: true, value: ["8.8.8.8"] }), now: () => "2026-07-22T12:00:00.000Z", policy: { maximumPagesPerRun: 5, maximumRunMilliseconds: 60_000, navigationTimeoutMilliseconds: 15_000, maximumHtmlBytes: 10_000, maximumTextCharacters: 5_000, maximumLinksPerPage: 10, maximumFrontierEntries: 100 } });
  const result = await subject.acquire({ job, cursor, plan, rights: { ...rights, ownerId: "owner-b" }, url: "https://client.example" });
  if (result.ok) throw new Error("Expected invalid command.");
  assertEquals(result.error.kind, "BrowserRunConfigurationInvalid");
  assertEquals(launches, 0);
});
