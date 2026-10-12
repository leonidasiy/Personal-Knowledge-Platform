import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isRuntimePolicy,advanceRuntimeContract,createRuntimeControl,runtimeStorageColumn} from '../scripts/evaluation-runtime-control.mjs';
import {createEvaluationLedger} from '../scripts/evaluation-budget.mjs';
// Entire state, source approvals and charges are constructed fixtures. No real gate or paid request.
const sha=v=>createHash('sha256').update(v).digest('hex'),hash=v=>sha(JSON.stringify(v)),h='a'.repeat(64),other='b'.repeat(64);
const ownerAnswer='you may increase the $5 cap to $8 automatically with my permission this time; continue running the benchmark and automatically reset the time limit for each new benchmark run';
const original={maximumRequests:1200,maximumInputTokens:3000000,maximumOutputTokens:3000000,maximumMilliseconds:10800000,maximumCostNanodollars:1000000000};
const decision={authority:'Synthetic offline approval',source:'evaluation-runtime-cost.test.mjs',decision:'TreatUSD1asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'};
function syntheticPolicy(){
 const approval={ownerAuthorized:true,source:'synthetic-renewal',decision:'Renew90Minutes20AdditionalRecoveriesUSD5'};
 return {version:2,source:'synthetic-code',budgetId:'owner-approved-image-benchmark',predecessorSha256:h,codeSha256:h,modelsSha256:h,selectionSha256:h,originalGrantSha256:h,maximumCostNanodollars:5000000000,maximumMilliseconds:5400000,maximumWindowMilliseconds:1800000,maximumAdditionalRecoveries:null,
  renewal:{approval,approvalSha256:hash(approval),previousRuntimeSha256:h,pacing:{source:'synthetic-pacing',initialMilliseconds:2000,minimumIntervalMilliseconds:2000,errorBackoffMilliseconds:[1000,2000,4000,8000,16000,32000,60000],suspendAfter429:3},maximumWindows:3},
  lineage:{diagnosticDebitNanodollars:100000000,diagnosticChains:[{path:'synthetic-diagnostic-one',sha256:h},{path:'synthetic-diagnostic-two',sha256:other}],previousRecoveriesConsumed:9,previousRuntimeSha256:h},
  continuation:{ownerAuthorized:true,source:'synthetic-continuation',decision:'DeepInfraMonitorRepairPreserveClock',previousRuntimeSha256:h,reconciliationSha256:h},
  recoveryPool:{ownerAuthorized:true,source:'synthetic-pool',predecessorStateSha256:h,previousLimit:20,previousUsed:18,additional:20},recoveryExtension:{source:'synthetic-recovery',sourceSha256:h,previousRuntimeSha256:h,previousMaximumRecoveries:40,previousRecoveriesUsed:40,maximumRecoveries:null},
  requestExtension:{source:'synthetic-requests',sourceSha256:h,previousRuntimeSha256:h,previousMaximumRequests:1200,maximumRequests:2000},inputTokenExtension:{source:'synthetic-input',sourceSha256:h,previousRuntimeSha256:h,previousMaximumInputTokens:3000000,maximumInputTokens:8000000},
  benchmarkIteration:{source:'synthetic-clock',sourceSha256:h,previousRuntimeSha256:h,previousDeadlineAtMs:5401000,previousWindowCount:0,iterationId:'synthetic-existing-run',durationMilliseconds:7200000},
  priorUnknowns:Array.from({length:24},(_,i)=>({key:'synthetic-unknown-'+i,estimatedDebitNanodollars:100000000,uncertaintyVersion:1}))};
}
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'runtime-cost-extension-')),db=new DatabaseSync(':memory:'),policy=syntheticPolicy();assert(isRuntimePolicy(policy));
 createEvaluationLedger({database:db,budgetId:policy.budgetId,policy:original,now:()=>1000,logger:()=>{},accountingMode:'estimated',ownerDecision:decision});
 const column=runtimeStorageColumn(policy);db.exec('ALTER TABLE evaluation_budgets ADD COLUMN '+column+' TEXT');db.exec('ALTER TABLE evaluation_reservations ADD COLUMN sanitized_envelope TEXT');
 for(const u of policy.priorUnknowns)db.prepare('INSERT INTO evaluation_reservations(budget_id,key,allowance,input_tokens,output_tokens,cost,response,uncertainty_version) VALUES(?,?,?,?,?,?,?,?)').run(policy.budgetId,u.key,JSON.stringify({key:u.key,inputTokens:1,outputTokens:1,costNanodollars:u.estimatedDebitNanodollars}),1,1,u.estimatedDebitNanodollars,null,1);
 db.prepare('INSERT INTO evaluation_reservations(budget_id,key,allowance,input_tokens,output_tokens,cost,response,uncertainty_version) VALUES(?,?,?,?,?,?,?,?)').run(policy.budgetId,'synthetic-paid',JSON.stringify({key:'synthetic-paid',inputTokens:1,outputTokens:1,costNanodollars:2500000000}),1,1,2500000000,JSON.stringify({output:{}}),0);
 const state={policy,benchmarkIterationActivatedAtMs:1000,benchmarkIterationHistory:[{iterationId:policy.benchmarkIteration.iterationId,startedAtMs:1000,deadlineAtMs:7201000,sourceSha256:h}],startedAtMs:1000,deadlineAtMs:7201000,lastNow:1000,windows:[{startedAtMs:1000,deadlineAtMs:1801000}],admissions:[{key:policy.priorUnknowns[0].key,cost:100000000,uncertaintyVersion:1,type:'external',retryAtMs:1000}],dispatches:[{key:'synthetic-original:recovery-1',sourceKey:policy.priorUnknowns[0].key,baseKey:'synthetic-original',attempt:1}],halted:null,cancelled:false,pacing:{},predecessorReservations:db.prepare('SELECT * FROM evaluation_reservations ORDER BY rowid').all(),predecessorBudget:db.prepare('SELECT * FROM evaluation_budgets').get(),contractHistory:[]};
 db.prepare('UPDATE evaluation_budgets SET '+column+'=?').run(JSON.stringify(state));
 const current=()=>db.prepare('SELECT '+column+' state FROM evaluation_budgets').get().state,beforeRows=db.prepare('SELECT * FROM evaluation_reservations ORDER BY rowid').all(),beforeBudget=db.prepare('SELECT * FROM evaluation_budgets').get();
 const approval={ownerAuthorized:true,benchmarkOnly:true,ownerAnswer,decision:'IncreaseBenchmarkCumulativeCapUSD5ToUSD8',previousMaximumCostNanodollars:5000000000,maximumCostNanodollars:8000000000,cumulativeCapNanodollars:8000000000,resetCounters:false,resetOriginalStart:false,retainAllUnknownReserves:true},source=join(directory,'owner-cost-approval.json');
 const proposal=async amendment=>{const value={...approval,...amendment},text=JSON.stringify(value);await writeFile(source,text);return {...structuredClone(policy),source:'synthetic-next-code',maximumCostNanodollars:8000000000,costExtension:{source,sourceSha256:sha(text),previousRuntimeSha256:sha(current()),previousMaximumCostNanodollars:5000000000,maximumCostNanodollars:8000000000}};};
 const advance=next=>advanceRuntimeContract({database:db,previousPolicy:policy,nextPolicy:next,review:{verdict:'PASS',BLOCKING:'NONE',codeSha256:next.codeSha256,modelsSha256:next.modelsSha256,gateSha256:h}});
 return {db,directory,column,policy,state,current,beforeRows,beforeBudget,proposal,advance,async close(){db.close();await rm(directory,{recursive:true,force:true});}};
}

