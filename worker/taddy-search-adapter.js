// @ts-check

/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{readonly id:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean}} SearchProviderDescriptor */
/** @typedef {{readonly kind:"SearchProviderCredentialMissing"}|{readonly kind:"SearchProviderCredentialRejected"}|{readonly kind:"SearchProviderQuotaExceeded"}|{readonly kind:"SearchProviderTimedOut"}|{readonly kind:"SearchProviderNetworkFailed"}|{readonly kind:"SearchProviderUpstreamRejected",readonly status:number}|{readonly kind:"SearchProviderQueryInvalid",readonly reason:"argument"|"complexity"|"field"|"input"|"syntax"|"variable"|"unspecified",readonly diagnosticTokens:readonly string[]}|{readonly kind:"SearchProviderInputInvalid"}|{readonly kind:"SearchProviderQueryTooComplex"}|{readonly kind:"SearchProviderGraphqlRejected",readonly code:string}|{readonly kind:"SearchProviderUnavailable"}|{readonly kind:"SearchProviderResponseInvalid"}|{readonly kind:"SearchProviderFeedBlocked",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedPrivate",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedDuplicate",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedInvalid",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedMissing",readonly seriesUuid:string}} SearchProviderFailure */
/** @typedef {{readonly providerId:string,readonly query:string,readonly limit:number}} SearchProviderCommand */
/** @typedef {{readonly providerId:string,readonly resultKind:string,readonly sourceLevel:"feed",readonly title:string,readonly description:string|null,readonly canonicalUrl:string,readonly publisherLabel:string|null,readonly publishedAt:null,readonly identityEvidence:readonly {readonly attribute:string,readonly value:string,readonly provenanceUrl:string}[]}} TaddyCandidate */
/** @typedef {{readonly providerId:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean,readonly maximumResults:number,readonly timeoutMs:number}} TaddySearchConfiguration */
/** @typedef {{readonly userId:string,readonly apiKey:string}} TaddyCredentials */
/** @typedef {{readonly uuid:string,readonly priority:string,readonly priorityReason:string|null,readonly dateLastRefreshed:number}} FeedRefreshEvidence */
/** @typedef {{readonly uuids:readonly string[],readonly rankings:Map<string,number>,readonly originals:Map<string,Record<string,unknown>>}} TaddySearchResult */

const ENDPOINT = "https://api.taddy.org";
const SEARCH_SELECTION =
  `{searchForTerm(term:__TERM__,filterForTypes:PODCASTSERIES,limitPerPage:__LIMIT__,includeSearchOperator:OR,isSafeMode:true){searchId podcastSeries{uuid name description authorName websiteUrl rssUrl}rankingDetails{id uuid rankingScore}}}`;
const DETAILS_SELECTION =
  `{getMultiplePodcastSeries(uuids:__UUIDS__){
      uuid
      name
      description
      authorName
      websiteUrl
      rssUrl
      isBlocked
      feedRefreshDetails { uuid priority priorityReason dateLastRefreshed }
    }
  }`;

/**
 * @param {TaddySearchConfiguration} configuration
 * @param {{readonly credentials:()=>Result<TaddyCredentials,SearchProviderFailure>,readonly timeoutSignal:(milliseconds:number)=>AbortSignal,readonly fetch:typeof fetch}} dependencies
 */
