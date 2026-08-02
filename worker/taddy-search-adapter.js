// @ts-check

/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{readonly id:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean}} SearchProviderDescriptor */
/** @typedef {{readonly kind:"SearchProviderCredentialMissing"}|{readonly kind:"SearchProviderCredentialRejected"}|{readonly kind:"SearchProviderQuotaExceeded"}|{readonly kind:"SearchProviderTimedOut"}|{readonly kind:"SearchProviderNetworkFailed"}|{readonly kind:"SearchProviderUpstreamRejected",readonly status:number}|{readonly kind:"SearchProviderGraphqlRejected",readonly code:string}|{readonly kind:"SearchProviderUnavailable"}|{readonly kind:"SearchProviderResponseInvalid"}|{readonly kind:"SearchProviderFeedBlocked",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedPrivate",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedDuplicate",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedInvalid",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedMissing",readonly seriesUuid:string}} SearchProviderFailure */
/** @typedef {{readonly providerId:string,readonly query:string,readonly limit:number}} SearchProviderCommand */
/** @typedef {{readonly providerId:string,readonly resultKind:string,readonly sourceLevel:"feed",readonly title:string,readonly description:string|null,readonly canonicalUrl:string,readonly publisherLabel:string|null,readonly publishedAt:null,readonly identityEvidence:readonly {readonly attribute:string,readonly value:string,readonly provenanceUrl:string}[]}} TaddyCandidate */
/** @typedef {{readonly providerId:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean,readonly maximumResults:number,readonly timeoutMs:number}} TaddySearchConfiguration */
/** @typedef {{readonly userId:string,readonly apiKey:string}} TaddyCredentials */

const ENDPOINT = "https://api.taddy.org/";
const SEARCH_QUERY =
  `query EducationalPodcastSeries($term:String!,$limit:Int!){search(term:$term,filterForTypes:PODCASTSERIES,page:1,limitPerPage:$limit,sortBy:EXACTNESS,matchBy:MOST_TERMS,isSafeMode:true){podcastSeries{uuid name description(shouldStripHtmlTags:true)websiteUrl rssUrl authorName isBlocked feedRefreshDetails{uuid priority priorityReason dateLastRefreshed}}rankingDetails{uuid rankingScore}}}`;
const PRIORITIES = new Set([
  "WEBSUB",
  "HIGH",
  "MEDIUM",
  "REGULAR",
  "LOW",
  "INACTIVE",
  "NEVER",
]);
const REASONS = new Set([
  "INACTIVE_FOR_OVER_1_YEAR",
  "DUPLICATE_FEED",
  "ERROR_PARSING_FEED",
  "FEED_URL_NOT_WORKING",
  "PRIVATE_PODCAST_FEED",
  "VIOLATES_TADDY_DISTRIBUTION_POLICY",
]);

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
    /** @param {SearchProviderCommand} command @returns {Promise<Result<readonly TaddyCandidate[],SearchProviderFailure>>} */
    async search(command) {
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
      const signal = dependencies.timeoutSignal(configuration.timeoutMs);
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError(
          "Taddy timeout dependency returned an invalid signal.",
        );
      }
      const response = await request(
        dependencies.fetch,
        signal,
        credential.value,
        {
          query: SEARCH_QUERY,
          variables: Object.freeze({
            term: command.query,
            limit: Math.min(command.limit, configuration.maximumResults),
          }),
        },
      );
      if (!response.ok) return response;
      const document = await readDocument(response.value);
      if (!document.ok) return document;
      return parseDocument(document.value, descriptor);
    },
  });
}

