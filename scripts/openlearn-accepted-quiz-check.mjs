// Native downstream check on committed knowledge; extraction state stays unfinished.
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,mkdir,open,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {createOpenLearnPipelineBudget,pipelineProtocol,MIMO_EVALUATOR_MODEL} from './openlearn-pipeline-budget.mjs';
import {createD1Port,createSixCaptureReplayBrowser,loadSixCaptureManifest,createFailedReviewRecoveryHooks,executeAuthorizedReviewRetries,waitForReviewRetryAfter,sourceBindings as collectBindings} from './openlearn-six-page-pipeline.mjs';
import {createKnowledgeWorkflowRuntime} from '../worker/knowledge-workflow-runtime.js';
import {createAgentConfigurationLoader} from '../src/features/knowledge-workflows/config.js';
import {D1KnowledgeWorkflowRepository} from '../worker/knowledge-workflow-d1.js';
import {D1KnowledgeContentRepository} from '../worker/knowledge-workflow-content-d1.js';
import {createLearningBatchService} from '../worker/learning-batches-d1.js';
import {AgentExecutionBoundaryFailure} from '../src/features/knowledge-workflows/harness.js';
import {WEBPAGE_IMAGE_POLICY} from '../worker/webpage-image-budget.js';

const project=resolve(fileURLToPath(new URL('..',import.meta.url)));
const mimo=process.argv.includes('--mimo');
const automaticRouting=mimo||process.argv.includes('--automatic-routing');
const directory=resolve('output/playwright/'+(mimo?'openlearn-mimo-review':automaticRouting?'openlearn-automatic-review':'openlearn-accepted-quizzes'));
const basePath=resolve('test-results/openlearn-six-page-pipeline-20261013/pipeline-contract.json');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const unwrap=result=>{if(!result.ok)throw new Error(result.error.kind);return result.value;};

