// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {"copyright" | "licence" | "terms" | "access" | "storage" | "display" | "transformation" | "attribution" | "origin"} SourceRightsCapability */
/** @typedef {"allowed" | "unknown" | "denied" | "ambiguous" | "conflicting"} SourceRightsOutcome */

/**
 * A server-owned, source-backed rights snapshot. It is deliberately separate
 * from the browser's discovery result so a client cannot grant itself rights.
 *
 * @typedef {{
 *   readonly profileId: string,
 *   readonly canonicalRootUrl: string,
 *   readonly origin: string,
 *   readonly access: "public",
 *   readonly attributionText: string,
 *   readonly robotsUrl: string,
 *   readonly evidence: readonly {
 *     readonly capability: SourceRightsCapability,
 *     readonly outcome: SourceRightsOutcome,
 *     readonly reference: string,
 *     readonly observedAt: string,
 *     readonly expiresAt: string | null
 *   }[]
 * }} SourceRightsProfile
 */

/** @typedef {{ readonly kind: "SourceRightsProfileInvalid", readonly field: string }} SourceRightsProfileFailure */

const capabilities = /** @type {const} */ ([
  "copyright",
  "licence",
  "terms",
  "access",
  "storage",
  "display",
  "transformation",
  "attribution",
  "origin",
]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value @returns {value is string} */
function timestamp(value) {
  return text(value) && Number.isFinite(Date.parse(value));
}

/** @param {unknown} value @returns {value is string} */
function secureUrl(value) {
  return text(value) && URL.canParse(value) && new URL(value).protocol === "https:";
}

/** @param {unknown} value @returns {value is SourceRightsCapability} */
function capability(value) {
  return typeof value === "string" && capabilities.includes(/** @type {SourceRightsCapability} */ (value));
}

/** @param {unknown} value @returns {value is SourceRightsOutcome} */
function outcome(value) {
  return value === "allowed" || value === "unknown" || value === "denied" || value === "ambiguous" || value === "conflicting";
}

/** @param {unknown} value @returns {value is SourceRightsProfile} */
export function isSourceRightsProfile(value) {
  return validateSourceRightsProfile(value).ok;
}

/** @param {unknown} value @returns {Result<SourceRightsProfile, SourceRightsProfileFailure>} */
export function validateSourceRightsProfile(value) {
  if (!record(value)) return invalid("profile");
  for (const field of ["profileId", "canonicalRootUrl", "origin", "attributionText", "robotsUrl"]) {
    if (!text(value[field])) return invalid(field);
  }
  if (!secureUrl(value.canonicalRootUrl)) return invalid("canonicalRootUrl");
  if (!secureUrl(value.origin) || new URL(/** @type {string} */ (value.origin)).pathname !== "/") return invalid("origin");
  if (!secureUrl(value.robotsUrl)) return invalid("robotsUrl");
  if (value.access !== "public") return invalid("access");
  if (!Array.isArray(value.evidence) || value.evidence.length !== capabilities.length) return invalid("evidence");
  /** @type {Set<string>} */ const seen = new Set();
  for (const entry of value.evidence) {
    if (!record(entry) || !capability(entry.capability) || seen.has(entry.capability)) return invalid("evidence.capability");
    if (!outcome(entry.outcome) || !secureUrl(entry.reference) || !timestamp(entry.observedAt) || !(entry.expiresAt === null || timestamp(entry.expiresAt))) return invalid("evidence");
    seen.add(entry.capability);
  }
  if (seen.size !== capabilities.length || !capabilities.every((item) => seen.has(item))) return invalid("evidence.capability");
  const root = new URL(/** @type {string} */ (value.canonicalRootUrl));
  const origin = new URL(/** @type {string} */ (value.origin));
  if (root.origin !== origin.origin || new URL(/** @type {string} */ (value.robotsUrl)).origin !== origin.origin) return invalid("origin");
  return {
    ok: true,
    value: Object.freeze({
      profileId: /** @type {string} */ (value.profileId).trim(),
      canonicalRootUrl: root.href,
      origin: origin.origin,
      access: "public",
      attributionText: /** @type {string} */ (value.attributionText).trim(),
      robotsUrl: new URL(/** @type {string} */ (value.robotsUrl)).href,
      evidence: Object.freeze(/** @type {SourceRightsProfile["evidence"]} */ (value.evidence.map((entry) => Object.freeze({
        capability: entry.capability,
        outcome: entry.outcome,
        reference: new URL(/** @type {string} */ (entry.reference)).href,
        observedAt: entry.observedAt,
        expiresAt: entry.expiresAt,
      })))),
    }),
  };
}

/** @param {string} field @returns {Result<never, SourceRightsProfileFailure>} */
function invalid(field) {
  return { ok: false, error: { kind: "SourceRightsProfileInvalid", field } };
}

export {};
