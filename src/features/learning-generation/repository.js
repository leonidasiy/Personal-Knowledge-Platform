// @ts-check

import { isNonEmptyText, isPositiveInteger, isRecord } from "./contracts.js";

/** @import { LearningGenerationFailure, LearningGenerationRecord, LearningGenerationReplay, LearningGenerationStatus, LearningGenerationStatusFailure, LearningNonContentFact, LearningRevocationCommand, LearningRevocationFailure, LearningRevocationResult, LearningRevocationTombstone, LearningReviewAudit, LearningReviewCommand, LearningReviewFailure, LearningTask, Result } from "./contracts.js" */

const freeze = Object.freeze;

/**
 * A small repository implementation used by the feature tests and by local
 * composition. The Worker D1 adapter uses the same identity and state
 * contract; this class intentionally keeps content out of revocation records.
 */
export class LearningGenerationRepository {
  /** @type {Map<string, { readonly fingerprint: string, readonly record: LearningGenerationRecord }>} */
  #generations = new Map();
  /** @type {Map<string, string>} */
  #generationKeys = new Map();
  /** @type {Map<string, string>} */
  #taskGenerations = new Map();
  /** @type {Map<string, { readonly fingerprint: string, readonly result: LearningRevocationResult }>} */
  #revocationKeys = new Map();
  /** @type {Map<string, number>} */
  #revokedThrough = new Map();
  /** @type {LearningRevocationTombstone[]} */
  #tombstones = [];
  /** @type {LearningNonContentFact[]} */
  #facts = [];
  /** @type {LearningReviewAudit[]} */
  #reviewAudits = [];
  /** @type {Map<string, { readonly fingerprint: string, readonly task: LearningTask }>} */
  #reviewKeys = new Map();
  #logger;

  /** @param {{ readonly logger: import("./contracts.js").LearningLogger }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.logger !== "function") throw new TypeError("Learning-generation repository dependencies are invalid.");
    this.#logger = dependencies.logger;
  }

  /** @param {string} ownerId @param {string} idempotencyKey @returns {Promise<Result<LearningGenerationReplay | null, LearningGenerationFailure>>} */
  async replay(ownerId, idempotencyKey) {
    if (!isNonEmptyText(ownerId) || !isNonEmptyText(idempotencyKey)) return this.#generationFailure("LearningGenerationPersistenceFailed");
    const key = scopedKey(ownerId, idempotencyKey);
    const id = this.#generationKeys.get(key);
    if (id === undefined) return { ok: true, value: null };
    const stored = this.#generations.get(id);
    if (stored === undefined) throw new TypeError("Learning-generation idempotency invariant is broken.");
    return { ok: true, value: freeze({ id: stored.record.id, fingerprint: stored.fingerprint, record: clone(stored.record) }) };
  }

  /** @param {string} ownerId @param {string} generationId @returns {Promise<Result<LearningGenerationStatus | null, LearningGenerationStatusFailure>>} */
  async getStatus(ownerId, generationId) {
    if (!isNonEmptyText(ownerId) || !isNonEmptyText(generationId)) return { ok: false, error: { kind: "LearningGenerationStatusPersistenceFailed" } };
    const stored = this.#generations.get(generationId);
    if (stored === undefined || stored.record.ownerId !== ownerId) return { ok: true, value: null };
    const counts = { published: 0, pendingReview: 0, rejected: 0, hidden: 0 };
    for (const task of stored.record.tasks) {
      if (task.status === "published") counts.published += 1;
      else if (task.status === "pending-review") counts.pendingReview += 1;
      else if (task.status === "rejected") counts.rejected += 1;
      else counts.hidden += 1;
    }
    return { ok: true, value: freeze({ id: stored.record.id, ownerId: stored.record.ownerId, sourceId: stored.record.sourceId, sourceRevision: stored.record.sourceRevision, itemId: stored.record.itemId, itemVersionId: stored.record.itemVersionId, status: stored.record.status, localOnly: stored.record.localOnly, policyVersion: stored.record.policyVersion, providerRequestId: stored.record.providerRequestId, failureKind: stored.record.failureKind, taskCounts: freeze(counts), createdAt: stored.record.createdAt }) };
  }

