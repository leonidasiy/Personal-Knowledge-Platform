import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestWebpageFacts,webpageFactsPrompt,webpageClaimBoundaryPrompt,quoteHash} from '../worker/webpage-facts.js';

const url='https://synthetic.invalid/lesson';
const blocks=[
 {id:'definition',locator:'p.definition',sectionId:'s',kind:'text',figureId:null,text:'A ratio compares quantities by division.'},
 {id:'condition',locator:'p.condition',sectionId:'s',kind:'text',figureId:null,text:'Division by zero is undefined.'},
];
const evidence={url,blocks,headings:[],images:[],warnings:[]};
const previousKnowledge=[{id:'committed-other',summary:'A proportion states that two ratios are equal.'}];
const lessOften=[{id:'unwanted-other',summary:'The numerator is written above the fraction bar.'}];

test('extractor and completeness prompts distinguish committed knowledge from unaccepted drafts and notes',()=>{
 for(const prompt of [webpageFactsPrompt,webpageClaimBoundaryPrompt]){
  assert.match(prompt,/previousKnowledge is the sole authority/);
  assert.match(prompt,/Observations, candidate drafts, normalizer drafts, plans, working-memory notes/);
  assert.match(prompt,/do not establish persisted acceptance/);
 }
 assert.match(webpageFactsPrompt,/An empty previousKnowledge means no committed knowledge was supplied/);
 assert.doesNotMatch(webpageFactsPrompt,/avoid repeating it across pages or prior brief progress notes/);
 assert.match(webpageClaimBoundaryPrompt,/"already retained".*unverified/);
 assert.match(webpageClaimBoundaryPrompt,/restore a genuinely omitted useful relationship through additionalCandidates/);
 assert.match(webpageClaimBoundaryPrompt,/same central unwanted concept/);
});

test('synthetic normalization recovers an uncommitted relationship claimed retained in notes with exact source provenance',async()=>{
 const calls=[];
 const result=await requestWebpageFacts({taskId:'synthetic-committed-authority',normalizeClaims:true,structuredOutput:true,deferQualityReview:false,maxOutputTokens:4096,
  input:{url,evidence,coverageGoals:[],previousKnowledge,lessOften,workingMemory:{drafts:['A ratio compares quantities by division.'],notes:'Already retained.'}},logger:()=>{},
  generate:async command=>{
   calls.push(command);
   if(command.phase==='grounding')return {ok:true,value:{verdicts:command.input.candidates.map(c=>({normalizedHash:c.normalizedHash,grounded:true,matchedLessOftenIds:[]}))}};
   assert.deepEqual(command.input.previousKnowledge,previousKnowledge);
   assert.deepEqual(command.input.lessOften,lessOften);
   const candidate=(id,normalizedHash)=>({summary:blocks.find(b=>b.id===id).text,normalizedHash,coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{reference:command.input.citationSources.find(s=>s.sourceId===id).reference,clause:blocks.find(b=>b.id===id).text}]});
   if(command.phase==='extraction')return {ok:true,value:{notes:'The definition was already retained in an earlier observed draft.',candidates:[candidate('condition','division-zero')]}};
   assert.equal(command.phase,'normalization');
   assert.match(command.input.notes,/already retained/);
   assert.match(command.systemPrompt,/supplied notes do not establish persisted acceptance/);
   return {ok:true,value:{notes:'Recovered source-supported definition absent from committed previousKnowledge.',reviews:command.input.candidates.map(c=>({sourceNormalizedHash:c.normalizedHash,relationshipUnits:[{condition:null,relationship:c.summary,childNormalizedHash:c.normalizedHash}],candidates:[c]})),additionalCandidates:[candidate('definition','ratio')]}};
  }});
 assert(result.ok,JSON.stringify(result));
 assert.deepEqual(calls.map(c=>c.phase),['extraction','normalization','grounding']);
 assert.deepEqual(result.value.candidates.map(c=>c.normalizedHash),['division-zero','ratio']);
 const recovered=result.value.candidates[1];assert.equal(recovered.summary,blocks[0].text);assert.equal(recovered.evidenceAnchors[0].blockId,'definition');assert.equal(recovered.evidenceAnchors[0].quote,blocks[0].text);assert.equal(recovered.evidenceAnchors[0].quoteDigest,await quoteHash(blocks[0].text));
 assert.deepEqual(previousKnowledge,[{id:'committed-other',summary:'A proportion states that two ratios are equal.'}]);
});