export function createTaddySearchProvider(configuration, dependencies) {
  if (
    !configurationValid(configuration) ||
    typeof dependencies?.credentials !== "function" ||
    typeof dependencies.timeoutSignal !== "function" ||
    typeof dependencies.fetch !== "function"
  ) {
    throw new TypeError("Invalid Taddy search provider dependencies.");
  }
  const descriptor = Object.freeze({
    id: configuration.providerId,
    label: configuration.label,
    resultKind: configuration.resultKind,
    priority: configuration.priority,
    enabled: configuration.enabled,
  });
  return Object.freeze({
    descriptor,
    /** @param {SearchProviderCommand} command @param {import("./discovery-search.js").SearchExecution} [execution] @returns {Promise<Result<readonly TaddyCandidate[],SearchProviderFailure>>} */
    async search(command, execution) {
      if (execution !== undefined && (!(execution.signal instanceof AbortSignal) || typeof execution.remainingMs !== "function")) throw new TypeError("Invalid Taddy execution budget.");
      if (!commandValid(command, descriptor.id)) {
        throw new TypeError("Invalid Taddy search command.");
      }
      const credential = dependencies.credentials();
      if (!credential.ok) return credential;
      if (
        !headerValue(credential.value.userId) ||
        !headerValue(credential.value.apiKey)
      ) {
        return {
          ok: false,
          error: { kind: "SearchProviderCredentialRejected" },
        };
      }
      const providerSignal = dependencies.timeoutSignal(configuration.timeoutMs);
      const signal = execution === undefined ? providerSignal : AbortSignal.any([providerSignal,execution.signal]);
      if (!(providerSignal instanceof AbortSignal)) {
        throw new TypeError(
          "Taddy timeout dependency returned an invalid signal.",
        );
      }
      const response = await request(
        dependencies.fetch,
        signal,
        credential.value,
        {
          query: searchQuery(command.query, Math.min(command.limit, configuration.maximumResults)),
        },
        "search",
      );
      if (!response.ok) return response;
      const document = await readDocument(response.value);
      if (!document.ok) return document;
      const searchResult = parseSearchDocument(document.value);
      if (!searchResult.ok) return searchResult;
      if (searchResult.value.uuids.length === 0) return { ok: true, value: Object.freeze([]) };
      const detailsResponse = await request(
        dependencies.fetch,
        signal,
        credential.value,
        { query: detailsQuery(searchResult.value.uuids) },
        "details",
      );
      if (!detailsResponse.ok) return detailsResponse;
      const detailsDocument = await readDocument(detailsResponse.value);
      if (!detailsDocument.ok) return detailsDocument;
      return parseDetailsDocument(detailsDocument.value, descriptor, searchResult.value);
    },
  });
}

/** @param {typeof fetch} fetchDependency @param {AbortSignal} signal @param {TaddyCredentials} credential @param {{readonly query:string}} body @param {"search"|"details"} stage @returns {Promise<Result<Response,SearchProviderFailure>>} */
async function request(fetchDependency, signal, credential, body, stage) {
  /** @type {Response} */ let response;
  try {
    response = await fetchDependency(ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-user-id": credential.userId,
        "x-api-key": credential.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return { ok: false, error: { kind: "SearchProviderTimedOut" } };
    }
    if (error instanceof Error) {
      return { ok: false, error: { kind: "SearchProviderNetworkFailed" } };
    }
    throw error;
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: { kind: "SearchProviderCredentialRejected" } };
  }
  if (response.status === 429) {
    return { ok: false, error: { kind: "SearchProviderQuotaExceeded" } };
  }
  if (!response.ok) {
    const document = await readDocument(response);
    if (document.ok && record(document.value) && document.value.errors !== undefined) {
      const mapped = graphqlFailure(document.value.errors, stage);
      if (mapped !== null) return { ok: false, error: mapped };
    }
    return {
      ok: false,
      error: {
        kind: "SearchProviderUpstreamRejected",
        status: response.status,
      },
    };
  }
  return { ok: true, value: response };
}

/** @param {string} term @param {number} limit */
function searchQuery(term, limit) {
  return SEARCH_SELECTION.replace("__TERM__", JSON.stringify(term)).replace("__LIMIT__", String(limit));
}

/** @param {readonly string[]} uuids */
function detailsQuery(uuids) {
  return DETAILS_SELECTION.replace("__UUIDS__", JSON.stringify(uuids));
}

/** @param {Response} response @returns {Promise<Result<unknown,SearchProviderFailure>>} */
async function readDocument(response) {
  try {
    return { ok: true, value: /** @type {unknown} */ (await response.json()) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, error: { kind: "SearchProviderResponseInvalid" } };
    }
    throw error;
  }
}

