// @ts-check

import { isIsoDateTime, isNonEmptyText, isPositiveInteger, isRecord } from "./contracts.js";

/** @import { LearningChoice, LearningReviewQueue, LearningReviewQueueSource, LearningReviewQueueTask, LearningTaskKind, Result } from "./contracts.js" */

/** @typedef {{ readonly kind: "LearningGatewayCommandInvalid", readonly field: string } | { readonly kind: "LearningGatewayUnauthenticated" } | { readonly kind: "LearningGatewayUnauthorized" } | { readonly kind: "LearningGatewayUnavailable" } | { readonly kind: "LearningGatewayTimedOut" } | { readonly kind: "LearningGatewayResponseInvalid" } | { readonly kind: "LearningGatewayRejected", readonly failureKind: string }} LearningGatewayFailure */
/** @typedef {{ readonly id: string, readonly kind: LearningTaskKind, readonly prompt: string, readonly explanation: string, readonly sourceAnchorIds: readonly [string, ...string[]], readonly choices: readonly LearningChoice[] | null, readonly correctChoiceIds: readonly [string, ...string[]] | null, readonly status: "published", readonly revision: number }} LearningPublishedQuiz */

const freeze = Object.freeze;

export class LearningGenerationBrowserGatewayClient {
  #fetch;
  #base;
  #timeoutMs;

  /** @param {{ readonly fetch: typeof fetch, readonly baseUrl: string, readonly timeoutMs: number }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies.fetch !== "function" || !URL.canParse(dependencies.baseUrl) || !Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1) throw new TypeError("Learning gateway dependencies are invalid.");
    this.#base = new URL(dependencies.baseUrl);
    if (this.#base.protocol !== "https:" && this.#base.hostname !== "localhost" && this.#base.hostname !== "127.0.0.1") throw new TypeError("Learning gateway protocol is invalid.");
    this.#fetch = dependencies.fetch;
    this.#timeoutMs = dependencies.timeoutMs;
  }

  /** @returns {Promise<Result<LearningReviewQueue, LearningGatewayFailure>>} */
  async listQueue() {
    const response = await this.#request("api/learning-generation/review-queue", "GET", null);
    if (!response.ok) return response;
    const value = isRecord(response.value) ? response.value.result : null;
    return parseQueue(value);
  }

  /** @returns {Promise<Result<readonly LearningPublishedQuiz[], LearningGatewayFailure>>} */
  async listPublished() {
    const response = await this.#request("api/learning-generation/published", "GET", null);
    if (!response.ok) return response;
    const value = isRecord(response.value) ? response.value.result : null;
    return parsePublished(value);
  }

  /** @param {unknown} command @returns {Promise<Result<{ readonly taskId: string, readonly status: "published" | "rejected", readonly reviewDecision: "approved" | "rejected", readonly reviewedAt: string, readonly revision: number }, LearningGatewayFailure>>} */
  async decide(command) {
    if (!isRecord(command) || Object.hasOwn(command, "ownerId") || !isNonEmptyText(command.taskId) || !isPositiveInteger(command.expectedRevision) || (command.decision !== "approve" && command.decision !== "reject") || !isIsoDateTime(command.reviewedAt) || !isNonEmptyText(command.idempotencyKey)) return invalid("command");
    const response = await this.#request("api/learning-generation/review", "POST", command);
    if (!response.ok) return response;
    const value = isRecord(response.value) ? response.value.result : null;
    if (!isRecord(value) || !isNonEmptyText(value.taskId) || (value.status !== "published" && value.status !== "rejected") || (value.reviewDecision !== "approved" && value.reviewDecision !== "rejected") || !isIsoDateTime(value.reviewedAt) || !isPositiveInteger(value.revision)) return bad();
    return { ok: true, value: freeze({ taskId: value.taskId, status: value.status, reviewDecision: value.reviewDecision, reviewedAt: value.reviewedAt, revision: value.revision }) };
  }

  /** @param {string} path @param {"GET" | "POST"} method @param {unknown} body @returns {Promise<Result<unknown, LearningGatewayFailure>>} */
  async #request(path, method, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    /** @type {Response} */ let response;
    try {
      response = await (0, this.#fetch)(new URL(path, this.#base), { method, credentials: "same-origin", headers: { accept: "application/json", ...(body === null ? {} : { "content-type": "application/json" }) }, body: body === null ? null : JSON.stringify(body), cache: "no-store", signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: { kind: "LearningGatewayTimedOut" } };
      if (error instanceof TypeError) return { ok: false, error: { kind: "LearningGatewayUnavailable" } };
      throw error;
    } finally { clearTimeout(timeout); }
    if (response.status === 401) return { ok: false, error: { kind: "LearningGatewayUnauthenticated" } };
    if (response.status === 403) return { ok: false, error: { kind: "LearningGatewayUnauthorized" } };
    /** @type {unknown} */ let document;
    try { document = await response.json(); } catch (error) { if (error instanceof SyntaxError) return bad(); throw error; }
    if (!response.ok) {
      const failureKind = isRecord(document) && isNonEmptyText(document.error) ? document.error : null;
      return failureKind === null ? bad() : { ok: false, error: { kind: "LearningGatewayRejected", failureKind } };
    }
    return { ok: true, value: document };
  }
}

