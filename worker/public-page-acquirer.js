// @ts-check
import { validateBrowserRunCommand } from "./browser-run-page-acquirer.js";
import { isIsoDateTime } from "../src/features/source-library/ingestion-contracts.js";
/** @import {BrowserRunAcquisitionBatch,BrowserRunObservedPage,Result,SourceIngestionFailure} from '../src/features/source-library/ingestion-contracts.js' */
/** @import {Policy} from '../acquisition/contracts.ts' */
/** Service-backed sibling of BrowserRunPageAcquirer. The old Cloudflare launcher
 * remains available for legacy tests, but production uses this enforced gate. */
export class PublicPageAcquirer {
  #deps;
  /** @param {{readonly client:ReturnType<typeof import('./acquisition-client.js').createAcquisitionClient>,readonly policy:Policy,readonly now:()=>string,readonly maximumPagesPerRun:number,readonly maximumFrontierEntries:number,readonly maximumRunMilliseconds:number,readonly logger:(entry:{readonly event:string,readonly failureKind?:string})=>void}} deps */
  constructor(deps) {
    if (
      typeof deps?.client?.perform !== "function" ||
      typeof deps.now !== "function" || typeof deps.logger !== "function" ||
      ![
        deps.maximumPagesPerRun,
        deps.maximumFrontierEntries,
        deps.maximumRunMilliseconds,
      ].every((n) => Number.isSafeInteger(n) && n > 0)
    ) throw new TypeError("BrowserRunConfigurationInvalid");
    this.#deps = deps;
  }
  /** @param {unknown} command @returns {Promise<Result<BrowserRunAcquisitionBatch,SourceIngestionFailure>>} */
  async acquire(command) {
    this.#deps.logger({ event: "source-acquisition-entry" });
    const result = await this.#acquire(command);
    this.#deps.logger({
      event: result.ok
        ? "source-acquisition-success"
        : "source-acquisition-failure",
      ...(result.ok ? {} : { failureKind: result.error.kind }),
    });
    return result;
  }
  /** @param {unknown} command @returns {Promise<Result<BrowserRunAcquisitionBatch,SourceIngestionFailure>>} */
  async #acquire(command) {
    const parsed = validateBrowserRunCommand(command);
    if (!parsed.ok) return parsed;
    const { job, cursor, plan, rights } = parsed.value;
    for (
      const capability
        of /** @type {const} */ (["storage", "display", "transformation"])
    ) {
      const evidence = rights.capabilities[capability];
      if (evidence.outcome === "unknown") {
        return {
          ok: false,
          error: { kind: "ContentRightsUnknown", capability },
        };
      }
      if (evidence.outcome === "denied") {
        return {
          ok: false,
          error: {
            kind: capability === "storage"
              ? "ContentStorageDenied"
              : capability === "display"
              ? "ContentDisplayDenied"
              : "ContentTransformationDenied",
          },
        };
      }
    }
    if (cursor.redirects > plan.maximumRedirects) {
      return { ok: false, error: { kind: "BrowserRunRedirectLimitExceeded" } };
    }
    const started = this.#time();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.#deps.maximumRunMilliseconds),
    ]);
    const frontier = cursor.frontier.map((entry) => ({
      ...entry,
    })); /** @type {BrowserRunObservedPage[]} */
    const pages = [];
    let redirects = cursor.redirects;
    let stopReason = null;
    try {
      while (true) {
        const next = frontier.filter((e) =>
          e.state === "pending" && e.depth <= plan.selectedDepth
        ).sort((a, b) =>
          a.ordinal - b.ordinal
        )[0];
        if (!next) break;
        if (pages.length >= this.#deps.maximumPagesPerRun) {
          stopReason = "BrowserRunExtractionLimitExceeded";
          break;
        }
        if (signal.aborted) {
          stopReason = "BrowserRunTimedOut";
          break;
        }
        const observed = await this.#deps.client.perform("page", {
          url: next.url,
          rootUrl: job.rootUrl,
          purpose: "page",
          maximumBytes: this.#deps.policy.htmlBytes,
          redirectLimit: Math.min(
            plan.maximumRedirects - redirects,
            this.#deps.policy.pageRedirects,
          ),
        }, signal);
        if (!observed.ok) {
          if (observed.error.kind.startsWith("Acquisition")) {
            return { ok: false, error: { kind: "BrowserRunUnavailable" } };
          }
          return {
            ok: false,
            error:
              /** @type {import('../acquisition/contracts.ts').Failure} */ (observed
                .error),
          };
        }
        const p = observed.value.projection;
        if (!p) {
          return {
            ok: false,
            error: { kind: "BrowserRunResponseInvalid", field: "projection" },
          };
        }
        redirects += observed.value.redirectHops.length;
        if (redirects > plan.maximumRedirects) {
          return {
            ok: false,
            error: { kind: "BrowserRunRedirectLimitExceeded" },
          };
        }
        pages.push({
          canonicalUrl: observed.value.finalUrl,
          status: observed.value.status,
          title: p.renderedTitle,
          description: "",
          readableText: p.renderedText,
          visibleLinks: p.visibleLinks,
          redirectChain: observed.value.redirectHops,
          peerAddress: observed.value.peerAddress,
          observedAt: this.#time(),
        });
        next.state = "visited";
        for (const link of p.visibleLinks) {
          if (
            !this.#scope(job.rootUrl, link) ||
            frontier.some((e) => e.url === link)
          ) continue;
          if (frontier.length >= this.#deps.maximumFrontierEntries) {
            return {
              ok: false,
              error: { kind: "IngestionFrontierLimitExceeded" },
            };
          }
          frontier.push({
            ordinal: frontier.length,
            url: link,
            depth: next.depth + 1,
            state: "pending",
            discoveredFromUrl: next.url,
          });
        }
      }
      const pending = frontier.filter((e) =>
        e.state === "pending" && e.depth <= plan.selectedDepth
      );
      const nextCursor = pending.length === 0 ? null : {
        version: cursor.version + 1,
        nextOrdinal: Math.min(...pending.map((e) => e.ordinal)),
        pagesProcessed: cursor.pagesProcessed + pages.length,
        decodedBytes: cursor.decodedBytes +
          pages.reduce(
            (n, p) => n + new TextEncoder().encode(p.readableText).length,
            0,
          ),
        redirects,
        frontier,
      };
      return {
        ok: true,
        value: {
          pages,
          nextCursor,
          measuredMilliseconds: Math.max(
            0,
            Date.parse(this.#time()) - Date.parse(started),
          ),
          stopReason,
        },
      };
    } finally {
      controller.abort();
    }
  }
  #time() {
    const time = this.#deps.now();
    if (!isIsoDateTime(time)) {
      throw new TypeError("BrowserRunConfigurationInvalid");
    }
    return time;
  }
  /** @param {string} rootUrl @param {string} link */
  #scope(rootUrl, link) {
    if (!URL.canParse(link)) return false;
    const root = new URL(rootUrl),
      url = new URL(link),
      path = root.pathname.replace(/\/$/, "");
    return url.protocol === "https:" && !url.username && !url.password &&
      url.port === "" && root.origin === url.origin &&
      (url.pathname === path || url.pathname.startsWith(`${path}/`));
  }
}
