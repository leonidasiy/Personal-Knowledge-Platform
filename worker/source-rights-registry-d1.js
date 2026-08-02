// @ts-check

import {
  isIsoDateTime,
  isNonEmptyText,
  isPositiveInteger,
  isPublicHttpsUrl,
  isRecord,
} from "../src/features/source-library/ingestion-contracts.js";

/** @import { CapabilityEvidence, Result, ServerRightsGrant, SourceIngestionFailure, TrustedSourceIngestionJob } from "../src/features/source-library/ingestion-contracts.js" */

/** @typedef {{ readonly results?: readonly unknown[] }} D1AllResult */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly all: () => Promise<D1AllResult> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement }} D1DatabasePort */

const freeze = Object.freeze;

export class D1SourceRightsRegistry {
  /** @type {D1DatabasePort} */
  #database;
  /** @type {() => string} */
  #now;

  /** @param {{ readonly database: D1DatabasePort, readonly now: () => string }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.now !== "function") {
      throw new TypeError("Source-rights registry dependencies are invalid.");
    }
    this.#database = dependencies.database;
    this.#now = dependencies.now;
  }

  /** @param {TrustedSourceIngestionJob} job @returns {Promise<Result<ServerRightsGrant, SourceIngestionFailure>>} */
  async resolve(job) {
    if (!validJobIdentity(job)) return fail({ kind: "RightsRegistrySchemaInvalid" });
    const now = this.#now();
    if (!isIsoDateTime(now)) throw new TypeError("Source-rights registry clock returned an invalid time.");
    let rows;
    try {
      const result = await this.#database.prepare(
        "SELECT owner_id, registry_id, registry_version, source_id, source_revision, canonical_root_url, storage_outcome, display_outcome, transformation_outcome, attribution_text, evidence_json, evidence_digest, assessor_id, assessor_version, observed_at, expires_at, state FROM source_rights_registry WHERE owner_id = ? AND source_id = ? ORDER BY observed_at DESC, registry_id DESC",
      ).bind(job.ownerId, job.sourceId).all();
      rows = Array.isArray(result.results) ? result.results : null;
    } catch (error) {
      if (error instanceof Error) return fail({ kind: "RightsRegistryUnavailable" });
      throw error;
    }
    if (rows === null) return fail({ kind: "RightsRegistrySchemaInvalid" });
    if (rows.length === 0) return fail({ kind: "RightsRegistryRecordMissing" });

    const parsed = [];
    for (const row of rows) {
      const entry = parseRow(row);
      if (!entry.ok) return entry;
      parsed.push(entry.value);
    }
    if (parsed.some((entry) => entry.ownerId !== job.ownerId)) return fail({ kind: "RightsRegistryOwnerMismatch" });
    if (parsed.some((entry) => entry.sourceId !== job.sourceId)) return fail({ kind: "RightsRegistrySourceMismatch" });
    const revision = parsed.filter((entry) => entry.sourceRevision === job.sourceRevision);
    if (revision.length === 0) return fail({ kind: "RightsRegistryRevisionMismatch" });
    const rooted = revision.filter((entry) => entry.canonicalRootUrl === new URL(job.rootUrl).href);
    if (rooted.length === 0) return fail({ kind: "RightsRegistryRootMismatch" });
    const active = rooted.filter((entry) => entry.state === "active");
    if (active.length === 0 && rooted.some((entry) => entry.state === "revoked")) {
      return fail({ kind: "RightsRegistryEvidenceRevoked" });
    }
    if (active.length === 0) return fail({ kind: "RightsRegistryRecordMissing" });
    if (active.length !== 1) return fail({ kind: "RightsRegistryEvidenceConflicting" });
    const selected = active[0];
    if (selected.expiresAt !== null && Date.parse(selected.expiresAt) <= Date.parse(now)) {
      return fail({ kind: "RightsRegistryEvidenceExpired" });
    }
    if (!isNonEmptyText(selected.attributionText)) return fail({ kind: "RightsRegistryAttributionMissing" });
    if (Object.values(selected.capabilities).some((capability) => !validCapability(capability))) {
      return fail({ kind: "RightsRegistryCapabilityMissing" });
    }
    return { ok: true, value: freeze({
      registryId: selected.registryId,
      registryVersion: selected.registryVersion,
      ownerId: selected.ownerId,
      sourceId: selected.sourceId,
      sourceRevision: selected.sourceRevision,
      canonicalRootUrl: selected.canonicalRootUrl,
      capabilities: selected.capabilities,
      crawlEvidence: selected.crawlEvidence,
      attributionText: selected.attributionText,
      evidenceDigest: selected.evidenceDigest,
      assessorId: selected.assessorId,
      assessorVersion: selected.assessorVersion,
      observedAt: selected.observedAt,
      expiresAt: selected.expiresAt,
    }) };
  }
}

