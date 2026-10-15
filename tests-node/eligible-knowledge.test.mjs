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
  const database = { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return { success: true, results: db.prepare(sql).all(...args) }; }, async run() { const result = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; } }; }, async batch() { throw new Error('Read-only fixture'); } };
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


test('multiple supporting images retain one Library card and five distinct Feed and Review items', async () => {
  const { db, seed, learning } = fixture();
  try {
    for (let index=1;index<=5;index++) seed(`point-${index}`);
    db.exec(`CREATE TABLE learner_feed_batches (owner_id TEXT, batch_id TEXT, learning_day TEXT, status TEXT, item_ids_json TEXT, revision INTEGER, idempotency_key TEXT, created_at TEXT, completed_at TEXT);
      CREATE TABLE learner_review_batches (owner_id TEXT, batch_id TEXT, learning_day TEXT, status TEXT, question_ids_json TEXT, revision INTEGER, idempotency_key TEXT, created_at TEXT, completed_at TEXT);`);
    const point=JSON.parse(db.prepare('SELECT point_json FROM extraction_knowledge_points WHERE knowledge_id=?').get('point-1').point_json);
    const factHash='sha256:'+createHash('sha256').update(JSON.stringify({summary:point.summary,normalizedHash:point.normalizedHash,evidenceAnchors:point.evidenceAnchors})).digest('hex');
    const binding={kind:'webpage-support',purpose:'illustration',ownerId:'owner',runId:'point-1',sourceRevision:1,factHash,originalDigest:'sha256:original',imageId:'synthetic-image',evidence:'Synthetic supporting image.'};
    const insert=(id,changes={})=>{
      const {owner='owner',run='point-1',revision=1,revoked=null,digest=binding.originalDigest,bound=binding,attribution='Synthetic attribution'}=changes;
      db.prepare('INSERT INTO knowledge_workflow_media_assets VALUES(?,?,?,?,?,?,?,?,?,?)').run(owner,'point-1',revoked,id,'image',attribution,run,revision,typeof bound==='string'||bound===null?bound:JSON.stringify(bound),digest);
    };
    insert('00-foreign-owner',{owner:'foreign'});
    insert('01-revoked',{revoked:'2026-10-02T00:00:00Z'});
    insert('02-wrong-run',{run:'foreign'});
    insert('03-wrong-revision',{revision:2});
    insert('04-invalid-purpose',{bound:{...binding,purpose:'unknown'}});
    insert('05-invalid-fact',{bound:{...binding,factHash:'changed'}});
    insert('06-invalid-owner',{bound:{...binding,ownerId:'foreign'}});
    insert('07-invalid-run',{bound:{...binding,runId:'foreign'}});
    insert('08-invalid-revision',{bound:{...binding,sourceRevision:2}});
    insert('09-invalid-digest',{digest:'changed'});
    insert('10-malformed',{bound:'{'});
    insert('11-invalid-uploaded-purpose',{bound:{...binding,kind:'uploaded-source',locator:'page:1',sourceDigest:'sha256:source'}});
    insert('12-missing-uploaded-locator',{bound:{...binding,kind:'uploaded-source',purpose:'evidence'}});
    insert('13-unverified',{bound:null});
    insert('14-missing-attribution',{attribution:''});
    insert('21-valid',{bound:{...binding,kind:'uploaded-source',purpose:'evidence',locator:'page:1',sourceDigest:'sha256:source'}});
    insert('20-valid');
    const mediaBefore=db.prepare('SELECT * FROM knowledge_workflow_media_assets ORDER BY asset_id').all();
    const library=await learning.listKnowledge('owner');
    assert.equal(library.ok,true,JSON.stringify(library));
    assert.equal(library.value.items.length,5);
    assert.equal(new Set(library.value.items.map(item=>item.knowledgeId)).size,5);
    assert.equal(new Set(library.value.items.map(item=>item.questionId)).size,5);
    assert.deepEqual(library.value.items[0].media,{assetId:'20-valid',kind:'image',url:'/api/learning-media?assetId=20-valid&variant=feed',attribution:'Synthetic attribution',purpose:'illustration'});
    assert(library.value.items.slice(1).every(item=>item.media===null));
    const feed=await learning.loadFeed('owner','2026-10-03');
    assert.equal(feed.ok,true,JSON.stringify(feed));
    assert.equal(feed.value.items.length,5);
    assert.equal(new Set(feed.value.items.map(item=>item.knowledgeId)).size,5);
    assert.equal(new Set(feed.value.batch.itemIds).size,5);
    for(let index=1;index<=5;index++)db.prepare('INSERT INTO learner_knowledge_state VALUES(?,?,?,?,?,?,?,?)').run('owner',`point-${index}`,'2026-10-01T00:00:00Z',1,null,0,'2026-10-02T00:00:00Z',0);
    const review=await learning.loadReview('owner','2026-10-03');
    assert.equal(review.ok,true,JSON.stringify(review));
    assert.equal(review.value.questions.length,5);
    assert.equal(new Set(review.value.questions.map(question=>question.knowledgeId)).size,5);
    assert.deepEqual(db.prepare('SELECT * FROM knowledge_workflow_media_assets ORDER BY asset_id').all(),mediaBefore);
    db.prepare('UPDATE knowledge_workflow_media_assets SET revoked_at=? WHERE asset_id=?').run('2026-10-03T00:00:00Z','20-valid');
    const next=await learning.listKnowledge('owner');
    assert.equal(next.ok,true);
    assert.equal(next.value.items.find(item=>item.knowledgeId==='point-1').media.assetId,'21-valid');
    assert.equal(next.value.items.find(item=>item.knowledgeId==='point-1').media.purpose,'evidence');
    db.prepare('UPDATE knowledge_workflow_media_assets SET revoked_at=? WHERE asset_id=?').run('2026-10-03T00:00:00Z','21-valid');
    const noMedia=await learning.listKnowledge('owner');
    assert.equal(noMedia.ok,true);
    assert.equal(noMedia.value.items.length,5);
    assert.equal(noMedia.value.items.find(item=>item.knowledgeId==='point-1').media,null);
  } finally { db.close(); }
});

