// @ts-check

/** @import { Result, SourceContentReference, SourceIngestionFailure, SourceRightsAssessment } from "../src/features/source-library/ingestion-contracts.js" */

const freeze = Object.freeze;
/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly first: () => Promise<unknown | null>, readonly all: () => Promise<{ readonly success: boolean, readonly results: readonly unknown[] }>, readonly run: () => Promise<D1Result> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement, readonly batch: (statements: readonly D1Statement[]) => Promise<readonly D1Result[]> }} D1DatabasePort */
export class D1ManualMaterialRepository {
  /** @type {D1DatabasePort} */
  #database;
  /** @param {D1DatabasePort} database */
  constructor(database) {
    if (typeof database?.prepare !== "function" || typeof database?.batch !== "function") throw new TypeError("D1 manual-material database is invalid.");
    this.#database = database;
  }

  /** @param {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly itemId: string, readonly itemVersionId: string }} query @returns {Promise<Result<{ readonly state: "active" | "disabled" }, SourceIngestionFailure>>} */
  async find(query) {
    try {
      const row = await this.#database.prepare(
        "SELECT s.state, s.revision FROM library_sources s JOIN source_item_versions i ON i.owner_id = s.owner_id AND i.source_id = s.source_id WHERE s.owner_id = ? AND s.source_id = ? AND i.item_id = ? AND i.version_id = ?",
      ).bind(query.ownerId, query.sourceId, query.itemId, query.itemVersionId).first();
      if (!isRecord(row)) {
        const source = await this.#database.prepare(
          "SELECT owner_id, revision, state FROM library_sources WHERE source_id = ? LIMIT 2",
        ).bind(query.sourceId).first();
        if (!isRecord(source)) return { ok: false, error: { kind: "ManualUploadSourceNotFound" } };
        if (source.owner_id !== query.ownerId) return { ok: false, error: { kind: "ManualUploadOwnerMismatch" } };
        return { ok: false, error: { kind: "ManualUploadItemNotFound" } };
      }
      if (typeof row.revision !== "number" || row.revision !== query.sourceRevision) return { ok: false, error: { kind: "ManualUploadRevisionStale" } };
      if (row.state !== "active" && row.state !== "disabled") throw new TypeError("Stored source state is invalid.");
      return { ok: true, value: freeze({ state: row.state }) };
    } catch (error) {
      if (error instanceof TypeError) throw error;
      if (error instanceof Error) return { ok: false, error: { kind: "ManualUploadPersistenceFailed" } };
      throw error;
    }
  }

  /** @param {string} ownerId @param {string} idempotencyKey @returns {Promise<Result<{ readonly fingerprint: string, readonly reference: SourceContentReference } | null, SourceIngestionFailure>>} */
  async replay(ownerId, idempotencyKey) {
    try {
      const row = await this.#database.prepare(
        "SELECT c.command_fingerprint, r.owner_id, r.content_reference_id, r.source_id, r.source_revision, r.item_id, r.item_version_id, r.object_key, r.content_digest, r.rights_assessment_id, r.state, r.created_at FROM source_manual_material_commands c JOIN source_content_references r ON r.owner_id = c.owner_id AND r.content_reference_id = c.content_reference_id WHERE c.owner_id = ? AND c.idempotency_key = ?",
      ).bind(ownerId, idempotencyKey).first();
      if (row === null) return { ok: true, value: null };
      if (!isRecord(row) || typeof row.command_fingerprint !== "string") throw new TypeError("Stored manual-material replay is invalid.");
      return { ok: true, value: freeze({ fingerprint: row.command_fingerprint, reference: contentReference(row) }) };
    } catch (error) {
      if (error instanceof TypeError) throw error;
      if (error instanceof Error) return { ok: false, error: { kind: "ManualUploadPersistenceFailed" } };
      throw error;
    }
  }

  /** @param {{ readonly fingerprint: string, readonly idempotencyKey: string, readonly rightsAssessment: SourceRightsAssessment, readonly contentReference: SourceContentReference }} command @returns {Promise<Result<SourceContentReference, SourceIngestionFailure>>} */
  async persist(command) {
    const reference = command.contentReference;
    const rights = command.rightsAssessment;
    const guard = "EXISTS (SELECT 1 FROM library_sources s JOIN source_item_versions i ON i.owner_id = s.owner_id AND i.source_id = s.source_id WHERE s.owner_id = ? AND s.source_id = ? AND s.state = 'active' AND s.revision = ? AND i.item_id = ? AND i.version_id = ?)";
    const guardValues = [reference.ownerId, reference.sourceId, reference.sourceRevision, reference.itemId, reference.itemVersionId];
    try {
      const results = await this.#database.batch([
        this.#database.prepare(
          `INSERT INTO source_rights_assessments (owner_id, assessment_id, source_id, item_id, capabilities_json, evidence_json, assessed_at, expires_at, source_revision, item_version_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        ).bind(rights.ownerId, rights.id, rights.sourceId, rights.itemId, JSON.stringify(rights.capabilities), JSON.stringify(rights.evidence), rights.assessedAt, rights.expiresAt, rights.sourceRevision, rights.itemVersionId, ...guardValues),
        this.#database.prepare(
          `INSERT INTO source_content_references (owner_id, content_reference_id, source_id, item_id, object_key, content_digest, rights_assessment_id, created_at, source_revision, item_version_id, state) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        ).bind(reference.ownerId, reference.id, reference.sourceId, reference.itemId, reference.objectKey, reference.contentDigest, reference.rightsAssessmentId, reference.createdAt, reference.sourceRevision, reference.itemVersionId, reference.state, ...guardValues),
        this.#database.prepare(
          `INSERT INTO source_manual_material_commands (owner_id, idempotency_key, command_fingerprint, content_reference_id, created_at) SELECT ?, ?, ?, ?, ? WHERE ${guard}`,
        ).bind(reference.ownerId, command.idempotencyKey, command.fingerprint, reference.id, reference.createdAt, ...guardValues),
      ]);
      if (results.some((result) => result.meta?.changes !== 1)) return { ok: false, error: { kind: "ManualUploadSourceItemMismatch" } };
      return { ok: true, value: freeze({ ...reference }) };
    } catch (error) {
      if (error instanceof Error) return { ok: false, error: { kind: "ManualUploadPersistenceFailed" } };
      throw error;
    }
  }
}

/** @param {Record<string, unknown>} row @returns {SourceContentReference} */
function contentReference(row) {
  if (typeof row.owner_id !== "string" || typeof row.content_reference_id !== "string" || typeof row.source_id !== "string" || typeof row.source_revision !== "number" || typeof row.item_id !== "string" || typeof row.item_version_id !== "string" || typeof row.object_key !== "string" || typeof row.content_digest !== "string" || typeof row.rights_assessment_id !== "string" || (row.state !== "processing-ready" && row.state !== "revoked") || typeof row.created_at !== "string") throw new TypeError("Stored source-content reference is invalid.");
  return freeze({ id: row.content_reference_id, ownerId: row.owner_id, sourceId: row.source_id, sourceRevision: row.source_revision, itemId: row.item_id, itemVersionId: row.item_version_id, objectKey: row.object_key, contentDigest: row.content_digest, rightsAssessmentId: row.rights_assessment_id, state: row.state, createdAt: row.created_at });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
export {};
