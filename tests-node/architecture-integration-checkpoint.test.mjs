import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createIntegrationCheckpoint,hash} from '../scripts/architecture-integration-checkpoint.ts';
import {classifyEvaluationFailure,reportWholeCases} from '../scripts/webpage-image-evaluation.mjs';

function fixture(overrides={}){
 const db=new DatabaseSync(':memory:'),ledger=new DatabaseSync(':memory:'),iterationId='iteration',caseId='failed-case',contractHash='a'.repeat(64),key=iterationId+':'+caseId+':application:review-grader:'+ 'b'.repeat(64);
 ledger.exec('CREATE TABLE evaluation_reservations(key TEXT,cost INTEGER,response TEXT,uncertainty_version INTEGER);CREATE TABLE evaluation_budgets(budget_id TEXT,runtime_control TEXT)');
 ledger.prepare('INSERT INTO evaluation_reservations VALUES(?,?,NULL,0)').run(key,123);
 const cases=[{id:caseId,split:'development'},{id:'unattempted-case',split:'holdout'}],checkpoint=createIntegrationCheckpoint(db,iterationId,contractHash,cases,{database:ledger,iterationId,budgetId:'budget',resumeInterrupted:true});
 const row={caseId,split:'development',status:'timeout',passes:false,judgeResultRefs:[],terminalReason:'EvaluationDeadlineExceeded',terminalError:{kind:'EvaluationDeadlineExceeded',field:'request-timer-expired'},...overrides};
 const receipts=ledger.prepare('SELECT * FROM evaluation_reservations ORDER BY rowid').all();
 checkpoint.append('start:'+caseId,{caseId,split:'development'});checkpoint.append('case:'+caseId,row);checkpoint.append('receipts:'+caseId,receipts);
 const proof={key,cost:123,iterationId,caseId,checkpointContractHash:contractHash,terminalPayloadSha256:hash(JSON.stringify(row)),receiptPayloadSha256:hash(JSON.stringify(receipts)),proofSource:'fixture-proof.json',proofSha256:'c'.repeat(64),gateSha256:'d'.repeat(64)};
 const runtime={policy:{codeSha256:contractHash},admissions:[],closedPipelineFailures:[]};
 ledger.prepare('INSERT INTO evaluation_budgets VALUES(?,?)').run('budget',JSON.stringify(runtime));
 const save=()=>ledger.prepare('UPDATE evaluation_budgets SET runtime_control=?').run(JSON.stringify(runtime));
 const admit=()=>{runtime.closedPipelineFailures=[proof];runtime.admissions=[{key,cost:123,uncertaintyVersion:0,type:'pipeline-failed'}];save();};
 return {db,ledger,checkpoint,cases,row,proof,runtime,admit,save,caseId};
}

test('same-iteration code continuation retains the proof-bound original checkpoint hash',()=>{
 const f=fixture();try{
  f.admit();f.runtime.policy.codeSha256='f'.repeat(64);f.save();
  const resumed=createIntegrationCheckpoint(f.db,'iteration','f'.repeat(64),f.cases,{database:f.ledger,iterationId:'iteration',budgetId:'budget',resumeInterrupted:true});
  assert.equal(resumed.rows()[0].status,'failed');
  const inherited=createIntegrationCheckpoint(f.db,'iteration','a'.repeat(64),f.cases,{database:f.ledger,iterationId:'iteration',budgetId:'budget',resumeInterrupted:true});
  assert.equal(inherited.rows()[0].status,'failed');
  resumed.append('start:unattempted-case',{caseId:'unattempted-case',split:'holdout'});
  assert(f.db.prepare('SELECT contract_hash FROM integration_progress').all().every(r=>r.contract_hash==='a'.repeat(64)));
  assert.throws(()=>createIntegrationCheckpoint(f.db,'iteration','e'.repeat(64),f.cases,{database:f.ledger,iterationId:'iteration',budgetId:'budget'}),/IntegrationCheckpointConflict/);
  const other=createIntegrationCheckpoint(f.db,'other-iteration','f'.repeat(64),f.cases,{database:f.ledger,iterationId:'other-iteration',budgetId:'budget',resumeInterrupted:true});
  assert.deepEqual(other.rows(),[]);
 }finally{f.db.close();f.ledger.close();}
});

test('a changed checkpoint hash without an authenticated closed-failure journal stays rejected',()=>{
 const f=fixture();try{
  const resumed=createIntegrationCheckpoint(f.db,'iteration','f'.repeat(64),f.cases,{database:f.ledger,iterationId:'iteration',budgetId:'budget'});
  assert.throws(()=>resumed.rows(),/IntegrationCheckpointConflict/);
 }finally{f.db.close();f.ledger.close();}
});