async function cleanEmpty({addition='valid',grounded=true,normalFailure=false,extraction=[],normalizeClaims=true}={}){
 const calls=[];
 const result=await requestWebpageFacts({taskId:'synthetic-empty-completeness',normalizeClaims,structuredOutput:true,deferQualityReview:false,maxOutputTokens:4096,input:{url,evidence,coverageGoals:[],previousKnowledge:[],lessOften},logger:()=>{},generate:async command=>{
  calls.push(command);
  if(command.phase==='extraction')return {ok:true,value:{notes:'Earlier observed draft was already retained.',candidates:extraction}};
  if(command.phase==='grounding')return {ok:true,value:{verdicts:command.input.candidates.map(c=>({normalizedHash:c.normalizedHash,grounded,matchedLessOftenIds:[]}))}};
  assert.equal(command.phase,'normalization');assert.deepEqual(command.input.candidates,[]);assert.deepEqual(command.input.previousKnowledge,[]);assert.deepEqual(command.input.lessOften,lessOften);
  assert.equal(command.responseSchema.schema.properties.reviews.minItems,0);assert.equal(command.responseSchema.schema.properties.reviews.maxItems,0);
  const identity=command.responseSchema.schema.properties.reviews.items.properties.sourceNormalizedHash;assert.equal(identity.type,'string');assert.equal(Object.hasOwn(identity,'enum'),false,'Never emit invalid empty JSON Schema enums');
  if(normalFailure)return {ok:false,error:{kind:'KnowledgeModelOutputInvalid'}};
  const candidate={summary:blocks[0].text,normalizedHash:'ratio',coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{reference:addition==='foreign'?{kind:'text',id:'unobserved'}:command.input.citationSources.find(s=>s.sourceId==='definition').reference,clause:blocks[0].text}]};
  return {ok:true,value:{notes:'Completeness reviewed against captured source and committed knowledge.',reviews:[],additionalCandidates:addition==='none'?[]:[candidate]}};
 }});
 return {result,calls};
}

test('clean empty extraction can recover uncommitted captured facts in the single bounded completeness pass',async()=>{
 const {result,calls}=await cleanEmpty();assert(result.ok,JSON.stringify(result));assert.equal(result.value.status,'complete');assert.deepEqual(calls.map(c=>c.phase),['extraction','normalization','grounding']);
 assert.equal(result.value.candidates.length,1);const point=result.value.candidates[0];assert.equal(point.summary,blocks[0].text);assert.equal(point.evidenceAnchors[0].quote,blocks[0].text);assert.equal(point.evidenceAnchors[0].quoteDigest,await quoteHash(blocks[0].text));
});

test('completeness with zero additions stops empty after one pass without grounding or retries',async()=>{
 const {result,calls}=await cleanEmpty({addition:'none'});assert(result.ok);assert.deepEqual(calls.map(c=>c.phase),['extraction','normalization']);assert.equal(result.value.status,'empty');assert.deepEqual(result.value.candidates,[]);assert.deepEqual(result.value.partialIssues.map(i=>i.kind),['WebpageFactsEmpty']);
});

test('recovered additions still reject foreign citations and adverse independent grounding',async()=>{
 const foreign=await cleanEmpty({addition:'foreign'});assert(foreign.result.ok);assert.deepEqual(foreign.result.value.candidates,[]);assert.deepEqual(foreign.result.value.partialIssues.map(i=>i.kind),['WebpageCandidateEvidenceInvalid']);assert.deepEqual(foreign.calls.map(c=>c.phase),['extraction','normalization']);
 const unsupported=await cleanEmpty({grounded:false});assert(unsupported.result.ok);assert.deepEqual(unsupported.result.value.candidates,[]);assert.deepEqual(unsupported.result.value.partialIssues.map(i=>i.kind),['WebpageCandidateGroundingRejected']);assert.deepEqual(unsupported.calls.map(c=>c.phase),['extraction','normalization','grounding']);
});

