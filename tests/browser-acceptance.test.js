// @ts-check

import { redactEvidence, redactScreenshotPage, removeExpiredArtifacts, responseDuration, runBrowserAcceptance, validateBrowserAcceptanceConfig } from "../scripts/browser-acceptance-core.mjs";

/** @param {unknown} actual @param {unknown} expected */
function equal(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }
/** @param {boolean} value @param {string} message */
function assert(value, message) { if (!value) throw new Error(message); }
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const targetUrl = "https://resonance-discovery.lirenleonidas.workers.dev";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const version = "4d2d8409-4b92-4a5f-a771-bccad9a140c1";

function environment() { return { BROWSER_ACCEPTANCE_TARGET_URL: targetUrl, BROWSER_ACCEPTANCE_CHROME_PATH: chromePath, BROWSER_ACCEPTANCE_NAVIGATION_TIMEOUT_MS: "15000", BROWSER_ACCEPTANCE_ACTION_TIMEOUT_MS: "5000", BROWSER_ACCEPTANCE_STORAGE_STATE_PATH: "/project/.private/browser-acceptance/storage-state.json" }; }
function config() { const result = validateBrowserAcceptanceConfig(environment(), { projectRoot: "/project" }); if (!result.ok) throw new Error(result.error.kind); return result.value; }
/** @param {{ readonly ok: false, readonly error: { readonly kind: string, readonly [key: string]: string | number } }} result @param {string} kind @param {Record<string, string | number>} details */
function failure(result, kind, details) { equal(result.error.kind, kind); equal(JSON.stringify(result.error), JSON.stringify({ kind, ...details })); }

Deno.test("config requires an explicit non-root project and exact controlled artifact roots", () => {
  const valid = config();
  equal(valid.artifactRoots[0], "/project/logs"); equal(valid.artifactRoots[1], "/project/test-results/browser-acceptance"); assert(Object.isFrozen(valid), "config is frozen");
  /** @type {readonly [Record<string, string>, { projectRoot?: string, logsRoot?: string, resultsRoot?: string }, string, Record<string, string | number>][]} */ const cases = [
    [environment(), {}, "BrowserAcceptanceConfigInvalid", { field: "projectRoot" }],
    [environment(), { projectRoot: "/" }, "BrowserAcceptanceConfigInvalid", { field: "projectRoot" }],
    [environment(), { projectRoot: "project" }, "BrowserAcceptanceConfigInvalid", { field: "projectRoot" }],
    [environment(), { projectRoot: "/project/" }, "BrowserAcceptanceConfigInvalid", { field: "projectRoot" }],
    [environment(), { projectRoot: "/project//workspace" }, "BrowserAcceptanceConfigInvalid", { field: "projectRoot" }],
    [environment(), { projectRoot: "/project/./workspace" }, "BrowserAcceptanceConfigInvalid", { field: "projectRoot" }],
    [environment(), { projectRoot: "/project/../workspace" }, "BrowserAcceptanceConfigInvalid", { field: "projectRoot" }],
    [{ ...environment(), BROWSER_ACCEPTANCE_STORAGE_STATE_PATH: "" }, { projectRoot: "/project" }, "BrowserAcceptanceSessionStateMissing", {}],
    [{ ...environment(), BROWSER_ACCEPTANCE_STORAGE_STATE_PATH: "/project/session.json" }, { projectRoot: "/project" }, "BrowserAcceptanceConfigInvalid", { field: "BROWSER_ACCEPTANCE_STORAGE_STATE_PATH" }],
    [environment(), { projectRoot: "/project", logsRoot: "/project/other" }, "BrowserAcceptanceConfigInvalid", { field: "logsRoot" }],
    [environment(), { projectRoot: "/project", resultsRoot: "/outside/results" }, "BrowserAcceptanceConfigInvalid", { field: "resultsRoot" }],
    [{ ...environment(), BROWSER_ACCEPTANCE_TARGET_URL: "https://other.workers.dev" }, { projectRoot: "/project" }, "BrowserAcceptanceConfigInvalid", { field: "BROWSER_ACCEPTANCE_TARGET_URL" }],
    [{ ...environment(), BROWSER_ACCEPTANCE_ACTION_TIMEOUT_MS: "120001" }, { projectRoot: "/project" }, "BrowserAcceptanceConfigInvalid", { field: "BROWSER_ACCEPTANCE_ACTION_TIMEOUT_MS" }],
  ];
  for (const [input, overrides, kind, details] of cases) {
    const result = validateBrowserAcceptanceConfig(/** @type {Record<string, string>} */ (input), /** @type {{ projectRoot?: string, logsRoot?: string, resultsRoot?: string }} */ (overrides));
    if (result.ok) throw new Error("Expected configuration failure.");
    failure(result, kind, details);
  }
});

Deno.test("redaction is total, allowlisted, and fail-closed by strict evidence schemas", () => {
  const accepted = redactEvidence({ url: `${targetUrl}/api/library?private=value`, status: 200, durationMs: 31, failureKind: "none", viewport: "desktop", workerVersion: version, responseBody: "private", cookie: "private", authorization: "Bearer private", "CF-Access-Client-Secret": "private" });
  equal(accepted.ok, true); if (accepted.ok) equal(JSON.stringify(accepted.value), JSON.stringify({ routeCategory: "api", status: 200, durationMs: 31, failureKind: "none", viewport: "desktop", workerVersion: version }));
  for (const event of [null, {}, { url: targetUrl, status: 200, durationMs: 1, failureKind: "opaque-value", viewport: "desktop", workerVersion: version }, { url: targetUrl, status: 200, durationMs: 1, failureKind: "none", viewport: "desktop", workerVersion: "eyJhbGciOiJIUzI1NiJ9.opaque.signature" }, { url: targetUrl, status: 99, durationMs: 1, failureKind: "none", viewport: "desktop", workerVersion: version }, { url: targetUrl, status: 200, durationMs: -1, failureKind: "none", viewport: "desktop", workerVersion: version }]) {
    const result = redactEvidence(/** @type {Record<string, unknown>} */ (event)); if (result.ok) throw new Error("Expected redaction failure."); failure(result, "BrowserAcceptanceRedactionFailed", { artifact: "evidence" });
  }
  const harmless = redactEvidence({ url: targetUrl, status: 200, durationMs: 1, failureKind: "none", viewport: "mobile", workerVersion: version });
  equal(harmless.ok, true);
});

