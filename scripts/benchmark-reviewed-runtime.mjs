// Benchmark composition only: all quality decisions and retries belong to the application.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {openPositiveStorage} from './architecture-live-positive.mjs';
import {createEvaluationTransport,createEstimatedRequestPlanner,EvaluationTransportFailure,requireEvaluationRequestWindow} from './evaluation-budget.mjs';
import {validateEvaluationRoleProfiles} from './webpage-image-evaluation.mjs';
import {QUIZ_MAX_ATTEMPTS} from '../src/features/knowledge-workflows/quiz.js';
import {createAgentConfigurationLoader} from '../src/features/knowledge-workflows/config.js';
import {createKnowledgeWorkflowService} from '../src/features/knowledge-workflows/workflow.js';
import {createMediaPipeline} from '../src/features/knowledge-workflows/media.js';
import {createKnowledgeWorkflowRuntime,requestMaterialBatch} from '../worker/knowledge-workflow-runtime.js';
import {requestWebpageFacts,createWebpageAttemptPolicy} from '../worker/webpage-facts.js';
import {associateWebpageImages,imageHash} from '../worker/webpage-images.js';
import {createWebpageImageBudget} from '../worker/webpage-image-budget.js';
import {D1KnowledgeWorkflowRepository} from '../worker/knowledge-workflow-d1.js';
import {D1KnowledgeContentRepository,D1QuizRepository} from '../worker/knowledge-workflow-content-d1.js';
import {D1WorkflowStageRepository} from '../worker/knowledge-workflow-stages-d1.js';
import {D1KnowledgeMediaRepository} from '../worker/knowledge-workflow-media-d1.js';

const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
/** @param {string} base64 */
const capturedBytes=base64=>Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
const sha=value=>createHash('sha256').update(value).digest('hex');
const extractionFiles=['scripts/benchmark-reviewed-runtime.mjs','worker/knowledge-workflow-runtime.js','worker/webpage-facts.js','worker/webpage-images.js','src/features/knowledge-workflows/quality-review.js'];
const value=result=>{if(!result.ok)throw Object.assign(new TypeError(result.error.kind),{kind:result.error.kind});return result.value;};
const unavailable=async()=>({ok:false,error:{kind:'ReviewedBenchmarkCapturedSourcesOnly'}});
export const REVIEWED_PIPELINE='application-review-v1';

// Persist each terminal point before a later point can interrupt the quiz phase.
export async function runReviewedQuizPoints({actor,stageRepository,run,points}){
 for(const point of points){
  const saved=await stageRepository.run(run,`reviewed-benchmark-quiz-disposition:${point.id}`,digest(JSON.stringify({version:'quiz-disposition-v1',maximumAttempts:QUIZ_MAX_ATTEMPTS,point})),async()=>{
   const result=await actor.run({ownerId:run.ownerId,runId:run.runId,points:[point]});
   return result.ok?{ok:true,value:result.value.dispositions[0]}:result;
  },{resumeSafe:true});
  if(!saved.ok)return saved;
 }
 return {ok:true,value:null};
}

