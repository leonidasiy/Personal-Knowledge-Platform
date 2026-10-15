import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createQuizActorCritic,normalizeKnowledgeQuizEvaluation} from '../src/features/knowledge-workflows/quiz.js';
import {normalizeQuizPairDraftAliases,isQuizPairDraft,assembleQuizPair,quizPairStableId,quizPairSchema} from '../src/features/knowledge-workflows/quiz-pair.js';
import {questionGeneratorPrompt,questionEvaluatorPrompt,questionEvaluationSchema,requestMaterialBatch} from '../worker/knowledge-workflow-runtime.js';
import {requestWebpageFacts} from '../worker/webpage-facts.js';
import {prepareEvaluationMaterials,classifyEvaluationFailure,createEvaluationRoleGenerate,composeSelectedEvaluation} from './webpage-image-evaluation.mjs';
import {openEvaluationGrant} from './evaluation-budget.mjs';
import {reviewBenchmark} from './mistral-benchmark.ts';
import {pathToFileURL} from 'node:url';
import {appendFileSync} from 'node:fs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function reconstructSavedKnowledge({item,contract,receipts,decodePixels,pdfSources}) {
 const proofs=[],generate=async command=>{
  const prefix=contract.iterationId+':'+command.taskId+':';
  const row=receipts.find(r=>typeof r.response==='string'&&r.key.startsWith(prefix)&&/^[a-f0-9]{64}(?::recovery-\d+)?$/.test(r.key.slice(prefix.length)));
  assert(row,'ActualSavedModelReceiptMissing '+command.taskId);
  const envelope=JSON.parse(row.response),value=JSON.parse(envelope.choices[0].message.content);
  proofs.push({key:row.key,responseSha256:hash(row.response)});return {ok:true,value};
 };
 const points=[];
 if(!item.input.material){
  const result=await requestWebpageFacts({reviewUsefulness:receipts.some(r=>typeof r.response==='string'&&r.key.startsWith(contract.iterationId+':'+item.id+':facts:grounding:')&&JSON.parse(JSON.parse(r.response).choices[0].message.content).verdicts?.some(v=>v&&Object.hasOwn(v,'useful'))),normalizeClaims:receipts.some(r=>r.key.startsWith(contract.iterationId+':'+item.id+':facts:normalization:')),structuredOutput:true,taskId:item.id+':facts',input:{url:item.input.evidence.url,...item.input},maxOutputTokens:4096,generate,logger:()=>{}});
  assert(result.ok,'ActualSavedWebpageFactsInvalid');points.push(...result.value.candidates);
 }else{
  const prepared=await prepareEvaluationMaterials([item],3000000,decodePixels,pdfSources);assert(prepared.ok,'ActualSavedMaterialInvalid');
  const material=prepared.value[0].input.material,image=item.images[0],scope={ownerId:contract.grant.id,runId:contract.iterationId};
  for(let offset=0;offset<material.sections.length;offset+=5){
   const result=await requestMaterialBatch({taskId:item.id+':material:'+offset,reviewMaterial:receipts.some(r=>typeof r.response==='string'&&r.key.startsWith(contract.iterationId+':'+item.id+':material:'+offset+':review:')),observeImage:receipts.some(r=>typeof r.response==='string'&&r.key.startsWith(contract.iterationId+':'+item.id+':material:'+offset+':observations:')),input:{fileName:material.fileName,sections:material.sections.slice(offset,offset+5),coverageGoals:item.input.coverageGoals,progress:{},mode:material.kind==='pdf-text'?'text':'image',...(material.kind==='uploaded-raster'?{visualId:image.id,scope,imageIdentity:{...scope,locator:material.sections[0].locator,visualId:image.id,digest:image.digest}}:{})},...(material.kind==='uploaded-raster'?{attachments:[{id:image.id,mediaType:image.mediaType,bytes:Uint8Array.from(Buffer.from(image.base64,'base64'))}],decodeImage:async(bytes,type)=>{const decoded=await decodePixels(bytes,type);return decoded.ok?{ok:true,value:null}:decoded;}}:{}),maxOutputTokens:16384,generate,logger:()=>{}});
   assert(result.ok,'ActualSavedMaterialOutputInvalid');for(const page of result.value)points.push(...page.candidates);
  }
 }
 assert(points.length>0&&new Set(points.map(p=>p.normalizedHash)).size===points.length,'ActualSavedKnowledgeIdentityInvalid');
 return {caseId:item.id,sourceUrl:item.input.evidence.url,receiptProofs:proofs,knowledge:points.map(point=>({...point,id:item.id+':'+point.normalizedHash,sourceId:item.id,sourceRevision:1,extractionVersion:contract.runtimePolicy.codeSha256,attribution:{sourceUrl:item.input.evidence.url}}))};
}