/** @param {unknown} row @returns {Result<ServerRightsGrant & { readonly state: "active" | "superseded" | "revoked" }, SourceIngestionFailure>} */
function parseRow(row) {
  if (!isRecord(row) || !isNonEmptyText(row.owner_id) || !isNonEmptyText(row.registry_id) ||
    !isNonEmptyText(row.registry_version) || !isNonEmptyText(row.source_id) ||
    !isPositiveInteger(row.source_revision) || !isPublicHttpsUrl(row.canonical_root_url) ||
    !isNonEmptyText(row.evidence_digest) || !isNonEmptyText(row.assessor_id) ||
    !isNonEmptyText(row.assessor_version) || !isIsoDateTime(row.observed_at) ||
    (row.expires_at !== null && !isIsoDateTime(row.expires_at)) ||
    !["active", "superseded", "revoked"].includes(String(row.state))) {
    return fail({ kind: "RightsRegistrySchemaInvalid" });
  }
  let evidence;
  try {
    evidence = JSON.parse(String(row.evidence_json));
  } catch (error) {
    if (error instanceof SyntaxError) return fail({ kind: "RightsRegistrySchemaInvalid" });
    throw error;
  }
  if (!isRecord(evidence)) return fail({ kind: "RightsRegistrySchemaInvalid" });
  /** @type {{ storage?: CapabilityEvidence, display?: CapabilityEvidence, transformation?: CapabilityEvidence }} */
  const capabilities = {};
  for (const name of /** @type {const} */ (["storage", "display", "transformation"])) {
    const details = evidence[name];
    const outcome = row[`${name}_outcome`];
    if (!isRecord(details) || !["allowed", "denied", "unknown"].includes(String(outcome)) ||
      !isNonEmptyText(details.evidenceReference) || !isIsoDateTime(details.observedAt) ||
      (details.expiresAt !== null && !isIsoDateTime(details.expiresAt))) {
      return fail({ kind: "RightsRegistryCapabilityMissing" });
    }
    capabilities[name] = freeze({ outcome: /** @type {"allowed" | "denied" | "unknown"} */ (outcome), evidenceReference: details.evidenceReference.trim(), observedAt: details.observedAt, expiresAt: details.expiresAt });
  }
  if (capabilities.storage === undefined || capabilities.display === undefined || capabilities.transformation === undefined) {
    return fail({ kind: "RightsRegistryCapabilityMissing" });
  }
  const crawl = evidence.crawl;
  if (!isRecord(crawl) || !["allowed", "denied", "unavailable", "malformed"].includes(String(crawl.robots)) ||
    !isNonEmptyText(crawl.robotsEvidenceReference) || !["allowed", "denied", "unknown"].includes(String(crawl.terms)) ||
    !isNonEmptyText(crawl.termsEvidenceReference) || !["public", "denied", "authentication-required", "paywall"].includes(String(crawl.access)) ||
    !isNonEmptyText(crawl.accessEvidenceReference) || !Array.isArray(crawl.structuralEvidence)) {
    return fail({ kind: "RightsRegistrySchemaInvalid" });
  }
  const structuralEvidence = [];
  for (const entry of crawl.structuralEvidence) {
    if (!isRecord(entry) || (entry.kind !== "sitemap" && entry.kind !== "navigation") ||
      !isPublicHttpsUrl(entry.evidenceUrl) || !isPositiveInteger(entry.requiredDepth) || !isIsoDateTime(entry.observedAt)) {
      return fail({ kind: "RightsRegistrySchemaInvalid" });
    }
    structuralEvidence.push(freeze({ kind: entry.kind, evidenceUrl: new URL(entry.evidenceUrl).href, requiredDepth: entry.requiredDepth, observedAt: entry.observedAt }));
  }
  return { ok: true, value: /** @type {ServerRightsGrant & { readonly state: "active" | "superseded" | "revoked" }} */ (freeze({
    registryId: row.registry_id.trim(), registryVersion: row.registry_version.trim(),
    ownerId: row.owner_id.trim(), sourceId: row.source_id.trim(), sourceRevision: row.source_revision,
    canonicalRootUrl: new URL(row.canonical_root_url).href,
    capabilities: freeze({ storage: capabilities.storage, display: capabilities.display, transformation: capabilities.transformation }),
    crawlEvidence: freeze({ robots: crawl.robots, robotsEvidenceReference: crawl.robotsEvidenceReference.trim(), terms: crawl.terms, termsEvidenceReference: crawl.termsEvidenceReference.trim(), access: crawl.access, accessEvidenceReference: crawl.accessEvidenceReference.trim(), structuralEvidence: freeze(structuralEvidence) }),
    attributionText: typeof row.attribution_text === "string" ? row.attribution_text.trim() : "",
    evidenceDigest: row.evidence_digest.trim(), assessorId: row.assessor_id.trim(), assessorVersion: row.assessor_version.trim(),
    observedAt: row.observed_at, expiresAt: row.expires_at, state: row.state,
  })) };
}

/** @param {unknown} value @returns {value is TrustedSourceIngestionJob} */
function validJobIdentity(value) {
  return isRecord(value) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.jobId) &&
    isNonEmptyText(value.sourceId) && isPositiveInteger(value.sourceRevision) && isPublicHttpsUrl(value.rootUrl);
}

/** @param {unknown} value @returns {value is CapabilityEvidence} */
function validCapability(value) {
  return isRecord(value) && ["allowed", "denied", "unknown"].includes(String(value.outcome)) &&
    isNonEmptyText(value.evidenceReference) && isIsoDateTime(value.observedAt) &&
    (value.expiresAt === null || isIsoDateTime(value.expiresAt));
}

/** @param {SourceIngestionFailure} error @returns {Result<never, SourceIngestionFailure>} */
function fail(error) { return { ok: false, error }; }

export {};