test('closed pipeline failure becomes terminal without changing timeout, receipts, reserves or retrying the case',async()=>{
 const f=fixture();try{
  assert.deepEqual(f.checkpoint.rows(),[f.row]);
  const original=f.db.prepare('SELECT * FROM integration_progress ORDER BY phase').all(),reservations=f.ledger.prepare('SELECT * FROM evaluation_reservations').all();
  f.admit();const [failed]=f.checkpoint.rows();
  assert.equal(failed.status,'failed');assert.equal(failed.passes,false);
  assert.deepEqual(failed.terminalError,{kind:'EvaluationPipelineRecoveryAdmissionFailed',causeKind:'EvaluationRecoveryEvidenceInvalid'});
  assert.equal(classifyEvaluationFailure(failed.terminalError),'pipeline');
  assert.equal(reportWholeCases([f.cases[0]],[failed]).value.status,'completed');
  assert.deepEqual(f.checkpoint.read('case:'+f.caseId),f.row);
  assert.deepEqual(f.db.prepare("SELECT * FROM integration_progress WHERE phase NOT LIKE 'pipeline-failure-disposition:%' ORDER BY phase").all(),original);
  assert.deepEqual(f.ledger.prepare('SELECT * FROM evaluation_reservations').all(),reservations);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM integration_progress').get().n,original.length+1);
  assert.deepEqual(f.checkpoint.rows(),[failed]);
  assert.deepEqual(await f.checkpoint.countedBoundary.beforeCase({caseId:f.caseId,split:'development'}),{ok:false,error:{kind:'IntegrationCaseReplayForbidden'}});
  assert.deepEqual(await f.checkpoint.countedBoundary.beforeCase({caseId:'unattempted-case',split:'holdout'}),{ok:true,value:null});
 }finally{f.db.close();f.ledger.close();}
});

for(const change of ['terminal-hash','receipt-hash','contract-hash','proof-hash','gate-hash','cost','key','missing-admission','wrong-admission-type','wrong-version','duplicate-proof'])test(`pipeline disposition rejects ${change}`,()=>{
 const f=fixture();try{
  f.admit();
  if(change==='terminal-hash')f.proof.terminalPayloadSha256='e'.repeat(64);
  if(change==='receipt-hash')f.proof.receiptPayloadSha256='e'.repeat(64);
  if(change==='contract-hash')f.proof.checkpointContractHash='e'.repeat(64);
  if(change==='proof-hash')f.proof.proofSha256='invalid';
  if(change==='gate-hash')f.proof.gateSha256='invalid';
  if(change==='cost')f.proof.cost++;
  if(change==='key')f.proof.key='another-case-request';
  if(change==='missing-admission')f.runtime.admissions=[];
  if(change==='wrong-admission-type')f.runtime.admissions[0].type='external';
  if(change==='wrong-version')f.runtime.admissions[0].uncertaintyVersion=1;
  if(change==='duplicate-proof')f.runtime.closedPipelineFailures.push({...f.proof,key:'another'});
  f.save();assert.throws(()=>f.checkpoint.rows(),/IntegrationPipelineDispositionConflict/);
  assert.equal(f.checkpoint.read('pipeline-failure-disposition:'+f.caseId),null);
 }finally{f.db.close();f.ledger.close();}
});

test('persisted disposition cannot outlive or disagree with its financial proof',()=>{
 const f=fixture();try{
  f.admit();f.checkpoint.rows();f.proof.gateSha256='e'.repeat(64);f.save();
  assert.throws(()=>f.checkpoint.rows(),/IntegrationPipelineDispositionConflict/);
  f.runtime.closedPipelineFailures=[];f.save();
  assert.throws(()=>f.checkpoint.rows(),/IntegrationPipelineDispositionConflict/);
 }finally{f.db.close();f.ledger.close();}
});

for(const overrides of [{status:'failed'},{terminalError:{kind:'EvaluationDeadlineExceeded',field:'global-deadline'}},{judgeResultRefs:['existing-judge#sha256:'+ 'e'.repeat(64)]}])test('only the exactly bound request timeout can receive a pipeline disposition',()=>{
 const f=fixture(overrides);try{f.admit();assert.throws(()=>f.checkpoint.rows(),/IntegrationPipelineDispositionConflict/);}finally{f.db.close();f.ledger.close();}
});