  /** @param {LearningGenerationRecord} record @param {string} fingerprint @returns {Promise<Result<LearningGenerationRecord, LearningGenerationFailure>>} */
  async persist(record, fingerprint) {
    this.#logger({ event: "learning-generation-repository-entry" });
    if (!validRecord(record) || !isNonEmptyText(fingerprint)) return this.#generationFailure("LearningGenerationPersistenceFailed");
    const key = scopedKey(record.ownerId, record.idempotencyKey);
    const existingId = this.#generationKeys.get(key);
    if (existingId !== undefined) {
      const existing = this.#generations.get(existingId);
      if (existing === undefined) throw new TypeError("Learning-generation idempotency invariant is broken.");
      if (existing.fingerprint !== fingerprint) return this.#generationFailure("LearningGenerationIdempotencyConflict", record.idempotencyKey);
      return { ok: true, value: clone(existing.record) };
    }
    const revokedThrough = this.#revokedThrough.get(sourceKey(record.ownerId, record.sourceId));
    if (revokedThrough !== undefined && record.sourceRevision <= revokedThrough) {
      return this.#generationFailure("LearningFreshRightsRequired", record.sourceId, record.sourceRevision);
    }
    for (const task of record.tasks) {
      const taskKey = scopedKey(record.ownerId, task.id);
      if (this.#taskGenerations.has(taskKey)) return this.#generationFailure("LearningGenerationPersistenceFailed");
    }
    const stored = clone(record);
    this.#generations.set(record.id, { fingerprint, record: stored });
    this.#generationKeys.set(key, record.id);
    for (const task of record.tasks) this.#taskGenerations.set(scopedKey(record.ownerId, task.id), record.id);
    this.#logger({ event: "learning-generation-repository-success" });
    return { ok: true, value: clone(stored) };
  }

  /** @param {string} ownerId @param {string} sourceId @param {number} sourceRevision @returns {Promise<Result<true, LearningGenerationFailure>>} */
  async assertGenerationAllowed(ownerId, sourceId, sourceRevision) {
    if (!isNonEmptyText(ownerId) || !isNonEmptyText(sourceId) || !isPositiveInteger(sourceRevision)) return this.#generationFailure("LearningGenerationPersistenceFailed");
    const revokedThrough = this.#revokedThrough.get(sourceKey(ownerId, sourceId));
    return revokedThrough !== undefined && sourceRevision <= revokedThrough
      ? this.#generationFailure("LearningFreshRightsRequired", sourceId, sourceRevision)
      : { ok: true, value: true };
  }

  /** @param {string} ownerId @param {string} taskId @returns {Promise<Result<LearningTask | null, LearningReviewFailure>>} */
  async findTask(ownerId, taskId) {
    if (!isNonEmptyText(ownerId) || !isNonEmptyText(taskId)) return this.#reviewFailure("LearningReviewPersistenceFailed");
    const generationId = this.#taskGenerations.get(scopedKey(ownerId, taskId));
    if (generationId === undefined) return { ok: true, value: null };
    const stored = this.#generations.get(generationId);
    if (stored === undefined) throw new TypeError("Learning-generation task index invariant is broken.");
    const task = stored.record.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined || stored.record.status === "revoked" || task.status === "hidden") return { ok: true, value: null };
    return { ok: true, value: clone(task) };
  }

