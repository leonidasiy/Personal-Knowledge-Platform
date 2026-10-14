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
/** @param {Partial<Record<string,unknown>>} overrides */ const input = overrides => ({ days: 7, now, subject: null, attempts: [attempt], studies: [{ completedAt: now, itemCount: 5 }], ...overrides });
Deno.test("progress aggregates current UTC day, fractions, recovery, and primary subjects", () => { const result = buildProgress(input({ attempts: [attempt, { ...attempt, batchId: "b2", questionId: "q2", correct: false, score: null, elapsedDays: null, previousCorrect: null, primarySubject: null }] })); assert(result.ok, "valid input"); if (!result.ok) return; assert(result.value.attempts.accuracy === .5 && result.value.attempts.averageScore === 1 && result.value.attempts.scoredCount === 1, "separate score"); assert(result.value.daily.at(-1)?.date === "2026-09-19", "current day"); assert(result.value.recovery.accuracy === 1, "recovery"); assert(result.value.subjects.find(s => s.id === "music")?.count === 1, "primary only"); assert(result.value.intervals.at(-1)?.count === 1, "missing interval"); });
Deno.test("progress distinguishes empty denominators and rejects invalid data", () => { const empty = buildProgress(input({ attempts: [], studies: [] })); assert(empty.ok && empty.value.attempts.accuracy === null && empty.value.daily[0].accuracy === null, "empty nulls"); for (const bad of [input({ days: 8 }), input({ attempts: [{ ...attempt, confidence: 80 }] }), input({ attempts: [{ ...attempt, primarySubject: "nope" }] }), input({ studies: [{ completedAt: now, itemCount: 6 }] })]) assert(!buildProgress(bad).ok, "invalid rejected"); });
Deno.test("progress deduplicates identical attempts and rejects same batch/question conflicts", () => { const duplicate = buildProgress(input({ attempts: [attempt, { ...attempt }] })); assert(duplicate.ok && duplicate.value.attempts.count === 1, "identical dedupe"); const conflict = buildProgress(input({ attempts: [attempt, { ...attempt, answeredAt: "2026-09-19T11:00:00.000Z" }] })); assert(!conflict.ok && conflict.error.field.endsWith("duplicate"), "timestamp conflict"); });
Deno.test("progress rejects invalid scores and excludes future records", () => { assert(!buildProgress(input({ attempts: [{ ...attempt, score: .5, correct: true }] })).ok, "score consistency"); const future = buildProgress(input({ attempts: [{ ...attempt, answeredAt: "2026-09-19T23:00:00.000Z" }] })); assert(future.ok && future.value.attempts.count === 0, "future excluded"); });
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
  assert(html.includes('href="#review">Start reviewing') && html.includes("empty-states.svg#progress"), "Review action and decorative empty-state art");
  assert(!html.includes('aria-label="Daily accuracy chart"') && html.includes('aria-label="Activity calendar chart"'), "no blank accuracy canvas; activity remains");
  assert(html.includes("0/0 attempts") && html.includes("Unavailable") && html.includes("Daily accuracy data table"), "honest empty metrics and accessible table");
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
  assert(!html.includes("<polyline"), "separated single observations are not connected");
  assert(html.includes("<circle") && !html.includes("<img"), "dots and escaped labels");
  const invalid = createProgressPage({ fetch: async () => new Response("{"), baseUrl: "https://example.test/", escapeHtml: value => value, onChange: () => {} });
  await invalid.load(); assert(invalid.render().includes("Progress data could not be read"), "JSON parse error is malformed data");
});
