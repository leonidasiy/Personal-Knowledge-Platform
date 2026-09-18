// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {"allowed" | "unknown" | "denied" | "ambiguous" | "conflicting"} EvidenceOutcome */
/** @typedef {"public" | "authenticated" | "paywalled" | "private" | "bypass-required"} AccessOutcome */

/**
 * @typedef {{
 *   readonly capability: "copyright" | "licence" | "terms" | "access" | "storage" | "display" | "transformation" | "attribution" | "origin",
 *   readonly outcome: EvidenceOutcome,
 *   readonly reference: string,
 *   readonly observedAt: string,
 *   readonly expiresAt: string | null
 * }} RightsEvidence
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly canonicalUrl: string,
 *   readonly evidence: readonly RightsEvidence[],
 *   readonly access: AccessOutcome,
 *   readonly origin: string,
 *   readonly requestedAt: string
 * }} RightsAssessmentCommand
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly canonicalUrl: string,
 *   readonly status: "allowed" | "awaiting-review" | "denied",
 *   readonly evidence: readonly RightsEvidence[],
 *   readonly reason: string | null,
 *   readonly assessedAt: string,
 *   readonly expiresAt: string | null
 * }} RightsDecision
 */

/**
 * @typedef {{
 *   readonly kind: "RightsCommandInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "RightsEvidenceMissing",
 *   readonly capability: string
 * } | {
 *   readonly kind: "RightsEvidenceUnknown",
 *   readonly capability: string
 * } | {
 *   readonly kind: "RightsEvidenceAmbiguous",
 *   readonly capability: string
 * } | {
 *   readonly kind: "RightsEvidenceConflicting",
 *   readonly capability: string
 * } | {
 *   readonly kind: "RightsEvidenceDenied",
 *   readonly capability: string
 * } | {
 *   readonly kind: "RightsEvidenceExpired",
 *   readonly capability: string
 * } | {
 *   readonly kind: "RightsAccessRestricted",
 *   readonly access: AccessOutcome
 * } | {
 *   readonly kind: "RightsOriginInvalid"
 * }} RightsFailure
 */

/** @typedef {{ readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }) => void }} RightsDependencies */

