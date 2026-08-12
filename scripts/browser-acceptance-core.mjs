// @ts-check

export const APPROVED_BROWSER_ACCEPTANCE_HOST = "resonance-discovery.lirenleonidas.workers.dev";
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAX_TIMEOUT_MS = 120_000;

/**
 * @typedef {
 * | { readonly kind: "BrowserAcceptanceConfigInvalid", readonly field: string }
 * | { readonly kind: "BrowserAcceptanceSessionStateMissing" }
 * | { readonly kind: "BrowserAcceptanceSessionStateUnreadable" }
 * | { readonly kind: "BrowserAcceptanceSessionStateMalformed" }
 * | { readonly kind: "BrowserAcceptanceChromeLaunchFailed" }
 * | { readonly kind: "BrowserAcceptanceBrowserSetupFailed", readonly stage: "context" | "page" }
 * | { readonly kind: "BrowserAcceptanceNetworkUnavailable" }
 * | { readonly kind: "BrowserAcceptanceAccessRejected", readonly status: number }
 * | { readonly kind: "BrowserAcceptanceAccessRedirected" }
 * | { readonly kind: "BrowserAcceptanceNavigationTimedOut", readonly route: string }
 * | { readonly kind: "BrowserAcceptanceConsoleError", readonly category: "listener" | "runtime" }
 * | { readonly kind: "BrowserAcceptanceSameOriginResponseFailed", readonly category: "module" | "api", readonly status: number }
 * | { readonly kind: "BrowserAcceptanceAssertionFailed", readonly assertion: "evaluation" }
 * | { readonly kind: "BrowserAcceptanceAssertionFailed", readonly assertion: "journey", readonly stage?: JourneyStage }
 * | { readonly kind: "BrowserAcceptanceWorkerVersionUnavailable" }
 * | { readonly kind: "BrowserAcceptanceArtifactWriteFailed", readonly artifact: string }
 * | { readonly kind: "BrowserAcceptanceArtifactCleanupFailed", readonly artifact: string }
 * | { readonly kind: "BrowserAcceptanceRedactionFailed", readonly artifact: string }
 * | { readonly kind: "BrowserAcceptanceCleanupFailed", readonly resource: string, readonly stage?: JourneyStage }
 * } BrowserAcceptanceFailure
 * @typedef {{ readonly targetUrl: string, readonly chromePath: string, readonly navigationTimeoutMs: number, readonly actionTimeoutMs: number, readonly storageStatePath: string, readonly artifactRoots: readonly [string, string] }} BrowserAcceptanceConfig
 * @typedef {{ readonly routeCategory: "document" | "module" | "asset" | "api", readonly status: number, readonly durationMs: number, readonly failureKind: "none" | "network" | "access" | "assertion", readonly viewport: "desktop" | "mobile", readonly workerVersion: string }} RedactedEvidence
 * @typedef {{ readonly runId: string, readonly workerVersion: string, readonly evidence: readonly RedactedEvidence[] }} BrowserAcceptanceReport
 * @typedef {{ readonly ok: true, readonly value: BrowserAcceptanceConfig } | { readonly ok: false, readonly error: BrowserAcceptanceFailure }} ConfigResult
 * @typedef {{ readonly ok: true, readonly value: RedactedEvidence } | { readonly ok: false, readonly error: { readonly kind: "BrowserAcceptanceRedactionFailed", readonly artifact: string } }} RedactionResult
 * @typedef {{ readonly ok: true } | { readonly ok: false, readonly error: { readonly kind: "BrowserAcceptanceArtifactCleanupFailed", readonly artifact: string } }} CleanupResult
 * @typedef {{ readonly ok: true, readonly value: BrowserAcceptanceReport } | { readonly ok: false, readonly error: BrowserAcceptanceFailure }} BrowserRunResult
 * @typedef {"feed" | "discover" | "review" | "library"} JourneyRoute
 * @typedef {"desktop-routes" | "primary-route" | "primary-query" | "primary-filter" | "primary-providers" | "primary-limit" | "primary-submit" | "primary-response-missing" | "primary-response-non-success" | "primary-results" | "detail-roundtrip" | "podcast-controls" | "podcast-submit" | "podcast-response-missing" | "podcast-response-non-success" | "podcast-results" | "podcast-candidate" | "approval-candidate-submit" | "approval-candidate-response-missing" | "approval-candidate-response-non-success" | "approval-candidate-results" | "approval-candidate" | "baseline-history" | "source-approval" | "source-approval-response-missing" | "source-approval-response-non-success" | "source-approval-response-invalid" | "source-approval-exhausted" | "history-preservation" | "source-removal" | "mobile-routes"} JourneyStage
 */

