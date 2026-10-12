// @ts-check

import {
  isAlias,
  isMap,
  isPair,
  isSeq,
  parseDocument,
} from "../../../vendor/yaml/index.js";

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {"rights-assessor" | "knowledge-scraper" | "question-generator" | "question-evaluator"} AgentRole */

/**
 * @typedef {{
 *   readonly provider: string,
 *   readonly name: string,
 *   readonly reasoningEffort?: "none" | "low" | "high"
 * }} AgentModel
 */

/**
 * @typedef {{
 *   readonly namespace: string,
 *   readonly visibility: "owner-run"
 * }} AgentMemoryVisibility
 */

/**
 * @typedef {{
 *   readonly maxTurns: number,
 *   readonly maxToolCalls: number,
 *   readonly timeoutMs: number,
 *   readonly maxOutputBytes: number,
 *   readonly compactionThresholdTokens: number
 * }} AgentConfigurationLimits
 */

/**
 * @typedef {{
 *   readonly role: AgentRole,
 *   readonly version: string,
 *   readonly model: AgentModel,
 *   readonly procedureVersion: string,
 *   readonly promptVersion: string,
 *   readonly inputSchema: string,
 *   readonly outputSchema: string,
 *   readonly allowedTools: readonly string[],
 *   readonly memory: AgentMemoryVisibility,
 *   readonly limits: AgentConfigurationLimits,
 *   readonly retry: {
 *     readonly maxAttempts: number,
 *     readonly backoffMs: number
 *   },
 *   readonly stopRules: readonly string[]
 * }} AgentConfiguration
 */

/**
 * @typedef {AgentConfiguration & {
 *   readonly id: string,
 *   readonly canonicalJson: string,
 *   readonly digest: string
 * }} AgentConfigurationSnapshot
 */

/**
 * @typedef {{ readonly source: string, readonly expectedRole?: AgentRole, readonly expectedDigest?: string }} AgentConfigurationCommand
 */

/**
 * @typedef {{ readonly sha256: (input: string) => Promise<string>, readonly supportedModels?: ReadonlySet<string>, readonly supportedTools?: ReadonlySet<string> }} AgentConfigurationDependencies
 */

/**
 * @typedef {{
 *   readonly kind: "WorkflowConfigurationCommandInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "WorkflowConfigurationYamlInvalid"
 * } | {
 *   readonly kind: "WorkflowConfigurationYamlUnsafe"
 * } | {
 *   readonly kind: "WorkflowConfigurationFieldUnknown",
 *   readonly field: string
 * } | {
 *   readonly kind: "WorkflowConfigurationFieldMissing",
 *   readonly field: string
 * } | {
 *   readonly kind: "WorkflowConfigurationFieldInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "WorkflowConfigurationSecretFieldForbidden",
 *   readonly field: string
 * } | {
 *   readonly kind: "WorkflowConfigurationRoleMismatch",
 *   readonly expected: AgentRole,
 *   readonly actual: string
 * } | {
 *   readonly kind: "WorkflowConfigurationDigestUnavailable"
 * } | {
 *   readonly kind: "WorkflowConfigurationDigestMismatch",
 *   readonly expected: string,
 *   readonly actual: string
 * } | {
 *   readonly kind: "WorkflowConfigurationModelUnsupported"
 * } | {
 *   readonly kind: "WorkflowConfigurationToolUnsupported",
 *   readonly tool: string
 * }} AgentConfigurationFailure
 */

/**
 * Structural view used only while validating untrusted YAML AST nodes.
 * @typedef {{
 *   readonly anchor?: unknown,
 *   readonly tag?: unknown,
 *   readonly items?: readonly unknown[],
 *   readonly key?: unknown,
 *   readonly value?: unknown,
 *   readonly source?: unknown
 * }} YamlNodeView
 */

/**
 * @typedef {{
 *   readonly contents: unknown,
 *   readonly errors: readonly unknown[],
 *   readonly warnings: readonly unknown[],
 *   toJS: (options?: unknown) => unknown
 * }} YamlDocument
 */

/** @param {unknown} value @returns {value is Readonly<Record<string, unknown>>} */
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

/** @param {unknown} value @returns {value is number} */
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** @param {unknown} value @returns {value is readonly unknown[]} */
function isArray(value) {
  return Array.isArray(value);
}

/** @param {unknown} node @returns {boolean} */
function containsUnsafeYamlNode(node) {
  if (node === null || typeof node !== "object") return false;
  if (isAlias(node)) return true;
  const view = /** @type {YamlNodeView} */ (node);
  if (view.anchor !== undefined || view.tag !== undefined) return true;
  if (isPair(node)) {
    const key = view.key;
    if (isRecord(key) && key.value === "<<") return true;
    return containsUnsafeYamlNode(view.key) || containsUnsafeYamlNode(view.value);
  }
  if (isMap(node) || isSeq(node)) {
    return Array.isArray(view.items) && view.items.some(containsUnsafeYamlNode);
  }
  return containsUnsafeYamlNode(view.value);
}

