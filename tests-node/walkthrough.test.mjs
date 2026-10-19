import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalDatabase } from '../local/storage.mjs';
import { createLocalApplication } from '../local/application.mjs';
import { seedWalkthrough, WALKTHROUGH_OWNER } from '../local/walkthrough-seed.mjs';
import { SourceLibraryGatewayClient } from '../src/features/source-library/gateway.js';
import { LearningBatchGatewayClient } from '../src/features/learning-generation/batches-gateway.js';

const root = fileURLToPath(new URL('../', import.meta.url));
function value(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }

test('walkthrough seed refuses a nonempty library without changing its records', async () => {
  const database = await openLocalDatabase(':memory:', root);
  try {
    database.sqlite.prepare('INSERT INTO library_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('personal', 'keep', 'https://example.test', 'https://example.test', 'Keep this source', '', '{}', '[]', 'active', '2026-10-01', '2026-10-01', 1);
    const before = database.sqlite.prepare('SELECT * FROM library_sources').all();
    await assert.rejects(seedWalkthrough(database), /empty database/);
    assert.deepEqual(database.sqlite.prepare('SELECT * FROM library_sources').all(), before);
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_workflow_runs').get().n, 0);
  } finally { database.close(); }
});

test('isolated full backend serves sources, search, 30-day history, study and graded review without external calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resonance-walkthrough-test-'));
  const origin = 'http://localhost:4180', password = 'synthetic-walkthrough-test-password';
  let application, externalCalls = 0;
  try {
    application = await createLocalApplication({ root, dataDirectory: directory, password, port: 4180, origin, environment: {}, logger() {}, fetch: async () => { externalCalls++; throw new Error('External network must not be used.'); } });
    const now = new Date().toISOString();
    const summary = await seedWalkthrough(application.database, now);
    assert.equal(summary.sources, 4); assert.equal(summary.knowledgePoints, 12); assert.equal(summary.quizzes, 12); assert(summary.attempts > 40);
    const login = await application.fetch(new Request(`${origin}/local/login`, { method: 'POST', headers: { host: 'localhost:4180', origin }, body: new URLSearchParams({ password }) }));
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const fetch = (input, init = {}) => application.fetch(new Request(input, { ...init, headers: { ...init.headers, host: 'localhost:4180', cookie, origin } }));
    const library = new SourceLibraryGatewayClient({ fetch, baseUrl: origin, timeoutMs: 1000 });
    const learning = new LearningBatchGatewayClient({ fetch, baseUrl: origin, timeoutMs: 1000 });
    const sources = value(await library.browse({ limit: 20, cursor: null }));
    assert.equal(sources.items.length, 4);
    for (const source of sources.items) {
      assert.equal(source.ownerId, WALKTHROUGH_OWNER);
      assert.match(source.canonicalUrl, /^https:\/\/openmusictheory.github.io\//);
      assert.match(source.description, /CC BY-SA 4.0/);
      const status = value(await library.workflowStatus(source.id));
      assert.equal(status.run.state, 'completed');
      assert.equal(status.run.counts.knowledgePoints, 3);
    }
    const points = value(await learning.listKnowledge());
    assert.equal(points.items.length, 12);
    const search = value(await library.search({ query: 'triad', scope: 'knowledge', limit: 50, mode: 'keyword', externalProcessingAllowed: false }));
    assert(search.length > 0);
    const response = await fetch(new URL('/api/learning-generation/progress?days=30', origin));
    assert.equal(response.status, 200);
    const progress = (await response.json()).result;
    assert.equal(progress.attempts.count, summary.attempts);
    assert(progress.attempts.correct > 0 && progress.attempts.correct < progress.attempts.count);
    assert.equal(progress.daily.length, 30);
    assert(progress.activity.filter(day => day.reviewAttempts > 0).length > 10);
    assert(progress.subjects.some(subject => subject.id === 'music'));
    const rows = application.database.sqlite.prepare('SELECT answered_at FROM learner_review_answers').all();
    assert(rows.every(row => Date.parse(row.answered_at) <= Date.parse(now) && Date.parse(row.answered_at) > Date.parse(now) - 30 * 86_400_000));
    const day = now.slice(0, 10), feed = value(await learning.loadFeed(day));
    assert.equal(feed.items.length, 5);
    value(await learning.completeFeed(feed.batch.batchId, 'walkthrough-test:study'));
    const review = value(await learning.loadReview(day));
    assert.equal(review.questions.length, 5, 'Recording starts with a full due batch');
    const question = review.questions[0];
    assert(!JSON.stringify(review).includes('correctChoiceIds'));
    const stored = JSON.parse(application.database.sqlite.prepare('SELECT task_json FROM learning_generation_tasks WHERE task_id=?').get(question.questionId).task_json);
    const answer = value(await learning.answerReview(review.batch.batchId, question.questionId, stored.correctChoiceIds, 'walkthrough-test:answer', null, null, question.revision));
    assert.equal(answer.correct, true);
    assert(answer.feedback.explanation.length > 0);
    assert.equal(externalCalls, 0);
    await assert.rejects(seedWalkthrough(application.database), /empty database/);
  } finally { await application?.close(); await rm(directory, { recursive: true, force: true }); }
});
