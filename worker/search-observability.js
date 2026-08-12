// @ts-check

/** @typedef {{readonly ok:true,readonly value:unknown}|{readonly ok:false,readonly error:unknown}} CentralSearchResult */
/** @typedef {{ readonly capabilities: () => readonly unknown[], readonly search: (command: unknown) => Promise<CentralSearchResult> }} CentralSearchPort */
/** @typedef {(event: Readonly<Record<string, unknown>>) => void} SearchEventLogger */

/**
 * Adds content-free lifecycle evidence around centralized discovery search.
 * The logger receives only fixed event and failure-kind fields.
 *
 * @template {CentralSearchPort} T
 * @param {T} search
 * @param {SearchEventLogger} log
 * @returns {T}
 */
export function instrumentCentralSearch(search, log) {
  if (
    search === null || typeof search !== "object" ||
    typeof search.capabilities !== "function" ||
    typeof search.search !== "function" || typeof log !== "function"
  ) throw new TypeError("Central search observability configuration is invalid.");
  return /** @type {T} */ (/** @type {unknown} */ (Object.freeze({
    capabilities: () => search.capabilities(),
    async search(/** @type {unknown} */ command) {
      log(Object.freeze({ event: "central-search-entry" }));
      const result = await search.search(command);
      if (record(result) && result.ok === true) {
        log(Object.freeze({ event: "central-search-success" }));
        return result;
      }
      const error = record(result) && record(result.error) ? result.error : null;
      log(Object.freeze({
        event: "central-search-failure",
        failureKind: error !== null && typeof error.kind === "string"
          ? error.kind
          : "CentralSearchFailureInvalid",
        providerFailureKinds: Object.freeze(providerFailureKinds(error)),
        providerFailureReasons: Object.freeze(providerFailureReasons(error)),
        providerDiagnosticTokens: Object.freeze(providerDiagnosticTokens(error)),
        upstreamStatuses: Object.freeze(upstreamStatuses(error)),
      }));
      return result;
    },
  })));
}

/** @param {Record<string, unknown>|null} error */
function providerDiagnosticTokens(error) {
  if (error === null || !Array.isArray(error.failures)) return [];
  const allowed = new Set([
    "query", "syntax", "search", "term", "field", "argument", "variable",
    "operation", "unknown", "invalid", "expected", "found", "missing",
    "required", "deprecated", "complex", "complexity", "allowed", "access",
    "permission", "plan", "limit", "string", "integer", "boolean", "podcast",
    "series", "selection",
  ]);
  return error.failures.flatMap((entry) => {
    const tokens = record(entry) && record(entry.failure) ? entry.failure.diagnosticTokens : null;
    return Array.isArray(tokens)
      ? tokens.filter((token) => typeof token === "string" && allowed.has(token))
      : [];
  }).slice(0, 40);
}

/** @param {Record<string, unknown>|null} error */
function providerFailureReasons(error) {
  if (error === null || !Array.isArray(error.failures)) return [];
  const allowed = new Set(["argument", "complexity", "field", "input", "syntax", "variable", "unspecified"]);
  return error.failures.flatMap((entry) => {
    const reason = record(entry) && record(entry.failure) ? entry.failure.reason : null;
    return typeof reason === "string" && allowed.has(reason) ? [reason] : [];
  }).slice(0, 20);
}

/** @param {Record<string, unknown>|null} error */
function upstreamStatuses(error) {
  if (error === null || !Array.isArray(error.failures)) return [];
  return error.failures.flatMap((entry) => {
    const status = record(entry) && record(entry.failure)
      ? entry.failure.status
      : null;
    if (
      !record(entry) || !record(entry.failure) ||
      entry.failure.kind !== "SearchProviderUpstreamRejected" ||
      typeof status !== "number" || !Number.isInteger(status) || status < 400 ||
      status > 599
    ) return [];
    return [status];
  }).slice(0, 20);
}

/** @param {Record<string, unknown>|null} error */
function providerFailureKinds(error) {
  if (error === null || !Array.isArray(error.failures)) return [];
  return error.failures.flatMap((entry) => {
    if (!record(entry) || !record(entry.failure) || typeof entry.failure.kind !== "string") return [];
    return [entry.failure.kind];
  }).slice(0, 20);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
