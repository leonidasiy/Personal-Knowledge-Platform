import {syntheticAssessment} from './fixtures/knowledge-review-audit.mjs';
import {syntheticRelationshipUnits} from './fixtures/webpage-condition-partition.mjs';
import { WEBPAGE_IMAGE_POLICY } from '../worker/webpage-image-budget.js';
import {D1SourceLibraryRepository} from '../worker/source-library-d1.js';
import {SourceLibraryService,validateApprovalCommand} from '../src/features/source-library/service.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
// Workflow fixtures inject captured evidence; DOM projection has separate browser tests.
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createKnowledgeWorkflowRuntime} from '../worker/knowledge-workflow-runtime.js';
import {createKnowledgeWorkflowService} from '../src/features/knowledge-workflows/workflow.js';
import {createAgentConfigurationLoader} from '../src/features/knowledge-workflows/config.js';
import {D1KnowledgeWorkflowRepository} from '../worker/knowledge-workflow-d1.js';
import {D1KnowledgeContentRepository} from '../worker/knowledge-workflow-content-d1.js';
import {D1SourceClassificationRepository} from '../worker/source-classification-d1.js';
import {D1KnowledgeMediaRepository} from '../worker/knowledge-workflow-media-d1.js';
import {createKnowledgeWorkflowCleanup} from '../worker/knowledge-workflow-cleanup.js';
import {createDiscoveryWorker} from '../worker/handler.js';
import {SourceLibraryRepository,sourceApprovalFingerprint} from '../src/features/source-library/repository.js';
import {prepareSubmittedLink} from '../src/features/source-library/submitted-link.js';
const unwrap=result=>{assert.equal(result.ok,true,JSON.stringify(result.error));return result.value;};
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
async function fixture(options={}) {
  const db=new DatabaseSync(':memory:');
  const migrations=new URL('../worker/migrations/',import.meta.url);
  for(const file of (await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort()) db.exec(await readFile(new URL(file,migrations),'utf8'));
  const database={prepare(query){let values=[];const execute=()=>({success:true,meta:{changes:Number(db.prepare(query).run(...values).changes)}});return {bind(...v){values=v;return this;},first:async()=>db.prepare(query).get(...values)??null,all:async()=>({success:true,results:db.prepare(query).all(...values)}),run:async()=>execute(),execute};},async batch(statements){db.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s.execute());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const now=()=>new Date().toISOString(),ownerId='fixture-owner',sourceId='fixture-source',rootUrl='https://source.example/course/';let ids=0;
  const repository=new D1KnowledgeWorkflowRepository({database,logger:()=>{}});
  let sourcePurges=0;
  const cleanup=createKnowledgeWorkflowCleanup({database,bucket:{delete:async()=>{}},sourceContent:{purge:async()=>{sourcePurges++;return {ok:true,value:null};}},workflowRepository:repository,now,logger:()=>{}});
  const service=createKnowledgeWorkflowService(repository,{now,createId:()=>`fixture-${++ids}`,logger:()=>{},cleanup});
  const configs={},loader=createAgentConfigurationLoader({sha256:async value=>`sha256:${createHash('sha256').update(value).digest('hex')}`});
  for(const role of ['rights-assessor','knowledge-scraper','question-generator','question-evaluator'])configs[role]=unwrap(await loader.load({source:await readFile(new URL(`../agent-config/${role}.yaml`,import.meta.url),'utf8'),expectedRole:role}));
  db.prepare('INSERT INTO library_sources(owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(ownerId,sourceId,rootUrl,rootUrl,'Fixture course','Fixture description','{}','[]','active',now(),now(),1);
  let run=unwrap(await service.createRun({ownerId,sourceId,sourceRevision:1,canonicalSourceIdentity:rootUrl,contentSignature:'fixture-content',idempotencyKey:'fixture-start',...(options.extractionScope?{extractionScope:options.extractionScope}:{}),configDigests:Object.fromEntries(Object.entries(configs).map(([role,c])=>[role,c.digest])),userAuthorization:{kind:'user-authorized-link',ownerId,sourceId,sourceRevision:1,url:rootUrl,recordedAt:now()}})).run;
  run=unwrap(await service.advance({ownerId,runId:run.runId,expectedRevision:run.revision,nextState:'rights-assessment'}));
  const pages=[],tasks=[],media=[],imageReads=[];
  let interrupt=options.interrupt;
  const transport=async(_url,init)=>{
    const body=JSON.parse(init.body),message=body.messages[1].content,text=Array.isArray(message)?message[0].text:message;
    const input=JSON.parse(text.slice(text.indexOf('\n')+1,text.lastIndexOf('\n')));const task=input.task?.task??input.task??input;tasks.push(task);
    let output;
    if(body.response_format?.json_schema?.name==='knowledge_batch_selection_v1')output={keptKnowledgeIds:task.points.map(point=>point.id)};
   else if(task.operation==='plan'||task.operation==='replan')output={revision:1,frontier:[rootUrl,...(task.operation==='replan'?[rootUrl+'lesson']:[])],coverageGoals:[],unresolvedGaps:[],stopDecision:{decision:task.scratchpad.processedUrls.length===(options.platformSibling?3:2)?'complete':'continue',rationale:'Inspect subtree inventory.',evidenceUrls:[],unresolvedGapIds:[]}};
    else if(task.operation==='extract-webpage-facts'){
      if(interrupt){interrupt=false;await options.interrupt({service,run:unwrap(await service.status({ownerId,runId:run.runId}))});}
      assert(!Array.isArray(message),'Text extraction never sees pixels');
      const b=task.sourceBlocks[0];
      output={notes:'Synthetic source text.',candidates:options.zeroRoot&&task.url===rootUrl?[]:[{summary:b.text,normalizedHash:task.url,evidenceAnchors:[{reference:task.citationSources.find(s=>s.sourceId===b.id).reference,clause:b.text}],coverageGoalIds:[],mediaCandidates:[]}]};
    }else if(task.operation==='normalize-webpage-claim-boundaries')output={notes:task.notes,additionalCandidates:[],reviews:task.candidates.map(c=>({sourceNormalizedHash:c.normalizedHash,relationshipUnits:syntheticRelationshipUnits([c]),candidates:[c]}))};
  else if(task.operation==='verify-webpage-facts')output={verdicts:task.candidates.map(c=>({normalizedHash:c.normalizedHash,grounded:true,useful:true}))};
    else if(task.operation==='match-webpage-images'){
      assert(Array.isArray(message));assert(message.filter(m=>m.type==='image_url').every(m=>m.image_url.url.startsWith('data:image/png;base64,')));
      assert(message.filter(m=>m.type==='image_url').length<=8);const image=task.candidates[0];
      output={matches:task.facts.map(f=>({normalizedHash:f.normalizedHash,status:task.candidates.some(c=>c.id==='image:1')?'match':'no-support',imageId:task.candidates.some(c=>c.id==='image:1')?(options.foreignImage?'invented':image.id):null,imageDigest:task.candidates.some(c=>c.id==='image:1')?image.digest:null}))};
    }else if(task.operation==='verify-webpage-image')output={supported:true,imageId:task.candidate.id,imageDigest:task.candidate.digest,visibleEvidence:'Synthetic quantity labels.'};
    else if(task.operation==='assess-webpage-image-purpose')output={purpose:'evidence',imageId:task.imageId,imageDigest:task.imageDigest,visibleEvidence:'Synthetic quantity labels.'};
   else if(task.auditEvidence && task.currentAttachmentIds)output=syntheticAssessment(task,{decision:'pass',reasons:['Constructed fixture'],feedback:'Constructed source support.',matchedLessOftenIds:[],allowTextOnly:false,supportingImageEvidence:task.currentAttachmentIds.length?'Synthetic quantity labels.':''});
   else if(task.source&&task.points)output={mainSubject:'music',topic:'Fixture relations'};
    else if(task.draft)output={score:9,reasons:['Fixture'],feedback:'Fixture evidence.',groundingProblems:[],knowledgeGroundingProblems:[]};
    else if(task.knowledge)output={knowledgeId:task.knowledge.id,knowledgeRevision:1,canonicalAnswers:['relation'],citedEvidenceUrls:task.knowledge.evidenceAnchors.map(a=>a.url),multipleChoice:{prompt:`What is supported at ${task.knowledge.id}?`,options:[{key:'a',text:'Relation'},{key:'b',text:'Other'}],correctOptionKeys:['a'],correctOptionAnswers:[{key:'a',canonicalAnswer:'relation'}],explanation:'Source relation.'},fillBlank:{prompt:'The supported ____ is shown.',blanks:[{id:'blank-1',canonicalAnswer:'relation',acceptedAnswers:['relation']}],explanation:'Source relation.'}};
    else assert.fail('Unexpected model task: '+JSON.stringify(task));
    return Response.json({id:`fixture-${tasks.length}`,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]});
  };
  const runtime=createKnowledgeWorkflowRuntime({imagePolicy:WEBPAGE_IMAGE_POLICY,database,fetch:transport,browser:{...(options.navigationForbidden?{inspect:async()=>assert.fail('Page scope cannot discover other pages'),click:async()=>assert.fail('Page scope cannot click to another page')}:{}),readPage:async({url})=>{pages.push(url);if(options.accessError)return {ok:false,error:{kind:options.accessError}};const finalUrl=options.redirect?url.replace(/lesson$/,'lesson/'):url;
      const locator='html:nth-of-type(1) > body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(1)';
      const imageUrls=options.images&&(!options.rootImagesOnly||url===rootUrl)?['https://images.example/diagram.png',...(options.twoLargeImages?['https://images.example/second.png']:options.nineImages?Array.from({length:8},(_,i)=>`https://images.example/${i}.png`):[])]:[];
      const claim=url===rootUrl?'A central supported relation.':url==='https://source.example/other-course/lesson'?'A separate supported relationship in another course.':'A distinct supported application.';
      const evidence={url:finalUrl,headings:[],blocks:options.imageOnly?[]:[{id:'dom:'+locator,locator,sectionId:'section:root',kind:'text',text:claim,figureId:null}],images:imageUrls.map((imageUrl,i)=>{const id=`occurrence:fixture:${i}`;return {id:`image:${i+1}`,url:imageUrl,occurrences:[{id,locator:`img:nth-of-type(${i+1})`,sectionId:'section:root',figureId:null,captionId:null,alt:''}],occurrenceWindows:[[id]]};}),warnings:options.pageWarning?['AcquisitionImageNotEvaluated']:[]};
      return {ok:true,value:{url,responseUrl:finalUrl,evidence,contentType:'text/html',bytes:new TextEncoder().encode(`<main>${claim} <a href="${rootUrl}lesson">Lesson</a>${options.platformSibling&&url===rootUrl+'lesson'?'<a href="https://source.example/other-course/lesson">Sibling course lesson</a>':''}${options.images&&(!options.rootImagesOnly||url===rootUrl)?'<img src="https://images.example/diagram.png" alt="Two cases">'+(options.twoLargeImages?'<img src="https://images.example/second.png" alt="Other cases">':options.nineImages?Array.from({length:8},(_,i)=>`<img src="https://images.example/${i}.png" alt="Other cases">`).join(''):''):''}</main>`),redirects:0}};},readRobots:async()=>({ok:true,value:{status:200,bytes:new TextEncoder().encode('User-agent: *\nAllow: /')}}),screenshot:async()=>assert.fail('No screenshot fallback'),close:async()=>({ok:true,value:null})},apiKey:'fixture',endpoint:'https://model.example/',now,nowMs:Date.now,logger:()=>{},configSnapshots:configs,resolveAddresses:async()=>({ok:true,value:['93.184.216.34']}),publicEgress:{fetch:async request=>{imageReads.push(request.url);return (options.imageFailure||options.mixedFailure&&request.url.endsWith('second.png'))?{ok:false,error:{kind:'MediaPublicEgressUnavailable'}}:{ok:true,value:new Response(options.twoLargeImages?Uint8Array.from({length:(options.imageMiB??17)*1024*1024},(_,i)=>png[i]??0):png,{headers:{'content-type':'image/png'}})};}},reviewMedia:{readOriginal:async scope=>{const saved=media.find(m=>m.knowledgeId===scope.knowledgeId);return {ok:true,value:saved?{id:saved.binding.imageId,bytes:saved.bytes,mediaType:saved.candidate.mediaTypeHint}:null};}},media:{ingest:async()=>assert.fail('Do not refetch a grounded image'),ingestBytes:async command=>{media.push(command);return options.mediaFailure?{ok:false,error:{kind:'MediaStorageFailed'}}:{ok:true,value:{}};}},transition:({run:current,nextState,...rest})=>service.advance({ownerId,runId:current.runId,expectedRevision:current.revision,nextState,...rest})});
  async function complete() {
    let current=unwrap(await service.status({ownerId,runId:run.runId}));
    const originalDeadline=current.extractionDeadlineAt;
    for (;;) {
      const result=await runtime.execute(current);
      if(!result.ok)return result;
      const next=result.value.run;
      if(result.value.state==='per-point-quiz-loop') {
        assert(next.revision>current.revision,'A quiz chunk must durably advance');
        current=next;
      } else if(result.value.state==='awaiting-time-limit-decision'&&Date.parse(next.extractionDeadlineAt)>Date.now()) {
        current=unwrap(await service.advance({ownerId,runId:run.runId,expectedRevision:next.revision,nextState:'extraction-loop'}));
      } else return result;
      if(originalDeadline!==null)assert.equal(current.extractionDeadlineAt,originalDeadline,'Scheduling never replenishes the source clock');
    }
  }
  return {db,database,service,run,runtime,complete,pages,tasks,media,imageReads,sourcePurges:()=>sourcePurges,close:()=>db.close()};
}
test('authorized Link uses the Discover subtree workflow and publishes paired quizzes without rights attestation',async()=>{
  const f=await fixture();try{const result=unwrap(await f.complete());assert.equal(result.state,'completed');assert.deepEqual(f.pages,['https://source.example/course/','https://source.example/course/lesson']);assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_workflow_quizzes').get().n,2,JSON.stringify(f.db.prepare('SELECT failure_kind,feedback FROM knowledge_workflow_quiz_retry_attempts').all()));assert.equal(f.db.prepare('SELECT count(*) AS n FROM learning_generation_tasks').get().n,2);assert(!f.tasks.some(task=>task.registry),'No invented licence or rights assessor requirement');assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_source_manifests').get().n,0,'Personal Link processing does not grant global reuse');}finally{f.close();}
});
for(const accessError of ['KnowledgePagePaywallDetected','KnowledgePageAuthenticationRequired','KnowledgePageTypeUnsupported','KnowledgePageFetchFailed','KnowledgeBrowserTimedOut','KnowledgeBrowserNavigationRejected','KnowledgeBrowserNetworkRejected'])test(`Link preserves explicit ${accessError}`,async()=>{
  const f=await fixture({accessError});try{const result=await f.runtime.execute(f.run);if(['KnowledgePageFetchFailed','KnowledgeBrowserTimedOut'].includes(accessError)){assert.equal(result.ok,true);const saved=JSON.parse(f.db.prepare('SELECT scratchpad_json FROM extraction_scratchpads').get().scratchpad_json);assert.equal(saved.failedPages[0].failureKind,accessError);assert.equal(saved.failedPages[0].attempts,4);assert.equal(f.pages.length,4);assert.equal(unwrap(await f.service.status({ownerId:f.run.ownerId,runId:f.run.runId})).failureKind,'WorkflowPagesFailed');}else{assert.equal(result.ok,false);assert(JSON.stringify(result.error).includes(accessError));}assert.equal(f.db.prepare('SELECT count(*) AS n FROM extraction_knowledge_points').get().n,0);}finally{f.close();}
});
test('webpage images are acquired before model attachment and exact evidence is bound to the point',async()=>{
  const f=await fixture({images:true});try{unwrap(await f.complete());assert.equal(f.imageReads.length,2);assert.equal(f.media.length,2);assert(f.media.every(m=>m.candidate.kind==='image'));assert(f.media.every(m=>m.bytes instanceof Uint8Array&&m.candidate.url==='https://images.example/diagram.png'));}finally{f.close();}
});
for(const options of [{images:true,imageFailure:true},{images:true,foreignImage:true}])test('image failure or invented association preserves text with explicit warnings '+JSON.stringify(options),async()=>{
  const f=await fixture(options);try{unwrap(await f.complete());assert.equal(f.media.length,0);const points=f.db.prepare('SELECT point_json FROM extraction_knowledge_points').all().map(row=>JSON.parse(row.point_json));assert.equal(points.length,2);assert(points.every(p=>p.imageWarnings?.length>0),'Warnings retained with supported text');}finally{f.close();}
});
test('cancellation fences ignored late model completion and preserves source-wide preexisting content',async()=>{
  const f=await fixture({interrupt:async({service,run})=>unwrap(await service.control({ownerId:run.ownerId,runId:run.runId,expectedRevision:run.revision,action:'abandon',idempotencyKey:'fixture-cancel'}))});
  try{const result=await f.runtime.execute(f.run);assert.equal(result.ok,false);assert.equal(f.db.prepare('SELECT count(*) AS n FROM extraction_knowledge_points').get().n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_memory_namespaces').get().n,0);assert.equal(f.sourcePurges(),0,'Abandonment never purges preexisting source-wide bodies');const status=unwrap(await f.service.status({ownerId:f.run.ownerId,runId:f.run.runId}));assert.equal(status.state,'abandoned');}finally{f.close();}
});

test('atomic cancellation rejects direct late point persistence after cleanup',async()=>{
  const f=await fixture();try{const canceled=unwrap(await f.service.control({ownerId:f.run.ownerId,runId:f.run.runId,expectedRevision:f.run.revision,action:'abandon',idempotencyKey:'cancel-direct'}));const repo=new D1KnowledgeContentRepository({database:f.database,logger:()=>{}});const result=await repo.appendKnowledgePoint({id:'late',sourceId:f.run.sourceId,sourceRevision:1,summary:'Late supported text',normalizedHash:'late',evidenceAnchors:[{url:f.run.canonicalSourceIdentity,selector:'main'}]},f.run.ownerId,f.run.runId,new Date().toISOString());assert.equal(result.ok,false);assert.equal(f.db.prepare('SELECT count(*) AS n FROM extraction_knowledge_points').get().n,0);assert.equal(canceled.state,'abandoned');}finally{f.close();}
});

test('media persistence failure preserves points with an explicit warning',async()=>{
  const f=await fixture({images:true,mediaFailure:true});try{unwrap(await f.complete());const points=f.db.prepare('SELECT point_json FROM extraction_knowledge_points').all().map(row=>JSON.parse(row.point_json));assert.equal(points.length,2);assert(points.every(p=>p.imageWarnings?.some(w=>w.includes('MediaStorageFailed'))));const warnings=unwrap(await new D1KnowledgeContentRepository({database:f.database,logger:()=>{}}).loadImageWarnings({ownerId:f.run.ownerId,runId:f.run.runId}));assert(warnings.some(w=>w.includes('MediaStorageFailed')));}finally{f.close();}
});

test('canceled late media write removes only its newly written object',async()=>{
  const f=await fixture();try{
    unwrap(await f.service.control({ownerId:f.run.ownerId,runId:f.run.runId,expectedRevision:f.run.revision,action:'abandon',idempotencyKey:'cancel-media'}));
    const objects=new Map([['preexisting',png]]),deleted=[];
    const bucket={put:async(key,bytes)=>objects.set(key,bytes),get:async()=>null,delete:async key=>{deleted.push(key);objects.delete(key);}};
    const repo=new D1KnowledgeMediaRepository({database:f.database,bucket,logger:()=>{}});
    const result=await repo.save({ownerId:f.run.ownerId,runId:f.run.runId,knowledgeId:'late',assetId:'late-asset',sourceUrl:'https://images.example/diagram.png',origin:'https://images.example',kind:'image',mediaType:'image/png',byteCount:png.length,digest:'fixture',privateOriginalKey:'attempt-original',attribution:'Source diagram; licence unverified',createdAt:new Date().toISOString()},{ownerId:f.run.ownerId,assetId:'late-asset',derivativeId:'late-feed',variant:'feed',mediaType:'image/png',byteCount:png.length,privateObjectKey:'attempt-derivative',deliveryToken:'late:feed',createdAt:new Date().toISOString()},png);
    assert.equal(result.ok,false);assert.deepEqual([...objects.keys()],['preexisting']);assert.deepEqual(deleted,['attempt-derivative']);
  }finally{f.close();}
});
test('cancellation preserves a completed preexisting source reuse manifest',async()=>{
  const f=await fixture();try{const repo=new D1KnowledgeWorkflowRepository({database:f.database,logger:()=>{}});unwrap(await repo.markReuse({canonicalSourceIdentity:f.run.canonicalSourceIdentity,sourceRevision:1,contentSignature:'preexisting',configDigests:f.run.configDigests,counts:f.run.counts,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));unwrap(await f.service.control({ownerId:f.run.ownerId,runId:f.run.runId,expectedRevision:f.run.revision,action:'abandon',idempotencyKey:'cancel-reuse'}));assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_source_manifests').get().n,1);}finally{f.close();}
});

test('cancellation purges attempt classification and fences late classifier issues',async()=>{
  const f=await fixture();try{const repo=new D1SourceClassificationRepository({database:f.database,now:()=>new Date().toISOString(),logger:()=>{}}),scope={ownerId:f.run.ownerId,runId:f.run.runId,sourceId:f.run.sourceId,sourceRevision:1};unwrap(await repo.persistAgent({...scope,classification:{mainSubject:'music',topic:'Attempt topic'},legacyAudit:[]}));unwrap(await f.service.control({ownerId:f.run.ownerId,runId:f.run.runId,expectedRevision:f.run.revision,action:'abandon',idempotencyKey:'cancel-classifier'}));assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_classifications').get().n,0);assert.equal((await repo.persistAgent({...scope,classification:{mainSubject:'music',topic:'Late topic'},legacyAudit:[]})).ok,false);assert.equal((await repo.recordReviewIssue({...scope,issueKind:'inference-failed'})).ok,false);assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_classification_review_issues').get().n,0);}finally{f.close();}
});
test('cancellation preserves preexisting classification and review issue fields',async()=>{
  const f=await fixture();try{const repo=new D1SourceClassificationRepository({database:f.database,now:()=>new Date().toISOString(),logger:()=>{}}),scope={ownerId:f.run.ownerId,sourceId:f.run.sourceId,sourceRevision:1};unwrap(await repo.updateManual({...scope,expectedRevision:0,classification:{mainSubject:'music',topic:'Owner topic'}}));unwrap(await repo.recordReviewIssue({...scope,issueKind:'legacy-conflict'}));const before=JSON.stringify(f.db.prepare('SELECT * FROM source_classifications').all()),issues=JSON.stringify(f.db.prepare('SELECT * FROM source_classification_review_issues').all());unwrap(await repo.persistAgent({...scope,runId:f.run.runId,classification:{mainSubject:'music',topic:'Attempt topic'},legacyAudit:[]}));unwrap(await repo.recordReviewIssue({...scope,runId:f.run.runId,issueKind:'inference-failed'}));unwrap(await f.service.control({ownerId:f.run.ownerId,runId:f.run.runId,expectedRevision:f.run.revision,action:'abandon',idempotencyKey:'cancel-preserve-classifier'}));assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM source_classifications').all()),before);assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM source_classification_review_issues').all()),issues);}finally{f.close();}
});

