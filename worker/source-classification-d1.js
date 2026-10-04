// @ts-check

import { isSubjectId } from "../src/features/knowledge-subjects/public.js";
/** @import { SourceClassification } from "../src/features/source-classification/public.js" */

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly mainSubject: string, readonly topic: string, readonly classificationRevision: number, readonly origin: "agent" | "manual" | "backfill", readonly status: "classified" | "needs-review", readonly legacyAudit: readonly unknown[], readonly updatedAt: string }} StoredSourceClassification */
/** @typedef {{ readonly owner_id: string, readonly source_id: string, readonly source_revision: number, readonly main_subject: string, readonly topic: string, readonly classification_revision: number, readonly origin: "agent" | "manual" | "backfill", readonly status: "classified" | "needs-review", readonly legacy_audit_json: string, readonly updated_at: string }} SourceClassificationRow */
/** @typedef {{ readonly kind: "SourceClassificationCommandInvalid" | "SourceClassificationSourceMissing" | "SourceClassificationRevisionConflict" | "SourceClassificationPersistenceFailed" }} SourceClassificationRepositoryFailure */
/** @typedef {{ readonly prepare: (sql: string) => { bind: (...values: unknown[]) => { first: <T>() => Promise<T|null>, run: () => Promise<{ success: boolean, meta?: { changes?: number } }> } }, readonly batch: (statements: readonly unknown[]) => Promise<readonly { success: boolean, meta?: { changes?: number } }[]> }} SourceClassificationDatabase */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function nonEmpty(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} row @returns {row is SourceClassificationRow} */
function stored(row) {
  return record(row) && nonEmpty(row.owner_id) && nonEmpty(row.source_id) && Number.isSafeInteger(row.source_revision) && Number.isSafeInteger(row.classification_revision) && isSubjectId(row.main_subject) && nonEmpty(row.topic) && row.topic.trim() === row.topic && (row.origin === "agent" || row.origin === "manual" || row.origin === "backfill") && (row.status === "classified" || row.status === "needs-review") && typeof row.legacy_audit_json === "string" && typeof row.updated_at === "string";
}
/** @param {Record<string, unknown>} row @returns {StoredSourceClassification} */
function toStored(row) {
  if (!stored(row)) throw new TypeError("StoredSourceClassificationInvalid");
  const legacyAudit = JSON.parse(row.legacy_audit_json);
  if (!Array.isArray(legacyAudit)) throw new TypeError("StoredSourceClassificationAuditInvalid");
  return Object.freeze({ ownerId: row.owner_id, sourceId: row.source_id, sourceRevision: row.source_revision, mainSubject: row.main_subject, topic: row.topic, classificationRevision: row.classification_revision, origin: row.origin, status: row.status, legacyAudit: Object.freeze(legacyAudit), updatedAt: row.updated_at });
}

/** @param {{ readonly database: SourceClassificationDatabase, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }) => void }} dependencies */
export class D1SourceClassificationRepository {
  /** @type {SourceClassificationDatabase} */ #database;
  /** @type {() => string} */ #now;
  /** @type {(entry: { readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }) => void} */ #logger;

  /** @param {{ readonly database: SourceClassificationDatabase, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }) => void }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") throw new TypeError("SourceClassificationRepositoryDependenciesInvalid");
    this.#database = dependencies.database;
    this.#now = dependencies.now;
    this.#logger = dependencies.logger;
  }

  /** @param {unknown} command @returns {Promise<Result<StoredSourceClassification|null, SourceClassificationRepositoryFailure>>} */
  async get(command) {
    if (!record(command) || !nonEmpty(command.ownerId) || !nonEmpty(command.sourceId)) return { ok: false, error: { kind: "SourceClassificationCommandInvalid" } };
    this.#logger({ event: "source-classification-read-entry", ownerId: command.ownerId, sourceId: command.sourceId });
    try {
      const row = await this.#database.prepare("SELECT * FROM source_classifications WHERE owner_id = ? AND source_id = ? LIMIT 1").bind(command.ownerId, command.sourceId).first();
      if (row === null) {
        this.#logger({ event: "source-classification-read-success", ownerId: command.ownerId, sourceId: command.sourceId });
        return { ok: true, value: null };
      }
      if (!record(row)) return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
      const value = toStored(row);
      if (value.ownerId !== command.ownerId || value.sourceId !== command.sourceId) return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
      this.#logger({ event: "source-classification-read-success", ownerId: command.ownerId, sourceId: command.sourceId });
      return { ok: true, value };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.#logger({ event: "source-classification-read-failure", ownerId: command.ownerId, sourceId: command.sourceId, failureKind: "SourceClassificationPersistenceFailed" });
      return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
    }
  }

