// Local synthetic lifecycle regression; no learner requests or records.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const origin = "http://localhost:4320";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.route("**/reveal-under-test.js", route => route.fulfill({ contentType: "text/javascript", body: moduleSource }));
  const moduleSource = await readFile(new URL("../src/features/experience/reveal.js", import.meta.url), "utf8");
  await page.goto(origin);
  await page.setContent('<main id="fixture"></main>');
  await page.addStyleTag({ path: "dist/src/styles.css" });
  await page.evaluate(async url => {
    const { revealCards } = await import(url);
    window.seen = new Set();
    window.mount = (observe = true) => {
      window.observer?.disconnect();
      document.querySelector('#fixture').innerHTML = Array.from({ length: 4 }, (_, i) => `<article data-reveal="test:${i}" style="height:420px;margin:20px;padding:32px"><h2>Knowledge card ${i + 1}</h2><button>Open source ${i + 1}</button></article>`).join('');
      window.observer = revealCards(document.querySelector('#fixture'), window.seen, observe ? IntersectionObserver : null);
    };
    window.mount();
  }, origin + '/reveal-under-test.js');
  const first = page.locator('[data-reveal="test:0"]'), last = page.locator('[data-reveal="test:3"]');
  await page.waitForFunction(() => document.querySelector('[data-reveal="test:0"]').classList.contains('reveal-enter'));
  assert.equal(await last.evaluate(el => getComputedStyle(el).opacity), '0', 'Below-fold content waits for entry');
  await page.evaluate(() => window.mount());
  await page.waitForFunction(() => document.querySelector('[data-reveal="test:0"]').classList.contains('reveal-enter'));
  await page.waitForFunction(() => window.seen.has('test:0'));
  await page.evaluate(() => window.mount());
  assert.equal(await first.getAttribute('class'), null, 'Completed entrance does not replay after render');
  await last.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-reveal="test:3"]').classList.contains('reveal-enter'));
  assert.ok(await last.evaluate(el => el.getAnimations().some(a => a.playState === 'running')), 'Scroll starts real animation');
  await page.waitForFunction(() => window.seen.has('test:3'));
  for (const mode of ['off', 'reduce', 'no-observer']) {
    await page.emulateMedia({ reducedMotion: mode === 'reduce' ? 'reduce' : 'no-preference' });
    await page.evaluate(mode => { window.scrollTo(0, 0); window.seen.clear(); document.documentElement.dataset.motion = mode === 'off' ? 'off' : 'on'; window.mount(mode !== 'no-observer'); }, mode);
    assert.equal(await last.evaluate(el => getComputedStyle(el).opacity), '1', mode + ' keeps content visible');
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { window.seen.clear(); window.mount(); document.querySelector('[data-reveal="test:3"] button').focus({ preventScroll: true }); });
  assert.equal(await last.evaluate(el => getComputedStyle(el).opacity), '1', 'Keyboard focus never hidden');
  console.log('Scroll reveal: pending, interrupted/completed render, scroll animation, reduced motion, toggle, no observer and keyboard focus passed.');
} finally { await browser.close(); }