/** @param {unknown} value */
function text(value) { return typeof value === "string" ? value : ""; }
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null; }
/** @param {string} path */
function absolutePath(path) { return path.startsWith("/") && path !== "/" && !path.split("/").includes(".") && !path.split("/").includes(".."); }
/** @param {string} path @returns {string | null} */
function normalizedAbsolutePath(path) {
  if (!path.startsWith("/")) return null;
  /** @type {string[]} */ const parts = [];
  for (const part of path.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
/** @param {string} url @returns {"document" | "module" | "asset" | "api"} */
function category(url) { try { const path = new URL(url).pathname; if (path.startsWith("/api/")) return "api"; if (/\.(?:m?js)$/i.test(path)) return "module"; if (/\.(?:css|png|jpe?g|webp|svg|ico|woff2?)$/i.test(path)) return "asset"; } catch {} return "document"; }
/** @param {string} url @param {unknown} status */
function expectedSourceApprovalConflict(url, status) {
  if (status !== 409) return false;
  try { return new URL(url).pathname === "/api/source-library/approve"; } catch { return false; }
}
/** @param {unknown} event @param {string} message */
function expectedSourceApprovalConflictConsole(event, message) {
  if (!/failed to load resource|\b409\b/i.test(message)) return false;
  const location = runtimeLocation(event);
  return location.startsWith("/api/source-library/approve:");
}
/** @param {unknown} event */
function runtimeLocation(event) {
  try {
    const location = eventValue(event, "location");
    const url = record(location) ? text(location.url) : "";
    const parsed = url === "" ? null : new URL(url);
    return parsed === null ? "unknown" : `${parsed.pathname}:${typeof location.lineNumber === "number" ? location.lineNumber : 0}:${typeof location.columnNumber === "number" ? location.columnNumber : 0}`;
  } catch { return "unknown"; }
}
/** @param {unknown} value */
function timeout(value) { return record(value) && "code" in value && value.code === "ETIMEDOUT"; }
/** @param {unknown} value */
function uuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
/** @param {unknown} value */
function nonblank(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value */
function stringList(value) { return Array.isArray(value) && value.every((entry) => nonblank(entry)) ? value : null; }
/** @param {unknown} event @param {string} field */
function eventValue(event, field) { try { return record(event) && typeof event[field] === "function" ? event[field]() : record(event) ? event[field] : undefined; } catch { return undefined; } }
/** @param {unknown} response */
async function workerVersionHeader(response) { const headers = await eventValue(response, "headers"); return record(headers) ? text(headers["x-resonance-worker-version"]) : ""; }
/** @param {unknown} response @returns {number | null} */
export function responseDuration(response) {
  const request = eventValue(response, "request"); const timing = eventValue(request, "timing");
  if (!record(timing) || typeof timing.startTime !== "number" || typeof timing.responseEnd !== "number") return null;
  const endpoint = timing.responseEnd >= 0 ? timing.responseEnd : timing.responseStart;
  return typeof endpoint === "number" && Number.isFinite(timing.startTime) && Number.isFinite(endpoint) && endpoint >= 0 && endpoint <= MAX_TIMEOUT_MS ? Math.round(endpoint) : null;
}
/** @param {string} expected @param {string} actual */
function sameFinalUrl(expected, actual) {
  try { const target = new URL(expected); const observed = new URL(actual); return target.origin === observed.origin && target.pathname === observed.pathname && observed.search === "" && observed.hash === "" && observed.username === "" && observed.password === ""; } catch { return false; }
}

const JOURNEY_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "desktop", width: 1440, height: 1000 }),
  Object.freeze({ name: "mobile", width: 390, height: 844 }),
]);

/** @param {Record<string, unknown>} page @param {string} selector */
function locator(page, selector) { return typeof page.locator === "function" ? page.locator(selector) : null; }
/** @param {unknown} value */
/** @param {unknown} value @param {string} method @param {unknown} [argument] */
async function action(value, method, argument) {
  if (!record(value) || typeof value[method] !== "function") throw new Error();
  return argument === undefined ? value[method]() : value[method](argument);
}
/** @param {Record<string, unknown>} page @param {string} selector */
async function textAt(page, selector) { const value = await action(locator(page, selector), "textContent"); return nonblank(value) ? value.trim() : null; }
/** @param {Record<string, unknown>} page @param {string} selector @param {string} name */
async function attributeAt(page, selector, name) { const value = await action(locator(page, selector), "getAttribute", name); return nonblank(value) ? value : null; }
/** @param {Record<string, unknown>} page @param {string} selector */
async function inputValueAt(page, selector) { const value = await action(locator(page, selector), "inputValue"); return nonblank(value) ? value : null; }
/** @param {Record<string, unknown>} page @param {string} selector */
async function checkedAt(page, selector) { const value = await action(locator(page, selector), "isChecked"); return typeof value === "boolean" ? value : null; }
/** @param {Record<string, unknown>} page @param {string} selector */
async function enabledAt(page, selector) { const value = await action(locator(page, selector), "isEnabled"); return typeof value === "boolean" ? value : null; }
/** @param {Record<string, unknown>} page */
async function resultIds(page) { const value = await action(locator(page, "[data-discovery-item-id]"), "evaluateAll", (/** @type {Element[]} */ nodes) => nodes.map((/** @type {Element} */ node) => node.getAttribute("data-discovery-item-id"))); return stringList(value); }
/** @param {Record<string, unknown>} page */
async function libraryIds(page) { const value = await action(locator(page, "[data-library-source]"), "evaluateAll", (/** @type {Element[]} */ nodes) => nodes.map((/** @type {Element} */ node) => node.getAttribute("data-library-source"))); return stringList(value); }
/**
 * Reads a changing DOM value until it satisfies the supplied condition.
 * @template T
 * @param {Record<string, unknown>} page
 * @param {number} timeoutMs
 * @param {() => Promise<T | null>} read
 * @param {(value: T) => boolean} matches
 * @returns {Promise<T>}
 */
async function waitForValue(page, timeoutMs, read, matches) {
  if (typeof page.waitForTimeout !== "function") throw new Error();
  const attempts = Math.max(1, Math.min(20, Math.ceil(timeoutMs / 250)));
  const intervalMs = Math.max(1, Math.floor(timeoutMs / attempts));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== null && matches(value)) return value;
    if (attempt + 1 < attempts) await page.waitForTimeout(intervalMs);
  }
  throw new Error();
}
/** @param {unknown} expectedRoute */
export function redactScreenshotPage(expectedRoute) {
  const query = document.querySelector('[data-discovery-search-form] input[name="query"]');
  const sensitive = [
    query !== null && "value" in query && typeof query.value === "string" ? query.value.trim() : "",
    ...[
      "[data-discovery-item-id] strong",
      "[data-selected-item-id] h2",
      "[data-library-source] h3",
      ".learning-card h2",
      ".review-card h2",
    ].flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((node) => (node.textContent || "").trim())),
  ].filter((value) => value.length > 0);
  const blocked = document.querySelector('[role="alert"], .discover-notice.error, [role="alertdialog"]') !== null;
  if (query !== null && "value" in query && typeof query.value === "string") query.value = "";
  document.querySelectorAll('[role="status"], [role="alert"], .discover-notice, .notice, .toast').forEach((node) => node.remove());
  document.querySelectorAll('[data-discovery-item-id], [data-selected-item-id], [data-library-source], .learning-card, .review-card, .feed-card').forEach((node) => node.remove());
  const bodyText = document.body.innerText;
  const leaksSensitiveValue = sensitive.some((value) => bodyText.includes(value));
  const route = location.hash.replace(/^#/, "") || "feed";
  return Object.freeze({ safe: route === expectedRoute && !blocked && !leaksSensitiveValue && !/[?&][^\s=]+=|access|authorization|cookie|client secret|\berror\b/i.test(bodyText), route });
}

