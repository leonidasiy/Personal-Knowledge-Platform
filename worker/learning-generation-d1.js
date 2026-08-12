// @ts-check

import { isNonEmptyText, isPositiveInteger, isRecord } from "../src/features/learning-generation/contracts.js";

/** @import { LearningGenerationFailure, LearningGenerationRecord, LearningGenerationReplay, LearningGenerationStatus, LearningGenerationStatusFailure, LearningNonContentFact, LearningRevocationCommand, LearningRevocationFailure, LearningRevocationResult, LearningRevocationTombstone, LearningReviewAudit, LearningReviewCommand, LearningReviewFailure, LearningReviewQueue, LearningReviewQueueFailure, LearningReviewQueueTask, LearningTask, Result } from "../src/features/learning-generation/contracts.js" */

const freeze = Object.freeze;

/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly first: () => Promise<unknown | null>, readonly all: () => Promise<{ readonly success: boolean, readonly results: readonly unknown[] }>, readonly run: () => Promise<D1Result> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement, readonly batch: (statements: readonly D1Statement[]) => Promise<readonly D1Result[]> }} D1DatabasePort */
/** @typedef {(entry: { readonly event: string, readonly failureKind?: string, readonly itemCount?: number }) => void} LearningD1Logger */
/** @typedef {{ readonly generationId: string, readonly status: "completed" | "failed", readonly failureKind: string | null, readonly pendingTaskCount: number, readonly reviewedTaskCount: number }} QueueGeneration */

export class D1LearningGenerationRepository {
  #database;
  #logger;

