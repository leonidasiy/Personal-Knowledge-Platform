import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOpenLearnNavigationBudget, navigationReservationNanodollars } from '../scripts/openlearn-navigation-budget.mjs';

const metadata = Object.freeze({ model: 'z-ai/glm-5.3-flash', contextLength: 1048576, promptUSDPerMillion: .027, completionUSDPerMillion: .9 });
const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
function request(max_tokens = 1024, overrides = {}) {
  return { method: 'POST', body: JSON.stringify({ model: metadata.model, messages: [{ role: 'user', content: 'Isolated synthetic navigation task.' }], provider: { sort: 'throughput', require_parameters: true, allow_fallbacks: true, max_price: { prompt: .027, completion: .9, request: 0, image: 0 } }, reasoning: { effort: 'high' }, max_tokens, stream: false, ...overrides }) };
}
function receipt(cost = .00000123456, overrides = {}) {
  return new Response(JSON.stringify({ model: metadata.model, choices: [{ message: { role: 'assistant', content: '{}' } }], usage: { prompt_tokens: 30, completion_tokens: 20, cost }, ...overrides }), { status: 200 });
}
function fixture(transport = async () => receipt()) {
  const directory = mkdtempSync(join(tmpdir(), 'openlearn-budget-'));
  const storePath = join(directory, 'navigation.sqlite');
  let clock = 100000;
  const opened = [];
  const open = (options = {}) => { const budget = createOpenLearnNavigationBudget({ storePath, metadata, now: () => clock, fetch: transport, ...options }); opened.push(budget); return budget; };
  return { directory, storePath, open, now: () => clock, advance(milliseconds) { clock += milliseconds; }, cleanup() { for (const budget of opened) budget.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function readStore(storePath, query, all = false) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try { return all ? db.prepare(query).all() : db.prepare(query).get(); } finally { db.close(); }
}
async function haltedHistoryFixture(afterTimeout = async () => receipt(.00000123456, { id: 'gen-isolated-renewed-success' })) {
  let calls = 0;
  const f = fixture(async (...args) => {
    calls++;
    if (calls === 1) return receipt(.000725391, { usage: { prompt_tokens: 13394, completion_tokens: 643, cost: .000725391 } });
    if (calls === 2) return receipt(.000322704, { usage: { prompt_tokens: 17708, completion_tokens: 125, cost: .000322704 } });
    if (calls === 3) throw new Error('Isolated original timeout');
    return afterTimeout(...args);
  });
  const budget = f.open();
  for (let session = 0; session < 6; session++) assert.equal((await budget.reserveSession({ credits: 4, ttlSeconds: 120 })).ok, true);
  await budget.modelFetch(endpoint, request()); await budget.modelFetch(endpoint, request());
  await assert.rejects(budget.modelFetch(endpoint, request()));
  const unknown = readStore(f.storePath, 'SELECT key,cost AS costNanodollars,uncertainty_version AS uncertaintyVersion FROM evaluation_reservations WHERE response IS NULL');
  const authority = { ownerAuthorized: true, approvalId: 'owner-20261013-renewal-1', source: 'Isolated fixture for owner go-ahead to retain the full unknown cost and renew thirty minutes.', priorUnknowns: [{ ...unknown }] };
  f.advance(1800001);
  return { ...f, budget, authority, calls: () => calls };
}

test('exact rational arithmetic sums fractional nanodollars before rounding', () => {
  assert.equal(navigationReservationNanodollars({ inputTokens: 1, outputTokens: 0, promptUSDPerMillion: '0.0261', completionUSDPerMillion: '0.9' }), 27);
  assert.equal(navigationReservationNanodollars({ inputTokens: 10, outputTokens: 0, promptUSDPerMillion: '0.0261', completionUSDPerMillion: '0.9' }), 261);
  assert.equal(navigationReservationNanodollars({ inputTokens: 1, outputTokens: 1, promptUSDPerMillion: '0.0261', completionUSDPerMillion: '0.9' }), 927);
});

test('preparation leaves activation null; first POST reserves before transport and settles known usage', async () => {
  let budget, calls = 0;
  const f = fixture(async (_input, init) => {
    calls++;
    const state = budget.snapshot().value;
    assert.equal(state.modelRequests, 1);
    assert.equal(state.unresolvedModelRequests, 1);
    assert.equal(state.modelCostNanodollars, navigationReservationNanodollars({ inputTokens: metadata.contextLength, outputTokens: 1024, promptUSDPerMillion: .027, completionUSDPerMillion: .9 }));
    assert.ok(init.signal instanceof AbortSignal);
    return receipt();
  });
  try {
    budget = f.open();
    assert.equal(budget.snapshot().value.activatedAtMs, null);
    f.advance(5000);
    const response = await budget.modelFetch(endpoint, request());
    assert.equal(response.status, 200); assert.equal(calls, 1);
    const state = budget.snapshot().value;
    assert.equal(state.activatedAtMs, 105000); assert.equal(state.deadlineAtMs, 1905000);
    assert.equal(state.modelCostNanodollars, 1235); assert.equal(state.unresolvedModelRequests, 0);
    budget.close();
    f.advance(5000);
    const resumed = f.open().snapshot().value;
    assert.equal(resumed.activatedAtMs, state.activatedAtMs); assert.equal(resumed.deadlineAtMs, state.deadlineAtMs);
    assert.equal(resumed.modelRequests, 1); assert.equal(resumed.modelCostNanodollars, 1235);
  } finally { f.cleanup(); }
});

test('vision uses full catalogue context bound and retains high reasoning and output cap', async () => {
  const f = fixture();
  try {
    const budget = f.open();
    const response = await budget.modelFetch(endpoint, request(1024, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Isolated fixture screenshot.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }] }));
    assert.equal(response.status, 200);
    assert.equal(budget.snapshot().value.modelRequests, 1);
  } finally { f.cleanup(); }
});