/** @param {Record<string, unknown>} page @param {string} path @param {JourneyRoute} expectedRoute */
async function redactedScreenshot(page, path, expectedRoute) {
  if (typeof page.evaluate !== "function" || typeof page.screenshot !== "function") throw new Error();
  const metadata = await page.evaluate(redactScreenshotPage, expectedRoute);
  if (!record(metadata) || metadata.safe !== true || text(metadata.route) !== expectedRoute) throw new Error();
  await page.screenshot({ path });
}

/** @param {Record<string, unknown>} page @param {JourneyRoute} route @param {number} timeoutMs */
async function waitForRenderedRoute(page, route, timeoutMs) {
  await waitForValue(page, timeoutMs, () => attributeAt(page, `.primary-nav [data-view="${route}"]`, "aria-current"), (value) => value === "page");
}

/** @param {Record<string, unknown>} page @param {JourneyRoute} route @param {number} timeoutMs */
async function navigateToRoute(page, route, timeoutMs) {
  await action(locator(page, `.primary-nav [data-view="${route}"]`), "click");
  await waitForRenderedRoute(page, route, timeoutMs);
}

/** @param {Record<string, unknown>} page @param {JourneyRoute} route @param {number} timeoutMs @param {boolean} [allowPendingNavigation] */
async function ensureRoute(page, route, timeoutMs, allowPendingNavigation = false) {
  let current = await attributeAt(page, `.primary-nav [data-view="${route}"]`, "aria-current");
  if (current !== "page" && allowPendingNavigation) {
    const graceMs = Math.min(1_000, timeoutMs);
    const attempts = Math.max(1, Math.min(4, Math.ceil(graceMs / 250)));
    for (let attempt = 0; attempt < attempts && current !== "page"; attempt += 1) {
      await action(page, "waitForTimeout", Math.max(1, Math.floor(graceMs / attempts)));
      current = await attributeAt(page, `.primary-nav [data-view="${route}"]`, "aria-current");
    }
  }
  if (current !== "page") await navigateToRoute(page, route, timeoutMs);
  else await waitForRenderedRoute(page, route, timeoutMs);
}

/** @param {Record<string, unknown>} page @param {number} timeoutMs */
async function waitForDiscoverySearchBound(page, timeoutMs) {
  const selectors = [
    '[data-discovery-search-form] button[type="submit"]',
    '[data-discovery-search-form] input[name="provider"][value="web"]',
    '[data-discovery-search-form] input[name="provider"][value="podcasts"]',
    '[data-discovery-search-form] select[name="limit"]',
  ];
  let consecutiveReadyObservations = 0;
  await waitForValue(
    page,
    timeoutMs,
    async () => {
      const bound = await attributeAt(page, "[data-discovery-search-form]", "data-discovery-search-bound");
      const enabled = await Promise.all(selectors.map((selector) => enabledAt(page, selector)));
      const ready = bound === "true" && enabled.every((value) => value === true);
      consecutiveReadyObservations = ready ? consecutiveReadyObservations + 1 : 0;
      return consecutiveReadyObservations;
    },
    (value) => value >= 2,
  );
}

/** @param {Record<string, unknown>} page @param {string} itemId @param {number} timeoutMs */
async function openDiscoveryDetail(page, itemId, timeoutMs) {
  await action(locator(page, `[data-discovery-item-id="${itemId}"]`), "click");
  await waitForValue(page, timeoutMs, () => attributeAt(page, "[data-selected-item-id]", "data-selected-item-id"), (selectedId) => selectedId === itemId);
}

/** @param {Record<string, unknown>} page @param {number} timeoutMs @param {(ids: string[]) => boolean} [matches] */
async function waitForDiscoveryList(page, timeoutMs, matches = (ids) => ids.length > 0) {
  return waitForValue(page, timeoutMs, () => resultIds(page), matches);
}

/** @param {Record<string, unknown>} page @param {number} timeoutMs @returns {Promise<{readonly ok:true}|{readonly ok:false,readonly error:"missing"|"non-success"}>} */
async function submitDiscoverySearch(page, timeoutMs) {
  if (typeof page.waitForResponse !== "function") throw new Error();
  const responsePromise = page.waitForResponse((/** @type {unknown} */ response) => {
    try { const url = new URL(text(eventValue(response, "url"))); return url.origin === `https://${APPROVED_BROWSER_ACCEPTANCE_HOST}` && url.pathname === "/api/discovery/search"; } catch { return false; }
  }, { timeout: timeoutMs });
  await action(locator(page, '[data-discovery-search-form] button[type="submit"]'), "click");
  /** @type {unknown} */ let response;
  try { response = await responsePromise; } catch { return { ok: false, error: "missing" }; }
  const status = eventValue(response, "status");
  if (!Number.isInteger(status) || /** @type {number} */ (status) < 200 || /** @type {number} */ (status) >= 300) return { ok: false, error: "non-success" };
  return { ok: true };
}

/** @param {Record<string, unknown>} page @param {string} itemId @param {number} timeoutMs @returns {Promise<{readonly ok:true,readonly value:string}|{readonly ok:false,readonly error:"missing"|"conflict"|"rejected"|"non-success"|"invalid"}>} */
async function submitSourceApproval(page, itemId, timeoutMs) {
  if (typeof page.waitForResponse !== "function") throw new Error();
  const responsePromise = page.waitForResponse((/** @type {unknown} */ response) => {
    try { const url = new URL(text(eventValue(response, "url"))); return url.origin === `https://${APPROVED_BROWSER_ACCEPTANCE_HOST}` && url.pathname === "/api/source-library/approve"; } catch { return false; }
  }, { timeout: timeoutMs });
  await action(locator(page, `[data-discovery-approve="${itemId}"] button[type="submit"]`), "click");
  /** @type {unknown} */ let response;
  try { response = await responsePromise; } catch { return { ok: false, error: "missing" }; }
  const status = eventValue(response, "status");
  if (status === 409) {
    let conflictBody;
    try { conflictBody = await eventValue(response, "json"); } catch { return { ok: false, error: "non-success" }; }
    return record(conflictBody) && conflictBody.error === "SourceStateConflict"
      ? { ok: false, error: "conflict" }
      : { ok: false, error: "rejected" };
  }
  if (!Number.isInteger(status) || /** @type {number} */ (status) < 200 || /** @type {number} */ (status) >= 300) return { ok: false, error: "non-success" };
  const body = await eventValue(response, "json");
  const result = record(body) ? body.result : null;
  const source = record(result) ? result.source : null;
  const sourceId = record(source) ? source.id : null;
  return typeof sourceId === "string" && sourceId.trim() !== "" ? { ok: true, value: sourceId } : { ok: false, error: "invalid" };
}

