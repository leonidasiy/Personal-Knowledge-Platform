// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {{ readonly success: boolean, readonly results: readonly unknown[] }} D1Rows */
/** @typedef {{ readonly bind: (...values: readonly (string | number)[]) => D1Statement, readonly all: () => Promise<D1Rows> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement }} D1DatabasePort */
/** @typedef {{ readonly purge: (command: { readonly ownerId: string, readonly runId: string, readonly knowledgeId: string, readonly before: string }) => Promise<Result<null, { readonly kind: string }>> }} QuizPurgePort */
/** @typedef {{ readonly kind: "WorkflowRestrictionReaperInvalid" | "WorkflowRestrictionReaperQueryFailed" | "WorkflowRestrictionReaperRowInvalid" | "WorkflowRestrictionReaperPurgeFailed" }} ReaperFailure */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** @param {string} value @returns {boolean} */
function timestamp(value) { return text(value) && Number.isFinite(Date.parse(value)); }

/** @param {{ readonly database: D1DatabasePort, readonly quizRepository: QuizPurgePort, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly count?: number, readonly failureKind?: string }) => void, readonly batchSize?: number }} dependencies @returns {{ readonly run: () => Promise<Result<number, ReaperFailure>> }} */
export function createKnowledgeWorkflowRestrictionReaper(dependencies) {
  const batchSize = dependencies?.batchSize ?? 25;
  if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.quizRepository?.purge !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function" || !positiveInteger(batchSize)) throw new TypeError("Knowledge workflow restriction-reaper dependencies are invalid.");
  return Object.freeze({
    async run() {
      const now = dependencies.now();
      if (!timestamp(now)) throw new TypeError("Knowledge workflow restriction-reaper clock returned an invalid timestamp.");
      dependencies.logger({ event: "knowledge-workflow-reaper-entry" });
      let result;
      try {
        result = await dependencies.database.prepare("SELECT owner_id, run_id, knowledge_id, restricted_until FROM knowledge_workflow_restrictions WHERE restricted_until <= ? ORDER BY restricted_until ASC, owner_id ASC, run_id ASC, knowledge_id ASC LIMIT ?").bind(now, batchSize).all();
      } catch (error) {
        dependencies.logger({ event: "knowledge-workflow-reaper-failure", failureKind: "WorkflowRestrictionReaperQueryFailed" });
        return { ok: false, error: { kind: "WorkflowRestrictionReaperQueryFailed" } };
      }
      if (result.success !== true || !Array.isArray(result.results)) {
        dependencies.logger({ event: "knowledge-workflow-reaper-failure", failureKind: "WorkflowRestrictionReaperQueryFailed" });
        return { ok: false, error: { kind: "WorkflowRestrictionReaperQueryFailed" } };
      }
      let purged = 0;
      for (const row of result.results) {
        if (!record(row) || !text(row.owner_id) || !text(row.run_id) || !text(row.knowledge_id) || !text(row.restricted_until) || !timestamp(row.restricted_until)) {
          dependencies.logger({ event: "knowledge-workflow-reaper-failure", failureKind: "WorkflowRestrictionReaperRowInvalid" });
          return { ok: false, error: { kind: "WorkflowRestrictionReaperRowInvalid" } };
        }
        const ownerId = /** @type {string} */ (row.owner_id);
        const runId = /** @type {string} */ (row.run_id);
        const knowledgeId = /** @type {string} */ (row.knowledge_id);
        const restrictedUntil = /** @type {string} */ (row.restricted_until);
        const removed = await dependencies.quizRepository.purge({ ownerId, runId, knowledgeId, before: restrictedUntil });
        if (!removed.ok) {
          dependencies.logger({ event: "knowledge-workflow-reaper-failure", failureKind: "WorkflowRestrictionReaperPurgeFailed" });
          return { ok: false, error: { kind: "WorkflowRestrictionReaperPurgeFailed" } };
        }
        purged += 1;
      }
      dependencies.logger({ event: "knowledge-workflow-reaper-success", count: purged });
      return { ok: true, value: purged };
    },
  });
}
