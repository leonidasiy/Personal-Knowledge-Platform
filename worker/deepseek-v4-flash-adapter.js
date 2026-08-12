// @ts-check

import {
  isNonEmptyText,
  isRecord,
} from "../src/features/learning-generation/contracts.js";

/** @import { LearningLogger, LearningProviderCommand, LearningProviderFailure, LearningProviderResult, Result } from "../src/features/learning-generation/contracts.js" */

export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_CHAT_COMPLETIONS_PATH = "/chat/completions";

/**
 * @typedef {{
 *   readonly apiKey: string | null,
 *   readonly endpoint: string,
 *   readonly model: string,
 *   readonly maximumInputCharacters: number,
 *   readonly maximumOutputTokens: number,
 *   readonly timeoutMs: number,
 *   readonly fetch: typeof fetch,
 *   readonly now: () => number,
 *   readonly logger: LearningLogger
 * }} DeepSeekDependencies
 */

/**
 * Create the provider adapter. The adapter owns transport and response
 * parsing; it does not decide whether a source is licensed or publishable.
 * @param {DeepSeekDependencies} dependencies
 */
export function createDeepSeekV4FlashAdapter(dependencies) {
  if (
    (dependencies.apiKey !== null && typeof dependencies.apiKey !== "string") ||
    !isNonEmptyText(dependencies.endpoint) ||
    !URL.canParse(dependencies.endpoint) ||
    new URL(dependencies.endpoint).protocol !== "https:" ||
    dependencies.model !== DEEPSEEK_V4_FLASH_MODEL ||
    !positiveInteger(dependencies.maximumInputCharacters) ||
    !positiveInteger(dependencies.maximumOutputTokens) ||
    !positiveInteger(dependencies.timeoutMs) ||
    typeof dependencies.fetch !== "function" ||
    typeof dependencies.now !== "function" ||
    typeof dependencies.logger !== "function"
  ) {
    throw new TypeError("DeepSeek V4 Flash adapter configuration is invalid.");
  }
  const endpoint = new URL(dependencies.endpoint).href;
  const apiKey = dependencies.apiKey;
  const maximumInputCharacters = dependencies.maximumInputCharacters;
  const maximumOutputTokens = dependencies.maximumOutputTokens;
  const timeoutMs = dependencies.timeoutMs;
  const request = dependencies.fetch;
  const now = dependencies.now;
  const logger = dependencies.logger;
  return Object.freeze({
    /** @param {unknown} input @returns {Promise<Result<LearningProviderResult, LearningProviderFailure>>} */
    async generate(input) {
      const startedAt = now();
      if (!Number.isFinite(startedAt)) throw new TypeError("DeepSeek adapter clock returned an invalid instant.");
      const command = validateCommand(input, maximumInputCharacters, maximumOutputTokens);
      if (!command.ok) return recordFailure(command.error, startedAt, now, logger);
      if (command.value.sourceKind === "manual-transcript") {
        return recordFailure({ kind: "LearningManualExternalProcessingProhibited" }, startedAt, now, logger);
      }
      if (apiKey === null || apiKey.trim() === "") {
        return recordFailure({ kind: "LearningProviderCredentialMissing" }, startedAt, now, logger);
      }
      logger({ event: "learning-provider-entry" });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await request(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: DEEPSEEK_V4_FLASH_MODEL,
            messages: [
              {
                role: "system",
                content: `${command.value.instruction}\nReturn a JSON object with a tasks array. Do not return prose outside JSON.`,
              },
              {
                role: "user",
                content: JSON.stringify({
                  excerpt: command.value.excerpt,
                  unitIds: command.value.unitIds,
                  sourceAnchorIds: command.value.sourceAnchorIds,
                }),
              },
            ],
            thinking: { type: "disabled" },
            response_format: { type: "json_object" },
            max_tokens: command.value.maximumOutputTokens,
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return recordFailure({ kind: "LearningProviderTimeout" }, startedAt, now, logger);
        }
        if (error instanceof TypeError) {
          return recordFailure({ kind: "LearningProviderUnavailable" }, startedAt, now, logger);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 429) {
        return recordFailure({ kind: "LearningProviderRateLimited" }, startedAt, now, logger);
      }
      if (!response.ok) {
        return recordFailure({ kind: "LearningProviderRejected", status: response.status }, startedAt, now, logger);
      }
      let document;
      try {
        document = /** @type {unknown} */ (await response.json());
      } catch (error) {
        if (error instanceof SyntaxError) {
          return recordFailure({ kind: "LearningProviderResponseInvalid", field: "body" }, startedAt, now, logger);
        }
        throw error;
      }
      const parsed = parseResponse(document);
      if (!parsed.ok) return recordFailure(parsed.error, startedAt, now, logger);
      const durationMs = now() - startedAt;
      if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError("DeepSeek adapter duration is invalid.");
      logger({ event: "learning-provider-success", durationMs });
      return { ok: true, value: parsed.value };
    },
  });
}