/** @param {Record<string, unknown>} page */
async function completedHistorySnapshot(page) {
  const progress = locator(page, ".review-route .recall-progress progress");
  const value = await action(progress, "getAttribute", "value");
  const max = await action(progress, "getAttribute", "max");
  const daily = await textAt(page, ".review-route .recall-metric:nth-of-type(1)");
  const sevenDay = await textAt(page, ".review-route .recall-metric:nth-of-type(2)");
  if (!nonblank(value) || !nonblank(max) || daily === null || sevenDay === null) throw new Error();
  return Object.freeze({ progressValue: value, progressMax: max, daily, sevenDay });
}

/** @param {{ readonly progressValue: string, readonly progressMax: string, readonly daily: string, readonly sevenDay: string }} left @param {{ readonly progressValue: string, readonly progressMax: string, readonly daily: string, readonly sevenDay: string }} right */
function sameCompletedHistory(left, right) {
  return left.progressValue === right.progressValue && left.progressMax === right.progressMax && left.daily === right.daily && left.sevenDay === right.sevenDay;
}

/**
 * Runs only against the hosted DOM contract. It keeps result titles and source
 * labels inside the page process; failures return fixed categories only.
 * @param {Record<string, unknown>} page @param {string} artifactsRoot @param {number} actionTimeoutMs
 * @returns {Promise<{ readonly ok: true } | { readonly ok: false, readonly error: BrowserAcceptanceFailure }>}
 */
