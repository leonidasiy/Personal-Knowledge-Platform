// Local acceptance against native services and an isolated copy of actual
// pipeline output. The active checkpoint is an explicitly labeled fixture;
// knowledge, quizzes, classification, and media are never fabricated here.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream,existsSync} from 'node:fs';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync,backup} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {createD1Port,createFileBucket,pipelineIdentity} from './openlearn-six-page-pipeline.mjs';
import {createDiscoveryWorker} from '../worker/handler.js';
import {SourceCatalogQueryService} from '../src/features/source-library/query.js';
import {D1SourceLibraryRepository} from '../worker/source-library-d1.js';
import {createSourceCursorCodec} from '../worker/source-cursor.js';
import {createLearningBatchService} from '../worker/learning-batches-d1.js';
import {D1KnowledgeWorkflowRepository} from '../worker/knowledge-workflow-d1.js';
import {D1KnowledgeContentRepository} from '../worker/knowledge-workflow-content-d1.js';
import {D1KnowledgeWorkflowProgressRepository} from '../worker/knowledge-workflow-progress-d1.js';
import {D1KnowledgeMediaRepository} from '../worker/knowledge-workflow-media-d1.js';
import {createKnowledgeWorkflowService} from '../src/features/knowledge-workflows/workflow.js';
import {createKnowledgeWorkflowCleanup} from '../worker/knowledge-workflow-cleanup.js';
import {createMediaPipeline} from '../src/features/knowledge-workflows/media.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const partial=process.argv.includes('--partial');
const contractPath=resolve(process.argv.slice(2).find(value=>!value.startsWith('--'))??'test-results/openlearn-six-page-pipeline-20261013/pipeline-contract.json');
const output=resolve(dirname(contractPath),'frontend');
const now=()=>new Date().toISOString(),ok=value=>({ok:true,value}),fail=kind=>({ok:false,error:{kind}});
const unwrap=result=>{if(!result.ok)throw new Error(result.error.kind);return result.value;};
const report={version:'openlearn-native-ui-v1',actualContent:true,checkpointFixture:false,actions:[],screenshots:[],requests:[],pageErrors:[],backendErrors:[],externalRequests:[],checks:{},result:'NOT_RUN'};
const contentTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.woff2':'font/woff2'};
let db,server,context,profile,page;
function count(table,ownerId,runId){return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=? AND run_id=?`).get(ownerId,runId).n);}

function composeWorker(origin,identity,bucket){
 const database=createD1Port(db),logger=entry=>{if(entry.failureKind)report.backendErrors.push({event:entry.event,failureKind:entry.failureKind});};
 const repository=new D1KnowledgeWorkflowRepository({database,logger});
 const progress=new D1KnowledgeWorkflowProgressRepository({database,logger});
 const content=new D1KnowledgeContentRepository({database,logger});
 const workflow=createKnowledgeWorkflowService(repository,{now,createId:randomUUID,logger,cleanup:createKnowledgeWorkflowCleanup({database,bucket,workflowRepository:repository,now,logger})});
 const catalog=new SourceCatalogQueryService({repository:new D1SourceLibraryRepository(database),cursorCodec:createSourceCursorCodec(randomUUID()+randomUUID(),crypto.subtle),semanticRanker:{rank:async()=>fail('SourceSemanticIndexUnavailable')},maximumSemanticCandidates:20,maximumPageSize:50,maximumQueryLength:200,fusionVersion:'rrf-v1'});
 const media=createMediaPipeline({repository:new D1KnowledgeMediaRepository({database,bucket,logger}),digest:async bytes=>createHash('sha256').update(bytes).digest('hex'),quarantine:{put:async()=>fail('LocalUiCreationDisabled'),remove:async()=>fail('LocalUiCreationDisabled')},derivatives:{create:async()=>fail('LocalUiCreationDisabled')},createId:randomUUID,now,logger});
 const learning=createLearningBatchService({database,bucket,now,logger});
 const sourceStatus=async command=>{
  const run=unwrap(await repository.listBySource(command.ownerId,command.sourceId))[0]??null;
  return ok({ownerId:command.ownerId,sourceId:command.sourceId,run:run?{...run,progress:unwrap(await progress.read(run))}:null,imageWarnings:run?unwrap(await content.loadImageWarnings({ownerId:command.ownerId,runId:run.runId})):[]});
 };
 return {progress,repository,learning,worker:createDiscoveryWorker({allowedOrigin:origin,maximumCommandBytes:1048576},{authenticate:async()=>ok({ownerId:identity.ownerId,email:'isolated-ui@example.test'}),acquireRss:async()=>fail('LocalUiNetworkDisabled'),sourceCatalog:catalog,knowledgeWorkflow:{start:async()=>fail('LocalUiProcessingDisabled'),status:command=>workflow.status(command),sourceStatus,control:command=>workflow.control(command)},learningBatches:learning,learningMedia:{serve:command=>media.serve(command)},requestLogger:()=>ok(null),now})};
}

async function startServer(identity,bucket){
 let ports;
 server=createServer(async(req,res)=>{
  try{
   const origin=`http://127.0.0.1:${server.address().port}`,url=new URL(req.url??'/',origin);
   if(url.pathname.startsWith('/api/')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    report.requests.push({method:req.method,path:url.pathname,time:Date.now()});
    const response=await ports.worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}));
    if(url.pathname==='/api/learning-generation/review-batch'){report.reviewResponses??=[];report.reviewResponses.push({httpStatus:response.status,body:await response.clone().json()});}
    if(!response.ok&&url.pathname!=='/api/learning-media'){const failure=await response.clone().json();report.apiFailures??=[];report.apiFailures.push({path:url.pathname,httpStatus:response.status,kind:failure.error?.kind??failure.result?.error?.kind??null});}
    if(url.pathname==='/api/knowledge-workflows/source-status'){const status=await response.clone().json();report.statusResponses??=[];report.statusResponses.push({httpStatus:response.status,projection:status.result??status});}
    if(url.pathname==='/api/knowledge-workflows/control'){const control=await response.clone().json();report.controlResponses??=[];report.controlResponses.push({httpStatus:response.status,projection:control.result??control});}
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
   }
   if(!['/','/index.html','/manifest.webmanifest','/service-worker.js'].includes(url.pathname)&&!url.pathname.startsWith('/src/')&&!url.pathname.startsWith('/assets/')){res.writeHead(404).end();return;}
   const file=resolve(root,url.pathname==='/'?'index.html':'.'+decodeURIComponent(url.pathname));
   if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
   res.setHeader('content-type',contentTypes[extname(file)]??'application/octet-stream');
   const stream=createReadStream(file);stream.on('error',()=>{if(!res.headersSent)res.writeHead(404);res.end();});stream.pipe(res);
  }catch(error){report.backendErrors.push({event:'local-ui-request-failure',failureKind:error.message});if(!res.headersSent)res.writeHead(500);res.end();}
 });
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 const origin=`http://127.0.0.1:${server.address().port}`;ports=composeWorker(origin,identity,bucket);return {origin,...ports};
}

