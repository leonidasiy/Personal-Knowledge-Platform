// @ts-check

import { isNonEmptyText, isRecord } from "../src/features/source-library/contracts.js";

/** @import { Result, SourceLibraryFailure } from "../src/features/source-library/contracts.js" */

export const SEMANTIC_RANKER_PROMPT_VERSION = "source-semantic-ranker-v2";

/** @typedef {{ readonly id: string, readonly sourceId: string, readonly sourceRevision: number, readonly title: string, readonly text: string }} SemanticCandidate */
// Dedicated model identifier: https://openrouter.ai/cohere/rerank-4-fast
const MODEL_ID = "cohere/rerank-4-fast";
/** @typedef {{ readonly endpoint?: string, readonly model?: string, readonly apiKey: string | null, readonly fetch: typeof fetch, readonly maximumCandidates: number, readonly timeoutMs: number, readonly logger: (entry: { readonly event: string, readonly candidateCount?: number, readonly failureReason?: string }) => void }} SemanticRankerDependencies */

/** @param {SemanticRankerDependencies} dependencies */
export function createSemanticRanker(dependencies) {
  const endpoint = dependencies.endpoint ?? "https://openrouter.ai/api/v1/rerank";
  const model = dependencies.model ?? MODEL_ID;
  if (!URL.canParse(endpoint) || new URL(endpoint).protocol !== "https:" || !isNonEmptyText(model)) throw new TypeError("Semantic ranker endpoint/model invalid.");
  if ((dependencies?.apiKey !== null && !isNonEmptyText(dependencies?.apiKey)) || typeof dependencies.fetch !== "function" || !positiveInteger(dependencies.maximumCandidates) || dependencies.maximumCandidates > 20 || !positiveInteger(dependencies.timeoutMs) || dependencies.timeoutMs > 3000 || typeof dependencies.logger !== "function") throw new TypeError("Semantic ranker dependencies are invalid.");
  return Object.freeze({
    /** @param {unknown} input @returns {Promise<Result<{ readonly matches: readonly { readonly id: string, readonly score: number }[], readonly modelId: string, readonly promptVersion: string }, SourceLibraryFailure>>} */
    async rank(input) {
      dependencies.logger({ event: "semantic-ranker.started" });
      const command = validateCommand(input, dependencies.maximumCandidates);
      if (!command.ok) {
        dependencies.logger({ event: "semantic-ranker.failed", failureReason: "InvalidCommand" });
        return command;
      }
      if (command.value.signal?.aborted) {
        dependencies.logger({ event: "semantic-ranker.failed", failureReason: "TimedOut" });
        return unavailable("TimedOut");
      }
      if (command.value.candidates.length === 0) {
        dependencies.logger({ event: "semantic-ranker.succeeded", candidateCount: 0 });
        return { ok: true, value: Object.freeze({ matches: Object.freeze([]), modelId: model, promptVersion: SEMANTIC_RANKER_PROMPT_VERSION }) };
      }
      if (dependencies.apiKey === null) {
        dependencies.logger({ event: "semantic-ranker.failed", failureReason: "NotConfigured" });
        return unavailable("NotConfigured");
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      command.value.signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs);
      try {
        const response = await dependencies.fetch(endpoint, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${dependencies.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, query: command.value.query, documents: command.value.candidates.map((candidate) => `${candidate.title}\n${candidate.text}`), top_n: Math.min(command.value.limit, command.value.candidates.length) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          dependencies.logger({ event: "semantic-ranker.failed", failureReason: "ProviderRejected" });
          return unavailable("ProviderRejected");
        }
        let output;
        try { output = await readBoundedResponse(response); }
        catch (error) {
          const reason = controller.signal.aborted ? "TimedOut" : "InvalidResponse";
          dependencies.logger({ event: "semantic-ranker.failed", failureReason: reason });
          return unavailable(reason);
        }
        const matches = validateMatches(output, command.value);
        if (!matches.ok) {
          dependencies.logger({ event: "semantic-ranker.failed", failureReason: "InvalidResponse" });
          return matches;
        }
        dependencies.logger({ event: "semantic-ranker.succeeded", candidateCount: command.value.candidates.length });
        return { ok: true, value: Object.freeze({ matches: matches.value, modelId: model, promptVersion: SEMANTIC_RANKER_PROMPT_VERSION }) };
      } catch (error) {
        const reason = controller.signal.aborted ? "TimedOut" : "TransportFailed";
        dependencies.logger({ event: "semantic-ranker.failed", failureReason: reason });
        return unavailable(reason);
      } finally { clearTimeout(timeout); command.value.signal?.removeEventListener("abort", cancel); }
    },
  });
}

/** @param {unknown} input @param {number} maximumCandidates @returns {Result<{ readonly signal?: AbortSignal, readonly query: string, readonly scope: "sources" | "knowledge", readonly limit: number, readonly candidates: readonly SemanticCandidate[] }, SourceLibraryFailure>} */
function validateCommand(input, maximumCandidates) {
  if (!isRecord(input) || !isNonEmptyText(input.query) || (input.scope !== "sources" && input.scope !== "knowledge") || !positiveInteger(input.limit) || !Array.isArray(input.candidates) || input.candidates.length > maximumCandidates) return unavailable("InvalidCommand");
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) return unavailable("InvalidCommand");
  const candidates = input.candidates;
  if (candidates.some((candidate) => !validCandidate(candidate)) || input.query.length + candidates.reduce((sum, candidate) => sum + candidate.title.length + candidate.text.length + 1, 0) > 12000 || new Set(candidates.map((candidate) => candidate.id.trim())).size !== candidates.length) return unavailable("InvalidCommand");
  const checked = /** @type {{ readonly signal?: AbortSignal, readonly query: string, readonly scope: "sources" | "knowledge", readonly limit: number, readonly candidates: readonly SemanticCandidate[] }} */ (input);
  return { ok: true, value: Object.freeze({ signal: checked.signal, query: checked.query.trim(), scope: checked.scope, limit: checked.limit, candidates: Object.freeze(checked.candidates.map((candidate) => Object.freeze({ id: candidate.id.trim(), sourceId: candidate.sourceId.trim(), sourceRevision: candidate.sourceRevision, title: candidate.title.trim(), text: candidate.text.trim() }))) }) };
}

