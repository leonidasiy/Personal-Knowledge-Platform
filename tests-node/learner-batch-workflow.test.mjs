import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createLearningBatchService } from '../worker/learning-batches-d1.js';
import { createJevAnswerGrader, JEV_GRADER_CONFIGURATION } from '../worker/jev-answer-grader.js';

function fixture(count = 8) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync('worker/migrations').filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(`worker/migrations/${file}`, 'utf8'));
  let clock = '2026-10-18T00:00:00.000Z', probability = 0.7, unavailable = false;
  const gradingRequests = [];
  let beforeGrade = async () => {}, skipUnavailable = false;
  const grader = createJevAnswerGrader({ apiKey: 'synthetic', configuration: JEV_GRADER_CONFIGURATION, timeoutMs: 1000, logger() {}, fetch: async (_url, options) => {
    const request = JSON.parse(options.body);
    gradingRequests.push(request);
    return unavailable ? new Response('{}', { status: 503 }) : Response.json({ model: 'typesafe/jev-1.13-20260917', answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'noul', noul: probability }])) });
  } });
  const database = { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return { success: true, results: db.prepare(sql).all(...args) }; }, async run() { if (skipUnavailable && sql.startsWith("INSERT INTO learner_batch_commands") && sql.includes("review-skip")) throw new Error("Synthetic skip outage"); return { success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; } }; }, async batch(statements) { db.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
  db.prepare('INSERT INTO library_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('owner', 'source', 'https://example.test', 'https://example.test', 'Synthetic source', '', '{}', '{}', 'active', clock, clock, 1);
  db.prepare('INSERT INTO knowledge_workflow_runs(owner_id,run_id,source_id,source_revision,canonical_source_identity,content_signature,state,revision,idempotency_key,config_digests_json,counts_json,reused,created_at,updated_at,run_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('owner', 'run', 'source', 1, 'https://example.test', 'hash', 'completed', 1, 'run-key', '{}', '{}', 0, clock, clock, '{}');
  for (let index = 0; index < count; index++) {
    const knowledgeId = `knowledge-${index}`, taskId = `task-${index}`, generationId = `generation-${index}`;
    const task = { id: taskId, kind: 'paired', prompt: 'Recall the relationship.', explanation: 'Synthetic explanation.', sourceAnchorIds: ['anchor'], choices: null, correctChoiceIds: null, revision: 1, pairedVariants: [
      { id: 'choice', kind: 'single-choice', prompt: 'Choose the home note.', explanation: 'The tonic is the home note.', choices: [{ id: 'a', label: 'Tonic' }, { id: 'b', label: 'Dominant' }], correctChoiceIds: ['a'] },
      { id: 'fill', kind: 'fill-blank', prompt: 'The home note is the ____.', explanation: 'The tonic is the home note.', blanks: [{ id: 'blank-1', acceptedAnswers: ['tonic'] }] },
    ] };
    const point = { summary: `Synthetic idea ${index}.`, normalizedHash: `hash-${index}`, evidenceAnchors: [{ id: 'anchor' }], attribution: { sourceUrl: 'https://example.test' } };
    db.prepare('INSERT INTO extraction_knowledge_points VALUES(?,?,?,?,?,?,?,?)').run('owner', 'run', knowledgeId, 'source', 1, `hash-${index}`, JSON.stringify(point), clock);
    db.prepare('INSERT INTO learning_generation_jobs(owner_id,generation_id,source_id,source_revision,item_id,item_version_id,content_digest,source_kind,rights_evidence_id,policy_version,status,local_only,idempotency_key,command_fingerprint,record_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('owner', generationId, 'source', 1, knowledgeId, 'v1', 'hash', 'public-text', 'rights', 'v1', 'completed', 0, generationId, 'hash', '{}', clock);
    db.prepare('INSERT INTO learning_generation_tasks VALUES(?,?,?,?,?,?,?,?,?)').run('owner', generationId, taskId, 1, knowledgeId, 'v1', 'published', 1, JSON.stringify(task));
    db.prepare('INSERT INTO knowledge_workflow_quizzes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('owner', `quiz-${index}`, 'run', knowledgeId, 'source', 1, `quiz-hash-${index}`, '{}', 9, 1, 'published', clock);
  }
  const service = createLearningBatchService({ database, now: () => clock, random: () => 0.3, logger() {}, semanticGrader: async command => {
    await beforeGrade();
    const result = await grader.grade(command);
    return result.ok ? { ok: true, value: result.value.probabilities } : result;
  } });
  const value = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
  const complete = async batch => value(await service.completeFeed({ ownerId: 'owner', batchId: batch.batchId, idempotencyKey: `complete:${batch.batchId}` }));
  const answer = (batch, question, overrides = {}) => service.answerReview({ ownerId: 'owner', batchId: batch.batchId, questionId: question.questionId, questionRevision: question.revision, selectedChoiceIds: question.kind === 'fill-blank' ? [] : ['a'], ...(question.kind === 'fill-blank' ? { blankAnswers: [{ id: 'blank-1', text: 'tonic' }] } : {}), idempotencyKey: `answer:${batch.batchId}:${question.questionId}`, ...overrides });
  const skip = (batch, question, overrides = {}) => service.skipReview({ ownerId: "owner", batchId: batch.batchId, questionId: question.questionId, questionRevision: question.revision, idempotencyKey: `skip:${batch.batchId}:${question.questionId}`, ...overrides });
  return { db, service, value, complete, answer, skip, setBeforeGrade: value => { beforeGrade = value; }, setSkipUnavailable: value => { skipUnavailable = value; }, gradingRequests, day: () => clock.slice(0, 10), setClock: value => { clock = value; }, setProbability: value => { probability = value; }, setUnavailable: value => { unavailable = value; } };
}

test('removing one Feed card replaces its slot, preserves four cards and survives reload', async () => {
  const f = fixture();
  try {
    const initial = f.value(await f.service.loadFeed('owner', f.day()));
    const removed = initial.items[2].knowledgeId;
    f.value(await f.service.removeKnowledge({ ownerId: 'owner', knowledgeId: removed, idempotencyKey: 'remove' }));
    const after = f.value(await f.service.loadFeed('owner', f.day()));
    assert.equal(after.batch.batchId, initial.batch.batchId);
    assert.equal(after.items.length, 5);
    for (const index of [0, 1, 3, 4]) assert.deepEqual(after.items[index], initial.items[index]);
    assert.equal(after.items.some(item => item.knowledgeId === removed), false);
    assert.deepEqual(f.value(await f.service.loadFeed('owner', f.day())), after);
    await f.complete(after.batch);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learner_knowledge_state WHERE studied_at IS NOT NULL').get().n, 5);
  } finally { f.db.close(); }
});

test('removing the only spare card still preserves and completes the remaining Feed', async () => {
  const f = fixture(5);
  try {
    const initial = f.value(await f.service.loadFeed('owner', f.day()));
    f.value(await f.service.removeKnowledge({ ownerId: 'owner', knowledgeId: initial.items[2].knowledgeId, idempotencyKey: 'remove' }));
    const after = f.value(await f.service.loadFeed('owner', f.day()));
    assert.deepEqual(after.items, initial.items.filter((_, index) => index !== 2));
    await f.complete(after.batch);
  } finally { f.db.close(); }
});

test('completion refreshes Feed; empty Review unlocks immediately and keeps its batch after later study', async () => {
  const f = fixture();
  try {
    assert.equal(f.value(await f.service.loadReview('owner', f.day())).batch, null);
    const initial = f.value(await f.service.loadFeed('owner', f.day()));
    await f.complete(initial.batch);
    const next = f.value(await f.service.loadFeed('owner', f.day()));
    assert.notEqual(next.batch.batchId, initial.batch.batchId);
    assert.equal(next.batch.status, 'open');
    const review = f.value(await f.service.loadReview('owner', f.day()));
    assert.equal(review.questions.length, 5);
    assert.equal(review.dueCount, 10);
    assert.equal(review.questions.every(question => question.pairedVariants === null), true);
    assert.deepEqual(new Set(review.questions.map(question => question.kind)), new Set(['single-choice', 'fill-blank']));
    assert.equal(JSON.stringify(review).includes('acceptedAnswers'), false);
    await f.complete(next.batch);
    assert.equal(f.value(await f.service.loadReview('owner', f.day())).batch.batchId, review.batch.batchId);
    f.setClock('2026-10-19T00:00:00.000Z');
    assert.notEqual(f.value(await f.service.loadReview('owner', f.day())).batch.batchId, review.batch.batchId);
    assert.notEqual(f.value(await f.service.loadFeed('owner', f.day())).batch.batchId, next.batch.batchId);
  } finally { f.db.close(); }
});

test('Jev accepts 70%, grades exact text too, and records paired variants as separate review attempts', async () => {
  const f = fixture(5);
  try {
    await f.complete(f.value(await f.service.loadFeed('owner', f.day())).batch);
    const review = f.value(await f.service.loadReview('owner', f.day()));
    const fill = review.questions.find(question => question.kind === 'fill-blank');
    const answer = f.value(await f.answer(review.batch, fill));
    assert.equal(answer.correct, true);
    assert.equal(answer.score, 0.7);
    assert.equal(f.gradingRequests.length, 1);
    assert.equal(f.gradingRequests[0].state.answers[0].response, 'tonic');
    assert.deepEqual(f.value(await f.answer(review.batch, fill)), answer);
    assert.equal(f.gradingRequests.length, 1, 'retry does not regrade');
    const states = f.db.prepare('SELECT * FROM learner_question_state WHERE knowledge_id=? ORDER BY question_id').all(fill.knowledgeId);
    assert.equal(states.length, 2);
    assert.equal(states.find(state => state.question_id !== fill.questionId).due_at, '2026-10-18T00:00:00.000Z');
    assert.equal(states.find(state => state.question_id === fill.questionId).due_at, answer.nextDueAt);
    const sibling = f.value(await f.service.loadReview('owner', f.day())).questions.find(question => question.knowledgeId === fill.knowledgeId);
    assert.ok(sibling, "The paired choice remains independently answerable.");
    f.value(await f.answer(review.batch, sibling));
    const progress = f.value(await f.service.loadProgress('owner', 7, null));
    assert.equal(progress.attempts.count, 2);
    assert.equal(progress.activity.find(row => row.date === f.day()).reviewAttempts, 2);
  } finally { f.db.close(); }
});

test('Jev rejection and outage preserve grading boundaries and pending attempts', async () => {
  for (const probability of [0, 0.699999, 0.7, 1]) {
    const f = fixture(5);
    try {
      await f.complete(f.value(await f.service.loadFeed('owner', f.day())).batch);
      const review = f.value(await f.service.loadReview('owner', f.day()));
      const fill = review.questions.find(question => question.kind === 'fill-blank');
      f.setUnavailable(true);
      const unavailable = await f.answer(review.batch, fill);
      assert.equal(unavailable.error.kind, 'ReviewGradingUnavailable');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learner_review_answers').get().n, 0);
      f.setUnavailable(false); f.setProbability(probability);
      const answer = f.value(await f.answer(review.batch, fill));
      assert.equal(answer.correct, probability >= 0.7);
      assert.equal(answer.score, probability);
      assert.equal(f.value(await f.service.loadProgress('owner', 7, null)).attempts.count, 1);
    } finally { f.db.close(); }
  }
});

test('all questions complete independently; unanswered variants remain available for the next batch', async () => {
  const f = fixture(5);
  try {
    await f.complete(f.value(await f.service.loadFeed('owner', f.day())).batch);
    const first = f.value(await f.service.loadReview('owner', f.day()));
    for (const [index, question] of first.questions.entries()) {
      const answer = f.value(await f.answer(first.batch, question));
      assert.equal(answer.completed, index === first.questions.length - 1);
    }
    const second = f.value(await f.service.loadReview('owner', f.day(), true));
    assert.equal(second.questions.length, 5);
    assert.equal(second.dueCount, 5);
    assert.equal(second.questions.some(question => first.batch.itemIds.includes(question.questionId)), false);
    assert.equal(f.value(await f.service.loadProgress('owner', 7, null)).attempts.count, 5);
  } finally { f.db.close(); }
});

test('point removal preserves completed study and answer counts', async () => {
  const f = fixture(5);
  try {
    await f.complete(f.value(await f.service.loadFeed('owner', f.day())).batch);
    const review = f.value(await f.service.loadReview('owner', f.day()));
    f.value(await f.answer(review.batch, review.questions[0]));
    const before = f.value(await f.service.loadProgress('owner', 7, null));
    f.value(await f.service.removeKnowledge({ ownerId: 'owner', knowledgeId: review.questions[0].knowledgeId, idempotencyKey: 'remove-studied' }));
    const after = f.value(await f.service.loadProgress('owner', 7, null));
    assert.deepEqual(after.activity, before.activity);
    assert.equal(after.attempts.count, before.attempts.count);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learner_question_state WHERE knowledge_id=?').get(review.questions[0].knowledgeId).n, 0);
  } finally { f.db.close(); }
});


test('skipping all questions reveals feedback, persists across reloads and preserves all future scheduling', async () => {
  const f = fixture(5);
  try {
    await f.complete(f.value(await f.service.loadFeed('owner', f.day())).batch);
    const review = f.value(await f.service.loadReview('owner', f.day()));
    const before = f.db.prepare('SELECT * FROM learner_knowledge_state ORDER BY knowledge_id').all();
    for (const [index, question] of review.questions.entries()) {
      const skipped = f.value(await f.skip(review.batch, question));
      assert.equal(skipped.completed, index === review.questions.length - 1);
      assert.equal(skipped.feedback.correctAnswer, question.kind === 'fill-blank' ? 'tonic' : 'Tonic');
      assert.equal(typeof skipped.feedback.explanation, 'string');
      assert.equal(f.value(await f.skip(review.batch, question, { idempotencyKey: `duplicate:${index}` })).questionId, question.questionId);
      assert.equal((await f.answer(review.batch, question)).ok, false, 'revealed answers cannot become review evidence');
    }
    assert.deepEqual(f.db.prepare('SELECT * FROM learner_knowledge_state ORDER BY knowledge_id').all(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learner_question_state').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learner_review_answers').get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM learner_batch_commands WHERE command_kind = 'review-skip'").get().n, review.questions.length);
    assert.equal(f.gradingRequests.length, 0);
    const reloaded = f.value(await f.service.loadReview('owner', f.day()));
    assert.equal(reloaded.batch.status, 'completed');
    assert.equal(reloaded.dueCount, review.dueCount);
    assert.equal(reloaded.skipped.length, review.questions.length);
    assert.deepEqual(reloaded.questions, review.questions);
    const progress = f.value(await f.service.loadProgress('owner', 7, null));
    assert.equal(progress.activity.find(row => row.date === f.day()).reviewAttempts, 0);
    const next = f.value(await f.service.loadReview('owner', f.day(), true));
    assert.notEqual(next.batch.batchId, review.batch.batchId);
    assert.deepEqual(next.questions.map(q => q.questionId), review.questions.map(q => q.questionId), 'unchanged random inputs and weights can select skipped questions again immediately');
  } finally { f.db.close(); }
});

test('mixed answers and skips complete a batch with only actual answers counted and scheduled', async () => {
  const f = fixture(5);
  try {
    await f.complete(f.value(await f.service.loadFeed('owner', f.day())).batch);
    const review = f.value(await f.service.loadReview('owner', f.day()));
    for (const question of review.questions.slice(0, -1)) f.value(await f.skip(review.batch, question));
    const last = review.questions.at(-1);
    const answer = f.value(await f.answer(review.batch, last));
    assert.equal(answer.completed, true, 'answering the last outstanding card also closes mixed batches');
    assert.equal((await f.skip(review.batch, last)).ok, false);
    assert.deepEqual(f.db.prepare('SELECT question_id FROM learner_review_answers').all().map(row => row.question_id), [last.questionId]);
    const progress = f.value(await f.service.loadProgress('owner', 7, null));
    assert.equal(progress.activity.find(row => row.date === f.day()).reviewAttempts, 1);
    const reloaded = f.value(await f.service.loadReview('owner', f.day()));
    assert.equal(reloaded.skipped.length, review.questions.length - 1);
    assert.equal(reloaded.dueCount, review.dueCount - 1);
  } finally { f.db.close(); }
});

test('Skip rejects bad, unavailable, stale and foreign questions and recovers after a write outage', async () => {
  const f = fixture(5);
  try {
    await f.complete(f.value(await f.service.loadFeed('owner', f.day())).batch);
    const review = f.value(await f.service.loadReview('owner', f.day())), question = review.questions[0];
    for (const overrides of [{ questionId: '' }, { questionId: 'missing' }, { ownerId: 'other' }, { questionRevision: 99 }, { batchId: 'missing' }, { idempotencyKey: '' }]) assert.equal((await f.skip(review.batch, question, overrides)).ok, false);
    assert.equal((await f.service.skipReview(null)).ok, false);
    f.setSkipUnavailable(true);
    assert.deepEqual(await f.skip(review.batch, question), { ok: false, error: { kind: 'LearningBatchPersistenceFailed' } });
    assert.equal(f.value(await f.service.loadReview('owner', f.day())).skipped.length, 0);
    f.setSkipUnavailable(false);
    f.value(await f.skip(review.batch, question));
    f.value(await f.skip(review.batch, question));
    assert.equal(f.value(await f.service.loadReview('owner', f.day())).skipped.length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learner_review_answers').get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM learner_batch_commands WHERE command_kind = 'review-skip'").get().n, 1);
  } finally { f.db.close(); }
});

test('Skip committed while Jev grades prevents the in-flight answer from changing progress or schedules', async () => {
  const f = fixture(5);
  try {
    await f.complete(f.value(await f.service.loadFeed('owner', f.day())).batch);
    const review = f.value(await f.service.loadReview('owner', f.day())), question = review.questions.find(q => q.kind === 'fill-blank');
    const before = f.db.prepare('SELECT * FROM learner_knowledge_state ORDER BY knowledge_id').all();
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.setBeforeGrade(async () => { entered(); await gate; });
    const pending = f.answer(review.batch, question);
    await started;
    f.value(await f.skip(review.batch, question));
    release();
    assert.deepEqual(await pending, { ok: false, error: { kind: 'ReviewAnswerNotAllowed' } });
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learner_review_answers').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learner_question_state').get().n, 0);
    assert.deepEqual(f.db.prepare('SELECT * FROM learner_knowledge_state ORDER BY knowledge_id').all(), before);
  } finally { f.db.close(); }
});


test('concurrent Skip requests for one card persist only one skip event', async () => {
  const f = fixture(5);
  try {
    await f.complete(f.value(await f.service.loadFeed('owner', f.day())).batch);
    const review = f.value(await f.service.loadReview('owner', f.day()));
    const results = await Promise.all([f.skip(review.batch, review.questions[0]), f.skip(review.batch, review.questions[0], { idempotencyKey: 'parallel-skip' })]);
    for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM learner_batch_commands WHERE command_kind = 'review-skip'").get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learner_review_answers').get().n, 0);
  } finally { f.db.close(); }
});