async function hostedJourney(page, artifactsRoot, actionTimeoutMs) {
  /** @type {string | null} */ let createdSourceId = null;
  /** @type {string[] | null} */ let preApprovalIds = null;
  let approvalAttempted = false;
  let completed = false;
  let removalVerified = false;
  let primary = /** @type {{ id: string, title: string } | null} */ (null);
  /** @type {JourneyStage} */ let stage = "desktop-routes";
  try {
    for (const viewport of JOURNEY_VIEWPORTS) {
      stage = viewport.name === "desktop" ? "desktop-routes" : "mobile-routes";
      if (typeof page.setViewportSize !== "function") throw new Error();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const route of /** @type {const} */ (["feed", "discover", "review", "library"])) {
        await navigateToRoute(page, route, actionTimeoutMs);
        await redactedScreenshot(page, `${artifactsRoot}/${viewport.name}-${route}.png`, route);
      }
      // The top-level routes are checked at both breakpoints; mutation is one
      // desktop-only reversible operation, never duplicated for mobile.
      if (viewport.name !== "desktop") continue;
      stage = "primary-route";
      await navigateToRoute(page, "discover", actionTimeoutMs);
      await waitForDiscoverySearchBound(page, actionTimeoutMs);
      stage = "primary-query";
      await action(locator(page, '[data-discovery-search-form] input[name="query"]'), "fill", "music cognition");
      stage = "primary-filter";
      await action(locator(page, "[data-discovery-search-form] .discover-filters summary"), "click");
      stage = "primary-providers";
      await action(locator(page, '[data-discovery-search-form] input[name="provider"][value="web"]'), "check");
      await action(locator(page, '[data-discovery-search-form] input[name="provider"][value="podcasts"]'), "check");
      await action(locator(page, '[data-discovery-search-form] input[name="provider"][value="youtube"]'), "uncheck");
      stage = "primary-limit";
      await action(locator(page, '[data-discovery-search-form] select[name="limit"]'), "selectOption", "10");
      stage = "primary-submit";
      const primarySubmission = await submitDiscoverySearch(page, actionTimeoutMs);
      if (!primarySubmission.ok) {
        stage = primarySubmission.error === "missing" ? "primary-response-missing" : "primary-response-non-success";
        throw new Error();
      }
      stage = "primary-results";
      const liveIds = await waitForDiscoveryList(page, actionTimeoutMs);
      const firstSelector = `[data-discovery-item-id="${liveIds[0]}"]`;
      const title = await textAt(page, `${firstSelector} strong`); if (title === null) throw new Error();
      primary = { id: liveIds[0], title };
      stage = "detail-roundtrip";
      await openDiscoveryDetail(page, primary.id, actionTimeoutMs);
      if (await attributeAt(page, "[data-selected-item-id]", "data-selected-item-id") !== primary.id || await textAt(page, "[data-selected-item-id] h2") !== primary.title) throw new Error();
      await navigateToRoute(page, "discover", actionTimeoutMs);
      await waitForDiscoveryList(page, actionTimeoutMs, (ids) => ids.join("|") === liveIds.join("|")); if (await inputValueAt(page, '[data-discovery-search-form] input[name="query"]') !== "music cognition" || await inputValueAt(page, '[data-discovery-search-form] select[name="limit"]') !== "10" || await checkedAt(page, '[data-discovery-search-form] input[value="web"]') !== true || await checkedAt(page, '[data-discovery-search-form] input[value="podcasts"]') !== true || await checkedAt(page, '[data-discovery-search-form] input[value="youtube"]') !== false) throw new Error();
      await waitForDiscoverySearchBound(page, actionTimeoutMs);
      await action(locator(page, "[data-discovery-search-form] .discover-filters summary"), "click");
      stage = "podcast-controls";
      await action(locator(page, '[data-discovery-search-form] input[name="provider"][value="web"]'), "uncheck");
      await action(locator(page, '[data-discovery-search-form] select[name="limit"]'), "selectOption", "20");
      stage = "podcast-submit";
      const podcastSubmission = await submitDiscoverySearch(page, actionTimeoutMs);
      if (!podcastSubmission.ok) {
        stage = podcastSubmission.error === "missing" ? "podcast-response-missing" : "podcast-response-non-success";
        throw new Error();
      }
      stage = "podcast-results";
      const currentIds = await waitForDiscoveryList(page, actionTimeoutMs);
      if (await inputValueAt(page, '[data-discovery-search-form] input[name="query"]') !== "music cognition" || await inputValueAt(page, '[data-discovery-search-form] select[name="limit"]') !== "20" || await checkedAt(page, '[data-discovery-search-form] input[value="web"]') !== false || await checkedAt(page, '[data-discovery-search-form] input[value="podcasts"]') !== true || await checkedAt(page, '[data-discovery-search-form] input[value="youtube"]') !== false) throw new Error();
      /** @type {string[]} */ const podcastIds = [];
      stage = "podcast-candidate";
      for (const candidateId of [...currentIds].reverse()) { await openDiscoveryDetail(page, candidateId, actionTimeoutMs); const approval = `[data-discovery-approve="${candidateId}"]`; if (await attributeAt(page, approval, "data-discovery-approve") === candidateId && await attributeAt(page, approval, "data-source-granularity") === "feed" && await attributeAt(page, approval, "data-source-capabilities") === "metadata") podcastIds.push(candidateId); await navigateToRoute(page, "discover", actionTimeoutMs); await waitForDiscoveryList(page, actionTimeoutMs, (ids) => ids.join("|") === currentIds.join("|")); }
      if (podcastIds.length === 0) throw new Error();
      stage = "approval-candidate-submit";
      await action(locator(page, "[data-discovery-search-form] .discover-filters summary"), "click");
      await action(locator(page, '[data-discovery-search-form] input[name="provider"][value="web"]'), "check");
      const approvalCandidateSubmission = await submitDiscoverySearch(page, actionTimeoutMs);
      if (!approvalCandidateSubmission.ok) {
        stage = approvalCandidateSubmission.error === "missing" ? "approval-candidate-response-missing" : "approval-candidate-response-non-success";
        throw new Error();
      }
      stage = "approval-candidate-results";
      const approvalCandidateIds = await waitForDiscoveryList(page, actionTimeoutMs);
      /** @type {string[]} */ const siteIds = [];
      stage = "approval-candidate";
      for (const candidateId of [...approvalCandidateIds].reverse()) { await openDiscoveryDetail(page, candidateId, actionTimeoutMs); const approval = `[data-discovery-approve="${candidateId}"]`; if (await attributeAt(page, approval, "data-discovery-approve") === candidateId && await attributeAt(page, approval, "data-source-granularity") === "site" && await attributeAt(page, approval, "data-source-capabilities") === "metadata,bounded-ingestion") siteIds.push(candidateId); await navigateToRoute(page, "discover", actionTimeoutMs); await waitForDiscoveryList(page, actionTimeoutMs, (ids) => ids.join("|") === approvalCandidateIds.join("|")); }
      if (siteIds.length === 0) throw new Error();
      stage = "baseline-history";
      await ensureRoute(page, "library", actionTimeoutMs, true);
      preApprovalIds = await libraryIds(page); if (preApprovalIds === null || preApprovalIds.length === 0) throw new Error();
      await navigateToRoute(page, "review", actionTimeoutMs);
      const completedHistory = await completedHistorySnapshot(page);
      await navigateToRoute(page, "discover", actionTimeoutMs);
      await waitForDiscoveryList(page, actionTimeoutMs, (ids) => ids.join("|") === approvalCandidateIds.join("|"));
      stage = "source-approval";
      let sourceApproved = false;
      for (const siteId of siteIds) {
        await openDiscoveryDetail(page, siteId, actionTimeoutMs);
        approvalAttempted = true;
        const submission = await submitSourceApproval(page, siteId, actionTimeoutMs);
        if (!submission.ok && submission.error === "conflict") {
          approvalAttempted = false;
          await navigateToRoute(page, "discover", actionTimeoutMs);
          await waitForDiscoveryList(page, actionTimeoutMs, (ids) => ids.join("|") === approvalCandidateIds.join("|"));
          continue;
        }
        if (!submission.ok) {
          if (submission.error === "rejected") approvalAttempted = false;
          stage = submission.error === "missing" ? "source-approval-response-missing" : submission.error === "invalid" ? "source-approval-response-invalid" : "source-approval-response-non-success";
          throw new Error();
        }
        createdSourceId = submission.value;
        sourceApproved = true;
        break;
      }
      if (!sourceApproved) { approvalAttempted = false; stage = "source-approval-exhausted"; throw new Error(); }
      await ensureRoute(page, "library", actionTimeoutMs);
      const beforeIds = preApprovalIds; const approvedSourceId = createdSourceId; if (beforeIds === null || approvedSourceId === null) throw new Error(); const approvedIds = await waitForValue(page, actionTimeoutMs, () => libraryIds(page), (ids) => ids.includes(approvedSourceId) && ids.filter((id) => !beforeIds.includes(id)).length === 1 && beforeIds.every((id) => ids.includes(id))); const additions = approvedIds.filter((id) => !beforeIds.includes(id)); if (additions.length !== 1 || additions[0] !== approvedSourceId || beforeIds.some((id) => !approvedIds.includes(id))) throw new Error();
      const sourceSelector = `[data-library-source="${createdSourceId}"]`;
      if (await textAt(page, `${sourceSelector} p:nth-of-type(3)`) !== "site · metadata, bounded-ingestion") throw new Error();
      stage = "history-preservation";
      await navigateToRoute(page, "review", actionTimeoutMs);
      if (!sameCompletedHistory(completedHistory, await completedHistorySnapshot(page))) throw new Error();
      await navigateToRoute(page, "library", actionTimeoutMs);
      stage = "source-removal";
      if (typeof page.once !== "function") throw new Error();
      page.once("dialog", (/** @type {unknown} */ dialog) => { if (record(dialog) && typeof dialog.accept === "function") void dialog.accept(); });
      await action(locator(page, `[data-library-disable="${createdSourceId}"]`), "click");
      const disabledId = createdSourceId; if (disabledId === null) throw new Error(); const remainingIds = await waitForValue(page, actionTimeoutMs, () => libraryIds(page), (ids) => !ids.includes(disabledId) && preApprovalIds !== null && preApprovalIds.every((id) => ids.includes(id))); if (remainingIds.includes(disabledId) || preApprovalIds.some((id) => !remainingIds.includes(id))) throw new Error();
      createdSourceId = null;
      removalVerified = true;
      await navigateToRoute(page, "review", actionTimeoutMs);
      if (!sameCompletedHistory(completedHistory, await completedHistorySnapshot(page))) throw new Error();
    }
    completed = true;
  } catch {
    return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceAssertionFailed", assertion: "journey", stage }) };
  } finally {
    if (!completed && !removalVerified && approvalAttempted && preApprovalIds !== null) {
      try {
        const beforeIds = preApprovalIds; if (beforeIds === null) throw new Error(); await ensureRoute(page, "library", actionTimeoutMs, true); if (createdSourceId === null) { const current = await waitForValue(page, actionTimeoutMs, () => libraryIds(page), (ids) => ids.filter((id) => !beforeIds.includes(id)).length === 1 && beforeIds.every((id) => ids.includes(id))); const additions = current.filter((id) => !beforeIds.includes(id)); if (additions.length !== 1) throw new Error(); createdSourceId = additions[0]; }
        if (typeof page.once !== "function") throw new Error();
        page.once("dialog", (/** @type {unknown} */ dialog) => { if (record(dialog) && typeof dialog.accept === "function") void dialog.accept(); });
        const disabledId = createdSourceId; if (disabledId === null) throw new Error(); await waitForValue(page, actionTimeoutMs, () => libraryIds(page), (ids) => ids.includes(disabledId) && beforeIds.every((id) => ids.includes(id))); await action(locator(page, `[data-library-disable="${disabledId}"]`), "click"); await waitForValue(page, actionTimeoutMs, () => libraryIds(page), (ids) => !ids.includes(disabledId) && beforeIds.every((id) => ids.includes(id)));
      } catch {
        return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceCleanupFailed", resource: "source", stage }) };
      }
    }
  }
  return { ok: true };
}

