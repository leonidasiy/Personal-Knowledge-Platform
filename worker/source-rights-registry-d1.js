// @ts-check

import {
  isIsoDateTime,
  isNonEmptyText,
  isPositiveInteger,
  isPublicHttpsUrl,
  isRecord,
} from "../src/features/source-library/ingestion-contracts.js";

/** @import { CapabilityEvidence, Result, ServerRightsGrant, SourceIngestionFailure, TrustedSourceIngestionJob } from "../src/features/source-library/ingestion-contracts.js" */
/** @import { RightsApprovalFailure, RightsApprovalRecord, RightsApprovalResult } from "../src/features/source-library/rights-approval.js" */

/** @typedef {{ readonly results?: readonly unknown[] }} D1AllResult */
/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly all: () => Promise<D1AllResult> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement, readonly batch?: (statements: readonly D1Statement[]) => Promise<readonly D1Result[]> }} D1DatabasePort */

const freeze = Object.freeze;

export class D1SourceRightsRegistry {
  /** @type {D1DatabasePort} */
  #database;
  /** @type {() => string} */
  #now;
  /** @type {(entry: { readonly event: string, readonly failureKind?: string }) => void} */
  #logger;

  /** @param {{ readonly database: D1DatabasePort, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly failureKind?: string }) => void }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") {
      throw new TypeError("Source-rights registry dependencies are invalid.");
    }
    this.#database = dependencies.database;
    this.#now = dependencies.now;
    this.#logger = dependencies.logger;
  }

  /** @param {TrustedSourceIngestionJob} job @returns {Promise<Result<ServerRightsGrant, SourceIngestionFailure>>} */
  async resolve(job) {
    this.#logger({ event: "source-rights-registry-resolve-entry" });
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
    if (active.length !== 1) {
      const context = freeze({
        ownerId: job.ownerId,
        sourceId: job.sourceId,
        sourceRevision: job.sourceRevision,
        registryIds: freeze(active.map((entry) => entry.registryId).sort()),
      });
      return sameCapabilityOutcomes(active)
        ? fail({ kind: "RightsRegistryEvidenceAmbiguous", context })
        : fail({ kind: "RightsRegistryEvidenceConflicting", context });
    }
    const selected = active[0];
    if (selected.expiresAt !== null && Date.parse(selected.expiresAt) <= Date.parse(now)) {
      return fail({ kind: "RightsRegistryEvidenceExpired" });
    }
    if (!isNonEmptyText(selected.attributionText)) return fail({ kind: "RightsRegistryAttributionMissing" });
    if (Object.values(selected.capabilities).some((capability) => !validCapability(capability))) {
      return fail({ kind: "RightsRegistryCapabilityMissing" });
    }
    if (Object.values(selected.capabilities).some((capability) => capability.expiresAt !== null && Date.parse(capability.expiresAt) <= Date.parse(now))) {
      return fail({ kind: "RightsRegistryEvidenceExpired" });
    }
    const result = /** @type {Result<ServerRightsGrant, SourceIngestionFailure>} */ ({ ok: true, value: freeze({
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
    }) });
    this.#logger({ event: "source-rights-registry-resolve-success" });
    return result;
  }