test('missing receipts halt both resource paths, retain full reserve, and cannot retry after restart', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return receipt(0, { usage: { prompt_tokens: 30, completion_tokens: 20 } }); });
  try {
    const budget = f.open();
    await assert.rejects(budget.modelFetch(endpoint, request()), { kind: 'OpenLearnNavigationModelReceiptUnresolved' });
    const stopped = budget.snapshot().value;
    assert.equal(stopped.unresolvedModelRequests, 1); assert.ok(stopped.modelCostNanodollars > 0);
    budget.close();
    const resumed = f.open();
    assert.equal(resumed.snapshot().value.modelCostNanodollars, stopped.modelCostNanodollars);
    await assert.rejects(resumed.modelFetch(endpoint, request()), { kind: 'OpenLearnNavigationAccountingHalted' });
    assert.equal((await resumed.reserveBrowserSession({ credits: 2, ttlSeconds: 60 })).error.kind, 'OpenLearnNavigationAccountingHalted');
    assert.equal(calls, 1);
  } finally { f.cleanup(); }
});

test('transport failure and partial known receipts retain the reserve and observed cost', async () => {
  for (const transport of [async () => { throw new Error('isolated transport failure'); }, async () => receipt(.05, { usage: { cost: .05 } })]) {
    const f = fixture(transport);
    try {
      const budget = f.open();
      await assert.rejects(budget.modelFetch(endpoint, request()));
      assert.equal(budget.snapshot().value.unresolvedModelRequests, 1);
      assert.ok(budget.snapshot().value.modelCostNanodollars >= 29233000);
      if (budget.snapshot().value.halted === 'OpenLearnNavigationModelReceiptUnresolved') assert.equal(budget.snapshot().value.modelCostNanodollars, 50000000);
    } finally { f.cleanup(); }
  }
});

test('browser reservations activate once, survive restart, and stop both resources at 100 credits', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return receipt(); });
  try {
    const budget = f.open();
    assert.equal((await budget.reserveSession({ credits: 2, ttlSeconds: 60 })).ok, true);
    const activation = budget.snapshot().value.activatedAtMs;
    budget.close(); f.advance(2000);
    const resumed = f.open();
    assert.equal(resumed.snapshot().value.activatedAtMs, activation);
    assert.equal((await resumed.reserveBrowserSession({ credits: 98, ttlSeconds: 2940 })).ok, true);
    assert.equal(resumed.snapshot().value.reservedBrowserCredits, 100);
    assert.equal((await resumed.reserveBrowserSession({ credits: 2, ttlSeconds: 60 })).error.kind, 'BrowserCreditLimitExceeded');
    await assert.rejects(resumed.modelFetch(endpoint, request()), { kind: 'BrowserCreditLimitExceeded' });
    assert.equal(calls, 0);
  } finally { f.cleanup(); }
});