Deno.test("page-context screenshot redaction removes known private DOM values and fails closed on duplicates", () => {
  /** @type {{ readonly selector: string, textContent: string, value?: string, removed: boolean, remove: () => void }} */
  const query = { selector: '[data-discovery-search-form] input[name="query"]', textContent: "", value: "private query", removed: false, remove() { this.removed = true; } };
  /** @type {{ readonly selector: string, textContent: string, value?: string, removed: boolean, remove: () => void }} */
  const result = { selector: "[data-discovery-item-id] strong", textContent: "Private source title", removed: false, remove() { this.removed = true; } };
  /** @type {{ readonly selector: string, textContent: string, value?: string, removed: boolean, remove: () => void }} */
  const card = { selector: "[data-discovery-item-id]", textContent: "Private source title", removed: false, remove() { this.removed = true; } };
  /** @type {{ readonly selector: string, textContent: string, value?: string, removed: boolean, remove: () => void }} */
  const notice = { selector: ".discover-notice", textContent: "Source notice", removed: false, remove() { this.removed = true; } };
  /** @type {{ readonly selector: string, textContent: string, value?: string, removed: boolean, remove: () => void }} */
  const publicText = { selector: "main", textContent: "Review", removed: false, remove() { this.removed = true; } };
  const nodes = [query, result, card, notice, publicText];
  /** @param {string} selector */
  const matches = (selector) => nodes.filter((node) => !node.removed && (selector === node.selector || (selector === '[data-discovery-item-id], [data-selected-item-id], [data-library-source], .learning-card, .review-card, .feed-card' && node.selector === "[data-discovery-item-id]") || (selector === '[role="status"], [role="alert"], .discover-notice, .notice, .toast' && node.selector === ".discover-notice")));
  const scope = /** @type {{ document?: unknown, location?: unknown }} */ (globalThis);
  const previousDocument = scope.document; const previousLocation = scope.location;
  try {
    /** @param {string} selector */
    const querySelector = (selector) => matches(selector)[0] ?? null;
    /** @param {string} selector */
    const querySelectorAll = (selector) => matches(selector);
    const renderedText = () => nodes.filter((node) => !node.removed && (node !== result || !card.removed)).map((node) => node.textContent).join(" ");
    scope.document = { querySelector, querySelectorAll, body: { get textContent() { return `${renderedText()} Offline access failed.`; }, get innerText() { return renderedText(); } } };
    scope.location = { hash: "#review" };
    equal(JSON.stringify(redactScreenshotPage("review")), JSON.stringify({ safe: true, route: "review" }));
    equal(query.value, ""); assert(card.removed && notice.removed, "Known result cards and notices must be removed.");
    equal(redactScreenshotPage("feed").safe, false);
    const visibleSecurity = { selector: "aside", textContent: "Access denied", removed: false, remove() { this.removed = true; } };
    nodes.push(visibleSecurity);
    equal(redactScreenshotPage("review").safe, false);
    visibleSecurity.remove();
    const duplicate = { selector: "aside", textContent: "Private source title", removed: false, remove() { this.removed = true; } };
    nodes.push(duplicate);
    equal(redactScreenshotPage("review").safe, false);
  } finally { scope.document = previousDocument; scope.location = previousLocation; }
});

Deno.test("retention blocks unsafe roots, invalid timestamps, and clock failures", async () => {
  /** @type {string[]} */ const removed = [];
  const fileSystem = {
    async listFiles() { return [{ path: "/project/logs/old.log", modifiedAt: "2026-06-01T00:00:00.000Z" }, { path: "/project/logs/new.log", modifiedAt: "2026-07-20T00:00:00.000Z" }]; },
    /** @param {string} path */ async remove(path) { removed.push(path); },
  };
  equal((await removeExpiredArtifacts(fileSystem, ["/project/logs"], () => new Date("2026-08-01T00:00:00.000Z"), 30)).ok, true); equal(JSON.stringify(removed), JSON.stringify(["/project/logs/old.log"]));
  /** @type {readonly [readonly { readonly path: string, readonly modifiedAt: string }[], () => Date][]} */ const unsafeCases = [[[{ path: "/outside/old.log", modifiedAt: "2026-06-01T00:00:00.000Z" }], () => new Date()], [[{ path: "/project/logs/old.log", modifiedAt: "not-a-date" }], () => new Date()], [[], () => { throw new Error("private clock"); }]];
  for (const [listed, clock] of unsafeCases) {
    const result = await removeExpiredArtifacts({ async listFiles() { return listed; }, async remove() {} }, ["/project/logs"], /** @type {() => Date} */ (clock), 30);
    if (result.ok) throw new Error("Expected cleanup failure."); failure(result, "BrowserAcceptanceArtifactCleanupFailed", { artifact: "retention" });
  }
});

Deno.test("retention validates every root and entry before deleting expired artifacts", async () => {
  /** @type {string[]} */ const removed = [];
  const result = await removeExpiredArtifacts({
    /** @param {string} root */
    async listFiles(root) {
      if (root === "/project/logs") return [{ path: "/project/logs/expired.log", modifiedAt: "2026-06-01T00:00:00.000Z" }];
      return [
        { path: "/project/test-results/browser-acceptance/expired.png", modifiedAt: "2026-06-01T00:00:00.000Z" },
        { path: "/project/test-results/browser-acceptance/malformed.png", modifiedAt: "not-a-date" },
      ];
    },
    /** @param {string} path */
    async remove(path) { removed.push(path); },
  }, ["/project/logs", "/project/test-results/browser-acceptance"], () => new Date("2026-08-01T00:00:00.000Z"), 30);
  if (result.ok) throw new Error("Expected atomic retention validation failure.");
  failure(result, "BrowserAcceptanceArtifactCleanupFailed", { artifact: "retention" });
  equal(removed.length, 0);
});

