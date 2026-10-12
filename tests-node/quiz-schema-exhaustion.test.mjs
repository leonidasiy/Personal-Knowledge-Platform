import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuizActorCritic} from '../src/features/knowledge-workflows/quiz.js';
import {normalizeQuizPairDraftAliases,quizPairSchema,validateQuizPairDraft} from '../src/features/knowledge-workflows/quiz-pair.js';
import {classifyEvaluationFailure,isTerminalPipelineFailure,runEvaluation} from '../scripts/webpage-image-evaluation.mjs';
import {createSyntheticSelectedEvaluationFixture} from './fixtures/evaluation/synthetic-selected.mjs';
import {readFrozenEvaluationCatalog} from './fixtures/evaluation/catalog.mjs';
import {createEvaluationLedger} from '../scripts/evaluation-budget.mjs';
import {DatabaseSync} from 'node:sqlite';
const ok=value=>({ok:true,value});
const point=id=>({id,sourceId:'synthetic',sourceRevision:1,summary:'The constructed source teaches a relation.',normalizedHash:id,coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{url:'https://synthetic.invalid',selector:'p'}]});
const draft=p=>({id:'draft:'+p.id,knowledgeId:p.id,knowledgeRevision:1,kind:'single-choice',prompt:'Which constructed relation?',options:['relation','alternative'],answer:'relation',explanation:'Constructed support.',citedEvidenceUrls:['https://synthetic.invalid']});
function fixture({maxAttempts=2,generate,evaluate=async()=>ok({score:9,reasons:['Constructed support.'],feedback:'Keep.',groundingProblems:[]})}) {
 const generated=[],evaluated=[],attempts=[],discarded=[],published=[];
 const actor=createQuizActorCritic({maxAttempts,now:()=> '2026-10-12T00:00:00.000Z',logger:()=>{},generator:{generate:async input=>{generated.push(input);return generate(input);}},evaluator:{evaluate:async input=>{evaluated.push(input);return evaluate(input);}},repository:{findPublished:async()=>ok(null),appendAttempt:async a=>{attempts.push(a);return ok(null);},publish:async p=>{published.push(p);return ok(null);},discard:async d=>{discarded.push(d);return ok(null);},purge:async()=>ok(null)}});
 return {actor,generated,evaluated,attempts,discarded,published};
}
test('flat required schema retains complete pair and strict missing-field/count boundaries',()=>{
 const s=quizPairSchema(true);assert.equal(s.name,'paired_quiz_v3');assert.equal(s.schema.anyOf,undefined);assert.equal(s.schema.allOf,undefined);assert.deepEqual(s.schema.required,['knowledgeId','knowledgeRevision','canonicalAnswers','citedEvidenceUrls','multipleChoice','fillBlank']);
 const partial={canonicalAnswers:['relation'],fillBlank:{blanks:[{id:'blank-1',canonicalAnswer:'relation',acceptedAnswers:['relation']}]}};assert.equal(validateQuizPairDraft(partial),false);assert.equal(normalizeQuizPairDraftAliases(partial),partial);assert.equal(partial.multipleChoice,undefined);
});
for(const mode of ['typed-schema','raw-invalid'])test(`all existing two drafts ${mode} fail typed after persisting attempts and purging all points`,async()=>{
 const f=fixture({generate:async()=>mode==='typed-schema'?{ok:false,error:{kind:'QuizDraftSchemaInvalid'}}:ok({})});const result=await f.actor.run({ownerId:'owner',runId:'run',points:['a','b','c'].map(point)});
 assert.deepEqual(result,{ok:false,error:{kind:'QuizGeneratorFailed',causeKind:'QuizDraftSchemaInvalid'}});assert.equal(f.generated.length,6);assert.equal(f.attempts.length,6);assert.equal(f.discarded.length,3);assert.equal(f.evaluated.length,0);assert.equal(f.published.length,0);assert.equal(classifyEvaluationFailure(result.error),'pipeline');assert(isTerminalPipelineFailure(result.error,{activeRequests:0}));
});
test('a valid second draft with semantic rejection stays a semantic abandonment',async()=>{
 const f=fixture({generate:async input=>input.attempt===1?{ok:false,error:{kind:'QuizDraftSchemaInvalid'}}:ok(draft(input.knowledge)),evaluate:async()=>ok({score:5,reasons:['Constructed semantic issue.'],feedback:'Revise the relation.',groundingProblems:['Constructed ambiguity.']})});const result=await f.actor.run({ownerId:'owner',runId:'run',points:[point('a')]});assert(result.ok);assert.equal(result.value.dispositions[0].failureKind,'QuizScoreBelowThreshold');assert.equal(f.generated.length,2);assert.equal(f.evaluated.length,1);
});
test('a well-formed source-conflicting quiz remains grounded negative without typed generator failure',async()=>{
 const p=point('a');const f=fixture({generate:async input=>ok(draft(input.knowledge)),evaluate:async()=>ok({score:9,reasons:['Captured source conflict.'],feedback:'The point conflicts with supplied support.',groundingProblems:[],knowledgeGroundingProblems:['The supplied point conflicts with its source.']})});const result=await f.actor.run({ownerId:'owner',runId:'run',points:[p]});assert(result.ok);assert.equal(result.value.dispositions[0].failureKind,'QuizKnowledgeUngrounded');assert.equal(f.generated.length,1);assert.equal(f.evaluated.length,1);assert.equal(f.published.length,0);
});
test('mixed successful publication and schema exhaustion preserves the valid publication and dispositions',async()=>{
 const f=fixture({generate:async input=>input.knowledge.id==='bad'?{ok:false,error:{kind:'QuizDraftSchemaInvalid'}}:ok(draft(input.knowledge))});const result=await f.actor.run({ownerId:'owner',runId:'run',points:[point('bad'),point('good')]});assert(result.ok);assert.deepEqual(result.value.dispositions.map(d=>d.status),['abandoned','accepted']);assert.equal(f.generated.length,3);assert.equal(f.published.length,1);
});
test('legacy three-draft caller retains its existing abandoned result and limits',async()=>{
 const f=fixture({maxAttempts:3,generate:async()=>({ok:false,error:{kind:'QuizDraftSchemaInvalid'}})});const result=await f.actor.run({ownerId:'owner',runId:'run',points:[point('a')]});assert(result.ok);assert.equal(result.value.dispositions[0].attempts,3);assert.equal(f.generated.length,3);assert.equal(f.discarded.length,1);
});
test('actual selected orchestration marks settled quiz schema exhaustion failed once and continues later cases',async()=>{
 const {config,corpus,negativeTargets,selectedRun}=createSyntheticSelectedEvaluationFixture(),catalog=await readFrozenEvaluationCatalog(),db=new DatabaseSync(':memory:'),calls=[];
 const ownerDecision={authority:'synthetic fixture; no actual spend',source:'quiz-schema-exhaustion.test.mjs',decision:'TreatUSD1asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'};
 const ledger=createEvaluationLedger({database:db,budgetId:'owner-approved-image-benchmark',policy:config.budget,now:()=>1000,logger:()=>{},accountingMode:'estimated',ownerDecision});
 try {
  const result=await runEvaluation({config,corpus,negativeTargets,selectedRun,catalog,ledger,mode:'estimated',ownerDecision,iterationId:'synthetic',now:()=>1000,logger:()=>{},signal:new AbortController().signal,requestPlanner:async()=>assert.fail('no paid planning'),database:{prepare:()=>assert.fail('no application database')},scope:{ownerId:'synthetic',runId:'synthetic'},allowNetwork:true,budgetAuthorized:true,apiKey:'synthetic-not-a-credential',fetch:async()=>assert.fail('no external call'),reviewedApplication:{extract:async({item})=>{calls.push(item.id);return ok({predictions:[]});},quiz:async item=>{const f=fixture({generate:async()=>({ok:false,error:{kind:'QuizDraftSchemaInvalid'}})});const result=await f.actor.run({ownerId:'owner',runId:item.id,points:[point(item.id)]});assert.equal(f.generated.length,2);return result;},current:async()=>assert.fail('failed generator must not reach source judge')}});
  assert(result.ok);const rows=result.value.wholeCaseReport.rows;assert.equal(rows.length,45);assert(rows.every(r=>r.status==='failed'&&!r.passes&&r.terminalReason==='QuizGeneratorFailed'&&r.terminalError.causeKind==='QuizDraftSchemaInvalid'&&r.judgeResultRefs.length===0));assert.equal(calls.length,45);assert.equal(new Set(calls).size,45);assert.equal(ledger.snapshot().value.requests,0);
 }finally{db.close();}
});
