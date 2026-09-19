// @ts-check

import { parseClassification } from "../knowledge-subjects/public.js";

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {{ readonly knowledgeId: string, readonly sourceId: string, readonly questionId: string, readonly title: string, readonly summary: string, readonly sourceUrl: string, readonly evidenceAnchorIds: readonly string[], readonly media: { readonly assetId: string, readonly kind: string, readonly url: string, readonly attribution: string } | null, readonly questionLocked: boolean, readonly classification?: import("../knowledge-subjects/public.js").Classification | null, readonly classificationRevision?: number }} LearningKnowledgeCard */
/** @typedef {{ readonly batchId: string, readonly learningDay: string, readonly status: "open" | "completed", readonly itemIds: readonly string[], readonly revision: number, readonly createdAt: string, readonly completedAt: string | null }} LearningBatchProjection */
/** @typedef {{ readonly batch: LearningBatchProjection | null, readonly items: readonly LearningKnowledgeCard[] }} FeedBatchProjection */
/** @typedef {{ readonly questionId: string, readonly knowledgeId: string, readonly title: string, readonly prompt: string, readonly kind: string, readonly choices: readonly { readonly id: string, readonly label: string }[] | null, readonly blanks: readonly { readonly id: string }[] | null, readonly sourceAnchorIds: readonly string[], readonly revision: number }} LearningReviewQuestion */
/** @typedef {{ readonly correct: boolean, readonly score: number, readonly completed: boolean, readonly nextDueAt: string, readonly feedback: { readonly explanation: string, readonly correctAnswer: string, readonly components: readonly { readonly id: string, readonly correct: boolean, readonly correctAnswer: string }[] } }} LearningReviewAnswer */
/** @typedef {{ readonly batch: LearningBatchProjection | null, readonly questions: readonly LearningReviewQuestion[], readonly dueCount: number }} ReviewBatchProjection */
/** @typedef {{ readonly kind: "LearningBatchGatewayCommandInvalid", readonly field: string } | { readonly kind: "LearningBatchGatewayUnauthenticated" } | { readonly kind: "LearningBatchGatewayUnauthorized" } | { readonly kind: "LearningBatchGatewayUnavailable" } | { readonly kind: "LearningBatchGatewayTimedOut" } | { readonly kind: "LearningBatchGatewayResponseInvalid" } | { readonly kind: "LearningBatchGatewayRejected", readonly failureKind: string }} LearningBatchGatewayFailure */

const freeze = Object.freeze;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value @returns {value is string} */
function iso(value) { return text(value) && Number.isFinite(Date.parse(value)); }

/** @param {unknown} value @returns {LearningBatchProjection | null} */
function parseBatch(value) {
  if (value === null) return null;
  if (!record(value) || !text(value.batchId) || !text(value.learningDay) || (value.status !== "open" && value.status !== "completed") || !Array.isArray(value.itemIds) || value.itemIds.length < 1 || value.itemIds.length > 5 || !value.itemIds.every(text) || !positiveInteger(value.revision) || !iso(value.createdAt) || (value.completedAt !== null && !iso(value.completedAt))) return null;
  return freeze({ batchId: value.batchId, learningDay: value.learningDay, status: value.status, itemIds: freeze([...value.itemIds]), revision: value.revision, createdAt: value.createdAt, completedAt: value.completedAt });
}

/** @param {unknown} value @returns {LearningKnowledgeCard | null} */
function parseCard(value) {
  if (!record(value) || !text(value.knowledgeId) || !text(value.sourceId) || !text(value.questionId) || !text(value.title) || !text(value.summary) || !text(value.sourceUrl) || !URL.canParse(value.sourceUrl) || !Array.isArray(value.evidenceAnchorIds) || value.evidenceAnchorIds.length === 0 || !value.evidenceAnchorIds.every(text) || typeof value.questionLocked !== "boolean") return null;
  const classification = value.classification === undefined || value.classification === null ? null : parseClassification(value.classification);
  if (classification !== null && !classification.ok) return null;
  const classificationRevision = value.classificationRevision === undefined ? 0 : value.classificationRevision;
  if (typeof classificationRevision !== "number" || !Number.isSafeInteger(classificationRevision) || classificationRevision < 0) return null;
  const sourceUrl = /** @type {string} */ (value.sourceUrl);
  const media = value.media === null ? null : record(value.media) && text(value.media.assetId) && text(value.media.kind) && text(value.media.url) && text(value.media.attribution) ? freeze({ assetId: value.media.assetId, kind: value.media.kind, url: value.media.url, attribution: value.media.attribution }) : undefined;
  return media === undefined ? null : freeze({ knowledgeId: value.knowledgeId, sourceId: value.sourceId, questionId: value.questionId, title: value.title, summary: value.summary, sourceUrl, evidenceAnchorIds: freeze([...value.evidenceAnchorIds]), media, questionLocked: value.questionLocked, classification: classification === null ? null : classification.value, classificationRevision });
}

