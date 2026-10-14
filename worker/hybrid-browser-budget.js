// @ts-check

/** @template T @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: { readonly kind: string } }} Result */
/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly first: () => Promise<unknown | null>, readonly run: () => Promise<D1Result> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement }} D1DatabasePort */
/** @typedef {{ readonly event: string, readonly ownerId: string, readonly runId: string, readonly failureKind: string }} BudgetLog */

// Browser sessions are only launched from executable workflow stages.
const ACTIVE_STATES_SQL = "('source-added', 'rights-assessment', 'robots-check', 'extraction-loop', 'extraction-finalized', 'per-point-quiz-loop')";

/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** @param {string} kind @returns {Result<null>} */
function failure(kind) { return { ok: false, error: { kind } }; }

/**
 * Reserve the full possible code-only Firecrawl session cost before launch.
 * Reservations survive retries and failed/unknown launches; there is no refund.
 * @param {{ readonly database: D1DatabasePort, readonly ownerId: string, readonly runId: string, readonly maximumCredits: number, readonly now: () => string, readonly createId: () => string, readonly logger: (entry: BudgetLog) => void }} dependencies
 */
export function createHybridBrowserBudget(dependencies) {
  if (typeof dependencies?.database?.prepare !== "function" || !text(dependencies.ownerId) || !text(dependencies.runId) || !Number.isSafeInteger(dependencies.maximumCredits) || dependencies.maximumCredits < 0 || typeof dependencies.now !== "function" || typeof dependencies.createId !== "function" || typeof dependencies.logger !== "function") throw new TypeError("Hybrid browser budget dependencies are invalid.");
  const { database, ownerId, runId, maximumCredits } = dependencies;

  return Object.freeze({
    /** @param {{ readonly credits: number, readonly ttlSeconds: number }} command @returns {Promise<Result<null>>} */
    async reserveSession(command) {
      if (!positiveInteger(command?.credits) || !positiveInteger(command.ttlSeconds) || command.credits !== 2 * Math.ceil(command.ttlSeconds / 60)) return failure("BrowserCreditBudgetCommandInvalid");
      try {
        const createdAt = dependencies.now();
        const reservationId = dependencies.createId();
        if (!text(createdAt) || !Number.isFinite(Date.parse(createdAt)) || !text(reservationId)) return failure("BrowserCreditBudgetCommandInvalid");

        // One atomic statement makes concurrent dispatches share the same limit.
        const result = await database.prepare(`INSERT INTO knowledge_workflow_browser_credit_reservations
          (owner_id, run_id, reservation_id, credits, ttl_seconds, created_at)
          SELECT ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM knowledge_workflow_runs WHERE owner_id = ? AND run_id = ? AND state IN ${ACTIVE_STATES_SQL})
          AND NOT EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones WHERE owner_id = ? AND run_id = ?)
          AND COALESCE((SELECT SUM(credits) FROM knowledge_workflow_browser_credit_reservations WHERE owner_id = ? AND run_id = ?), 0) <= ? - ?`)
          .bind(ownerId, runId, reservationId, command.credits, command.ttlSeconds, createdAt, ownerId, runId, ownerId, runId, ownerId, runId, maximumCredits, command.credits).run();
        if (result.success !== true || !Number.isSafeInteger(result.meta?.changes) || (result.meta?.changes ?? -1) < 0 || (result.meta?.changes ?? 2) > 1) throw new Error("Browser reservation write was not confirmed.");
        if (result.meta?.changes === 1) return { ok: true, value: null };

        const status = await database.prepare(`SELECT 1 AS active FROM knowledge_workflow_runs
          WHERE owner_id = ? AND run_id = ? AND state IN ${ACTIVE_STATES_SQL}
          AND NOT EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones WHERE owner_id = ? AND run_id = ?)`)
          .bind(ownerId, runId, ownerId, runId).first();
        if (status === null) return failure("BrowserWorkflowInactive");
        if (typeof status !== "object" || !("active" in status) || status.active !== 1) throw new Error("Browser workflow status was not confirmed.");
        return failure("BrowserCreditLimitExceeded");
      } catch (_error) {
        dependencies.logger({ event: "hybrid-browser-budget-reservation-failed", ownerId, runId, failureKind: "BrowserCreditBudgetPersistenceFailed" });
        return failure("BrowserCreditBudgetPersistenceFailed");
      }
    },
  });
}
