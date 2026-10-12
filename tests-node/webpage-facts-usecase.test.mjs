import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {captureCitationSources} from '../worker/webpage-citations.js';
import {requestWebpageFacts,quoteHash,validateWebpageGrounding,webpageGroundingPrompt} from '../worker/webpage-facts.js';
globalThis.fetch=async()=>{throw Error('OfflineNetworkForbidden');};
const fixture=JSON.parse(readFileSync('test-results/benchmark-recovery-20261007/usecase-aligned-fix/facts/actual-and-SYNTHETIC-offline-fixture.json','utf8'));
const url='https://synthetic.invalid/';
const source='For y ≠ 0, x/y is defined. A ratio compares quantities by division.';
const block={id:'b',locator:'p',sectionId:'s',text:source,kind:'text',figureId:null};
const evidence={url,blocks:[block],headings:[],images:[],warnings:[]};
const capture=await captureCitationSources({owner:url,sources:[{id:'b',locator:'p',text:source}]});assert(capture.ok);
const fact=(summary='A ratio compares quantities by division.',hash='ratio',clauses=['A ratio compares quantities by division'])=>({summary,normalizedHash:hash,coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:clauses.map(clause=>({reference:capture.value.sources[0].reference,clause}))});
async function run(candidates,verdicts,input={url,evidence,coverageGoals:[]},inspect=()=>{}){
 const calls=[];const result=await requestWebpageFacts({taskId:'offline',input,structuredOutput:true,maxOutputTokens:4096,logger:()=>{},generate:async c=>{calls.push(c.phase);inspect(JSON.parse(JSON.stringify(c)));return {ok:true,value:c.phase==='extraction'?{notes:'',candidates}:verdicts};}});return {result,calls};
}
test('actual missing terminal period reaches grounding without rewriting fact',async()=>{
 const original=fixture.actualExtraction.candidates[2];const captured=await captureCitationSources({owner:fixture.input.url,sources:fixture.input.evidence.blocks.map(b=>({id:b.id,locator:b.locator,text:b.text}))});assert(captured.ok);const candidate={...original,evidenceAnchors:original.evidenceAnchors.map(a=>({reference:captured.value.sources.find(s=>s.sourceId===a.blockId).reference,clause:a.clause}))};const {result,calls}=await run([candidate],{verdicts:[{normalizedHash:candidate.normalizedHash,grounded:true}]},fixture.input);
 assert.deepEqual(calls,['extraction','grounding']);assert(result.ok);assert.equal(result.value.candidates[0].summary,candidate.summary);assert.equal(result.value.candidates[0].evidenceAnchors[0].quote,fixture.input.evidence.blocks.find(b=>b.id===original.evidenceAnchors[0].blockId).text);
});
test('supported whole paraphrase and different segmentation are eligible',async()=>{
 const c=fact('Division expresses a comparison between quantities.','paraphrase',['Division expresses']);const {result}=await run([c],{verdicts:[{normalizedHash:c.normalizedHash,grounded:true}]});assert(result.ok);assert.equal(result.value.candidates[0].summary,c.summary);
});
test('corroborating captured references may differ in clause order',async()=>{
 const c=fact(undefined,'ratio',['division.','A ratio','compares quantities']);c.evidenceAnchors.push({...c.evidenceAnchors[0],clause:'A ratio compares quantities by division.'});const {result}=await run([c],{verdicts:[{normalizedHash:'ratio',grounded:true}]});assert(result.ok);assert.equal(result.value.candidates[0].evidenceAnchors.length,4);
});
test('distinct reordered true/false verdicts match hashes and preserve immutable facts',async()=>{
 const a=fact(undefined,'a'),b=fact('x/y is defined.','b',['x/y']);const originals=structuredClone([a,b]);const {result}=await run([a,b],{verdicts:[{normalizedHash:'b',grounded:false},{normalizedHash:'a',grounded:true}]});assert(result.ok);assert.deepEqual(result.value.candidates.map(c=>c.normalizedHash),['a']);assert.deepEqual([a,b],originals);assert(Object.isFrozen(result.value.candidates[0]));assert.equal(result.value.candidates[0].evidenceAnchors[0].quoteDigest,await quoteHash(source));
});
for(const [name,summary] of Object.entries({addition:'A ratio compares quantities by division. It cures disease.',condition:'x/y is always defined.',negation:'For y = 0, x/y is defined.',operator:'For y ≠ 0, x*y is defined.'}))test(`semantic false filters ${name} without claiming heuristic classification`,async()=>{
 const {result,calls}=await run([fact(summary,'bad',[summary.slice(0,3)])],{verdicts:[{normalizedHash:'bad',grounded:false}]});assert.deepEqual(calls,['extraction','grounding']);assert(result.ok);assert.equal(result.value.candidates.length,0);
});
for(const defect of ['quote','range','hash','url','locator','duplicatehash','notesarray'])test(`named quality result for ${defect}`,async()=>{
 const c=fact();let candidates=[c];if(defect==='quote')c.evidenceAnchors[0].quote='not in source';if(defect==='range')c.evidenceAnchors[0].quote=source+' extra';if(defect==='hash')c.evidenceAnchors[0].quoteDigest='sha256:wrong';if(defect==='url')c.evidenceAnchors[0].url='https://foreign.invalid/';if(defect==='locator')c.evidenceAnchors[0].selector='aside';if(defect==='duplicatehash')candidates=[c,structuredClone(c)];
 const {result}=defect==='notesarray'?{result:await requestWebpageFacts({taskId:'offline',input:{url,evidence,coverageGoals:[]},maxOutputTokens:1,logger:()=>{},generate:async()=>({ok:true,value:{notes:[],candidates:[]}})})}:await run(candidates,{verdicts:[]});if(defect!=='duplicatehash'&&defect!=='notesarray'){assert(result.ok);assert.equal(result.value.status,'empty');assert.equal(result.value.partialIssues[0].kind,'WebpageCandidateEvidenceInvalid');}else{assert.equal(result.ok,false);assert.equal(result.error.kind,defect==='duplicatehash'?'WebpageFactsInvalid':'WebpageFactEvidenceInvalid');}
});
for(const [name,verdicts] of Object.entries({missing:[],duplicate:[{normalizedHash:'a',grounded:true},{normalizedHash:'a',grounded:false}],foreign:[{normalizedHash:'a',grounded:true},{normalizedHash:'foreign',grounded:true}],badtype:[{normalizedHash:'a',grounded:'true'},{normalizedHash:'b',grounded:true}],alias:[{hash:'a',grounded:true},{normalizedHash:'b',grounded:true}],oldshape:[{normalizedHash:'a',grounded:true,useful:true,clauses:['a']},{normalizedHash:'b',grounded:true}]}))test(`strict grounding rejects ${name}`,async()=>{
 const candidates=[fact(undefined,'a'),fact(undefined,'b')].map(c=>({...c,evidenceAnchors:c.evidenceAnchors.map(a=>({blockId:'b',quote:source,clause:a.clause,url,selector:'p',quoteDigest:capture.value.sources[0].quoteDigest}))}));assert.deepEqual(validateWebpageGrounding({verdicts},candidates),{ok:false,error:{kind:'WebpageGroundingInvalid'}});
});
test('wire prompt/schema expose full verified text, exact hash boolean and untrusted source instructions; no images',async()=>{
 const c=fact();const {result}=await run([c],{verdicts:[{normalizedHash:'ratio',grounded:true}]}, {url,evidence,coverageGoals:[],pixels:'secret-image',memory:'outside'},command=>{
 assert.equal(command.attachments,undefined);assert(!JSON.stringify(command.input).includes('secret-image'));assert(!JSON.stringify(command.input).includes('outside'));assert.equal(command.input.sourceBlocks[0].text,source);
 if(command.phase==='grounding'){assert.equal(command.systemPrompt,webpageGroundingPrompt);assert.match(command.systemPrompt,/every.*(claim|clause)/i);assert.match(command.systemPrompt,/negation/);assert.match(command.systemPrompt,/untrusted/);assert.match(command.systemPrompt,/punctuation/);const schema=command.responseSchema.schema.properties.verdicts.items;assert.deepEqual(schema.required,['normalizedHash','grounded']);assert.equal(schema.additionalProperties,false);assert.equal(schema.properties.grounded.type,'boolean');assert.equal(command.input.candidates[0].summary,c.summary);}
 });assert(result.ok);
});
test('source snapshot and candidate snapshots resist model-port mutation',async()=>{
 const input={url,evidence:structuredClone(evidence),coverageGoals:[]};let calls=0;
 const result=await requestWebpageFacts({taskId:'fences',input,maxOutputTokens:10,logger:()=>{},generate:async command=>{calls++;if(calls===1){command.input.sourceBlocks[0].text='invented';input.evidence.blocks[0].text='mutated caller';input.evidence.url='https://mutated.invalid/';input.url='https://mutated.invalid/';return {ok:true,value:{notes:'',candidates:[fact()]}};}command.input.candidates[0].summary='rewritten';return {ok:true,value:{verdicts:[{normalizedHash:'ratio',grounded:true}]}};}});assert(result.ok);assert.equal(result.value.candidates[0].summary,fact().summary);assert.equal(result.value.candidates[0].evidenceAnchors[0].quote,source);assert.equal(result.value.candidates[0].evidenceAnchors[0].url,url);
});
// Owner-approved partial-result contract; SYNTHETIC decisions only.
test('malformed plus valid retains immutable fact and reports indexed provenance issue',async()=>{
 const valid=fact(),before=structuredClone(valid);
 const {result,calls}=await run([null,valid],{verdicts:[{normalizedHash:'ratio',grounded:true}]});
 assert(result.ok);assert.equal(result.value.status,'partial');assert.equal(result.value.candidates.length,1);assert.deepEqual(valid,before);assert(Object.isFrozen(result.value.candidates[0]));
 assert.deepEqual(result.value.partialIssues,[{kind:'WebpageCandidateInvalid',candidateIndex:0,normalizedHash:null,provenance:{url,blockIds:[]}}]);assert.deepEqual(calls,['extraction','grounding']);
});
test('all malformed reports every rejection with no grounding or full success',async()=>{
 const {result,calls}=await run([null,{summary:'bad'}],{verdicts:[]});assert(result.ok);assert.equal(result.value.status,'empty');assert.equal(result.value.partialIssues.length,2);assert.deepEqual(result.value.partialIssues.map(i=>i.candidateIndex),[0,1]);assert.deepEqual(calls,['extraction']);
});
test('unsupported plus valid explicitly reports semantic rejection without changing retained fact',async()=>{
 const {result,calls}=await run([fact(undefined,'bad'),fact(undefined,'good')],{verdicts:[{normalizedHash:'good',grounded:true},{normalizedHash:'bad',grounded:false}]});assert(result.ok);assert.equal(result.value.status,'partial');assert.deepEqual(result.value.candidates.map(c=>c.normalizedHash),['good']);assert.equal(result.value.partialIssues[0].kind,'WebpageCandidateGroundingRejected');assert.equal(result.value.partialIssues[0].candidateIndex,0);assert.deepEqual(result.value.partialIssues[0].provenance,{url,blockIds:['b']});assert.deepEqual(calls,['extraction','grounding']);
});
test('bad source quote plus valid reports candidate evidence issue, never silent loss',async()=>{
 const bad=fact(undefined,'bad');bad.evidenceAnchors[0].quote='absent';const {result}=await run([bad,fact()],{verdicts:[{normalizedHash:'ratio',grounded:true}]});assert(result.ok);assert.equal(result.value.status,'partial');assert.equal(result.value.partialIssues[0].kind,'WebpageCandidateEvidenceInvalid');assert.equal(result.value.candidates.length,1);
});
test('empty extraction explicitly empty and has no unapproved dispatch',async()=>{
 const {result,calls}=await run([],{verdicts:[]});assert(result.ok);assert.equal(result.value.status,'empty');assert.equal(result.value.partialIssues[0].kind,'WebpageFactsEmpty');assert.deepEqual(calls,['extraction']);
});

