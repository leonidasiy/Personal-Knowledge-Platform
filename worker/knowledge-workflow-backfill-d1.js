// @ts-check

/** @import { BackfillMarker } from "../src/features/knowledge-workflows/backfill.js" */

/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly first: () => Promise<unknown | null>, readonly run: () => Promise<D1Result> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement }} D1DatabasePort */
/** @typedef {{ readonly event: string, readonly ownerId?: string, readonly failureKind?: string }} BackfillD1Log */

/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function nonNegativeInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** @param {unknown} value @returns {BackfillMarker | null} */
function parseMarker(value) {
  if (!record(value) || !text(value.owner_id) || !text(value.backfill_key) || !nonNegativeInteger(value.source_count) || !text(value.run_ids_json) || !text(value.created_at)) return null;
  let runIds;
  try { runIds = JSON.parse(value.run_ids_json); } catch (error) { return null; }
  if (!Array.isArray(runIds) || !runIds.every(text)) return null;
  return Object.freeze({ ownerId: value.owner_id, backfillKey: value.backfill_key, sourceCount: value.source_count, runIds: Object.freeze([...runIds]), createdAt: value.created_at });
}

export class D1KnowledgeWorkflowBackfillRepository {
  /** @type {D1DatabasePort} */ #database;
  /** @type {(entry: BackfillD1Log) => void} */ #logger;

  /** @param {{ readonly database: D1DatabasePort, readonly logger: (entry: BackfillD1Log) => void }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.logger !== "function") throw new TypeError("D1 workflow-backfill dependencies are invalid.");
    this.#database = dependencies.database;
    this.#logger = dependencies.logger;
  }

  /** @param {string} ownerId @param {string} backfillKey @returns {Promise<{ readonly ok: true, readonly value: BackfillMarker | null } | { readonly ok: false, readonly error: { readonly kind: "BackfillMarkerReadFailed" } }>} */
  async read(ownerId, backfillKey) {
    try {
      const row = await this.#database.prepare("SELECT owner_id, backfill_key, source_count, run_ids_json, created_at FROM knowledge_workflow_backfill_markers WHERE owner_id = ? AND backfill_key = ? LIMIT 1").bind(ownerId, backfillKey).first();
      if (row === null) return { ok: true, value: null };
      const marker = parseMarker(row);
      return marker === null ? { ok: false, error: { kind: "BackfillMarkerReadFailed" } } : { ok: true, value: marker };
    } catch (error) {
      this.#logger({ event: "knowledge-workflow-backfill-marker-read-failure", ownerId, failureKind: "BackfillMarkerReadFailed" });
      return { ok: false, error: { kind: "BackfillMarkerReadFailed" } };
    }
  }

  /** @param {BackfillMarker} marker @returns {Promise<{ readonly ok: true, readonly value: null } | { readonly ok: false, readonly error: { readonly kind: "BackfillMarkerWriteFailed" } }>} */
  async write(marker) {
    try {
      const result = await this.#database.prepare("INSERT INTO knowledge_workflow_backfill_markers (owner_id, backfill_key, source_count, run_ids_json, created_at) VALUES (?, ?, ?, ?, ?)").bind(marker.ownerId, marker.backfillKey, marker.sourceCount, JSON.stringify(marker.runIds), marker.createdAt).run();
      if (result.success !== true || result.meta?.changes !== 1) return { ok: false, error: { kind: "BackfillMarkerWriteFailed" } };
      this.#logger({ event: "knowledge-workflow-backfill-marker-write-success", ownerId: marker.ownerId });
      return { ok: true, value: null };
    } catch (error) {
      this.#logger({ event: "knowledge-workflow-backfill-marker-write-failure", ownerId: marker.ownerId, failureKind: "BackfillMarkerWriteFailed" });
      return { ok: false, error: { kind: "BackfillMarkerWriteFailed" } };
    }
  }
}

export {};
