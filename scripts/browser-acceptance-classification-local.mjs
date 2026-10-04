// Isolated local UI check: synthetic API fixture, fresh temporary Chrome profile,
// no hosted origin, with browser/context/server/profile cleanup in finally.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = resolve(root, "test-fixtures/browser-classification.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assert(fixture.knowledge.every(item => !item.summary.toLowerCase().includes(fixture.updatedClassification.topic.toLowerCase())), "Topic-only browser phrase must be absent from every point summary.");
const syntheticSource = { id: fixture.sourceId, ownerId: "synthetic-owner", submittedUrl: "https://example.test/synthetic-music-source", canonicalUrl: "https://example.test/synthetic-music-source", title: "Synthetic source for browser verification", description: "Synthetic fixture source.", state: "active", addedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", approvedAt: "2026-10-01T00:00:00.000Z", revision: fixture.sourceRevision, interestAreaIds: [], identityEvidence: [], adapter: { id: "web", version: "fixture-1", granularity: "page", capabilities: [] } };
const output = resolve(root, "test-results/browser-classification-local");
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
const artifactDir = resolve(output, runId);
const profile = await mkdtemp(resolve(tmpdir(), "pkp-classification-chrome-"));
const requests = [];
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const cleanup = { browserContextClosed: false, profileRemoved: false, fixtureServerClosed: false };
let completedReport = null;
let classification = { ...fixture.initialClassification };
let classificationRevision = fixture.classificationRevision;
let browserContext;
let server;

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
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("LocalFixtureServerAddressUnavailable");
  return `http://127.0.0.1:${address.port}`;
}
function feedProjection() {
  const items = fixture.knowledge.map((point, index) => ({
    ...point, sourceId: fixture.sourceId, sourceRevision: fixture.sourceRevision,
    questionId: `synthetic-q${index + 1}`, evidenceAnchorIds: [`synthetic-anchor-${index + 1}`],
    media: null, questionLocked: true, sourceClassification: { ...classification }, sourceClassificationRevision: classificationRevision,
  }));
  return { result: { batch: { batchId: "synthetic-batch", learningDay: "2026-10-04", status: "open", itemIds: items.map(({ knowledgeId }) => knowledgeId), revision: 1, createdAt: "2026-10-04T00:00:00.000Z", completedAt: null }, items } };
}

