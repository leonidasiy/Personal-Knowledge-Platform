// Local-only real Chrome clicks. Every API is synthetic; no learner/service writes.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { buildProgress } from "../src/features/progress/public.js";

const origin = process.env.REMINDER_TEST_ORIGIN ?? "http://localhost:4320";
if (!["http://localhost:4320", "http://localhost:4321"].includes(origin)) throw new Error("LocalTestOriginRequired");
const output = "output/playwright/revamp";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const now = "2026-09-19T12:00:00.000Z";
const source = { id: "source-a", ownerId: "local-owner-v1", submittedUrl: "https://example.test/learning", canonicalUrl: "https://example.test/learning", title: "A synthetic source for curious minds", description: "Synthetic browser fixture; no personal content.", adapter: { id: "web", version: "1", granularity: "root", capabilities: ["metadata"] }, interestAreaIds: [], identityEvidence: [], state: "active", approvedAt: now, updatedAt: now, revision: 1 };
const batch = { batchId: "fixture", learningDay: "2026-09-19", status: "open", itemIds: ["k0","k1","k2","k3","k4"], revision: 1, createdAt: now, completedAt: null };
// Use the public subject contract, rather than making test classification IDs up.
const { SUBJECTS } = await import("../src/features/knowledge-subjects/public.js");
let completed = false, answer = false, feedState = "ready", libraryQuery = "";
let preferenceFails = false, releasePreference;
const preferencePending = new Promise(resolve => { releasePreference = resolve; });
const requests = [], errors = [], remote = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin && url.protocol !== "file:" && url.protocol !== "data:") { remote.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    requests.push({ path, method: request.method() });
    const respond = result => route.fulfill({ json: { result } });
    if (path.endsWith("/feed-batch")) {
      if (feedState === "error") return route.fulfill({ status: 503, json: { error: "SyntheticUnavailable" } });
      if (feedState === "empty") return respond({ batch: null, items: [] });
      return respond({ batch: { ...batch, status: completed ? "completed" : "open", completedAt: completed ? now : null }, items: batch.itemIds.map((id, i) => ({ knowledgeId: id, sourceId: source.id, questionId: "q"+i, title: ["Ideas grow where they meet", "A pattern worth noticing", "Come back with fresh eyes", "A different way to ask", "Leave room for a question"][i], summary: "Synthetic content for visual verification. Connect the idea to something you know. Return after a delay, then check what you can bring back without looking.", sourceUrl: source.canonicalUrl, evidenceAnchorIds: ["fixture-anchor"], media: null, questionLocked: !completed, classification: { version: 1, primarySubject: SUBJECTS[i].id, secondarySubjects: [], subcategory: "Synthetic source context" }, classificationRevision: 0 })) });
    }
    if (path.endsWith("/feed-batch/complete")) { completed = true; return respond({ completed: true }); }
    if (path.endsWith("/knowledge-preference")) {
      await preferencePending;
      return preferenceFails ? route.fulfill({ status: 503, json: { error: "SyntheticUnavailable" } }) : respond({ completed: true });
    }
    if (path.endsWith("/review-batch")) return respond({ batch: completed ? { ...batch, itemIds: ["q0"], status: answer ? "completed" : "open", completedAt: answer ? now : null } : null, dueCount: completed && !answer ? 1 : 0, questions: completed ? [{ questionId: "q0", knowledgeId: "k0", title: "Recall practice", prompt: "What is the synthetic answer?", kind: "fill-blank", choices: null, blanks: null, sourceAnchorIds: ["fixture-anchor"], revision: 1 }] : [] });
    if (path.endsWith("/review-batch/answer")) { answer = true; return respond({ completed: true, correct: true, score: 1, nextDueAt: "2026-09-20T12:00:00.000Z", feedback: { explanation: "Synthetic correction, shown only after an attempt.", correctAnswer: "retrieval", components: [] } }); }
    if (path.endsWith("/progress")) {
      const result = buildProgress({ now, days: Number(url.searchParams.get("days")), subject: url.searchParams.get("subject"), attempts: [], studies: completed ? [{ completedAt: now, itemCount: 5 }] : [] });
      assert.ok(result.ok); return respond(result.value);
    }
    if (path === "/api/source-library") return respond({ items: [source], interestAreas: [], nextCursor: null });
    if (path === "/api/source-library/search") { libraryQuery = url.searchParams.get("q"); return respond([{ source, score: 1, matchedBy: "exact" }]); }
    if (path.endsWith("/library-knowledge")) return respond({ items: [] });
    if (path.endsWith("/suppressions/check")) return respond([]);
    if (path.endsWith("/source-status")) return respond({ sourceId: source.id, run: null, reasonCode: null, message: null });
    if (path.endsWith("/capabilities")) return respond([{ id: "web", label: "Web", resultKind: "web", priority: 1, enabled: true }]);
    if (path === "/api/discovery/search") return respond({ items: [{ providerId: "web", resultKind: "web", sourceLevel: "site", title: "Synthetic learning archive", description: "A source for browser verification.", canonicalUrl: "https://archive.example.test/", publisherLabel: null, publishedAt: null, identityEvidence: [{ attribute: "provider-result-page", value: "https://archive.example.test/lessons", provenanceUrl: "https://archive.example.test/lessons" }] }], providerFailures: [], submittedQuery: "patterns", providerQuery: "patterns educational", policyVersion: "educational-v1" });
    // Reminders unavailable is deliberate: appearance controls must still work.
    if (path === "/api/reminders") return route.fulfill({ status: 503, json: { error: "RemindersUnavailable" } });
    throw new Error(`UnexpectedSyntheticRequest:${request.method()}:${path}`);
  });
  const ready = async () => { await page.locator(".learner-feed").waitFor(); await page.evaluate(() => document.fonts.ready); };
  const nav = async view => { await page.locator(`.primary-nav [data-view="${view}"]`).click(); await page.waitForFunction(v => document.querySelector(".primary-nav [aria-current=page]")?.getAttribute("data-view") === v, view); };
  const theme = async mode => { await page.getByRole("button", { name: "Settings", exact: true }).click(); await page.locator(`[data-setting="theme"][value="${mode}"]`).check(); await page.waitForFunction(m => document.documentElement.dataset.theme === m, mode); assert.equal(await page.locator('[data-setting="layout"]').count(), 0); await nav("feed"); await ready(); };
  const noOverflow = async label => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: page overflow`);
  await page.goto(origin); await ready();
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    for (const width of [1440, 1024, 800, 375, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => scrollTo(0, 0));
      await noOverflow(`${mode}/${width}`);
      assert.equal(await page.locator("main h1").count(), 1, "One route heading");
      const geometry = await page.evaluate(() => {
        const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; };
        return { nav: [...document.querySelectorAll(".primary-nav button")].slice(0, 2).map(box), cards: [...document.querySelectorAll(".learning-card")].slice(0, 2).map(box), cardColumns: getComputedStyle(document.querySelector(".learning-card")).gridTemplateColumns };
      });
      if (width > 800 && mode === "dark") { assert.equal(geometry.nav[0].x, geometry.nav[1].x); assert.ok(geometry.nav[1].y > geometry.nav[0].y); }
      else assert.equal(geometry.nav[0].y, geometry.nav[1].y, "Horizontal navigation");
      assert.equal(geometry.cards[0].x, geometry.cards[1].x);
      assert.ok(geometry.cards[1].y > geometry.cards[0].y, "Full-row cards in both modes");
      if ([1440,375].includes(width)) await page.screenshot({ path: `${output}/${mode}-${width}.png` });
    }
    // 200% browser zoom has a 720 CSS-pixel layout viewport on a 1440px screen.
    await page.setViewportSize({ width: 720, height: 500 }); await noOverflow(`${mode}/200%-equivalent reflow`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await nav("library"); await page.locator('[data-library-source="source-a"]').waitFor();
    await page.screenshot({ path: `${output}/${mode}-library.png` });
    await page.locator("#library-search").fill("curious");
    await Promise.all([page.waitForResponse(r => r.url().includes("/api/source-library/search?")), page.locator("[data-library-search] button").click()]);
    await page.waitForFunction(() => document.querySelector("#library-search")?.value === "curious");
    await page.locator('[data-library-source="source-a"]').waitFor(); assert.equal(libraryQuery, "curious");
    await page.locator('.library-upload > summary').first().click();
    await page.locator('[data-library-upload=""] textarea').fill("An unsubmitted private draft");
    assert.equal(await page.locator('[data-library-upload=""] textarea').inputValue(), "An unsubmitted private draft");
    await nav("discover"); await page.locator("#discover-query").fill("patterns"); await page.locator("[data-discovery-search-form] button").click();
    await page.locator("[data-discovery-item-id]").first().click(); await page.locator("[data-selected-item-id]").waitFor();
    await page.screenshot({ path: `${output}/${mode}-discover.png` });
    for (const view of ["library", "discover", "progress", "settings"]) {
      if (view === "settings") await page.getByRole("button", { name: "Settings", exact: true }).click(); else await nav(view);
      await page.locator(view === "settings" ? ".settings-page" : view === "progress" ? ".progress-page" : view === "library" ? "#library-title" : "#discover-title").waitFor();
      await page.setViewportSize({ width: 320, height: 700 }); await noOverflow(`${mode}/${view}/320`);
      await page.screenshot({ path: `${output}/${mode}-${view}-320.png` });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await nav("feed"); await ready();
  }
  const preferenceButton = page.locator('.preference-more').first();
  await Promise.all([page.waitForRequest(r => r.url().endsWith('/knowledge-preference')), preferenceButton.click()]);
  assert.equal(await page.getByText('Preference saved.', { exact: true }).count(), 0, 'No success before persistence');
  releasePreference();
  await page.getByText('Preference saved.', { exact: true }).waitFor();
  assert.equal(await preferenceButton.evaluate(el => el === document.activeElement), true, 'Toast must preserve button focus');
  await page.getByRole('button', { name: 'Close notification' }).click();
  preferenceFails = true;
  await page.locator('.preference-less').first().click();
  await page.locator('.learner-feed [role="alert"]').waitFor();
  assert.equal(await page.getByText('Preference saved.', { exact: true }).count(), 0, 'Failed save must not confirm success');
  await page.getByRole("button", { name: "Mark batch studied", exact: true }).click();
  await page.getByText("Batch studied. Paired questions are unlocked in Review.", { exact: true }).waitFor();
  await page.locator('.hero-actions [data-view="review"]').click(); await page.locator('[name="answerText"]').waitFor();
  assert.equal(await page.locator(".subject-mark, .idea-art").count(), 0, "No pre-answer cues");
  assert.equal(await page.getByText("retrieval", { exact: true }).count(), 0);
  await page.locator('[name="answerText"]').fill("retrieval"); assert.equal(await page.locator('[name="confidence"]').count(), 0);
  await page.getByRole("button", { name: "Check answer", exact: true }).click(); await page.getByText("Correct.", { exact: true }).waitFor();
  await page.screenshot({ path: `${output}/review-feedback.png` });
  for (feedState of ["empty", "error"]) { await nav("feed"); await page.locator(".daily-grid .state-panel").waitFor(); assert.equal(await page.locator("main h1").count(), 1); await nav("review"); }
  await page.keyboard.press("Tab"); assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "BODY");
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  assert.ok(requests.filter(r => r.method !== "GET").every(r => ["/api/source-library/suppressions/check", "/api/discovery/search", "/api/learning-generation/feed-batch/complete", "/api/learning-generation/review-batch/answer", "/api/learning-generation/knowledge-preference"].includes(r.path)));
  console.log("PASS: theme-specific shell/card geometry; 320–1440px and 200%-equivalent reflow; Library search/draft, Discover search/detail, Feed completion → Review attempt/feedback, no pre-answer cues, empty/error hierarchy. All APIs synthetic.");
} finally { await browser.close(); }
