// @ts-check

/** @import { WorkerFailure } from "./contracts.js" */

/**
 * @typedef {{
 *   readonly videoId: string,
 *   readonly title: string,
 *   readonly description: string | null,
 *   readonly channelId: string | null,
 *   readonly publisherLabel: string,
 *   readonly publishedAt: string,
 *   readonly canonicalUrl: string,
 *   readonly embedUrl: string,
 *   readonly madeForKids: boolean,
 *   readonly refreshBy: string
 * }} YouTubeCandidate
 */

/** @template T,E @typedef {{readonly ok:true,readonly value:T,readonly nextCursor?:string}|{readonly ok:false,readonly error:E}} Result */

export class YouTubeDiscoveryAdapter {
  /** @type {{ readonly maximumResults: number, readonly quotaTimeZone: string }} */
  #configuration;
  /** @type {{
   *   readonly fetch: typeof fetch,
   *   readonly now: () => Date,
   *   readonly apiKeyForSearch: () => Result<string, WorkerFailure>,
   *   readonly reserveSearchQuery: (reservation: { readonly quotaDay: string }) => Promise<Result<number, WorkerFailure>>,
   *   readonly reserveGeneralRead: (reservation: { readonly quotaDay: string, readonly units: number }) => Promise<Result<number, WorkerFailure>>
   * }} */
  #dependencies;
  /** @type {Intl.DateTimeFormat} */
  #quotaDayFormatter;

