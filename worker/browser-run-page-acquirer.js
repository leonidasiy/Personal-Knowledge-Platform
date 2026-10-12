// @ts-check

import {
  isIsoDateTime,
  isNonEmptyText,
  isPositiveInteger,
  isPublicHttpsUrl,
  isRecord,
} from "../src/features/source-library/ingestion-contracts.js";

/** @import { BrowserRunAcquisitionBatch, BrowserRunObservedPage, Result, ServerRightsGrant, SourceCrawlPlan, SourceIngestionCursor, SourceIngestionFailure, SourceIngestionFrontierEntry, TrustedSourceIngestionJob } from "../src/features/source-library/ingestion-contracts.js" */

/** @typedef {{ readonly ip: string, readonly port: number }} RemoteAddress */
/** @typedef {{ readonly url: () => string, readonly response: () => BrowserResponse | null }} BrowserRequest */
/** @typedef {{ readonly url: () => string, readonly status: () => number, readonly headers: () => Record<string, string>, readonly remoteAddress: () => RemoteAddress, readonly request: () => { readonly redirectChain: () => readonly BrowserRequest[] } }} BrowserResponse */
/** @typedef {{ readonly url: () => string, readonly resourceType: () => string, readonly isNavigationRequest: () => boolean, readonly abort: (reason?: string) => Promise<void>, readonly continue: () => Promise<void> }} InterceptedRequest */
/** @typedef {{ readonly setRequestInterception: (enabled: boolean) => Promise<void>, readonly on: (event: "request" | "popup", listener: (value: unknown) => void | Promise<void>) => void, readonly goto: (url: string, options: { readonly waitUntil: "domcontentloaded", readonly timeout: number }) => Promise<BrowserResponse | null>, readonly content: () => Promise<string>, readonly evaluate: (callback: (maximumTextCharacters: number, maximumLinks: number) => unknown, maximumTextCharacters: number, maximumLinks: number) => Promise<unknown>, readonly close: () => Promise<void> }} BrowserPage */
/** @typedef {{ readonly newPage: () => Promise<BrowserPage>, readonly close: () => Promise<void> }} BrowserContext */
/** @typedef {{ readonly createBrowserContext: () => Promise<BrowserContext>, readonly close: () => Promise<void> }} BrowserSession */
/** @typedef {{ readonly activeSessions: readonly { readonly id: string }[], readonly allowedBrowserAcquisitions: number, readonly maxConcurrentSessions: number, readonly timeUntilNextAllowedBrowserAcquisition: number }} BrowserLimits */
/** @typedef {{ readonly limits: (binding: unknown) => Promise<unknown>, readonly launch: (binding: unknown) => Promise<BrowserSession> }} BrowserLauncher */

const freeze = Object.freeze;
const encoder = new TextEncoder();

export class BrowserRunPageAcquirer {
  #dependencies;

