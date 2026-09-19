// Build and serve dist on localhost:4320. All learner API responses are synthetic.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { SUBJECTS } from "../src/features/knowledge-subjects/public.js";
import { buildProgress } from "../src/features/progress/public.js";
const origin = process.env.REMINDER_TEST_ORIGIN ?? "http://localhost:4320", now = "2026-09-19T12:00:00.000Z";
if (!["http://localhost:4320", "http://localhost:4321"].includes(origin)) throw new Error("LocalTestOriginRequired");
const output = new URL("../test-results/progress-classification/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [], writes = [], remote = [];
let offset = 0, progressState = "ready", correction = null;
const batch = { batchId: "fixture", learningDay: "2026-09-19", status: "open", itemIds: ["k0","k1","k2","k3","k4"], revision: 1, createdAt: now, completedAt: null };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.testCues = [];
    window.AudioContext = class {
      state = localStorage.getItem("synthetic-audio-failure") === "blocked" ? "suspended" : "running"; currentTime = 0; destination = {};
      constructor() { if (localStorage.getItem("synthetic-audio-failure") === "unsupported") throw new Error("Synthetic unsupported audio"); }
      resume() { return this.state === "suspended" ? Promise.reject(new Error("Synthetic blocked audio")) : Promise.resolve(); }
      createOscillator() { return { frequency: { setValueAtTime: n => window.testCues.push(n) }, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    };
  });
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (!r.url().startsWith(origin)) remote.push(r.url()); });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== "GET" && !path.endsWith("/suppressions/check")) writes.push({ path, body: request.postDataJSON() });
    if (path.endsWith("/feed-batch")) return route.fulfill({ json: { result: { batch, items: batch.itemIds.map((id,i) => ({ knowledgeId: id, sourceId: "fixture", questionId: "q"+i, title: "Synthetic learning source", summary: "Fixture only: connect an idea to prior knowledge, retrieve it after a delay, and reflect on the feedback.", sourceUrl: "https://example.test/fixture", evidenceAnchorIds: ["anchor"], media: null, questionLocked: true, classification: i === 0 && correction ? correction : { version: 1, primarySubject: SUBJECTS[(offset+i)%22].id, secondarySubjects: [], subcategory: "Source-grounded detail" }, classificationRevision: correction ? 1 : 0 })) } } });
    if (path.endsWith("/classification")) { correction = request.postDataJSON().classification; return route.fulfill({ json: { result: { classification: correction, classificationRevision: 1 } } }); }
    if (path.endsWith("/knowledge-preference")) return route.fulfill({ json: { result: { completed: true } } });
    if (path.endsWith("/review-batch")) return route.fulfill({ json: { result: { batch: { ...batch, itemIds: ["q0"] }, dueCount: 1, questions: [{ questionId: "q0", knowledgeId: "k0", title: "Review", prompt: "Synthetic question", kind: "fill-blank", choices: null, blanks: null, sourceAnchorIds: ["anchor"], revision: 1 }] } } });
    if (path.endsWith("/review-batch/answer")) return route.fulfill({ json: { result: { completed: true, correct: true, score: 1, nextDueAt: "2026-09-20T12:00:00.000Z", feedback: { explanation: "Synthetic feedback", correctAnswer: "retrieval", components: [] } } } });
    if (path.endsWith("/progress")) {
      if (progressState === "error") return route.fulfill({ status: 503, json: { error: "ProgressReadUnavailable" } });
      const attempts = progressState === "empty" ? [] : Array.from({ length: 12 }, (_,i) => ({ batchId: "b"+i, questionId: "q"+i, knowledgeId: "k"+i, answeredAt: `2026-09-${String(8+i).padStart(2,"0")}T10:00:00.000Z`, correct: i%3 !== 0, score: i%3 === 0 ? 0.5 : 1, elapsedDays: i+1, previousCorrect: false, primarySubject: SUBJECTS[i%22].id }));
      const result = buildProgress({ now, days: Number(url.searchParams.get("days")), subject: url.searchParams.get("subject"), attempts, studies: progressState === "empty" ? [] : [{ completedAt: now, itemCount: 5 }] });
      assert.ok(result.ok);
      return route.fulfill({ json: { result: result.value } });
    }
    return route.fulfill({ status: 503, json: { error: "SyntheticUnavailable" } });
  });
  let previousView = "feed";
  const settings = async () => { if (await page.locator(".settings-page").count()) return; previousView = await page.locator(".primary-nav button.active").getAttribute("data-view"); await page.getByRole("button", {name:"Settings",exact:true}).click(); await page.locator('[data-setting="sound"]').waitFor(); };
  const closeSettings = async () => { if (await page.locator(".settings-page").count()) { await page.locator(`.primary-nav [data-view="${previousView}"]`).click(); await page.locator(".settings-page").waitFor({state:"hidden"}); } };
  const nav = async view => { await page.locator(`.primary-nav [data-view="${view}"]`).click(); };
  await page.goto(origin);
  await page.locator(".learner-feed").waitFor();
  await settings();
  assert.equal(await page.locator('[data-setting="sound"]').isChecked(), false);
  await settings(); await page.locator('[data-setting="sound"]').check(); await closeSettings();
  for (const mode of ["light", "dark"]) {
    await settings(); await page.locator(`[data-setting="theme"][value="${mode}"]`).check(); await closeSettings();
    await nav("feed");
    for (offset = 0; offset < 22; offset++) {
      await page.reload(); await page.locator(".learner-feed").waitFor();
      const card = page.locator(".learning-card").first();
      assert.equal(await card.getAttribute("data-subject"), SUBJECTS[offset].id);
      assert.equal(await card.locator(".subject-mark path").count(), 1);
      await card.locator('[data-preference="more"]').click();
      await page.waitForTimeout(100);
      assert.ok(await page.evaluate(f => window.testCues.includes(f), 240+offset*23), JSON.stringify({ mode, offset, cues: await page.evaluate(() => window.testCues), errors }));
    }
    await nav("progress"); await page.locator(".progress-page").waitFor();
    for (const width of [1280,375,320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const days of [7,30,90]) {
        await page.locator('[name="days"]').selectOption(String(days));
        await page.locator("[data-progress-controls] button").click();
        await page.locator(".progress-page").waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1), `${mode}/${width}/${days} overflow`);
      }
      await page.screenshot({ path: fileURLToPath(new URL(`${mode}-${width}.png`, output)) });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[name="subject"]').selectOption("mathematics");
  await page.locator("[data-progress-controls] button").click();
  await page.locator(".progress-page").waitFor();
  assert.match(await page.locator(".progress-summary").innerText(), /0\/1 attempts/);
  await page.getByText("Daily accuracy data table", { exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.ok(await page.locator(".progress-table").first().getAttribute("open") !== null);
  await page.emulateMedia({ forcedColors: "active" });
  assert.notEqual(await page.locator(".progress-table summary").first().evaluate(e => getComputedStyle(e).outlineStyle), "none");
  await page.emulateMedia({ forcedColors: "none" });
  await nav("feed"); await page.locator(".learner-feed").waitFor();
  const card = page.locator(".learning-card").first();
  await card.locator('[data-library-details-key] summary').click();
  await card.locator('[name="primary"]').selectOption("music");
  await card.locator('[name="subcategory"]').fill("Synthetic correction");
  await card.getByRole("button", { name: "Save classification" }).click();
  await page.getByText("Classification saved.", { exact: true }).waitFor();
  assert.equal(await page.locator(".learning-card").first().getAttribute("data-subject"), "music");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".learning-card").first().hover();
  assert.equal(await page.locator(".subject-mark").first().evaluate(e => getComputedStyle(e).transform), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await settings(); await page.locator('[data-setting="motion"]').uncheck(); await page.locator('[data-setting="sound"]').uncheck(); await closeSettings();
  await page.locator(".learning-card").first().hover();
  assert.equal(await page.locator(".subject-mark").first().evaluate(e => getComputedStyle(e).transform), "none");
  const cueCount = await page.evaluate(() => window.testCues.length);
  await nav("review"); await page.locator('[name="answerText"]').fill("retrieval");
  assert.equal(await page.locator("[data-subject]").count(), 0);
  assert.equal(await page.locator('[name="confidence"]').count(), 0);
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[name="confidence"]'));
  assert.equal(Object.hasOwn(writes.find(w => w.path.endsWith("/answer")).body, "confidence"), false);
  assert.equal(await page.evaluate(() => window.testCues.length), cueCount);
  for (const state of ["empty", "error"]) {
    progressState = state;
    await nav("progress");
    await page.locator(state === "empty" ? ".progress-page" : "main [role=alert]").waitFor();
    assert.match(await page.locator("main").innerText(), state === "empty" ? /No .*attempt|Unavailable/i : /unavailable/i);
    await nav("feed");
  }
  for (const blocked of [false, true]) {
    await nav("feed");
    await page.evaluate(blocked => localStorage.setItem("synthetic-audio-failure", blocked ? "blocked" : "unsupported"), blocked);
    await page.reload(); await page.locator(".learner-feed").waitFor();
    await settings(); await page.locator('[data-setting="sound"]').check();
    await page.waitForFunction(() => document.querySelector('[data-setting="sound"]')?.checked === false);
    assert.match(await page.locator("body").innerText(), /sound.*unavailable|audio.*unavailable/i);
  }
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  assert.ok(writes.every(w => ["/knowledge-preference","/classification","/answer"].some(p => w.path.endsWith(p))));
  console.log("PASS: 22 subjects and cues in both modes; progress 7/30/90d at 320/375/1280px; correction, no confidence collection, no pre-answer subject cues, motion/sound off, empty/error; synthetic-only APIs.");
} finally { await browser.close(); }