  /**
   * @param {{ readonly maximumResults: number, readonly quotaTimeZone: string }} configuration
   * @param {{
   *   readonly fetch: typeof fetch,
   *   readonly now: () => Date,
   *   readonly apiKeyForSearch: () => Result<string, WorkerFailure>,
   *   readonly reserveSearchQuery: (reservation: { readonly quotaDay: string }) => Promise<Result<number, WorkerFailure>>,
   *   readonly reserveGeneralRead: (reservation: { readonly quotaDay: string, readonly units: number }) => Promise<Result<number, WorkerFailure>>
   * }} dependencies
   */
  constructor(configuration, dependencies) {
    if (
      !Number.isInteger(configuration.maximumResults) ||
      configuration.maximumResults < 1 || configuration.maximumResults > 50 ||
      typeof configuration.quotaTimeZone !== "string" ||
      configuration.quotaTimeZone.trim() === "" ||
      typeof dependencies.fetch !== "function" ||
      typeof dependencies.now !== "function" ||
      typeof dependencies.apiKeyForSearch !== "function" ||
      typeof dependencies.reserveSearchQuery !== "function" ||
      typeof dependencies.reserveGeneralRead !== "function"
    ) throw new TypeError("YouTube discovery configuration is invalid.");
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: configuration.quotaTimeZone,
        calendar: "iso8601",
        numberingSystem: "latn",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new TypeError(
          "YouTube quota time-zone configuration is invalid.",
        );
      }
      throw error;
    }
    this.#configuration = Object.freeze({ ...configuration });
    this.#dependencies = dependencies;
    this.#quotaDayFormatter = formatter;
  }

  /** @param {unknown} input @param {AbortSignal} [signal] @returns {Promise<Result<readonly YouTubeCandidate[], WorkerFailure>>} */
  async search(input, signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Invalid YouTube search signal.");
    if (signal?.aborted) return {ok:false,error:{kind:"YouTubeUpstreamUnavailable"}};
    if (
      typeof input !== "object" || input === null || Array.isArray(input) ||
      typeof /** @type {Record<string, unknown>} */ (input).query !==
        "string" ||
      /** @type {Record<string, unknown>} */ (input).query.trim() === ""
    ) {
      return {
        ok: false,
        error: { kind: "DiscoveryCommandInvalid", field: "query" },
      };
    }
    const pageToken = /** @type {Record<string,unknown>} */ (input).pageToken;
    const requestedLimit = /** @type {Record<string,unknown>} */ (input).limit;
    if (pageToken !== undefined && (typeof pageToken !== "string" || !pageToken.trim()) || requestedLimit !== undefined && (typeof requestedLimit !== "number" || !Number.isInteger(requestedLimit) || requestedLimit < 1)) return {ok:false,error:{kind:"YouTubeResponseInvalid"}};
    const query = /** @type {{ query: string }} */ (input).query;
    const now = this.#dependencies.now();
    if (!Number.isFinite(now.getTime())) {
      return { ok: false, error: { kind: "YouTubeResponseInvalid" } };
    }
    const credential = this.#dependencies.apiKeyForSearch();
    if (!credential.ok) return credential;
    if (credential.value.trim() === "") {
      return { ok: false, error: { kind: "YouTubeCredentialRejected" } };
    }
    const quotaDay = quotaDayFor(now, this.#quotaDayFormatter);
    const searchReservation = await this.#dependencies.reserveSearchQuery({
      quotaDay,
    });
    if (!searchReservation.ok) return searchReservation;
    if (signal?.aborted) return {ok:false,error:{kind:"YouTubeUpstreamUnavailable"}};
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.search = new URLSearchParams({
      key: credential.value,
      part: "snippet",
      type: "video",
      maxResults: String(Math.min(this.#configuration.maximumResults, typeof requestedLimit === "number" ? requestedLimit : this.#configuration.maximumResults)),
      safeSearch: "strict",
      q: query,
    }).toString();
    if (typeof pageToken === "string") searchUrl.searchParams.set("pageToken", pageToken);
    const searched = await fetchYouTube(
      this.#dependencies.fetch,
      searchUrl,
      signal,
    );
    if (!searched.ok) return searched;
    const searchDocument = await readJson(searched.value);
    if (!searchDocument.ok) return searchDocument;
    const nextCursor = typeof searchDocument.value === "object" && searchDocument.value !== null ? /** @type {Record<string,unknown>} */ (searchDocument.value).nextPageToken : undefined;
    if (nextCursor !== undefined && (typeof nextCursor !== "string" || !nextCursor.trim())) return {ok:false,error:{kind:"YouTubeResponseInvalid"}};
    const continuation = typeof nextCursor === "string" ? {nextCursor} : {};
    const summaries = parseSearchItems(searchDocument.value);
    if (!summaries.ok) return summaries;
    if (summaries.value.length === 0) {
      return { ok: true, value: Object.freeze([]), ...continuation };
    }
    if (signal?.aborted) return {ok:false,error:{kind:"YouTubeUpstreamUnavailable"}};
    const generalReservation = await this.#dependencies.reserveGeneralRead({
      quotaDay,
      units: 1,
    });
    if (!generalReservation.ok) return generalReservation;
    if (signal?.aborted) return {ok:false,error:{kind:"YouTubeUpstreamUnavailable"}};
    const statusUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    statusUrl.search = new URLSearchParams({
      key: credential.value,
      part: "status",
      id: summaries.value.map((
        /** @type {{ readonly videoId: string }} */ item,
      ) => item.videoId).join(","),
    }).toString();
    const statuses = await fetchYouTube(
      this.#dependencies.fetch,
      statusUrl,
      signal,
    );
    if (!statuses.ok) return statuses;
    const statusDocument = await readJson(statuses.value);
    if (!statusDocument.ok) return statusDocument;
    const statusById = parseStatuses(statusDocument.value);
    if (!statusById.ok) return statusById;
    const refreshBy = new Date(now.getTime() + 30 * 24 * 60 * 60_000)
      .toISOString();
    /** @type {YouTubeCandidate[]} */
    const candidates = [];
    for (const summary of summaries.value) {
      const status = statusById.value.get(summary.videoId);
      if (
        status === undefined ||
        status.madeForKids === null
      ) continue;
      candidates.push(Object.freeze({
        ...summary,
        canonicalUrl: `https://www.youtube.com/watch?v=${
          encodeURIComponent(summary.videoId)
        }`,
        embedUrl: `https://www.youtube-nocookie.com/embed/${
          encodeURIComponent(summary.videoId)
        }`,
        madeForKids: status.madeForKids,
        refreshBy,
      }));
    }
    return { ok: true, value: Object.freeze(candidates), ...continuation };
  }
}

/**
 * @param {Date} date
 * @param {Intl.DateTimeFormat} formatter
 */
