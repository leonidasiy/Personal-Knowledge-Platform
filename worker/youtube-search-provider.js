// @ts-check

/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{readonly id:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean}} SearchProviderDescriptor */
/** @typedef {{readonly kind:"SearchProviderCredentialMissing"}|{readonly kind:"SearchProviderCredentialRejected"}|{readonly kind:"SearchProviderQuotaExceeded"}|{readonly kind:"SearchProviderUnavailable"}|{readonly kind:"SearchProviderResponseInvalid"}} SearchProviderFailure */
/** @typedef {{readonly providerId:string,readonly query:string,readonly limit:number}} SearchProviderCommand */
/** @typedef {{readonly videoId:string,readonly title:string,readonly publisherLabel:string,readonly publishedAt:string,readonly canonicalUrl:string,readonly embedUrl:string,readonly madeForKids:boolean,readonly refreshBy:string}} YouTubeCandidate */
/** @typedef {{readonly providerId:string,readonly resultKind:string,readonly sourceLevel:"video",readonly title:string,readonly description:null,readonly canonicalUrl:string,readonly publisherLabel:string,readonly publishedAt:string,readonly identityEvidence:readonly {readonly attribute:string,readonly value:string,readonly provenanceUrl:string}[]}} CentralYouTubeCandidate */

/**
 * @param {{readonly providerId:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean}} configuration
 * @param {{readonly adapter:{search(input:unknown):Promise<Result<readonly YouTubeCandidate[],{readonly kind:string}>>}}} dependencies
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
    /** @param {SearchProviderCommand} command @returns {Promise<Result<readonly CentralYouTubeCandidate[],SearchProviderFailure>>} */
    async search(command) {
      if (!commandValid(command, descriptor.id)) throw new TypeError("Invalid YouTube search command.");
      const result = await dependencies.adapter.search({ query: command.query });
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
          description: null,
          canonicalUrl: item.canonicalUrl,
          publisherLabel: item.publisherLabel,
          publishedAt: item.publishedAt,
          identityEvidence: Object.freeze([Object.freeze({
            attribute: "official-youtube-video",
            value: item.videoId,
            provenanceUrl: item.canonicalUrl,
          })]),
        }));
      }
      return { ok: true, value: Object.freeze(candidates) };
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
  return record(value) && Object.keys(value).length === 8 && text(value.videoId) && text(value.title) && text(value.publisherLabel) &&
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
function secure(value) { return typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:"; }
/** @param {unknown} value */
function instant(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
