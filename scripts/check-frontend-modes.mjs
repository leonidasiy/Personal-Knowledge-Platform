// Run after deno task build and serving dist on port 4320.
// Synthetic browser-only data; never contacts the hosted service.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const origin = process.env.REMINDER_TEST_ORIGIN ?? "http://localhost:4320";
if (!["http://localhost:4320", "http://localhost:4321"].includes(origin)) throw new Error("LocalTestOriginRequired");
const output = new URL("../test-results/frontend-modes/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [], remote = [], writes = [];
const batch = { batchId: "synthetic-batch", learningDay: "2026-09-19", status: "open", itemIds: ["1", "2", "3", "4", "5"], revision: 1, createdAt: "2026-09-19T00:00:00Z", completedAt: null };
const titles = ["Why retrieval strengthens memory", "The shape of a good question", "Finding patterns across subjects", "Letting time do some of the work", "Turning feedback into the next attempt"];
const items = titles.map((title, i) => ({ knowledgeId: String(i + 1), sourceId: "synthetic-source", questionId: "q" + i, title, summary: "Synthetic visual-test content, not a learner record. A useful study session connects an idea to what you already know, then gives you a chance to retrieve it without looking. Return after a delay and notice what comes back.", sourceUrl: "https://example.test/synthetic", evidenceAnchorIds: ["synthetic-anchor"], media: null, questionLocked: true }));
let feedState = "success";
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", e => { errors.push(e.message); console.error("Browser exception:", e.message); });
  page.on("request", r => { if (!r.url().startsWith(origin)) remote.push(r.url()); });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    // This public read query uses POST for its bounded list of source IDs.
    if (request.method() !== "GET" && path !== "/api/source-library/suppressions/check") writes.push(path);
    if (path.endsWith("/feed-batch")) {
      if (feedState === "error") return route.fulfill({ status: 503, json: { error: "SyntheticUnavailable" } });
      return route.fulfill({ json: { result: feedState === "empty" ? { batch: null, items: [] } : { batch, items } } });
    }
    if (path.endsWith("/review-batch")) return route.fulfill({ json: { result: { batch: { ...batch, itemIds: ["q0"] }, dueCount: 1, questions: [{ questionId: "q0", knowledgeId: "1", title: titles[0], prompt: "Synthetic check: what happens after a delay?", kind: "fill-blank", choices: null, blanks: null, sourceAnchorIds: ["synthetic-anchor"], revision: 1 }] } } });
    if (path.endsWith("/library-knowledge")) return route.fulfill({ json: { result: { items: [] } } });
    if (path === "/api/source-library") return route.fulfill({ json: { result: { items: [], interestAreas: [], nextCursor: null } } });
    if (path.endsWith("/capabilities")) return route.fulfill({ json: { result: [{ id: "synthetic", label: "Synthetic test provider", resultKind: "website", priority: 1, enabled: true }] } });
    // Explicit unavailable service exercises recovery UI for non-learner routes.
    return route.fulfill({ status: 503, json: { error: "SyntheticUnavailable" } });
  });
  const ready = async () => { await page.locator(".learner-feed").waitFor(); await page.evaluate(() => document.fonts.ready); };
  let previousView = "feed";
  const settings = async () => {
    if (await page.locator(".settings-page").count()) return;
    previousView = await page.locator(".primary-nav button.active").getAttribute("data-view");
    await page.getByRole("button", {name:"Settings", exact:true}).click();
    await page.locator('[data-setting="sound"]').waitFor();
  };
  const theme = async mode => {
    await settings();
    await page.locator(`input[data-setting="theme"][value="${mode}"]`).check();
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, mode === "system" ? "light" : mode);
  };
  const closeSettings = async () => { if (await page.locator(".settings-page").count()) { await page.locator(`.primary-nav [data-view="${previousView}"]`).click(); await page.locator(".settings-page").waitFor({state:"hidden"}); } };
  await page.goto(origin);
  await ready();
  await settings();
  assert.equal(await page.locator('input[data-setting="sound"]').isChecked(), false);
  await closeSettings();
  assert.equal(await page.locator('[data-setting="layout"]').count(), 0);
  assert.equal(await page.locator("main").getAttribute("data-layout"), null);
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-focus-key")), "theme-" + mode);
    await closeSettings();
    assert.equal(await page.locator("main").getAttribute("data-layout"), null);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator("body").evaluate(e => getComputedStyle(e).color), mode === "dark" ? "rgb(237, 243, 242)" : "rgb(34, 45, 48)");
    await page.screenshot({ path: fileURLToPath(new URL(mode + ".png", output)) });
    for (const size of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }, { width: 812, height: 375 }, { width: 320, height: 700 }]) {
      await page.setViewportSize(size);
      for (const view of ["feed", "review", "discover", "library"]) {
        await page.locator(`.primary-nav [data-view="${view}"]`).click();
        await page.waitForFunction(expected => document.querySelector(".primary-nav button.active")?.getAttribute("data-view") === expected, view);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${mode}/${view}/${size.width} overflow`);
      }
      await settings();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Settings overflow");
      await closeSettings();
      if (size.width === 375) {
        await page.locator('.primary-nav [data-view="feed"]').click();
        await ready();
        await page.screenshot({ path: fileURLToPath(new URL(mode + "-mobile.png", output)) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.primary-nav [data-view="feed"]').click();
  }
  await page.reload();
  await ready();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await settings();
  await page.locator('input[data-setting="sound"]').check();
  assert.ok(await page.locator('input[data-setting="sound"]').isChecked());
  await page.locator('input[data-setting="sound"]').uncheck();
  assert.equal(await page.locator('input[data-setting="sound"]').isChecked(), false);
  await theme("system");
  await closeSettings();
  await page.locator('.primary-nav [data-view="review"]').click();
  const answer = page.locator('input[name="answerText"]');
  await answer.fill("Unsubmitted synthetic answer");
  await answer.focus();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await answer.inputValue(), "Unsubmitted synthetic answer");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")), "answerText");
  assert.equal(await page.locator("main").getAttribute("data-layout"), null);
  await page.emulateMedia({ colorScheme: "light", forcedColors: "active" });
  await settings();
  await page.locator('input[data-setting="theme"][value="light"]').focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector('input[data-setting="theme"][value="light"]')?.checked === true);
  assert.notEqual(await page.locator('input[data-setting="theme"][value="light"] + span').evaluate(e => getComputedStyle(e).outlineStyle), "none");
  await page.emulateMedia({ forcedColors: "none" });
  await page.locator('.primary-nav [data-view="feed"]').click();
  await ready();
  for (const state of ["empty", "error"]) {
    feedState = state;
    for (const mode of ["light", "dark"]) {
      await theme(mode);
      await closeSettings();
      await page.reload();
      await page.locator(".state-panel").waitFor();
      assert.match(await page.locator("main").innerText(), state === "empty" ? /No complete learning batch/ : /could not be updated/);
    }
  }
  assert.deepEqual(writes, [], "Theme/navigation checks must never mutate learner APIs");
  assert.deepEqual(remote, [], "No external assets or services");
  assert.deepEqual(errors, [], "No browser exceptions");
  await context.close();
  // Separate real service-worker context: install the build then go offline.
  const offline = await browser.newContext();
  const probe = await offline.newPage();
  await probe.goto(origin);
  await probe.evaluate(async () => { await navigator.serviceWorker.ready; });
  await probe.reload();
  await probe.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await offline.setOffline(true);
  await probe.reload();
  await probe.getByRole("button", {name:"Settings", exact:true}).click();
  for (const mode of ["dark", "light"]) {
    await probe.locator(`input[data-setting="theme"][value="${mode}"]`).check();
    await probe.waitForFunction(expected => document.documentElement.dataset.theme === expected, mode);
    await probe.evaluate(() => document.fonts.ready);
    const family = mode === "light" ? "Fraunces" : "Syne";
    assert.ok(await probe.evaluate(name => document.fonts.check(`600 24px "${name}"`), family), "Offline display font");
    assert.ok(await probe.evaluate(() => document.fonts.check('400 16px "Manrope"')), "Offline body font");
  }
  await offline.close();
  console.log("PASS: both palettes, four routes, 320/375/812/1440px, focus, drafts, persistence/system, forced colors, empty/error states, no learner writes, offline fonts. Screenshots: test-results/frontend-modes/");
} finally {
  await browser.close();
}