/** @param {{ readonly launchError?: boolean, readonly launchValue?: null | "invalid", readonly sessionError?: "missing" | "unreadable" | "malformed", readonly onError?: boolean, readonly consoleCategory?: string, readonly gotoError?: "network" | "timeout", readonly status?: number, readonly responses?: readonly { readonly url: string, readonly status: number, readonly timing?: unknown }[], readonly evaluateError?: boolean, readonly workerVersion?: string | null, readonly assertion?: string, readonly writeError?: boolean, readonly clockError?: boolean, readonly closeErrors?: readonly ("page" | "context" | "browser")[] }} [options] */
function dependencies(options = {}) {
  /** @type {Map<string, (event: Record<string, unknown>) => void>} */ const listeners = new Map();
  /** @type {string[]} */ const written = [];
  /** @type {unknown[]} */ const logged = [];
  /** @type {string[]} */ const cleanup = [];
  /** @type {string[]} */ const setup = [];
  const page = {
    /** @param {string} event @param {(event: Record<string, unknown>) => void} listener */ on(event, listener) { if (options.onError) throw new Error("private listener"); listeners.set(event, listener); },
    async goto() { if (options.gotoError === "timeout") throw Object.assign(new Error("private timeout"), { code: "ETIMEDOUT" }); if (options.gotoError === "network") throw new Error("private network"); if (options.consoleCategory !== undefined) listeners.get("console")?.({ category: options.consoleCategory }); for (const response of options.responses ?? []) listeners.get("response")?.({ ...response, request: () => ({ timing: () => response.timing ?? ({ startTime: 1_754_112_000_000, responseStart: 12, responseEnd: -1 }) }) }); return { status: options.status ?? 200 }; },
    async evaluate() { if (options.evaluateError) throw new Error("private evaluation"); return { workerVersion: options.workerVersion === undefined ? version : options.workerVersion, assertions: options.assertion === undefined ? [] : [{ assertion: options.assertion, passed: false }] }; },
    /** @param {{ readonly path: string }} request */ async screenshot(request) { assert(request.path.includes("run-a"), "generated run ID only"); },
    async close() { cleanup.push("page"); if (options.closeErrors?.includes("page")) throw new Error("private page close"); },
  };
  const context = {
    async newPage() { setup.push("page"); return page; },
    async close() { cleanup.push("context"); if (options.closeErrors?.includes("context")) throw new Error("private context close"); },
  };
  const browser = {
    /** @param {{ readonly serviceWorkers: "allow", readonly reducedMotion: "reduce", readonly storageState: unknown }} request */
    async newContext(request) { equal(JSON.stringify(request), JSON.stringify({ serviceWorkers: "allow", reducedMotion: "reduce", storageState: { cookies: [], origins: [] } })); return context; },
    async close() { cleanup.push("browser"); if (options.closeErrors?.includes("browser")) throw new Error("private browser close"); },
  };
  return {
    /** @param {string} path */
    async loadSessionState(path) {
      equal(path, "/project/.private/browser-acceptance/storage-state.json");
      if (options.sessionError !== undefined) return { ok: false, error: { kind: `BrowserAcceptanceSessionState${options.sessionError[0].toUpperCase()}${options.sessionError.slice(1)}` } };
      return { ok: true, value: Object.freeze({ cookies: Object.freeze([]), origins: Object.freeze([]) }) };
    },
    /** @param {{ readonly executablePath: string }} request */
    async launch(request) { equal(request.executablePath, chromePath); if (options.launchError) throw new Error("private launch"); if (options.launchValue === null) return null; if (options.launchValue === "invalid") return { close: "not-a-function" }; return browser; },
    fileSystem: {
      async listFiles() { return []; }, async remove() {}, async mkdir() {},
      /** @param {string} _path @param {string} contents */
      async writeTextFile(_path, contents) { if (options.writeError) throw new Error("private write"); written.push(contents); },
    },
    now: () => { if (options.clockError) throw new Error("private clock"); return new Date("2026-08-01T00:00:00.000Z"); },
    /** @param {unknown} entry */
    log(entry) { logged.push(entry); },
    createId: () => "run-a", state: { written, logged, cleanup, setup },
  };
}

Deno.test("runner maps lifecycle failures with exact required metadata", async () => {
  /** @type {readonly [Parameters<typeof dependencies>[0], string, Record<string, string | number>][]} */ const cases = [
    [{ sessionError: "missing" }, "BrowserAcceptanceSessionStateMissing", {}], [{ sessionError: "unreadable" }, "BrowserAcceptanceSessionStateUnreadable", {}], [{ sessionError: "malformed" }, "BrowserAcceptanceSessionStateMalformed", {}], [{ launchError: true }, "BrowserAcceptanceChromeLaunchFailed", {}], [{ gotoError: "network" }, "BrowserAcceptanceNetworkUnavailable", {}], [{ gotoError: "timeout" }, "BrowserAcceptanceNavigationTimedOut", { route: "document" }], [{ status: 302 }, "BrowserAcceptanceAccessRedirected", {}], [{ status: 403 }, "BrowserAcceptanceAccessRejected", { status: 403 }], [{ onError: true }, "BrowserAcceptanceConsoleError", { category: "listener" }], [{ evaluateError: true }, "BrowserAcceptanceAssertionFailed", { assertion: "evaluation" }], [{ workerVersion: null }, "BrowserAcceptanceWorkerVersionUnavailable", {}], [{ assertion: "feed-visible" }, "BrowserAcceptanceAssertionFailed", { assertion: "journey" }], [{ writeError: true }, "BrowserAcceptanceArtifactWriteFailed", { artifact: "evidence" }], [{ clockError: true }, "BrowserAcceptanceArtifactCleanupFailed", { artifact: "retention" }],
  ];
  for (const [options, kind, details] of cases) { const result = await runBrowserAcceptance(config(), dependencies(/** @type {Parameters<typeof dependencies>[0]} */ (options))); if (result.ok) throw new Error("Expected runner failure."); failure(result, kind, details); assert(!JSON.stringify(result.error).includes("private"), "private error text escaped"); }
});