/** @param {unknown} value @returns {Result<TaddySearchResult,SearchProviderFailure>} */
function parseSearchDocument(value) {
  if (!record(value)) return invalid();
  if (value.errors !== undefined) {
    const failure = graphqlFailure(value.errors, "search");
    if (failure !== null) return { ok: false, error: failure };
    return invalid();
  }
  if (
    !record(value.data) || !record(value.data.searchForTerm) ||
    !Array.isArray(value.data.searchForTerm.podcastSeries) ||
    !Array.isArray(value.data.searchForTerm.rankingDetails) ||
    value.data.searchForTerm.podcastSeries.length > 25 ||
    value.data.searchForTerm.rankingDetails.length > 25
  ) {
    return invalid();
  }
  /** @type {Map<string,number>} */ const rankings = new Map();
  for (const entry of value.data.searchForTerm.rankingDetails) {
    if (!record(entry) || !uuid(entry.uuid) || typeof entry.rankingScore !== "number" || !Number.isFinite(entry.rankingScore) || entry.rankingScore < 0 || rankings.has(entry.uuid)) return invalid();
    rankings.set(entry.uuid, entry.rankingScore);
  }
  /** @type {Map<string,Record<string,unknown>>} */ const originals = new Map();
  /** @type {string[]} */ const uuids = [];
  /** @type {Set<string>} */ const seen = new Set();
  for (const item of value.data.searchForTerm.podcastSeries) {
    if (!record(item) || Object.keys(item).some(key => !["uuid","name","description","authorName","websiteUrl","rssUrl"].includes(key)) || !uuid(item.uuid) || seen.has(item.uuid) || !rankings.has(item.uuid)) return invalid();
    seen.add(item.uuid);
    uuids.push(item.uuid);
    originals.set(item.uuid,item);
  }
  if (rankings.size !== seen.size) return invalid();
  return { ok: true, value: Object.freeze({ uuids: Object.freeze(uuids), rankings, originals }) };
}

/** @param {unknown} value @param {SearchProviderDescriptor} descriptor @param {TaddySearchResult} search @returns {Result<readonly TaddyCandidate[],SearchProviderFailure>} */
function parseDetailsDocument(value, descriptor, search) {
  const rankings=search.rankings;
  if (!record(value)) return invalid();
  if (value.errors !== undefined) {
    const failure = graphqlFailure(value.errors, "details");
    if (failure !== null) return { ok: false, error: failure };
    return invalid();
  }
  if (!record(value.data) || !Array.isArray(value.data.getMultiplePodcastSeries) || value.data.getMultiplePodcastSeries.length !== rankings.size) return invalid();
  /** @type {Map<string,TaddyCandidate>} */ const candidates = new Map();
  /** @type {Set<string>} */ const seen = new Set();
  for (const item of value.data.getMultiplePodcastSeries) {
    if (!record(item) || !uuid(item.uuid) || seen.has(item.uuid) || !rankings.has(item.uuid)) return invalid();
    seen.add(item.uuid);
    const parsed = parseSeries({...item,...search.originals.get(item.uuid)}, descriptor, rankings);
    if (!parsed.ok) return parsed;
    candidates.set(item.uuid, parsed.value);
  }
  return { ok: true, value: Object.freeze(search.uuids.map(uuid => /** @type {TaddyCandidate} */(candidates.get(uuid)))) };
}

