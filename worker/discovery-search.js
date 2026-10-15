// @ts-check

/** @template T @template E @typedef {{readonly ok:true,readonly value:T,readonly nextCursor?:string}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{readonly id:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean}} SearchProviderDescriptor */
/** @typedef {{readonly attribute:string,readonly value:string,readonly provenanceUrl:string}} SearchIdentityEvidence */
/** @typedef {{readonly providerId:string,readonly resultKind:string,readonly sourceLevel:"site"|"document"|"feed"|"episode"|"video"|"unknown",readonly title:string,readonly description:string|null,readonly canonicalUrl:string,readonly publisherLabel:string|null,readonly publishedAt:string|null,readonly identityEvidence:readonly SearchIdentityEvidence[]}} CentralSearchCandidate */
/** @typedef {{readonly providerId:string,readonly query:string,readonly limit:number,readonly cursor?:string}} SearchProviderCommand */
/** @typedef {{readonly kind:"SearchProviderCredentialMissing"}|{readonly kind:"SearchProviderCredentialRejected"}|{readonly kind:"SearchProviderQuotaExceeded"}|{readonly kind:"SearchProviderTimedOut"}|{readonly kind:"SearchProviderNetworkFailed"}|{readonly kind:"SearchProviderUpstreamRejected",readonly status:number}|{readonly kind:"SearchProviderQueryInvalid",readonly reason:"argument"|"complexity"|"field"|"input"|"syntax"|"variable"|"unspecified",readonly diagnosticTokens:readonly string[]}|{readonly kind:"SearchProviderInputInvalid"}|{readonly kind:"SearchProviderQueryTooComplex"}|{readonly kind:"SearchProviderGraphqlRejected",readonly code:string}|{readonly kind:"SearchProviderUnavailable"}|{readonly kind:"SearchProviderResponseInvalid"}|{readonly kind:"SearchProviderFeedBlocked",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedPrivate",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedDuplicate",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedInvalid",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedMissing",readonly seriesUuid:string}} SearchProviderFailure */
/** @typedef {{readonly signal:AbortSignal,remainingMs():number}} SearchExecution */
/** @typedef {{readonly descriptor:SearchProviderDescriptor,search(command:SearchProviderCommand,execution?:SearchExecution):Promise<Result<readonly CentralSearchCandidate[],SearchProviderFailure>>}} SearchProvider */
/** @typedef {{prepare(input:unknown):Result<{readonly submittedQuery:string,readonly providerQuery:string,readonly policyVersion:string},import("./educational-search-policy.js").EducationalSearchFailure>}} EducationalSearchPolicy */
/** @typedef {{readonly kind:"CentralSearchTimedOut",readonly stage:"providers"}|{readonly kind:"CentralSearchCommandInvalid",readonly field:string}|{readonly kind:"CentralSearchProvidersInvalid"}|{readonly kind:"CentralSearchProviderUnknown",readonly providerId:string}|{readonly kind:"CentralSearchProviderDisabled",readonly providerId:string}|{readonly kind:"CentralSearchLimitInvalid",readonly maximum:number}|{readonly kind:"CentralSearchAllProvidersFailed",readonly failures:readonly ProviderFailure[]}|import("./educational-search-policy.js").EducationalSearchFailure} CentralSearchFailure */
/** @typedef {{readonly providerId:string,readonly failure:SearchProviderFailure}} ProviderFailure */
/** @typedef {{readonly query:string,readonly providerIds:readonly string[],readonly limit:number,readonly cursors?:Readonly<Record<string,string>>}} CentralSearchCommand */
/** @typedef {{readonly items:readonly CentralSearchCandidate[],readonly providerFailures:readonly ProviderFailure[],readonly submittedQuery:string,readonly providerQuery:string,readonly policyVersion:string,readonly nextCursors?:Readonly<Record<string,string>>}} CentralSearchResult */

/**
 * @param {{readonly maximumLimit:number}} configuration
 * @param {{readonly policy:EducationalSearchPolicy,readonly providers:readonly SearchProvider[],readonly budget:{readonly timeoutMs:number,readonly now:()=>number,readonly timeoutSignal:(milliseconds:number)=>AbortSignal}}} dependencies
 */