Deno.test("runner maps raw console and assertion text to closed metadata", async () => {
  for (const sensitive of ["Authorization: Bearer private", "cookie=session-private", `${targetUrl}/discover?query=private`]) {
    const consoleResult = await runBrowserAcceptance(config(), dependencies({ consoleCategory: sensitive }));
    if (consoleResult.ok) throw new Error("Expected console failure.");
    failure(consoleResult, "BrowserAcceptanceConsoleError", { category: "runtime" });
    assert(!JSON.stringify(consoleResult).includes(sensitive), "Raw console input escaped.");

    const assertionResult = await runBrowserAcceptance(config(), dependencies({ assertion: sensitive }));
    if (assertionResult.ok) throw new Error("Expected assertion failure.");
    failure(assertionResult, "BrowserAcceptanceAssertionFailed", { assertion: "journey" });
    assert(!JSON.stringify(assertionResult).includes(sensitive), "Raw assertion input escaped.");
  }
});

Deno.test("runner loads isolated session state without installing credential routes", async () => {
  const dependency = dependencies();
  const result = await runBrowserAcceptance(config(), dependency);
  equal(result.ok, true);
  equal(JSON.stringify(dependency.state.cleanup), JSON.stringify(["page", "context", "browser"]));
});

Deno.test("runner uses a fresh context with native service-worker registration and no capability override", async () => {
  const dependency = dependencies();
  const result = await runBrowserAcceptance(config(), dependency);
  equal(result.ok, true);
  equal(JSON.stringify(dependency.state.setup), JSON.stringify(["page"]));
});

Deno.test("retention rejects normalized traversal and sibling-prefix paths before deletion", async () => {
  for (const path of ["/project/logs/../outside/old.log", "/project/logs-copy/old.log"]) {
    /** @type {string[]} */ const removed = [];
    const result = await removeExpiredArtifacts({
      async listFiles() { return [{ path, modifiedAt: "2026-06-01T00:00:00.000Z" }]; },
      /** @param {string} value */
      async remove(value) { removed.push(value); },
    }, ["/project/logs"], () => new Date("2026-08-01T00:00:00.000Z"), 30);
    if (result.ok) throw new Error("Expected unsafe-path failure.");
    failure(result, "BrowserAcceptanceArtifactCleanupFailed", { artifact: "retention" });
    equal(removed.length, 0);
  }
});

Deno.test("runner maps malformed launcher values without rejecting", async () => {
  for (const launchValue of [null, "invalid"]) {
    const result = await runBrowserAcceptance(config(), dependencies({ launchValue: /** @type {null | "invalid"} */ (launchValue) }));
    if (result.ok) throw new Error("Expected launch failure.");
    failure(result, "BrowserAcceptanceChromeLaunchFailed", {});
  }
});

Deno.test("runner only fails same-origin module and API non-success responses", async () => {
  /** @type {readonly [readonly { readonly url: string, readonly status: number }[], Record<string, string | number> | null][]} */ const responseCases = [[[{ url: "https://cdn.example/app.js", status: 500 }], null], [[{ url: `${targetUrl}/app.css`, status: 500 }], null], [[{ url: `${targetUrl}/assets/app.js`, status: 302 }], { category: "module", status: 302 }], [[{ url: `${targetUrl}/api/discover`, status: 500 }], { category: "api", status: 500 }]];
  for (const [responses, expected] of responseCases) {
    const result = await runBrowserAcceptance(config(), dependencies({ responses }));
    if (expected === null) equal(result.ok, true); else { if (result.ok) throw new Error("Expected same-origin response failure."); failure(result, "BrowserAcceptanceSameOriginResponseFailed", expected); }
  }
});

Deno.test("same-origin evidence is timed, redacted before retention, and fully logged", async () => {
  const dependency = dependencies({ responses: [{ url: `${targetUrl}/api/discover?query=private`, status: 200 }] });
  const result = await runBrowserAcceptance(config(), dependency);
  equal(result.ok, true);
  equal(dependency.state.written.length, 1);
  const artifact = dependency.state.written[0];
  assert(artifact.includes('"routeCategory":"api"') && artifact.includes('"durationMs":12'), "Timed API evidence must be retained.");
  assert(!artifact.includes("query=private") && !artifact.includes(targetUrl), "Evidence artifacts must not retain URLs or query text.");
  equal(dependency.state.logged.length, 2);
});

Deno.test("response timing accepts completed and pending Playwright epochs and closes malformed or over-budget evidence", async () => {
  const complete = { request: () => ({ timing: () => ({ startTime: 1_754_112_000_000, responseStart: 11, responseEnd: 12 }) }) };
  const pending = { request: () => ({ timing: () => ({ startTime: 1_754_112_000_000, responseStart: 11, responseEnd: -1 }) }) };
  equal(responseDuration(complete), 12); equal(responseDuration(pending), 11);
  for (const timing of [{ startTime: 1_754_112_000_000, responseStart: 11, responseEnd: 12 }, { startTime: 1_754_112_000_000, responseStart: 11, responseEnd: -1 }]) {
    equal((await runBrowserAcceptance(config(), dependencies({ responses: [{ url: `${targetUrl}/api/discover`, status: 200, timing }] }))).ok, true);
  }
  for (const timing of [{ startTime: "epoch", responseStart: 11, responseEnd: 12 }, { startTime: 1_754_112_000_000, responseStart: 11, responseEnd: 120_001 }]) {
    const result = await runBrowserAcceptance(config(), dependencies({ responses: [{ url: `${targetUrl}/api/discover`, status: 200, timing }] }));
    if (result.ok) throw new Error("Expected closed evidence failure.");
    failure(result, "BrowserAcceptanceRedactionFailed", { artifact: "evidence" });
  }
});

Deno.test("runner cleanup preserves the first failure after closing every resource", async () => {
  /** @type {readonly [readonly ("page" | "context" | "browser")[], string][]} */ const cleanupCases = [[["page"], "page"], [["context"], "context"], [["browser"], "browser"], [["page", "context", "browser"], "page"]];
  for (const [closeErrors, resource] of cleanupCases) {
    const dependency = dependencies({ closeErrors });
    const result = await runBrowserAcceptance(config(), dependency); if (result.ok) throw new Error("Expected cleanup failure."); failure(result, "BrowserAcceptanceCleanupFailed", { resource });
    equal(JSON.stringify(dependency.state.cleanup), JSON.stringify(["page", "context", "browser"]));
    assert(!JSON.stringify(result).includes("private"), "Cleanup details must remain redacted.");
  }
  const malformed = await runBrowserAcceptance(/** @type {never} */ (null), /** @type {never} */ (null)); if (malformed.ok) throw new Error("Expected malformed runner input failure."); failure(malformed, "BrowserAcceptanceConfigInvalid", { field: "config" });
});