test('deadline resumes without reset; malformed and unaffordable requests never activate', async () => {
  const f = fixture();
  try {
    const budget = f.open();
    assert.equal((await budget.reserveSession({ credits: 2, ttlSeconds: 61 })).error.kind, 'BrowserCreditBudgetCommandInvalid');
    assert.equal((await budget.reserveSession({ credits: 102, ttlSeconds: 3060 })).error.kind, 'BrowserCreditLimitExceeded');
    await assert.rejects(budget.modelFetch(endpoint, request(1024, { model: 'unapproved/model' })), { kind: 'OpenLearnNavigationModelProtocolInvalid' });
    assert.equal(budget.snapshot().value.activatedAtMs, null);
    assert.equal((await budget.reserveSession({ credits: 2, ttlSeconds: 60 })).ok, true);
    budget.close(); f.advance(1800000);
    const resumed = f.open();
    assert.equal((await resumed.reserveSession({ credits: 2, ttlSeconds: 60 })).error.kind, 'OpenLearnNavigationDeadlineExceeded');
    await assert.rejects(resumed.modelFetch(endpoint, request()), { kind: 'OpenLearnNavigationDeadlineExceeded' });
  } finally { f.cleanup(); }
});

test('model ceiling stops before dispatch when insufficient dollars remain', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return receipt(.9); });
  try {
    const budget = f.open();
    await budget.modelFetch(endpoint, request(1000000));
    assert.equal(budget.snapshot().value.modelCostNanodollars, 900000000);
    await assert.rejects(budget.modelFetch(endpoint, request(1000000)), { kind: 'OpenLearnNavigationModelBudgetExceeded' });
    assert.equal(calls, 1);
    assert.equal(budget.snapshot().value.modelRequests, 1);
  } finally { f.cleanup(); }
});

test('historical or unrelated ledgers cannot be opened or altered', () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.storePath);
    db.exec("CREATE TABLE evaluation_budgets(budget_id TEXT PRIMARY KEY); INSERT INTO evaluation_budgets VALUES('owner-approved-image-benchmark');");
    db.close();
    assert.throws(() => f.open(), /OpenLearnNavigationBudgetStoreConflict/);
    const readback = new DatabaseSync(f.storePath);
    assert.equal(readback.prepare('SELECT budget_id FROM evaluation_budgets').get().budget_id, 'owner-approved-image-benchmark');
    assert.equal(readback.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table'").get().total, 1);
    readback.close();
  } finally { f.cleanup(); }
});

test('owner continuation admits only the exact original unknown and retains its full cost without activating preparation', async () => {
  const f = await haltedHistoryFixture();
  try {
    const originalRows = readStore(f.storePath, 'SELECT * FROM evaluation_reservations ORDER BY key', true);
    const originalGrant = readStore(f.storePath, 'SELECT * FROM openlearn_navigation_grant');
    const originalBudget = readStore(f.storePath, 'SELECT * FROM evaluation_budgets');
    assert.equal(f.budget.snapshot().value.modelCostNanodollars, 30281247);
    for (const bad of [
      { ...f.authority, ownerAuthorized: false },
      { ...f.authority, priorUnknowns: [] },
      { ...f.authority, priorUnknowns: [{ ...f.authority.priorUnknowns[0], key: 'unrelated-unknown' }] },
      { ...f.authority, priorUnknowns: [{ ...f.authority.priorUnknowns[0], costNanodollars: 1 }] },
      { ...f.authority, priorUnknowns: [{ ...f.authority.priorUnknowns[0], uncertaintyVersion: 2 }] },
    ]) assert.equal(f.budget.prepareContinuation(bad).ok, false);
    assert.equal(f.budget.prepareContinuation(f.authority).ok, true);
    const prepared = f.budget.snapshot().value;
    assert.equal(prepared.effectiveActivatedAtMs, null); assert.equal(prepared.effectiveDeadlineAtMs, null);
    assert.equal(prepared.modelCostNanodollars, 30281247); assert.equal(prepared.modelRequests, 3);
    assert.equal(prepared.unresolvedModelRequests, 1); assert.equal(prepared.activeModelRequests, 0);
    assert.equal(prepared.reservedBrowserCredits, 24); assert.equal(prepared.halted, null);
    assert.equal(prepared.originalHalted, originalGrant.halted);
    assert.equal(f.budget.prepareContinuation(f.authority).ok, true);
    assert.equal(f.budget.prepareContinuation({ ...f.authority, approvalId: 'second-renewal-not-authorized' }).error.kind, 'OpenLearnNavigationContinuationConflict');
    assert.deepEqual(readStore(f.storePath, 'SELECT * FROM evaluation_reservations ORDER BY key', true), originalRows);
    assert.deepEqual(readStore(f.storePath, 'SELECT * FROM openlearn_navigation_grant'), originalGrant);
    assert.deepEqual(readStore(f.storePath, 'SELECT * FROM evaluation_budgets'), originalBudget);
    assert.equal(f.calls(), 3);
  } finally { f.cleanup(); }
});

