// One source-derived test candidate, real archived pixels, native matcher and
// verifier. This does not publish knowledge or resume the failed reviewer chain.
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,mkdir,open} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {createOpenLearnPipelineBudget,pipelineProtocol,PIPELINE_MODELS} from './openlearn-pipeline-budget.mjs';
import {createD1Port} from './openlearn-six-page-pipeline.mjs';
import {createAgentConfigurationLoader} from '../src/features/knowledge-workflows/config.js';
import {isKnowledgeCandidate} from '../src/features/knowledge-workflows/extraction.js';
import {createOpenRouterKnowledgeModel} from '../worker/knowledge-workflow-model.js';
import {createWebpageImageBudget,WEBPAGE_IMAGE_POLICY} from '../worker/webpage-image-budget.js';
import {associateWebpageImages,imageHash} from '../worker/webpage-images.js';
import {createWebpageAttemptPolicy,quoteHash,isWebpageEvidence} from '../worker/webpage-facts.js';

const project=resolve(fileURLToPath(new URL('..',import.meta.url)));
const directory=resolve('output/playwright/openlearn-browser-images');
const basePath=resolve('test-results/openlearn-six-page-pipeline-20261013/pipeline-contract.json');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const unwrap=result=>{if(!result.ok)throw new Error(result.error.kind);return result.value;};

async function prepare(){
 const base=await json(basePath),capturePath=resolve(directory,'capture-result.json'),capture=await json(capturePath);
 assert.equal(capture.result,'CAPTURE_PASS');assert.equal(capture.cleanup.ok,true);assert.equal(capture.firecrawlApiCalls,0);
 const page=capture.pages.find(page=>new URL(page.url).pathname.endsWith('content-section-2.1'));assert.ok(page);
 const evidence=await json(page.evidencePath);assert.ok(isWebpageEvidence(evidence));
 const image=evidence.images.find(image=>image.url.endsWith('/a224_pm_mu001.jpg'));assert.ok(image);
 const stored=page.images.find(candidate=>candidate.url===image.url&&candidate.sha256);assert.ok(stored);
 assert.equal(hash(await readFile(stored.path)),stored.sha256);
 const block=evidence.blocks.find(block=>block.text.includes('five-line staff'));assert.ok(block);
 const summary='The staff shown in Example 1 has five lines.';
 const fact={summary,normalizedHash:'standalone-test-five-line-staff',evidenceAnchors:[{url:evidence.url,selector:block.locator,blockId:block.id,clause:summary,quote:block.text,quoteDigest:await quoteHash(block.text)}],coverageGoalIds:[],mediaCandidates:[]};assert.ok(isKnowledgeCandidate(fact));
 const authority={ownerAuthorized:true,source:'can you attempt that approach and verify that it works; by the way, besides image association, all the knowledge points and quizzes could be generated successfully, right?',scope:'Browser image capture and one native matcher/verifier sample on a source-derived provisional test claim. No accepted Library knowledge or quiz publication, reviewer retry reset, Firecrawl service dispatch, or replenishment.',models:[PIPELINE_MODELS[0]],maximumModelCalls:2,cumulativeModelCostLimitNanodollars:1_000_000_000,cumulativeBrowserCreditLimit:100};
 const paths=new Set(base.sourceBindings.map(binding=>binding.path));paths.add('scripts/openlearn-browser-image-association.mjs');paths.add('scripts/openlearn-browser-image-probe.mjs');
 const sourceBindings=[];for(const path of [...paths].sort())sourceBindings.push({path,sha256:hash(await readFile(resolve(project,path)))});
 const priorResultPath=resolve(dirname(basePath),'pipeline-result.json');
 const contract={version:'openlearn-browser-image-association-v1',preparedAt:new Date().toISOString(),basePath,baseSha256:hash(await readFile(basePath)),capturePath,captureSha256:hash(await readFile(capturePath)),evidencePath:page.evidencePath,evidenceSha256:hash(await readFile(page.evidencePath)),image:{id:image.id,url:image.url,...stored},fact,authority,priorResultPath,priorResultSha256:hash(await readFile(priorResultPath)),sourceBindings};
 await save(resolve(directory,'association-contract.json'),contract);console.log(JSON.stringify({contract:resolve(directory,'association-contract.json'),sourceBindings:sourceBindings.length,modelApiCalls:0}));
}

