// Synthetic countdown journeys against the production bundle; no hosted writes or paid models.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { buildProgress } from '../src/features/progress/public.js';

const root = resolve('dist');
const output = resolve('test-results/browser-review-countdown-local');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer((req, res) => {
  const path = resolve(root, `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`);
  if (path !== root && !path.startsWith(root + sep)) return res.writeHead(403).end();
  const file = path === root ? resolve(root, 'index.html') : path;
  res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
  const stream = createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
  stream.pipe(res);
});
let browser;
const report = { fixture: 'Synthetic quizzes and HTTP responses; no real model evaluation.', checks: [], errors: [] };
const question = id => ({ questionId: id, knowledgeId: `knowledge:${id}`, title: 'Synthetic music source', prompt: `Question ${id}: name the home note: ____.`, kind: 'fill-blank', choices: null, blanks: [{ id: 'blank-1' }], sourceAnchorIds: ['synthetic'], revision: 1 });
const batch = { batchId: 'fixture-review', learningDay: '2026-10-23', status: 'open', itemIds: ['q1','q2','q3','q4','q5'], revision: 1, createdAt: '2026-10-23T00:00:00Z', completedAt: null };
try {
  await mkdir(output, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  for (const [theme, width, motion] of [['light',1440,'no-preference'], ['dark',390,'reduce']]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, colorScheme: theme, reducedMotion: motion, serviceWorkers: 'allow' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => report.errors.push(error.message));
      let state = { batch: structuredClone(batch), questions: batch.itemIds.map(question), dueCount: 10, skipped: [] };
      let replacements = 0, refreshes = 0, failReplacement = false, failRefresh = false;
      const answered = new Set();
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { report.errors.push(`Unexpected outside request: ${url.origin}`); return route.abort(); }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const body = request.postDataJSON();
        const respond = result => route.fulfill({ json: { result } });
        if (url.pathname.endsWith('/review-batch/skip')) {
          const skip = { questionId: body.questionId, completed: false, feedback: { correctAnswer: 'tonic', explanation: 'The tonic is the home note.' } };
          state.skipped.push(skip);
          return respond(skip);
        }
        if (url.pathname.endsWith('/review-batch/replace')) {
          replacements++;
          if (failReplacement) { failReplacement = false; return route.fulfill({ status: 503, json: { error: 'LearningBatchPersistenceFailed' } }); }
          const replacement = question(`replacement-${replacements}`);
          state.questions = state.questions.map(q => q.questionId === body.questionId ? replacement : q);
          state.batch.itemIds = state.batch.itemIds.map(id => id === body.questionId ? replacement.questionId : id);
          state.skipped = state.skipped.filter(q => q.questionId !== body.questionId);
          return respond({ questionId: body.questionId, ...state, questions: [replacement], skipped: [] });
        }
        if (url.pathname.endsWith('/review-batch/answer')) {
          answered.add(body.questionId);
          return respond({ correct: true, score: 1, completed: answered.size === 5, nextDueAt: '2026-10-24T00:00:00Z', feedback: { correctAnswer: 'tonic', explanation: 'The tonic is the home note.', components: [{ id: 'blank-1', correct: true, correctAnswer: 'tonic' }] } });
        }
        if (url.pathname.endsWith('/review-batch/refresh')) {
          refreshes++;
          await new Promise(resolve => setTimeout(resolve, 200));
          if (failRefresh) { failRefresh = false; return route.fulfill({ status: 503, json: { error: 'LearningBatchPersistenceFailed' } }); }
          state = { ...state, batch: { ...batch, batchId: `fixture-next-${refreshes}`, itemIds: ['next'] }, questions: [question('next')], skipped: [] };
          return respond(state);
        }
        if (url.pathname.endsWith('/review-batch')) return respond(state);
        if (url.pathname.endsWith('/feed-batch')) return respond({ batch: null, items: [] });
        if (url.pathname.endsWith('/library-knowledge')) return respond({ items: [] });
        if (url.pathname.endsWith('/progress')) return respond(buildProgress({ from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z', subject: null, batches: [], attempts: [], questions: [] }));
        if (url.pathname.endsWith('/capabilities')) return respond([]);
        if (url.pathname === '/api/source-library') return respond({ items: [], interestAreas: [], nextCursor: null });
        if (url.pathname.endsWith('/preferences') || url.pathname.endsWith('/reminders')) return respond({});
        throw new Error(`Unconfigured fixture endpoint: ${url.pathname}`);
      });
      await page.goto(`${origin}/#review`);
      await page.locator('[data-review-question="q5"]').waitFor();
      const card = id => page.locator(`[data-review-question="${id}"]`);
      await card('q2').locator('input').fill('unsent draft');
      await card('q3').getByRole('button', { name: 'Skip', exact: true }).click();
      await card('q3').getByText('Correct answer: tonic', { exact: true }).waitFor();
      assert.equal(await card('q3').locator('[data-countdown-seconds]').textContent(), '10');
      await card('q3').locator('summary').click();
      await page.screenshot({ path: resolve(output, `${theme}-skip.png`), fullPage: true });
      const before = await page.evaluate(() => scrollY);
      await page.waitForFunction(() => !document.querySelector('[data-review-question="q3"]'), null, { timeout: 14000 });
      assert.equal(replacements, 1, 'timer sends one replacement');
      assert.equal(await page.evaluate(() => scrollY), before, 'automatic replacement preserves exact scroll');
      assert.equal(await card('q2').locator('input').inputValue(), 'unsent draft');
      assert.equal(await page.locator('[data-review-question]').count(), 5);
      report.checks.push(`${theme}/${width}: automatic 10s replacement, correct feedback, exact scroll, five cards, other draft retained`);

      await card('q4').getByRole('button', { name: 'Skip', exact: true }).click();
      await card('q4').getByRole('button', { name: /Replace quiz/ }).waitFor();
      failReplacement = true;
      await card('q4').getByRole('button', { name: /Replace quiz/ }).focus();
      await page.keyboard.press('Enter');
      await card('q4').getByRole('alert').waitFor();
      assert(await card('q4').textContent().then(text => text.includes('Correct answer: tonic')));
      const retryY = await page.evaluate(() => scrollY);
      await card('q4').getByRole('button', { name: 'Replace quiz', exact: true }).press('Enter');
      await card('replacement-3').waitFor();
      assert.equal(await page.evaluate(() => scrollY), retryY, 'manual replacement also preserves exact scroll');
      report.checks.push(`${theme}/${width}: keyboard early replacement, failure preserves feedback, retry succeeds`);

      for (const node of await page.locator('[data-review-question]').all()) {
        await node.locator('input').fill('tonic');
        await node.getByRole('button', { name: 'Check answer', exact: true }).click();
        await node.getByText('Correct (100%).', { exact: true }).waitFor();
      }
      await page.locator('.review-next-batch').waitFor();
      assert.equal(refreshes, 0);
      await page.locator('.review-next-batch').scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(output, `${theme}-batch.png`), fullPage: true });
      const duration = await page.locator('.spark-ring').evaluate(node => Number.parseFloat(getComputedStyle(node).transitionDuration));
      assert(motion === 'reduce' ? duration < 0.02 : duration === 1, 'Existing motion settings control ring interpolation.');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (theme === 'dark') {
        failRefresh = true;
        await page.locator('[data-action="next-review-batch"]').press('Enter');
        await page.getByRole('alert').waitFor();
        assert.equal(await page.locator('[data-review-question]').count(), 5, 'failed batch refresh retains answered cards');
        await page.locator('[data-action="refresh-learner-review"]').press('Enter');
      }
      await card('next').waitFor({ timeout: 14000 });
      assert.equal(await page.evaluate(() => scrollY), 0, 'new batch starts at page top');
      assert.equal(refreshes, theme === 'dark' ? 2 : 1);
      report.checks.push(`${theme}/${width}: ${theme === 'dark' ? 'manual early next-batch, retry' : 'automatic 10s next-batch'}, returns to top, no overflow, motion preference respected`);
    } finally { await context.close(); }
  }
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failure = error.stack;
  throw error;
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
