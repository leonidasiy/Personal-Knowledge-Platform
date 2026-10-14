import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestWebpageFacts,createWebpageAttemptPolicy,quoteHash} from '../worker/webpage-facts.js';
const url='https://synthetic.invalid/lesson',block={id:'mixed',locator:'main > p',sectionId:'s',kind:'text',figureId:null,text:'A ratio compares quantities by division. Division by zero is undefined.'};
const evidence={url,blocks:[block],images:[],headings:[],warnings:[]};
const lessOften=[{id:'owner-excluded',summary:'A ratio compares quantities by division.'}];
const summaries={'wanted':'Division by zero is undefined.','excluded':'A ratio compares quantities by division.'};
const ok=value=>({ok:true,value});
async function run({preferences=lessOften,deferred=true,useful=false,reply,invalidSource=false,initialEmpty=false,transportFailure=false,sourceGrounded=true}={}){
 const calls=[];
 const result=await requestWebpageFacts({taskId:'synthetic-owner-exclusions',normalizeClaims:true,deferQualityReview:deferred,reviewUsefulness:useful,structuredOutput:true,maxOutputTokens:4096,attemptPolicy:createWebpageAttemptPolicy({extraction:1,normalization:1,grounding:1,match:0,verify:0,requests:3}),input:{url,evidence,coverageGoals:[],lessOften:preferences,previousKnowledge:[]},logger:()=>{},generate:async command=>{
  calls.push(command);
  const candidate=hash=>({summary:summaries[hash],normalizedHash:hash,coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{reference:invalidSource?{kind:'text',id:'foreign'}:command.input.citationSources[0].reference,clause:summaries[hash]}]});
  if(command.phase==='extraction')return ok({notes:'Unwanted concept is absent from committed knowledge; provisional draft only.',candidates:initialEmpty?[]:[candidate('wanted')]});
  if(command.phase==='normalization')return ok({notes:'Constructed erroneous completeness addition, not a real model judgment.',reviews:command.input.candidates.map(c=>({sourceNormalizedHash:c.normalizedHash,relationshipUnits:[{condition:null,relationship:c.summary,childNormalizedHash:c.normalizedHash}],candidates:[c]})),additionalCandidates:[candidate('excluded'),...(initialEmpty?[candidate('wanted')]:[])]});
  assert.equal(command.phase,'grounding');
  assert.deepEqual(command.input.lessOften,preferences);assert.deepEqual(command.input.previousKnowledge,[]);assert.equal(command.input.operation,deferred?'filter-webpage-owner-exclusions':'verify-webpage-facts');
  assert.equal(command.input.notes,undefined,'Do not forward erroneous normalization notes into owner eligibility task');
  assert.match(command.systemPrompt,/A shared broad subject or shared entity is not a match/);
  assert.match(command.systemPrompt,/Earlier extractor\/normalizer outputs, notes and working memory are provisional judgments/);
  const schema=command.responseSchema.schema.properties.verdicts;
  assert.equal(schema.minItems,2);assert.equal(schema.maxItems,2);assert.deepEqual(schema.items.properties.matchedLessOftenIds.items.enum,['owner-excluded']);
  if(transportFailure)return {ok:false,error:{kind:'SyntheticOwnerEligibilityTransportFailed'}};
  const verdicts=command.input.candidates.map(c=>({normalizedHash:c.normalizedHash,...(deferred?{}:{grounded:sourceGrounded,...(useful?{useful:true}:{})}),matchedLessOftenIds:c.normalizedHash==='excluded'?['owner-excluded']:[]}));
  return ok(reply?reply(verdicts):{verdicts});
 }});
 return {result,calls};
}

