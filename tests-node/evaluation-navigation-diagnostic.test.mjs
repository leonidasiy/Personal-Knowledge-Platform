import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isRuntimePolicy,advanceRuntimeContract,createRuntimeControl,runtimeStorageColumn} from '../scripts/evaluation-runtime-control.mjs';
import {createEvaluationLedger} from '../scripts/evaluation-budget.mjs';
import {isNavigationDiagnostic,verifyNavigationDiagnosticIteration} from '../scripts/evaluation-navigation-diagnostic.mjs';
// Constructed offline authority, captures and gate; never measured model output or a real independent PASS.
const sha=v=>createHash('sha256').update(v).digest('hex'),hash=v=>sha(JSON.stringify(v)),h='a'.repeat(64),other='b'.repeat(64);
const original={maximumRequests:1200,maximumInputTokens:3000000,maximumOutputTokens:3000000,maximumMilliseconds:10800000,maximumCostNanodollars:1000000000},decision={authority:'Synthetic offline test',source:'evaluation-navigation-diagnostic.test.mjs',decision:'TreatUSD1asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'navigation-proof-')),db=new DatabaseSync(join(dir,'canonical.sqlite'));
 const save=(name,value)=>{const source=join(dir,name),bytes=JSON.stringify(value);writeFileSync(source,bytes);return {source,sha256:sha(bytes)};};
 const clock={ownerAuthorized:true,ownerAnswer:'automatically reset it to 2 hours for each new benchmark run',durationMilliseconds:7200000,cumulativeCapNanodollars:5000000000,resetCounters:false,resetOriginalStart:false,retainAllUnknownReserves:true},timer=save('old-clock.json',clock),approval={ownerAuthorized:true,source:'synthetic-renewal',decision:'Renew90Minutes20AdditionalRecoveriesUSD5'},roles={source:'synthetic-approved-models'};
 const previous={version:2,source:'old-candidate',budgetId:'owner-approved-image-benchmark',predecessorSha256:h,codeSha256:h,modelsSha256:hash(roles),selectionSha256:h,originalGrantSha256:h,maximumCostNanodollars:5000000000,maximumMilliseconds:5400000,maximumWindowMilliseconds:1800000,maximumAdditionalRecoveries:20,renewal:{approval,approvalSha256:hash(approval),previousRuntimeSha256:h,pacing:{source:'synthetic-pacing',initialMilliseconds:2000,minimumIntervalMilliseconds:2000,errorBackoffMilliseconds:[1000,2000,4000,8000,16000,32000,60000],suspendAfter429:3},maximumWindows:3},lineage:{diagnosticDebitNanodollars:0,diagnosticChains:[{path:'one',sha256:h},{path:'two',sha256:other}],previousRecoveriesConsumed:9,previousRuntimeSha256:h},priorUnknowns:[{key:'unknown',estimatedDebitNanodollars:10,uncertaintyVersion:1}],requestExtension:{source:'synthetic-requests',sourceSha256:h,previousRuntimeSha256:h,previousMaximumRequests:1200,maximumRequests:2000},benchmarkIteration:{source:timer.source,sourceSha256:timer.sha256,previousRuntimeSha256:h,previousDeadlineAtMs:5401000,previousWindowCount:0,iterationId:'old',durationMilliseconds:7200000}};
 assert(isRuntimePolicy(previous));createEvaluationLedger({database:db,budgetId:previous.budgetId,policy:original,now:()=>1000,logger:()=>{},accountingMode:'estimated',ownerDecision:decision});
 const column=runtimeStorageColumn(previous);db.exec('ALTER TABLE evaluation_budgets ADD COLUMN '+column+' TEXT');db.exec('ALTER TABLE evaluation_reservations ADD COLUMN sanitized_envelope TEXT');
 db.prepare('INSERT INTO evaluation_reservations(budget_id,key,allowance,input_tokens,output_tokens,cost,response,uncertainty_version) VALUES(?,?,?,?,?,?,?,?)').run(previous.budgetId,'unknown','{}',1,1,10,null,1);
 const state={policy:previous,startedAtMs:1000,deadlineAtMs:7201000,lastNow:1000,windows:[{startedAtMs:1000,deadlineAtMs:1801000}],benchmarkIterationActivatedAtMs:1000,benchmarkIterationHistory:[{iterationId:'old',startedAtMs:1000,deadlineAtMs:7201000,sourceSha256:timer.sha256}],admissions:[],dispatches:[],halted:null,cancelled:false,pacing:{},predecessorReservations:db.prepare('SELECT * FROM evaluation_reservations').all(),predecessorBudget:db.prepare('SELECT * FROM evaluation_budgets').get(),contractHistory:[]};
 db.prepare('UPDATE evaluation_budgets SET '+column+'=?').run(JSON.stringify(state));
 const oldContract={runtimePolicy:previous,grant:{id:previous.budgetId,storePath:'synthetic-canonical-ledger'},roleProfiles:roles,costPolicy:{source:'synthetic-rates'},ownerDecision:decision},prior=save('previous.json',oldContract),url='https://example.org/tutorial/',rootCapture=save('root.json',{ok:true,value:{responseUrl:url,evidence:{url,blocks:[{id:'b',locator:'main',sectionId:'s',text:'Useful source content',kind:'text',figureId:null}],headings:[],images:[],warnings:[]},visibleLinks:[url+'one',url+'two']}}),driver=save('driver.json',{synthetic:true}),closedRun=save('closed.json',{cleanupConfirmed:true,code:0,signal:null,monitorFailure:null,failure:null,ownedPid:999999});
 const source=join(dir,'candidate.json'),owner={version:'navigation-diagnostic-v1',decision:'RunPublicNavigationPhaseDiagnostic',ownerAuthorized:true,recordsActualOwnerAnswer:true,ownerAnswer:'Synthetic request for a navigation phase test',freshHiddenCredit:false,contractSource:source,previousContract:prior,rootCapture,driver,closedRun,timingAuthority:timer,rootUrl:url,maximumPages:3,maximumModelRequests:20,startingReservations:1,cumulativeCapNanodollars:5000000000,maximumRequests:2000,resetCounters:false,resetOriginalStart:false,retainAllUnknownReserves:true},ownerRef=save('owner.json',owner),newTimer=save('clock.json',{...clock,navigationDiagnostic:ownerRef});
 const next={...structuredClone(previous),source,navigationDiagnostic:{source:ownerRef.source,sourceSha256:ownerRef.sha256,iterationId:'navigation',startingReservations:1,maximumRequests:20},benchmarkIteration:{...previous.benchmarkIteration,source:newTimer.source,sourceSha256:newTimer.sha256,previousRuntimeSha256:sha(JSON.stringify(state)),previousDeadlineAtMs:state.deadlineAtMs,previousWindowCount:1,iterationId:'navigation'}};
 const sourceFiles=Object.fromEntries([prior,rootCapture,driver,closedRun,timer,ownerRef,newTimer].map(ref=>[ref.source,ref.sha256]));next.codeSha256=hash(sourceFiles);
 const current={version:'navigation-phase-contract-v1',iterationId:'navigation',sourceFiles,runtimePolicy:next,grant:oldContract.grant,roleProfiles:roles,costPolicy:oldContract.costPolicy,ownerDecision:decision,navigationScope:{rootUrl:url,maximumPages:3,maximumModelRequests:20,selectedLinks:'two-observed-same-origin-path-links',rootCapture,driver,freshHiddenCredit:false}};
 writeFileSync(source,JSON.stringify(current));const review={verdict:'PASS',BLOCKING:'NONE',codeSha256:next.codeSha256,modelsSha256:next.modelsSha256,gateSha256:h};
 return {db,dir,save,previous,next,state,source,current,owner,ownerRef,driver,review,column,cleanup(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('diagnostic admission preserves all historical rows/limits; activation starts once and the canonical ledger rejects request21',()=>{
 const f=fixture();try{
  assert(isRuntimePolicy(f.next));assert.equal(verifyNavigationDiagnosticIteration(f.previous,f.next,f.db).freshHiddenCredit,false);
  const before=f.db.prepare('SELECT * FROM evaluation_reservations').all(),budget=f.db.prepare('SELECT * FROM evaluation_budgets').get();advanceRuntimeContract({database:f.db,previousPolicy:f.previous,nextPolicy:f.next,review:f.review});
  assert.deepEqual(f.db.prepare('SELECT * FROM evaluation_reservations').all(),before);assert.deepEqual({...f.db.prepare('SELECT * FROM evaluation_budgets').get(),[f.column]:null},{...budget,[f.column]:null});
  let now=7202000;const runtime=createRuntimeControl({database:f.db,policy:f.next,now:()=>now});runtime.activate();const first=runtime.snapshot();assert.equal(first.deadlineAtMs,now+7200000);assert.equal(first.benchmarkIterationHistory.length,2);now+=1000;runtime.activate();assert.equal(runtime.snapshot().deadlineAtMs,first.deadlineAtMs);
  const ledger=createEvaluationLedger({database:f.db,budgetId:f.next.budgetId,policy:original,runtimePolicy:f.next,now:()=>now,logger:()=>{},accountingMode:'estimated',ownerDecision:decision});
  for(let i=0;i<20;i++){now+=2001;const r=ledger.reserve({key:'navigation:'+i,inputTokens:1,outputTokens:1,costNanodollars:1,model:'synthetic/model'});assert.equal(r.ok,true,JSON.stringify(r));f.db.prepare('UPDATE evaluation_reservations SET response=? WHERE key=?').run('{}','navigation:'+i);}
  now+=2001;assert.deepEqual(ledger.reserve({key:'navigation:21',inputTokens:1,outputTokens:1,costNanodollars:1,model:'synthetic/model'}),{ok:false,error:{kind:'EvaluationBudgetExceeded'}});assert.equal(f.db.prepare('SELECT COUNT(*) n FROM evaluation_reservations').get().n,21);
  assert.deepEqual(f.db.prepare('SELECT * FROM evaluation_reservations WHERE key=?').get('unknown'),before[0]);assert.equal(f.next.maximumCostNanodollars,f.previous.maximumCostNanodollars);assert.equal(f.next.requestExtension.maximumRequests,2000);
 }finally{f.cleanup();}
});
test('diagnostic proof rejects changed scope, model authority, captured bytes and missing real gate atomically',()=>{
 const f=fixture();try{
  const baseline=f.db.prepare('SELECT '+f.column+' value FROM evaluation_budgets').get().value;
  for(const field of ['ownerAuthorized','recordsActualOwnerAnswer','retainAllUnknownReserves']){writeFileSync(f.ownerRef.source,JSON.stringify({...f.owner,[field]:false}));assert.throws(()=>verifyNavigationDiagnosticIteration(f.previous,f.next,f.db),/EvaluationNavigationDiagnosticInvalid/);}writeFileSync(f.ownerRef.source,JSON.stringify(f.owner));
  assert.throws(()=>advanceRuntimeContract({database:f.db,previousPolicy:f.previous,nextPolicy:f.next,review:{...f.review,verdict:'FAIL'}}),/EvaluationRuntimeReviewInvalid/);
  assert.throws(()=>verifyNavigationDiagnosticIteration(f.previous,{...f.next,modelsSha256:other},f.db),/retained models/);
  writeFileSync(f.driver.source,'changed');assert.throws(()=>verifyNavigationDiagnosticIteration(f.previous,f.next,f.db),/candidate source changed/);assert.equal(f.db.prepare('SELECT '+f.column+' value FROM evaluation_budgets').get().value,baseline);
 }finally{f.cleanup();}
});
test('diagnostic shape rejects extra permissions, excessive requests, duplicate iteration and fresh-ledger bootstrap',()=>{
 const f=fixture();try{
  assert.equal(isNavigationDiagnostic({...f.next.navigationDiagnostic,maximumRequests:21}),false);assert.equal(isNavigationDiagnostic({...f.next.navigationDiagnostic,resetCounters:true}),false);
  assert.throws(()=>advanceRuntimeContract({database:f.db,previousPolicy:f.previous,nextPolicy:{...f.next,benchmarkIteration:f.previous.benchmarkIteration},review:f.review}),/EvaluationRuntimeReviewInvalid|EvaluationNavigationDiagnosticInvalid/);
  const fresh=new DatabaseSync(':memory:');try{createEvaluationLedger({database:fresh,budgetId:f.next.budgetId,policy:original,now:()=>1000,logger:()=>{},accountingMode:'estimated',ownerDecision:decision});assert.throws(()=>createRuntimeControl({database:fresh,policy:f.next,now:()=>1000}),/requires existing grant advancement/);}finally{fresh.close();}
 }finally{f.cleanup();}
});

test('filesystem identity refresh binds the exact canonical database and all historical rows; rejects substituted identity',()=>{
 const f=fixture();try{
  const path=f.db.location(),stat=statSync(path),prior=JSON.parse(readFileSync(f.owner.previousContract.source)),grant={...prior.grant,storePath:path,device:stat.dev-1,inode:stat.ino-1};prior.grant=grant;writeFileSync(f.owner.previousContract.source,JSON.stringify(prior));f.owner.previousContract.sha256=sha(readFileSync(f.owner.previousContract.source));
  const summary=f.save('summary.json',{supervisorCleanupConfirmed:true,remainingRequests:1999,cumulativeCostUSD:0.00000001,remainingUSD:4.99999999}),result=f.save('result.json',{ok:true,value:{executionScope:'post-hoc-selected-case-retest',status:'completed',aggregateUsage:{requests:1,costNanodollars:10,activeRequests:0}}});
  const identity={version:'navigation-canonical-identity-v1',canonicalPath:path,previousDevice:grant.device,previousInode:grant.inode,device:stat.dev,inode:stat.ino,databaseSha256:sha(readFileSync(path)),budgetsSha256:hash(f.db.prepare('SELECT * FROM evaluation_budgets ORDER BY budget_id').all()),reservationsSha256:hash(f.db.prepare('SELECT * FROM evaluation_reservations ORDER BY budget_id,key').all()),sqliteSidecars:{'-wal':null,'-shm':null},closedSummary:summary,closedResult:result};
  const identityRef=f.save('identity.json',identity);f.owner.canonicalIdentity=identityRef;writeFileSync(f.ownerRef.source,JSON.stringify(f.owner));f.ownerRef.sha256=sha(readFileSync(f.ownerRef.source));f.next.navigationDiagnostic.sourceSha256=f.ownerRef.sha256;const timer=JSON.parse(readFileSync(f.next.benchmarkIteration.source));timer.navigationDiagnostic=f.ownerRef;writeFileSync(f.next.benchmarkIteration.source,JSON.stringify(timer));f.next.benchmarkIteration.sourceSha256=sha(readFileSync(f.next.benchmarkIteration.source));
  for(const ref of [f.owner.previousContract,f.ownerRef,identityRef,summary,result,{source:f.next.benchmarkIteration.source,sha256:f.next.benchmarkIteration.sourceSha256}])f.current.sourceFiles[ref.source]=ref.sha256;f.next.codeSha256=hash(f.current.sourceFiles);f.current.runtimePolicy=f.next;f.current.grant={...grant,device:stat.dev,inode:stat.ino};writeFileSync(f.source,JSON.stringify(f.current));
  assert.equal(verifyNavigationDiagnosticIteration(f.previous,f.next,f.db).freshHiddenCredit,false);
  f.current.grant.inode++;writeFileSync(f.source,JSON.stringify(f.current));assert.throws(()=>verifyNavigationDiagnosticIteration(f.previous,f.next,f.db),/restored canonical identity/);f.current.grant.inode--;f.current.grant.policy={newAuthority:true};writeFileSync(f.source,JSON.stringify(f.current));assert.throws(()=>verifyNavigationDiagnosticIteration(f.previous,f.next,f.db),/same accounting and model authority/);
 }finally{f.cleanup();}
});