  /** @param {{ readonly launcher: BrowserLauncher, readonly binding: unknown, readonly resolveAddresses: (hostname: string) => Promise<Result<readonly string[], SourceIngestionFailure>>, readonly now: () => string, readonly policy: { readonly maximumPagesPerRun: number, readonly maximumRunMilliseconds: number, readonly navigationTimeoutMilliseconds: number, readonly maximumHtmlBytes: number, readonly maximumTextCharacters: number, readonly maximumLinksPerPage: number, readonly maximumFrontierEntries: number } }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.launcher?.limits !== "function" || typeof dependencies.launcher.launch !== "function" ||
      (typeof dependencies.binding !== "object" && typeof dependencies.binding !== "function") || dependencies.binding === null ||
      typeof dependencies.resolveAddresses !== "function" || typeof dependencies.now !== "function" || !validPolicy(dependencies.policy)) {
      throw new TypeError("Browser Run page-acquirer dependencies are invalid.");
    }
    this.#dependencies = dependencies;
  }

  /** @param {unknown} command @returns {Promise<Result<BrowserRunAcquisitionBatch, SourceIngestionFailure>>} */
  async acquire(command) {
    const parsed = validateBrowserRunCommand(command);
    if (!parsed.ok) return parsed;
    const limits = await this.#activeLimits();
    if (!limits.ok) return limits;
    if (limits.value.allowedBrowserAcquisitions < 1) {
      const now = this.#time();
      return fail({ kind: "BrowserRunLaunchThrottled", retryAt: new Date(Date.parse(now) + limits.value.timeUntilNextAllowedBrowserAcquisition).toISOString() });
    }
    if (limits.value.activeSessions.length >= limits.value.maxConcurrentSessions) return fail({ kind: "BrowserRunConcurrencyExceeded" });

    /** @type {BrowserSession | null} */ let browser = null;
    /** @type {BrowserContext | null} */ let context = null;
    /** @type {BrowserPage | null} */ let page = null;
    /** @type {{ readonly close: () => Promise<void> }[]} */ const acquired = [];
    /** @type {Result<BrowserRunAcquisitionBatch, SourceIngestionFailure>} */ let result = fail({ kind: "BrowserRunUnavailable" });
    let sessionCloseFailed = false;
    const startedAt = this.#time();
    try {
      const launched = await this.#dependencies.launcher.launch(this.#dependencies.binding);
      track(launched, acquired);
      if (!validBrowser(launched)) {
        result = fail({ kind: "BrowserRunLaunchFailed" });
      } else {
        browser = launched;
        const createdContext = await browser.createBrowserContext();
        track(createdContext, acquired);
        if (!validContext(createdContext)) {
          result = fail({ kind: "BrowserRunLaunchFailed" });
        } else {
          context = createdContext;
          const createdPage = await context.newPage();
          track(createdPage, acquired);
          if (!validPage(createdPage)) {
            result = fail({ kind: "BrowserRunLaunchFailed" });
          } else {
            page = createdPage;
            await page.setRequestInterception(true);
            const interception = { failure: /** @type {SourceIngestionFailure | null} */ (null) };
            page.on("request", async (value) => {
              const request = /** @type {InterceptedRequest} */ (value);
              const decision = await this.#intercept(request, parsed.value.job.rootUrl);
              if (!decision.ok) {
                interception.failure = decision.error;
                await request.abort("blockedbyclient");
                return;
              }
              if (decision.value === "abort") await request.abort("blockedbyclient");
              else await request.continue();
            });
            page.on("popup", async (value) => {
              const popup = /** @type {BrowserPage} */ (value);
              await popup.close();
            });
            result = await this.#crawl(page, parsed.value, interception, startedAt);
          }
        }
      }
    } catch (error) {
      result = fail(classifyProviderFailure(error, this.#time()));
    } finally {
      sessionCloseFailed = !(await closeAll(acquired));
    }
    if (sessionCloseFailed) return fail({ kind: "BrowserRunSessionCloseFailed" });
    return result;
  }

  /** @param {BrowserPage} page @param {{ readonly job: TrustedSourceIngestionJob, readonly cursor: SourceIngestionCursor, readonly plan: SourceCrawlPlan, readonly rights: ServerRightsGrant }} command @param {{ failure: SourceIngestionFailure | null }} interception @param {string} startedAt @returns {Promise<Result<BrowserRunAcquisitionBatch, SourceIngestionFailure>>} */
  async #crawl(page, command, interception, startedAt) {
    const frontier = command.cursor.frontier.map((entry) => ({ ...entry }));
    /** @type {BrowserRunObservedPage[]} */ const pages = [];
    let redirects = command.cursor.redirects;
    let stopReason = null;
    while (true) {
      const entry = frontier.filter((item) => item.state === "pending" && item.depth <= command.plan.selectedDepth).sort((left, right) => left.ordinal - right.ordinal)[0];
      if (entry === undefined) break;
      const elapsed = Date.parse(this.#time()) - Date.parse(startedAt);
      if (pages.length >= this.#dependencies.policy.maximumPagesPerRun) { stopReason = "BrowserRunExtractionLimitExceeded"; break; }
      if (elapsed >= this.#dependencies.policy.maximumRunMilliseconds) { stopReason = "BrowserRunTimedOut"; break; }
      const authorized = await this.#authorize(entry.url, command.job.rootUrl);
      if (!authorized.ok) return authorized;
      interception.failure = null;
      let response;
      try {
        response = await page.goto(authorized.value.href, { waitUntil: "domcontentloaded", timeout: this.#dependencies.policy.navigationTimeoutMilliseconds });
      } catch (error) {
        if (error instanceof Error) return fail(classifyProviderFailure(error, this.#time()));
        throw error;
      }
      if (interception.failure !== null) return fail(interception.failure);
      if (response === null) return fail({ kind: "BrowserRunResponseInvalid", field: "response" });
      const observed = await this.#observe(page, response, command.job.rootUrl);
      if (!observed.ok) return observed;
      redirects += observed.value.redirectChain.length;
      if (redirects > command.plan.maximumRedirects) return fail({ kind: "BrowserRunRedirectLimitExceeded" });
      pages.push(observed.value);
      const located = frontier.find((candidate) => candidate.ordinal === entry.ordinal);
      if (located !== undefined) located.state = "visited";
      for (const link of observed.value.visibleLinks) {
        if (frontier.some((candidate) => candidate.url === link)) continue;
        if (frontier.length >= this.#dependencies.policy.maximumFrontierEntries) return fail({ kind: "IngestionFrontierLimitExceeded" });
        const next = await this.#authorize(link, command.job.rootUrl);
        if (!next.ok) continue;
        frontier.push({ ordinal: frontier.length, url: next.value.href, depth: entry.depth + 1, state: "pending", discoveredFromUrl: entry.url });
      }
    }
    const pending = frontier.filter((entry) => entry.state === "pending" && entry.depth <= command.plan.selectedDepth);
    const nextCursor = pending.length === 0 ? null : freeze({
      version: command.cursor.version + 1,
      nextOrdinal: Math.min(...pending.map((entry) => entry.ordinal)),
      pagesProcessed: command.cursor.pagesProcessed + pages.length,
      decodedBytes: command.cursor.decodedBytes + pages.reduce((total, item) => total + encoder.encode(item.readableText).byteLength, 0),
      redirects,
      frontier: freeze(frontier.map((entry) => freeze(entry))),
    });
    const measuredMilliseconds = Math.max(0, Date.parse(this.#time()) - Date.parse(startedAt));
    return { ok: true, value: freeze({ pages: freeze(pages), nextCursor, measuredMilliseconds, stopReason }) };
  }

  /** @param {BrowserPage} page @param {BrowserResponse} response @param {string} rootUrl @returns {Promise<Result<BrowserRunObservedPage, SourceIngestionFailure>>} */
  async #observe(page, response, rootUrl) {
    if (typeof response.url !== "function" || typeof response.status !== "function" || typeof response.headers !== "function" ||
      typeof response.remoteAddress !== "function" || typeof response.request !== "function") return fail({ kind: "BrowserRunResponseInvalid", field: "response" });
    const final = await this.#authorize(response.url(), rootUrl);
    if (!final.ok) return final;
    const peer = response.remoteAddress();
    if (!isRecord(peer) || !isNonEmptyText(peer.ip)) return fail({ kind: "BrowserRunPeerAddressUnavailable" });
    if (forbiddenAddress(peer.ip)) return fail({ kind: "BrowserRunPeerAddressRejected" });
    const request = response.request();
    if (!isRecord(request) || typeof request.redirectChain !== "function") return fail({ kind: "BrowserRunResponseInvalid", field: "redirectChain" });
    const chain = request.redirectChain();
    if (!Array.isArray(chain)) return fail({ kind: "BrowserRunResponseInvalid", field: "redirectChain" });
    const redirects = [];
    for (const redirected of chain) {
      if (!isRecord(redirected) || typeof redirected.url !== "function" || typeof redirected.response !== "function") return fail({ kind: "BrowserRunResponseInvalid", field: "redirectChain" });
      const authorized = await this.#authorize(redirected.url(), rootUrl);
      if (!authorized.ok) return authorized;
      const redirectResponse = redirected.response();
      if (redirectResponse === null || typeof redirectResponse.remoteAddress !== "function") return fail({ kind: "BrowserRunPeerAddressUnavailable" });
      const remote = redirectResponse.remoteAddress();
      if (!isRecord(remote) || !isNonEmptyText(remote.ip)) return fail({ kind: "BrowserRunPeerAddressUnavailable" });
      if (forbiddenAddress(remote.ip)) return fail({ kind: "BrowserRunPeerAddressRejected" });
      redirects.push(authorized.value.href);
    }
    const status = response.status();
    if (status === 401 || status === 402) return fail({ kind: status === 401 ? "AuthenticationRequired" : "PaywallDetected" });
    if (status === 403 || status === 429) return fail({ kind: "BrowserRunBotAccessDenied" });
    if (!Number.isInteger(status) || status < 200 || status > 299) return fail({ kind: "BrowserRunResponseInvalid", field: "status" });
    const mediaType = response.headers()["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") return fail({ kind: "CrawlResponseTypeUnsupported", mediaType: mediaType ?? "missing" });
    const html = await page.content();
    if (encoder.encode(html).byteLength > this.#dependencies.policy.maximumHtmlBytes) return fail({ kind: "BrowserRunExtractionLimitExceeded", field: "html" });
    // Limit data returned from the browser process before it crosses the Worker boundary.
    const projection = await page.evaluate((maximumTextCharacters, maximumLinks) => {
      const container = document.querySelector("main, article") ?? document.body;
      const text = (container?.textContent?.replace(/\s+/g, " ").trim() ?? "").slice(0, maximumTextCharacters + 1);
      const description = document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "";
      const links = [...document.querySelectorAll("a[href]")].filter((link) => link.getClientRects().length > 0).slice(0, maximumLinks + 1).map((link) => /** @type {HTMLAnchorElement} */ (link).href);
      return { title: document.title, description, text, links };
    }, this.#dependencies.policy.maximumTextCharacters, this.#dependencies.policy.maximumLinksPerPage);
    if (!validProjection(projection)) return fail({ kind: "BrowserRunResponseInvalid", field: "projection" });
    if (projection.text.length > this.#dependencies.policy.maximumTextCharacters) return fail({ kind: "BrowserRunExtractionLimitExceeded", field: "text" });
    if (projection.links.length > this.#dependencies.policy.maximumLinksPerPage) return fail({ kind: "BrowserRunExtractionLimitExceeded", field: "links" });
    const observedAt = this.#time();
    const visibleLinks = projection.links.flatMap((link) => {
      if (!URL.canParse(link, final.value)) return [];
      const normalized = new URL(link, final.value).href;
      return isPublicHttpsUrl(normalized) ? [normalized] : [];
    });
    return { ok: true, value: freeze({ canonicalUrl: final.value.href, status, title: projection.title.trim(), description: projection.description.trim(), readableText: projection.text.trim(), visibleLinks: freeze(visibleLinks), redirectChain: freeze(redirects), peerAddress: peer.ip, observedAt }) };
  }

  /** @param {InterceptedRequest} request @param {string} rootUrl @returns {Promise<Result<"continue" | "abort", SourceIngestionFailure>>} */
  async #intercept(request, rootUrl) {
    if (!isRecord(request) || typeof request.url !== "function" || typeof request.resourceType !== "function" || typeof request.isNavigationRequest !== "function") return fail({ kind: "BrowserRunResponseInvalid", field: "request" });
    const resourceType = request.resourceType();
    if (["image", "media", "font", "stylesheet"].includes(resourceType)) return { ok: true, value: "abort" };
    const url = request.url();
    if (url.startsWith("data:") || url === "about:blank") return { ok: true, value: "continue" };
    if (!request.isNavigationRequest() && URL.canParse(url) && new URL(url).origin !== new URL(rootUrl).origin) return { ok: true, value: "abort" };
    const authorized = await this.#authorize(url, rootUrl);
    if (!authorized.ok) return authorized;
    return { ok: true, value: "continue" };
  }

  /** @param {string} value @param {string} rootUrl @returns {Promise<Result<URL, SourceIngestionFailure>>} */
  async #authorize(value, rootUrl) {
    if (!isPublicHttpsUrl(value)) return fail({ kind: "BrowserRunNavigationRejected", reason: "invalid-url" });
    const url = new URL(value);
    const root = new URL(rootUrl);
    const rootPath = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
    if (url.port !== "" || url.origin !== root.origin || (url.pathname !== root.pathname && !url.pathname.startsWith(rootPath))) return fail({ kind: "BrowserRunNavigationRejected", reason: "source-boundary" });
    const resolved = await this.#dependencies.resolveAddresses(url.hostname);
    if (!resolved.ok) return resolved;
    if (resolved.value.length === 0 || resolved.value.some(forbiddenAddress)) return fail({ kind: "BrowserRunNavigationRejected", reason: "resolved-address" });
    return { ok: true, value: url };
  }

  /** @returns {Promise<Result<BrowserLimits, SourceIngestionFailure>>} */
  async #activeLimits() {
    try {
      const limits = await this.#dependencies.launcher.limits(this.#dependencies.binding);
      return validLimits(limits) ? { ok: true, value: limits } : fail({ kind: "BrowserRunResponseInvalid", field: "limits" });
    } catch (error) {
      if (error instanceof Error) return fail(classifyProviderFailure(error, this.#time()));
      throw error;
    }
  }

  #time() {
    const value = this.#dependencies.now();
    if (!isIsoDateTime(value)) throw new TypeError("Browser Run page-acquirer clock returned an invalid time.");
    return value;
  }
}

/** @param {unknown} value @returns {value is { readonly title: string, readonly description: string, readonly text: string, readonly links: readonly string[] }} */
function validProjection(value) { return isRecord(value) && isNonEmptyText(value.title) && typeof value.description === "string" && isNonEmptyText(value.text) && Array.isArray(value.links) && value.links.every((link) => typeof link === "string"); }
/** @param {unknown} value @returns {value is BrowserLimits} */
function validLimits(value) {
  if (!isRecord(value) || !Array.isArray(value.activeSessions) ||
    !value.activeSessions.every((entry) => isRecord(entry) && isNonEmptyText(entry.id)) ||
    !isPositiveInteger(value.maxConcurrentSessions) || typeof value.allowedBrowserAcquisitions !== "number" ||
    !Number.isInteger(value.allowedBrowserAcquisitions) || value.allowedBrowserAcquisitions < 0 ||
    typeof value.timeUntilNextAllowedBrowserAcquisition !== "number" ||
    !Number.isInteger(value.timeUntilNextAllowedBrowserAcquisition) || value.timeUntilNextAllowedBrowserAcquisition < 0) return false;
  return true;
}
/** @param {unknown} value */
function validBrowser(value) { return isRecord(value) && typeof value.createBrowserContext === "function" && typeof value.close === "function"; }
/** @param {unknown} value */
function validContext(value) { return isRecord(value) && typeof value.newPage === "function" && typeof value.close === "function"; }
/** @param {unknown} value */
function validPage(value) { return isRecord(value) && typeof value.setRequestInterception === "function" && typeof value.on === "function" && typeof value.goto === "function" && typeof value.content === "function" && typeof value.evaluate === "function" && typeof value.close === "function"; }
/** @param {unknown} value */
function validPolicy(value) { return isRecord(value) && isPositiveInteger(value.maximumPagesPerRun) && isPositiveInteger(value.maximumRunMilliseconds) && isPositiveInteger(value.navigationTimeoutMilliseconds) && value.navigationTimeoutMilliseconds <= value.maximumRunMilliseconds && isPositiveInteger(value.maximumHtmlBytes) && isPositiveInteger(value.maximumTextCharacters) && isPositiveInteger(value.maximumLinksPerPage) && isPositiveInteger(value.maximumFrontierEntries); }

/** @param {unknown} command @returns {Result<{ readonly job: TrustedSourceIngestionJob, readonly cursor: SourceIngestionCursor, readonly plan: SourceCrawlPlan, readonly rights: ServerRightsGrant }, SourceIngestionFailure>} */
export function validateBrowserRunCommand(command) {
  if (!isRecord(command) || !validJob(command.job) || !validCursor(command.cursor) || !validPlan(command.plan) || !validRights(command.rights) || Object.keys(command).some((key) => !["job", "cursor", "plan", "rights"].includes(key))) return fail({ kind: "BrowserRunConfigurationInvalid" });
  const job = /** @type {TrustedSourceIngestionJob} */ (command.job);
  const plan = /** @type {SourceCrawlPlan} */ (command.plan);
  const rights = /** @type {ServerRightsGrant} */ (command.rights);
  if (plan.ownerId !== job.ownerId || plan.sourceId !== job.sourceId || plan.sourceRevision !== job.sourceRevision || plan.rootUrl !== new URL(job.rootUrl).href || rights.ownerId !== job.ownerId || rights.sourceId !== job.sourceId || rights.sourceRevision !== job.sourceRevision || rights.canonicalRootUrl !== new URL(job.rootUrl).href) return fail({ kind: "RightsRegistryEvidenceConflicting" });
  return { ok: true, value: freeze({ job, cursor: /** @type {SourceIngestionCursor} */ (command.cursor), plan, rights }) };
}
/** @param {unknown} value */
function validJob(value) { return isRecord(value) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.jobId) && isNonEmptyText(value.sourceId) && isPositiveInteger(value.sourceRevision) && isPublicHttpsUrl(value.rootUrl); }
/** @param {unknown} value @returns {value is SourceIngestionCursor} */
function validCursor(value) {
  return isRecord(value) && isPositiveInteger(value.version) && typeof value.nextOrdinal === "number" && Number.isInteger(value.nextOrdinal) && value.nextOrdinal >= 0 &&
    typeof value.pagesProcessed === "number" && Number.isInteger(value.pagesProcessed) && value.pagesProcessed >= 0 &&
    typeof value.decodedBytes === "number" && Number.isInteger(value.decodedBytes) && value.decodedBytes >= 0 &&
    typeof value.redirects === "number" && Number.isInteger(value.redirects) && value.redirects >= 0 &&
    Array.isArray(value.frontier) && value.frontier.every(validFrontier);
}
/** @param {unknown} value @returns {value is SourceCrawlPlan} */
function validPlan(value) {
  return isRecord(value) && isNonEmptyText(value.policyVersion) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.sourceId) && isPositiveInteger(value.sourceRevision) && isPublicHttpsUrl(value.rootUrl) &&
    isPositiveInteger(value.selectedDepth) && ["policy-default", "sitemap-evidence", "navigation-evidence"].includes(String(value.depthReason)) &&
    (value.depthEvidence === null || (isRecord(value.depthEvidence) && (value.depthEvidence.kind === "sitemap" || value.depthEvidence.kind === "navigation") && isPublicHttpsUrl(value.depthEvidence.evidenceUrl) && isPositiveInteger(value.depthEvidence.requiredDepth) && isIsoDateTime(value.depthEvidence.observedAt))) &&
    isPositiveInteger(value.maximumPages) && isPositiveInteger(value.maximumDecodedBytes) && isPositiveInteger(value.maximumConcurrency) && isPositiveInteger(value.maximumDurationMs) && typeof value.maximumRedirects === "number" && Number.isInteger(value.maximumRedirects) && value.maximumRedirects >= 0 && isPositiveInteger(value.refreshIntervalMs) && isIsoDateTime(value.assessedAt);
}
/** @param {unknown} value @returns {value is ServerRightsGrant} */
function validRights(value) {
  return isRecord(value) && isNonEmptyText(value.registryId) && isNonEmptyText(value.registryVersion) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.sourceId) && isPositiveInteger(value.sourceRevision) && isPublicHttpsUrl(value.canonicalRootUrl) &&
    isRecord(value.capabilities) && [value.capabilities.storage, value.capabilities.display, value.capabilities.transformation].every(validCapabilityEvidence) && isNonEmptyText(value.attributionText) && isNonEmptyText(value.evidenceDigest) && isNonEmptyText(value.assessorId) && isNonEmptyText(value.assessorVersion) && isIsoDateTime(value.observedAt) && (value.expiresAt === null || isIsoDateTime(value.expiresAt));
}
/** @param {unknown} value */
function validCapabilityEvidence(value) { return isRecord(value) && (value.outcome === "allowed" || value.outcome === "denied" || value.outcome === "unknown") && isNonEmptyText(value.evidenceReference) && isIsoDateTime(value.observedAt) && (value.expiresAt === null || isIsoDateTime(value.expiresAt)); }
/** @param {unknown} value @returns {value is SourceIngestionFrontierEntry} */
function validFrontier(value) { return isRecord(value) && typeof value.ordinal === "number" && Number.isInteger(value.ordinal) && value.ordinal >= 0 && isPublicHttpsUrl(value.url) && typeof value.depth === "number" && Number.isInteger(value.depth) && value.depth >= 0 && (value.state === "pending" || value.state === "visited") && (value.discoveredFromUrl === null || isPublicHttpsUrl(value.discoveredFromUrl)); }

/** @param {unknown} error @param {string} now */
function classifyProviderFailure(error, now) {
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (text.includes("browser time limit") || (text.includes("429") && text.includes("daily"))) return /** @type {const} */ ({ kind: "BrowserRunDailyBudgetExceeded" });
  if (text.includes("429") || text.includes("too many requests")) return /** @type {const} */ ({ kind: "BrowserRunLaunchThrottled", retryAt: new Date(Date.parse(now) + 20_000).toISOString() });
  if (text.includes("timeout") || text.includes("timed out")) return /** @type {const} */ ({ kind: "BrowserRunTimedOut" });
  return /** @type {const} */ ({ kind: "BrowserRunUnavailable" });
}

/** @param {readonly { readonly close: () => Promise<void> }[]} resources */
async function closeAll(resources) {
  let ok = true;
  const closed = new Set();
  for (const resource of resources) {
    if (closed.has(resource)) continue;
    closed.add(resource);
    try { await resource.close(); } catch (error) { ok = false; }
  }
  return ok;
}

/** @param {unknown} value @param {{ readonly close: () => Promise<void> }[]} resources */
function track(value, resources) {
  if (isRecord(value) && typeof value.close === "function") resources.push(/** @type {{ readonly close: () => Promise<void> }} */ (value));
}

/** @param {string} value */
function forbiddenAddress(value) {
  if (value.includes(":")) {
    const firstText = value.toLowerCase().split(":", 1)[0];
    const first = firstText === "" ? 0 : Number.parseInt(firstText, 16);
    return !Number.isInteger(first) || first < 0x2000 || first > 0x3fff || value.toLowerCase().startsWith("2001:db8:");
  }
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113);
}

/** @param {SourceIngestionFailure} error @returns {Result<never, SourceIngestionFailure>} */
function fail(error) { return { ok: false, error }; }

export {};
