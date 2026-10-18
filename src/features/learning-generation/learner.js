// @ts-check
import { createShellMarkup } from "../../shell-markup.js";
import { pendingSpark, playSpark, sparkIcon } from "../experience/spark.js";

import { SUBJECTS } from "../knowledge-subjects/public.js";
import { subjectPresentation } from "../knowledge-subjects/presentation.js";

import { showGoalCelebration } from "./celebration.js";

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
 *   readonly getDailyTargets?: () => { readonly learning: number, readonly review: number },
 *   readonly onChange: (notice?: string, preferredFocusKey?: string | null, fallbackHeadingId?: string | null) => void
 * }} LearnerControllerDependencies
 */

const freeze = Object.freeze;
const feedMarkup = createShellMarkup("feed-markup");

/** @param {LearnerControllerDependencies} dependencies */
export function createLearnerController(dependencies) {
  if (typeof dependencies?.fetch !== "function" || !URL.canParse(dependencies.baseUrl) || !Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || typeof dependencies.escapeHtml !== "function" || typeof dependencies.now !== "function" || typeof dependencies.createId !== "function" || typeof dependencies.onChange !== "function") throw new TypeError("Learner controller dependencies are invalid.");
  const { createId, escapeHtml, now, onChange } = dependencies;
  const gateway = new LearningBatchGatewayClient({ fetch: dependencies.fetch, baseUrl: dependencies.baseUrl, timeoutMs: dependencies.timeoutMs });
  /** @type {{ readonly state: "idle" | "loading" | "success" | "error", readonly value: FeedBatchProjection | null, readonly error: LearningBatchGatewayFailure | null }} */ let feed = { state: "idle", value: null, error: null };
  /** @type {{ readonly state: "idle" | "loading" | "success" | "error", readonly value: ReviewBatchProjection | null, readonly error: LearningBatchGatewayFailure | null }} */ let review = { state: "idle", value: null, error: null };
  /** @type {Map<string, { readonly correct: boolean, readonly score: number, readonly explanation: string, readonly correctAnswer: string, readonly skipped?: boolean }> } */ const answers = new Map();
  /** @type {Map<string, { readonly selectedChoiceIds: readonly string[], readonly answerText: string, readonly blanks: Readonly<Record<string, string>> }> } */ const attempts = new Map();

  const pending = new Set();
  const celebrations = new Set();
  /** @type {Map<string, string>} */ const preferences = new Map();
  let classificationMessage = "";
  /** @type {{ readonly date: string, readonly studyItems: number, readonly reviewAttempts: number } | null} */ let dailyProgress = null;
  /** @type {Promise<void> | null} */ let progressLoad = null;
  let feedDay = "", reviewDay = "";
  let reviewCelebrationDay = "";

  async function loadDailyProgress() {
    if (!dependencies.getDailyTargets) return;
    if (progressLoad !== null) return await progressLoad;
    progressLoad = (async () => {
      const result = await gateway.loadProgress();
      dailyProgress = result.ok ? result.value.activity.find(row => row.date === day()) ?? null : null;
    })().finally(() => { progressLoad = null; });
    await progressLoad;
  }

  /** @param {"learning" | "review"} kind */
  function renderDailyGoal(kind) {
    if (!dependencies.getDailyTargets) return "";
    const target = dependencies.getDailyTargets()[kind];
    const count = kind === "learning" ? dailyProgress?.studyItems : dailyProgress?.reviewAttempts;
    const label = feedMarkup(kind === "learning" ? 24 : 25);
    return feedMarkup(23, count === undefined ? "Progress unavailable" : `${count} / ${target}`, label);
  }

  async function refreshDay() {
    if (pending.size > 0 || feed.state === "loading" || review.state === "loading" || (feedDay === day() && reviewDay === day())) return;
    attempts.clear();
    await Promise.all([loadFeed(), loadReview()]);
  }

  /** @param {string} key */
  function actionState(key) {
    return `data-spark-button data-focus-key="${escapeHtml(key)}" ${pending.has(key) ? 'aria-disabled="true" aria-busy="true"' : ""} ${celebrations.has(key) ? `data-spark-event="${escapeHtml(key)}"` : ""}`;
  }
  /** @param {string} key @param {string} label @param {string} waiting */
  function actionLabel(key, label, waiting) { return pending.has(key) ? `${pendingSpark()}${waiting}` : label; }
  /** @param {string} key */
  function begin(key) {
    if (pending.has(key)) return false;
    pending.add(key);
    onChange(undefined, key);
    return true;
  }

  function day() { return now().slice(0, 10); }

  async function loadFeed() {
    feed = { state: "loading", value: feed.value, error: null };
    onChange();
    const requestedDay = day();
    const result = await gateway.loadFeed(requestedDay);
    if (result.ok) feedDay = requestedDay;
    await loadDailyProgress();
    feed = result.ok ? { state: "success", value: result.value, error: null } : { state: "error", value: null, error: result.error };
    onChange();
    return result;
  }

  async function loadReview() {
    const previousBatchId = review.value?.batch?.batchId ?? null;
    review = { state: "loading", value: review.value, error: null };
    onChange();
    const requestedDay = day();
    const result = await gateway.loadReview(requestedDay);
    if (result.ok) reviewDay = requestedDay;
    await loadDailyProgress();
    if (result.ok && result.value.batch?.batchId !== previousBatchId) {
      answers.clear();
    }
    if (result.ok) for (const skipped of result.value.skipped) answers.set(skipped.questionId, { correct: false, score: 0, ...skipped.feedback, skipped: true });
    review = result.ok ? { state: "success", value: result.value, error: null } : { state: "error", value: null, error: result.error };
    onChange();
    return result;
  }

  async function refreshFeed() {
    if (!begin("feed-refresh")) return;
    const result = await gateway.refreshFeed(`feed-refresh:${createId()}`);
    pending.delete("feed-refresh");
    feed = result.ok ? { state: "success", value: result.value, error: null } : { state: "error", value: feed.value, error: result.error };
    onChange(undefined, "feed-refresh");
  }

  async function completeFeed() {
    const batch = feed.value?.batch;
    if (batch === null || batch === undefined || batch.status !== "open") return;
    if (!begin("feed-complete")) return;
    await loadDailyProgress();
    const studiedBefore = dailyProgress?.studyItems;
    const result = await gateway.completeFeed(batch.batchId, `feed-complete:${batch.batchId}`);
    pending.delete("feed-complete");
    if (!result.ok) {
      feed = { state: "error", value: feed.value, error: result.error };
      onChange();
      return;
    }
    await Promise.all([loadFeed(), ...(review.value?.batch == null ? [loadReview()] : [])]);
    const targets = dependencies.getDailyTargets?.();
    if (targets && studiedBefore !== undefined && studiedBefore < targets.learning && dailyProgress !== null && dailyProgress.studyItems >= targets.learning) {
      showGoalCelebration("learning", dailyProgress.studyItems, Math.max(0, targets.review - dailyProgress.reviewAttempts));
    }
  }

  async function refreshReview() {
    if (review.state === "loading" || review.value?.questions.some(question => questionPending(question.questionId)) || !begin("review-refresh")) return;
    const result = await gateway.refreshReview(`review-refresh:${createId()}`);
    pending.delete("review-refresh");
    if (result.ok) {
      answers.clear();
      attempts.clear();
    }
    review = result.ok ? { state: "success", value: result.value, error: null } : { state: "error", value: review.value, error: result.error };
    onChange(undefined, "review-refresh");
    return result;
  }

  /** @param {string} questionId */
  function questionPending(questionId) { return pending.has("review-refresh") || pending.has(`review-submit:${questionId}`) || pending.has(`review-skip:${questionId}`); }

  /** @param {HTMLFormElement} form */
  async function answerReview(form) {
    const batchId = form.dataset.learnerReviewBatch ?? "";
    const questionId = form.dataset.learnerReviewQuestion ?? "";
    const formData = new FormData(form);
    const selectedChoiceIds = formData.getAll("selectedChoiceIds").filter((value) => typeof value === "string");
    const answerText = formData.get("answerText");
    const question = review.value?.questions.find((candidate) => candidate.questionId === questionId);
    const blankAnswers = question?.blanks?.map((blank) => ({ id: blank.id, text: formData.get(`blank:${blank.id}`) })) ?? null;
    if (batchId === "" || questionId === "" || question === undefined || (question.kind === "fill-blank" ? blankAnswers === null ? typeof answerText !== "string" || answerText.trim() === "" : blankAnswers.some(answer => typeof answer.text !== "string" || answer.text.trim() === "") : selectedChoiceIds.length === 0)) return;
    const actionKey = `review-submit:${questionId}`;
    if (questionPending(questionId) || answers.has(questionId)) return;
    const reviewedBefore = dailyProgress?.reviewAttempts;
    attempts.set(questionId, { selectedChoiceIds: freeze([...selectedChoiceIds]), answerText: String(answerText ?? ""), blanks: freeze(Object.fromEntries((question.blanks ?? []).map(blank => [blank.id, String(formData.get(`blank:${blank.id}`) ?? "")])))});
    begin(actionKey);
    const result = await gateway.answerReview(batchId, questionId, /** @type {string[]} */ (selectedChoiceIds), `review-answer:${batchId}:${questionId}`, typeof answerText === "string" ? answerText : null, blankAnswers === null ? null : blankAnswers.map((answer) => ({ id: answer.id, text: /** @type {string} */ (answer.text) })), question.revision);
    pending.delete(actionKey);
    if (!result.ok) {
      review = { state: "error", value: review.value, error: result.error };
      onChange(undefined, `review-submit:${questionId}`);
      return;
    }
    showFeedback(questionId, result.value);
    await loadDailyProgress();
    onChange(undefined, `review-feedback:${questionId}`, "review-title");
    const target = dependencies.getDailyTargets?.().review;
    if (target !== undefined && reviewedBefore !== undefined && reviewedBefore < target && dailyProgress !== null && dailyProgress.reviewAttempts >= target && reviewCelebrationDay !== day()) {
      reviewCelebrationDay = day();
      showGoalCelebration("review", dailyProgress.reviewAttempts);
    }
  }

  /** @param {HTMLElement} button */
  async function skipReview(button) {
    const questionId = button.dataset.questionId ?? "";
    const question = review.value?.questions.find(item => item.questionId === questionId);
    const batch = review.value?.batch;
    const key = `review-skip:${questionId}`;
    if (!question || !batch || questionPending(questionId) || answers.has(questionId)) return;
    begin(key);
    const result = await gateway.skipReview(batch.batchId, questionId, question.revision, `review-skip:${batch.batchId}:${questionId}`);
    pending.delete(key);
    if (result.ok) showFeedback(questionId, { ...result.value, correct: false, score: 0 }, true);
    else review = { state: "error", value: review.value, error: result.error };
    onChange(undefined, result.ok ? `review-feedback:${questionId}` : key, "review-title");
  }

  /** @param {string} questionId @param {{correct:boolean,score:number,completed:boolean,feedback:{explanation:string,correctAnswer:string}}} result @param {boolean} [skipped] */
  function showFeedback(questionId, result, skipped = false) {
    attempts.delete(questionId);
    if (result.correct) celebrations.add(`review-feedback:${questionId}`);
    answers.set(questionId, { correct: result.correct, score: result.score, ...result.feedback, skipped });
    if (review.value !== null) review = { state: "success", value: { ...review.value, batch: result.completed && review.value.batch ? { ...review.value.batch, status: "completed", completedAt: now() } : review.value.batch, dueCount: Math.max(0, review.value.dueCount - (skipped ? 0 : 1)) }, error: null };
  }

  /** @param {HTMLElement} button */
  async function preference(button) {
    const knowledgeId = button.dataset.knowledgeId ?? "";
    const choice = button.dataset.preference;
    if (knowledgeId === "" || (choice !== "more" && choice !== "less")) return;
    const actionKey = `preference:${knowledgeId}:${choice}`;
    if (pending.has(`preference:${knowledgeId}:more`) || pending.has(`preference:${knowledgeId}:less`)) return;
    begin(actionKey);
    const result = await gateway.setPreference(knowledgeId, choice, `knowledge-preference:${knowledgeId}:${choice}:${createId()}`);
    pending.delete(actionKey);
    if (!result.ok) {
      feed = { state: "error", value: feed.value, error: result.error };
      onChange(undefined, actionKey);
    } else {
      preferences.set(knowledgeId, choice);
      if (choice === "more") celebrations.add(actionKey);
      onChange(undefined, actionKey);
      onChange("Preference saved.");
    }
  }

  /** @param {HTMLElement} button */
  async function removeKnowledge(button) {
    const knowledgeId = button.dataset.knowledgeId ?? "";
    const target = button.dataset.removeTarget;
    if (knowledgeId === "" || (target !== "image" && target !== "knowledge")) return;
    const key = `remove:${knowledgeId}`;
    if (!begin(key)) return;
    const result = await gateway.removeKnowledge(knowledgeId, `knowledge-remove:${knowledgeId}:${createId()}`, target);
    pending.delete(key);
    if (!result.ok) {
      feed = { state: "error", value: feed.value, error: result.error };
      onChange(undefined, key);
      return;
    }
    if (target === "image" && feed.value) {
      feed = { state: "success", error: null, value: { ...feed.value, items: feed.value.items.map(card => card.knowledgeId === knowledgeId ? { ...card, media: null } : card) } };
      onChange(undefined, key);
      onChange("Image removed. Knowledge point and quizzes kept.");
      return;
    }
    await Promise.all([loadFeed(), loadReview()]);
  }

  /** @param {LearningBatchGatewayFailure | null} failure */
  function friendly(failure) {
    if (failure === null) return "";
    if (failure.kind === "LearningBatchGatewayUnauthenticated" || failure.kind === "LearningBatchGatewayUnauthorized") return feedMarkup(6);
    if (failure.kind === "LearningBatchGatewayUnavailable" || failure.kind === "LearningBatchGatewayTimedOut") return feedMarkup(7);
    if (failure.kind === "LearningBatchGatewayRejected" && failure.failureKind === "LearningBatchInsufficientCandidates") return feedMarkup(8);
    if (failure.kind === "LearningBatchGatewayRejected" && failure.failureKind === "LearningBatchIncomplete") return feedMarkup(9);
    if (failure.kind === "LearningBatchGatewayRejected" && failure.failureKind === "ReviewGradePending") return feedMarkup(11);
    if (failure.kind === "LearningBatchGatewayRejected" && failure.failureKind === "ReviewGradingUnavailable") return feedMarkup(12);
    return feedMarkup(13);
  }

  function renderFeed() {
    return feedMarkup(0) + `${renderDailyGoal("learning")}${renderFeedHeading()}<div class="daily-grid">${renderFeedBody()}</div></section>`;
  }

  function renderFeedHeading() {
    const value = feed.value;
    if (value === null || value.batch === null || value.items.length === 0) return "";
    const complete = value.batch.status === "completed";
    return feedMarkup(14, value.items.length, complete ? "" : feedMarkup(16));
  }

  function renderFeedBody() {
    if (feed.state === "loading" && feed.value === null) return feedMarkup(3);
    if (feed.state === "error" && feed.value === null) return statePanel("Feed", friendly(feed.error), "retry-learner-feed", "h2");
    const value = feed.value;
    if (value === null || value.batch === null || value.items.length === 0) return feedMarkup(1);
    const complete = value.batch.status === "completed";
    return `${pending.has("feed-refresh") ? feedMarkup(26, pendingSpark()) : ""}<section class="feed-column learner-feed" aria-labelledby="feed-title">${classificationMessage === "" ? "" : `<p role="status">${escapeHtml(classificationMessage)}</p>`}<div class="feed-stack">${value.items.map(renderCard).join("")}</div>${complete ? feedMarkup(22) : feedMarkup(21, actionState("feed-complete"), actionLabel("feed-complete", "Mark batch studied", "Saving study…"))}${feed.state === "error" ? `<p class="state-inline" role="alert">${escapeHtml(friendly(feed.error))}</p>` : ""}</section>`;
  }

  /** @param {LearningKnowledgeCard} card */
  function renderCard(card) {
    const classification = card.sourceClassification;
    const presentation = subjectPresentation(classification?.mainSubject ?? null);
    const subject = presentation === null ? "" : ` data-subject="${escapeHtml(classification?.mainSubject ?? "")}"`;
    const mark = presentation === null ? "" : `<svg class="subject-mark" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${presentation.path}"/></svg>`;
    const hasImage = card.media !== null && !card.media.url.startsWith("/assets/fallback-media/");
    const media = !hasImage || card.media === null ? "" : `<figure class="card-media"><button class="image-zoom" type="button" data-image-zoom aria-label="Enlarge image"><img src="${escapeHtml(card.media.url)}" alt="${escapeHtml(card.media.attribution)}" loading="lazy" decoding="async" data-associated-media="true"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6m-3-3v6"/></svg></button></figure>`;
    const key = `remove:${card.knowledgeId}`;
    const removal = `<details class="card-remove" data-library-details-key="${escapeHtml(key)}" ${pending.has(key) ? "open" : ""}><summary class="button quiet" data-focus-key="${escapeHtml(key)}">Remove ▾</summary><div class="removal-actions">${[["image", "Image only"], ["knowledge", "Knowledge point"]].map(([target, label]) => `<button class="button secondary" type="button" data-action="remove-learner-knowledge" data-remove-target="${target}" data-knowledge-id="${escapeHtml(card.knowledgeId)}" ${pending.has(key) || target === "image" && !hasImage ? "disabled" : ""}>${pending.has(key) ? "Removing…" : label}</button>`).join("")}</div></details>`;
    return `<article class="learning-card"${subject} data-reveal="knowledge:${escapeHtml(card.knowledgeId)}" data-knowledge-id="${escapeHtml(card.knowledgeId)}"><div class="card-body"><p class="card-knowledge">${escapeHtml(card.summary)}</p>${media}<h3 class="card-source"><a href="${escapeHtml(card.sourceUrl)}" rel="noreferrer">${escapeHtml(card.title)}</a></h3><p class="card-subject">${mark}${escapeHtml(presentation?.label ?? "Unclassified")}</p>${classification ? `<p>${escapeHtml(classification.topic)}</p>` : ""}<div class="card-context">${classificationEditor(card)}<details class="source-details"><summary>Source evidence</summary><p><a href="${escapeHtml(card.sourceUrl)}" rel="noreferrer">Open source</a></p><p>Evidence anchors: ${escapeHtml(card.evidenceAnchorIds.join(", "))}</p></details></div><div class="preference-controls"><button class="button preference-more ${preferences.get(card.knowledgeId) === "more" ? "spark-saved" : ""}" type="button" data-action="learner-preference" data-preference="more" data-knowledge-id="${escapeHtml(card.knowledgeId)}" ${actionState(`preference:${card.knowledgeId}:more`)}>${actionLabel(`preference:${card.knowledgeId}:more`, `${sparkIcon()}${preferences.get(card.knowledgeId) === "more" ? "Preference saved" : "More like this"}`, "Saving…")}</button><button class="button preference-less" type="button" data-action="learner-preference" data-preference="less" data-knowledge-id="${escapeHtml(card.knowledgeId)}" ${actionState(`preference:${card.knowledgeId}:less`)}>${actionLabel(`preference:${card.knowledgeId}:less`, preferences.get(card.knowledgeId) === "less" ? "Preference saved" : "Less like this", "Saving…")}</button>${removal}</div></div></article>`;
  }

  /** @param {LearningKnowledgeCard} card */
  function classificationEditor(card) {
    const classification = card.sourceClassification;
    const options = SUBJECTS.map(subject => `<option value="${subject.id}" ${subject.id === classification?.mainSubject ? "selected" : ""}>${escapeHtml(subject.label)}</option>`).join("");
    return `<details data-library-details-key="classification-${escapeHtml(card.sourceId)}"><summary>Edit source classification</summary><form class="classification-form" data-source-classification="${escapeHtml(card.sourceId)}" data-source-revision="${card.sourceRevision}" data-revision="${card.sourceClassificationRevision}"><label>Main subject<select name="mainSubject" required><option value="" disabled ${classification === null ? "selected" : ""}>Choose a main subject</option>${options}</select></label><label>Topic<input name="topic" maxlength="120" required value="${escapeHtml(classification?.topic ?? "")}"></label><button class="button secondary" type="submit">Save source classification</button></form></details>`;
  }

  /** @param {HTMLFormElement} form */
  async function correctClassification(form) {
    const values = new FormData(form);
    const result = await gateway.updateSourceClassification({ sourceId: form.dataset.sourceClassification ?? "", sourceRevision: Number(form.dataset.sourceRevision), expectedRevision: Number(form.dataset.revision), mainSubject: String(values.get("mainSubject") ?? ""), topic: String(values.get("topic") ?? "").trim() });
    classificationMessage = result.ok ? "Source classification saved." : result.error.kind === "LearningBatchGatewayRejected" && result.error.failureKind === "SourceClassificationRevisionConflict" ? "This source classification changed elsewhere. Reload the page before editing again." : "Source classification could not be saved. Your changes have not been applied.";
    if (result.ok) await loadFeed(); else onChange();
  }

  function renderReview() {
    if (review.state === "loading" && review.value === null) return feedMarkup(4);
    if (review.state === "error" && review.value === null) return statePanel("Review", friendly(review.error), "retry-learner-review");
    const value = review.value;
    const error = review.error === null ? "" : feedMarkup(20, escapeHtml(friendly(review.error)));
    if (value === null || value.questions.length === 0) return renderDailyGoal("review") + error + feedMarkup(2, renderReviewRefresh());
    return feedMarkup(17, renderDailyGoal("review"), String(value.questions.length), value.questions.length === 1 ? "" : "s", renderReviewRefresh(), error, value.questions.map(renderQuestion).join(""));
  }

  function renderReviewRefresh() {
    const busy = review.state === "loading" || pending.has("review-refresh") || review.value?.questions.some(question => questionPending(question.questionId));
    return feedMarkup(18, `${actionState("review-refresh")} ${busy ? "disabled" : ""}`, actionLabel("review-refresh", "Refresh batch", "Finding questions…"));
  }

  /** @param {LearningReviewQuestion} question */
  function renderQuestion(question) {
    const answer = answers.get(question.questionId);
    const attempt = attempts.get(question.questionId);
    const input = question.kind === "fill-blank"
      ? question.blanks === null ? `<label>Answer<input type="text" name="answerText" autocomplete="off" required value="${escapeHtml(attempt?.answerText ?? "")}"></label>` : question.blanks.map((blank, index) => `<label>Blank ${index + 1}<input type="text" name="blank:${escapeHtml(blank.id)}" autocomplete="off" required value="${escapeHtml(attempt?.blanks[blank.id] ?? "")}"></label>`).join("")
      : feedMarkup(29, escapeHtml(question.prompt), question.choices?.map(choice => `<label><input type="${question.kind === "multiple-choice" ? "checkbox" : "radio"}" name="selectedChoiceIds" value="${escapeHtml(choice.id)}" ${attempt?.selectedChoiceIds.includes(choice.id) ? "checked" : ""}><span>${escapeHtml(choice.label)}</span></label>`).join("") ?? "");
    const completed = review.value?.batch?.status === "completed";
    const actionKey = `review-submit:${question.questionId}`;
    const feedbackKey = `review-feedback:${question.questionId}`;
    const skipKey = `review-skip:${question.questionId}`;
    const busy = questionPending(question.questionId);
    const body = answer === undefined && !completed
      ? `<form data-learner-review data-learner-review-batch="${escapeHtml(review.value?.batch?.batchId ?? "")}" data-learner-review-question="${escapeHtml(question.questionId)}" novalidate ${busy ? 'aria-busy="true"' : ""}>${busy ? input.replaceAll("<input ", "<input disabled ") : input}<button class="button primary" ${actionState(actionKey)} type="submit" ${busy ? "disabled" : ""}>${actionLabel(actionKey, "Check answer", "Checking…")}</button><button class="button quiet" type="button" data-action="skip-review" data-question-id="${escapeHtml(question.questionId)}" ${actionState(skipKey)} ${busy ? "disabled" : ""}>${actionLabel(skipKey, "Skip", "Loading…")}</button></form>`
      : `<p class="answer-feedback ${answer === undefined || answer.skipped ? "" : `is-${answer.correct ? "correct" : "incorrect"}`}" role="status" tabindex="-1" data-focus-key="${escapeHtml(feedbackKey)}" ${celebrations.has(feedbackKey) ? `data-spark-event="${escapeHtml(feedbackKey)}"` : ""}>${answer?.correct ? sparkIcon() : ""}${answer === undefined ? "Answered." : answer.skipped ? "Skipped." : answer.correct ? question.kind === "fill-blank" ? `Correct (${Math.round(answer.score * 100)}%).` : "Correct." : answer.score > 0 ? `Partly correct (${Math.floor(answer.score * 100)}%).` : "Not quite."}</p>`;
    const feedback = answer === undefined || answer.correct ? "" : feedMarkup(27, escapeHtml(answer.correctAnswer), escapeHtml(answer.explanation), escapeHtml(question.sourceAnchorIds.join(", ")));
    return feedMarkup(28, escapeHtml(question.questionId), escapeHtml(question.title), escapeHtml(question.prompt), body, feedback);
  }

  /** @param {string} title @param {string} message @param {string} action @param {"h1"|"h2"} [heading] */
  function statePanel(title, message, action, heading = "h1") { return feedMarkup(5, escapeHtml(title), heading, escapeHtml(message), heading, action); }

  /** @param {HTMLElement} root */
  function bind(root) {
    root.querySelectorAll("[data-spark-event]").forEach(element => {
      if (!(element instanceof HTMLElement)) return;
      const key = element.dataset.sparkEvent ?? "";
      if (!celebrations.delete(key)) return;
      element.removeAttribute("data-spark-event");
      requestAnimationFrame(() => playSpark(element, key.startsWith("review-feedback:") ? "answer" : "preference"));
    });
    root.querySelectorAll("form[data-source-classification]").forEach(form => form.addEventListener("submit", event => { event.preventDefault(); if (form instanceof HTMLFormElement) void correctClassification(form); }));
    root.querySelector("[data-action='retry-learner-feed']")?.addEventListener("click", () => void loadFeed());
    root.querySelector("[data-action='retry-learner-review']")?.addEventListener("click", () => void loadReview());
    root.querySelector("[data-action='refresh-learner-feed']")?.addEventListener("click", () => void refreshFeed());
    root.querySelector("[data-action='complete-learner-feed']")?.addEventListener("click", () => void completeFeed());
    root.querySelector("[data-action='refresh-learner-review']")?.addEventListener("click", () => void refreshReview());
    root.querySelectorAll("[data-action='learner-preference']").forEach((element) => element.addEventListener("click", () => { if (element instanceof HTMLElement) void preference(element); }));
    root.querySelectorAll("[data-action='remove-learner-knowledge']").forEach((element) => element.addEventListener("click", () => { if (element instanceof HTMLElement) void removeKnowledge(element); }));
    root.querySelectorAll("[data-image-zoom]").forEach(button => button.addEventListener("click", () => {
      const source = button.querySelector("img");
      if (!(source instanceof HTMLImageElement)) return;
      const dialog = document.createElement("dialog");
      dialog.className = "image-viewer";
      dialog.setAttribute("aria-label", "Image detail");
      dialog.innerHTML = `<form method="dialog" class="hero-actions"><button class="button secondary" type="button" data-zoom-toggle aria-pressed="false">Zoom in</button><button class="button primary">Close</button></form><div class="image-view"><img src="${escapeHtml(source.src)}" alt="${escapeHtml(source.alt)}"></div>`;
      dialog.querySelector("[data-zoom-toggle]")?.addEventListener("click", event => {
        const zoomed = dialog.classList.toggle("is-zoomed");
        if (event.currentTarget instanceof HTMLElement) {
          event.currentTarget.textContent = zoomed ? "Zoom out" : "Zoom in";
          event.currentTarget.setAttribute("aria-pressed", String(zoomed));
        }
      });
      dialog.addEventListener("close", () => dialog.remove());
      dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
      root.append(dialog);
      dialog.showModal();
    }));
    root.querySelectorAll("img[data-associated-media]").forEach((element) => element.addEventListener("error", () => { element.closest(".card-media")?.remove(); }));
    root.querySelectorAll("[data-action='skip-review']").forEach(button => button.addEventListener("click", () => { if (button instanceof HTMLElement) void skipReview(button); }));
    root.querySelectorAll("[data-learner-review]").forEach((element) => element.addEventListener("submit", (event) => { event.preventDefault(); if (event.currentTarget instanceof HTMLFormElement) void answerReview(event.currentTarget); }));
  }

  return freeze({ loadFeed, loadReview, refreshFeed, refreshDay, renderFeed, renderReview, bind, hasDueReview: () => (review.value?.dueCount ?? 0) > 0 });
}

export {};