export function createCentralDiscoverySearch(configuration, dependencies) {
  if (
    !positive(dependencies?.budget?.timeoutMs) || dependencies.budget.timeoutMs >= 30_000 || typeof dependencies.budget.now !== "function" || typeof dependencies.budget.timeoutSignal !== "function" ||
    !record(configuration) || Object.keys(configuration).length !== 1 ||
    !positive(configuration.maximumLimit) ||
    !validPolicy(dependencies?.policy) ||
    !providersValid(dependencies?.providers)
  ) throw new TypeError("Invalid central search dependencies.");
  const maximumLimit = configuration.maximumLimit;
  const providers = [...dependencies.providers].sort((left, right) =>
    left.descriptor.priority - right.descriptor.priority ||
    left.descriptor.id.localeCompare(right.descriptor.id)
  );
  const byId = new Map(
    providers.map((provider) => [provider.descriptor.id, provider]),
  );
  return Object.freeze({
    capabilities() {
      return Object.freeze(providers.map((provider) => provider.descriptor));
    },
    /** @param {unknown} input @returns {Promise<Result<CentralSearchResult,CentralSearchFailure>>} */
    async search(input) {
      const command = commandValue(input, maximumLimit);
      if (!command.ok) return command;
      const prepared = dependencies.policy.prepare(command.value.query);
      if (!prepared.ok) return prepared;
      /** @type {SearchProvider[]} */ const selected = [];
      for (const providerId of command.value.providerIds) {
        const provider = byId.get(providerId);
        if (provider === undefined) {
          return {
            ok: false,
            error: { kind: "CentralSearchProviderUnknown", providerId },
          };
        }
        if (!provider.descriptor.enabled) {
          return {
            ok: false,
            error: { kind: "CentralSearchProviderDisabled", providerId },
          };
        }
        selected.push(provider);
      }
      selected.sort((left, right) =>
        left.descriptor.priority - right.descriptor.priority ||
        left.descriptor.id.localeCompare(right.descriptor.id)
      );
      selected.splice(command.value.limit);
      const providerLimit = (/** @type {number} */ index) => Math.floor(command.value.limit / selected.length) + (index < command.value.limit % selected.length ? 1 : 0);
      const startedAt = dependencies.budget.now();
      if (!Number.isFinite(startedAt)) throw new TypeError("Invalid discovery budget clock.");
      const deadline = startedAt + dependencies.budget.timeoutMs;
      const signal = dependencies.budget.timeoutSignal(dependencies.budget.timeoutMs);
      if (!(signal instanceof AbortSignal)) throw new TypeError("Invalid discovery budget signal.");
      const execution = Object.freeze({signal, remainingMs: () => {
        const now = dependencies.budget.now();
        if (!Number.isFinite(now) || now < startedAt) throw new TypeError("Invalid discovery budget clock.");
        return Math.max(0, deadline - now);
      }});
      if (signal.aborted || execution.remainingMs() <= 0) return {ok:false,error:{kind:"CentralSearchTimedOut",stage:"providers"}};
      const responsesResult = await bounded(Promise.all(selected.map(async (provider, index) => ({
        provider,
        result: await provider.search({
          providerId: provider.descriptor.id,
          query: prepared.value.providerQuery,
          limit: providerLimit(index),
          ...(command.value.cursors?.[provider.descriptor.id] === undefined ? {} : {cursor:command.value.cursors[provider.descriptor.id]}),
        }, execution),
      }))), execution, "providers");
      if (!responsesResult.ok) return responsesResult;
      const responses = responsesResult.value;
      /** @type {Record<string,string>} */ const nextCursors = {};
      /** @type {ProviderFailure[]} */ const providerFailures = [];
      /** @type {CentralSearchCandidate[]} */ const pool = [];
      let successfulProviders = 0;
      for (const response of responses) {
        if (!response.result.ok) {
          providerFailures.push(Object.freeze({
            providerId: response.provider.descriptor.id,
            failure: response.result.error,
          }));
          continue;
        }
        let responseValid = Array.isArray(response.result.value) && response.result.value.length <= providerLimit(selected.indexOf(response.provider));
        responseValid = responseValid && (response.result.nextCursor === undefined || text(response.result.nextCursor));
        if (!responseValid) {
          providerFailures.push({providerId:response.provider.descriptor.id, failure:{kind:"SearchProviderResponseInvalid"}});
          continue;
        }
        for (const item of response.result.value) {
          if (!centralSearchCandidateValid(item) || item.providerId !== response.provider.descriptor.id || item.resultKind !== response.provider.descriptor.resultKind) {
            providerFailures.push(Object.freeze({
              providerId: response.provider.descriptor.id,
              failure: {
                kind: /** @type {const} */ ("SearchProviderResponseInvalid"),
              },
            }));
            responseValid = false;
            break;
          }
        }
        if (!responseValid) continue;
        if (response.result.nextCursor !== undefined) nextCursors[response.provider.descriptor.id] = response.result.nextCursor;
        successfulProviders += 1;
        for (const item of response.result.value) {
          pool.push(item);
        }
      }
      if (successfulProviders === 0) {
        return {
          ok: false,
          error: {
            kind: "CentralSearchAllProvidersFailed",
            failures: Object.freeze(providerFailures),
          },
        };
      }
      if (signal.aborted || execution.remainingMs() <= 0) return {ok:false,error:{kind:"CentralSearchTimedOut",stage:"providers"}};
      return {
        ok: true,
        value: Object.freeze({
          ...(Object.keys(nextCursors).length ? {nextCursors:Object.freeze(nextCursors)} : {}),
          items: Object.freeze(pool.slice(0, command.value.limit)),
          providerFailures: Object.freeze(providerFailures),
          ...prepared.value,
        }),
      };
    },
  });
}