test('continuation activates at first paid dispatch, subtracts all historical counters, and resumes its same clock', async () => {
  const f = await haltedHistoryFixture();
  try {
    const old = f.budget.snapshot().value;
    assert.equal(f.budget.prepareContinuation(f.authority).ok, true);
    f.advance(5000);
    assert.equal((await f.budget.reserveSession({ credits: 4, ttlSeconds: 120 })).ok, true);
    const active = f.budget.snapshot().value;
    assert.equal(active.effectiveActivatedAtMs, old.deadlineAtMs + 5001);
    assert.equal(active.effectiveDeadlineAtMs, active.effectiveActivatedAtMs + 1800000);
    assert.equal(active.activatedAtMs, old.activatedAtMs); assert.equal(active.deadlineAtMs, old.deadlineAtMs);
    const row = readStore(f.storePath, 'SELECT policy FROM openlearn_continuation_evaluation_budgets');
    const policy = JSON.parse(row.policy);
    assert.equal(policy.maximumCostNanodollars, 1000000000 - 30281247);
    assert.equal(policy.maximumRequests, 1200 - 3);
    assert.equal(policy.maximumInputTokens, 3000000 - (13394 + 17708 + 1048576));
    assert.equal(policy.maximumOutputTokens, 3000000 - (643 + 125 + 1024));
    await f.budget.modelFetch(endpoint, request());
    const after = f.budget.snapshot().value;
    assert.equal(after.modelCostNanodollars, 30281247 + 1235); assert.equal(after.modelRequests, 4);
    assert.equal(after.unresolvedModelRequests, 1); assert.equal(after.activeModelRequests, 0);
    f.budget.close(); f.advance(1000);
    const resumed = f.open();
    assert.equal(resumed.prepareContinuation(f.authority).ok, true);
    assert.equal(resumed.snapshot().value.effectiveActivatedAtMs, active.effectiveActivatedAtMs);
    assert.equal(resumed.snapshot().value.effectiveDeadlineAtMs, active.effectiveDeadlineAtMs);
    assert.equal(resumed.snapshot().value.modelCostNanodollars, after.modelCostNanodollars);
    f.advance(1800000);
    assert.equal((await resumed.reserveSession({ credits: 2, ttlSeconds: 60 })).error.kind, 'OpenLearnNavigationDeadlineExceeded');
    assert.equal(resumed.prepareContinuation(f.authority).ok, true);
    assert.equal(resumed.snapshot().value.effectiveDeadlineAtMs, active.effectiveDeadlineAtMs);
  } finally { f.cleanup(); }
});

test('a new unknown halts the approved continuation and cannot obtain another renewal or blind retry', async () => {
  const f = await haltedHistoryFixture(async () => { throw new Error('Isolated new timeout'); });
  try {
    const oldOriginal = readStore(f.storePath, 'SELECT * FROM evaluation_reservations ORDER BY key', true);
    assert.equal(f.budget.prepareContinuation(f.authority).ok, true);
    await assert.rejects(f.budget.modelFetch(endpoint, request()));
    const halted = f.budget.snapshot().value;
    assert.equal(halted.unresolvedModelRequests, 2); assert.equal(halted.activeModelRequests, 1);
    assert.equal(halted.modelCostNanodollars, 30281247 + 29233152);
    assert.equal(halted.halted, 'OpenLearnNavigationModelTransportUncertain');
    assert.deepEqual(readStore(f.storePath, 'SELECT * FROM evaluation_reservations ORDER BY key', true), oldOriginal);
    assert.equal(f.budget.prepareContinuation(f.authority).ok, true);
    await assert.rejects(f.budget.modelFetch(endpoint, request()), { kind: 'OpenLearnNavigationAccountingHalted' });
    assert.equal((await f.budget.reserveSession({ credits: 2, ttlSeconds: 60 })).error.kind, 'OpenLearnNavigationAccountingHalted');
    f.budget.close();
    const resumed = f.open();
    await assert.rejects(resumed.modelFetch(endpoint, request()), { kind: 'OpenLearnNavigationAccountingHalted' });
    assert.equal(f.calls(), 4);
  } finally { f.cleanup(); }
});

