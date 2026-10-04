// @ts-check

/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly first: () => Promise<unknown | null>, readonly all: () => Promise<{ readonly success: boolean, readonly results?: readonly unknown[] }> , readonly run: () => Promise<D1Result> }} D1Statement */
/** @typedef {{ readonly prepare: (sql: string) => D1Statement }} D1DatabasePort */
/** @typedef {{ readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }} BackfillLog */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Provides owner-scoped keyset pages, current-revision points, and durable per-revision checkpoints. */
export class D1SourceClassificationBackfillRepository {
  /** @type {D1DatabasePort} */ #db;
  /** @type {() => string} */ #now;
  /** @type {(entry: BackfillLog) => void} */ #logger;
  /** @param {{ readonly database: D1DatabasePort, readonly now: () => string, readonly logger: (entry: BackfillLog) => void }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") throw new TypeError("SourceClassificationBackfillRepositoryDependenciesInvalid");
    this.#db = dependencies.database; this.#now = dependencies.now; this.#logger = dependencies.logger;
  }
  /** @param {{ readonly ownerId: string, readonly afterSourceId: string | null, readonly limit: number }} command */
  async pageSources(command) {
    try {
      const rows = await this.#db.prepare("SELECT owner_id, source_id, revision, title FROM library_sources WHERE owner_id = ? AND state = 'active' AND (? IS NULL OR source_id > ?) ORDER BY source_id LIMIT ?").bind(command.ownerId, command.afterSourceId, command.afterSourceId, command.limit + 1).all();
      if (!rows.success || !Array.isArray(rows.results)) return { ok: false, error: { kind: "BackfillSourceListFailed" } };
      const selected = rows.results.slice(0, command.limit);
      if (!selected.every((row) => record(row) && row.owner_id === command.ownerId && typeof row.source_id === "string" && Number.isSafeInteger(row.revision) && typeof row.title === "string")) return { ok: false, error: { kind: "BackfillSourceListFailed" } };
      const sources = selected.map((row) => ({ ownerId: command.ownerId, id: /** @type {string} */ (row.source_id), revision: /** @type {number} */ (row.revision), title: /** @type {string} */ (row.title) }));
      return { ok: true, value: { sources, nextCursor: rows.results.length > command.limit ? sources.at(-1)?.id ?? null : null } };
    } catch (error) { this.#logger({ event: "source-classification-backfill-source-list-failure", ownerId: command.ownerId, failureKind: "BackfillSourceListFailed" }); return { ok: false, error: { kind: "BackfillSourceListFailed" } }; }
  }
  /** @param {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly afterKnowledgeId: string | null, readonly limit: number }} command */
  async pagePoints(command) {
    try {
      const rows = await this.#db.prepare("SELECT knowledge_id, point_json FROM extraction_knowledge_points WHERE owner_id = ? AND source_id = ? AND source_revision = ? AND (? IS NULL OR knowledge_id > ?) ORDER BY knowledge_id LIMIT ?").bind(command.ownerId, command.sourceId, command.sourceRevision, command.afterKnowledgeId, command.afterKnowledgeId, command.limit + 1).all();
      if (!rows.success || !Array.isArray(rows.results)) return { ok: false, error: { kind: "BackfillPointListFailed" } };
      const selected = rows.results.slice(0, command.limit);
      const points = [];
      for (const row of selected) {
        if (!record(row) || typeof row.knowledge_id !== "string" || typeof row.point_json !== "string") return { ok: false, error: { kind: "BackfillPointListFailed" } };
        const parsed = JSON.parse(row.point_json);
        if (!record(parsed)) return { ok: false, error: { kind: "BackfillPointListFailed" } };
        points.push({ ...parsed, id: row.knowledge_id });
      }
      return { ok: true, value: { points, nextCursor: rows.results.length > command.limit ? points.at(-1)?.id ?? null : null } };
    } catch (error) { this.#logger({ event: "source-classification-backfill-point-list-failure", ownerId: command.ownerId, sourceId: command.sourceId, failureKind: "BackfillPointListFailed" }); return { ok: false, error: { kind: "BackfillPointListFailed" } }; }
  }
  /** @param {{ readonly ownerId: string, readonly sourceId: string }} command */
  async getClassification(command) {
    try {
      const row = await this.#db.prepare("SELECT source_revision, origin, status FROM source_classifications WHERE owner_id = ? AND source_id = ? LIMIT 1").bind(command.ownerId, command.sourceId).first();
      if (row === null) return { ok: true, value: null };
      if (!record(row) || !Number.isSafeInteger(row.source_revision) || !["agent", "manual", "backfill"].includes(/** @type {string} */ (row.origin))) return { ok: false, error: { kind: "BackfillClassificationReadFailed" } };
      return { ok: true, value: { sourceRevision: /** @type {number} */ (row.source_revision), origin: /** @type {"agent"|"manual"|"backfill"} */ (row.origin), status: row.status } };
    } catch (error) { this.#logger({ event: "source-classification-backfill-classification-read-failure", ownerId: command.ownerId, sourceId: command.sourceId, failureKind: "BackfillClassificationReadFailed" }); return { ok: false, error: { kind: "BackfillClassificationReadFailed" } }; }
  }
  /** status='read' reads; other statuses write idempotently. */
  /** @param {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly status: "read" | "completed" | "needs-review" | "manual-preserved" }} command */
  async checkpoint(command) {
    try {
      if (command.status === "read") {
        const row = await this.#db.prepare("SELECT status FROM source_classification_backfill_checkpoints WHERE owner_id = ? AND source_id = ? AND source_revision = ? LIMIT 1").bind(command.ownerId, command.sourceId, command.sourceRevision).first();
        if (row === null) return { ok: true, value: null };
        if (!record(row) || !["completed", "needs-review", "manual-preserved"].includes(/** @type {string} */ (row.status))) return { ok: false, error: { kind: "BackfillCheckpointReadFailed" } };
        return { ok: true, value: row.status };
      }
      const now = this.#now();
      if (!Number.isFinite(Date.parse(now))) return { ok: false, error: { kind: "BackfillCheckpointWriteFailed" } };
      const result = await this.#db.prepare("INSERT INTO source_classification_backfill_checkpoints (owner_id, source_id, source_revision, status, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM library_sources WHERE owner_id = ? AND source_id = ? AND revision = ? AND state = 'active') ON CONFLICT(owner_id, source_id, source_revision) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at").bind(command.ownerId, command.sourceId, command.sourceRevision, command.status, now, command.ownerId, command.sourceId, command.sourceRevision).run();
      if (!result.success || (result.meta?.changes ?? 0) !== 1) return { ok: false, error: { kind: "BackfillCheckpointWriteFailed" } };
      return { ok: true, value: null };
    } catch (error) { this.#logger({ event: `source-classification-backfill-checkpoint-${command.status}-failure`, ownerId: command.ownerId, sourceId: command.sourceId, failureKind: "BackfillCheckpointWriteFailed" }); return { ok: false, error: { kind: command.status === "read" ? "BackfillCheckpointReadFailed" : "BackfillCheckpointWriteFailed" } }; }
  }
}

export {};