/** @param {unknown} value @param {SearchProviderDescriptor} descriptor @param {Map<string,number>} rankings @returns {Result<TaddyCandidate,SearchProviderFailure>} */
function parseSeries(value, descriptor, rankings) {
  if (
    !record(value) || !uuid(value.uuid) || !boundedText(value.name, 500) ||
    !(value.rssUrl === null || typeof value.rssUrl === "string") ||
    !(value.isBlocked === null || typeof value.isBlocked === "boolean") ||
    !(value.description === undefined || value.description === null || boundedText(value.description, 20_000)) ||
    !(value.authorName === undefined || value.authorName === null || boundedText(value.authorName, 500)) ||
    !(value.websiteUrl === undefined || value.websiteUrl === null || secure(value.websiteUrl)) ||
    !refreshValid(value.feedRefreshDetails)
  ) return invalid();
  const refresh = value.feedRefreshDetails;
  const ranking = rankings.get(value.uuid);
  if (ranking === undefined) return invalid();
  if (value.isBlocked || refresh.priorityReason === "VIOLATES_TADDY_DISTRIBUTION_POLICY" || refresh.priority === "NEVER" && refresh.priorityReason === null) return { ok: false, error: { kind: "SearchProviderFeedBlocked", seriesUuid: value.uuid } };
  if (refresh.priorityReason === "PRIVATE_PODCAST_FEED") return { ok: false, error: { kind: "SearchProviderFeedPrivate", seriesUuid: value.uuid } };
  if (refresh.priorityReason === "DUPLICATE_FEED") return { ok: false, error: { kind: "SearchProviderFeedDuplicate", seriesUuid: value.uuid } };
  if (refresh.priorityReason === "ERROR_PARSING_FEED" || refresh.priorityReason === "FEED_URL_NOT_WORKING") return { ok: false, error: { kind: "SearchProviderFeedInvalid", seriesUuid: value.uuid } };
  if (value.rssUrl === null || value.rssUrl.trim() === "") {
    return {
      ok: false,
      error: { kind: "SearchProviderFeedMissing", seriesUuid: value.uuid },
    };
  }
  if (!secure(value.rssUrl)) {
    return {
      ok: false,
      error: { kind: "SearchProviderFeedInvalid", seriesUuid: value.uuid },
    };
  }
  const provenanceUrl = ENDPOINT;
  /** @type {{readonly attribute:string,readonly value:string,readonly provenanceUrl:string}[]} */
  const evidence = [
    Object.freeze({
      attribute: "taddy-series-uuid",
      value: value.uuid,
      provenanceUrl,
    }),
    Object.freeze({ attribute: "taddy-ranking-score", value: String(ranking), provenanceUrl }),
    Object.freeze({ attribute: "taddy-feed-refresh-priority", value: refresh.priority, provenanceUrl }),
    Object.freeze({ attribute: "taddy-feed-last-refreshed", value: String(refresh.dateLastRefreshed), provenanceUrl }),
    Object.freeze({
      attribute: "podcast-feed",
      value: value.rssUrl,
      provenanceUrl: value.rssUrl,
    }),
  ];
  for (const [field, attribute] of [["description", "taddy-series-description"], ["authorName", "taddy-author-name"], ["websiteUrl", "taddy-publisher-website"]]) {
    if (typeof value[field] === "string") evidence.push(Object.freeze({attribute,value: value[field],provenanceUrl}));
  }
  return {
    ok: true,
    value: Object.freeze({
      providerId: descriptor.id,
      resultKind: descriptor.resultKind,
      sourceLevel: "feed",
      title: value.name,
      description: typeof value.description === "string" ? value.description : null,
      canonicalUrl: value.rssUrl,
      publisherLabel: typeof value.authorName === "string" ? value.authorName : null,
      publishedAt: null,
      identityEvidence: Object.freeze(evidence),
    }),
  };
}

const REFRESH_PRIORITIES = new Set(["WEBSUB", "HIGH", "MEDIUM", "REGULAR", "LOW", "INACTIVE", "NEVER"]);
const REFRESH_REASONS = new Set(["INACTIVE_FOR_OVER_1_YEAR", "DUPLICATE_FEED", "ERROR_PARSING_FEED", "FEED_URL_NOT_WORKING", "PRIVATE_PODCAST_FEED", "VIOLATES_TADDY_DISTRIBUTION_POLICY"]);
/** @param {unknown} value @returns {value is FeedRefreshEvidence} */
function refreshValid(value) {
  return record(value) && uuid(value.uuid) && typeof value.priority === "string" && REFRESH_PRIORITIES.has(value.priority) && (value.priorityReason === null || typeof value.priorityReason === "string" && REFRESH_REASONS.has(value.priorityReason)) && typeof value.dateLastRefreshed === "number" && Number.isInteger(value.dateLastRefreshed) && value.dateLastRefreshed >= 0;
}

