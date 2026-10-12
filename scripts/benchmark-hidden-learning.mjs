import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {reviewBenchmark} from './mistral-benchmark.ts';
import {openEvaluationGrant} from './evaluation-budget.mjs';
import {validateEvaluation,validateRejectionTargets,evaluationHash,createEvaluationRoleGenerate,scoreSemanticEvaluation,isEvaluationQualityFailure,isTerminalPipelineFailure,runIndependentEvaluation,reportWholeCases} from './webpage-image-evaluation.mjs';
import {openPositiveStorage} from './architecture-live-positive.mjs';
import {requestWebpageFacts,createWebpageAttemptPolicy} from '../worker/webpage-facts.js';
import {createWebpageImageBudget} from '../worker/webpage-image-budget.js';
import {associateWebpageImages} from '../worker/webpage-images.js';
import {runBenchmarkQuizzes} from './benchmark-learning-quiz.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),read=async file=>JSON.parse(await readFile(file,'utf8'));

export function validateHiddenLearningInputs({config,corpus,negativeTargets,modelInputs,originalCorpus,goldReview,freezeSha256}){
 assert(validateEvaluation(config,corpus).ok,'HiddenCorpusInvalid');assert(validateRejectionTargets(corpus.cases,negativeTargets).ok,'HiddenRejectionContractInvalid');assert.equal(negativeTargets.corpusHash,corpus.hash);
 assert.equal(corpus.cases.length,10);assert(corpus.cases.every(c=>c.split==='holdout'&&c.origin.kind==='independent-labelled-source'&&!c.input.material));
 assert.equal(new Set(corpus.cases.map(c=>c.sourceFamily)).size,10);assert(corpus.cases.every(c=>!originalCorpus.cases.some(old=>old.id===c.id||old.sourceFamily===c.sourceFamily||old.input.evidence.url.split('#')[0]===c.input.evidence.url.split('#')[0])),'HiddenSourceOverlap');
 assert.equal(goldReview.verdict,'PASS');assert.equal(goldReview.freezeSha256,freezeSha256);assert.equal(goldReview.casesReviewed,10);assert.equal(goldReview.unresolved,0);assert(typeof goldReview.reviewer==='string'&&goldReview.reviewer.trim()&&typeof goldReview.goldAuthor==='string'&&goldReview.goldAuthor.trim()&&goldReview.reviewer!==goldReview.goldAuthor,'SeparateGoldReviewerRequired');
 assert.deepEqual(modelInputs.cases,corpus.cases.map(c=>({id:c.id,input:c.input,images:c.images})),'HiddenModelProjectionChanged');assert.equal(modelInputs.cases.length,10);
 return true;
}

