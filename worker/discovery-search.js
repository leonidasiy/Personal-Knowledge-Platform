// @ts-check

/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{readonly id:string,readonly label:string,readonly resultKind:string,readonly priority:number,readonly enabled:boolean}} SearchProviderDescriptor */
/** @typedef {{readonly attribute:string,readonly value:string,readonly provenanceUrl:string}} SearchIdentityEvidence */
/** @typedef {{readonly providerId:string,readonly resultKind:string,readonly sourceLevel:"site"|"document"|"feed"|"episode"|"video"|"unknown",readonly title:string,readonly description:string|null,readonly canonicalUrl:string,readonly publisherLabel:string|null,readonly publishedAt:string|null,readonly identityEvidence:readonly SearchIdentityEvidence[]}} CentralSearchCandidate */
/** @typedef {{readonly providerId:string,readonly query:string,readonly limit:number}} SearchProviderCommand */
/** @typedef {{readonly kind:"SearchProviderCredentialMissing"}|{readonly kind:"SearchProviderCredentialRejected"}|{readonly kind:"SearchProviderQuotaExceeded"}|{readonly kind:"SearchProviderTimedOut"}|{readonly kind:"SearchProviderNetworkFailed"}|{readonly kind:"SearchProviderUpstreamRejected",readonly status:number}|{readonly kind:"SearchProviderGraphqlRejected",readonly code:string}|{readonly kind:"SearchProviderUnavailable"}|{readonly kind:"SearchProviderResponseInvalid"}|{readonly kind:"SearchProviderFeedBlocked",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedPrivate",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedDuplicate",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedInvalid",readonly seriesUuid:string}|{readonly kind:"SearchProviderFeedMissing",readonly seriesUuid:string}} SearchProviderFailure */
/** @typedef {{readonly descriptor:SearchProviderDescriptor,search(command:SearchProviderCommand):Promise<Result<readonly CentralSearchCandidate[],SearchProviderFailure>>}} SearchProvider */
/** @typedef {{prepare(input:unknown):Result<{readonly submittedQuery:string,readonly providerQuery:string,readonly policyVersion:string},{readonly kind:string}>,accepts(metadata:{readonly title:string,readonly description:string|null}):boolean}} EducationalSearchPolicy */
/** @typedef {{readonly kind:"CentralSearchCommandInvalid",readonly field:string}|{readonly kind:"CentralSearchProvidersInvalid"}|{readonly kind:"CentralSearchProviderUnknown",readonly providerId:string}|{readonly kind:"CentralSearchProviderDisabled",readonly providerId:string}|{readonly kind:"CentralSearchLimitInvalid",readonly maximum:number}|{readonly kind:"CentralSearchAllProvidersFailed",readonly failures:readonly ProviderFailure[]}|{readonly kind:string}} CentralSearchFailure */
/** @typedef {{readonly providerId:string,readonly failure:SearchProviderFailure}} ProviderFailure */
/** @typedef {{readonly query:string,readonly providerIds:readonly string[],readonly limit:number}} CentralSearchCommand */
/** @typedef {{readonly items:readonly CentralSearchCandidate[],readonly providerFailures:readonly ProviderFailure[],readonly submittedQuery:string,readonly providerQuery:string,readonly policyVersion:string}} CentralSearchResult */

/**
 * @param {{readonly maximumLimit:number}} configuration
 * @param {{readonly policy:EducationalSearchPolicy,readonly providers:readonly SearchProvider[]}} dependencies
 */
export function createCentralDiscoverySearch(configuration, dependencies) {
  if (
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
      const responses = await Promise.all(selected.map(async (provider) => ({
        provider,
        result: await provider.search({
          providerId: provider.descriptor.id,
          query: prepared.value.providerQuery,
          limit: command.value.limit,
        }),
      })));
      /** @type {ProviderFailure[]} */ const providerFailures = [];
      /** @type {Map<string,CentralSearchCandidate>} */ const canonical =
        new Map();
      let successfulProviders = 0;
      for (const response of responses) {
        if (!response.result.ok) {
          providerFailures.push(Object.freeze({
            providerId: response.provider.descriptor.id,
            failure: response.result.error,
          }));
          continue;
        }
        let responseValid = true;
        for (const item of response.result.value) {
          if (!candidateValid(item, response.provider.descriptor)) {
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
        successfulProviders += 1;
        for (const item of response.result.value) {
          if (
            dependencies.policy.accepts({
              title: item.title,
              description: item.description,
            }) && !canonical.has(item.canonicalUrl)
          ) canonical.set(item.canonicalUrl, item);
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
      return {
        ok: true,
        value: Object.freeze({
          items: Object.freeze(
            [...canonical.values()].slice(0, command.value.limit),
          ),
          providerFailures: Object.freeze(providerFailures),
          ...prepared.value,
        }),
      };
    },
  });
}

/** @param {unknown} input @param {number} maximum @returns {Result<CentralSearchCommand,CentralSearchFailure>} */
function commandValue(input, maximum) {
  if (!record(input) || Object.keys(input).length !== 3) {
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
  return {
    ok: true,
    value: Object.freeze({
      query: input.query,
      providerIds: Object.freeze([...input.providerIds]),
      limit: input.limit,
    }),
  };
}

/** @param {unknown} value @returns {value is EducationalSearchPolicy} */
function validPolicy(value) {
  return record(value) && typeof value.prepare === "function" &&
    typeof value.accepts === "function";
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

/** @param {unknown} value @param {SearchProviderDescriptor} descriptor @returns {value is CentralSearchCandidate} */
function candidateValid(value, descriptor) {
  return record(value) && Object.keys(value).length === 9 &&
    value.providerId === descriptor.id &&
    value.resultKind === descriptor.resultKind &&
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
    new URL(value).protocol === "https:";
}

/** @param {unknown} value */
function instant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
