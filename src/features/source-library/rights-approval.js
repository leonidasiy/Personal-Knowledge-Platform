// @ts-check

import {
  isIsoDateTime,
  isNonEmptyText,
  isPositiveInteger,
  isPublicHttpsUrl,
  isRecord,
} from "./ingestion-contracts.js";

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {"allowed" | "denied" | "unknown"} EvidenceOutcome */

/**
 * @typedef {{
 *   readonly outcome: EvidenceOutcome,
 *   readonly evidenceReference: string,
 *   readonly observedAt: string,
 *   readonly expiresAt: string
 * }} RightsApprovalCapability
 */

/**
 * @typedef {{
 *   readonly robots: "allowed" | "denied" | "unavailable" | "malformed",
 *   readonly robotsEvidenceReference: string,
 *   readonly terms: "allowed" | "denied" | "unknown",
 *   readonly termsEvidenceReference: string,
 *   readonly access: "public" | "denied" | "authentication-required" | "paywall",
 *   readonly accessEvidenceReference: string,
 *   readonly structuralEvidence: readonly {
 *     readonly kind: "sitemap" | "navigation",
 *     readonly evidenceUrl: string,
 *     readonly requiredDepth: number,
 *     readonly observedAt: string
 *   }[]
 * }} RightsApprovalCrawlEvidence
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly idempotencyKey: string,
 *   readonly canonicalRootUrl: string,
 *   readonly registryVersion: string,
 *   readonly attributionText: string,
 *   readonly evidenceDigest: string,
 *   readonly assessorId: string,
 *   readonly assessorVersion: string,
 *   readonly observedAt: string,
 *   readonly expiresAt: string,
 *   readonly capabilities: {
 *     readonly storage: RightsApprovalCapability,
 *     readonly display: RightsApprovalCapability,
 *     readonly transformation: RightsApprovalCapability
 *   },
 *   readonly crawlEvidence: RightsApprovalCrawlEvidence
 * }} RightsApprovalCommand
 */

/**
 * Server-created metadata passed to the repository.
 * @typedef {RightsApprovalCommand & {
 *   readonly approvalId: string,
 *   readonly registryId: string,
 *   readonly createdAt: string
 * }} RightsApprovalRecord
 */

/**
 * @typedef {{
 *   readonly approvalId: string,
 *   readonly registryId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly jobId: string | null,
 *   readonly requeued: boolean,
 *   readonly reused: boolean
 * }} RightsApprovalResult
 */

/**
 * @typedef {{
 *   readonly kind: "RightsApprovalCommandInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "RightsApprovalEvidenceNotPermitted",
 *   readonly field: string
 * } | {
 *   readonly kind: "RightsApprovalEvidenceExpired",
 *   readonly field: string
 * } | {
 *   readonly kind: "RightsApprovalSourceNotFound"
 * } | {
 *   readonly kind: "RightsApprovalSourceDisabled"
 * } | {
 *   readonly kind: "RightsApprovalRevisionStale",
 *   readonly expected: number,
 *   readonly actual: number
 * } | {
 *   readonly kind: "RightsApprovalRootMismatch"
 * } | {
 *   readonly kind: "RightsApprovalEvidenceConflict"
 * } | {
 *   readonly kind: "RightsApprovalIdempotencyConflict"
 * } | {
 *   readonly kind: "RightsApprovalPersistenceFailed"
 * }} RightsApprovalFailure
 */

const freeze = Object.freeze;
const commandFields = new Set([
  "ownerId",
  "sourceId",
  "sourceRevision",
  "idempotencyKey",
  "canonicalRootUrl",
  "registryVersion",
  "attributionText",
  "evidenceDigest",
  "assessorId",
  "assessorVersion",
  "observedAt",
  "expiresAt",
  "capabilities",
  "crawlEvidence",
]);
const capabilityNames = /** @type {const} */ (["storage", "display", "transformation"]);
const capabilityFields = new Set(["outcome", "evidenceReference", "observedAt", "expiresAt"]);
const crawlFields = new Set(["robots", "robotsEvidenceReference", "terms", "termsEvidenceReference", "access", "accessEvidenceReference", "structuralEvidence"]);
const structuralFields = new Set(["kind", "evidenceUrl", "requiredDepth", "observedAt"]);
const capabilityNamesSet = new Set(capabilityNames);

/** @typedef {Record<string, unknown> & {
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly idempotencyKey: string,
 *   readonly canonicalRootUrl: string,
 *   readonly registryVersion: string,
 *   readonly attributionText: string,
 *   readonly evidenceDigest: string,
 *   readonly assessorId: string,
 *   readonly assessorVersion: string,
 *   readonly observedAt: string,
 *   readonly expiresAt: string,
 *   readonly capabilities: Record<string, unknown>,
 *   readonly crawlEvidence: Record<string, unknown>
 * }} ApprovalInput */

/** @typedef {Record<string, unknown> & {
 *   readonly robots: "allowed" | "denied" | "unavailable" | "malformed",
 *   readonly robotsEvidenceReference: string,
 *   readonly terms: "allowed" | "denied" | "unknown",
 *   readonly termsEvidenceReference: string,
 *   readonly access: "public" | "denied" | "authentication-required" | "paywall",
 *   readonly accessEvidenceReference: string,
 *   readonly structuralEvidence: readonly unknown[]
 * }} ApprovalCrawlInput */

