// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEvaluationLedger } from './evaluation-budget.mjs';

const GRANT_ID = 'owner-approved-openlearn-navigation';
const MODEL = 'z-ai/glm-5.3-flash';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const POLICY = Object.freeze({ maximumRequests: 1200, maximumInputTokens: 3000000, maximumOutputTokens: 3000000, maximumMilliseconds: 1800000, maximumCostNanodollars: 1000000000 });
const OWNER_CONTRACT = Object.freeze({ source: 'Owner OpenLearn navigation test: early stopping when $1 model API cost or 100 free Firecrawl credits is incurred/consumed.', modelCostLimitNanodollars: 1000000000, browserCreditLimit: 100, maximumMilliseconds: 1800000, model: MODEL, reasoningEffort: 'high' });

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is number} */
function count(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** @param {string} kind */
function failure(kind) { return { ok: /** @type {const} */ (false), error: { kind } }; }

/** Exact decimal rational representation, including provider JSON exponents.
 * @param {string | number} value @returns {{numerator:bigint,denominator:bigint}|null} */
function fraction(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) return null;
  const power = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (!Number.isSafeInteger(power) || Math.abs(power) > 1000) return null;
  const digits = BigInt(match[1] + (match[2] ?? ''));
  return power >= 0 ? { numerator: digits * 10n ** BigInt(power), denominator: 1n } : { numerator: digits, denominator: 10n ** BigInt(-power) };
}
/** @param {bigint} numerator @param {bigint} denominator @returns {number|null} */
function ceiling(numerator, denominator) { const amount = (numerator + denominator - 1n) / denominator; return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null; }

/** Sum exact USD/million rates before rounding upward once to nanodollars.
 * @param {{inputTokens:number,outputTokens:number,promptUSDPerMillion:string|number,completionUSDPerMillion:string|number}} command */
export function navigationReservationNanodollars(command) {
  if (!count(command.inputTokens) || !count(command.outputTokens)) return null;
  const prompt = fraction(command.promptUSDPerMillion), completion = fraction(command.completionUSDPerMillion);
  if (!prompt || !completion) return null;
  return ceiling((BigInt(command.inputTokens) * prompt.numerator * completion.denominator + BigInt(command.outputTokens) * completion.numerator * prompt.denominator) * 1000n, prompt.denominator * completion.denominator);
}

/** @param {number} dollars */
function receiptNanodollars(dollars) { const cost = fraction(dollars); return cost ? ceiling(cost.numerator * 1000000000n, cost.denominator) : null; }
/** @param {unknown} value @returns {value is string} */
function generationId(value) { return typeof value === 'string' && /^gen-[0-9A-Za-z-]{1,124}$/.test(value); }

export class OpenLearnNavigationBudgetFailure extends Error {
  /** @param {{kind:string}} error */
  constructor(error) { super(error.kind); this.name = 'OpenLearnNavigationBudgetFailure'; this.kind = error.kind; }
}

/** A separate owner grant; never opens or resets historical image benchmark ledgers.
 * Bounds come from the fresh approved GLM catalogue and enforced provider ceilings.
 * The whole model context bounds text and visual inputs, without tokenizer estimates.
 * @param {{storePath:string,metadata:{model:string,contextLength:number,promptUSDPerMillion:number,completionUSDPerMillion:number,canonicalSlug?:string},now?:()=>number,fetch?:typeof fetch,logger?:(entry:{event:string,failureKind?:string})=>void}} dependencies */
