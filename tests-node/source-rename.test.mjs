import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../worker/migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter(n => n.endsWith('.sql') && n < '0018').sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'));
  db.exec(`INSERT INTO library_sources VALUES ('owner','source','https://example.test','https://example.test','Old title','Synthetic','{}','[]','active','2026-01-01','2026-01-01',1);
    INSERT INTO library_source_events VALUES ('owner','approval','source','approved',1,'approval-key','approval-fingerprint','2026-01-01');
    INSERT INTO knowledge_workflow_runs VALUES ('owner','run','source',1,'https://example.test','signature','awaiting-upload',2,'run-key','{}',NULL,NULL,NULL,'{}',NULL,0,'2026-01-01','2026-01-01','{}');`);
  return db;
}

test('rename migration preserves audit history, indexes, foreign keys and existing event constraints', () => {
  const db = fixture();
  try {
    db.exec(readFileSync(new URL('../worker/migrations/0018_source_rename.sql', import.meta.url), 'utf8'));
    assert.equal(db.prepare('SELECT event_kind FROM library_source_events').get().event_kind, 'approved');
    assert(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='library_source_events_owner_source_order'").get());
    assert.equal(db.prepare('PRAGMA foreign_key_list(library_source_events)').all().length, 2);
    assert.throws(() => db.exec("INSERT INTO library_source_events VALUES ('owner','bad','source','invented',1,'bad','x','today',NULL,NULL,NULL)"), /CHECK/);
    assert.throws(() => db.exec("INSERT INTO library_source_events VALUES ('owner','bad','missing','approved',1,'bad','x','today',NULL,NULL,NULL)"), /FOREIGN KEY/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

function migrated() {
  const db = fixture();
  db.exec(readFileSync(new URL('../worker/migrations/0018_source_rename.sql', import.meta.url), 'utf8'));
  const database = {
    prepare(query) {
      let values = [];
      return { bind(...args) { values = args; return this; }, async first() { return db.prepare(query).get(...values) ?? null; }, async all() { return { success: true, results: db.prepare(query).all(...values) }; }, async run() { return this.execute(); }, execute() { return { success: true, meta: { changes: Number(db.prepare(query).run(...values).changes) } }; } };
    },
    async batch(statements) { db.exec('BEGIN IMMEDIATE'); try { const result = statements.map(s => s.execute()); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  };
  return { db, database };
}
const rename = { ownerId: 'owner', sourceId: 'source', runId: 'run', expectedRevision: 1, expectedTitle: 'Old title', title: 'New title', idempotencyKey: 'rename-key' };
async function service(database) {
  const { D1SourceRenameRepository } = await import('../worker/source-rename-d1.js');
  const { createSourceRenameService } = await import('../src/features/source-library/rename.js');
  const { D1SourceLibraryRepository } = await import('../worker/source-library-d1.js');
  return createSourceRenameService(new D1SourceRenameRepository(database), new D1SourceLibraryRepository(database), { now: () => '2026-10-03T00:00:00.000Z', createId: () => 'rename-event', logger: () => {} });
}
test('owner rename preserves revision and awaiting upload, updates search and shares atomic audit/idempotency stream', async () => {
  const { db, database } = migrated();
  try {
    const sut = await service(database);
    assert.deepEqual(await sut.rename(rename), { ok: true, value: { sourceId: 'source', runId: 'run', title: 'New title', revision: 1, reused: false } });
    assert.deepEqual({ ...db.prepare('SELECT title,revision FROM library_sources').get() }, { title: 'New title', revision: 1 });
    assert.equal(db.prepare('SELECT state FROM knowledge_workflow_runs').get().state, 'awaiting-upload');
    assert.equal(db.prepare("SELECT count(*) AS n FROM library_sources_fts WHERE library_sources_fts MATCH 'New'").get().n, 1);
    assert.deepEqual({ ...db.prepare("SELECT owner_id,old_title,new_title,source_revision,idempotency_key FROM library_source_events WHERE event_kind='renamed'").get() }, { owner_id: 'owner', old_title: 'Old title', new_title: 'New title', source_revision: 1, idempotency_key: 'rename-key' });
    db.exec("UPDATE knowledge_workflow_runs SET state='extraction-loop'");
    assert.deepEqual(await sut.rename(rename), { ok: true, value: { sourceId: 'source', runId: 'run', title: 'New title', revision: 1, reused: true } });
    assert.equal(db.prepare("SELECT count(*) AS n FROM library_source_events WHERE event_kind='renamed'").get().n, 1);
  } finally { db.close(); }
});

test('rename rejects missing or foreign context without writes and stale title/revision/run with a retry conflict', async () => {
  const { db, database } = migrated();
  try {
    const sut = await service(database);
    for (const update of [{ ownerId: 'other' }, { sourceId: 'missing' }, { runId: 'missing' }]) assert.deepEqual(await sut.rename({ ...rename, ...update }), { ok: false, error: { kind: 'SourceUploadContextUnavailable' } });
    for (const update of [{ expectedTitle: 'Stale' }, { expectedRevision: 2 }]) assert.deepEqual(await sut.rename({ ...rename, ...update }), { ok: false, error: { kind: 'SourceRenameConflict' } });
    db.exec("UPDATE knowledge_workflow_runs SET state='completed'");
    assert.deepEqual(await sut.rename(rename), { ok: false, error: { kind: 'SourceRenameConflict' } });
    assert.equal(db.prepare('SELECT title FROM library_sources').get().title, 'Old title');
    assert.equal(db.prepare('SELECT count(*) AS n FROM library_source_events').get().n, 1);
  } finally { db.close(); }
});

test('upload context reads current source independently of pagination and rejects invalid/stale bindings', async () => {
  const { db, database } = migrated();
  try {
    const sut = await service(database);
    const context = { ownerId: 'owner', sourceId: 'source', runId: 'run' };
    const result = await sut.uploadContext(context);
    assert.equal(result.ok, true);
    assert.equal(result.value.source.title, 'Old title');
    assert.equal(result.value.runId, 'run');
    for (const update of [{ ownerId: 'other' }, { sourceId: 'missing' }, { runId: 'missing' }]) assert.deepEqual(await sut.uploadContext({ ...context, ...update }), { ok: false, error: { kind: 'SourceUploadContextUnavailable' } });
    assert.deepEqual(await sut.uploadContext({ ...context, sourceId: '' }), { ok: false, error: { kind: 'SourceRenameCommandInvalid' } });
    db.exec('UPDATE library_sources SET revision=2');
    assert.deepEqual(await sut.uploadContext(context), { ok: false, error: { kind: 'SourceRenameConflict' } });
    db.exec("UPDATE library_sources SET revision=1; UPDATE knowledge_workflow_runs SET state='completed'");
    assert.deepEqual(await sut.uploadContext(context), { ok: false, error: { kind: 'SourceRenameConflict' } });
  } finally { db.close(); }
});

test('authenticated HTTP context and rename use owner identity, resolve audio reason and reject forged context', async () => {
  const { db, database } = migrated();
  try {
    db.prepare('UPDATE library_sources SET adapter_json=?').run(JSON.stringify({ granularity: 'episode', capabilities: ['audio'] }));
    const { createDiscoveryWorker } = await import('../worker/handler.js');
    const worker = createDiscoveryWorker({ allowedOrigin: 'https://app.test', maximumCommandBytes: 4096 }, { authenticate: async () => ({ ok: true, value: { ownerId: 'owner', email: 'test@example.test' } }), acquireRss: async () => assert.fail('No acquisition'), sourceRename: await service(database), requestLogger: () => ({ ok: true, value: null }) });
    const context = await worker.fetch(new Request('https://app.test/api/source-library/upload-context?sourceId=source&runId=run'));
    assert.equal(context.status, 200);
    const data = await context.json();
    assert.equal(data.result.source.title, 'Old title');
    assert.match(data.result.reason, /audio or video/);
    assert.equal(data.result.failureKind, undefined);
    const { ownerId, ...command } = rename;
    const send = body => worker.fetch(new Request('https://app.test/api/source-library/rename', { method: 'POST', body: JSON.stringify(body) }));
    assert.equal((await send(rename)).status, 400);
    const renamed = await send(command);
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).result.title, 'New title');
    assert.equal((await send({ ...command, expectedTitle: 'wrong', idempotencyKey: 'other-key' })).status, 409);
    assert.equal((await worker.fetch(new Request('https://app.test/api/source-library/upload-context?runId=run'))).status, 400);
    assert.equal((await worker.fetch(new Request('https://app.test/api/source-library/upload-context?sourceId=foreign&runId=run'))).status, 404);
  } finally { db.close(); }
});

test('a concurrent identical rename replays the committed event instead of reporting conflict', async () => {
  const { db, database } = migrated();
  try {
    const rival = await service(database);
    const concurrent = { ...database, async batch(statements) { assert.equal((await rival.rename(rename)).ok, true); return database.batch(statements); } };
    const result = await (await service(concurrent)).rename(rename);
    assert.equal(result.ok, true);
    assert.equal(result.value.reused, true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM library_source_events WHERE event_kind='renamed'").get().n, 1);
  } finally { db.close(); }
});

test('failed event insertion rolls title back and a race changing old title cannot leave an audit/idempotency row', async () => {
  const { db, database } = migrated();
  try {
    const { createSourceRenameService } = await import('../src/features/source-library/rename.js');
    const { D1SourceRenameRepository } = await import('../worker/source-rename-d1.js');
    const { D1SourceLibraryRepository } = await import('../worker/source-library-d1.js');
    const collision = createSourceRenameService(new D1SourceRenameRepository(database), new D1SourceLibraryRepository(database), { now: () => '2026-10-03T00:00:00Z', createId: () => 'approval', logger: () => {} });
    assert.deepEqual(await collision.rename(rename), { ok: false, error: { kind: 'SourceRenamePersistenceFailed' } });
    assert.equal(db.prepare('SELECT title FROM library_sources').get().title, 'Old title');
    const racing = { ...database, async batch(statements) { db.exec("UPDATE library_sources SET title='Another edit'"); return database.batch(statements); } };
    assert.deepEqual(await (await service(racing)).rename(rename), { ok: false, error: { kind: 'SourceRenameConflict' } });
    assert.equal(db.prepare('SELECT title FROM library_sources').get().title, 'Another edit');
    assert.equal(db.prepare('SELECT count(*) AS n FROM library_source_events').get().n, 1);
    assert.equal((await (await service(database)).rename({ ...rename, expectedTitle: 'Another edit' })).ok, true);
    assert.deepEqual(await (await service(database)).rename({ ...rename, title: 'Different command' }), { ok: false, error: { kind: 'SourceRenameIdempotencyConflict' } });
  } finally { db.close(); }
});

test('invalid rename command boundaries leave source/audit untouched', async () => {
  const { db, database } = migrated();
  try {
    const sut = await service(database);
    for (const patch of [{ sourceId: '' }, { runId: '' }, { ownerId: '' }, { expectedRevision: 0 }, { expectedRevision: 1.5 }, { expectedRevision: Infinity }, { expectedTitle: null }, { title: '' }, { title: '   ' }, { title: 'a'.repeat(301) }, { idempotencyKey: '' }]) assert.deepEqual(await sut.rename({ ...rename, ...patch }), { ok: false, error: { kind: 'SourceRenameCommandInvalid' } });
    assert.equal(db.prepare('SELECT count(*) AS n FROM library_source_events').get().n, 1);
    assert.equal((await sut.rename({ ...rename, title: 'a'.repeat(300) })).ok, true);
  } finally { db.close(); }
});

test('database batch failure is reported rather than claiming a successful rename', async () => {
  const { db, database } = migrated();
  try {
    const sut = await service({ ...database, batch: async () => [{ success: false }] });
    assert.deepEqual(await sut.rename(rename), { ok: false, error: { kind: 'SourceRenamePersistenceFailed' } });
  } finally { db.close(); }
});

test('search handler supplies cancellation within its operation budget', async () => {
  const { createDiscoveryWorker } = await import('../worker/handler.js');
  let signal;
  const worker = createDiscoveryWorker({ allowedOrigin: 'https://app.test', maximumCommandBytes: 4096, maximumBackendOperationMs: 10 }, { authenticate: async () => ({ ok: true, value: { ownerId: 'owner', email: 'test@example.test' } }), acquireRss: async () => assert.fail('No acquisition'), sourceCatalog: { search: async command => { signal = command.signal; await new Promise(resolve => setTimeout(resolve, 20)); return { ok: true, value: [] }; } }, requestLogger: () => ({ ok: true, value: null }) });
  await worker.fetch(new Request('https://app.test/api/source-library/search?q=synthetic&mode=semantic&limit=10&externalProcessingAllowed=true'));
  assert(signal instanceof AbortSignal);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signal.aborted, true);
});

test('D1 changed-row metadata may include trigger writes without changing the successful result', async () => {
  const { db, database } = migrated();
  try {
    const d1 = { ...database, async batch(statements) { const result = await database.batch(statements); return result.map(r => ({ ...r, meta: { changes: 3 } })); } };
    assert.equal((await (await service(d1)).rename(rename)).ok, true);
  } finally { db.close(); }
});

test('latest run, canonical identity and active source guards reject outdated upload handoffs', async () => {
  for (const change of ["UPDATE library_sources SET state='disabled'", "UPDATE knowledge_workflow_runs SET canonical_source_identity='https://changed.test'", "UPDATE knowledge_workflow_runs SET source_revision=2", "INSERT INTO knowledge_workflow_runs SELECT owner_id,'run-new',source_id,source_revision,canonical_source_identity,content_signature,state,revision,'run-new-key',config_digests_json,extraction_started_at,extraction_deadline_at,decision_required,counts_json,failure_kind,reused,created_at,'2026-10-04',run_json FROM knowledge_workflow_runs"]) {
    const { db, database } = migrated();
    try {
      db.exec(change);
      const sut = await service(database);
      assert.deepEqual(await sut.rename(rename), { ok: false, error: { kind: 'SourceRenameConflict' } });
      assert.deepEqual(await sut.uploadContext({ ownerId: 'owner', sourceId: 'source', runId: 'run' }), { ok: false, error: { kind: 'SourceRenameConflict' } });
      assert.equal(db.prepare('SELECT title FROM library_sources').get().title, 'Old title');
      assert.equal(db.prepare('SELECT count(*) AS n FROM library_source_events').get().n, 1);
    } finally { db.close(); }
  }
});

test('context and rename database outages return named failures with safe operation logging', async () => {
  const { db, database } = migrated();
  try {
    const sut = await service({ ...database, prepare() { throw new Error('synthetic database failure'); } });
    assert.deepEqual(await sut.rename(rename), { ok: false, error: { kind: 'SourceRenamePersistenceFailed' } });
    assert.deepEqual(await sut.uploadContext({ ownerId: 'owner', sourceId: 'source', runId: 'run' }), { ok: false, error: { kind: 'SourceUploadContextReadFailed' } });
  } finally { db.close(); }
});