async function run(contractPath){
 const contractBytes=await readFile(contractPath),contract=JSON.parse(contractBytes),gate=await json(resolve(directory,'association-gate.json')),snapshot=await json(resolve(directory,'association-snapshot-result.json'));
 assert.equal(contract.version,'openlearn-browser-image-association-v1');assert.equal(gate.decision,'PASS');assert.equal(gate.contractSha256,hash(contractBytes));assert.equal(gate.snapshotDigest,snapshot.digest);
 assert.equal(fileURLToPath(import.meta.url),resolve(snapshot.path,'files/scripts/openlearn-browser-image-association.mjs'));
 for(const binding of contract.sourceBindings)assert.equal(hash(await readFile(resolve(snapshot.path,'files',binding.path))),binding.sha256);
 for(const [path,sha] of [[contract.basePath,contract.baseSha256],[contract.capturePath,contract.captureSha256],[contract.evidencePath,contract.evidenceSha256],[contract.image.path,contract.image.sha256],[contract.priorResultPath,contract.priorResultSha256]])assert.equal(hash(await readFile(path)),sha);
 assert.equal(contract.authority.maximumModelCalls,2);assert.deepEqual(contract.authority.models,[PIPELINE_MODELS[0]]);
 const base=await json(contract.basePath),initialEvidence=await json(contract.evidencePath),imageBytes=new Uint8Array(await readFile(contract.image.path));
 assert.ok(isKnowledgeCandidate(contract.fact));
 const image=initialEvidence.images.find(image=>image.id===contract.image.id&&image.url===contract.image.url);assert.ok(image);
 const evidence={...initialEvidence,images:[image]};assert.ok(isWebpageEvidence(evidence));
 for(const name of ['association-attempt.json','association-result.json','association-trace.jsonl','association-application.sqlite'])assert.equal(existsSync(resolve(directory,name)),false,'Standalone test execution must be pristine');
 const lock=await open(resolve(dirname(contract.basePath),'pipeline-run.lock'),'wx',0o600);
 const tracePath=resolve(directory,'association-trace.jsonl');let traceWrites=Promise.resolve();
 const log=entry=>{traceWrites=traceWrites.then(()=>appendFile(tracePath,JSON.stringify({at:new Date().toISOString(),...entry})+'\n'));return traceWrites;};
 let budget,db,result,cleanup={ok:false},modelCalls=0;
 try{
  const attempt=await open(resolve(directory,'association-attempt.json'),'wx',0o600);try{await attempt.writeFile(JSON.stringify({contractSha256:hash(contractBytes),startedAt:new Date().toISOString()})+'\n');}finally{await attempt.close();}
  process.loadEnvFile(resolve(dirname(contract.basePath),'../..','.env'));assert.ok(process.env.OPENROUTER_API_KEY);
  budget=createOpenLearnPipelineBudget({storePath:base.budgetStorePath,priorStorePath:base.priorStorePath,priorAccounting:base.priorAccounting,catalogs:base.catalogs,ownerCostAssumption:base.ownerCostAssumption,failedReviewCostPolicy:base.failedReviewCostPolicy,logger:entry=>{void log(entry);},onResponse:entry=>log({phase:'paid-model-response',...entry})});
  const before=budget.snapshot();assert.equal(before.current.requests,19);assert.equal(before.cumulativeModelCostNanodollars,119143859);assert.equal(before.reservedBrowserCredits,96);assert.equal(before.preparationPaused,true);assert.ok(before.remainingMilliseconds>0);
  const source=new DatabaseSync(base.applicationStorePath,{readOnly:true});try{await backup(source,resolve(directory,'association-application.sqlite'));}finally{source.close();}
  db=new DatabaseSync(resolve(directory,'association-application.sqlite'));
  const config=unwrap(await createAgentConfigurationLoader({sha256:async text=>'sha256:'+hash(text)}).load({source:await readFile(resolve(snapshot.path,'files/agent-config/knowledge-scraper.yaml'),'utf8'),expectedRole:'knowledge-scraper'}));assert.equal(config.model.name,PIPELINE_MODELS[0]);
  const model=createOpenRouterKnowledgeModel({apiKey:process.env.OPENROUTER_API_KEY,endpoint:'https://openrouter.ai/api/v1/chat/completions',model:config.model.name,timeoutMs:config.limits.timeoutMs,maximumInputCharacters:250_000,fetch:budget.modelFetch,protocol:pipelineProtocol(base.catalogs[config.model.name],'knowledge-scraper'),now:budget.nowMs,logger:entry=>{void log(entry);}});
  const imageBudget=createWebpageImageBudget({database:createD1Port(db),policy:WEBPAGE_IMAGE_POLICY,scope:{ownerId:base.identity.ownerId,runId:base.identity.runId,pageUrl:evidence.url},maximumPages:100,deadlineAtMs:budget.nowMs()+before.remainingMilliseconds,now:budget.nowMs,logger:entry=>{void log(entry);}});
  const associated=await associateWebpageImages({scope:{ownerId:base.identity.ownerId,runId:base.identity.runId,sourceRevision:1},facts:[contract.fact],evidence,budget:imageBudget,attemptPolicy:createWebpageAttemptPolicy({extraction:1,grounding:1,match:1,verify:1,requests:2}),digest:imageHash,readImage:async(url,_deadline,maximumBytes)=>{assert.equal(url,contract.image.url);assert.ok(imageBytes.length<=maximumBytes);return {ok:true,value:{bytes:imageBytes.slice(),mediaType:contract.image.mediaType}};},logger:entry=>{void log(entry);},generate:async command=>{
   assert.ok(modelCalls<contract.authority.maximumModelCalls);modelCalls++;
   budget.bindModelStage('knowledge-scraper',{ownerId:base.identity.ownerId,runId:base.identity.runId,stageKey:'standalone-browser-image-'+command.phase,inputDigest:'sha256:'+hash(JSON.stringify(command.input)),createdAt:new Date(budget.nowMs()).toISOString()});
   const generated=await model.generate({role:'knowledge-scraper',phase:command.phase,systemPrompt:command.systemPrompt,input:command.input,attachments:command.attachments,maxOutputTokens:command.maxOutputTokens,responseSchema:command.responseSchema});
   return generated.ok?{ok:true,value:generated.value.output}:generated;
  }});
  if(associated.ok&&associated.value.some(value=>value.status==='match'))assert.equal(modelCalls,2,'Match requires both actual matcher and verifier calls');
  const projected=associated.ok?await Promise.all(associated.value.map(async({image,...rest})=>({...rest,...(image?{image:{id:image.id,url:image.url,mediaType:image.mediaType,byteLength:image.bytes.length,digest:await imageHash(image.bytes)}}:{})}))):associated;
  result={version:'openlearn-browser-image-association-result-v1',sourceDerivedTestCandidate:true,acceptedLibraryKnowledge:false,fullPipelineVerified:false,fact:contract.fact,image:contract.image,modelCalls,association:projected,outcome:associated.ok&&associated.value.length===1&&associated.value[0].status==='match'?'ASSOCIATION_PASS':associated.ok?'ASSOCIATION_ABSTAINED':'ASSOCIATION_FAILED'};
 }catch(error){result={version:'openlearn-browser-image-association-result-v1',sourceDerivedTestCandidate:true,acceptedLibraryKnowledge:false,fullPipelineVerified:false,modelCalls,outcome:'ASSOCIATION_FAILED',error:{kind:error?.failure?.kind??(['Error','TypeError','SyntaxError','RangeError','AssertionError'].includes(error?.name)?error.name:'UnknownFailure')}};}
 finally{
  if(db)db.close();cleanup={ok:true};await traceWrites;
  try{if(budget){const accounting=budget.snapshot(),recordedAt=new Date().toISOString(),stop={version:'openlearn-six-page-pipeline-result-v1',executionScope:'standalone-browser-image-association',recordedAt,outcome:{ok:result?.outcome==='ASSOCIATION_PASS'},cleanup,accounting};
   const trace=Buffer.from(JSON.stringify({at:recordedAt,phase:'pipeline-stopped',executionScope:stop.executionScope,cleanup,accounting})+'\n'),bytes=Buffer.from(JSON.stringify(stop,null,2)+'\n');
   const resultPath=resolve(directory,'stop-result-'+hash(bytes)+'.json'),stopTracePath=resolve(directory,'stop-trace-'+hash(trace)+'.jsonl');await writeFile(resultPath,bytes,{mode:0o600});await writeFile(stopTracePath,trace,{mode:0o600});
   budget.pauseForPreparation({resultPath,resultSha256:hash(bytes),tracePath:stopTracePath,traceSha256:hash(trace)});result.accounting=budget.snapshot();}}
  finally{if(budget)budget.close();await lock.close();await import('node:fs/promises').then(fs=>fs.rm(resolve(dirname(contract.basePath),'pipeline-run.lock'),{force:true}));await save(resolve(directory,'association-result.json'),{...result,cleanup});}
 }
 console.log(JSON.stringify({outcome:result.outcome,modelCalls,cumulativeModelCostNanodollars:result.accounting?.cumulativeModelCostNanodollars,result:resolve(directory,'association-result.json')}));
}
if(process.argv.includes('--prepare'))await prepare();
else if(process.argv.includes('--run'))await run(resolve(process.argv[process.argv.indexOf('--run')+1]));
else throw new Error('Use --prepare or --run <contract>');
