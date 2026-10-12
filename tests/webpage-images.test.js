// @ts-check
import { associateWebpageImages } from '../worker/webpage-images.js';
import { quoteHash } from '../worker/webpage-facts.js';
function assert(/** @type {boolean} */ value) { if(!value)throw new Error('Image association invariant failed'); }
const url='https://source.example/ratios';
const evidence={url,headings:[],blocks:[{id:'b',locator:'p',sectionId:'s',kind:/** @type {const} */('text'),text:'Ratios compare quantities.',figureId:null}],images:[{id:'actual',url:'https://image.example/chart.png',occurrences:[{id:'o',locator:'img',sectionId:'s',figureId:null,captionId:null,alt:'Do not trust this alt'}],occurrenceWindows:[['o']]}],warnings:[]};
const fact={summary:'Ratios compare quantities.',normalizedHash:'ratio',evidenceAnchors:[{url,selector:'p'}],coverageGoalIds:[],mediaCandidates:[]};
const bytes=new Uint8Array([1,2,3]);
// Scripted budget fixture only; actual persistence/caps are checked against SQLite.
const budget={reserve:async()=>({ok:/** @type {const} */(true),value:{deadlineAtMs:Date.now()+30000,maximumBytes:20*1024*1024}}),settle:async()=>({ok:/** @type {const} */(true),value:null})};
for(const variant of ['correct','swapped','ad','conflict','foreign','wronghash','ambiguous','unreadable','overlong']) Deno.test(`separate actual-image verifier ${variant}`,async()=>{
 let verifiedCalls=0;
 const digest=await quoteHash(String.fromCharCode(...bytes));
 const result=await associateWebpageImages({budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[fact],evidence,readImage:async()=>({ok:true,value:{bytes,mediaType:'image/png'}}),digest:async()=>digest,logger:()=>{},generate:async command=>{
 const input=/** @type {{operation:string,candidate?:{id:string,digest:string},facts?:typeof fact[]}} */(command.input);
 if(input.operation==='match-webpage-images')return {ok:true,value:{matches:[{normalizedHash:'ratio',status:variant==='ambiguous'?'ambiguous':variant==='unreadable'?'unreadable':'match',imageId:['ambiguous','unreadable'].includes(variant)?null:variant==='foreign'?'foreign':'actual',imageDigest:['ambiguous','unreadable'].includes(variant)?null:variant==='wronghash'?'sha256:wrong':digest}]}};
 verifiedCalls++;
 assert(!JSON.stringify(input).includes('matcherAssertion'));
 assert(command.attachments?.length===1 && command.attachments[0].id==='actual');
 return {ok:true,value:{supported:['correct','overlong'].includes(variant),imageId:'actual',imageDigest:digest,visibleEvidence:variant==='overlong'?'x'.repeat(501):'Visible source labels compare two quantities.'}};
 }});
 assert(result.ok);
 if(result.ok)assert(result.value[0].status===(variant==='correct'?'match':variant==='ambiguous'?'ambiguous':variant==='unreadable'?'unreadable':['foreign','wronghash','overlong'].includes(variant)?'not-evaluated':'no-support'));
 if(['foreign','wronghash','ambiguous','unreadable'].includes(variant))assert(verifiedCalls===0);
});
Deno.test('no accepted web facts skips acquisition and association',async()=>{
 const result=await associateWebpageImages({budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[],evidence,logger:()=>{},digest:async()=>{throw Error('No hash');},readImage:async()=>{throw Error('No read');},generate:async()=>{throw Error('No model');}});
 assert(result.ok && result.value.length===0);
});
Deno.test('occurrence requests are bounded and reach later contexts without duplicating image approval',async()=>{
 const occurrences=Array.from({length:70},(_,i)=>({id:`o${i}`,locator:`img${i}`,sectionId:`s${i}`,figureId:null,captionId:null,alt:''}));
 const e={...evidence,images:[{...evidence.images[0],occurrences,occurrenceWindows:[occurrences.slice(0,32).map(o=>o.id),occurrences.slice(32,64).map(o=>o.id),occurrences.slice(64).map(o=>o.id)]}]};
 let calls=0,later=false;const digest=await quoteHash('fixture');
 const result=await associateWebpageImages({budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[fact],evidence:e,readImage:async()=>({ok:true,value:{bytes,mediaType:'image/png'}}),digest:async()=>digest,logger:()=>{},generate:async command=>{
 const input=/** @type {{operation:string,candidates?:{occurrences:typeof occurrences}[]}} */(command.input);
 if(input.operation==='match-webpage-images'){calls++;assert(input.candidates?.every(c=>c.occurrences.length<=32)===true);later ||= input.candidates?.some(c=>c.occurrences.some(o=>o.id==='o69'))===true;return {ok:true,value:{matches:[{normalizedHash:'ratio',status:'match',imageId:'actual',imageDigest:digest}]}};}
 return {ok:true,value:{supported:true,imageId:'actual',imageDigest:digest,visibleEvidence:'Quantity labels.'}};
 }}); assert(result.ok&&result.value[0].status==='match'&&calls===3&&later);
});