test('continuation browser credits remain cumulative across the original and renewed windows', async () => {
  const f = await haltedHistoryFixture();
  try {
    assert.equal(f.budget.prepareContinuation(f.authority).ok, true);
    assert.equal((await f.budget.reserveSession({ credits: 76, ttlSeconds: 2280 })).ok, true);
    assert.equal(f.budget.snapshot().value.reservedBrowserCredits, 100);
    assert.equal((await f.budget.reserveSession({ credits: 2, ttlSeconds: 60 })).error.kind, 'BrowserCreditLimitExceeded');
    await assert.rejects(f.budget.modelFetch(endpoint, request()), { kind: 'BrowserCreditLimitExceeded' });
  } finally { f.cleanup(); }
});

test('safe generation IDs persist on successful receipts and before failed or partial body reads', async () => {
  const cases = [
    async () => receipt(.00000123456, { id: 'gen-isolated-success' }),
    async () => new Response('{"id":"gen-isolated-partial",', { status: 200 }),
    async () => new Response('not-json', { status: 200, headers: { 'x-generation-id': 'gen-isolated-header' } }),
    async () => new Response('{"choices":[{"message":{"content":"gen-untrusted-text"}}]', { status: 200 }),
  ];
  for (let index = 0; index < cases.length; index++) {
    const f = fixture(cases[index]);
    try {
      const budget = f.open();
      if (index === 0) await budget.modelFetch(endpoint, request()); else await assert.rejects(budget.modelFetch(endpoint, request()));
      const ids = readStore(f.storePath, 'SELECT generation_id FROM openlearn_model_generation_ids', true);
      if (index < 3) assert.equal(ids[0].generation_id, ['gen-isolated-success', 'gen-isolated-partial', 'gen-isolated-header'][index]);
      else assert.equal(ids.length, 0);
      if (index === 0) assert.equal(JSON.parse(readStore(f.storePath, 'SELECT response FROM evaluation_reservations').response).id, 'gen-isolated-success');
      else assert.equal(readStore(f.storePath, 'SELECT response FROM evaluation_reservations').response, null);
    } finally { f.cleanup(); }
  }
});