/** @param {unknown} environment @param {unknown} [overrides] @returns {ConfigResult} */
export function validateBrowserAcceptanceConfig(environment, overrides = {}) {
  if (!record(environment) || !record(overrides)) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "environment" }) };
  const requestedStorageStatePath = text(environment.BROWSER_ACCEPTANCE_STORAGE_STATE_PATH); if (requestedStorageStatePath.length === 0) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateMissing" }) };
  let target; try { target = new URL(text(environment.BROWSER_ACCEPTANCE_TARGET_URL)); } catch { return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "BROWSER_ACCEPTANCE_TARGET_URL" }) }; }
  if (target.protocol !== "https:" || target.host !== APPROVED_BROWSER_ACCEPTANCE_HOST || target.search || target.hash || target.username || target.password) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "BROWSER_ACCEPTANCE_TARGET_URL" }) };
  if (text(environment.BROWSER_ACCEPTANCE_CHROME_PATH) !== CHROME_PATH) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "BROWSER_ACCEPTANCE_CHROME_PATH" }) };
  const navigationTimeoutMs = Number(text(environment.BROWSER_ACCEPTANCE_NAVIGATION_TIMEOUT_MS)); const actionTimeoutMs = Number(text(environment.BROWSER_ACCEPTANCE_ACTION_TIMEOUT_MS));
  if (!Number.isInteger(navigationTimeoutMs) || navigationTimeoutMs <= 0 || navigationTimeoutMs > MAX_TIMEOUT_MS) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "BROWSER_ACCEPTANCE_NAVIGATION_TIMEOUT_MS" }) };
  if (!Number.isInteger(actionTimeoutMs) || actionTimeoutMs <= 0 || actionTimeoutMs > MAX_TIMEOUT_MS) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "BROWSER_ACCEPTANCE_ACTION_TIMEOUT_MS" }) };
  const projectRoot = text(overrides.projectRoot); if (!absolutePath(projectRoot) || normalizedAbsolutePath(projectRoot) !== projectRoot) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "projectRoot" }) };
  const storageStatePath = `${projectRoot}/.private/browser-acceptance/storage-state.json`;
  if (requestedStorageStatePath !== storageStatePath) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "BROWSER_ACCEPTANCE_STORAGE_STATE_PATH" }) };
  const logsRoot = `${projectRoot}/logs`; const resultsRoot = `${projectRoot}/test-results/browser-acceptance`;
  if (overrides.logsRoot !== undefined && text(overrides.logsRoot) !== logsRoot) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "logsRoot" }) };
  if (overrides.resultsRoot !== undefined && text(overrides.resultsRoot) !== resultsRoot) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "resultsRoot" }) };
  /** @type {readonly [string, string]} */ const artifactRoots = [logsRoot, resultsRoot];
  return { ok: true, value: Object.freeze({ targetUrl: target.toString().replace(/\/$/, ""), chromePath: CHROME_PATH, navigationTimeoutMs, actionTimeoutMs, storageStatePath, artifactRoots: Object.freeze(artifactRoots) }) };
}

/** @param {unknown} event @returns {RedactionResult} */
export function redactEvidence(event) {
  if (!record(event)) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceRedactionFailed", artifact: "evidence" }) };
  const status = event.status; const durationMs = event.durationMs; const failureKind = event.failureKind; const viewport = event.viewport; const workerVersion = text(event.workerVersion);
  if (text(event.url).length === 0 || !Number.isInteger(status) || typeof status !== "number" || status < 100 || status > 599 || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_TIMEOUT_MS || !["none", "network", "access", "assertion"].includes(text(failureKind)) || !["desktop", "mobile"].includes(text(viewport)) || !uuid(workerVersion)) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceRedactionFailed", artifact: "evidence" }) };
  return { ok: true, value: Object.freeze({ routeCategory: category(text(event.url)), status, durationMs, failureKind: /** @type {"none" | "network" | "access" | "assertion"} */ (failureKind), viewport: /** @type {"desktop" | "mobile"} */ (viewport), workerVersion }) };
}

