
const shell = Deno.readTextFileSync("index.html");
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  getElementById: (/** @type {string} */ id) => {
    const content = shell.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`))?.[1];
    return content === undefined ? null : { textContent: content };
  },
} });
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
    const controller = createLearnerController({ fetch: async () => response({ result: { batch: { ...review.batch, batchId: "feed:a", itemIds: ["knowledge-1"] }, items: [{ knowledgeId: "knowledge-1", sourceId: "source-1", sourceRevision: 1, sourceClassification: null, sourceClassificationRevision: 0, questionId: "question-1", title: "Source", summary: "A useful relationship.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["page:1"], media, questionLocked: true }] } }), baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: (value) => value, now: () => "2026-09-08T00:00:00.000Z", createId: () => "test", onChange: () => {} });
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
  const controller = createLearnerController({ fetch: async () => response({ result: { batch: { ...review.batch, batchId: "feed:image", itemIds: ["knowledge-1"] }, items: [{ knowledgeId: "knowledge-1", sourceId: "source-1", sourceRevision: 1, sourceClassification: null, sourceClassificationRevision: 0, questionId: "question-1", title: "Source", summary: "A diagram-backed relationship.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["page:1"], media: { assetId: "media-1", kind: "image", url: "/api/knowledge-workflows/media/media-1?variant=feed", attribution: "Source page diagram" }, questionLocked: true }] } }), baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: (value) => value, now: () => "2026-09-08T00:00:00.000Z", createId: () => "test", onChange: () => {} });
  await controller.loadFeed();
  const html = controller.renderFeed();
  assert(html.includes("data-associated-media=\"true\""), "Associated source media must render.");
  assert(!html.includes("data-fallback-src"), "Unrelated fallback must never be declared.");
  assert(html.includes('alt="Source page diagram"') && !html.includes("<figcaption"), "Images keep accessible attribution without the removed supportive caption.");
  assert(html.includes('data-image-zoom') && html.includes('aria-label="Enlarge image"'), "Associated images offer a keyboard accessible larger view.");
  assert(html.includes('data-remove-target="image"') && html.includes('data-remove-target="knowledge"') && html.includes('<summary class="button quiet"'), "Remove expands into image-only and knowledge-point choices.");
  assert(html.indexOf('card-knowledge') < html.indexOf('card-media') && html.indexOf('card-media') < html.indexOf('card-source'), "Associated media must support the knowledge before its source, not lead the page.");
});

Deno.test("Feed keeps associated image attribution accessible without supportive captions", async () => {
  for (const purpose of [undefined, "evidence", "illustration"]) {
    const media = { assetId: "media-1", kind: "image", url: "/api/learning-media?assetId=media-1&variant=feed", attribution: "Source page image", ...(purpose === undefined ? {} : { purpose }) };
    const card = { knowledgeId: "knowledge-1", sourceId: "source-1", sourceRevision: 1, sourceClassification: null, sourceClassificationRevision: 0, questionId: "question-1", title: "Source", summary: "A text-supported relationship.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["page:1"], media, questionLocked: true };
    const controller = createLearnerController({ fetch: async () => response({ result: { batch: { ...review.batch, batchId: "feed:illustration", itemIds: [card.knowledgeId] }, items: [card] } }), baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: (value) => value, now: () => "2026-09-08T00:00:00.000Z", createId: () => "test", onChange: () => {} });
    await controller.loadFeed();
    const html = controller.renderFeed();
    assert(html.includes('data-associated-media="true"'), "Approved source images remain visible.");
    assert(html.includes('alt="Source page image"') && html.includes('class="card-source"'), "Accessible attribution and the source link remain available.");
    assert(!html.includes("<figcaption") && !html.includes("Illustration — facts are supported by the source text"), "Supportive captions are removed for all image purposes.");
  }
});

Deno.test("Feed source editor exposes only main subject dropdown and free-text topic", async () => {
  const card = { knowledgeId: "knowledge-1", sourceId: "source-1", sourceRevision: 3, sourceClassificationRevision: 2, sourceClassification: { mainSubject: "music", topic: "Cadential harmony" }, questionId: "question-1", title: "Source", summary: "A useful relationship.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["page:1"], media: null, questionLocked: true };
  const controller = createLearnerController({ fetch: async () => response({ result: { batch: { ...review.batch, batchId: "feed:source-edit", itemIds: ["knowledge-1"] }, items: [card] } }), baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: (value) => value, now: () => "2026-09-08T00:00:00.000Z", createId: () => "test", onChange: () => {} });
  const loaded = await controller.loadFeed();
  assert(loaded.ok, "The source-level classification projection must load.");
  const html = controller.renderFeed();
  const editor = html.slice(html.indexOf("<form class=\"classification-form\""), html.indexOf("</form>") + 7);
  assert(editor.includes('name="mainSubject"') && editor.includes("<select"), "Main subject remains one dropdown.");
  assert(editor.includes('name="topic"') && editor.includes("<input"), "Topic remains free text.");
  assert((editor.match(/<select\b/gu) ?? []).length === 1 && (editor.match(/<input\b/gu) ?? []).length === 1, "Exactly two editable fields appear.");
  assert(!/name="(?:secondary|subcategory|primarySubject)"/iu.test(editor), "Per-point taxonomy fields are absent.");
});

Deno.test("Feed displays topic beneath subject separately from the classification editor", async () => {
  const items = [
    { knowledgeId: "knowledge-1", sourceId: "source-1", sourceRevision: 3, sourceClassificationRevision: 2, sourceClassification: { mainSubject: "music", topic: "Cadential harmony" }, questionId: "question-1", title: "Classified source", summary: "A useful relationship.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["page:1"], media: null, questionLocked: true },
    { knowledgeId: "knowledge-2", sourceId: "source-2", sourceRevision: 1, sourceClassificationRevision: 0, sourceClassification: null, questionId: "question-2", title: "Unclassified source", summary: "Another relationship.", sourceUrl: "https://example.test/other", evidenceAnchorIds: ["page:2"], media: null, questionLocked: true },
  ];
  const controller = createLearnerController({ fetch: async () => response({ result: { batch: { ...review.batch, batchId: "feed:classification", itemIds: items.map((item) => item.knowledgeId) }, items } }), baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: (value) => value, now: () => "2026-09-08T00:00:00.000Z", createId: () => "test", onChange: () => {} });
  await controller.loadFeed();
  const html = controller.renderFeed();
  const classified = html.slice(html.indexOf('data-knowledge-id="knowledge-1"'), html.indexOf("</article>"));
  assert(classified.indexOf('class="card-subject"') < classified.indexOf("<p>Cadential harmony</p>") && classified.indexOf("<p>Cadential harmony</p>") < classified.indexOf('Edit source classification'), "Classified card order must be subject, separate topic, then editor action.");
  assert(classified.includes("<p>Cadential harmony</p>"), "The existing topic must display as its own card field.");
  assert(classified.includes("<summary>Edit source classification</summary>"), "The disclosure summary must be an action, not the topic.");
  const unclassified = html.slice(html.indexOf('data-knowledge-id="knowledge-2"'), html.indexOf("</article>", html.indexOf('data-knowledge-id="knowledge-2"')));
  assert(unclassified.includes("Unclassified") && !unclassified.includes("Cadential harmony") && unclassified.includes("</p><div class=\"card-context\">"), "An unclassified card keeps its subject label without a standalone topic.");
  assert(unclassified.includes('name="topic"'), "Topic remains editable in the existing editor.");
});

Deno.test("completed Feed replaces study action with one Review continuation", async () => {
  const controller = createLearnerController({ fetch: async () => response({ result: { batch: { ...review.batch, batchId: "feed:done", status: "completed", completedAt: "2026-09-01T12:00:00.000Z", itemIds: ["knowledge-1"] }, items: [{ knowledgeId: "knowledge-1", sourceId: "source-1", sourceRevision: 1, sourceClassification: null, sourceClassificationRevision: 0, questionId: "question-1", title: "Source", summary: "A useful relationship.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["page:1"], media: null, questionLocked: false }] } }), baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: (value) => value, now: () => "2026-09-08T00:00:00.000Z", createId: () => "test", onChange: () => {} });
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

Deno.test("Review renders exactly one keyboard-operable choice and one fill-blank variant without answer keys", async () => {
  const paired = { ...review, questions: [{ ...review.questions[0], pairedVariants: [
    { id: "choice-v1", kind: "single-choice", prompt: "Which interval spans six semitones?", choices: [{ id: "tritone", label: "Tritone" }, { id: "octave", label: "Octave" }], blanks: null },
    { id: "fill-v1", kind: "fill-blank", prompt: "A six-semitone interval is a ____.", choices: null, blanks: [{ id: "blank-1" }] },
  ] }] };
  const controller = createLearnerController({ fetch: async () => response({ result: paired }), baseUrl: "https://app.example.test/", timeoutMs: 1_000, escapeHtml: (value) => value, now: () => "2026-09-01T12:00:00.000Z", createId: () => "id-1", onChange: () => {} });
  const loaded = await controller.loadReview();
  assert(loaded.ok, "The answer-hidden server pair must load.");
  const html = controller.renderReview();
  assert((html.match(/<fieldset\b/gu) ?? []).length === 2, "The learner must see exactly two separately labelled variant groups.");
  assert(html.includes("Which interval spans six semitones?"), "The MCQ prompt must be visible.");
  assert(html.includes("A six-semitone interval is a ____.") && html.includes("Blank 1"), "The fill-blank prompt and distinct blank label must be visible.");
  assert(html.includes('type="radio" name="selectedChoiceIds"') && html.includes('name="pairedBlank:blank-1" size="28"'), "Single-choice and comfortably sized typed responses must use native controls.");
  assert(html.includes("Check both answers"), "The pair is submitted together.");
  assert(!html.includes("correctChoiceIds") && !html.includes("acceptedAnswers") && !html.includes("A tritone spans six semitones."), "No grading key or explanation may appear before an attempt.");
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

Deno.test("Empty Feed and Review offer artwork and a next action without invented learning content", async () => {
  const controller = createLearnerController({ fetch: async () => response({ result: { batch: null, items: [], questions: [], dueCount: 0 } }), baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: value => value, now: () => "2026-10-14T00:00:00.000Z", createId: () => "empty", onChange: () => {} });
  await controller.loadFeed();
  await controller.loadReview();
  const feed = controller.renderFeed(), review = controller.renderReview();
  assert(feed.includes("empty-states.svg#feed") && feed.includes('href="#discover"') && !feed.includes('data-knowledge-id'), "Empty Feed uses its own artwork and guides discovery without sample cards.");
  assert(review.includes("empty-states.svg#review") && review.includes('href="#feed"') && !review.includes('data-question-id'), "Empty Review guides study without sample questions.");
});

Deno.test("preference motion follows actual settlement, rejects duplicate pending clicks and consumes success once", async () => {
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const originalFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  class Button {
    /** @type {Record<string, string>} */ dataset = { knowledgeId: "knowledge-1", preference: "more", sparkEvent: "preference:knowledge-1:more" };
    /** @type {Map<string, () => void>} */ listeners = new Map();
    /** @param {string} type @param {() => void} listener */
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeAttribute() { delete this.dataset.sparkEvent; }
  }
  /** @type {FrameRequestCallback[]} */ const frames = [];
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: Button });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (/** @type {FrameRequestCallback} */ callback) => frames.push(callback) });
  try {
    /** @type {(response:Response) => void} */ let settle = () => { throw new Error("No pending request"); };
    let requests = 0;
    let changed = () => {};
    const card = { knowledgeId: "knowledge-1", sourceId: "source-1", sourceRevision: 1, sourceClassification: null, sourceClassificationRevision: 0, questionId: "question-1", title: "Source", summary: "A useful relationship.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["page:1"], media: null, questionLocked: true };
    const controller = createLearnerController({ fetch: async (_url, init) => {
      if (init?.method === "GET") return response({ result: { batch: { ...review.batch, batchId: "feed:motion" }, items: [card] } });
      requests++;
      return await new Promise(resolve => { settle = resolve; });
    }, baseUrl: "https://app.example.test/", timeoutMs: 1000, escapeHtml: value => value, now: () => "2026-10-15T00:00:00.000Z", createId: () => "motion", onChange: () => changed() });
    await controller.loadFeed();
    const button = new Button();
    /** @type {Button[]} */ let events = [];
    const root = /** @type {HTMLElement} */ (/** @type {unknown} */ ({ querySelector: () => null, querySelectorAll: (/** @type {string} */ selector) => selector === "[data-spark-event]" ? events : selector === "[data-action='learner-preference']" ? [button] : [] }));
    controller.bind(root);
    button.listeners.get("click")?.();
    button.listeners.get("click")?.();
    assert(requests === 1, "A pending action must send only one request.");
    assert(controller.renderFeed().includes('aria-busy="true"') && !controller.renderFeed().includes('data-spark-event='), "Pending is real request state, never success.");
    let completed = new Promise(resolve => { changed = () => resolve(undefined); });
    settle(response({ result: { saved: true } }));
    await completed;
    assert(controller.renderFeed().includes('data-spark-event="preference:knowledge-1:more"'), "Only a settled success schedules a celebration.");
    events = [button];
    controller.bind(root);
    controller.bind(root);
    assert(frames.length === 1 && !controller.renderFeed().includes('data-spark-event='), "Rerender/bind must not repeat a consumed success.");
    events = [];
    button.listeners.get("click")?.();
    completed = new Promise(resolve => { changed = () => resolve(undefined); });
    settle(new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 }));
    await completed;
    assert(!controller.renderFeed().includes('data-spark-event=') && !controller.renderFeed().includes('aria-busy="true"') && controller.renderFeed().includes('role="alert"'), "Failure must clear pending, expose the error and never celebrate.");
  } finally {
    if (originalElement) Object.defineProperty(globalThis, "HTMLElement", originalElement); else Reflect.deleteProperty(globalThis, "HTMLElement");
    if (originalFrame) Object.defineProperty(globalThis, "requestAnimationFrame", originalFrame); else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  }
});