test('combined image attachment budget preserves text and explicitly warns for omitted bytes',async()=>{
 const f=await fixture({images:true,twoLargeImages:true});try{const result=unwrap(await f.complete());assert.equal(result.state,'completed');assert.equal(f.db.prepare('SELECT count(*) AS n FROM extraction_knowledge_points').get().n,2);assert(f.tasks.filter(t=>t.operation==='match-webpage-images').every(t=>t.candidates.length===1));const warnings=unwrap(await new D1KnowledgeContentRepository({database:f.database,logger:()=>{}}).loadImageWarnings({ownerId:f.run.ownerId,runId:f.run.runId}));assert(!warnings.some(w=>w.includes('KnowledgeModelAttachmentBudgetExceeded')),'Separate bounded batches evaluate both images');}finally{f.close();}
});
test('zero root facts skip image acquisition and retain empty-text diagnostics with successful child points',async()=>{
 const f=await fixture({images:true,imageFailure:true,rootImagesOnly:true,zeroRoot:true});try{const result=unwrap(await f.complete());assert.equal(result.state,'completed');assert.equal(f.db.prepare('SELECT count(*) AS n FROM extraction_knowledge_points').get().n,1);const warnings=unwrap(await new D1KnowledgeContentRepository({database:f.database,logger:()=>{}}).loadImageWarnings({ownerId:f.run.ownerId,runId:f.run.runId}));assert.equal(f.imageReads.length,0,'Zero facts never acquire pictures');assert(warnings.some(w=>w.includes('WebpageFactsEmpty')),'Empty extraction diagnostic survives SQLite reload');assert(!warnings.some(w=>w.startsWith('Image warning:')),'Zero facts produce no image warning');assert.equal(f.tasks.filter(t=>t.operation==='match-webpage-images').length,0);}finally{f.close();}
});
const restartCommand=run=>({ownerId:run.ownerId,sourceId:run.sourceId,sourceRevision:run.sourceRevision,canonicalSourceIdentity:run.canonicalSourceIdentity,contentSignature:run.contentSignature,idempotencyKey:run.idempotencyKey,configDigests:run.configDigests,userAuthorization:run.userAuthorization});