test('malformed empty results, disabled normalization and failed completeness retain bounded early-stop contracts',async()=>{
 const malformed=await cleanEmpty({extraction:[null]});assert(malformed.result.ok);assert.deepEqual(malformed.result.value.partialIssues.map(i=>i.kind),['WebpageCandidateInvalid']);assert.deepEqual(malformed.calls.map(c=>c.phase),['extraction']);
 const disabled=await cleanEmpty({normalizeClaims:false});assert(disabled.result.ok);assert.equal(disabled.result.value.status,'empty');assert.deepEqual(disabled.calls.map(c=>c.phase),['extraction']);
 const failed=await cleanEmpty({normalFailure:true});assert.deepEqual(failed.result,{ok:false,error:{kind:'KnowledgeModelOutputInvalid'}});assert.deepEqual(failed.calls.map(c=>c.phase),['extraction','normalization']);
});

// Prompt/input/output contract fixtures, never proof of real-model semantic compliance.
test('completeness exclusion stays independent of committed-knowledge authority',()=>{
 assert.match(webpageClaimBoundaryPrompt,/lessOften exclusion and committed-knowledge duplication are independent eligibility checks/);
 assert.match(webpageClaimBoundaryPrompt,/First exclude.*whether or not it appears in previousKnowledge/);
 assert.match(webpageClaimBoundaryPrompt,/Absence from previousKnowledge never authorizes restoring a lessOften exclusion/);
 assert.match(webpageClaimBoundaryPrompt,/an intentionally unwanted omission is not a completeness gap/);
 assert.match(webpageClaimBoundaryPrompt,/additionalCandidates, reviewed children, refinements and expansions/);
 assert.match(webpageClaimBoundaryPrompt,/only if the relationship is not excluded by lessOften and previousKnowledge has no matching committed relationship/);
 assert.match(webpageClaimBoundaryPrompt,/Preserve distinct wanted relationships in mixed source blocks/);
});

for(const committed of [[],previousKnowledge])test(`synthetic mixed-source completeness keeps owner exclusions with ${committed.length} committed entries`,async()=>{
 const calls=[],excluded=[{id:'owner-excluded',summary:blocks[0].text}];
 const result=await requestWebpageFacts({taskId:'synthetic-less-often-completeness',normalizeClaims:true,deferQualityReview:true,structuredOutput:true,maxOutputTokens:4096,input:{url,evidence,coverageGoals:[],lessOften:excluded,previousKnowledge:committed},logger:()=>{},generate:async command=>{
  calls.push(command);assert.deepEqual(command.input.lessOften,excluded);assert.deepEqual(command.input.previousKnowledge,committed);
  if(command.phase==='grounding')return {ok:true,value:{verdicts:command.input.candidates.map(c=>({normalizedHash:c.normalizedHash,matchedLessOftenIds:[]}))}};
  if(command.phase==='extraction')return {ok:true,value:{notes:'The ratio relationship was omitted by owner preference. A wanted draft has not been committed.',candidates:[]}};
  assert.equal(command.phase,'normalization');assert.deepEqual(command.input.candidates,[]);
  assert.match(command.systemPrompt,/Absence from previousKnowledge never authorizes restoring a lessOften exclusion/);
  const source=command.input.citationSources.find(s=>s.sourceId==='condition');
  return {ok:true,value:{notes:'Constructed assessment: owner-excluded ratio remains omitted; uncommitted division condition is useful.',reviews:[],additionalCandidates:[{summary:blocks[1].text,normalizedHash:'division-zero',coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{reference:source.reference,clause:blocks[1].text}]}]}};
 }});
 assert(result.ok,JSON.stringify(result));assert.deepEqual(calls.map(c=>c.phase),['extraction','normalization','grounding']);assert.deepEqual(result.value.candidates.map(c=>c.normalizedHash),['division-zero']);
 assert.equal(result.value.candidates[0].evidenceAnchors[0].quote,blocks[1].text);assert.equal(result.value.candidates[0].evidenceAnchors[0].quoteDigest,await quoteHash(blocks[1].text));
});