/**
 * @typedef {{
 *   readonly repository: {
 *     readonly approve: (record: RightsApprovalRecord, fingerprint: string) => Promise<Result<RightsApprovalResult, RightsApprovalFailure>>
 *   },
 *   readonly createId: () => string,
 *   readonly now: () => string,
 *   readonly logger: (entry: { readonly event: string, readonly failureKind?: string }) => void
 * }} RightsApprovalDependencies
 */

export class SourceRightsApprovalService {
  /** @type {RightsApprovalDependencies} */
  #dependencies;

  /** @param {RightsApprovalDependencies} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies?.repository?.approve !== "function" ||
      typeof dependencies.createId !== "function" ||
      typeof dependencies.now !== "function" ||
      typeof dependencies.logger !== "function"
    ) {
      throw new TypeError("Rights-approval dependencies are invalid.");
    }
    this.#dependencies = dependencies;
  }

  /** @param {unknown} command @returns {Promise<Result<RightsApprovalResult, RightsApprovalFailure>>} */
  async approve(command) {
    this.#dependencies.logger({ event: "source-rights-approval-entry" });
    const validated = validateRightsApprovalCommand(command);
    if (!validated.ok) return this.#failure(validated.error);
    const approvedAt = this.#dependencies.now();
    if (!isIsoDateTime(approvedAt)) {
      throw new TypeError("Rights-approval clock returned an invalid time.");
    }
    const expiredField = expiredEvidenceField(validated.value, approvedAt);
    if (expiredField !== null) {
      return this.#failure({ kind: "RightsApprovalEvidenceExpired", field: expiredField });
    }
    const record = freeze({
      ...validated.value,
      approvalId: this.#id("source-rights-approval"),
      registryId: this.#id("source-rights-registry"),
      createdAt: approvedAt,
    });
    const result = await this.#dependencies.repository.approve(record, JSON.stringify(validated.value));
    if (!result.ok) return this.#failure(result.error);
    this.#dependencies.logger({ event: "source-rights-approval-success" });
    return result;
  }

  /** @param {RightsApprovalFailure} failure @returns {Result<never, RightsApprovalFailure>} */
  #failure(failure) {
    this.#dependencies.logger({ event: "source-rights-approval-failure", failureKind: failure.kind });
    return { ok: false, error: failure };
  }

  /** @param {string} prefix */
  #id(prefix) {
    const id = this.#dependencies.createId();
    if (!isNonEmptyText(id)) throw new TypeError("Rights-approval ID factory returned an invalid ID.");
    return `${prefix}:${id}`;
  }
}

/**
 * Validate and normalize an approval command before any persistence.
 * @param {unknown} value
 * @returns {Result<RightsApprovalCommand, RightsApprovalFailure>}
 */