/** @param {unknown} value @returns {LearningReviewQuestion | null} */
function parseQuestion(value) {
  if (!record(value) || !text(value.questionId) || !text(value.knowledgeId) || !text(value.title) || !text(value.prompt) || !text(value.kind) || !Array.isArray(value.sourceAnchorIds) || value.sourceAnchorIds.length === 0 || !value.sourceAnchorIds.every(text) || !positiveInteger(value.revision)) return null;
  if (Object.hasOwn(value, "explanation") || Object.hasOwn(value, "correctChoiceIds") || Object.hasOwn(value, "acceptedAnswers") || Object.hasOwn(value, "blankId")) return null;
  const choices = value.choices === null ? null : Array.isArray(value.choices) && value.choices.length > 0 && value.choices.every((choice) => record(choice) && text(choice.id) && text(choice.label)) ? freeze(value.choices.map((choice) => freeze({ id: /** @type {string} */ (choice.id), label: /** @type {string} */ (choice.label) }))) : undefined;
  const blanks = value.blanks === undefined || value.blanks === null ? null : Array.isArray(value.blanks) && value.blanks.length >= 2 && value.blanks.length <= 4 && value.blanks.every((blank, index) => record(blank) && blank.id === `blank-${index + 1}` && !Object.hasOwn(blank, "acceptedAnswers")) ? freeze(value.blanks.map((blank) => freeze({ id: /** @type {string} */ (blank.id) }))) : undefined;
  return choices === undefined || blanks === undefined ? null : freeze({ questionId: value.questionId, knowledgeId: value.knowledgeId, title: value.title, prompt: value.prompt, kind: value.kind, choices, blanks, sourceAnchorIds: freeze([...value.sourceAnchorIds]), revision: value.revision });
}

/** @param {unknown} value @returns {LearningReviewAnswer | null} */
function parseReviewAnswer(value) {
  if (!record(value) || typeof value.correct !== "boolean" || typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 1 || typeof value.completed !== "boolean" || !iso(value.nextDueAt) || !record(value.feedback) || !text(value.feedback.explanation) || !text(value.feedback.correctAnswer) || !Array.isArray(value.feedback.components) || !value.feedback.components.every((component) => record(component) && text(component.id) && typeof component.correct === "boolean" && typeof component.correctAnswer === "string")) return null;
  return freeze({ correct: value.correct, score: value.score, completed: value.completed, nextDueAt: value.nextDueAt, feedback: freeze({ explanation: value.feedback.explanation, correctAnswer: value.feedback.correctAnswer, components: freeze(value.feedback.components.map((component) => freeze({ id: /** @type {string} */ (component.id), correct: /** @type {boolean} */ (component.correct), correctAnswer: /** @type {string} */ (component.correctAnswer) }))) }) });
}

/** @param {unknown} value @returns {Result<FeedBatchProjection, LearningBatchGatewayFailure>} */
function parseFeed(value) {
  if (!record(value) || !Array.isArray(value.items)) return bad();
  const batch = parseBatch(value.batch);
  if (value.batch !== null && batch === null) return bad();
  const items = value.items.map(parseCard);
  return items.some((item) => item === null) ? bad() : { ok: true, value: freeze({ batch, items: freeze(/** @type {LearningKnowledgeCard[]} */ (items)) }) };
}

/** @param {unknown} value @returns {Result<ReviewBatchProjection, LearningBatchGatewayFailure>} */
function parseReview(value) {
  if (!record(value) || !Array.isArray(value.questions) || typeof value.dueCount !== "number" || !Number.isSafeInteger(value.dueCount) || value.dueCount < 0) return bad();
  const dueCount = value.dueCount;
  const batch = parseBatch(value.batch);
  if (value.batch !== null && batch === null) return bad();
  const questions = value.questions.map(parseQuestion);
  return questions.some((question) => question === null) ? bad() : { ok: true, value: freeze({ batch, questions: freeze(/** @type {LearningReviewQuestion[]} */ (questions)), dueCount }) };
}

