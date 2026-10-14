import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createEvaluationLedger,validateEvaluationCatalog} from './evaluation-budget.mjs';
import {AgentExecutionBoundaryFailure} from '../src/features/knowledge-workflows/harness.js';
import {parseRetryAfter,errorTypes} from './evaluation-provider-diagnostics.mjs';

const endpoint='https://openrouter.ai/api/v1/chat/completions';
const hash=value=>createHash('sha256').update(value).digest('hex');
const requireResult=result=>{if(!result.ok)throw new Error(result.error.kind);return result.value;};
const count=value=>Number.isSafeInteger(value)&&value>=0;
export const PIPELINE_MODELS=['z-ai/glm-5.3-flash','mistralai/mistral-large-4-0'];
export const MIMO_EVALUATOR_MODEL='xiaomi/mimo-v2.6-pro';
// Catalog prices can contain sub-nanodollar token rates (GLM26.1nanodollars).
// Round only the reservation/routing ceiling upward; preserve raw catalog bytes.
export function priceCeilingNanodollars(value){
 if(typeof value!=='string'||value.length>64||!/^\d+(?:\.\d+)?$/.test(value))throw new Error('PipelinePricingInvalid');
 const [whole,fraction='']=value.split('.'),digits=BigInt(whole+fraction),scale=fraction.length-9;
 const result=scale>0?(digits+10n**BigInt(scale)-1n)/10n**BigInt(scale):digits*10n**BigInt(-scale);
 if(result>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('PipelinePricingInvalid');return Number(result);
}
function validateBillingCatalog(catalog){
 const pricing=catalog?.model?.pricing;if(!pricing)throw new Error('PipelineCatalogInvalid');
 const normalized={...catalog,model:{...catalog.model,pricing:{...pricing,prompt:(priceCeilingNanodollars(pricing.prompt)/1000000000).toFixed(9),completion:(priceCeilingNanodollars(pricing.completion)/1000000000).toFixed(9)}}};
 requireResult(validateEvaluationCatalog(normalized,catalog.model.id));return normalized;
}

// Historical grant is read only. Its unknown reservations remain charged.
export function readNavigationAccounting(storePath){
 const db=new DatabaseSync(storePath,{readOnly:true});
 try{
  const tables=['evaluation_reservations','openlearn_continuation_evaluation_reservations','openlearn_continuation_2_evaluation_reservations'];
  const rows=tables.flatMap(table=>db.prepare(`SELECT key,cost,response IS NULL AS unresolved,uncertainty_version FROM ${table} ORDER BY key`).all().map(row=>({table,...row})));
  const browser=db.prepare('SELECT reservation_id,credits,ttl_seconds,created_at_ms FROM openlearn_browser_reservations ORDER BY created_at_ms,reservation_id').all();
  const modelCostNanodollars=rows.reduce((sum,row)=>sum+row.cost,0),reservedBrowserCredits=browser.reduce((sum,row)=>sum+row.credits,0);
  if(!count(modelCostNanodollars)||!count(reservedBrowserCredits)||rows.some(row=>!count(row.cost)))throw new Error('PipelinePriorAccountingInvalid');
  return {modelCostNanodollars,reservedBrowserCredits,modelRequests:rows.length,unresolvedRequests:rows.filter(row=>row.unresolved).length,fingerprint:hash(JSON.stringify({rows,browser}))};
 }finally{db.close();}
}

export function pipelineProtocol(catalog,role,automaticReviewerRouting=false,evaluatorModel=PIPELINE_MODELS[1],unrestrictedProviderPricing=false){
 validateBillingCatalog(catalog);
 if(![PIPELINE_MODELS[1],MIMO_EVALUATOR_MODEL].includes(evaluatorModel))throw new Error('PipelineEvaluatorModelUnauthorized');
 const evaluator=role==='question-evaluator',expected=evaluator?evaluatorModel:PIPELINE_MODELS[0];
 if(catalog.model.id!==expected)throw new Error('PipelineRoleModelMismatch');
 return {source:'Owner authorized isolated OpenLearn six-capture configured-model pipeline',responseFormat:catalog.model.id===MIMO_EVALUATOR_MODEL?'json_schema':'json_object',reasoningEffort:evaluator?'none':'high',provider:{...(unrestrictedProviderPricing||evaluator&&automaticReviewerRouting?{}:{sort:'throughput'}),require_parameters:true,allow_fallbacks:true,...(unrestrictedProviderPricing?{}:{max_price:{prompt:priceCeilingNanodollars(catalog.model.pricing.prompt)/1000,completion:priceCeilingNanodollars(catalog.model.pricing.completion)/1000,request:0,image:0}})},receiptOptional:true};
}

// Starts the new finite clock at first admitted model call, never at preparation.
// No browser sessions are created here; retained96 reservations stay unchanged.
export function createOpenLearnPipelineBudget({storePath,priorStorePath,priorAccounting,catalogs,ownerCostAssumption,failedReviewCostPolicy,ownerContinuation,ownerRecovery,ownerExecutionOverride,automaticReviewerRouting=false,evaluatorModel=PIPELINE_MODELS[1],now=Date.now,fetch:transport=globalThis.fetch,logger=()=>{},onResponse=()=>{}}){
 if(![PIPELINE_MODELS[1],MIMO_EVALUATOR_MODEL].includes(evaluatorModel))throw new Error('PipelineEvaluatorModelUnauthorized');
 const activeModels=[PIPELINE_MODELS[0],evaluatorModel],requiredModels=[...new Set([...PIPELINE_MODELS,evaluatorModel])];
 if(!catalogs||requiredModels.some(model=>!catalogs[model]||catalogs[model].model?.id!==model))throw new Error('PipelineCatalogInvalid');for(const model of requiredModels)validateBillingCatalog(catalogs[model]);
 const db=new DatabaseSync(storePath);let ledger=null,recoveryLedger=null,closed=false,boundStage=null;
 const namespaceDatabase=prefix=>{
  const nested=[];const rewrite=sql=>prefix?sql.replace(/\bevaluation_(budgets|reservations)\b/g,prefix+'_evaluation_$1').replace(/\bevaluation_(?=[a-z_]+(?: BEFORE| ON| AFTER))/g,prefix+'_evaluation_'):sql;
  return {exec:sql=>{const rewritten=rewrite(sql);if(rewritten==='BEGIN IMMEDIATE'){const outer=db.isTransaction;nested.push(outer);if(outer)return;}else if(['COMMIT','ROLLBACK'].includes(rewritten)&&nested.pop())return;return db.exec(rewritten);},prepare:sql=>db.prepare(rewrite(sql)),get isTransaction(){return db.isTransaction;}};
 };
 const originalDatabase=namespaceDatabase('');

 db.exec(`CREATE TABLE IF NOT EXISTS pipeline_dispatches(key TEXT PRIMARY KEY,start_at_ms INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS pipeline_outcomes(key TEXT PRIMARY KEY,end_at_ms INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS pipeline_preparation_pauses(id TEXT PRIMARY KEY,start_at_ms INTEGER NOT NULL,proof_json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS pipeline_preparation_resumes(id TEXT PRIMARY KEY,end_at_ms INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS pipeline_model_failure_diagnostics(key TEXT PRIMARY KEY,recorded_at_ms INTEGER NOT NULL,diagnostic_json TEXT NOT NULL);`);
 for(const table of ['pipeline_dispatches','pipeline_outcomes','pipeline_preparation_pauses','pipeline_preparation_resumes','pipeline_model_failure_diagnostics'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;`);
 const phases=()=>db.prepare('SELECT p.*,r.end_at_ms FROM pipeline_preparation_pauses p LEFT JOIN pipeline_preparation_resumes r USING(id) ORDER BY p.start_at_ms').all();
 const logicalNow=()=>{const current=now();return current-phases().reduce((sum,p)=>sum+Math.max(0,(p.end_at_ms??current)-p.start_at_ms),0);};
 const policy={maximumRequests:1200,maximumInputTokens:3000000,maximumOutputTokens:3000000,maximumMilliseconds:1800000,maximumCostNanodollars:1000000000-priorAccounting.modelCostNanodollars};
 if(!count(policy.maximumCostNanodollars)||policy.maximumCostNanodollars===0||priorAccounting.reservedBrowserCredits>100)throw new Error('PipelinePriorBudgetExhausted');
 const verifyPrior=()=>{const actual=readNavigationAccounting(priorStorePath);if(JSON.stringify(actual)!==JSON.stringify(priorAccounting))throw new Error('PipelinePriorAccountingChanged');};
 const getLedger=()=>ledger??(ledger=createEvaluationLedger({database:originalDatabase,budgetId:'openlearn-six-capture-owner-window-1',policy,now:logicalNow,logger}));
 const existing=()=>db.prepare("SELECT name FROM sqlite_master WHERE name='evaluation_budgets'").get()&&db.prepare('SELECT budget_id FROM evaluation_budgets LIMIT 1').get();
 const recoveryDatabase=namespaceDatabase('pipeline_recovery');
 const assumption=()=>db.prepare("SELECT name FROM sqlite_master WHERE name='pipeline_owner_cost_assumptions'").get()?db.prepare('SELECT * FROM pipeline_owner_cost_assumptions WHERE singleton=1').get():null;
 const originalRowsHash=()=>hash(JSON.stringify({budgets:db.prepare('SELECT * FROM evaluation_budgets ORDER BY budget_id').all(),reservations:db.prepare('SELECT * FROM evaluation_reservations ORDER BY key').all()}));
 const openRecovery=()=>{
  const journal=assumption();if(!journal)return null;
  const original=requireResult(getLedger().snapshot());
  if(hash(JSON.stringify(original))!==journal.original_snapshot_sha256||originalRowsHash()!==journal.original_rows_sha256)throw new Error('PipelineCostAssumptionHistoryChanged');
  if(ownerCostAssumption&&ownerCostAssumption.sha256!==journal.authorization_sha256)throw new Error('PipelineCostAssumptionConflict');
  return recoveryLedger??(recoveryLedger=createEvaluationLedger({database:recoveryDatabase,budgetId:'openlearn-six-capture-same-window-recovery-1',policy:JSON.parse(journal.remaining_policy_json),now:logicalNow,logger}));
 };
 function baseState(){
  const original=requireResult(getLedger().snapshot()),recovery=openRecovery();if(!recovery)return original;
  const active=requireResult(recovery.snapshot()),journal=assumption();
  return {...active,startedAtMs:original.startedAtMs,deadlineAtMs:original.deadlineAtMs,requests:original.requests+active.requests,inputTokens:original.inputTokens+active.inputTokens,outputTokens:original.outputTokens+active.outputTokens,costNanodollars:original.costNanodollars-journal.original_reservation_nanodollars+active.costNanodollars};
 }

 // The standing owner assumption never manufactures provider receipts or edits
 // old grants. Each new attempt uses the established configured ledger with a
 // single-request grant, retaining the original clock. Global admission below
 // retains the original1200-attempt limit and cumulative money ceiling. Token
 // headroom follows those finite attempts and validated catalog context bounds.
 const standing=()=>db.prepare("SELECT name FROM sqlite_master WHERE name='pipeline_failed_review_policy'").get()?db.prepare('SELECT * FROM pipeline_failed_review_policy').get():null;
 const baseRowsHash=()=>hash(JSON.stringify({original:originalRowsHash(),recoveryBudgets:db.prepare('SELECT * FROM pipeline_recovery_evaluation_budgets ORDER BY budget_id').all(),recoveryReservations:db.prepare('SELECT * FROM pipeline_recovery_evaluation_reservations ORDER BY key').all()}));
 const attempts=()=>standing()?db.prepare('SELECT * FROM pipeline_review_policy_attempts ORDER BY sequence').all():[];
 const waivers=()=>standing()?db.prepare('SELECT * FROM pipeline_failed_review_assumptions ORDER BY recorded_at_ms,key').all():[];
 const stageIdentity=value=>{
  if(!value||!['ownerId','runId','stageKey','inputDigest','createdAt'].every(k=>typeof value[k]==='string'&&value[k].length>0)||!Number.isFinite(Date.parse(value.createdAt)))throw Error('PipelineReviewStageIdentityInvalid');
  return Object.fromEntries(['ownerId','runId','stageKey','inputDigest','createdAt'].map(k=>[k,value[k]]));
 };
 const namespace=sequence=>`pipeline_review_attempt_${sequence}`;

 const attemptLedger=row=>createEvaluationLedger({database:namespaceDatabase(namespace(row.sequence)),budgetId:row.budget_id,policy:JSON.parse(row.policy_json),now:logicalNow,logger});
 const attemptRows=()=>attempts().map(a=>({attempt:a,row:db.prepare(`SELECT * FROM ${namespace(a.sequence)}_evaluation_reservations`).get()}));
 const continuation=()=>db.prepare("SELECT name FROM sqlite_master WHERE name='pipeline_owner_continuations'").get()?db.prepare('SELECT * FROM pipeline_owner_continuations').get():null;
 const recoveries=()=>db.prepare("SELECT name FROM sqlite_master WHERE name='pipeline_owner_full_reserve_recoveries'").get()?db.prepare('SELECT * FROM pipeline_owner_full_reserve_recoveries ORDER BY sequence').all():[];
 const executionOverride=()=>db.prepare("SELECT name FROM sqlite_master WHERE name='pipeline_owner_execution_overrides'").get()?db.prepare('SELECT * FROM pipeline_owner_execution_overrides').get():null;
 const usageRows=()=>executionOverride()?db.prepare('SELECT c.*,r.receipt_json,r.input_tokens,r.output_tokens,r.cost AS settled_cost,f.known_usage FROM pipeline_actual_usage_calls c LEFT JOIN pipeline_actual_usage_receipts r USING(key) LEFT JOIN pipeline_actual_usage_failures f USING(key) ORDER BY c.created_at_ms,c.key').all():[];
 const usageCost=row=>row.receipt_json!==null?row.settled_cost:Math.max(row.estimated_cost,JSON.parse(row.known_usage??'{}').costNanodollars??0);
 const currentCostLimit=()=>{const latest=recoveries().at(-1);return latest?JSON.parse(latest.authorization_json).cumulativeModelCostLimitNanodollars:1000000000;};
 const recoveryActivation=journal=>db.prepare("SELECT name FROM sqlite_master WHERE name='pipeline_owner_recovery_activations'").get()?(db.prepare('SELECT * FROM pipeline_owner_recovery_activations WHERE authorization_sha256=?').get(journal.authorization_sha256)??null):null;
 const continuationActivation=()=>continuation()?(db.prepare('SELECT * FROM pipeline_owner_continuation_activations').get()??null):null;
 const continuationProof=journal=>{const authority=JSON.parse(journal.authorization_json);return {reservationKey:authority.reservationKey,authorizationSha256:journal.authorization_sha256,attemptKey:hash(JSON.stringify({authorizationSha256:journal.authorization_sha256,identity:authority.identity})),identitySha256:hash(JSON.stringify(authority.identity)),identity:authority.identity,maximumAdditionalAttempts:1,retainedReservationNanodollars:authority.retainedReservationNanodollars,costEvidence:'owner-authorized full reserve retained; provider billed cost remains unknown'};};
 function verifyClosureHistory(journal,rows){
  const original=rows.find(v=>v.attempt.sequence===journal.sequence),budget=original&&db.prepare(`SELECT * FROM ${namespace(journal.sequence)}_evaluation_budgets`).get();
  if(!original?.row||hash(JSON.stringify(original.row))!==journal.row_sha256||hash(JSON.stringify(original.attempt))!==journal.attempt_sha256||hash(JSON.stringify(budget))!==journal.budget_sha256)throw Error('PipelineContinuationHistoryChanged');
  return journal;
 }
 function verifiedContinuation(rows){const journal=continuation();return journal?verifyClosureHistory(journal,rows):null;}
 const verifiedRecoveries=rows=>recoveries().map(journal=>verifyClosureHistory(journal,rows));
 const effectiveDeadline=state=>state.effectiveDeadlineAtMs??state.deadlineAtMs;
 function currentState(){
  const base=baseState(),journal=standing();if(!journal)return base;
  if(journal.base_rows_sha256!==baseRowsHash())throw Error('PipelineReviewPolicyHistoryChanged');
  const waived=waivers(),rows=attemptRows();
  for(const w of waived){const row=w.sequence===0?db.prepare('SELECT * FROM pipeline_recovery_evaluation_reservations WHERE key=?').get(w.key):rows.find(v=>v.attempt.sequence===w.sequence)?.row;if(!row||hash(JSON.stringify(row))!==w.row_sha256)throw Error('PipelineReviewPolicyHistoryChanged');}
  const closed=verifiedContinuation(rows),recovered=verifiedRecoveries(rows),closedKeys=[...(closed?[closed]:[]),...recovered].map(j=>JSON.parse(j.authorization_json).reservationKey);
  const added=rows.filter(v=>v.row),unknown=added.filter(v=>v.row.response===null&&!waived.some(w=>w.key===v.row.key)&&!closedKeys.includes(v.row.key)),baseWaived=waived.filter(w=>w.sequence===0);
  const blockedBase=base.unresolvedRequests!==baseWaived.length||base.cancelled||base.halted&&base.halted!=='EvaluationTransportUncertain';
  const current={...base,requests:base.requests+added.length,inputTokens:base.inputTokens+added.reduce((n,v)=>n+v.row.input_tokens,0),outputTokens:base.outputTokens+added.reduce((n,v)=>n+v.row.output_tokens,0),costNanodollars:base.costNanodollars+added.reduce((n,v)=>n+v.row.cost,0)-waived.reduce((n,w)=>n+w.reservation_nanodollars,0),unresolvedRequests:Math.max(0,base.unresolvedRequests-baseWaived.length)+unknown.length,activeRequests:Math.max(0,base.activeRequests-baseWaived.length)+unknown.length,halted:blockedBase?base.halted:unknown.length?'EvaluationTransportUncertain':null,admissionHalted:blockedBase?base.admissionHalted:unknown.length?'EvaluationTransportUncertain':null};
  if(rows.some(v=>!v.row)){current.activeRequests++;current.admissionHalted='EvaluationLeaseUnresolved';}
  if(closed)current.effectiveDeadlineAtMs=current.deadlineAtMs+JSON.parse(closed.authorization_json).additionalMilliseconds+recovered.reduce((sum,j)=>sum+JSON.parse(j.authorization_json).additionalMilliseconds,0);
  const override=executionOverride();if(override){
   const extra=usageRows(),pending=db.prepare('SELECT COUNT(*) n FROM (SELECT key FROM pipeline_dispatches UNION SELECT key FROM pipeline_actual_usage_calls) d LEFT JOIN pipeline_outcomes o USING(key) WHERE o.key IS NULL').get().n;
   Object.assign(current,{requests:current.requests+extra.length,inputTokens:current.inputTokens+extra.reduce((n,r)=>n+(r.receipt_json!==null?r.input_tokens:r.estimated_input_tokens),0),outputTokens:current.outputTokens+extra.reduce((n,r)=>n+(r.receipt_json!==null?r.output_tokens:r.estimated_output_tokens),0),costNanodollars:current.costNanodollars+extra.reduce((n,r)=>n+usageCost(r),0),unresolvedRequests:current.unresolvedRequests+extra.filter(r=>r.receipt_json===null).length,activeRequests:pending,halted:blockedBase?base.halted:null,admissionHalted:blockedBase?base.admissionHalted:pending?'EvaluationLeaseUnresolved':null});
  }
  return current;
 }
 function bindModelStage(role,identity){const normalized=stageIdentity(identity);if(role==='question-evaluator'&&!normalized.stageKey.startsWith('question-evaluator:'))throw Error('PipelineReviewStageIdentityInvalid');boundStage={role,identity:normalized};}
 function authorizeReviewStageRecovery(identity){
  const journal=standing();if(!journal)return executionRecoveryProof(identity);
  const normalized=stageIdentity(identity),keyHash=hash(JSON.stringify(normalized));
  const row=waivers().find(w=>w.identity_sha256===keyHash);if(!row)return executionRecoveryProof(identity);
  if(row.sequence===0){const original=JSON.parse(journal.authorization_json).historicalStage;if(identity.status!==original.status||identity.completedAt!==original.completedAt||identity.result_json!==original.result_json)return null;}
  const result=typeof identity.result_json==='string'?JSON.parse(identity.result_json):identity.result_json;
  if(!['claimed','completed'].includes(identity.status)||identity.status==='completed'&&(result?.ok!==false||typeof result.error?.kind!=='string'))return null;
  currentState();const diagnostic=db.prepare('SELECT diagnostic_json FROM pipeline_model_failure_diagnostics WHERE key=?').get(row.key),providerFailure=diagnostic?JSON.parse(diagnostic.diagnostic_json).providerFailure:null;return {reservationKey:row.key,authorizationSha256:journal.authorization_sha256,attemptKey:hash(JSON.stringify({policy:journal.authorization_sha256,reservationKey:row.key,identity:keyHash})),identitySha256:keyHash,costEvidence:'owner-assumption; provider billed cost remains unknown',...(providerFailure?{providerFailure,...(count(providerFailure.retryAfter?.retryAtMs)?{retryAtMs:providerFailure.retryAfter.retryAtMs}:{})}:{})};
 }
 function authorizeScraperStageRecovery(identity){
  const normalized=stageIdentity(identity);
  if(identity.status!==undefined&&identity.status!=='claimed'||identity.result_json!=null||identity.completedAt!=null)return null;
  const journal=[...recoveries(),...(continuation()?[continuation()]:[])].find(j=>JSON.stringify(normalized)===JSON.stringify(JSON.parse(j.authorization_json).identity));
  if(!journal)return executionRecoveryProof(identity);currentState();return continuationProof(journal);
 }
 // The owner removed price and receipt-uncertainty admission gates for this
 // bounded ongoing test. These append-only rows never rewrite historical debt.
 function authorizeExecutionOverride(command){
  if(!command||typeof command.path!=='string'||hash(readFileSync(command.path))!==command.sha256)throw Error('PipelineExecutionOverrideInvalid');
  const authority=JSON.parse(readFileSync(command.path)),previous=executionOverride();
  if(previous){if(previous.authorization_sha256!==command.sha256||previous.command_json!==JSON.stringify(command))throw Error('PipelineExecutionOverrideConflict');return;}
  verifyPrior();const state=currentState(),paused=phases().find(p=>p.end_at_ms===null),historicalIdentity=attemptRows().filter(v=>v.attempt.identity_json).map(v=>JSON.parse(v.attempt.identity_json)).at(-1);
  const source="Remove that ceiling. We don't need that on the backend. You should take in whatever price OpenRouter charges. Such a price difference should not stop our testing. Remove all other similar restraints that might stop the testing and that are not useful to the actual functionality of our pipeline.";
  if(authority.version!=='owner-unrestricted-provider-price-policy-v1'||authority.ownerAuthorized!==true||authority.source!==source||authority.continuationSource!=='Just remember to inform me when that happens. But that should not stop you from finishing the ongoing testing.'||typeof authority.authorizationId!=='string'||!authority.authorizationId||typeof authority.identity?.ownerId!=='string'||typeof authority.identity?.runId!=='string'||historicalIdentity?.ownerId!==authority.identity.ownerId||historicalIdentity?.runId!==authority.identity.runId||JSON.stringify(authority.models)!==JSON.stringify(activeModels)||currentCostLimit()!==1500000000||authority.modelCostNotificationThresholdNanodollars!==1500000000||authority.cumulativeBrowserCreditLimit!==150||authority.maximumRequests!==1200||authority.additionalMilliseconds!==0||authority.originalStartedAtMs!==state.startedAtMs||authority.originalDeadlineAtMs!==state.deadlineAtMs||authority.effectiveDeadlineAtMs!==effectiveDeadline(state)||!count(Date.parse(authority.recordedAt))||Date.parse(authority.recordedAt)>now()||!paused||state.cancelled||logicalNow()>=effectiveDeadline(state)||db.prepare('SELECT COUNT(*) n FROM pipeline_dispatches d LEFT JOIN pipeline_outcomes o USING(key) WHERE o.key IS NULL').get().n!==0)throw Error('PipelineExecutionOverrideInvalid');
  db.exec('BEGIN IMMEDIATE');try{
   db.exec(`CREATE TABLE pipeline_owner_execution_overrides(authorization_sha256 TEXT PRIMARY KEY,authorization_json TEXT NOT NULL,command_json TEXT NOT NULL,original_snapshot_json TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL);
CREATE TABLE pipeline_actual_usage_calls(key TEXT PRIMARY KEY,model TEXT NOT NULL,role TEXT NOT NULL,identity_json TEXT NOT NULL,estimated_input_tokens INTEGER NOT NULL,estimated_output_tokens INTEGER NOT NULL,estimated_cost INTEGER NOT NULL,estimate_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL);
CREATE TABLE pipeline_actual_usage_receipts(key TEXT PRIMARY KEY,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cost INTEGER NOT NULL,receipt_json TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL);
CREATE TABLE pipeline_actual_usage_failures(key TEXT PRIMARY KEY,known_usage TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL);
CREATE TABLE pipeline_cost_notifications(notification_id TEXT PRIMARY KEY,reported_cost INTEGER NOT NULL,threshold INTEGER NOT NULL,recorded_at_ms INTEGER NOT NULL);`);
   for(const table of ['pipeline_owner_execution_overrides','pipeline_actual_usage_calls','pipeline_actual_usage_receipts','pipeline_actual_usage_failures','pipeline_cost_notifications'])db.exec(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;`);
   db.prepare('INSERT INTO pipeline_owner_execution_overrides VALUES(?,?,?,?,?)').run(command.sha256,JSON.stringify(authority),JSON.stringify(command),JSON.stringify(state),now());db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 const receiptCost=rows=>rows.reduce((n,row)=>n+(row.response!==null?row.cost:JSON.parse(row.known_usage??'{}').costNanodollars??0),0);
 function reportedReceiptCost(){
  const prior=new DatabaseSync(priorStorePath,{readOnly:true});let total;try{total=['evaluation_reservations','openlearn_continuation_evaluation_reservations','openlearn_continuation_2_evaluation_reservations'].reduce((n,t)=>n+receiptCost(prior.prepare(`SELECT * FROM ${t}`).all()),0);}finally{prior.close();}
  total+=receiptCost(db.prepare('SELECT * FROM evaluation_reservations').all());if(assumption())total+=receiptCost(db.prepare('SELECT * FROM pipeline_recovery_evaluation_reservations').all());total+=receiptCost(attemptRows().filter(v=>v.row).map(v=>v.row));
  return total+usageRows().reduce((n,r)=>n+(r.receipt_json!==null?r.settled_cost:JSON.parse(r.known_usage??'{}').costNanodollars??0),0);
 }
 function notifyCost(){const override=executionOverride();if(!override)return;const threshold=JSON.parse(override.authorization_json).modelCostNotificationThresholdNanodollars;for(const metric of [{basis:'accounted-with-unknown-holds',value:priorAccounting.modelCostNanodollars+currentState().costNanodollars},{basis:'reported-receipts',value:reportedReceiptCost()}]){const id=override.authorization_sha256+':'+metric.basis;if(metric.value>=threshold&&!db.prepare('SELECT notification_id FROM pipeline_cost_notifications WHERE notification_id=?').get(id)){db.prepare('INSERT INTO pipeline_cost_notifications VALUES(?,?,?,?)').run(id,metric.value,threshold,now());logger({event:'pipeline-model-cost-threshold-crossed',basis:metric.basis,costNanodollars:metric.value,modelCostNotificationThresholdNanodollars:threshold,executionContinues:true});}}}
 function executionRecoveryProof(identity){
  const override=executionOverride();if(!override)return null;const id=stageIdentity(identity),authority=JSON.parse(override.authorization_json);
  const result=typeof identity.result_json==='string'?JSON.parse(identity.result_json):identity.result_json,failedClaim=(identity.status===undefined||identity.status==='claimed')&&result==null&&identity.completedAt==null,failedOutput=identity.status==='completed'&&result?.ok===false&&result.error?.kind==='WorkflowAgentAgentOutputInvalid'&&Number.isFinite(Date.parse(identity.completedAt));
  if(id.ownerId!==authority.identity.ownerId||id.runId!==authority.identity.runId||!(failedClaim||failedOutput))return null;
  const current=usageRows().find(r=>r.identity_json===JSON.stringify(id)),old=attemptRows().find(v=>v.attempt.identity_json===JSON.stringify(id)&&v.row),key=current?.key??old?.row.key;
  if(!key||!db.prepare('SELECT key FROM pipeline_outcomes WHERE key=?').get(key))return null;
  return {reservationKey:key,authorizationSha256:override.authorization_sha256,identity:id,attemptKey:hash(JSON.stringify({authorizationSha256:override.authorization_sha256,identity:id})),maximumAdditionalAttempts:1,retainedReservationNanodollars:current?usageCost(current):old.row.cost,costEvidence:'owner-authorized continued execution; reported charge or unknown hold retained'};
 }
 function authorizeModelStageRecovery(identity){const id=stageIdentity(identity);return id.stageKey.startsWith('knowledge-scraper:')?authorizeScraperStageRecovery(identity):id.stageKey.startsWith('question-evaluator:')?authorizeReviewStageRecovery(identity):executionRecoveryProof(identity);}
 function reserveActualUsage({key,body,catalog,stage}){
  const override=executionOverride(),authority=JSON.parse(override.authorization_json),id=stage?.identity;
  if(!id||id.ownerId!==authority.identity.ownerId||id.runId!==authority.identity.runId){const error=new AgentExecutionBoundaryFailure({kind:'PipelineModelStageIdentityInvalid'});error.notStarted=true;throw error;}
  // Existing public planner convention: explicitly approximate, not a token
  // bound or a price ceiling. Image bytes are excluded from text-byte estimates.
  let images=0;const textBody=JSON.stringify(body,(_key,value)=>{if(value?.type==='image_url'){images++;return {type:'image_url'};}return value;}),inputTokens=Math.ceil(new TextEncoder().encode(textBody).length/4)+images*8000,outputTokens=body.max_tokens,pricing=(catalog.rawCatalogModel??catalog.model).pricing,costNanodollars=inputTokens*priceCeilingNanodollars(pricing.prompt)+outputTokens*priceCeilingNanodollars(pricing.completion);
  if(!count(costNanodollars))throw Error('PipelineEstimateInvalid');
  db.exec('BEGIN IMMEDIATE');try{const state=currentState();if(state.cancelled)throw Error('EvaluationCancelled');if(state.admissionHalted||state.activeRequests)throw Error('EvaluationAccountingHalted');if(logicalNow()>=effectiveDeadline(state))throw Error('EvaluationDeadlineExceeded');if(state.requests>=policy.maximumRequests)throw Error('EvaluationBudgetExceeded');
   db.prepare('INSERT INTO pipeline_actual_usage_calls VALUES(?,?,?,?,?,?,?,?,?)').run(key,body.model,stage.role,JSON.stringify(id),inputTokens,outputTokens,costNanodollars,JSON.stringify({approximate:true,source:'Existing evaluation-budget estimated planner convention; not a binding upper bound',textBytes:new TextEncoder().encode(textBody).length,images,bytesPerToken:4,visualTokensPerImage:8000}),now());db.exec('COMMIT');
   return {reserved:{deadlineAtMs:effectiveDeadline(state)},active:{complete(command){if(![command.inputTokens,command.outputTokens,command.costNanodollars].every(count))return {ok:false,error:{kind:'PipelineModelReceiptInvalid'}};db.prepare('INSERT INTO pipeline_actual_usage_receipts VALUES(?,?,?,?,?,?)').run(key,command.inputTokens,command.outputTokens,command.costNanodollars,JSON.stringify(command.response),now());return {ok:true,value:null};},uncertain(command){db.prepare('INSERT OR IGNORE INTO pipeline_actual_usage_failures VALUES(?,?,?)').run(key,JSON.stringify(Object.fromEntries(['inputTokens','outputTokens','costNanodollars'].filter(k=>count(command[k])).map(k=>[k,command[k]]))),now());return {ok:true,value:null};}}};
  }catch(error){db.exec('ROLLBACK');const failure=error instanceof AgentExecutionBoundaryFailure?error:new AgentExecutionBoundaryFailure({kind:/^Evaluation[A-Za-z]+$/.test(error.message)?error.message:'PipelineUsagePersistenceFailed'});failure.notStarted=true;throw failure;}
 }
 // An explicit owner closure admits exactly this physically stopped unknown.
 // Its full debit, receipt absence, halt and stage evidence remain untouched.
 // The time grant is appended separately and activates inside paid admission.
 function authorizeContinuation(command){
  if(!command||typeof command.path!=='string'||hash(readFileSync(command.path))!==command.sha256)throw Error('PipelineContinuationInvalid');
  const authority=JSON.parse(readFileSync(command.path)),previous=continuation();
  if(previous){if(previous.authorization_sha256!==command.sha256||previous.proof_json!==JSON.stringify(command))throw Error('PipelineContinuationConflict');currentState();return continuationProof(previous);}
  verifyPrior();const state=currentState(),rows=attemptRows(),unknown=rows.filter(v=>v.row?.response===null&&!waivers().some(w=>w.key===v.row.key));
  const target=unknown.find(v=>v.row.key===authority.reservationKey),identity=stageIdentity(authority.identity),paused=phases().find(p=>p.end_at_ms===null);
  if(!standing()||authority.version!=='owner-full-reserve-continuation-v1'||authority.ownerAuthorized!==true||authority.source!=='Please continue'||typeof authority.authorizationId!=='string'||!authority.authorizationId.trim()||authority.model!==PIPELINE_MODELS[0]||authority.role!=='knowledge-scraper'||!identity.stageKey.startsWith('knowledge-scraper:')||authority.additionalMilliseconds!==1800000||authority.maximumRequests!==1200||authority.cumulativeModelCostLimitNanodollars!==1000000000||authority.cumulativeBrowserCreditLimit!==100||authority.originalStartedAtMs!==state.startedAtMs||authority.originalDeadlineAtMs!==state.deadlineAtMs||!count(Date.parse(authority.recordedAt))||Date.parse(authority.recordedAt)>now()||authority.assumedEffectiveCostNanodollars!==undefined||state.cancelled||state.halted!=='EvaluationTransportUncertain'||state.admissionHalted!=='EvaluationTransportUncertain'||state.unresolvedRequests!==1||state.activeRequests!==1||unknown.length!==1||!target||target.attempt.model!==authority.model||target.attempt.role!==authority.role||target.attempt.identity_json!==JSON.stringify(identity)||target.row.cost!==authority.retainedReservationNanodollars||target.row.uncertainty_version!==1||!count(target.row.cost)||target.row.cost===0||target.row.response!==null||target.row.known_usage!==null)throw Error('PipelineContinuationInvalid');
  const dispatch=db.prepare('SELECT * FROM pipeline_dispatches WHERE key=?').get(authority.reservationKey),outcome=db.prepare('SELECT * FROM pipeline_outcomes WHERE key=?').get(authority.reservationKey);
  if(!paused||!dispatch||!outcome||db.prepare('SELECT COUNT(*)n FROM pipeline_dispatches d LEFT JOIN pipeline_outcomes o USING(key) WHERE o.key IS NULL').get().n!==0||logicalNow()>=state.deadlineAtMs||state.requests>=1200||priorAccounting.modelCostNanodollars+state.costNanodollars>=1000000000)throw Error('PipelineContinuationWindowInvalid');
  for(const name of ['result','trace'])if(typeof command[name+'Path']!=='string'||hash(readFileSync(command[name+'Path']))!==command[name+'Sha256'])throw Error('PipelineContinuationProofInvalid');
  const report=JSON.parse(readFileSync(command.resultPath)),trace=readFileSync(command.tracePath,'utf8').trim().split('\n').map(s=>JSON.parse(s)),last=trace.at(-1),stoppedAt=Date.parse(report.recordedAt),latestOutcome=db.prepare('SELECT MAX(end_at_ms)ms FROM pipeline_outcomes').get().ms;
  if(report.version!=='openlearn-six-page-pipeline-result-v1'||report.cleanup?.ok!==true||JSON.stringify(report.accounting?.current)!==JSON.stringify(state)||report.accounting.cumulativeModelCostNanodollars!==priorAccounting.modelCostNanodollars+state.costNanodollars||report.accounting.reservedBrowserCredits!==priorAccounting.reservedBrowserCredits||last?.phase!=='pipeline-stopped'||last.cleanup?.ok!==true||JSON.stringify(last.accounting?.current)!==JSON.stringify(state)||Date.parse(last.at)!==stoppedAt||!count(stoppedAt)||stoppedAt<latestOutcome||stoppedAt>paused.start_at_ms||stoppedAt>now())throw Error('PipelineContinuationProofInvalid');
  db.exec('BEGIN IMMEDIATE');try{
   db.exec(`CREATE TABLE pipeline_owner_continuations(authorization_sha256 TEXT PRIMARY KEY,authorization_json TEXT NOT NULL,proof_json TEXT NOT NULL,sequence INTEGER NOT NULL,row_sha256 TEXT NOT NULL,attempt_sha256 TEXT NOT NULL,budget_sha256 TEXT NOT NULL,original_snapshot_json TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL);CREATE TABLE pipeline_owner_continuation_activations(authorization_sha256 TEXT PRIMARY KEY,physical_at_ms INTEGER NOT NULL,logical_at_ms INTEGER NOT NULL,reservation_key TEXT NOT NULL);`);
   for(const table of ['pipeline_owner_continuations','pipeline_owner_continuation_activations'])db.exec(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;`);
   const budget=db.prepare(`SELECT * FROM ${namespace(target.attempt.sequence)}_evaluation_budgets`).get();
   db.prepare('INSERT INTO pipeline_owner_continuations VALUES(?,?,?,?,?,?,?,?,?)').run(command.sha256,JSON.stringify(authority),JSON.stringify(command),target.attempt.sequence,hash(JSON.stringify(target.row)),hash(JSON.stringify(target.attempt)),hash(JSON.stringify(budget)),JSON.stringify(state),now());db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return continuationProof(continuation());
 }
 function authorizeRecovery(command){
  if(!command||typeof command.path!=='string'||hash(readFileSync(command.path))!==command.sha256)throw Error('PipelineRecoveryInvalid');
  const authority=JSON.parse(readFileSync(command.path)),previous=recoveries().find(j=>j.authorization_sha256===command.sha256||JSON.parse(j.authorization_json).authorizationId===authority.authorizationId||JSON.parse(j.authorization_json).reservationKey===authority.reservationKey);
  if(previous){if(previous.authorization_sha256!==command.sha256||previous.proof_json!==JSON.stringify(command))throw Error('PipelineRecoveryConflict');currentState();return continuationProof(previous);}
  verifyPrior();const state=currentState(),rows=attemptRows(),unknown=rows.filter(v=>v.row?.response===null&&!waivers().some(w=>w.key===v.row.key)&&![...recoveries(),...(continuation()?[continuation()]:[])].some(j=>JSON.parse(j.authorization_json).reservationKey===v.row.key));
  const target=unknown.find(v=>v.row.key===authority.reservationKey),identity=stageIdentity(authority.identity),paused=phases().find(p=>p.end_at_ms===null);
  const previousCostLimit=currentCostLimit(),preservingCap=authority.cumulativeModelCostLimitNanodollars===previousCostLimit&&(authority.previousCumulativeModelCostLimitNanodollars===undefined||authority.previousCumulativeModelCostLimitNanodollars===previousCostLimit);
  const existingDecision=preservingCap&&((authority.additionalMilliseconds===0&&['Please continue. You may raise the Firecrawl credit limit to 150.','Retain reserve and continue'].includes(authority.source))||(authority.additionalMilliseconds===1800000&&authority.source==='Retain reserve and add 30 minutes'));
  const raisedCapDecision=authority.source==='raise the limit to $1.5 and continue'&&authority.additionalMilliseconds===0&&previousCostLimit===1000000000&&authority.previousCumulativeModelCostLimitNanodollars===1000000000&&authority.cumulativeModelCostLimitNanodollars===1500000000;
  if(!standing()||!continuationActivation()||authority.priorContinuationAuthorizationSha256!==continuation()?.authorization_sha256||authority.effectiveDeadlineAtMs!==effectiveDeadline(state)||authority.version!=='owner-full-reserve-recovery-v1'||authority.ownerAuthorized!==true||!(existingDecision||raisedCapDecision)||typeof authority.authorizationId!=='string'||!authority.authorizationId.trim()||authority.model!==PIPELINE_MODELS[0]||authority.role!=='knowledge-scraper'||!identity.stageKey.startsWith('knowledge-scraper:')||authority.maximumRequests!==1200||authority.cumulativeBrowserCreditLimit!==150||authority.originalStartedAtMs!==state.startedAtMs||authority.originalDeadlineAtMs!==state.deadlineAtMs||!count(Date.parse(authority.recordedAt))||Date.parse(authority.recordedAt)>now()||authority.assumedEffectiveCostNanodollars!==undefined||state.cancelled||state.halted!=='EvaluationTransportUncertain'||state.admissionHalted!=='EvaluationTransportUncertain'||state.unresolvedRequests!==1||state.activeRequests!==1||unknown.length!==1||!target||target.attempt.model!==authority.model||target.attempt.role!==authority.role||target.attempt.identity_json!==JSON.stringify(identity)||target.row.cost!==authority.retainedReservationNanodollars||target.row.uncertainty_version!==1||!count(target.row.cost)||target.row.cost===0||target.row.response!==null||target.row.known_usage!==null)throw Error('PipelineRecoveryInvalid');
  const dispatch=db.prepare('SELECT * FROM pipeline_dispatches WHERE key=?').get(authority.reservationKey),outcome=db.prepare('SELECT * FROM pipeline_outcomes WHERE key=?').get(authority.reservationKey);
  if(!paused||!dispatch||!outcome||db.prepare('SELECT COUNT(*)n FROM pipeline_dispatches d LEFT JOIN pipeline_outcomes o USING(key) WHERE o.key IS NULL').get().n!==0||logicalNow()>=effectiveDeadline(state)||state.requests>=1200||priorAccounting.modelCostNanodollars+state.costNanodollars>=authority.cumulativeModelCostLimitNanodollars)throw Error('PipelineRecoveryWindowInvalid');
  for(const name of ['result','trace'])if(typeof command[name+'Path']!=='string'||hash(readFileSync(command[name+'Path']))!==command[name+'Sha256'])throw Error('PipelineRecoveryProofInvalid');
  const report=JSON.parse(readFileSync(command.resultPath)),trace=readFileSync(command.tracePath,'utf8').trim().split('\n').map(s=>JSON.parse(s)),last=trace.at(-1),stoppedAt=Date.parse(report.recordedAt),latestOutcome=db.prepare('SELECT MAX(end_at_ms)ms FROM pipeline_outcomes').get().ms;
  if(report.version!=='openlearn-six-page-pipeline-result-v1'||report.cleanup?.ok!==true||JSON.stringify(report.accounting?.current)!==JSON.stringify(state)||report.accounting.cumulativeModelCostNanodollars!==priorAccounting.modelCostNanodollars+state.costNanodollars||report.accounting.reservedBrowserCredits!==priorAccounting.reservedBrowserCredits||last?.phase!=='pipeline-stopped'||last.cleanup?.ok!==true||JSON.stringify(last.accounting?.current)!==JSON.stringify(state)||Date.parse(last.at)!==stoppedAt||!count(stoppedAt)||stoppedAt<latestOutcome||stoppedAt>paused.start_at_ms||stoppedAt>now())throw Error('PipelineRecoveryProofInvalid');
  db.exec('BEGIN IMMEDIATE');try{
   db.exec(`CREATE TABLE IF NOT EXISTS pipeline_owner_full_reserve_recoveries(authorization_sha256 TEXT PRIMARY KEY,authorization_json TEXT NOT NULL,proof_json TEXT NOT NULL,sequence INTEGER NOT NULL,row_sha256 TEXT NOT NULL,attempt_sha256 TEXT NOT NULL,budget_sha256 TEXT NOT NULL,original_snapshot_json TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL,authorization_id TEXT NOT NULL UNIQUE,reservation_key TEXT NOT NULL UNIQUE);CREATE TABLE IF NOT EXISTS pipeline_owner_recovery_activations(authorization_sha256 TEXT PRIMARY KEY,physical_at_ms INTEGER NOT NULL,logical_at_ms INTEGER NOT NULL,reservation_key TEXT NOT NULL);`);
   for(const table of ['pipeline_owner_full_reserve_recoveries','pipeline_owner_recovery_activations'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;`);
   const budget=db.prepare(`SELECT * FROM ${namespace(target.attempt.sequence)}_evaluation_budgets`).get();
   db.prepare('INSERT INTO pipeline_owner_full_reserve_recoveries VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(command.sha256,JSON.stringify(authority),JSON.stringify(command),target.attempt.sequence,hash(JSON.stringify(target.row)),hash(JSON.stringify(target.attempt)),hash(JSON.stringify(budget)),JSON.stringify(state),now(),authority.authorizationId,authority.reservationKey);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return continuationProof(recoveries().find(j=>j.authorization_sha256===command.sha256));
 }
 function recordReviewAssumption({key,sequence,identity,model,known,proof}){
  const journal=standing();if(!journal||model!==PIPELINE_MODELS[1]||!identity||known.costNanodollars>0)return false;
  const row=db.prepare(`SELECT * FROM ${sequence===0?'pipeline_recovery':namespace(sequence)}_evaluation_reservations WHERE key=?`).get(key);
  if(!row||row.response!==null||row.uncertainty_version!==1||row.known_usage!==null&&JSON.parse(row.known_usage).costNanodollars>0)return false;
  const id=stageIdentity(identity);db.prepare('INSERT INTO pipeline_failed_review_assumptions VALUES(?,?,?,?,?,?,?,?)').run(key,sequence,row.cost,hash(JSON.stringify(row)),hash(JSON.stringify(id)),JSON.stringify(id),now(),JSON.stringify(proof));return true;
 }
 function authorizeFailedReviewCostPolicy(command){
  if(!command||typeof command.path!=='string'||hash(readFileSync(command.path))!==command.sha256)throw Error('PipelineReviewPolicyInvalid');
  const authority=JSON.parse(readFileSync(command.path)),previous=standing();
  if(previous){if(previous.authorization_sha256!==command.sha256||previous.proof_json!==JSON.stringify(command))throw Error('PipelineReviewPolicyConflict');currentState();return;}
  verifyPrior();if(!command.historicalStage?.stageKey?.startsWith('question-evaluator:'))throw Error('PipelineReviewPolicyEvidenceInvalid');if(JSON.stringify(command.historicalStage)!==JSON.stringify(authority.historicalStage))throw Error('PipelineReviewPolicyEvidenceInvalid');const base=baseState(),identity=stageIdentity(command.historicalStage),key=authority.reservationKey;
  if(!assumption()||authority.version!=='owner-failed-review-cost-policy-v1'||authority.ownerAuthorized!==true||authority.source!=='assume failed review calls incur 0 charges from now on'||authority.model!==PIPELINE_MODELS[1]||authority.role!=='question-evaluator'||authority.costEvidence!=='owner-assumption; provider billed cost remains unknown'||authority.cumulativeModelCostLimitNanodollars!==1000000000||authority.cumulativeBrowserCreditLimit!==100||authority.maximumRequests!==1200||authority.originalStartedAtMs!==base.startedAtMs||authority.originalDeadlineAtMs!==base.deadlineAtMs||!Number.isFinite(Date.parse(authority.recordedAt))||Date.parse(authority.recordedAt)>now()||base.halted!=='EvaluationTransportUncertain'||base.unresolvedRequests!==1||base.cancelled)throw Error('PipelineReviewPolicyInvalid');
  const row=db.prepare('SELECT * FROM pipeline_recovery_evaluation_reservations WHERE response IS NULL').get(),dispatch=db.prepare('SELECT * FROM pipeline_dispatches WHERE key=?').get(key),outcome=db.prepare('SELECT * FROM pipeline_outcomes WHERE key=?').get(key);
  if(row?.key!==key||row.uncertainty_version!==1||row.known_usage!==null&&JSON.parse(row.known_usage).costNanodollars>0||!dispatch||!outcome||db.prepare('SELECT COUNT(*)n FROM pipeline_dispatches d LEFT JOIN pipeline_outcomes o USING(key) WHERE o.key IS NULL').get().n)throw Error('PipelineReviewPolicyEvidenceInvalid');
  for(const name of ['result','trace'])if(typeof command[name+'Path']!=='string'||hash(readFileSync(command[name+'Path']))!==command[name+'Sha256'])throw Error('PipelineReviewPolicyEvidenceInvalid');
  const report=JSON.parse(readFileSync(command.resultPath)),trace=readFileSync(command.tracePath,'utf8').trim().split('\n').map(s=>JSON.parse(s)),last=trace.at(-1),stoppedAt=Date.parse(report.recordedAt),asLogical=instant=>instant-phases().reduce((sum,p)=>sum+Math.max(0,Math.min(instant,p.end_at_ms??instant)-p.start_at_ms),0);
  const result=typeof command.historicalStage.result_json==='string'?JSON.parse(command.historicalStage.result_json):command.historicalStage.result_json;
  const entries=trace.filter(e=>e.event==='knowledge-model-entry'&&asLogical(Date.parse(e.at))>=Date.parse(identity.createdAt)&&Date.parse(e.at)<=outcome.end_at_ms);
  if(report.cleanup?.ok!==true||report.version!=='openlearn-six-page-pipeline-result-v1'||JSON.stringify(report.accounting.current)!==JSON.stringify(base)||last?.phase!=='pipeline-stopped'||last.cleanup?.ok!==true||JSON.stringify(last.accounting.current)!==JSON.stringify(base)||Date.parse(last.at)!==stoppedAt||stoppedAt<outcome.end_at_ms||stoppedAt>now()||entries.length!==1||entries[0].stage!=='question-evaluator'||entries[0].phase==='normalization'||Date.parse(identity.createdAt)>asLogical(dispatch.start_at_ms)||Date.parse(command.historicalStage.completedAt)<asLogical(outcome.end_at_ms)||command.historicalStage.status!=='completed'||result?.ok!==false||result.error?.kind!=='WorkflowAgentAgentOutputInvalid')throw Error('PipelineReviewPolicyEvidenceInvalid');
  // Current stop must already be audited/paused, so authorization cannot restart
  // an expired clock or silently turn offline repair into paid execution time.
  if(!phases().some(p=>p.end_at_ms===null)||logicalNow()>=base.deadlineAtMs)throw Error('PipelineReviewPolicyWindowInvalid');
  const remainingRequests=policy.maximumRequests-base.requests,maxContext=Math.max(...PIPELINE_MODELS.map(m=>catalogs[m].model.context_length));
  if(remainingRequests<=0||!count(maxContext*remainingRequests))throw Error('PipelineReviewPolicyBudgetExhausted');
  db.exec('BEGIN IMMEDIATE');try{
   db.exec(`CREATE TABLE pipeline_failed_review_policy(authorization_sha256 TEXT PRIMARY KEY,authorization_json TEXT NOT NULL,proof_json TEXT NOT NULL,base_rows_sha256 TEXT NOT NULL,base_snapshot_json TEXT NOT NULL,remaining_requests INTEGER NOT NULL,derived_input_tokens INTEGER NOT NULL,derived_output_tokens INTEGER NOT NULL,recorded_at_ms INTEGER NOT NULL);CREATE TABLE pipeline_failed_review_assumptions(key TEXT PRIMARY KEY,sequence INTEGER NOT NULL,reservation_nanodollars INTEGER NOT NULL,row_sha256 TEXT NOT NULL,identity_sha256 TEXT NOT NULL,identity_json TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL,proof_json TEXT NOT NULL);CREATE TABLE pipeline_review_policy_attempts(sequence INTEGER PRIMARY KEY,budget_id TEXT NOT NULL,policy_json TEXT NOT NULL,identity_json TEXT,role TEXT,model TEXT NOT NULL);`);
   for(const table of ['pipeline_failed_review_policy','pipeline_failed_review_assumptions','pipeline_review_policy_attempts'])db.exec(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;`);
   db.prepare('INSERT INTO pipeline_failed_review_policy VALUES(?,?,?,?,?,?,?,?,?)').run(command.sha256,JSON.stringify(authority),JSON.stringify(command),baseRowsHash(),JSON.stringify(base),remainingRequests,remainingRequests*maxContext,remainingRequests*maxContext,now());
   if(!recordReviewAssumption({key,sequence:0,identity,model:authority.model,known:{},proof:command}))throw Error('PipelineReviewPolicyEvidenceInvalid');db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 function reserveStanding({key,inputTokens,outputTokens,costNanodollars,model,stage}){
  db.exec('BEGIN IMMEDIATE');try{
   const state=currentState();if(state.cancelled)throw Error('EvaluationCancelled');if(state.admissionHalted||state.activeRequests)throw Error('EvaluationAccountingHalted');if(logicalNow()>=effectiveDeadline(state))throw Error('EvaluationDeadlineExceeded');
   if(state.requests>=policy.maximumRequests||priorAccounting.modelCostNanodollars+state.costNanodollars+costNanodollars>currentCostLimit())throw Error('EvaluationBudgetExceeded');
   const sequence=attempts().length+1,budgetId=`openlearn-six-capture-standing-attempt-${sequence}`,prefix=namespace(sequence),attemptPolicy={maximumRequests:1,maximumInputTokens:catalogs[model].model.context_length,maximumOutputTokens:catalogs[model].model.context_length,maximumMilliseconds:effectiveDeadline(state)-state.startedAtMs,maximumCostNanodollars:currentCostLimit()-priorAccounting.modelCostNanodollars-state.costNanodollars};
   db.exec(`CREATE TABLE ${prefix}_evaluation_budgets(budget_id TEXT PRIMARY KEY,policy TEXT NOT NULL,started INTEGER NOT NULL,deadline INTEGER NOT NULL,cancelled INTEGER NOT NULL DEFAULT 0,halted TEXT);`);
   db.prepare(`INSERT INTO ${prefix}_evaluation_budgets VALUES(?,?,?,?,0,NULL)`).run(budgetId,JSON.stringify(attemptPolicy),state.startedAtMs,effectiveDeadline(state));
   const attempt={sequence,budget_id:budgetId,policy_json:JSON.stringify(attemptPolicy)};const active=attemptLedger(attempt),reserved=requireResult(active.reserve({key,inputTokens,outputTokens,costNanodollars}));
   db.prepare('INSERT INTO pipeline_review_policy_attempts VALUES(?,?,?,?,?,?)').run(sequence,budgetId,attempt.policy_json,stage?JSON.stringify(stage.identity):null,stage?.role??null,model);
   const grant=continuation();if(grant&&!continuationActivation())db.prepare('INSERT INTO pipeline_owner_continuation_activations VALUES(?,?,?,?)').run(grant.authorization_sha256,now(),logicalNow(),key);
   for(const grant of recoveries())if(JSON.parse(grant.authorization_json).additionalMilliseconds>0&&!recoveryActivation(grant))db.prepare('INSERT INTO pipeline_owner_recovery_activations VALUES(?,?,?,?)').run(grant.authorization_sha256,now(),logicalNow(),key);
   db.exec('COMMIT');return {active,reserved,sequence};
  }catch(error){db.exec('ROLLBACK');const boundary=new AgentExecutionBoundaryFailure({kind:(/^Evaluation[A-Za-z]+$/.test(error.message)||error.message==='PipelineContinuationHistoryChanged')?error.message:'PipelineReviewPolicyPersistenceFailed'});boundary.notStarted=true;throw boundary;}
 }
 // Trusted isolated runner composition. This records an owner assumption, never
 // a provider receipt, and creates no new time or counter allowance.
 function authorizeCostAssumption(command){
  if(!command||typeof command.path!=='string'||typeof command.sha256!=='string')throw new Error('PipelineCostAssumptionInvalid');
  const bytes=readFileSync(command.path);if(hash(bytes)!==command.sha256)throw new Error('PipelineCostAssumptionChanged');
  const authority=JSON.parse(bytes),prior=assumption();
  if(prior){if(prior.authorization_sha256!==command.sha256||prior.authorization_json!==JSON.stringify(authority)||prior.preparation_proof_json!==JSON.stringify(command))throw new Error('PipelineCostAssumptionConflict');openRecovery();return;}
  verifyPrior();if(!existing())throw new Error('PipelineCostAssumptionInvalid');
  const original=requireResult(getLedger().snapshot()),unknowns=db.prepare('SELECT * FROM evaluation_reservations WHERE response IS NULL').all(),row=unknowns[0];
  if(authority.version!=='owner-timeout-cost-assumption-v1'||authority.ownerAuthorized!==true||typeof authority.source!=='string'||!authority.source.trim()||typeof authority.scope!=='string'||!authority.scope.trim()||!Number.isFinite(Date.parse(authority.recordedAt))||Date.parse(authority.recordedAt)>now()||authority.assumedEffectiveCostNanodollars!==0||authority.costEvidence!=='owner-assumption; provider billed cost remains unknown'||authority.cumulativeModelCostLimitNanodollars!==1000000000||authority.cumulativeBrowserCreditLimit!==100||original.cancelled||original.halted!=='EvaluationTransportUncertain'||authority.originalStartedAtMs!==original.startedAtMs||authority.originalDeadlineAtMs!==original.deadlineAtMs||unknowns.length!==1||row.key!==authority.reservationKey||row.cost!==authority.originalReservationNanodollars||row.uncertainty_version!==1||row.known_usage!==null||!count(row.cost)||row.cost===0||db.prepare('SELECT COUNT(*)n FROM pipeline_dispatches d LEFT JOIN pipeline_outcomes o USING(key) WHERE o.key IS NULL').get().n!==0)throw new Error('PipelineCostAssumptionInvalid');
  const remainingPolicy={...policy,maximumRequests:policy.maximumRequests-original.requests,maximumInputTokens:policy.maximumInputTokens-original.inputTokens,maximumOutputTokens:policy.maximumOutputTokens-original.outputTokens,maximumCostNanodollars:policy.maximumCostNanodollars-original.costNanodollars+row.cost};
  if(Object.values(remainingPolicy).some(v=>!count(v)||v===0))throw new Error('PipelineCostAssumptionBudgetExhausted');
  for(const name of ['result','trace'])if(typeof command[name+'Path']!=='string'||hash(readFileSync(command[name+'Path']))!==command[name+'Sha256'])throw new Error('PipelineCostAssumptionProofInvalid');
  const report=JSON.parse(readFileSync(command.resultPath,'utf8')),trace=readFileSync(command.tracePath,'utf8').trim().split('\n').map(line=>JSON.parse(line)),last=trace.at(-1),stoppedAt=Date.parse(report.recordedAt),latestOutcome=db.prepare('SELECT MAX(end_at_ms)ms FROM pipeline_outcomes').get().ms;
  if(report.version!=='openlearn-six-page-pipeline-result-v1'||report.cleanup?.ok!==true||JSON.stringify(report.accounting?.current)!==JSON.stringify(original)||!count(stoppedAt)||stoppedAt<original.startedAtMs||stoppedAt<latestOutcome||stoppedAt>now()||last?.phase!=='pipeline-stopped'||last.cleanup?.ok!==true||Date.parse(last.at)!==stoppedAt||JSON.stringify(last.accounting?.current)!==JSON.stringify(original)||phases().some(p=>p.end_at_ms===null||p.start_at_ms>=stoppedAt)||stoppedAt>=original.deadlineAtMs||db.prepare('SELECT COUNT(*)n FROM pipeline_dispatches').get().n!==original.requests)throw new Error('PipelineCostAssumptionProofInvalid');
  db.exec('BEGIN IMMEDIATE');try{
   db.exec(`CREATE TABLE pipeline_owner_cost_assumptions(singleton INTEGER PRIMARY KEY CHECK(singleton=1),authorization_sha256 TEXT NOT NULL,authorization_json TEXT NOT NULL,original_snapshot_sha256 TEXT NOT NULL,original_reservation_nanodollars INTEGER NOT NULL,remaining_policy_json TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL,preparation_proof_json TEXT NOT NULL,original_rows_sha256 TEXT NOT NULL);CREATE TRIGGER pipeline_owner_cost_assumptions_immutable BEFORE UPDATE ON pipeline_owner_cost_assumptions BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER pipeline_owner_cost_assumptions_no_delete BEFORE DELETE ON pipeline_owner_cost_assumptions BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TABLE pipeline_recovery_evaluation_budgets(budget_id TEXT PRIMARY KEY,policy TEXT NOT NULL,started INTEGER NOT NULL,deadline INTEGER NOT NULL,cancelled INTEGER NOT NULL DEFAULT 0,halted TEXT);`);
   db.prepare('INSERT INTO pipeline_owner_cost_assumptions VALUES(1,?,?,?,?,?,?,?,?)').run(command.sha256,JSON.stringify(authority),hash(JSON.stringify(original)),row.cost,JSON.stringify(remainingPolicy),now(),JSON.stringify(command),originalRowsHash());
   db.prepare('INSERT INTO pipeline_recovery_evaluation_budgets VALUES(?,?,?,?,0,NULL)').run('openlearn-six-capture-same-window-recovery-1',JSON.stringify(remainingPolicy),original.startedAtMs,original.deadlineAtMs);
   db.prepare('INSERT INTO pipeline_preparation_pauses VALUES(?,?,?)').run(randomUUID(),stoppedAt,JSON.stringify({ownerCostAssumption:command}));
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  openRecovery();logger({event:'pipeline-owner-cost-assumption-recorded',reservationKey:row.key,authorizationSha256:command.sha256});
 }
 if(ownerCostAssumption)authorizeCostAssumption(ownerCostAssumption);else if(assumption())openRecovery();
 if(failedReviewCostPolicy)authorizeFailedReviewCostPolicy(failedReviewCostPolicy);
 if(ownerContinuation)authorizeContinuation(ownerContinuation);
 if(ownerRecovery)authorizeRecovery(ownerRecovery);
 if(ownerExecutionOverride)authorizeExecutionOverride(ownerExecutionOverride);
 function pauseForPreparation(proof){
  if(!existing())return;
  verifyPrior();
  const state=currentState();
  for(const name of ['result','trace'])if(hash(readFileSync(proof[name+'Path']))!==proof[name+'Sha256'])throw new Error('PipelinePreparationProofInvalid');
  const paused=phases().find(p=>p.end_at_ms===null);
  if(paused?.proof_json===JSON.stringify(proof))return;
  const uncertainStop=state.halted==='EvaluationTransportUncertain'&&state.admissionHalted==='EvaluationTransportUncertain'&&state.unresolvedRequests>0&&state.activeRequests===state.unresolvedRequests;
  if(state.cancelled||!uncertainStop&&(state.activeRequests!==0||state.halted||state.admissionHalted||!executionOverride()&&state.unresolvedRequests!==0))throw new Error('PipelinePreparationPauseInvalid');
  const report=JSON.parse(readFileSync(proof.resultPath,'utf8'));
  const trace=readFileSync(proof.tracePath,'utf8').trim().split('\n').map(line=>JSON.parse(line)),last=trace.at(-1),recordedAt=Date.parse(report.recordedAt),lastAt=Date.parse(last?.at),latestOutcome=db.prepare('SELECT MAX(end_at_ms)ms FROM pipeline_outcomes').get().ms;
  if(report.version!=='openlearn-six-page-pipeline-result-v1'||report.cleanup?.ok!==true||JSON.stringify(report.accounting?.current)!==JSON.stringify(state)||!Number.isSafeInteger(recordedAt)||!Number.isSafeInteger(lastAt)||recordedAt<latestOutcome||recordedAt>now()||last?.phase!=='pipeline-stopped'||last.cleanup?.ok!==true||JSON.stringify(last.accounting?.current)!==JSON.stringify(state)||lastAt>recordedAt||lastAt<latestOutcome)throw new Error('PipelinePreparationProofInvalid');
  const pending=db.prepare('SELECT COUNT(*)n FROM pipeline_dispatches d LEFT JOIN pipeline_outcomes o USING(key) WHERE o.key IS NULL').get().n;
  if(pending!==0)throw new Error('PipelinePreparationPauseInvalid');
  if(paused){
   const latestDispatch=db.prepare('SELECT MAX(start_at_ms)ms FROM pipeline_dispatches').get().ms;
   if(recordedAt<paused.start_at_ms||latestDispatch>paused.start_at_ms||latestOutcome>paused.start_at_ms)throw new Error('PipelinePreparationPauseInvalid');
   // A terminal retry can stop without a provider dispatch while preparation is
   // already paused. Validate its new evidence, preserving the original pause
   // and proof exactly; this acknowledgement creates no additional time.
   return;
  }
  const closedPhases=phases(),logicalStoppedAt=recordedAt-closedPhases.reduce((sum,p)=>sum+(p.end_at_ms-p.start_at_ms),0);
  if(closedPhases.some(p=>p.end_at_ms>recordedAt)||logicalStoppedAt<state.startedAtMs||logicalStoppedAt>=effectiveDeadline(state))throw new Error('PipelinePreparationPauseInvalid');
  db.prepare('INSERT INTO pipeline_preparation_pauses VALUES(?,?,?)').run(randomUUID(),recordedAt,JSON.stringify(proof));
 }
 async function modelFetch(url,init){
  if(closed||String(url)!==endpoint||init?.method!=='POST'||typeof init.body!=='string')throw new Error('PipelineModelTransportInvalid');
  if(init.signal?.aborted)throw new Error('PipelineModelRequestAborted');
  verifyPrior();const body=JSON.parse(init.body),catalog=catalogs[body.model];
  const role=body.model===evaluatorModel?'question-evaluator':'knowledge-scraper';
  if(!catalog||!activeModels.includes(body.model)||!count(body.max_tokens)||body.max_tokens===0||body.max_tokens>=catalog.model.context_length||body.stream!==false)throw new Error('PipelineModelRequestInvalid');
  const protocol=pipelineProtocol(catalog,role,automaticReviewerRouting,evaluatorModel,Boolean(executionOverride()));
  if(JSON.stringify(body.provider)!==JSON.stringify(protocol.provider)||body.reasoning?.effort!==protocol.reasoningEffort||!['json_object',protocol.responseFormat].includes(body.response_format?.type)||body.response_format?.type==='json_schema'&&(body.response_format.json_schema?.strict!==true||typeof body.response_format.json_schema?.schema!=='object'||body.response_format.json_schema.schema===null))throw new Error('PipelineModelProtocolMismatch');
  // Full catalog context is reserved for input, including image/schema tokens.
  const inputTokens=catalog.model.context_length,outputTokens=body.max_tokens;
  const promptRate=priceCeilingNanodollars(catalog.model.pricing.prompt),completionRate=priceCeilingNanodollars(catalog.model.pricing.completion);
  if(promptRate===null||completionRate===null)throw new Error('PipelinePricingInvalid');
  const costNanodollars=inputTokens*promptRate+outputTokens*completionRate;
  if(!count(costNanodollars))throw new Error('PipelineReservationInvalid');
  if(!executionOverride()&&!existing()&&(costNanodollars>policy.maximumCostNanodollars||inputTokens>policy.maximumInputTokens||outputTokens>policy.maximumOutputTokens)){const error=new AgentExecutionBoundaryFailure({kind:'EvaluationBudgetExceeded'});error.notStarted=true;throw error;}
  const key=randomUUID(),stage=boundStage;boundStage=null;let active,reserved,sequence=0;
  if(executionOverride()){({active,reserved}=reserveActualUsage({key,body,catalog,stage}));}
  else if(standing()){({active,reserved,sequence}=reserveStanding({key,inputTokens,outputTokens,costNanodollars,model:body.model,stage}));}
  else{active=openRecovery()??getLedger();const reservation=active.reserve({key,inputTokens,outputTokens,costNanodollars});if(!reservation.ok){const error=new AgentExecutionBoundaryFailure(reservation.error);error.notStarted=true;throw error;}reserved=reservation.value;}
  const paused=phases().find(p=>p.end_at_ms===null);if(paused)db.prepare('INSERT INTO pipeline_preparation_resumes VALUES(?,?)').run(paused.id,now());
  const remaining=reserved.deadlineAtMs-logicalNow();if(remaining<=0)throw new Error('PipelineDeadlineExceeded');
  const signal=AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(remaining)]);
  let known={},settled=false,failureStage='dispatch',httpStatus=null,generationId=null,receiptIssues=[],providerFailure={errorCode:null,errorType:'unknown',providerIdentifier:'unknown',retryAfter:{source:'missing'}};
  try{
   db.prepare('INSERT INTO pipeline_dispatches VALUES(?,?)').run(key,now());
   const response=await transport(url,{...init,signal});httpStatus=response.status;const retry=response.headers.get('retry-after'),parsedRetry=retry===null?null:parseRetryAfter(retry,now());providerFailure.retryAfter=retry===null?{source:'missing'}:parsedRetry.ok?parsedRetry.value:{source:'invalid'};failureStage='response-read';const copy=response.clone();
   const reader=copy.body?.getReader(),chunks=[];let length=0;
   if(reader)try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;if(length>1048576){await reader.cancel();throw new Error('PipelineModelResponseTooLarge');}chunks.push(chunk.value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   failureStage='response-decode';const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   failureStage='response-json';const document=JSON.parse(decoded),usage=document?.usage;
   if(typeof document?.id==='string'&&/^gen-[A-Za-z0-9_-]{1,252}$/.test(document.id))generationId=document.id;
   failureStage='receipt-validation';
   const providerError=document?.error;providerFailure.errorCode=Number.isSafeInteger(providerError?.code)&&providerError.code>=100&&providerError.code<=599?providerError.code:null;providerFailure.errorType=errorTypes.includes(providerError?.metadata?.error_type)?providerError.metadata.error_type:'unknown';
   // Existing diagnostics have no source-backed provider identifier allowlist.
   // Keep unknown rather than persist an arbitrary provider/message echo.
   if(usage){if(count(usage.prompt_tokens))known.inputTokens=usage.prompt_tokens;if(count(usage.completion_tokens))known.outputTokens=usage.completion_tokens;if(typeof usage.cost==='number'&&Number.isFinite(usage.cost)&&usage.cost>=0)known.costNanodollars=Math.ceil(usage.cost*1000000000);}
   receiptIssues=[...(!response.ok?['http-rejected']:[]),...(document?.error?['provider-error']:[]),...(![body.model,catalog.model.canonical_slug].includes(document?.model)?['model-mismatch']:[]),...(!usage?['usage-missing']:[]),...(!count(known.inputTokens)?['input-tokens-missing']:[]),...(!count(known.outputTokens)?['output-tokens-missing']:[]),...(!count(known.costNanodollars)?['cost-missing']:[]),...(typeof document?.id!=='string'?['generation-id-missing']:[])];
   if(receiptIssues.length)throw new Error('PipelineModelReceiptInvalid');
   const receipt={id:document.id,model:document.model,usage:{prompt_tokens:known.inputTokens,completion_tokens:known.outputTokens,cost:usage.cost}};
   failureStage='ledger-completion';requireResult(active.complete({key,...known,response:receipt}));settled=true;
   db.prepare('INSERT INTO pipeline_outcomes VALUES(?,?)').run(key,now());notifyCost();
   failureStage='response-observer';await onResponse({key,requestDigest:hash(init.body),receipt,choices:Array.isArray(document.choices)?document.choices.map(choice=>({finish_reason:choice.finish_reason,message:{content:choice.message?.content??null}})):[]});
   return response;
  }catch(error){
   if(!settled)active.uncertain({key,kind:'EvaluationTransportUncertain',...known});db.prepare('INSERT OR IGNORE INTO pipeline_outcomes VALUES(?,?)').run(key,now());
   // Never log arbitrary exception messages: JSON/network errors can include
   // response content or credentials. Stable domain kinds and built-in types
   // retain useful failure context without persisting prompts or full bodies.
   const exceptionType=['Error','TypeError','SyntaxError','RangeError','AbortError','TimeoutError'].includes(error?.name)?error.name:'Error';
   const internalKind=error instanceof AgentExecutionBoundaryFailure?error.failure.kind:typeof error?.message==='string'&&/^(?:Pipeline|Evaluation)[A-Z][A-Za-z0-9]{0,80}$/.test(error.message)?error.message:null;
   const failureKind=internalKind??(failureStage==='dispatch'?'PipelineModelTransportFailed':failureStage==='response-read'?'PipelineModelResponseReadFailed':failureStage==='response-decode'||failureStage==='response-json'?'PipelineModelResponseInvalid':failureStage==='response-observer'?'PipelineModelObserverFailed':'PipelineModelLedgerPersistenceFailed');
   const diagnostic={event:'pipeline-model-transport-failure',key,model:body.model,stage:failureStage,failureKind,exceptionType,httpStatus,generationId,receiptIssues,providerFailure,knownUsage:known,settled};
   db.prepare('INSERT INTO pipeline_model_failure_diagnostics VALUES(?,?,?)').run(key,now(),JSON.stringify(diagnostic));logger(diagnostic);notifyCost();
   if(!settled&&sequence&&stage?.role==='question-evaluator')recordReviewAssumption({key,sequence,identity:stage.identity,model:body.model,known,proof:{diagnosticKey:key,authorizationSha256:standing().authorization_sha256}});
   throw error instanceof AgentExecutionBoundaryFailure?error:new AgentExecutionBoundaryFailure({kind:failureKind,field:failureStage,...(httpStatus===null?{}:{httpStatus})});
  }
 }
 return {modelFetch,pauseForPreparation,authorizeCostAssumption,authorizeFailedReviewCostPolicy,authorizeContinuation,authorizeRecovery,authorizeExecutionOverride,authorizeModelStageRecovery,authorizeScraperStageRecovery,bindModelStage,authorizeReviewStageRecovery,nowMs:logicalNow,snapshot(){verifyPrior();const current=ledger||existing()?currentState():null,journal=assumption(),originalCurrent=journal?requireResult(getLedger().snapshot()):null,activeRecovery=journal?requireResult(openRecovery().snapshot()):null;return {priorAccounting,current,...(journal?{originalCurrent,ownerCostAssumptions:[JSON.parse(journal.authorization_json)],grossCumulativeModelCostNanodollars:priorAccounting.modelCostNanodollars+originalCurrent.costNanodollars+activeRecovery.costNanodollars+attemptRows().filter(v=>v.row).reduce((n,v)=>n+v.row.cost,0)+usageRows().reduce((n,r)=>n+usageCost(r),0)}:{}),...(standing()?{failedReviewCostPolicy:JSON.parse(standing().authorization_json),failedReviewCostAssumptions:waivers().map(w=>({reservationKey:w.key,assumedEffectiveCostNanodollars:0,costEvidence:'owner-assumption; provider billed cost remains unknown',reservationNanodollars:w.reservation_nanodollars,identity:JSON.parse(w.identity_json)})),derivedTokenCeilings:{inputTokens:standing().derived_input_tokens,outputTokens:standing().derived_output_tokens,remainingRequestsAtAuthorization:standing().remaining_requests}}:{}),...(continuation()?{ownerContinuations:[{authority:JSON.parse(continuation().authorization_json),proof:JSON.parse(continuation().proof_json),activation:continuationActivation(),costEvidence:'owner-authorized full reserve retained; provider billed cost remains unknown'}],effectiveDeadlineAtMs:effectiveDeadline(current)}:{}),...(recoveries().length?{ownerRecoveries:recoveries().map(j=>({authority:JSON.parse(j.authorization_json),proof:JSON.parse(j.proof_json),activation:recoveryActivation(j),costEvidence:'owner-authorized full reserve retained; provider billed cost remains unknown'})),cumulativeBrowserCreditLimit:150}:{}),...(executionOverride()?{ownerExecutionOverride:JSON.parse(executionOverride().authorization_json),modelCostAdmissionLimitNanodollars:null,modelCostNotificationThresholdNanodollars:JSON.parse(executionOverride().authorization_json).modelCostNotificationThresholdNanodollars,reportedReceiptCostNanodollars:reportedReceiptCost(),costThresholdNotified:Boolean(db.prepare('SELECT notification_id FROM pipeline_cost_notifications').get()),costThresholdNotifications:db.prepare('SELECT * FROM pipeline_cost_notifications ORDER BY recorded_at_ms,notification_id').all(),unknownCostsAreEstimated:true}:{}),cumulativeModelCostLimitNanodollars:currentCostLimit(),cumulativeModelCostNanodollars:priorAccounting.modelCostNanodollars+(current?.costNanodollars??0),reservedBrowserCredits:priorAccounting.reservedBrowserCredits,preparationPaused:phases().some(p=>p.end_at_ms===null),physicalIntervals:phases(),remainingMilliseconds:current?Math.max(0,effectiveDeadline(current)-logicalNow()):1800000};},close(){if(!closed){closed=true;db.close();}}};
}
