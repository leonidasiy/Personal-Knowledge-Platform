// @ts-check

/**
 * @typedef {
 *   | "request-entry"
 *   | "request-authenticated"
 *   | "request-success"
 *   | "request-failure"
 *   | "request-auth-failure"
 *   | "dependency-entry"
 *   | "dependency-success"
 *   | "dependency-failure"
 * } DiscoveryRequestLogEvent
 */

/** @typedef {{ readonly event: DiscoveryRequestLogEvent, readonly correlationId: string, readonly route: string, readonly method: string, readonly ownerId?: string, readonly sourceId?: string, readonly runId?: string, readonly operation?: string, readonly status?: number, readonly failureKind?: string, readonly durationMs?: number, readonly itemCount?: number }} DiscoveryRequestLogEntry */
/** @typedef {{ readonly component: "discovery-worker", readonly event: DiscoveryRequestLogEvent, readonly correlationId: string, readonly occurredAt: string, readonly route: string, readonly method: string, readonly ownerId?: string, readonly sourceId?: string, readonly runId?: string, readonly operation?: string, readonly status?: number, readonly failureKind?: string, readonly durationMs?: number, readonly itemCount?: number }} DiscoveryRequestLogRecord */
/** @typedef {{ readonly kind: "DiscoveryRequestLogEntryInvalid" | "DiscoveryRequestLogTimestampInvalid" }} DiscoveryRequestLogFailure */
/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

const EVENTS = new Set([
  "request-entry",
  "request-authenticated",
  "request-success",
  "request-failure",
  "request-auth-failure",
  "dependency-entry",
  "dependency-success",
  "dependency-failure",
]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function safeCategory(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

/** @param {unknown} value @returns {value is number} */
function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * This logger is deliberately allow-listed. Callers can pass richer objects,
 * but only bounded operational categories and opaque IDs are emitted. Source
 * content, titles, URLs, cookies, tokens, prompts, and provider payloads are
 * not fields in the output contract.
 *
 * @param {{ readonly sink: (record: DiscoveryRequestLogRecord) => void, readonly now: () => string }} dependencies
 * @returns {(entry: DiscoveryRequestLogEntry) => Result<null, DiscoveryRequestLogFailure>}
 */
export function createDiscoveryRequestLogger(dependencies) {
  if (typeof dependencies?.sink !== "function" || typeof dependencies.now !== "function") {
    throw new TypeError("Discovery request logger dependencies are invalid.");
  }
  /** @type {Map<string, number>} */
  const started = new Map();

  /** @param {DiscoveryRequestLogEntry} entry @returns {Result<null, DiscoveryRequestLogFailure>} */
  function log(entry) {
    if (
      !record(entry) ||
      !EVENTS.has(entry.event) ||
      !safeCategory(entry.correlationId) ||
      !safeCategory(entry.route) ||
      !safeCategory(entry.method)
    ) {
      return { ok: false, error: { kind: "DiscoveryRequestLogEntryInvalid" } };
    }
    if ((entry.event.startsWith("dependency-") && !safeCategory(entry.operation)) || (entry.operation !== undefined && !safeCategory(entry.operation))) return { ok: false, error: { kind: "DiscoveryRequestLogEntryInvalid" } };
    if (entry.status !== undefined && (!Number.isSafeInteger(entry.status) || entry.status < 100 || entry.status > 599)) {
      return { ok: false, error: { kind: "DiscoveryRequestLogEntryInvalid" } };
    }
    if (entry.durationMs !== undefined && !nonNegativeInteger(entry.durationMs)) {
      return { ok: false, error: { kind: "DiscoveryRequestLogEntryInvalid" } };
    }
    if (entry.itemCount !== undefined && !nonNegativeInteger(entry.itemCount)) {
      return { ok: false, error: { kind: "DiscoveryRequestLogEntryInvalid" } };
    }
    if (entry.ownerId !== undefined && !safeCategory(entry.ownerId)) return { ok: false, error: { kind: "DiscoveryRequestLogEntryInvalid" } };
    if (entry.sourceId !== undefined && !safeCategory(entry.sourceId)) return { ok: false, error: { kind: "DiscoveryRequestLogEntryInvalid" } };
    if (entry.runId !== undefined && !safeCategory(entry.runId)) return { ok: false, error: { kind: "DiscoveryRequestLogEntryInvalid" } };
    if (entry.failureKind !== undefined && !safeCategory(entry.failureKind)) return { ok: false, error: { kind: "DiscoveryRequestLogEntryInvalid" } };
    const occurredAt = dependencies.now();
    if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) {
      return { ok: false, error: { kind: "DiscoveryRequestLogTimestampInvalid" } };
    }

    const dependencyKey = entry.operation === undefined
      ? entry.correlationId
      : `${entry.correlationId}:dependency:${entry.operation}`;
    const isEntry = entry.event === "request-entry" || entry.event === "dependency-entry";
    const isTerminal = entry.event === "request-success" || entry.event === "request-failure" || entry.event === "dependency-success" || entry.event === "dependency-failure";
    if (isEntry) started.set(dependencyKey, Date.parse(occurredAt));
    const inferredDuration = entry.durationMs ?? (isTerminal && started.has(dependencyKey)
      ? Math.max(0, Date.parse(occurredAt) - /** @type {number} */ (started.get(dependencyKey)))
      : undefined);
    if (isTerminal) started.delete(dependencyKey);

    /** @type {DiscoveryRequestLogRecord} */
    const safe = {
      component: "discovery-worker",
      event: entry.event,
      correlationId: entry.correlationId,
      occurredAt,
      route: entry.route,
      method: entry.method,
      ...(entry.ownerId === undefined ? {} : { ownerId: entry.ownerId }),
      ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
      ...(entry.runId === undefined ? {} : { runId: entry.runId }),
      ...(entry.operation === undefined ? {} : { operation: entry.operation }),
      ...(entry.status === undefined ? {} : { status: entry.status }),
      ...(entry.failureKind === undefined ? {} : { failureKind: entry.failureKind }),
      ...(inferredDuration === undefined ? {} : { durationMs: inferredDuration }),
      ...(entry.itemCount === undefined ? {} : { itemCount: entry.itemCount }),
    };
    dependencies.sink(Object.freeze(safe));
    return { ok: true, value: null };
  }

  return Object.freeze(log);
}
