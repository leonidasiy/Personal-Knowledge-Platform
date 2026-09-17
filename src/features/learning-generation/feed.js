// @ts-check

import { LearningGenerationBrowserGatewayClient } from "./browser-gateway.js";

/** @import { LearningPublishedQuiz } from "./browser-gateway.js" */

/**
 * @typedef {{
 *   readonly fetch: typeof fetch,
 *   readonly baseUrl: string,
 *   readonly timeoutMs: number,
 *   readonly escapeHtml: (value: string) => string,
 *   readonly onChange: () => void
 * }} GeneratedQuizControllerDependencies
 */

const freeze = Object.freeze;

/** @param {GeneratedQuizControllerDependencies} dependencies */
export function createGeneratedQuizController(dependencies) {
  if (typeof dependencies?.fetch !== "function" || !URL.canParse(dependencies.baseUrl) || !Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || typeof dependencies.escapeHtml !== "function" || typeof dependencies.onChange !== "function") throw new TypeError("Generated quiz controller dependencies are invalid.");
  const gateway = new LearningGenerationBrowserGatewayClient({ fetch: dependencies.fetch, baseUrl: dependencies.baseUrl, timeoutMs: dependencies.timeoutMs });
  /** @type {readonly LearningPublishedQuiz[]} */ let quizzes = [];
  /** @type {"idle" | "loading" | "success" | "error"} */ let state = "idle";
  /** @type {Promise<void> | null} */ let loadPromise = null;
  /** @type {Map<string, string>} */ const feedback = new Map();

  function render() {
    if (state === "loading") return `<section class="wide-view state-panel" role="status" aria-busy="true"><p class="eyebrow">Generated learning</p><h2>Loading new quizzes</h2><p>Checking the questions published from your approved sources.</p></section>`;
    if (state === "error") return `<section class="wide-view state-panel" role="alert"><p class="eyebrow">Generated learning</p><h2>New quizzes could not load</h2><p>Refresh the Feed to check your published source questions again.</p><button class="button secondary" type="button" data-action="refresh-generated-quizzes">Refresh quizzes</button></section>`;
    if (quizzes.length === 0) return "";
    return `<section class="wide-view generated-quiz-feed" aria-labelledby="generated-quiz-title"><div class="section-heading"><div><p class="eyebrow">From your sources</p><h2 id="generated-quiz-title">New generated quizzes</h2></div><button class="button secondary" type="button" data-action="refresh-generated-quizzes">Refresh quizzes</button></div><div class="feed-stack">${quizzes.map(renderQuiz).join("")}</div></section>`;
  }

  /** @param {LearningPublishedQuiz} quiz */
  function renderQuiz(quiz) {
    const choices = quiz.choices === null || quiz.correctChoiceIds === null
      ? `<h3>${dependencies.escapeHtml(quiz.prompt)}</h3><p>This open-response question is ready for review in the Library queue.</p>`
      : `<fieldset><legend>${dependencies.escapeHtml(quiz.prompt)}</legend><div class="quiz-options">${quiz.choices.map((choice) => `<label><input type="${quiz.kind === "multiple-choice" ? "checkbox" : "radio"}" name="generated-answer-${dependencies.escapeHtml(quiz.id)}" value="${dependencies.escapeHtml(choice.id)}"><span>${dependencies.escapeHtml(choice.label)}</span></label>`).join("")}</div></fieldset><button class="button primary" type="submit">Check answer</button>`;
    return `<article class="learning-card generated-quiz-card"><form data-generated-quiz="${dependencies.escapeHtml(quiz.id)}"><div class="card-body"><p class="eyebrow">Generated ${dependencies.escapeHtml(quiz.kind)} quiz</p>${choices}<details class="source-details"><summary>Why this question is here</summary><p>${dependencies.escapeHtml(quiz.explanation)}</p><p>Evidence anchors: ${dependencies.escapeHtml(quiz.sourceAnchorIds.join(", "))}</p></details><p class="answer-feedback" aria-live="polite">${dependencies.escapeHtml(feedback.get(quiz.id) ?? "")}</p></div></form></article>`;
  }

  /** @param {boolean} reload @returns {Promise<void>} */
  async function load(reload = false) {
    if (!reload && loadPromise !== null) return await loadPromise;
    state = "loading";
    dependencies.onChange();
    const run = (async () => {
      const result = await gateway.listPublished();
      if (!result.ok) {
        quizzes = [];
        state = "error";
        return;
      }
      quizzes = [...result.value];
      state = "success";
    })().finally(() => {
      loadPromise = null;
      dependencies.onChange();
    });
    loadPromise = run;
    return await run;
  }

  /** @param {HTMLFormElement} form */
  function answerGeneratedQuiz(form) {
    const quiz = quizzes.find((candidate) => candidate.id === form.dataset.generatedQuiz);
    if (quiz === undefined || quiz.correctChoiceIds === null) return;
    const selected = new FormData(form).getAll(`generated-answer-${quiz.id}`).filter((value) => typeof value === "string");
    if (selected.length === 0) {
      feedback.set(quiz.id, "Choose an answer first.");
    } else {
      const expected = [...quiz.correctChoiceIds].sort();
      const actual = /** @type {string[]} */ (selected).sort();
      feedback.set(quiz.id, JSON.stringify(actual) === JSON.stringify(expected) ? "Correct. This matches the generated answer." : "Not quite. Revisit the source evidence and try again.");
    }
  }

  return Object.freeze({ render, load, answer: answerGeneratedQuiz });
}

export {};
