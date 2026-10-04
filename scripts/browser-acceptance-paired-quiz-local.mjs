// Synthetic local learner check. Uses a fresh temporary Chrome profile and
// intercepts all API calls; no hosted service or learner record is involved.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "test-results/browser-paired-quiz-local");
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
const artifacts = resolve(output, runId);
const profile = await mkdtemp(resolve(tmpdir(), "pkp-paired-quiz-chrome-"));
const baseBatch = { batchId: "synthetic-review", learningDay: "2026-10-04", status: "open", itemIds: ["synthetic-single", "synthetic-multi"], revision: 1, createdAt: "2026-10-04T00:00:00.000Z", completedAt: null };
const questions = [
  { questionId: "synthetic-single", knowledgeId: "knowledge-single", title: "Synthetic music source", prompt: "Which interval spans six semitones?", kind: "single-choice", choices: null, blanks: null, pairedVariants: [
    { id: "single-choice-v1", kind: "single-choice", prompt: "Choose the interval spanning six semitones.", explanation: "A tritone spans six semitones.", choices: [{ id: "tritone", label: "Tritone" }, { id: "octave", label: "Octave" }], blanks: null },
    { id: "single-fill-v1", kind: "fill-blank", prompt: "A six-semitone interval is a ____.", explanation: "A tritone spans six semitones.", choices: null, blanks: [{ id: "blank-1" }] },
  ], sourceAnchorIds: ["synthetic-anchor-1"], revision: 4 },
  { questionId: "synthetic-multi", knowledgeId: "knowledge-multi", title: "Synthetic music source", prompt: "Which qualities are shared?", kind: "multiple-choice", choices: null, blanks: null, pairedVariants: [
    { id: "multi-choice-v1", kind: "multiple-choice", prompt: "Select both shared properties.", explanation: "Both selected properties apply.", choices: [{ id: "six", label: "Six semitones" }, { id: "consonant", label: "Perfect consonance" }, { id: "eight", label: "Eight semitones" }], blanks: null },
    { id: "multi-fill-v1", kind: "fill-blank", prompt: "The shared count is ____ semitones.", explanation: "The shared count is six semitones.", choices: null, blanks: [{ id: "blank-1" }] },
  ], sourceAnchorIds: ["synthetic-anchor-2"], revision: 7 },
];
const review = { result: { batch: baseBatch, questions, dueCount: 2 } };
const requests = [];
const pageErrors = [];
const consoleErrors = [];
const failedResponses = [];
let answerAttempt = 0;
let server;
let context;
const cleanup = { contextClosed: false, serverClosed: false, profileRemoved: false };
const contentTypes = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"], [".webp", "image/webp"], [".png", "image/png"], [".woff2", "font/woff2"]]);
async function startServer() {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (path !== root && !path.startsWith(`${root}${sep}`)) { res.writeHead(403).end(); return; }
    const file = path === root ? resolve(root, "index.html") : path;
    res.setHeader("content-type", contentTypes.get(extname(file)) ?? "application/octet-stream");
    const stream = createReadStream(file);
    stream.on("error", () => { if (!res.headersSent) res.writeHead(404); res.end("Not found"); });
    stream.pipe(res);
  });
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("LocalFixtureServerAddressUnavailable");
  return `http://127.0.0.1:${address.port}`;
}