/** @param {{ readonly failRemoval?: boolean, readonly staleReplacement?: boolean, readonly overlappingReplacement?: boolean, readonly firstApprovalConflict?: boolean, readonly firstApprovalConflictError?: string, readonly approvalResponseInvalid?: boolean, readonly approvalAutoNavigates?: boolean, readonly approvalAutoNavigatesDelayed?: boolean, readonly searchResponseMissing?: boolean, readonly searchResponseStatus?: number, readonly secondSearchResponseMissing?: boolean, readonly secondSearchResponseStatus?: number, readonly unsafeScreenshot?: boolean, readonly strictPlaywright?: boolean, readonly failAfterApproval?: boolean, readonly historyMismatchAfterApproval?: boolean, readonly historyMismatchAfterRemoval?: boolean, readonly delayedRerender?: boolean, readonly delayedRouteRender?: boolean, readonly delayedJourneyRender?: boolean, readonly delayedControlReady?: boolean, readonly accessContent?: boolean, readonly rawError?: boolean, readonly sourceNotice?: boolean, readonly openDialog?: boolean, readonly emptyLibrary?: boolean, readonly finalUrl?: string, readonly consoleBeforeNavigation?: boolean, readonly consoleDuringJourney?: boolean }} [options] */
function journeyDependencies(options = {}) {
  let phase = 0;
  let waitTicks = 0;
  /** @type {string | null} */ let selected = null;
  let approved = false;
  let removed = false;
  let removalTick = 0;
  let postApprovalFailure = false;
  let renderedRoute = "feed";
  /** @type {"feed" | "discover" | "review" | "library" | null} */ let pendingRoute = null;
  /** @type {string | null} */ let visibleSelected = null;
  /** @type {string | null} */ let pendingSelected = null;
  let listRendered = true;
  let pendingList = false;
  const privacy = { query: "music cognition", sourceNotice: options.sourceNotice === true, access: options.accessContent === true, rawError: options.rawError === true, dialog: options.openDialog === true };
  /** @type {string[]} */ const screenshots = [];
  /** @type {string[]} */ const actions = [];
  const ids = () => {
    if (options.delayedJourneyRender && !listRendered) return [];
    if (options.delayedRerender && ((phase === 1 && waitTicks < 1) || (phase >= 2 && waitTicks < 2))) return [];
    if (options.staleReplacement && phase < 3) return ["live-a", "feed-a"];
    if (phase < 2) return ["live-a", "live-b"];
    if (phase === 2) return options.overlappingReplacement ? ["live-a", "feed-a"] : ["nonfeed-a", "feed-a"];
    return options.firstApprovalConflict ? ["site-a", "site-b"] : ["site-a"];
  };
  const sources = () => {
    if (options.emptyLibrary) return [];
    if (!approved || (removed && (!options.delayedRerender || waitTicks > removalTick))) return ["pre-a", "pre-b"];
    if (options.delayedRerender && waitTicks < 3) return ["pre-a", "pre-b"];
    return ["pre-a", "pre-b", "created"];
  };
  const reviewMetric = () => approved && ((options.historyMismatchAfterApproval && !removed) || (options.historyMismatchAfterRemoval && removed)) ? "99% 99 of 100 correct" : "50% 1 of 2 correct";
  /** @param {string} selector */
  const locate = (selector) => ({
    async click() {
      actions.push(`click:${selector}`);
      if (options.consoleDuringJourney && selector === '.primary-nav [data-view="feed"]') listeners.get("console")?.({ type: () => "error" });
      const route = selector.match(/^\.primary-nav \[data-view="(feed|discover|review|library)"\]$/)?.[1];
      if (route === "feed" || route === "discover" || route === "review" || route === "library") {
        if (route === "library" && options.approvalAutoNavigates && renderedRoute === "library") throw new Error("duplicate library navigation");
        pendingRoute = route;
        if (route === "discover" && visibleSelected !== null) { pendingList = options.delayedJourneyRender === true; listRendered = !pendingList; }
        if (!options.delayedRouteRender && !options.delayedJourneyRender) renderedRoute = route;
      }
      const item = selector.match(/^\[data-discovery-item-id="([^"]+)"\]$/)?.[1];
      const disable = selector.match(/^\[data-library-disable="([^"]+)"\]$/)?.[1];
      if (item !== undefined) { selected = item; listRendered = false; if (options.delayedJourneyRender) pendingSelected = item; else visibleSelected = item; }
      if (disable === "created") { if (options.failRemoval) throw new Error("private removal"); removed = true; removalTick = waitTicks; }
      if (selector.includes('button[type="submit"]')) phase += selector.includes("data-discovery-search-form") ? 1 : 0;
      if (selector === "a.discover-back-link") selected = null;
    },
    /** @param {string} value */ async fill(value) { if (options.delayedJourneyRender) equal(renderedRoute, "discover"); actions.push(`fill:${selector}`); equal(value, "music cognition"); },
    async check() { if (options.delayedControlReady && waitTicks === 0) throw new Error("controls refreshing"); actions.push(`check:${selector}`); },
    async uncheck() { if (options.delayedControlReady && waitTicks === 0) throw new Error("controls refreshing"); actions.push(`uncheck:${selector}`); },
    async isEnabled() { return !options.delayedControlReady || waitTicks > 0; },
    /** @param {string} value */ async selectOption(value) { actions.push(`select:${value}`); },
    /** @param {string} value */ async press(value) {
      if (options.strictPlaywright) throw new Error("form is not actionably focusable");
      actions.push(`press:${selector}`);
      if (selector === "[data-discovery-search-form]") { equal(value, "Enter"); phase += 1; }
      if (selector.includes("data-discovery-approve")) approved = true;
    },
    async textContent() {
      if (selector === ".review-route .recall-metric:nth-of-type(1)" || selector === ".review-route .recall-metric:nth-of-type(2)") return reviewMetric();
      if (selector.includes("data-selected-item-id") && selector.endsWith(" h2")) return visibleSelected === "live-a" ? "Live result" : visibleSelected === "feed-a" || visibleSelected === "feed-b" ? "Feed result" : visibleSelected === "site-a" || visibleSelected === "site-b" ? "Site result" : null;
      if (selector === "[data-selected-item-id]") return visibleSelected === "feed-a" || visibleSelected === "feed-b" ? "Feed result feed · metadata" : visibleSelected === "live-a" ? "Live result" : null;
      if (selector === '[data-library-source="created"] p:nth-of-type(3)') return "site · metadata, bounded-ingestion";
      if (selector === '[data-library-source="created"]') return "incidental feed metadata body text";
      if (selector.endsWith("strong")) return "Live result";
      return null;
    },
    /** @param {string} name */ async getAttribute(name) {
      const route = selector.match(/^\.primary-nav \[data-view="(feed|discover|review|library)"\]$/)?.[1];
      if ((route === "feed" || route === "discover" || route === "review" || route === "library") && name === "aria-current") return renderedRoute === route ? "page" : null;
      if (selector === "[data-discovery-search-form]" && name === "data-discovery-search-bound") return "true";
      if (selector === ".review-route .recall-progress progress" && name === "value") return "1";
      if (selector === ".review-route .recall-progress progress" && name === "max") return "2";
      if (selector === "[data-selected-item-id]" && name === "data-selected-item-id") return visibleSelected;
      if ((selector === '[data-discovery-approve="feed-a"]' || selector === '[data-discovery-approve="feed-b"]' || selector === '[data-discovery-approve="nonfeed-a"]' || selector === '[data-discovery-approve="site-a"]' || selector === '[data-discovery-approve="site-b"]') && name === "data-discovery-approve") return selector.includes("feed-a") ? "feed-a" : selector.includes("feed-b") ? "feed-b" : selector.includes("site-a") ? "site-a" : selector.includes("site-b") ? "site-b" : "nonfeed-a";
      if ((selector === '[data-discovery-approve="feed-a"]' || selector === '[data-discovery-approve="feed-b"]') && name === "data-source-granularity") return "feed";
      if ((selector === '[data-discovery-approve="feed-a"]' || selector === '[data-discovery-approve="feed-b"]') && name === "data-source-capabilities") return "metadata";
      if ((selector === '[data-discovery-approve="site-a"]' || selector === '[data-discovery-approve="site-b"]') && name === "data-source-granularity") return "site";
      if ((selector === '[data-discovery-approve="site-a"]' || selector === '[data-discovery-approve="site-b"]') && name === "data-source-capabilities") return "metadata,bounded-ingestion";
      if (selector === '[data-discovery-approve="nonfeed-a"]' && name === "data-source-granularity") return "individual-item";
      if (selector === '[data-discovery-approve="nonfeed-a"]' && name === "data-source-capabilities") return "metadata";
      return null;
    },
    async inputValue() { return selector.includes('input[name="query"]') ? "music cognition" : phase === 1 ? "10" : "20"; },
    async isChecked() { return selector.includes('value="web"') ? phase === 1 || phase >= 3 : selector.includes('value="podcasts"'); },
    async waitFor() {
      if (options.delayedRerender && (selector === "[data-discovery-item-id]" || selector === "[data-library-source]") && (selector === "[data-discovery-item-id]" ? ids() : sources()).length === 0) throw new Error("not visible until rerender");
    },
    /** @param {(nodes: { readonly getAttribute: (name: string) => string }[]) => unknown} callback */ async evaluateAll(callback) {
      if (selector === "[data-library-source]" && approved && options.failAfterApproval && !postApprovalFailure) { postApprovalFailure = true; throw new Error("post approval render failed"); }
      const values = selector === "[data-discovery-item-id]" ? ids() : selector === "[data-library-source]" ? sources() : [];
      return callback(values.map((value) => ({ getAttribute: () => value })));
    },
  });
  let searchResponses = 0;
  let approvalResponses = 0;
  /** @type {Map<string, (event: Record<string, unknown>) => void>} */ const listeners = new Map();
  const page = {
    /** @param {string} event @param {(event: Record<string, unknown>) => void} listener */ on(event, listener) { listeners.set(event, listener); },
    once() {},
    locator: locate,
    /** @param {(response: Record<string, unknown>) => boolean} predicate */
    async waitForResponse(predicate) { const approvalStatus = options.firstApprovalConflict && approvalResponses === 0 ? 409 : 200; const approval = { url: () => `${targetUrl}/api/source-library/approve`, status: () => approvalStatus, json: async () => approvalStatus === 409 ? { error: options.firstApprovalConflictError ?? "SourceStateConflict" } : options.approvalResponseInvalid ? { result: {} } : { result: { source: { id: "created" } } }, request: () => ({ timing: () => ({ startTime: 1_754_112_000_000, responseStart: 12, responseEnd: 12 }) }) }; if (predicate(approval)) { listeners.get("response")?.(approval); if (approvalStatus === 409) listeners.get("console")?.({ type: () => "error", text: () => "Failed to load resource: the server responded with a status of 409 ()", location: () => ({ url: `${targetUrl}/api/source-library/approve`, lineNumber: 0, columnNumber: 0 }) }); actions.push("response:approval"); approvalResponses += 1; if (approvalStatus >= 200 && approvalStatus < 300) { approved = true; if (options.approvalAutoNavigates) renderedRoute = "library"; if (options.approvalAutoNavigatesDelayed) pendingRoute = "library"; } return approval; } actions.push("response:search"); searchResponses += 1; if ((searchResponses === 1 && options.searchResponseMissing) || (searchResponses === 2 && options.secondSearchResponseMissing)) throw new Error("private search response"); const response = { url: () => `${targetUrl}/api/discovery/search`, status: () => searchResponses === 2 ? options.secondSearchResponseStatus ?? 200 : options.searchResponseStatus ?? 200, request: () => ({ timing: () => ({ startTime: 1_754_112_000_000, responseStart: 12, responseEnd: 12 }) }) }; listeners.get("response")?.(response); if (!predicate(response)) throw new Error("search predicate mismatch"); return response; },
    async goto() { if (options.consoleBeforeNavigation) listeners.get("console")?.({ type: () => "error" }); return { status: () => 200, url: () => options.finalUrl ?? targetUrl, headers: async () => ({ "x-resonance-worker-version": version }) }; },
    /** @param {{ readonly width: number, readonly height: number }} viewport */ async setViewportSize(viewport) { actions.push(`viewport:${viewport.width}x${viewport.height}`); },
    async waitForTimeout() { waitTicks += 1; if (pendingRoute !== null) { renderedRoute = pendingRoute; pendingRoute = null; } if (pendingSelected !== null) { visibleSelected = pendingSelected; pendingSelected = null; } if (pendingList) { listRendered = true; pendingList = false; visibleSelected = null; } },
    /** @param {unknown} callback @param {unknown} expectedRoute */ async evaluate(callback, expectedRoute) { if (options.strictPlaywright && typeof callback !== "function") throw new Error("function required"); if (typeof callback !== "function") return { workerVersion: version, assertions: [] }; privacy.query = ""; privacy.sourceNotice = false; return { safe: !options.unsafeScreenshot && !privacy.access && !privacy.rawError && !privacy.dialog && expectedRoute === renderedRoute, route: renderedRoute }; },
    /** @param {{ readonly path: string }} request */ async screenshot(request) { assert(privacy.query === "" && !privacy.sourceNotice, "Screenshot requires query and source notice removal."); assert(!privacy.access && !privacy.rawError && !privacy.dialog, "Screenshot must not capture blocked private state."); const route = request.path.match(/-(feed|discover|review|library)\.png$/)?.[1]; assert(route === renderedRoute, "Screenshot requires the expected route to render first."); screenshots.push(request.path); },
    async close() {},
  };
  const base = dependencies();
  return {
    ...base,
    async launch() { return { async newContext() { return { async addInitScript() {}, async newPage() { return page; }, async route() {}, async unrouteAll() {}, async close() {} }; }, async close() {} }; },
    state: { actions, screenshots, sources, privacy },
  };
}

