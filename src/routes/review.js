// @ts-check

const freeze = Object.freeze;

/** @import { CatalogCandidate, QuizVersion } from "../features/catalog/contracts.js" */
/** @import { QuestionResponse, Result } from "../features/questions/contracts.js" */
/** @import { RecallAccuracy } from "../features/daily-learning/contracts.js" */

/**
 * @typedef {"today" | "open"} ReviewTab
 */

/**
 * @typedef {{
 *   readonly candidate: CatalogCandidate,
 *   readonly response: string,
 *   readonly submittedAtLabel: string,
 *   readonly matchedConcepts: readonly string[]
 * }} OpenResponseItem
 */

/**
 * @typedef {{
 *   readonly activeTab: ReviewTab,
 *   readonly currentCandidate: CatalogCandidate | null,
 *   readonly currentPosition: number,
 *   readonly totalPrompts: number,
 *   readonly completedPrompts: number,
 *   readonly dailyAccuracy: RecallAccuracy,
 *   readonly sevenDayAccuracy: RecallAccuracy,
 *   readonly openResponses: readonly OpenResponseItem[],
 *   readonly feedback: null | {
 *     readonly promptId: string,
 *     readonly status: "correct" | "incorrect" | "review-required",
 *     readonly message: string
 *   }
 * }} ReviewRouteModel
 */

/**
 * @typedef {{
 *   readonly kind: "ReviewResponseMissing",
 *   readonly field: "answer-choice" | "answer-text"
 * } | {
 *   readonly kind: "ReviewResponseInvalid",
 *   readonly field: "answer-choice" | "answer-text"
 * } | {
 *   readonly kind: "ReviewResponseCountInvalid",
 *   readonly expected: "one" | "one-or-more",
 *   readonly actual: number
 * }} ReviewResponseFailure
 */

/**
 * Render the daily recall route without retaining route or answer state.
 *
 * @param {ReviewRouteModel} model
 * @param {(value: string) => string} escapeHtml
 * @returns {string}
 */
export function renderReviewRoute(model, escapeHtml) {
  const completed = boundedInteger(model.completedPrompts, model.totalPrompts);
  const total = nonNegativeInteger(model.totalPrompts);
  const currentPosition = total === 0
    ? 0
    : Math.min(Math.max(1, nonNegativeInteger(model.currentPosition)), total);
  const progressPercentage = total === 0
    ? 0
    : Math.round((completed / total) * 100);

  return `<section class="review-route wide-view" aria-labelledby="review-title"><div class="section-heading"><div><p class="eyebrow">Active recall</p><h1 id="review-title">Review</h1></div></div><div class="review-tabs" role="tablist" aria-label="Review sections">${
    renderTab("today", "Today's recall", model.activeTab)
  }${
    renderTab(
      "open",
      `Open responses (${model.openResponses.length})`,
      model.activeTab,
    )
  }</div><div class="recall-metrics" aria-label="Recall progress">${
    renderAccuracyMetric(
      "Daily Recall accuracy",
      model.dailyAccuracy,
      escapeHtml,
    )
  }${
    renderAccuracyMetric(
      "7-day Recall accuracy",
      model.sevenDayAccuracy,
      escapeHtml,
    )
  }</div>${
    model.activeTab === "today"
      ? renderTodayPanel(
        model,
        currentPosition,
        completed,
        total,
        progressPercentage,
        escapeHtml,
      )
      : renderOpenResponses(model.openResponses, escapeHtml)
  }</section>`;
}

/**
 * Convert submitted route fields to the grading feature's response contract.
 *
 * Choice controls use `answer-choice`; text controls use `answer-text`.
 *
 * @param {QuizVersion} quiz
 * @param {FormData} formData
 * @returns {Result<QuestionResponse, ReviewResponseFailure>}
 */
