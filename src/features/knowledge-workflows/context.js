// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {"rights-assessor" | "knowledge-scraper" | "question-generator" | "question-evaluator"} AgentRole */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly role: string,
 *   readonly tokenCount: number,
 *   readonly eventIds: readonly string[],
 *   readonly summary: string,
 *   readonly recordIds?: readonly string[]
 * }} ContextTurn
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly state: string,
 *   readonly revision: number
 * }} ContextCheckpoint
 */

/**
 * @typedef {{
 *   readonly activeContract: unknown,
 *   readonly checkpoint: ContextCheckpoint,
 *   readonly unresolvedIssues: readonly unknown[],
 *   readonly evidenceLinks: readonly string[],
 *   readonly recentTurns: readonly ContextTurn[],
 *   readonly ledgerEventIds: readonly string[],
 *   readonly tokenCount: number,
 *   readonly safeCheckpoint: boolean
 * }} WorkingContext
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly runId: string,
 *   readonly role: AgentRole,
 *   readonly checkpointId: string,
 *   readonly sourceContextDigest: string,
 *   readonly compactedContextDigest: string,
 *   readonly thresholdTokens: number,
 *   readonly inputTokenCount: number,
 *   readonly retainedTurnIds: readonly string[],
 *   readonly recoveryEventIds: readonly string[],
 *   readonly reversible: true,
 *   readonly createdAt: string,
 *   readonly coveredTurnIds: readonly string[],
 *   readonly coveredRecordIds: readonly string[]
 * }} CompactionRecord
 */

/**
 * @typedef {{
 *   readonly kind: "ContextCommandInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "ContextLimitBeforeSafeCheckpoint"
 * } | {
 *   readonly kind: "CompactionRecordPersistenceFailed"
 * } | {
 *   readonly kind: "ContextDigestUnavailable"
 * } | {
 *   readonly kind: "ContextSummaryFailed" | "ContextSummaryInvalid"
 * }} ContextFailure
 */

/**
 * @typedef {{
 *   readonly status: "not-needed" | "compacted",
 *   readonly context: WorkingContext,
 *   readonly record: CompactionRecord | null
 * }} CompactionResult
 */

/**
 * @typedef {{
 *   readonly thresholdTokens?: number,
 *   readonly maxRecentTurns?: number,
 *   readonly maxSummaryTokens?: number,
 *   readonly summarize?: (input: { readonly role: AgentRole, readonly context: WorkingContext, readonly coveredTurnIds: readonly string[], readonly maxOutputTokens: number }) => Promise<Result<{ readonly summary: string }, { readonly kind: string }>>,
 *   readonly now: () => string,
 *   readonly digest: (canonical: string) => string,
 *   readonly appendRecord: (record: CompactionRecord) => Promise<null>,
 *   readonly logger: (entry: { readonly event: string, readonly runId: string, readonly role: AgentRole, readonly failureKind?: string }) => void
 * }} ContextDependencies
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function isNonEmptyText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value @returns {value is AgentRole} */
function isAgentRole(value) {
  return value === "rights-assessor" || value === "knowledge-scraper" ||
    value === "question-generator" || value === "question-evaluator";
}

/** @param {unknown} value @returns {value is ContextTurn} */
function isContextTurn(value) {
  return isRecord(value) && isNonEmptyText(value.id) && isNonEmptyText(value.role) &&
    typeof value.tokenCount === "number" && Number.isSafeInteger(value.tokenCount) && value.tokenCount >= 0 &&
    Array.isArray(value.eventIds) && value.eventIds.every(isNonEmptyText) &&
    typeof value.summary === "string" && (value.recordIds === undefined || (Array.isArray(value.recordIds) && value.recordIds.every(isNonEmptyText)));
}