test('media multiplicity cannot consume the 1000 distinct knowledge candidate limit', async () => {
  const { db, seed, learning } = fixture();
  try {
    for(let index=1;index<=1001;index++)seed(`point-${String(index).padStart(4,'0')}`);
    const point=JSON.parse(db.prepare('SELECT point_json FROM extraction_knowledge_points WHERE knowledge_id=?').get('point-0001').point_json);
    const factHash='sha256:'+createHash('sha256').update(JSON.stringify({summary:point.summary,normalizedHash:point.normalizedHash,evidenceAnchors:point.evidenceAnchors})).digest('hex');
    const binding=JSON.stringify({kind:'webpage-support',ownerId:'owner',runId:'point-0001',sourceRevision:1,factHash,originalDigest:'sha256:original',imageId:'synthetic-image',evidence:'Synthetic supporting image.'});
    for(let index=0;index<=1000;index++)db.prepare('INSERT INTO knowledge_workflow_media_assets VALUES(?,?,?,?,?,?,?,?,?,?)').run('owner','point-0001',null,`asset-${String(index).padStart(4,'0')}`,'image','Synthetic attribution','point-0001',1,binding,'sha256:original');
    const result=await learning.listKnowledge('owner');
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.value.items.length,1000);
    assert.equal(new Set(result.value.items.map(item=>item.knowledgeId)).size,1000);
    assert.equal(result.value.items[0].media.assetId,'asset-0000');
    assert.equal(result.value.items.at(-1).knowledgeId,'point-1000');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM knowledge_workflow_media_assets').get().n,1001);
  } finally { db.close(); }
});