async function screenshot(page,name){const path=resolve(output,name+'.png');await page.screenshot({path,fullPage:true});report.screenshots.push(path);}
async function visibleText(page,value){await page.getByText(value,{exact:false}).first().waitFor({state:'visible'});}
async function noOverflow(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);}
async function navigate(page,view){await page.locator(view==="settings"?'[data-focus-key="settings-button"]':`.primary-nav [data-view="${view}"]`).click();}

try{
 await mkdir(output,{recursive:true});
 const contract=JSON.parse(await readFile(contractPath,'utf8')),identity=contract.identity??pipelineIdentity;
 assert.equal(identity.ownerId,pipelineIdentity.ownerId,'Only the explicitly isolated pipeline owner is accepted');
 assert.equal(identity.sourceId,pipelineIdentity.sourceId);
 const sourceDb=new DatabaseSync(contract.applicationStorePath,{readOnly:true});
 try{await backup(sourceDb,resolve(output,'ui-application.sqlite'));}finally{sourceDb.close();}
 if(existsSync(contract.objectDirectory))await cp(contract.objectDirectory,resolve(output,'objects'),{recursive:true,force:true});
 else await mkdir(resolve(output,'objects'),{recursive:true});
 db=new DatabaseSync(resolve(output,'ui-application.sqlite'));
 const actualRun=JSON.parse(db.prepare('SELECT run_json FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=?').get(identity.ownerId,identity.runId).run_json);
 if(!partial)assert.equal(actualRun.state,'completed','Full acceptance requires a completed actual pipeline');
 else assert.notEqual(actualRun.state,'completed','Partial acceptance must preserve the actual incomplete run');
 const points=db.prepare('SELECT knowledge_id,point_json FROM extraction_knowledge_points WHERE owner_id=? AND run_id=? ORDER BY created_at,knowledge_id').all(identity.ownerId,identity.runId);
 const quizzes=db.prepare("SELECT knowledge_id,draft_json FROM knowledge_workflow_quizzes WHERE owner_id=? AND run_id=? AND status='published'").all(identity.ownerId,identity.runId);
 assert.ok(points.length>0,'Actual saved knowledge is required; no synthetic fallback');
 if(!partial)assert.ok(quizzes.length>0,'Full acceptance requires actual published quizzes');
 report.pipeline={runId:identity.runId,actualState:actualRun.state,knowledgePoints:points.length,publishedPairs:quizzes.length,mediaAssets:count('knowledge_workflow_media_assets',identity.ownerId,identity.runId),sourceDatabaseSha256:createHash('sha256').update(await readFile(contract.applicationStorePath)).digest('hex')};
 const {origin,progress,repository}=await startServer(identity,createFileBucket(resolve(output,'objects')));
 profile=await mkdtemp(resolve(tmpdir(),'pkp-openlearn-ui-'));
 context=await chromium.launchPersistentContext(profile,{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,serviceWorkers:'block',viewport:{width:1440,height:1000},colorScheme:'light',reducedMotion:'reduce',args:['--no-first-run','--no-default-browser-check']});
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();report.externalRequests.push({origin:new URL(route.request().url()).origin});return route.abort();});
 page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.pageErrors.push(error.message));
 // Install before application startup so its already-scheduled minute timer
 // belongs to the virtual clock; installing afterward cannot migrate timers.
 await page.clock.install();
 await page.goto(origin+'/#library');
 const card=page.locator(`[data-library-source="${identity.sourceId}"]`);await card.waitFor();
 assert.equal(await page.locator('[data-library-source="isolated-less-often-fixture"]').count(),0,'Disabled preference fixture stays outside Library content');
 await visibleText(page,JSON.parse(points[0].point_json).summary);
 await card.locator('[data-library-workflow-progress]').waitFor();
 assert.equal(await card.locator('[data-library-workflow-progress] [role="status"]').getAttribute('aria-live'),'polite');
 if(!partial)assert.ok((await card.innerText()).includes('Processing complete'));
 else{report.actualProgress=unwrap(await progress.read(actualRun));assert.ok(report.actualProgress.knowledgePoints.some(point=>point.knowledgeId===points[0].knowledge_id));assert.ok((await card.innerText()).includes(`${report.actualProgress.generatedQuizQuestions} quiz questions generated`));report.checks.actualPartialStatus=true;}
 await screenshot(page,'library-desktop-light');await noOverflow(page);
 report.actions.push({action:'actual-native-library',knowledgeId:points[0].knowledge_id});
 // User-selected themes and viewport checks affect only this private profile.
 await navigate(page,'settings');
 const dark=page.locator('input[name="theme-mode"][value="dark"]');
 await dark.waitFor();await dark.check();await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await navigate(page,'library');await card.waitFor();await screenshot(page,'library-desktop-dark');report.checks.darkTheme=true;
 await page.setViewportSize({width:390,height:844});await noOverflow(page);await screenshot(page,'library-mobile');
 await card.focus();assert.equal(await card.evaluate(node=>document.activeElement===node),true);await card.press('Tab');assert.equal(await card.evaluate(node=>node.contains(document.activeElement)),true);report.checks.cardKeyboardFocus=true;
 await page.setViewportSize({width:1440,height:1000});
 if(!partial){
 await navigate(page,'feed');
 const study=page.locator('[data-action="complete-learner-feed"]');await study.first().waitFor();
 report.checks.nativeFeedCards=await study.count();
 const images=page.locator('img[src*="/api/"]');
 report.checks.actualMediaImageCount=await images.count();
 for(const image of await images.all()){await image.scrollIntoViewIfNeeded();await image.evaluate(node=>node.complete&&node.naturalWidth>0?null:new Promise((yes,no)=>{node.addEventListener('load',yes,{once:true});node.addEventListener('error',()=>no(new Error('ActualMediaImageFailed')),{once:true});}));}
 await screenshot(page,'feed-actual-content');
 const studyIds=await page.locator('.learner-feed [data-knowledge-id].learning-card').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-knowledge-id')));
 assert.equal(studyIds.length,5);assert.ok(studyIds.every(id=>points.some(point=>point.knowledge_id===id)));await study.click();await visibleText(page,'Batch studied. Paired questions are unlocked in Review.');
 await navigate(page,'review');
 const question=page.locator('[data-review-question]').first();await question.waitFor();
 assert.equal(await question.locator('fieldset').count(),2,'Actual quiz must render both paired questions');
 await screenshot(page,'review-actual-paired-quiz');await page.setViewportSize({width:390,height:844});await noOverflow(page);await screenshot(page,'review-mobile-paired-quiz');
 const questionId=await question.getAttribute('data-review-question');
 const task=JSON.parse(db.prepare('SELECT task_json FROM learning_generation_tasks WHERE owner_id=? AND task_id=?').get(identity.ownerId,questionId).task_json);
 assert.ok(task.pairedVariants?.length===2);
 for(const variant of task.pairedVariants){
  if(variant.kind==='fill-blank')for(const blank of variant.blanks)await question.locator(`input[name="pairedBlank:${blank.id}"]`).fill(blank.acceptedAnswers[0]);
  else for(const choice of variant.correctChoiceIds){const index=variant.choices.findIndex(item=>item.id===choice);assert.ok(index>=0);await question.locator('input[name="selectedChoiceIds"]').nth(index).check();}
 }
 await question.getByRole('button',{name:'Check both answers'}).click();
 await question.locator('.answer-feedback.is-correct').waitFor();
 const componentFeedback=await question.locator('.source-details li').allTextContents();
 assert.match(componentFeedback[0],/^Choice question: correct/u);
 for(let index=1;index<componentFeedback.length;index++)assert.match(componentFeedback[index],new RegExp(`^Blank ${index}: correct`,'u'));
 assert.ok(componentFeedback.every(text=>!text.includes('quiz:')),'Learner feedback hides internal quiz identifiers');
 report.checks.readableComponentFeedback=true;await screenshot(page,'review-actual-feedback');
 await page.reload();
 await page.locator('[data-review-question]').first().waitFor();
 assert.equal(await page.locator(`[data-review-question="${questionId}"]`).count(),0,'Reload must not reopen an answered question');
 assert.equal(await page.locator('[data-review-question]').count(),studyIds.length-1,'Only unanswered questions resume');
 report.checks.reviewResumesUnanswered=true;
 report.checks.pairedQuizRendered=true;report.checks.nativeCanonicalAnswerFeedback=true;report.actions.push({action:'actual-native-feed-study-and-paired-review',studiedCount:studyIds.length,questionId});
 }
 if(partial){report.untested=['Completed extraction across six pages','Feed with published pairs','Review quiz rendering and grading','Generated media rendering'];report.fullPipeline={result:'BLOCKED',reason:'The source extraction run is incomplete; this partial UI check does not verify Feed, Review grading, or generated media.'};}
 // Minute refresh/cancel require an explicitly active checkpoint after the
 // initial actual-run display. Only the isolated clone's lifecycle is changed.
 await navigate(page,'library');
 const checkpoint={...unwrap(await repository.findById(identity.ownerId,identity.runId)),state:partial?'extraction-loop':'per-point-quiz-loop',revision:actualRun.revision+1,decisionRequired:null,failureKind:null,updatedAt:now(),extractionDeadlineAt:new Date(Date.now()+1800000).toISOString()};
 db.prepare('UPDATE knowledge_workflow_runs SET state=?,revision=?,decision_required=NULL,failure_kind=NULL,updated_at=?,run_json=? WHERE owner_id=? AND run_id=?').run(checkpoint.state,checkpoint.revision,checkpoint.updatedAt,JSON.stringify(checkpoint),identity.ownerId,identity.runId);
 if(!partial){
 unwrap(await progress.save({ownerId:identity.ownerId,runId:identity.runId,currentUrl:JSON.parse(points[0].point_json).attribution.sourceUrl,pageTitle:'Actual OpenLearn content — isolated active checkpoint',sectionTitle:'Extracted content checkpoint',stage:'Generating paired quiz questions',updatedAt:now()}));
 }
 report.checkpointFixture=true;report.checkpointChanges='Isolated active lifecycle checkpoint after actual-run display; generated descendants preserved';
 await page.reload();await card.locator('[data-library-workflow-cancel]').waitFor();
 if(!partial)await visibleText(page,'Generating paired quiz questions');
 else await visibleText(page,JSON.parse(points[0].point_json).summary);
 await screenshot(page,'library-active-checkpoint');
 const baseline=report.requests.filter(item=>item.path==='/api/knowledge-workflows/source-status').length;
 unwrap(await progress.save({ownerId:identity.ownerId,runId:identity.runId,stage:'Minute refresh confirmed — isolated checkpoint',updatedAt:now()}));
 await page.clock.runFor(60001);
 await visibleText(page,'Minute refresh confirmed — isolated checkpoint');
 const after=report.requests.filter(item=>item.path==='/api/knowledge-workflows/source-status').length;
 assert.ok(after>baseline,'One-minute source-scoped status refresh');report.checks.minuteRefresh={virtualTime:true,baseline,after};
 page.once('dialog',dialog=>dialog.dismiss());await card.locator('[data-library-workflow-cancel]').click();assert.equal(count('extraction_knowledge_points',identity.ownerId,identity.runId),points.length);
 page.once('dialog',dialog=>dialog.accept());await card.locator('[data-library-workflow-cancel]').click();
 await visibleText(page,'Processing canceled. Extracted knowledge and quizzes removed.');
 for(const table of ['extraction_knowledge_points','knowledge_workflow_quizzes','knowledge_workflow_progress'])assert.equal(count(table,identity.ownerId,identity.runId),0,table+' purged by production cleanup');
 for(const point of points)assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM learning_generation_tasks WHERE owner_id=? AND item_id=?').get(identity.ownerId,point.knowledge_id).n),0,'Published learner task purged');
 assert.equal(unwrap(await repository.findById(identity.ownerId,identity.runId)).state,'abandoned');
 assert.ok(count('knowledge_workflow_run_tombstones',identity.ownerId,identity.runId)>0,'Cancellation installs a durable late-write fence');
 const latePoint=await new D1KnowledgeContentRepository({database:createD1Port(db),logger:()=>{}}).appendKnowledgePoint(JSON.parse(points[0].point_json),identity.ownerId,identity.runId,now());
 assert.equal(latePoint.ok,false,'Late append of the actual extracted point is rejected after cancellation');
 assert.equal(count('extraction_knowledge_points',identity.ownerId,identity.runId),0);report.checks.latePointWriteFenced=latePoint.error.kind;
 report.cleanupCounts={knowledgePoints:0,quizzes:count('knowledge_workflow_quizzes',identity.ownerId,identity.runId),mediaAssets:count('knowledge_workflow_media_assets',identity.ownerId,identity.runId),tombstones:count('knowledge_workflow_run_tombstones',identity.ownerId,identity.runId)};
 assert.equal(await card.locator('[data-library-workflow-progress]').count(),0);await screenshot(page,'library-canceled');
 const terminalReads=report.requests.filter(item=>item.path==='/api/knowledge-workflows/source-status').length;
 await page.clock.runFor(60001);
 assert.equal(report.requests.filter(item=>item.path==='/api/knowledge-workflows/source-status').length,terminalReads,'Terminal source stops polling');
 report.checks.confirmedCancel=true;report.checks.confirmationDeclinePreserves=true;
 assert.deepEqual(report.pageErrors,[]);report.result=partial?'PARTIAL':'PASS';if(partial)report.partialChecks='PASS';
}catch(error){report.result='FAIL';report.failure={name:error.name,message:error.message};process.exitCode=1;
 if(page&&!page.isClosed())try{await screenshot(page,'failure');await writeFile(resolve(output,'failure-body.txt'),await page.locator('body').innerText(),{mode:0o600});}catch(diagnosticError){report.failureDiagnosticError=diagnosticError.name;}
}
finally{
 if(context)await context.close();if(server)await new Promise(yes=>server.close(yes));if(db)db.close();if(profile)await rm(profile,{recursive:true,force:true});
 await mkdir(output,{recursive:true});await writeFile(resolve(output,'acceptance.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({result:report.result,failure:report.failure??null,report:resolve(output,'acceptance.json')}));
}
