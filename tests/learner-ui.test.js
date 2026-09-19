// @ts-check

import { createLearnerController } from "../src/features/learning-generation/learner.js";

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {unknown} body */
function response(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const review = {
  batch: {
    batchId: "review:music",
    learningDay: "2026-09-01",
    status: "open",
    itemIds: ["question-1"],
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    completedAt: null,
  },
  questions: [{
    questionId: "question-1",
    knowledgeId: "knowledge-1",
    title: "Open Music Theory",
    prompt: "Which interval spans six semitones?",
    kind: "single-choice",
    choices: [{ id: "choice-1", label: "Tritone" }, { id: "choice-2", label: "Octave" }],
    sourceAnchorIds: ["anchor-1"],
    revision: 1,
  }],
  dueCount: 1,
};

Deno.test("Feed is text-only without associated media and hides legacy fallback images", async () => {
  for (const media of [null, { assetId: "old-fallback", kind: "image", url: "/assets/fallback-media/old.png", attribution: "User-attested local fallback" }]) {
    const controller = createLearnerController({ fetch: async () => response({ result: { batch: { ...review.batch, batchId: "feed:a", itemIds: ["knowledge-1"] }, items: [{ knowledgeId: "knowledge-1", sourceId: "source-1", questionId: "question-1", title: "Source", summary: "A useful relationship.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["page:1"], media, questionLocked: true }] } }), baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: (value) => value, now: () => "2026-09-08T00:00:00.000Z", createId: () => "test", onChange: () => {} });
    await controller.loadFeed();
    const html = controller.renderFeed();
    assert(html.includes("A useful relationship."), "Text must remain visible.");
    const card = html.slice(html.indexOf('<article class="learning-card"'));
    assert(card.indexOf('card-knowledge') < card.indexOf('card-source') && card.indexOf('card-source') < card.indexOf('card-subject'), "Reading order must be knowledge, source, then subject.");
    assert(!html.includes('session-panel') && !html.includes('progress-bridge'), "Completion must not repeat competing panels.");
    assert(html.includes('Mark batch studied') && !html.includes('data-view="review"'), "Open batch must retain explicit completion before the Review continuation.");
    assert(!html.includes("<img") && !html.includes("card-media") && !html.includes("source-icon-fallback") && !html.includes("card-visual"), "Unassociated fallback must not render.");
  }
});

Deno.test("Feed renders an associated source image without an unrelated fallback", async () => {
  const controller = createLearnerController({ fetch: async () => response({ result: { batch: { ...review.batch, batchId: "feed:image", itemIds: ["knowledge-1"] }, items: [{ knowledgeId: "knowledge-1", sourceId: "source-1", questionId: "question-1", title: "Source", summary: "A diagram-backed relationship.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["page:1"], media: { assetId: "media-1", kind: "image", url: "/api/knowledge-workflows/media/media-1?variant=feed", attribution: "Source page diagram" }, questionLocked: true }] } }), baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: (value) => value, now: () => "2026-09-08T00:00:00.000Z", createId: () => "test", onChange: () => {} });
  await controller.loadFeed();
  const html = controller.renderFeed();
  assert(html.includes("data-associated-media=\"true\""), "Associated source media must render.");
  assert(!html.includes("data-fallback-src"), "Unrelated fallback must never be declared.");
  assert(html.includes("Source page diagram"), "Media attribution must remain visible.");
  assert(html.indexOf('card-knowledge') < html.indexOf('card-media') && html.indexOf('card-media') < html.indexOf('card-source'), "Associated media must support the knowledge before its source, not lead the page.");
});

Deno.test("completed Feed replaces study action with one Review continuation", async () => {
  const controller = createLearnerController({ fetch: async () => response({ result: { batch: { ...review.batch, batchId: "feed:done", status: "completed", completedAt: "2026-09-01T12:00:00.000Z", itemIds: ["knowledge-1"] }, items: [{ knowledgeId: "knowledge-1", sourceId: "source-1", questionId: "question-1", title: "Source", summary: "A useful relationship.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["page:1"], media: null, questionLocked: false }] } }), baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: (value) => value, now: () => "2026-09-08T00:00:00.000Z", createId: () => "test", onChange: () => {} });
  await controller.loadFeed();
  const html = controller.renderFeed();
  assert(!html.includes('data-action="complete-learner-feed"'), "Completed batch must not offer another study write.");
  assert(html.split('data-view="review"').length === 2, "Exactly one closing Review continuation must be available.");
  assert(html.includes('data-action="refresh-learner-feed"'), "Completed batch retains refresh.");
});

Deno.test("Review renders the paired quiz prompt, not the knowledge-card summary", async () => {
  const knowledgeSummary = "This knowledge card explains ordered pitch intervals and interval classes in detail.";
  const controller = createLearnerController({
    fetch: async () => response({ result: review }),
    baseUrl: "https://app.example.test/",
    timeoutMs: 1_000,
    escapeHtml: (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
    now: () => "2026-09-01T12:00:00.000Z",
    createId: () => "id-1",
    onChange: () => {},
  });
  const loaded = await controller.loadReview();
  assert(loaded.ok, "Review must accept a valid paired-question projection.");
  const html = controller.renderReview();
  assert(html.includes("Which interval spans six semitones?"), "Review must render the quiz prompt.");
  assert(html.includes("Tritone") && html.includes("Octave"), "Review must render the quiz answer choices.");
  assert(html.includes("Paired with Open Music Theory"), "Review must identify the quiz's source context.");
  assert(!html.includes(knowledgeSummary), "Review must not render the knowledge-card summary.");
  assert(!html.includes("The source defines the interval class"), "Review must not render an explanation before an answer.");
  assert(html.includes("data-review-question=\"question-1\""), "Review must render the paired question container.");
  assert(!html.includes('name="confidence"'), "Review must not collect confidence.");
});

Deno.test("Review renders ordered blank inputs without revealing answers", async () => {
  const multi = { ...review, questions: [{ ...review.questions[0], prompt: "A ____ resolves to the ____.", kind: "fill-blank", choices: null, blanks: [{ id: "blank-1" }, { id: "blank-2" }] }] };
  const controller = createLearnerController({ fetch: async () => response({ result: multi }), baseUrl: "https://app.example.test/", timeoutMs: 1_000, escapeHtml: (value) => value, now: () => "2026-09-01T12:00:00.000Z", createId: () => "id-1", onChange: () => {} });
  const loaded = await controller.loadReview();
  assert(loaded.ok, "Review must accept ordered blank definitions.");
  const html = controller.renderReview();
  assert(html.includes('name="blank:blank-1"') && html.includes('name="blank:blank-2"'), "Both blanks need accessible inputs.");
  assert(html.includes("Blank 1") && html.includes("Blank 2"), "Each input needs a distinct label.");
  assert(!html.includes("dominant") && !html.includes("tonic"), "The pre-attempt view must not reveal answers.");
});

Deno.test("Review empty state contains no knowledge-card content", async () => {
  const controller = createLearnerController({
    fetch: async () => response({ result: { batch: null, questions: [], dueCount: 0 } }),
    baseUrl: "https://app.example.test/",
    timeoutMs: 1_000,
    escapeHtml: (value) => value,
    now: () => "2026-09-01T12:00:00.000Z",
    createId: () => "id-1",
    onChange: () => {},
  });
  const loaded = await controller.loadReview();
  assert(loaded.ok, "Review must accept an empty due-question projection.");
  const html = controller.renderReview();
  assert(html.includes("No questions are due"), "Review must show its empty quiz state.");
  assert(!html.includes("knowledge-card") && !html.includes("Knowledge card"), "Review empty state must not present knowledge cards.");
});

Deno.test("Feed completion is not triggered by an intersection observer", async () => {
  const source = await Deno.readTextFile(new URL("../src/features/learning-generation/learner.js", import.meta.url));
  assert(!source.includes("IntersectionObserver"), "Feed completion must remain an explicit learner action.");
  assert(source.includes("data-action='complete-learner-feed'"), "Feed must retain its explicit completion action.");
});
