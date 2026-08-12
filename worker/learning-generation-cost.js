// @ts-check

/** @import { LearningCostModel, LearningProviderUsage } from "../src/features/learning-generation/contracts.js" */

/** @param {{ readonly inputUsdPerMillionTokens: number, readonly outputUsdPerMillionTokens: number }} configuration @returns {LearningCostModel} */
export function createLearningCostModel(configuration) {
  if (!isRate(configuration?.inputUsdPerMillionTokens) || !isRate(configuration.outputUsdPerMillionTokens)) throw new TypeError("Learning cost-model configuration is invalid.");
  const inputRate = configuration.inputUsdPerMillionTokens;
  const outputRate = configuration.outputUsdPerMillionTokens;
  return Object.freeze({
    /** @param {import("../src/features/learning-generation/contracts.js").LearningCostEstimateInput} input */
    estimate(input) {
      if (!Number.isInteger(input?.inputCharacters) || input.inputCharacters < 0 || !Number.isInteger(input.maximumOutputTokens) || input.maximumOutputTokens < 1) throw new TypeError("Learning cost estimate input is invalid.");
      return (input.inputCharacters / 4 * inputRate + input.maximumOutputTokens * outputRate) / 1_000_000;
    },
    /** @param {LearningProviderUsage} usage */
    actual(usage) {
      if (!validUsage(usage)) throw new TypeError("Learning provider usage is invalid.");
      return (usage.inputTokens * inputRate + usage.outputTokens * outputRate) / 1_000_000;
    },
  });
}

/** @param {unknown} value @returns {value is number} */
function isRate(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }
/** @param {unknown} value @returns {value is LearningProviderUsage} */
function validUsage(value) { if (typeof value !== "object" || value === null || Array.isArray(value) || !("inputTokens" in value) || !("outputTokens" in value)) return false; const usage = /** @type {{ readonly inputTokens: unknown, readonly outputTokens: unknown }} */ (value); return Number.isInteger(usage.inputTokens) && Number.isInteger(usage.outputTokens) && /** @type {number} */ (usage.inputTokens) >= 0 && /** @type {number} */ (usage.outputTokens) >= 0; }

export {};