  /** @param {{ readonly database: D1DatabasePort, readonly logger: LearningD1Logger }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.database.batch !== "function" || typeof dependencies.logger !== "function") throw new TypeError("D1 learning-generation dependencies are invalid.");
    this.#database = dependencies.database;
    this.#logger = dependencies.logger;
  }

  /** @param {string} ownerId @param {string} idempotencyKey @returns {Promise<Result<LearningGenerationReplay | null, LearningGenerationFailure>>} */
  async replay(ownerId, idempotencyKey) {
    if (!isNonEmptyText(ownerId) || !isNonEmptyText(idempotencyKey)) return generationFailure(this.#logger, "LearningGenerationPersistenceFailed");
    try {
      const row = await this.#database.prepare("SELECT generation_id, command_fingerprint, record_json FROM learning_generation_jobs WHERE owner_id = ? AND idempotency_key = ? LIMIT 1").bind(ownerId, idempotencyKey).first();
      if (row === null) return { ok: true, value: null };
      if (!isRecord(row) || !isNonEmptyText(row.generation_id) || !isNonEmptyText(row.command_fingerprint) || !isNonEmptyText(row.record_json)) return generationFailure(this.#logger, "LearningGenerationPersistenceFailed");
      const record = parseRecord(row.record_json);
      if (record === null || record.ownerId !== ownerId) return generationFailure(this.#logger, "LearningGenerationPersistenceFailed");
      return { ok: true, value: freeze({ id: record.id, fingerprint: row.command_fingerprint, record }) };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningGenerationPersistenceFailed"); }
  }

  /** @param {string} ownerId @param {string} generationId @returns {Promise<Result<LearningGenerationStatus | null, LearningGenerationStatusFailure>>} */
  async getStatus(ownerId, generationId) {
    if (!isNonEmptyText(ownerId) || !isNonEmptyText(generationId)) return statusFailure(this.#logger, "LearningGenerationStatusPersistenceFailed");
    try {
      const row = await this.#database.prepare("SELECT generation_id, source_id, source_revision, item_id, item_version_id, status, local_only, policy_version, provider_request_id, failure_kind, created_at FROM learning_generation_jobs WHERE owner_id = ? AND generation_id = ? LIMIT 1").bind(ownerId, generationId).first();
      if (row === null) return { ok: true, value: null };
      if (!isRecord(row) || !isNonEmptyText(row.generation_id) || !isNonEmptyText(row.source_id) || !isPositiveInteger(row.source_revision) || !isNonEmptyText(row.item_id) || !isNonEmptyText(row.item_version_id) || (row.status !== "completed" && row.status !== "failed" && row.status !== "revoked") || (row.local_only !== 0 && row.local_only !== 1) || !isNonEmptyText(row.policy_version) || (row.provider_request_id !== null && !isNonEmptyText(row.provider_request_id)) || (row.failure_kind !== null && !isNonEmptyText(row.failure_kind)) || !isNonEmptyText(row.created_at)) return statusFailure(this.#logger, "LearningGenerationStatusPersistenceFailed");
      const rows = (await this.#database.prepare("SELECT status, COUNT(*) AS count FROM learning_generation_tasks WHERE owner_id = ? AND generation_id = ? GROUP BY status").bind(ownerId, generationId).all()).results;
      const counts = { published: 0, pendingReview: 0, rejected: 0, hidden: 0 };
      for (const task of rows) {
        if (!isRecord(task) || typeof task.count !== "number" || !Number.isInteger(task.count) || task.count < 0) return statusFailure(this.#logger, "LearningGenerationStatusPersistenceFailed");
        if (task.status === "published") counts.published = task.count;
        else if (task.status === "pending-review") counts.pendingReview = task.count;
        else if (task.status === "rejected") counts.rejected = task.count;
        else if (task.status === "hidden") counts.hidden = task.count;
        else return statusFailure(this.#logger, "LearningGenerationStatusPersistenceFailed");
      }
      return { ok: true, value: freeze({ id: row.generation_id, ownerId, sourceId: row.source_id, sourceRevision: row.source_revision, itemId: row.item_id, itemVersionId: row.item_version_id, status: row.status, localOnly: row.local_only === 1, policyVersion: row.policy_version, providerRequestId: row.provider_request_id, failureKind: row.failure_kind, taskCounts: freeze(counts), createdAt: row.created_at }) };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningGenerationStatusPersistenceFailed"); }
  }

  /** @param {LearningGenerationRecord} record @param {string} fingerprint @returns {Promise<Result<LearningGenerationRecord, LearningGenerationFailure>>} */
  async persist(record, fingerprint) {
    this.#logger({ event: "learning-generation-d1-persist-entry", itemCount: record.units.length });
    if (!validRecord(record) || !isNonEmptyText(fingerprint)) return generationFailure(this.#logger, "LearningGenerationPersistenceFailed");
    try {
      const revoked = await this.#database.prepare("SELECT MAX(source_revision) AS revoked_through FROM learning_generation_revocations WHERE owner_id = ? AND source_id = ?").bind(record.ownerId, record.sourceId).first();
      if (isRecord(revoked) && typeof revoked.revoked_through === "number" && revoked.revoked_through >= record.sourceRevision) return generationFailure(this.#logger, "LearningFreshRightsRequired", record.sourceId, record.sourceRevision);
      const existing = await this.#database.prepare("SELECT generation_id, command_fingerprint, record_json FROM learning_generation_jobs WHERE owner_id = ? AND idempotency_key = ? LIMIT 1").bind(record.ownerId, record.idempotencyKey).first();
      if (existing !== null) {
        if (!isRecord(existing) || !isNonEmptyText(existing.command_fingerprint) || !isNonEmptyText(existing.record_json)) return generationFailure(this.#logger, "LearningGenerationPersistenceFailed");
        if (existing.command_fingerprint !== fingerprint) return generationFailure(this.#logger, "LearningGenerationIdempotencyConflict", record.idempotencyKey);
        const replay = parseRecord(existing.record_json);
        return replay === null ? generationFailure(this.#logger, "LearningGenerationPersistenceFailed") : { ok: true, value: replay };
      }
      const statements = [this.#database.prepare("INSERT INTO learning_generation_jobs (owner_id, generation_id, source_id, source_revision, item_id, item_version_id, content_digest, source_kind, rights_evidence_id, attribution_json, policy_version, status, local_only, provider_request_id, failure_kind, idempotency_key, command_fingerprint, record_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(record.ownerId, record.id, record.sourceId, record.sourceRevision, record.itemId, record.itemVersionId, record.contentDigest, record.sourceKind, record.rightsEvidenceId, record.attribution === null ? null : JSON.stringify(record.attribution), record.policyVersion, record.status, record.localOnly ? 1 : 0, record.providerRequestId, record.failureKind, record.idempotencyKey, fingerprint, JSON.stringify(record), record.createdAt), ...record.units.map((unit) => this.#database.prepare("INSERT INTO learning_generation_units (owner_id, generation_id, unit_id, source_revision, item_id, item_version_id, unit_json) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(record.ownerId, record.id, unit.id, unit.sourceRevision, unit.itemId, unit.itemVersionId, JSON.stringify(unit))), ...record.tasks.map((task) => this.#database.prepare("INSERT INTO learning_generation_tasks (owner_id, generation_id, task_id, source_revision, item_id, item_version_id, status, revision, task_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(record.ownerId, record.id, task.id, task.sourceRevision, task.itemId, task.itemVersionId, task.status, task.revision, JSON.stringify(task)))];
      const results = await this.#database.batch(statements);
      if (results.length !== statements.length || results.some((result) => result.meta?.changes !== 1)) return generationFailure(this.#logger, "LearningGenerationPersistenceFailed");
      this.#logger({ event: "learning-generation-d1-persist-success", itemCount: record.units.length });
      return { ok: true, value: clone(record) };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningGenerationPersistenceFailed"); }
  }

  /** @param {string} ownerId @param {string} sourceId @param {number} sourceRevision @returns {Promise<Result<true, LearningGenerationFailure>>} */
  async assertGenerationAllowed(ownerId, sourceId, sourceRevision) {
    if (!isNonEmptyText(ownerId) || !isNonEmptyText(sourceId) || !isPositiveInteger(sourceRevision)) return generationFailure(this.#logger, "LearningGenerationPersistenceFailed");
    try {
      const row = await this.#database.prepare("SELECT MAX(source_revision) AS revoked_through FROM learning_generation_revocations WHERE owner_id = ? AND source_id = ?").bind(ownerId, sourceId).first();
      return isRecord(row) && typeof row.revoked_through === "number" && row.revoked_through >= sourceRevision ? generationFailure(this.#logger, "LearningFreshRightsRequired", sourceId, sourceRevision) : { ok: true, value: true };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningGenerationPersistenceFailed"); }
  }

  /** @param {string} ownerId @param {string} taskId @returns {Promise<Result<LearningTask | null, LearningReviewFailure>>} */
  async findTask(ownerId, taskId) {
    if (!isNonEmptyText(ownerId) || !isNonEmptyText(taskId)) return reviewFailure(this.#logger, "LearningReviewPersistenceFailed");
    try {
      const row = await this.#database.prepare("SELECT t.task_json, t.status, j.status AS generation_status FROM learning_generation_tasks t JOIN learning_generation_jobs j ON j.owner_id = t.owner_id AND j.generation_id = t.generation_id WHERE t.owner_id = ? AND t.task_id = ? LIMIT 1").bind(ownerId, taskId).first();
      if (row === null || !isRecord(row) || row.generation_status === "revoked" || row.status === "hidden") return { ok: true, value: null };
      const task = isNonEmptyText(row.task_json) ? parseTask(row.task_json) : null;
      return task === null ? reviewFailure(this.#logger, "LearningReviewPersistenceFailed") : { ok: true, value: task };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningReviewPersistenceFailed"); }
  }

  /** @param {LearningReviewCommand} command @returns {Promise<Result<LearningTask, LearningReviewFailure>>} */
  async applyDecision(command) {
    if (!validReviewCommand(command)) return reviewFailure(this.#logger, "LearningReviewPersistenceFailed");
    try {
      const fingerprint = JSON.stringify([command.taskId, command.expectedRevision, command.decision, command.reviewedAt]);
      const audit = await this.#database.prepare("SELECT idempotency_key, command_fingerprint FROM learning_generation_review_audits WHERE owner_id = ? AND idempotency_key = ? LIMIT 1").bind(command.ownerId, command.idempotencyKey).first();
      if (audit !== null) {
        if (!isRecord(audit) || audit.command_fingerprint !== fingerprint) return reviewFailure(this.#logger, "LearningReviewIdempotencyConflict", command.idempotencyKey);
        const replay = await this.findTask(command.ownerId, command.taskId);
        return replay.ok && replay.value !== null ? { ok: true, value: replay.value } : reviewFailure(this.#logger, "LearningReviewPersistenceFailed");
      }
      const row = await this.#database.prepare("SELECT t.task_json, t.status, t.revision, t.generation_id, j.record_json, j.status AS generation_status FROM learning_generation_tasks t JOIN learning_generation_jobs j ON j.owner_id = t.owner_id AND j.generation_id = t.generation_id WHERE t.owner_id = ? AND t.task_id = ? LIMIT 1").bind(command.ownerId, command.taskId).first();
      if (row === null || !isRecord(row)) return reviewFailure(this.#logger, "LearningReviewTaskUnknown", command.taskId);
      const current = isNonEmptyText(row.task_json) ? parseTask(row.task_json) : null;
      const record = isNonEmptyText(row.record_json) ? parseRecord(row.record_json) : null;
      if (current === null || record === null) return reviewFailure(this.#logger, "LearningReviewPersistenceFailed");
      if (row.generation_status === "revoked" || current.status === "hidden") return reviewFailure(this.#logger, "LearningReviewTaskUnknown", command.taskId);
      if (current.status !== "pending-review") return reviewFailure(this.#logger, "LearningReviewAlreadyDecided", command.taskId);
      if (current.revision !== command.expectedRevision) return reviewFailure(this.#logger, "LearningReviewRevisionStale", command.expectedRevision, current.revision);
      const decided = freeze({ ...current, status: command.decision === "approve" ? "published" : "rejected", reviewDecision: command.decision === "approve" ? "approved" : "rejected", reviewedAt: command.reviewedAt, revision: current.revision + 1 });
      const nextRecord = clone({ ...record, tasks: freeze(record.tasks.map((task) => task.id === command.taskId ? decided : task)) });
      const statements = [this.#database.prepare("UPDATE learning_generation_tasks SET status = ?, revision = ?, task_json = ? WHERE owner_id = ? AND task_id = ? AND status = 'pending-review' AND revision = ?").bind(decided.status, decided.revision, JSON.stringify(decided), command.ownerId, command.taskId, command.expectedRevision), this.#database.prepare("UPDATE learning_generation_jobs SET record_json = ? WHERE owner_id = ? AND generation_id = ?").bind(JSON.stringify(nextRecord), command.ownerId, record.id), this.#database.prepare("INSERT INTO learning_generation_review_audits (owner_id, audit_id, task_id, decision, expected_revision, resulting_revision, idempotency_key, command_fingerprint, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(command.ownerId, `audit:${encodeURIComponent(command.idempotencyKey)}`, command.taskId, command.decision, command.expectedRevision, decided.revision, command.idempotencyKey, fingerprint, command.reviewedAt)];
      const results = await this.#database.batch(statements);
      if (results.length !== statements.length || results.some((result) => result.meta?.changes !== 1)) {
        const currentAfterRace = await this.#database.prepare("SELECT status, revision FROM learning_generation_tasks WHERE owner_id = ? AND task_id = ? LIMIT 1").bind(command.ownerId, command.taskId).first();
        if (isRecord(currentAfterRace) && currentAfterRace.status !== "pending-review") return reviewFailure(this.#logger, "LearningReviewAlreadyDecided", command.taskId);
        if (isRecord(currentAfterRace) && isPositiveInteger(currentAfterRace.revision) && currentAfterRace.revision !== command.expectedRevision) return reviewFailure(this.#logger, "LearningReviewRevisionStale", command.expectedRevision, currentAfterRace.revision);
        return reviewFailure(this.#logger, "LearningReviewPersistenceFailed");
      }
      return { ok: true, value: clone(decided) };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningReviewPersistenceFailed"); }
  }

  /** @param {string} ownerId @returns {Promise<Result<readonly LearningTask[], LearningReviewFailure>>} */
  async listVisible(ownerId) {
    if (!isNonEmptyText(ownerId)) return reviewFailure(this.#logger, "LearningReviewPersistenceFailed");
    try {
      const rows = (await this.#database.prepare("SELECT t.task_json FROM learning_generation_tasks t JOIN learning_generation_jobs j ON j.owner_id = t.owner_id AND j.generation_id = t.generation_id WHERE t.owner_id = ? AND t.status = 'published' AND j.status <> 'revoked' ORDER BY j.created_at, t.task_id").bind(ownerId).all()).results;
      const tasks = [];
      for (const row of rows) { if (!isRecord(row) || !isNonEmptyText(row.task_json)) return reviewFailure(this.#logger, "LearningReviewPersistenceFailed"); const task = parseTask(row.task_json); if (task === null) return reviewFailure(this.#logger, "LearningReviewPersistenceFailed"); tasks.push(task); }
      return { ok: true, value: freeze(tasks) };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningReviewPersistenceFailed"); }
  }

  /** @param {string} ownerId @returns {Promise<Result<LearningReviewQueue, LearningReviewQueueFailure>>} */
  async listQueue(ownerId) {
    if (!isNonEmptyText(ownerId)) return queueFailure(this.#logger, "LearningReviewQueuePersistenceFailed");
    this.#logger({ event: "learning-review-queue-d1-entry" });
    try {
      const sourceRows = (await this.#database.prepare(
        "SELECT s.source_id, s.title, s.adapter_json, (SELECT j.state FROM source_ingestion_jobs j WHERE j.owner_id = s.owner_id AND j.source_id = s.source_id ORDER BY j.source_revision DESC, j.created_at DESC, j.job_id DESC LIMIT 1) AS ingestion_state, (SELECT j.stop_reason FROM source_ingestion_jobs j WHERE j.owner_id = s.owner_id AND j.source_id = s.source_id ORDER BY j.source_revision DESC, j.created_at DESC, j.job_id DESC LIMIT 1) AS ingestion_failure, (SELECT j.generation_state FROM source_ingestion_jobs j WHERE j.owner_id = s.owner_id AND j.source_id = s.source_id ORDER BY j.source_revision DESC, j.created_at DESC, j.job_id DESC LIMIT 1) AS generation_state, (SELECT j.generation_failure FROM source_ingestion_jobs j WHERE j.owner_id = s.owner_id AND j.source_id = s.source_id ORDER BY j.source_revision DESC, j.created_at DESC, j.job_id DESC LIMIT 1) AS generation_failure, (SELECT COUNT(*) FROM source_content_references c WHERE c.owner_id = s.owner_id AND c.source_id = s.source_id AND c.state = 'processing-ready') AS content_count FROM library_sources s WHERE s.owner_id = ? AND s.state = 'active' ORDER BY s.approved_at DESC, s.source_id DESC",
      ).bind(ownerId).all()).results;
      const generationRows = (await this.#database.prepare(
        "SELECT g.generation_id, g.source_id, g.status, g.failure_kind, g.created_at, SUM(CASE WHEN t.status = 'pending-review' THEN 1 ELSE 0 END) AS pending_count, SUM(CASE WHEN t.status IN ('published', 'rejected') THEN 1 ELSE 0 END) AS reviewed_count FROM learning_generation_jobs g LEFT JOIN learning_generation_tasks t ON t.owner_id = g.owner_id AND t.generation_id = g.generation_id WHERE g.owner_id = ? AND g.status <> 'revoked' GROUP BY g.owner_id, g.generation_id ORDER BY g.created_at DESC, g.generation_id DESC",
      ).bind(ownerId).all()).results;
      const taskRows = (await this.#database.prepare(
        "SELECT t.task_json FROM learning_generation_tasks t JOIN learning_generation_jobs g ON g.owner_id = t.owner_id AND g.generation_id = t.generation_id WHERE t.owner_id = ? AND t.status = 'pending-review' AND g.status = 'completed' ORDER BY g.created_at, t.task_id",
      ).bind(ownerId).all()).results;
      /** @type {Map<string, QueueGeneration>} */
      const generations = new Map();
      for (const value of generationRows) {
        if (!isRecord(value) || !isNonEmptyText(value.generation_id) || !isNonEmptyText(value.source_id) || (value.status !== "completed" && value.status !== "failed") || (value.failure_kind !== null && !isNonEmptyText(value.failure_kind)) || !isNonEmptyText(value.created_at) || !isNonNegativeInteger(value.pending_count) || !isNonNegativeInteger(value.reviewed_count)) return queueFailure(this.#logger, "LearningReviewQueuePersistenceFailed");
        if (!generations.has(value.source_id)) generations.set(value.source_id, freeze({ generationId: value.generation_id, status: value.status, failureKind: value.failure_kind, pendingTaskCount: value.pending_count, reviewedTaskCount: value.reviewed_count }));
      }
      const sources = [];
      for (const value of sourceRows) {
        if (!isRecord(value) || !isNonEmptyText(value.source_id) || !isNonEmptyText(value.title) || !isNonEmptyText(value.adapter_json) || (value.ingestion_state !== null && value.ingestion_state !== undefined && !isNonEmptyText(value.ingestion_state)) || (value.ingestion_failure !== null && value.ingestion_failure !== undefined && !isNonEmptyText(value.ingestion_failure)) || !validGenerationState(value.generation_state) || (value.generation_failure !== null && value.generation_failure !== undefined && !isNonEmptyText(value.generation_failure)) || !isNonNegativeInteger(value.content_count)) return queueFailure(this.#logger, "LearningReviewQueuePersistenceFailed");
        const bounded = boundedIngestionCapability(value.adapter_json);
        if (bounded === null) return queueFailure(this.#logger, "LearningReviewQueuePersistenceFailed");
        const generation = generations.get(value.source_id) ?? null;
        const status = queueStatus(bounded, value.ingestion_state, value.ingestion_failure, value.generation_state, value.generation_failure, value.content_count, generation);
        sources.push(freeze({ sourceId: value.source_id, title: value.title, status: status.status, generationId: generation?.generationId ?? null, pendingTaskCount: generation?.pendingTaskCount ?? 0, reviewedTaskCount: generation?.reviewedTaskCount ?? 0, failureKind: status.failureKind }));
      }
      const tasks = [];
      for (const value of taskRows) {
        if (!isRecord(value) || !isNonEmptyText(value.task_json)) return queueFailure(this.#logger, "LearningReviewQueuePersistenceFailed");
        const task = parseTask(value.task_json);
        if (task === null || task.status !== "pending-review") return queueFailure(this.#logger, "LearningReviewQueuePersistenceFailed");
        tasks.push(reviewTaskProjection(task));
      }
      return { ok: true, value: freeze({ sources: freeze(sources), tasks: freeze(tasks) }) };
    } catch (error) {
      if (error instanceof Error) return queueFailure(this.#logger, "LearningReviewQueuePersistenceFailed");
      throw error;
    }
  }

  /** @param {LearningRevocationCommand} command @param {string} fingerprint @returns {Promise<Result<LearningRevocationResult, LearningRevocationFailure>>} */
  async revoke(command, fingerprint) {
    this.#logger({ event: "learning-revocation-d1-entry" });
    if (!validRevocationCommand(command) || !isNonEmptyText(fingerprint)) return revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
    try {
      const existing = await this.#database.prepare("SELECT command_fingerprint, result_json FROM learning_generation_revocations WHERE owner_id = ? AND idempotency_key = ? LIMIT 1").bind(command.ownerId, command.idempotencyKey).first();
      if (existing !== null) {
        if (!isRecord(existing) || existing.command_fingerprint !== fingerprint || !isNonEmptyText(existing.result_json)) return revocationFailure(this.#logger, "LearningRevocationConflict", command.idempotencyKey);
        const result = parseRevocationResult(existing.result_json);
        return result === null ? revocationFailure(this.#logger, "LearningRevocationPersistenceFailed") : { ok: true, value: freeze({ ...result, reused: true }) };
      }
      const rows = (await this.#database.prepare("SELECT generation_id, source_revision, item_id, item_version_id, status, record_json FROM learning_generation_jobs WHERE owner_id = ? AND source_id = ? AND source_revision <= ? ORDER BY generation_id").bind(command.ownerId, command.sourceId, command.sourceRevision).all()).results;
      /** @type {LearningRevocationTombstone[]} */ const tombstones = [];
      /** @type {D1Statement[]} */ const statements = [];
      let changedGenerations = 0; let changedUnits = 0; let changedTasks = 0;
      for (const row of rows) {
        if (!isRecord(row) || !isNonEmptyText(row.generation_id) || !isPositiveInteger(row.source_revision) || !isNonEmptyText(row.item_id) || !isNonEmptyText(row.item_version_id) || row.status === "revoked" || !isNonEmptyText(row.record_json)) continue;
        const record = parseRecord(row.record_json); if (record === null) return revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
        const hiddenTasks = record.tasks.map((task) => freeze({ ...task, status: "hidden", revision: task.revision + 1 }));
        const hidden = /** @type {LearningGenerationRecord} */ (clone({ ...record, tasks: freeze(hiddenTasks), status: /** @type {const} */ ("revoked") }));
        statements.push(this.#database.prepare("UPDATE learning_generation_jobs SET status = 'revoked', record_json = ? WHERE owner_id = ? AND generation_id = ? AND status <> 'revoked'").bind(JSON.stringify(hidden), command.ownerId, record.id));
        for (const unit of record.units) { changedUnits += 1; tombstones.push(makeTombstone(command, record, "unit", unit.id)); }
        for (const task of record.tasks) { changedTasks += 1; statements.push(this.#database.prepare("UPDATE learning_generation_tasks SET status = 'hidden', revision = ?, task_json = ? WHERE owner_id = ? AND task_id = ? AND status <> 'hidden'").bind(task.revision + 1, JSON.stringify(hiddenTasks.find((candidate) => candidate.id === task.id)), command.ownerId, task.id)); tombstones.push(makeTombstone(command, record, "task", task.id)); }
        changedGenerations += 1; tombstones.push(makeTombstone(command, record, "generation", record.id));
      }
      const result = freeze({ changedGenerations, changedUnits, changedTasks, tombstones: freeze(tombstones), reused: false });
      statements.push(this.#database.prepare("INSERT INTO learning_generation_revocations (owner_id, revocation_id, source_id, source_revision, idempotency_key, command_fingerprint, reason, result_json, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(command.ownerId, `revocation:${encodeURIComponent(command.idempotencyKey)}`, command.sourceId, command.sourceRevision, command.idempotencyKey, fingerprint, command.reason, JSON.stringify(result), command.revokedAt));
      for (const tombstone of tombstones) statements.push(this.#database.prepare("INSERT INTO learning_generation_tombstones (owner_id, tombstone_id, source_id, source_revision, item_id, item_version_id, descendant_kind, descendant_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(tombstone.ownerId, tombstone.id, tombstone.sourceId, tombstone.sourceRevision, tombstone.itemId, tombstone.itemVersionId, tombstone.descendantKind, tombstone.descendantId, tombstone.reason, tombstone.revokedAt));
      const results = await this.#database.batch(statements);
      if (results.length !== statements.length || results.some((entry) => entry.meta?.changes !== 1)) return revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
      this.#logger({ event: "learning-revocation-d1-success", itemCount: tombstones.length });
      return { ok: true, value: result };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningRevocationPersistenceFailed"); }
  }

  /** @param {string} ownerId @returns {Promise<Result<readonly LearningRevocationTombstone[], LearningRevocationFailure>>} */
  async listTombstones(ownerId) {
    if (!isNonEmptyText(ownerId)) return revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
    try {
      const rows = (await this.#database.prepare("SELECT tombstone_id, source_id, source_revision, item_id, item_version_id, descendant_kind, descendant_id, reason, revoked_at FROM learning_generation_tombstones WHERE owner_id = ? ORDER BY revoked_at, tombstone_id").bind(ownerId).all()).results;
      const tombstones = rows.map((row) => parseTombstone(row, ownerId)).filter((value) => value !== null);
      if (tombstones.length !== rows.length) return revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
      return { ok: true, value: freeze(tombstones) };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningRevocationPersistenceFailed"); }
  }

  /** @param {LearningNonContentFact} fact @returns {Promise<Result<LearningNonContentFact, LearningRevocationFailure>>} */
  async recordFact(fact) {
    if (!validFact(fact)) return revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
    try {
      const id = `fact:${encodeURIComponent(fact.taskId)}:${encodeURIComponent(fact.kind)}:${encodeURIComponent(fact.occurredAt)}`;
      const result = await this.#database.prepare("INSERT INTO learning_generation_facts (owner_id, fact_id, task_id, fact_kind, occurred_at, correct, schedule_step) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(fact.ownerId, id, fact.taskId, fact.kind, fact.occurredAt, fact.correct === null ? null : fact.correct ? 1 : 0, fact.scheduleStep).run();
      return result.meta?.changes === 1 ? { ok: true, value: freeze({ ...fact }) } : revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
    } catch (error) { return databaseFailure(error, this.#logger, "LearningRevocationPersistenceFailed"); }
  }

  /** @param {string} ownerId @returns {Promise<Result<readonly LearningNonContentFact[], LearningRevocationFailure>>} */
  async listFacts(ownerId) {
    if (!isNonEmptyText(ownerId)) return revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
    try {
      const rows = (await this.#database.prepare("SELECT task_id, fact_kind, occurred_at, correct, schedule_step FROM learning_generation_facts WHERE owner_id = ? ORDER BY occurred_at, fact_id").bind(ownerId).all()).results;
      const facts = rows.map((row) => isRecord(row) && isNonEmptyText(row.task_id) && (row.fact_kind === "review-decision" || row.fact_kind === "study-response" || row.fact_kind === "schedule") && isNonEmptyText(row.occurred_at) && (row.correct === null || row.correct === 0 || row.correct === 1) && (row.schedule_step === null || typeof row.schedule_step === "number") ? freeze({ ownerId, taskId: row.task_id, kind: row.fact_kind, occurredAt: row.occurred_at, correct: row.correct === null ? null : row.correct === 1, scheduleStep: row.schedule_step }) : null);
      if (facts.some((fact) => fact === null)) return revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
      return { ok: true, value: freeze(/** @type {LearningNonContentFact[]} */ (facts)) };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningRevocationPersistenceFailed"); }
  }

  /** @param {string} ownerId @returns {Promise<Result<readonly LearningReviewAudit[], LearningRevocationFailure>>} */
  async listReviewAudits(ownerId) {
    if (!isNonEmptyText(ownerId)) return revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
    try {
      const rows = (await this.#database.prepare("SELECT task_id, decision, expected_revision, resulting_revision, idempotency_key, occurred_at FROM learning_generation_review_audits WHERE owner_id = ? ORDER BY occurred_at, audit_id").bind(ownerId).all()).results;
      const audits = rows.map((row) => isRecord(row) && isNonEmptyText(row.task_id) && (row.decision === "approve" || row.decision === "reject") && isPositiveInteger(row.expected_revision) && isPositiveInteger(row.resulting_revision) && isNonEmptyText(row.idempotency_key) && isNonEmptyText(row.occurred_at) ? freeze({ ownerId, taskId: row.task_id, decision: row.decision, expectedRevision: row.expected_revision, resultingRevision: row.resulting_revision, idempotencyKey: row.idempotency_key, occurredAt: row.occurred_at }) : null);
      if (audits.some((audit) => audit === null)) return revocationFailure(this.#logger, "LearningRevocationPersistenceFailed");
      return { ok: true, value: freeze(/** @type {LearningReviewAudit[]} */ (audits)) };
    } catch (error) { return databaseFailure(error, this.#logger, "LearningRevocationPersistenceFailed"); }
  }
}

/** @param {D1DatabasePort} _database */
export function isD1LearningGenerationDatabase(_database) { return typeof _database?.prepare === "function" && typeof _database?.batch === "function"; }

/** @param {unknown} value @returns {value is LearningGenerationRecord} */
function validRecord(value) { return isRecord(value) && isNonEmptyText(value.id) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.sourceId) && isPositiveInteger(value.sourceRevision) && isNonEmptyText(value.itemId) && isNonEmptyText(value.itemVersionId) && isNonEmptyText(value.contentDigest) && isNonEmptyText(value.rightsEvidenceId) && isNonEmptyText(value.policyVersion) && Array.isArray(value.units) && Array.isArray(value.tasks) && isNonEmptyText(value.idempotencyKey) && isNonEmptyText(value.createdAt) && (value.status === "completed" || value.status === "failed" || value.status === "revoked") && typeof value.localOnly === "boolean" && (value.attribution === null || isRecord(value.attribution)); }
/** @param {unknown} value @returns {LearningGenerationRecord | null} */
function parseRecord(value) { let parsed; try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch (error) { if (error instanceof SyntaxError) return null; throw error; } return validRecord(parsed) ? clone(parsed) : null; }
/** @param {unknown} value @returns {LearningTask | null} */
function parseTask(value) { let parsed; try { parsed = JSON.parse(String(value)); } catch (error) { if (error instanceof SyntaxError) return null; throw error; } return isRecord(parsed) && isNonEmptyText(parsed.id) && (parsed.status === "pending-review" || parsed.status === "published" || parsed.status === "rejected" || parsed.status === "hidden") && isPositiveInteger(parsed.revision) ? clone(/** @type {LearningTask} */ (parsed)) : null; }
/** @param {LearningTask} task @returns {LearningReviewQueueTask} */
function reviewTaskProjection(task) { return freeze({ id: task.id, sourceId: task.sourceId, kind: task.kind, prompt: task.prompt, explanation: task.explanation, sourceAnchorIds: task.sourceAnchorIds, choices: task.choices, correctChoiceIds: task.correctChoiceIds, expectedConcepts: task.expectedConcepts, minimumWords: task.minimumWords, stimulus: task.stimulus, responseKind: task.responseKind, status: /** @type {const} */ ("pending-review"), revision: task.revision }); }
/** @param {unknown} value @returns {LearningRevocationResult | null} */
function parseRevocationResult(value) { let parsed; try { parsed = JSON.parse(String(value)); } catch (error) { if (error instanceof SyntaxError) return null; throw error; } return isRecord(parsed) && typeof parsed.changedGenerations === "number" && typeof parsed.changedUnits === "number" && typeof parsed.changedTasks === "number" && Array.isArray(parsed.tombstones) ? clone(/** @type {LearningRevocationResult} */ (parsed)) : null; }
/** @param {unknown} value @param {string} ownerId @returns {LearningRevocationTombstone | null} */
function parseTombstone(value, ownerId) { if (!isRecord(value) || !isNonEmptyText(value.tombstone_id) || !isNonEmptyText(value.source_id) || !isPositiveInteger(value.source_revision) || !isNonEmptyText(value.item_id) || !isNonEmptyText(value.item_version_id) || (value.descendant_kind !== "generation" && value.descendant_kind !== "unit" && value.descendant_kind !== "task") || !isNonEmptyText(value.descendant_id) || !isNonEmptyText(value.reason) || !isNonEmptyText(value.revoked_at)) return null; return freeze({ id: value.tombstone_id, ownerId, sourceId: value.source_id, sourceRevision: value.source_revision, itemId: value.item_id, itemVersionId: value.item_version_id, descendantKind: value.descendant_kind, descendantId: value.descendant_id, reason: value.reason, revokedAt: value.revoked_at }); }
/** @param {LearningRevocationCommand} command @param {LearningGenerationRecord} record @param {"generation"|"unit"|"task"} kind @param {string} id @returns {LearningRevocationTombstone} */
function makeTombstone(command, record, kind, id) { return freeze({ id: `${record.id}:tombstone:${kind}:${id}`, ownerId: command.ownerId, sourceId: command.sourceId, sourceRevision: command.sourceRevision, itemId: record.itemId, itemVersionId: record.itemVersionId, descendantKind: kind, descendantId: id, reason: command.reason, revokedAt: command.revokedAt }); }
/** @param {unknown} value @returns {value is LearningReviewCommand} */
function validReviewCommand(value) { return isRecord(value) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.taskId) && isPositiveInteger(value.expectedRevision) && (value.decision === "approve" || value.decision === "reject") && isNonEmptyText(value.reviewedAt) && isNonEmptyText(value.idempotencyKey); }
/** @param {unknown} value @returns {value is LearningRevocationCommand} */
function validRevocationCommand(value) { return isRecord(value) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.sourceId) && isPositiveInteger(value.sourceRevision) && isNonEmptyText(value.idempotencyKey) && isNonEmptyText(value.reason) && isNonEmptyText(value.revokedAt); }
/** @param {unknown} value @returns {value is LearningNonContentFact} */
function validFact(value) { return isRecord(value) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.taskId) && (value.kind === "review-decision" || value.kind === "study-response" || value.kind === "schedule") && isNonEmptyText(value.occurredAt) && (value.correct === null || typeof value.correct === "boolean") && (value.scheduleStep === null || (typeof value.scheduleStep === "number" && Number.isInteger(value.scheduleStep) && value.scheduleStep >= 0 && value.scheduleStep <= 4)); }
/** @template E @param {unknown} error @param {LearningD1Logger} logger @param {string} kind @returns {Result<never, E>} */
function databaseFailure(error, logger, kind) { if (!(error instanceof Error)) throw error; const result = kind === "LearningGenerationStatusPersistenceFailed" ? statusFailure(logger, kind) : kind === "LearningReviewPersistenceFailed" ? reviewFailure(logger, kind) : kind === "LearningRevocationPersistenceFailed" ? revocationFailure(logger, kind) : generationFailure(logger, kind); return /** @type {Result<never, E>} */ (result); }
/** @param {LearningD1Logger} logger @param {string} kind @returns {Result<never, LearningReviewQueueFailure>} */
function queueFailure(logger, kind) { const error = { kind: /** @type {"LearningReviewQueuePersistenceFailed"} */ (kind) }; logger({ event: "learning-review-queue-d1-failure", failureKind: error.kind }); return { ok: false, error }; }
/** @param {LearningD1Logger} logger @param {string} kind @param {string} [first] @param {number} [second] @returns {Result<never, LearningGenerationFailure>} */
function generationFailure(logger, kind, first, second) { const error = kind === "LearningGenerationIdempotencyConflict" ? { kind, idempotencyKey: /** @type {string} */ (first) } : kind === "LearningFreshRightsRequired" ? { kind, sourceId: /** @type {string} */ (first), sourceRevision: /** @type {number} */ (second) } : { kind: /** @type {"LearningGenerationPersistenceFailed"} */ (kind) }; logger({ event: "learning-generation-d1-failure", failureKind: error.kind }); return { ok: false, error: /** @type {LearningGenerationFailure} */ (error) }; }
/** @param {LearningD1Logger} logger @param {string} kind @param {string|number} [first] @param {number} [second] @returns {Result<never, LearningReviewFailure>} */
function reviewFailure(logger, kind, first, second) { const error = kind === "LearningReviewTaskUnknown" || kind === "LearningReviewAlreadyDecided" ? { kind, taskId: /** @type {string} */ (first) } : kind === "LearningReviewRevisionStale" ? { kind, expected: /** @type {number} */ (first), actual: /** @type {number} */ (second) } : kind === "LearningReviewIdempotencyConflict" ? { kind, idempotencyKey: /** @type {string} */ (first) } : { kind: /** @type {"LearningReviewPersistenceFailed"} */ (kind) }; logger({ event: "learning-review-d1-failure", failureKind: error.kind }); return { ok: false, error: /** @type {LearningReviewFailure} */ (error) }; }
/** @param {LearningD1Logger} logger @param {string} kind @param {string} [id] @returns {Result<never, LearningRevocationFailure>} */
function revocationFailure(logger, kind, id) { const error = kind === "LearningRevocationConflict" ? { kind, idempotencyKey: /** @type {string} */ (id) } : { kind: /** @type {"LearningRevocationPersistenceFailed"} */ (kind) }; logger({ event: "learning-revocation-d1-failure", failureKind: error.kind }); return { ok: false, error: /** @type {LearningRevocationFailure} */ (error) }; }
/** @param {LearningD1Logger} logger @param {string} kind @returns {Result<never, LearningGenerationStatusFailure>} */
function statusFailure(logger, kind) { const error = { kind: /** @type {"LearningGenerationStatusPersistenceFailed"} */ (kind) }; logger({ event: "learning-generation-status-d1-failure", failureKind: error.kind }); return { ok: false, error }; }
/** @param {boolean} bounded @param {unknown} ingestionState @param {unknown} ingestionFailure @param {"not-requested"|"queued"|"completed"|"failed"} generationState @param {unknown} generationFailure @param {number} contentCount @param {QueueGeneration | null} generation @returns {{ readonly status: import("../src/features/learning-generation/contracts.js").LearningReviewQueueStatus, readonly failureKind: string | null }} */
function queueStatus(bounded, ingestionState, ingestionFailure, generationState, generationFailure, contentCount, generation) {
  if (!bounded) return { status: "unavailable", failureKind: "IngestionSourceAcquisitionProhibited" };
  if (generationState === "failed") return { status: "failed", failureKind: typeof generationFailure === "string" ? generationFailure : "LearningGenerationUnavailable" };
  if (generation?.status === "failed") return { status: "failed", failureKind: generation.failureKind ?? "LearningGenerationUnavailable" };
  if (generation !== null && generation.pendingTaskCount > 0) return { status: "ready-for-review", failureKind: null };
  if (generation !== null && generation.status === "completed" && generation.reviewedTaskCount > 0) return { status: "reviewed", failureKind: null };
  if (ingestionState === "pending") return { status: "queued", failureKind: null };
  if (ingestionState === "leased" || ingestionState === "partial") return { status: "generating", failureKind: null };
  if (ingestionState === "failed" || ingestionState === "cancelled") return { status: "failed", failureKind: typeof ingestionFailure === "string" ? ingestionFailure : "SourceIngestionUnavailable" };
  if (generationState === "queued") return { status: "generating", failureKind: null };
  if (generationState === "completed" && generation === null) return { status: "failed", failureKind: "LearningGenerationUnavailable" };
  if (contentCount > 0) return { status: "failed", failureKind: "LearningGenerationUnavailable" };
  return { status: "unavailable", failureKind: "LearningGenerationUnavailable" };
}
/** @param {unknown} value @returns {value is "not-requested"|"queued"|"completed"|"failed"} */
function validGenerationState(value) { return value === "not-requested" || value === "queued" || value === "completed" || value === "failed"; }
/** @param {string} value @returns {boolean | null} */
function boundedIngestionCapability(value) { let parsed; try { parsed = JSON.parse(value); } catch (error) { if (error instanceof SyntaxError) return null; throw error; } return isRecord(parsed) && Array.isArray(parsed.capabilities) && parsed.capabilities.every(isNonEmptyText) ? parsed.capabilities.includes("bounded-ingestion") : null; }
/** @param {unknown} value @returns {value is number} */
function isNonNegativeInteger(value) { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
/** @template T @param {T} value @returns {T} */
function clone(value) { return structuredClone(value); }

export {};