  /** Inserts an agent result once. Retries return the existing value and never overwrite it.
   * @param {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly classification: SourceClassification, readonly legacyAudit: readonly unknown[] }} command
   * @returns {Promise<Result<{ readonly value: StoredSourceClassification, readonly inserted: boolean }, SourceClassificationRepositoryFailure>>}
   */
  async persistAgent(command) {
    if (!validClassificationInput(command) || !Array.isArray(command.legacyAudit)) return { ok: false, error: { kind: "SourceClassificationCommandInvalid" } };
    const now = this.#now();
    if (!Number.isFinite(Date.parse(now))) return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
    this.#logger({ event: "source-classification-write-entry", ownerId: command.ownerId, sourceId: command.sourceId });
    try {
      const written = await this.#database.prepare("INSERT INTO source_classifications (owner_id, source_id, source_revision, main_subject, topic, classification_revision, origin, status, legacy_audit_json, updated_at) SELECT ?, ?, ?, ?, ?, 1, 'agent', 'classified', ?, ? WHERE EXISTS (SELECT 1 FROM library_sources WHERE owner_id = ? AND source_id = ? AND revision = ? AND state = 'active') ON CONFLICT(owner_id, source_id) DO NOTHING").bind(command.ownerId, command.sourceId, command.sourceRevision, command.classification.mainSubject, command.classification.topic, JSON.stringify(command.legacyAudit), now, command.ownerId, command.sourceId, command.sourceRevision).run();
      if (!written.success) return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
      const current = await this.get({ ownerId: command.ownerId, sourceId: command.sourceId });
      if (!current.ok) return current;
      if (current.value === null) return { ok: false, error: { kind: "SourceClassificationSourceMissing" } };
      if (current.value.sourceRevision !== command.sourceRevision) return { ok: false, error: { kind: "SourceClassificationRevisionConflict" } };
      this.#logger({ event: "source-classification-write-success", ownerId: command.ownerId, sourceId: command.sourceId });
      return { ok: true, value: { value: current.value, inserted: (written.meta?.changes ?? 0) === 1 } };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.#logger({ event: "source-classification-write-failure", ownerId: command.ownerId, sourceId: command.sourceId, failureKind: "SourceClassificationPersistenceFailed" });
      return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
    }
  }

  /** @param {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly expectedRevision: number, readonly classification: SourceClassification }} command @returns {Promise<Result<StoredSourceClassification, SourceClassificationRepositoryFailure>>} */
  async updateManual(command) {
    if (!validClassificationInput(command) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) return { ok: false, error: { kind: "SourceClassificationCommandInvalid" } };
    const now = this.#now();
    if (!Number.isFinite(Date.parse(now))) return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
    this.#logger({ event: "source-classification-manual-entry", ownerId: command.ownerId, sourceId: command.sourceId });
    try {
      const written = command.expectedRevision === 0
        ? await this.#database.prepare("INSERT INTO source_classifications (owner_id, source_id, source_revision, main_subject, topic, classification_revision, origin, status, legacy_audit_json, updated_at) SELECT ?, ?, ?, ?, ?, 1, 'manual', 'classified', '[]', ? WHERE EXISTS (SELECT 1 FROM library_sources WHERE owner_id = ? AND source_id = ? AND revision = ? AND state = 'active') ON CONFLICT(owner_id, source_id) DO NOTHING").bind(command.ownerId, command.sourceId, command.sourceRevision, command.classification.mainSubject, command.classification.topic, now, command.ownerId, command.sourceId, command.sourceRevision).run()
        : await this.#database.prepare("UPDATE source_classifications SET source_revision = ?, main_subject = ?, topic = ?, classification_revision = classification_revision + 1, origin = 'manual', status = 'classified', updated_at = ? WHERE owner_id = ? AND source_id = ? AND classification_revision = ? AND EXISTS (SELECT 1 FROM library_sources WHERE owner_id = ? AND source_id = ? AND revision = ? AND state = 'active')").bind(command.sourceRevision, command.classification.mainSubject, command.classification.topic, now, command.ownerId, command.sourceId, command.expectedRevision, command.ownerId, command.sourceId, command.sourceRevision).run();
      if (!written.success) return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
      if ((written.meta?.changes ?? 0) !== 1) {
        const source = await this.#database.prepare("SELECT revision FROM library_sources WHERE owner_id = ? AND source_id = ? AND state = 'active' LIMIT 1").bind(command.ownerId, command.sourceId).first();
        return source === null ? { ok: false, error: { kind: "SourceClassificationSourceMissing" } } : { ok: false, error: { kind: "SourceClassificationRevisionConflict" } };
      }
      const current = await this.get({ ownerId: command.ownerId, sourceId: command.sourceId });
      if (!current.ok) return current;
      if (current.value === null) return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
      return { ok: true, value: current.value };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.#logger({ event: "source-classification-manual-failure", ownerId: command.ownerId, sourceId: command.sourceId, failureKind: "SourceClassificationPersistenceFailed" });
      return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
    }
  }

