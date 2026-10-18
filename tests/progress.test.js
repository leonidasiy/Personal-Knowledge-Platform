// @ts-check
const shell = Deno.readTextFileSync("index.html");
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  getElementById: (/** @type {string} */ id) => ({ textContent: shell.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`))?.[1] ?? "" }),
} });
import { buildProgress, isProgressSummary } from "../src/features/progress/public.js";
import { createProgressPage } from "../src/features/progress/page.js";

/** @param {boolean} value @param {string} message */ const assert = (value, message) => { if (!value) throw new Error(message); };
const now = "2026-09-19T12:00:00.000Z";
const attempt = Object.freeze({ batchId: "b", questionId: "q", knowledgeId: null, answeredAt: now, correct: true, score: 1, elapsedDays: 2, previousCorrect: false, primarySubject: "music" });
/** @param {Partial<Record<string,unknown>>} overrides */ const input = overrides => ({ days: 7, now, subject: null, attempts: [attempt], studies: [{ completedAt: now, itemCount: 5 }], subjectCounts: [{ id: "music", count: 1 }], ...overrides });
Deno.test("progress aggregates current UTC day, fractions, recovery, and primary subjects", () => { const result = buildProgress(input({ attempts: [attempt, { ...attempt, batchId: "b2", questionId: "q2", correct: false, score: null, elapsedDays: null, previousCorrect: null, primarySubject: null }] })); assert(result.ok, "valid input"); if (!result.ok) return; assert(result.value.attempts.accuracy === .5 && result.value.attempts.averageScore === 1 && result.value.attempts.scoredCount === 1, "separate score"); assert(result.value.daily.at(-1)?.date === "2026-09-19", "current day"); assert(result.value.recovery.accuracy === 1, "recovery"); assert(result.value.subjects.find(s => s.id === "music")?.count === 1, "primary only"); assert(result.value.intervals.at(-1)?.count === 1, "missing interval"); });
Deno.test("progress distinguishes empty denominators and rejects invalid data", () => { const empty = buildProgress(input({ attempts: [], studies: [] })); assert(empty.ok && empty.value.attempts.accuracy === null && empty.value.daily[0].accuracy === null, "empty nulls"); for (const bad of [input({ days: 8 }), input({ attempts: [{ ...attempt, confidence: 80 }] }), input({ attempts: [{ ...attempt, primarySubject: "nope" }] }), input({ studies: [{ completedAt: now, itemCount: 6 }] })]) assert(!buildProgress(bad).ok, "invalid rejected"); });
Deno.test("progress deduplicates identical attempts and rejects same batch/question conflicts", () => { const duplicate = buildProgress(input({ attempts: [attempt, { ...attempt }] })); assert(duplicate.ok && duplicate.value.attempts.count === 1, "identical dedupe"); const conflict = buildProgress(input({ attempts: [attempt, { ...attempt, answeredAt: "2026-09-19T11:00:00.000Z" }] })); assert(!conflict.ok && conflict.error.field.endsWith("duplicate"), "timestamp conflict"); });
Deno.test("progress rejects invalid scores and excludes future records", () => { assert(!buildProgress(input({ attempts: [{ ...attempt, score: .5, correct: true }] })).ok, "score consistency"); const future = buildProgress(input({ attempts: [{ ...attempt, answeredAt: "2026-09-19T23:00:00.000Z" }] })); assert(future.ok && future.value.attempts.count === 0, "future excluded"); });
Deno.test("progress accepts composed workflow identifiers and still rejects empty or padded identifiers", () => {
  const knowledgeId = `knowledge:source:${"a".repeat(64)}:1:${"b".repeat(64)}`;
  const questionId = `knowledge-workflow-task:run:${knowledgeId}:${knowledgeId}:choice`;
  const result = buildProgress(input({ attempts: [{ ...attempt, knowledgeId, questionId }] }));
  assert(questionId.length > 200, "Fixture covers workflow identifiers beyond the former limit");
  assert(result.ok && result.value.activity.at(-1)?.studyItems === 5 && result.value.activity.at(-1)?.reviewAttempts === 1, "Valid workflow answers retain both activity counts");
  for (const field of ["batchId", "questionId", "knowledgeId"]) {
    for (const value of [null, 1, "", " ", " padded"]) {
      if (field === "knowledgeId" && value === null) continue;
      assert(!buildProgress(input({ attempts: [{ ...attempt, [field]: value }] })).ok, "Invalid identifiers remain rejected");
    }
  }
});
Deno.test("progress page safely reports malformed responses", async () => {
  const result = buildProgress(input({ attempts: [] })); if (!result.ok) throw new Error("fixture invalid");
  /** @param {string} value */ const escapeHtml = value => value.replaceAll("<", "&lt;");
  const response = { result: { ...result.value, period: { ...result.value.period, startedOn: "<script>" } } };
  const page = createProgressPage({ fetch: /** @type {typeof fetch} */(async () => new Response(JSON.stringify(response))), baseUrl: "https://example.test/", escapeHtml, onChange: () => {} });
  await page.load(); assert(page.render().includes("Progress data could not be read"), "invalid date rejected");
  const malformed = createProgressPage({ fetch: /** @type {typeof fetch} */(async () => new Response("{}")), baseUrl: "https://example.test/", escapeHtml, onChange: () => {} });
  await malformed.load(); assert(malformed.render().includes("Progress data could not be read"), "malformed response safe");
});
Deno.test("empty progress replaces unused plots with guidance and keeps real activity", async () => {
  const result = buildProgress(input({ attempts: [] })); if (!result.ok) throw new Error("fixture invalid");
  const page = createProgressPage({ fetch: async () => new Response(JSON.stringify({ result: result.value })), baseUrl: "https://example.test/", escapeHtml: value => value, onChange: () => {} });
  await page.load(); const html = page.render();
  assert(!html.includes("What these measurements mean") && !html.includes("progress-definitions"), "The removed bottom explanation must not render.");
  assert(html.includes('href="#review">Start reviewing') && html.includes("empty-states.svg#progress"), "Review action and decorative empty-state art");
  assert(!html.includes('aria-label="Daily accuracy chart"') && html.includes('aria-label="Activity calendar chart"'), "no blank accuracy canvas; activity remains");
  assert(html.includes("0/0 attempts") && html.includes("Unavailable") && !html.includes("<table"), "honest empty metrics without a data table");
});
Deno.test("progress page ignores stale out-of-order responses", async () => {
  const first = Promise.withResolvers(), second = Promise.withResolvers(); let call = 0;
  const one = buildProgress(input({ attempts: [attempt] })), none = buildProgress(input({ attempts: [] })); if (!one.ok || !none.ok) throw new Error("fixtures invalid");
  const page = createProgressPage({ fetch: /** @type {typeof fetch} */(() => (++call === 1 ? first.promise : second.promise)), baseUrl: "https://example.test/", escapeHtml: value => value, onChange: () => {} });
  const loadingOne = page.load(), loadingTwo = page.load(); second.resolve(new Response(JSON.stringify({ result: none.value }))); await loadingTwo; first.resolve(new Response(JSON.stringify({ result: one.value }))); await loadingOne;
  assert(page.render().includes("0/0 attempts"), "latest response wins");
});

Deno.test("progress response validates ratios, real dates and recovery counts", () => {
  const result = buildProgress(input({})); if (!result.ok) throw new Error("fixture invalid");
  assert(isProgressSummary(result.value), "valid summary");
  for (const bad of [
    { ...result.value, attempts: { ...result.value.attempts, averageScore: 2 } },
    { ...result.value, attempts: { ...result.value.attempts, scoredCount: 0 } },
    { ...result.value, recovery: { eligible: -1, recovered: -1, accuracy: 1 } },
    { ...result.value, period: { ...result.value.period, startedOn: "2026-02-30" } },
  ]) assert(!isProgressSummary(bad), "malformed summary rejected");
  const reordered = Object.fromEntries(Object.entries(attempt).reverse());
  const deduped = buildProgress(input({ attempts: [attempt, reordered] }));
  assert(deduped.ok && deduped.value.attempts.count === 1, "property order is not new evidence");
});

Deno.test("progress charts keep data gaps and escape labels; malformed JSON is named", async () => {
  const result = buildProgress(input({ attempts: [attempt, { ...attempt, batchId: "earlier", answeredAt: "2026-09-17T12:00:00Z" }] }));
  if (!result.ok) throw new Error("fixture invalid");
  const summary = { ...result.value, subjects: result.value.subjects.map(r => ({ ...r, label: "<img src=x onerror=alert(1)>" })) };
  const page = createProgressPage({ fetch: async () => new Response(JSON.stringify({ result: summary })), baseUrl: "https://example.test/", escapeHtml: value => value.replaceAll("<", "&lt;"), onChange: () => {} });
  await page.load(); const html = page.render();
  assert(!html.includes("<line "), "separated single observations are not connected");
  assert(html.includes("<circle") && !html.includes("<img"), "dots and escaped labels");
  const invalid = createProgressPage({ fetch: async () => new Response("{"), baseUrl: "https://example.test/", escapeHtml: value => value, onChange: () => {} });
  await invalid.load(); assert(invalid.render().includes("Progress data could not be read"), "JSON parse error is malformed data");
});

Deno.test("primary subjects rank library knowledge counts, cap at five and never count repeated quiz attempts", () => {
  const subjectCounts = [{ id: "music", count: 4 }, { id: "physics", count: 9 }, { id: "computing", count: 20 }, { id: "history", count: 1 }, { id: "biology", count: 7 }, { id: "mathematics", count: 12 }, { id: "arts", count: 0 }];
  const result = buildProgress(input({ subjectCounts, attempts: Array.from({ length: 30 }, (_, i) => ({ ...attempt, batchId: `b${i}` })) }));
  assert(result.ok, "valid counts"); if (!result.ok) return;
  assert(result.value.subjects.map(s => s.id).join() === "computing,mathematics,physics,biology,music", "largest five in descending knowledge count");
  assert(result.value.subjects.at(-1)?.count === 4, "30 quiz attempts do not increase the four music points");
  const filtered = buildProgress(input({ subject: "music", subjectCounts }));
  assert(filtered.ok && filtered.value.subjects.length === 1 && filtered.value.subjects[0].count === 4, "subject filter respected");
  for (const bad of [null, [{ id: "music", count: -1 }], [{ id: "music", count: 1.5 }], [{ id: "invented", count: 1 }], [{ id: "music", count: 1 }, { id: "music", count: 2 }]]) assert(!buildProgress(input({ subjectCounts: bad })).ok, "invalid knowledge counts rejected");
});

Deno.test("Progress has only interactive accuracy, activity and knowledge-count charts without tables or recovery", async () => {
  const result = buildProgress(input({ attempts: [attempt, { ...attempt, batchId: "wrong", correct: false, score: 0 }] })); if (!result.ok) throw new Error("fixture invalid");
  const page = createProgressPage({ fetch: async () => Response.json({ result: result.value }), baseUrl: "https://example.test/", escapeHtml: value => value, onChange: () => {} });
  await page.load(); const html = page.render();
  for (const removed of ["<table", "<details", "data table", "Recovery after", "Recorded activity", "Spacing intervals", "Unclassified"]) assert(!html.includes(removed), `${removed} removed`);
  assert((html.match(/data-progress-chart/g) ?? []).length === 3, "three remaining charts");
  assert(html.includes('data-chart-value="2026-09-19: 50% accuracy, 1/2 correct answers"'), "exact daily accuracy on its point");
  assert(html.includes('data-chart-value="2026-09-19: 5 knowledge points studied in 1 batches, 2 quiz attempts"'), "activity details on its cell");
  assert(html.includes('data-chart-value="Music & Performing Arts: 1 knowledge points"'), "knowledge count on subject bar");
  assert((html.match(/role="tooltip" hidden/g) ?? []).length === 3, "data readouts start hidden");
  assert(html.includes('tabindex="0" role="img"'), "chart data is keyboard and screen-reader accessible");
});

Deno.test("chart values respond to hover, tap and focus, dismiss on exit, outside tap and Escape", async () => {
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
  class Point {
    /** @param {string} value */ constructor(value) { this.value = value; }
    closest() { return this; }
    getAttribute() { return this.value; }
  }
  Object.defineProperty(globalThis, "Element", { configurable: true, value: Point });
  try {
    const handlers = new Map(), rootHandlers = new Map();
    const tooltip = { hidden: true, textContent: "" };
    const plot = { querySelector: () => tooltip, addEventListener: (/** @type {string} */ name, /** @type {(e:any)=>void} */ handler) => handlers.set(name, handler) };
    const root = { querySelector: () => null, querySelectorAll: (/** @type {string} */ selector) => selector === "[data-progress-chart]" ? [plot] : [tooltip], addEventListener: (/** @type {string} */ name, /** @type {(e:any)=>void} */ handler) => rootHandlers.set(name, handler) };
    const page = createProgressPage({ fetch: async () => Response.json({}), baseUrl: "https://example.test/", escapeHtml: value => value, onChange: () => {} });
    page.bind(/** @type {HTMLElement} */(/** @type {unknown} */(root)));
    const point = new Point("2026-09-19: 50% accuracy, 1/2 correct answers");
    for (const name of ["pointerover", "click", "focusin"]) {
      handlers.get(name)({ target: point });
      assert(!tooltip.hidden && tooltip.textContent === point.value, `${name} reveals the data value`);
      handlers.get("pointerout")({ pointerType: "touch" }); assert(!tooltip.hidden, "touch readout persists after lifting finger");
      handlers.get("pointerout")({ pointerType: "mouse" }); assert(tooltip.hidden, "mouse exit dismisses");
    }
    handlers.get("click")({ target: point }); rootHandlers.get("pointerdown")({ target: {} }); assert(tooltip.hidden, "outside tap dismisses");
    handlers.get("focusin")({ target: point }); rootHandlers.get("keydown")({ key: "Escape" }); assert(tooltip.hidden, "Escape dismisses");
    handlers.get("focusin")({ target: point }); handlers.get("focusout")({}); assert(tooltip.hidden, "blur dismisses");
  } finally {
    if (originalElement) Object.defineProperty(globalThis, "Element", originalElement);
    else Reflect.deleteProperty(globalThis, "Element");
  }
});
