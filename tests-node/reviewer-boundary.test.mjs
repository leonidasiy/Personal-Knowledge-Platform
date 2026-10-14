import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createQuizActorCritic} from '../src/features/knowledge-workflows/quiz.js';

// Synthetic boundary checks, not real model evaluations.
const knowledge={id:'point',sourceId:'source',sourceRevision:1,summary:'A staff has five lines.',evidenceAnchors:[{url:'https://example.test/lesson',selector:'#staff'}]};
const draft={id:'draft',knowledgeId:'point',knowledgeRevision:1,kind:'single-choice',prompt:'How many lines does a staff have?',options:['Five','Four'],answer:'Five',citedEvidenceUrls:['https://example.test/lesson']};
function dependencies(score){
 let published=0;
 return {get published(){return published;},generator:{generate:async()=>({ok:true,value:draft})},reviewer:{evaluate:async()=>({ok:true,value:{score,reasons:['Synthetic reviewer decision'],feedback:'Check the source.',groundingProblems:[]}})},repository:{findPublished:async()=>({ok:true,value:null}),appendAttempt:async()=>({ok:true,value:null}),publish:async()=>{published++;return {ok:true,value:null};},discard:async()=>({ok:true,value:null}),purge:async()=>({ok:true,value:null})},now:()=> '2026-10-13T00:00:00Z',logger:()=>{},maxAttempts:2};
}
test('external test evaluator cannot substitute for the production reviewer',()=>{
 const inputs=dependencies(9);delete inputs.reviewer;
 assert.throws(()=>createQuizActorCritic({...inputs,evaluator:{evaluate:async()=>({ok:true,value:{score:10}})}}),TypeError);
});
test('external scoring is never invoked and cannot permit or prevent publication',async()=>{
 for(const reviewerScore of [7,9]){
  const inputs=dependencies(reviewerScore);
  const result=await createQuizActorCritic({...inputs,evaluator:{evaluate:async()=>assert.fail('External evaluator reached production')}}).run({ownerId:'owner',runId:'run',points:[knowledge]});
  assert.equal(result.ok,true);assert.equal(inputs.published,reviewerScore===9?1:0);
 }
});