test('constructed owner judgment filters completeness addition before deferred media use within three text phases',async()=>{
 const {result,calls}=await run();assert(result.ok,JSON.stringify(result));assert.deepEqual(calls.map(c=>c.phase),['extraction','normalization','grounding']);assert.deepEqual(result.value.candidates.map(c=>c.normalizedHash),['wanted']);assert.equal(result.value.status,'complete');assert.deepEqual(result.value.partialIssues,[]);assert.equal(result.value.candidates[0].evidenceAnchors[0].quote,block.text);assert.equal(result.value.candidates[0].evidenceAnchors[0].quoteDigest,await quoteHash(block.text));
});
test('clean empty completeness additions use the same single eligibility check',async()=>{const {result,calls}=await run({initialEmpty:true});assert(result.ok);assert.deepEqual(result.value.candidates.map(c=>c.normalizedHash),['wanted']);assert.equal(calls.length,3);});
test('no owner exclusions preserve two-call deferred path with no extra model request',async()=>{const {result,calls}=await run({preferences:[]});assert(result.ok);assert.deepEqual(calls.map(c=>c.phase),['extraction','normalization']);assert.equal(result.value.candidates.length,2);});
for(const useful of [false,true])test(`nondeferred source grounding combines owner classification in its one existing phase, usefulness=${useful}`,async()=>{const {result,calls}=await run({deferred:false,useful});assert(result.ok);assert.deepEqual(result.value.candidates.map(c=>c.normalizedHash),['wanted']);assert.equal(calls.length,3);assert(calls[2].responseSchema.schema.properties.verdicts.items.required.includes('grounded'));assert.equal(calls[2].responseSchema.schema.properties.verdicts.items.required.includes('useful'),useful);});
for(const [name,reply] of Object.entries({
 missing:verdicts=>({verdicts:verdicts.slice(0,1)}),
 duplicate:verdicts=>({verdicts:[verdicts[0],verdicts[0]]}),
 foreignHash:verdicts=>({verdicts:[verdicts[0],{...verdicts[1],normalizedHash:'foreign'}]}),
 foreignPreference:verdicts=>({verdicts:[verdicts[0],{...verdicts[1],matchedLessOftenIds:['foreign']}]}),
 repeatedPreference:verdicts=>({verdicts:[verdicts[0],{...verdicts[1],matchedLessOftenIds:['owner-excluded','owner-excluded']}]}),
 invalidIds:verdicts=>({verdicts:[verdicts[0],{...verdicts[1],matchedLessOftenIds:'owner-excluded'}]}),
 extra:verdicts=>({verdicts,notes:'Do not drop anything'}),
 extraDecision:verdicts=>({verdicts:verdicts.map(v=>({...v,pass:true}))}),
}))test('owner eligibility denies '+name+' without retries or returning candidates',async()=>{const {result,calls}=await run({reply});assert.deepEqual(result,{ok:false,error:{kind:'WebpageOwnerExclusionInvalid'}});assert.equal(calls.length,3);});
test('owner check transport failure stays terminal without fallback or retries',async()=>{const {result,calls}=await run({transportFailure:true});assert.deepEqual(result,{ok:false,error:{kind:'SyntheticOwnerEligibilityTransportFailed'}});assert.equal(calls.length,3);});
test('owner eligibility does not rescue invalid source provenance',async()=>{const {result,calls}=await run({invalidSource:true});assert(result.ok);assert.deepEqual(result.value.candidates,[]);assert.deepEqual(calls.map(c=>c.phase),['extraction']);assert.equal(result.value.partialIssues[0].kind,'WebpageCandidateEvidenceInvalid');});
test('combined owner check preserves adverse source grounding',async()=>{const {result}=await run({deferred:false,sourceGrounded:false});assert(result.ok);assert.deepEqual(result.value.candidates,[]);assert(result.value.partialIssues.every(i=>i.kind==='WebpageCandidateGroundingRejected'));});
test('all candidates explicitly excluded return clean empty with no media candidates',async()=>{const {result}=await run({reply:verdicts=>({verdicts:verdicts.map(v=>({...v,matchedLessOftenIds:['owner-excluded']}))})});assert(result.ok);assert.equal(result.value.status,'empty');assert.deepEqual(result.value.candidates,[]);assert.deepEqual(result.value.partialIssues,[]);});