/** @param {unknown} value @returns {value is SemanticCandidate} */
function validCandidate(value) { if (!isRecord(value)) return false; const candidate = /** @type {Record<string, unknown>} */ (value); return isNonEmptyText(candidate.id) && isNonEmptyText(candidate.sourceId) && Number.isSafeInteger(candidate.sourceRevision) && /** @type {number} */ (candidate.sourceRevision) >= 1 && isNonEmptyText(candidate.title) && isNonEmptyText(candidate.text); }
/** @param {unknown} output @param {{ readonly limit: number, readonly candidates: readonly SemanticCandidate[] }} command @returns {Result<readonly { readonly id: string, readonly score: number }[], SourceLibraryFailure>} */
function validateMatches(output, command) {
  if (!isRecord(output) || !Array.isArray(output.results) || output.results.length !== Math.min(command.limit, command.candidates.length)) return unavailable("InvalidResponse");
  const matches = output.results;
  if (matches.some((match) => !isRecord(match) || typeof match.index !== "number" || !Number.isSafeInteger(match.index) || match.index < 0 || match.index >= command.candidates.length || typeof match.relevance_score !== "number" || !Number.isFinite(match.relevance_score) || match.relevance_score < 0 || match.relevance_score > 1) || new Set(matches.map((match) => match.index)).size !== matches.length) return unavailable("InvalidResponse");
  return { ok: true, value: Object.freeze(matches.map((match) => Object.freeze({ id: command.candidates[match.index].id, score: match.relevance_score })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))) };
}
/** @param {"NotConfigured" | "InvalidCommand" | "InvalidResponse" | "ProviderRejected" | "TransportFailed" | "TimedOut"} reason @returns {Result<never, Extract<SourceLibraryFailure, { readonly kind: "SourceSemanticIndexUnavailable" }>>} */
function unavailable(reason) { return { ok: false, error: { kind: "SourceSemanticIndexUnavailable", reason } }; }
/** @param {unknown} value */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

/** @param {Response} response @returns {Promise<unknown>} */
async function readBoundedResponse(response) {
  if (!response.body) throw new TypeError("Reranker response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new RangeError("Reranker response exceeds its byte limit.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
