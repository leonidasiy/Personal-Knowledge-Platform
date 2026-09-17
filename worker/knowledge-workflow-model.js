// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {"rights-assessor" | "knowledge-scraper" | "question-generator" | "question-evaluator"} KnowledgeAgentRole */
/** @typedef {KnowledgeAgentRole | "semantic-ranker"} KnowledgeModelRole */
/** @typedef {{ readonly id: string, readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif", readonly bytes?: Uint8Array, readonly url?: string }} KnowledgeModelAttachment */
/** @typedef {{ readonly name: string, readonly schema: Record<string, unknown> }} KnowledgeResponseSchema */
/** @typedef {{ readonly role: KnowledgeAgentRole, readonly systemPrompt: string, readonly input: unknown, readonly maxOutputTokens: number, readonly timeoutMs?: number, readonly attachments?: readonly KnowledgeModelAttachment[], readonly responseSchema?: KnowledgeResponseSchema, readonly reasoningEffort?: "low", readonly providerSort?: "throughput" }} KnowledgeModelCommand */
/** @typedef {{ readonly role: KnowledgeModelRole, readonly systemPrompt: string, readonly input: unknown, readonly maxOutputTokens: number, readonly timeoutMs?: number, readonly attachments?: readonly KnowledgeModelAttachment[], readonly responseSchema?: KnowledgeResponseSchema, readonly reasoningEffort?: "low", readonly providerSort?: "throughput" }} KnowledgeModelTransportCommand */
/** @typedef {{ readonly output: Record<string, unknown>, readonly requestId: string, readonly inputTokens: number | null, readonly outputTokens: number | null, readonly reasoningTrace: { readonly provider: string, readonly fields: readonly unknown[] } | null }} KnowledgeModelResult */
/** @typedef {{ readonly kind: "KnowledgeModelCommandInvalid", readonly field: string } | { readonly kind: "KnowledgeModelCredentialMissing" } | { readonly kind: "KnowledgeModelTimeout" } | { readonly kind: "KnowledgeModelUnavailable" } | { readonly kind: "KnowledgeModelRejected", readonly status: number } | { readonly kind: "KnowledgeModelResponseInvalid", readonly field: string }} KnowledgeModelFailure */
/** @typedef {{ readonly apiKey: string | null, readonly endpoint: string, readonly model: string, readonly timeoutMs: number, readonly maximumInputCharacters: number, readonly fetch: typeof fetch, readonly now: () => number, readonly logger: (entry: { readonly event: string, readonly role?: KnowledgeModelRole, readonly failureKind?: string, readonly diagnosticToken?: string, readonly durationMs?: number, readonly requestId?: string, readonly inputTokens?: number | null, readonly outputTokens?: number | null }) => void }} KnowledgeModelDependencies */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value @returns {value is number} */
function nonNegativeInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
const MAXIMUM_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAXIMUM_ATTACHMENT_TOTAL_BYTES = 32 * 1024 * 1024;
/** @param {unknown} value @returns {value is KnowledgeModelAttachment} */
function validAttachment(value) {
  if (!record(value) || !text(value.id) || typeof value.mediaType !== "string" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(value.mediaType)) return false;
  const bytes = value.bytes;
  const url = value.url;
  const hasBytes = bytes instanceof Uint8Array;
  const hasUrl = typeof url === "string";
  if (hasBytes === hasUrl || hasBytes && (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_ATTACHMENT_BYTES) || hasUrl && (!URL.canParse(url) || new URL(url).protocol !== "https:" || new URL(url).username !== "" || new URL(url).password !== "")) return false;
  return true;
}
/** @param {Uint8Array} bytes @returns {string} */
function base64(bytes) { const chunks = []; for (let index = 0; index < bytes.byteLength; index += 32_768) chunks.push(String.fromCharCode(...bytes.subarray(index, Math.min(index + 32_768, bytes.byteLength)))); return btoa(chunks.join("")); }
/** @param {readonly KnowledgeModelAttachment[]} attachments @returns {{ readonly type: "image_url", readonly image_url: { readonly url: string } }[]} */
function imageBlocks(attachments) {
  return attachments.map((attachment) => ({ type: "image_url", image_url: { url: attachment.bytes instanceof Uint8Array ? `data:${attachment.mediaType};base64,${base64(attachment.bytes)}` : /** @type {string} */ (attachment.url) } }));
}
/** @param {KnowledgeModelFailure} failure @param {KnowledgeModelDependencies} dependencies @param {KnowledgeModelRole | undefined} role @param {number} startedAt @param {string | undefined} [diagnosticToken] @returns {Result<never, KnowledgeModelFailure>} */
function fail(failure, dependencies, role, startedAt, diagnosticToken = undefined) {
  const durationMs = dependencies.now() - startedAt;
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError("Knowledge model clock returned an invalid duration.");
  dependencies.logger({ event: "knowledge-model-failure", role, failureKind: failure.kind, ...(diagnosticToken === undefined ? {} : { diagnosticToken }), durationMs });
  return { ok: false, error: failure };
}