const requiredCapabilities = /** @type {const} */ (["copyright", "licence", "terms", "access", "storage", "display", "transformation", "attribution", "origin"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value @returns {value is EvidenceOutcome} */
function outcome(value) { return value === "allowed" || value === "unknown" || value === "denied" || value === "ambiguous" || value === "conflicting"; }
/** @param {unknown} value @returns {value is AccessOutcome} */
function access(value) { return value === "public" || value === "authenticated" || value === "paywalled" || value === "private" || value === "bypass-required"; }
/** @param {unknown} value @returns {boolean} */
function timestamp(value) { return text(value) && Number.isFinite(Date.parse(value)); }
/** @param {unknown} value @returns {boolean} */
function publicHttps(value) { return text(value) && URL.canParse(value) && new URL(value).protocol === "https:"; }

/** @param {unknown} value @returns {value is RightsEvidence} */
function validEvidence(value) {
  return isRecord(value) && requiredCapabilities.includes(/** @type {typeof requiredCapabilities[number]} */ (value.capability)) && outcome(value.outcome) && text(value.reference) && timestamp(value.observedAt) && (value.expiresAt === null || timestamp(value.expiresAt));
}

/** @param {unknown} value @returns {Result<RightsAssessmentCommand, RightsFailure>} */
function validateCommand(value) {
  if (!isRecord(value)) return { ok: false, error: { kind: "RightsCommandInvalid", field: "command" } };
  if (!text(value.ownerId)) return { ok: false, error: { kind: "RightsCommandInvalid", field: "ownerId" } };
  if (!text(value.sourceId)) return { ok: false, error: { kind: "RightsCommandInvalid", field: "sourceId" } };
  if (!positiveInteger(value.sourceRevision)) return { ok: false, error: { kind: "RightsCommandInvalid", field: "sourceRevision" } };
  if (!publicHttps(value.canonicalUrl)) return { ok: false, error: { kind: "RightsCommandInvalid", field: "canonicalUrl" } };
  if (!access(value.access)) return { ok: false, error: { kind: "RightsCommandInvalid", field: "access" } };
  if (!publicHttps(value.origin)) return { ok: false, error: { kind: "RightsCommandInvalid", field: "origin" } };
  if (!timestamp(value.requestedAt)) return { ok: false, error: { kind: "RightsCommandInvalid", field: "requestedAt" } };
  if (!Array.isArray(value.evidence)) return { ok: false, error: { kind: "RightsCommandInvalid", field: "evidence" } };
  const evidence = /** @type {unknown[]} */ (value.evidence);
  if (evidence.some((entry) => !validEvidence(entry))) return { ok: false, error: { kind: "RightsCommandInvalid", field: "evidence" } };
  const canonicalUrl = /** @type {string} */ (value.canonicalUrl);
  const origin = /** @type {string} */ (value.origin);
  const requestedAt = /** @type {string} */ (value.requestedAt);
  const accessValue = /** @type {AccessOutcome} */ (value.access);
  return { ok: true, value: Object.freeze({ ownerId: value.ownerId.trim(), sourceId: value.sourceId.trim(), sourceRevision: value.sourceRevision, canonicalUrl: new URL(canonicalUrl).href, evidence: Object.freeze(/** @type {RightsEvidence[]} */ ([...evidence])), access: accessValue, origin: new URL(origin).origin, requestedAt }) };
}

/** @param {RightsAssessmentCommand} command @param {string} now @returns {RightsFailure | null} */
function firstFailure(command, now) {
  if (command.access !== "public") return { kind: "RightsAccessRestricted", access: command.access };
  if (new URL(command.canonicalUrl).origin !== command.origin) return { kind: "RightsOriginInvalid" };
  for (const capability of requiredCapabilities) {
    const matches = command.evidence.filter((entry) => entry.capability === capability);
    if (matches.length === 0) return { kind: "RightsEvidenceMissing", capability };
    const distinctOutcomes = new Set(matches.map((entry) => entry.outcome));
    if (distinctOutcomes.has("conflicting") || (distinctOutcomes.has("allowed") && distinctOutcomes.has("denied"))) return { kind: "RightsEvidenceConflicting", capability };
    const evidence = matches[0];
    if (evidence.expiresAt !== null && Date.parse(evidence.expiresAt) <= Date.parse(now)) return { kind: "RightsEvidenceExpired", capability };
    if (evidence.outcome === "unknown") return { kind: "RightsEvidenceUnknown", capability };
    if (evidence.outcome === "ambiguous") return { kind: "RightsEvidenceAmbiguous", capability };
    if (evidence.outcome === "denied") return { kind: "RightsEvidenceDenied", capability };
  }
  return null;
}

/** @param {RightsDependencies} dependencies */
export function createRightsAssessor(dependencies) {
  if (!dependencies || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") throw new TypeError("Rights-assessor dependencies are invalid.");
  return Object.freeze({
    /** @param {unknown} command @returns {Result<RightsDecision, RightsFailure>} */
    assess(command) {
      const parsed = validateCommand(command);
      if (!parsed.ok) return parsed;
      const now = dependencies.now();
      if (!timestamp(now)) throw new TypeError("Rights-assessor clock returned an invalid timestamp.");
      dependencies.logger({ event: "rights-assessor-entry", ownerId: parsed.value.ownerId, sourceId: parsed.value.sourceId });
      const failure = firstFailure(parsed.value, now);
      if (failure !== null) {
        dependencies.logger({ event: "rights-assessor-failure", ownerId: parsed.value.ownerId, sourceId: parsed.value.sourceId, failureKind: failure.kind });
        return { ok: true, value: Object.freeze({ ownerId: parsed.value.ownerId, sourceId: parsed.value.sourceId, sourceRevision: parsed.value.sourceRevision, canonicalUrl: parsed.value.canonicalUrl, status: failure.kind === "RightsEvidenceDenied" || failure.kind === "RightsAccessRestricted" || failure.kind === "RightsOriginInvalid" ? "denied" : "awaiting-review", evidence: parsed.value.evidence, reason: failure.kind, assessedAt: now, expiresAt: earliestExpiry(parsed.value.evidence) }) };
      }
      const decision = Object.freeze({ ownerId: parsed.value.ownerId, sourceId: parsed.value.sourceId, sourceRevision: parsed.value.sourceRevision, canonicalUrl: parsed.value.canonicalUrl, status: /** @type {const} */ ("allowed"), evidence: parsed.value.evidence, reason: null, assessedAt: now, expiresAt: earliestExpiry(parsed.value.evidence) });
      dependencies.logger({ event: "rights-assessor-success", ownerId: parsed.value.ownerId, sourceId: parsed.value.sourceId });
      return { ok: true, value: decision };
    },
  });
}

/** @param {readonly RightsEvidence[]} evidence @returns {string | null} */
function earliestExpiry(evidence) {
  const dates = evidence.filter((entry) => entry.expiresAt !== null).map((entry) => /** @type {string} */ (entry.expiresAt));
  return dates.length === 0 ? null : dates.sort()[0];
}

export {};
