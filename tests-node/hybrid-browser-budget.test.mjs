import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHybridBrowserBudget } from '../worker/hybrid-browser-budget.js';

const timestamp = '2026-10-13T00:00:00.000Z';

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const migration of ['0008_knowledge_workflows.sql', '0009_knowledge_workflow_content.sql', '0027_hybrid_browser_budget.sql']) {
    db.exec(readFileSync(new URL(`../worker/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const database = {
    prepare(query) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return db.prepare(query).get(...bindings) ?? null; },
        async run() { const result = db.prepare(query).run(...bindings); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
  };
  let nextId = 0;
  const logs = [];
  const addRun = (ownerId = 'owner', runId = 'run', state = 'extraction-loop') => {
    db.prepare(`INSERT INTO knowledge_workflow_runs
      (owner_id,run_id,source_id,source_revision,canonical_source_identity,content_signature,state,revision,idempotency_key,config_digests_json,counts_json,reused,created_at,updated_at,run_json)
      VALUES (?,?,?,1,?,?,?,1,?,'{}','{}',0,?,?,'{}')`).run(ownerId, runId, `source-${runId}`, 'https://example.org/course', 'fixture', state, `command-${runId}`, timestamp, timestamp);
  };
  const budget = (maximumCredits = 100, ownerId = 'owner', runId = 'run', overrides = {}) => createHybridBrowserBudget({
    database, ownerId, runId, maximumCredits, now: () => timestamp, createId: () => `reservation-${++nextId}`, logger: entry => logs.push(entry), ...overrides,
  });
  const reservations = () => db.prepare('SELECT * FROM knowledge_workflow_browser_credit_reservations ORDER BY reservation_id').all();
  return { db, database, logs, addRun, budget, reservations };
}

test('each session reserves its full minute-rounded cost and cumulative credits survive helper recreation', async () => {
  const f = fixture();
  try {
    f.addRun();
    assert.deepEqual(await f.budget(8).reserveSession({ credits: 2, ttlSeconds: 1 }), { ok: true, value: null });
    assert.equal((await f.budget(8).reserveSession({ credits: 2, ttlSeconds: 60 })).ok, true);
    assert.equal((await f.budget(8).reserveSession({ credits: 4, ttlSeconds: 61 })).ok, true);
    assert.deepEqual(await f.budget(8).reserveSession({ credits: 2, ttlSeconds: 1 }), { ok: false, error: { kind: 'BrowserCreditLimitExceeded' } });
    assert.equal(f.reservations().reduce((sum, row) => sum + row.credits, 0), 8);
    assert.deepEqual(f.reservations().map(row => row.ttl_seconds), [1, 60, 61]);
    assert.ok(f.reservations().every(row => row.created_at === timestamp));
    // Failed or unknown remote launches cannot refund anything through this helper.
    assert.equal(typeof f.budget().refund, 'undefined');
  } finally { f.db.close(); }
});

test('concurrent reservation requests from separate helpers cannot overspend', async () => {
  const f = fixture();
  try {
    f.addRun();
    const results = await Promise.all([f.budget(2).reserveSession({ credits: 2, ttlSeconds: 60 }), f.budget(2).reserveSession({ credits: 2, ttlSeconds: 60 })]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => !result.ok && result.error.kind === 'BrowserCreditLimitExceeded').length, 1);
    assert.equal(f.reservations().length, 1);
  } finally { f.db.close(); }
});

test('run and owner scopes are isolated; nonexistent and foreign runs cannot reserve', async () => {
  const f = fixture();
  try {
    f.addRun(); f.addRun('owner', 'other-run'); f.addRun('other-owner', 'run');
    for (const [owner, run] of [['owner', 'run'], ['owner', 'other-run'], ['other-owner', 'run']]) {
      assert.equal((await f.budget(2, owner, run).reserveSession({ credits: 2, ttlSeconds: 60 })).ok, true);
    }
    for (const [owner, run] of [['owner', 'missing'], ['other-owner', 'other-run']]) {
      assert.deepEqual(await f.budget(2, owner, run).reserveSession({ credits: 2, ttlSeconds: 60 }), { ok: false, error: { kind: 'BrowserWorkflowInactive' } });
    }
    assert.equal(f.reservations().length, 3);
  } finally { f.db.close(); }
});

test('inactive states and run tombstones prevent session reservations without erasing prior costs', async () => {
  const f = fixture();
  try {
    f.addRun();
    assert.equal((await f.budget().reserveSession({ credits: 2, ttlSeconds: 60 })).ok, true);
    for (const state of ['paused', 'completed', 'abandoned', 'retryable-failure', 'awaiting-rights-review', 'awaiting-upload', 'awaiting-time-limit-decision', 'failed', 'unknown']) {
      f.db.prepare('UPDATE knowledge_workflow_runs SET state = ? WHERE owner_id = ? AND run_id = ?').run(state, 'owner', 'run');
      assert.deepEqual(await f.budget().reserveSession({ credits: 2, ttlSeconds: 60 }), { ok: false, error: { kind: 'BrowserWorkflowInactive' } }, state);
    }
    f.db.prepare("UPDATE knowledge_workflow_runs SET state = 'extraction-loop'").run();
    f.db.prepare('INSERT INTO knowledge_workflow_run_tombstones VALUES(?,?,?,?,?,?)').run('owner', 'cancelled', 'run', timestamp, 'workflow-abandoned', timestamp);
    assert.deepEqual(await f.budget().reserveSession({ credits: 2, ttlSeconds: 60 }), { ok: false, error: { kind: 'BrowserWorkflowInactive' } });
    assert.equal(f.reservations().length, 1);
  } finally { f.db.close(); }
});

test('malformed reservation commands and dependencies never write a reservation', async () => {
  const f = fixture();
  try {
    f.addRun();
    for (const command of [null, {}, { credits: 0, ttlSeconds: 60 }, { credits: 2, ttlSeconds: 0 }, { credits: 2, ttlSeconds: 61 }, { credits: 4, ttlSeconds: 60 }, { credits: 2, ttlSeconds: 1.5 }, { credits: Infinity, ttlSeconds: 60 }]) {
      assert.deepEqual(await f.budget().reserveSession(command), { ok: false, error: { kind: 'BrowserCreditBudgetCommandInvalid' } });
    }
    assert.deepEqual(await f.budget(100, 'owner', 'run', { now: () => 'invalid' }).reserveSession({ credits: 2, ttlSeconds: 60 }), { ok: false, error: { kind: 'BrowserCreditBudgetCommandInvalid' } });
    assert.deepEqual(await f.budget(100, 'owner', 'run', { createId: () => '' }).reserveSession({ credits: 2, ttlSeconds: 60 }), { ok: false, error: { kind: 'BrowserCreditBudgetCommandInvalid' } });
    assert.throws(() => f.budget(-1), TypeError);
    assert.throws(() => f.budget(Infinity), TypeError);
    assert.equal(f.reservations().length, 0);
    assert.deepEqual(await f.budget(0).reserveSession({ credits: 2, ttlSeconds: 60 }), { ok: false, error: { kind: 'BrowserCreditLimitExceeded' } });
  } finally { f.db.close(); }
});

test('persistence failures and uncertain write responses prevent authorization and log a typed failure', async () => {
  const f = fixture();
  try {
    f.addRun();
    for (const database of [
      { prepare() { throw new Error('database unavailable'); } },
      { prepare() { return { bind() { return this; }, async run() { return { success: false }; } }; } },
      { prepare() { return { bind() { return this; }, async run() { return { success: true }; } }; } },
    ]) {
      const result = await f.budget(100, 'owner', 'run', { database }).reserveSession({ credits: 2, ttlSeconds: 60 });
      assert.deepEqual(result, { ok: false, error: { kind: 'BrowserCreditBudgetPersistenceFailed' } });
    }
    assert.equal(f.logs.length, 3);
    assert.ok(f.logs.every(entry => entry.failureKind === 'BrowserCreditBudgetPersistenceFailed'));
    assert.equal(f.reservations().length, 0);
  } finally { f.db.close(); }
});

test('migration enforces owner/run foreign keys and code-only credit calculation', () => {
  const f = fixture();
  try {
    f.addRun();
    const statement = f.db.prepare('INSERT INTO knowledge_workflow_browser_credit_reservations VALUES(?,?,?,?,?,?)');
    assert.throws(() => statement.run('owner', 'missing', 'foreign', 2, 60, timestamp), /FOREIGN KEY/);
    assert.throws(() => statement.run('owner', 'run', 'under-reserved', 2, 61, timestamp), /CHECK/);
    statement.run('owner', 'run', 'reserved', 4, 61, timestamp);
    assert.throws(() => f.db.prepare('DELETE FROM knowledge_workflow_runs').run(), /FOREIGN KEY/);
  } finally { f.db.close(); }
});
