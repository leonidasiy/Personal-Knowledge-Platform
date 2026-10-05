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
const shellRoot = resolve(root, "dist");
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
const observedResponses = [];
const offlineDiagnostics = [];
const failureProbes = [];
const cleanup = { browserContextClosed: false, profileRemoved: false, fixtureServerClosed: false };
let completedReport = null;
let classification = { ...fixture.initialClassification };
let classificationRevision = fixture.classificationRevision;
let browserContext;
let server;

const contentTypes = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"], [".webp", "image/webp"], [".png", "image/png"], [".woff2", "font/woff2"]]);
async function fixtureApi(url, method, body, json, notFound) {
    const path = url.pathname;
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
    if (path === "/api/source-library/classification" && method === "POST") {
      assert.equal(body?.sourceId, fixture.sourceId, "classification save is source scoped");
      assert.equal(body?.sourceRevision, fixture.sourceRevision);
      assert.equal(body?.expectedRevision, classificationRevision);
      classification = { mainSubject: body.mainSubject, topic: body.topic };
      classificationRevision += 1;
      return json({ result: { sourceId: fixture.sourceId, sourceRevision: fixture.sourceRevision, classificationRevision, ...classification } });
    }
    if (path.endsWith("/capabilities")) return json({ result: [{ id: "web", label: "Web sources", resultKind: "web", priority: 1, enabled: true }] });
    if (path.endsWith("/reminders") || path.endsWith("/preferences")) return json({ result: {} });
    return notFound();
}

