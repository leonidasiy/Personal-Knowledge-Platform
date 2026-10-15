// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {{ readonly id: string, readonly response: string, readonly canonicalAnswers: readonly string[] }} JevAnswer */
/** @typedef {{ readonly prompt: string, readonly answers: readonly JevAnswer[] }} JevGradeCommand */
/** @typedef {{ readonly kind: "JevCommandInvalid" | "JevCredentialMissing" | "JevTimeout" | "JevRateLimited" | "JevProviderUnavailable" | "JevProviderRejected" | "JevResponseInvalid" }} JevFailure */

/** @typedef {{ readonly requestedModel: string, readonly servedModel: string | null, readonly endpoint: string, readonly acceptanceThreshold: number, readonly evidence: string }} JevGraderConfiguration */
/** @type {JevGraderConfiguration} */
export const JEV_GRADER_CONFIGURATION = Object.freeze({
  requestedModel: "~typesafe/jev-latest",
  servedModel: null,
  endpoint: "https://openrouter.ai/api/alpha/decisions",
  acceptanceThreshold: 0.7,
  evidence: "https://openrouter.ai/docs/guides/community/jev-tutorial",
});
const MAXIMUM_ANSWERS = 4;
const MAXIMUM_FIELD_CHARACTERS = 2_000;

/** @param {unknown} value @returns {value is JevGraderConfiguration} */
function validConfiguration(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  const expected = ["requestedModel", "servedModel", "endpoint", "acceptanceThreshold", "evidence"];
  if (Object.keys(candidate).length !== expected.length || expected.some((key) => !Object.hasOwn(candidate, key))) return false;
  if (typeof candidate.requestedModel !== "string" || candidate.requestedModel.trim() === "" || (candidate.requestedModel === "~typesafe/jev-latest" ? candidate.servedModel !== null : typeof candidate.servedModel !== "string" || candidate.servedModel.trim() === "") || typeof candidate.evidence !== "string" || candidate.evidence.trim() === "" || typeof candidate.acceptanceThreshold !== "number" || !Number.isFinite(candidate.acceptanceThreshold) || candidate.acceptanceThreshold < 0 || candidate.acceptanceThreshold > 1) return false;
  if (typeof candidate.endpoint !== "string") return false;
  try {
    const endpoint = new URL(candidate.endpoint);
    return endpoint.protocol === "https:" && endpoint.hostname === "openrouter.ai" && endpoint.pathname === "/api/alpha/decisions" && endpoint.search === "" && endpoint.hash === "";
  } catch { return false; }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is JevGradeCommand} */
function validCommand(value) {
  if (!record(value) || !text(value.prompt) || value.prompt.length > MAXIMUM_FIELD_CHARACTERS || !Array.isArray(value.answers) || value.answers.length < 1 || value.answers.length > MAXIMUM_ANSWERS) return false;
  return value.answers.every((answer) => record(answer) && text(answer.id) && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(answer.id) && text(answer.response) && answer.response.length <= MAXIMUM_FIELD_CHARACTERS && Array.isArray(answer.canonicalAnswers) && answer.canonicalAnswers.length > 0 && answer.canonicalAnswers.length <= 4 && answer.canonicalAnswers.every((canonical) => text(canonical) && canonical.length <= MAXIMUM_FIELD_CHARACTERS)) && new Set(value.answers.map((answer) => answer.id)).size === value.answers.length;
}

/** @param {unknown} value @param {readonly string[]} expectedIds @param {string | null} expectedModel @returns {{ readonly model: string, readonly probabilities: readonly number[] } | null} */
function parseDecision(value, expectedIds, expectedModel) {
  if (!record(value) || !text(value.model) || !record(value.answers)) return null;
  // The latest alias resolves to a versioned Jev model; pinned callers retain exact matching.
  if (expectedModel === null ? !/^typesafe\/jev-\d+(?:\.\d+)*(?:-\d{8})?$/u.test(value.model) : value.model !== expectedModel) return null;
  const answerMap = value.answers;
  if (Object.keys(answerMap).length !== expectedIds.length || expectedIds.some((id) => !(id in answerMap))) return null;
  const probabilities = [];
  for (const id of expectedIds) {
    const answer = answerMap[id];
    if (!record(answer) || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1 || Object.keys(answer).length !== 2) return null;
    probabilities.push(answer.noul);
  }
  return Object.freeze({ model: value.model, probabilities: Object.freeze(probabilities) });
}

