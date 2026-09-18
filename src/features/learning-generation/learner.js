// @ts-check

import { LearningBatchGatewayClient } from "./batches-gateway.js";

/** @import { FeedBatchProjection, LearningBatchGatewayFailure, LearningKnowledgeCard, LearningReviewQuestion, ReviewBatchProjection } from "./batches-gateway.js" */

/**
 * @typedef {{
 *   readonly fetch: typeof fetch,
 *   readonly baseUrl: string,
 *   readonly timeoutMs: number,
 *   readonly escapeHtml: (value: string) => string,
 *   readonly now: () => string,
 *   readonly createId: () => string,
 *   readonly onChange: () => void
 * }} LearnerControllerDependencies
 */

const freeze = Object.freeze;

/** @param {LearnerControllerDependencies} dependencies */
export function createLearnerController(dependencies) {
  if (typeof dependencies?.fetch !== "function" || !URL.canParse(dependencies.baseUrl) || !Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || typeof dependencies.escapeHtml !== "function" || typeof dependencies.now !== "function" || typeof dependencies.createId !== "function" || typeof dependencies.onChange !== "function") throw new TypeError("Learner controller dependencies are invalid.");
  const { createId, escapeHtml, now, onChange } = dependencies;
  const gateway = new LearningBatchGatewayClient({ fetch: dependencies.fetch, baseUrl: dependencies.baseUrl, timeoutMs: dependencies.timeoutMs });
  /** @type {{ readonly state: "idle" | "loading" | "success" | "error", readonly value: FeedBatchProjection | null, readonly error: LearningBatchGatewayFailure | null }} */ let feed = { state: "idle", value: null, error: null };
  /** @type {{ readonly state: "idle" | "loading" | "success" | "error", readonly value: ReviewBatchProjection | null, readonly error: LearningBatchGatewayFailure | null }} */ let review = { state: "idle", value: null, error: null };
  /** @type {Map<string, { readonly correct: boolean, readonly score: number, readonly explanation: string, readonly correctAnswer: string, readonly components: readonly { readonly id: string, readonly correct: boolean, readonly correctAnswer: string }[] }> } */ const answers = new Map();

  function day() { return now().slice(0, 10); }

  async function loadFeed() {
    feed = { state: "loading", value: feed.value, error: null };
    onChange();
    const result = await gateway.loadFeed(day());
    feed = result.ok ? { state: "success", value: result.value, error: null } : { state: "error", value: null, error: result.error };
    onChange();
    return result;
  }

  async function loadReview() {
    const previousBatchId = review.value?.batch?.batchId ?? null;
    review = { state: "loading", value: review.value, error: null };
    onChange();
    const result = await gateway.loadReview(day());
    if (result.ok && result.value.batch?.batchId !== previousBatchId) {
      answers.clear();
    }
    review = result.ok ? { state: "success", value: result.value, error: null } : { state: "error", value: null, error: result.error };
    onChange();
    return result;
  }

  async function refreshFeed() {
    const result = await gateway.refreshFeed(`feed-refresh:${createId()}`);
    feed = result.ok ? { state: "success", value: result.value, error: null } : { state: "error", value: feed.value, error: result.error };
    onChange();
    return result;
  }

  async function completeFeed() {
    const batch = feed.value?.batch;
    if (batch === null || batch === undefined || batch.status !== "open") return;
    const result = await gateway.completeFeed(batch.batchId, `feed-complete:${batch.batchId}`);
    if (!result.ok) {
      feed = { state: "error", value: feed.value, error: result.error };
      onChange();
      return;
    }
    await Promise.all([loadFeed(), loadReview()]);
  }

  async function refreshReview() {
    const previousBatchId = review.value?.batch?.batchId ?? null;
    const result = await gateway.refreshReview(`review-refresh:${createId()}`);
    if (result.ok && result.value.batch?.batchId !== previousBatchId) {
      answers.clear();
    }
    review = result.ok ? { state: "success", value: result.value, error: null } : { state: "error", value: review.value, error: result.error };
    onChange();
    return result;
  }

  /** @param {HTMLFormElement} form */
  async function answerReview(form) {
    const batchId = form.dataset.learnerReviewBatch ?? "";
    const questionId = form.dataset.learnerReviewQuestion ?? "";
    const formData = new FormData(form);
    const selectedChoiceIds = formData.getAll("selectedChoiceIds").filter((value) => typeof value === "string");
    const answerText = formData.get("answerText");
    const question = review.value?.questions.find((candidate) => candidate.questionId === questionId);
    const blankAnswers = question?.blanks?.map((blank) => ({ id: blank.id, text: formData.get(`blank:${blank.id}`) })) ?? null;
    if (batchId === "" || questionId === "" || question === undefined || (question.kind === "fill-blank" ? blankAnswers === null ? typeof answerText !== "string" || answerText.trim() === "" : blankAnswers.some((answer) => typeof answer.text !== "string" || answer.text.trim() === "") : selectedChoiceIds.length === 0)) return;
    const result = await gateway.answerReview(batchId, questionId, /** @type {string[]} */ (selectedChoiceIds), `review-answer:${batchId}:${questionId}`, typeof answerText === "string" ? answerText : null, blankAnswers === null ? null : blankAnswers.map((answer) => ({ id: answer.id, text: /** @type {string} */ (answer.text) })));
    if (!result.ok) {
      review = { state: "error", value: review.value, error: result.error };
      onChange();
      return;
    }
    const correct = result.value.correct === true;
    const alreadyAnswered = answers.has(questionId);
    answers.set(questionId, { correct, score: result.value.score, explanation: result.value.feedback.explanation, correctAnswer: result.value.feedback.correctAnswer, components: result.value.feedback.components });
    if (review.value !== null) {
      const batch = result.value.completed === true && review.value.batch !== null
        ? { ...review.value.batch, status: /** @type {const} */ ("completed"), completedAt: now() }
        : review.value.batch;
      review = { state: "success", value: { ...review.value, batch, dueCount: Math.max(0, review.value.dueCount - (alreadyAnswered ? 0 : 1)) }, error: null };
    }
    onChange();
  }

  /** @param {HTMLElement} button */
  async function preference(button) {
    const knowledgeId = button.dataset.knowledgeId ?? "";
    const choice = button.dataset.preference;
    if (knowledgeId === "" || (choice !== "more" && choice !== "less")) return;
    const result = await gateway.setPreference(knowledgeId, choice, `knowledge-preference:${knowledgeId}:${choice}`);
    if (!result.ok) {
      feed = { state: "error", value: feed.value, error: result.error };
      onChange();
    }
  }

  /** @param {HTMLElement} button */
  async function removeKnowledge(button) {
    const knowledgeId = button.dataset.knowledgeId ?? "";
    if (knowledgeId === "") return;
    const result = await gateway.removeKnowledge(knowledgeId, `knowledge-remove:${knowledgeId}:${createId()}`);
    if (!result.ok) {
      feed = { state: "error", value: feed.value, error: result.error };
      onChange();
      return;
    }
    await Promise.all([loadFeed(), loadReview()]);
  }

  /** @param {LearningBatchGatewayFailure | null} failure */
  function friendly(failure) {
    if (failure === null) return "";
    if (failure.kind === "LearningBatchGatewayUnauthenticated" || failure.kind === "LearningBatchGatewayUnauthorized") return "Sign in through the private learning service, then try again.";
    if (failure.kind === "LearningBatchGatewayUnavailable" || failure.kind === "LearningBatchGatewayTimedOut") return "The learning service could not be reached. Try again; no batch was changed.";
    if (failure.kind === "LearningBatchGatewayRejected" && failure.failureKind === "LearningBatchInsufficientCandidates") return "A complete five-card learning batch is not available yet. Add or finish another source first.";
    if (failure.kind === "LearningBatchGatewayRejected" && failure.failureKind === "LearningBatchIncomplete") return "Finish the current five-card batch before refreshing it.";
    if (failure.kind === "LearningBatchGatewayRejected" && failure.failureKind === "ReviewRefreshLocked") return "Answer every question in the current Review batch before refreshing it.";
    if (failure.kind === "LearningBatchGatewayRejected" && failure.failureKind === "ReviewGradePending") return "Your answer is still being checked. Try again; this attempt has not been recorded.";
    return "The learning batch could not be updated. Try again.";
  }

  function renderFeed() {
    if (feed.state === "loading" && feed.value === null) return `<section class="wide-view state-panel" role="status" aria-busy="true"><p class="eyebrow">Feed</p><h1>Preparing today's five knowledge cards</h1><p>Matching paired source knowledge and media.</p></section>`;
    if (feed.state === "error" && feed.value === null) return statePanel("Feed", friendly(feed.error), "retry-learner-feed");
    const value = feed.value;
    if (value === null || value.batch === null || value.items.length === 0) return `<section class="wide-view state-panel" aria-labelledby="feed-title"><p class="eyebrow">Feed</p><h1 id="feed-title">No complete learning batch yet</h1><p>Five paired knowledge cards are required before Feed can open a batch.</p><button class="button primary" type="button" data-action="retry-learner-feed">Refresh</button></section>`;
    const complete = value.batch.status === "completed";
    return `<section class="feed-column learner-feed" aria-labelledby="feed-title"><div class="section-heading"><div><p class="eyebrow">Daily batch · ${value.items.length} of 5</p><h1 id="feed-title">Learning feed</h1></div>${complete ? `<button class="button secondary" type="button" data-action="refresh-learner-feed">Refresh batch</button>` : `<p class="batch-lock-status">Reach the bottom to study all five</p>`}</div><div class="feed-stack">${value.items.map(renderCard).join("")}</div><div class="learner-feed-sentinel" data-learner-feed-sentinel role="status">${complete ? `<p>Batch studied. Paired questions are unlocked in Review.</p>` : `<p>Bottom reached: mark all five cards studied.</p><button class="button primary" type="button" data-action="complete-learner-feed">Mark batch studied</button>`}</div>${feed.state === "error" ? `<p class="state-inline" role="alert">${escapeHtml(friendly(feed.error))}</p>` : ""}</section>`;
  }

  /** @param {LearningKnowledgeCard} card */
  function renderCard(card) {
    const media = card.media === null || card.media.url.startsWith("/assets/fallback-media/") ? "" : `<div class="card-media"><img src="${escapeHtml(card.media.url)}" alt="${escapeHtml(card.media.attribution)}" loading="lazy" decoding="async" data-associated-media="true" data-fallback-src="/assets/fallback-media/Christmas%20Music%20Image.png"><span class="media-attribution">${escapeHtml(card.media.attribution)}</span></div>`;
    return `<article class="learning-card" data-knowledge-id="${escapeHtml(card.knowledgeId)}">${media}<div class="card-body"><p class="selection-reason">From ${escapeHtml(card.title)}</p><h2>${escapeHtml(card.title)}</h2><p>${escapeHtml(card.summary)}</p><details class="source-details"><summary>Source evidence</summary><p><a href="${escapeHtml(card.sourceUrl)}" rel="noreferrer">Open source</a></p><p>Evidence anchors: ${escapeHtml(card.evidenceAnchorIds.join(", "))}</p></details><p class="paired-question-status">${card.questionLocked ? "Question locked until this batch is studied." : "Paired question unlocked in Review."}</p><div class="preference-controls"><button class="button preference-more" type="button" data-action="learner-preference" data-preference="more" data-knowledge-id="${escapeHtml(card.knowledgeId)}">More like this</button><button class="button preference-less" type="button" data-action="learner-preference" data-preference="less" data-knowledge-id="${escapeHtml(card.knowledgeId)}">Less like this</button><button class="button quiet" type="button" data-action="remove-learner-knowledge" data-knowledge-id="${escapeHtml(card.knowledgeId)}">Remove</button></div></div></article>`;
  }

  function renderReview() {
    if (review.state === "loading" && review.value === null) return `<section class="wide-view state-panel" role="status" aria-busy="true"><p class="eyebrow">Review</p><h1>Preparing today's questions</h1></section>`;
    if (review.state === "error" && review.value === null) return statePanel("Review", friendly(review.error), "retry-learner-review");
    const value = review.value;
    if (value === null || value.questions.length === 0) return `<section class="wide-view state-panel" aria-labelledby="review-title"><p class="eyebrow">Review</p><h1 id="review-title">No questions are due</h1><p>Questions unlock after a Feed batch is studied and return according to their review interval.</p><button class="button secondary" type="button" data-action="refresh-learner-review">Refresh questions</button></section>`;
    const complete = value.batch?.status === "completed" || [...answers.keys()].filter((id) => value.questions.some((question) => question.questionId === id)).length === value.questions.length;
    return `<section class="review-route wide-view" aria-labelledby="review-title"><div class="section-heading"><div><p class="eyebrow">Due batch · ${value.questions.length} question${value.questions.length === 1 ? "" : "s"}</p><h1 id="review-title">Review</h1></div>${complete ? `<button class="button secondary" type="button" data-action="refresh-learner-review">Refresh questions</button>` : `<p class="batch-lock-status">Answer every question before refreshing</p>`}</div>${review.error === null ? "" : `<p class="state-inline" role="alert">${escapeHtml(friendly(review.error))}</p>`}<div class="review-question-list">${value.questions.map(renderQuestion).join("")}</div></section>`;
  }

  /** @param {LearningReviewQuestion} question */
  function renderQuestion(question) {
    const answer = answers.get(question.questionId);
    const input = question.kind === "fill-blank"
      ? question.blanks === null ? `<label>Answer<input type="text" name="answerText" autocomplete="off" required></label>` : question.blanks.map((blank, index) => `<label>Blank ${index + 1}<input type="text" name="blank:${escapeHtml(blank.id)}" autocomplete="off" required></label>`).join("")
      : question.choices === null
      ? `<p>This question type is not answerable in the current Review batch.</p>`
      : `<fieldset class="quiz-options"><legend class="sr-only">${escapeHtml(question.prompt)}</legend>${question.choices.map((choice) => `<label><input type="${question.kind === "multiple-choice" ? "checkbox" : "radio"}" name="selectedChoiceIds" value="${escapeHtml(choice.id)}"><span>${escapeHtml(choice.label)}</span></label>`).join("")}</fieldset>`;
    const completed = review.value?.batch?.status === "completed";
    const body = answer === undefined && !completed
      ? `<form data-learner-review data-learner-review-batch="${escapeHtml(review.value?.batch?.batchId ?? "")}" data-learner-review-question="${escapeHtml(question.questionId)}" novalidate>${input}<button class="button primary" type="submit" ${question.choices === null && question.kind !== "fill-blank" ? "disabled" : ""}>Check answer</button></form>`
      : `<p class="answer-feedback ${answer === undefined ? "" : `is-${answer.correct ? "correct" : "incorrect"}`}" role="status">${answer === undefined ? "Completed. This question has been scheduled for its next interval." : answer.correct ? "Correct." : answer.score > 0 ? `Partly correct (${Math.round(answer.score * 100)}%).` : "Not quite."}</p>`;
    const feedback = answer === undefined ? "" : `<details class="source-details" open><summary>Answer and source explanation</summary><p><strong>Correct answer:</strong> ${escapeHtml(answer.correctAnswer)}</p>${answer.components.length > 1 ? `<ul>${answer.components.map((component, index) => `<li>${question.kind === "fill-blank" ? `Blank ${index + 1}` : escapeHtml(question.choices?.find((choice) => choice.id === component.id)?.label ?? component.id)}: ${component.correct ? "correct" : "review"}${component.correctAnswer === "" ? "" : ` · ${escapeHtml(component.correctAnswer)}`}</li>`).join("")}</ul>` : ""}<p>${escapeHtml(answer.explanation)}</p><p>Evidence anchors: ${escapeHtml(question.sourceAnchorIds.join(", "))}</p></details>`;
    return `<article class="review-card" data-review-question="${escapeHtml(question.questionId)}"><p class="review-question-meta">Paired with ${escapeHtml(question.title)}</p><h2>${escapeHtml(question.prompt)}</h2>${body}${feedback}</article>`;
  }

  /** @param {string} title @param {string} message @param {string} action */
  function statePanel(title, message, action) { return `<section class="wide-view state-panel" role="alert"><p class="eyebrow">${escapeHtml(title)}</p><h1>${escapeHtml(message)}</h1><button class="button primary" type="button" data-action="${action}">Try again</button></section>`; }

  /** @param {HTMLElement} root */
  function bind(root) {
    root.querySelector("[data-action='retry-learner-feed']")?.addEventListener("click", () => void loadFeed());
    root.querySelector("[data-action='retry-learner-review']")?.addEventListener("click", () => void loadReview());
    root.querySelector("[data-action='refresh-learner-feed']")?.addEventListener("click", () => void refreshFeed());
    root.querySelector("[data-action='complete-learner-feed']")?.addEventListener("click", () => void completeFeed());
    root.querySelector("[data-action='refresh-learner-review']")?.addEventListener("click", () => void refreshReview());
    root.querySelectorAll("[data-action='learner-preference']").forEach((element) => element.addEventListener("click", () => { if (element instanceof HTMLElement) void preference(element); }));
    root.querySelectorAll("[data-action='remove-learner-knowledge']").forEach((element) => element.addEventListener("click", () => { if (element instanceof HTMLElement) void removeKnowledge(element); }));
    root.querySelectorAll("img[data-associated-media]").forEach((element) => element.addEventListener("error", () => { if (!(element instanceof HTMLImageElement) || element.dataset.fallbackUsed === "true") return; const fallback = element.dataset.fallbackSrc; if (fallback === undefined || fallback === "") return; element.dataset.fallbackUsed = "true"; element.src = fallback; }));
    root.querySelectorAll("[data-learner-review]").forEach((element) => element.addEventListener("submit", (event) => { event.preventDefault(); if (event.currentTarget instanceof HTMLFormElement) void answerReview(event.currentTarget); }));
  }

  return freeze({ loadFeed, loadReview, renderFeed, renderReview, bind, hasDueReview: () => (review.value?.dueCount ?? 0) > 0 });
}

export {};