test('source-bound cap-only transition preserves complete charges, reserves, counters, history and active clock; actual ledger reserves above5 and stops at8',async()=>{
 const f=await fixture();try{
  const oldLedger=createEvaluationLedger({database:f.db,budgetId:f.policy.budgetId,policy:original,runtimePolicy:f.policy,now:()=>1000,logger:()=>{},accountingMode:'estimated',ownerDecision:decision});
  assert.equal(oldLedger.snapshot().value.costNanodollars,5000000000);assert.deepEqual(oldLedger.reserve({key:'synthetic-before-extension',inputTokens:1,outputTokens:1,costNanodollars:1,model:'synthetic/model'}),{ok:false,error:{kind:'EvaluationBudgetExceeded',field:'costNanodollars'}});
  const next=await f.proposal();assert(isRuntimePolicy(next));f.advance(next);const after=JSON.parse(f.current());
  assert.deepEqual(f.db.prepare('SELECT * FROM evaluation_reservations ORDER BY rowid').all(),f.beforeRows);assert.deepEqual({...f.db.prepare('SELECT * FROM evaluation_budgets').get(),[f.column]:null},{...f.beforeBudget,[f.column]:null});
  assert.deepEqual({...after,policy:f.state.policy,contractHistory:f.state.contractHistory},JSON.parse(JSON.stringify(f.state)));assert.equal(after.contractHistory.length,1);assert.deepEqual(after.contractHistory[0].policy,f.policy);
  const ledger=createEvaluationLedger({database:f.db,budgetId:f.policy.budgetId,policy:original,runtimePolicy:next,now:()=>3000,logger:()=>{},accountingMode:'estimated',ownerDecision:decision});
  assert.equal(ledger.snapshot().value.costNanodollars,5000000000);assert.equal(ledger.snapshot().value.unresolvedRequests,24);const reserved=ledger.reserve({key:'synthetic-after-extension',inputTokens:1,outputTokens:1,costNanodollars:3000000000,model:'synthetic/model'});assert.equal(reserved.ok,true,JSON.stringify(reserved));
  const usage=ledger.snapshot().value;assert.equal(usage.costNanodollars,8000000000,'historical diagnostic debit and all24 unknown reserves remain included');assert.equal(usage.requests,26);assert.deepEqual(ledger.reserve({key:'synthetic-over-eight',inputTokens:1,outputTokens:1,costNanodollars:1,model:'synthetic/model'}),{ok:false,error:{kind:'EvaluationBudgetExceeded',field:'costNanodollars'}});
  assert.equal(JSON.parse(f.db.prepare('SELECT policy FROM evaluation_budgets').get().policy).maximumCostNanodollars,1000000000);assert.equal(next.requestExtension.maximumRequests,2000);assert.equal(next.inputTokenExtension.maximumInputTokens,8000000);assert.equal(original.maximumOutputTokens,3000000);assert.equal(next.maximumAdditionalRecoveries,null);
  const resumed=createRuntimeControl({database:f.db,policy:next,now:()=>4000});resumed.activate();const same=JSON.parse(f.current());assert.equal(same.benchmarkIterationActivatedAtMs,1000);assert.equal(same.deadlineAtMs,7201000);assert.equal(same.benchmarkIterationHistory.length,1);assert.equal(same.windows.length,1);
 }finally{await f.close();}
});
for(const [name,change] of Object.entries({missingOwner:{ownerAuthorized:false},wrongOwner:{ownerAnswer:'Unrelated permission'},wrongDecision:{decision:'Raise any cap'},wrongAmount:{maximumCostNanodollars:9000000000},resetCounters:{resetCounters:true},resetOriginalStart:{resetOriginalStart:true},dropReserves:{retainAllUnknownReserves:false}}))test(`cost transition rejects ${name} authorization atomically`,async()=>{const f=await fixture();try{const before=f.current(),next=await f.proposal(change);assert.throws(()=>f.advance(next),/EvaluationCostExtensionConflict/);assert.equal(f.current(),before);assert.deepEqual(f.db.prepare('SELECT * FROM evaluation_reservations ORDER BY rowid').all(),f.beforeRows);}finally{await f.close();}});
for(const mismatch of ['sourceSha256','previousRuntimeSha256'])test(`cost transition rejects stale ${mismatch} atomically`,async()=>{const f=await fixture();try{const before=f.current(),next=await f.proposal();next.costExtension[mismatch]=other;assert.throws(()=>f.advance(next),/EvaluationCostExtensionConflict/);assert.equal(f.current(),before);}finally{await f.close();}});
test('runtime8 requires exact fixed5→8 extension; direct policy/bootstrap, simultaneous clock/counter changes and active unadmitted requests fail',async()=>{
 const f=await fixture();try{
  assert.equal(isRuntimePolicy({...f.policy,maximumCostNanodollars:8000000000}),false);
  const next=await f.proposal();assert.equal(isRuntimePolicy({...next,maximumCostNanodollars:9000000000}),false);assert.equal(isRuntimePolicy({...next,costExtension:{...next.costExtension,previousMaximumCostNanodollars:8000000000}}),false);
  assert.throws(()=>f.advance({...next,requestExtension:{...next.requestExtension,maximumRequests:3000}}),/EvaluationRuntimeReviewInvalid/);
  assert.throws(()=>f.advance({...next,benchmarkIteration:{...next.benchmarkIteration,iterationId:'synthetic-new-run'}}),/EvaluationCostExtensionConflict/);
  f.db.prepare('INSERT INTO evaluation_reservations(budget_id,key,allowance,input_tokens,output_tokens,cost,response) VALUES(?,?,?,?,?,?,NULL)').run(f.policy.budgetId,'synthetic-active','{}',1,1,1);const live=await f.proposal();assert.throws(()=>f.advance(live),/EvaluationBenchmarkRequestActive/);
  const boot=new DatabaseSync(':memory:');try{createEvaluationLedger({database:boot,budgetId:f.policy.budgetId,policy:original,now:()=>1000,logger:()=>{},accountingMode:'estimated',ownerDecision:decision});assert.throws(()=>createRuntimeControl({database:boot,policy:next,now:()=>1000}),/EvaluationRequestExtensionConflict|EvaluationCostExtensionConflict/);}finally{boot.close();}
 }finally{await f.close();}
});