test('a second approved renewal appends after expiry and retains all first-window counters and history', async () => {
  const f = await haltedHistoryFixture(async () => receipt(.009536509, { id: 'gen-first-renewal-fixture', usage: { prompt_tokens: 300000, completion_tokens: 600, cost: .009536509 } }));
  try {
    assert.equal(f.budget.prepareContinuation(f.authority).ok, true);
    const authority2 = { ...f.authority, approvalId: 'owner-20261013-renewal-2', source: 'Owner fixture: please proceed then; renew thirty minutes under original limits.' };
    assert.equal(f.budget.prepareContinuation(authority2).error.kind, 'OpenLearnNavigationContinuationConflict');
    for (let i = 0; i < 5; i++) assert.equal((await f.budget.reserveSession({ credits: 4, ttlSeconds: 120 })).ok, true);
    await f.budget.modelFetch(endpoint, request());
    assert.equal(f.budget.prepareContinuation(authority2).error.kind, 'OpenLearnNavigationContinuationConflict');
    const first = f.budget.snapshot().value;
    assert.equal(first.modelCostNanodollars, 39817756); assert.equal(first.reservedBrowserCredits, 44);
    const retainedFirst = readStore(f.storePath, 'SELECT * FROM openlearn_navigation_continuation');
    const retainedRows = readStore(f.storePath, 'SELECT * FROM openlearn_continuation_evaluation_reservations ORDER BY key', true);
    f.advance(1800001);
    assert.equal(f.budget.prepareContinuation(authority2).ok, true);
    assert.equal(f.budget.prepareContinuation(authority2).ok, true);
    const prepared = f.budget.snapshot().value;
    assert.equal(prepared.effectiveActivatedAtMs, null); assert.equal(prepared.effectiveDeadlineAtMs, null);
    assert.equal(prepared.modelCostNanodollars, 39817756); assert.equal(prepared.reservedBrowserCredits, 44);
    assert.equal(prepared.modelRequests, 4); assert.equal(prepared.unresolvedModelRequests, 1); assert.equal(prepared.activeModelRequests, 0);
    assert.deepEqual(prepared.continuationHistory.map(row => row.approvalId), [f.authority.approvalId, authority2.approvalId]);
    assert.deepEqual(readStore(f.storePath, 'SELECT * FROM openlearn_navigation_continuation'), retainedFirst);
    assert.deepEqual(readStore(f.storePath, 'SELECT * FROM openlearn_continuation_evaluation_reservations ORDER BY key', true), retainedRows);
    f.advance(1234);
    assert.equal((await f.budget.reserveSession({ credits: 4, ttlSeconds: 120 })).ok, true);
    const active = f.budget.snapshot().value;
    assert.equal(active.effectiveActivatedAtMs, first.effectiveDeadlineAtMs + 1235);
    assert.equal(active.effectiveDeadlineAtMs, active.effectiveActivatedAtMs + 1800000);
    const policy = JSON.parse(readStore(f.storePath, 'SELECT policy FROM openlearn_continuation_2_evaluation_budgets').policy);
    assert.equal(policy.maximumCostNanodollars, 1000000000 - 39817756);
    assert.equal(policy.maximumRequests, 1200 - 4);
    assert.equal(policy.maximumInputTokens, 3000000 - (13394 + 17708 + 1048576 + 300000));
    assert.equal(policy.maximumOutputTokens, 3000000 - (643 + 125 + 1024 + 600));
    f.budget.close(); f.advance(1000);
    const resumed = f.open();
    assert.equal(resumed.prepareContinuation(authority2).ok, true);
    assert.equal(resumed.snapshot().value.effectiveDeadlineAtMs, active.effectiveDeadlineAtMs);
    assert.equal(resumed.snapshot().value.modelCostNanodollars, 39817756);
    assert.equal(resumed.snapshot().value.reservedBrowserCredits, 48);
    assert.equal((await resumed.reserveSession({ credits: 52, ttlSeconds: 1560 })).ok, true);
    await assert.rejects(resumed.modelFetch(endpoint, request()), { kind: 'BrowserCreditLimitExceeded' });
  } finally { f.cleanup(); }
});

test('second renewal cannot admit a new unknown produced by the first renewal', async () => {
  const f = await haltedHistoryFixture(async () => { throw new Error('Isolated first-renewal unknown'); });
  try {
    assert.equal(f.budget.prepareContinuation(f.authority).ok, true);
    await assert.rejects(f.budget.modelFetch(endpoint, request()));
    f.advance(1800001);
    const authority2 = { ...f.authority, approvalId: 'owner-20261013-renewal-2', source: 'Owner fixture: renew only with original unknown retained.' };
    assert.equal(f.budget.prepareContinuation(authority2).error.kind, 'OpenLearnNavigationContinuationConflict');
    assert.equal(f.budget.snapshot().value.unresolvedModelRequests, 2);
  } finally { f.cleanup(); }
});

test('a second-window unknown halts only that window, retains prior history, and blocks further renewal', async () => {
  let resumedCalls = 0;
  const f = await haltedHistoryFixture(async () => {
    if (++resumedCalls === 1) return receipt();
    throw new Error('Isolated second-window timeout');
  });
  try {
    assert.equal(f.budget.prepareContinuation(f.authority).ok, true);
    await f.budget.modelFetch(endpoint, request());
    const first = readStore(f.storePath, 'SELECT * FROM openlearn_navigation_continuation');
    f.advance(1800001);
    const authority2 = { ...f.authority, approvalId: 'owner-20261013-renewal-2', source: 'Owner fixture: please proceed then; renew with prior unknown preserved.' };
    assert.equal(f.budget.prepareContinuation(authority2).ok, true);
    await assert.rejects(f.budget.modelFetch(endpoint, request()));
    const stopped = f.budget.snapshot().value;
    assert.equal(stopped.modelCostNanodollars, 30281247 + 1235 + 29233152);
    assert.equal(stopped.unresolvedModelRequests, 2); assert.equal(stopped.activeModelRequests, 1);
    assert.equal(stopped.halted, 'OpenLearnNavigationModelTransportUncertain');
    assert.deepEqual(readStore(f.storePath, 'SELECT * FROM openlearn_navigation_continuation'), first);
    await assert.rejects(f.budget.modelFetch(endpoint, request()), { kind: 'OpenLearnNavigationAccountingHalted' });
    f.advance(1800001);
    assert.equal(f.budget.prepareContinuation({ ...authority2, approvalId: 'unapproved-third-window' }).error.kind, 'OpenLearnNavigationContinuationConflict');
    f.budget.close();
    const restarted = f.open();
    assert.equal(restarted.snapshot().value.halted, stopped.halted);
    assert.equal(restarted.snapshot().value.effectiveDeadlineAtMs, stopped.effectiveDeadlineAtMs);
    assert.equal(restarted.snapshot().value.modelCostNanodollars, stopped.modelCostNanodollars);
  } finally { f.cleanup(); }
});

