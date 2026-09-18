// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {{ readonly url: string, readonly kind: "image", readonly educationallyConnected: true, readonly mediaTypeHint: string, readonly rights: { readonly storage: "allowed", readonly display: "allowed", readonly transformation: "allowed", readonly attribution: string, readonly originEvidence: string } }} OpenSourceImageCandidate */
/** @typedef {{ readonly kind: "ImageSearchQueryInvalid" | "ImageSearchUnavailable" | "ImageSearchRateLimited" | "ImageSearchResponseInvalid" }} ImageSearchFailure */

const OPENVERSE_ENDPOINT = "https://api.openverse.org/v1/images/";
const MAX_QUERY_LENGTH = 180;
const MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 8_000;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is string} */
function httpsUrl(value) { return text(value) && URL.canParse(value) && new URL(value).protocol === "https:"; }
/** @param {string} value @returns {readonly string[]} */
function terms(value) { return Object.freeze([...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 12)); }

/** @param {unknown} value @returns {boolean} */
function reusableLicense(value) {
  if (!text(value)) return false;
  const license = value.toLocaleLowerCase();
  const normalized = license.replaceAll("-", " ");
  if (license.includes("noncommercial") || license.includes("-nc") || normalized.includes(" no derivatives") || license.includes("-nd")) return false;
  return license.includes("cc0") || license.includes("public domain") || license.includes("pdm") || normalized === "by" || normalized === "by sa" || normalized.includes("cc by");
}

/** @param {Record<string, unknown>} result @param {readonly string[]} queryTerms @returns {OpenSourceImageCandidate | null} */
function project(result, queryTerms) {
  const url = httpsUrl(result.url) ? /** @type {string} */ (result.url) : httpsUrl(result.thumbnail) ? /** @type {string} */ (result.thumbnail) : null;
  const title = text(result.title) ? result.title : "Open-license music image";
  const creator = text(result.creator) ? result.creator : "Creator not supplied";
  const license = text(result.license) ? result.license : null;
  if (url === null || license === null || !reusableLicense(license)) return null;
  const searchable = [title, result.description, result.tags].filter(text).join(" ");
  const matchingTerms = queryTerms.filter((term) => searchable.toLocaleLowerCase().includes(term));
  if (matchingTerms.length < Math.min(2, queryTerms.length)) return null;
  const landing = httpsUrl(result.foreign_landing_url) ? result.foreign_landing_url : url;
  const licenseUrl = httpsUrl(result.license_url) ? result.license_url : "https://creativecommons.org/share-your-work/cclicenses/";
  const attribution = `${title} — ${creator} — ${license}`;
  return Object.freeze({
    url,
    kind: "image",
    educationallyConnected: true,
    mediaTypeHint: text(result.mime_type) && result.mime_type.startsWith("image/") ? result.mime_type : "image/jpeg",
    rights: Object.freeze({ storage: "allowed", display: "allowed", transformation: "allowed", attribution, originEvidence: `Openverse result ${landing}; licence evidence ${licenseUrl}` }),
  });
}

/** @param {{ readonly fetch: typeof fetch, readonly now?: () => string, readonly timeoutMs?: number, readonly logger: (entry: { readonly event: string, readonly failureKind?: string, readonly resultCount?: number }) => void }} dependencies */
export function createOpenSourceImageSearch(dependencies) {
  const timeoutMs = dependencies?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof dependencies?.fetch !== "function" || typeof dependencies.logger !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("Open-source image search dependencies are invalid.");
  return Object.freeze({
    /** @param {{ readonly query: string }} command @returns {Promise<Result<readonly OpenSourceImageCandidate[], ImageSearchFailure>>} */
    async search(command) {
      if (!record(command) || !text(command.query) || command.query.length > MAX_QUERY_LENGTH) return { ok: false, error: { kind: "ImageSearchQueryInvalid" } };
      const query = command.query.trim();
      const queryTerms = terms(query);
      if (queryTerms.length === 0) return { ok: false, error: { kind: "ImageSearchQueryInvalid" } };
      const endpoint = new URL(OPENVERSE_ENDPOINT);
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("page_size", String(MAX_RESULTS));
      endpoint.searchParams.set("mature", "false");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await dependencies.fetch(endpoint.href, { method: "GET", headers: { accept: "application/json" }, cache: "no-store", signal: controller.signal });
      } catch (error) {
        clearTimeout(timeout);
        dependencies.logger({ event: "open-source-image-search-failure", failureKind: "ImageSearchUnavailable" });
        return { ok: false, error: { kind: "ImageSearchUnavailable" } };
      }
      clearTimeout(timeout);
      if (response.status === 429) {
        dependencies.logger({ event: "open-source-image-search-failure", failureKind: "ImageSearchRateLimited" });
        return { ok: false, error: { kind: "ImageSearchRateLimited" } };
      }
      if (!response.ok) {
        dependencies.logger({ event: "open-source-image-search-failure", failureKind: "ImageSearchUnavailable" });
        return { ok: false, error: { kind: "ImageSearchUnavailable" } };
      }
      let document;
      try { document = await response.json(); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { ok: false, error: { kind: "ImageSearchResponseInvalid" } };
      }
      if (!record(document) || !Array.isArray(document.results)) return { ok: false, error: { kind: "ImageSearchResponseInvalid" } };
      const candidates = document.results.flatMap((value) => record(value) ? [project(value, queryTerms)].filter((candidate) => candidate !== null) : []);
      dependencies.logger({ event: "open-source-image-search-success", resultCount: candidates.length });
      return { ok: true, value: Object.freeze(/** @type {OpenSourceImageCandidate[]} */ (candidates)) };
    },
  });
}

export {};