/** @param {unknown} value @returns {Result<LearningReviewQueue, LearningGatewayFailure>} */
function parseQueue(value) {
  if (!isRecord(value) || !Array.isArray(value.sources) || !Array.isArray(value.tasks)) return bad();
  /** @type {LearningReviewQueueSource[]} */ const sources = [];
  for (const candidate of value.sources) {
    if (!isRecord(candidate) || !isNonEmptyText(candidate.sourceId) || !isNonEmptyText(candidate.title) || !isQueueStatus(candidate.status) || (candidate.generationId !== null && !isNonEmptyText(candidate.generationId)) || !isNonNegativeInteger(candidate.pendingTaskCount) || !isNonNegativeInteger(candidate.reviewedTaskCount) || (candidate.failureKind !== null && !isNonEmptyText(candidate.failureKind))) return bad();
    sources.push(freeze({ sourceId: candidate.sourceId, title: candidate.title, status: /** @type {import("./contracts.js").LearningReviewQueueStatus} */ (candidate.status), generationId: candidate.generationId, pendingTaskCount: candidate.pendingTaskCount, reviewedTaskCount: candidate.reviewedTaskCount, failureKind: candidate.failureKind }));
  }
  /** @type {LearningReviewQueueTask[]} */ const tasks = [];
  for (const candidate of value.tasks) {
    const task = parseTask(candidate);
    if (task === null) return bad();
    tasks.push(task);
  }
  return { ok: true, value: freeze({ sources: freeze(sources), tasks: freeze(tasks) }) };
}

/** @param {unknown} value @returns {Result<readonly LearningPublishedQuiz[], LearningGatewayFailure>} */
function parsePublished(value) {
  if (!Array.isArray(value)) return bad();
  const quizzes = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !isNonEmptyText(candidate.id) || !isTaskKind(candidate.kind) || !isNonEmptyText(candidate.prompt) || !isNonEmptyText(candidate.explanation) || !Array.isArray(candidate.sourceAnchorIds) || candidate.sourceAnchorIds.length === 0 || candidate.sourceAnchorIds.some((item) => !isNonEmptyText(item)) || candidate.status !== "published" || !isPositiveInteger(candidate.revision)) return bad();
    const choices = parseChoices(candidate.choices);
    const correctChoiceIds = parseTextList(candidate.correctChoiceIds);
    if (choices === undefined || correctChoiceIds === undefined) return bad();
    quizzes.push(freeze({ id: candidate.id, kind: candidate.kind, prompt: candidate.prompt, explanation: candidate.explanation, sourceAnchorIds: freeze(/** @type {[string, ...string[]]} */ ([...candidate.sourceAnchorIds])), choices, correctChoiceIds, status: /** @type {const} */ ("published"), revision: candidate.revision }));
  }
  return { ok: true, value: freeze(quizzes) };
}

/** @param {unknown} value @returns {LearningReviewQueueTask | null} */
function parseTask(value) {
  if (!isRecord(value) || !isNonEmptyText(value.id) || !isNonEmptyText(value.sourceId) || !isTaskKind(value.kind) || !isNonEmptyText(value.prompt) || !isNonEmptyText(value.explanation) || !Array.isArray(value.sourceAnchorIds) || value.sourceAnchorIds.length === 0 || value.sourceAnchorIds.some((item) => !isNonEmptyText(item)) || !isPositiveInteger(value.revision) || value.status !== "pending-review") return null;
  const choices = parseChoices(value.choices);
  const correctChoiceIds = parseTextList(value.correctChoiceIds);
  const expectedConcepts = parseTextList(value.expectedConcepts);
  if (choices === undefined || correctChoiceIds === undefined || expectedConcepts === undefined || (value.minimumWords !== null && (!isPositiveInteger(value.minimumWords))) || (value.responseKind !== null && value.responseKind !== "text") || (value.stimulus !== null && typeof value.stimulus !== "string" && !isRecord(value.stimulus))) return null;
  return freeze({ id: value.id, sourceId: value.sourceId, kind: value.kind, prompt: value.prompt, explanation: value.explanation, sourceAnchorIds: freeze(/** @type {[string, ...string[]]} */ ([...value.sourceAnchorIds])), choices, correctChoiceIds, expectedConcepts, minimumWords: value.minimumWords, stimulus: /** @type {LearningReviewQueueTask["stimulus"]} */ (value.stimulus), responseKind: value.responseKind, status: /** @type {const} */ ("pending-review"), revision: value.revision });
}

/** @param {unknown} value @returns {readonly LearningChoice[] | null | undefined} */
function parseChoices(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const choices = [];
  for (const candidate of value) if (isRecord(candidate) && isNonEmptyText(candidate.id) && isNonEmptyText(candidate.label)) choices.push(freeze({ id: candidate.id, label: candidate.label })); else return undefined;
  return freeze(choices);
}

/** @param {unknown} value @returns {readonly [string, ...string[]] | null | undefined} */
function parseTextList(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !isNonEmptyText(item))) return undefined;
  return freeze(/** @type {[string, ...string[]]} */ ([...value]));
}

/** @param {unknown} value @returns {value is LearningTaskKind} */
function isTaskKind(value) { return value === "single-choice" || value === "multiple-choice" || value === "fill-blank" || value === "short-response" || value === "case-study" || value === "symbolic-midi" || value === "notation"; }
/** @param {unknown} value @returns {value is import("./contracts.js").LearningReviewQueueStatus} */
function isQueueStatus(value) { return value === "queued" || value === "generating" || value === "ready-for-review" || value === "reviewed" || value === "failed" || value === "unavailable"; }
/** @param {unknown} value @returns {value is number} */
function isNonNegativeInteger(value) { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
/** @returns {Result<never, LearningGatewayFailure>} */
function bad() { return { ok: false, error: { kind: "LearningGatewayResponseInvalid" } }; }
/** @param {string} field @returns {Result<never, LearningGatewayFailure>} */
function invalid(field) { return { ok: false, error: { kind: "LearningGatewayCommandInvalid", field } }; }

export {};