/** @param {unknown} value @param {number} maximumInputCharacters @param {number} maximumOutputTokens @returns {Result<LearningProviderCommand, LearningProviderFailure>} */
function validateCommand(value, maximumInputCharacters, maximumOutputTokens) {
  if (!isRecord(value)) return invalidInput("command");
  if (value.sourceKind !== "public-text" && value.sourceKind !== "manual-transcript") return invalidInput("sourceKind");
  if (!isNonEmptyText(value.excerpt) || value.excerpt.length > maximumInputCharacters) return invalidInput("excerpt");
  if (!isNonEmptyText(value.instruction)) return invalidInput("instruction");
  if (!Array.isArray(value.unitIds) || value.unitIds.length === 0 || value.unitIds.some((id) => !isNonEmptyText(id))) return invalidInput("unitIds");
  if (!Array.isArray(value.sourceAnchorIds) || value.sourceAnchorIds.length === 0 || value.sourceAnchorIds.some((id) => !isNonEmptyText(id))) return invalidInput("sourceAnchorIds");
  const checked = /** @type {{ readonly sourceKind: "public-text" | "manual-transcript", readonly excerpt: string, readonly unitIds: string[], readonly sourceAnchorIds: string[], readonly instruction: string, readonly maximumOutputTokens: number }} */ (value);
  if (!positiveInteger(checked.maximumOutputTokens) || checked.maximumOutputTokens > maximumOutputTokens) return invalidInput("maximumOutputTokens");
  return {
    ok: true,
    value: Object.freeze(/** @type {LearningProviderCommand} */ ({
      sourceKind: checked.sourceKind,
      excerpt: checked.excerpt,
      unitIds: Object.freeze(/** @type {[string, ...string[]]} */ ([...checked.unitIds])),
      sourceAnchorIds: Object.freeze(/** @type {[string, ...string[]]} */ ([...checked.sourceAnchorIds])),
      instruction: checked.instruction,
      maximumOutputTokens: checked.maximumOutputTokens,
    })),
  };
}

/** @param {unknown} value @returns {Result<LearningProviderResult, LearningProviderFailure>} */
function parseResponse(value) {
  if (!isRecord(value) || !isNonEmptyText(value.id) || !Array.isArray(value.choices) || value.choices.length < 1 || !isRecord(value.choices[0])) {
    return invalidResponse("choices");
  }
  const choice = value.choices[0];
  if (choice.finish_reason !== "stop") return invalidResponse("finish_reason");
  if (!isRecord(choice.message) || !isNonEmptyText(choice.message.content)) return invalidResponse("message.content");
  let content;
  try {
    content = JSON.parse(choice.message.content);
  } catch (error) {
    if (error instanceof SyntaxError) return invalidResponse("message.content.json");
    throw error;
  }
  if (!isRecord(content) || !Array.isArray(content.tasks)) return invalidResponse("tasks");
  if (!isRecord(value.usage) || !nonNegativeInteger(value.usage.prompt_tokens) || !nonNegativeInteger(value.usage.completion_tokens) || !nonNegativeInteger(value.usage.total_tokens)) {
    return invalidResponse("usage");
  }
  const usage = /** @type {{ readonly prompt_tokens: number, readonly completion_tokens: number, readonly total_tokens: number }} */ (value.usage);
  const tasks = /** @type {unknown[]} */ (content.tasks);
  if (usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens) return invalidResponse("usage.total_tokens");
  return {
    ok: true,
    value: Object.freeze({
      drafts: Object.freeze([...tasks]),
      usage: Object.freeze({ inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }),
      requestId: value.id,
    }),
  };
}

/** @param {LearningProviderFailure} failure @param {number} startedAt @param {() => number} now @param {LearningLogger} logger @returns {Result<never, LearningProviderFailure>} */
function recordFailure(failure, startedAt, now, logger) {
  const durationMs = now() - startedAt;
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError("DeepSeek adapter failure duration is invalid.");
  logger({ event: "learning-provider-failure", failureKind: failure.kind, durationMs });
  return { ok: false, error: failure };
}

/** @param {string} field @returns {Result<never, LearningProviderFailure>} */
function invalidInput(field) {
  return { ok: false, error: { kind: "LearningProviderInputInvalid", field } };
}

/** @param {string} field @returns {Result<never, LearningProviderFailure>} */
function invalidResponse(field) {
  return { ok: false, error: { kind: "LearningProviderResponseInvalid", field } };
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @param {unknown} value */
function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export {};