/** @param {unknown} value @returns {SearchProviderFailure|null} */
function graphqlFailure(value, stage = "search") {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    return null;
  }
  /** @type {{readonly code:string,readonly message:string}[]} */ const errors =
    [];
  for (const entry of value) {
    if (
      !record(entry) || !boundedText(entry.code, 100) ||
      !boundedText(entry.message, 1_000)
    ) return null;
    errors.push({ code: entry.code, message: entry.message });
  }
  const code = errors[0].code;
  if (
    code === "API_KEY_INVALID" || code === "REQUIRES_USER_AUTHENTICATION" ||
    code === "ACCESS_NOT_ALLOWED"
  ) return { kind: "SearchProviderCredentialRejected" };
  if (code === "API_RATE_LIMIT_EXCEEDED") {
    return { kind: "SearchProviderQuotaExceeded" };
  }
  if (code === "TADDY_SERVER_ERROR") {
    return { kind: "SearchProviderUnavailable" };
  }
  if (code === "INVALID_QUERY_OR_SYNTAX") {
    return {
      kind: "SearchProviderQueryInvalid",
      reason: queryInvalidReason(errors[0].message),
      diagnosticTokens: Object.freeze([stage, ...queryDiagnosticTokens(errors[0].message)]),
    };
  }
  if (code === "BAD_USER_INPUT") return { kind: "SearchProviderInputInvalid" };
  if (code === "QUERY_TOO_COMPLEX") return { kind: "SearchProviderQueryTooComplex" };
  return { kind: "SearchProviderGraphqlRejected", code };
}

/** @param {string} message */
function queryDiagnosticTokens(message) {
  const words = new Set(message.toLocaleLowerCase("en-US").match(/[a-z]+/gu) ?? []);
  const allowed = [
    "query", "syntax", "search", "term", "field", "argument", "variable",
    "operation", "unknown", "invalid", "expected", "found", "missing",
    "required", "deprecated", "complex", "complexity", "allowed", "access",
    "permission", "plan", "limit", "string", "integer", "boolean", "podcast",
    "series", "selection",
  ];
  return Object.freeze(allowed.filter((token) => words.has(token)));
}

/** @param {string} message */
function queryInvalidReason(message) {
  const normalized = message.toLocaleLowerCase("en-US");
  if (normalized.includes("unknown argument")) return /** @type {const} */ ("argument");
  if (normalized.includes("cannot query field")) return /** @type {const} */ ("field");
  if (normalized.includes("variable")) return /** @type {const} */ ("variable");
  if (normalized.includes("syntax") || normalized.includes("parse")) return /** @type {const} */ ("syntax");
  if (normalized.includes("complex")) return /** @type {const} */ ("complexity");
  if (normalized.includes("invalid value") || normalized.includes("expected type")) return /** @type {const} */ ("input");
  return /** @type {const} */ ("unspecified");
}

/** @returns {Result<never,SearchProviderFailure>} */
function invalid() {
  return { ok: false, error: { kind: "SearchProviderResponseInvalid" } };
}
/** @param {unknown} value @returns {value is TaddySearchConfiguration} */
function configurationValid(value) {
  return record(value) && Object.keys(value).length === 7 &&
    [value.providerId, value.label, value.resultKind].every(text) &&
    positive(value.priority) && typeof value.enabled === "boolean" &&
    positive(value.maximumResults) && value.maximumResults <= 25 &&
    positive(value.timeoutMs) && value.timeoutMs <= 30_000;
}
/** @param {unknown} value @param {string} providerId */
function commandValid(value, providerId) {
  return record(value) && Object.keys(value).length === 3 &&
    value.providerId === providerId && text(value.query) &&
    positive(value.limit);
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string" && value.trim() !== "";
}
/** @param {unknown} value @param {number} maximum @returns {value is string} */
function boundedText(value, maximum) {
  return typeof value === "string" && value.trim() !== "" &&
    value.length <= maximum;
}
/** @param {unknown} value @returns {value is number} */
function positive(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
/** @param {unknown} value @returns {value is string} */
function secure(value) {
  return typeof value === "string" && URL.canParse(value) &&
    new URL(value).protocol === "https:" && new URL(value).username === "" && new URL(value).password === "" && new URL(value).hash === "";
}
/** @param {unknown} value @returns {value is string} */
function headerValue(value) {
  return typeof value === "string" && value.length <= 512 &&
    /^[\x21-\x7e]+$/u.test(value);
}
/** @param {unknown} value @returns {value is string} */
function uuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(value);
}