/** @param {unknown} value @returns {Result<{ readonly items: readonly LearningKnowledgeCard[] }, LearningBatchGatewayFailure>} */
function parseKnowledge(value) {
  if (!record(value) || !Array.isArray(value.items)) return bad();
  const items = value.items.map(parseCard);
  return items.some((item) => item === null)
    ? bad()
    : { ok: true, value: freeze({ items: freeze(/** @type {LearningKnowledgeCard[]} */ (items)) }) };
}

export class LearningBatchGatewayClient {
  #fetch;
  #base;
  #timeoutMs;

  /** @param {{ readonly fetch: typeof fetch, readonly baseUrl: string, readonly timeoutMs: number }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.fetch !== "function" || !URL.canParse(dependencies.baseUrl) || !Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1) throw new TypeError("Learning batch gateway dependencies are invalid.");
    this.#base = new URL(dependencies.baseUrl);
    if (this.#base.protocol !== "https:" && this.#base.hostname !== "localhost" && this.#base.hostname !== "127.0.0.1") throw new TypeError("Learning batch gateway protocol is invalid.");
    this.#fetch = dependencies.fetch;
    this.#timeoutMs = dependencies.timeoutMs;
  }

  /** @param {string} learningDay @returns {Promise<Result<FeedBatchProjection, LearningBatchGatewayFailure>>} */
  async loadFeed(learningDay) {
    if (!iso(`${learningDay}T00:00:00.000Z`)) return invalid("learningDay");
    const response = await this.#request(`api/learning-generation/feed-batch?day=${encodeURIComponent(learningDay)}`, "GET", null);
    if (!response.ok) return response;
    return parseFeed(resultValue(response.value));
  }

  /** @param {string | null} [sourceId] @returns {Promise<Result<{ readonly items: readonly LearningKnowledgeCard[] }, LearningBatchGatewayFailure>>} */
  async listKnowledge(sourceId = null) {
    if (sourceId !== null && !text(sourceId)) return invalid("sourceId");
    const query = sourceId === null ? "" : `?sourceId=${encodeURIComponent(sourceId)}`;
    const response = await this.#request(`api/learning-generation/library-knowledge${query}`, "GET", null);
    if (!response.ok) return response;
    return parseKnowledge(resultValue(response.value));
  }

  /** @param {string} idempotencyKey @returns {Promise<Result<FeedBatchProjection, LearningBatchGatewayFailure>>} */
  async refreshFeed(idempotencyKey) {
    if (!text(idempotencyKey)) return invalid("idempotencyKey");
    const response = await this.#request("api/learning-generation/feed-batch/refresh", "POST", { idempotencyKey });
    if (!response.ok) return response;
    return parseFeed(resultValue(response.value));
  }