/** @param {string} source @returns {boolean} */
function hasDuplicateJsonKeys(source) {
  let index = 0;
  /** @returns {void} */
  function whitespace() { while (/\s/u.test(source[index] ?? "")) index += 1; }
  /** @returns {string} */
  function stringToken() {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') return /** @type {string} */ (JSON.parse(source.slice(start, index)));
    }
    throw new SyntaxError("Unterminated JSON string.");
  }
  /** @returns {boolean} */
  function value() {
    whitespace();
    if (source[index] === '"') { stringToken(); return false; }
    if (source[index] === "{") {
      index += 1;
      whitespace();
      const keys = new Set();
      if (source[index] === "}") { index += 1; return false; }
      while (index < source.length) {
        whitespace();
        if (source[index] !== '"') throw new SyntaxError("Expected JSON object key.");
        const key = stringToken();
        const duplicate = keys.has(key);
        keys.add(key);
        whitespace();
        if (source[index] !== ":") throw new SyntaxError("Expected JSON object colon.");
        index += 1;
        const nestedDuplicate = value();
        if (duplicate || nestedDuplicate) return true;
        whitespace();
        if (source[index] === "}") { index += 1; return false; }
        if (source[index] !== ",") throw new SyntaxError("Expected JSON object separator.");
        index += 1;
      }
      throw new SyntaxError("Unterminated JSON object.");
    }
    if (source[index] === "[") {
      index += 1;
      whitespace();
      if (source[index] === "]") { index += 1; return false; }
      while (index < source.length) {
        if (value()) return true;
        whitespace();
        if (source[index] === "]") { index += 1; return false; }
        if (source[index] !== ",") throw new SyntaxError("Expected JSON array separator.");
        index += 1;
      }
      throw new SyntaxError("Unterminated JSON array.");
    }
    const start = index;
    while (index < source.length && !/[\s,\]}]/u.test(source[index])) index += 1;
    if (index === start) throw new SyntaxError("Expected JSON value.");
    return false;
  }
  return value();
}

/**
 * Create a bounded OpenRouter Decisions API adapter. It returns only typed
 * outcomes and never includes request/response content in logs.
 * @param {{ readonly apiKey: string | null, readonly configuration: JevGraderConfiguration, readonly fetch: typeof fetch, readonly timeoutMs: number, readonly logger: (entry: { readonly event: string, readonly failureKind?: JevFailure["kind"] }) => void }} dependencies
 */
