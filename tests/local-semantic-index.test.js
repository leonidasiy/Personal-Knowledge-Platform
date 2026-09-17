// @ts-check

import { createSemanticRanker, SEMANTIC_RANKER_PROMPT_VERSION } from "../worker/local-semantic-index.js";

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test("semantic ranker sends bounded public candidates and preserves model/prompt provenance", async () => {
  /** @type {unknown} */ let command;
  const ranker = createSemanticRanker({ model: { generate: async (value) => { command = value; return { ok: true, value: { output: { matches: [{ id: "knowledge-2", score: 0.8 }] } } }; } }, modelId: "configured-model", maximumCandidates: 2, maximumOutputTokens: 128 });
  const result = await ranker.rank({ query: "harmonic resolution", scope: "knowledge", limit: 1, candidates: [{ id: "knowledge-2", sourceId: "source-2", sourceRevision: 3, title: "Harmony", text: "A cadence resolves tension." }] });
  assert(result.ok, "Ranker should succeed.");
  if (!result.ok) throw new Error(result.error.kind);
  assert(result.value.matches[0].id === "knowledge-2", "Ranked id mismatch.");
  assert(result.value.modelId === "configured-model", "Model provenance mismatch.");
  assert(result.value.promptVersion === SEMANTIC_RANKER_PROMPT_VERSION, "Prompt provenance mismatch.");
  assert(typeof command === "object" && command !== null && /** @type {Record<string, unknown>} */ (command).role === "semantic-ranker", "Wrong model role.");
});

Deno.test("semantic ranker rejects provider matches outside its typed candidate boundary", async () => {
  const ranker = createSemanticRanker({ model: { generate: async () => ({ ok: true, value: { output: { matches: [{ id: "not-supplied", score: 1 }] } } }) }, modelId: "configured-model", maximumCandidates: 1, maximumOutputTokens: 128 });
  const result = await ranker.rank({ query: "harmony", scope: "sources", limit: 1, candidates: [{ id: "source-1", sourceId: "source-1", sourceRevision: 1, title: "Theory", text: "Harmony." }] });
  assert(!result.ok && result.error.kind === "SourceSemanticIndexUnavailable", "Unknown provider ids must be rejected.");
});

Deno.test("semantic ranker maps provider throws and malformed output to a named failure", async () => {
  const candidate = [{ id: "source-1", sourceId: "source-1", sourceRevision: 1, title: "Theory", text: "Harmony." }];
  for (const model of [{ generate: async () => Promise.reject(new TypeError("transport")) }, { generate: async () => ({ ok: /** @type {const} */ (true), value: { output: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (null)) } }) }]) {
    const result = await createSemanticRanker({ model, modelId: "configured-model", maximumCandidates: 1, maximumOutputTokens: 128 }).rank({ query: "harmony", scope: "sources", limit: 1, candidates: candidate });
    assert(!result.ok && result.error.kind === "SourceSemanticIndexUnavailable", "Provider boundary must fail closed.");
  }
});