function assembleDraft(value,point){
 value=normalizeQuizPairDraftAliases(value);
 if(!isQuizPairDraft(value)||value.knowledgeId!==point.id||value.knowledgeRevision!==point.sourceRevision)return {ok:false,error:{kind:'QuizDraftSchemaInvalid'}};
 const pair=assembleQuizPair(value,quizPairStableId({sourceId:point.sourceId,knowledgeId:point.id,revision:point.sourceRevision}));
 const correct=pair.multipleChoice.correctOptionKeys.map(key=>pair.multipleChoice.options.find(option=>option.key===key)?.text);
 return {ok:true,value:{id:pair.multipleChoice.id,knowledgeId:point.id,knowledgeRevision:point.sourceRevision,kind:pair.multipleChoice.kind,prompt:pair.multipleChoice.prompt,options:pair.multipleChoice.options.map(option=>option.text),answer:pair.multipleChoice.kind==='single-choice'?correct[0]:correct,explanation:pair.multipleChoice.explanation,citedEvidenceUrls:pair.citedEvidenceUrls,pairedQuiz:pair}};
}

export function captureQuizBatch(commands){
 const sources=new Map();
 const projected=commands.map(command=>({...command,knowledge:{...command.knowledge,evidenceAnchors:command.knowledge.evidenceAnchors.map(anchor=>{
  if(typeof anchor.quote!=='string')return {...anchor};
  const {quote,...metadata}=anchor,reference='captured:'+hash(quote);
  sources.set(reference,{reference,text:quote});return {...metadata,quoteReference:reference};
 })}}));
 return {commands:projected,capturedEvidence:[...sources.values()]};
}