/** @param {unknown} input @param {number} maximum @returns {Result<CentralSearchCommand,CentralSearchFailure>} */
function commandValue(input, maximum) {
  if (!record(input) || Object.keys(input).some(key => !["query","providerIds","limit","cursors"].includes(key))) {
    return {
      ok: false,
      error: { kind: "CentralSearchCommandInvalid", field: "command" },
    };
  }
  if (typeof input.query !== "string") {
    return {
      ok: false,
      error: { kind: "CentralSearchCommandInvalid", field: "query" },
    };
  }
  if (
    !Array.isArray(input.providerIds) || input.providerIds.length === 0 ||
    input.providerIds.length > 20 || !input.providerIds.every(text) ||
    new Set(input.providerIds).size !== input.providerIds.length
  ) {
    return { ok: false, error: { kind: "CentralSearchProvidersInvalid" } };
  }
  if (!positive(input.limit) || input.limit > maximum) {
    return {
      ok: false,
      error: { kind: "CentralSearchLimitInvalid", maximum },
    };
  }
  if (input.cursors !== undefined && (!record(input.cursors) || Object.entries(input.cursors).some(([id,cursor]) => !/** @type {string[]} */ (input.providerIds).includes(id) || !text(cursor)))) return {ok:false,error:{kind:"CentralSearchCommandInvalid",field:"cursors"}};
  return {
    ok: true,
    value: Object.freeze({
      ...(input.cursors === undefined ? {} : {cursors: /** @type {Record<string,string>} */ (input.cursors)}),
      query: input.query,
      providerIds: Object.freeze([...input.providerIds]),
      limit: input.limit,
    }),
  };
}

/** @param {unknown} value @returns {value is EducationalSearchPolicy} */
function validPolicy(value) {
  return record(value) && typeof value.prepare === "function";
}

/** @param {unknown} value @returns {value is readonly SearchProvider[]} */
function providersValid(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    return false;
  }
  const ids = new Set();
  const priorities = new Set();
  for (const provider of value) {
    if (
      !record(provider) || Object.keys(provider).length !== 2 ||
      typeof provider.search !== "function" ||
      !descriptorValid(provider.descriptor) ||
      ids.has(provider.descriptor.id) ||
      priorities.has(provider.descriptor.priority)
    ) return false;
    ids.add(provider.descriptor.id);
    priorities.add(provider.descriptor.priority);
  }
  return true;
}

/** @param {unknown} value @returns {value is SearchProviderDescriptor} */
function descriptorValid(value) {
  return record(value) && Object.keys(value).length === 5 && text(value.id) &&
    text(value.label) && text(value.resultKind) && positive(value.priority) &&
    typeof value.enabled === "boolean";
}

/** @param {unknown} value @returns {value is CentralSearchCandidate} */
export function centralSearchCandidateValid(value) {
  return record(value) && Object.keys(value).length === 9 &&
    text(value.providerId) && text(value.resultKind) &&
    sourceLevel(value.sourceLevel) && text(value.title) &&
    (value.description === null || typeof value.description === "string") &&
    secure(value.canonicalUrl) &&
    (value.publisherLabel === null || text(value.publisherLabel)) &&
    (value.publishedAt === null || instant(value.publishedAt)) &&
    Array.isArray(value.identityEvidence) &&
    value.identityEvidence.length > 0 &&
    value.identityEvidence.length <= 10 &&
    value.identityEvidence.every(evidence);
}

/** @param {unknown} value */
function evidence(value) {
  return record(value) && Object.keys(value).length === 3 &&
    text(value.attribute) && text(value.value) && secure(value.provenanceUrl);
}

/** @param {unknown} value */
function sourceLevel(value) {
  return value === "site" || value === "document" || value === "feed" ||
    value === "episode" || value === "video" || value === "unknown";
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value @returns {value is number} */
function positive(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @param {unknown} value */
function secure(value) {
  return typeof value === "string" && URL.canParse(value) &&
    new URL(value).protocol === "https:" && new URL(value).username === "" && new URL(value).password === "" && new URL(value).hash === "";
}

/** @param {unknown} value */
function instant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** @template T @param {Promise<T>} operation @param {SearchExecution} execution @param {"providers"} stage @returns {Promise<Result<T,{readonly kind:"CentralSearchTimedOut",readonly stage:"providers"}>>} */
async function bounded(operation, execution, stage) {
  const failure = {ok: /** @type {const} */(false),error:{kind: /** @type {const} */("CentralSearchTimedOut"),stage}};
  /** @type {()=>void} */ let abort = () => {};
  const timeout = new Promise(resolve => {abort = () => resolve(failure); execution.signal.addEventListener("abort",abort,{once:true});});
  try {
    if (execution.signal.aborted || execution.remainingMs() <= 0) return failure;
    const result = await Promise.race([operation.then(value => ({ok: /** @type {const} */(true),value})),timeout]);
    if (execution.signal.aborted || execution.remainingMs() <= 0) return failure;
    return /** @type {Result<T,{readonly kind:"CentralSearchTimedOut",readonly stage:"providers"}>} */(result);
  } finally { execution.signal.removeEventListener("abort",abort); }
}
