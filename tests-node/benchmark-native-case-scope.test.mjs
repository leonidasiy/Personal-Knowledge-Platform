import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openReviewedBenchmark,REVIEWED_PIPELINE} from '../scripts/benchmark-reviewed-runtime.mjs';
import {openPositiveStorage} from '../scripts/architecture-live-positive.mjs';
import {D1KnowledgeContentRepository,D1QuizRepository} from '../worker/knowledge-workflow-content-d1.js';
import {assembleQuizPair,quizPairStableId} from '../src/features/knowledge-workflows/quiz-pair.js';
import {readFrozenEvaluationCatalog} from './fixtures/evaluation/catalog.mjs';
import {createSyntheticEvaluationFixture} from './fixtures/evaluation/synthetic.mjs';

import {randomUUID} from 'node:crypto';
import {createKnowledgeWorkflowService} from '../src/features/knowledge-workflows/workflow.js';
import {D1KnowledgeWorkflowRepository} from '../worker/knowledge-workflow-d1.js';
import {D1WorkflowStageRepository} from '../worker/knowledge-workflow-stages-d1.js';
// Constructed storage/session regression only; no generated content, paid call or model-accuracy claim.
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'reviewed-case-scope-')),now=()=>Date.parse('2026-10-09T00:00:00Z'),nowIso=()=>new Date(now()).toISOString();
 const {config,corpus}=createSyntheticEvaluationFixture(),catalog=await readFrozenEvaluationCatalog(),reviewer=structuredClone(catalog);reviewer.model.id='synthetic/reviewer';reviewer.model.canonical_slug='synthetic/reviewer-v1';
 const protocol={source:'synthetic offline protocol',responseFormat:'json_schema',reasoningEffort:'high',receiptOptional:true,provider:{sort:'throughput',require_parameters:true,allow_fallbacks:true}},profiles={source:'synthetic offline role fixture',roles:{'knowledge-scraper':{catalog,version:catalog.model.canonical_slug,protocol},'review-grader':{catalog:reviewer,version:reviewer.model.canonical_slug,protocol}}};
 const file='scripts/benchmark-reviewed-runtime.mjs',contract={pipelineMode:REVIEWED_PIPELINE,directory,iterationId:'synthetic-iteration',grant:{id:'synthetic-grant'},sourceFiles:{[file]:createHash('sha256').update(await readFile(file)).digest('hex')}},roleDependencies={profiles,apiKey:null,modelConfig:{...config.model,name:catalog.model.id},transport:{fetch:async()=>assert.fail('offline test must not call a model')},costPolicy:{source:'synthetic offline policy',bytesPerToken:4,visualTokensPerImage:8000}};
 let application=await openReviewedBenchmark({contract,roleDependencies,imagePolicy:config.imagePolicy,now});const storage=await openPositiveStorage({directory:application.directory});
 return {application,storage,contract,roleDependencies,config,corpus,now,nowIso,legacyOwner:contract.grant.id+':application:'+contract.iterationId,async reopen(){await application.close();application=await openReviewedBenchmark({contract,roleDependencies,imagePolicy:config.imagePolicy,now});this.application=application;},async close(){await application.close();await storage.close();await rm(directory,{recursive:true,force:true});}};
}
function caseAt(f,id,url,text){const item=structuredClone(f.corpus.cases[0]);item.id=id;item.input.evidence.url=url;item.input.material={kind:'pdf-text',fileName:'same-book.pdf',text,pageStart:1,pageEnd:2};return item;}
function registerLegacy(f,item){const url=item.input.evidence.url;f.storage.sqlite.prepare('INSERT INTO library_sources (owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(f.legacyOwner,item.id,url,url,item.id,'synthetic registration','{}',JSON.stringify({source:'captured-benchmark',caseId:item.id,url}),'active',f.nowIso(),f.nowIso(),1);}
test('distinct material cases share their exact canonical URL with isolated native owners and idempotent reopen',async()=>{
 const f=await fixture();try{
  const url='https://people.hsc.edu/faculty-staff/blins/books/openintrostats4e.pdf',a=caseAt(f,'holdout-pdf-text-003',url,'First selected section.'),b=caseAt(f,'holdout-pdf-text-007',url,'Different selected section.'),ar=(await f.application.forCase(a)).run,br=(await f.application.forCase(b)).run;
  assert.equal(ar.ownerId,f.legacyOwner+':case:'+a.id);assert.equal(br.ownerId,f.legacyOwner+':case:'+b.id);assert.notEqual(ar.ownerId,br.ownerId);assert.notEqual(ar.runId,br.runId);assert.notEqual(ar.contentSignature,br.contentSignature);assert.equal(ar.sourceId,a.id);assert.equal(br.sourceId,b.id);assert.equal(ar.canonicalSourceIdentity,url);assert.equal(br.canonicalSourceIdentity,url);
  const content=new D1KnowledgeContentRepository({database:f.storage.database,logger:()=>{}}),stages=new D1WorkflowStageRepository({database:f.storage.database,now:f.nowIso});let calls=0;
  for(const [item,run] of [[a,ar],[b,br]]){
   const point={id:'same-knowledge-id',sourceId:item.id,sourceRevision:1,summary:item.input.material.text,normalizedHash:item.id,evidenceAnchors:[{url,selector:item.id}],coverageGoalIds:[],mediaCandidates:[],attribution:{sourceUrl:url},extractionVersion:'synthetic'};assert.deepEqual(await content.appendKnowledgePoint(point,run.ownerId,run.runId,f.nowIso()),{ok:true,value:null});
   assert.deepEqual(await stages.run(run,'same-stage-key','same-input',async()=>{calls++;return {ok:true,value:item.id};}),{ok:true,value:item.id});
  }
  assert.equal(calls,2);const sources=f.storage.sqlite.prepare('SELECT * FROM library_sources ORDER BY source_id').all();assert.equal(sources.length,2);assert(sources.every(s=>s.canonical_url===url&&s.submitted_url===url&&JSON.parse(s.identity_evidence_json).url===url));
  assert.throws(()=>f.storage.sqlite.prepare('INSERT INTO library_sources SELECT owner_id,?,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision FROM library_sources WHERE owner_id=?').run('duplicate-within-one-owner',ar.ownerId),/UNIQUE constraint failed: library_sources.owner_id, library_sources.canonical_url/);
  await f.reopen();for(const [item,run] of [[a,ar],[b,br]]){const reopened=(await f.application.forCase(item)).run;assert.equal(reopened.ownerId,run.ownerId);assert.equal(reopened.runId,run.runId);const points=await f.application.list(item);assert.equal(points.ok,true);assert.equal(points.value.length,1);assert.equal(points.value[0].sourceId,item.id);assert.deepEqual(await stages.run(reopened,'same-stage-key','same-input',async()=>assert.fail('completed native stage must not retry')),{ok:true,value:item.id});}
  assert.deepEqual(f.storage.sqlite.prepare('SELECT * FROM library_sources ORDER BY source_id').all(),sources);assert.equal(f.storage.sqlite.prepare('SELECT count(*) n FROM knowledge_workflow_runs').get().n,2);assert.deepEqual(f.storage.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{await f.close();}
});
test('historical legacy run, completed extraction and protected claim retain exact owner and durable state',async()=>{
 const f=await fixture();try{
  const item=caseAt(f,'legacy-case','https://example.org/legacy','Prior captured material.'),probe=(await f.application.forCase(caseAt(f,'probe','https://example.org/probe','probe'))).run;registerLegacy(f,item);
  const service=createKnowledgeWorkflowService(new D1KnowledgeWorkflowRepository({database:f.storage.database,logger:()=>{}}),{now:f.nowIso,createId:randomUUID,logger:()=>{}}),created=await service.createRun({ownerId:f.legacyOwner,sourceId:item.id,sourceRevision:1,canonicalSourceIdentity:item.input.evidence.url,contentSignature:'sha256:'+createHash('sha256').update(JSON.stringify(item.input)).digest('hex'),idempotencyKey:f.contract.iterationId+':reviewed:'+item.id,configDigests:probe.configDigests});assert.equal(created.ok,true);let run=created.value.run;
  for(const nextState of ['rights-assessment','robots-check','extraction-loop']){const result=await service.advance({ownerId:run.ownerId,runId:run.runId,expectedRevision:run.revision,nextState});assert.equal(result.ok,true);run=result.value;}
  const stages=new D1WorkflowStageRepository({database:f.storage.database,now:f.nowIso});assert.deepEqual(await stages.run(run,'reviewed-benchmark-extraction','legacy-extraction',async()=>({ok:true,value:{facts:['retained synthetic receipt']}})),{ok:true,value:{facts:['retained synthetic receipt']}});
  f.storage.sqlite.prepare("INSERT INTO knowledge_workflow_stages(owner_id,run_id,stage_key,input_digest,status,created_at) VALUES(?,?,?,?,'claimed',?)").run(run.ownerId,run.runId,'question-evaluator:quiz-evaluator-protected','legacy-model-input',f.nowIso());
  const beforeRun=f.storage.sqlite.prepare('SELECT * FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=?').get(run.ownerId,run.runId),beforeStages=f.storage.sqlite.prepare('SELECT * FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? ORDER BY stage_key').all(run.ownerId,run.runId),beforeSource=f.storage.sqlite.prepare('SELECT * FROM library_sources WHERE owner_id=? AND source_id=?').get(run.ownerId,item.id);
  await f.reopen();const resumed=(await f.application.forCase(item)).run;assert.equal(resumed.ownerId,f.legacyOwner);assert.equal(resumed.runId,run.runId);assert.deepEqual(f.storage.sqlite.prepare('SELECT * FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=?').get(run.ownerId,run.runId),beforeRun);assert.deepEqual(f.storage.sqlite.prepare('SELECT * FROM library_sources WHERE owner_id=? AND source_id=?').get(run.ownerId,item.id),beforeSource);assert.deepEqual(await stages.run(resumed,'question-evaluator:quiz-evaluator-protected','legacy-model-input',async()=>assert.fail('unproven legacy claim must remain protected')),{ok:false,error:{kind:'WorkflowStageCallUncertain'}});assert.deepEqual(f.storage.sqlite.prepare('SELECT * FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? ORDER BY stage_key').all(run.ownerId,run.runId),beforeStages);
 }finally{await f.close();}
});
test('registered legacy source without a run keeps its original owner when its native run starts',async()=>{
 const f=await fixture();try{const item=caseAt(f,'legacy-source-only','https://example.org/source-only','Original material.');registerLegacy(f,item);const before=f.storage.sqlite.prepare('SELECT * FROM library_sources WHERE owner_id=? AND source_id=?').get(f.legacyOwner,item.id),run=(await f.application.forCase(item)).run;assert.equal(run.ownerId,f.legacyOwner);assert.deepEqual(f.storage.sqlite.prepare('SELECT * FROM library_sources WHERE owner_id=? AND source_id=?').get(f.legacyOwner,item.id),before);await f.reopen();assert.equal((await f.application.forCase(item)).run.runId,run.runId);}finally{await f.close();}
});