Deno.test("hosted journey drives both viewports, replaces live results, mutates once, and captures only redacted route screenshots", async () => {
  const dependency = journeyDependencies();
  const result = await runBrowserAcceptance(config(), dependency);
  equal(result.ok, true);
  assert(dependency.state.actions.includes("viewport:1440x1000") && dependency.state.actions.includes("viewport:390x844"), "Both approved viewports must run.");
  equal(dependency.state.actions.filter((entry) => entry === "click:[data-discovery-search-form] .discover-filters summary").length, 3);
  assert(dependency.state.actions.includes('check:[data-discovery-search-form] input[name="provider"][value="web"]') && dependency.state.actions.includes('check:[data-discovery-search-form] input[name="provider"][value="podcasts"]'), "The first search must be bounded to web and podcasts.");
  assert(dependency.state.actions.includes('uncheck:[data-discovery-search-form] input[name="provider"][value="youtube"]'), "YouTube must be explicitly excluded from the non-consent search.");
  equal(dependency.state.screenshots.length, 8);
  assert(dependency.state.screenshots.every((path) => /\/(desktop|mobile)-(feed|discover|review|library)\.png$/.test(path)), "Screenshot names must be route-only.");
});

Deno.test("hosted journey waits for the requested route to render before its screenshot", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ delayedRouteRender: true }));
  equal(result.ok, true);
});

