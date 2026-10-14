// Synthetic local fixtures only: no hosted data, real searches, uploads, or answers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { buildProgress } from "../src/features/progress/public.js";

const root = resolve("dist"), output = resolve("output/playwright/empty-states");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const server = createServer((req, res) => {
  const path = resolve(root, `.${new URL(req.url, "http://localhost").pathname}`);
  if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  const file = path === root ? resolve(root, "index.html") : path;
  res.setHeader("content-type", mime[extname(file)] ?? "application/octet-stream");
  const stream = createReadStream(file);
  stream.on("error", () => { res.writeHead(404).end(); }); stream.pipe(res);
});
let browser;
let searchRequests = 0;
const errors = [], screenshots = [];
try {
  await mkdir(output, { recursive: true });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "localhost", done); });
  const origin = `http://localhost:${server.address().port}`;
  browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    let result;
    if (path.endsWith("/capabilities")) result = [{ id: "web", label: "Web sources", resultKind: "web", priority: 1, enabled: true }, { id: "youtube", label: "YouTube videos", resultKind: "video", priority: 2, enabled: true }];
    else if (path === "/api/discovery/search") {
      searchRequests++;
      const command = route.request().postDataJSON();
      result = { items: command.query === "nothing" ? [] : [{ providerId: "youtube", resultKind: "video", sourceLevel: "video", title: 'Synthetic video: rhythm & <meter>', description: "Synthetic local browser fixture", canonicalUrl: "https://www.youtube.com/watch?v=synthetic", publisherLabel: "Fixture publisher", publishedAt: null, identityEvidence: [{ attribute: "youtube-api-video-id", value: "synthetic", provenanceUrl: "https://www.youtube.com/watch?v=synthetic" }] }], providerFailures: [], submittedQuery: command.query, providerQuery: command.query, policyVersion: "fixture-v1" };
    } else if (path === "/api/source-library") result = { items: [], interestAreas: [{ id: "music", ownerId: "fixture", title: "Music", provenance: "configured" }], nextCursor: null };
    else if (path.endsWith("/suppressions/check")) result = [];
    else if (path.endsWith("/feed-batch")) result = { batch: null, items: [] };
    else if (path.endsWith("/review-batch")) result = { batch: null, questions: [], dueCount: 0 };
    else if (path.endsWith("/library-knowledge")) result = { items: [] };
    else if (path.endsWith("/progress")) {
      const summary = buildProgress({ days: Number(url.searchParams.get("days")), now: "2026-10-14T12:00:00.000Z", subject: null, attempts: [], studies: [] });
      assert(summary.ok); result = summary.value;
    } else { await route.fulfill({ status: 404, json: { error: "SyntheticRouteMissing" } }); return; }
    await route.fulfill({ json: { result } });
  });
  await page.goto(`${origin}/#discover`);
  await page.locator('[data-discovery-state="never-run"] .empty-art').waitFor();
  assert.equal(await page.locator('[data-discovery-item-id]').count(), 0);
  assert.equal(searchRequests, 0);
  assert.equal(await page.getByText("YouTube API Services", { exact: true }).count(), 0);
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const panel of ["discover", "feed", "review", "library", "progress", "upload"]) {
      await page.locator(`[data-view="${panel}"]`).first().click();
      await page.locator("main .empty-art").first().waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${panel} ${theme} ${width}: no overflow`);
      const name = `${panel}-${theme}-${width}.png`;
      await page.screenshot({ path: resolve(output, name), fullPage: true }); screenshots.push(name);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('[data-view="discover"]').click();
  await page.locator('#discover-query').fill('rhythm');
  const options = page.getByText("Search options", { exact: true });
  await options.focus(); await page.keyboard.press("Enter");
  await page.locator('select[name="limit"]').selectOption("20");
  const youtube = page.locator('input[name="provider"][value="youtube"]');
  assert.equal(await youtube.isChecked(), false);
  await youtube.focus(); await page.keyboard.press("Space");
  await page.locator('[data-youtube-policy-accept]').waitFor();
  assert.equal(await page.locator('[data-youtube-policy-accept]').count(), 1);
  await page.locator('[name="youtube-policy"]').check();
  await page.getByRole("button", { name: "Enable YouTube search" }).click();
  await page.locator('[data-youtube-connection][hidden]').waitFor({ state: "attached" });
  assert.equal(await page.locator('#discover-query').inputValue(), "rhythm");
  assert.equal(await page.locator('select[name="limit"]').inputValue(), "20");
  assert.equal(await youtube.isChecked(), true);
  await page.locator('[data-discovery-search-form]').getByRole("button", { name: "Search", exact: true }).click();
  await page.locator('[data-discovery-item-id]').waitFor();
  const searches = searchRequests;
  for (const panel of ["library", "review", "feed", "discover"]) await page.locator(`[data-view="${panel}"]`).first().click();
  await page.locator('[data-discovery-item-id]').waitFor();
  assert.equal(searchRequests, searches, "panel navigation preserves results without another search");
  assert.equal(await page.locator('#discover-query').inputValue(), "rhythm");
  await page.locator('[data-discovery-item-id]').click();
  await page.getByRole("button", { name: "Upload video transcript" }).click();
  await page.locator('[data-upload-form]').waitFor();
  assert.equal(await page.locator('[name="title"]').inputValue(), 'Synthetic video: rhythm & <meter>');
  assert.equal(await page.locator('[data-upload-input]').inputValue(), "text");
  assert.match(await page.locator('.upload-reason').innerText(), /transcript/);
  await page.locator('[data-view="discover"]').click();
  await page.locator('[data-discovery-item-id]').waitFor();
  // Closing and reopening an app document preserves policy acceptance, not results.
  await page.close();
  const reopened = await context.newPage();
  reopened.on("pageerror", error => errors.push(error.message));
  await reopened.goto(`${origin}/#discover`);
  await reopened.locator('[data-discovery-state="never-run"] .empty-art').waitFor();
  assert.equal(await reopened.locator('[data-discovery-item-id]').count(), 0);
  assert.equal(searchRequests, searches);
  await reopened.getByText("Search options", { exact: true }).click();
  await reopened.locator('input[value="youtube"]').check();
  assert.equal(await reopened.locator('[data-youtube-policy-accept]').count(), 0, "accepted policy does not reappear after reopen");
  await reopened.locator('#discover-query').fill("nothing");
  await reopened.locator('[data-discovery-search-form]').getByRole("button", { name: "Search", exact: true }).click();
  await reopened.locator('[data-discovery-state="empty"] .empty-art').waitFor();
  assert.equal(await reopened.locator('[data-discovery-item-id]').count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, "report.json"), JSON.stringify({ status: "PASS", syntheticFixtures: true, searchRequests, errors, screenshots, checked: ["empty panels in both themes at desktop/mobile", "keyboard YouTube selection and one-time persisted acceptance", "query/provider/limit preserved through consent", "results retained across panels and cleared on app reopen", "YouTube transcript upload title and text mode", "zero-result artwork"] }, null, 2));
  console.log(`PASS: ${screenshots.length} screenshots; policy, session results, transcript handoff and empty panels verified.`);
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
