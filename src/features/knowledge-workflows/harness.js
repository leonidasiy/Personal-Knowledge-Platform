// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {import("./memory.js").AgentMemoryNamespace} AgentMemoryNamespace */
/** @typedef {import("./memory.js").AgentRole} AgentRole */

/**
 * @typedef {{
 *   readonly provider: string,
 *   readonly fields: readonly unknown[]
 * }} ReasoningTrace
 */

/**
 * @typedef {{
 *   readonly type: "tool-call",
 *   readonly reasoningTrace?: ReasoningTrace | null,
 *   readonly call: { readonly id: string, readonly name: string, readonly input: unknown }
 * } | {
 *   readonly type: "final",
 *   readonly reasoningTrace?: ReasoningTrace | null,
 *   readonly output: Record<string, unknown>
 * }} AgentModelResponse
 */

/** @typedef {{ readonly respond: (command: { readonly taskId: string, readonly turn: number, readonly input: unknown, readonly toolResults: readonly unknown[] }) => Promise<unknown> }} AgentModel */
/** @typedef {{ readonly execute: (input: unknown) => Promise<unknown> }} AgentTool */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly runId: string,
 *   readonly role: AgentRole,
 *   readonly taskId: string,
 *   readonly kind: "model-response" | "tool-call" | "tool-result",
 *   readonly occurredAt: string,
 *   readonly failureKind?: string,
 *   readonly reasoningTrace?: ReasoningTrace,
 *   readonly payload?: unknown
 * }} AgentEvent
 */

/** @typedef {{ readonly append: (event: AgentEvent) => Promise<null> }} AgentEventLedger */

/**
 * @typedef {{
 *   readonly kind: "AgentCommandInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "AgentOutputInvalid"
 * } | {
 *   readonly kind: "OrphanedToolCall"
 * } | {
 *   readonly kind: "DuplicateDispatch"
 * } | {
 *   readonly kind: "ToolUnauthorized"
 * } | {
 *   readonly kind: "ToolExecutionFailed"
 * } | {
 *   readonly kind: "ToolCallLimitExceeded"
 * } | {
 *   readonly kind: "AgentLedgerPersistenceFailed"
 * } | {
 *   readonly kind: "IterationLimitExceeded"
 * }} AgentHarnessFailure
 */

/**
 * @typedef {{
 *   readonly memory: {
 *     readonly listRecords: (namespace: AgentMemoryNamespace) => Promise<Result<readonly unknown[], unknown>>
 *   },
 *   readonly model: AgentModel,
 *   readonly eventLedger: AgentEventLedger,
 *   readonly tools: ReadonlyMap<string, AgentTool>,
 *   readonly executionId?: string,
 *   readonly maxTurns: number,
 *   readonly maxToolCalls?: number,
 *   readonly now: () => string,
 *   readonly logger: (entry: { readonly event: string, readonly runId?: string, readonly role?: AgentRole, readonly failureKind?: string }) => void
 * }} AgentHarnessDependencies
 */

/** @typedef {{ readonly namespace: AgentMemoryNamespace, readonly taskId: string, readonly input: unknown }} AgentRunCommand */

/** @param {unknown} value @returns {value is string} */
function isNonEmptyText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is ReasoningTrace | null | undefined} */
function isReasoningTrace(value) {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || !isNonEmptyText(value.provider) || !Array.isArray(value.fields)) return false;
  return true;
}

/** @param {unknown} value @returns {value is AgentModelResponse} */
function isModelResponse(value) {
  if (!isRecord(value) || !isReasoningTrace(value.reasoningTrace)) return false;
  if (value.type === "tool-call") {
    return isRecord(value.call) && isNonEmptyText(value.call.id) &&
      isNonEmptyText(value.call.name) && "input" in value.call;
  }
  return value.type === "final" && isRecord(value.output);
}

/** @param {AgentMemoryNamespace} namespace @returns {boolean} */
function isNamespace(namespace) {
  return isRecord(namespace) && isNonEmptyText(namespace.id) && isNonEmptyText(namespace.ownerId) &&
    isNonEmptyText(namespace.runId) && isNonEmptyText(namespace.role);
}

/**
 * Creates the bounded model/tool/event orchestration loop. External effects
 * are injected and every visible model response receives an immutable event
 * before the next dispatch.
 * @param {AgentHarnessDependencies} dependencies
 */
