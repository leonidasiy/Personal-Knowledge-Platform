// @ts-check

const freeze = Object.freeze;

/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{readonly kind:"DiscoveryGatewayCommandInvalid",readonly field:string}|{readonly kind:"DiscoveryGatewayUnauthenticated"}|{readonly kind:"DiscoveryGatewayUnauthorized"}|{readonly kind:"DiscoveryGatewayRateLimited"}|{readonly kind:"DiscoveryGatewayUnavailable"}|{readonly kind:"DiscoveryGatewayTimedOut"}|{readonly kind:"DiscoveryGatewayResponseInvalid"}|{readonly kind:"DiscoveryGatewayRejected",readonly failureKind:string}} DiscoveryGatewayFailure */
/** @typedef {{readonly id:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean}} GatewaySearchCapability */
/** @typedef {{readonly providerId:string,readonly resultKind:string,readonly sourceLevel:"site"|"document"|"feed"|"episode"|"video"|"unknown",readonly title:string,readonly description:string|null,readonly canonicalUrl:string,readonly publisherLabel:string|null,readonly publishedAt:string|null,readonly identityEvidence:readonly {readonly attribute:string,readonly value:string,readonly provenanceUrl:string}[]}} GatewayCentralCandidate */
/** @typedef {{readonly items:readonly GatewayCentralCandidate[],readonly providerFailures:readonly {readonly providerId:string,readonly failure:{readonly kind:string}}[],readonly submittedQuery:string,readonly providerQuery:string,readonly policyVersion:string,readonly nextCursors?:Readonly<Record<string,string>>}} GatewayCentralSearchResult */
/** @typedef {{readonly canonicalUrl:string,readonly text:string}} GatewayPublisherTranscript */

export class DiscoverySearchGatewayClient {
  /** @type {typeof fetch} */ #fetch;
  /** @type {URL} */ #base;
  /** @type {number} */ #timeout;

  /** @param {{readonly fetch:typeof fetch,readonly baseUrl:string,readonly timeoutMs:number}} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies.fetch !== "function" ||
      !URL.canParse(dependencies.baseUrl) ||
      !Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1
    ) {
      throw new TypeError("Discovery gateway dependencies are invalid.");
    }
    this.#base = new URL(dependencies.baseUrl);
    if (
      this.#base.protocol !== "https:" && this.#base.hostname !== "localhost"
    ) {
      throw new TypeError(
        "Discovery gateway must use HTTPS outside localhost.",
      );
    }
    this.#fetch = dependencies.fetch;
    this.#timeout = dependencies.timeoutMs;
  }

  /** @returns {Promise<Result<readonly GatewaySearchCapability[],DiscoveryGatewayFailure>>} */
  async capabilities() {
    const response = await this.request("GET", "api/discovery/search/capabilities", null);
    if (!response.ok) return response;
    const values = record(response.value) ? response.value.result : null;
    if (!Array.isArray(values) || values.length === 0 || values.length > 20) return bad();
    /** @type {GatewaySearchCapability[]} */ const items = [];
    for (const value of values) {
      if (!capability(value)) return bad();
      items.push(freeze({ ...value }));
    }
    return { ok: true, value: freeze(items) };
  }

  /** @param {unknown} command @returns {Promise<Result<GatewayCentralSearchResult,DiscoveryGatewayFailure>>} */
  async search(command) {
    if (!validCentralSearchCommand(command)) return invalid("command");
    const response = await this.post("api/discovery/search", command);
    if (!response.ok) return response;
    const value = record(response.value) ? response.value.result : null;
    return centralResult(value);
  }

  /** @param {string} path @param {unknown} body @returns {Promise<Result<unknown,DiscoveryGatewayFailure>>} */
  async post(path, body) {
    return this.request("POST", path, body);
  }