async function httpFixture() {
 const f=await fixture();let tick=0,ids=0;
 const now=()=>new Date(Date.UTC(2026,9,6)+ ++tick*1000).toISOString();
 const ownerId=f.run.ownerId;
 for(const area of ['http-area','other-area'])f.db.prepare('INSERT INTO interest_areas(owner_id,interest_area_id,label,provenance_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(ownerId,area,'Fixture area','{}',now(),now());
 const sourceLibrary=new SourceLibraryService({repository:new D1SourceLibraryRepository(f.database),now,createId:()=>`http-${++ids}`,ingestionPolicyVersion:'fixture'});
 const worker=createDiscoveryWorker({allowedOrigin:'https://app.example',maximumCommandBytes:4096},{now,createRequestId:()=>`request-${++ids}`,requestLogger:()=>({ok:true,value:null}),authenticate:async()=>({ok:true,value:{ownerId,email:'fixture@example.test'}}),acquireRss:async()=>assert.fail('No acquisition at approval'),sourceLibrary,knowledgeWorkflow:{start:async command=>{const result=await f.service.createRun(command);return result.ok?{ok:true,value:{runId:result.value.run.runId,reused:result.value.reused}}:result;},status:command=>f.service.status(command),control:command=>f.service.control(command)}});
 const command={title:'HTTP Link',url:'https://http-source.example/course/',interestAreaId:'http-area',idempotencyKey:'http-link'};
 const post=async(body=command)=>{const response=await worker.fetch(new Request('https://worker.example/api/source-library/extract',{method:'POST',headers:{origin:'https://app.example','content-type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
 const snapshot=()=>Object.fromEntries(['library_sources','library_source_events','source_interest_areas','source_ingestion_jobs','source_item_versions'].map(table=>[table,f.db.prepare(`SELECT * FROM ${table}`).all()]));
 return {...f,post,command,snapshot};
}
test('HTTP Link concurrent identical requests converge on one SQLite active attempt',async()=>{
 const f=await httpFixture();try{
  const responses=await Promise.all([f.post(),f.post()]);assert.deepEqual(responses.map(r=>r.status),[200,200],JSON.stringify(responses));
  const [first,second]=responses.map(r=>r.body);assert.equal(first.result.source.id,second.result.source.id);assert.equal(first.workflow.runId,second.workflow.runId);
  assert.deepEqual(second.result.source.identityEvidence,first.result.source.identityEvidence);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM library_source_events WHERE idempotency_key=?').get(f.command.idempotencyKey).n,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_workflow_runs WHERE source_id=?').get(first.result.source.id).n,1);
 }finally{f.close();}
});
test('HTTP Link later retry preserves observation provenance; changed identity conflicts without writes',async()=>{
 const f=await httpFixture();try{
  const first=await f.post();assert.equal(first.status,200,JSON.stringify(first));const before=f.snapshot();
  const retry=await f.post();assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(retry.body.workflow.runId,first.body.workflow.runId);
  assert.deepEqual(retry.body.result.source,{primarySubject:null,...first.body.result.source});assert.deepEqual(f.snapshot(),before);
  const evidence=first.body.result.source.identityEvidence[0];assert.equal(evidence.attribute,'user-submitted-url');assert.equal(evidence.value,f.command.url);assert.equal(evidence.provenanceUrl,f.command.url);assert.equal(evidence.observedAt,'2026-10-06T00:00:05.000Z');
  for(const changed of [{title:'Changed title'},{url:'https://other-source.example/course/'},{interestAreaId:'other-area'}]){const conflict=await f.post({...f.command,...changed});assert.equal(conflict.status,409,JSON.stringify(conflict));assert.equal(conflict.body.error,'SourceIdempotencyConflict');assert.deepEqual(f.snapshot(),before);}
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_workflow_runs WHERE source_id=?').get(first.body.result.source.id).n,1);
 }finally{f.close();}
});
test('HTTP Link cancelled retry creates a new SQLite attempt preserving existing source data',async()=>{
 const f=await httpFixture();try{
  const first=await f.post();assert.equal(first.status,200,JSON.stringify(first));const run=unwrap(await f.service.status({ownerId:f.run.ownerId,runId:first.body.workflow.runId}));
  unwrap(await f.service.control({ownerId:run.ownerId,runId:run.runId,expectedRevision:run.revision,action:'abandon',idempotencyKey:'http-cancel'}));const before=f.snapshot();
  const retry=await f.post();assert.equal(retry.status,200,JSON.stringify(retry));assert.notEqual(retry.body.workflow.runId,run.runId);assert.deepEqual(retry.body.result.source,{primarySubject:null,...first.body.result.source});assert.deepEqual(f.snapshot(),before);
  assert.equal(unwrap(await f.service.status({ownerId:run.ownerId,runId:run.runId})).state,'abandoned');assert.equal(unwrap(await f.service.status({ownerId:run.ownerId,runId:retry.body.workflow.runId})).state,'source-added');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_workflow_runs WHERE source_id=?').get(first.body.result.source.id).n,2);
 }finally{f.close();}
});
test('HTTP Link replays the earlier timestamp-bearing approval without rewriting provenance or fingerprint',async()=>{
 const f=await httpFixture();try{
  const first=await f.post();assert.equal(first.status,200);const row=f.db.prepare('SELECT command_fingerprint FROM library_source_events WHERE idempotency_key=?').get(f.command.idempotencyKey);
  const legacy=JSON.parse(row.command_fingerprint);legacy.identityEvidence=first.body.result.source.identityEvidence;
  f.db.prepare('UPDATE library_source_events SET command_fingerprint=? WHERE idempotency_key=?').run(JSON.stringify(legacy),f.command.idempotencyKey);const before=f.snapshot();
  const retry=await f.post();assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(retry.body.workflow.runId,first.body.workflow.runId);assert.deepEqual(f.snapshot(),before);
  const {ownerId:_owner,...publicCommand}=legacy;const changed={...publicCommand,identityStatus:'resolved',identityEvidence:[{...legacy.identityEvidence[0],provenanceUrl:'https://foreign.example/'}]};const conflict=await f.post(changed);assert.equal(conflict.status,409);assert.equal(conflict.body.error,'SourceIdempotencyConflict');assert.deepEqual(f.snapshot(),before);
 }finally{f.close();}
});
test('submitted Link identity matches in-memory replay while provider observations remain strict',async()=>{
 for(const adapterId of ['submitted-link','provider']){
  let ids=0;const repo=new SourceLibraryRepository(),service=new SourceLibraryService({repository:repo,now:()=>new Date().toISOString(),createId:()=>`memory-${++ids}`,ingestionPolicyVersion:'fixture'});
  const prepared=unwrap(prepareSubmittedLink({title:'Fixture',url:'https://memory.example/',interestAreaId:'area',idempotencyKey:'memory'},'2026-10-06T00:00:00.000Z'));
  const command={...prepared,ownerId:'fixture-owner',adapter:{...prepared.adapter,id:adapterId}},first=unwrap(await service.approve(command));
  const retry=await service.approve({...command,identityEvidence:[{...command.identityEvidence[0],observedAt:'2026-10-06T00:01:00.000Z'}]});assert.equal(retry.ok,adapterId==='submitted-link');
  if(retry.ok)assert.deepEqual(retry.value.source,first.source);else assert.equal(retry.error.kind,'SourceIdempotencyConflict');
 }
 const authored=unwrap(prepareSubmittedLink({title:'Fixture',url:'https://memory.example/',interestAreaId:'area',idempotencyKey:'legacy-memory'},'2026-10-06T00:00:00.000Z'));
 const {identityStatus:_status,...value}=authored;const legacyFingerprint=JSON.stringify(unwrap(validateApprovalCommand({...authored,ownerId:'fixture-owner'})));
 const normalized=sourceApprovalFingerprint(legacyFingerprint,'submitted-link');
 assert.equal(sourceApprovalFingerprint(normalized,'submitted-link'),normalized);
 for(const change of [
  {adapter:{...value.adapter,id:'provider'}},
  {adapter:{...value.adapter,version:'v2'}},
  {identityEvidence:[{...value.identityEvidence[0],attribute:'provider-observation'}]},
  {identityEvidence:[{...value.identityEvidence[0],value:'Different observation'}]},
  {identityEvidence:[{...value.identityEvidence[0],provenanceUrl:'https://foreign.example/'}]},
  {identityEvidence:[...value.identityEvidence,{...value.identityEvidence[0],attribute:'other-observation'}]},
 ]){const fingerprint=JSON.stringify({...value,...change});assert.equal(sourceApprovalFingerprint(fingerprint,change.adapter?.id??'submitted-link'),fingerprint);}
 const privateFingerprint=JSON.stringify({adapter:{id:'private-document'},identityEvidence:value.identityEvidence});
 assert.equal(sourceApprovalFingerprint(privateFingerprint,'private-document'),privateFingerprint);
 let ids=0;const repository=new SourceLibraryRepository(),service=new SourceLibraryService({repository,now:()=> '2026-10-06T00:02:00.000Z',createId:()=>`legacy-${++ids}`,ingestionPolicyVersion:'fixture'});
 const first=unwrap(await service.approve({...authored,ownerId:'fixture-owner'}));
 const imported=new SourceLibraryRepository();
 unwrap(await imported.approve({source:first.source,event:repository.listEvents('fixture-owner')[0],job:first.job,fingerprint:legacyFingerprint}));
 const replayService=new SourceLibraryService({repository:imported,now:()=> '2026-10-06T00:03:00.000Z',createId:()=>`legacy-${++ids}`,ingestionPolicyVersion:'fixture'});
 const replay=unwrap(await replayService.approve({...authored,ownerId:'fixture-owner',identityEvidence:[{...authored.identityEvidence[0],observedAt:'2026-10-06T00:04:00.000Z'}]}));
 assert.equal(replay.reused,true);assert.deepEqual(replay.source,first.source);assert.equal(imported.listEvents('fixture-owner').length,1);assert.equal(imported.listIngestionJobs('fixture-owner').length,1);
 assert.throws(()=>sourceApprovalFingerprint('{invalid','submitted-link'),/invalid JSON/);
 assert.throws(()=>sourceApprovalFingerprint(JSON.stringify({adapter:{id:'submitted-link',version:'v1'},submittedUrl:'https://example.test/',identityEvidence:[{attribute:'user-submitted-url',value:'https://example.test/',provenanceUrl:'https://example.test/',observedAt:'invalid'}]}),'submitted-link'),/observation time is invalid/);
});
test('cancelled Link Extract starts a new D1 attempt preserving existing source data',async()=>{
 const f=await fixture();try{const before=f.db.prepare('SELECT * FROM library_sources').all();unwrap(await f.service.control({ownerId:f.run.ownerId,runId:f.run.runId,expectedRevision:f.run.revision,action:'abandon',idempotencyKey:'restart-cancel'}));const next=unwrap(await f.service.createRun(restartCommand(f.run)));assert.notEqual(next.run.runId,f.run.runId);assert.equal(next.run.state,'source-added');assert.deepEqual(f.db.prepare('SELECT * FROM library_sources').all(),before);assert.equal(unwrap(await f.service.status({ownerId:f.run.ownerId,runId:f.run.runId})).state,'abandoned');}finally{f.close();}
});
test('concurrent identical Extract both succeed with one atomic D1 active attempt',async()=>{
 const f=await fixture();try{const command={...restartCommand(f.run),sourceId:'other-source',idempotencyKey:'concurrent'};command.userAuthorization={...command.userAuthorization,sourceId:command.sourceId};const second=createKnowledgeWorkflowService(new D1KnowledgeWorkflowRepository({database:f.database,logger:()=>{}}),{now:()=>new Date().toISOString(),createId:()=> 'separate-service-attempt',logger:()=>{}});const results=await Promise.all([f.service.createRun(command),second.createRun(command)]);assert(results.every(r=>r.ok),JSON.stringify(results));assert.equal(results[0].value.run.runId,results[1].value.run.runId);assert.equal(f.db.prepare("SELECT count(*) AS n FROM knowledge_workflow_runs WHERE idempotency_key='concurrent'").get().n,1);}finally{f.close();}
});

for(const distinctKeys of [false,true])test('concurrent source approval atomically converges before Extract starts '+(distinctKeys?'distinct request keys':'same request key'),async()=>{
 const f=await fixture();try{let id=0;const service=new SourceLibraryService({repository:new D1SourceLibraryRepository(f.database),now:()=>new Date().toISOString(),createId:()=>`new-source-${++id}`,ingestionPolicyVersion:'fixture'});const url='https://new.example/course/';f.db.prepare('INSERT INTO interest_areas(owner_id,interest_area_id,label,provenance_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(f.run.ownerId,'area-new','Fixture area','{}',new Date().toISOString(),new Date().toISOString());const command={ownerId:f.run.ownerId,submittedUrl:url,canonicalUrl:url,title:'Exact title',description:'Exact snippet',idempotencyKey:'same-extract',identityStatus:'resolved',adapter:{id:'web',version:'1',granularity:'document',capabilities:['metadata','bounded-ingestion']},interestAreaIds:['area-new'],identityEvidence:[{attribute:'canonical-url',value:url,provenanceUrl:url,observedAt:new Date().toISOString()}]};const results=await Promise.all([service.approve(command),service.approve(distinctKeys?{...command,idempotencyKey:'other-extract'}:command)]);assert(results.every(r=>r.ok),JSON.stringify(results));assert.equal(results[0].value.source.id,results[1].value.source.id);assert.equal(f.db.prepare("SELECT count(*) AS n FROM library_sources WHERE canonical_url=?").get(url).n,1);assert.equal(f.db.prepare("SELECT count(*) AS n FROM library_source_events WHERE idempotency_key='same-extract'").get().n,1);}finally{f.close();}
});
test('page warnings are attempt owned, fenced after cancellation and never hide persistence failure',async()=>{
 const f=await fixture();try{const content=new D1KnowledgeContentRepository({database:f.database,logger:()=>{}}),command={ownerId:f.run.ownerId,runId:f.run.runId,pageUrl:f.run.canonicalSourceIdentity,warnings:['Image warning: fixture. Text retained.']};unwrap(await content.savePageImageWarnings(command));assert.equal(unwrap(await content.loadImageWarnings(command)).length,1);unwrap(await f.service.control({ownerId:f.run.ownerId,runId:f.run.runId,expectedRevision:f.run.revision,action:'abandon',idempotencyKey:'cancel-warning'}));assert.equal(unwrap(await content.loadImageWarnings(command)).length,0);assert.equal((await content.savePageImageWarnings(command)).ok,false);f.db.exec('DROP TABLE knowledge_workflow_page_image_warnings');assert.equal((await content.savePageImageWarnings(command)).error.kind,'ImageWarningPersistenceFailed');}finally{f.close();}
});

test('exact combined image byte boundary retains both attachments without a budget warning',async()=>{
 const f=await fixture({images:true,twoLargeImages:true,imageMiB:16});try{unwrap(await f.complete());assert(f.tasks.filter(t=>t.operation==='observe').every(t=>t.embeddedImages.length===2));assert(!unwrap(await new D1KnowledgeContentRepository({database:f.database,logger:()=>{}}).loadImageWarnings({ownerId:f.run.ownerId,runId:f.run.runId})).some(w=>w.includes('BudgetExceeded')));}finally{f.close();}
});
test('images beyond the model count limit are disclosed while text and first eight images survive',async()=>{
 const f=await fixture({images:true,nineImages:true});try{unwrap(await f.complete());assert(f.tasks.filter(t=>t.operation==='observe').every(t=>t.embeddedImages.length===8));assert.equal(f.imageReads.length,18,'Both pages eventually evaluate ninth image');assert(f.tasks.filter(t=>t.operation==='match-webpage-images').every(t=>t.candidates.length<=8));}finally{f.close();}
});
test('allowed lesson redirect attributes exact final URL and preserves requested page progression',async()=>{
 const f=await fixture({redirect:true});try{unwrap(await f.complete());const points=f.db.prepare('SELECT point_json FROM extraction_knowledge_points').all().map(r=>JSON.parse(r.point_json));assert(points.some(p=>p.attribution.sourceUrl==='https://source.example/course/lesson/'));assert(points.every(p=>p.evidenceAnchors.every(a=>a.url===p.attribution.sourceUrl)));assert.deepEqual(f.pages,['https://source.example/course/','https://source.example/course/lesson']);}finally{f.close();}
});
test('image-only webpage returns zero facts without fact/image model calls',async()=>{
 const f=await fixture({imageOnly:true,images:true});try{const result=await f.runtime.execute(f.run);assert(result.ok||JSON.stringify(result.error).includes('KnowledgeSetEmpty'));assert.equal(f.db.prepare('SELECT count(*) AS n FROM extraction_knowledge_points').get().n,0);assert.equal(f.imageReads.length,0);assert(!f.tasks.some(t=>['extract-webpage-facts','verify-webpage-facts','match-webpage-images'].includes(t.operation)));}finally{f.close();}
});

test('mixed failed candidate warnings persist through SQLite and prevent incomplete image publication',async()=>{
 const f=await fixture({images:true,twoLargeImages:true,imageMiB:1,mixedFailure:true});try{unwrap(await f.complete());assert.equal(f.media.length,0,'Incomplete candidate evidence cannot publish an image');assert.equal(f.tasks.filter(t=>t.operation==='match-webpage-images').length,2);assert.equal(f.tasks.filter(t=>t.operation==='verify-webpage-image').length,0,'Incomplete candidate evidence stays unattached before purpose assessment');const points=f.db.prepare('SELECT point_json FROM extraction_knowledge_points').all().map(r=>JSON.parse(r.point_json));assert.equal(points.length,2);assert(points.every(p=>p.mediaCandidates.length===0&&p.imageWarnings.some(w=>w.includes('MediaPublicEgressUnavailable'))));const scope={ownerId:f.run.ownerId,runId:f.run.runId};const warnings=unwrap(await new D1KnowledgeContentRepository({database:f.database,logger:()=>{}}).loadImageWarnings(scope));assert(warnings.some(w=>w.includes('MediaPublicEgressUnavailable')));assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_workflow_page_image_warnings').get().n,2);}finally{f.close();}
});

for(const imageOnly of [false,true])test('page warnings persist without image candidates and with zero facts '+imageOnly,async()=>{
 const f=await fixture({imageOnly,pageWarning:true});try{const result=await f.runtime.execute(f.run);assert(result.ok||JSON.stringify(result.error).includes('KnowledgeSetEmpty'));const repo=new D1KnowledgeContentRepository({database:f.database,logger:()=>{}}),scope={ownerId:f.run.ownerId,runId:f.run.runId};assert(unwrap(await repo.loadImageWarnings(scope)).includes('AcquisitionImageNotEvaluated'));unwrap(await repo.savePageImageWarnings({...scope,pageUrl:f.run.canonicalSourceIdentity,warnings:['Second durable warning']}));const warnings=unwrap(await repo.loadImageWarnings(scope));assert(warnings.includes('AcquisitionImageNotEvaluated'));assert(warnings.includes('Second durable warning'));assert.equal(f.imageReads.length,0);}finally{f.close();}
});

test('page extraction ignores discovered links and model attempts to broaden the saved run',async()=>{
  const f=await fixture({extractionScope:'page',navigationForbidden:true});
  try {
    assert.equal(unwrap(await f.complete()).state,'completed');
    assert.deepEqual(f.pages,['https://source.example/course/']);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_workflow_quizzes').get().n,1);
    assert.equal(JSON.parse(f.db.prepare('SELECT run_json FROM knowledge_workflow_runs').get().run_json).extractionScope,'page');
    assert(f.tasks.filter(t=>t.operation==='plan'||t.operation==='replan').every(t=>t.extractionScope==='page'));
  } finally {f.close();}
});
test('platform extraction follows a newly discovered sibling course across resumed chunks',async()=>{
  const f=await fixture({extractionScope:'platform',platformSibling:true});
  try {
    assert.equal(unwrap(await f.complete()).state,'completed');
    assert.deepEqual(f.pages,['https://source.example/course/','https://source.example/course/lesson','https://source.example/other-course/lesson']);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_workflow_quizzes').get().n,3);
    assert(f.tasks.filter(t=>t.operation==='plan'||t.operation==='replan').every(t=>t.extractionScope==='platform'));
  } finally {f.close();}
});
