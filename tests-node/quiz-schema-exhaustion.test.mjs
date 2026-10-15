import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuizActorCritic} from '../src/features/knowledge-workflows/quiz.js';
import {normalizeQuizPairDraftAliases,quizPairSchema,validateQuizPairDraft} from '../src/features/knowledge-workflows/quiz-pair.js';
import {classifyEvaluationFailure,isTerminalPipelineFailure,reportWholeCases,runEvaluation} from '../scripts/webpage-image-evaluation.mjs';
import {createSyntheticSelectedEvaluationFixture} from './fixtures/evaluation/synthetic-selected.mjs';
import {readFrozenEvaluationCatalog} from './fixtures/evaluation/catalog.mjs';
import {createEvaluationLedger} from '../scripts/evaluation-budget.mjs';
import {DatabaseSync} from 'node:sqlite';
const ok=value=>({ok:true,value});
const point=id=>({id,sourceId:'synthetic',sourceRevision:1,summary:'The constructed source teaches a relation.',normalizedHash:id,coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{url:'https://synthetic.invalid',selector:'p'}]});
const draft=p=>({id:'draft:'+p.id,knowledgeId:p.id,knowledgeRevision:1,kind:'single-choice',prompt:'Which constructed relation?',options:['relation','alternative'],answer:'relation',explanation:'Constructed support.',citedEvidenceUrls:['https://synthetic.invalid']});
function fixture({maxAttempts=2,generate,evaluate=async()=>ok({score:9,reasons:['Constructed support.'],feedback:'Keep.',groundingProblems:[]})}) {
 const generated=[],evaluated=[],attempts=[],discarded=[],published=[];
 const actor=createQuizActorCritic({maxAttempts,now:()=> '2026-10-12T00:00:00.000Z',logger:()=>{},generator:{generate:async input=>{generated.push(input);return generate(input);}},reviewer:{evaluate:async input=>{evaluated.push(input);return evaluate(input);}},repository:{findPublished:async()=>ok(null),appendAttempt:async a=>{attempts.push(a);return ok(null);},publish:async p=>{published.push(p);return ok(null);},discard:async d=>{discarded.push(d);return ok(null);},purge:async()=>ok(null)}});
 return {actor,generated,evaluated,attempts,discarded,published};
}
test('flat required schema retains complete pair and strict missing-field/count boundaries',()=>{
 const s=quizPairSchema(true);assert.equal(s.name,'paired_quiz_v3');assert.equal(s.schema.anyOf,undefined);assert.equal(s.schema.allOf,undefined);assert.deepEqual(s.schema.required,['knowledgeId','knowledgeRevision','canonicalAnswers','citedEvidenceUrls','multipleChoice','fillBlank']);
 const partial={canonicalAnswers:['relation'],fillBlank:{blanks:[{id:'blank-1',canonicalAnswer:'relation',acceptedAnswers:['relation']}]}};assert.equal(validateQuizPairDraft(partial),false);assert.equal(normalizeQuizPairDraftAliases(partial),partial);assert.equal(partial.multipleChoice,undefined);
});
for(const mode of ['typed-schema','raw-invalid'])test(`${mode} exhausts four technical attempts without quality disposition or removal`,async()=>{
 const f=fixture({generate:async()=>mode==='typed-schema'?{ok:false,error:{kind:'QuizDraftSchemaInvalid'}}:ok({})});const result=await f.actor.run({ownerId:'owner',runId:'run',points:['a','b','c'].map(point)});
 assert.deepEqual(result,{ok:false,error:{kind:'QuizDraftSchemaInvalid',technicalRetriesExhausted:true,technicalAttempts:4}});assert.equal(f.generated.length,4);assert.equal(f.attempts.length,0);assert.equal(f.discarded.length,0);assert.deepEqual(f.generated.map(x=>[x.attempt,x.technicalAttempt]),[[1,1],[1,2],[1,3],[1,4]]);assert.equal(f.evaluated.length,0);assert.equal(f.published.length,0);assert.equal(classifyEvaluationFailure(result.error),'pipeline');assert(isTerminalPipelineFailure(result.error,{activeRequests:0}));
});
test('a valid second draft with semantic rejection stays a semantic abandonment',async()=>{
 const f=fixture({generate:async input=>input.attempt===1&&input.technicalAttempt===1?{ok:false,error:{kind:'QuizDraftSchemaInvalid'}}:ok(draft(input.knowledge)),evaluate:async()=>ok({score:5,reasons:['Constructed semantic issue.'],feedback:'Revise the relation.',groundingProblems:['Constructed ambiguity.']})});const result=await f.actor.run({ownerId:'owner',runId:'run',points:[point('a')]});assert(result.ok);assert.equal(result.value.dispositions[0].failureKind,'QuizScoreBelowThreshold');assert.equal(f.generated.length,3);assert.equal(f.evaluated.length,2);
});
test('a well-formed source-conflicting quiz remains grounded negative without typed generator failure',async()=>{
 const p=point('a');const f=fixture({generate:async input=>ok(draft(input.knowledge)),evaluate:async()=>ok({score:9,reasons:['Captured source conflict.'],feedback:'The point conflicts with supplied support.',groundingProblems:[],knowledgeGroundingProblems:['The supplied point conflicts with its source.']})});const result=await f.actor.run({ownerId:'owner',runId:'run',points:[p]});assert(result.ok);assert.equal(result.value.dispositions[0].failureKind,'QuizKnowledgeUngrounded');assert.equal(f.generated.length,1);assert.equal(f.evaluated.length,1);assert.equal(f.published.length,0);
});
test('mixed successful publication and schema exhaustion preserves the valid publication and dispositions',async()=>{
 const f=fixture({generate:async input=>input.knowledge.id==='bad'?{ok:false,error:{kind:'QuizDraftSchemaInvalid'}}:ok(draft(input.knowledge))});const result=await f.actor.run({ownerId:'owner',runId:'run',points:[point('good'),point('bad')]});assert.equal(result.ok,false);assert.equal(result.error.kind,'QuizDraftSchemaInvalid');assert.equal(result.error.technicalRetriesExhausted,true);assert.equal(f.generated.length,5);assert.equal(f.published.length,1);assert.equal(f.attempts.length,1);assert.equal(f.discarded.length,0);
});
test('legacy quality limit still retains knowledge after four technical failures',async()=>{
 const f=fixture({maxAttempts:3,generate:async()=>({ok:false,error:{kind:'QuizDraftSchemaInvalid'}})});const result=await f.actor.run({ownerId:'owner',runId:'run',points:[point('a')]});assert.equal(result.ok,false);assert.equal(result.error.technicalAttempts,4);assert.equal(f.generated.length,4);assert.equal(f.discarded.length,0);assert.equal(f.attempts.length,0);
});
test('actual selected orchestration marks settled quiz schema exhaustion failed once and continues later cases',async()=>{
 const {config,corpus,negativeTargets,selectedRun}=createSyntheticSelectedEvaluationFixture(),catalog=await readFrozenEvaluationCatalog(),db=new DatabaseSync(':memory:'),calls=[];
 const ownerDecision={authority:'synthetic fixture; no actual spend',source:'quiz-schema-exhaustion.test.mjs',decision:'TreatUSD1asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'};
 const ledger=createEvaluationLedger({database:db,budgetId:'owner-approved-image-benchmark',policy:config.budget,now:()=>1000,logger:()=>{},accountingMode:'estimated',ownerDecision});
 try {
  const result=await runEvaluation({config,corpus,negativeTargets,selectedRun,catalog,ledger,mode:'estimated',ownerDecision,iterationId:'synthetic',now:()=>1000,logger:()=>{},signal:new AbortController().signal,requestPlanner:async()=>assert.fail('no paid planning'),database:{prepare:()=>assert.fail('no application database')},scope:{ownerId:'synthetic',runId:'synthetic'},allowNetwork:true,budgetAuthorized:true,apiKey:'synthetic-not-a-credential',fetch:async()=>assert.fail('no external call'),reviewedApplication:{extract:async({item})=>{calls.push(item.id);return ok({predictions:[]});},quiz:async item=>{const f=fixture({generate:async()=>({ok:false,error:{kind:'QuizDraftSchemaInvalid'}})});const result=await f.actor.run({ownerId:'owner',runId:item.id,points:[point(item.id)]});assert.equal(f.generated.length,4);return result;},current:async()=>assert.fail('failed generator must not reach source judge')}});
  assert(result.ok,JSON.stringify(result.error));const rows=result.value.wholeCaseReport.rows;assert.equal(rows.length,45);assert(rows.every(r=>r.status==='failed'&&!r.passes&&r.terminalReason==='QuizDraftSchemaInvalid'&&r.terminalError.technicalRetriesExhausted===true&&r.terminalError.technicalAttempts===4&&r.judgeResultRefs.length===0));assert.equal(calls.length,45);assert.equal(new Set(calls).size,45);assert.equal(ledger.snapshot().value.requests,0);
 }finally{db.close();}
});