test('extraction wire splits independent objectives while preserving complete central relations and qualifiers',async()=>{const c=fact();const {result}=await run([c],{verdicts:[{normalizedHash:'ratio',grounded:true}]},{url,evidence,coverageGoals:[]},command=>{if(command.phase!=='extraction')return;assert.match(command.systemPrompt,/independently testable relationship/i);assert.match(command.systemPrompt,/Do not split.*necessary conditions/i);assert.equal(command.input.sourceMode,'webpage-text');assert.match(command.systemPrompt,/images illustrate/i);});assert(result.ok);assert.equal(result.value.candidates[0].summary,c.summary);});
test('whole visual claims reject partial chains, preserve isolated relation and text-only mixed fact',async()=>{const {associateWebpageImages,imageHash}=await import('../worker/webpage-images.js'),{materialImagePrompt}=await import('../worker/knowledge-workflow-runtime.js');assert.match(materialImagePrompt,/complete transcription.*partial visual evidence/i);const images=[{id:'i',url:'https://synthetic.invalid/i.png',occurrences:[{id:'o',locator:'img',sectionId:'s',figureId:null,captionId:null,alt:'untrusted'}],occurrenceWindows:[['o']]}];const a={summary:'A ratio compares quantities by division.',normalizedHash:'isolated',coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{blockId:'b',quote:source,clause:'A ratio compares quantities.',url,selector:'p',quoteDigest:await quoteHash(source)}]},b={...a,normalizedHash:'mixed',summary:'A ratio compares quantities by division. For y ≠ 0, x/y is defined.'},facts=[a,b],before=structuredClone(facts),bytes=new Uint8Array([1]),digest=await imageHash(bytes);let verified=0;const result=await associateWebpageImages({scope:{ownerId:'fixture',runId:'fixture',sourceRevision:1},facts,evidence:{...evidence,images},budget:{reserve:async()=>({ok:true,value:{deadlineAtMs:Date.now()+1000,maximumBytes:100}}),settle:async()=>({ok:true,value:null})},readImage:async()=>({ok:true,value:{bytes,mediaType:'image/png'}}),digest:imageHash,logger:()=>{},generate:async c=>{assert.equal(c.input.sourceMode,'webpage-text');if(c.phase==='match')return {ok:true,value:{matches:facts.map(f=>({normalizedHash:f.normalizedHash,status:'match',imageId:'i',imageDigest:digest}))}};verified++;assert.match(c.systemPrompt,/partial visual chain/i);assert.match(c.systemPrompt,/EVERY.*clause/);assert.match(c.systemPrompt,/source text cannot fill.*pixel/i);return {ok:true,value:{supported:c.input.fact.normalizedHash==='isolated',imageId:'i',imageDigest:digest,visibleEvidence:c.input.fact.normalizedHash==='isolated'?'visible relation':''}};}});assert(result.ok);assert.equal(verified,2);assert.equal(result.value[0].status,'match');assert.equal(result.value[1].status,'no-support');assert.equal(result.value[1].binding,undefined);assert.deepEqual(facts,before);});