  /**
   * Persist an owner-scoped approval and requeue only the legacy rights-missing job.
   * @param {RightsApprovalRecord} record
   * @param {string} fingerprint
   * @returns {Promise<Result<RightsApprovalResult, RightsApprovalFailure>>}
   */
  async approve(record, fingerprint) {
    this.#logger({ event: "source-rights-approval-persistence-entry" });
    if (!validApprovalRecord(record) || !isNonEmptyText(fingerprint) || typeof this.#database.batch !== "function") {
      return this.#approvalFailure({ kind: "RightsApprovalPersistenceFailed" });
    }
    try {
      const replay = await this.#loadApprovalReplay(record.ownerId, record.idempotencyKey, fingerprint);
      if (!replay.ok) return replay;
      if (replay.value !== null) return { ok: true, value: replay.value };

      const source = await this.#first("SELECT canonical_url, revision, state FROM library_sources WHERE owner_id = ? AND source_id = ? LIMIT 1", [record.ownerId, record.sourceId]);
      if (source === null) return this.#approvalFailure({ kind: "RightsApprovalSourceNotFound" });
      if (!isRecord(source) || !isPublicHttpsUrl(source.canonical_url) || !isPositiveInteger(source.revision) || (source.state !== "active" && source.state !== "disabled")) return this.#approvalFailure({ kind: "RightsApprovalPersistenceFailed" });
      if (source.state === "disabled") return this.#approvalFailure({ kind: "RightsApprovalSourceDisabled" });
      if (source.revision !== record.sourceRevision) return this.#approvalFailure({ kind: "RightsApprovalRevisionStale", expected: record.sourceRevision, actual: source.revision });
      if (new URL(source.canonical_url).href !== record.canonicalRootUrl) return this.#approvalFailure({ kind: "RightsApprovalRootMismatch" });

      const existing = await this.#first("SELECT registry_id FROM source_rights_registry WHERE owner_id = ? AND source_id = ? AND source_revision = ? AND state = 'active' LIMIT 1", [record.ownerId, record.sourceId, record.sourceRevision]);
      if (existing !== null) {
        if (!isRecord(existing) || !isNonEmptyText(existing.registry_id)) return this.#approvalFailure({ kind: "RightsApprovalPersistenceFailed" });
        return this.#approvalFailure({ kind: "RightsApprovalEvidenceConflict" });
      }

      const job = await this.#first("SELECT job_id, source_revision, state, stop_reason FROM source_ingestion_jobs WHERE owner_id = ? AND source_id = ? AND source_revision = ? ORDER BY updated_at DESC, job_id DESC LIMIT 1", [record.ownerId, record.sourceId, record.sourceRevision]);
      if (job !== null && (!isRecord(job) || !isNonEmptyText(job.job_id) || !isPositiveInteger(job.source_revision) || !isNonEmptyText(job.state) || (job.stop_reason !== null && !isNonEmptyText(job.stop_reason)))) return this.#approvalFailure({ kind: "RightsApprovalPersistenceFailed" });
      const checkedJob = job === null ? null : /** @type {{ readonly job_id: string, readonly source_revision: number, readonly state: string, readonly stop_reason: string | null }} */ (job);
      const requeued = checkedJob !== null && checkedJob.state === "failed" && checkedJob.stop_reason === "RightsRegistryRecordMissing";
      const result = freeze({ approvalId: record.approvalId, registryId: record.registryId, sourceId: record.sourceId, sourceRevision: record.sourceRevision, jobId: checkedJob === null ? null : checkedJob.job_id, requeued, reused: false });
      const evidenceJson = JSON.stringify({ storage: record.capabilities.storage, display: record.capabilities.display, transformation: record.capabilities.transformation, crawl: record.crawlEvidence });
      const registryValues = [record.ownerId, record.registryId, record.registryVersion, record.sourceId, record.sourceRevision, record.canonicalRootUrl, record.capabilities.storage.outcome, record.capabilities.display.outcome, record.capabilities.transformation.outcome, record.attributionText, evidenceJson, record.evidenceDigest, record.assessorId, record.assessorVersion, record.observedAt, record.expiresAt, record.createdAt];
      /** @type {D1Statement[]} */
      const statements = [];
      if (requeued) {
        statements.push(this.#database.prepare(
          "UPDATE source_ingestion_jobs SET state = 'pending', stop_reason = NULL, plan_json = NULL, lease_token = NULL, lease_expires_at = NULL, pages_processed = 0, decoded_bytes = 0, generation_state = 'not-requested', generation_failure = NULL, updated_at = ? WHERE owner_id = ? AND job_id = ? AND source_id = ? AND source_revision = ? AND state = 'failed' AND stop_reason = 'RightsRegistryRecordMissing'",
        ).bind(record.createdAt, record.ownerId, /** @type {string} */ (checkedJob.job_id), record.sourceId, record.sourceRevision));
        statements.push(this.#database.prepare(
          "INSERT INTO source_rights_registry (owner_id, registry_id, registry_version, source_id, source_revision, canonical_root_url, storage_outcome, display_outcome, transformation_outcome, attribution_text, evidence_json, evidence_digest, assessor_id, assessor_version, observed_at, expires_at, state, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ? WHERE EXISTS (SELECT 1 FROM source_ingestion_jobs WHERE owner_id = ? AND job_id = ? AND source_id = ? AND source_revision = ? AND state = 'pending')",
        ).bind(...registryValues, record.ownerId, checkedJob.job_id, record.sourceId, record.sourceRevision));
      } else {
        statements.push(this.#database.prepare(
          "INSERT INTO source_rights_registry (owner_id, registry_id, registry_version, source_id, source_revision, canonical_root_url, storage_outcome, display_outcome, transformation_outcome, attribution_text, evidence_json, evidence_digest, assessor_id, assessor_version, observed_at, expires_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
        ).bind(...registryValues));
      }
      const auditValues = [record.ownerId, record.approvalId, record.sourceId, record.sourceRevision, record.registryId, record.idempotencyKey, fingerprint, JSON.stringify(result), record.createdAt];
      if (requeued) {
        statements.push(this.#database.prepare(
          "INSERT INTO source_rights_approval_audits (owner_id, approval_id, source_id, source_revision, registry_id, idempotency_key, command_fingerprint, result_json, occurred_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM source_rights_registry WHERE owner_id = ? AND registry_id = ? AND state = 'active') AND EXISTS (SELECT 1 FROM source_ingestion_jobs WHERE owner_id = ? AND job_id = ? AND source_id = ? AND source_revision = ? AND state = 'pending')",
        ).bind(...auditValues, record.ownerId, record.registryId, record.ownerId, checkedJob.job_id, record.sourceId, record.sourceRevision));
      } else {
        statements.push(this.#database.prepare(
          "INSERT INTO source_rights_approval_audits (owner_id, approval_id, source_id, source_revision, registry_id, idempotency_key, command_fingerprint, result_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(...auditValues));
      }
      const results = await this.#database.batch(statements);
      if (results.length !== statements.length || results.some((entry) => entry.meta?.changes !== 1)) return this.#approvalFailure({ kind: "RightsApprovalPersistenceFailed" });
      this.#logger({ event: "source-rights-approval-persistence-success" });
      return { ok: true, value: result };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      try {
        const replay = await this.#loadApprovalReplay(record.ownerId, record.idempotencyKey, fingerprint);
        if (!replay.ok) return replay;
        return replay.value === null ? this.#approvalFailure({ kind: "RightsApprovalPersistenceFailed" }) : { ok: true, value: replay.value };
      } catch (replayError) {
        if (replayError instanceof Error) return this.#approvalFailure({ kind: "RightsApprovalPersistenceFailed" });
        throw replayError;
      }
    }
  }

  /** @param {string} query @param {readonly (string | number | null)[]} values @returns {Promise<unknown | null>} */
  async #first(query, values) {
    const statement = this.#database.prepare(query).bind(...values);
    return await /** @type {{ readonly first: () => Promise<unknown | null> }} */ (/** @type {unknown} */ (statement)).first();
  }

  /** @param {string} ownerId @param {string} idempotencyKey @param {string} fingerprint @returns {Promise<Result<RightsApprovalResult | null, RightsApprovalFailure>>} */
  async #loadApprovalReplay(ownerId, idempotencyKey, fingerprint) {
    const row = await this.#first("SELECT command_fingerprint, result_json FROM source_rights_approval_audits WHERE owner_id = ? AND idempotency_key = ? LIMIT 1", [ownerId, idempotencyKey]);
    if (row === null) return { ok: true, value: null };
    if (!isRecord(row) || !isNonEmptyText(row.command_fingerprint) || !isNonEmptyText(row.result_json)) return this.#approvalFailure({ kind: "RightsApprovalPersistenceFailed" });
    if (row.command_fingerprint !== fingerprint) return this.#approvalFailure({ kind: "RightsApprovalIdempotencyConflict" });
    let parsed;
    try {
      parsed = JSON.parse(row.result_json);
    } catch (error) {
      if (error instanceof SyntaxError) return this.#approvalFailure({ kind: "RightsApprovalPersistenceFailed" });
      throw error;
    }
    if (!validApprovalResult(parsed)) return this.#approvalFailure({ kind: "RightsApprovalPersistenceFailed" });
    return { ok: true, value: freeze({ ...parsed, reused: true }) };
  }

  /** @param {RightsApprovalFailure} error @returns {Result<never, RightsApprovalFailure>} */
  #approvalFailure(error) {
    this.#logger({ event: "source-rights-approval-persistence-failure", failureKind: error.kind });
    return { ok: false, error };
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