export function createJevAnswerGrader(dependencies) {
  if ((dependencies?.apiKey !== null && typeof dependencies?.apiKey !== "string") || !validConfiguration(dependencies?.configuration) || typeof dependencies?.fetch !== "function" || !Number.isSafeInteger(dependencies?.timeoutMs) || dependencies.timeoutMs < 1 || typeof dependencies?.logger !== "function") throw new TypeError("Jev grader dependencies are invalid.");
  const { apiKey, fetch: request, timeoutMs, logger } = dependencies;
  const configuration = Object.freeze({ ...dependencies.configuration });
  return Object.freeze({
    /** @param {unknown} input @returns {Promise<Result<{ readonly accepted: readonly boolean[], readonly probabilities: readonly number[], readonly model: string }, JevFailure>>} */
    async grade(input) {
      if (!validCommand(input)) return failure(logger, "JevCommandInvalid");
      if (apiKey === null || apiKey.trim() === "") return failure(logger, "JevCredentialMissing");
      const answers = input.answers;
      const state = Object.freeze({ prompt: input.prompt, answers: Object.freeze(answers.map((answer) => Object.freeze({ id: answer.id, response: answer.response, canonicalAnswers: Object.freeze([...answer.canonicalAnswers]) }))) });
      const questions = Object.fromEntries(answers.map((answer) => [answer.id, Object.freeze({
        type: "noul",
        instructions: `Does the response in state.answers for ${answer.id} communicate the canonical answer to the stated prompt accurately, without contradiction or extra incorrect claims?`,
        criteria: Object.freeze({ true: "The response gives the canonical answer or a correct paraphrase, is materially complete, and does so without contradiction or extra incorrect claims.", false: "The response is wrong, partial, contradictory, materially incomplete, or includes an extra incorrect claim." }),
      })]));
      const decision=await createJevDecisionModel(dependencies).decide({state,questions});
      return decision.ok?{ok:true,value:Object.freeze({...decision.value,accepted:Object.freeze(decision.value.probabilities.map(probability=>probability>=configuration.acceptanceThreshold))})}:decision;
    },
  });
}

/** @param {(entry: { readonly event: string, readonly failureKind?: JevFailure["kind"] }) => void} logger @param {JevFailure["kind"]} kind @returns {Result<never, JevFailure>} */
function failure(logger, kind) { logger({ event: "jev-answer-grading-failure", failureKind: kind }); return { ok: false, error: { kind } }; }

/** Typed probabilistic decisions shared by answer grading and captured-image association.
 * @param {Parameters<typeof createJevAnswerGrader>[0]} dependencies */
export function createJevDecisionModel(dependencies) {
  if (!validConfiguration(dependencies?.configuration) || typeof dependencies.fetch !== "function" || !Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1) throw new TypeError("Jev decision dependencies are invalid.");
  const { apiKey, fetch: request, timeoutMs, logger, configuration } = dependencies;
  return Object.freeze({
    /** @param {{state:unknown,questions:Record<string,{type:'noul',instructions:string,criteria:{true:string,false:string}}>}} input @returns {Promise<Result<{readonly model:string,readonly probabilities:readonly number[]},JevFailure>>} */
    async decide({state,questions}) {
      if(!record(questions)||!Object.keys(questions).length||!Object.entries(questions).every(([id,q])=>/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(id)&&record(q)&&q.type==='noul'&&text(q.instructions)&&record(q.criteria)&&text(q.criteria.true)&&text(q.criteria.false))) return failure(logger,'JevCommandInvalid');
      if(apiKey===null||apiKey.trim()==='')return failure(logger,'JevCredentialMissing');
      logger({ event: "jev-answer-grading-entry" });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let document;
      try {
        const response = await request(configuration.endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: configuration.requestedModel, state, questions }), signal: controller.signal });
        if (response.status === 429 || response.status === 529) return failure(logger, "JevRateLimited");
        if (response.status === 401 || response.status === 403) return failure(logger, "JevCredentialMissing");
        if (!response.ok) return failure(logger, response.status >= 500 ? "JevProviderUnavailable" : "JevProviderRejected");
        let body;
        try { body = await response.text(); } catch (error) { throw error; }
        try {
          if (hasDuplicateJsonKeys(body)) return failure(logger, "JevResponseInvalid");
          document = JSON.parse(body);
        } catch (error) { if (error instanceof SyntaxError) return failure(logger, "JevResponseInvalid"); throw error; }
      } catch (error) {
        if (controller.signal.aborted) return failure(logger, "JevTimeout");
        if (error instanceof TypeError) return failure(logger, "JevProviderUnavailable");
        throw error;
      } finally { clearTimeout(timer); }
      const decision = parseDecision(document, Object.keys(questions), configuration.servedModel);
      if (decision === null) return failure(logger, "JevResponseInvalid");
      logger({ event: "jev-answer-grading-success" });
      return {ok:true,value:decision};
    },
  });
}
