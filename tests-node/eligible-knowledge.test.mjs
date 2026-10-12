import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { D1SourceLibraryRepository } from '../worker/source-library-d1.js';
import { createLearningBatchService } from '../worker/learning-batches-d1.js';
import { createHash } from 'node:crypto';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE library_sources (owner_id TEXT, source_id TEXT, state TEXT, title TEXT, canonical_url TEXT, revision INTEGER);
    CREATE TABLE extraction_knowledge_points (owner_id TEXT, run_id TEXT, source_id TEXT, source_revision INTEGER, knowledge_id TEXT, point_json TEXT, created_at TEXT);
    CREATE TABLE knowledge_workflow_runs (owner_id TEXT, run_id TEXT, source_id TEXT, source_revision INTEGER, state TEXT);
    CREATE TABLE knowledge_workflow_quizzes (owner_id TEXT, run_id TEXT, source_id TEXT, source_revision INTEGER, knowledge_id TEXT, status TEXT);
    CREATE TABLE learning_generation_tasks (owner_id TEXT, item_id TEXT, status TEXT, task_json TEXT);
    CREATE TABLE knowledge_workflow_materials (owner_id TEXT, run_id TEXT, material_json TEXT);
    CREATE TABLE learner_knowledge_state (owner_id TEXT, knowledge_id TEXT, studied_at TEXT, view_count INTEGER, last_answer_correct INTEGER, scheduled_days INTEGER, due_at TEXT, preference REAL);
    CREATE TABLE knowledge_classifications (owner_id TEXT, knowledge_id TEXT, classification_json TEXT, revision INTEGER);
    CREATE TABLE source_classifications (owner_id TEXT, source_id TEXT, topic TEXT, main_subject TEXT, classification_revision INTEGER);
    CREATE TABLE learner_preference_feedback (owner_id TEXT, knowledge_id TEXT, preference REAL);
    CREATE TABLE knowledge_workflow_media_assets (owner_id TEXT, knowledge_id TEXT, revoked_at TEXT, asset_id TEXT, kind TEXT, attribution TEXT, run_id TEXT, source_revision INTEGER, binding_json TEXT, digest TEXT);
    CREATE VIRTUAL TABLE knowledge_points_search_fts USING fts5(owner_id UNINDEXED, knowledge_id UNINDEXED, source_id UNINDEXED, summary, source_title, source_topic);
  `);
  function seed(id, options = {}) {
    const { owner = 'owner', revision = 1, state = 'completed', summary = 'cadence summary', quiz = 'published', task = 'published', runRevision = 1, quizRun = id, quizRevision = 1 } = options;
    db.prepare('INSERT INTO library_sources VALUES (?, ?, ?, ?, ?, ?)').run(owner, id, 'active', id, 'https://example.test/', revision);
    db.prepare('INSERT INTO knowledge_workflow_runs VALUES (?, ?, ?, ?, ?)').run(owner, id, id, runRevision, state);
    db.prepare('INSERT INTO extraction_knowledge_points VALUES (?, ?, ?, ?, ?, ?, ?)').run(owner, id, id, 1, id, JSON.stringify({ summary, attribution: { sourceUrl: 'https://example.test/' }, evidenceAnchors: [{ id: 'anchor' }] }), id);
    db.prepare('INSERT INTO knowledge_points_search_fts VALUES (?, ?, ?, ?, ?, ?)').run(owner, id, id, typeof summary === 'string' ? summary : 'cadence', id, '');
    if (quiz !== null) db.prepare('INSERT INTO knowledge_workflow_quizzes VALUES (?, ?, ?, ?, ?, ?)').run(owner, quizRun, id, quizRevision, id, quiz);
    if (task !== null) db.prepare('INSERT INTO learning_generation_tasks VALUES (?, ?, ?, ?)').run(owner, id, task, JSON.stringify({ id: `question-${id}`, kind: 'single-choice', prompt: 'Which cadence?', explanation: 'Cadence explanation', sourceAnchorIds: ['anchor'], choices: [{ id: 'a', label: 'A' }], correctChoiceIds: ['a'], revision: 1 }));
  }
  const database = { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return { success: true, results: db.prepare(sql).all(...args) }; } }; }, async batch() { throw new Error('Read-only fixture'); } };
  return { db, seed, repository: new D1SourceLibraryRepository(database), learning: createLearningBatchService({ database, now: () => '2026-10-03T00:00:00Z', logger() {} }) };
}

function seedEligibilityCases(seed) {
  seed('01-stale', { revision: 2 });
  seed('02-running', { state: 'extracting' });
  seed('03-blank', { summary: ' \n\t' });
  seed('04-no-quiz', { quiz: null });
  seed('05-unpublished', { quiz: 'pending-review' });
  seed('06-no-task', { task: null });
  seed('07-unpublished-task', { task: 'pending-review' });
  seed('08-foreign', { owner: 'someone-else' });
  seed('09-wrong-run-revision', { runRevision: 2 });
  seed('10-wrong-quiz-run', { quizRun: 'another-run' });
  seed('11-wrong-quiz-revision', { quizRevision: 2 });
  seed('12-nontext', { summary: 42 });
  seed('99-eligible');
}

test('keyword knowledge search filters incomplete and stale pairs before its result limit', async () => {
  const { db, seed, repository } = fixture();
  try {
    seedEligibilityCases(seed);
    const result = await repository.knowledgeKeywordSearch({ ownerId: 'owner', query: 'cadence', limit: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.map(hit => hit.knowledge.knowledgeId), ['99-eligible']);
  } finally { db.close(); }
});

test('semantic knowledge candidates and private counts exclude incomplete pairs before the limit', async () => {
  const { db, seed, repository } = fixture();
  try {
    seedEligibilityCases(seed);
    db.prepare('INSERT INTO knowledge_workflow_materials VALUES (?, ?, ?)').run('owner', '01-stale', JSON.stringify({ provenance: { processingAllowed: false } }));
    const result = await repository.knowledgeSemanticCandidates({ ownerId: 'owner', limit: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.candidates.map(hit => hit.knowledge.knowledgeId), ['99-eligible']);
    assert.equal(result.value.privateDerivedCount, 0);
  } finally { db.close(); }
});

test('Library collection and source cards return only completed current published knowledge pairs', async () => {
  const { db, seed, learning } = fixture();
  try {
    seedEligibilityCases(seed);
    const result = await learning.listKnowledge('owner');
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.items.map(item => item.knowledgeId), ['99-eligible']);
    const staleCard = await learning.listKnowledge('owner', '01-stale');
    assert.deepEqual(staleCard, { ok: true, value: { items: [] } });
  } finally { db.close(); }
});

test('all knowledge read paths exclude Unicode whitespace summaries', async () => {
  const { db, seed, repository, learning } = fixture();
  try {
    seed('01-whitespace', { summary: '\u00a0\u2003\u202f\ufeff' });
    seed('99-eligible');
    const semantic = await repository.knowledgeSemanticCandidates({ ownerId: 'owner', limit: 20 });
    assert.equal(semantic.ok, true);
    assert.deepEqual(semantic.value.candidates.map(hit => hit.knowledge.knowledgeId), ['99-eligible']);
    const collection = await learning.listKnowledge('owner');
    assert.equal(collection.ok, true);
    assert.deepEqual(collection.value.items.map(item => item.knowledgeId), ['99-eligible']);
  } finally { db.close(); }
});

test('knowledge cards retain frozen text and publish only exact owner/run/fact-bound supporting media', async () => {
  const { db, seed, learning } = fixture();
  try {
    seed('supported');
    seed('no-image');
    const point = JSON.parse(db.prepare('SELECT point_json FROM extraction_knowledge_points WHERE knowledge_id=?').get('supported').point_json);
    const hash = 'sha256:' + createHash('sha256').update(JSON.stringify({ summary: point.summary, normalizedHash: point.normalizedHash, evidenceAnchors: point.evidenceAnchors })).digest('hex');
    const binding = { kind: 'webpage-support', ownerId: 'owner', runId: 'supported', sourceRevision: 1, factHash: hash, originalDigest: 'sha256:original', imageId: 'fixture-image', evidence: 'Visible quantities support the comparison.' };
    db.prepare('INSERT INTO knowledge_workflow_media_assets VALUES(?,?,?,?,?,?,?,?,?,?)').run('owner', 'supported', null, 'supporting-asset', 'image', 'Fixture attribution', 'supported', 1, JSON.stringify(binding), binding.originalDigest);
    for (const defect of ['none', 'owner', 'run', 'revision', 'fact', 'original', 'unverified']) {
      const current = { ...binding, ...(defect === 'owner' ? { ownerId: 'foreign' } : defect === 'run' ? { runId: 'foreign' } : defect === 'revision' ? { sourceRevision: 2 } : defect === 'fact' ? { factHash: 'sha256:changed' } : defect === 'original' ? { originalDigest: 'sha256:changed' } : {}) };
      db.prepare('UPDATE knowledge_workflow_media_assets SET binding_json=?').run(defect === 'unverified' ? null : JSON.stringify(current));
      const result = await learning.listKnowledge('owner');
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.value.items.length, 2);
      const supported = result.value.items.find(item => item.knowledgeId === 'supported');
      assert.equal(supported.summary, point.summary);
      assert.equal(supported.media?.assetId ?? null, defect === 'none' ? 'supporting-asset' : null, defect);
      assert.equal(result.value.items.find(item => item.knowledgeId === 'no-image').media, null);
    }
    assert.equal(db.prepare('SELECT point_json FROM extraction_knowledge_points WHERE knowledge_id=?').get('supported').point_json, JSON.stringify(point));
  } finally { db.close(); }
});