/** @param {unknown} value @returns {value is RightsApprovalRecord} */
function validApprovalRecord(value) {
  return isRecord(value) && isNonEmptyText(value.approvalId) && isNonEmptyText(value.registryId) &&
    isNonEmptyText(value.ownerId) && isNonEmptyText(value.sourceId) && isPositiveInteger(value.sourceRevision) && isNonEmptyText(value.idempotencyKey) &&
    isNonEmptyText(value.canonicalRootUrl) && isPublicHttpsUrl(value.canonicalRootUrl) &&
    isNonEmptyText(value.registryVersion) && isNonEmptyText(value.attributionText) &&
    isNonEmptyText(value.evidenceDigest) && isNonEmptyText(value.assessorId) && isNonEmptyText(value.assessorVersion) &&
    isIsoDateTime(value.observedAt) && isIsoDateTime(value.expiresAt) && isIsoDateTime(value.createdAt) &&
    isRecord(value.capabilities) && capabilityRecord(value.capabilities.storage) && capabilityRecord(value.capabilities.display) && capabilityRecord(value.capabilities.transformation) &&
    isRecord(value.crawlEvidence) && value.crawlEvidence.robots === "allowed" && value.crawlEvidence.terms === "allowed" && value.crawlEvidence.access === "public" &&
    isNonEmptyText(value.crawlEvidence.robotsEvidenceReference) && isNonEmptyText(value.crawlEvidence.termsEvidenceReference) && isNonEmptyText(value.crawlEvidence.accessEvidenceReference) && Array.isArray(value.crawlEvidence.structuralEvidence);
}