/** @param {unknown} fileSystem @param {unknown} roots @param {unknown} now @param {unknown} retentionDays @returns {Promise<CleanupResult>} */
export async function removeExpiredArtifacts(fileSystem, roots, now, retentionDays) {
  if (!record(fileSystem) || typeof fileSystem.listFiles !== "function" || typeof fileSystem.remove !== "function" || !Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !absolutePath(root)) || typeof now !== "function" || typeof retentionDays !== "number" || !Number.isInteger(retentionDays) || retentionDays < 0) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceArtifactCleanupFailed", artifact: "retention" }) };
  try { const instant = now(); if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error(); const threshold = instant.getTime() - retentionDays * 86_400_000; /** @type {string[]} */ const expiredPaths = []; for (const root of roots) { const canonicalRoot = normalizedAbsolutePath(root); if (canonicalRoot === null || canonicalRoot !== root) throw new Error(); const entries = await fileSystem.listFiles(root); if (!Array.isArray(entries)) throw new Error(); for (const entry of entries) { if (!record(entry) || typeof entry.path !== "string" || typeof entry.modifiedAt !== "string") throw new Error(); const canonicalEntry = normalizedAbsolutePath(entry.path); if (canonicalEntry === null || canonicalEntry !== entry.path || !canonicalEntry.startsWith(`${canonicalRoot}/`)) throw new Error(); const modified = new Date(entry.modifiedAt).getTime(); if (!Number.isFinite(modified)) throw new Error(); if (modified < threshold) expiredPaths.push(canonicalEntry); } } for (const path of expiredPaths) await fileSystem.remove(path); } catch { return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceArtifactCleanupFailed", artifact: "retention" }) }; }
  return { ok: true };
}