Deno.test("hosted journey waits for Discovery controls to finish refreshing", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ delayedControlReady: true }));
  equal(result.ok, true);
});

Deno.test("hosted journey waits for post-screenshot Discover, detail, and list rendering", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ delayedJourneyRender: true }));
  equal(result.ok, true);
});

Deno.test("hosted path matches real Playwright evaluate, response headers, and actionable submit controls", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ strictPlaywright: true }));
  equal(result.ok, true);
});

Deno.test("hosted journey waits for delayed search, approval, and removal rerenders", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ delayedRerender: true }));
  equal(result.ok, true);
});

Deno.test("hosted journey accepts legitimate overlap when the filtered result set changes", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ overlappingReplacement: true }));
  equal(result.ok, true);
});

Deno.test("hosted journey accepts identical provider results after two proven search responses", async () => {
  const dependency = journeyDependencies({ staleReplacement: true });
  const result = await runBrowserAcceptance(config(), dependency);
  equal(result.ok, true);
  equal(dependency.state.actions.filter((entry) => entry === "response:search").length, 3);
});

Deno.test("hosted journey skips a disabled canonical site before one successful mutation", async () => {
  const dependency = journeyDependencies({ firstApprovalConflict: true });
  const result = await runBrowserAcceptance(config(), dependency);
  equal(result.ok, true);
  equal(dependency.state.actions.filter((entry) => entry === "response:approval").length, 2);
});

Deno.test("hosted journey blocks non-state approval conflicts", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ firstApprovalConflict: true, firstApprovalConflictError: "SourceInterestAreaMissing" }));
  if (result.ok) throw new Error("Expected non-state approval conflict failure.");
  failure(result, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "source-approval-response-non-success" });
});

Deno.test("hosted journey fails closed and cleans up after a malformed approval response", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ approvalResponseInvalid: true }));
  if (result.ok) throw new Error("Expected approval response failure.");
  failure(result, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "source-approval-response-invalid" });
});

Deno.test("hosted journey does not restart Library navigation after approval", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ approvalAutoNavigates: true }));
  equal(result.ok, true);
});

Deno.test("hosted journey waits for delayed automatic Library navigation after approval", async () => {
  const dependency = journeyDependencies({ approvalAutoNavigatesDelayed: true });
  const result = await runBrowserAcceptance(config(), dependency);
  equal(result.ok, true);
  equal(dependency.state.actions.filter((entry) => entry === 'click:.primary-nav [data-view="library"]').length, 5);
});