try {
  await mkdir(artifacts, { recursive: true });
  const origin = await startServer();
  context = await chromium.launchPersistentContext(profile, {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true, viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "reduce",
    args: ["--no-first-run", "--no-default-browser-check"], timeout: 20_000,
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.text().includes("responded with a status of 503 (Service Unavailable)")) consoleErrors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 400 && !(response.status() === 503 && new URL(response.url()).pathname.endsWith("/review-batch/answer"))) failedResponses.push({ status: response.status(), url: response.url() }); });
  page.on("request", request => { if (!request.url().startsWith(origin)) requests.push({ kind: "outside-origin", url: request.url() }); });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON() ?? null;
    requests.push({ method: request.method(), path: url.pathname, body });
    if (url.pathname.endsWith("/review-batch/answer")) {
      answerAttempt += 1;
      if (answerAttempt === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "ReviewGradingUnavailable" }) });
      const correct = body?.questionId !== "synthetic-multi";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { correct, score: correct ? 1 : 0.5, completed: body?.questionId === "synthetic-multi", nextDueAt: "2026-10-05T00:00:00.000Z", feedback: { explanation: correct ? "The paired responses match." : "The complete pair must be correct.", correctAnswer: "Tritone; six semitones", components: [{ id: "choice-v1", correct, correctAnswer: "Tritone" }, { id: "fill-v1:blank-1", correct, correctAnswer: "six" }] } } }) });
    }
    if (url.pathname.endsWith("/review-batch")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(review) });
    if (url.pathname.endsWith("/feed-batch")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { batch: null, items: [] } }) });
    if (url.pathname.endsWith("/capabilities")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: [] }) });
    if (url.pathname.endsWith("/reminders") || url.pathname.endsWith("/preferences")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: {} }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: {} }) });
  });

  const evidence = [];
  const actions = [];
  const trace = async (action, locator = null) => {
    const focused = await page.evaluate(() => {
      const node = document.activeElement;
      if (!(node instanceof HTMLElement)) return null;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return { tag: node.tagName, type: node instanceof HTMLInputElement ? node.type : null, name: node.getAttribute("name"), id: node.id || null, value: node instanceof HTMLInputElement ? node.value : null, checked: node instanceof HTMLInputElement && (node.type === "radio" || node.type === "checkbox") ? node.checked : null, label: node.labels ? [...node.labels].map(label => label.innerText.trim()).join(" ") : null, text: node.innerText?.trim().slice(0, 80) || null, className: typeof node.className === "string" ? node.className : null, outline: style.outline, outlineColor: style.outlineColor, outlineStyle: style.outlineStyle, boxShadow: style.boxShadow, rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
    });
    actions.push({ action, focused });
    if (locator) assert.equal(await locator.evaluate(node => node === document.activeElement), true, `${action} leaves the expected native control focused`);
  };
  const capture = async (name, viewport, theme, action) => {
    const screenshot = resolve(artifacts, `${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: viewport.startsWith("desktop"), animations: "disabled" });
    evidence.push({ screenshot, viewport, theme, action });
  };
  const captureElement = async (name, viewport, theme, locator, action) => {
    const screenshot = resolve(artifacts, `${name}.png`);
    await locator.screenshot({ path: screenshot, animations: "disabled" });
    evidence.push({ screenshot, viewport, theme, action });
  };
  await page.goto(origin, { waitUntil: "networkidle", timeout: 15_000 });
  const nav = page.locator('.primary-nav [data-view="review"]');
  await nav.focus();
  assert.equal(await nav.evaluate(node => node === document.activeElement), true, "Review navigation is keyboard focusable");
  await page.keyboard.press("Enter");
  await page.locator('[data-review-question="synthetic-single"]').waitFor();
  const single = page.locator('[data-review-question="synthetic-single"]');
  const multi = page.locator('[data-review-question="synthetic-multi"]');
  const assertUnanswered = async () => {
    assert.equal(await single.locator('input[type="radio"]:checked').count(), 0, "single-choice form starts unanswered");
    assert.equal(await single.locator('input[name^="pairedBlank:"]').first().inputValue(), "", "single fill form starts untouched");
    assert.equal(await multi.locator('input[type="checkbox"]:checked').count(), 0, "multi-choice form starts unanswered");
    assert.equal(await multi.locator('input[name^="pairedBlank:"]').first().inputValue(), "", "multi fill form starts untouched");
  };
  await assertUnanswered();
  await capture("00-desktop-light-unanswered", "desktop 1440x1000", "light", "Both untouched synthetic single-choice and multi-choice forms before any answer entry.");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("00-mobile-light-unanswered", "mobile 390x844", "light", "Both untouched synthetic forms before any answer entry, mobile.");
  await captureElement("00-mobile-light-unanswered-single", "mobile 390x844", "light", single, "Untouched single-choice form at mobile width.");
  await captureElement("00-mobile-light-unanswered-multi", "mobile 390x844", "light", multi, "Untouched multi-choice form at mobile width.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-setting="theme"][value="dark"]').check();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.locator('.primary-nav [data-view="review"]').click();
  await page.locator('[data-review-question="synthetic-multi"]').waitFor();
  await assertUnanswered();
  await capture("00-desktop-dark-unanswered", "desktop 1440x1000", "dark", "Both untouched synthetic forms before any answer entry, desktop dark theme.");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("00-mobile-dark-unanswered", "mobile 390x844", "dark", "Both untouched synthetic forms before any answer entry, mobile dark theme.");
  await captureElement("00-mobile-dark-unanswered-single", "mobile 390x844", "dark", single, "Untouched single-choice form at mobile width, dark theme.");
  await captureElement("00-mobile-dark-unanswered-multi", "mobile 390x844", "dark", multi, "Untouched multi-choice form at mobile width, dark theme.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-setting="theme"][value="light"]').check();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.locator('.primary-nav [data-view="review"]').click();
  await page.locator('[data-review-question="synthetic-single"]').waitFor();
  await assertUnanswered();
  assert.equal(await single.locator("fieldset").count(), 2, "one MCQ and one fill blank appear as distinct fieldsets");
  assert.equal(await single.locator('input[type="radio"]').count(), 2);
  assert.equal(await single.locator('input[name^="pairedBlank:"]').count(), 1);
  assert.ok(await single.locator('input[name="pairedBlank:blank-1"]').evaluate(node => node.getBoundingClientRect().width) >= 200, "desktop fill input is wide enough to read a typed answer");
  assert.equal(await single.getByText("A tritone spans six semitones.", { exact: true }).count(), 0, "answer explanation remains hidden before an attempt");
  const singleChoice = single.getByLabel("Tritone");
  await singleChoice.focus();
  assert.equal(await singleChoice.evaluate(node => node === document.activeElement), true, "choice receives keyboard focus");
  await trace("focus-single-radio", singleChoice);
  await page.keyboard.press("Space");
  await trace("Space-select-single-radio", singleChoice);
  assert.equal(await singleChoice.isChecked(), true, "Space activates the focused native radio");
  const singleBlank = single.locator('input[name="pairedBlank:blank-1"]');
  await page.keyboard.press("Tab");
  assert.equal(await singleBlank.evaluate(node => node === document.activeElement), true, "Tab moves from the selected radio to the fill input");
  await trace("Tab-radio-to-fill", singleBlank);
  await page.keyboard.type("six");
  const singleSubmit = single.getByRole("button", { name: "Check both answers" });
  await page.keyboard.press("Tab");
  assert.equal(await singleSubmit.evaluate(node => node === document.activeElement), true, "Tab moves from the fill input to pair submission");
  await trace("Tab-fill-to-submit", singleSubmit);
  await capture("00-desktop-light-single-selected-before-unavailable", "desktop 1440x1000", "light", "Selected radio and typed answer immediately before unavailable grading.");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("00-mobile-light-single-selected-before-unavailable", "mobile 390x844", "light", "Same answer immediately before unavailable grading, mobile.");
  await captureElement("00-mobile-light-single-selected-before-unavailable-form", "mobile 390x844", "light", single, "Selected single-choice and typed answer immediately before unavailable grading, mobile.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press("Enter");
  await trace("Enter-submit-unavailable", singleSubmit);
  await page.getByRole("alert").getByText("Answer checking is temporarily unavailable.").waitFor();
  const unavailableChoice = single.getByLabel("Tritone");
  assert.equal(await unavailableChoice.isChecked(), true, "selected option survives unavailable grading");
  assert.equal(await unavailableChoice.getAttribute("value"), "tritone", "selected choice ID survives unavailable grading");
  assert.equal(await single.locator('input[name="pairedBlank:blank-1"]').inputValue(), "six", "typed response survives unavailable grading");
  assert.equal(await single.getByText("Not quite.", { exact: true }).count(), 0, "unavailable grading is not shown as incorrect");
  await capture("01-desktop-light-grading-unavailable", "desktop 1440x1000", "light", "Submitted by keyboard; unavailable grading kept both responses editable and visible, with a distinct alert.");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("01-mobile-light-grading-unavailable", "mobile 390x844", "light", "Unavailable grading preserves the selected radio and typed answer, mobile.");
  await captureElement("01-mobile-light-grading-unavailable-form", "mobile 390x844", "light", single, "Unavailable grading preserves selected choice and typed answer in the mobile form.");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await single.locator('input[name="pairedBlank:blank-1"]').evaluate(node => node.getBoundingClientRect().width) >= 200, "mobile fill input remains wide enough to read a typed answer");
  await capture("02-mobile-light-grading-unavailable", "mobile 390x844", "light", "Checked preserved fill input width on mobile after unavailable grading.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await single.getByRole("button", { name: "Check both answers" }).click();
  await single.getByText("Correct.", { exact: true }).waitFor();
  assert.equal(await single.locator("form[data-learner-review]").count(), 0, "successful answer is shown once");
  assert.equal(await multi.locator('input[type="checkbox"]').count(), 3, "multi-choice uses native checkboxes");
  const sixCheckbox = multi.getByLabel("Six semitones");
  await sixCheckbox.focus();
  await trace("focus-multi-checkbox", sixCheckbox);
  await page.keyboard.press("Space");
  await trace("Space-select-multi-checkbox", sixCheckbox);
  assert.equal(await sixCheckbox.isChecked(), true, "Space activates the focused native checkbox");
  await multi.getByLabel("Perfect consonance").check();
  const multiBlank = multi.locator('input[name="pairedBlank:blank-1"]');
  await multiBlank.focus();
  await trace("focus-multi-fill", multiBlank);
  await page.keyboard.type("six");
  await page.keyboard.press("Tab");
  const multiSubmit = multi.getByRole("button", { name: "Check both answers" });
  await trace("Tab-multi-fill-to-submit", multiSubmit);
  await page.keyboard.press("Enter");
  await trace("Enter-submit-multi", multiSubmit);
  await multi.getByText("Not quite.", { exact: true }).waitFor();
  assert.equal(await multi.getByText(/Partly correct/).count(), 0, "paired grading never exposes partial-credit feedback");
  const answerRequests = requests.filter(request => request.path === "/api/learning-generation/review-batch/answer");
  assert.equal(answerRequests.length, 3, "one pair command per attempt: unavailable, retry, and second question");
  assert.equal(failedResponses.length, 0, "only the intentional grading-unavailable fixture response may use an error status");
  assert.equal(requests.filter(request => request.method === "POST").length, 3, "no extra schedule, XP, or reminder writes are issued by the learner UI");
  const [failedBody, retryBody, multiBody] = answerRequests.map(request => request.body);
  assert.equal(failedBody.questionId, "synthetic-single");
  assert.equal(failedBody.questionRevision, 4);
  assert.deepEqual(failedBody.selectedChoiceIds, ["tritone"]);
  assert.deepEqual(failedBody.pairedBlankAnswers, [{ id: "blank-1", text: "six" }]);
  assert.equal(retryBody.idempotencyKey, failedBody.idempotencyKey, "retry keeps pair idempotency identity");
  actions.push({ action: "retry-reuses-idempotency-key", requestCount: 2, firstKey: failedBody.idempotencyKey, retryKey: retryBody.idempotencyKey, sameKey: retryBody.idempotencyKey === failedBody.idempotencyKey, selectedChoiceIds: retryBody.selectedChoiceIds, pairedBlankAnswers: retryBody.pairedBlankAnswers });
  assert.deepEqual(multiBody.selectedChoiceIds, ["six", "consonant"], "multi-select set is sent once as a whole");
  assert.deepEqual(multiBody.pairedBlankAnswers, [{ id: "blank-1", text: "six" }]);
  await capture("03-desktop-light-paired-results", "desktop 1440x1000", "light", "Submitted both single-choice and multi-choice pairs; each question received one result and one pair command per attempt.");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-setting="theme"][value="dark"]').check();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.locator('.primary-nav [data-view="review"]').click();
  await page.locator('[data-review-question="synthetic-multi"]').waitFor();
  await capture("04-desktop-dark-review", "desktop 1440x1000", "dark", "Switched through Settings and reopened Review in dark theme.");
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(overflow.document <= overflow.viewport + 1, `mobile horizontal overflow ${JSON.stringify(overflow)}`);
  await capture("05-mobile-dark-review", "mobile 390x844", "dark", "Review pair at mobile width; verified no horizontal overflow.");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-setting="theme"][value="light"]').check();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.locator('.primary-nav [data-view="review"]').click();
  await page.locator('[data-review-question="synthetic-multi"]').waitFor();
  await capture("06-mobile-light-review", "mobile 390x844", "light", "Switched through Settings and verified Review at mobile width in light theme.");
  const motion = await page.evaluate(() => ({ reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, transition: getComputedStyle(document.documentElement).transitionDuration, animation: getComputedStyle(document.querySelector(".primary-nav") ?? document.body).animationDuration }));
  const hasLongMotion = value => value.split(",").some(part => Number.parseFloat(part) > 0.02 && part.trim().endsWith("s"));
  assert.equal(motion.reduced, true);
  assert.equal(hasLongMotion(motion.transition), false);
  assert.equal(hasLongMotion(motion.animation), false);
  assert.deepEqual(requests.filter(request => request.kind === "outside-origin"), []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedResponses, [], "the synthetic 503 is intercepted at route boundary, not emitted to browser");
  await page.getByRole("button", { name: "Refresh questions" }).waitFor();
  const unansweredEvidence = evidence.filter(item => item.screenshot.split(/[\\/]/u).at(-1)?.startsWith("00-") === true);
  assert.equal(unansweredEvidence.length, 8, "all pristine unanswered screenshot artifacts are present");
  assert.deepEqual(unansweredEvidence.filter(item => item.viewport.startsWith("desktop")).map(item => item.theme).sort(), ["dark", "light"], "desktop unanswered screenshots cover both themes");
  assert.deepEqual(unansweredEvidence.filter(item => item.viewport.startsWith("mobile")).map(item => item.theme).sort(), ["dark", "dark", "dark", "light", "light", "light"], "mobile unanswered screenshots show both forms in both themes");
  assert.deepEqual(actions.filter(item => item.action.startsWith("Space-")).map(item => item.action), ["Space-select-single-radio", "Space-select-multi-checkbox"], "native radio and checkbox keyboard activation are both traced");
  await writeFile(resolve(artifacts, "actions.json"), `${JSON.stringify(actions, null, 2)}\n`);
  const report = { status: "PASS", fixture: "Synthetic answer-hidden paired quizzes only; no learner data or hosted APIs.", browser: "Installed Google Chrome, isolated temporary profile", checks: ["single-choice MCQ and fill blank rendered exactly once", "multi-choice checkboxes and fill blank submitted together", "pristine unanswered forms screenshot at desktop/mobile in both themes", "native radio and checkbox Space actions, actual focused element/CSS state for Tab transitions and Enter submission", "desktop/mobile fill input width is at least 200px", "server unavailable response preserved option and typed text and did not render incorrect feedback, with pre/post screenshots", "retry reused pair idempotency key visible in request trace", "wrong paired result with score 0.5 displayed incorrect with no partial credit", "one response command per paired attempt", "question revision sent unchanged", "question results only schedule through the answer response; no schedule, XP, or reminder write endpoints are called", "desktop/mobile in light and dark themes", "OS reduced motion", "no off-origin requests, console errors, page errors, failed network responses, or mobile overflow"], requests: requests.map(({ body, ...request }) => ({ ...request, ...(body ? { body } : {}) })), actions, evidence, motion };
  await writeFile(resolve(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  await mkdir(artifacts, { recursive: true });
  await writeFile(resolve(artifacts, "failure.json"), `${JSON.stringify({ error: error instanceof Error ? error.stack : String(error), requests, pageErrors, consoleErrors, failedResponses }, null, 2)}\n`);
  throw error;
} finally {
  if (context) { await context.close(); cleanup.contextClosed = true; }
  if (server?.listening) await new Promise(resolveClose => server.close(() => { cleanup.serverClosed = true; resolveClose(); })); else cleanup.serverClosed = true;
  await rm(profile, { recursive: true, force: true });
  try { await import("node:fs/promises").then(({ access }) => access(profile)); } catch { cleanup.profileRemoved = true; }
  await mkdir(artifacts, { recursive: true });
  await writeFile(resolve(artifacts, "cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
}
console.log(JSON.stringify({ status: "PASS", artifacts, cleanup }));
