// @ts-check

import {
  LOCAL_SEMANTIC_DIMENSIONS,
  LOCAL_SEMANTIC_MODEL_ID,
  LOCAL_SEMANTIC_MODEL_VERSION,
  createLocalSemanticEmbedding,
  cosineSimilarity,
} from "../worker/local-semantic-index.js";

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test("local semantic embeddings are versioned, bounded, and finite", async () => {
  const result = await createLocalSemanticEmbedding("Harmonic motion");
  assert(result.ok, "Embedding should succeed.");
  if (!result.ok) throw new Error(result.error.kind);
  assert(result.value.modelId === LOCAL_SEMANTIC_MODEL_ID, "Model id mismatch.");
  assert(result.value.modelVersion === LOCAL_SEMANTIC_MODEL_VERSION, "Model version mismatch.");
  assert(result.value.dimensions === LOCAL_SEMANTIC_DIMENSIONS, "Dimension mismatch.");
  assert(result.value.vector.length === LOCAL_SEMANTIC_DIMENSIONS, "Vector length mismatch.");
  assert(result.value.vector.every(Number.isFinite), "Vector must be finite.");
});

Deno.test("local semantic cosine ranking rewards related morphology and rejects invalid vectors", async () => {
  const harmonic = await createLocalSemanticEmbedding("harmonic");
  const harmony = await createLocalSemanticEmbedding("harmony");
  if (!harmonic.ok || !harmony.ok) throw new Error("Expected embeddings.");
  const score = cosineSimilarity(harmonic.value.vector, harmony.value.vector);
  assert(score !== null && score > 0, "Related terms should score.");
  assert(cosineSimilarity(harmonic.value.vector, [1]) === null, "Wrong dimensions must fail explicitly.");
});