async function startServer() {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", async () => {
        try {
          const raw = Buffer.concat(chunks).toString();
          const body = raw ? JSON.parse(raw) : null;
          await fixtureApi(url, req.method, body,
            value => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); },
            () => { res.writeHead(404).end("SyntheticFixtureRouteMissing"); });
        } catch (error) { console.error("Synthetic fixture request failed", error); res.writeHead(500).end("SyntheticFixtureRequestFailed"); }
      });
      return;
    }
    const path = resolve(shellRoot, `.${decodeURIComponent(url.pathname)}`);
    if (path !== shellRoot && !path.startsWith(`${shellRoot}${sep}`)) { res.writeHead(403).end(); return; }
    const file = path === shellRoot ? resolve(shellRoot, "index.html") : path;
    res.setHeader("content-type", contentTypes.get(extname(file)) ?? "application/octet-stream");
    const stream = createReadStream(file);
    stream.on("error", () => { if (!res.headersSent) res.writeHead(404); res.end("Not found"); });
    stream.pipe(res);
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "localhost", resolveListen); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("LocalFixtureServerAddressUnavailable");
  return `http://localhost:${address.port}`;
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
    headless: true, viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "reduce", serviceWorkers: "allow",
    args: ["--no-first-run", "--no-default-browser-check"], timeout: 20000,
  });
  await browserContext.exposeBinding("recordOfflineRegistration", (_, value) => offlineDiagnostics.push(value));
  await browserContext.addInitScript(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = async (...args) => {
      try {
        const registration = await register(...args);
        await window.recordOfflineRegistration({ outcome: "resolved", registrationPresent: registration !== undefined, script: String(args[0]), secureContext: isSecureContext });
        return registration;
      }
      catch (error) {
        await window.recordOfflineRegistration({ name: error.name, message: error.message, script: String(args[0]), secureContext: isSecureContext });
        throw error;
      }
    };
  });
  const page = browserContext.pages()[0] ?? await browserContext.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", response => {
    const observed = { status: response.status(), url: response.url() };
    observedResponses.push(observed);
    if (response.status() >= 400) failedResponses.push(observed);
  });
  page.on("request", request => { if (!request.url().startsWith(origin)) requests.push({ kind: "outside-origin", url: request.url() }); });
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort("blockedbyclient"));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postDataJSON() ?? null;
    const entry = { method: request.method(), path, query: Object.fromEntries(url.searchParams), body };
    requests.push(entry);
    const json = value => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    return fixtureApi(url, request.method(), body, json, () => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Synthetic fixture has no response for this route" }) }));
  });

  const capture = async (name, details) => {
    const screenshot = resolve(artifactDir, `${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    return { screenshot, ...details };
  };
  const evidence = [];
  await page.goto(origin, { waitUntil: "networkidle", timeout: 15000 });
  await page.locator(".learner-feed").waitFor();
  assert.equal(offlineDiagnostics.some(item => item.name || item.registrationPresent === false), false, "Native registration must return a registration without rejection");
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.state === "activated" && navigator.serviceWorker.controller !== null;
  }, null, { timeout: 15000 });
  assert.equal(await page.getByText("Offline access failed. Reconnect and reload.", { exact: true }).count(), 0);
  const offlineState = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return { scriptURL: registration.active.scriptURL, scope: registration.scope, state: registration.active.state, controlled: navigator.serviceWorker.controller !== null, cacheNames: await caches.keys(), secureContext: isSecureContext };
  });
  await browserContext.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".primary-nav").waitFor();
    assert.equal(await page.getByText("Offline access failed. Reconnect and reload.", { exact: true }).count(), 0, "cached offline shell does not show registration failure");
  } finally { await browserContext.setOffline(false); }
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".learner-feed").waitFor();
  assert.deepEqual(failedResponses, [], "No unexpected responses during registration or offline reload");
  const geometryFailures = [];
  const geometry = async () => page.locator(".discover-search").evaluate(panel => {
    const style = getComputedStyle(panel);
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const nodes = [...panel.querySelectorAll("form > label, .discover-search-row, summary, input, button, select, fieldset")].filter(node => node.checkVisibility());
    return { panel: rect(panel), padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], radius: style.borderRadius, expectedRadius: style.getPropertyValue("--panel-radius").trim(), overflow: panel.scrollWidth > panel.clientWidth, documentOverflow: document.documentElement.scrollWidth > innerWidth, direction: getComputedStyle(panel.querySelector(".discover-search-row")).flexDirection, alignment: [...panel.querySelectorAll("form > label, .discover-search-row, summary")].map(node => rect(node).x), controls: nodes.map(node => ({ tag: node.tagName, ...rect(node), overflow: node.scrollWidth > node.clientWidth + 1 })), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, transition: getComputedStyle(panel.querySelector("button")).transitionDuration };
  });
  for (const theme of ["light", "dark"]) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(`[data-setting="theme"][value="${theme}"]`).check();
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    await page.locator('.primary-nav [data-view="discover"]').click();
    await page.locator(".discover-search").waitFor();
    for (const width of [1240, 1280, 1440, 799, 800, 801, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const options = page.locator(".discover-filters summary");
      for (const open of [false, true]) {
        if (await options.evaluate(node => node.parentElement.open) !== open) {
          await options.focus();
          await page.keyboard.press("Enter");
        }
        assert.equal(await options.evaluate(node => node.parentElement.open), open, "Enter toggles Search options");
        await page.getByLabel("Find a learning source", { exact: true }).fill("Synthetic harmony question");
        if (open) {
          const provider = page.getByLabel("Web sources", { exact: true });
          await provider.uncheck();
          await provider.check();
          await page.locator('.discover-filters select[name="limit"]').selectOption("10");
        }
        const query = page.getByLabel("Find a learning source", { exact: true });
        assert.equal(await query.getAttribute("type"), "search");
        assert.equal(await page.getByRole("button", { name: "Search", exact: true }).count(), 1);
        await options.focus();
        await page.keyboard.press("Tab");
        if (open) assert.equal(await page.getByLabel("Web sources", { exact: true }).evaluate(node => node === document.activeElement), true, "open options expose provider next in keyboard order");
        else assert.equal(await page.locator(".discover-filters").evaluate(node => node.contains(document.activeElement)), false, "closed options remove inner controls from keyboard order");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await options.evaluate(node => node === document.activeElement), true, "reverse Tab returns to disclosure without trap");
        await options.focus();
        const focus = await options.evaluate(node => ({ active: node === document.activeElement, outline: getComputedStyle(node).outlineWidth }));
        assert.equal(focus.active, true);
        assert.equal(focus.outline, "3px", "keyboard focus remains visible");
        await page.locator(".discover-search").scrollIntoViewIfNeeded();
        const measured = await geometry();
        evidence.push(await capture(`discover-${theme}-${width}-${open ? "open" : "closed"}`, { viewport: `${width}x${width === 390 ? 844 : 1000}`, theme, action: "Navigated to Discover, typed query, keyboard toggled options, toggled provider and selected limit; scrolled panel into view.", open, geometry: measured, focus }));
        try {
          assert.equal(measured.overflow || measured.documentOverflow, false, `${width}: no horizontal overflow`);
          assert.equal(measured.direction, width > 800 ? "row" : "column");
          assert.equal(measured.reducedMotion, true);
          assert.equal(measured.transition, "1e-05s");
          if (width > 800) {
            assert.deepEqual(measured.padding, ["24px", "24px", "24px", "24px"], `${width}: 24px panel inset`);
            assert.deepEqual(measured.borders, ["1px", "1px", "1px", "1px"]);
            assert.equal(measured.radius, measured.expectedRadius);
            for (const control of measured.controls) {
              assert(control.x >= measured.panel.x + 25 - 1 && control.right <= measured.panel.right - 25 + 1 && control.y >= measured.panel.y + 25 - 1 && control.bottom <= measured.panel.bottom - 25 + 1, `${width}: ${control.tag} within padded panel`);
              assert.equal(control.overflow, false, `${width}: ${control.tag} does not clip`);
            }
            for (const x of measured.alignment) assert(Math.abs(x - measured.panel.x - 25) <= 1, `${width}: label/search/options aligned`);
          } else {
            assert.deepEqual(measured.padding, ["24px", "0px", "24px", "0px"]);
            assert.deepEqual(measured.borders, ["1px", "0px", "1px", "0px"]);
            assert.equal(measured.radius, "0px");
            // Compare every measured control with the original mobile rule, including open options.
            const baseline = await page.addStyleTag({ content: ".discover-search { padding:24px 0; border:0; border-radius:0; border-block:1px solid var(--border); }" });
            assert.deepEqual(await geometry(), measured, `${width}: mobile layout unchanged`);
            await baseline.evaluate(node => node.remove());
          }
        } catch (error) { geometryFailures.push(`${theme}/${width}/${open}: ${error.message}`); }
      }
    }
  }
  assert.deepEqual(geometryFailures, [], "Discover geometry acceptance");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-setting="theme"][value="light"]').check();
  await page.locator('.primary-nav [data-view="feed"]').click();
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
  assert.equal(await page.getByRole("status").filter({ hasText: "Source classification saved." }).count(), 1, "save feedback exposes status semantics");
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
  await page.waitForFunction(subject => document.querySelector("select[data-library-subject]")?.value === subject, fixture.updatedClassification.mainSubject);
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
  const probeBrowser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  try {
    for (const mode of ["blocked", "rejected", "missing-worker", "unsupported"]) {
      const context = await probeBrowser.newContext({ serviceWorkers: mode === "blocked" ? "block" : "allow" });
      const diagnostics = [];
      const probeResponses = [];
      try {
        await context.exposeBinding("recordProbe", (_, value) => diagnostics.push(value));
        await context.addInitScript(mode => {
          if (mode === "unsupported") { delete Navigator.prototype.serviceWorker; return; }
          const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
          navigator.serviceWorker.register = async (...args) => {
            try {
              if (mode === "rejected") throw new DOMException("Synthetic registration denial", "SecurityError");
              const registration = await register(...(mode === "missing-worker" ? ["./missing-service-worker.js"] : args));
              await window.recordProbe({ outcome: "resolved", registrationPresent: registration !== undefined, script: String(args[0]), secureContext: isSecureContext });
              return registration;
            } catch (error) {
              await window.recordProbe({ outcome: "rejected", name: error.name, message: error.message, script: mode === "missing-worker" ? "./missing-service-worker.js" : String(args[0]), secureContext: isSecureContext });
              throw error;
            }
          };
        }, mode);
        const probe = await context.newPage();
        probe.on("response", response => { if (response.status() >= 400) probeResponses.push({ status: response.status(), url: response.url() }); });
        await probe.goto(origin, { waitUntil: "networkidle" });
        await probe.locator(".learner-feed").waitFor();
        const message = probe.getByText("Offline access failed. Reconnect and reload.", { exact: true });
        if (mode === "unsupported") {
          assert.equal(await probe.evaluate(() => "serviceWorker" in navigator), false);
          assert.equal(await message.count(), 0, "Unsupported API follows existing no-registration contract");
        } else {
          await message.waitFor();
          assert.equal(await probe.getByRole("alert").filter({ hasText: "Offline access failed." }).count(), 1);
          if (mode === "blocked") assert.equal(diagnostics[0]?.registrationPresent, false, "Playwright blocking resolves without a registration");
          else {
            assert.equal(diagnostics[0]?.outcome, "rejected");
            assert.equal(typeof diagnostics[0]?.message, "string");
            if (mode === "rejected") assert.equal(diagnostics[0]?.name, "SecurityError");
          }
          await probe.screenshot({ path: resolve(artifactDir, `offline-${mode}-visible.png`) });
          await probe.getByRole("button", { name: "Close notification", exact: true }).click();
          assert.equal(await message.count(), 0, "Failure notification remains dismissible");
        }
        const screenshot = resolve(artifactDir, `offline-${mode}.png`);
        await probe.screenshot({ path: screenshot });
        failureProbes.push({ mode, diagnostics, failedResponses: probeResponses, visibleScreenshot: mode === "unsupported" ? null : resolve(artifactDir, `offline-${mode}-visible.png`), screenshot, notificationVerified: mode !== "unsupported", contextClosed: false });
      } finally {
        await context.close();
        const result = failureProbes.find(item => item.mode === mode);
        if (result) result.contextClosed = true;
      }
    }
  } finally { await probeBrowser.close(); }
  const report = { status: "PASS", acceptanceScope: "Automated local browser checks only; actual screen-reader announcements and reading order unresolved.", offlineState, offlineDiagnostics, failureProbes, fixture: "Synthetic isolated browser fixture; not production or learner data.", origin: "localhost local fixture server", browser: "Installed Google Chrome through repo-declared playwright-core", freshProfile: "Temporary unique profile", assertions: ["Discover panel geometry at 1240/1280/1440 and 799/800/801/390 in both themes with options closed/open; 24px desktop inset, border/radius, alignment, no clipping/overflow and unchanged mobile geometry", "Discover keyboard options, visible focus, typed query, provider toggle, result limit and reduced motion", "classification editor has exactly main-subject dropdown and topic text input", "classification disclosure is Enter-operable; Tab moves from disclosure to subject field; topic input, save, and Library navigation are keyboard operable and focusable", "single source-wide save refreshed all five same-source Feed siblings", "after save and navigation, Library main-subject shelf selected the updated subject and displayed the source", "topic-only query is absent from every fixture summary and matches without changing the default knowledge scope", "content-only query returns only its associated knowledge point", "source search and knowledge search return scope-specific results", "emulated OS reduced motion disables computed transitions and animations", "desktop and mobile in light and dark themes", "no off-origin requests, failed responses, runtime exceptions, or console errors", "mobile no horizontal overflow"], requests: requests.map(({ body, ...request }) => ({ ...request, ...(body && typeof body === "object" ? { bodyFields: Object.keys(body).sort() } : {}) })), responses: observedResponses.filter(response => new URL(response.url).pathname.startsWith("/api/")), evidence, pageErrors, consoleErrors, failedResponses };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(artifactDir, "report.json"), `${JSON.stringify({ ...report, status: "PENDING_CLEANUP" }, null, 2)}\n`));
  completedReport = report;
  if (process.argv.includes("--interactive")) {
    console.log(JSON.stringify({ interactiveOrigin: origin, artifactDir, instruction: "Synthetic local fixture remains available; press Enter to close and clean up." }));
    await new Promise(done => process.stdin.once("data", done));
  }
} catch (error) {
  await mkdir(artifactDir, { recursive: true });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(artifactDir, "failure.json"), `${JSON.stringify({ error: error instanceof Error ? error.stack : String(error), requests, offlineDiagnostics, failureProbes, observedResponses, pageErrors, consoleErrors, failedResponses }, null, 2)}\n`));
  throw error;
} finally {
  if (browserContext) {
    try { await browserContext.close(); cleanup.browserContextClosed = true; }
    catch (error) { console.error("Browser context cleanup failed", error); process.exitCode = 1; }
  }
  if (server?.listening) await new Promise((resolveClose, rejectClose) => server.close(error => { if (error) { rejectClose(error); return; } cleanup.fixtureServerClosed = true; resolveClose(); }));
  else cleanup.fixtureServerClosed = true;
  await rm(profile, { recursive: true, force: true });
  try { await import("node:fs/promises").then(({ access }) => access(profile)); }
  catch (error) { if (error?.code !== "ENOENT") throw error; cleanup.profileRemoved = true; }
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