  /** @param {LearningReviewCommand} command @returns {Promise<Result<LearningTask, LearningReviewFailure>>} */
  async applyDecision(command) {
    if (!validReviewCommand(command)) return this.#reviewFailure("LearningReviewPersistenceFailed");
    const key = scopedKey(command.ownerId, command.idempotencyKey);
    const replay = this.#reviewKeys.get(key);
    const fingerprint = JSON.stringify([command.taskId, command.expectedRevision, command.decision, command.reviewedAt]);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) return this.#reviewFailure("LearningReviewIdempotencyConflict", command.idempotencyKey);
      return { ok: true, value: clone(replay.task) };
    }
    const generationId = this.#taskGenerations.get(scopedKey(command.ownerId, command.taskId));
    if (generationId === undefined) return this.#reviewFailure("LearningReviewTaskUnknown", command.taskId);
    const stored = this.#generations.get(generationId);
    if (stored === undefined) throw new TypeError("Learning-generation review index invariant is broken.");
    const taskIndex = stored.record.tasks.findIndex((candidate) => candidate.id === command.taskId);
    if (taskIndex < 0) throw new TypeError("Learning-generation task index invariant is broken.");
    const current = stored.record.tasks[taskIndex];
    if (stored.record.status === "revoked" || current.status === "hidden") return this.#reviewFailure("LearningReviewTaskUnknown", command.taskId);
    if (current.status !== "pending-review") return this.#reviewFailure("LearningReviewAlreadyDecided", command.taskId);
    if (current.revision !== command.expectedRevision) return this.#reviewFailure("LearningReviewRevisionStale", command.expectedRevision, current.revision);
    const decided = freeze({ ...current, status: command.decision === "approve" ? "published" : "rejected", reviewDecision: command.decision === "approve" ? "approved" : "rejected", reviewedAt: command.reviewedAt, revision: current.revision + 1 });
    const tasks = [...stored.record.tasks];
    tasks[taskIndex] = decided;
    this.#generations.set(generationId, { fingerprint: stored.fingerprint, record: clone({ ...stored.record, tasks: freeze(tasks) }) });
    const audit = freeze({ ownerId: command.ownerId, taskId: command.taskId, decision: command.decision, expectedRevision: command.expectedRevision, resultingRevision: decided.revision, idempotencyKey: command.idempotencyKey, occurredAt: command.reviewedAt });
    this.#reviewAudits.push(audit);
    this.#reviewKeys.set(key, { fingerprint, task: clone(decided) });
    this.#logger({ event: "learning-review-repository-success" });
    return { ok: true, value: clone(decided) };
  }

  /** @param {string} ownerId @returns {Promise<Result<readonly LearningTask[], LearningReviewFailure>>} */
  async listVisible(ownerId) {
    if (!isNonEmptyText(ownerId)) return this.#reviewFailure("LearningReviewPersistenceFailed");
    const tasks = [];
    for (const stored of this.#generations.values()) {
      if (stored.record.ownerId !== ownerId || stored.record.status === "revoked") continue;
      for (const task of stored.record.tasks) if (task.status === "published") tasks.push(clone(task));
    }
    return { ok: true, value: freeze(tasks) };
  }

  /** @param {LearningRevocationCommand} command @param {string} fingerprint @returns {Promise<Result<LearningRevocationResult, LearningRevocationFailure>>} */
  async revoke(command, fingerprint) {
    this.#logger({ event: "learning-revocation-repository-entry" });
    if (!validRevocationCommand(command) || !isNonEmptyText(fingerprint)) return this.#revocationFailure("LearningRevocationPersistenceFailed");
    const key = scopedKey(command.ownerId, command.idempotencyKey);
    const replay = this.#revocationKeys.get(key);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) return this.#revocationFailure("LearningRevocationConflict", command.idempotencyKey);
      return { ok: true, value: clone({ ...replay.result, reused: true }) };
    }
    const source = sourceKey(command.ownerId, command.sourceId);
    const prior = this.#revokedThrough.get(source) ?? 0;
    this.#revokedThrough.set(source, Math.max(prior, command.sourceRevision));
    /** @type {LearningRevocationTombstone[]} */
    const tombstones = [];
    let changedGenerations = 0;
    let changedUnits = 0;
    let changedTasks = 0;
    for (const [generationId, stored] of this.#generations) {
      if (stored.record.ownerId !== command.ownerId || stored.record.sourceId !== command.sourceId || stored.record.sourceRevision > command.sourceRevision || stored.record.status === "revoked") continue;
      const hiddenTasks = stored.record.tasks.map((task) => freeze({ ...task, status: "hidden", revision: task.revision + 1 }));
      const hidden = /** @type {LearningGenerationRecord} */ (clone({ ...stored.record, tasks: freeze(hiddenTasks), status: /** @type {const} */ ("revoked") }));
      this.#generations.set(generationId, { fingerprint: stored.fingerprint, record: hidden });
      changedGenerations += 1;
      for (const unit of stored.record.units) {
        changedUnits += 1;
        tombstones.push(tombstone(command, generationId, stored.record.itemId, stored.record.itemVersionId, "unit", unit.id));
      }
      for (const task of stored.record.tasks) {
        changedTasks += 1;
        tombstones.push(tombstone(command, generationId, stored.record.itemId, stored.record.itemVersionId, "task", task.id));
      }
      tombstones.push(tombstone(command, generationId, stored.record.itemId, stored.record.itemVersionId, "generation", stored.record.id));
    }
    this.#tombstones.push(...tombstones.map(clone));
    const result = freeze({ changedGenerations, changedUnits, changedTasks, tombstones: freeze(tombstones.map(clone)), reused: false });
    this.#revocationKeys.set(key, { fingerprint, result: clone(result) });
    this.#logger({ event: "learning-revocation-repository-success", durationMs: tombstones.length });
    return { ok: true, value: result };
  }

  /** @param {string} ownerId @returns {Promise<Result<readonly LearningRevocationTombstone[], LearningRevocationFailure>>} */
  async listTombstones(ownerId) {
    if (!isNonEmptyText(ownerId)) return this.#revocationFailure("LearningRevocationPersistenceFailed");
    return { ok: true, value: freeze(this.#tombstones.filter((tombstone) => tombstone.ownerId === ownerId).map(clone)) };
  }

  /** @param {LearningNonContentFact} fact @returns {Promise<Result<LearningNonContentFact, LearningRevocationFailure>>} */
  async recordFact(fact) {
    if (!validFact(fact)) return this.#revocationFailure("LearningRevocationPersistenceFailed");
    const stored = clone(fact);
    this.#facts.push(stored);
    return { ok: true, value: clone(stored) };
  }

  /** @param {string} ownerId @returns {Promise<Result<readonly LearningNonContentFact[], LearningRevocationFailure>>} */
  async listFacts(ownerId) {
    if (!isNonEmptyText(ownerId)) return this.#revocationFailure("LearningRevocationPersistenceFailed");
    return { ok: true, value: freeze(this.#facts.filter((fact) => fact.ownerId === ownerId).map(clone)) };
  }

  /** @param {string} ownerId @returns {Promise<Result<readonly LearningReviewAudit[], LearningRevocationFailure>>} */
  async listReviewAudits(ownerId) {
    if (!isNonEmptyText(ownerId)) return this.#revocationFailure("LearningRevocationPersistenceFailed");
    return { ok: true, value: freeze(this.#reviewAudits.filter((audit) => audit.ownerId === ownerId).map(clone)) };
  }

  /** @param {string} kind @param {string} [first] @param {number} [second] @returns {Result<never, LearningGenerationFailure>} */
  #generationFailure(kind, first, second) {
    const error = kind === "LearningGenerationIdempotencyConflict"
      ? { kind, idempotencyKey: /** @type {string} */ (first) }
      : kind === "LearningFreshRightsRequired"
      ? { kind, sourceId: /** @type {string} */ (first), sourceRevision: /** @type {number} */ (second) }
      : { kind: /** @type {"LearningGenerationPersistenceFailed"} */ (kind) };
    this.#logger({ event: "learning-generation-repository-failure", failureKind: error.kind });
    return { ok: false, error: /** @type {LearningGenerationFailure} */ (error) };
  }

  /** @param {string} kind @param {string|number} [first] @param {number} [second] @returns {Result<never, LearningReviewFailure>} */
  #reviewFailure(kind, first, second) {
    const error = kind === "LearningReviewTaskUnknown"
      ? { kind, taskId: /** @type {string} */ (first) }
      : kind === "LearningReviewAlreadyDecided"
      ? { kind, taskId: /** @type {string} */ (first) }
      : kind === "LearningReviewRevisionStale"
      ? { kind, expected: /** @type {number} */ (first), actual: /** @type {number} */ (second) }
      : kind === "LearningReviewIdempotencyConflict"
      ? { kind, idempotencyKey: /** @type {string} */ (first) }
      : { kind: /** @type {"LearningReviewPersistenceFailed"} */ (kind) };
    this.#logger({ event: "learning-review-repository-failure", failureKind: error.kind });
    return { ok: false, error: /** @type {LearningReviewFailure} */ (error) };
  }

  /** @param {string} kind @param {string} [key] @returns {Result<never, LearningRevocationFailure>} */
  #revocationFailure(kind, key) {
    const error = kind === "LearningRevocationConflict" ? { kind, idempotencyKey: /** @type {string} */ (key) } : { kind: /** @type {"LearningRevocationPersistenceFailed"} */ (kind) };
    this.#logger({ event: "learning-revocation-repository-failure", failureKind: error.kind });
    return { ok: false, error: /** @type {LearningRevocationFailure} */ (error) };
  }
}

/** @param {string} ownerId @param {string} value */
function scopedKey(ownerId, value) { return `${ownerId}\u0000${value}`; }
/** @param {string} ownerId @param {string} sourceId */
function sourceKey(ownerId, sourceId) { return `${ownerId}\u0000${sourceId}`; }
/** @template T @param {T} value @returns {T} */
function clone(value) { return structuredClone(value); }

/** @param {unknown} value @returns {value is LearningGenerationRecord} */
function validRecord(value) {
  return isRecord(value) && isNonEmptyText(value.id) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.sourceId) && isPositiveInteger(value.sourceRevision) && isNonEmptyText(value.itemId) && isNonEmptyText(value.itemVersionId) && isNonEmptyText(value.contentDigest) && isNonEmptyText(value.rightsEvidenceId) && isNonEmptyText(value.policyVersion) && Array.isArray(value.units) && Array.isArray(value.tasks) && isNonEmptyText(value.idempotencyKey) && isNonEmptyText(value.createdAt) && (value.status === "completed" || value.status === "failed" || value.status === "revoked") && typeof value.localOnly === "boolean" && (value.attribution === null || isRecord(value.attribution));
}
/** @param {unknown} value @returns {value is LearningReviewCommand} */
function validReviewCommand(value) { return isRecord(value) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.taskId) && isPositiveInteger(value.expectedRevision) && (value.decision === "approve" || value.decision === "reject") && isNonEmptyText(value.reviewedAt) && isNonEmptyText(value.idempotencyKey); }
/** @param {unknown} value @returns {value is LearningRevocationCommand} */
function validRevocationCommand(value) { return isRecord(value) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.sourceId) && isPositiveInteger(value.sourceRevision) && isNonEmptyText(value.idempotencyKey) && isNonEmptyText(value.reason) && isNonEmptyText(value.revokedAt); }
/** @param {unknown} value @returns {value is LearningNonContentFact} */
function validFact(value) { return isRecord(value) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.taskId) && (value.kind === "review-decision" || value.kind === "study-response" || value.kind === "schedule") && isNonEmptyText(value.occurredAt) && (value.correct === null || typeof value.correct === "boolean") && (value.scheduleStep === null || (typeof value.scheduleStep === "number" && Number.isInteger(value.scheduleStep) && value.scheduleStep >= 0 && value.scheduleStep <= 4)); }
/** @param {LearningRevocationCommand} command @param {string} generationId @param {string} itemId @param {string} itemVersionId @param {"generation"|"unit"|"task"} descendantKind @param {string} descendantId @returns {LearningRevocationTombstone} */
function tombstone(command, generationId, itemId, itemVersionId, descendantKind, descendantId) { return freeze({ id: `${generationId}:tombstone:${descendantKind}:${descendantId}`, ownerId: command.ownerId, sourceId: command.sourceId, sourceRevision: command.sourceRevision, itemId, itemVersionId, descendantKind, descendantId, reason: command.reason, revokedAt: command.revokedAt }); }

export {};