Deno.test('a failed later candidate blocks display but preserves verified evidence',async()=>{
 const digest=await quoteHash('fixture');
 const result=await associateWebpageImages({budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[fact],evidence:{...evidence,images:[...evidence.images,{...evidence.images[0],id:'bad',url:'https://image.example/bad.png'}]},logger:()=>{},digest:async()=>digest,readImage:async url=>url.endsWith('bad.png')?{ok:false,error:{kind:'CandidateReadFailed'}}:{ok:true,value:{bytes,mediaType:'image/png'}},generate:async command=>command.taskId==='webpage-image-match'?{ok:true,value:{matches:[{normalizedHash:'ratio',status:'match',imageId:'actual',imageDigest:digest}]}}:{ok:true,value:{supported:true,imageId:'actual',imageDigest:digest,visibleEvidence:'Quantity labels.'}}});
 assert(result.ok&&result.value[0].status==='not-evaluated'&&result.value[0].failureKind==='CandidateReadFailed'&&result.value[0].image===undefined&&result.value[0].verifiedBindings?.length===1);
});
Deno.test('later model failure blocks display but preserves verified evidence',async()=>{
 const digest=await quoteHash('fixture');let matches=0;
 const occurrences=Array.from({length:33},(_,i)=>({...evidence.images[0].occurrences[0],id:`o${i}`}));
 const result=await associateWebpageImages({budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[fact],evidence:{...evidence,images:[{...evidence.images[0],occurrences,occurrenceWindows:[occurrences.slice(0,32).map(o=>o.id),['o32']]}]},logger:()=>{},digest:async()=>digest,readImage:async()=>({ok:true,value:{bytes,mediaType:'image/png'}}),generate:async command=>command.taskId==='webpage-image-match'?++matches===1?{ok:true,value:{matches:[{normalizedHash:'ratio',status:'match',imageId:'actual',imageDigest:digest}]}}:{ok:false,error:{kind:'CandidateModelFailed'}}:{ok:true,value:{supported:true,imageId:'actual',imageDigest:digest,visibleEvidence:'Quantity labels.'}}});
 assert(result.ok&&result.value[0].status==='not-evaluated'&&result.value[0].failureKind==='CandidateModelFailed'&&result.value[0].image===undefined&&result.value[0].verifiedBindings?.length===1);
});

Deno.test('matching and verification dispatch strict response schemas',async()=>{
 const digest=await quoteHash('fixture');let calls=0;
 const result=await associateWebpageImages({budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[fact],evidence,readImage:async()=>({ok:true,value:{bytes,mediaType:'image/png'}}),digest:async()=>digest,logger:()=>{},generate:async command=>{
 assert(command.responseSchema?.schema.additionalProperties===false);calls++;
 if(command.phase==='match'){const matches=JSON.parse(JSON.stringify(command.responseSchema?.schema)).properties.matches,variants=matches.items.anyOf;assert(matches.minItems===1&&matches.maxItems===1);assert(variants.every(/** @param {{properties:{normalizedHash:{enum:string[]}}}} v */ v=>v.properties.normalizedHash.enum.join(',')==='ratio'));assert(variants.length===2&&variants[0].properties.status.enum[0]==='match'&&variants[0].properties.imageId.type==='string');assert(variants[1].properties.imageId.type==='null'&&variants[1].properties.imageDigest.type==='null'&&variants[1].properties.status.enum.includes('ambiguous'));}
 if(command.phase==='verify'){const schema=JSON.parse(JSON.stringify(command.responseSchema?.schema));assert(schema.properties.visibleEvidence.maxLength===500);assert(command.systemPrompt.includes('at most 500 characters'));}
 return command.phase==='match'?{ok:true,value:{matches:[{normalizedHash:'ratio',status:'match',imageId:'actual',imageDigest:digest}]}}:{ok:true,value:{supported:true,imageId:'actual',imageDigest:digest,visibleEvidence:'Quantity labels.'}};
 }});assert(result.ok&&result.value[0].status==='match'&&calls===2);
});

Deno.test('deferred quality review returns only an unverified image selection and skips the redundant verifier',async()=>{
 const digest=await quoteHash('fixture');let calls=0;
 const result=await associateWebpageImages({deferQualityReview:true,budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[fact],evidence,readImage:async()=>({ok:true,value:{bytes,mediaType:'image/png'}}),digest:async()=>digest,logger:()=>{},generate:async command=>{
   calls++;assert(command.phase==='match');assert(command.systemPrompt.includes('provisional selection'));
   return {ok:true,value:{matches:[{normalizedHash:'ratio',status:'match',imageId:'actual',imageDigest:digest}]}};
 }});
 assert(result.ok&&calls===1);
 if(result.ok){const selected=result.value[0];assert(selected.status==='review-pending'&&selected.image?.id==='actual'&&selected.selectedImageDigest===digest);assert(selected.binding===undefined&&selected.verifiedBindings===undefined);}
});

