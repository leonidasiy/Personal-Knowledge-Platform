// @ts-check

import { isForbiddenAddress } from "./knowledge-workflow-network.js";

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/**
 * @typedef {{
 *   readonly limits: (binding: unknown) => Promise<unknown>,
 *   readonly launch: (binding: unknown) => Promise<unknown>
 * }} BrowserLauncher
 */

/**
 * @typedef {{
 *   readonly activeSessions: readonly { readonly id: string }[],
 *   readonly allowedBrowserAcquisitions: number,
 *   readonly maxConcurrentSessions: number,
 *   readonly timeUntilNextAllowedBrowserAcquisition: number
 * }} BrowserLimits
 */

/**
 * @typedef {{
 *   readonly createBrowserContext: () => Promise<unknown>,
 *   readonly close: () => Promise<void>
 * }} BrowserSession
 */

/**
 * @typedef {{
 *   readonly newPage: () => Promise<unknown>,
 *   readonly close: () => Promise<void>
 * }} BrowserContext
 */

/**
 * @typedef {{
 *   readonly setUserAgent: (userAgent: string) => Promise<void>,
 *   readonly setExtraHTTPHeaders: (headers: Readonly<Record<string, string>>) => Promise<void>,
 *   readonly setRequestInterception?: (enabled: boolean) => Promise<void>,
 *   readonly on?: (event: "request", listener: (value: unknown) => void | Promise<void>) => void,
 *   readonly goto: (url: string, options: { readonly waitUntil: "domcontentloaded", readonly timeout: number }) => Promise<unknown>,
 *   readonly waitForNetworkIdle?: (options: { readonly idleTime: number, readonly timeout: number }) => Promise<void>,
 *   readonly content: () => Promise<string>,
 *   readonly evaluate: {
 *     (callback: (maximumTextCharacters: number, maximumLinks: number) => unknown, maximumTextCharacters: number, maximumLinks: number): Promise<unknown>,
 *     (callback: (robotsTarget: string, maximumBytes: number) => unknown, robotsTarget: string, maximumBytes: number): Promise<unknown>
 *   },
 *   readonly screenshot?: (options: { readonly type: "png" }) => Promise<unknown>,
 *   readonly close: () => Promise<void>
 * }} BrowserPage
 */

/** @typedef {(command: { readonly url: string, readonly timeout: number }) => Promise<unknown>} BrowserRequestCapability */

/**
 * @typedef {{
 *   readonly url: string,
 *   readonly responseUrl: string,
 *   readonly contentType: string,
 *   readonly bytes: Uint8Array,
 *   readonly redirects: number,
 *   readonly renderedTitle: string,
 *   readonly renderedText: string,
 *   readonly visibleLinks: readonly string[]
 * }} BrowserPageRead
 */

/** @typedef {{ readonly status: number, readonly headers: Readonly<Record<string, string>>, readonly bytes: Uint8Array }} BrowserRobotsRead */
/** @typedef {{ readonly url: string, readonly mediaType: "image/png", readonly bytes: Uint8Array }} BrowserScreenshot */

/**
 * @typedef {{
 *   readonly kind:
 *     "KnowledgeBrowserConfigurationInvalid" |
 *     "KnowledgeBrowserCapacityUnavailable" |
 *     "KnowledgeBrowserLaunchThrottled" |
 *     "KnowledgeBrowserConcurrencyExceeded" |
 *     "KnowledgeBrowserLaunchFailed" |
 *     "KnowledgeBrowserSessionCloseFailed" |
 *     "KnowledgeBrowserNavigationRejected" |
 *     "KnowledgeBrowserNetworkRejected" |
 *     "KnowledgeBrowserNavigationFailed" |
 *     "KnowledgeBrowserTimedOut" |
 *     "KnowledgeBrowserResponseInvalid" |
 *     "KnowledgeBrowserRenderedProjectionFailed" |
 *     "KnowledgePageBotAccessDenied" |
 *     "KnowledgePageRateLimited" |
 *     "KnowledgePageAuthenticationRequired" |
 *     "KnowledgePagePaywallDetected" |
 *     "KnowledgePageFetchFailed" |
 *     "KnowledgePageTooLarge" |
 *     "KnowledgePageTypeUnsupported" |
 *     "KnowledgeRobotsFetchUnavailable" |
 *     "KnowledgeRobotsRequestCapabilityUnavailable" |
 *     "KnowledgeRobotsRedirectRejected" |
 *     "KnowledgeRobotsTooLarge" |
 *     "KnowledgeRobotsResponseInvalid" |
 *     "WorkflowBrowserScreenshotUnavailable" |
 *     "KnowledgeScreenshotTooLarge" |
 *     "KnowledgeScreenshotFailed" |
 *     "KnowledgeBrowserPacingFailed" |
 *     "KnowledgeBrowserClosed" |
 *     "KnowledgeBrowserOperationConflict",
 *   readonly diagnosticToken?: string
 * }} BrowserFailure
 */