export async function runBenchmarkQuizzes({caseId,points,generate,file,maximumEvaluatorOutputTokens,logger=()=>{},now=()=>new Date().toISOString()}){
 let saved;try{saved=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;saved={caseId,knowledgeIds:points.map(p=>p.id),attempts:[],outputs:[],accepted:[],dispositions:[],learnerPublication:false};}
 assert.equal(saved.caseId,caseId);assert.deepEqual(saved.knowledgeIds,points.map(p=>p.id));assert.equal(saved.learnerPublication,false);
 const persist=async()=>{await writeFile(file+'.tmp',JSON.stringify(saved,null,2)+'\n',{mode:0o600});await rename(file+'.tmp',file);};
 const ok=value=>({ok:true,value});
 let stopReason;const paidGenerate=generate;generate=async command=>{if(stopReason)throw new Error(stopReason);let result;try{result=await paidGenerate({...command,failureOrigin:'pipeline'});}catch(error){const failure=error?.failure??{kind:error?.kind??'BenchmarkPipelineExecutionFailed'};if(classifyEvaluationFailure(failure)==='pipeline')return {ok:false,error:failure};stopReason=failure.kind;throw new Error(stopReason,{cause:error});}if(!result.ok&&classifyEvaluationFailure(result.error)!=='pipeline'){stopReason=result.error.kind;throw new Error(stopReason);}return result;};
 const cached=new Map(),dispatch=command=>cached.has(command.role+':'+command.input.knowledge.id+':'+command.input.attempt)?Promise.resolve(cached.get(command.role+':'+command.input.knowledge.id+':'+command.input.attempt)):generate(command);
 const actor=createQuizActorCritic({maxAttempts:3,technicalRetries:false,now,logger,
  generator:{generate:async command=>{
   const result=await dispatch({role:'knowledge-scraper',taskId:caseId+':quiz-generator:'+command.knowledge.id+':attempt-'+command.attempt,systemPrompt:questionGeneratorPrompt,input:command,maxOutputTokens:2048,responseSchema:quizPairSchema(true)});
   saved.outputs.push({phase:'generation',knowledgeId:command.knowledge.id,attempt:command.attempt,result});await persist();
   return result.ok?assembleDraft(result.value,command.knowledge):result;
  }},
  reviewer:{evaluate:async command=>{
   const result=await dispatch({role:'review-grader',taskId:caseId+':quiz-evaluator:'+command.knowledge.id+':attempt-'+command.attempt,systemPrompt:questionEvaluatorPrompt,input:command,maxOutputTokens:1024,responseSchema:questionEvaluationSchema});
   saved.outputs.push({phase:'evaluation',knowledgeId:command.knowledge.id,attempt:command.attempt,result});await persist();return cached.has('review-grader:'+command.knowledge.id+':'+command.attempt)||!result.ok?result:normalizeKnowledgeQuizEvaluation(result.value,command.knowledge);
  }},
  repository:{findPublished:async command=>{const accepted=saved.accepted.find(a=>a.knowledge.id===command.knowledgeId);return ok(accepted?{status:'published',attempt:accepted.attempt}:null);},appendAttempt:async attempt=>{if(stopReason){saved.executionStops??=[];saved.executionStops.push({knowledgeId:attempt.knowledgeId,attempt:attempt.attempt,reason:stopReason});}else{const previous=saved.attempts.find(a=>a.knowledgeId===attempt.knowledgeId&&a.attempt===attempt.attempt);if(previous){for(const key of ['draftId','score','feedback','failureKind'])assert.deepEqual(previous[key],attempt[key],'QuizAttemptReplayChanged');}else saved.attempts.push(attempt);}await persist();return ok(null);},publish:async command=>{saved.accepted.push({...command,learnerPublication:false});await persist();return ok(null);},discard:async()=>ok(null),purge:async()=>ok(null)}
 });
 const batchSize=Math.floor(maximumEvaluatorOutputTokens/1024);assert(batchSize>=1,'QuizEvaluatorOutputBudgetInvalid');
 for(let offset=0;offset<points.length;offset+=batchSize){
  const batch=points.slice(offset,offset+batchSize);if(batch.every(point=>saved.dispositions.some(d=>d.knowledgeId===point.id)))continue;
  const batchId=hash(JSON.stringify(batch.map(point=>point.id))).slice(0,16);
  const previousGeneration=saved.batchOutputs?.find(output=>output.phase==='generation'&&output.batchId===batchId);
  const generated=previousGeneration?.result??await generate({role:'knowledge-scraper',taskId:caseId+':quiz-batch-generator:'+batchId,systemPrompt:questionGeneratorPrompt+'\n# Batch envelope\nProcess each command independently. Return exactly {"quizzes":[pairedQuizDraft,...]} in command order; each element follows the full output contract above and its supplied knowledge identity. No other fields. Resolve each quoteReference against capturedEvidence for the full original quote; these references are evidence identities, never answers.',input:captureQuizBatch(batch.map(knowledge=>({knowledge,attempt:1,feedback:null}))),maxOutputTokens:batch.length*2048,responseSchema:{name:'benchmark_quiz_batch_v1',schema:{type:'object',additionalProperties:false,required:['quizzes'],properties:{quizzes:{type:'array',minItems:batch.length,maxItems:batch.length,items:quizPairSchema(true).schema}}}}});
  saved.batchOutputs??=[];if(!previousGeneration)saved.batchOutputs.push({phase:'generation',batchId,result:generated});await persist();
  const validBatch=generated.ok&&generated.value!==null&&typeof generated.value==='object'&&!Array.isArray(generated.value)&&Object.keys(generated.value).join(',')==='quizzes'&&Array.isArray(generated.value.quizzes)&&generated.value.quizzes.length===batch.length&&generated.value.quizzes.every((q,i)=>q?.knowledgeId===batch[i].id);
  const evaluatorCommands=[];
  for(let i=0;i<batch.length;i++){
   const point=batch[i],result=validBatch?ok(generated.value.quizzes[i]):generated.ok?{ok:false,error:{kind:'QuizBatchSchemaInvalid'}}:generated;
   cached.set('knowledge-scraper:'+point.id+':1',result);
   const assembled=result.ok?assembleDraft(result.value,point):result;
   if(assembled.ok&&result.value.knowledgeRevision===point.sourceRevision&&result.value.citedEvidenceUrls.every(url=>point.evidenceAnchors.some(anchor=>anchor.url===url))){evaluatorCommands.push({draft:assembled.value,knowledge:{id:point.id,summary:point.summary,evidenceAnchors:point.evidenceAnchors},deterministicValidation:{ok:true},attempt:1,rubric:'10 means the draft tests the key concept precisely; 1 means irrelevant or too general.'});}
  }
  if(evaluatorCommands.length){
   const previousEvaluation=saved.batchOutputs.find(output=>output.phase==='evaluation'&&output.batchId===batchId);
   const evaluated=previousEvaluation?.result??await generate({role:'review-grader',taskId:caseId+':quiz-batch-evaluator:'+batchId,systemPrompt:questionEvaluatorPrompt+'\n# Batch envelope\nEvaluate every command independently. Return exactly {"evaluations":[{"knowledgeId":"supplied identity","evaluation":evaluationObject},...]} in command order; evaluationObject follows the complete output contract above. No other fields. Resolve each quoteReference against capturedEvidence for the full original quote; these references are evidence identities, never answers.',input:captureQuizBatch(evaluatorCommands),maxOutputTokens:evaluatorCommands.length*1024,responseSchema:{name:'benchmark_quiz_evaluation_batch_v2',schema:{type:'object',additionalProperties:false,required:['evaluations'],properties:{evaluations:{type:'array',minItems:evaluatorCommands.length,maxItems:evaluatorCommands.length,items:{type:'object',additionalProperties:false,required:['knowledgeId','evaluation'],properties:{knowledgeId:{type:'string',enum:evaluatorCommands.map(command=>command.knowledge.id)},evaluation:questionEvaluationSchema.schema}}}}}}});
   assert(previousEvaluation?.evaluationProtocol===undefined||previousEvaluation.evaluationProtocol===questionEvaluationSchema.name,'QuizBatchEvaluationProtocolInvalid');
   if(!previousEvaluation)saved.batchOutputs.push({phase:'evaluation',batchId,evaluationProtocol:questionEvaluationSchema.name,result:evaluated});await persist();
   const valid=evaluated.ok&&evaluated.value!==null&&typeof evaluated.value==='object'&&!Array.isArray(evaluated.value)&&Object.keys(evaluated.value).join(',')==='evaluations'&&Array.isArray(evaluated.value.evaluations)&&evaluated.value.evaluations.length===evaluatorCommands.length&&evaluated.value.evaluations.every((entry,i)=>entry!==null&&typeof entry==='object'&&!Array.isArray(entry)&&Object.keys(entry).sort().join(',')==='evaluation,knowledgeId'&&entry.knowledgeId===evaluatorCommands[i].knowledge.id);
   assert(!previousEvaluation||previousEvaluation.evaluationProtocol!==undefined||!valid||evaluated.value.evaluations.every(entry=>!Array.isArray(entry.evaluation?.knowledgeGroundingProblems)||!entry.evaluation.knowledgeGroundingProblems.some(issue=>issue!==null&&typeof issue==='object')),'QuizBatchEvaluationProtocolMissing');
   evaluatorCommands.forEach((command,i)=>cached.set('review-grader:'+command.knowledge.id+':1',valid?(previousEvaluation&&previousEvaluation.evaluationProtocol===undefined?ok(evaluated.value.evaluations[i].evaluation):normalizeKnowledgeQuizEvaluation(evaluated.value.evaluations[i].evaluation,command.knowledge)):evaluated.ok?{ok:false,error:{kind:'QuizBatchEvaluationInvalid'}}:evaluated));
  }
  for(const point of batch){
   if(saved.dispositions.some(d=>d.knowledgeId===point.id))continue;
   const result=await actor.run({ownerId:'isolated-benchmark',runId:caseId,points:[point]});if(!result.ok){if(classifyEvaluationFailure(result.error)!=='pipeline')throw Object.assign(new Error(result.error.kind),{failure:result.error});saved.dispositions.push({knowledgeId:point.id,status:'abandoned',attempts:0,failureKind:result.error.kind});await persist();continue;}
   if(stopReason)throw new Error(stopReason);
   saved.dispositions.push(...result.value.dispositions);await persist();
   logger({event:'benchmark-quiz-point-complete',caseId,completed:saved.dispositions.length,total:points.length,accepted:saved.accepted.length});
  }
 }
 return {caseId,points:points.length,accepted:saved.accepted.length,passes:saved.dispositions.length===points.length&&saved.dispositions.every(d=>d.status==='accepted'),scores:saved.accepted.map(a=>a.score),dispositions:saved.dispositions,learnerPublication:false};
}