/** @param {unknown} value @returns {value is WorkingContext} */
function isWorkingContext(value) {
  return isRecord(value) && isRecord(value.checkpoint) &&
    isNonEmptyText(value.checkpoint.id) && isNonEmptyText(value.checkpoint.state) &&
    typeof value.checkpoint.revision === "number" && Number.isSafeInteger(value.checkpoint.revision) && value.checkpoint.revision >= 0 &&
    Array.isArray(value.unresolvedIssues) && Array.isArray(value.evidenceLinks) &&
    value.evidenceLinks.every(isNonEmptyText) && Array.isArray(value.recentTurns) &&
    value.recentTurns.every(isContextTurn) && Array.isArray(value.ledgerEventIds) &&
    value.ledgerEventIds.every(isNonEmptyText) && typeof value.tokenCount === "number" && Number.isSafeInteger(value.tokenCount) &&
    value.tokenCount >= 0 && typeof value.safeCheckpoint === "boolean" &&
    value.activeContract !== undefined;
}

/** @param {unknown} value @returns {value is { readonly ownerId: string, readonly runId: string, readonly role: AgentRole, readonly context: WorkingContext, readonly thresholdTokens?: number, readonly summarize?: ContextDependencies["summarize"] }} */
function isCompactionCommand(value) {
  return isRecord(value) && isNonEmptyText(value.ownerId) && isNonEmptyText(value.runId) &&
    isAgentRole(value.role) && isWorkingContext(value.context) && (value.thresholdTokens === undefined || (typeof value.thresholdTokens === "number" && Number.isSafeInteger(value.thresholdTokens) && value.thresholdTokens > 0)) && (value.summarize === undefined || typeof value.summarize === "function");
}

/** @param {unknown} value */
function cloneSerializable(value) {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError("Working context is not serializable.", { cause: error });
  }
}

/** @param {unknown} value */
function freezeTree(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeTree(child);
  return value;
}

