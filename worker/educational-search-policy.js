// @ts-check

/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{readonly version:string,readonly terms:readonly string[],readonly markers:readonly string[],readonly maximumSubmittedCharacters:number,readonly maximumProviderCharacters:number}} EducationalSearchPolicyConfiguration */
/** @typedef {{readonly submittedQuery:string,readonly providerQuery:string,readonly policyVersion:string}} PreparedEducationalQuery */
/** @typedef {{readonly kind:"EducationalQueryInvalid"}|{readonly kind:"EducationalQueryTooLong",readonly maximum:number}|{readonly kind:"EducationalProviderQueryTooLong",readonly maximum:number}} EducationalSearchFailure */

/**
 * @param {EducationalSearchPolicyConfiguration} configuration
 * @returns {{prepare(input:unknown):Result<PreparedEducationalQuery,EducationalSearchFailure>,accepts(metadata:{readonly title:string,readonly description:string|null}):boolean}}
 */
export function createEducationalSearchPolicy(configuration) {
  if (!validConfiguration(configuration)) {
    throw new TypeError("Invalid educational search policy.");
  }
  const terms = Object.freeze(configuration.terms.map(normalizeTerm));
  const markers = Object.freeze(configuration.markers.map(normalizeTerm));
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
      const existing = tokenSet(submittedQuery);
      const missing = terms.filter((term) => !existing.has(term));
      const providerQuery = [submittedQuery, ...missing].join(" ");
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
    /** @param {{readonly title:string,readonly description:string|null}} metadata */
    accepts(metadata) {
      if (
        typeof metadata?.title !== "string" ||
        (metadata.description !== null &&
          typeof metadata.description !== "string")
      ) throw new TypeError("Invalid educational metadata.");
      const tokens = tokenSet(
        `${metadata.title} ${metadata.description ?? ""}`,
      );
      return markers.some((marker) => tokens.has(marker));
    },
  });
}

/** @param {unknown} value @returns {value is EducationalSearchPolicyConfiguration} */
function validConfiguration(value) {
  if (!record(value) || Object.keys(value).length !== 5) return false;
  return text(value.version) && uniqueText(value.terms) &&
    uniqueText(value.markers) && positive(value.maximumSubmittedCharacters) &&
    positive(value.maximumProviderCharacters);
}

/** @param {string} value */
function normalizeText(value) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** @param {string} value */
function normalizeTerm(value) {
  return normalizeText(value).toLocaleLowerCase("en-US");
}

/** @param {string} value */
function tokenSet(value) {
  const normalized = normalizeTerm(value);
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const result = new Set(tokens);
  for (let start = 0; start < tokens.length; start += 1) {
    for (let end = start + 2; end <= tokens.length; end += 1) {
      result.add(tokens.slice(start, end).join(" "));
    }
  }
  return result;
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

/** @param {unknown} value @returns {value is readonly string[]} */
function uniqueText(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 &&
    value.every(text) &&
    new Set(value.map((entry) => normalizeTerm(entry))).size === value.length;
}