export async function runQuizBenchmarkCli(args){
 assert(args.length===2&&args[0]==='--execute','QuizBenchmarkArgumentsInvalid');
 const c=JSON.parse(await readFile(args[1],'utf8'));assert.equal((await reviewBenchmark(c)).ok,true);
 if(c.pipelineMode!==undefined)return runReviewedQuizBenchmark(c);
 assert(c.quizRun?.knowledgeFile&&c.quizRun?.caseIds&&Object.hasOwn(c.sourceFiles,c.quizRun.knowledgeFile),'SourceBoundQuizInputsRequired');
 const cases=JSON.parse(await readFile(c.quizRun.knowledgeFile,'utf8'));assert.deepEqual(cases.map(item=>item.caseId),c.quizRun.caseIds);
 assert(process.env.OPENROUTER_API_KEY,'OpenRouterCredentialMissing');
 const logger=entry=>appendFileSync(c.directory+'/quiz-events.jsonl',JSON.stringify(entry)+'\n',{mode:0o600});
 const opened=await openEvaluationGrant({grant:c.grant,ledgerFile:c.grant.storePath,runtimePolicy:c.runtimePolicy,originalGrantSha256:c.runtimePolicy.originalGrantSha256,accountingMode:'estimated',ownerDecision:c.ownerDecision,now:Date.now,logger});
 assert(opened.ledger.activateRuntimeWindow().ok,'QuizBenchmarkWindowInvalid');const snapshot=opened.ledger.snapshot();assert(snapshot.ok&&snapshot.value.activeRequests===0,'QuizRequiresIdlePaidLease');
 const deadline=snapshot.value.effectiveDeadlineAtMs,controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DOMException('EvaluationWindowExpired','TimeoutError')),Math.max(1,deadline-Date.now()));
 const role=createEvaluationRoleGenerate({profiles:c.roleProfiles,reasoningSettings:c.reasoningSettings,apiKey:process.env.OPENROUTER_API_KEY,modelConfig:{endpoint:'https://openrouter.ai/api/v1/chat/completions',timeoutMs:1800000,maximumInputCharacters:3000000},transport:{ledger:opened.ledger,iterationId:c.iterationId,fetch,now:Date.now,signal:controller.signal,logger,billingMode:'estimated',ownerDecision:c.ownerDecision},costPolicy:c.costPolicy});
 const generate=command=>deadline>Date.now()?role({...command,timeoutMs:deadline-Date.now()}):Promise.resolve({ok:false,error:{kind:'EvaluationDeadlineExceeded'}});
 try{const results=[];for(const item of cases){
  if(deadline<=Date.now())throw new Error('EvaluationDeadlineExceeded');
  const result=await runBenchmarkQuizzes({caseId:item.caseId,points:item.knowledge,generate,file:c.directory+'/quiz-'+item.caseId+'.json',maximumEvaluatorOutputTokens:c.roleProfiles.roles['review-grader'].protocol.maximumOutputTokens,logger:entry=>{logger(entry);console.log(JSON.stringify(entry));}});
  results.push(result);await writeFile(c.directory+'/quiz-result.json',JSON.stringify({status:results.length===cases.length?'completed':'incomplete',cases:cases.length,completed:results.length,passed:results.filter(r=>r.passes).length,results,learnerPublication:false},null,2)+'\n',{mode:0o600});
 }
 }finally{clearTimeout(timer);await new Promise(resolve=>opened.ledger.closeWhenSettled(()=>{opened.database.close();resolve();}));await writeFile(c.directory+'/quiz-terminal.json',JSON.stringify({at:new Date().toISOString(),cleanupConfirmed:true})+'\n',{mode:0o600});}
}
/** Reviewed mode consumes only the application's accepted artifacts and scoped actor.
 * The predecessor is source bound; no old baseline output or batch cache is used. */