  /** @param {string} batchId @param {string} idempotencyKey @returns {Promise<Result<Record<string, unknown>, LearningBatchGatewayFailure>>} */
  async completeFeed(batchId, idempotencyKey) { return this.#command("api/learning-generation/feed-batch/complete", { batchId, idempotencyKey }); }
  /** @param {string} learningDay @returns {Promise<Result<ReviewBatchProjection, LearningBatchGatewayFailure>>} */
  async loadReview(learningDay) {
    if (!iso(`${learningDay}T00:00:00.000Z`)) return invalid("learningDay");
    const response = await this.#request(`api/learning-generation/review-batch?day=${encodeURIComponent(learningDay)}`, "GET", null);
    if (!response.ok) return response;
    return parseReview(resultValue(response.value));
  }
  /** @param {string} idempotencyKey @returns {Promise<Result<ReviewBatchProjection, LearningBatchGatewayFailure>>} */
  async refreshReview(idempotencyKey) {
    if (!text(idempotencyKey)) return invalid("idempotencyKey");
    const response = await this.#request("api/learning-generation/review-batch/refresh", "POST", { idempotencyKey });
    if (!response.ok) return response;
    return parseReview(resultValue(response.value));
  }
  /** @param {string} batchId @param {string} questionId @param {readonly string[]} selectedChoiceIds @param {string} idempotencyKey @param {string | null} [answerText] @param {readonly { readonly id: string, readonly text: string }[] | null} [blankAnswers] @returns {Promise<Result<LearningReviewAnswer, LearningBatchGatewayFailure>>} */
  async answerReview(batchId, questionId, selectedChoiceIds, idempotencyKey, answerText = null, blankAnswers = null) {
    const result = await this.#command("api/learning-generation/review-batch/answer", { batchId, questionId, selectedChoiceIds, answerText, blankAnswers, idempotencyKey });
    if (!result.ok) return result;
    const parsed = parseReviewAnswer(result.value);
    return parsed === null ? bad() : { ok: true, value: parsed };
  }
  /** @param {string} knowledgeId @param {"more" | "less"} choice @param {string} idempotencyKey @returns {Promise<Result<Record<string, unknown>, LearningBatchGatewayFailure>>} */
  async setPreference(knowledgeId, choice, idempotencyKey) { return this.#command("api/learning-generation/knowledge-preference", { knowledgeId, choice, idempotencyKey }); }
  /** @param {string} knowledgeId @param {string} idempotencyKey @returns {Promise<Result<Record<string, unknown>, LearningBatchGatewayFailure>>} */
  async removeKnowledge(knowledgeId, idempotencyKey) { return this.#command("api/learning-generation/knowledge-remove", { knowledgeId, idempotencyKey }); }

  /** @param {string} knowledgeId @param {number} expectedRevision @param {unknown} classification @returns {Promise<Result<true, LearningBatchGatewayFailure>>} */
  async correctClassification(knowledgeId, expectedRevision, classification) {
    const parsed = parseClassification(classification);
    if (!text(knowledgeId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !parsed.ok) return invalid("classification");
    const response = await this.#request("api/learning-generation/classification", "POST", { knowledgeId, expectedRevision, classification: parsed.value });
    if (!response.ok) return response;
    const value = resultValue(response.value);
    if (!record(value) || value.classificationRevision !== expectedRevision + 1 || !parseClassification(value.classification).ok) return bad();
    return { ok: true, value: true };
  }

  /** @param {string} path @param {Record<string, unknown>} body @returns {Promise<Result<Record<string, unknown>, LearningBatchGatewayFailure>>} */
  async #command(path, body) {
    if (!text(body.idempotencyKey)) return invalid("idempotencyKey");
    const response = await this.#request(path, "POST", body);
    if (!response.ok) return response;
    const value = resultValue(response.value);
    return record(value) ? { ok: true, value } : bad();
  }

  /** @param {string} path @param {"GET" | "POST"} method @param {Record<string, unknown> | null} body @returns {Promise<Result<unknown, LearningBatchGatewayFailure>>} */
  async #request(path, method, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response;
    try {
      response = await (0, this.#fetch)(new URL(path, this.#base), { method, credentials: "same-origin", headers: { accept: "application/json", ...(body === null ? {} : { "content-type": "application/json" }) }, body: body === null ? null : JSON.stringify(body), cache: "no-store", signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: { kind: "LearningBatchGatewayTimedOut" } };
      if (error instanceof TypeError) return { ok: false, error: { kind: "LearningBatchGatewayUnavailable" } };
      throw error;
    } finally { clearTimeout(timeout); }
    if (response.status === 401) return { ok: false, error: { kind: "LearningBatchGatewayUnauthenticated" } };
    if (response.status === 403) return { ok: false, error: { kind: "LearningBatchGatewayUnauthorized" } };
    let document;
    try { document = await response.json(); } catch (error) { if (error instanceof SyntaxError) return bad(); throw error; }
    if (!response.ok) {
      const failureKind = record(document) && text(document.error) ? document.error : null;
      return failureKind === null ? bad() : { ok: false, error: { kind: "LearningBatchGatewayRejected", failureKind } };
    }
    return { ok: true, value: document };
  }
}

/** @param {unknown} value @returns {unknown} */
function resultValue(value) { return record(value) && Object.hasOwn(value, "result") ? value.result : null; }
/** @returns {Result<never, LearningBatchGatewayFailure>} */
function bad() { return { ok: false, error: { kind: "LearningBatchGatewayResponseInvalid" } }; }
/** @param {string} field @returns {Result<never, LearningBatchGatewayFailure>} */
function invalid(field) { return { ok: false, error: { kind: "LearningBatchGatewayCommandInvalid", field } }; }

export {};