export function validateRightsApprovalCommand(value) {
  if (!isRecord(value)) return invalid("body");
  if (Object.keys(value).some((field) => !commandFields.has(field))) return invalid("body");
  for (const field of ["ownerId", "sourceId", "idempotencyKey", "registryVersion", "attributionText", "evidenceDigest", "assessorId", "assessorVersion"]) {
    if (!isNonEmptyText(value[field])) return invalid(field);
  }
  if (!isPositiveInteger(value.sourceRevision)) return invalid("sourceRevision");
  if (!isPublicHttpsUrl(value.canonicalRootUrl)) return invalid("canonicalRootUrl");
  if (!isIsoDateTime(value.observedAt)) return invalid("observedAt");
  if (!isIsoDateTime(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) return invalid("expiresAt");
  if (!isRecord(value.capabilities) || !exactFields(value.capabilities, capabilityNamesSet)) return invalid("capabilities");
  const checked = /** @type {ApprovalInput} */ (value);
  /** @type {Record<string, RightsApprovalCapability>} */
  const capabilities = {};
  for (const name of capabilityNames) {
    const field = `capabilities.${name}`;
    const capability = checked.capabilities[name];
    if (!isRecord(capability)) return invalid(field);
    if (!exactFields(capability, capabilityFields)) return invalid(field);
    if (!isNonEmptyText(capability.evidenceReference)) return invalid(`${field}.evidenceReference`);
    if (!isIsoDateTime(capability.observedAt)) return invalid(`${field}.observedAt`);
    if (!isIsoDateTime(capability.expiresAt)) return invalid(`${field}.expiresAt`);
    if (!["allowed", "denied", "unknown"].includes(String(capability.outcome))) return invalid(`${field}.outcome`);
    if (capability.outcome !== "allowed") return { ok: false, error: { kind: "RightsApprovalEvidenceNotPermitted", field } };
    if (Date.parse(capability.expiresAt) <= Date.parse(capability.observedAt)) return invalid(`${field}.expiresAt`);
    capabilities[name] = freeze({
      outcome: capability.outcome,
      evidenceReference: capability.evidenceReference.trim(),
      observedAt: capability.observedAt,
      expiresAt: capability.expiresAt,
    });
  }
  if (!isRecord(checked.crawlEvidence)) return invalid("crawlEvidence");
  const crawl = /** @type {ApprovalCrawlInput} */ (checked.crawlEvidence);
  if (!exactFields(crawl, crawlFields)) return invalid("crawlEvidence");
  if (!["allowed", "denied", "unavailable", "malformed"].includes(String(crawl.robots))) return invalid("crawlEvidence.robots");
  if (!["allowed", "denied", "unknown"].includes(String(crawl.terms))) return invalid("crawlEvidence.terms");
  if (!["public", "denied", "authentication-required", "paywall"].includes(String(crawl.access))) return invalid("crawlEvidence.access");
  if (!isAllowedCrawlOutcome(crawl)) {
    if (crawl.robots !== "allowed") return permitted("crawlEvidence.robots");
    if (crawl.terms !== "allowed") return permitted("crawlEvidence.terms");
    return permitted("crawlEvidence.access");
  }
  if (!isNonEmptyText(crawl.robotsEvidenceReference)) return invalid("crawlEvidence.robotsEvidenceReference");
  if (!isNonEmptyText(crawl.termsEvidenceReference)) return invalid("crawlEvidence.termsEvidenceReference");
  if (!isNonEmptyText(crawl.accessEvidenceReference)) return invalid("crawlEvidence.accessEvidenceReference");
  if (!Array.isArray(crawl.structuralEvidence)) return invalid("crawlEvidence.structuralEvidence");
  const structuralEvidence = [];
  for (const [index, entry] of crawl.structuralEvidence.entries()) {
    if (!isRecord(entry) || (entry.kind !== "sitemap" && entry.kind !== "navigation")) return invalid(`crawlEvidence.structuralEvidence.${index}.kind`);
    if (!exactFields(entry, structuralFields)) return invalid(`crawlEvidence.structuralEvidence.${index}`);
    if (!isPublicHttpsUrl(entry.evidenceUrl)) return invalid(`crawlEvidence.structuralEvidence.${index}.evidenceUrl`);
    if (!isPositiveInteger(entry.requiredDepth)) return invalid(`crawlEvidence.structuralEvidence.${index}.requiredDepth`);
    if (!isIsoDateTime(entry.observedAt)) return invalid(`crawlEvidence.structuralEvidence.${index}.observedAt`);
    structuralEvidence.push(freeze({ kind: entry.kind, evidenceUrl: new URL(entry.evidenceUrl).href, requiredDepth: entry.requiredDepth, observedAt: entry.observedAt }));
  }
  return {
    ok: true,
    value: freeze({
      ownerId: checked.ownerId.trim(),
      sourceId: checked.sourceId.trim(),
      sourceRevision: checked.sourceRevision,
      idempotencyKey: checked.idempotencyKey.trim(),
      canonicalRootUrl: new URL(checked.canonicalRootUrl).href,
      registryVersion: checked.registryVersion.trim(),
      attributionText: checked.attributionText.trim(),
      evidenceDigest: checked.evidenceDigest.trim(),
      assessorId: checked.assessorId.trim(),
      assessorVersion: checked.assessorVersion.trim(),
      observedAt: checked.observedAt,
      expiresAt: checked.expiresAt,
      capabilities: freeze({ storage: capabilities.storage, display: capabilities.display, transformation: capabilities.transformation }),
      crawlEvidence: freeze({
        robots: crawl.robots,
        robotsEvidenceReference: crawl.robotsEvidenceReference.trim(),
        terms: crawl.terms,
        termsEvidenceReference: crawl.termsEvidenceReference.trim(),
        access: crawl.access,
        accessEvidenceReference: crawl.accessEvidenceReference.trim(),
        structuralEvidence: freeze(structuralEvidence),
      }),
    }),
  };
}

/** @param {Record<string, unknown>} value @returns {boolean} */
function isAllowedCrawlOutcome(value) {
  return value.robots === "allowed" && value.terms === "allowed" && value.access === "public";
}

/** @param {string} field @returns {Result<never, RightsApprovalFailure>} */
function permitted(field) {
  return { ok: false, error: { kind: "RightsApprovalEvidenceNotPermitted", field } };
}

/** @param {string} field @returns {Result<never, RightsApprovalFailure>} */
function invalid(field) {
  return { ok: false, error: { kind: "RightsApprovalCommandInvalid", field } };
}

/** @param {Record<string, unknown>} value @param {ReadonlySet<string>} allowed @returns {boolean} */
function exactFields(value, allowed) {
  const fields = Object.keys(value);
  return fields.length === allowed.size && fields.every((field) => allowed.has(field));
}

/** @param {RightsApprovalCommand} command @param {string} now @returns {string | null} */
function expiredEvidenceField(command, now) {
  if (Date.parse(command.expiresAt) <= Date.parse(now)) return "expiresAt";
  for (const name of capabilityNames) {
    if (Date.parse(command.capabilities[name].expiresAt) <= Date.parse(now)) return `capabilities.${name}.expiresAt`;
  }
  return null;
}

export {};