async function runReviewedQuizBenchmark(c){
 const adapter=await import(new URL('./benchmark-reviewed-runtime.mjs',import.meta.url).href);
 assert.equal(await adapter.validateReviewedPipeline(c),true);
 const q=c.quizRun;assert(q&&typeof q.knowledgeContractFile==='string'&&Object.hasOwn(c.sourceFiles,q.knowledgeContractFile)&&typeof q.applicationDirectory==='string'&&typeof q.knowledgeIterationId==='string'&&Array.isArray(q.caseIds),'ReviewedQuizSourceRequired');
 const previous=JSON.parse(await readFile(q.knowledgeContractFile));assert.equal(previous.pipelineMode,c.pipelineMode);assert.equal(previous.iterationId,q.knowledgeIterationId);assert.equal(previous.grant.id,c.grant.id);assert.equal(q.applicationDirectory,previous.reviewedStorageDirectory??previous.directory+'/reviewed-application');assert.deepEqual(previous.roleProfiles,c.roleProfiles);assert.deepEqual(previous.reasoningSettings,c.reasoningSettings);
 assert(q.caseIds.length>0&&new Set(q.caseIds).size===q.caseIds.length&&q.caseIds.every(id=>(previous.caseIds??previous.selection.map(s=>s.caseId)).includes(id)),'ReviewedQuizCaseScopeInvalid');
 const read=async file=>JSON.parse(await readFile(file,'utf8'));
 const [config,corpus,selectedRun,negativeTargets]=await Promise.all([read(previous.paths.config),read(previous.paths.corpus),read(previous.paths.selectedRun),read(previous.paths.negativeTargets)]);
 const selected=composeSelectedEvaluation({config,corpus,selectedRun,negativeTargets,caseIds:q.caseIds});assert(selected.ok,'ReviewedQuizSourceCompositionInvalid');
 const {testPixelDecoder}=await import('../tests-node/evaluation-pixel-decoder.mjs');let decoder;
 const decodePixels=async(bytes,type)=>{decoder??=await testPixelDecoder();return decoder.decodePixels(bytes,type);};
 const prepared=await prepareEvaluationMaterials(selected.value.corpus.cases,config.model.maximumInputCharacters,decodePixels,selected.value.corpus.pdfSources);assert(prepared.ok,'ReviewedQuizMaterialInvalid');
 assert(process.env.OPENROUTER_API_KEY,'OpenRouterCredentialMissing');
 const logger=entry=>appendFileSync(c.directory+'/quiz-events.jsonl',JSON.stringify(entry)+'\n',{mode:0o600});
 const opened=await openEvaluationGrant({grant:c.grant,ledgerFile:c.grant.storePath,runtimePolicy:c.runtimePolicy,originalGrantSha256:c.runtimePolicy.originalGrantSha256,accountingMode:'estimated',ownerDecision:c.ownerDecision,now:Date.now,logger});
 const controller=new AbortController();let application,timer;
 try{
  application=await adapter.openReviewedBenchmark({contract:c,imagePolicy:config.imagePolicy,roleDependencies:{profiles:c.roleProfiles,reasoningSettings:c.reasoningSettings,apiKey:process.env.OPENROUTER_API_KEY,modelConfig:config.model,transport:{ledger:opened.ledger,iterationId:c.iterationId,fetch,now:Date.now,signal:controller.signal,logger,billingMode:'estimated',ownerDecision:c.ownerDecision},costPolicy:c.costPolicy},logger});
  assert(opened.ledger.activateRuntimeWindow().ok,'ReviewedQuizWindowInvalid');const snapshot=opened.ledger.snapshot();assert(snapshot.ok&&snapshot.value.activeRequests===0,'ReviewedQuizRequiresIdlePaidLease');
  const deadline=snapshot.value.effectiveDeadlineAtMs;timer=setTimeout(()=>controller.abort(new DOMException('EvaluationWindowExpired','TimeoutError')),Math.max(1,deadline-Date.now()));
  const results=[];
  for(const id of q.caseIds){if(deadline<=Date.now())throw new Error('EvaluationDeadlineExceeded');const item=prepared.value.find(item=>item.id===id);assert(item,'ReviewedQuizSourceMissing');let result;try{result=await application.quiz(item);}catch(error){if(!(error instanceof Error))throw error;result={ok:false,error:error.failure??{kind:error.kind??'BenchmarkPipelineExecutionFailed'}};}if(!result.ok){const usage=opened.ledger.snapshot();if(!usage.ok||usage.value.admissionHalted||(usage.value.effectiveCancelled??usage.value.cancelled)||usage.value.activeRequests||classifyEvaluationFailure(result.error)!=='pipeline')throw Object.assign(new Error(result.error.kind),{failure:result.error});result={ok:true,value:{caseId:id,passes:false,status:'failed',failure:result.error,terminalReason:result.error.kind,learnerPublication:false}};}results.push(result.value);await writeFile(c.directory+'/quiz-'+id+'.json',JSON.stringify(result.value,null,2)+'\n',{mode:0o600});await writeFile(c.directory+'/quiz-result.json',JSON.stringify({pipelineMode:c.pipelineMode,status:results.length===q.caseIds.length?'completed':'incomplete',cases:q.caseIds.length,completed:results.length,passed:results.filter(r=>r.passes).length,results,applicationDirectory:application.directory,knowledgeIterationId:q.knowledgeIterationId,learnerPublication:false},null,2)+'\n',{mode:0o600});}
 }finally{clearTimeout(timer);await application?.close();await decoder?.close();await new Promise(resolve=>opened.ledger.closeWhenSettled(()=>{opened.database.close();resolve();}));await writeFile(c.directory+'/quiz-terminal.json',JSON.stringify({at:new Date().toISOString(),cleanupConfirmed:true})+'\n',{mode:0o600});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runQuizBenchmarkCli(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
