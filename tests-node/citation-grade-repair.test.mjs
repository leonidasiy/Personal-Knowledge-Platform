import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestWebpageFacts,quoteHash} from '../worker/webpage-facts.js';
const capture=async command=>(await import('../worker/webpage-citations.js')).captureCitationSources(command);
const source='For y ≠ 0, x/y is defined.\nA ratio compares\u00a0quantities. e\u0301 ≠ é; − ≠ -; 😀';
const sourceCommand={owner:'https://synthetic.invalid/revision',sources:[{id:'b',locator:'main > p',text:source}]};
test('whole canonical source references preserve Unicode, spaces, line breaks, identity, locator and digest',async()=>{
 const original=structuredClone(sourceCommand),r=await capture(sourceCommand);assert(r.ok);const c=r.value,s=c.sources[0];
 assert.equal(s.text,source);assert.equal(s.sourceId,'b');assert.equal(s.locator,'main > p');assert.equal(s.quoteDigest,await quoteHash(source));assert(Object.isFrozen(s));assert(Object.isFrozen(s.reference));assert.deepEqual(c.resolve([s.reference]),{ok:true,value:[s]});
 sourceCommand.sources[0].text='changed';assert.equal(c.resolve([s.reference]).value[0].text,source);sourceCommand.sources[0].text=source;assert.deepEqual(sourceCommand,original);
});
for(const defect of ['unknown','foreign','stale','duplicate','missing-text','legacy-quote','extra-field','pixel'])test('canonical capture/reference rejects '+defect,async()=>{
 const r=await capture(sourceCommand);assert(r.ok);let refs=[r.value.sources[0].reference];
 if(defect==='unknown')refs=[{kind:'text',id:'unknown'}];
 if(defect==='foreign'||defect==='stale'){const cmd=structuredClone(sourceCommand);if(defect==='foreign')cmd.owner='https://foreign.invalid/';else cmd.sources[0].text+=' revision';refs=[(await capture(cmd)).value.sources[0].reference];}
 if(defect==='duplicate')refs.push(refs[0]);if(defect==='legacy-quote')refs=[{sourceId:'b',quote:source}];if(defect==='extra-field')refs=[{...refs[0],quote:source}];if(defect==='pixel')refs=[{kind:'pixels',id:'i',cue:'observed'}];
 if(defect==='missing-text'){assert.equal((await capture({owner:sourceCommand.owner,sources:[{id:'b',locator:'p',text:''}]})).error.kind,'CitationCaptureInvalid');return;}
 assert.deepEqual(r.value.resolve(refs),{ok:false,error:{kind:'CitationReferenceInvalid'}});
});
async function factsRun({badReference=false,reject=false,duplicate=false}={}){
 const url=sourceCommand.owner,evidence={url,blocks:[{id:'b',sectionId:'s',kind:'text',figureId:null,locator:'main > p',text:source}],headings:[],images:[],warnings:[]};let calls=0;const log=[];
 const result=await requestWebpageFacts({taskId:'canonical',input:{url,evidence,coverageGoals:[]},maxOutputTokens:4096,structuredOutput:true,logger:e=>log.push(e),generate:async c=>{
  calls++;if(c.phase==='grounding'){assert.equal(c.input.candidates.length,1);assert.equal(c.input.candidates[0].evidenceAnchors[0].quote,source);return {ok:true,value:{verdicts:[{normalizedHash:'valid',grounded:!reject}]}};}
  assert.equal(c.input.citationSources[0].text,source);const ref=c.input.citationSources[0].reference;
  const candidate={summary:'A ratio compares quantities.',normalizedHash:'valid',coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{reference:ref,clause:'A ratio compares quantities.'}]};
  const bad={...structuredClone(candidate),normalizedHash:'bad',evidenceAnchors:[{reference:{kind:'text',id:'foreign'},clause:'Unproven.'}]};
  if(duplicate)candidate.evidenceAnchors.push(structuredClone(candidate.evidenceAnchors[0]));
  return {ok:true,value:{notes:'',candidates:badReference?[bad,candidate]:[candidate]}};
 }});return {result,calls,log};
}
test('canonical extraction derives literal provenance and keeps rejected plus valid partial issues',async()=>{
 const {result,calls}=await factsRun({badReference:true});assert(result.ok);assert.equal(calls,2);assert.equal(result.value.status,'partial');assert.equal(result.value.candidates.length,1);assert.equal(result.value.partialIssues[0].candidateIndex,0);const a=result.value.candidates[0].evidenceAnchors[0];assert.equal(a.quote,source);assert.equal(a.quoteDigest,await quoteHash(source));assert.equal(a.blockId,'b');assert.equal(a.selector,'main > p');assert.equal(a.url,sourceCommand.owner);
});
test('canonical extraction still independently rejects unsupported summary',async()=>{const {result,calls}=await factsRun({reject:true});assert(result.ok);assert.equal(calls,2);assert.equal(result.value.candidates.length,0);assert.equal(result.value.partialIssues[0].kind,'WebpageCandidateGroundingRejected');});
test('identical canonical extraction references/clauses rejected explicitly',async()=>{const {result,calls}=await factsRun({duplicate:true});assert(result.ok);assert.equal(calls,1);assert.equal(result.value.status,'empty');assert.equal(result.value.partialIssues[0].kind,'WebpageCandidateEvidenceInvalid');});
test('extraction strict schema enumerates application supplied captured references',async()=>{
 const {webpageFactsSchema}=await import('../worker/webpage-facts.js');const r=await capture(sourceCommand);assert(r.ok);const schema=webpageFactsSchema(r.value.sources,[]);
 assert.deepEqual(schema.schema.properties.candidates.items.properties.evidenceAnchors.items.properties.reference.properties.id.enum,[r.value.sources[0].reference.id]);
 for(const [sources,goals] of [[null,[]],[[],null],[r.value.sources,[{id:''}]]])assert.throws(()=>webpageFactsSchema(sources,goals),{name:'TypeError',message:'WebpageFactsSchemaCommandInvalid'});
});