/** @param {unknown} value @returns {string} */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** @param {ContextDependencies} dependencies */
export function createContextCompactor(dependencies) {
  const thresholdTokens = dependencies?.thresholdTokens ?? 500_000;
  // No arbitrary raw-turn window: compact every completed raw turn by default.
  const maxRecentTurns = dependencies?.maxRecentTurns ?? 0;
  const maxSummaryTokens = dependencies?.maxSummaryTokens ?? 8_192;
  if (!dependencies || !Number.isSafeInteger(thresholdTokens) || thresholdTokens <= 0 ||
    !Number.isSafeInteger(maxRecentTurns) || maxRecentTurns < 0 || !Number.isSafeInteger(maxSummaryTokens) || maxSummaryTokens <= 0 ||
    typeof dependencies.now !== "function" || typeof dependencies.digest !== "function" ||
    typeof dependencies.appendRecord !== "function" || typeof dependencies.logger !== "function") {
    throw new TypeError("Context compactor dependencies are invalid.");
  }
  return Object.freeze({
    /** @param {unknown} command @returns {Promise<Result<CompactionResult, ContextFailure>>} */
    async compact(command) {
      if (!isCompactionCommand(command)) {
        return { ok: false, error: { kind: "ContextCommandInvalid", field: "command" } };
      }
      const { ownerId, runId, role, context } = command;
      const commandThreshold = command.thresholdTokens ?? thresholdTokens;
      if (context.tokenCount < commandThreshold) {
        return { ok: true, value: { status: "not-needed", context: /** @type {WorkingContext} */ (freezeTree(cloneSerializable(context))), record: null } };
      }
      if (!context.safeCheckpoint) {
        dependencies.logger({ event: "knowledge-workflow.compaction-paused", runId, role, failureKind: "ContextLimitBeforeSafeCheckpoint" });
        return { ok: false, error: { kind: "ContextLimitBeforeSafeCheckpoint" } };
      }
      let sourceContextDigest;
      let compactedContextDigest;
      try {
        sourceContextDigest = dependencies.digest(canonicalize(context));
        if (!isNonEmptyText(sourceContextDigest)) throw new TypeError("Context digest is empty.");
      } catch (error) {
        dependencies.logger({ event: "knowledge-workflow.compaction-failure", runId, role, failureKind: "ContextDigestUnavailable" });
        return { ok: false, error: { kind: "ContextDigestUnavailable" } };
      }
      const retainedTurns = maxRecentTurns === 0 ? [] : context.recentTurns.slice(-maxRecentTurns);
      const coveredTurns = maxRecentTurns === 0 ? context.recentTurns : context.recentTurns.slice(0, -maxRecentTurns);
      let summary = "";
      if (coveredTurns.length > 0) {
        const summarize = command.summarize ?? dependencies.summarize;
        if (typeof summarize !== "function") return { ok: false, error: { kind: "ContextSummaryFailed" } };
        let summarized;
        try {
          summarized = await summarize({ role, context, coveredTurnIds: coveredTurns.map((turn) => turn.id), maxOutputTokens: maxSummaryTokens });
        } catch (error) {
          dependencies.logger({ event: "knowledge-workflow.compaction-failure", runId, role, failureKind: "ContextSummaryFailed" });
          return { ok: false, error: { kind: "ContextSummaryFailed" } };
        }
        if (!isRecord(summarized) || summarized.ok !== true) return { ok: false, error: { kind: "ContextSummaryFailed" } };
        if (!isRecord(summarized.value) || Object.keys(summarized.value).length !== 1 || !isNonEmptyText(summarized.value.summary)) return { ok: false, error: { kind: "ContextSummaryInvalid" } };
        summary = summarized.value.summary;
        if (Math.ceil(new TextEncoder().encode(summary).byteLength / 3) > maxSummaryTokens || summary.length >= coveredTurns.reduce((size, turn) => size + turn.summary.length, 0)) return { ok: false, error: { kind: "ContextSummaryInvalid" } };
      }
      const summaryTurn = coveredTurns.length === 0 ? [] : [{ id: `summary:${context.checkpoint.id}:${sourceContextDigest}`, role: "summary", tokenCount: Math.ceil(new TextEncoder().encode(summary).byteLength / 3), eventIds: [...new Set(coveredTurns.flatMap((turn) => turn.eventIds))], recordIds: [...new Set(coveredTurns.flatMap((turn) => turn.recordIds ?? []))], summary }];
      const compacted = /** @type {WorkingContext} */ (freezeTree(cloneSerializable({
        activeContract: context.activeContract,
        checkpoint: context.checkpoint,
        unresolvedIssues: context.unresolvedIssues,
        evidenceLinks: [...new Set(context.evidenceLinks)],
        recentTurns: [...summaryTurn, ...retainedTurns],
        ledgerEventIds: context.ledgerEventIds,
        tokenCount: summaryTurn.reduce((total, turn) => total + turn.tokenCount, 0) + retainedTurns.reduce((total, turn) => total + turn.tokenCount, 0),
        safeCheckpoint: true,
      })));
      try {
        compactedContextDigest = dependencies.digest(canonicalize(compacted));
        if (!isNonEmptyText(compactedContextDigest)) throw new TypeError("Compacted context digest is empty.");
      } catch (error) {
        dependencies.logger({ event: "knowledge-workflow.compaction-failure", runId, role, failureKind: "ContextDigestUnavailable" });
        return { ok: false, error: { kind: "ContextDigestUnavailable" } };
      }
      const record = /** @type {CompactionRecord} */ (freezeTree({
        id: `compaction:${runId}:${context.checkpoint.id}:${crypto.randomUUID()}`,
        ownerId,
        runId,
        role,
        checkpointId: context.checkpoint.id,
        sourceContextDigest,
        compactedContextDigest,
        thresholdTokens: commandThreshold,
        inputTokenCount: context.tokenCount,
        retainedTurnIds: retainedTurns.map((turn) => turn.id),
        coveredTurnIds: coveredTurns.map((turn) => turn.id),
        coveredRecordIds: [...new Set(coveredTurns.flatMap((turn) => turn.recordIds ?? []))],
        recoveryEventIds: [...context.ledgerEventIds],
        reversible: true,
        createdAt: dependencies.now(),
      }));
      try {
        await dependencies.appendRecord(record);
      } catch (error) {
        dependencies.logger({ event: "knowledge-workflow.compaction-failure", runId, role, failureKind: "CompactionRecordPersistenceFailed" });
        return { ok: false, error: { kind: "CompactionRecordPersistenceFailed" } };
      }
      dependencies.logger({ event: "knowledge-workflow.compaction-success", runId, role });
      return { ok: true, value: { status: "compacted", context: compacted, record } };
    },
  });
}

export {};