  /** @param {"GET"|"POST"} method @param {string} path @param {unknown|null} body @returns {Promise<Result<unknown,DiscoveryGatewayFailure>>} */
  async request(method, path, body) {
    const controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timeout;
    const deadline=new Promise((resolve)=>{timeout=setTimeout(()=>{controller.abort();resolve(/** @type {Result<never,DiscoveryGatewayFailure>} */({ok:false,error:{kind:"DiscoveryGatewayTimedOut"}}));},this.#timeout);});
    /** @returns {Promise<Result<unknown,DiscoveryGatewayFailure>>} */
    const work=async()=>{
    /** @type {Response} */ let response;
    try {
      response = await (0, this.#fetch)(new URL(path, this.#base), {
        method,
        credentials: "same-origin",
        headers: method === "POST"
          ? { "content-type": "application/json", accept: "application/json" }
          : { accept: "application/json" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if(timeout!==undefined)clearTimeout(timeout);
      if (controller.signal.aborted) {
        return { ok: false, error: { kind: "DiscoveryGatewayTimedOut" } };
      }
      if (error instanceof TypeError) {
        return { ok: false, error: { kind: "DiscoveryGatewayUnavailable" } };
      }
      throw error;
    }
    if (controller.signal.aborted) {if(timeout!==undefined)clearTimeout(timeout); return {ok:false,error:{kind:"DiscoveryGatewayTimedOut"}};}
    const statusFailure = /** @type {const} */ ({
      401: "DiscoveryGatewayUnauthenticated",
      403: "DiscoveryGatewayUnauthorized",
    })[response.status];
    if (statusFailure !== undefined) {
      if(timeout!==undefined)clearTimeout(timeout);
      return { ok: false, error: { kind: statusFailure } };
    }
    /** @type {unknown} */ let document;
    try {
      document = await response.json();
    } catch (error) {
      if (controller.signal.aborted) return {ok:false,error:{kind:"DiscoveryGatewayTimedOut"}};
      if (error instanceof SyntaxError) return bad();
      throw error;
    }
    if (controller.signal.aborted) return {ok:false,error:{kind:"DiscoveryGatewayTimedOut"}};
    if (!response.ok) {
      const failureKind = record(document) ? text(document.error) : null;
      return failureKind === null
        ? response.status === 429
          ? { ok: false, error: { kind: "DiscoveryGatewayRateLimited" } }
          : bad()
        : {
          ok: false,
          error: { kind: "DiscoveryGatewayRejected", failureKind },
        };
    }
    return { ok: true, value: document };
    };
    try {return /** @type {Result<unknown,DiscoveryGatewayFailure>} */(await Promise.race([work(),deadline]));}
    finally {if(timeout!==undefined)clearTimeout(timeout);}
  }
}

/**
 * Publisher transcript retrieval stays available to the later ingestion
 * boundary without adding its rights workflow to the interactive search bundle.
 */
export class DiscoveryGatewayClient extends DiscoverySearchGatewayClient {
  /** @param {unknown} command @returns {Promise<Result<GatewayPublisherTranscript,DiscoveryGatewayFailure>>} */
  async retrievePublisherTranscript(command) {
    if (!record(command)) return invalid("command");
    const transcriptUrl = publisherUrl(command.url),
      requestId = text(command.id),
      language = text(command.lang),
      evidenceId = text(command.evidenceId),
      evidenceBasis = text(command.basis),
      evidenceReference = secureUrl(command.rights),
      attributionText = text(command.credit),
      rightsExpiresAt = instant(command.expires),
      startCharacter = command.start,
      characterCount = command.count;
    if (transcriptUrl === null) return invalid("transcriptUrl");
    if (
      !requestId || !language || !evidenceId || !evidenceBasis ||
      !evidenceReference || !attributionText || !rightsExpiresAt
    ) return invalid("command");
    if (
      !Number.isInteger(startCharacter) ||
      /** @type {number} */ (startCharacter) < 0 ||
      !Number.isInteger(characterCount) ||
      /** @type {number} */ (characterCount) < 1 ||
      /** @type {number} */ (characterCount) > 8_000
    ) return invalid("command");
    const authorized = await this.post(
      "api/discovery/publisher-transcript/authorize",
      {
        evidenceId,
        transcriptUrl,
        attributionText,
        evidenceBasis,
        evidenceReference,
        expiresAt: rightsExpiresAt,
      },
    );
    if (!authorized.ok) return authorized;
    if (!record(authorized.value) || authorized.value.stored !== true) {
      return bad();
    }
    const response = await this.post("api/discovery/publisher-transcript", {
      requestId,
      transcriptUrl,
      evidenceId,
      language,
      jsonTextPath: null,
      retention: { mode: "excerpt", startCharacter, characterCount },
    });
    if (!response.ok) return response;
    const value = record(response.value) ? response.value.result : null;
    if (!record(value)) return bad();
    const canonicalUrl = publisherUrl(value.canonicalUrl),
      textValue = text(value.text);
    if (
      canonicalUrl === null || textValue === null ||
      textValue.length > /** @type {number} */ (characterCount) ||
      value.retentionMode !== "excerpt" ||
      value.rightsExpiresAt !== rightsExpiresAt
    ) return bad();
    return {
      ok: true,
      value: freeze({
        canonicalUrl,
        text: textValue,
      }),
    };
  }
}

/** @param {unknown} value */
function capability(value) {
  return record(value) && Object.keys(value).length === 5 && text(value.id) !== null &&
    text(value.label) !== null && text(value.resultKind) !== null &&
    Number.isInteger(value.priority) && /** @type {number} */ (value.priority) > 0 &&
    typeof value.enabled === "boolean";
}

/** @param {unknown} value @returns {value is {query:string,providerIds:readonly string[],limit:number,cursors?:Readonly<Record<string,string>>}} */
export function validCentralSearchCommand(value) {
  return record(value) && Object.keys(value).every(key => ["query","providerIds","limit","cursors"].includes(key)) && (value.cursors === undefined || cursorMap(value.cursors) && Object.keys(value.cursors).every(id => Array.isArray(value.providerIds) && value.providerIds.includes(id))) && text(value.query) !== null &&
    Array.isArray(value.providerIds) && value.providerIds.length > 0 && value.providerIds.length <= 20 &&
    value.providerIds.every((providerId) => text(providerId) !== null) &&
    new Set(value.providerIds).size === value.providerIds.length &&
    Number.isInteger(value.limit) && /** @type {number} */ (value.limit) > 0 && /** @type {number} */ (value.limit) <= 20;
}

/** @param {unknown} value @returns {Result<GatewayCentralSearchResult,DiscoveryGatewayFailure>} */
function centralResult(value) {
  if (!record(value) || Object.keys(value).some(key => !["items","providerFailures","submittedQuery","providerQuery","policyVersion","nextCursors"].includes(key)) || (value.nextCursors !== undefined && !cursorMap(value.nextCursors)) || !Array.isArray(value.items) || value.items.length > 20 ||
    !Array.isArray(value.providerFailures) || value.providerFailures.length > 20 ||
    text(value.submittedQuery) === null || text(value.providerQuery) === null || text(value.policyVersion) === null ||
    !value.items.every(centralCandidate) || !value.providerFailures.every(failure => record(failure) && Object.keys(failure).length === 2 && text(failure.providerId) !== null && record(failure.failure) && text(failure.failure.kind) !== null)) return bad();
  return {ok:true,value:freeze(/** @type {GatewayCentralSearchResult} */(value))};
}

/** @param {unknown} value @param {readonly string[]} choices @returns {value is string} */
function choice(value,choices) { return typeof value === "string" && choices.includes(value); }

/** @param {unknown} value @returns {value is GatewayCentralCandidate} */
function centralCandidate(value) {
  return record(value) && Object.keys(value).length === 9 && text(value.providerId) !== null && text(value.resultKind) !== null &&
    choice(value.sourceLevel, ["site", "document", "feed", "episode", "video", "unknown"]) && text(value.title) !== null &&
    (value.description === null || typeof value.description === "string") && secureUrl(value.canonicalUrl) !== null &&
    (value.publisherLabel === null || text(value.publisherLabel) !== null) &&
    (value.publishedAt === null || instant(value.publishedAt) !== null) && Array.isArray(value.identityEvidence) && value.identityEvidence.length > 0 &&
    value.identityEvidence.length <= 10 && value.identityEvidence.every((entry) => record(entry) && Object.keys(entry).length === 3 &&
      text(entry.attribute) !== null && text(entry.value) !== null && secureUrl(entry.provenanceUrl) !== null);
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** @param {unknown} value */
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
/** @param {unknown} value */
/** @param {unknown} value */
function instant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}
/** @param {unknown} value */
function secureUrl(value) {
  return typeof value === "string" && URL.canParse(value) &&
      new URL(value).protocol === "https:" && new URL(value).username === "" && new URL(value).password === "" && new URL(value).hash === ""
    ? value
    : null;
}
/** @param {unknown} value */
function publisherUrl(value) {
  const url = secureUrl(value);
  if (url === null) return null;
  const host = new URL(url).hostname.toLowerCase();
  return host === "youtu.be" || host === "youtube.com" ||
      host.endsWith(".youtube.com")
    ? null
    : url;
}
/** @returns {Result<never,DiscoveryGatewayFailure>} */
function bad() {
  return { ok: false, error: { kind: "DiscoveryGatewayResponseInvalid" } };
}
/** @param {string} field @returns {Result<never,DiscoveryGatewayFailure>} */
function invalid(field) {
  return {
    ok: false,
    error: { kind: "DiscoveryGatewayCommandInvalid", field },
  };
}

export {};

/** @param {unknown} value @returns {value is Record<string,string>} */
function cursorMap(value) { return record(value) && Object.entries(value).every(([id,cursor]) => text(id) !== null && text(cursor) !== null); }