const freeze = Object.freeze;
const encoder = new TextEncoder();

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value @returns {value is number} */
function nonNegativeInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
/** @param {unknown} value @returns {boolean} */
function objectLike(value) { return (typeof value === "object" || typeof value === "function") && value !== null; }
/** @param {unknown} value @returns {value is { readonly close: () => Promise<void> }} */
function closeable(value) {
  return objectLike(value) && typeof /** @type {{ readonly close?: unknown }} */ (value).close === "function";
}
/** @param {unknown} value @returns {boolean} */
function publicHttps(value) {
  if (!text(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.username === "" && url.password === "";
}
/** @param {unknown} value @returns {value is Readonly<Record<string, string>>} */
function validHeaders(value) {
  return record(value) && Object.entries(value).every(([key, header]) => text(key) && typeof header === "string" && header.trim() !== "");
}

/** @param {unknown} error @returns {BrowserFailure} */
function classifyNavigationFailure(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("timeout") || message.includes("timed out")
    ? { kind: "KnowledgeBrowserTimedOut", diagnosticToken: "navigation-timeout" }
    : { kind: "KnowledgeBrowserNavigationFailed", diagnosticToken: "navigation-failed" };
}

/** @param {unknown} value @returns {value is BrowserLimits} */
function validLimits(value) {
  return record(value) && Array.isArray(value.activeSessions) && value.activeSessions.every((entry) => record(entry) && text(entry.id)) &&
    nonNegativeInteger(value.allowedBrowserAcquisitions) && positiveInteger(value.maxConcurrentSessions) &&
    nonNegativeInteger(value.timeUntilNextAllowedBrowserAcquisition);
}

/** @param {unknown} value @returns {value is BrowserSession} */
function validSession(value) { return record(value) && typeof value.createBrowserContext === "function" && typeof value.close === "function"; }
/** @param {unknown} value @returns {value is BrowserContext} */
function validContext(value) { return record(value) && typeof value.newPage === "function" && typeof value.close === "function"; }
/** @param {unknown} value @returns {value is BrowserPage} */
function validPage(value) {
  return record(value) && typeof value.setUserAgent === "function" && typeof value.setExtraHTTPHeaders === "function" &&
    typeof value.goto === "function" && typeof value.content === "function" &&
    typeof value.evaluate === "function" && typeof value.close === "function";
}

/** @param {unknown} response @returns {number | null} */
function responseStatus(response) {
  if (!record(response) || typeof response.status !== "function") return null;
  const status = response.status();
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

/** @param {unknown} response @returns {string | null} */
function responseUrl(response) {
  if (!record(response) || typeof response.url !== "function") return null;
  const value = response.url();
  return text(value) ? value : null;
}

/** @param {unknown} response @returns {Readonly<Record<string, string>> | null} */
function responseHeaders(response) {
  if (!record(response) || typeof response.headers !== "function") return null;
  const value = response.headers();
  if (!record(value)) return null;
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [key, header] of Object.entries(value)) if (typeof header === "string") headers[key.toLowerCase()] = header;
  return freeze(headers);
}

/** @param {unknown} response @returns {readonly unknown[]} */
function redirectChain(response) {
  if (!record(response) || typeof response.request !== "function") return [];
  const request = response.request();
  if (!record(request) || typeof request.redirectChain !== "function") return [];
  const chain = request.redirectChain();
  return Array.isArray(chain) ? chain : [];
}

/** @param {Readonly<Record<string, string>>} headers @param {number} nowMs @returns {number | null} */
function retryAfterMilliseconds(headers, nowMs) {
  const value = headers["retry-after"]?.trim();
  if (value === undefined || value === "") return null;
  if (/^\d+$/u.test(value)) return Number(value) * 1_000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed - nowMs) : null;
}

/** @param {BrowserPageRead} value @returns {BrowserPageRead} */
function clonePageRead(value) {
  return freeze({ ...value, bytes: new Uint8Array(value.bytes), visibleLinks: freeze([...value.visibleLinks]) });
}

/** @param {BrowserRobotsRead} value @returns {BrowserRobotsRead} */
function cloneRobotsRead(value) {
  return freeze({ ...value, headers: freeze({ ...value.headers }), bytes: new Uint8Array(value.bytes) });
}

/** @param {URL} root @param {URL} candidate @returns {boolean} */
function withinSourcePath(root, candidate) {
  if (root.pathname === "/") return true;
  const rootPath = root.pathname.endsWith("/") ? root.pathname.slice(0, -1) : root.pathname;
  const candidatePath = candidate.pathname.endsWith("/") && candidate.pathname !== "/" ? candidate.pathname.slice(0, -1) : candidate.pathname;
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

/**
 * Browser acquisition for the knowledge workflow. The browser identity stays
 * stable; source boundaries, robots, DNS, response status, and fixed pacing
 * are the controls used instead of evasion techniques.
 *
 * @param {{
 *   readonly launcher: BrowserLauncher,
 *   readonly binding: unknown,
 *   readonly resolveAddresses: (hostname: string) => Promise<Result<readonly string[], { readonly kind: string }>>,
 *   readonly nowMs: () => number,
 *   readonly browserRequest?: unknown,
 *   readonly userAgent: string,
 *   readonly extraHTTPHeaders: Readonly<Record<string, string>>,
   *   readonly logger: (entry: { readonly event: string, readonly failureKind?: string, readonly diagnosticToken?: string, readonly httpStatus?: number }) => void,
 *   readonly sleep?: (milliseconds: number) => Promise<void>,
 *   readonly navigationTimeoutMilliseconds?: number,
 *   readonly maximumHtmlBytes?: number,
 *   readonly maximumRobotsBytes?: number,
 *   readonly maximumScreenshotBytes?: number,
 *   readonly minimumInterRequestDelayMilliseconds?: number,
 *   readonly maximumRetryAfterMilliseconds?: number,
 *   readonly maximumRateLimitRetries?: number,
 *   readonly maximumCachedPages?: number,
 *   readonly maximumVisibleLinks?: number,
 *   readonly maximumRenderedTextCharacters?: number,
 *   readonly renderSettleMilliseconds?: number,
 *   readonly renderSettleTimeoutMilliseconds?: number
 * }} dependencies
 */
export function createKnowledgeWorkflowBrowser(dependencies) {
  const policy = {
    navigationTimeoutMilliseconds: dependencies?.navigationTimeoutMilliseconds ?? 15_000,
    maximumHtmlBytes: dependencies?.maximumHtmlBytes ?? 1_000_000,
    maximumRobotsBytes: dependencies?.maximumRobotsBytes ?? 256 * 1024,
    maximumScreenshotBytes: dependencies?.maximumScreenshotBytes ?? 2_000_000,
    minimumInterRequestDelayMilliseconds: dependencies?.minimumInterRequestDelayMilliseconds ?? 1_500,
    maximumRetryAfterMilliseconds: dependencies?.maximumRetryAfterMilliseconds ?? 30_000,
    maximumRateLimitRetries: dependencies?.maximumRateLimitRetries ?? 1,
    maximumCachedPages: dependencies?.maximumCachedPages ?? 4,
    maximumVisibleLinks: dependencies?.maximumVisibleLinks ?? 200,
    maximumRenderedTextCharacters: dependencies?.maximumRenderedTextCharacters ?? 250_000,
    renderSettleMilliseconds: dependencies?.renderSettleMilliseconds ?? 750,
    renderSettleTimeoutMilliseconds: dependencies?.renderSettleTimeoutMilliseconds ?? 5_000,
  };
  if (!dependencies || typeof dependencies.launcher?.limits !== "function" || typeof dependencies.launcher.launch !== "function" ||
    !objectLike(dependencies.binding) || typeof dependencies.resolveAddresses !== "function" || typeof dependencies.nowMs !== "function" ||
    !text(dependencies.userAgent) || !validHeaders(dependencies.extraHTTPHeaders) || typeof dependencies.logger !== "function" || !positiveInteger(policy.navigationTimeoutMilliseconds) ||
    !positiveInteger(policy.maximumHtmlBytes) || !positiveInteger(policy.maximumRobotsBytes) || !positiveInteger(policy.maximumScreenshotBytes) ||
    !nonNegativeInteger(policy.minimumInterRequestDelayMilliseconds) || !positiveInteger(policy.maximumRetryAfterMilliseconds) ||
    !nonNegativeInteger(policy.maximumRateLimitRetries) || !positiveInteger(policy.maximumCachedPages) ||
    !positiveInteger(policy.maximumVisibleLinks) || !positiveInteger(policy.maximumRenderedTextCharacters) ||
    !nonNegativeInteger(policy.renderSettleMilliseconds) || !positiveInteger(policy.renderSettleTimeoutMilliseconds) ||
    (dependencies.sleep !== undefined && typeof dependencies.sleep !== "function")) {
    throw new TypeError("Knowledge workflow browser dependencies are invalid.");
  }

  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  /** @type {BrowserSession | null} */
  let session = null;
  /** @type {BrowserContext | null} */
  let context = null;
  /** @type {BrowserPage | null} */
  let page = null;
  /** @type {number | null} */
  let lastNavigationAtMs = null;
  /** @type {string | null} */
  let currentUrl = null;
  /** @type {string | null} */
  let activeRootUrl = null;
  /** @type {BrowserFailure | null} */
  let interceptionFailure = null;
  /** @type {Map<string, BrowserPageRead>} */
  const pageCache = new Map();
  /** @type {Map<string, BrowserRobotsRead>} */
  const robotsCache = new Map();
  /** @type {Map<string, Result<readonly string[], { readonly kind: string }>>} */
  const addressCache = new Map();
  let closed = false;
  /** @type {string | null} */
  let activeOperation = null;

  /** @template T @param {string} operation @param {() => Promise<Result<T, BrowserFailure>>} action @returns {Promise<Result<T, BrowserFailure>>} */
  async function withOperation(operation, action) {
    if (closed) return { ok: false, error: { kind: "KnowledgeBrowserClosed" } };
    if (activeOperation !== null) return { ok: false, error: { kind: "KnowledgeBrowserOperationConflict" } };
    activeOperation = operation;
    try { return await action(); } finally { activeOperation = null; }
  }

  /** @returns {number} */
  function clock() {
    const value = dependencies.nowMs();
    if (!Number.isFinite(value) || value < 0) throw new TypeError("Knowledge workflow browser clock returned an invalid instant.");
    return value;
  }

  /** @param {unknown} error @returns {string} */
  function networkDiagnosticToken(error) {
    if (!record(error) || typeof error.kind !== "string") return "resolver-failed";
    if (error.kind === "WorkflowPrivateAddressRejected") return "forbidden-address";
    if (error.kind === "WorkflowDnsLookupFailed") return "dns-lookup-failed";
    return "resolver-failed";
  }

  /** @param {string} hostname @returns {Promise<Result<readonly string[], { readonly kind: string }>>} */
  async function resolveHost(hostname) {
    const cached = addressCache.get(hostname);
    if (cached !== undefined) return cached;
    let resolved;
    try {
      resolved = await dependencies.resolveAddresses(hostname);
    } catch (error) {
      dependencies.logger({ event: "knowledge-browser-network-failure", failureKind: "KnowledgeBrowserNetworkRejected", diagnosticToken: "resolver-threw" });
      return { ok: false, error: { kind: "WorkflowDnsLookupFailed" } };
    }
    if (resolved.ok) addressCache.set(hostname, resolved);
    return resolved;
  }

  /** @param {string} rootUrl @param {string} value @returns {Promise<Result<URL, BrowserFailure>>} */
  async function authorize(rootUrl, value) {
    if (!publicHttps(rootUrl) || !publicHttps(value)) return { ok: false, error: { kind: "KnowledgeBrowserNavigationRejected" } };
    const root = new URL(rootUrl);
    const target = new URL(value);
    if (target.origin !== root.origin || target.port !== "" || !withinSourcePath(root, target)) return { ok: false, error: { kind: "KnowledgeBrowserNavigationRejected" } };
    const resolved = await resolveHost(target.hostname);
    if (!resolved.ok) {
      dependencies.logger({ event: "knowledge-browser-network-failure", failureKind: "KnowledgeBrowserNetworkRejected", diagnosticToken: networkDiagnosticToken(resolved.error) });
      return { ok: false, error: { kind: "KnowledgeBrowserNetworkRejected" } };
    }
    if (resolved.value.length === 0) {
      dependencies.logger({ event: "knowledge-browser-network-failure", failureKind: "KnowledgeBrowserNetworkRejected", diagnosticToken: "no-public-address" });
      return { ok: false, error: { kind: "KnowledgeBrowserNetworkRejected" } };
    }
    if (resolved.value.some((address) => isForbiddenAddress(address))) {
      dependencies.logger({ event: "knowledge-browser-network-failure", failureKind: "KnowledgeBrowserNetworkRejected", diagnosticToken: "forbidden-address" });
      return { ok: false, error: { kind: "KnowledgeBrowserNetworkRejected" } };
    }
    return { ok: true, value: target };
  }

  /** @param {unknown} request @returns {Promise<void>} */
  async function handleRequest(request) {
    if (!record(request) || typeof request.url !== "function" || typeof request.resourceType !== "function" ||
      typeof request.isNavigationRequest !== "function" || typeof request.abort !== "function" || typeof request.continue !== "function") {
      interceptionFailure = { kind: "KnowledgeBrowserResponseInvalid" };
      return;
    }
    const url = request.url();
    const resourceType = request.resourceType();
    const navigation = request.isNavigationRequest();
    try {
      if (["image", "media", "font", "stylesheet"].includes(resourceType)) {
        await request.abort("blockedbyclient");
        return;
      }
      if (url.startsWith("data:") || url === "about:blank") {
        await request.continue();
        return;
      }
      if (!publicHttps(url)) {
        if (navigation) interceptionFailure = { kind: "KnowledgeBrowserNavigationRejected" };
        await request.abort("blockedbyclient");
        return;
      }
      const root = activeRootUrl === null ? null : new URL(activeRootUrl);
      if (root === null) {
        interceptionFailure = { kind: "KnowledgeBrowserNavigationRejected" };
        await request.abort("blockedbyclient");
        return;
      }
      if (new URL(url).origin !== root.origin) {
        await request.abort("blockedbyclient");
        return;
      }
      if (navigation) {
        const authorized = await authorize(root.href, url);
        if (!authorized.ok) {
          interceptionFailure = authorized.error;
          await request.abort("blockedbyclient");
          return;
        }
      }
      await request.continue();
    } catch (error) {
      if (navigation) interceptionFailure = { kind: "KnowledgeBrowserNavigationFailed" };
    }
  }

  /** @returns {Promise<Result<BrowserPage, BrowserFailure>>} */
  async function ensurePage() {
    if (page !== null) return { ok: true, value: page };
    dependencies.logger({ event: "knowledge-browser-session-entry" });
    let limits;
    try { limits = await dependencies.launcher.limits(dependencies.binding); } catch (error) {
      dependencies.logger({ event: "knowledge-browser-session-failure", failureKind: "KnowledgeBrowserCapacityUnavailable" });
      return { ok: false, error: { kind: "KnowledgeBrowserCapacityUnavailable" } };
    }
    if (!validLimits(limits)) {
      dependencies.logger({ event: "knowledge-browser-session-failure", failureKind: "KnowledgeBrowserCapacityUnavailable" });
      return { ok: false, error: { kind: "KnowledgeBrowserCapacityUnavailable" } };
    }
    if (limits.allowedBrowserAcquisitions < 1) {
      dependencies.logger({ event: "knowledge-browser-session-failure", failureKind: "KnowledgeBrowserLaunchThrottled" });
      return { ok: false, error: { kind: "KnowledgeBrowserLaunchThrottled" } };
    }
    if (limits.activeSessions.length >= limits.maxConcurrentSessions) {
      dependencies.logger({ event: "knowledge-browser-session-failure", failureKind: "KnowledgeBrowserConcurrencyExceeded" });
      return { ok: false, error: { kind: "KnowledgeBrowserConcurrencyExceeded" } };
    }
    try {
      const launched = await dependencies.launcher.launch(dependencies.binding);
      if (!validSession(launched)) {
        await closeResources([launched]);
        return { ok: false, error: { kind: "KnowledgeBrowserLaunchFailed" } };
      }
      session = launched;
      const createdContext = await session.createBrowserContext();
      if (!validContext(createdContext)) {
        await closeResources([createdContext]);
        return { ok: false, error: { kind: "KnowledgeBrowserLaunchFailed" } };
      }
      context = createdContext;
      const createdPage = await context.newPage();
      if (!validPage(createdPage)) {
        await closeResources([createdPage]);
        return { ok: false, error: { kind: "KnowledgeBrowserLaunchFailed" } };
      }
      page = createdPage;
      await page.setUserAgent(dependencies.userAgent);
      await page.setExtraHTTPHeaders(dependencies.extraHTTPHeaders);
      dependencies.logger({ event: "knowledge-browser-identity-configured" });
      if (typeof page.setRequestInterception !== "function" || typeof page.on !== "function") {
        await closeResources();
        return { ok: false, error: { kind: "KnowledgeBrowserLaunchFailed" } };
      }
      await page.setRequestInterception(true);
      page.on("request", (request) => { void handleRequest(request); });
      dependencies.logger({ event: "knowledge-browser-session-success" });
      return { ok: true, value: page };
    } catch (error) {
      dependencies.logger({ event: "knowledge-browser-session-failure", failureKind: "KnowledgeBrowserLaunchFailed" });
      await closeResources();
      return { ok: false, error: { kind: "KnowledgeBrowserLaunchFailed" } };
    }
  }

  /** @returns {Promise<Result<null, BrowserFailure>>} */
  async function pace() {
    try {
      const now = clock();
      const wait = lastNavigationAtMs === null ? 0 : Math.max(0, policy.minimumInterRequestDelayMilliseconds - (now - lastNavigationAtMs));
      if (wait > 0) await sleep(wait);
      lastNavigationAtMs = clock();
      return { ok: true, value: null };
    } catch (error) {
      return { ok: false, error: { kind: "KnowledgeBrowserPacingFailed" } };
    }
  }

  /** @returns {Promise<Result<null, BrowserFailure>>} */
  async function settleRenderedPage() {
    if (page === null) return { ok: false, error: { kind: "KnowledgeBrowserRenderedProjectionFailed" } };
    if (typeof page.waitForNetworkIdle === "function") {
      try {
        await page.waitForNetworkIdle({ idleTime: policy.renderSettleMilliseconds, timeout: policy.renderSettleTimeoutMilliseconds });
        dependencies.logger({ event: "knowledge-browser-render-settled" });
        return { ok: true, value: null };
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (!message.includes("timeout") && !message.includes("timed out")) return { ok: false, error: { kind: "KnowledgeBrowserRenderedProjectionFailed" } };
        dependencies.logger({ event: "knowledge-browser-render-settle-timeout" });
        return { ok: true, value: null };
      }
    }
    if (policy.renderSettleMilliseconds === 0) return { ok: true, value: null };
    try {
      await sleep(policy.renderSettleMilliseconds);
      dependencies.logger({ event: "knowledge-browser-render-settle-fallback" });
      return { ok: true, value: null };
    } catch (error) {
      return { ok: false, error: { kind: "KnowledgeBrowserRenderedProjectionFailed" } };
    }
  }

  /** @param {BrowserPage} currentPage @returns {Promise<Result<{ readonly renderedTitle: string, readonly renderedText: string, readonly visibleLinks: readonly string[] }, BrowserFailure>>} */
  async function renderedProjection(currentPage) {
    let evaluated;
    try {
      evaluated = await currentPage.evaluate((maximumTextCharacters, maximumLinks) => {
        const container = /** @type {HTMLElement | null} */ (document.querySelector("main, article") ?? document.body);
        const renderedTitle = (document.title ?? "").replace(/\s+/gu, " ").trim().slice(0, 300);
        const renderedText = (container?.innerText ?? container?.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, maximumTextCharacters);
        const visibleLinks = [...document.querySelectorAll("a[href]")]
          .filter((link) => link.getClientRects().length > 0)
          .slice(0, maximumLinks)
          .flatMap((link) => {
            const value = /** @type {HTMLAnchorElement} */ (link).href;
            return typeof value === "string" && value.trim() !== "" ? [value] : [];
          });
        return JSON.stringify({ renderedTitle, renderedText, visibleLinks });
      }, policy.maximumRenderedTextCharacters, policy.maximumVisibleLinks);
    } catch (error) {
      return { ok: false, error: { kind: "KnowledgeBrowserRenderedProjectionFailed" } };
    }
    if (typeof evaluated !== "string") return { ok: false, error: { kind: "KnowledgeBrowserRenderedProjectionFailed" } };
    let parsed;
    try { parsed = JSON.parse(evaluated); } catch (error) { return { ok: false, error: { kind: "KnowledgeBrowserRenderedProjectionFailed" } }; }
    if (!record(parsed) || typeof parsed.renderedTitle !== "string" || typeof parsed.renderedText !== "string" || !Array.isArray(parsed.visibleLinks) || !parsed.visibleLinks.every((value) => typeof value === "string")) return { ok: false, error: { kind: "KnowledgeBrowserRenderedProjectionFailed" } };
    if (parsed.renderedText.length > policy.maximumRenderedTextCharacters || parsed.visibleLinks.length > policy.maximumVisibleLinks) return { ok: false, error: { kind: "KnowledgeBrowserRenderedProjectionFailed" } };
    return { ok: true, value: freeze({ renderedTitle: parsed.renderedTitle, renderedText: parsed.renderedText, visibleLinks: freeze([...parsed.visibleLinks]) }) };
  }

  /** @param {{ readonly rootUrl: string, readonly url: string }} command @returns {Promise<Result<{ readonly response: unknown, readonly status: number, readonly headers: Readonly<Record<string, string>>, readonly finalUrl: string, readonly redirects: number }, BrowserFailure>>} */
  async function navigate(command) {
    const authorized = await authorize(command.rootUrl, command.url);
    if (!authorized.ok) return authorized;
    const ready = await ensurePage();
    if (!ready.ok) return ready;
    const paced = await pace();
    if (!paced.ok) return paced;
    activeRootUrl = new URL(command.rootUrl).href;
    interceptionFailure = null;
    let response;
    try { response = await ready.value.goto(authorized.value.href, { waitUntil: "domcontentloaded", timeout: policy.navigationTimeoutMilliseconds }); } catch (error) {
      return { ok: false, error: classifyNavigationFailure(error) };
    }
    if (interceptionFailure !== null) return { ok: false, error: interceptionFailure };
    const status = responseStatus(response);
    const finalUrl = responseUrl(response);
    const headers = responseHeaders(response);
    if (response === null || status === null || finalUrl === null || headers === null) return { ok: false, error: { kind: "KnowledgeBrowserResponseInvalid" } };
    const finalAuthorized = await authorize(command.rootUrl, finalUrl);
    if (!finalAuthorized.ok) return finalAuthorized;
    currentUrl = finalAuthorized.value.href;
    return { ok: true, value: freeze({ response, status, headers, finalUrl: finalAuthorized.value.href, redirects: redirectChain(response).length }) };
  }

  /** @param {{ readonly rootUrl: string, readonly url: string }} command @returns {Promise<Result<BrowserPageRead, BrowserFailure>>} */
  async function readPageInternal({ rootUrl, url }) {
    if (!publicHttps(rootUrl) || !publicHttps(url)) return { ok: false, error: { kind: "KnowledgeBrowserNavigationRejected" } };
    const key = new URL(url).href;
    const cached = pageCache.get(key);
    if (cached !== undefined) return { ok: true, value: clonePageRead(cached) };
    dependencies.logger({ event: "knowledge-browser-page-entry" });
    for (let attempt = 0; attempt <= policy.maximumRateLimitRetries; attempt += 1) {
      const navigated = await navigate({ rootUrl, url: key });
      if (!navigated.ok) {
        dependencies.logger({ event: "knowledge-browser-page-failure", failureKind: navigated.error.kind, ...(navigated.error.diagnosticToken === undefined ? {} : { diagnosticToken: navigated.error.diagnosticToken }) });
        return navigated;
      }
      if (navigated.value.status === 401) {
        dependencies.logger({ event: "knowledge-browser-page-failure", failureKind: "KnowledgePageAuthenticationRequired", diagnosticToken: "http-authentication-required", httpStatus: navigated.value.status });
        return { ok: false, error: { kind: "KnowledgePageAuthenticationRequired" } };
      }
      if (navigated.value.status === 402) {
        dependencies.logger({ event: "knowledge-browser-page-failure", failureKind: "KnowledgePagePaywallDetected", diagnosticToken: "http-paywall", httpStatus: navigated.value.status });
        return { ok: false, error: { kind: "KnowledgePagePaywallDetected" } };
      }
      if (navigated.value.status === 403) {
        dependencies.logger({ event: "knowledge-browser-page-failure", failureKind: "KnowledgePageBotAccessDenied", diagnosticToken: "http-access-denied", httpStatus: navigated.value.status });
        return { ok: false, error: { kind: "KnowledgePageBotAccessDenied" } };
      }
      if (navigated.value.status === 429) {
        const retryAfter = retryAfterMilliseconds(navigated.value.headers, clock());
        if (attempt >= policy.maximumRateLimitRetries || retryAfter === null || retryAfter > policy.maximumRetryAfterMilliseconds) {
          dependencies.logger({ event: "knowledge-browser-page-failure", failureKind: "KnowledgePageRateLimited", diagnosticToken: "http-rate-limited", httpStatus: navigated.value.status });
          return { ok: false, error: { kind: "KnowledgePageRateLimited" } };
        }
        try { await sleep(retryAfter); lastNavigationAtMs = clock(); } catch (error) {
          return { ok: false, error: { kind: "KnowledgeBrowserPacingFailed" } };
        }
        continue;
      }
      if (navigated.value.status < 200 || navigated.value.status > 299) {
        dependencies.logger({ event: "knowledge-browser-page-failure", failureKind: "KnowledgePageFetchFailed", diagnosticToken: "http-non-success", httpStatus: navigated.value.status });
        return { ok: false, error: { kind: "KnowledgePageFetchFailed", diagnosticToken: "http-non-success" } };
      }
      const contentType = (navigated.value.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
        dependencies.logger({ event: "knowledge-browser-page-failure", failureKind: "KnowledgePageTypeUnsupported", diagnosticToken: "unsupported-content-type", httpStatus: navigated.value.status });
        return { ok: false, error: { kind: "KnowledgePageTypeUnsupported" } };
      }
      const ready = await ensurePage();
      if (!ready.ok) return ready;
      const settled = await settleRenderedPage();
      if (!settled.ok) return settled;
      let html;
      try { html = await ready.value.content(); } catch (error) {
        dependencies.logger({ event: "knowledge-browser-page-failure", failureKind: "KnowledgePageFetchFailed", diagnosticToken: "page-content-failed", httpStatus: navigated.value.status });
        return { ok: false, error: { kind: "KnowledgePageFetchFailed", diagnosticToken: "page-content-failed" } };
      }
      const bytes = encoder.encode(html);
      if (bytes.byteLength > policy.maximumHtmlBytes) {
        dependencies.logger({ event: "knowledge-browser-page-failure", failureKind: "KnowledgePageTooLarge", diagnosticToken: "html-too-large", httpStatus: navigated.value.status });
        return { ok: false, error: { kind: "KnowledgePageTooLarge" } };
      }
      const projection = await renderedProjection(ready.value);
      if (!projection.ok) return projection;
      const value = freeze({ url: key, responseUrl: navigated.value.finalUrl, contentType, bytes, redirects: navigated.value.redirects, renderedTitle: projection.value.renderedTitle, renderedText: projection.value.renderedText, visibleLinks: projection.value.visibleLinks });
      pageCache.set(key, value);
      while (pageCache.size > policy.maximumCachedPages) {
        const oldest = pageCache.keys().next().value;
        if (typeof oldest !== "string") break;
        pageCache.delete(oldest);
      }
      dependencies.logger({ event: "knowledge-browser-page-success" });
      return { ok: true, value: clonePageRead(value) };
    }
    return { ok: false, error: { kind: "KnowledgePageRateLimited" } };
  }

  /** @param {{ readonly sourceUrl: string, readonly robotsUrl: string }} command @returns {Promise<Result<BrowserRobotsRead, BrowserFailure>>} */
  async function readRobotsInternal({ sourceUrl, robotsUrl }) {
    if (!publicHttps(sourceUrl) || !publicHttps(robotsUrl)) return { ok: false, error: { kind: "KnowledgeBrowserNavigationRejected" } };
    const source = new URL(sourceUrl);
    const target = new URL(robotsUrl);
    const key = `${source.origin}/robots.txt`;
    if (target.href !== key) return { ok: false, error: { kind: "KnowledgeBrowserNavigationRejected" } };
    if (typeof dependencies.browserRequest !== "function") return { ok: false, error: { kind: "KnowledgeRobotsRequestCapabilityUnavailable" } };
    const cached = robotsCache.get(key);
    if (cached !== undefined) return { ok: true, value: cloneRobotsRead(cached) };
    dependencies.logger({ event: "knowledge-browser-robots-entry" });
    const robotsRoot = new URL(source.href);
    robotsRoot.pathname = "/";
    robotsRoot.search = "";
    robotsRoot.hash = "";
    const browserReady = await ensurePage();
    if (!browserReady.ok) return browserReady;
    const sourceNavigation = await navigate({ rootUrl: robotsRoot.href, url: robotsRoot.href });
    if (!sourceNavigation.ok) return sourceNavigation;
    activeRootUrl = robotsRoot.href;
    interceptionFailure = null;
    let response;
    try {
      response = await /** @type {BrowserRequestCapability} */ (dependencies.browserRequest)({ url: key, timeout: policy.navigationTimeoutMilliseconds });
    } catch (error) {
      return { ok: false, error: { kind: "KnowledgeRobotsFetchUnavailable" } };
    }
    if (interceptionFailure !== null) return { ok: false, error: interceptionFailure };
    const status = responseStatus(response);
    const finalUrl = responseUrl(response);
    const headers = responseHeaders(response);
    if (response === null || status === null || finalUrl === null || headers === null) return { ok: false, error: { kind: "KnowledgeRobotsResponseInvalid" } };
    if (finalUrl !== key) return { ok: false, error: { kind: "KnowledgeRobotsRedirectRejected" } };
    // Preserve an origin 403 as an observation so the policy layer can decide
    // whether a separately reachable source page is sufficient to continue.
    // Other non-success responses remain unavailable and fail closed.
    if (!((status >= 200 && status <= 299) || status === 404 || status === 410 || status === 403)) return { ok: false, error: { kind: "KnowledgeRobotsFetchUnavailable" } };
    if (status === 403) {
      if (record(response) && typeof response.text === "function") try { await response.text(); } catch (error) { /* preserve the 403 observation */ }
      const value = freeze({ status, headers, bytes: new Uint8Array() });
      robotsCache.set(key, value);
      dependencies.logger({ event: "knowledge-browser-robots-success" });
      return { ok: true, value: cloneRobotsRead(value) };
    }
    if (!record(response) || typeof response.text !== "function") return { ok: false, error: { kind: "KnowledgeRobotsResponseInvalid" } };
    let body;
    try { body = await response.text(); } catch (error) { return { ok: false, error: { kind: "KnowledgeRobotsFetchUnavailable" } }; }
    if (typeof body !== "string") return { ok: false, error: { kind: "KnowledgeRobotsResponseInvalid" } };
    const bytes = encoder.encode(body);
    if (bytes.byteLength > policy.maximumRobotsBytes) return { ok: false, error: { kind: "KnowledgeRobotsTooLarge" } };
    const value = freeze({ status, headers, bytes });
    robotsCache.set(key, value);
    dependencies.logger({ event: "knowledge-browser-robots-success" });
    return { ok: true, value: cloneRobotsRead(value) };
  }

  /** @param {{ readonly rootUrl: string, readonly url: string }} command @returns {Promise<Result<BrowserScreenshot, BrowserFailure>>} */
  async function screenshotInternal({ rootUrl, url }) {
    if (!publicHttps(rootUrl) || !publicHttps(url)) return { ok: false, error: { kind: "KnowledgeBrowserNavigationRejected" } };
    const key = new URL(url).href;
    if (currentUrl !== key) {
      const loaded = await navigate({ rootUrl, url: key });
      if (!loaded.ok) return loaded;
      if (loaded.value.status < 200 || loaded.value.status > 299) return { ok: false, error: { kind: "KnowledgeScreenshotFailed" } };
    }
    const ready = await ensurePage();
    if (!ready.ok) return ready;
    if (typeof ready.value.screenshot !== "function") return { ok: false, error: { kind: "WorkflowBrowserScreenshotUnavailable" } };
    let output;
    try { output = await ready.value.screenshot({ type: "png" }); } catch (error) { return { ok: false, error: { kind: "KnowledgeScreenshotFailed" } }; }
    if (!(output instanceof Uint8Array)) return { ok: false, error: { kind: "KnowledgeScreenshotFailed" } };
    if (output.byteLength > policy.maximumScreenshotBytes) return { ok: false, error: { kind: "KnowledgeScreenshotTooLarge" } };
    return { ok: true, value: freeze({ url: key, mediaType: /** @type {const} */ ("image/png"), bytes: new Uint8Array(output) }) };
  }

  /** @param {readonly unknown[]} [additionalResources] @returns {Promise<Result<null, BrowserFailure>>} */
  async function closeResources(additionalResources = []) {
    const resources = [...new Set([...additionalResources, page, context, session].filter(closeable))];
    page = null;
    context = null;
    session = null;
    currentUrl = null;
    activeRootUrl = null;
    lastNavigationAtMs = null;
    interceptionFailure = null;
    pageCache.clear();
    robotsCache.clear();
    addressCache.clear();
    let failed = false;
    for (const resource of resources) {
      if (resource === null) continue;
      try { await resource.close(); } catch (error) { failed = true; }
    }
    if (failed) {
      dependencies.logger({ event: "knowledge-browser-session-failure", failureKind: "KnowledgeBrowserSessionCloseFailed" });
      return { ok: false, error: { kind: "KnowledgeBrowserSessionCloseFailed" } };
    }
    if (resources.some((resource) => resource !== null)) dependencies.logger({ event: "knowledge-browser-session-close-success" });
    return { ok: true, value: null };
  }

  /** @param {{ readonly rootUrl: string, readonly url: string }} command @returns {Promise<Result<BrowserPageRead, BrowserFailure>>} */
  function readPage(command) { return withOperation("readPage", () => readPageInternal(command)); }

  /** @param {{ readonly sourceUrl: string, readonly robotsUrl: string }} command @returns {Promise<Result<BrowserRobotsRead, BrowserFailure>>} */
  function readRobots(command) { return withOperation("readRobots", () => readRobotsInternal(command)); }

  /** @param {{ readonly rootUrl: string, readonly url: string }} command @returns {Promise<Result<BrowserScreenshot, BrowserFailure>>} */
  function screenshot(command) { return withOperation("screenshot", () => screenshotInternal(command)); }

  /** @returns {Promise<Result<null, BrowserFailure>>} */
  function close() {
    return withOperation("close", async () => {
      closed = true;
      return closeResources();
    });
  }

  return Object.freeze({ readPage, readRobots, screenshot, close });
}

export {};