export function createAgentHarness(dependencies) {
  if (!dependencies || !dependencies.memory || typeof dependencies.memory.listRecords !== "function" ||
    !dependencies.model || typeof dependencies.model.respond !== "function" ||
    !dependencies.eventLedger || typeof dependencies.eventLedger.append !== "function" ||
    !(dependencies.tools instanceof Map) || !Number.isSafeInteger(dependencies.maxTurns) || dependencies.maxTurns <= 0 ||
    (dependencies.maxToolCalls !== undefined && (!Number.isSafeInteger(dependencies.maxToolCalls) || dependencies.maxToolCalls <= 0)) ||
    typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") {
    throw new TypeError("Agent harness dependencies are invalid.");
  }
  const { memory, model, eventLedger, tools, executionId = "direct", maxTurns, maxToolCalls = Number.MAX_SAFE_INTEGER, now, logger } = dependencies;
  if (!isNonEmptyText(executionId)) throw new TypeError("Agent execution ID is invalid.");
  return Object.freeze({
    /** @param {AgentRunCommand} command @returns {Promise<Result<{ readonly output: Record<string, unknown>, readonly turns: number }, AgentHarnessFailure>>} */
    async run(command) {
      if (!command || !isNamespace(command.namespace)) {
        return { ok: false, error: { kind: "AgentCommandInvalid", field: "namespace" } };
      }
      if (!isNonEmptyText(command.taskId)) {
        return { ok: false, error: { kind: "AgentCommandInvalid", field: "taskId" } };
      }
      /** @type {Set<string>} */
      const dispatched = new Set();
      /** @type {unknown[]} */
      const toolResults = [];
      let toolCallCount = 0;
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        let response;
        try {
          response = await model.respond({ taskId: command.taskId, turn, input: command.input, toolResults });
        } catch {
          logger({ event: "agent.failure", runId: command.namespace.runId, role: command.namespace.role, failureKind: "AgentOutputInvalid" });
          return { ok: false, error: { kind: "AgentOutputInvalid" } };
        }
        if (!isModelResponse(response)) {
          const persisted = await appendEvent(eventLedger, {
            id: `agent-event:${command.namespace.runId}:${executionId}:${command.taskId}:${turn}`,
            runId: command.namespace.runId,
            role: command.namespace.role,
            taskId: command.taskId,
            kind: "model-response",
            occurredAt: now(),
            failureKind: "AgentOutputInvalid",
            payload: null,
          });
          if (!persisted.ok) return persisted;
          logger({ event: "agent.failure", runId: command.namespace.runId, role: command.namespace.role, failureKind: "AgentOutputInvalid" });
          return { ok: false, error: { kind: "AgentOutputInvalid" } };
        }
        const trace = response.reasoningTrace ?? null;
        const modelEvent = /** @type {AgentEvent} */ ({
          id: `agent-event:${command.namespace.runId}:${executionId}:${command.taskId}:${turn}`,
          runId: command.namespace.runId,
          role: command.namespace.role,
          taskId: command.taskId,
          kind: "model-response",
          occurredAt: now(),
          ...(trace === null ? { failureKind: "ReasoningTraceUnavailable" } : { reasoningTrace: trace }),
          payload: response.type === "final" ? response.output : response.call,
        });
        const modelPersisted = await appendEvent(eventLedger, modelEvent);
        if (!modelPersisted.ok) return modelPersisted;
        if (response.type === "final") {
          logger({ event: "agent.success", runId: command.namespace.runId, role: command.namespace.role });
          return { ok: true, value: { output: response.output, turns: turn } };
        }
        if (dispatched.has(response.call.id)) {
          logger({ event: "agent.failure", runId: command.namespace.runId, role: command.namespace.role, failureKind: "DuplicateDispatch" });
          return { ok: false, error: { kind: "DuplicateDispatch" } };
        }
        const tool = tools.get(response.call.name);
        if (!tool) {
          logger({ event: "agent.failure", runId: command.namespace.runId, role: command.namespace.role, failureKind: "ToolUnauthorized" });
          return { ok: false, error: { kind: "ToolUnauthorized" } };
        }
        toolCallCount += 1;
        if (toolCallCount > maxToolCalls) {
          logger({ event: "agent.failure", runId: command.namespace.runId, role: command.namespace.role, failureKind: "ToolCallLimitExceeded" });
          return { ok: false, error: { kind: "ToolCallLimitExceeded" } };
        }
        dispatched.add(response.call.id);
        const toolCallPersisted = await appendEvent(eventLedger, {
          id: `agent-tool-call:${command.namespace.runId}:${executionId}:${command.taskId}:${response.call.id}`,
          runId: command.namespace.runId,
          role: command.namespace.role,
          taskId: command.taskId,
          kind: "tool-call",
          occurredAt: now(),
          payload: response.call,
        });
        if (!toolCallPersisted.ok) return toolCallPersisted;
        let toolResult;
        try {
          toolResult = await tool.execute(response.call.input);
        } catch {
          logger({ event: "agent.failure", runId: command.namespace.runId, role: command.namespace.role, failureKind: "ToolExecutionFailed" });
          return { ok: false, error: { kind: "ToolExecutionFailed" } };
        }
        toolResults.push({ id: response.call.id, value: toolResult });
        const toolResultPersisted = await appendEvent(eventLedger, {
          id: `agent-tool-result:${command.namespace.runId}:${command.taskId}:${response.call.id}`,
          runId: command.namespace.runId,
          role: command.namespace.role,
          taskId: command.taskId,
          kind: "tool-result",
          occurredAt: now(),
          payload: { id: response.call.id, value: toolResult },
        });
        if (!toolResultPersisted.ok) return toolResultPersisted;
      }
      logger({ event: "agent.failure", runId: command.namespace.runId, role: command.namespace.role, failureKind: "IterationLimitExceeded" });
      return { ok: false, error: { kind: "IterationLimitExceeded" } };
    },
  });
}

/** @param {AgentEventLedger} ledger @param {AgentEvent} event @returns {Promise<Result<null, AgentHarnessFailure>>} */
async function appendEvent(ledger, event) {
  try {
    await ledger.append(event);
    return { ok: true, value: null };
  } catch {
    return { ok: false, error: { kind: "AgentLedgerPersistenceFailed" } };
  }
}

export {};