/** @param {unknown} error @returns {string} */
function transportDiagnostic(error) {
  if (!(error instanceof Error)) return "unknown-error";
  const message = error.message.toLowerCase();
  if (message.includes("dns") || message.includes("name resolution")) return "dns";
  if (message.includes("tls") || message.includes("certificate")) return "tls";
  if (message.includes("connect") || message.includes("socket")) return "connect";
  if (message.includes("fetch")) return "fetch";
  return error.name === "TypeError" ? "type-error" : "unknown-error";
}

/** @param {KnowledgeModelDependencies} dependencies */
export function createOpenRouterKnowledgeModel(dependencies) {
  if ((dependencies?.apiKey !== null && typeof dependencies?.apiKey !== "string") || !text(dependencies?.endpoint) || !URL.canParse(dependencies.endpoint) || new URL(dependencies.endpoint).protocol !== "https:" || !text(dependencies.model) || !positiveInteger(dependencies.timeoutMs) || !positiveInteger(dependencies.maximumInputCharacters) || typeof dependencies.fetch !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") throw new TypeError("Knowledge model dependencies are invalid.");
  const endpoint = new URL(dependencies.endpoint).href;
  const apiKey = dependencies.apiKey;
  return Object.freeze({
    /** @param {unknown} input @returns {Promise<Result<KnowledgeModelResult, KnowledgeModelFailure>>} */
    async generate(input) {
      const startedAt = dependencies.now();
      if (!Number.isFinite(startedAt)) throw new TypeError("Knowledge model clock returned an invalid instant.");
      if (!record(input) || !text(input.role) || !["rights-assessor", "knowledge-scraper", "question-generator", "question-evaluator", "semantic-ranker"].includes(input.role) || !text(input.systemPrompt) || !positiveInteger(input.maxOutputTokens) || (input.timeoutMs !== undefined && !positiveInteger(input.timeoutMs)) || (input.responseSchema !== undefined && (!record(input.responseSchema) || !text(input.responseSchema.name) || !record(input.responseSchema.schema))) || (input.reasoningEffort !== undefined && input.reasoningEffort !== "low") || (input.providerSort !== undefined && input.providerSort !== "throughput") || (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 8 || !input.attachments.every(validAttachment) || input.attachments.reduce((total, attachment) => total + (attachment.bytes instanceof Uint8Array ? attachment.bytes.byteLength : 0), 0) > MAXIMUM_ATTACHMENT_TOTAL_BYTES))) return fail({ kind: "KnowledgeModelCommandInvalid", field: "command" }, dependencies, undefined, startedAt);
      let serializedInput;
      try { serializedInput = JSON.stringify(input.input); } catch (error) { return fail({ kind: "KnowledgeModelCommandInvalid", field: "input" }, dependencies, /** @type {KnowledgeModelRole} */ (input.role), startedAt); }
      if (!text(serializedInput) || serializedInput.length > dependencies.maximumInputCharacters) return fail({ kind: "KnowledgeModelCommandInvalid", field: "input" }, dependencies, /** @type {KnowledgeModelRole} */ (input.role), startedAt);
      if (apiKey === null || apiKey.trim() === "") return fail({ kind: "KnowledgeModelCredentialMissing" }, dependencies, /** @type {KnowledgeModelRole} */ (input.role), startedAt);
      const command = /** @type {KnowledgeModelTransportCommand} */ (input);
      dependencies.logger({ event: "knowledge-model-entry", role: command.role });
      const controller = new AbortController();
      const timeoutMs = command.timeoutMs ?? dependencies.timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      let responseReceived = false;
      let document;
      try {
        response = await dependencies.fetch(endpoint, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: dependencies.model, messages: [{ role: "system", content: `${command.systemPrompt}\nReturn only one JSON object. Do not include prose outside JSON.` }, { role: "user", content: command.attachments === undefined ? `<task_input>\n${serializedInput}\n</task_input>` : [{ type: "text", text: `<task_input>\n${serializedInput}\n</task_input>` }, ...imageBlocks(command.attachments)] }], response_format: command.responseSchema === undefined ? { type: "json_object" } : { type: "json_schema", json_schema: { name: command.responseSchema.name, strict: true, schema: command.responseSchema.schema } }, ...(command.responseSchema === undefined ? {} : { provider: { sort: command.providerSort ?? "throughput", require_parameters: true } }), ...(command.reasoningEffort === undefined ? {} : { reasoning: { effort: command.reasoningEffort } }), max_tokens: command.maxOutputTokens, stream: false }),
          signal: controller.signal,
        });
        responseReceived = true;
        if (response.status === 429) return fail({ kind: "KnowledgeModelRejected", status: response.status }, dependencies, command.role, startedAt);
        if (!response.ok) return fail({ kind: "KnowledgeModelRejected", status: response.status }, dependencies, command.role, startedAt);
        document = /** @type {unknown} */ (await response.json());
      } catch (error) {
        if (controller.signal.aborted) return fail({ kind: "KnowledgeModelTimeout" }, dependencies, command.role, startedAt);
        if (!responseReceived && error instanceof TypeError) return fail({ kind: "KnowledgeModelUnavailable" }, dependencies, command.role, startedAt, transportDiagnostic(error));
        if (responseReceived && error instanceof SyntaxError) return fail({ kind: "KnowledgeModelResponseInvalid", field: "body" }, dependencies, command.role, startedAt);
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (!record(document) || !text(document.id) || !Array.isArray(document.choices) || document.choices.length < 1 || !record(document.choices[0])) return fail({ kind: "KnowledgeModelResponseInvalid", field: "choices" }, dependencies, command.role, startedAt, "choices-shape");
      const choice = document.choices[0];
      if (choice.finish_reason !== "stop") return fail({ kind: "KnowledgeModelResponseInvalid", field: "finish_reason" }, dependencies, command.role, startedAt, "finish-reason");
      if (!record(choice.message) || !text(choice.message.content)) return fail({ kind: "KnowledgeModelResponseInvalid", field: "message.content" }, dependencies, command.role, startedAt, "message-content-empty");
      let output;
      try { output = JSON.parse(choice.message.content); } catch (error) {
        if (error instanceof SyntaxError) return fail({ kind: "KnowledgeModelResponseInvalid", field: "message.content.json" }, dependencies, command.role, startedAt, "message-content-json");
        throw error;
      }
      if (!record(output)) return fail({ kind: "KnowledgeModelResponseInvalid", field: "output" }, dependencies, command.role, startedAt, "output-shape");
      const usage = record(document.usage) && (document.usage.prompt_tokens === undefined || nonNegativeInteger(document.usage.prompt_tokens)) && (document.usage.completion_tokens === undefined || nonNegativeInteger(document.usage.completion_tokens))
        ? { inputTokens: document.usage.prompt_tokens === undefined ? null : document.usage.prompt_tokens, outputTokens: document.usage.completion_tokens === undefined ? null : document.usage.completion_tokens }
        : { inputTokens: null, outputTokens: null };
      const result = Object.freeze({ output, requestId: document.id, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, reasoningTrace: null });
      const durationMs = dependencies.now() - startedAt;
      if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError("Knowledge model duration is invalid.");
      dependencies.logger({ event: "knowledge-model-success", role: command.role, durationMs, requestId: result.requestId, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      return { ok: true, value: result };
    },
  });
}

export {};