async function preparationFixture() {
  const f = await haltedHistoryFixture();
  assert.equal(f.budget.prepareContinuation(f.authority).ok, true);
  assert.equal((await f.budget.reserveSession({ credits: 2, ttlSeconds: 60 })).ok, true);
  f.advance(1800001);
  const authority = { ...f.authority, approvalId: 'owner-20261013-renewal-2', source: 'Isolated approved renewal 2.' };
  assert.equal(f.budget.prepareContinuation(authority).ok, true);
  assert.equal((await f.budget.reserveSession({ credits: 2, ttlSeconds: 60 })).ok, true);
  f.advance(10000);
  return { ...f, authority };
}
function preparationProof(f, start, end, events = [], cleanup = { ok: true, value: null }) {
  const resultPath = join(f.directory, `result-${start}.json`), tracePath = join(f.directory, `trace-${start}-${end}.jsonl`);
  writeFileSync(resultPath, JSON.stringify({ recordedAt: new Date(start).toISOString(), cleanup, accounting: f.budget.snapshot().value }));
  writeFileSync(tracePath, [...events, { at: new Date(end).toISOString(), phase: 'lesson-processing' }].map(e => JSON.stringify(e)).join('\n') + '\n');
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  return { resultPath, resultSha256: digest(resultPath), tracePath, traceSha256: digest(tracePath) };
}
function preparationCommand(f, start, end, events) {
  return { approvalId: f.authority.approvalId, startAtMs: start, endAtMs: end, source: 'Owner AGENTS: offline preparation excluded from active execution.', proof: preparationProof(f, start, end, events) };
}

test('audited offline time corrects renewal 2 without changing grants, counters, or raw deadlines', async () => {
  const f = await preparationFixture();
  try {
    const baseline = f.budget.snapshot().value, raw = readStore(f.storePath, 'SELECT * FROM openlearn_navigation_renewals');
    const start = f.now(); f.advance(2000000); const end = f.now();
    const command = preparationCommand(f, start, end);
    assert.equal(f.budget.recordOfflinePreparationInterval(command).ok, true);
    assert.equal(f.budget.recordOfflinePreparationInterval(command).ok, true);
    const corrected = f.budget.snapshot().value;
    assert.equal(corrected.effectiveDeadlineAtMs, baseline.effectiveDeadlineAtMs + 2000000);
    assert.equal(corrected.excludedOfflineMilliseconds, 2000000);
    assert.equal(corrected.modelCostNanodollars, baseline.modelCostNanodollars);
    assert.equal(corrected.modelRequests, baseline.modelRequests);
    assert.equal(corrected.reservedBrowserCredits, baseline.reservedBrowserCredits);
    assert.deepEqual(readStore(f.storePath, 'SELECT * FROM openlearn_navigation_renewals'), raw);
    f.budget.close(); const resumed = f.open();
    assert.equal(resumed.snapshot().value.effectiveDeadlineAtMs, corrected.effectiveDeadlineAtMs);
    assert.equal((await resumed.reserveSession({ credits: 2, ttlSeconds: 60 })).ok, true);
    f.advance(1790000);
    assert.equal((await resumed.reserveSession({ credits: 2, ttlSeconds: 60 })).error.kind, 'OpenLearnNavigationDeadlineExceeded');
  } finally { f.cleanup(); }
});