export function questionResponseFromFormData(quiz, formData) {
  if (quiz.kind === "single-choice" || quiz.kind === "multiple-choice") {
    const rawChoices = formData.getAll("answer-choice");
    if (rawChoices.length === 0) {
      return {
        ok: false,
        error: { kind: "ReviewResponseMissing", field: "answer-choice" },
      };
    }
    if (rawChoices.some((choice) => typeof choice !== "string")) {
      return {
        ok: false,
        error: { kind: "ReviewResponseInvalid", field: "answer-choice" },
      };
    }
    const selectedChoiceIds = rawChoices
      .filter((choice) => typeof choice === "string")
      .map((choice) => choice.trim());
    if (selectedChoiceIds.some((choice) => choice === "")) {
      return {
        ok: false,
        error: { kind: "ReviewResponseInvalid", field: "answer-choice" },
      };
    }
    const expected = quiz.kind === "single-choice" ? "one" : "one-or-more";
    if (
      (quiz.kind === "single-choice" && selectedChoiceIds.length !== 1) ||
      (quiz.kind === "multiple-choice" && selectedChoiceIds.length < 1)
    ) {
      return {
        ok: false,
        error: {
          kind: "ReviewResponseCountInvalid",
          expected,
          actual: selectedChoiceIds.length,
        },
      };
    }
    return {
      ok: true,
      value: freeze({
        kind: "choice",
        selectedChoiceIds: freeze(selectedChoiceIds),
      }),
    };
  }

  const rawText = formData.get("answer-text");
  if (rawText === null) {
    return {
      ok: false,
      error: { kind: "ReviewResponseMissing", field: "answer-text" },
    };
  }
  if (typeof rawText !== "string" || rawText.trim() === "") {
    return {
      ok: false,
      error: { kind: "ReviewResponseInvalid", field: "answer-text" },
    };
  }
  if (quiz.kind === "fill-blank") {
    return {
      ok: true,
      value: freeze({
        kind: /** @type {const} */ ("fill"),
        blankId: `${quiz.id}:blank-1`,
        text: rawText.trim(),
      }),
    };
  }
  if (quiz.kind === "case-study") {
    return {
      ok: true,
      value: freeze({
        kind: /** @type {const} */ ("case-study"),
        childResponses: freeze([{
          questionId: `${quiz.id}:response`,
          response: freeze({
            kind: /** @type {const} */ ("text"),
            text: rawText.trim(),
          }),
        }]),
      }),
    };
  }
  return {
    ok: true,
    value: freeze({ kind: "text", text: rawText.trim() }),
  };
}

/**
 * @param {ReviewRouteModel} model
 * @param {number} currentPosition
 * @param {number} completed
 * @param {number} total
 * @param {number} progressPercentage
 * @param {(value: string) => string} escapeHtml
 */
function renderTodayPanel(
  model,
  currentPosition,
  completed,
  total,
  progressPercentage,
  escapeHtml,
) {
  return `<div class="review-tab-panel" role="tabpanel" id="review-panel-today" aria-labelledby="review-tab-today"><div class="recall-progress"><div><span>Today's recall</span><strong>${completed} of ${total} answered</strong></div><progress max="${
    Math.max(total, 1)
  }" value="${completed}">${progressPercentage}%</progress></div>${
    model.currentCandidate === null
      ? `<section class="empty-state" aria-live="polite"><h2>Today's recall is complete</h2><p>New prompts will appear after studied material reaches its next recall interval.</p></section>`
      : renderCurrentQuestion(
        model.currentCandidate,
        currentPosition,
        total,
        model.feedback,
        escapeHtml,
      )
  }</div>`;
}

/**
 * @param {CatalogCandidate} candidate
 * @param {number} currentPosition
 * @param {number} total
 * @param {ReviewRouteModel["feedback"]} feedback
 * @param {(value: string) => string} escapeHtml
 */
function renderCurrentQuestion(
  candidate,
  currentPosition,
  total,
  feedback,
  escapeHtml,
) {
  const quiz = candidate.quiz;
  const activeFeedback = feedback?.promptId === quiz.id ? feedback : null;
  return `<article class="review-card" aria-labelledby="review-question-title"><div class="review-question-meta"><span>Question ${currentPosition} of ${total}</span><span>${
    escapeHtml(questionKindLabel(quiz.kind))
  }</span></div><p class="selection-reason">From ${
    escapeHtml(candidate.title)
  }</p>${
    quiz.stimulus === null
      ? ""
      : `<div class="case-stimulus"><span>Case</span><p>${
        escapeHtml(quiz.stimulus)
      }</p></div>`
  }<h2 id="review-question-title">${escapeHtml(quiz.prompt)}</h2>${
    activeFeedback === null
      ? `<form class="review-answer-form" data-review-answer data-prompt-id="${
        escapeHtml(quiz.id)
      }" novalidate>${
        renderAnswerControl(quiz, escapeHtml)
      }<div class="review-answer-actions"><button class="button primary" type="submit">Check answer</button></div><p class="answer-feedback" aria-live="polite"></p></form>`
      : `<div class="review-answer-result"><p class="answer-feedback is-${activeFeedback.status}${
        activeFeedback.status === "correct" ? " animate-confirmation" : ""
      }" aria-live="polite">${
        escapeHtml(activeFeedback.message)
      }</p><button class="button primary" type="button" data-action="next-question">Next question</button></div>`
  }</article>`;
}

/**
 * @param {QuizVersion} quiz
 * @param {(value: string) => string} escapeHtml
 */
function renderAnswerControl(quiz, escapeHtml) {
  if (quiz.kind === "single-choice" || quiz.kind === "multiple-choice") {
    const controlType = quiz.kind === "single-choice" ? "radio" : "checkbox";
    return `<fieldset class="quiz-options"><legend class="sr-only">${
      escapeHtml(quiz.prompt)
    }</legend>${
      quiz.choices.map((
        /** @type {string} */ choice,
        /** @type {number} */ index,
      ) => {
        const choiceId = `${quiz.id}-choice-${index}`;
        return `<label for="${escapeHtml(choiceId)}"><input id="${
          escapeHtml(choiceId)
        }" type="${controlType}" name="answer-choice" value="${
          escapeHtml(String(index))
        }"><span>${escapeHtml(choice)}</span></label>`;
      }).join("")
    }</fieldset>`;
  }

  if (quiz.kind === "fill-blank") {
    return `<label class="text-answer" for="${
      escapeHtml(quiz.id)
    }-answer"><span>Your answer</span><input id="${
      escapeHtml(quiz.id)
    }-answer" name="answer-text" type="text" autocomplete="off" required></label>`;
  }

  return `<label class="text-answer open-answer" for="${
    escapeHtml(quiz.id)
  }-answer"><span>Your response</span><textarea id="${
    escapeHtml(quiz.id)
  }-answer" name="answer-text" rows="7" aria-describedby="${
    escapeHtml(quiz.id)
  }-guidance" required></textarea></label><p class="response-guidance" id="${
    escapeHtml(quiz.id)
  }-guidance">Aim for at least ${
    nonNegativeInteger(quiz.minimumWords)
  } words.</p>`;
}

