// Local synthetic browser regression: shelf filtering, persistence and recovery.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { SUBJECTS } from "../src/features/knowledge-subjects/public.js";

const origin = "http://localhost:4320", output = "output/playwright/refinement";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const time = "2026-09-19T12:00:00.000Z";
const source = id => ({ id, ownerId: "local-owner-v1", title: `Synthetic ${id}`, description: "Local test source.", submittedUrl: `https://example.test/${id}`, canonicalUrl: `https://example.test/${id}`, adapter: { id: "web", version: "1", granularity: "root", capabilities: ["metadata"] }, interestAreaIds: [], identityEvidence: [], state: "active", approvedAt: time, updatedAt: time, revision: 1 });
const sources = [source("old"), source("new"), source("legacy")];
sources[0].approvedAt = "2026-09-01T12:00:00.000Z";
sources[2].approvedAt = "2026-08-01T12:00:00.000Z";
const knowledge = [["old", 0], ["new", 0], ["new", 1]].map(([id, subject], i) => ({ knowledgeId: `k${i}`, sourceId: id, questionId: `q${i}`, title: `Synthetic ${id}`, summary: "A source-grounded synthetic relationship.", sourceUrl: `https://example.test/${id}`, evidenceAnchorIds: ["fixture"], questionLocked: true, media: null, classification: { version: 1, primarySubject: SUBJECTS[subject].id, secondarySubjects: [], subcategory: "Synthetic context" }, classificationRevision: 0 }));
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [], remote = [], writes = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem, get = Storage.prototype.getItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "resonance-library-subject" && window.denyShelfWrite) throw new DOMException("Synthetic denial", "SecurityError");
      return set.call(this, key, value);
    };
    Storage.prototype.getItem = function(key) {
      if (key === "resonance-library-subject" && get.call(this, "synthetic-deny-shelf-read") === "true") throw new DOMException("Synthetic denial", "SecurityError");
      return get.call(this, key);
    };
  });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) { remote.push(path); return route.abort(); }
    if (!path.startsWith("/api/")) return route.continue();
    if (request.method() !== "GET") writes.push(path);
    const respond = result => route.fulfill({ json: { result } });
    if (path.endsWith("/feed-batch")) return respond({ batch: null, items: [] });
    if (path.endsWith("/review-batch")) return respond({ batch: null, questions: [], dueCount: 0 });
    if (path === "/api/source-library") return respond({ items: sources, interestAreas: [], nextCursor: null });
    if (path.endsWith("/library-knowledge")) return respond({ items: knowledge });
    if (path.endsWith("/source-status")) return respond({ sourceId: url.searchParams.get("sourceId"), run: null, reasonCode: null, message: null });
    if (path.endsWith("/suppressions/check")) return respond([]);
    if (path === "/api/reminders") return route.fulfill({ status: 503, json: { error: "SyntheticUnavailable" } });
    throw new Error(`UnexpectedFixtureRequest:${path}`);
  });
  const openLibrary = async () => {
    await page.locator('.primary-nav [data-view="library"]').click();
    await page.locator('[data-library-subject]').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-library-subject]')?.value !== "unclassified");
  };
  const ids = () => page.locator('[data-library-source]').evaluateAll(nodes => nodes.map(node => node.dataset.librarySource));
  await page.goto(origin); await openLibrary();
  assert.equal(await page.locator('[data-library-subject]').inputValue(), SUBJECTS[0].id);
  assert.deepEqual(await ids(), ["new", "old"], "Newest first, unrelated legacy excluded");
  for (const theme of ["light", "dark"]) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await page.getByText('Keep Resonance close', { exact: true }).count(), 0);
    await page.locator(`[data-setting="theme"][value="${theme}"]`).check();
    await openLibrary();
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('[data-library-subject]').selectOption(SUBJECTS[1].id);
      assert.deepEqual(await ids(), ["new"], "Multi-subject source appears on its other shelf");
      assert.equal(await page.evaluate(() => localStorage.getItem('resonance-library-subject')), SUBJECTS[1].id);
      assert.equal(await page.locator('[data-library-subject]').evaluate(el => el === document.activeElement), true);
      await page.locator('[data-library-subject]').click();
      await page.screenshot({ path: `${output}/${theme}-${width}-selector.png` });
      await page.keyboard.press('Escape');
      await page.locator('[data-library-subject]').selectOption('unclassified');
      assert.deepEqual(await ids(), ["legacy"]);
      await page.locator('[data-library-subject]').selectOption(SUBJECTS[2].id);
      await page.getByText('No loaded sources in this subject.', { exact: false }).waitFor();
      await page.locator('[data-library-subject]').selectOption(SUBJECTS[0].id);
      await page.locator('[data-reveal="source:old"]').scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${output}/${theme}-${width}-shelf.png` });
    }
  }
  await page.locator('[data-library-subject]').selectOption(SUBJECTS[1].id);
  await page.reload(); await openLibrary();
  assert.equal(await page.locator('[data-library-subject]').inputValue(), SUBJECTS[1].id, "Selection survives reload");
  await page.evaluate(() => { window.denyShelfWrite = true; });
  await page.locator('[data-library-subject]').selectOption(SUBJECTS[0].id);
  assert.deepEqual(await ids(), ["new", "old"], "Current shelf remains usable despite denied persistence");
  await page.getByText('This shelf is selected, but the preference could not be saved for next time.', { exact: true }).waitFor();
  await page.evaluate(() => { window.denyShelfWrite = false; localStorage.setItem('resonance-library-subject', 'invalid'); });
  await page.reload(); await openLibrary();
  await page.getByText('Your saved Library subject is no longer available. Choose another shelf.', { exact: true }).waitFor();
  await page.evaluate(() => localStorage.setItem('synthetic-deny-shelf-read', 'true'));
  await page.reload(); await openLibrary();
  await page.getByText('Your Library subject preference could not be restored. You can still choose a shelf.', { exact: true }).waitFor();
  assert.deepEqual(remote, []); assert.deepEqual(errors, []);
  assert.ok(writes.every(path => path.endsWith('/suppressions/check')));
  console.log('PASS: Library subject filtering/newest/multi-subject/legacy/empty shelves, keyboard focus, native popup, reload persistence, storage denial/invalid recovery, both themes 320/1280. Local fixtures only.');
} finally { await browser.close(); }