try {
  await mkdir(artifactDir, { recursive: true });
  const origin = await startServer();
  browserContext = await chromium.launchPersistentContext(profile, {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "reduce",
    args: ["--no-first-run", "--no-default-browser-check"], timeout: 20000,
  });
  const page = browserContext.pages()[0] ?? await browserContext.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() }); });
  page.on("request", request => { if (!request.url().startsWith(origin)) requests.push({ kind: "outside-origin", url: request.url() }); });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postDataJSON() ?? null;
    const entry = { method: request.method(), path, query: Object.fromEntries(url.searchParams), body };
    requests.push(entry);
    const json = value => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (path.endsWith("/feed-batch")) return json(feedProjection());
    if (path.endsWith("/review-batch")) return json({ result: { batch: null, questions: [], dueCount: 0 } });
    if (path.endsWith("/library-knowledge")) return json({ result: { items: fixture.knowledge.map((item) => ({ knowledgeId: item.knowledgeId, sourceId: fixture.sourceId, sourceRevision: fixture.sourceRevision, questionId: `q-${item.knowledgeId}`, title: item.title, summary: item.summary, sourceUrl: item.sourceUrl, evidenceAnchorIds: ["synthetic-anchor-1"], media: null, questionLocked: true, sourceClassification: { ...classification }, sourceClassificationRevision: classificationRevision })) } });
    if (path === "/api/source-library") return json({ result: { items: [syntheticSource], interestAreas: [], nextCursor: null } });
    if (path === "/api/source-library/suppressions/check") return json({ result: [] });
    if (path === "/api/knowledge-workflows/source-status") return json({ result: { sourceId: url.searchParams.get("sourceId"), run: null, reasonCode: null, message: null } });
    if (path === "/api/source-library/search") {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      const scope = url.searchParams.get("scope");
      const matches = fixture.knowledge.filter(item => `${item.title} ${item.summary} ${classification.topic}`.toLowerCase().includes(query));
      if (scope === "knowledge") return json({ result: matches.map(item => ({ knowledge: { knowledgeId: item.knowledgeId, sourceId: fixture.sourceId, sourceTitle: "Synthetic source for browser verification", summary: item.summary, sourceUrl: item.sourceUrl, evidenceAnchorIds: ["synthetic-anchor-1"], questionLocked: true }, score: 1, matchedBy: "exact" })) });
      return json({ result: query && syntheticSource.title.toLowerCase().includes(query) ? [{ source: syntheticSource, score: 1 }] : [] });
    }
    if (path === "/api/source-library/classification" && request.method() === "POST") {
      assert.equal(body?.sourceId, fixture.sourceId, "classification save is source scoped");
      assert.equal(body?.sourceRevision, fixture.sourceRevision);
      assert.equal(body?.expectedRevision, classificationRevision);
      classification = { mainSubject: body.mainSubject, topic: body.topic };
      classificationRevision += 1;
      return json({ result: { sourceId: fixture.sourceId, sourceRevision: fixture.sourceRevision, classificationRevision, ...classification } });
    }
    if (path.endsWith("/capabilities")) return json({ result: [] });
    if (path.endsWith("/reminders") || path.endsWith("/preferences")) return json({ result: {} });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Synthetic fixture has no response for this route" }) });
  });

  const capture = async (name, details) => {
    const screenshot = resolve(artifactDir, `${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    return { screenshot, ...details };
  };
  const evidence = [];
  await page.goto(origin, { waitUntil: "networkidle", timeout: 15000 });
  await page.locator(".learner-feed").waitFor();
  assert.equal(await page.locator("form[data-source-classification]").count(), 5);
  const editor = page.locator(`form[data-source-classification="${fixture.sourceId}"]`).first();
  const disclosure = editor.locator("xpath=..//summary");
  await disclosure.focus();
  assert.equal(await disclosure.evaluate(node => node === document.activeElement), true, "classification disclosure is keyboard focusable");
  await page.keyboard.press("Enter");
  assert.equal(await editor.locator("select").count(), 1, "Enter opens the classification disclosure");
  assert.equal(await editor.locator("select").count(), 1, "editor has only the main-subject selector");
  assert.equal(await editor.locator("input").count(), 1, "editor has only the topic text input");
  await page.keyboard.press("Tab");
  assert.equal(await editor.locator("select[name=mainSubject]").evaluate(node => node === document.activeElement), true, "Tab moves from the open disclosure to the subject selector");
  await editor.locator("select[name=mainSubject]").selectOption(fixture.updatedClassification.mainSubject);
  await editor.locator("input[name=topic]").focus();
  await editor.locator("input[name=topic]").fill(fixture.updatedClassification.topic);
  assert.equal(await editor.locator("input[name=topic]").evaluate(node => node === document.activeElement), true, "topic field receives keyboard focus and text input");
  evidence.push(await capture("01-desktop-light-editor", { viewport: "desktop 1440x1000", theme: "light", action: "Opened first source editor; changed the main-subject dropdown and topic text." }));
  const saveButton = editor.getByRole("button", { name: "Save source classification" });
  await saveButton.focus();
  assert.equal(await saveButton.evaluate(node => node === document.activeElement), true, "save action is keyboard focusable");
  await page.keyboard.press("Enter");
  await page.getByText("Source classification saved.", { exact: true }).waitFor();
  await page.waitForFunction(({ sourceId, subject, topic }) => {
    const forms = [...document.querySelectorAll(`form[data-source-classification="${sourceId}"]`)];
    return forms.length === 5 && forms.every(form => form.querySelector('select[name="mainSubject"]')?.value === subject && form.querySelector('input[name="topic"]')?.value === topic);
  }, { sourceId: fixture.sourceId, subject: fixture.updatedClassification.mainSubject, topic: fixture.updatedClassification.topic });
  const siblings = page.locator(`form[data-source-classification="${fixture.sourceId}"]`);
  assert.equal(await siblings.count(), 5);
  for (let i = 0; i < await siblings.count(); i += 1) {
    assert.equal(await siblings.nth(i).locator("select[name=mainSubject]").inputValue(), fixture.updatedClassification.mainSubject, `sibling ${i + 1} subject refreshed`);
    assert.equal(await siblings.nth(i).locator("input[name=topic]").inputValue(), fixture.updatedClassification.topic, `sibling ${i + 1} topic refreshed`);
    assert.equal(await siblings.nth(i).getAttribute("data-revision"), String(fixture.classificationRevision + 1));
  }
  assert.equal(requests.filter(request => request.path === "/api/source-library/classification").length, 1, "one source-wide write");
  evidence.push(await capture("02-desktop-light-siblings-refreshed", { viewport: "desktop 1440x1000", theme: "light", action: "Saved once; all five source sibling editors reflect updated classification and revision." }));

  const libraryNav = page.locator('.primary-nav [data-view="library"]');
  await libraryNav.focus();
  assert.equal(await libraryNav.evaluate(node => node === document.activeElement), true, "Library navigation control is keyboard focusable");
  await page.keyboard.press("Enter");
  await page.locator("form[data-library-search]").waitFor();
  const shelf = page.locator("select[data-library-subject]");
  await shelf.waitFor();
  assert.equal(await shelf.inputValue(), fixture.updatedClassification.mainSubject, "Library subject shelf refreshes to the source's saved main subject");
  assert.equal(await page.locator(`[data-library-source="${fixture.sourceId}"]`).count(), 1, "source appears on the refreshed main-subject shelf");
  evidence.push(await capture("03-desktop-library-updated-subject-shelf", { viewport: "desktop 1440x1000", theme: "light", action: `Opened Library after saving; its shelf selected '${fixture.updatedClassification.mainSubject}' and displayed the classified source.` }));
  const search = page.locator("form[data-library-search]");
  const queryInput = search.locator("input[name=query]");
  assert.equal(await search.locator("select[name=searchScope]").inputValue(), "knowledge", "new Library search defaults to knowledge without an interaction");
  await queryInput.fill(fixture.updatedClassification.topic);
  await search.getByRole("button", { name: "Search", exact: true }).click();
  try { await page.locator("[data-library-knowledge]").first().waitFor(); }
  catch (error) { throw new Error(`Default topic search did not render knowledge hits. Requests: ${JSON.stringify(requests.filter(request => request.path === "/api/source-library/search"))}`, { cause: error }); }
  assert.equal(await page.locator("[data-library-knowledge]").count(), 5, "topic-only query returns each associated knowledge hit without selecting a scope");
  assert.equal(await page.locator("form[data-library-search] select[name=searchScope]").inputValue(), "knowledge", "knowledge is preselected as the default search method");
  assert.equal(requests.filter(request => request.path === "/api/source-library/search").at(-1)?.query?.scope, "knowledge", "default query scope is knowledge");
  assert.equal(new Set(await page.locator("[data-library-knowledge]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-library-knowledge")))).size, 5, "topic match has no duplicated knowledge rows");
  assert.equal(await page.locator("[data-library-knowledge] a").evaluateAll((nodes, sourceUrl) => nodes.every(node => node.getAttribute("href") === sourceUrl), fixture.knowledge[0].sourceUrl), true, "knowledge hits preserve their source association");
  evidence.push(await capture("04-desktop-library-topic-search", { viewport: "desktop 1440x1000", theme: "light", action: `Default Library query searched the source-owned topic '${fixture.updatedClassification.topic}' without changing scope; five associated knowledge hits rendered.` }));
  await queryInput.fill("dominant");
  await search.getByRole("button", { name: "Search", exact: true }).click();
  await page.locator("[data-library-knowledge]").first().waitFor();
  assert.equal(await page.locator("[data-library-knowledge]").count(), 1, "content-only query renders its single point");
  assert.equal(await page.locator("[data-library-knowledge]").first().getAttribute("data-library-knowledge"), "synthetic-k3", "knowledge result remains tied to its source point");
  await search.locator("select[name=searchScope]").selectOption("sources");
  await queryInput.fill("Synthetic source");
  await search.getByRole("button", { name: "Search", exact: true }).click();
  await page.locator("[data-library-source]").first().waitFor();
  assert.equal(await page.locator("[data-library-source]").count(), 1, "source-only query renders synthetic source result");
  assert.equal(requests.filter(request => request.path === "/api/source-library/search").at(-1)?.query?.scope, "sources");
  evidence.push(await capture("05-desktop-library-source-search", { viewport: "desktop 1440x1000", theme: "light", action: "Library source scope searched for 'Synthetic source'; source result rendered." }));

  const motionState = await page.evaluate(() => ({ reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior, transitionDuration: getComputedStyle(document.documentElement).transitionDuration, animationDuration: getComputedStyle(document.querySelector(".primary-nav") ?? document.body).animationDuration }));
  assert.equal(motionState.reducedMotion, true, "browser context emulates the OS reduced-motion preference");
  const longMotion = value => value.split(",").some(part => Number.parseFloat(part) > 0.02 && part.trim().endsWith("s"));
  assert.equal(longMotion(motionState.transitionDuration), false, "reduced motion disables root transitions");
  assert.equal(longMotion(motionState.animationDuration), false, "reduced motion disables navigation animations");
  evidence.push(await capture("06-desktop-light-reduced-motion", { viewport: "desktop 1440x1000", theme: "light", action: "Verified emulated OS reduced motion and computed transition/animation durations; both are disabled or at most 0.02s.", motionState }));

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-setting="theme"][value="dark"]').check();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.locator('.primary-nav [data-view="feed"]').click();
  await page.locator(".learner-feed").waitFor();
  evidence.push(await capture("07-desktop-dark-feed", { viewport: "desktop 1440x1000", theme: "dark", action: "Switched theme through Settings and reopened Feed." }));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.primary-nav [data-view="library"]').click();
  await page.locator("form[data-library-search]").waitFor();
  await page.locator("form[data-library-search] input[name=query]").fill(fixture.updatedClassification.topic);
  await page.locator("form[data-library-search]").getByRole("button", { name: "Search", exact: true }).click();
  await page.locator("[data-library-knowledge]").first().waitFor();
  evidence.push(await capture("08-mobile-dark-library-content-search", { viewport: "mobile 390x844", theme: "dark", action: "Repeated Library content search on mobile." }));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-setting="theme"][value="light"]').check();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.locator('.primary-nav [data-view="feed"]').click();
  await page.locator(".learner-feed").waitFor();
  evidence.push(await capture("09-mobile-light-feed", { viewport: "mobile 390x844", theme: "light", action: "Switched theme and reopened Feed at mobile width." }));

  const overflow = await page.evaluate(() => ({ viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.ok(overflow.documentWidth <= overflow.viewportWidth + 1, `mobile viewport overflow: ${JSON.stringify(overflow)}`);
  assert.deepEqual(requests.filter(request => request.kind === "outside-origin"), [], "browser made no request outside local origin");
  assert.deepEqual(pageErrors, [], "no browser runtime exceptions");
  assert.deepEqual(consoleErrors, [], "no browser console errors");
  assert.deepEqual(failedResponses, [], "no failed browser network responses");
  assert.equal(classificationRevision, fixture.classificationRevision + 1);
  const report = { status: "PASS", fixture: "Synthetic isolated browser fixture; not production or learner data.", origin: "127.0.0.1 local fixture server", browser: "Installed Google Chrome through repo-declared playwright-core", freshProfile: "Temporary unique profile", assertions: ["classification editor has exactly main-subject dropdown and topic text input", "classification disclosure is Enter-operable; Tab moves from disclosure to subject field; topic input, save, and Library navigation are keyboard operable and focusable", "single source-wide save refreshed all five same-source Feed siblings", "after save and navigation, Library main-subject shelf selected the updated subject and displayed the source", "topic-only query is absent from every fixture summary and matches without changing the default knowledge scope", "content-only query returns only its associated knowledge point", "source search and knowledge search return scope-specific results", "emulated OS reduced motion disables computed transitions and animations", "desktop and mobile in light and dark themes", "no off-origin requests, failed responses, runtime exceptions, or console errors", "mobile no horizontal overflow"], requests: requests.map(({ body, ...request }) => ({ ...request, ...(body && typeof body === "object" ? { bodyFields: Object.keys(body).sort() } : {}) })), responses: requests.filter(request => request.path).map(request => ({ path: request.path, status: 200 })), evidence, pageErrors, consoleErrors, failedResponses };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`));
  completedReport = report;
} catch (error) {
  await mkdir(artifactDir, { recursive: true });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(artifactDir, "failure.json"), `${JSON.stringify({ error: error instanceof Error ? error.stack : String(error), requests, pageErrors, consoleErrors, failedResponses }, null, 2)}\n`));
  throw error;
} finally {
  if (browserContext) {
    try { await browserContext.close(); cleanup.browserContextClosed = true; }
    catch (error) { console.error("Browser context cleanup failed", error); process.exitCode = 1; }
  }
  if (server?.listening) await new Promise(resolveClose => server.close(() => { cleanup.fixtureServerClosed = true; resolveClose(); }));
  else cleanup.fixtureServerClosed = true;
  await rm(profile, { recursive: true, force: true });
  try { await import("node:fs/promises").then(({ access }) => access(profile)); }
  catch { cleanup.profileRemoved = true; }
  await import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(artifactDir, "cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`));
}

if (completedReport !== null) {
  const report = completedReport;
  const cleanupResult = JSON.parse(await readFile(resolve(artifactDir, "cleanup.json"), "utf8"));
  assert.deepEqual(cleanupResult, { browserContextClosed: true, profileRemoved: true, fixtureServerClosed: true }, "browser, isolated profile, and fixture server are fully cleaned up");
  report.cleanup = cleanupResult;
  await import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`));
  console.log(JSON.stringify({ status: report.status, artifactDir, evidence: report.evidence.map(({ screenshot }) => screenshot), assertions: report.assertions, cleanup: cleanupResult }));
}