/**
 * @param {readonly OpenResponseItem[]} items
 * @param {(value: string) => string} escapeHtml
 */
function renderOpenResponses(items, escapeHtml) {
  return `<div class="review-tab-panel" role="tabpanel" id="review-panel-open" aria-labelledby="review-tab-open">${
    items.length === 0
      ? `<section class="empty-state" aria-live="polite"><h2>No responses need review</h2><p>Free responses and case studies that need a decision will appear here.</p></section>`
      : `<div class="open-response-list">${
        items.map((item) =>
          `<article class="open-response-card"><div><p class="selection-reason">Awaiting your review</p><h2>${
            escapeHtml(item.candidate.quiz.prompt)
          }</h2><p>${
            escapeHtml(item.response)
          }</p></div><dl><div><dt>Lesson</dt><dd>${
            escapeHtml(item.candidate.title)
          }</dd></div><div><dt>Submitted</dt><dd>${
            escapeHtml(item.submittedAtLabel)
          }</dd></div><div><dt>Concepts found</dt><dd>${
            item.matchedConcepts.length === 0
              ? "None yet"
              : item.matchedConcepts.map(escapeHtml).join(", ")
          }</dd></div></dl><div class="open-response-actions"><button class="button primary" type="button" data-open-grade="correct" data-prompt-id="${
            escapeHtml(item.candidate.quiz.id)
          }">Mark correct</button><button class="button secondary" type="button" data-open-grade="incorrect" data-prompt-id="${
            escapeHtml(item.candidate.quiz.id)
          }">Mark incorrect</button></div></article>`
        ).join("")
      }</div>`
  }</div>`;
}

/**
 * @param {ReviewTab} tab
 * @param {string} label
 * @param {ReviewTab} activeTab
 */
function renderTab(tab, label, activeTab) {
  const selected = tab === activeTab;
  return `<button id="review-tab-${tab}" role="tab" type="button" data-review-tab="${tab}" aria-selected="${selected}" aria-controls="review-panel-${tab}" tabindex="${
    selected ? "0" : "-1"
  }">${label}</button>`;
}

/**
 * @param {string} label
 * @param {RecallAccuracy} accuracy
 * @param {(value: string) => string} escapeHtml
 */
function renderAccuracyMetric(label, accuracy, escapeHtml) {
  const percentage = accuracy.percentage === null
    ? "—"
    : `${Math.min(100, Math.max(0, Math.round(accuracy.percentage)))}%`;
  const detail = accuracy.total === 0
    ? "No finalized responses"
    : `${nonNegativeInteger(accuracy.correct)} of ${
      nonNegativeInteger(accuracy.total)
    } correct`;
  return `<article class="recall-metric"><span>${
    escapeHtml(label)
  }</span><strong>${percentage}</strong><small>${
    escapeHtml(detail)
  }</small></article>`;
}

/** @param {QuizVersion["kind"]} kind */
function questionKindLabel(kind) {
  switch (kind) {
    case "single-choice":
      return "Single choice";
    case "multiple-choice":
      return "Select all that apply";
    case "fill-blank":
      return "Fill in the blank";
    case "free-response":
      return "Free response";
    case "case-study":
      return "Case study";
    default:
      return "Question";
  }
}

/** @param {number} value */
function nonNegativeInteger(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** @param {number} value @param {number} maximum */
function boundedInteger(value, maximum) {
  return Math.min(nonNegativeInteger(value), nonNegativeInteger(maximum));
}
