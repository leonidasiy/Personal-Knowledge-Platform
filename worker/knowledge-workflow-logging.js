// @ts-check

/** @typedef {{ readonly event: string, readonly ownerId?: string, readonly runId?: string, readonly stage?: string, readonly action?: string, readonly failureKind?: string, readonly diagnosticToken?: string, readonly httpStatus?: number, readonly durationMs?: number, readonly count?: number, readonly itemCount?: number }} KnowledgeWorkflowLogEntry */
/** @typedef {{ readonly component: "knowledge-workflow", readonly event: string, readonly correlationId: string, readonly occurredAt: string, readonly ownerId?: string, readonly runId?: string, readonly stage?: string, readonly action?: string, readonly failureKind?: string, readonly diagnosticToken?: string, readonly httpStatus?: number, readonly durationMs?: number, readonly count?: number, readonly itemCount?: number }} KnowledgeWorkflowLogRecord */
/** @typedef {{ readonly kind: "KnowledgeWorkflowLogEntryInvalid" | "KnowledgeWorkflowLogTimestampInvalid" }} KnowledgeWorkflowLogFailure */
/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function nonNegativeInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
/** @param {unknown} value @returns {value is string} */
function boundedCategory(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value); }

/**
 * A dedicated, allow-listed structured sink for the M5 backend. The logger
 * never serializes unknown entry fields, so source text, prompts, answers,
 * provider payloads, credentials, and private memory cannot enter the log.
 * @param {{ readonly sink: (record: KnowledgeWorkflowLogRecord) => void, readonly now: () => string }} dependencies
 * @returns {(entry: KnowledgeWorkflowLogEntry) => Result<null, KnowledgeWorkflowLogFailure>}
 */
export function createKnowledgeWorkflowLogger(dependencies) {
  if (typeof dependencies?.sink !== "function" || typeof dependencies.now !== "function") throw new TypeError("Knowledge workflow logger dependencies are invalid.");
  /** @type {Map<string, number>} */
  const started = new Map();
  /** @returns {Result<null, KnowledgeWorkflowLogFailure>} */
  const invalidEntry = () => ({ ok: false, error: { kind: "KnowledgeWorkflowLogEntryInvalid" } });
  /** @param {KnowledgeWorkflowLogEntry} entry @returns {Result<null, KnowledgeWorkflowLogFailure>} */
  function log(entry) {
    if (!record(entry) || !boundedCategory(entry.event) ||
      (entry.ownerId !== undefined && !boundedCategory(entry.ownerId)) ||
      (entry.runId !== undefined && !boundedCategory(entry.runId)) ||
      (entry.stage !== undefined && !boundedCategory(entry.stage)) ||
      (entry.action !== undefined && !boundedCategory(entry.action)) ||
      (entry.failureKind !== undefined && !boundedCategory(entry.failureKind)) ||
      (entry.diagnosticToken !== undefined && !boundedCategory(entry.diagnosticToken)) ||
      (entry.httpStatus !== undefined && (!Number.isSafeInteger(entry.httpStatus) || entry.httpStatus < 100 || entry.httpStatus > 599)) ||
      (entry.durationMs !== undefined && !nonNegativeInteger(entry.durationMs)) ||
      (entry.count !== undefined && !nonNegativeInteger(entry.count)) ||
      (entry.itemCount !== undefined && !nonNegativeInteger(entry.itemCount))) return invalidEntry();
    const occurredAt = dependencies.now();
    if (!text(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) return { ok: false, error: { kind: "KnowledgeWorkflowLogTimestampInvalid" } };
    const ownerId = entry.ownerId;
    const runId = entry.runId;
    const correlationId = runId ?? (ownerId === undefined ? "knowledge-workflow" : `owner:${ownerId}`);
    const explicitDuration = entry.durationMs === undefined ? undefined : entry.durationMs;
    const isEntry = entry.event.endsWith("-entry");
    const isTerminal = entry.event.endsWith("-success") || entry.event.endsWith("-failure");
    if (isEntry) started.set(correlationId, Date.parse(occurredAt));
    const inferredDuration = explicitDuration ?? (isTerminal && started.has(correlationId) ? Math.max(0, Date.parse(occurredAt) - /** @type {number} */ (started.get(correlationId))) : undefined);
    if (isTerminal) started.delete(correlationId);
    /** @type {KnowledgeWorkflowLogRecord} */
    const safe = {
      component: "knowledge-workflow",
      event: entry.event,
      correlationId,
      occurredAt,
      ...(ownerId === undefined ? {} : { ownerId }),
      ...(runId === undefined ? {} : { runId }),
      ...(text(entry.stage) ? { stage: entry.stage } : {}),
      ...(text(entry.action) ? { action: entry.action } : {}),
      ...(text(entry.failureKind) ? { failureKind: entry.failureKind } : {}),
      ...(entry.diagnosticToken === undefined ? {} : { diagnosticToken: entry.diagnosticToken }),
      ...(entry.httpStatus === undefined ? {} : { httpStatus: entry.httpStatus }),
      ...(inferredDuration === undefined ? {} : { durationMs: inferredDuration }),
      ...(nonNegativeInteger(entry.count) ? { count: entry.count } : {}),
      ...(nonNegativeInteger(entry.itemCount) ? { itemCount: entry.itemCount } : {}),
    };
    dependencies.sink(Object.freeze(safe));
    return { ok: true, value: null };
  }
  return Object.freeze(log);
}
