import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyDirectUnseenTenOwner,verifyDirectUnseenTenPrerequisites,directUnseenTenOwnerAnswer} from '../scripts/evaluation-unseen-ten-scope.ts';
const digest='a'.repeat(64),originalSelection={source:'original45.json',sha256:digest};
const previous={runtimePolicy:{selectionSha256:digest,maximumCostNanodollars:16e9,maximumAdditionalRecoveries:null,requestExtension:{maximumRequests:5000},inputTokenExtension:{maximumInputTokens:24e6},outputTokenExtension:{maximumOutputTokens:5e6},originalGrantSha256:digest,modelsSha256:digest,priorUnknowns:[]},grant:{policy:{}},roleProfiles:{fixture:true},reasoningSettings:{fixture:true},costPolicy:{fixture:true}};
const current=structuredClone(previous),selection={originalSelection};
const owner={version:'owner-direct-unseen-ten-v1',actualAuthor:'/root',recordsActualOwnerAnswer:true,ownerAuthorized:true,benchmarkOnly:true,newSpendingAuthority:false,ownerAnswer:directUnseenTenOwnerAnswer,caseCount:10,resetCounters:false,resetOriginalStart:false,retainAllUnknownReserves:true,previousContract:{source:'pending-contract.json',sha256:digest},previousRuntimeSha256:digest,originalSelection,cumulativeCapNanodollars:16e9,maximumRequests:5000,maximumInputTokens:24e6,maximumOutputTokens:5e6};
test('direct owner authorizes exactly ten without manufacturing prior qualification or new spending',()=>{
 const before=JSON.stringify({owner,current,previous});assert.equal(verifyDirectUnseenTenOwner(owner,selection,current,previous),owner);assert.equal(JSON.stringify({owner,current,previous}),before);
});
for(const [field,value] of [['ownerAnswer','unrecorded approval'],['caseCount',11],['newSpendingAuthority',true],['resetCounters',true],['retainAllUnknownReserves',false],['cumulativeCapNanodollars',17e9],['maximumRequests',6000],['maximumInputTokens',25e6],['maximumOutputTokens',6e6]])test(`direct authority rejects ${field}`,()=>{
 assert.throws(()=>verifyDirectUnseenTenOwner({...owner,[field]:value},selection,current,previous),/EvaluationUnseenTenProofInvalid/);
});
for(const field of ['maximumCostNanodollars','modelsSha256','priorUnknowns'])test(`direct scope cannot change existing ${field}`,()=>{
 const altered=structuredClone(current);altered.runtimePolicy[field]=field==='priorUnknowns'?[{key:'erased'}]:field==='modelsSha256'?'b'.repeat(64):17e9;assert.throws(()=>verifyDirectUnseenTenOwner(owner,selection,altered,previous),/direct retained policy/);
});
test('direct prerequisites require actual source-bound pending runtime and closed process proofs',()=>{
 assert.throws(()=>verifyDirectUnseenTenPrerequisites(selection,current,{version:'unseen-ten-direct-prerequisites-v1'}),/direct prerequisite shape/);
});

test('historical exposure supports older workflow schemas and keeps a frozen accounting origin across adoption',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,unlinkSync,realpathSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createHash}=await import('node:crypto');const {DatabaseSync}=await import('node:sqlite');
 const {collectExposureInventory}=await import('../scripts/evaluation-unseen-ten-scope.ts');
 const original=process.cwd(),temp=realpathSync(mkdtempSync(join(tmpdir(),'pkp-unseen-exposure-')));
 try{
  process.chdir(temp);const base='test-results/architecture-recovery/continued-repair',capture=base+'/blinded-unseen10-preparation-v1',annotation=base+'/blinded-unseen10-independent-annotation-v1',run=base+'/new-run';
  for(const p of [capture,annotation,run,base+'/history'])mkdirSync(p,{recursive:true});
  writeFileSync('source.js','project source');symlinkSync(join(temp,'source.js'),base+'/history/code-mirror');symlinkSync(join(temp,'tests-node/deleted.test.mjs'),base+'/history/deleted-test-mirror');
  const old=new DatabaseSync(base+'/history/legacy.sqlite');old.exec("CREATE TABLE knowledge_workflow_runs(source_id TEXT);INSERT INTO knowledge_workflow_runs VALUES('holdout-legacy')");old.close();
  const livePath=base+'/history/accounting.sqlite',ledger=new DatabaseSync(livePath);ledger.exec("CREATE TABLE evaluation_reservations(response TEXT);INSERT INTO evaluation_reservations VALUES('{\"url\":\"https://prior.example/source\"}')");ledger.close();
  const snapshot=run+'/previous-accounting.sqlite';writeFileSync(snapshot,readFileSync(livePath));const proof={source:snapshot,sha256:createHash('sha256').update(readFileSync(snapshot)).digest('hex')};
  const first=collectExposureInventory(capture,run,annotation,{livePath,snapshot:proof});assert.equal(first.issues.length,0);assert.equal(first.symbolicLinks.length,2);assert(first.caseIds.includes('holdout-legacy'));assert(first.urls.includes('https://prior.example/source'));assert(first.observedFiles.some(f=>f.path===snapshot));
  const changed=new DatabaseSync(livePath);changed.exec("INSERT INTO evaluation_reservations VALUES('{\"url\":\"https://new-hidden.example/source\"}')");changed.close();
  assert.deepEqual(collectExposureInventory(capture,run,annotation,{livePath,snapshot:proof}),first);
  symlinkSync(join(tmpdir(),'outside-project'),base+'/history/outside-link');assert.equal(collectExposureInventory(capture,run,annotation,{livePath,snapshot:proof}).issues.length,1);unlinkSync(base+'/history/outside-link');
  writeFileSync(proof.source,'changed');assert.throws(()=>collectExposureInventory(capture,run,annotation,{livePath,snapshot:proof}),/frozen previous accounting exposure/);
 }finally{process.chdir(original);rmSync(temp,{recursive:true,force:true});}
});