async function prepare(){
 const base=await json(basePath),applicationBasePath=mimo?resolve('output/playwright/openlearn-automatic-review/application.sqlite'):automaticRouting?resolve('output/playwright/openlearn-accepted-quizzes/application.sqlite'):base.applicationStorePath,db=new DatabaseSync(applicationBasePath,{readOnly:true});let points,run,additionalReview,allowedStagePrefixes;
 try{points=db.prepare('SELECT point_json FROM extraction_knowledge_points WHERE owner_id=? AND run_id=? ORDER BY created_at,knowledge_id').all(base.identity.ownerId,base.identity.runId).map(row=>JSON.parse(row.point_json));run=JSON.parse(db.prepare('SELECT run_json FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=?').get(base.identity.ownerId,base.identity.runId).run_json);}
 finally{if(mimo){const rows=db.prepare("SELECT stage_key FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND (stage_key LIKE 'question-evaluator:quiz-preference-%' OR stage_key LIKE 'question-evaluator:quiz-evaluator-%') ORDER BY length(stage_key)").all(base.identity.ownerId,base.identity.runId);allowedStagePrefixes=[...new Set(rows.map(row=>row.stage_key.split(':sha256:')[0]+':'))];assert.equal(allowedStagePrefixes.length,2);}if(automaticRouting&&!mimo){const rows=db.prepare("SELECT * FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND stage_key LIKE 'question-evaluator:quiz-evaluator-%' ORDER BY length(stage_key)").all(base.identity.ownerId,base.identity.runId);assert.equal(rows.length,3);assert.ok(rows.every(row=>row.status==='claimed'));additionalReview=rows.at(-1);}db.close();}
 assert.equal(points.length,1);assert.equal(run.state,'retryable-failure');assert.ok(points.every(point=>point.mediaCandidates.length===0));
 let evaluatorCandidate,candidateCatalog;
 if(mimo){const source=await readFile(resolve(project,'agent-config/question-evaluator.yaml'),'utf8');assert.ok(source.includes('name: mistralai/mistral-large-4-0'));evaluatorCandidate=source.replace('version: question-evaluator-v6','version: question-evaluator-v7').replace('name: mistralai/mistral-large-4-0','name: '+MIMO_EVALUATOR_MODEL);const catalogPath=resolve(directory,'model-catalog.json'),bytes=await readFile(catalogPath),model=JSON.parse(bytes).data.find(m=>m.id===MIMO_EVALUATOR_MODEL);assert.ok(model);candidateCatalog={path:catalogPath,source:'https://openrouter.ai/api/v1/models',retrievedAt:new Date().toISOString(),catalogSha256:hash(bytes),model};}
 const paths=new Set([...base.sourceBindings.map(binding=>binding.path),...(await collectBindings(project,'scripts/openlearn-accepted-quiz-check.mjs')).keys()]);
 const sourceBindings=[];for(const path of [...paths].sort())sourceBindings.push({path,sha256:hash(await readFile(resolve(project,path)))});
 const contract={version:'openlearn-accepted-quiz-check-v1',preparedAt:new Date().toISOString(),basePath,baseSha256:hash(await readFile(basePath)),applicationBasePath,applicationSha256:hash(await readFile(applicationBasePath)),automaticReviewerRouting:automaticRouting,evaluatorCandidate,candidateCatalog,allowedStagePrefixes,additionalReview,points,run,sourceBindings,authority:{ownerAuthorized:true,source:mimo?"Can you try using Mimo v2.6 Pro as the evaluator? If that works, use that from now on.":automaticRouting?"You may retry by trusting openrouter's dynamic routing capability.":'Continue verifying, especially the end-to-end pipeline flow, encompassing all critical phases: knowledge extraction, image association, quiz generation, etc.',...(automaticRouting?{maximumAdditionalPaidCalls:mimo?2:1,scopeOverride:mimo?'Native MiMo preference and quiz review on cached real draft. Evaluator model/config refresh on isolated copy only; retain four prior Mistral failures. No other model work.':'One additional attempt on the exact exhausted saved quiz reviewer; no extraction retry. Automatic provider load balancing within unchanged price and cumulative caps.'}:{}),scope:'Native quiz actor on the existing accepted point and saved review evidence, in an isolated application copy using the original cumulative budget and clock. No completed-extraction claim, exhausted-review retry reset, image attachment invented for text-only knowledge, Firecrawl call, or hosted mutation.'}};
 await mkdir(directory,{recursive:true});await save(resolve(directory,'contract.json'),contract);console.log(JSON.stringify({contract:resolve(directory,'contract.json'),sourceBindings:sourceBindings.length,points:points.length,modelApiCalls:0}));
}