/** @param {unknown} value @returns {boolean} */
function capabilityRecord(value) {
  return isRecord(value) && value.outcome === "allowed" && isNonEmptyText(value.evidenceReference) && isIsoDateTime(value.observedAt) && isIsoDateTime(value.expiresAt);
}

/** @param {readonly (ServerRightsGrant & { readonly state: "active" | "superseded" | "revoked" })[]} entries @returns {boolean} */
function sameCapabilityOutcomes(entries) {
  const first = entries[0];
  if (first === undefined) return false;
  const capabilities = /** @type {const} */ (["storage", "display", "transformation"]);
  return entries.every((entry) => capabilities.every((capability) => entry.capabilities[capability].outcome === first.capabilities[capability].outcome));
}

/** @param {unknown} value @returns {value is RightsApprovalResult} */
function validApprovalResult(value) {
  return isRecord(value) && isNonEmptyText(value.approvalId) && isNonEmptyText(value.registryId) && isNonEmptyText(value.sourceId) &&
    isPositiveInteger(value.sourceRevision) && (value.jobId === null || isNonEmptyText(value.jobId)) && typeof value.requeued === "boolean" && typeof value.reused === "boolean";
}

/** @param {SourceIngestionFailure} error @returns {Result<never, SourceIngestionFailure>} */
function fail(error) { return { ok: false, error }; }

export {};