test('cleanup pause freezes active time until the first paid dispatch and resumes exactly once', async () => {
  const f = await preparationFixture();
  try {
    const baseline = f.budget.snapshot().value, start = f.now();
    const { endAtMs, ...pause } = preparationCommand(f, start, start);
    assert.equal(f.budget.pauseForPreparation(pause).ok, true);
    assert.equal(f.budget.pauseForPreparation(pause).ok, true);
    f.advance(4000000);
    assert.equal(f.budget.snapshot().value.preparationPaused, true);
    assert.equal(f.budget.snapshot().value.effectiveDeadlineAtMs, baseline.effectiveDeadlineAtMs + 4000000);
    f.budget.close(); const restarted = f.open();
    assert.equal(restarted.snapshot().value.preparationPaused, true);
    assert.equal((await restarted.reserveSession({ credits: 100, ttlSeconds: 3000 })).error.kind, 'BrowserCreditLimitExceeded');
    assert.equal(restarted.snapshot().value.preparationPaused, true);
    assert.equal((await restarted.reserveSession({ credits: 2, ttlSeconds: 60 })).ok, true);
    const resumed = restarted.snapshot().value;
    assert.equal(resumed.preparationPaused, false);
    assert.equal(resumed.excludedOfflineMilliseconds, 4000000);
    assert.equal(resumed.effectiveActivatedAtMs, baseline.effectiveActivatedAtMs);
    f.advance(1000);
    assert.equal(restarted.resumeFromPreparation().ok, true);
    assert.equal(restarted.snapshot().value.effectiveDeadlineAtMs, resumed.effectiveDeadlineAtMs);
    assert.equal(readStore(f.storePath, 'SELECT COUNT(*) AS n FROM openlearn_preparation_resumes').n, 1);
  } finally { f.cleanup(); }
});

test('offline proof rejects paid browser or model overlap, malformed evidence, and expired active starts', async () => {
  for (const scenario of ['browser', 'model', 'hash', 'cleanup', 'approval', 'expired', 'overlap']) {
    const f = await preparationFixture();
    try {
      const start = f.now(); f.advance(1000); const end = f.now();
      const events = scenario === 'model' ? [{ at: new Date(end + 100).toISOString(), event: 'knowledge-model-success', durationMs: 200, requestId: 'gen-fixture-overlap' }] : [];
      let command = preparationCommand(f, start, end, events);
      if (scenario === 'browser') {
        const db = new DatabaseSync(f.storePath);
        db.prepare('INSERT INTO openlearn_browser_reservations VALUES(?,?,?,?)').run('isolated-overlap', 2, 60, start + 1); db.close();
      }
      if (scenario === 'hash') command.proof.resultSha256 = '0'.repeat(64);
      if (scenario === 'cleanup') command.proof = preparationProof(f, start, end, [], { ok: false });
      if (scenario === 'approval') command.approvalId = f.authority.approvalId + '-wrong';
      if (scenario === 'expired') {
        const expired = f.budget.snapshot().value.effectiveDeadlineAtMs;
        f.advance(expired - f.now() + 1000); command = preparationCommand(f, expired, f.now());
      }
      if (scenario === 'overlap') {
        assert.equal(f.budget.recordOfflinePreparationInterval(command).ok, true);
        f.advance(1000); command = preparationCommand(f, start + 1, f.now());
      }
      assert.equal(f.budget.recordOfflinePreparationInterval(command).ok, false, scenario);
    } finally { f.cleanup(); }
  }
});

test('new unknowns prevent offline corrections and model dispatch journals survive known receipts', async () => {
  const f = await preparationFixture();
  try {
    const start = f.now(); f.advance(1000);
    const command = preparationCommand(f, start, f.now());
    await f.budget.modelFetch(endpoint, request());
    const dispatch = readStore(f.storePath, 'SELECT * FROM openlearn_model_dispatches ORDER BY physical_started_at_ms DESC LIMIT 1');
    assert.equal(dispatch.approval_id, f.authority.approvalId); assert.equal(dispatch.physical_started_at_ms, f.now());
    assert.ok(readStore(f.storePath, 'SELECT * FROM openlearn_model_dispatch_outcomes WHERE reservation_key=' + "'" + dispatch.reservation_key + "'"));
    assert.equal(f.budget.recordOfflinePreparationInterval(command).ok, true);
    const uncertain = f.open({ fetch: async () => { throw new Error('Isolated timeout'); } });
    await assert.rejects(uncertain.modelFetch(endpoint, request()));
    const pauseStart = f.now(), { endAtMs, ...pause } = preparationCommand(f, pauseStart, pauseStart);
    assert.equal(uncertain.pauseForPreparation(pause).ok, false);
  } finally { f.cleanup(); }
});