async function run(contractPath){
 const bytes=await readFile(contractPath),contract=JSON.parse(bytes),gate=await json(resolve(directory,'gate.json')),snapshot=await json(resolve(directory,'snapshot-result.json'));
 assert.equal(contract.version,'openlearn-accepted-quiz-check-v1');assert.equal(gate.decision,'PASS');assert.equal(gate.contractSha256,hash(bytes));assert.equal(gate.snapshotDigest,snapshot.digest);
 assert.equal(fileURLToPath(import.meta.url),resolve(snapshot.path,'files/scripts/openlearn-accepted-quiz-check.mjs'));
 for(const binding of contract.sourceBindings)assert.equal(hash(await readFile(resolve(snapshot.path,'files',binding.path))),binding.sha256);
 assert.equal(hash(await readFile(contract.basePath)),contract.baseSha256);
 const base=await json(contract.basePath);assert.equal(hash(await readFile(contract.applicationBasePath??base.applicationStorePath)),contract.applicationSha256);
 const loaded=await loadSixCaptureManifest(base.manifestPath,base.manifestSha256),lock=await open(resolve(dirname(basePath),'pipeline-run.lock'),'wx',0o600);
 const tracePath=resolve(directory,'trace.jsonl');let writes=Promise.resolve();const log=entry=>{writes=writes.then(()=>appendFile(tracePath,JSON.stringify({at:new Date().toISOString(),...entry})+'\n'));return writes;};
 let budget,db,hooks,lastStage,outcome,report,expectedRun=contract.run,cleanup={ok:false};
 try{
  if(!process.env.OPENROUTER_API_KEY)process.loadEnvFile(resolve(dirname(contract.basePath),'../..','.env'));assert.ok(process.env.OPENROUTER_API_KEY);
  let catalogs=base.catalogs;const evaluatorModel=contract.candidateCatalog?.model.id??'mistralai/mistral-large-4-0';if(contract.candidateCatalog){const c=contract.candidateCatalog;assert.equal(hash(await readFile(c.path)),c.catalogSha256);assert.deepEqual(JSON.parse(await readFile(c.path,'utf8')).data.find(m=>m.id===evaluatorModel),c.model);catalogs={...catalogs,[evaluatorModel]:c};}
  budget=createOpenLearnPipelineBudget({storePath:base.budgetStorePath,priorStorePath:base.priorStorePath,priorAccounting:base.priorAccounting,catalogs,evaluatorModel,ownerCostAssumption:base.ownerCostAssumption,failedReviewCostPolicy:base.failedReviewCostPolicy,automaticReviewerRouting:contract.automaticReviewerRouting===true,logger:entry=>{void log(entry);},onResponse:entry=>log({phase:'paid-model-response',...entry})});
  assert.equal(budget.snapshot().preparationPaused,true);assert.ok(budget.snapshot().remainingMilliseconds>0);
  const copyPath=resolve(directory,'application.sqlite');
  if(!existsSync(copyPath)){const source=new DatabaseSync(contract.applicationBasePath??base.applicationStorePath,{readOnly:true});try{await backup(source,copyPath);}finally{source.close();}}
  db=new DatabaseSync(copyPath);const database=createD1Port(db),now=()=>new Date(budget.nowMs()).toISOString(),logger=entry=>{void log(entry);};
  const repository=new D1KnowledgeWorkflowRepository({database,logger});let run=unwrap(await repository.findById(base.identity.ownerId,base.identity.runId));assert.deepEqual(run,contract.run);
  const content=new D1KnowledgeContentRepository({database,logger}),points=unwrap(await content.listKnowledgePoints({...base.identity,sourceRevision:1}));assert.deepEqual(points,contract.points);
  const configs={},loader=createAgentConfigurationLoader({sha256:async text=>'sha256:'+hash(text)});
  for(const role of ['rights-assessor','knowledge-scraper','question-generator','question-evaluator'])configs[role]=unwrap(await loader.load({source:await readFile(resolve(snapshot.path,'files/agent-config',role+'.yaml'),'utf8'),expectedRole:role}));
  if(contract.evaluatorCandidate){const previous=configs['question-evaluator'],next=unwrap(await loader.load({source:contract.evaluatorCandidate,expectedRole:'question-evaluator'}));const strip=c=>{const value=structuredClone(c);delete value.digest;delete value.canonicalJson;delete value.id;delete value.version;delete value.model.name;return value;};assert.equal(previous.model.name,'mistralai/mistral-large-4-0');assert.equal(next.model.name,MIMO_EVALUATOR_MODEL);assert.equal(next.version,'question-evaluator-v7');assert.deepEqual(strip(previous),strip(next));configs['question-evaluator']=next;expectedRun={...run,configDigests:{...run.configDigests,'question-evaluator':next.digest},revision:run.revision+1,updatedAt:now()};const audit={version:'isolated-evaluator-model-refresh-v1',authority:contract.authority,before:run,after:expectedRun};db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO pipeline_configuration_refreshes VALUES(?,?)').run(hash(JSON.stringify(audit)),JSON.stringify(audit));unwrap(await repository.update({ownerId:run.ownerId,runId:run.runId,expectedRevision:run.revision,next:expectedRun}));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}run=expectedRun;await log({phase:'pipeline-evaluator-model-refreshed',previousModel:previous.model.name,model:next.model.name,previousDigest:previous.digest,digest:next.digest});}
  hooks=createFailedReviewRecoveryHooks({db,budget,identity:base.identity,log});
  const baseline=budget.snapshot();let paidCalls=0,dispatches=0;
  const modelFetch=async(url,init)=>{if(contract.automaticReviewerRouting){if(dispatches>=contract.authority.maximumAdditionalPaidCalls){const error=new AgentExecutionBoundaryFailure({kind:'EvaluationBudgetExceeded',field:'OwnerAdditionalReviewerAttemptLimit'});error.notStarted=false;throw error;}assert.equal(JSON.parse(init.body).model,evaluatorModel);assert.equal(paidCalls,dispatches+1);dispatches++;}return budget.modelFetch(url,init);};
  const authorizeFailedReviewCall=async stage=>{const proof=await hooks.authorizeFailedReviewCall(stage);if(!proof)return null;const target=contract.additionalReview;return {...proof,...(target&&stage.key===target.stage_key&&stage.inputDigest===target.input_digest&&stage.createdAt===target.created_at?{allowAdditionalAttempt:true}:{})};};
  const runtime=createKnowledgeWorkflowRuntime({preflightModelWork:(role,stage)=>{if(contract.automaticReviewerRouting){assert.equal(role,'question-evaluator');if(contract.evaluatorCandidate){assert.ok(contract.allowedStagePrefixes.some(prefix=>stage.stageKey.startsWith(prefix)));assert.equal(stage.ownerId,run.ownerId);assert.equal(stage.runId,run.runId);assert.ok(paidCalls<contract.authority.maximumAdditionalPaidCalls);assert.equal(budget.snapshot().current.requests,baseline.current.requests+paidCalls);paidCalls++;}else{assert.ok(stage.stageKey.startsWith(contract.additionalReview.stage_key+':owner-review-recovery:'));assert.equal(stage.inputDigest,contract.additionalReview.input_digest);assert.equal(paidCalls++,0);assert.equal(budget.snapshot().current.requests,baseline.current.requests);}}hooks.preflightModelWork(role,stage);lastStage={role,...stage};},authorizeFailedReviewCall,webpageStructuredOutput:true,imagePolicy:WEBPAGE_IMAGE_POLICY,database,fetch:modelFetch,browser:createSixCaptureReplayBrowser(loaded.captures),apiKey:process.env.OPENROUTER_API_KEY,endpoint:'https://openrouter.ai/api/v1/chat/completions',now,nowMs:budget.nowMs,logger,configSnapshots:configs,modelProtocols:Object.fromEntries(Object.entries(configs).map(([role,c])=>[role,pipelineProtocol(catalogs[c.model.name],role,contract.automaticReviewerRouting===true,evaluatorModel)])),reviewedNavigation:loaded.navigation,transition:async()=>{throw new Error('DownstreamCheckCannotTransitionExtraction');}});
  outcome=await unwrap(runtime.createQuizActorForRun(run)).run({ownerId:run.ownerId,runId:run.runId,points});
 }catch(error){outcome={ok:false,error:{kind:error?.failure?.kind??(['Error','TypeError','SyntaxError','RangeError','AssertionError'].includes(error?.name)?error.name:'UnknownFailure')}};}
 finally{
  try{
   try{if(db){const database=createD1Port(db),now=()=>new Date(budget.nowMs()).toISOString(),learning=createLearningBatchService({database,now,logger:()=>{}}),identity=base.identity;
    const persisted=db.prepare('SELECT knowledge_id,status,draft_json,attempt_number FROM knowledge_workflow_quizzes WHERE owner_id=? AND run_id=?').all(identity.ownerId,identity.runId);
    const generated= persisted.map(({draft_json,...row})=>({...row,draft:JSON.parse(draft_json)}));
    const retainedRun=JSON.parse(db.prepare('SELECT run_json FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=?').get(identity.ownerId,identity.runId).run_json);assert.deepEqual(retainedRun,expectedRun);
    const retainedPoints=db.prepare('SELECT point_json FROM extraction_knowledge_points WHERE owner_id=? AND run_id=? ORDER BY created_at,knowledge_id').all(identity.ownerId,identity.runId).map(row=>JSON.parse(row.point_json));
    await save(resolve(directory,'outputs.json'),{inputKnowledge:contract.points,knowledge:retainedPoints,quizzes:generated,quizAttempts:db.prepare('SELECT attempt_number,score,failure_kind FROM knowledge_workflow_quiz_attempts WHERE owner_id=? AND run_id=?').all(identity.ownerId,identity.runId),learningUnitCount:db.prepare('SELECT count(*) AS n FROM learning_generation_units WHERE owner_id=?').get(identity.ownerId).n,feed:await learning.loadFeed(identity.ownerId,now().slice(0,10)),review:await learning.loadReview(identity.ownerId,now().slice(0,10)),actualRun:retainedRun});
   }}catch{outcome={ok:false,error:{kind:'DownstreamProjectionFailed'},priorOutcome:outcome};}
   let reviewRecovery=null;
   try{reviewRecovery=outcome?.ok===false&&lastStage?.role==='question-evaluator'?await hooks?.recoveryForStage(lastStage)??null:null;}
   catch{outcome={ok:false,error:{kind:'DownstreamRecoveryProofFailed'},priorOutcome:outcome};}
   if(db){db.close();db=null;}cleanup={ok:true};await writes;
   if(reviewRecovery?.retryAtMs!==undefined&&!await waitForReviewRetryAfter({proof:reviewRecovery,remainingMilliseconds:budget.snapshot().remainingMilliseconds,log}))reviewRecovery=null;
   const accounting=budget?.snapshot(),recordedAt=new Date().toISOString();await log({at:recordedAt,phase:'pipeline-stopped',executionScope:'accepted-knowledge-quizzes',outcome,cleanup,accounting});await writes;
   const stop={version:'openlearn-six-page-pipeline-result-v1',recordedAt,executionScope:'accepted-knowledge-quizzes',fullPipelineVerified:false,outcome,cleanup,accounting,reviewRecovery};
   const stopBytes=Buffer.from(JSON.stringify(stop,null,2)+'\n'),resultPath=resolve(directory,'result-'+hash(stopBytes)+'.json'),traceBytes=await readFile(tracePath),immutableTrace=resolve(directory,'trace-'+hash(traceBytes)+'.jsonl');await writeFile(resultPath,stopBytes,{flag:'wx',mode:0o600});if(!existsSync(immutableTrace))await writeFile(immutableTrace,traceBytes,{flag:'wx',mode:0o600});
   if(budget&&cleanup.ok&&accounting.remainingMilliseconds>0)budget.pauseForPreparation({resultPath,resultSha256:hash(stopBytes),tracePath:immutableTrace,traceSha256:hash(traceBytes)});
   report={...stop,accounting:budget?.snapshot(),preparationPauseAcknowledged:budget?.snapshot().preparationPaused===true};await save(resolve(directory,'result.json'),report);
  }finally{db?.close();budget?.close();await lock.close();await rm(resolve(dirname(basePath),'pipeline-run.lock'),{force:true});}
 }
 console.log(JSON.stringify({outcome,fullPipelineVerified:false,result:resolve(directory,'result.json')}));return report;
}

if(process.argv.includes('--prepare'))await prepare();
else if(process.argv.includes('--run')){const path=resolve(process.argv[process.argv.indexOf('--run')+1]);if(automaticRouting)await run(path);else await executeAuthorizedReviewRetries(()=>run(path));}
else throw new Error('Use --prepare or --run CONTRACT_JSON');