export function readReviewedQuizStatistics({sqlite,run,knowledgeIds,outputs}){
 const rows=sqlite.prepare("SELECT stage_key,result_json FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND status='completed'").all(run.ownerId,run.runId);
 const dispositions=knowledgeIds.map(knowledgeId=>{
  const saved=rows.find(row=>row.stage_key===`reviewed-benchmark-quiz-disposition:${knowledgeId}`);
  const result=saved?JSON.parse(saved.result_json):null,published=outputs.find(output=>output.knowledgeId===knowledgeId);
  const disposition=result?.ok?result.value:published?{knowledgeId,status:'accepted',publicationStatus:'published',attempts:published.attempt,failureKind:null,restrictedUntil:null}:null;
  assert(disposition&&disposition.knowledgeId===knowledgeId,'ReviewedQuizStatisticsUnavailable');
  const prefix=`question-generator:quiz-generator-${knowledgeId}-`;
  const ordinals=rows.flatMap(row=>{if(!row.stage_key.startsWith(prefix))return [];const ordinal=/^(\d+):/.exec(row.stage_key.slice(prefix.length));return ordinal?[Number(ordinal[1])]:[];});
  assert(ordinals.every(attempt=>Number.isSafeInteger(attempt)&&attempt>=1&&attempt<=QUIZ_MAX_ATTEMPTS),'ReviewedQuizAttemptInvalid');
  const attempts=Math.max(disposition.attempts,published?.attempt??0,...ordinals);
  assert(Number.isSafeInteger(attempts)&&attempts>=0&&attempts<=QUIZ_MAX_ATTEMPTS,'ReviewedQuizAttemptInvalid');
  return {...disposition,attempts};
 });
 const inputPoints=knowledgeIds.length,attemptedPoints=dispositions.filter(item=>item.attempts>0).length,retriedPoints=dispositions.filter(item=>item.attempts>1).length;
 const quizDroppedPoints=dispositions.filter(item=>item.status==='abandoned'&&item.failureKind!=='QuizSeeLessOften').length;
 return {dispositions,statistics:{inputPoints,attemptedPoints,retriedPoints,extraAttempts:dispositions.reduce((sum,item)=>sum+Math.max(0,item.attempts-1),0),retryRate:attemptedPoints?retriedPoints/attemptedPoints:0,quizDroppedPoints,quizDropRate:inputPoints?quizDroppedPoints/inputPoints:0,exhaustedDropPoints:dispositions.filter(item=>item.status==='abandoned'&&item.attempts===QUIZ_MAX_ATTEMPTS&&item.failureKind!=='QuizKnowledgeUngrounded'&&item.failureKind!=='QuizSeeLessOften').length,preferenceDroppedPoints:dispositions.filter(item=>item.failureKind==='QuizSeeLessOften').length}};
}
/** Explicit source-bound execution mode, never inferred from the selected model. */
export async function validateReviewedPipeline(contract){
 if(contract?.pipelineMode===undefined)return false;
 assert.equal(contract.pipelineMode,REVIEWED_PIPELINE,'BenchmarkPipelineModeInvalid');
 const path=decodeURIComponent(new URL(import.meta.url).pathname),bytes=await readFile(path);
 assert.equal(contract.sourceFiles[path]??contract.sourceFiles['scripts/benchmark-reviewed-runtime.mjs'],createHash('sha256').update(bytes).digest('hex'),'ReviewedRuntimeSourceBindingMissing');
 return true;
}

/** Stock application adapter receives the real accounted envelope and retains its metadata.
 * No generator injection, copied reviewer, or model-output replay bypass is used. */