export function createOpenLearnNavigationBudget(dependencies) {
  const metadata = Object.freeze({ ...dependencies.metadata });
  if (typeof dependencies.storePath !== 'string' || dependencies.storePath.trim() === '' || !metadata || metadata.model !== MODEL || !count(metadata.contextLength) || metadata.contextLength === 0 || metadata.contextLength > POLICY.maximumInputTokens || !fraction(metadata.promptUSDPerMillion) || !fraction(metadata.completionUSDPerMillion) || metadata.promptUSDPerMillion > .027 || metadata.completionUSDPerMillion > .9 || metadata.canonicalSlug !== undefined && (typeof metadata.canonicalSlug !== 'string' || !metadata.canonicalSlug.startsWith(`${MODEL}-`))) throw new TypeError('OpenLearnNavigationBudgetDependenciesInvalid');
  const now = dependencies.now ?? Date.now, transport = dependencies.fetch ?? globalThis.fetch, logger = dependencies.logger ?? (() => {});
  if (typeof now !== 'function' || typeof transport !== 'function' || typeof logger !== 'function') throw new TypeError('OpenLearnNavigationBudgetDependenciesInvalid');
  const database = new DatabaseSync(resolve(dependencies.storePath));
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (tables.length && !tables.some(table => table.name === 'openlearn_navigation_grant')) { database.close(); throw new TypeError('OpenLearnNavigationBudgetStoreConflict'); }
  database.exec(`PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS openlearn_navigation_grant (grant_id TEXT PRIMARY KEY, contract_json TEXT NOT NULL, metadata_json TEXT NOT NULL, activated_at_ms INTEGER, deadline_at_ms INTEGER, halted TEXT);
    CREATE TABLE IF NOT EXISTS openlearn_browser_reservations (reservation_id TEXT PRIMARY KEY, credits INTEGER NOT NULL CHECK(credits>0), ttl_seconds INTEGER NOT NULL CHECK(ttl_seconds>0), created_at_ms INTEGER NOT NULL, CHECK(credits=2*((ttl_seconds+59)/60)));
    CREATE TABLE IF NOT EXISTS openlearn_navigation_continuation (slot INTEGER PRIMARY KEY CHECK(slot=1), approval_id TEXT NOT NULL UNIQUE, approval_json TEXT NOT NULL, original_snapshot_json TEXT NOT NULL, activated_at_ms INTEGER, deadline_at_ms INTEGER, halted TEXT);
    CREATE TABLE IF NOT EXISTS openlearn_navigation_renewals (sequence INTEGER PRIMARY KEY CHECK(sequence>=2), approval_id TEXT NOT NULL UNIQUE, approval_json TEXT NOT NULL, original_snapshot_json TEXT NOT NULL, activated_at_ms INTEGER, deadline_at_ms INTEGER, halted TEXT);
    CREATE TABLE IF NOT EXISTS openlearn_model_generation_ids (reservation_key TEXT PRIMARY KEY, generation_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS openlearn_offline_intervals (interval_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, start_at_ms INTEGER NOT NULL, end_at_ms INTEGER NOT NULL CHECK(end_at_ms>start_at_ms), source TEXT NOT NULL, proof_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS openlearn_preparation_pauses (pause_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, start_at_ms INTEGER NOT NULL, source TEXT NOT NULL, proof_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS openlearn_preparation_resumes (pause_id TEXT PRIMARY KEY REFERENCES openlearn_preparation_pauses(pause_id), end_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS openlearn_model_dispatches (reservation_key TEXT PRIMARY KEY, approval_id TEXT, physical_started_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS openlearn_model_dispatch_outcomes (reservation_key TEXT PRIMARY KEY REFERENCES openlearn_model_dispatches(reservation_key), physical_ended_at_ms INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS openlearn_grant_contract_immutable BEFORE UPDATE OF grant_id,contract_json,metadata_json ON openlearn_navigation_grant BEGIN SELECT RAISE(ABORT,'OpenLearnGrantImmutable'); END;
    CREATE TRIGGER IF NOT EXISTS openlearn_grant_no_delete BEFORE DELETE ON openlearn_navigation_grant BEGIN SELECT RAISE(ABORT,'OpenLearnGrantImmutable'); END;
    CREATE TRIGGER IF NOT EXISTS openlearn_continuation_approval_immutable BEFORE UPDATE OF slot,approval_id,approval_json,original_snapshot_json ON openlearn_navigation_continuation BEGIN SELECT RAISE(ABORT,'OpenLearnContinuationImmutable'); END;
    CREATE TRIGGER IF NOT EXISTS openlearn_continuation_activation_immutable BEFORE UPDATE OF activated_at_ms,deadline_at_ms ON openlearn_navigation_continuation WHEN OLD.activated_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'OpenLearnContinuationImmutable'); END;
    CREATE TRIGGER IF NOT EXISTS openlearn_continuation_halt_immutable BEFORE UPDATE OF halted ON openlearn_navigation_continuation WHEN OLD.halted IS NOT NULL AND NEW.halted IS NOT OLD.halted BEGIN SELECT RAISE(ABORT,'OpenLearnContinuationImmutable'); END;
    CREATE TRIGGER IF NOT EXISTS openlearn_continuation_no_delete BEFORE DELETE ON openlearn_navigation_continuation BEGIN SELECT RAISE(ABORT,'OpenLearnContinuationImmutable'); END;
    CREATE TRIGGER IF NOT EXISTS openlearn_renewal_approval_immutable BEFORE UPDATE OF sequence,approval_id,approval_json,original_snapshot_json ON openlearn_navigation_renewals BEGIN SELECT RAISE(ABORT,'OpenLearnContinuationImmutable'); END;
    CREATE TRIGGER IF NOT EXISTS openlearn_renewal_activation_immutable BEFORE UPDATE OF activated_at_ms,deadline_at_ms ON openlearn_navigation_renewals WHEN OLD.activated_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'OpenLearnContinuationImmutable'); END;
    CREATE TRIGGER IF NOT EXISTS openlearn_renewal_halt_immutable BEFORE UPDATE OF halted ON openlearn_navigation_renewals WHEN OLD.halted IS NOT NULL AND NEW.halted IS NOT OLD.halted BEGIN SELECT RAISE(ABORT,'OpenLearnContinuationImmutable'); END;
    CREATE TRIGGER IF NOT EXISTS openlearn_renewal_no_delete BEFORE DELETE ON openlearn_navigation_renewals BEGIN SELECT RAISE(ABORT,'OpenLearnContinuationImmutable'); END;`);
  for (const table of ['openlearn_offline_intervals', 'openlearn_preparation_pauses', 'openlearn_preparation_resumes', 'openlearn_model_dispatches', 'openlearn_model_dispatch_outcomes']) {
    database.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'OpenLearnAuditImmutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'OpenLearnAuditImmutable'); END;`);
  }
  const binding = JSON.stringify(metadata), contract = JSON.stringify(OWNER_CONTRACT);
  database.prepare('INSERT OR IGNORE INTO openlearn_navigation_grant(grant_id,contract_json,metadata_json) VALUES(?,?,?)').run(GRANT_ID, contract, binding);
  const grants = database.prepare('SELECT * FROM openlearn_navigation_grant').all(), stored = grants[0];
  if (grants.length !== 1 || stored.grant_id !== GRANT_ID || stored.contract_json !== contract || stored.metadata_json !== binding) { database.close(); throw new TypeError('OpenLearnNavigationBudgetGrantConflict'); }
  const existingBudgets = tables.some(table => table.name === 'evaluation_budgets') ? database.prepare('SELECT budget_id FROM evaluation_budgets').all() : [];
  if (existingBudgets.some(row => row.budget_id !== GRANT_ID)) { database.close(); throw new TypeError('OpenLearnNavigationBudgetStoreConflict'); }
  /** @type {ReturnType<typeof createEvaluationLedger>|null} */ let ledger = null;
  /** @type {Map<number,ReturnType<typeof createEvaluationLedger>>} */ const continuationLedgers = new Map();
  let closed = false;
  /** @returns {Record<string,unknown>} */
  function grant() { const value = database.prepare('SELECT * FROM openlearn_navigation_grant WHERE grant_id=?').get(GRANT_ID); if (!value) throw new TypeError('OpenLearnNavigationBudgetGrantMissing'); return /** @type {Record<string,unknown>} */ (value); }
  /** @returns {number} */
  function instant() { const value = now(); if (!count(value)) throw new TypeError('OpenLearnNavigationClockInvalid'); return value; }
  function activate() {
    if (ledger) return ledger;
    ledger = createEvaluationLedger({ database: /** @type {import('./evaluation-budget.mjs').LedgerDatabase} */ (database), budgetId: GRANT_ID, policy: POLICY, now: instant, logger });
    const state = ledger.snapshot(); if (!state.ok) throw new OpenLearnNavigationBudgetFailure(state.error);
    const row = grant();
    if (row.activated_at_ms === null) database.prepare('UPDATE openlearn_navigation_grant SET activated_at_ms=?,deadline_at_ms=? WHERE grant_id=? AND activated_at_ms IS NULL').run(state.value.startedAtMs, state.value.deadlineAtMs, GRANT_ID);
    else if (row.activated_at_ms !== state.value.startedAtMs || row.deadline_at_ms !== state.value.deadlineAtMs) throw new TypeError('OpenLearnNavigationActivationConflict');
    return ledger;
  }
  if (stored.activated_at_ms !== null || existingBudgets.length) activate();

  /** @returns {Record<string,unknown>[]} */
  function windowRows() {
    const first = database.prepare('SELECT 1 AS sequence,* FROM openlearn_navigation_continuation WHERE slot=1').get();
    const renewals = database.prepare('SELECT * FROM openlearn_navigation_renewals ORDER BY sequence').all();
    const rows = /** @type {Record<string,unknown>[]} */ (first ? [first, ...renewals] : renewals);
    if (rows.some((row, index) => row.sequence !== index + 1)) throw new TypeError('OpenLearnNavigationContinuationSequenceInvalid');
    return rows;
  }
  /** @returns {Record<string,unknown>|null} */
  function continuation() { return windowRows().at(-1) ?? null; }
  /** Immutable intervals and acknowledged cleanup pauses use physical time;
   * the underlying ledger continues to use its original logical deadline.
   * @param {Record<string,unknown>} row */
  function preparationHistory(row) {
    const intervals = database.prepare('SELECT start_at_ms,end_at_ms,source,proof_json FROM openlearn_offline_intervals WHERE approval_id=?').all(String(row.approval_id));
    const pauses = database.prepare('SELECT p.pause_id,p.start_at_ms,r.end_at_ms,p.source,p.proof_json FROM openlearn_preparation_pauses p LEFT JOIN openlearn_preparation_resumes r USING(pause_id) WHERE p.approval_id=?').all(String(row.approval_id));
    return [...intervals.map(item => ({ ...item, pause_id: null })), ...pauses].sort((a, b) => Number(a.start_at_ms) - Number(b.start_at_ms));
  }
  /** @param {Record<string,unknown>|null} row @param {number} at */
  function offlineOffset(row, at) { return row ? preparationHistory(row).reduce((total, item) => total + Math.max(0, Math.min(at, item.end_at_ms === null ? at : Number(item.end_at_ms)) - Number(item.start_at_ms)), 0) : 0; }
  /** @param {Record<string,unknown>|null} row @param {number} [at] */
  function logicalInstant(row, at = instant()) { return at - offlineOffset(row, at); }
  /** @param {Record<string,unknown>} row */
  function effectiveDeadline(row) { return row.deadline_at_ms === null ? null : Number(row.deadline_at_ms) + offlineOffset(row, instant()); }
  /** @param {Record<string,unknown>} row */
  function namespace(row) { return row.sequence === 1 ? 'openlearn_continuation_' : `openlearn_continuation_${row.sequence}_`; }
  /** @param {Record<string,unknown>} row */
  function control(row) { return row.sequence === 1 ? { table: 'openlearn_navigation_continuation', key: 'slot', value: 1 } : { table: 'openlearn_navigation_renewals', key: 'sequence', value: Number(row.sequence) }; }
  function originalSnapshot() {
    const state = ledger?.snapshot();
    if (!state?.ok) throw new TypeError('OpenLearnNavigationOriginalLedgerUnavailable');
    const row = grant();
    const unknowns = database.prepare('SELECT key,cost AS costNanodollars,uncertainty_version AS uncertaintyVersion FROM evaluation_reservations WHERE response IS NULL ORDER BY key').all();
    return { activatedAtMs: row.activated_at_ms, deadlineAtMs: row.deadline_at_ms, grantHalted: row.halted, ledgerHalted: state.value.halted, cancelled: state.value.cancelled, requests: state.value.requests, inputTokens: state.value.inputTokens, outputTokens: state.value.outputTokens, costNanodollars: state.value.costNanodollars, unknowns };
  }
  /** @param {number} sequence */
  function historicalSnapshot(sequence) {
    const original = originalSnapshot();
    if (sequence === 1) return original;
    const previous = windowRows().filter(row => Number(row.sequence) < sequence);
    const windows = [];
    for (const row of previous) {
      if (row.activated_at_ms === null) throw new TypeError('OpenLearnNavigationContinuationHistoryConflict');
      const state = activateWindow(row).snapshot(); if (!state.ok) throw new OpenLearnNavigationBudgetFailure(state.error);
      const unknowns = database.prepare(`SELECT key,cost AS costNanodollars,uncertainty_version AS uncertaintyVersion FROM ${namespace(row)}evaluation_reservations WHERE response IS NULL ORDER BY key`).all();
      original.requests += state.value.requests; original.inputTokens += state.value.inputTokens; original.outputTokens += state.value.outputTokens; original.costNanodollars += state.value.costNanodollars;
      original.unknowns.push(...unknowns);
      windows.push({ sequence: row.sequence, approvalId: row.approval_id, approvalJson: row.approval_json, activatedAtMs: row.activated_at_ms, deadlineAtMs: row.deadline_at_ms, halted: row.halted, ledgerHalted: state.value.halted, cancelled: state.value.cancelled, requests: state.value.requests, inputTokens: state.value.inputTokens, outputTokens: state.value.outputTokens, costNanodollars: state.value.costNanodollars, unknowns });
    }
    original.unknowns.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    return { ...original, windows };
  }
  /** @param {Record<string,unknown>} row */
  function retainedOriginal(row) {
    const original = historicalSnapshot(Number(row.sequence));
    if (JSON.stringify(original) !== row.original_snapshot_json) throw new TypeError('OpenLearnNavigationContinuationHistoryConflict');
    return original;
  }
  /** @param {Record<string,unknown>} row */
  function activateWindow(row) {
    const original = retainedOriginal(row);
    const loaded = continuationLedgers.get(Number(row.sequence)); if (loaded) return loaded;
    // A fixed namespace in the SAME SQLite file reuses the ledger's atomic money,
    // token, request, receipt and uncertainty contracts without touching old rows.
    /** @param {string} sql */ const namespaced = sql => sql.replace(/\bevaluation_([a-z_]+)\b/g, `${namespace(row)}evaluation_$1`);
    const scopedDatabase = { exec: /** @param {string} sql */ sql => database.exec(namespaced(sql)), prepare: /** @param {string} sql */ sql => database.prepare(namespaced(sql)), get isTransaction() { return database.isTransaction; } };
    const policy = { ...POLICY, maximumCostNanodollars: POLICY.maximumCostNanodollars - original.costNanodollars, maximumRequests: POLICY.maximumRequests - original.requests, maximumInputTokens: POLICY.maximumInputTokens - original.inputTokens, maximumOutputTokens: POLICY.maximumOutputTokens - original.outputTokens };
    if (Object.values(policy).some(value => value <= 0)) throw new OpenLearnNavigationBudgetFailure({ kind: 'OpenLearnNavigationModelBudgetExceeded' });
    const continuationLedger = createEvaluationLedger({ database: /** @type {import('./evaluation-budget.mjs').LedgerDatabase} */ (scopedDatabase), budgetId: GRANT_ID, policy, now: () => logicalInstant(row), logger });
    continuationLedgers.set(Number(row.sequence), continuationLedger);
    const state = continuationLedger.snapshot(); if (!state.ok) throw new OpenLearnNavigationBudgetFailure(state.error);
    const target = control(row);
    if (row.activated_at_ms === null) database.prepare(`UPDATE ${target.table} SET activated_at_ms=?,deadline_at_ms=? WHERE ${target.key}=? AND activated_at_ms IS NULL`).run(state.value.startedAtMs, state.value.deadlineAtMs, target.value);
    else if (row.activated_at_ms !== state.value.startedAtMs || row.deadline_at_ms !== state.value.deadlineAtMs) throw new TypeError('OpenLearnNavigationContinuationActivationConflict');
    return continuationLedger;
  }
  function activateContinuation() { const row = continuation(); return row ? activateWindow(row) : activate(); }
  for (const row of windowRows()) {
    retainedOriginal(row);
    if (row.activated_at_ms !== null || database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(`${namespace(row)}evaluation_budgets`)) activateWindow(row);
  }

  /** Explicit owner approval keeps the exact unknown reserve; it never settles it.
   * @param {{ownerAuthorized:true,approvalId:string,source:string,priorUnknowns:readonly {key:string,costNanodollars:number,uncertaintyVersion:number}[]}} command */
  function prepareContinuation(command) {
    if (!record(command) || command.ownerAuthorized !== true || typeof command.approvalId !== 'string' || command.approvalId.trim() === '' || typeof command.source !== 'string' || command.source.trim() === '' || !Array.isArray(command.priorUnknowns) || command.priorUnknowns.length !== 1 || !command.priorUnknowns.every(item => record(item) && typeof item.key === 'string' && item.key.trim() !== '' && count(item.costNanodollars) && item.costNanodollars > 0 && count(item.uncertaintyVersion) && item.uncertaintyVersion > 0)) return failure('OpenLearnNavigationContinuationInvalid');
    try {
      const approval = { ownerAuthorized: true, approvalId: command.approvalId, source: command.source, priorUnknowns: command.priorUnknowns.map(item => ({ key: item.key, costNanodollars: item.costNanodollars, uncertaintyVersion: item.uncertaintyVersion })) };
      const rows = windowRows(), repeated = rows.find(row => row.approval_id === approval.approvalId);
      if (repeated) { if (repeated.approval_json !== JSON.stringify(approval)) return failure('OpenLearnNavigationContinuationConflict'); retainedOriginal(repeated); return { ok: /** @type {const} */ (true), value: null }; }
      const existing = rows.at(-1), sequence = rows.length + 1;
      if (existing && (existing.activated_at_ms === null || preparationHistory(existing).some(item => item.end_at_ms === null) || instant() < Number(effectiveDeadline(existing)))) return failure('OpenLearnNavigationContinuationConflict');
      const original = historicalSnapshot(sequence);
      if (!original.grantHalted || !original.ledgerHalted || original.cancelled || !existing && instant() < Number(original.deadlineAtMs) || original.unknowns.length !== 1 || JSON.stringify(original.unknowns) !== JSON.stringify(approval.priorUnknowns)) return failure('OpenLearnNavigationContinuationConflict');
      if ('windows' in original && original.windows.some(row => row.cancelled)) return failure('OpenLearnNavigationContinuationConflict');
      const unknown = database.prepare('SELECT allowance,cost FROM evaluation_reservations WHERE key=? AND response IS NULL').get(approval.priorUnknowns[0].key);
      if (!unknown || !record(JSON.parse(String(unknown.allowance))) || Number(unknown.cost) < Number(JSON.parse(String(unknown.allowance)).costNanodollars)) return failure('OpenLearnNavigationContinuationConflict');
      if (original.costNanodollars >= POLICY.maximumCostNanodollars || original.requests >= POLICY.maximumRequests || original.inputTokens >= POLICY.maximumInputTokens || original.outputTokens >= POLICY.maximumOutputTokens) return failure('OpenLearnNavigationModelBudgetExceeded');
      if (sequence === 1) database.prepare('INSERT INTO openlearn_navigation_continuation(slot,approval_id,approval_json,original_snapshot_json) VALUES(1,?,?,?)').run(approval.approvalId, JSON.stringify(approval), JSON.stringify(original));
      else database.prepare('INSERT INTO openlearn_navigation_renewals(sequence,approval_id,approval_json,original_snapshot_json) VALUES(?,?,?,?)').run(sequence, approval.approvalId, JSON.stringify(approval), JSON.stringify(original));
      return { ok: /** @type {const} */ (true), value: null };
    } catch (_error) { return failure('OpenLearnNavigationContinuationPersistenceFailed'); }
  }

  /** @typedef {{resultPath:string,resultSha256:string,tracePath:string,traceSha256:string}} PreparationProof */
  /** @typedef {{approvalId:string,startAtMs:number,source:string,proof:PreparationProof}} PreparationPause */
  /** @param {unknown} command @returns {command is PreparationPause} */
  function preparationCommandValid(command) {
    return record(command) && typeof command.approvalId === 'string' && count(command.startAtMs) && typeof command.source === 'string' && command.source.trim() !== '' && record(command.proof) && ['resultPath', 'tracePath'].every(key => typeof command.proof[key] === 'string' && command.proof[key].trim() !== '') && ['resultSha256', 'traceSha256'].every(key => typeof command.proof[key] === 'string' && /^[a-f0-9]{64}$/.test(command.proof[key]));
  }
  /** @param {Record<string,unknown>} row */
  function preparationAllowed(row) {
    if (Number(row.sequence) < 2 || row.activated_at_ms === null || row.halted) return false;
    retainedOriginal(row);
    const state = activateWindow(row).snapshot();
    return state.ok && !state.value.cancelled && !state.value.admissionHalted && state.value.unresolvedRequests === 0;
  }
  /** Verify immutable cleanup evidence and reconstruct older physical transport
   * spans from provider success/failure events. Receipt observation alone never
   * establishes a request's start. New requests have a separate physical journal.
   * @param {PreparationPause} command @param {Record<string,unknown>} row @param {number} end */
  function verifyPreparationProof(command, row, end) {
    const bytes = readFileSync(command.proof.resultPath), traceBytes = readFileSync(command.proof.tracePath);
    if (createHash('sha256').update(bytes).digest('hex') !== command.proof.resultSha256 || createHash('sha256').update(traceBytes).digest('hex') !== command.proof.traceSha256) return false;
    const result = JSON.parse(bytes.toString('utf8'));
    if (!record(result) || Date.parse(String(result.recordedAt)) !== command.startAtMs || !record(result.cleanup) || result.cleanup.ok !== true || !record(result.accounting) || result.accounting.activeModelRequests !== 0 || !record(result.accounting.continuation) || result.accounting.continuation.approvalId !== command.approvalId) return false;
    const events = traceBytes.toString('utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
    const successes = new Map();
    for (const event of events) {
      if (!record(event)) return false;
      const at = Date.parse(String(event.at)); if (!count(at)) return false;
      if (event.event === 'knowledge-model-success' || event.event === 'knowledge-model-failure') {
        if (!count(event.durationMs) || event.durationMs > at) return false;
        if (at - event.durationMs < end && at > command.startAtMs) return false;
        if (event.event === 'knowledge-model-success' && generationId(event.requestId)) successes.set(event.requestId, event);
      }
      if (event.event === 'knowledge-model-entry' && at >= command.startAtMs && at < end) return false;
    }
    if (database.prepare('SELECT 1 FROM openlearn_browser_reservations WHERE created_at_ms>=? AND created_at_ms<? LIMIT 1').get(command.startAtMs, end)) return false;
    const dispatches = database.prepare('SELECT d.*,o.physical_ended_at_ms FROM openlearn_model_dispatches d LEFT JOIN openlearn_model_dispatch_outcomes o USING(reservation_key) WHERE d.approval_id=?').all(String(row.approval_id));
    if (dispatches.some(item => item.physical_ended_at_ms === null || Number(item.physical_started_at_ms) < end && Number(item.physical_ended_at_ms) > command.startAtMs || Number(item.physical_started_at_ms) >= command.startAtMs && Number(item.physical_started_at_ms) < end)) return false;
    const journaled = new Set(dispatches.map(item => item.reservation_key));
    const legacy = database.prepare(`SELECT key,response FROM ${namespace(row)}evaluation_reservations`).all();
    // A legacy receipt without a matching duration-bearing trace is insufficient
    // evidence; never fabricate a historical dispatch timestamp.
    for (const reservation of legacy) {
      if (journaled.has(reservation.key)) continue;
      if (reservation.response === null) return false;
      const receipt = JSON.parse(String(reservation.response));
      if (!record(receipt) || !generationId(receipt.id) || !successes.has(receipt.id)) return false;
    }
    return true;
  }
  /** @param {PreparationPause & {endAtMs:number}} command */
  function recordOfflinePreparationInterval(command) {
    if (!preparationCommandValid(command) || !count(command.endAtMs) || command.endAtMs <= command.startAtMs) return failure('OpenLearnNavigationPreparationInvalid');
    try {
      const row = continuation();
      if (!row || row.approval_id !== command.approvalId || !preparationAllowed(row) || command.endAtMs > instant()) return failure('OpenLearnNavigationPreparationConflict');
      const id = `${command.approvalId}:${command.startAtMs}:${command.endAtMs}`, proof = JSON.stringify(command.proof);
      const existing = database.prepare('SELECT * FROM openlearn_offline_intervals WHERE interval_id=?').get(id);
      if (existing) return existing.source === command.source && existing.proof_json === proof ? { ok: /** @type {const} */ (true), value: null } : failure('OpenLearnNavigationPreparationConflict');
      if (command.startAtMs < Number(row.activated_at_ms) || logicalInstant(row, command.startAtMs) >= Number(row.deadline_at_ms) || preparationHistory(row).some(item => item.end_at_ms === null || command.startAtMs < Number(item.end_at_ms) && command.endAtMs > Number(item.start_at_ms)) || !verifyPreparationProof(command, row, command.endAtMs)) return failure('OpenLearnNavigationPreparationProofRejected');
      database.prepare('INSERT INTO openlearn_offline_intervals VALUES(?,?,?,?,?,?)').run(id, command.approvalId, command.startAtMs, command.endAtMs, command.source, proof);
      return { ok: /** @type {const} */ (true), value: null };
    } catch (_error) { return failure('OpenLearnNavigationPreparationProofRejected'); }
  }
  /** @param {PreparationPause} command */
  function pauseForPreparation(command) {
    if (!preparationCommandValid(command)) return failure('OpenLearnNavigationPreparationInvalid');
    try {
      const row = continuation();
      if (!row || row.approval_id !== command.approvalId || !preparationAllowed(row) || command.startAtMs > instant()) return failure('OpenLearnNavigationPreparationConflict');
      const id = `${command.approvalId}:${command.startAtMs}`, proof = JSON.stringify(command.proof);
      const existing = database.prepare('SELECT * FROM openlearn_preparation_pauses WHERE pause_id=?').get(id);
      if (existing) return existing.source === command.source && existing.proof_json === proof ? { ok: /** @type {const} */ (true), value: null } : failure('OpenLearnNavigationPreparationConflict');
      if (command.startAtMs < Number(row.activated_at_ms) || logicalInstant(row, command.startAtMs) >= Number(row.deadline_at_ms) || preparationHistory(row).some(item => item.end_at_ms === null || Number(item.end_at_ms) > command.startAtMs) || !verifyPreparationProof(command, row, instant())) return failure('OpenLearnNavigationPreparationProofRejected');
      database.prepare('INSERT INTO openlearn_preparation_pauses VALUES(?,?,?,?,?)').run(id, command.approvalId, command.startAtMs, command.source, proof);
      return { ok: /** @type {const} */ (true), value: null };
    } catch (_error) { return failure('OpenLearnNavigationPreparationProofRejected'); }
  }
  /** Paid dispatch auto-closes an acknowledged cleanup pause; optional explicit
   * resume can only end it at the actual current physical instant.
   * @param {{endAtMs?:number}} [command] */
  function resumeFromPreparation(command = {}) {
    try {
      const row = continuation(), at = instant();
      if (command.endAtMs !== undefined && command.endAtMs !== at) return failure('OpenLearnNavigationPreparationInvalid');
      if (!row) return { ok: /** @type {const} */ (true), value: null };
      const paused = preparationHistory(row).filter(item => item.end_at_ms === null);
      if (!paused.length) return { ok: /** @type {const} */ (true), value: null };
      if (paused.length !== 1 || !preparationAllowed(row)) return failure('OpenLearnNavigationPreparationConflict');
      const pause = paused[0];
      const proof = /** @type {PreparationProof} */ (JSON.parse(String(pause.proof_json)));
      if (at < Number(pause.start_at_ms) || !verifyPreparationProof({ approvalId: String(row.approval_id), startAtMs: Number(pause.start_at_ms), source: String(pause.source), proof }, row, at)) return failure('OpenLearnNavigationPreparationProofRejected');
      database.prepare('INSERT INTO openlearn_preparation_resumes VALUES(?,?)').run(String(pause.pause_id), at);
      return { ok: /** @type {const} */ (true), value: null };
    } catch (_error) { return failure('OpenLearnNavigationPreparationProofRejected'); }
  }

  function snapshot() {
    if (closed) return failure('OpenLearnNavigationBudgetClosed');
    const row = grant();
    const browser = database.prepare('SELECT COUNT(*) AS sessions,COALESCE(SUM(credits),0) AS credits FROM openlearn_browser_reservations').get();
    if (!browser) throw new TypeError('OpenLearnNavigationBrowserLedgerInvalid');
    const state = ledger?.snapshot(); if (state && !state.ok) return state;
    const rows = windowRows(), window = rows.at(-1) ?? null;
    const totals = { requests: state?.ok ? state.value.requests : 0, costNanodollars: state?.ok ? state.value.costNanodollars : 0, unresolvedRequests: state?.ok ? state.value.unresolvedRequests : 0 };
    let currentUnresolved = 0, currentHalted = null;
    const continuationHistory = [];
    for (const candidate of rows) {
      retainedOriginal(candidate);
      const continued = continuationLedgers.get(Number(candidate.sequence))?.snapshot(); if (continued && !continued.ok) return continued;
      if (continued?.ok) { totals.requests += continued.value.requests; totals.costNanodollars += continued.value.costNanodollars; totals.unresolvedRequests += continued.value.unresolvedRequests; }
      if (candidate.sequence === window?.sequence) { currentUnresolved = continued?.ok ? continued.value.unresolvedRequests : 0; currentHalted = candidate.halted ?? (continued?.ok ? continued.value.admissionHalted : null); }
      continuationHistory.push({ sequence: candidate.sequence, approvalId: candidate.approval_id, activatedAtMs: candidate.activated_at_ms, deadlineAtMs: candidate.deadline_at_ms, halted: candidate.halted ?? (continued?.ok ? continued.value.admissionHalted : null), approval: JSON.parse(String(candidate.approval_json)) });
    }
    const originalHalted = row.halted ?? (state?.ok ? state.value.admissionHalted : null);
    const preparation = window ? preparationHistory(window) : [];
    const preparationIntervals = preparation.map(item => ({ startAtMs: Number(item.start_at_ms), endAtMs: item.end_at_ms === null ? null : Number(item.end_at_ms), source: item.source, proof: JSON.parse(String(item.proof_json)), pauseId: item.pause_id }));
    return { ok: /** @type {const} */ (true), value: { grant: OWNER_CONTRACT, metadata, activatedAtMs: row.activated_at_ms, deadlineAtMs: row.deadline_at_ms, originalHalted, effectiveActivatedAtMs: window ? window.activated_at_ms : row.activated_at_ms, effectiveDeadlineAtMs: window ? effectiveDeadline(window) : row.deadline_at_ms, excludedOfflineMilliseconds: offlineOffset(window, instant()), preparationPaused: preparation.some(item => item.end_at_ms === null), preparationIntervals, continuation: continuationHistory.at(-1) ?? null, continuationHistory, halted: window ? currentHalted : originalHalted, modelRequests: totals.requests, modelCostNanodollars: totals.costNanodollars, unresolvedModelRequests: totals.unresolvedRequests, activeModelRequests: window ? currentUnresolved : state?.ok ? state.value.unresolvedRequests : 0, reservedBrowserCredits: Number(browser.credits), browserSessions: Number(browser.sessions) } };
  }
  function admissible() {
    const state = snapshot(); if (!state.ok) return state;
    if (state.value.halted) return failure('OpenLearnNavigationAccountingHalted');
    if (state.value.activeModelRequests) return failure('OpenLearnNavigationModelReceiptUnresolved');
    if (state.value.effectiveDeadlineAtMs !== null && instant() >= Number(state.value.effectiveDeadlineAtMs)) return failure('OpenLearnNavigationDeadlineExceeded');
    if (state.value.modelCostNanodollars >= POLICY.maximumCostNanodollars) return failure('OpenLearnNavigationModelBudgetExceeded');
    if (state.value.reservedBrowserCredits >= OWNER_CONTRACT.browserCreditLimit) return failure('BrowserCreditLimitExceeded');
    return state;
  }
  /** @param {string} kind */
  function halt(kind) { const row = continuation(); if (row) { const target = control(row); database.prepare(`UPDATE ${target.table} SET halted=COALESCE(halted,?) WHERE ${target.key}=?`).run(kind, target.value); } else database.prepare('UPDATE openlearn_navigation_grant SET halted=COALESCE(halted,?) WHERE grant_id=?').run(kind, GRANT_ID); logger({ event: 'openlearn-navigation-accounting-halted', failureKind: kind }); }
  /** @param {{credits:number,ttlSeconds:number}} command */
  async function reserveBrowserSession(command) {
    if (!count(command?.credits) || command.credits === 0 || !count(command.ttlSeconds) || command.ttlSeconds === 0 || command.credits !== 2 * Math.ceil(command.ttlSeconds / 60)) return failure('BrowserCreditBudgetCommandInvalid');
    try {
      const state = admissible(); if (!state.ok) return state;
      if (state.value.reservedBrowserCredits + command.credits > OWNER_CONTRACT.browserCreditLimit) return failure('BrowserCreditLimitExceeded');
      const resumed = resumeFromPreparation(); if (!resumed.ok) return resumed;
      activateContinuation();
      const row = continuation();
      const budgetTable = row ? `${namespace(row)}evaluation_budgets` : 'evaluation_budgets';
      const reservationTable = row ? `${namespace(row)}evaluation_reservations` : 'evaluation_reservations';
      const target = row ? control(row) : { table: 'openlearn_navigation_grant', key: 'grant_id', value: GRANT_ID };
      const costs = ['evaluation_reservations', ...windowRows().filter(candidate => candidate.activated_at_ms !== null).map(candidate => `${namespace(candidate)}evaluation_reservations`)];
      const totalCost = costs.map(table => `(SELECT COALESCE(SUM(cost),0) FROM ${table})`).join('+');
      const result = database.prepare(`INSERT INTO openlearn_browser_reservations(reservation_id,credits,ttl_seconds,created_at_ms) SELECT ?,?,?,?
        WHERE (SELECT COALESCE(SUM(credits),0) FROM openlearn_browser_reservations)<=100-?
        AND NOT EXISTS(SELECT 1 FROM ${target.table} WHERE ${target.key}=? AND halted IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM ${budgetTable} WHERE halted IS NOT NULL OR cancelled=1 OR deadline<=?)
        AND ${totalCost}<1000000000
        AND NOT EXISTS(SELECT 1 FROM ${reservationTable} WHERE response IS NULL)`)
        .run(randomUUID(), command.credits, command.ttlSeconds, instant(), command.credits, target.value, logicalInstant(row));
      if (result.changes !== 1) return failure('BrowserCreditLimitExceeded');
      return { ok: /** @type {const} */ (true), value: null };
    } catch (_error) { return failure('BrowserCreditBudgetPersistenceFailed'); }
  }
  /** @type {typeof fetch} */
  const modelFetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== ENDPOINT || init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') throw new OpenLearnNavigationBudgetFailure({ kind: 'OpenLearnNavigationModelRequestInvalid' });
    let body; try { body = JSON.parse(init.body); } catch (_error) { throw new OpenLearnNavigationBudgetFailure({ kind: 'OpenLearnNavigationModelRequestInvalid' }); }
    if (!record(body) || body.model !== MODEL || body.stream !== false || !count(body.max_tokens) || body.max_tokens === 0 || body.max_tokens > metadata.contextLength || !Array.isArray(body.messages) || !record(body.reasoning) || body.reasoning.effort !== 'high' || !record(body.provider) || body.provider.require_parameters !== true || body.provider.allow_fallbacks !== true || body.provider.sort !== 'throughput' || !record(body.provider.max_price) || body.provider.max_price.prompt !== metadata.promptUSDPerMillion || body.provider.max_price.completion !== metadata.completionUSDPerMillion || body.provider.max_price.request !== 0 || body.provider.max_price.image !== 0) throw new OpenLearnNavigationBudgetFailure({ kind: 'OpenLearnNavigationModelProtocolInvalid' });
    const state = admissible(); if (!state.ok) throw new OpenLearnNavigationBudgetFailure(state.error);
    const costNanodollars = navigationReservationNanodollars({ inputTokens: metadata.contextLength, outputTokens: body.max_tokens, promptUSDPerMillion: metadata.promptUSDPerMillion, completionUSDPerMillion: metadata.completionUSDPerMillion });
    if (costNanodollars === null || state.value.modelCostNanodollars + costNanodollars > POLICY.maximumCostNanodollars) throw new OpenLearnNavigationBudgetFailure({ kind: 'OpenLearnNavigationModelBudgetExceeded' });
    const resumed = resumeFromPreparation(); if (!resumed.ok) throw new OpenLearnNavigationBudgetFailure(resumed.error);
    const active = activateContinuation(), key = randomUUID();
    const reserved = active.reserve({ key, inputTokens: metadata.contextLength, outputTokens: body.max_tokens, costNanodollars });
    if (!reserved.ok) throw new OpenLearnNavigationBudgetFailure(reserved.error);
    const row = continuation();
    database.prepare('INSERT INTO openlearn_model_dispatches VALUES(?,?,?)').run(key, row ? String(row.approval_id) : null, instant());
    const remaining = Math.max(1, reserved.value.deadlineAtMs - logicalInstant(row));
    const timer = AbortSignal.timeout(remaining), signal = init.signal ? AbortSignal.any([init.signal, timer]) : timer;
    /** @type {{inputTokens?:number,outputTokens?:number,costNanodollars?:number}} */ const observed = {};
    /** @type {string|undefined} */ let observedGenerationId;
    /** @param {unknown} id */
    function preserveGenerationId(id) {
      if (!generationId(id)) return;
      if (observedGenerationId !== undefined && observedGenerationId !== id) throw new OpenLearnNavigationBudgetFailure({ kind: 'OpenLearnNavigationGenerationIdConflict' });
      database.prepare('INSERT OR IGNORE INTO openlearn_model_generation_ids(reservation_key,generation_id,observed_at_ms) VALUES(?,?,?)').run(key, id, instant());
      observedGenerationId = id;
    }
    try {
      const response = await transport(input, { ...init, signal });
      // Persist the safe billing ID as soon as headers arrive, before any body read.
      preserveGenerationId(response.headers.get('x-generation-id'));
      const copy = response.clone(), reader = copy.body?.getReader();
      let responseText = '';
      if (reader) {
        const decoder = new TextDecoder();
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            responseText += decoder.decode(chunk.value, { stream: true });
            // Only an anchored first top-level provider field is read from an
            // unfinished JSON document; never search assistant/prompt strings.
            const prefixId = /^\s*\{\s*"id"\s*:\s*"(gen-[0-9A-Za-z-]{1,124})"\s*(?:[,}]|$)/.exec(responseText);
            if (prefixId) preserveGenerationId(prefixId[1]);
          }
          responseText += decoder.decode();
        } finally { reader.releaseLock(); }
      } else responseText = await copy.text();
      const document = JSON.parse(responseText);
      if (record(document)) preserveGenerationId(document.id);
      if (record(document) && record(document.usage)) {
        if (count(document.usage.prompt_tokens)) observed.inputTokens = document.usage.prompt_tokens;
        if (count(document.usage.completion_tokens)) observed.outputTokens = document.usage.completion_tokens;
        const knownCost = typeof document.usage.cost === 'number' ? receiptNanodollars(document.usage.cost) : null;
        if (knownCost !== null) observed.costNanodollars = knownCost;
      }
      if (!response.ok || !record(document) || document.error !== undefined || typeof document.model !== 'string' || document.model !== MODEL && document.model !== metadata.canonicalSlug || !record(document.usage) || !count(document.usage.prompt_tokens) || !count(document.usage.completion_tokens) || typeof document.usage.cost !== 'number') throw new OpenLearnNavigationBudgetFailure({ kind: 'OpenLearnNavigationModelReceiptUnresolved' });
      const usageCost = receiptNanodollars(document.usage.cost);
      if (usageCost === null) throw new OpenLearnNavigationBudgetFailure({ kind: 'OpenLearnNavigationModelReceiptUnresolved' });
      const receipt = { httpStatus: response.status, ...(observedGenerationId === undefined ? {} : { id: observedGenerationId }), model: document.model, usage: { prompt_tokens: document.usage.prompt_tokens, completion_tokens: document.usage.completion_tokens, cost: document.usage.cost } };
      const completed = active.complete({ key, inputTokens: document.usage.prompt_tokens, outputTokens: document.usage.completion_tokens, costNanodollars: usageCost, response: receipt });
      if (!completed.ok) { halt(completed.error.kind); throw new OpenLearnNavigationBudgetFailure(completed.error); }
      database.prepare('INSERT INTO openlearn_model_dispatch_outcomes VALUES(?,?)').run(key, instant());
      return response;
    } catch (error) {
      const kind = error instanceof OpenLearnNavigationBudgetFailure ? error.kind : 'OpenLearnNavigationModelTransportUncertain';
      active.uncertain({ key, kind: 'EvaluationTransportUncertain', ...observed });
      database.prepare('INSERT OR IGNORE INTO openlearn_model_dispatch_outcomes VALUES(?,?)').run(key, instant());
      halt(kind);
      throw error instanceof OpenLearnNavigationBudgetFailure ? error : new OpenLearnNavigationBudgetFailure({ kind });
    }
  };
  return Object.freeze({ modelFetch, reserveBrowserSession, reserveSession: reserveBrowserSession, prepareContinuation, recordOfflinePreparationInterval, pauseForPreparation, resumeFromPreparation, snapshot, halt, close() { if (!closed) { database.close(); closed = true; } } });
}