function quotaDayFor(date, formatter) {
  const parts = new Map(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (year === undefined || month === undefined || day === undefined) {
    throw new TypeError("YouTube quota-day formatter invariant is broken.");
  }
  return `${year}-${month}-${day}`;
}

/**
 * @param {typeof fetch} fetchDependency
 * @param {URL} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<Result<Response, WorkerFailure>>}
 */
async function fetchYouTube(fetchDependency, url, signal) {
  /** @type {Response} */
  let response;
  try {
    response = await fetchDependency(url, {
      signal,
      headers: {
        accept: "application/json",
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, error: { kind: "YouTubeUpstreamUnavailable" } };
    }
    throw error;
  }
  if (response.status === 429) {
    return { ok: false, error: { kind: "YouTubeProviderQuotaExceeded" } };
  }
  if (response.status === 401 || response.status === 403) {
    if (await isProviderQuotaResponse(response)) {
      return { ok: false, error: { kind: "YouTubeProviderQuotaExceeded" } };
    }
    return { ok: false, error: { kind: "YouTubeCredentialRejected" } };
  }
  if (!response.ok) {
    return { ok: false, error: { kind: "YouTubeUpstreamUnavailable" } };
  }
  return { ok: true, value: response };
}

/** @param {Response} response */
async function isProviderQuotaResponse(response) {
  /** @type {unknown} */
  let value;
  try {
    value = await response.clone().json();
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (
    !isRecord(value) || !isRecord(value.error) ||
    !Array.isArray(value.error.errors)
  ) return false;
  return value.error.errors.some((entry) =>
    isRecord(entry) && typeof entry.reason === "string" &&
    (entry.reason.toLowerCase().includes("quota") ||
      entry.reason.toLowerCase().includes("ratelimit"))
  );
}

/** @param {Response} response @returns {Promise<Result<unknown, WorkerFailure>>} */
async function readJson(response) {
  try {
    return { ok: true, value: /** @type {unknown} */ (await response.json()) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, error: { kind: "YouTubeResponseInvalid" } };
    }
    throw error;
  }
}

/** @param {unknown} value @returns {Result<readonly { readonly videoId: string, readonly title: string, readonly description: string|null, readonly channelId: string|null, readonly publisherLabel: string, readonly publishedAt: string }[], WorkerFailure>} */
function parseSearchItems(value) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { ok: false, error: { kind: "YouTubeResponseInvalid" } };
  }
  const items = [];
  for (const item of value.items) {
    if (!isRecord(item) || !isRecord(item.id) || !isRecord(item.snippet)) {
      return { ok: false, error: { kind: "YouTubeResponseInvalid" } };
    }
    const videoId = item.id.videoId;
    const title = item.snippet.title;
    const publisherLabel = item.snippet.channelTitle;
    const publishedAt = item.snippet.publishedAt;
    if ((item.snippet.description !== undefined && typeof item.snippet.description !== "string") || (item.snippet.channelId !== undefined && (typeof item.snippet.channelId !== "string" || item.snippet.channelId.trim() === ""))) return {ok:false,error:{kind:"YouTubeResponseInvalid"}};
    const description = typeof item.snippet.description === "string" ? item.snippet.description : null;
    const channelId = typeof item.snippet.channelId === "string" ? item.snippet.channelId : null;
    if (
      typeof videoId !== "string" || !videoId.trim() || typeof title !== "string" || !title.trim() || typeof publisherLabel !== "string" || !publisherLabel.trim() || typeof publishedAt !== "string" || !publishedAt.trim()
    ) {
      return { ok: false, error: { kind: "YouTubeResponseInvalid" } };
    }
    items.push(Object.freeze({ videoId, title, description, channelId, publisherLabel, publishedAt }));
  }
  return { ok: true, value: Object.freeze(items) };
}

/** @param {unknown} value @returns {Result<ReadonlyMap<string, { readonly embeddable: boolean, readonly madeForKids: boolean | null }>, WorkerFailure>} */
function parseStatuses(value) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { ok: false, error: { kind: "YouTubeResponseInvalid" } };
  }
  const statuses = new Map();
  for (const item of value.items) {
    if (
      !isRecord(item) || typeof item.id !== "string" ||
      !isRecord(item.status) || typeof item.status.embeddable !== "boolean"
    ) {
      return { ok: false, error: { kind: "YouTubeResponseInvalid" } };
    }
    statuses.set(
      item.id,
      Object.freeze({
        embeddable: item.status.embeddable,
        madeForKids: typeof item.status.madeForKids === "boolean"
          ? item.status.madeForKids
          : null,
      }),
    );
  }
  return { ok: true, value: statuses };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export {};