export async function runHiddenLearningBenchmark(args){
 assert(args.length===2&&args[0]==='--execute','HiddenBenchmarkArgumentsInvalid');const c=await read(args[1]);assert.equal((await reviewBenchmark(c)).ok,true);
 const h=c.hiddenRun;assert(h&&['config','corpus','negativeTargets','modelInputs','freeze','goldReview'].every(k=>typeof h[k]==='string'&&Object.hasOwn(c.sourceFiles,h[k])),'SourceBoundHiddenRunRequired');
 const [config,corpus,negativeTargets,modelInputs,originalCorpus,goldReview,freeze]=await Promise.all([read(h.config),read(h.corpus),read(h.negativeTargets),read(h.modelInputs),read(c.paths.corpus),read(h.goldReview),read(h.freeze)]);
 const freezeSha256=sha(await readFile(h.freeze));assert.equal(freezeSha256,h.freezeSha256);assert.equal(freeze.LLMOutputsSeen,0);assert.equal(freeze.cases,10);
 validateHiddenLearningInputs({config,corpus,negativeTargets,modelInputs,originalCorpus,goldReview,freezeSha256});assert(process.env.OPENROUTER_API_KEY,'OpenRouterCredentialMissing');
 const logger=entry=>appendFileSync(c.directory+'/hidden-events.jsonl',JSON.stringify(entry)+'\n',{mode:0o600});
 const reviewedMode=c.pipelineMode!==undefined;
 const adapter=reviewedMode?await import(new URL('./benchmark-reviewed-runtime.mjs',import.meta.url).href):undefined;if(adapter)assert.equal(await adapter.validateReviewedPipeline(c),true);
 const storage=reviewedMode?undefined:await openPositiveStorage({directory:c.directory+'/isolated-storage'}),scope={ownerId:c.grant.id,runId:c.iterationId};
 if(storage)storage.sqlite.prepare('INSERT OR IGNORE INTO knowledge_workflow_runs(owner_id,run_id,source_id,source_revision,canonical_source_identity,content_signature,state,revision,idempotency_key,config_digests_json,counts_json,reused,created_at,updated_at,run_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(scope.ownerId,scope.runId,'hidden10',1,'https://isolated.test/hidden10',corpus.hash,'extraction',1,scope.runId,'{}','{}',0,new Date().toISOString(),new Date().toISOString(),'{}');
 const opened=await openEvaluationGrant({grant:c.grant,ledgerFile:c.grant.storePath,runtimePolicy:c.runtimePolicy,originalGrantSha256:c.runtimePolicy.originalGrantSha256,accountingMode:'estimated',ownerDecision:c.ownerDecision,now:Date.now,logger});
 if(!reviewedMode)assert(opened.ledger.activateRuntimeWindow().ok,'HiddenWindowInvalid');const snapshot=opened.ledger.snapshot();assert(snapshot.ok&&snapshot.value.activeRequests===0,'HiddenRequiresIdlePaidLease');
 let deadline=snapshot.value.effectiveDeadlineAtMs;const controller=new AbortController();let timer=reviewedMode?undefined:setTimeout(()=>controller.abort(new DOMException('EvaluationWindowExpired','TimeoutError')),Math.max(1,deadline-Date.now()));
 const roleDependencies={profiles:c.roleProfiles,reasoningSettings:c.reasoningSettings,apiKey:process.env.OPENROUTER_API_KEY,modelConfig:config.model,transport:{ledger:opened.ledger,iterationId:c.iterationId,fetch,now:Date.now,signal:controller.signal,logger,billingMode:'estimated',ownerDecision:c.ownerDecision},costPolicy:c.costPolicy};
 const role=createEvaluationRoleGenerate(roleDependencies);
 const application=adapter?await adapter.openReviewedBenchmark({contract:c,roleDependencies,imagePolicy:config.imagePolicy,logger}):undefined;
 if(reviewedMode){assert(opened.ledger.activateRuntimeWindow().ok,'HiddenWindowInvalid');const active=opened.ledger.snapshot();assert(active.ok&&active.value.activeRequests===0,'HiddenRequiresIdlePaidLease');deadline=active.value.effectiveDeadlineAtMs;timer=setTimeout(()=>controller.abort(new DOMException('EvaluationWindowExpired','TimeoutError')),Math.max(1,deadline-Date.now()));}
 const generate=command=>deadline>Date.now()?role({...command,timeoutMs:deadline-Date.now()}):Promise.resolve({ok:false,error:{kind:'EvaluationDeadlineExceeded'}});
 const rowsFile=c.directory+'/hidden-result.json';let saved;try{saved=await read(rowsFile);}catch(error){if(error.code!=='ENOENT')throw error;saved={corpusHash:corpus.hash,cases:10,rows:[],learnerPublication:false};}
 assert.equal(saved.corpusHash,corpus.hash);
 const persist=async()=>{const usage=opened.ledger.snapshot();assert(usage.ok);saved.status=saved.rows.length===10?'completed':'incomplete';saved.passed=saved.rows.filter(r=>r.passes).length;saved.scorePercent=saved.passed*10;saved.requiredPasses=9;if(reviewedMode){const whole=reportWholeCases(corpus.cases,saved.rows.map(row=>({...row,split:'holdout',status:row.status??(row.failure?'failed':'completed'),judgeResultRefs:row.judgeResultRefs??[]})));assert(whole.ok,'ReviewedHiddenWholeCaseReportInvalid');saved.wholeCaseReport=whole.value;saved.passed=whole.value.passed;saved.scorePercent=whole.value.passed*10;}saved.accounting=usage.value;await writeFile(rowsFile,JSON.stringify(saved,null,2)+'\n',{mode:0o600});};
 try{for(const input of modelInputs.cases){
  if(saved.rows.some(r=>r.caseId===input.id))continue;if(deadline<=Date.now())throw new Error('EvaluationDeadlineExceeded');
  const item=corpus.cases.find(item=>item.id===input.id),caseGenerate=command=>generate({...command,failureOrigin:command.failureOrigin??'pipeline',role:command.role??(command.phase==='normalization'||command.phase==='grounding'?'review-grader':'knowledge-scraper'),taskId:command.taskId.startsWith(input.id+':')?command.taskId:input.id+':'+command.taskId});
  let facts,associations,judged;const row={caseId:input.id,knowledgeImagePass:false,quizPass:false,passes:false};
  if(application){
   const reviewed=await runReviewedHiddenCase({application,input,item,config,negativeTargets,generate:caseGenerate,deadline,getUsage:()=>opened.ledger.snapshot()});Object.assign(row,reviewed);
  }else{
  try{
   const imageCaps=config.imagePolicy.candidateEvaluationsPerPage,attemptPolicy=createWebpageAttemptPolicy({extraction:1,normalization:1,grounding:1,match:imageCaps,verify:imageCaps*50,requests:3+imageCaps*51});
   const extracted=await requestWebpageFacts({normalizeClaims:true,reviewUsefulness:true,structuredOutput:true,attemptPolicy,taskId:input.id+':facts',input:{url:input.input.evidence.url,...input.input},maxOutputTokens:4096,generate:caseGenerate,logger});if(!extracted.ok)throw Object.assign(new Error(extracted.error.kind),{failure:extracted.error});facts=extracted.value;
   await writeFile(c.directory+'/facts-'+input.id+'.json',JSON.stringify(facts,null,2)+'\n',{mode:0o600});
   const budget=createWebpageImageBudget({database:storage.database,policy:config.imagePolicy,scope:{...scope,pageUrl:input.input.evidence.url},maximumPages:config.runPolicy.maximumPages,deadlineAtMs:deadline,now:Date.now,logger});
   const matched=await associateWebpageImages({attemptPolicy,scope:{...scope,sourceRevision:1},facts:facts.candidates,evidence:input.input.evidence,budget,digest:async bytes=>'sha256:'+sha(bytes),generate:caseGenerate,logger,readImage:async url=>{const metadata=input.input.evidence.images.find(i=>i.url===url),image=input.images.find(i=>i.id===metadata?.id);return image?{ok:true,value:{bytes:Uint8Array.from(Buffer.from(image.base64,'base64')),mediaType:image.mediaType}}:{ok:false,error:{kind:'EvaluationImageMissing'}};}});
   if(!matched.ok)throw Object.assign(new Error(matched.error.kind),{failure:matched.error});associations=matched.value;
   await writeFile(c.directory+'/images-'+input.id+'.json',JSON.stringify(associations,null,2)+'\n',{mode:0o600});
   const failures=associations.flatMap(a=>a.failureKinds??(a.failureKind?[a.failureKind]:[]));if(failures.length)throw Object.assign(new Error(failures[0]),{failure:{kind:failures.find(kind=>!isEvaluationQualityFailure({kind}))??failures[0]}});
   const predictions=facts.candidates.map(fact=>{const a=associations.find(a=>a.normalizedHash===fact.normalizedHash);return {caseId:input.id,summary:fact.summary,imageId:a?.status==='match'?a.image.id:null,status:a?.status??'no-support'};});
   const targets=negativeTargets.targets.filter(t=>t.caseId===input.id),refs=new Set(targets.flatMap(t=>t.evidence.map(e=>e.reference)));
   const grade=await runIndependentEvaluation({generate:caseGenerate,evaluate:evaluatorGenerate=>scoreSemanticEvaluation({cases:[item],predictions,thresholds:config.thresholds,generate:evaluatorGenerate,negativeTargets:{...negativeTargets,targets,sources:negativeTargets.sources.filter(s=>refs.has(s.reference))}})});if(!grade.ok)throw Object.assign(new Error(grade.error.kind),{failure:grade.error});judged=grade.value;
   row.knowledgeImagePass=judged.wholeCases[0].passes&&facts.status!=='empty';row.metrics=judged.metrics;row.counts=judged.counts;row.judgeResultRefs=judged.wholeCases[0].judgeResultRefs;
  }catch(error){if(!(error instanceof Error))throw error;const failure=error.failure??{kind:error.kind??'BenchmarkPipelineExecutionFailed'},usage=opened.ledger.snapshot();if(!usage.ok||!isTerminalPipelineFailure(failure,usage.value))throw error;row.failure=failure;row.status='failed';row.terminalReason=failure.kind;}
  if(!row.failure&&facts?.candidates.length){
   const points=facts.candidates.map(point=>({...point,id:input.id+':'+point.normalizedHash,sourceId:input.id,sourceRevision:1,extractionVersion:c.runtimePolicy.codeSha256,attribution:{sourceUrl:input.input.evidence.url}}));
   const quiz=await runBenchmarkQuizzes({caseId:input.id,points,generate:caseGenerate,file:c.directory+'/quiz-'+input.id+'.json',maximumEvaluatorOutputTokens:c.roleProfiles.roles['review-grader'].protocol.maximumOutputTokens,logger});row.quiz=quiz;row.quizPass=quiz.passes;
  }
  }
  row.passes=row.knowledgeImagePass&&row.quizPass;saved.rows.push(row);await persist();console.log(JSON.stringify({caseId:row.caseId,completed:saved.rows.length,knowledgeImagePass:row.knowledgeImagePass,quizPass:row.quizPass,passes:row.passes}));
 }
 }finally{clearTimeout(timer);await new Promise(resolve=>opened.ledger.closeWhenSettled(()=>{opened.database.close();resolve();}));await application?.close();await storage?.close();await writeFile(c.directory+'/hidden-terminal.json',JSON.stringify({at:new Date().toISOString(),cleanupConfirmed:true})+'\n',{mode:0o600});}
}

export async function runReviewedHiddenCase({application,input,item,config,negativeTargets,generate,deadline,getUsage}){
 const row={knowledgeImagePass:false,quizPass:false,passes:false,applicationDirectory:application.directory};
 let facts,final;
 try{
  const extracted=await application.extract({item:input,generate,deadline,maximumPages:config.runPolicy.maximumPages});if(!extracted.ok)throw Object.assign(new Error(extracted.error.kind),{failure:extracted.error});
  facts=extracted.value.facts;row.status=facts?.status==='empty'?'failed':facts?.status==='partial'?'partial':'completed';
  const quiz=await application.quiz(input);if(!quiz.ok)throw Object.assign(new Error(quiz.error.kind),{failure:quiz.error});row.quiz=quiz.value;row.quizPass=quiz.value.passes;
  final=await application.current(input);if(!final.ok)throw Object.assign(new Error(final.error.kind),{failure:final.error});
 }catch(error){
  if(!(error instanceof Error))throw error;
  const failure=error.failure??{kind:error.kind??'BenchmarkPipelineExecutionFailed'},usage=getUsage();
  if(!usage.ok||!isTerminalPipelineFailure(failure,usage.value))throw error;
  return {...row,status:'failed',failure,terminalReason:failure.kind};
 }
 const targets=negativeTargets.targets.filter(t=>t.caseId===input.id),refs=new Set(targets.flatMap(t=>t.evidence.map(e=>e.reference)));
 const grade=await runIndependentEvaluation({generate,evaluate:evaluatorGenerate=>scoreSemanticEvaluation({cases:[item],predictions:final.value.predictions,thresholds:config.thresholds,generate:evaluatorGenerate,negativeTargets:{...negativeTargets,targets,sources:negativeTargets.sources.filter(s=>refs.has(s.reference))}})});
 if(!grade.ok)throw Object.assign(new Error(grade.error.kind),{failure:grade.error});
 row.knowledgeImagePass=grade.value.wholeCases[0].passes&&row.status==='completed';row.metrics=grade.value.metrics;row.counts=grade.value.counts;row.judgeResultRefs=grade.value.wholeCases[0].judgeResultRefs;
 return row;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runHiddenLearningBenchmark(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