/** @param {unknown} value @returns {unknown} */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  /** @type {Record<string, unknown>} */
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
  return sorted;
}

/** @param {unknown} value @returns {unknown} */
function freezeDeep(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const item of value) freezeDeep(item);
    } else {
      for (const child of Object.values(value)) freezeDeep(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** @param {YamlDocument} document @returns {Record<string, unknown> | null} */
function parsedConfiguration(document) {
  if (!isMap(document.contents)) return null;
  const value = document.toJS({ mapAsMap: false });
  return isRecord(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/** @param {Record<string, unknown>} value @returns {{ readonly field: string } | null} */
function findSecretField(value) {
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
    if (new Set([
      "apikey",
      "accesstoken",
      "authtoken",
      "clientsecret",
      "credential",
      "password",
      "privatekey",
      "secret",
      "token",
    ]).has(normalizedKey)) {
      return { field: key };
    }
    if (isRecord(child)) {
      const nested = findSecretField(child);
      if (nested) return { field: `${key}.${nested.field}` };
    } else if (Array.isArray(child)) {
      for (const item of child) {
        if (isRecord(item)) {
          const nested = findSecretField(item);
          if (nested) return { field: `${key}.${nested.field}` };
        }
      }
    }
  }
  return null;
}

/** @param {Record<string, unknown>} value @returns {AgentConfigurationFailure | null} */
function validateConfiguration(value) {
  const allowed = new Set([
    "role",
    "version",
    "model",
    "procedureVersion",
    "promptVersion",
    "inputSchema",
    "outputSchema",
    "allowedTools",
    "memory",
    "limits",
    "retry",
    "stopRules",
  ]);
  const secret = findSecretField(value);
  if (secret) return { kind: "WorkflowConfigurationSecretFieldForbidden", field: secret.field };
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) return { kind: "WorkflowConfigurationFieldUnknown", field: unknown };
  for (const field of allowed) {
    if (!(field in value)) return { kind: "WorkflowConfigurationFieldMissing", field };
  }
  if (!isAgentRole(value.role)) return { kind: "WorkflowConfigurationFieldInvalid", field: "role" };
  for (const field of ["version", "procedureVersion", "promptVersion", "inputSchema", "outputSchema"]) {
    if (!isNonEmptyText(value[field])) return { kind: "WorkflowConfigurationFieldInvalid", field };
  }
  if (!isRecord(value.model)) return { kind: "WorkflowConfigurationFieldInvalid", field: "model" };
  const unknownModelField = Object.keys(value.model).find((field) => field !== "provider" && field !== "name" && field !== "reasoningEffort");
  if (unknownModelField !== undefined) return { kind: "WorkflowConfigurationFieldUnknown", field: `model.${unknownModelField}` };
  if (!isNonEmptyText(value.model.provider) || !isNonEmptyText(value.model.name)) {
    return { kind: "WorkflowConfigurationFieldInvalid", field: "model" };
  }
  if (value.model.reasoningEffort !== undefined && (typeof value.model.reasoningEffort !== "string" || !["none", "low", "high"].includes(value.model.reasoningEffort))) return { kind: "WorkflowConfigurationFieldInvalid", field: "model.reasoningEffort" };
  if (!isArray(value.allowedTools) || value.allowedTools.length === 0 ||
    value.allowedTools.some((tool) => !isNonEmptyText(tool))) {
    return { kind: "WorkflowConfigurationFieldInvalid", field: "allowedTools" };
  }
  if (!isRecord(value.memory) || !isNonEmptyText(value.memory.namespace) ||
    value.memory.visibility !== "owner-run") {
    return { kind: "WorkflowConfigurationFieldInvalid", field: "memory" };
  }
  if (!isRecord(value.limits)) return { kind: "WorkflowConfigurationFieldInvalid", field: "limits" };
  const limits = value.limits;
  for (const field of ["maxTurns", "maxToolCalls", "timeoutMs", "maxOutputBytes", "compactionThresholdTokens"]) {
    if (!(field in limits)) return { kind: "WorkflowConfigurationFieldMissing", field: `limits.${field}` };
    if (!isPositiveInteger(limits[field])) return { kind: "WorkflowConfigurationFieldInvalid", field: `limits.${field}` };
  }
  const compactionThresholdTokens = limits.compactionThresholdTokens;
  const maxOutputBytes = limits.maxOutputBytes;
  if (typeof compactionThresholdTokens !== "number" || typeof maxOutputBytes !== "number") {
    return { kind: "WorkflowConfigurationFieldInvalid", field: "limits" };
  }
  if (compactionThresholdTokens < 150000 || maxOutputBytes > 1048576) {
    return { kind: "WorkflowConfigurationFieldInvalid", field: compactionThresholdTokens < 150000 ? "limits.compactionThresholdTokens" : "limits.maxOutputBytes" };
  }
  if (!isRecord(value.retry)) return { kind: "WorkflowConfigurationFieldInvalid", field: "retry" };
  for (const field of ["maxAttempts", "backoffMs"]) {
    if (!(field in value.retry)) return { kind: "WorkflowConfigurationFieldMissing", field: `retry.${field}` };
    if (!isPositiveInteger(value.retry[field])) return { kind: "WorkflowConfigurationFieldInvalid", field: `retry.${field}` };
  }
  if (!isArray(value.stopRules) || value.stopRules.some((rule) => !isNonEmptyText(rule))) {
    return { kind: "WorkflowConfigurationFieldInvalid", field: "stopRules" };
  }
  return null;
}

/**
 * Creates the strict YAML configuration loader. The digest implementation is
 * injected so parsing and hashing remain deterministic and testable without
 * shared runtime configuration.
 * @param {AgentConfigurationDependencies} dependencies
 */
export function createAgentConfigurationLoader(dependencies) {
  if (!dependencies || typeof dependencies.sha256 !== "function") {
    throw new TypeError("Agent configuration dependencies are invalid.");
  }
  return Object.freeze({
    /** @param {AgentConfigurationCommand} command @returns {Promise<import("./config.js").Result<AgentConfigurationSnapshot, AgentConfigurationFailure>>} */
    async load(command) {
      if (!command || !isNonEmptyText(command.source)) {
        return { ok: false, error: { kind: "WorkflowConfigurationCommandInvalid", field: "source" } };
      }
      if (command.expectedRole !== undefined && !isAgentRole(command.expectedRole)) {
        return { ok: false, error: { kind: "WorkflowConfigurationCommandInvalid", field: "expectedRole" } };
      }
      if (command.expectedDigest !== undefined && !isNonEmptyText(command.expectedDigest)) {
        return { ok: false, error: { kind: "WorkflowConfigurationCommandInvalid", field: "expectedDigest" } };
      }
      /** @type {YamlDocument | null} */
      let document = null;
      try {
        document = /** @type {YamlDocument} */ (parseDocument(command.source, {
          version: "1.2",
          schema: "core",
          strict: true,
          stringKeys: true,
          uniqueKeys: true,
          maxAliasCount: 0,
          logLevel: "error",
        }));
      } catch {
        return { ok: false, error: { kind: "WorkflowConfigurationYamlInvalid" } };
      }
      if (document.errors.length > 0 || document.warnings.length > 0) {
        return { ok: false, error: { kind: "WorkflowConfigurationYamlInvalid" } };
      }
      if (containsUnsafeYamlNode(document.contents)) {
        return { ok: false, error: { kind: "WorkflowConfigurationYamlUnsafe" } };
      }
      const parsed = parsedConfiguration(document);
      if (!parsed) return { ok: false, error: { kind: "WorkflowConfigurationYamlInvalid" } };
      const validation = validateConfiguration(parsed);
      if (validation) return { ok: false, error: validation };
      const model = /** @type {AgentModel} */ (parsed.model);
      if (dependencies.supportedModels !== undefined && !dependencies.supportedModels.has(`${model.provider}/${model.name}`)) {
        return { ok: false, error: { kind: "WorkflowConfigurationModelUnsupported" } };
      }
      if (dependencies.supportedTools !== undefined) {
        const unsupported = /** @type {string[]} */ (parsed.allowedTools).find((tool) => !dependencies.supportedTools?.has(tool));
        if (unsupported !== undefined) return { ok: false, error: { kind: "WorkflowConfigurationToolUnsupported", tool: unsupported } };
      }
      if (command.expectedRole !== undefined && parsed.role !== command.expectedRole) {
        return {
          ok: false,
          error: {
            kind: "WorkflowConfigurationRoleMismatch",
            expected: command.expectedRole,
            actual: String(parsed.role),
          },
        };
      }
      const canonicalValue = /** @type {AgentConfiguration} */ (canonicalize({
        role: parsed.role,
        version: parsed.version,
        model: parsed.model,
        procedureVersion: parsed.procedureVersion,
        promptVersion: parsed.promptVersion,
        inputSchema: parsed.inputSchema,
        outputSchema: parsed.outputSchema,
        allowedTools: parsed.allowedTools,
        memory: parsed.memory,
        limits: parsed.limits,
        retry: parsed.retry,
        stopRules: parsed.stopRules,
      }));
      const canonicalJson = JSON.stringify(canonicalValue);
      let digest;
      try {
        digest = await dependencies.sha256(canonicalJson);
      } catch {
        return { ok: false, error: { kind: "WorkflowConfigurationDigestUnavailable" } };
      }
      if (!isNonEmptyText(digest)) {
        return { ok: false, error: { kind: "WorkflowConfigurationDigestUnavailable" } };
      }
      if (command.expectedDigest !== undefined && digest !== command.expectedDigest) {
        return { ok: false, error: { kind: "WorkflowConfigurationDigestMismatch", expected: command.expectedDigest, actual: digest } };
      }
      const snapshot = {
        ...canonicalValue,
        id: `${canonicalValue.role}:${canonicalValue.version}`,
        canonicalJson,
        digest,
      };
      return { ok: true, value: /** @type {AgentConfigurationSnapshot} */ (freezeDeep(snapshot)) };
    },
  });
}