/** @param {typeof fetch} fetchDependency @param {AbortSignal} signal @param {TaddyCredentials} credential @param {{readonly query:string,readonly variables:{readonly term:string,readonly limit:number}}} body @returns {Promise<Result<Response,SearchProviderFailure>>} */
async function request(fetchDependency, signal, credential, body) {
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

/** @param {unknown} value @param {SearchProviderDescriptor} descriptor @returns {Result<readonly TaddyCandidate[],SearchProviderFailure>} */
function parseDocument(value, descriptor) {
  if (!record(value)) return invalid();
  if (value.errors !== undefined) {
    const failure = graphqlFailure(value.errors);
    if (failure !== null) return { ok: false, error: failure };
    return invalid();
  }
  if (
    !record(value.data) || !record(value.data.search) ||
    !Array.isArray(value.data.search.podcastSeries) ||
    !Array.isArray(value.data.search.rankingDetails) ||
    value.data.search.podcastSeries.length > 25 ||
    value.data.search.rankingDetails.length > 25
  ) {
    return invalid();
  }
  /** @type {Map<string,number>} */ const rankings = new Map();
  for (const entry of value.data.search.rankingDetails) {
    if (
      !record(entry) || !uuid(entry.uuid) ||
      typeof entry.rankingScore !== "number" ||
      !Number.isFinite(entry.rankingScore) || entry.rankingScore < 0 ||
      rankings.has(entry.uuid)
    ) return invalid();
    rankings.set(entry.uuid, entry.rankingScore);
  }
  /** @type {Map<string,TaddyCandidate>} */ const candidates = new Map();
  for (const item of value.data.search.podcastSeries) {
    const parsed = parseSeries(item, descriptor, rankings);
    if (!parsed.ok) return parsed;
    if (!candidates.has(parsed.value.canonicalUrl)) {
      candidates.set(parsed.value.canonicalUrl, parsed.value);
    }
  }
  return { ok: true, value: Object.freeze([...candidates.values()]) };
}

/** @param {unknown} value @param {SearchProviderDescriptor} descriptor @param {Map<string,number>} rankings @returns {Result<TaddyCandidate,SearchProviderFailure>} */
function parseSeries(value, descriptor, rankings) {
  if (
    !record(value) || !uuid(value.uuid) || !boundedText(value.name, 500) ||
    !(value.description === null || boundedString(value.description, 5_000)) ||
    !(value.websiteUrl === null || secure(value.websiteUrl)) ||
    !(value.rssUrl === null || typeof value.rssUrl === "string") ||
    !(value.authorName === null || boundedString(value.authorName, 500)) ||
    typeof value.isBlocked !== "boolean" || !record(value.feedRefreshDetails)
  ) return invalid();
  const refresh = value.feedRefreshDetails;
  if (
    !uuid(refresh.uuid) || typeof refresh.priority !== "string" ||
    !PRIORITIES.has(refresh.priority) ||
    !(refresh.priorityReason === null ||
      typeof refresh.priorityReason === "string" &&
        REASONS.has(refresh.priorityReason)) ||
    typeof refresh.dateLastRefreshed !== "number" ||
    !Number.isInteger(refresh.dateLastRefreshed) ||
    refresh.dateLastRefreshed < 0
  ) return invalid();
  const ranking = rankings.get(value.uuid);
  if (ranking === undefined) return invalid();
  if (
    value.isBlocked ||
    refresh.priorityReason === "VIOLATES_TADDY_DISTRIBUTION_POLICY" ||
    refresh.priority === "NEVER" && refresh.priorityReason === null
  ) {
    return {
      ok: false,
      error: { kind: "SearchProviderFeedBlocked", seriesUuid: value.uuid },
    };
  }
  if (refresh.priorityReason === "PRIVATE_PODCAST_FEED") {
    return {
      ok: false,
      error: { kind: "SearchProviderFeedPrivate", seriesUuid: value.uuid },
    };
  }
  if (refresh.priorityReason === "DUPLICATE_FEED") {
    return {
      ok: false,
      error: { kind: "SearchProviderFeedDuplicate", seriesUuid: value.uuid },
    };
  }
  if (
    refresh.priorityReason === "ERROR_PARSING_FEED" ||
    refresh.priorityReason === "FEED_URL_NOT_WORKING"
  ) {
    return {
      ok: false,
      error: { kind: "SearchProviderFeedInvalid", seriesUuid: value.uuid },
    };
  }
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
    Object.freeze({
      attribute: "taddy-ranking-score",
      value: String(ranking),
      provenanceUrl,
    }),
    Object.freeze({
      attribute: "taddy-feed-refresh-priority",
      value: refresh.priority,
      provenanceUrl,
    }),
    Object.freeze({
      attribute: "taddy-feed-last-refreshed",
      value: String(refresh.dateLastRefreshed),
      provenanceUrl,
    }),
    Object.freeze({
      attribute: "podcast-feed",
      value: value.rssUrl,
      provenanceUrl: value.rssUrl,
    }),
  ];
  if (value.websiteUrl !== null) {
    evidence.push(
      Object.freeze({
        attribute: "publisher-page",
        value: value.websiteUrl,
        provenanceUrl: value.websiteUrl,
      }),
    );
  }
  return {
    ok: true,
    value: Object.freeze({
      providerId: descriptor.id,
      resultKind: descriptor.resultKind,
      sourceLevel: "feed",
      title: value.name.trim(),
      description: value.description === null
        ? null
        : value.description.trim() || null,
      canonicalUrl: value.rssUrl,
      publisherLabel: value.authorName === null
        ? null
        : value.authorName.trim() || null,
      publishedAt: null,
      identityEvidence: Object.freeze(evidence),
    }),
  };
}

/** @param {unknown} value @returns {SearchProviderFailure|null} */
function graphqlFailure(value) {
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
  return { kind: "SearchProviderGraphqlRejected", code };
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
/** @param {unknown} value @param {number} maximum @returns {value is string} */
function boundedString(value, maximum) {
  return typeof value === "string" && value.length <= maximum;
}
/** @param {unknown} value @returns {value is number} */
function positive(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
/** @param {unknown} value @returns {value is string} */
function secure(value) {
  return typeof value === "string" && URL.canParse(value) &&
    new URL(value).protocol === "https:";
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