Deno.test("screenshot gate clears query and source notices but blocks Access, raw errors, and dialogs", async () => {
  const cleared = journeyDependencies({ sourceNotice: true });
  equal((await runBrowserAcceptance(config(), cleared)).ok, true);
  equal(cleared.state.privacy.query, ""); equal(cleared.state.privacy.sourceNotice, false);
  for (const options of [{ accessContent: true }, { rawError: true }, { openDialog: true }]) {
    const blocked = await runBrowserAcceptance(config(), journeyDependencies(options));
    if (blocked.ok) throw new Error("Expected screenshot privacy failure.");
    failure(blocked, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "desktop-routes" });
  }
});

Deno.test("completed history survives approval and removal; a mismatch cleans exactly the created source", async () => {
  equal((await runBrowserAcceptance(config(), journeyDependencies())).ok, true);
  const mismatch = journeyDependencies({ historyMismatchAfterApproval: true });
  const mismatchResult = await runBrowserAcceptance(config(), mismatch);
  if (mismatchResult.ok) throw new Error("Expected completed-history mismatch.");
  failure(mismatchResult, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "history-preservation" });
  equal(JSON.stringify(mismatch.state.sources()), JSON.stringify(["pre-a", "pre-b"]));
  equal(mismatch.state.actions.filter((action) => action === 'click:[data-library-disable="created"]').length, 1);
  const cleanupFailure = await runBrowserAcceptance(config(), journeyDependencies({ historyMismatchAfterApproval: true, failRemoval: true }));
  if (cleanupFailure.ok) throw new Error("Expected cleanup failure.");
  failure(cleanupFailure, "BrowserAcceptanceCleanupFailed", { resource: "source", stage: "history-preservation" });
  const afterRemoval = journeyDependencies({ historyMismatchAfterRemoval: true });
  const afterRemovalResult = await runBrowserAcceptance(config(), afterRemoval);
  if (afterRemovalResult.ok) throw new Error("Expected post-removal mismatch.");
  failure(afterRemovalResult, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "source-removal" });
  equal(afterRemoval.state.actions.filter((action) => action === 'click:[data-library-disable="created"]').length, 1);
});

Deno.test("post-approval recovery removes only the created source and gives cleanup failure precedence", async () => {
  const recovered = journeyDependencies({ failAfterApproval: true });
  const journeyFailure = await runBrowserAcceptance(config(), recovered);
  if (journeyFailure.ok) throw new Error("Expected post-approval journey failure.");
  failure(journeyFailure, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "source-approval" });
  equal(JSON.stringify(recovered.state.sources()), JSON.stringify(["pre-a", "pre-b"]));
  const cleanupFailure = await runBrowserAcceptance(config(), journeyDependencies({ failAfterApproval: true, failRemoval: true }));
  if (cleanupFailure.ok) throw new Error("Expected recovery cleanup failure.");
  failure(cleanupFailure, "BrowserAcceptanceCleanupFailed", { resource: "source", stage: "source-approval" });
});

Deno.test("hosted journey requires an unrelated preexisting Library source", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ emptyLibrary: true }));
  if (result.ok) throw new Error("Expected empty Library failure.");
  failure(result, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "baseline-history" });
});

Deno.test("hosted final URL permits only the canonical root slash variation", async () => {
  equal((await runBrowserAcceptance(config(), journeyDependencies({ finalUrl: `${targetUrl}/` }))).ok, true);
  for (const finalUrl of [`${targetUrl}/discover`, "https://other.example/"]) {
    const result = await runBrowserAcceptance(config(), journeyDependencies({ finalUrl }));
    if (result.ok) throw new Error("Expected redirect failure.");
    failure(result, "BrowserAcceptanceAccessRedirected", {});
  }
});

Deno.test("hosted runner prioritizes an off-target final URL over a pre-navigation console error", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ finalUrl: "https://other.example/", consoleBeforeNavigation: true }));
  if (result.ok) throw new Error("Expected access redirect failure.");
  failure(result, "BrowserAcceptanceAccessRedirected", {});
});

Deno.test("hosted runner preserves a runtime console failure for a canonical worker URL", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ consoleBeforeNavigation: true }));
  if (result.ok) throw new Error("Expected runtime console failure.");
  failure(result, "BrowserAcceptanceConsoleError", { category: "runtime" });
});

Deno.test("hosted runner preserves a runtime console failure raised during the journey", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ consoleDuringJourney: true }));
  if (result.ok) throw new Error("Expected runtime console failure.");
  failure(result, "BrowserAcceptanceConsoleError", { category: "runtime" });
});

Deno.test("hosted journey cleanup failure takes precedence over a deferred runtime console error", async () => {
  const result = await runBrowserAcceptance(config(), journeyDependencies({ consoleDuringJourney: true, failRemoval: true, historyMismatchAfterApproval: true }));
  if (result.ok) throw new Error("Expected source cleanup failure.");
  failure(result, "BrowserAcceptanceCleanupFailed", { resource: "source", stage: "history-preservation" });
});

Deno.test("hosted journey blocks a missing search response, unsafe screenshots, and mandatory source cleanup failures", async () => {
  /** @type {readonly [Parameters<typeof journeyDependencies>[0], string, Record<string, string>][]} */ const cases = [
    [{ searchResponseMissing: true }, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "primary-response-missing" }],
    [{ searchResponseStatus: 400 }, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "primary-response-non-success" }],
    [{ secondSearchResponseMissing: true }, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "podcast-response-missing" }],
    [{ secondSearchResponseStatus: 502 }, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "podcast-response-non-success" }],
    [{ unsafeScreenshot: true }, "BrowserAcceptanceAssertionFailed", { assertion: "journey", stage: "desktop-routes" }],
    [{ failRemoval: true }, "BrowserAcceptanceCleanupFailed", { resource: "source", stage: "source-removal" }],
  ];
  for (const [options, kind, details] of cases) {
    const result = await runBrowserAcceptance(config(), journeyDependencies(/** @type {{ readonly failRemoval?: boolean, readonly searchResponseMissing?: boolean, readonly searchResponseStatus?: number, readonly secondSearchResponseMissing?: boolean, readonly secondSearchResponseStatus?: number, readonly unsafeScreenshot?: boolean }} */ (options)));
    if (result.ok) throw new Error("Expected hosted workflow failure.");
    failure(result, kind, details);
  }
});
