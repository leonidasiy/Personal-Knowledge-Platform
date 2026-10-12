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

// Constructed storage regression only; no source-derived output or model accuracy claim.
test('real reviewed adapter registers the Library parent needed by quiz publication and reopens idempotently',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reviewed-source-registration-'));
 const now=()=>Date.parse('2026-10-09T00:00:00Z'),nowIso=()=>new Date(now()).toISOString();
 const {config,corpus}=createSyntheticEvaluationFixture(),item=corpus.cases[0],catalog=await readFrozenEvaluationCatalog();
 const reviewer=structuredClone(catalog);reviewer.model.id='synthetic/reviewer';reviewer.model.canonical_slug='synthetic/reviewer-v1';
 const protocol={source:'synthetic offline protocol',responseFormat:'json_schema',reasoningEffort:'high',receiptOptional:true,provider:{sort:'throughput',require_parameters:true,allow_fallbacks:true}};
 const profiles={source:'synthetic offline role fixture',roles:{'knowledge-scraper':{catalog,version:catalog.model.canonical_slug,protocol},'review-grader':{catalog:reviewer,version:reviewer.model.canonical_slug,protocol}}};
 const file='scripts/benchmark-reviewed-runtime.mjs',contract={pipelineMode:REVIEWED_PIPELINE,directory,iterationId:'synthetic-iteration',grant:{id:'synthetic-grant'},sourceFiles:{[file]:createHash('sha256').update(await readFile(file)).digest('hex')}};
 const roleDependencies={profiles,apiKey:null,modelConfig:{...config.model,name:catalog.model.id},transport:{fetch:async()=>assert.fail('offline test must not call a model')},costPolicy:{source:'synthetic offline policy',bytesPerToken:4,visualTokensPerImage:8000}};
 let application,storage;
 try{
  application=await openReviewedBenchmark({contract,roleDependencies,imagePolicy:config.imagePolicy,now});
  const session=await application.forCase(item),run=session.run;
  storage=await openPositiveStorage({directory:application.directory});
  assert.equal(storage.sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  assert(storage.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='knowledge_workflow_stages'").get());
  const point={id:'synthetic-point',sourceId:item.id,sourceRevision:1,summary:'A cadence closes a phrase.',normalizedHash:'cadence',evidenceAnchors:[{url:item.input.evidence.url,selector:'p'}],coverageGoalIds:[],mediaCandidates:[],attribution:{sourceUrl:item.input.evidence.url},extractionVersion:'synthetic-offline-fixture'};
  const content=new D1KnowledgeContentRepository({database:storage.database,logger:()=>{}});
  assert.deepEqual(await content.appendKnowledgePoint(point,run.ownerId,run.runId,nowIso()),{ok:true,value:null});
  const pair=assembleQuizPair({knowledgeId:point.id,knowledgeRevision:1,canonicalAnswers:['Cadence'],citedEvidenceUrls:[item.input.evidence.url],multipleChoice:{prompt:'What closes a phrase?',options:[{key:'A',text:'Cadence'},{key:'B',text:'Pickup'}],correctOptionKeys:['A'],correctOptionAnswers:[{key:'A',canonicalAnswer:'Cadence'}],explanation:'A cadence closes the phrase.'},fillBlank:{prompt:'A ____ closes a phrase.',blanks:[{id:'blank-1',canonicalAnswer:'Cadence',acceptedAnswers:['Cadence']}],explanation:'A cadence closes the phrase.'}},quizPairStableId({sourceId:point.sourceId,knowledgeId:point.id,revision:1}));
  const draft={id:pair.multipleChoice.id,knowledgeId:point.id,knowledgeRevision:1,kind:pair.multipleChoice.kind,prompt:pair.multipleChoice.prompt,options:pair.multipleChoice.options.map(option=>option.text),answer:'Cadence',explanation:pair.multipleChoice.explanation,citedEvidenceUrls:pair.citedEvidenceUrls,pairedQuiz:{...pair,canonicalAnswers:pair.fillBlank.canonicalAnswers}};
  const repository=new D1QuizRepository({database:storage.database,now:nowIso,logger:()=>{}});
  const result=await repository.publish({ownerId:run.ownerId,runId:run.runId,knowledge:point,draft,score:9,attempt:1,status:'published'});
  assert.deepEqual(result,{ok:true,value:null});
  const source=storage.sqlite.prepare('SELECT * FROM library_sources WHERE owner_id=? AND source_id=?').get(run.ownerId,item.id);
  assert.equal(source.canonical_url,item.input.evidence.url);assert.equal(source.submitted_url,item.input.evidence.url);assert.equal(source.revision,1);assert.equal(source.state,'active');
  for(const table of ['knowledge_workflow_quizzes','learning_generation_jobs','learning_generation_units','learning_generation_tasks'])assert.equal(storage.sqlite.prepare('SELECT count(*) count FROM '+table+' WHERE owner_id=?').get(run.ownerId).count,1,table);
  assert.deepEqual(storage.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  await application.close();application=await openReviewedBenchmark({contract,roleDependencies,imagePolicy:config.imagePolicy,now});
  const reopened=await application.forCase(item);assert.equal(reopened.run.runId,run.runId);
  assert.deepEqual(storage.sqlite.prepare('SELECT * FROM library_sources WHERE owner_id=? AND source_id=?').get(run.ownerId,item.id),source);
  assert.equal(storage.sqlite.prepare('SELECT count(*) count FROM library_sources WHERE owner_id=?').get(run.ownerId).count,1);
  assert.deepEqual(await repository.findPublished({ownerId:run.ownerId,runId:run.runId,knowledgeId:point.id}),{ok:true,value:{status:'published',attempt:1}});
 }finally{await application?.close();await storage?.close();await rm(directory,{recursive:true,force:true});}
});
