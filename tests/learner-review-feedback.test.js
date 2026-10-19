// @ts-check
import { createLearnerController } from "../src/features/learning-generation/learner.js";
import { buildProgress } from "../src/features/progress/public.js";

const shell = Deno.readTextFileSync("index.html");
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  getElementById: (/** @type {string} */ id) => ({ textContent: shell.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`))?.[1] }),
} });
/** @param {unknown} condition @param {string} message */
function assert(condition, message) { if (!condition) throw new Error(message); }

const batch = { batchId: "review:fixture", learningDay: "2026-10-19", status: "open", itemIds: ["fill", "choice"], revision: 1, createdAt: "2026-10-19T00:00:00.000Z", completedAt: null };
const questions = [
  { questionId: "fill", knowledgeId: "k1", title: "Synthetic source", prompt: "The home note is the ____.", kind: "fill-blank", blanks: [{ id: "blank-1" }], choices: null, sourceAnchorIds: ["anchor"], revision: 1 },
  { questionId: "choice", knowledgeId: "k2", title: "Synthetic source", prompt: "Which interval?", kind: "single-choice", blanks: null, choices: [{ id: "a", label: "Tritone" }, { id: "b", label: "Octave" }], sourceAnchorIds: ["anchor"], revision: 1 },
];
const projection = { batch, questions, dueCount: 2 };
const grade = { correct: false, score: 0.4, completed: false, nextDueAt: "2026-10-20T00:00:00.000Z", feedback: { correctAnswer: "tonic", explanation: "The tonic is the home note.", components: [{ id: "blank-1", correct: false, correctAnswer: "tonic" }] } };

class Form {
  /** @param {string} questionId */
  constructor(questionId) { this.dataset = { learnerReviewBatch: batch.batchId, learnerReviewQuestion: questionId }; }
  /** @type {((event: {preventDefault:()=>void,currentTarget:Form})=>void)|null} */ submit = null;
  /** @param {string} _event @param {(event: {preventDefault:()=>void,currentTarget:Form})=>void} callback */
  addEventListener(_event, callback) { this.submit = callback; }
  send() { this.submit?.({ preventDefault() {}, currentTarget: this }); }
}
class Values {
  getAll() { return ["b"]; }
  /** @param {string} name */ get(name) { return name === "blank:blank-1" ? "synthetic response" : null; }
}

/** @param {()=>Promise<void>} run */
async function withForms(run) {
  const originals = ["HTMLFormElement", "FormData"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.defineProperty(globalThis, "HTMLFormElement", { configurable: true, value: Form });
  Object.defineProperty(globalThis, "FormData", { configurable: true, value: Values });
  try { await run(); } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, /** @type {string} */ (key), /** @type {PropertyDescriptor} */ (descriptor));
      else Reflect.deleteProperty(globalThis, /** @type {string} */ (key));
    }
  }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

Deno.test("grading errors appear on the submitted card; retry reveals results that survive route and day reloads", async () => await withForms(async () => {
  let failed = true, refreshFailed = true, replacement = false, reviewReads = 0;
  /** @type {string|null|undefined} */ let focus;
  const controller = createLearnerController({
    fetch: async (input, init) => {
      const path = String(input);
      if (path.endsWith("/answer")) return failed ? Response.json({ error: "ReviewGradingUnavailable" }, { status: 503 }) : Response.json({ result: JSON.parse(String(init?.body)).questionId === "choice" ? { ...grade, correct: true, score: 1, completed: true } : grade });
      if (path.endsWith("/refresh")) {
        if (refreshFailed) return Response.json({ error: "LearningBatchPersistenceFailed" }, { status: 503 });
        replacement = true; return Response.json({ result: { ...projection, batch: { ...batch, batchId: "review:next" } } });
      }
      if (path.includes("feed-batch")) return Response.json({ result: { batch: null, items: [] } });
      reviewReads++;
      // The server omits answered questions on a subsequent GET.
      return Response.json({ result: reviewReads > 1 ? { ...projection, questions: [questions[1]] } : projection });
    },
    baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: value => value,
    now: () => "2026-10-19T12:00:00.000Z", createId: () => "fixture", onChange: (_message, key) => { focus = key; },
  });
  await controller.loadReview();
  const form = new Form("fill");
  /** @type {()=>void} */ let refresh = () => {};
  controller.bind(/** @type {HTMLElement} */ (/** @type {unknown} */ ({
    querySelector: () => ({ addEventListener: (/** @type {string} */ _event, /** @type {()=>void} */ callback) => { refresh = callback; } }),
    querySelectorAll: (/** @type {string} */ selector) => selector === "[data-learner-review]" ? [form] : [],
  })));
  form.send(); await tick();
  let html = controller.renderReview();
  const card = html.slice(html.indexOf('data-review-question="fill"'), html.indexOf('data-review-question="choice"'));
  assert(card.includes('role="alert"') && card.includes("Answer checking is temporarily unavailable"), "Submission failure must be visible inside the affected card.");
  assert(focus === "review-submit:fill" && card.includes('value="synthetic response"'), "Focus returns to the retry action beside the error, preserving the response.");
  failed = false; form.send(); await tick();
  html = controller.renderReview();
  assert(html.includes("Partly correct (40%).") && html.includes("Correct answer:</strong> tonic"), "Successful retry reveals the score and correction.");
  assert(!html.includes("Answer checking is temporarily unavailable"), "Retry clears its previous error.");
  await controller.loadReview(); await controller.refreshDay();
  assert(reviewReads === 1 && controller.renderReview().includes("Partly correct (40%)."), "Navigation and automatic refresh retain answered cards and their results.");
  form.dataset.learnerReviewQuestion = "choice"; form.send(); await tick();
  html = controller.renderReview();
  assert(html.includes("Partly correct (40%).") && html.includes("Correct."), "Completing the batch retains both results.");
  await controller.loadReview();
  refresh(); await tick();
  assert(controller.renderReview().includes("Partly correct (40%).") && controller.renderReview().includes("Correct."), "A failed manual refresh retains both results.");
  refreshFailed = false;
  refresh(); await tick();
  assert(replacement && !controller.renderReview().includes("Partly correct") && controller.renderReview().includes('data-learner-review-batch="review:next"'), "An explicit batch refresh clears previous results.");
}));

Deno.test("successful grading renders before a slow progress request completes", async () => await withForms(async () => {
  const progress = buildProgress({ days: 7, now: "2026-10-19T12:00:00.000Z", subject: null, attempts: [], studies: [] });
  assert(progress.ok, "Synthetic progress is valid.");
  if (!progress.ok) return;
  let deferProgress = false, renderedFeedback = false;
  /** @type {(response:Response)=>void} */ let settle = () => {};
  const controller = createLearnerController({
    fetch: async input => String(input).includes("/progress?")
      ? deferProgress ? await new Promise(resolve => { settle = resolve; }) : Response.json({ result: progress.value })
      : Response.json({ result: String(input).endsWith("/answer") ? grade : projection }),
    baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: value => value,
    now: () => "2026-10-19T12:00:00.000Z", createId: () => "fixture", getDailyTargets: () => ({ learning: 5, review: 5 }),
    onChange: (_message, key) => { if (key === "review-feedback:fill") renderedFeedback = true; },
  });
  await controller.loadReview(); deferProgress = true;
  const form = new Form("fill");
  controller.bind(/** @type {HTMLElement} */ (/** @type {unknown} */ ({ querySelector: () => null, querySelectorAll: (/** @type {string} */ selector) => selector === "[data-learner-review]" ? [form] : [] })));
  form.send(); await tick();
  assert(renderedFeedback && controller.renderReview().includes("Correct answer:</strong> tonic"), "Grading feedback must not wait for daily progress.");
  settle(Response.json({ result: progress.value })); await tick();
}));