Deno.test('deferred selections preserve abstentions, identity failures and matcher outages',async()=>{
 const digest=await quoteHash('fixture');
 for(const status of ['no-support','ambiguous','unreadable','wrong-digest','outage']) {
   const result=await associateWebpageImages({deferQualityReview:true,budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[fact],evidence,readImage:async()=>({ok:true,value:{bytes,mediaType:'image/png'}}),digest:async()=>digest,logger:()=>{},generate:async command=>{
     assert(command.phase==='match');
     if(status==='outage')return {ok:false,error:{kind:'KnowledgeModelResponseInvalid'}};
     return {ok:true,value:{matches:[{normalizedHash:'ratio',status:status==='wrong-digest'?'match':status,imageId:status==='wrong-digest'?'actual':null,imageDigest:status==='wrong-digest'?'sha256:wrong':null}]}};
   }});
   assert(result.ok);
   if(result.ok){const selected=result.value[0];assert(selected.status===(['outage','wrong-digest'].includes(status)?'not-evaluated':status));assert(selected.image===undefined&&selected.binding===undefined);if(status==='outage')assert(selected.failureKind==='KnowledgeModelResponseInvalid');}
 }
});

Deno.test('deferred candidate acquisition failure keeps the selection unavailable for publication',async()=>{
 const digest=await quoteHash('fixture');
 const result=await associateWebpageImages({deferQualityReview:true,budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[fact],evidence:{...evidence,images:[...evidence.images,{...evidence.images[0],id:'bad',url:'https://image.example/bad.png'}]},logger:()=>{},digest:async()=>digest,readImage:async url=>url.endsWith('bad.png')?{ok:false,error:{kind:'CandidateReadFailed'}}:{ok:true,value:{bytes,mediaType:'image/png'}},generate:async command=>{
   assert(command.phase==='match');return {ok:true,value:{matches:[{normalizedHash:'ratio',status:'match',imageId:'actual',imageDigest:digest}]}};
 }});
 assert(result.ok&&result.value[0].status==='not-evaluated'&&result.value[0].failureKind==='CandidateReadFailed'&&result.value[0].image===undefined&&result.value[0].binding===undefined);
});

Deno.test('image matcher accepts a shuffled exact fact-hash bijection and preserves fact output order',async()=>{
 const facts=[fact,{...fact,normalizedHash:'second',summary:'Another supported relationship.'}],digest=await quoteHash('fixture');let verifiers=0;
 const result=await associateWebpageImages({budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts,evidence,readImage:async()=>({ok:true,value:{bytes,mediaType:'image/png'}}),digest:async()=>digest,logger:()=>{},generate:async command=>{
   if(command.phase==='match')return {ok:true,value:{matches:[...facts].reverse().map(point=>({normalizedHash:point.normalizedHash,status:'match',imageId:'actual',imageDigest:digest}))}};
   verifiers++;return {ok:true,value:{supported:true,imageId:'actual',imageDigest:digest,visibleEvidence:'Readable quantity labels and the depicted comparison.'}};
 }});
 assert(result.ok&&verifiers===2);if(result.ok){assert(result.value.map(item=>item.normalizedHash).join(',')==='ratio,second');assert(result.value.every(item=>item.status==='match'&&item.binding?.originalDigest===digest));}
});

Deno.test('image matcher rejects duplicate, foreign and missing fact identities before verification',async()=>{
 const facts=[fact,{...fact,normalizedHash:'second'}],digest=await quoteHash('fixture');
 for(const ids of [['ratio','ratio'],['ratio','foreign'],['ratio']]) {
   let verifiers=0;
   const result=await associateWebpageImages({budget,scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts,evidence,readImage:async()=>({ok:true,value:{bytes,mediaType:'image/png'}}),digest:async()=>digest,logger:()=>{},generate:async command=>{
     if(command.phase!=='match'){verifiers++;throw new Error('Untrusted identity must not reach verifier.');}
     return {ok:true,value:{matches:ids.map(normalizedHash=>({normalizedHash,status:'match',imageId:'actual',imageDigest:digest}))}};
   }});
   assert(result.ok&&verifiers===0);if(result.ok)assert(result.value.every(item=>item.status==='not-evaluated'&&item.failureKind==='WebpageImageMatcherInvalid'&&item.image===undefined&&item.binding===undefined));
 }
});