test('mixed transport and format faults share four technical calls while quality revisions remain separate',async()=>{
 const f=fixture({generate:async input=>{
  if(input.attempt===1){if(input.technicalAttempt===1)return {ok:false,error:{kind:'KnowledgeModelTimeout'}};if(input.technicalAttempt===2)return ok({});if(input.technicalAttempt===3)return {ok:false,error:{kind:'KnowledgeModelRejected',status:503}};}
  if(input.attempt===2&&input.technicalAttempt===1)return ok({});
  return ok(draft(input.knowledge));
 },evaluate:async input=>{
  if(input.attempt===1){if(input.technicalAttempt===1)return ok({score:9});if(input.technicalAttempt===2)return {ok:false,error:{kind:'KnowledgeModelUnavailable'}};return ok({score:5,reasons:['Synthetic quality defect.'],feedback:'Revise this relationship.',groundingProblems:[]});}
  return ok({score:9,reasons:['Synthetic supported revision.'],feedback:'Keep.',groundingProblems:[]});
 }});
 const result=await f.actor.run({ownerId:'owner',runId:'mixed',points:[point('a')]});assert(result.ok);assert.equal(result.value.dispositions[0].attempts,2);
 assert.deepEqual(f.generated.map(x=>[x.attempt,x.technicalAttempt]),[[1,1],[1,2],[1,3],[1,4],[2,1],[2,2]]);
 assert.deepEqual(f.evaluated.map(x=>[x.attempt,x.technicalAttempt]),[[1,1],[1,2],[1,3],[2,1]]);
 assert(!f.evaluated[0].rubric.includes('Previous response'));assert.match(f.evaluated[1].rubric,/Previous response failed format validation/);assert.match(f.evaluated[1].rubric,/unchanged draft/);assert.equal(f.evaluated[0].draft,f.evaluated[1].draft);assert.equal(f.evaluated[1].draft,f.evaluated[2].draft);
 assert.deepEqual(f.attempts.map(x=>[x.attempt,x.score]),[[1,5],[2,9]]);assert.equal(f.published.length,1);assert.equal(f.discarded.length,0);assert.equal(f.generated[4].feedback,'Revise this relationship.');assert.match(f.generated[5].feedback,/Revise this relationship/);assert.match(f.generated[5].feedback,/Regenerate a schema-valid draft/);
});
test('critic technical exhaustion retains the same valid draft without knowledge disposition or publication',async()=>{
 const errors=[{kind:'WorkflowStageCallUncertain'},null,{kind:'KnowledgeModelRejected',status:429},{kind:'KnowledgeModelTimeout'}];
 const f=fixture({generate:async input=>ok(draft(input.knowledge)),evaluate:async input=>{const error=errors[input.technicalAttempt-1];return error?{ok:false,error}:ok({});}});
 const result=await f.actor.run({ownerId:'owner',runId:'critic',points:[point('a')]});assert.deepEqual(result,{ok:false,error:{kind:'KnowledgeModelTimeout',technicalRetriesExhausted:true,technicalAttempts:4}});
 assert.equal(f.generated.length,1);assert.equal(f.evaluated.length,4);assert(f.evaluated.every(x=>x.attempt===1&&x.draft===f.evaluated[0].draft));assert.equal(f.attempts.length,0);assert.equal(f.discarded.length,0);assert.equal(f.published.length,0);
});
test('accounting, authentication and already exhausted failures stop without another physical attempt',async()=>{
 for(const error of [{kind:'KnowledgeModelRejected',status:400},{kind:'KnowledgeModelRejected',status:401},{kind:'KnowledgeModelRejected',status:403},{kind:'KnowledgeModelRejected',status:422},{kind:'KnowledgeModelRejected',status:200,causeKind:'KnowledgeModelCredentialMissing'},{kind:'KnowledgeModelCredentialMissing'},{kind:'KnowledgeModelUsageInvalid'},{kind:'WorkflowStageCallUncertain',causeKind:'AgentLedgerPersistenceFailed'},{kind:'WorkflowStageCallUncertain',causeKind:'KnowledgeModelUsageInvalid'},{kind:'KnowledgeModelTimeout',technicalRetriesExhausted:true,technicalAttempts:4}]){
  const f=fixture({generate:async()=>({ok:false,error})});const result=await f.actor.run({ownerId:'owner',runId:'stop',points:[point('a')]});assert.equal(result.ok,false);assert.equal(f.generated.length,1);assert.equal(f.attempts.length,0);assert.equal(f.discarded.length,0);assert.equal(f.evaluated.length,0);assert.equal(f.published.length,0);
  if(error.technicalRetriesExhausted)assert.deepEqual(result.error,error);else assert.equal(result.error.causeKind,error.causeKind??error.kind);
 }
});
test('whole-case terminal errors validate technical exhaustion metadata without accepting malformed counters',()=>{
 const cases=[{id:'synthetic',split:'development'}],row={caseId:'synthetic',split:'development',status:'failed',passes:false,judgeResultRefs:[],terminalReason:'QuizDraftSchemaInvalid',terminalError:{kind:'QuizDraftSchemaInvalid',technicalRetriesExhausted:true,technicalAttempts:4}};
 assert.equal(reportWholeCases(cases,[row]).ok,true);assert.equal(reportWholeCases(cases,[{...row,terminalReason:'KnowledgeReviewOutputInvalid',terminalError:{...row.terminalError,kind:'KnowledgeReviewOutputInvalid',attempts:4}}]).ok,true);
 for(const metadata of [{attempts:0},{attempts:5},{attempts:'4'},{technicalRetriesExhausted:false},{technicalRetriesExhausted:'true'},{technicalAttempts:0},{technicalAttempts:5},{technicalAttempts:1.5},{technicalAttempts:'4'}])assert.equal(reportWholeCases(cases,[{...row,terminalError:{...row.terminalError,...metadata}}]).ok,false);
});

