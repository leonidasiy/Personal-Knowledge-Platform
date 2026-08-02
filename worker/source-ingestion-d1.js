// @ts-check

import { isNonEmptyText, isPositiveInteger, isPublicHttpsUrl } from "../src/features/source-library/ingestion-contracts.js";

/** @import { Result, SourceIngestionCommit, SourceIngestionCursor, SourceIngestionFailure, SourceIngestionLease, TrustedSourceIngestionJob } from "../src/features/source-library/ingestion-contracts.js" */

const freeze = Object.freeze;

/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly results: readonly unknown[] }} D1AllResult */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly first: () => Promise<unknown | null>, readonly all: () => Promise<D1AllResult>, readonly run: () => Promise<D1Result> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement, readonly batch: (statements: readonly D1Statement[]) => Promise<readonly D1Result[]> }} D1DatabasePort */

export class D1SourceIngestionRepository {
  /** @type {D1DatabasePort} */
  #database;

  /** @param {D1DatabasePort} database */
  constructor(database) {
    if (typeof database?.prepare !== "function" || typeof database?.batch !== "function") {
      throw new TypeError("D1 source-ingestion database is invalid.");
    }
    this.#database = database;
  }

  /** @param {{ readonly ownerId: string, readonly jobId: string }} command @returns {Promise<Result<TrustedSourceIngestionJob, SourceIngestionFailure>>} */
  async loadRunnable(command) {
    try {
      const row = await this.#database.prepare(
        "SELECT j.job_id, j.source_id, j.source_revision, j.state AS job_state, s.canonical_url, s.adapter_json, s.revision AS current_revision, s.state AS source_state FROM source_ingestion_jobs j JOIN library_sources s ON s.owner_id = j.owner_id AND s.source_id = j.source_id WHERE j.owner_id = ? AND j.job_id = ? LIMIT 1",
      ).bind(command.ownerId, command.jobId).first();
      if (!isRecord(row)) return { ok: false, error: { kind: "IngestionJobNotFound" } };
      if (row.source_state === "disabled") return { ok: false, error: { kind: "IngestionSourceDisabled" } };
      if (!isPositiveInteger(row.source_revision) || !isPositiveInteger(row.current_revision) || row.source_revision !== row.current_revision) {
        return { ok: false, error: { kind: "IngestionSourceRevisionStale" } };
      }
      if (row.job_state !== "pending" && row.job_state !== "partial") {
        return { ok: false, error: { kind: "IngestionJobLeaseConflict" } };
      }
      const acquisitionAllowed = boundedIngestionCapability(row.adapter_json);
      if (acquisitionAllowed === null) {
        return { ok: false, error: { kind: "IngestionPersistenceFailed" } };
      }
      if (!acquisitionAllowed) {
        return {
          ok: false,
          error: { kind: "IngestionSourceAcquisitionProhibited" },
        };
      }
      if (!isNonEmptyText(row.job_id) || !isNonEmptyText(row.source_id) || !isPublicHttpsUrl(row.canonical_url)) {
        return { ok: false, error: { kind: "IngestionPersistenceFailed" } };
      }
      const canonicalRootUrl = new URL(row.canonical_url).href;
      const cursorRow = await this.#database.prepare(
        "SELECT cursor_version, next_ordinal, pages_processed, decoded_bytes, redirects, state FROM source_ingestion_resume_cursors WHERE owner_id = ? AND job_id = ? AND source_id = ? AND source_revision = ? LIMIT 1",
      ).bind(command.ownerId, row.job_id, row.source_id, row.source_revision).first();
      const frontierRows = cursorRow === null ? [] : (await this.#database.prepare(
        "SELECT ordinal, url, depth, state, discovered_from_url FROM source_ingestion_frontier WHERE owner_id = ? AND job_id = ? ORDER BY ordinal",
      ).bind(command.ownerId, row.job_id).all()).results;
      const cursor = cursorRow === null
        ? initialCursor(canonicalRootUrl)
        : isRecord(cursorRow) ? parseCursor(cursorRow, frontierRows) : null;
      if (cursor === null) return { ok: false, error: { kind: "BrowserRunPartialStatePersistenceFailed" } };
      return { ok: true, value: freeze({ ownerId: command.ownerId, jobId: row.job_id, sourceId: row.source_id, sourceRevision: row.source_revision, rootUrl: canonicalRootUrl, cursor }) };
    } catch (error) {
      if (error instanceof Error) return { ok: false, error: { kind: "IngestionPersistenceFailed" } };
      throw error;
    }
  }

  /** @param {SourceIngestionLease} lease @param {string} planJson @param {SourceIngestionCursor} cursor @returns {Promise<Result<SourceIngestionLease, SourceIngestionFailure>>} */
  async lease(lease, planJson, cursor) {
    try {
      const guard = "EXISTS (SELECT 1 FROM source_ingestion_jobs WHERE owner_id = ? AND job_id = ? AND source_id = ? AND source_revision = ? AND state = 'leased' AND lease_token = ?)";
      const guardValues = [lease.ownerId, lease.jobId, lease.sourceId, lease.sourceRevision, lease.leaseToken];
      const statements = [this.#database.prepare(
        "UPDATE source_ingestion_jobs SET state = 'leased', lease_token = ?, lease_expires_at = ?, plan_json = ?, updated_at = ? WHERE owner_id = ? AND job_id = ? AND source_id = ? AND source_revision = ? AND state IN ('pending', 'partial') AND EXISTS (SELECT 1 FROM library_sources WHERE owner_id = ? AND source_id = ? AND state = 'active' AND revision = ?)",
      ).bind(
        lease.leaseToken, lease.leaseExpiresAt, planJson, lease.leasedAt,
        lease.ownerId, lease.jobId, lease.sourceId, lease.sourceRevision,
        lease.ownerId, lease.sourceId, lease.sourceRevision,
      ), this.#database.prepare(
        `INSERT INTO source_ingestion_resume_cursors (owner_id, job_id, source_id, source_revision, cursor_version, next_ordinal, pages_processed, decoded_bytes, redirects, state, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'leased', ? WHERE ${guard}
         ON CONFLICT(owner_id, job_id) DO UPDATE SET cursor_version = excluded.cursor_version, next_ordinal = excluded.next_ordinal, pages_processed = excluded.pages_processed, decoded_bytes = excluded.decoded_bytes, redirects = excluded.redirects, state = 'leased', updated_at = excluded.updated_at`,
      ).bind(lease.ownerId, lease.jobId, lease.sourceId, lease.sourceRevision, cursor.version, cursor.nextOrdinal, cursor.pagesProcessed, cursor.decodedBytes, cursor.redirects, lease.leasedAt, ...guardValues),
      ...cursor.frontier.map((entry) => this.#database.prepare(
        `INSERT INTO source_ingestion_frontier (owner_id, job_id, ordinal, url, depth, state, discovered_from_url, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
         ON CONFLICT(owner_id, job_id, ordinal) DO UPDATE SET url = excluded.url, depth = excluded.depth, state = excluded.state, discovered_from_url = excluded.discovered_from_url, updated_at = excluded.updated_at`,
      ).bind(lease.ownerId, lease.jobId, entry.ordinal, entry.url, entry.depth, entry.state, entry.discoveredFromUrl, lease.leasedAt, lease.leasedAt, ...guardValues))];
      const results = await this.#database.batch(statements);
      if (results.some((result) => result.meta?.changes !== 1)) return await this.#leaseFailure(lease);
      return { ok: true, value: freeze({ ...lease }) };
    } catch (error) {
      if (error instanceof Error) return { ok: false, error: { kind: "IngestionPersistenceFailed" } };
      throw error;
    }
  }

  /** @param {TrustedSourceIngestionJob} job @param {string} reason @param {string} recordedAt @returns {Promise<Result<null, SourceIngestionFailure>>} */
  async recordMetadataOnly(job, reason, recordedAt) {
    try {
      const result = await this.#database.prepare(
        "UPDATE source_ingestion_jobs SET state = 'failed', stop_reason = ?, updated_at = ? WHERE owner_id = ? AND job_id = ? AND source_id = ? AND source_revision = ? AND state IN ('pending', 'partial')",
      ).bind(reason, recordedAt, job.ownerId, job.jobId, job.sourceId, job.sourceRevision).run();
      return result.meta?.changes === 1
        ? { ok: true, value: null }
        : { ok: false, error: { kind: "RightsRegistryMetadataPersistenceFailed" } };
    } catch (error) {
      if (error instanceof Error) return { ok: false, error: { kind: "RightsRegistryMetadataPersistenceFailed" } };
      throw error;
    }
  }

  /** @param {SourceIngestionCommit} commit @returns {Promise<Result<{ readonly state: "completed" | "partial" }, SourceIngestionFailure>>} */
  async commit(commit) {
    const guard = "EXISTS (SELECT 1 FROM source_ingestion_jobs j JOIN library_sources s ON s.owner_id = j.owner_id AND s.source_id = j.source_id WHERE j.owner_id = ? AND j.job_id = ? AND j.source_id = ? AND j.source_revision = ? AND j.state = 'leased' AND j.lease_token = ? AND s.state = 'active' AND s.revision = ?)";
    const guardValues = [commit.lease.ownerId, commit.lease.jobId, commit.lease.sourceId, commit.lease.sourceRevision, commit.lease.leaseToken, commit.lease.sourceRevision];
    const statements = [
      this.#database.prepare(
        `INSERT INTO source_crawl_assessments (owner_id, assessment_id, source_id, policy_version, selected_depth, evidence_json, outcome, assessed_at, source_revision) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
      ).bind(
        commit.crawlAssessment.ownerId, commit.crawlAssessment.id,
        commit.crawlAssessment.sourceId, commit.crawlAssessment.policyVersion,
        commit.crawlAssessment.selectedDepth, JSON.stringify(commit.crawlAssessment.evidence),
        commit.crawlAssessment.outcome, commit.crawlAssessment.assessedAt,
        commit.crawlAssessment.sourceRevision, ...guardValues,
      ),
      ...commit.rightsAssessments.map((/** @type {import("../src/features/source-library/ingestion-contracts.js").SourceRightsAssessment} */ assessment) => this.#database.prepare(
        `INSERT INTO source_rights_assessments (owner_id, assessment_id, source_id, item_id, capabilities_json, evidence_json, assessed_at, expires_at, source_revision, item_version_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
      ).bind(
        assessment.ownerId, assessment.id, assessment.sourceId, assessment.itemId,
        JSON.stringify(assessment.capabilities), JSON.stringify(assessment.evidence),
        assessment.assessedAt, assessment.expiresAt, assessment.sourceRevision,
        assessment.itemVersionId, ...guardValues,
      )),
      ...commit.items.map((/** @type {import("../src/features/source-library/ingestion-contracts.js").SourceItemVersion} */ item) => this.#database.prepare(
        `INSERT INTO source_item_versions (owner_id, source_id, item_id, version_id, canonical_url, title, description, content_digest, provenance_json, observed_at, published_at, source_revision) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
      ).bind(
        item.ownerId, item.sourceId, item.itemId, item.versionId, item.canonicalUrl,
        item.title, item.description, item.contentDigest, JSON.stringify(item.provenance),
        item.observedAt, item.publishedAt, item.sourceRevision, ...guardValues,
      )),
      ...commit.contentReferences.map((/** @type {import("../src/features/source-library/ingestion-contracts.js").SourceContentReference} */ reference) => this.#database.prepare(
        `INSERT INTO source_content_references (owner_id, content_reference_id, source_id, item_id, object_key, content_digest, rights_assessment_id, created_at, source_revision, item_version_id, state) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
      ).bind(
        reference.ownerId, reference.id, reference.sourceId, reference.itemId,
        reference.objectKey, reference.contentDigest, reference.rightsAssessmentId,
        reference.createdAt, reference.sourceRevision, reference.itemVersionId,
        reference.state, ...guardValues,
      )),
      ...cursorStatements(this.#database, commit, guard, guardValues),
      this.#database.prepare(
        "UPDATE source_ingestion_jobs SET state = ?, stop_reason = ?, pages_processed = ?, decoded_bytes = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND job_id = ? AND source_id = ? AND source_revision = ? AND state = 'leased' AND lease_token = ?",
      ).bind(
        commit.state, commit.stopReason, commit.pagesProcessed, commit.decodedBytes,
        commit.committedAt, commit.lease.ownerId, commit.lease.jobId,
        commit.lease.sourceId, commit.lease.sourceRevision, commit.lease.leaseToken,
      ),
    ];
    try {
      const results = await this.#database.batch(statements);
      if (results.some((result) => result.meta?.changes !== 1)) {
        return { ok: false, error: { kind: "IngestionJobLeaseConflict" } };
      }
      return { ok: true, value: freeze({ state: commit.state }) };
    } catch (error) {
      if (error instanceof Error) return { ok: false, error: { kind: "IngestionPersistenceFailed" } };
      throw error;
    }
  }

  /** @param {SourceIngestionLease} lease @returns {Promise<Result<never, SourceIngestionFailure>>} */
  async #leaseFailure(lease) {
    const source = await this.#database.prepare(
      "SELECT state, revision FROM library_sources WHERE owner_id = ? AND source_id = ?",
    ).bind(lease.ownerId, lease.sourceId).first();
    if (isRecord(source) && source.state === "disabled") {
      return { ok: false, error: { kind: "IngestionSourceDisabled" } };
    }
    if (isRecord(source) && typeof source.revision === "number" && source.revision !== lease.sourceRevision) {
      return { ok: false, error: { kind: "IngestionSourceRevisionStale" } };
    }
    return { ok: false, error: { kind: "IngestionJobLeaseConflict" } };
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {boolean | null} */
function boundedIngestionCapability(value) {
  if (typeof value !== "string") return null;
  /** @type {unknown} */ let adapter;
  try {
    adapter = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (
    !isRecord(adapter) || !Array.isArray(adapter.capabilities) ||
    !adapter.capabilities.every(isNonEmptyText)
  ) return null;
  return adapter.capabilities.includes("bounded-ingestion");
}

/** @param {string} rootUrl @returns {SourceIngestionCursor} */
function initialCursor(rootUrl) {
  return freeze({ version: 1, nextOrdinal: 0, pagesProcessed: 0, decodedBytes: 0, redirects: 0, frontier: freeze([freeze({ ordinal: 0, url: rootUrl, depth: 0, state: /** @type {const} */ ("pending"), discoveredFromUrl: null })]) });
}

/** @param {Record<string, unknown>} cursorRow @param {readonly unknown[]} frontierRows @returns {SourceIngestionCursor | null} */
function parseCursor(cursorRow, frontierRows) {
  if (!isPositiveInteger(cursorRow.cursor_version) || !isNonNegativeInteger(cursorRow.next_ordinal) ||
    !isNonNegativeInteger(cursorRow.pages_processed) || !isNonNegativeInteger(cursorRow.decoded_bytes) ||
    !isNonNegativeInteger(cursorRow.redirects) || !Array.isArray(frontierRows)) return null;
  const frontier = [];
  for (const value of frontierRows) {
    if (!isRecord(value) || !isNonNegativeInteger(value.ordinal) || !isPublicHttpsUrl(value.url) ||
      !isNonNegativeInteger(value.depth) || (value.state !== "pending" && value.state !== "visited") ||
      (value.discovered_from_url !== null && !isPublicHttpsUrl(value.discovered_from_url))) return null;
    frontier.push(freeze({ ordinal: value.ordinal, url: new URL(value.url).href, depth: value.depth, state: value.state, discoveredFromUrl: value.discovered_from_url === null ? null : new URL(value.discovered_from_url).href }));
  }
  if (frontier.length === 0) return null;
  return freeze({
    version: /** @type {number} */ (cursorRow.cursor_version),
    nextOrdinal: /** @type {number} */ (cursorRow.next_ordinal),
    pagesProcessed: /** @type {number} */ (cursorRow.pages_processed),
    decodedBytes: /** @type {number} */ (cursorRow.decoded_bytes),
    redirects: /** @type {number} */ (cursorRow.redirects),
    frontier: freeze(/** @type {import("../src/features/source-library/ingestion-contracts.js").SourceIngestionFrontierEntry[]} */ (frontier)),
  });
}

/** @param {D1DatabasePort} database @param {SourceIngestionCommit} commit @param {string} guard @param {readonly (string | number | null)[]} guardValues @returns {readonly D1Statement[]} */
function cursorStatements(database, commit, guard, guardValues) {
  if (commit.resumeCursor === null) {
    return [database.prepare(
      `UPDATE source_ingestion_resume_cursors SET pages_processed = ?, decoded_bytes = ?, state = 'completed', updated_at = ? WHERE owner_id = ? AND job_id = ? AND ${guard}`,
    ).bind(commit.pagesProcessed, commit.decodedBytes, commit.committedAt, commit.lease.ownerId, commit.lease.jobId, ...guardValues)];
  }
  const cursor = commit.resumeCursor;
  return [database.prepare(
    `UPDATE source_ingestion_resume_cursors SET cursor_version = ?, next_ordinal = ?, pages_processed = ?, decoded_bytes = ?, redirects = ?, state = 'ready', updated_at = ? WHERE owner_id = ? AND job_id = ? AND ${guard}`,
  ).bind(cursor.version, cursor.nextOrdinal, cursor.pagesProcessed, cursor.decodedBytes, cursor.redirects, commit.committedAt, commit.lease.ownerId, commit.lease.jobId, ...guardValues),
  ...cursor.frontier.map((entry) => database.prepare(
    `INSERT INTO source_ingestion_frontier (owner_id, job_id, ordinal, url, depth, state, discovered_from_url, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
     ON CONFLICT(owner_id, job_id, ordinal) DO UPDATE SET url = excluded.url, depth = excluded.depth, state = excluded.state, discovered_from_url = excluded.discovered_from_url, updated_at = excluded.updated_at`,
  ).bind(commit.lease.ownerId, commit.lease.jobId, entry.ordinal, entry.url, entry.depth, entry.state, entry.discoveredFromUrl, commit.committedAt, commit.committedAt, ...guardValues))];
}

/** @param {unknown} value */
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export {};
