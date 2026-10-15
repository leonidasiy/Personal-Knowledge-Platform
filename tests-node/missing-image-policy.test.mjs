import {syntheticAssessment} from './fixtures/knowledge-review-audit.mjs';
import {syntheticRelationshipUnits} from './fixtures/webpage-condition-partition.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createKnowledgeWorkflowRuntime} from '../worker/knowledge-workflow-runtime.js';
import {createKnowledgeWorkflowService} from '../src/features/knowledge-workflows/workflow.js';
import {createAgentConfigurationLoader} from '../src/features/knowledge-workflows/config.js';
import {D1KnowledgeWorkflowRepository} from '../worker/knowledge-workflow-d1.js';
import {associateWebpageImages,imageHash} from '../worker/webpage-images.js';
import {WEBPAGE_IMAGE_POLICY} from '../worker/webpage-image-budget.js';
const unwrap=r=>{assert.equal(r.ok,true,JSON.stringify(r.error));return r.value;};
const root='https://policy.invalid/course/',imageUrl='https://pixels.invalid/optional-image.png';
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
// Scripted ports and in-memory migrated SQLite only: no provider, browser, DNS or network.
async function fixture(variant){
 const db=new DatabaseSync(':memory:');
 for(const file of (await readdir('worker/migrations')).filter(f=>f.endsWith('.sql')).sort())db.exec(await readFile('worker/migrations/'+file,'utf8'));
 const database={prepare(sql){let values=[];const execute=()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}});return {bind(...v){values=v;return this;},first:async()=>db.prepare(sql).get(...values)??null,all:async()=>({success:true,results:db.prepare(sql).all(...values)}),run:async()=>execute(),execute};},async batch(statements){db.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>s.execute());db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const now=()=>new Date().toISOString(),ownerId='policy-owner',sourceId='policy-source';let ids=0;
 const service=createKnowledgeWorkflowService(new D1KnowledgeWorkflowRepository({database,logger:()=>{}}),{now,createId:()=>`policy-${++ids}`,logger:()=>{}});
 const configs={},loader=createAgentConfigurationLoader({sha256:async text=>'sha256:'+createHash('sha256').update(text).digest('hex')});
 for(const role of ['rights-assessor','knowledge-scraper','question-generator','question-evaluator'])configs[role]=unwrap(await loader.load({source:await readFile(`agent-config/${role}.yaml`,'utf8'),expectedRole:role}));
 db.prepare('INSERT INTO library_sources(owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(ownerId,sourceId,root,root,'Policy fixture','Isolated source','{}','[]','active',now(),now(),1);
 let run=unwrap(await service.createRun({ownerId,sourceId,sourceRevision:1,canonicalSourceIdentity:root,contentSignature:'policy-fixture',idempotencyKey:'policy-start',configDigests:Object.fromEntries(Object.entries(configs).map(([r,c])=>[r,c.digest])),userAuthorization:{kind:'user-authorized-link',ownerId,sourceId,sourceRevision:1,url:root,recordedAt:now()}})).run;
 run=unwrap(await service.advance({ownerId,runId:run.runId,expectedRevision:run.revision,nextState:'rights-assessment'}));
 const urls=[root,...Array.from({length:6},(_,i)=>root+'lesson-'+(i+1))],requests=[],reads=[],pages=[],media=[],logs=[];
 const makeRuntime=()=>createKnowledgeWorkflowRuntime({database,imagePolicy:WEBPAGE_IMAGE_POLICY,configSnapshots:configs,now,nowMs:Date.now,logger:entry=>logs.push(entry),apiKey:'synthetic-not-a-secret',endpoint:'https://unexecuted.invalid/',resolveAddresses:async()=>({ok:true,value:['93.184.216.34']}),
  fetch:async(_url,init)=>{
   const message=JSON.parse(init.body).messages[1].content,body=Array.isArray(message)?message[0].text:message;
   const input=JSON.parse(body.slice(body.indexOf('\n')+1,body.lastIndexOf('\n'))),task=input.task?.task??input.task??input;requests.push({...input,task});let output;
   if(['plan','replan'].includes(task.operation))output={revision:1,frontier:urls.filter(u=>!task.scratchpad.processedUrls.includes(u)),coverageGoals:[],unresolvedGaps:[],stopDecision:{decision:task.scratchpad.processedUrls.length===urls.length?'complete':'continue',rationale:'Observe remaining source text.',evidenceUrls:[],unresolvedGapIds:[]}};
   else if(task.operation==='extract-webpage-facts')output={notes:'Independent source text retained.',candidates:task.sourceBlocks.map((b,i)=>({summary:b.text,normalizedHash:task.url+':'+i,evidenceAnchors:[{reference:task.citationSources.find(s=>s.sourceId===b.id).reference,clause:b.text}],coverageGoalIds:[],mediaCandidates:[]}))};
   else if(task.operation==='normalize-webpage-claim-boundaries')output={notes:task.notes,additionalCandidates:[],reviews:task.candidates.map(c=>({sourceNormalizedHash:c.normalizedHash,relationshipUnits:syntheticRelationshipUnits([c]),candidates:[c]}))};
  else if(task.operation==='verify-webpage-facts')output={verdicts:task.candidates.map(c=>({normalizedHash:c.normalizedHash,grounded:true,useful:true}))};
   else if(task.operation==='match-webpage-images'){
    const late=task.facts.every(f=>f.normalizedHash.startsWith(urls[6]+':'));
    output={matches:task.facts.map((f,i)=>({normalizedHash:f.normalizedHash,status:(late||variant==='mixed')&&i===0?'match':'no-support',imageId:(late||variant==='mixed')&&i===0?task.candidates[0].id:null,imageDigest:(late||variant==='mixed')&&i===0?task.candidates[0].digest:null}))};
   }else if(task.operation==='verify-webpage-image')output={supported:true,imageId:task.candidate.id,imageDigest:task.candidate.digest,visibleEvidence:'Synthetic matching labels.'};
   else if(task.operation==='assess-webpage-image-purpose')output={purpose:'evidence',imageId:task.imageId,imageDigest:task.imageDigest,visibleEvidence:'Synthetic quantity labels.'};
   else if(task.auditEvidence && task.currentAttachmentIds)output=syntheticAssessment(task,{decision:'pass',reasons:['Constructed fixture'],feedback:'Constructed source support.',matchedLessOftenIds:[],allowTextOnly:false,supportingImageEvidence:task.currentAttachmentIds.length?'Synthetic quantity labels.':''});
   else if(task.source&&task.points)output={mainSubject:'music',topic:'Fixture relations'};
   else if(task.draft)output={score:9,reasons:['Scripted fixture'],feedback:'Source relation.',groundingProblems:[],knowledgeGroundingProblems:[]};
   else if(task.knowledge)output={knowledgeId:task.knowledge.id,knowledgeRevision:1,canonicalAnswers:['relation'],citedEvidenceUrls:task.knowledge.evidenceAnchors.map(a=>a.url),multipleChoice:{prompt:`What is supported by ${task.knowledge.id}?`,options:[{key:'a',text:'Relation'},{key:'b',text:'Other'}],correctOptionKeys:['a'],correctOptionAnswers:[{key:'a',canonicalAnswer:'relation'}],explanation:'Source relation.'},fillBlank:{prompt:'A ____ is supported.',blanks:[{id:'blank-1',canonicalAnswer:'relation',acceptedAnswers:['relation']}],explanation:'Source relation.'}};
   else assert.fail('Unexpected scripted task');
   return Response.json({id:'scripted-'+requests.length,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]});
  },browser:{readPage:async({url})=>{
   pages.push(url);const index=urls.indexOf(url),hasImages=index===6||index===0&&variant!=='absent';
   const images=hasImages?[{id:index===6?'later-image':'optional-image',url:imageUrl,occurrences:[{id:'o',locator:'img',sectionId:'s',figureId:null,captionId:null,alt:'Optional image metadata'}],occurrenceWindows:[['o']]}]:[];
   if(index===0&&variant==='mixed')images.push({...images[0],id:'failed-image',url:'https://pixels.invalid/failed-image.png'});
   const blocks=[0,1].map(i=>({id:'b'+i,locator:'p'+i,sectionId:'s',kind:'text',text:`Source relation ${index}.${i} preserves its conditions.`,figureId:null}));
   return {ok:true,value:{url,responseUrl:url,evidence:{url,headings:[],blocks,images,warnings:[]},contentType:'text/html',bytes:new TextEncoder().encode('<main>'+blocks.map(b=>'<p>'+b.text+'</p>').join('')+'</main>'),redirects:0}};
  },readRobots:async()=>({ok:true,value:{status:200,bytes:new TextEncoder().encode('User-agent: *\nAllow: /')}}),screenshot:async()=>assert.fail('No screenshot'),close:async()=>({ok:true,value:null})},
  publicEgress:{fetch:async request=>{reads.push(request.url);return variant==='unavailable'&&reads.length===1||request.url.endsWith('failed-image.png')?{ok:false,error:{kind:'MediaPublicEgressUnavailable'}}:{ok:true,value:new Response(png,{headers:{'content-type':'image/png'}})};}},
  reviewMedia:{readOriginal:async scope=>{const saved=media.find(m=>m.knowledgeId===scope.knowledgeId);return {ok:true,value:saved?{id:saved.binding.imageId,bytes:saved.bytes,mediaType:saved.candidate.mediaTypeHint}:null};}},media:{ingest:async()=>assert.fail('No refetch'),ingestBytes:async command=>{media.push(command);return {ok:true,value:{}};}},transition:({run:current,nextState,...rest})=>service.advance({ownerId,runId:current.runId,expectedRevision:current.revision,nextState,...rest})});
 const context=()=>({scratchpad:JSON.parse(db.prepare('SELECT scratchpad_json FROM extraction_scratchpads').get().scratchpad_json),memory:db.prepare('SELECT kind,payload_json FROM agent_memory_records').all().map(r=>({...r,payload_json:JSON.parse(r.payload_json)})),plannerRequests:requests.filter(r=>['plan','replan'].includes(r.task.operation))});
 return {db,service,run,makeRuntime,context,requests,reads,pages,media,logs,urls};
}
for(const variant of ['absent','no-support','unavailable','mixed'])test('missing-image policy actual checkpoint replay '+variant,async()=>{
 const f=await fixture(variant);try{
  let current=f.run;
  for(let page=0;page<5;page++){
   const chunk=unwrap(await f.makeRuntime().execute(current));assert.equal(chunk.state,'awaiting-time-limit-decision');
   if(page<4)current=unwrap(await f.service.advance({ownerId:current.ownerId,runId:current.runId,expectedRevision:chunk.run.revision,nextState:'extraction-loop'}));
  }
  const checkpoint=f.context();assert.equal(checkpoint.scratchpad.processedUrls.length,5);
  const readsAtCheckpoint=f.reads.length,requestBoundary=f.requests.length;
  const paused=unwrap(await f.service.status({ownerId:f.run.ownerId,runId:f.run.runId}));
  const resumed=unwrap(await f.service.advance({ownerId:paused.ownerId,runId:paused.runId,expectedRevision:paused.revision,nextState:'extraction-loop'}));
  current=resumed;let finished;
  for(let chunk=0;chunk<20;chunk++){
   finished=unwrap(await f.makeRuntime().execute(current));
   if(finished.state==='completed')break;
   assert(['awaiting-time-limit-decision','per-point-quiz-loop'].includes(finished.state));
   current=finished.state==='awaiting-time-limit-decision'?unwrap(await f.service.advance({ownerId:current.ownerId,runId:current.runId,expectedRevision:finished.run.revision,nextState:'extraction-loop'})):finished.run;
  }
  assert.equal(finished.state,'completed');
  const continued=f.context(),points=f.db.prepare('SELECT point_json FROM extraction_knowledge_points').all().map(r=>JSON.parse(r.point_json));
  const warnings=f.db.prepare('SELECT warnings_json FROM knowledge_workflow_page_image_warnings').all().map(r=>JSON.parse(r.warnings_json));
  const forbidden=/Image warning:|no-support|MediaPublicEgressUnavailable|optional-image|failed-image|later-image|pixels\.invalid|imageDigest|pendingImage|missingImage/;
  const contexts={checkpoint,continued},absenceNotes=Object.fromEntries(Object.entries(contexts).map(([k,v])=>[k,(JSON.stringify(v).match(new RegExp(forbidden.source,'g'))??[]).length]));
  const out='test-results/full-image-review/missing-image-policy-fix';await mkdir(out,{recursive:true});
  await writeFile(out+'/replay-'+variant+'.json',JSON.stringify({variant,contexts,absenceNotes,warnings,readsAtCheckpoint,totalReads:f.reads.length,pages:f.pages,pointCount:points.length,mediaCount:f.media.length,attemptRows:f.db.prepare('SELECT attempt_key,evaluations,decoded_bytes,settled,output_json IS NOT NULL cached FROM knowledge_workflow_image_attempts').all(),logs:f.logs},null,2)+'\n');
  assert.equal(points.length,14);assert.deepEqual(f.pages,f.urls);
  for(const point of points){const [url,index]=[point.attribution.sourceUrl,Number(point.normalizedHash.slice(-1))];assert.equal(point.summary,`Source relation ${f.urls.indexOf(url)}.${index} preserves its conditions.`);if(url===root&&variant!=='mixed'||index===1)assert.deepEqual(point.mediaCandidates,[]);}
  assert.equal(f.media.length,1);assert.equal(f.media[0].binding.originalDigest,await imageHash(png));
  assert.equal(readsAtCheckpoint,variant==='absent'?0:variant==='mixed'?2:1);
  if(variant==='absent')assert(!f.requests.slice(0,requestBoundary).some(r=>['match-webpage-images','verify-webpage-image'].includes(r.task.operation)));
  if(['unavailable','mixed'].includes(variant))assert(warnings.flat().some(w=>w.includes('MediaPublicEgressUnavailable')));
  assert(f.requests.slice(requestBoundary).filter(r=>r.task.operation==='match-webpage-images').every(r=>r.task.facts.every(fact=>fact.normalizedHash.startsWith(f.urls[6]+':'))),'Later image must never reconcile old text facts');
  assert.deepEqual(absenceNotes,{checkpoint:0,continued:0},'Image diagnostics/candidate obligations must stay outside source memory, scratchpad and planner context');
  for(const context of Object.values(contexts)){
   assert(context.scratchpad.pageNotes.every(p=>p.note==='Independent source text retained.'));
   assert(context.memory.filter(r=>r.payload_json.payload.phase==='page-observed').every(r=>r.payload_json.payload.note==='Independent source text retained.'));
   assert(context.plannerRequests.filter(r=>r.task.observation).every(r=>r.task.observation.notes==='Independent source text retained.'&&r.task.observation.candidates.every(c=>c.mediaCandidates.length===0)));
  }
 }finally{f.db.close();}
});
test('accepted facts with zero images skip every image port and preserve exact input',async()=>{
 const fact={summary:'Independent supported text.',normalizedHash:'fact',evidenceAnchors:[{url:root,selector:'p'}],coverageGoalIds:[],mediaCandidates:[]},before=structuredClone(fact);
 const forbidden=async()=>assert.fail('No optional image work');
 assert.deepEqual(unwrap(await associateWebpageImages({scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[fact],evidence:{url:root,headings:[],blocks:[],images:[],warnings:[]},readImage:forbidden,digest:forbidden,generate:forbidden,logger:()=>assert.fail('No image diagnostics'),budget:{reserve:forbidden,settle:forbidden}})),[]);
 assert.deepEqual(fact,before);
});
for(const variant of ['foreign-id','wrong-digest','verifier-rejection','ambiguous','unreadable','access','invalid-bytes','budget','model'])test('available-image failure remains explicit and unattached '+variant,async()=>{
 const fact={summary:'Independent supported text.',normalizedHash:'fact',evidenceAnchors:[{url:root,selector:'p'}],coverageGoalIds:[],mediaCandidates:[]},digest=await imageHash(png);
 const evidence={url:root,headings:[],blocks:[],warnings:[],images:[{id:'available',url:imageUrl,occurrences:[{id:'o',locator:'img',sectionId:'s',figureId:null,captionId:null,alt:''}],occurrenceWindows:[['o']]}]};
 let verified=0;const before=structuredClone(fact);
 const result=unwrap(await associateWebpageImages({scope:{ownerId:'owner',runId:'run',sourceRevision:1},facts:[fact],evidence,logger:()=>{},digest:imageHash,
  budget:{reserve:async()=>variant==='budget'?{ok:false,error:{kind:'WebpageImageBudgetNotEvaluated'}}:{ok:true,value:{deadlineAtMs:Date.now()+30000,maximumBytes:20*1024*1024}},settle:async()=>({ok:true,value:null})},
  readImage:async()=>variant==='access'?{ok:false,error:{kind:'MediaPublicEgressUnavailable'}}:{ok:true,value:{bytes:variant==='invalid-bytes'?new Uint8Array():png,mediaType:'image/png'}},
  generate:async command=>{
   if(command.taskId==='webpage-image-match')return variant==='model'?{ok:false,error:{kind:'KnowledgeModelUnavailable'}}:{ok:true,value:{matches:[{normalizedHash:'fact',status:['ambiguous','unreadable'].includes(variant)?variant:'match',imageId:['ambiguous','unreadable'].includes(variant)?null:variant==='foreign-id'?'foreign':'available',imageDigest:['ambiguous','unreadable'].includes(variant)?null:variant==='wrong-digest'?'sha256:'+'0'.repeat(64):digest}]}};
   verified++;return {ok:true,value:{supported:false,imageId:'available',imageDigest:digest,visibleEvidence:''}};
  }}))[0];
 assert.equal(result.image,undefined);assert.equal(result.binding,undefined);assert.deepEqual(fact,before);
 const errors={'foreign-id':'WebpageImageIdentityMismatch','wrong-digest':'WebpageImageIdentityMismatch',access:'MediaPublicEgressUnavailable','invalid-bytes':'WebpageImageBytesInvalid',budget:'WebpageImageBudgetNotEvaluated',model:'KnowledgeModelUnavailable'};
 if(errors[variant])assert.equal(result.failureKind,errors[variant]);
 assert.equal(result.status,['ambiguous','unreadable'].includes(variant)?variant:['budget','model','foreign-id','wrong-digest','access','invalid-bytes'].includes(variant)?'not-evaluated':'no-support');
 assert.equal(verified,variant==='verifier-rejection'?1:0);
});