// Synthetic provider errors, never real model calls. Technical retries do not revise quiz quality.
test('HTTP2xx provider error envelopes and408 share the existing four-attempt quiz technical budget',async()=>{
 for(const status of [200,204,299,408])for(const phase of ['generation','evaluation'])for(const recovers of [false,true]){
  const rejected={ok:false,error:{kind:'KnowledgeModelRejected',status}},f=fixture({generate:async input=>phase==='generation'&&(!recovers||input.technicalAttempt<4)?rejected:ok(draft(input.knowledge)),evaluate:async input=>phase==='evaluation'&&(!recovers||input.technicalAttempt<4)?rejected:ok({score:9,reasons:['Synthetic support.'],feedback:'Keep.',groundingProblems:[]})});
  const result=await f.actor.run({ownerId:'owner',runId:'provider-envelope',points:[point('a')]});
  assert.equal(result.ok,recovers);assert.equal(f.generated.length,phase==='generation'?4:1);assert.equal(f.evaluated.length,phase==='generation'?(recovers?1:0):4);
  const calls=phase==='generation'?f.generated:f.evaluated;assert.deepEqual(calls.map(x=>[x.attempt,x.technicalAttempt]),[[1,1],[1,2],[1,3],[1,4]]);
  if(phase==='evaluation')assert(f.evaluated.every(x=>x.draft===f.evaluated[0].draft));
  assert.equal(f.discarded.length,0);assert.equal(f.attempts.length,recovers?1:0);assert.equal(f.published.length,recovers?1:0);
  if(!recovers)assert.deepEqual(result.error,{...rejected.error,technicalRetriesExhausted:true,technicalAttempts:4});
 }
});
