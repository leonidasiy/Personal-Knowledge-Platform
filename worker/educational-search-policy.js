// @ts-check

/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{readonly version:string,readonly maximumSubmittedCharacters:number,readonly maximumProviderCharacters:number}} EducationalSearchPolicyConfiguration */
/** @typedef {{readonly submittedQuery:string,readonly providerQuery:string,readonly policyVersion:string}} PreparedEducationalQuery */
/** @typedef {{readonly kind:"EducationalQueryInvalid"}|{readonly kind:"EducationalQueryTooLong",readonly maximum:number}|{readonly kind:"EducationalProviderQueryTooLong",readonly maximum:number}} EducationalSearchFailure */

/**
 * @param {EducationalSearchPolicyConfiguration} configuration
 * @returns {{prepare(input:unknown):Result<PreparedEducationalQuery,EducationalSearchFailure>}}
 */
export function createEducationalSearchPolicy(configuration) {
  if (!validConfiguration(configuration)) {
    throw new TypeError("Invalid educational search policy.");
  }
  const version = configuration.version.trim();
  const maximumSubmittedCharacters = configuration.maximumSubmittedCharacters;
  const maximumProviderCharacters = configuration.maximumProviderCharacters;
  return Object.freeze({
    /** @param {unknown} input */
    prepare(input) {
      if (typeof input !== "string") {
        return { ok: false, error: { kind: "EducationalQueryInvalid" } };
      }
      const submittedQuery = normalizeText(input);
      if (submittedQuery === "") {
        return { ok: false, error: { kind: "EducationalQueryInvalid" } };
      }
      if (submittedQuery.length > maximumSubmittedCharacters) {
        return {
          ok: false,
          error: {
            kind: "EducationalQueryTooLong",
            maximum: maximumSubmittedCharacters,
          },
        };
      }
      const providerQuery = submittedQuery;
      if (providerQuery.length > maximumProviderCharacters) {
        return {
          ok: false,
          error: {
            kind: "EducationalProviderQueryTooLong",
            maximum: maximumProviderCharacters,
          },
        };
      }
      return {
        ok: true,
        value: Object.freeze({
          submittedQuery,
          providerQuery,
          policyVersion: version,
        }),
      };
    },

  });
}

/** @param {unknown} value @returns {value is EducationalSearchPolicyConfiguration} */
function validConfiguration(value) {
  if (!record(value) || Object.keys(value).length !== 3) return false;
  return text(value.version) && positive(value.maximumSubmittedCharacters) &&
    positive(value.maximumProviderCharacters);
}

/** @param {string} value */
function normalizeText(value) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
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