  /** Records a durable retryable backfill issue without changing classification data.
   * @param {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly issueKind: "inference-failed" | "legacy-conflict" | "legacy-unclassified" }} command
   * @returns {Promise<Result<null, SourceClassificationRepositoryFailure>>}
   */
  async recordReviewIssue(command) {
    if (!record(command) || !nonEmpty(command.ownerId) || !nonEmpty(command.sourceId) || !Number.isSafeInteger(command.sourceRevision) || command.sourceRevision < 1 || !["inference-failed", "legacy-conflict", "legacy-unclassified"].includes(command.issueKind)) return { ok: false, error: { kind: "SourceClassificationCommandInvalid" } };
    const now = this.#now();
    if (!Number.isFinite(Date.parse(now))) return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
    this.#logger({ event: "source-classification-review-entry", ownerId: command.ownerId, sourceId: command.sourceId });
    try {
      const written = await this.#database.prepare("INSERT INTO source_classification_review_issues (owner_id, source_id, source_revision, issue_kind, attempts, created_at, updated_at) SELECT ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM library_sources WHERE owner_id = ? AND source_id = ? AND revision = ? AND state = 'active') ON CONFLICT(owner_id, source_id, source_revision) DO UPDATE SET issue_kind = excluded.issue_kind, attempts = source_classification_review_issues.attempts + 1, updated_at = excluded.updated_at").bind(command.ownerId, command.sourceId, command.sourceRevision, command.issueKind, now, now, command.ownerId, command.sourceId, command.sourceRevision).run();
      if (!written.success || (written.meta?.changes ?? 0) < 1) return { ok: false, error: { kind: "SourceClassificationSourceMissing" } };
      this.#logger({ event: "source-classification-review-success", ownerId: command.ownerId, sourceId: command.sourceId });
      return { ok: true, value: null };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.#logger({ event: "source-classification-review-failure", ownerId: command.ownerId, sourceId: command.sourceId, failureKind: "SourceClassificationPersistenceFailed" });
      return { ok: false, error: { kind: "SourceClassificationPersistenceFailed" } };
    }
  }
}

/** @param {unknown} command @returns {command is { readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly classification: SourceClassification }} */
function validClassificationInput(command) {
  return record(command) && nonEmpty(command.ownerId) && nonEmpty(command.sourceId) && typeof command.sourceRevision === "number" && Number.isSafeInteger(command.sourceRevision) && command.sourceRevision > 0 && record(command.classification) && Object.keys(command.classification).sort().join(",") === "mainSubject,topic" && isSubjectId(command.classification.mainSubject) && typeof command.classification.topic === "string" && command.classification.topic.trim() === command.classification.topic && command.classification.topic.length > 0 && command.classification.topic.length <= 120 && !/[<>\x00-\x1f\x7f]/u.test(command.classification.topic);
}

export {};
