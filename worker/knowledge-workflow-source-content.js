// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly bind: (...values: readonly (string | number)[]) => D1Statement, readonly all: () => Promise<{ readonly success: boolean, readonly results: readonly unknown[] }>, readonly run: () => Promise<D1Result>, readonly first: () => Promise<unknown | null> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement, readonly batch: (statements: readonly D1Statement[]) => Promise<readonly D1Result[]> }} D1DatabasePort */
/** @typedef {{ readonly remove: (objectKey: string) => Promise<Result<null, unknown>> }} SourceContentStore */
/** @typedef {{ readonly kind: "KnowledgeWorkflowSourceContentCleanupFailed" }} SourceContentFailure */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

/**
 * Removes source-library bodies while retaining source identity and audit
 * metadata. Existing study/review rows can therefore remain addressable while
 * revoked source objects cannot be fetched again.
 * @param {{ readonly database: D1DatabasePort, readonly contentStore: SourceContentStore, readonly logger: (entry: { readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }) => void }} dependencies
 */
export function createKnowledgeWorkflowSourceContentCleanup(dependencies) {
  if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.database.batch !== "function" || typeof dependencies.contentStore?.remove !== "function" || typeof dependencies.logger !== "function") throw new TypeError("Knowledge workflow source-content cleanup dependencies are invalid.");
  return Object.freeze({
    /** @param {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision?: number }} scope @returns {Promise<Result<null, SourceContentFailure>>} */
    async purge(scope) {
      if (!text(scope?.ownerId) || !text(scope.sourceId) || (scope.sourceRevision !== undefined && !positiveInteger(scope.sourceRevision))) return { ok: false, error: { kind: "KnowledgeWorkflowSourceContentCleanupFailed" } };
      dependencies.logger({ event: "knowledge-workflow-source-content-entry", ownerId: scope.ownerId, sourceId: scope.sourceId });
      let rows;
      try {
        const statement = scope.sourceRevision === undefined
          ? dependencies.database.prepare("SELECT object_key FROM source_content_references WHERE owner_id = ? AND source_id = ? AND state = 'processing-ready' ORDER BY content_reference_id").bind(scope.ownerId, scope.sourceId)
          : dependencies.database.prepare("SELECT object_key FROM source_content_references WHERE owner_id = ? AND source_id = ? AND source_revision = ? AND state = 'processing-ready' ORDER BY content_reference_id").bind(scope.ownerId, scope.sourceId, scope.sourceRevision);
        const selected = await statement.all();
        if (!selected.success || !Array.isArray(selected.results)) return fail(dependencies, scope, "KnowledgeWorkflowSourceContentCleanupFailed");
        rows = selected.results;
      } catch (error) {
        return fail(dependencies, scope, "KnowledgeWorkflowSourceContentCleanupFailed");
      }
      /** @type {string[]} */
      const keys = [];
      for (const row of rows) {
        if (!record(row) || !text(row.object_key) || !row.object_key.startsWith("source-content/") || row.object_key.includes("..")) return fail(dependencies, scope, "KnowledgeWorkflowSourceContentCleanupFailed");
        keys.push(row.object_key);
      }
      try {
        for (const key of keys) {
          const removed = await dependencies.contentStore.remove(key);
          if (!removed.ok) return fail(dependencies, scope, "KnowledgeWorkflowSourceContentCleanupFailed");
        }
        if (keys.length > 0) {
          const results = await dependencies.database.batch([
            scope.sourceRevision === undefined
              ? dependencies.database.prepare("UPDATE source_content_references SET state = 'revoked' WHERE owner_id = ? AND source_id = ? AND state = 'processing-ready'").bind(scope.ownerId, scope.sourceId)
              : dependencies.database.prepare("UPDATE source_content_references SET state = 'revoked' WHERE owner_id = ? AND source_id = ? AND source_revision = ? AND state = 'processing-ready'").bind(scope.ownerId, scope.sourceId, scope.sourceRevision),
          ]);
          if (results.length !== 1 || results[0]?.success !== true) return fail(dependencies, scope, "KnowledgeWorkflowSourceContentCleanupFailed");
        }
      } catch (error) {
        return fail(dependencies, scope, "KnowledgeWorkflowSourceContentCleanupFailed");
      }
      dependencies.logger({ event: "knowledge-workflow-source-content-success", ownerId: scope.ownerId, sourceId: scope.sourceId });
      return { ok: true, value: null };
    },
  });
}

/** @param {{ readonly logger: (entry: { readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }) => void }} dependencies @param {{ readonly ownerId: string, readonly sourceId: string }} scope @param {string} failureKind @returns {Result<null, SourceContentFailure>} */
function fail(dependencies, scope, failureKind) {
  dependencies.logger({ event: "knowledge-workflow-source-content-failure", ownerId: scope.ownerId, sourceId: scope.sourceId, failureKind });
  return { ok: false, error: { kind: "KnowledgeWorkflowSourceContentCleanupFailed" } };
}
