// @ts-check

import { isNonEmptyText } from "../src/features/source-library/contracts.js";

/** @import { Result } from "../src/features/source-library/contracts.js" */

export const LOCAL_SEMANTIC_MODEL_ID = "local-feature-hash";
export const LOCAL_SEMANTIC_MODEL_VERSION = "v1";
export const LOCAL_SEMANTIC_DIMENSIONS = 64;

/** @typedef {{ readonly kind: "SourceEmbeddingUnavailable" }} LocalSemanticFailure */

/**
 * Build a deterministic feature-hash vector from bounded source metadata.
 * This intentionally stays local and model-free; it is approximate semantic
 * similarity, not a claim of pretrained language understanding.
 *
 * @param {string} text
 * @returns {Promise<Result<{ readonly vector: readonly number[], readonly modelId: string, readonly modelVersion: string, readonly dimensions: number }, LocalSemanticFailure>>}
 */
export async function createLocalSemanticEmbedding(text) {
  if (!isNonEmptyText(text) || text.length > 20_000) {
    return { ok: false, error: { kind: "SourceEmbeddingUnavailable" } };
  }
  const vector = vectorize(text);
  return {
    ok: true,
    value: Object.freeze({
      vector: Object.freeze(vector),
      modelId: LOCAL_SEMANTIC_MODEL_ID,
      modelVersion: LOCAL_SEMANTIC_MODEL_VERSION,
      dimensions: LOCAL_SEMANTIC_DIMENSIONS,
    }),
  };
}
/** @param {string} text @returns {readonly number[]} */
export function vectorize(text) {
  const vector = new Array(LOCAL_SEMANTIC_DIMENSIONS).fill(0);
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    addFeature(vector, token, 1);
    const padded = `^${token}$`;
    for (let index = 0; index + 3 <= padded.length; index++) {
      addFeature(vector, padded.slice(index, index + 3), 0.5);
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? Object.freeze(vector) : Object.freeze(vector.map((value) => value / norm));
}

/** @param {number[]} vector @param {string} feature @param {number} weight */
function addFeature(vector, feature, weight) {
  const hash = hashFeature(feature);
  const bucket = hash % LOCAL_SEMANTIC_DIMENSIONS;
  const sign = (hash & 1) === 0 ? 1 : -1;
  vector[bucket] += sign * weight;
}

/** @param {string} value @returns {number} */
function hashFeature(value) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** @param {readonly number[]} left @param {readonly number[]} right @returns {number | null} */
export function cosineSimilarity(left, right) {
  if (
    left.length !== right.length || left.length === 0 ||
    left.some((value) => !Number.isFinite(value)) ||
    right.some((value) => !Number.isFinite(value))
  ) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index];
    const rightValue = right[index];
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}