export async function openReviewedBenchmark({contract,roleDependencies,imagePolicy,now=Date.now,logger=()=>{}}){
 assert.equal(await validateReviewedPipeline(contract),true);
 value(validateEvaluationRoleProfiles(roleDependencies.profiles));
 let recovery;
 if(contract.nativeRecovery){
  const declaration=contract.nativeRecovery,bytes=await readFile(declaration.source);
  assert.equal(sha(bytes),declaration.sha256,'ReviewedNativeRecoveryBindingInvalid');
  assert.equal(contract.sourceFiles[declaration.source],declaration.sha256,'ReviewedNativeRecoveryBindingInvalid');
  recovery=JSON.parse(bytes);
  assert.equal(recovery.version,'accounted-native-stage-recovery-v1');assert.equal(recovery.ownerAuthorized,true);
  assert.equal(recovery.applicationIterationId,contract.quizRun?.knowledgeIterationId??contract.iterationId);
  assert.equal(recovery.roleProfilesSha256,sha(JSON.stringify(roleDependencies.profiles)));
  assert.equal(recovery.costPolicySha256,sha(JSON.stringify(roleDependencies.costPolicy)));
  for(const field of ['caseId'])assert.equal(typeof recovery[field],'string');
  for(const field of ['ownerId','runId','key','inputDigest','createdAt'])assert.equal(typeof recovery.stage?.[field],'string');
  assert(recovery.stage.key.startsWith('question-evaluator:quiz-evaluator-'),'ReviewedNativeRecoveryStageInvalid');
  assert.equal(typeof recovery.request?.key,'string');assert(Number.isSafeInteger(recovery.request.costNanodollars)&&recovery.request.costNanodollars>=0);
  assert(Number.isSafeInteger(recovery.request.uncertaintyVersion)&&recovery.request.uncertaintyVersion>=1);
  const closureBytes=await readFile(recovery.closure.source);
  assert.equal(sha(closureBytes),recovery.closure.sha256);assert.equal(contract.sourceFiles[recovery.closure.source],recovery.closure.sha256);
  const closure=JSON.parse(closureBytes);
  assert.equal(closure.cleanupConfirmed,true);assert.equal(closure.stopping,true);assert.equal(closure.stopReason,'IntegrationDeadlineExceeded');
  assert.equal(closure.failure,null);assert.equal(closure.monitorFailure,null);
  assert(Number.isSafeInteger(recovery.closure.deadlineAtMs));
  assert(Date.parse(closure.finishedAt)>=recovery.closure.deadlineAtMs&&Date.parse(recovery.stage.createdAt)<recovery.closure.deadlineAtMs);
  for(const path of extractionFiles)assert(/^[a-f0-9]{64}$/.test(recovery.extraction?.sourceFiles?.[path]),'ReviewedExtractionRecoveryBindingInvalid');
 }
 const store=await openPositiveStorage({directory:contract.quizRun?.applicationDirectory??contract.reviewedStorageDirectory??contract.directory+'/reviewed-application'});
 const applicationIterationId=contract.quizRun?.knowledgeIterationId??contract.iterationId;
 assert(store.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='knowledge_workflow_stages'").get(),'ReviewedApplicationMigration25Required');
 const content=new D1KnowledgeContentRepository({database:store.database,logger});
 const workflowRepository=new D1KnowledgeWorkflowRepository({database:store.database,logger});
 const nowIso=()=>new Date(now()).toISOString();
 const extractionStages=new D1WorkflowStageRepository({database:store.database,now:nowIso});
 const workflows=createKnowledgeWorkflowService(workflowRepository,{now:nowIso,createId:randomUUID,logger});
 const mediaRepository=new D1KnowledgeMediaRepository({database:store.database,bucket:store.bucket,logger});
 const quizRepository=new D1QuizRepository({database:store.database,bucket:store.bucket,now:nowIso,logger});
 const loader=createAgentConfigurationLoader({sha256:async input=>digest(input)});
 const configSnapshots={};
 for(const role of ['rights-assessor','knowledge-scraper','question-generator','question-evaluator']){
  const original=value(await loader.load({source:await readFile(new URL('../agent-config/'+role+'.yaml',import.meta.url),'utf8'),expectedRole:role}));
  const {id,canonicalJson,digest:oldDigest,...config}=original;
  const profile=roleDependencies.profiles.roles[role==='question-evaluator'?'review-grader':'knowledge-scraper'];
  // The accounted transport bounds each provider attempt; native roles bound the logical call by the existing execution window.
  if(contract.runtimePolicy)config.limits={...config.limits,timeoutMs:contract.runtimePolicy.maximumWindowMilliseconds};
  config.model={provider:'openrouter',name:profile.catalog.model.id,...(profile.protocol.reasoningEffort===undefined?{}:{reasoningEffort:profile.protocol.reasoningEffort})};
  configSnapshots[role]=value(await loader.load({source:JSON.stringify(config),expectedRole:role}));
 }
 const configDigests=Object.fromEntries(Object.entries(configSnapshots).map(([role,snapshot])=>[role,snapshot.digest]));
 let pixelBrowser,pixelPage;
 const derivatives={create:async({bytes,mediaType})=>{
  pixelBrowser??=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  if(!pixelPage){const context=await pixelBrowser.newContext();await context.route('**/*',route=>route.abort());pixelPage=await context.newPage();}
  const encoded=await pixelPage.evaluate(async({base64,type})=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type}));try{const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');if(!ctx)throw new TypeError('ReviewedCanvasUnavailable');ctx.drawImage(bitmap,0,0);return Array.from(new Uint8Array(await(await canvas.convertToBlob({type:'image/webp',quality:.82})).arrayBuffer()));}finally{bitmap.close();}},{base64:Buffer.from(bytes).toString('base64'),type:mediaType});
  return {ok:true,value:{bytes:Uint8Array.from(encoded),mediaType:'image/webp'}};
 }};
 const media=createMediaPipeline({repository:mediaRepository,createId:randomUUID,now:nowIso,logger,digest:async bytes=>({ok:true,value:digest(bytes)}),derivatives,quarantine:{put:async({key,bytes})=>{await store.bucket.put(key,bytes);return {ok:true,value:null};},remove:async key=>{await store.bucket.delete(key);return {ok:true,value:null};}}});
 const sessions=new Map();
 async function forCase(item){
  if(sessions.has(item.id))return sessions.get(item.id);
  const sourceId=item.id,legacyOwnerId=contract.grant.id+':application:'+applicationIterationId;
  // Retain historical runs; new cases need separate owners when material segments share a canonical source.
  const legacy=store.sqlite.prepare('SELECT 1 FROM knowledge_workflow_runs WHERE owner_id=? AND source_id=? UNION ALL SELECT 1 FROM library_sources WHERE owner_id=? AND source_id=? LIMIT 1').get(legacyOwnerId,sourceId,legacyOwnerId,sourceId);
  const ownerId=legacy?legacyOwnerId:legacyOwnerId+':case:'+sourceId,scope={ownerId,sourceId,sourceRevision:1};
  // Quiz publication projects learning jobs that reference the scoped Library source.
  const sourceUrl=item.input.evidence.url,registeredAt=nowIso();
  store.sqlite.prepare('INSERT INTO library_sources (owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,source_id) DO NOTHING').run(ownerId,sourceId,sourceUrl,sourceUrl,item.input.material?.fileName??sourceId,'Isolated owner-authorized benchmark source','{}',JSON.stringify({source:'captured-benchmark',caseId:sourceId,url:sourceUrl}),'active',registeredAt,registeredAt,1);
  const registered=store.sqlite.prepare('SELECT canonical_url,revision FROM library_sources WHERE owner_id=? AND source_id=?').get(ownerId,sourceId);
  assert(registered?.canonical_url===sourceUrl&&registered.revision===1,'ReviewedLibrarySourceConflict');
  const created=value(await workflows.createRun({...scope,canonicalSourceIdentity:item.input.evidence.url,contentSignature:digest(JSON.stringify(item.input)),idempotencyKey:applicationIterationId+':reviewed:'+item.id,configDigests}));
  let run=created.run;
  const stateOrder=['source-added','rights-assessment','robots-check','extraction-loop','extraction-finalized','per-point-quiz-loop','completed'];
  assert(stateOrder.includes(run.state),'ReviewedWorkflowStateInvalid');
  for(const nextState of ['rights-assessment','robots-check','extraction-loop'])if(stateOrder.indexOf(run.state)<stateOrder.indexOf(nextState))run=value(await workflows.advance({ownerId,runId:run.runId,expectedRevision:run.revision,nextState}));
  let activeRecoveryKey;
  const authorizeClaimedModelCall=async identity=>{
   if(!recovery||recovery.caseId!==item.id||identity.ownerId!==recovery.stage.ownerId||identity.runId!==recovery.stage.runId||identity.stageKey!==recovery.stage.key)return false;
   if(identity.inputDigest!==recovery.stage.inputDigest||identity.createdAt!==recovery.stage.createdAt)throw new EvaluationTransportFailure({kind:'EvaluationRecoveryEvidenceInvalid',field:'native stage identity'});
   const paidValue=result=>{if(!result.ok)throw new EvaluationTransportFailure(result.error);return result.value;};
   const ledger=roleDependencies.transport.ledger,snapshot=paidValue(ledger.snapshot());
   const replay=paidValue(ledger.replayResponse(recovery.request.key));
   if(replay===null){
    const admitted=paidValue(ledger.recoveryCandidate(recovery.request.key));
    if(snapshot.activeRequests!==0||!admitted||admitted.failedKey!==recovery.request.key||admitted.costNanodollars!==recovery.request.costNanodollars||admitted.uncertaintyVersion!==recovery.request.uncertaintyVersion)throw new EvaluationTransportFailure({kind:'EvaluationRecoveryEvidenceInvalid',field:'native reservation admission'});
   }
   activeRecoveryKey=recovery.request.key;return true;
  };
  const countedFetch=async(input,init)=>{
   assert.equal(typeof init?.body,'string','ReviewedModelBodyInvalid');
   const body=JSON.parse(init.body),role=body.model===roleDependencies.profiles.roles['review-grader'].catalog.model.id?'review-grader':'knowledge-scraper',profile=roleDependencies.profiles.roles[role];
   assert.equal(body.model,profile.catalog.model.id,'ReviewedRoleModelMismatch');
   // Native schemas remain native; absence (e.g. context compaction) remains JSON object.
   const responseFormat=body.response_format?.type;assert(['json_schema','json_object'].includes(responseFormat),'ReviewedResponseFormatInvalid');
   if(responseFormat==='json_schema')assert.equal(profile.protocol.responseFormat,'json_schema','ReviewedNativeSchemaAuthorityMissing');
   assert.equal(body.reasoning?.effort,profile.protocol.reasoningEffort,'ReviewedConfiguredReasoningMismatch');
   body.provider=profile.protocol.provider;
   if(profile.protocol.reasoningEffort===undefined)delete body.reasoning;else body.reasoning={effort:profile.protocol.reasoningEffort};
   if(profile.protocol.maximumOutputTokens!==undefined)body.max_tokens=Math.min(body.max_tokens,profile.protocol.maximumOutputTokens);
   const requestPlanner=createEstimatedRequestPlanner({metadata:profile.catalog,costPolicy:roleDependencies.costPolicy,sourceContract:roleDependencies.transport.ownerDecision,now});
   const transport=createEvaluationTransport({...roleDependencies.transport,requestTimeoutMs:roleDependencies.modelConfig.timeoutMs,failureOrigin:'pipeline',catalog:profile.catalog,model:profile.catalog.model.id,endpoint:roleDependencies.modelConfig.endpoint,requestPlanner,benchmarkContract:roleDependencies.profiles.benchmarkContract,expectedResponseFormat:responseFormat,...(profile.protocol.reasoningEffort===undefined?{}:{expectedReasoningEffort:profile.protocol.reasoningEffort}),iterationId:applicationIterationId+':'+item.id+':application:'+role,...(activeRecoveryKey===undefined?{}:{expectedRecoveryKey:activeRecoveryKey})});
   try{return await transport(input,{...init,body:JSON.stringify(body)});}finally{activeRecoveryKey=undefined;}
  };
  const runtime=createKnowledgeWorkflowRuntime({technicalRetries:false,database:store.database,apiKey:roleDependencies.apiKey,endpoint:roleDependencies.modelConfig.endpoint,configSnapshots,imagePolicy,...(contract.runtimePolicy?.version===2?{preflightModelWork:(agentRole)=>{const ledger=roleDependencies.transport.ledger,snapshot=value(ledger.snapshot());requireEvaluationRequestWindow(snapshot,roleDependencies.modelConfig.timeoutMs,now());const profile=roleDependencies.profiles.roles[agentRole==='question-evaluator'?'review-grader':'knowledge-scraper'],pacing=value(ledger.pacingDue(profile.catalog.model.id));requireEvaluationRequestWindow(snapshot,roleDependencies.modelConfig.timeoutMs,now(),pacing.retryAtMs);}}:{}),...(recovery?{authorizeClaimedModelCall}:{}),fetch:countedFetch,now:nowIso,nowMs:now,logger,browser:{readPage:unavailable,readRobots:unavailable,screenshot:unavailable,close:async()=>{}},transition:command=>workflows.advance({ownerId,runId:run.runId,expectedRevision:command.run.revision,nextState:command.nextState,...(command.counts?{counts:command.counts}:{})}),reviewMedia:mediaRepository,mediaBucket:store.bucket,media});
  const session={run,runtime,item};sessions.set(item.id,session);return session;
 }
 async function accept({item,candidate,sourceUrl,sourceEvidence,sourceMode='text',image}){
  const {run,runtime}=await forCase(item);
  const point={...candidate,id:`knowledge:${item.id}:1:${candidate.normalizedHash}`,sourceId:item.id,sourceRevision:1,mediaCandidates:image?[{visualId:image.id}]:[],attribution:{sourceUrl:sourceUrl??item.input.evidence.url},extractionVersion:'application-reviewed-extraction-v1'};
  const review=await runtime.reviewCapturedCandidate({run,point,sourceEvidence,sourceMode,...(image?{supportingImage:{id:image.id,bytes:image.bytes,mediaType:image.mediaType}}:{})});
  if(!review.ok||review.value===null)return review;
  const accepted=review.value.point;
  if(store.sqlite.prepare("SELECT 1 FROM knowledge_workflow_purge_tombstones WHERE owner_id=? AND run_id=? AND knowledge_id=? AND reason='no-meaningful-quiz' LIMIT 1").get(run.ownerId,run.runId,accepted.id))return {ok:true,value:null};
  const appended=await content.appendKnowledgePoint(accepted,run.ownerId,run.runId,nowIso());if(!appended.ok)return appended;
  let binding=review.value.binding;
  if(sourceMode==='image'&&image&&accepted.mediaCandidates.length)binding={kind:'uploaded-source',ownerId:run.ownerId,runId:run.runId,sourceRevision:1,imageId:image.id,originalDigest:digest(image.bytes),sourceDigest:run.contentSignature,locator:accepted.evidenceAnchors[0].selector,evidence:review.value.verdict.supportingImageEvidence,factHash:digest(JSON.stringify({summary:accepted.summary,normalizedHash:accepted.normalizedHash,evidenceAnchors:accepted.evidenceAnchors}))};
  if(binding&&image){
   const original=await mediaRepository.readOriginal({ownerId:run.ownerId,runId:run.runId,knowledgeId:accepted.id,sourceRevision:1});if(!original.ok)return original;
   if(original.value===null){
    const imageUrl=image.url??sourceUrl??item.input.evidence.url;
    const ingested=await media.ingestBytes({ownerId:run.ownerId,runId:run.runId,knowledgeId:accepted.id,sourceUrl:imageUrl,bytes:image.bytes,binding,candidate:{url:imageUrl,kind:'image',educationallyConnected:true,mediaTypeHint:image.mediaType,rights:{storage:'allowed',display:'allowed',transformation:'allowed',attribution:imageUrl+' — source image; isolated owner-authorized benchmark processing',originEvidence:contract.ownerDecision.source}}});
    if(!ingested.ok)return ingested;
    const attached=await content.attachMediaSelection({ownerId:run.ownerId,knowledgeId:accepted.id,selection:{assetId:ingested.value.asset.assetId,kind:'image',url:'/api/learning-media?assetId='+encodeURIComponent(ingested.value.asset.assetId)+'&variant=feed',attribution:ingested.value.asset.attribution}});if(!attached.ok)return attached;
   }
  }
  return {ok:true,value:{point:accepted,binding,verdict:review.value.verdict}};
 }
 async function list(item){const {run}=await forCase(item);return content.listKnowledgePoints({ownerId:run.ownerId,runId:run.runId,sourceId:run.sourceId,sourceRevision:1});}
 async function extractCaptured({item,generate,decodeImage,deadline,maximumPages}){
  const session=await forCase(item),run=session.run,scope={ownerId:run.ownerId,runId:run.runId},material=item.input.material;
  let facts;
  if(material){
   const image=material.kind==='uploaded-raster'?{...item.images[0],bytes:Uint8Array.from(Buffer.from(item.images[0].base64,'base64')),url:material.sections[0].url}:undefined;
   for(let offset=0;offset<material.sections.length;offset+=5){
    const sections=material.sections.slice(offset,offset+5);
    const output=await requestMaterialBatch({reviewMaterial:false,taskId:item.id+':material:'+offset,input:{fileName:material.fileName,sections,coverageGoals:item.input.coverageGoals,progress:{},mode:image?'image':'text',...(image?{visualId:image.id,scope,imageIdentity:{...scope,locator:sections[0].locator,visualId:image.id,digest:image.digest}}:{})},...(image?{attachments:[{id:image.id,bytes:image.bytes,mediaType:image.mediaType}],decodeImage}:{}),maxOutputTokens:16384,generate,logger});
    if(!output.ok)return output;
    for(const page of output.value){const section=sections.find(s=>s.url===page.url);if(!section)return {ok:false,error:{kind:'WorkflowMaterialSectionNotFound'}};
     for(const candidate of page.candidates){const reviewed=await accept({item,candidate,sourceUrl:section.url,sourceEvidence:{sections:[{id:section.id,url:section.url,locator:section.locator,text:section.text}]},sourceMode:image?'image':'text',image});if(!reviewed.ok)return reviewed;}
    }
   }
  }else{
   const imageCaps=imagePolicy.candidateEvaluationsPerPage,attemptPolicy=createWebpageAttemptPolicy({extraction:1,normalization:1,grounding:1,match:imageCaps,verify:imageCaps*50,requests:3+imageCaps*51});
   const extracted=await requestWebpageFacts({normalizeClaims:true,deferQualityReview:true,structuredOutput:true,attemptPolicy,taskId:item.id+':facts',input:{url:item.input.evidence.url,...item.input},maxOutputTokens:4096,generate,logger});if(!extracted.ok)return extracted;facts=extracted.value;
   const budget=createWebpageImageBudget({database:store.database,policy:imagePolicy,scope:{...scope,pageUrl:item.input.evidence.url},maximumPages,deadlineAtMs:deadline,now,logger});
   const associationKey='reviewed-benchmark-image-association',capturedImages=item.images.map(/** @param {import('./webpage-image-evaluation.mjs').EvaluationCase['images'][number]} image */image=>({id:image.id,mediaType:image.mediaType,digest:digest(capturedBytes(image.base64))}));
   const associationDigest=digest(JSON.stringify({protocol:'captured-provisional-image-association-v1',facts:facts.candidates,evidence:item.input.evidence,capturedImages,configDigests,imagePolicy,sourceFiles:Object.fromEntries(extractionFiles.map(path=>[path,contract.sourceFiles[path]??contract.sourceFiles[decodeURIComponent(new URL('../'+path,import.meta.url).pathname)]??null]))}));
   // A historical/partial read is not proof of a completed selection. Never reacquire it for a missing cache.
   const priorAssociation=store.sqlite.prepare('SELECT status FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND stage_key=?').get(run.ownerId,run.runId,associationKey);
   if(priorAssociation&&priorAssociation.status!=='completed')return {ok:false,error:{kind:'WorkflowStageCallUncertain'}};
   if(!priorAssociation&&store.sqlite.prepare('SELECT 1 FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=? LIMIT 1').get(run.ownerId,run.runId))return {ok:false,error:{kind:'WorkflowStageCallUncertain'}};
   const selected=await extractionStages.run(run,associationKey,associationDigest,async()=>{
    const matched=await associateWebpageImages({deferQualityReview:true,attemptPolicy,scope:{...scope,sourceRevision:1},facts:extracted.value.candidates,evidence:item.input.evidence,budget,digest:imageHash,generate,logger,readImage:async url=>{const metadata=item.input.evidence.images.find(i=>i.url===url),image=item.images.find(i=>i.id===metadata?.id);return image?{ok:true,value:{bytes:Uint8Array.from(Buffer.from(image.base64,'base64')),mediaType:image.mediaType}}:{ok:false,error:{kind:'EvaluationImageMissing'}};}});
    if(!matched.ok)return matched;
    const incomplete=matched.value.find(a=>a.evidenceCompletion!=='complete'||a.status==='not-evaluated');
    if(incomplete)return {ok:false,error:{kind:incomplete.failureKind??'ReviewedImageAssociationIncomplete'}};
    return {ok:true,value:matched.value.map(({image,...association})=>({...association,...(image?{imageIdentity:{id:image.id,url:image.url,mediaType:image.mediaType,digest:digest(image.bytes)}}:{})}))};
   });if(!selected.ok)return selected;
   // Resolve only the completed, exact source-bound selection; bytes remain owned by captured input.
   if(!Array.isArray(selected.value)||selected.value.length!==(item.input.evidence.images.length?facts.candidates.length:0)||new Set(selected.value.map(a=>a?.normalizedHash)).size!==selected.value.length)return {ok:false,error:{kind:'ReviewedImageAssociationCacheInvalid'}};
   /** @type {import('../worker/webpage-images.js').ImageAssociation[]} */const associations=[];
   for(const association of selected.value){
    if(!association||!facts.candidates.some(f=>f.normalizedHash===association.normalizedHash)||association.evidenceCompletion!=='complete'||!['review-pending','no-support','ambiguous','unreadable'].includes(association.status))return {ok:false,error:{kind:'ReviewedImageAssociationCacheInvalid'}};
    const {imageIdentity,...outcome}=association;
    if(association.status!=='review-pending'){if(imageIdentity!==undefined)return {ok:false,error:{kind:'ReviewedImageAssociationCacheInvalid'}};associations.push(outcome);continue;}
    const image=item.images.find(/** @param {import('./webpage-image-evaluation.mjs').EvaluationCase['images'][number]} i */i=>i.id===imageIdentity?.id),metadata=item.input.evidence.images.find(/** @param {import('./webpage-image-evaluation.mjs').EvaluationCase['input']['evidence']['images'][number]} i */i=>i.id===imageIdentity?.id);
    if(!imageIdentity||!image||!metadata||imageIdentity.url!==metadata.url||imageIdentity.mediaType!==image.mediaType||imageIdentity.digest!==digest(capturedBytes(image.base64))||association.selectedImageDigest!==imageIdentity.digest)return {ok:false,error:{kind:'ReviewedImageAssociationCacheInvalid'}};
    associations.push({...outcome,image:{id:image.id,url:metadata.url,mediaType:image.mediaType,bytes:capturedBytes(image.base64)}});
   }
   const matched={ok:true,value:associations};
   for(const candidate of facts.candidates){const association=matched.value.find(a=>a.normalizedHash===candidate.normalizedHash),image=association?.status==='review-pending'?association.image:undefined;
    const reviewed=await accept({item,candidate,sourceEvidence:item.input.evidence,image});if(!reviewed.ok)return reviewed;
   }
  }
  const recorded=await current(item);if(!recorded.ok)return recorded;
  return {ok:true,value:{...recorded.value,facts,applicationDirectory:store.directory,knowledgeIterationId:applicationIterationId}};
 }
 async function extract(command){
  const {item}=command,{run}=await forCase(item);
  // A completed application extraction is durable; later quiz purges must never trigger fresh extraction.
  let inputDigest=digest(JSON.stringify({protocol:'reviewed-completed-extraction-v1',contentSignature:run.contentSignature,configDigests,imagePolicy,
   sourceFiles:Object.fromEntries(['scripts/benchmark-reviewed-runtime.mjs','worker/knowledge-workflow-runtime.js','worker/webpage-facts.js','worker/webpage-images.js','src/features/knowledge-workflows/quality-review.js'].map(path=>[path,contract.sourceFiles[path]??contract.sourceFiles[decodeURIComponent(new URL('../'+path,import.meta.url).pathname)]??null]))}));
  if(recovery?.caseId===item.id&&recovery.stage.ownerId===run.ownerId&&recovery.stage.runId===run.runId){
   const priorDigest=digest(JSON.stringify({protocol:'reviewed-completed-extraction-v1',contentSignature:run.contentSignature,configDigests,imagePolicy,sourceFiles:recovery.extraction.sourceFiles}));
   const receipt=store.sqlite.prepare("SELECT input_digest,created_at,status,result_json FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND stage_key='reviewed-benchmark-extraction'").get(run.ownerId,run.runId);
   assert(receipt?.status==='completed'&&receipt.input_digest===priorDigest&&receipt.input_digest===recovery.extraction.inputDigest&&receipt.created_at===recovery.extraction.createdAt&&JSON.parse(receipt.result_json).ok===true,'ReviewedExtractionRecoveryReceiptInvalid');
   inputDigest=priorDigest;
  }
  const completed=await extractionStages.run(run,'reviewed-benchmark-extraction',inputDigest,()=>extractCaptured(command),{resumeSafe:true});
  if(!completed.ok)return completed;
  const recorded=await current(item);if(!recorded.ok)return recorded;
  return {ok:true,value:{...completed.value,...recorded.value,applicationDirectory:store.directory,knowledgeIterationId:applicationIterationId}};
 }
 async function current(item){
  const session=await forCase(item),recorded=await list(item);if(!recorded.ok)return recorded;
  const predictions=[];
  for(const point of recorded.value){const original=await mediaRepository.readOriginal({ownerId:session.run.ownerId,runId:session.run.runId,knowledgeId:point.id,sourceRevision:1});if(!original.ok)return original;
   predictions.push({caseId:item.id,summary:point.summary,imageId:original.value?.id??null,status:original.value?'match':'no-support',...(original.value?.purpose===undefined?{}:{imagePurpose:original.value.purpose})});
  }
  return {ok:true,value:{points:recorded.value,predictions}};
 }
 async function quiz(item){
  const {run,runtime}=await forCase(item),points=value(await list(item)),actor=runtime.createQuizActorForRun(run);if(!actor.ok)return actor;
  const knowledgeIds=store.sqlite.prepare("SELECT result_json FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND stage_key LIKE 'knowledge-quality:%' AND status='completed' ORDER BY created_at,stage_key").all(run.ownerId,run.runId).flatMap(row=>{const result=JSON.parse(row.result_json);return result.ok&&result.value?.point?[result.value.point.id]:[];});
  assert.equal(new Set(knowledgeIds).size,knowledgeIds.length,'ReviewedKnowledgeIdentityConflict');
  const reviewed=await runReviewedQuizPoints({actor:actor.value,stageRepository:extractionStages,run,points});if(!reviewed.ok)return reviewed;
  const acceptedPoints=value(await list(item)),outputs=[];
  for(const point of acceptedPoints){const published=await quizRepository.findPublished({ownerId:run.ownerId,runId:run.runId,knowledgeId:point.id});if(!published.ok)return published;if(published.value?.status==='published'){const row=store.sqlite.prepare("SELECT draft_json,score,attempt_number FROM knowledge_workflow_quizzes WHERE owner_id=? AND run_id=? AND knowledge_id=? AND status='published'").get(run.ownerId,run.runId,point.id);assert(row,'ReviewedPublishedQuizMissing');outputs.push({knowledgeId:point.id,draft:JSON.parse(row.draft_json),score:row.score,attempt:row.attempt_number});}}
  const qualityRows=store.sqlite.prepare("SELECT stage_key,result_json FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND stage_key LIKE 'knowledge-quality:%' AND status='completed'").all(run.ownerId,run.runId);
  const repairRows=store.sqlite.prepare("SELECT stage_key FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND stage_key LIKE 'knowledge-scraper:knowledge-repair-%'").all(run.ownerId,run.runId);
  const retriedPoints=qualityRows.filter(row=>repairRows.some(repair=>repair.stage_key.startsWith('knowledge-scraper:knowledge-repair-'+row.stage_key.slice('knowledge-quality:'.length)))).length;
  const knowledgeStatistics={candidatePoints:qualityRows.length,acceptedPoints:knowledgeIds.length,droppedPoints:qualityRows.length-knowledgeIds.length,retriedPoints,extraAttempts:retriedPoints};
  const {dispositions,statistics}=readReviewedQuizStatistics({sqlite:store.sqlite,run,knowledgeIds,outputs});
  return {ok:true,value:{caseId:item.id,knowledgeIds,accepted:outputs.map(o=>o.knowledgeId),outputs,knowledgeStatistics,dispositions,statistics,maximumAttempts:QUIZ_MAX_ATTEMPTS,learnerPublication:false,passes:outputs.length===acceptedPoints.length}};
 }
 return {accept,extract,current,list,quiz,forCase,directory:store.directory,async close(){await pixelBrowser?.close();await store.close();}};
}