/** @param {unknown} config @param {unknown} dependencies @returns {Promise<BrowserRunResult>} */
export async function runBrowserAcceptance(config, dependencies) {
  if (!record(config)) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "config" }) };
  if (!record(dependencies) || typeof dependencies.launch !== "function" || typeof dependencies.loadSessionState !== "function" || !record(dependencies.fileSystem) || typeof dependencies.now !== "function" || typeof dependencies.createId !== "function" || typeof dependencies.log !== "function") return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "dependencies" }) };
  const roots = Array.isArray(config.artifactRoots) ? config.artifactRoots : [];
  const checked = validateBrowserAcceptanceConfig({ BROWSER_ACCEPTANCE_TARGET_URL: config.targetUrl, BROWSER_ACCEPTANCE_CHROME_PATH: config.chromePath, BROWSER_ACCEPTANCE_NAVIGATION_TIMEOUT_MS: String(config.navigationTimeoutMs), BROWSER_ACCEPTANCE_ACTION_TIMEOUT_MS: String(config.actionTimeoutMs), BROWSER_ACCEPTANCE_STORAGE_STATE_PATH: config.storageStatePath }, { projectRoot: text(roots[0]).replace(/\/logs$/, ""), logsRoot: text(roots[0]), resultsRoot: text(roots[1]) });
  if (!checked.ok) return checked;
  const retention = await removeExpiredArtifacts(dependencies.fileSystem, checked.value.artifactRoots, dependencies.now, 30); if (!retention.ok) return retention;
  let sessionStateResult; try { sessionStateResult = await dependencies.loadSessionState(checked.value.storageStatePath); } catch { return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateUnreadable" }) }; }
  if (!record(sessionStateResult) || typeof sessionStateResult.ok !== "boolean") return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateMalformed" }) };
  if (!sessionStateResult.ok) { const kind = record(sessionStateResult.error) ? text(sessionStateResult.error.kind) : ""; if (kind === "BrowserAcceptanceSessionStateMissing" || kind === "BrowserAcceptanceSessionStateUnreadable" || kind === "BrowserAcceptanceSessionStateMalformed") return { ok: false, error: Object.freeze({ kind }) }; return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateMalformed" }) }; }
  const sessionState = sessionStateResult.value; if (!record(sessionState) || !Array.isArray(sessionState.cookies) || !Array.isArray(sessionState.origins)) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateMalformed" }) };
  let runId; try { runId = dependencies.createId(); } catch { return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "runId" }) }; }
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(runId)) return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "runId" }) };
  /** @type {BrowserAcceptanceFailure | null} */ let outcome = null;
  /** @type {RedactedEvidence[]} */ const evidence = [];
  /** @type {{ routeCategory: "module" | "api", status: number, durationMs: number }[]} */ const observations = [];
  let runtimeConsoleError = false;
  /** @type {Record<string, unknown> | null} */ let browser = null;
  /** @type {Record<string, unknown> | null} */ let context = null;
  /** @type {Record<string, unknown> | null} */ let page = null;
  try {
    try { const launched = await dependencies.launch({ executablePath: checked.value.chromePath }); if (!record(launched) || typeof launched.newContext !== "function") outcome = Object.freeze({ kind: "BrowserAcceptanceChromeLaunchFailed" }); else browser = launched; } catch { outcome = Object.freeze({ kind: "BrowserAcceptanceChromeLaunchFailed" }); }
    if (browser !== null && outcome === null) try { if (typeof browser.newContext !== "function") throw new Error(); context = await browser.newContext({ serviceWorkers: "allow", reducedMotion: "reduce", storageState: sessionState }); if (!record(context)) throw new Error(); } catch { outcome = Object.freeze({ kind: "BrowserAcceptanceBrowserSetupFailed", stage: "context" }); }
    if (context !== null && outcome === null) try { if (typeof context.newPage !== "function") throw new Error(); page = await context.newPage(); if (!record(page)) throw new Error(); } catch { outcome = Object.freeze({ kind: "BrowserAcceptanceBrowserSetupFailed", stage: "page" }); }
    if (page !== null && outcome === null) {
      try { if (typeof page.on !== "function") throw new Error(); page.on("console", (/** @type {unknown} */ event) => { const severity = text(eventValue(event, "type")); const message = text(eventValue(event, "text")); if (expectedSourceApprovalConflictConsole(event, message)) return; if (severity === "error" || severity === "assert" || (severity === "" && nonblank(eventValue(event, "category")))) runtimeConsoleError = true; }); page.on("pageerror", () => { runtimeConsoleError = true; }); page.on("requestfailed", (/** @type {unknown} */ event) => { if (outcome !== null) return; const url = text(eventValue(event, "url")); try { const route = category(url); if (new URL(url).origin === new URL(checked.value.targetUrl).origin && (route === "module" || route === "api")) outcome = Object.freeze({ kind: "BrowserAcceptanceSameOriginResponseFailed", category: route, status: 0 }); } catch {} }); page.on("response", (/** @type {unknown} */ event) => { if (outcome !== null) return; const status = eventValue(event, "status"); const url = text(eventValue(event, "url")); let origin = ""; try { origin = new URL(url).origin; } catch { return; } const route = category(url); if (expectedSourceApprovalConflict(url, status)) return; const durationMs = responseDuration(event); if (origin === new URL(checked.value.targetUrl).origin && (route === "module" || route === "api") && typeof status === "number") { if (durationMs === null) { outcome = Object.freeze({ kind: "BrowserAcceptanceRedactionFailed", artifact: "evidence" }); return; } observations.push(Object.freeze({ routeCategory: route, status, durationMs })); if (!Number.isInteger(status) || status < 200 || status >= 300) outcome = Object.freeze({ kind: "BrowserAcceptanceSameOriginResponseFailed", category: route, status }); } }); } catch { outcome = Object.freeze({ kind: "BrowserAcceptanceConsoleError", category: "listener" }); }
      let response; try { if (typeof page.goto !== "function") throw new Error(); response = await page.goto(checked.value.targetUrl, { timeout: checked.value.navigationTimeoutMs }); } catch (error) { outcome = timeout(error) ? Object.freeze({ kind: "BrowserAcceptanceNavigationTimedOut", route: "document" }) : Object.freeze({ kind: "BrowserAcceptanceNetworkUnavailable" }); }
      const documentStatus = eventValue(response, "status");
      if (outcome === null && typeof documentStatus === "number") { if (documentStatus >= 300 && documentStatus < 400) outcome = Object.freeze({ kind: "BrowserAcceptanceAccessRedirected" }); else if (documentStatus === 401 || documentStatus === 403) outcome = Object.freeze({ kind: "BrowserAcceptanceAccessRejected", status: documentStatus }); }
      if (outcome === null && typeof page.locator === "function" && !sameFinalUrl(checked.value.targetUrl, text(eventValue(response, "url")))) outcome = Object.freeze({ kind: "BrowserAcceptanceAccessRedirected" });
      if (outcome === null && runtimeConsoleError) outcome = Object.freeze({ kind: "BrowserAcceptanceConsoleError", category: "runtime" });
      if (outcome === null) try { const hosted = typeof page.locator === "function"; const workerVersion = hosted ? await workerVersionHeader(response) : ""; if (hosted && !sameFinalUrl(checked.value.targetUrl, text(eventValue(response, "url")))) outcome = Object.freeze({ kind: "BrowserAcceptanceAccessRedirected" }); else if (hosted && !uuid(workerVersion)) outcome = Object.freeze({ kind: "BrowserAcceptanceWorkerVersionUnavailable" }); else if (hosted) { if (typeof dependencies.fileSystem.mkdir !== "function") throw new Error(); await dependencies.fileSystem.mkdir(`${checked.value.artifactRoots[1]}/${runId}`); const journey = await hostedJourney(page, `${checked.value.artifactRoots[1]}/${runId}`, checked.value.actionTimeoutMs); if (!journey.ok) outcome = journey.error; } else { if (typeof page.evaluate !== "function") throw new Error(); const evaluated = await page.evaluate(); const legacyVersion = record(evaluated) ? text(evaluated.workerVersion) : ""; if (!uuid(legacyVersion)) outcome = Object.freeze({ kind: "BrowserAcceptanceWorkerVersionUnavailable" }); else if (!record(evaluated) || !Array.isArray(evaluated.assertions)) outcome = Object.freeze({ kind: "BrowserAcceptanceAssertionFailed", assertion: "evaluation" }); else { const failed = evaluated.assertions.find((/** @type {unknown} */ entry) => record(entry) && entry.passed === false); if (failed !== undefined && record(failed)) outcome = Object.freeze({ kind: "BrowserAcceptanceAssertionFailed", assertion: "journey" }); } if (outcome === null) { const item = redactEvidence({ url: checked.value.targetUrl, status: 200, durationMs: 0, failureKind: "none", viewport: "desktop", workerVersion: legacyVersion }); if (!item.ok) outcome = item.error; else evidence.push(item.value); } } if (outcome === null && runtimeConsoleError) outcome = Object.freeze({ kind: "BrowserAcceptanceConsoleError", category: "runtime" }); if (outcome === null && hosted) { const item = redactEvidence({ url: checked.value.targetUrl, status: 200, durationMs: 0, failureKind: "none", viewport: "desktop", workerVersion }); if (!item.ok) outcome = item.error; else evidence.push(item.value); } if (outcome === null) for (const observation of observations) evidence.push(Object.freeze({ ...observation, failureKind: "none", viewport: "desktop", workerVersion: evidence[0].workerVersion })); } catch { outcome = Object.freeze({ kind: "BrowserAcceptanceAssertionFailed", assertion: "evaluation" }); }
    }
    if (outcome === null && page !== null) try { if (typeof dependencies.fileSystem.mkdir !== "function" || typeof dependencies.fileSystem.writeTextFile !== "function" || typeof page.screenshot !== "function") throw new Error(); if (typeof page.locator !== "function") { await dependencies.fileSystem.mkdir(`${checked.value.artifactRoots[1]}/${runId}`); await page.screenshot({ path: `${checked.value.artifactRoots[1]}/${runId}/desktop-feed.png` }); } await dependencies.fileSystem.writeTextFile(`${checked.value.artifactRoots[0]}/browser-acceptance-${runId}.log`, `${evidence.map((entry) => JSON.stringify(entry)).join("\n")}\n`); evidence.forEach((entry) => /** @type {(entry: RedactedEvidence) => void} */ (dependencies.log)(entry)); } catch { outcome = Object.freeze({ kind: "BrowserAcceptanceArtifactWriteFailed", artifact: "evidence" }); };
  } finally {
    for (const [resource, value] of [["page", page], ["context", context], ["browser", browser]]) try { if (record(value) && typeof value.close === "function") await value.close(); } catch { if (outcome === null || outcome.kind !== "BrowserAcceptanceCleanupFailed") outcome = Object.freeze({ kind: "BrowserAcceptanceCleanupFailed", resource }); }
  }
  if (outcome !== null) return { ok: false, error: outcome }; return { ok: true, value: Object.freeze({ runId, workerVersion: evidence[0].workerVersion, evidence: Object.freeze(evidence) }) };
}
