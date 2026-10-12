// @ts-check

/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{readonly id:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean}} SearchProviderDescriptor */
/** @typedef {{readonly kind:"SearchProviderCredentialMissing"}|{readonly kind:"SearchProviderCredentialRejected"}|{readonly kind:"SearchProviderQuotaExceeded"}|{readonly kind:"SearchProviderUnavailable"}|{readonly kind:"SearchProviderResponseInvalid"}} SearchProviderFailure */
/** @typedef {{readonly providerId:string,readonly query:string,readonly limit:number}} SearchProviderCommand */
/** @typedef {{readonly videoId:string,readonly title:string,readonly description:string|null,readonly channelId:string|null,readonly publisherLabel:string,readonly publishedAt:string,readonly canonicalUrl:string,readonly embedUrl:string,readonly madeForKids:boolean,readonly refreshBy:string}} YouTubeCandidate */
/** @typedef {{readonly providerId:string,readonly resultKind:string,readonly sourceLevel:"video",readonly title:string,readonly description:string|null,readonly canonicalUrl:string,readonly publisherLabel:string,readonly publishedAt:string,readonly identityEvidence:readonly {readonly attribute:string,readonly value:string,readonly provenanceUrl:string}[]}} CentralYouTubeCandidate */

/**
 * @param {{readonly providerId:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean}} configuration
 * @param {{readonly adapter:{search(input:unknown,signal?:AbortSignal):Promise<Result<readonly YouTubeCandidate[],{readonly kind:string}>>}}} dependencies
 */
export function createYouTubeSearchProvider(configuration, dependencies) {
  if (!configurationValid(configuration) || typeof dependencies?.adapter?.search !== "function") {
    throw new TypeError("Invalid YouTube search provider dependencies.");
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
    /** @param {SearchProviderCommand} command @param {import("./discovery-search.js").SearchExecution} [execution] @returns {Promise<Result<readonly CentralYouTubeCandidate[],SearchProviderFailure>>} */
    async search(command, execution) {
      if (execution !== undefined && (!(execution.signal instanceof AbortSignal) || typeof execution.remainingMs !== "function")) throw new TypeError("Invalid YouTube execution budget.");
      if (!commandValid(command, descriptor.id)) throw new TypeError("Invalid YouTube search command.");
      const result = await dependencies.adapter.search({ query: command.query }, execution?.signal);
      if (!result.ok) return { ok: false, error: mapFailure(result.error.kind) };
      /** @type {CentralYouTubeCandidate[]} */ const candidates = [];
      for (const item of result.value) {
        if (!candidateValid(item)) {
          return { ok: false, error: { kind: "SearchProviderResponseInvalid" } };
        }
        candidates.push(Object.freeze({
          providerId: descriptor.id,
          resultKind: descriptor.resultKind,
          sourceLevel: "video",
          title: item.title,
          description: item.description,
          canonicalUrl: item.canonicalUrl,
          publisherLabel: item.publisherLabel,
          publishedAt: item.publishedAt,
          identityEvidence: Object.freeze([Object.freeze({
            attribute: "youtube-api-video-id",
            value: item.videoId,
            provenanceUrl: item.canonicalUrl,
          }),
            ...(item.channelId === null ? [] : [Object.freeze({ attribute: "youtube-channel-id", value: item.channelId, provenanceUrl: item.canonicalUrl })]),
          ]),
        }));
      }
      return { ok: true, value: Object.freeze(candidates.slice(0, command.limit)) };
    },
  });
}

/** @param {string} kind @returns {SearchProviderFailure} */
function mapFailure(kind) {
  if (kind === "YouTubeCredentialMissing") return { kind: "SearchProviderCredentialMissing" };
  if (kind === "YouTubeCredentialRejected" || kind === "YouTubeCredentialRefreshUnavailable") return { kind: "SearchProviderCredentialRejected" };
  if (kind === "YouTubeSearchQuotaExceeded" || kind === "YouTubeGeneralQuotaExceeded" || kind === "YouTubeProviderQuotaExceeded") return { kind: "SearchProviderQuotaExceeded" };
  if (kind === "YouTubeResponseInvalid") return { kind: "SearchProviderResponseInvalid" };
  return { kind: "SearchProviderUnavailable" };
}

/** @param {unknown} value */
function candidateValid(value) {
  return record(value) && Object.keys(value).length === 10 && text(value.videoId) && text(value.title) && (value.description === null || typeof value.description === "string") && (value.channelId === null || text(value.channelId)) && text(value.publisherLabel) &&
    instant(value.publishedAt) && secure(value.canonicalUrl) && secure(value.embedUrl) && typeof value.madeForKids === "boolean" && instant(value.refreshBy);
}
/** @param {unknown} value */
function configurationValid(value) {
  return record(value) && Object.keys(value).length === 5 && [value.providerId, value.label, value.resultKind].every(text) && positive(value.priority) && typeof value.enabled === "boolean";
}
/** @param {unknown} value @param {string} providerId */
function commandValid(value, providerId) { return record(value) && Object.keys(value).length === 3 && value.providerId === providerId && text(value.query) && positive(value.limit); }
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positive(value) { return typeof value === "number" && Number.isInteger(value) && value > 0; }
/** @param {unknown} value @returns {value is string} */
function secure(value) { return typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:" && new URL(value).username === "" && new URL(value).password === "" && new URL(value).hash === ""; }
/** @param {unknown} value */
function instant(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
