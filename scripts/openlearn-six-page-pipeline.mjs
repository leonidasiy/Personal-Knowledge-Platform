import {readFile,writeFile,appendFile,mkdir,open,readdir,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {chromium} from 'playwright-core';
import {createKnowledgeWorkflowRuntime} from '../worker/knowledge-workflow-runtime.js';
import {AgentExecutionBoundaryFailure} from '../src/features/knowledge-workflows/harness.js';
import {createKnowledgeWorkflowService,isWorkflowRetryStage} from '../src/features/knowledge-workflows/workflow.js';
import {createAgentConfigurationLoader} from '../src/features/knowledge-workflows/config.js';
import {D1KnowledgeWorkflowRepository} from '../worker/knowledge-workflow-d1.js';
import {D1KnowledgeMediaRepository} from '../worker/knowledge-workflow-media-d1.js';
import {D1KnowledgeContentRepository} from '../worker/knowledge-workflow-content-d1.js';
import {createLearningBatchService} from '../worker/learning-batches-d1.js';
import {createMediaPipeline,acquireImageBytes} from '../src/features/knowledge-workflows/media.js';
import {ACQUISITION_POLICY} from '../worker/acquisition-policy.js';
import {isForbiddenAddress} from '../worker/knowledge-workflow-network.js';
import {isWebpageEvidence} from '../worker/webpage-facts.js';
import {WEBPAGE_IMAGE_POLICY,WEBPAGE_EXTRACTION_POLICY} from '../worker/webpage-image-budget.js';
import {createOpenLearnPipelineBudget,readNavigationAccounting,pipelineProtocol,PIPELINE_MODELS} from './openlearn-pipeline-budget.mjs';
import {navigationInventoryDigest} from './openlearn-navigation-live.mjs';

const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const defaultDirectory=resolve(projectRoot,'test-results/openlearn-six-page-pipeline-20261013');
const navigationDirectory=resolve(projectRoot,'test-results/openlearn-navigation-20261013');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ok=value=>({ok:true,value}),fail=kind=>({ok:false,error:{kind}});
const unwrap=value=>{if(!value.ok)throw new Error(value.error.kind);return value.value;};
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const escape=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const pipelineIdentity={ownerId:'isolated-openlearn-six-page-owner',sourceId:'isolated-openlearn-six-page-source',runId:'isolated-openlearn-six-page-run'};

export function createD1Port(db){
 const executors=new WeakMap();
 return {prepare(sql){let values=[];const execute=()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}}),statement={bind(...args){values=args;return this;},async first(){return db.prepare(sql).get(...values)??null;},async all(){return {success:true,results:db.prepare(sql).all(...values)};},async run(){return execute();}};executors.set(statement,execute);return statement;},async batch(statements){db.exec('BEGIN IMMEDIATE');try{const results=statements.map(statement=>{const execute=executors.get(statement);if(!execute)throw new Error('PipelineDatabaseStatementInvalid');return execute();});db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};
}
export function createFileBucket(directory){
 const filename=key=>{if(typeof key!=='string'||key.includes('\\'))throw new Error('PipelineObjectKeyInvalid');const path=resolve(directory,key);if(!path.startsWith(resolve(directory)+sep))throw new Error('PipelineObjectKeyInvalid');return path;};
 return {async put(key,bytes,options={}){const path=filename(key);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);await save(path+'.metadata.json',options);},async get(key){const path=filename(key);if(!existsSync(path))return null;const bytes=new Uint8Array(await readFile(path));return {arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),httpMetadata:(await json(path+'.metadata.json')).httpMetadata??{}};},async delete(key){const {rm}=await import('node:fs/promises');const path=filename(key);await rm(path,{force:true});await rm(path+'.metadata.json',{force:true});}};
}

export async function loadSixCaptureManifest(manifestPath,expectedSha256){
 const bytes=await readFile(manifestPath);if(hash(bytes)!==expectedSha256)throw new Error('PipelineCaptureManifestChanged');
 const manifest=JSON.parse(bytes);if(manifest.version!=='openlearn-six-capture-manifest-v1'||!Array.isArray(manifest.captures)||manifest.captures.length!==6)throw new Error('PipelineCaptureManifestInvalid');const reviewBytes=await readFile(manifest.inventoryReviewPath),stateBytes=await readFile(manifest.navigationStatePath);if(hash(reviewBytes)!==manifest.inventoryReviewSha256||hash(stateBytes)!==manifest.navigationStateSha256)throw new Error('PipelineCaptureInventoryEvidenceChanged');const review=JSON.parse(reviewBytes),state=JSON.parse(stateBytes);
 if(review.decision!=='PASS'||review.displayedOrderVerified!==true||review.relevantLessonInventoryVerified!==true||navigationInventoryDigest(state.plan)!==review.inventoryDigest||review.inventoryDigest!==manifest.inventoryDigest||manifest.sourceRootUrl!==state.plan.sourceRootUrl)throw new Error('PipelineCaptureInventoryUnreviewed');
 const captures=[];
 for(let i=0;i<6;i++){const item=manifest.captures[i],raw=await readFile(item.path);if(hash(raw)!==item.sha256||item.url!==state.plan.lessonUrls[i])throw new Error('PipelineCaptureBindingInvalid');const page=JSON.parse(raw);if(page.sourceUrl!==item.url||page.responseUrl!==item.url||!isWebpageEvidence(page.evidence)||page.evidence.url!==item.url||page.navigation?.url!==item.url)throw new Error('PipelineCaptureEvidenceInvalid');captures.push(page);}
 return {manifest,captures,navigation:{...state.plan,lessonUrls:manifest.captures.map(c=>c.url),rationale:'Owner authorized replay of exact independently reviewed six-page prefix; remaining course excluded from this pipeline.'}};
}

// A saved browser capture is replayed, not represented as a new live request.
// The discovery-only assessment is deliberately not passed to extraction.
export function createSixCaptureReplayBrowser(captures,archive){
 const pages=new Map(captures.map(page=>[page.sourceUrl,page]));let current=null,currentRoot=null,closed=false;
 return {async readPage({url,rootUrl,signal}){if(closed)return fail('KnowledgeBrowserClosed');if(signal?.aborted)return fail('Cancelled');const page=pages.get(url);if(!page)return fail('PipelineReplayUrlNotCaptured');if(archive){if(typeof rootUrl!=='string'||!URL.canParse(rootUrl))return fail('KnowledgeBrowserNavigationRejected');const root=new URL(rootUrl),target=new URL(url),path=root.pathname.replace(/\/$/,'');if(root.protocol!=='https:'||root.username||root.password||root.port||root.origin!==target.origin||path&&target.pathname!==path&&!target.pathname.startsWith(path+'/'))return fail('KnowledgeBrowserNavigationRejected');}current=page;currentRoot=rootUrl;const evidence=structuredClone(page.evidence),renderedTitle=page.navigation.title,renderedText=evidence.blocks.map(b=>b.text).join('\n');const html='<html><head><title>'+escape(renderedTitle)+'</title></head><body>'+evidence.blocks.map(b=>'<p>'+escape(b.text)+'</p>').join('')+evidence.images.map(i=>'<img src="'+escape(i.url)+'" alt="'+escape(i.occurrences.map(o=>o.alt).join(' '))+'">').join('')+'</body></html>';return ok({url,responseUrl:page.responseUrl,contentType:'text/html',bytes:new TextEncoder().encode(html),redirects:0,renderedTitle,renderedText,evidence,visibleLinks:captures.map(c=>c.sourceUrl)});},...(archive?{async readImage({rootUrl,pageUrl,url,maximumBytes,signal}){if(closed)return fail('KnowledgeBrowserClosed');if(signal?.aborted)return fail('Cancelled');if(!Number.isSafeInteger(maximumBytes)||maximumBytes<=0||maximumBytes>ACQUISITION_POLICY.imageBytes)return fail('MediaCommandInvalid');if(!current||current.responseUrl!==pageUrl||currentRoot!==rootUrl||!current.evidence.images.some(image=>image.url===url))return fail('KnowledgeBrowserObservationStale');const image=archive.get(current.sourceUrl,url);if(!image)return fail('MediaFetchFailed');return image.bytes.length>maximumBytes?fail('MediaPayloadTooLarge'):ok(image);}}:{}),async readRobots(){return fail('RobotsFetchUnavailable');},async screenshot(){return fail('PipelineReplayScreenshotUnavailable');},async close(){closed=true;current=null;currentRoot=null;return ok(null);}};
}

/** Verifies an actual browser capture archive without dispatching any requests.
 * Original manifest evidence remains authoritative for replay text and image URLs.
 * Actual DOM evidence and byte digests independently bind the saved raster files.
 */
export async function loadCapturedBrowserImages(path,expectedSha256,captures){
 const bytes=await readFile(path);if(hash(bytes)!==expectedSha256)throw new Error('PipelineBrowserImagesChanged');const report=JSON.parse(bytes),directory=dirname(resolve(path));
 const publicUrl=raw=>{try{const u=new URL(raw),h=u.hostname.replace(/^\[|\]$/g,'');return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&h!=='localhost'&&!h.endsWith('.localhost')&&!h.endsWith('.local')&&(!(/^\d+\.\d+\.\d+\.\d+$/.test(h)||h.includes(':'))||!isForbiddenAddress(h));}catch{return false;}};
 const inside=raw=>typeof raw==='string'&&resolve(raw).startsWith(directory+sep);
 const uniqueStrings=value=>Array.isArray(value)&&value.every(v=>typeof v==='string')&&new Set(value).size===value.length;
 const sameSet=(a,b)=>a.length===b.length&&a.every(v=>b.includes(v));
 if(report.version!=='openlearn-browser-image-probe-v1'||report.result!=='CAPTURE_PASS'||report.cleanup?.ok!==true||report.blockerBypass!==false||report.firecrawlApiCalls!==0||report.modelApiCalls!==0||!Array.isArray(report.failures)||report.failures.length||!Array.isArray(captures)||captures.length!==6||!Array.isArray(report.pages)||report.pages.length!==6||!Array.isArray(report.assets))throw new Error('PipelineBrowserImagesInvalid');
 const assets=new Map(),references=new Map(),lookup=new Map(),evidenceBindings=[];
 for(const asset of report.assets){
  if(!asset||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256)||assets.has(asset.sha256)||!inside(asset.path)||!Number.isSafeInteger(asset.byteLength)||asset.byteLength<=0||asset.byteLength>Math.min(ACQUISITION_POLICY.imageBytes,ACQUISITION_POLICY.encodedResourceBytes)||!uniqueStrings(asset.sourceUrls)||!uniqueStrings(asset.pageUrls)||!asset.sourceUrls.length||!asset.pageUrls.length||!asset.sourceUrls.every(publicUrl)||!asset.pageUrls.every(publicUrl))throw new Error('PipelineBrowserImageAssetInvalid');
  if((await stat(asset.path)).size!==asset.byteLength)throw new Error('PipelineBrowserImageBytesChanged');const original=await readFile(asset.path);if(hash(original)!==asset.sha256)throw new Error('PipelineBrowserImageBytesChanged');
  const validated=await acquireImageBytes({fetch:async()=>ok(new Response(original,{headers:{'content-type':asset.mediaType}}))},asset.sourceUrls[0],undefined,ACQUISITION_POLICY.imageBytes);if(!validated.ok)throw new Error('PipelineBrowserImageBytesInvalid');
  assets.set(asset.sha256,{asset,image:validated.value});references.set(asset.sha256,{sourceUrls:new Set(),pageUrls:new Set()});
 }
 let imageCount=0;
 for(let i=0;i<6;i++){
  const page=report.pages[i],captured=captures[i];if(!page||page.url!==captured.sourceUrl||!publicUrl(page.url)||!publicUrl(page.responseUrl)||!inside(page.evidencePath)||!uniqueStrings(page.expectedImageUrls)||!Array.isArray(page.images)||page.images.length>ACQUISITION_POLICY.resources)throw new Error('PipelineBrowserImagePageInvalid');
  const requested=new URL(page.url),actual=new URL(page.responseUrl);if(requested.origin!==actual.origin||requested.pathname!==actual.pathname||[...requested.searchParams].some(([key,value])=>!actual.searchParams.getAll(key).includes(value)))throw new Error('PipelineBrowserImagePageInvalid');
  const evidenceDigest=/[/\\]page-([a-f0-9]{64})\.json$/.exec(resolve(page.evidencePath))?.[1],evidenceBytes=await readFile(page.evidencePath);if(!evidenceDigest||hash(evidenceBytes)!==evidenceDigest)throw new Error('PipelineBrowserImageEvidenceChanged');evidenceBindings.push(Object.freeze({path:page.evidencePath,sha256:evidenceDigest}));
  const observed=JSON.parse(evidenceBytes),originalUrls=captured.evidence.images.map(image=>image.url);if(!isWebpageEvidence(observed)||observed.url!==page.responseUrl||!sameSet(page.expectedImageUrls,originalUrls)||!sameSet(page.expectedImageUrls,observed.images.map(image=>image.url)))throw new Error('PipelineBrowserImageEvidenceInvalid');
  const pageImages=new Map();let total=0;
  for(const image of page.images){const stored=assets.get(image.sha256);if(!stored||!page.expectedImageUrls.includes(image.url)||pageImages.has(image.url)||image.path!==stored.asset.path||image.byteLength!==stored.asset.byteLength||image.mediaType!==stored.asset.mediaType)throw new Error('PipelineBrowserImageBindingInvalid');total+=image.byteLength;if(total>ACQUISITION_POLICY.encodedOperationBytes)throw new Error('PipelineBrowserImageBytesInvalid');pageImages.set(image.url,stored.image);const ref=references.get(image.sha256);ref.sourceUrls.add(image.url);ref.pageUrls.add(page.responseUrl);imageCount++;}
  if(!sameSet([...pageImages.keys()],page.expectedImageUrls))throw new Error('PipelineBrowserImageBindingInvalid');lookup.set(captured.sourceUrl,pageImages);
 }
 for(const [digest,{asset}]of assets){const ref=references.get(digest);if(!sameSet(asset.sourceUrls,[...ref.sourceUrls])||!sameSet(asset.pageUrls,[...ref.pageUrls]))throw new Error('PipelineBrowserImageBindingInvalid');}
 return Object.freeze({pageCount:6,imageCount,assetCount:assets.size,evidenceBindings:Object.freeze(evidenceBindings),get(pageUrl,imageUrl){const image=lookup.get(pageUrl)?.get(imageUrl);return image?{bytes:image.bytes.slice(),mediaType:image.mediaType}:undefined;}});
}

export async function seedIsolatedPreferences({db,database,ownerId,sourceUrl,preferences,now,logger,authorizationAt=now()}){
 const sourceId='isolated-less-often-fixture',runId='isolated-preference-fixture';
 db.prepare('INSERT OR IGNORE INTO library_sources(owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(ownerId,sourceId,sourceUrl+'#isolated-preferences',sourceUrl+'#isolated-preferences','Isolated see-less preferences','User-selected test preferences, not extracted source knowledge',JSON.stringify({id:'website',version:'isolated-capture-replay-v1',granularity:'page',capabilities:[]}),'[]','active',now(),now(),1);
 const repository=new D1KnowledgeWorkflowRepository({database,logger}),service=createKnowledgeWorkflowService(repository,{now,createId:()=>runId,logger});
 const priorRun=unwrap(await repository.findById(ownerId,runId));authorizationAt=priorRun?.userAuthorization?.recordedAt??authorizationAt;
 unwrap(await service.createRun({ownerId,sourceId,sourceRevision:1,canonicalSourceIdentity:sourceUrl+'#isolated-preferences',contentSignature:'isolated-preferences-v1',idempotencyKey:runId,configDigests:{},userAuthorization:{kind:'user-authorized-link',ownerId,sourceId,sourceRevision:1,url:sourceUrl+'#isolated-preferences',recordedAt:authorizationAt}}));
 const content=new D1KnowledgeContentRepository({database,logger});
 for(const pref of preferences.lessOften){const point={id:pref.id,sourceId,sourceRevision:1,summary:pref.summary,normalizedHash:pref.id,evidenceAnchors:[{url:sourceUrl,selector:'isolated-user-preference'}],coverageGoalIds:[],mediaCandidates:[],attribution:{sourceUrl},extractionVersion:'isolated-preference-fixture-v1'};unwrap(await content.appendKnowledgePoint(point,ownerId,runId,now()));db.prepare('INSERT OR IGNORE INTO learner_preference_feedback VALUES(?,?,?,?,?)').run(ownerId,pref.id,-1,'less',now());}
 db.prepare("INSERT OR IGNORE INTO source_classifications(owner_id,source_id,source_revision,main_subject,topic,classification_revision,origin,status,legacy_audit_json,updated_at)VALUES(?,?,1,'music','Isolated music preferences',1,'manual','classified','[]',?)").run(ownerId,sourceId,now());
 db.prepare("UPDATE library_sources SET state='disabled' WHERE owner_id=? AND source_id=?").run(ownerId,sourceId);
}

export async function sourceBindings(root,entry,seen=new Map()){
 if(seen.has(entry))return seen;const bytes=await readFile(resolve(root,entry));seen.set(entry,hash(bytes));
 for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)){if(!match[1].startsWith('.'))continue;const target=resolve(root,dirname(entry),match[1]);if(!target.startsWith(root+sep))throw new Error('PipelineSourceBindingOutsideRoot');await sourceBindings(root,target.slice(root.length+1),seen);}
 return seen;
}

export async function prepareSixPagePipeline({directory=defaultDirectory,ownerAuthorizationPath}){
 if(!ownerAuthorizationPath)throw new Error('PipelineOwnerAuthorizationRequired');const ownerAuthorizationBytes=await readFile(ownerAuthorizationPath),ownerAuthorization=JSON.parse(ownerAuthorizationBytes);if(ownerAuthorization.ownerAuthorized!==true||typeof ownerAuthorization.source!=='string'||!ownerAuthorization.source.trim())throw new Error('PipelineOwnerAuthorizationInvalid');
 await mkdir(resolve(directory,'captures'),{recursive:true});
 const state=await json(resolve(navigationDirectory,'live-state.json')),reviewPath=resolve(navigationDirectory,'inventory-review.json'),review=await json(reviewPath),captures=[];
 if(navigationInventoryDigest(state.plan)!==review.inventoryDigest||state.processedPages.length<6)throw new Error('PipelineSixPagePrefixUnavailable');
 for(let i=0;i<6;i++){const raw=await readFile(resolve(navigationDirectory,`live-page-${String(i+1).padStart(3,'0')}.json`)),sha256=hash(raw),path=resolve(directory,'captures',sha256+'.json');if(!existsSync(path))await writeFile(path,raw,{flag:'wx',mode:0o600});captures.push({path,sha256,url:state.plan.lessonUrls[i]});}
 const reviewBytes=await readFile(reviewPath),stateBytes=await readFile(resolve(navigationDirectory,'live-state.json')),inventoryReviewPath=resolve(directory,'captures','inventory-review-'+hash(reviewBytes)+'.json'),navigationStatePath=resolve(directory,'captures','navigation-state-'+hash(stateBytes)+'.json');if(!existsSync(inventoryReviewPath))await writeFile(inventoryReviewPath,reviewBytes,{flag:'wx'});if(!existsSync(navigationStatePath))await writeFile(navigationStatePath,stateBytes,{flag:'wx'});
 const manifest={version:'openlearn-six-capture-manifest-v1',inventoryDigest:review.inventoryDigest,inventoryReviewPath,inventoryReviewSha256:hash(reviewBytes),navigationStatePath,navigationStateSha256:hash(stateBytes),sourceRootUrl:state.plan.sourceRootUrl,captures};const manifestPath=resolve(directory,'capture-manifest.json');await save(manifestPath,manifest);const manifestSha256=hash(await readFile(manifestPath));const loadedManifest=await loadSixCaptureManifest(manifestPath,manifestSha256);
 let browserImages=null;const browserImagePath=resolve(projectRoot,'output/playwright/openlearn-browser-images/capture-result.json');if(existsSync(browserImagePath)){browserImages={path:browserImagePath,sha256:hash(await readFile(browserImagePath))};browserImages.evidenceBindings=(await loadCapturedBrowserImages(browserImages.path,browserImages.sha256,loadedManifest.captures)).evidenceBindings;}
 const response=await fetch('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('PipelineModelCatalogUnavailable');const catalogBytes=new Uint8Array(await response.arrayBuffer()),catalog=JSON.parse(new TextDecoder().decode(catalogBytes)),catalogs={};await writeFile(resolve(directory,'model-catalog.json'),catalogBytes);
 for(const id of PIPELINE_MODELS){const model=catalog.data.find(model=>model.id===id);if(!model||!model.architecture?.input_modalities?.includes('image'))throw new Error('PipelineConfiguredVisionModelUnsupported:'+id);catalogs[id]={source:'https://openrouter.ai/api/v1/models',retrievedAt:new Date().toISOString(),catalogSha256:hash(catalogBytes),model};pipelineProtocol(catalogs[id],id===PIPELINE_MODELS[1]?'question-evaluator':'knowledge-scraper');}
 const navigationContract=await json(resolve(navigationDirectory,'live-contract.json')),priorAccounting=readNavigationAccounting(navigationContract.storePath);
 const bindings=await sourceBindings(projectRoot,'scripts/openlearn-six-page-pipeline.mjs');for(const role of ['rights-assessor','knowledge-scraper','question-generator','question-evaluator'])bindings.set('agent-config/'+role+'.yaml',hash(await readFile(resolve(projectRoot,'agent-config',role+'.yaml'))));for(const name of (await readdir(resolve(projectRoot,'worker/migrations'))).filter(n=>n.endsWith('.sql')))bindings.set('worker/migrations/'+name,hash(await readFile(resolve(projectRoot,'worker/migrations',name))));
 let ownerCostAssumption=null,evaluatorConfigRefresh=null;
 const assumptionPath=resolve(directory,'timeout-cost-assumption.json');
 if(existsSync(assumptionPath)){
  const assumptionBytes=await readFile(assumptionPath),assumptionSha256=hash(assumptionBytes),previousContractPath=resolve(directory,'pipeline-contract.json'),previousContract=existsSync(previousContractPath)?await json(previousContractPath):null;
  if(previousContract?.ownerCostAssumption?.sha256===assumptionSha256)ownerCostAssumption=previousContract.ownerCostAssumption;
  else{const resultBytes=await readFile(resolve(directory,'pipeline-result.json')),traceBytes=await readFile(resolve(directory,'pipeline-trace.jsonl')),resultPath=resolve(directory,'pipeline-result-'+hash(resultBytes)+'.json'),tracePath=resolve(directory,'pipeline-trace-'+hash(traceBytes)+'.jsonl');if(!existsSync(resultPath)||!existsSync(tracePath))throw new Error('PipelineHistoricalCleanupEvidenceMissing');ownerCostAssumption={path:assumptionPath,sha256:assumptionSha256,resultPath,resultSha256:hash(resultBytes),tracePath,traceSha256:hash(traceBytes)};}
  const applicationPath=resolve(directory,'application.sqlite');if(existsSync(applicationPath)){
   const application=new DatabaseSync(applicationPath,{readOnly:true});let priorRun;try{const row=application.prepare('SELECT run_json FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=?').get(pipelineIdentity.ownerId,pipelineIdentity.runId);priorRun=row?JSON.parse(row.run_json):null;}finally{application.close();}
   const loader=createAgentConfigurationLoader({sha256:async text=>'sha256:'+hash(text)}),nextEvaluator=unwrap(await loader.load({source:await readFile(resolve(projectRoot,'agent-config/question-evaluator.yaml'),'utf8'),expectedRole:'question-evaluator'}));
   if(priorRun&&priorRun.configDigests['question-evaluator']!==nextEvaluator.digest){
    if(previousContract?.evaluatorConfigRefresh?.previousDigest===priorRun.configDigests['question-evaluator'])evaluatorConfigRefresh=previousContract.evaluatorConfigRefresh;
    else{const previousSnapshot=await json(resolve(directory,'snapshot-result.json')),path=resolve(previousSnapshot.path,'files/agent-config/question-evaluator.yaml'),bytes=await readFile(path),previousEvaluator=unwrap(await loader.load({source:bytes.toString(),expectedRole:'question-evaluator',expectedDigest:priorRun.configDigests['question-evaluator']}));evaluatorConfigRefresh={previousSnapshotDigest:previousSnapshot.digest,path,sha256:hash(bytes),previousDigest:previousEvaluator.digest};}
   }
  }
 }
 let failedReviewCostPolicy=null;const reviewPolicyPath=resolve(directory,'owner-failed-review-cost-policy.json');
 if(existsSync(reviewPolicyPath)){
  const bytes=await readFile(reviewPolicyPath),authority=JSON.parse(bytes),sha256=hash(bytes),previousPath=resolve(directory,'pipeline-contract.json'),previous=existsSync(previousPath)?await json(previousPath):null;
  if(authority.version!=='owner-failed-review-cost-policy-v1'||authority.ownerAuthorized!==true||authority.historicalStage?.ownerId!==pipelineIdentity.ownerId||authority.historicalStage?.runId!==pipelineIdentity.runId)throw new Error('PipelineFailedReviewPolicyInvalid');
  if(previous?.failedReviewCostPolicy?.sha256===sha256)failedReviewCostPolicy=previous.failedReviewCostPolicy;
  else{const resultBytes=await readFile(resolve(directory,'pipeline-result.json')),traceBytes=await readFile(resolve(directory,'pipeline-trace.jsonl')),resultPath=resolve(directory,'pipeline-result-'+hash(resultBytes)+'.json'),tracePath=resolve(directory,'pipeline-trace-'+hash(traceBytes)+'.jsonl');if(!existsSync(resultPath)||!existsSync(tracePath))throw new Error('PipelineHistoricalCleanupEvidenceMissing');failedReviewCostPolicy={path:reviewPolicyPath,sha256,resultPath,resultSha256:hash(resultBytes),tracePath,traceSha256:hash(traceBytes),historicalStage:authority.historicalStage};}
 }
 const preferencePath=resolve(navigationDirectory,'less-often.json');const contract={version:'openlearn-six-page-pipeline-v1',...(browserImages?{browserImages}:{}),ownerCostAssumption,evaluatorConfigRefresh,failedReviewCostPolicy,ownerAuthorization,ownerAuthorizationPath:resolve(ownerAuthorizationPath),ownerAuthorizationSha256:hash(ownerAuthorizationBytes),directory:resolve(directory),identity:pipelineIdentity,manifestPath,manifestSha256,preferencesPath:preferencePath,preferencesSha256:hash(await readFile(preferencePath)),priorStorePath:navigationContract.storePath,priorAccounting,catalogs,sourceUrl:captures[0].url,requestedSourceUrl:navigationContract.sourceUrl,sourceRootUrl:state.plan.sourceRootUrl,limits:{cumulativeModelCostNanodollars:1000000000,cumulativeBrowserCredits:100,maximumMilliseconds:1800000},sourceBindings:[...bindings].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256})),preparedAt:new Date().toISOString(),applicationStorePath:resolve(directory,'application.sqlite'),budgetStorePath:resolve(directory,'pipeline-budget.sqlite'),objectDirectory:resolve(directory,'objects')};for(const name of ['pipeline-contract.json','pipeline-gate.json']){const path=resolve(directory,name);if(existsSync(path)){const prior=await readFile(path),archive=resolve(directory,name.replace('.json','-')+hash(prior)+'.json');if(!existsSync(archive))await writeFile(archive,prior,{flag:'wx',mode:0o600});}}await save(resolve(directory,'pipeline-contract.json'),contract);return contract;
}

async function createPixelRuntime(){
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}),context=await browser.newContext();await context.route('**/*',route=>route.abort());const page=await context.newPage();
 const process=async(bytes,mediaType,resize)=>page.evaluate(async({base64,mediaType,resize})=>{let image;try{image=await createImageBitmap(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:mediaType}));const scale=Math.min(1,1600/image.width,1200/image.height),canvas=new OffscreenCanvas(resize?Math.max(1,Math.round(image.width*scale)):image.width,resize?Math.max(1,Math.round(image.height*scale)):image.height),ctx=canvas.getContext('2d');if(!ctx)throw new Error('ImageCanvasUnavailable');ctx.drawImage(image,0,0,canvas.width,canvas.height);if(!resize)return {ok:true};const output=new Uint8Array(await(await canvas.convertToBlob({type:'image/webp',quality:0.82})).arrayBuffer());return {ok:true,bytes:Array.from(output)};}catch{return {ok:false};}finally{image?.close();}},{base64:Buffer.from(bytes).toString('base64'),mediaType,resize});
 return {close:()=>browser.close(),decode:async(bytes,type)=>{const result=await process(bytes,type,false);return result.ok?ok(null):fail('UploadedImageDecodeFailed');},derivative:async({bytes,mediaType})=>{const result=await process(bytes,mediaType,true);return result.ok?ok({bytes:Uint8Array.from(result.bytes),mediaType:'image/webp'}):fail('MediaDerivativeProcessingFailed');}};
}

function readPinnedImage(url,addresses,signal,maximumBytes){
 return new Promise((resolve,reject)=>{
  const request=httpsRequest(url,{method:'GET',signal,lookup:(_host,options,callback)=>options.all?callback(null,addresses):callback(null,addresses[0].address,addresses[0].family)},response=>{
   (async()=>{
    const headers=new Headers();for(const [key,value]of Object.entries(response.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
    if(response.statusCode>=300&&response.statusCode<400){response.destroy();return resolve({status:response.statusCode,headers,bytes:null});}
    const chunks=[];let size=0;for await(const chunk of response){size+=chunk.length;if(size>maximumBytes){response.destroy();throw new Error('MediaPublicEgressPayloadTooLarge');}chunks.push(chunk);}
    resolve({status:response.statusCode,headers,bytes:Buffer.concat(chunks,size)});
   })().catch(reject);
  });request.once('error',reject);request.end();
 });
}
function createCapturedMediaEgress(captures){
 const allowed=new Set(captures.flatMap(c=>c.evidence.images.map(i=>i.url)));
 return {async fetch(request,{maximumBytes=2097152}={}){
  if(!allowed.has(request.url)||request.method!=='GET')return fail('MediaPublicEgressFailed');let url=request.url;
  try{for(let redirects=0;redirects<=5;redirects++){
   const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port)return fail('MediaPublicEgressRedirectUnsafe');
   const addresses=await lookup(parsed.hostname,{all:true});if(!addresses.length||addresses.some(a=>isForbiddenAddress(a.address)))return fail('MediaPublicEgressPrivateAddress');
   // Bind the validated resolution to the HTTPS socket; retain TLS hostname verification.
   const response=await readPinnedImage(url,addresses,request.signal,maximumBytes);
   if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location)return fail('MediaPublicEgressRedirectUnsafe');url=new URL(location,url).href;if(new URL(url).origin!==new URL(request.url).origin)return fail('MediaPublicEgressRedirectUnsafe');continue;}
   return ok(new Response(response.bytes,{status:response.status,headers:response.headers}));
  }return fail('MediaPublicEgressRedirectLimitExceeded');}catch(error){return fail(error instanceof Error&&error.message==='MediaPublicEgressPayloadTooLarge'?error.message:'MediaPublicEgressFailed');}
 }};
}

export async function saveApplicationProjections({db,contract}){
 const database=createD1Port(db),bucket=createFileBucket(contract.objectDirectory),now=()=>new Date().toISOString(),logger=()=>{},repository=new D1KnowledgeWorkflowRepository({database,logger}),learning=createLearningBatchService({database,now,logger,bucket}),{ownerId,sourceId,runId}=contract.identity;
 await save(resolve(contract.directory,'application-projections.json'),{workflow:await repository.findById(ownerId,runId),knowledge:await learning.listKnowledge(ownerId,sourceId),feed:await learning.loadFeed(ownerId,now().slice(0,10)),review:await learning.loadReview(ownerId,now().slice(0,10)),points:db.prepare('SELECT point_json FROM extraction_knowledge_points WHERE owner_id=? AND run_id=?').all(ownerId,runId).map(row=>JSON.parse(row.point_json)),quizzes:db.prepare('SELECT draft_json FROM knowledge_workflow_quizzes WHERE owner_id=? AND run_id=?').all(ownerId,runId).map(row=>JSON.parse(row.draft_json)),media:db.prepare('SELECT asset_id,binding_json,attribution FROM knowledge_workflow_media_assets WHERE owner_id=? AND run_id=?').all(ownerId,runId)});
}

// Match the production entry's automatic bounded extraction continuation.
// The persisted deadline and cumulative progress survive every chunk.
export async function executeSixCaptureChunks({run,runtime,service,now,log}){
 let current=run;
 for(;;){
  const executed=await runtime.execute(current);if(!executed.ok)return executed;
  const result=executed.value,chunkRun=result?.run;
  if(result?.state!=='awaiting-time-limit-decision'||typeof chunkRun?.extractionDeadlineAt!=='string'||!Number.isFinite(Date.parse(chunkRun.extractionDeadlineAt))||!Number.isFinite(Date.parse(now()))||Date.parse(now())>=Date.parse(chunkRun.extractionDeadlineAt))return executed;
  if(!Number.isSafeInteger(chunkRun.counts?.pages)||chunkRun.counts.pages<=current.counts.pages)return fail('PipelineExtractionContinuationNoProgress');
  const continued=await service.advance({ownerId:chunkRun.ownerId,runId:chunkRun.runId,expectedRevision:chunkRun.revision,nextState:'extraction-loop'});if(!continued.ok)return continued;
  await log({phase:'pipeline-extraction-chunk-continued',runId:chunkRun.runId,revision:continued.value.revision,counts:continued.value.counts,extractionStartedAt:continued.value.extractionStartedAt,extractionDeadlineAt:continued.value.extractionDeadlineAt});
  const latest=await service.status({ownerId:chunkRun.ownerId,runId:chunkRun.runId});if(!latest.ok)return latest;
  if(latest.value.state!=='extraction-loop')return ok({state:latest.value.state,run:latest.value});
  current=latest.value;
 }
}

export async function persistPipelineFailure({service,ownerId,runId,outcome,log}){
 if(outcome?.ok!==false)return null;
 const latest=await service.status({ownerId,runId});if(!latest.ok)throw new Error(latest.error.kind);
 if(latest.value.state==='retryable-failure'||!isWorkflowRetryStage(latest.value.state))return latest.value;
 const failureKind=outcome.error.detailKind??outcome.error.kind;
 const persisted=await service.advance({ownerId,runId,expectedRevision:latest.value.revision,nextState:'retryable-failure',failureKind});if(!persisted.ok)throw new Error(persisted.error.kind);
 await log({phase:'pipeline-retryable-failure-persisted',runId,revision:persisted.value.revision,failureKind});return persisted.value;
}

// Isolated trusted composition: authenticated failed-review reservations may
// create new stage attempts; application history and successful caches stay put.
export function createFailedReviewRecoveryHooks({db,budget,identity,log=async()=>{}}){
 const matches=stage=>stage.ownerId===identity.ownerId&&stage.runId===identity.runId;
 async function authorize(stage){
  if(!matches(stage)||!['question-evaluator:','knowledge-scraper:','question-generator:','rights-assessor:'].some(prefix=>stage.stageKey.startsWith(prefix)))return null;
  const row=db.prepare('SELECT * FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND stage_key=?').get(stage.ownerId,stage.runId,stage.stageKey);
  if(!row||row.input_digest!==stage.inputDigest||row.created_at!==stage.createdAt||!['claimed','completed'].includes(row.status))return null;
  const result=row.result_json===null?null:JSON.parse(row.result_json);
  if(row.status==='completed'&&!(result?.ok===false&&result.error?.kind==='WorkflowAgentAgentOutputInvalid'))return null;
  const flat={ownerId:stage.ownerId,runId:stage.runId,stageKey:stage.stageKey,inputDigest:stage.inputDigest,createdAt:stage.createdAt};
  const unrestrictedProof=await budget.authorizeModelStageRecovery?.({...flat,status:row.status,result_json:row.result_json,completedAt:row.completed_at});
  if(unrestrictedProof?.identity){
   if(!['ownerId','runId','stageKey','inputDigest','createdAt'].every(key=>unrestrictedProof.identity?.[key]===flat[key])||unrestrictedProof.attemptKey!==hash(JSON.stringify({authorizationSha256:unrestrictedProof.authorizationSha256,identity:flat})))throw Error('PipelineModelRecoveryProofInvalid');
   const audit={version:'owner-price-policy-stage-recovery-v1',originalStage:row,proof:unrestrictedProof},bytes=JSON.stringify(audit),digest=hash(bytes);
   db.exec("CREATE TABLE IF NOT EXISTS pipeline_price_policy_stage_recoveries(audit_sha256 TEXT PRIMARY KEY,audit_json TEXT NOT NULL);CREATE TRIGGER IF NOT EXISTS pipeline_price_policy_stage_recoveries_immutable BEFORE UPDATE ON pipeline_price_policy_stage_recoveries BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER IF NOT EXISTS pipeline_price_policy_stage_recoveries_no_delete BEFORE DELETE ON pipeline_price_policy_stage_recoveries BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;");
   db.prepare('INSERT OR IGNORE INTO pipeline_price_policy_stage_recoveries VALUES(?,?)').run(digest,bytes);
   await log({phase:'pipeline-price-policy-stage-recovery',stageKey:flat.stageKey,attemptKey:unrestrictedProof.attemptKey,auditSha256:digest});return unrestrictedProof;
  }
  if(stage.stageKey.startsWith('knowledge-scraper:')){
   if(row.status!=='claimed'||row.result_json!==null||row.completed_at!==null)return null;
   const proof=await budget.authorizeScraperStageRecovery?.({...flat,status:row.status,result_json:row.result_json,completedAt:row.completed_at});if(!proof)return null;
   if(!['ownerId','runId','stageKey','inputDigest','createdAt'].every(key=>proof.identity?.[key]===flat[key])||proof.attemptKey!==hash(JSON.stringify({authorizationSha256:proof.authorizationSha256,identity:flat})))throw Error('PipelineScraperRecoveryProofInvalid');
   // Authenticate all owner journals so later grants do not hide an older
   // successful child. The existing stage repository retains retry limits.
   const recover=createContinuationRecovery({db,authority:{version:'owner-full-reserve-recovery-v1',ownerAuthorized:true,role:'knowledge-scraper',identity:proof.identity,reservationKey:proof.reservationKey,retainedReservationNanodollars:proof.retainedReservationNanodollars},authorizationSha256:proof.authorizationSha256,log});
   const recovered=await recover({scope:{ownerId:flat.ownerId,runId:flat.runId},key:flat.stageKey,inputDigest:flat.inputDigest,createdAt:flat.createdAt,status:row.status,result,completedAt:row.completed_at});return recovered?proof:null;
  }
  const proof=await budget.authorizeReviewStageRecovery({...flat,status:row.status,result_json:row.result_json,completedAt:row.completed_at});if(!proof)return null;
  const audit={version:'isolated-failed-review-stage-recovery-v1',originalStage:row,proof},bytes=JSON.stringify(audit),digest=hash(bytes);
  db.exec("CREATE TABLE IF NOT EXISTS pipeline_review_stage_recoveries(audit_sha256 TEXT PRIMARY KEY,audit_json TEXT NOT NULL);CREATE TRIGGER IF NOT EXISTS pipeline_review_stage_recoveries_immutable BEFORE UPDATE ON pipeline_review_stage_recoveries BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER IF NOT EXISTS pipeline_review_stage_recoveries_no_delete BEFORE DELETE ON pipeline_review_stage_recoveries BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;");
  db.prepare('INSERT OR IGNORE INTO pipeline_review_stage_recoveries VALUES(?,?)').run(digest,bytes);
  await log({phase:'pipeline-failed-review-stage-authorized',runId:stage.runId,stageKey:stage.stageKey,inputDigest:stage.inputDigest,reservationKey:proof.reservationKey,authorizationSha256:proof.authorizationSha256,auditSha256:digest});return proof;
 }
 return {
  preflightModelWork(role,stage){if(!matches(stage))throw new Error('PipelineModelStageIdentityInvalid');budget.bindModelStage(role,stage);},
  async authorizeFailedReviewCall(stage){const proof=await authorize({ownerId:stage.scope.ownerId,runId:stage.scope.runId,stageKey:stage.key,inputDigest:stage.inputDigest,createdAt:stage.createdAt});return proof?{attemptKey:proof.attemptKey}:null;},
  recoveryForStage:authorize,
 };
}

// The owner closed one uncertain scraper call at its full reserved cost.
export function createContinuationRecovery({db,authority,authorizationSha256,log=async()=>{}}){
 const fields=['ownerId','runId','stageKey','inputDigest','createdAt'];
 return async stage=>{
  const identity={ownerId:stage.scope.ownerId,runId:stage.scope.runId,stageKey:stage.key,inputDigest:stage.inputDigest,createdAt:stage.createdAt};
  if(!['owner-full-reserve-continuation-v1','owner-full-reserve-recovery-v1'].includes(authority.version)||authority.ownerAuthorized!==true||authority.role!=='knowledge-scraper'||!fields.every(key=>identity[key]===authority.identity?.[key])||stage.status!=='claimed'||stage.result!==null)return null;
  const original=db.prepare('SELECT * FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND stage_key=?').get(identity.ownerId,identity.runId,identity.stageKey);
  if(!original||original.status!=='claimed'||original.result_json!==null||original.input_digest!==identity.inputDigest||original.created_at!==identity.createdAt)return null;
  const attemptKey=hash(JSON.stringify({authorizationSha256,identity})),audit={authorizationSha256,reservationKey:authority.reservationKey,retainedReservationNanodollars:authority.retainedReservationNanodollars,originalStage:original,attemptKey},raw=JSON.stringify(audit),digest=hash(raw);
  db.exec("CREATE TABLE IF NOT EXISTS pipeline_model_stage_recoveries(audit_sha256 TEXT PRIMARY KEY,audit_json TEXT NOT NULL);CREATE TRIGGER IF NOT EXISTS pipeline_model_stage_recoveries_immutable BEFORE UPDATE ON pipeline_model_stage_recoveries BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER IF NOT EXISTS pipeline_model_stage_recoveries_no_delete BEFORE DELETE ON pipeline_model_stage_recoveries BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;");
  db.prepare('INSERT OR IGNORE INTO pipeline_model_stage_recoveries VALUES(?,?)').run(digest,raw);
  await log({phase:'pipeline-full-reserve-stage-recovery',stageKey:identity.stageKey,attemptKey,auditSha256:digest});return {attemptKey};
 };
}

export async function extendContinuationDeadline({db,repository,run,authority,authorizationSha256,now,log=async()=>{}}){
 const auditId=hash(JSON.stringify({authorizationSha256,runId:run.runId}));
 db.exec("CREATE TABLE IF NOT EXISTS pipeline_execution_grants(audit_sha256 TEXT PRIMARY KEY,audit_json TEXT NOT NULL);CREATE TRIGGER IF NOT EXISTS pipeline_execution_grants_immutable BEFORE UPDATE ON pipeline_execution_grants BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER IF NOT EXISTS pipeline_execution_grants_no_delete BEFORE DELETE ON pipeline_execution_grants BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;");
 const prior=db.prepare('SELECT audit_json FROM pipeline_execution_grants WHERE audit_sha256=?').get(auditId);
 if(prior){const audit=JSON.parse(prior.audit_json);if(run.extractionDeadlineAt!==audit.after.extractionDeadlineAt)throw Error('PipelineContinuationDeadlineChanged');return run;}
 const authorizedVersion=authority.version==='owner-full-reserve-continuation-v1'||(authority.version==='owner-full-reserve-recovery-v1'&&authority.source==='Retain reserve and add 30 minutes');
 if(!authorizedVersion||authority.ownerAuthorized!==true||authority.additionalMilliseconds!==1800000||run.ownerId!==authority.identity?.ownerId||run.runId!==authority.identity?.runId||run.state!=='retryable-failure'||typeof run.extractionDeadlineAt!=='string')throw Error('PipelineContinuationDeadlineUnauthorized');
 const next={...run,revision:run.revision+1,updatedAt:now(),extractionDeadlineAt:new Date(Date.parse(run.extractionDeadlineAt)+authority.additionalMilliseconds).toISOString()},audit={authorizationSha256,before:run,after:next};
 db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO pipeline_execution_grants VALUES(?,?)').run(auditId,JSON.stringify(audit));unwrap(await repository.update({ownerId:run.ownerId,runId:run.runId,expectedRevision:run.revision,next}));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
 await log({phase:'pipeline-finite-execution-grant',runId:run.runId,additionalMilliseconds:authority.additionalMilliseconds,previousDeadline:run.extractionDeadlineAt,extractionDeadlineAt:next.extractionDeadlineAt,auditSha256:auditId});return next;
}

// Repair only observed false-empty completions in an isolated copied checkpoint.
export function reopenEmptyPageCheckpoints({db,identity,captures,urls}){
 if(!Array.isArray(urls)||!urls.length||new Set(urls).size!==urls.length)throw Error('PipelineEmptyPageRepairInvalid');
 const row=db.prepare('SELECT * FROM extraction_scratchpads WHERE owner_id=? AND run_id=?').get(identity.ownerId,identity.runId);if(!row)throw Error('PipelineEmptyPageRepairInvalid');
 const before=JSON.parse(row.scratchpad_json),removedDigests=[];
 for(const url of urls){
  const capture=captures.find(c=>c.sourceUrl===url),note=before.pageNotes?.find(n=>n.url===url);
  if(!capture||!before.processedUrls.includes(url)||!note||note.candidateCount!==0)throw Error('PipelineEmptyPageRepairInvalid');
  const e=capture.evidence,digest='sha256:'+hash(JSON.stringify({blocks:e.blocks.map(b=>({kind:b.kind,text:b.text})),headings:e.headings.map(h=>({level:h.level,text:h.text})),images:e.images.map(i=>({url:i.url,alt:i.occurrences.map(o=>o.alt)}))}));
  if(!before.processedContentDigests.includes(digest)||!before.processedResponseUrls.includes(capture.responseUrl))throw Error('PipelineEmptyPageRepairInvalid');
  removedDigests.push(digest);
 }
 const responses=captures.filter(c=>urls.includes(c.sourceUrl)).map(c=>c.responseUrl);
 const after={...before,processedUrls:before.processedUrls.filter(u=>!urls.includes(u)),processedResponseUrls:before.processedResponseUrls.filter(u=>!responses.includes(u)),processedContentDigests:before.processedContentDigests.filter(d=>!removedDigests.includes(d)),frontier:captures.map(c=>c.sourceUrl).filter(u=>!before.processedUrls.includes(u)||urls.includes(u)),consecutiveNoveltyZero:0,revision:before.revision+1};
 const audit={version:'openlearn-empty-page-repair-v1',identity,urls,before,after,preservesAcceptedKnowledge:true,preservesHistoricalObservations:true},raw=JSON.stringify(audit),digest=hash(raw);
 db.exec('BEGIN IMMEDIATE');try{
  db.exec("CREATE TABLE IF NOT EXISTS pipeline_empty_page_repairs(audit_sha256 TEXT PRIMARY KEY,audit_json TEXT NOT NULL);CREATE TRIGGER IF NOT EXISTS pipeline_empty_page_repairs_immutable BEFORE UPDATE ON pipeline_empty_page_repairs BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;CREATE TRIGGER IF NOT EXISTS pipeline_empty_page_repairs_no_delete BEFORE DELETE ON pipeline_empty_page_repairs BEGIN SELECT RAISE(ABORT,'PipelineHistoryImmutable');END;");
  db.prepare('INSERT INTO pipeline_empty_page_repairs VALUES(?,?)').run(digest,raw);
  const changed=db.prepare('UPDATE extraction_scratchpads SET scratchpad_json=?,revision=? WHERE owner_id=? AND run_id=? AND revision=?').run(JSON.stringify(after),after.revision,identity.ownerId,identity.runId,row.revision);if(changed.changes!==1)throw Error('PipelineEmptyPageRepairConflict');
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return {auditSha256:digest,...audit};
}


// Retry only authenticated, physically finished model failures; native stage
// attempt counters and the original execution clock remain authoritative.
export async function executePipelineModelRetries({run,runtime,service,now,log,authorize,remainingMilliseconds}){
 const retried=new Set();let current=run;
 for(;;){
  let outcome;try{outcome=await executeSixCaptureChunks({run:current,runtime,service,now,log});}catch(error){if(!(error instanceof AgentExecutionBoundaryFailure))throw error;outcome={ok:false,error:error.failure};}
  const failed=await persistPipelineFailure({service,ownerId:current.ownerId,runId:current.runId,outcome,log});
  if(outcome.ok||!authorize||failed?.state!=='retryable-failure'||remainingMilliseconds()<=0||outcome.error.kind==='WorkflowStageProviderRetryLimitReached')return outcome;
  const proof=await authorize();if(!proof||retried.has(proof.reservationKey))return outcome;
  retried.add(proof.reservationKey);
  if(proof.retryAtMs!==undefined&&!await waitForReviewRetryAfter({proof,remainingMilliseconds:remainingMilliseconds(),log}))return outcome;
  current=unwrap(await service.control({ownerId:failed.ownerId,runId:failed.runId,expectedRevision:failed.revision,action:'resume',idempotencyKey:'price-policy-retry:'+proof.reservationKey}));
  await log({phase:'pipeline-model-retry-resumed',reservationKey:proof.reservationKey,state:current.state,revision:current.revision});
 }
}

export async function executeAuthorizedReviewRetries(execute){
 const retried=new Set();
 for(;;){const report=await execute(),proof=report?.reviewRecovery;if(!proof||report.outcome?.ok!==false||report.cleanup?.ok!==true||report.preparationPauseAcknowledged!==true||report.accounting?.remainingMilliseconds<=0)return report;
  if(typeof proof.reservationKey!=='string'||retried.has(proof.reservationKey))throw new Error('PipelineReviewRecoveryRepeated');
  retried.add(proof.reservationKey);
 }
}

// Provider-directed waiting belongs to the active execution window. Wait before
// saving the cleanup proof/pause, never extend the original clock for backoff.
export async function waitForReviewRetryAfter({proof,remainingMilliseconds,now=Date.now,sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)),log=async()=>{}}){
 const retryAtMs=proof?.retryAtMs;
 if(!Number.isSafeInteger(retryAtMs)||!Number.isSafeInteger(remainingMilliseconds)||remainingMilliseconds<=0)return false;
 const delay=Math.max(0,retryAtMs-now());if(delay===0)return true;
 const available=Math.min(delay,remainingMilliseconds);await log({phase:'pipeline-review-retry-after-wait',reservationKey:proof.reservationKey,retryAtMs,waitMilliseconds:available,remainingMilliseconds});
 let left=available;while(left>0){const chunk=Math.min(left,60000);await sleep(chunk);left-=chunk;}
 return delay<remainingMilliseconds;
}

export async function refreshEvaluatorTimeout({db,repository,run,configSnapshots,previousEvaluator,authority,now,log}){
 const configDigests=Object.fromEntries(Object.entries(configSnapshots).map(([role,c])=>[role,c.digest])),changed=Object.keys(configDigests).filter(role=>configDigests[role]!==run.configDigests[role]);
 if(!changed.length)return run;
 const strip=snapshot=>{const copy=structuredClone(snapshot);delete copy.digest;delete copy.canonicalJson;delete copy.id;delete copy.version;delete copy.limits.timeoutMs;return copy;},nextEvaluator=configSnapshots['question-evaluator'];
 if(changed.length!==1||changed[0]!=='question-evaluator'||previousEvaluator?.digest!==run.configDigests['question-evaluator']||previousEvaluator.limits.timeoutMs!==30000||nextEvaluator.limits.timeoutMs!==120000||nextEvaluator.version===previousEvaluator.version||JSON.stringify(strip(previousEvaluator))!==JSON.stringify(strip(nextEvaluator))||authority?.document?.ownerAuthorized!==true||authority.document.version!=='owner-timeout-cost-assumption-v1'||!authority.sha256||run.state!=='retryable-failure')throw new Error('PipelineConfigurationRefreshUnauthorized');
 const next={...run,configDigests,revision:run.revision+1,updatedAt:now()},entry={version:'isolated-evaluator-timeout-refresh-v1',authoritySha256:authority.sha256,costEvidence:'owner-assumption; provider billed cost remains unknown',before:run,after:next},entryJson=JSON.stringify(entry),entrySha256=hash(entryJson);
 db.exec("CREATE TABLE IF NOT EXISTS pipeline_configuration_refreshes(entry_sha256 TEXT PRIMARY KEY,entry_json TEXT NOT NULL);CREATE TRIGGER IF NOT EXISTS pipeline_configuration_refreshes_immutable BEFORE UPDATE ON pipeline_configuration_refreshes BEGIN SELECT RAISE(ABORT,'PipelineConfigurationHistoryImmutable');END;CREATE TRIGGER IF NOT EXISTS pipeline_configuration_refreshes_no_delete BEFORE DELETE ON pipeline_configuration_refreshes BEGIN SELECT RAISE(ABORT,'PipelineConfigurationHistoryImmutable');END;");
 db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO pipeline_configuration_refreshes VALUES(?,?)').run(entrySha256,entryJson);const result=await repository.update({ownerId:run.ownerId,runId:run.runId,expectedRevision:run.revision,next});if(!result.ok)throw new Error(result.error.kind);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
 await log({phase:'pipeline-evaluator-timeout-refreshed',runId:run.runId,revision:next.revision,auditSha256:entrySha256,authoritySha256:authority.sha256});return next;
}

// Authorized offline repair only: no model fetch, browser, image or live-page IO.
export async function repairSixPageCheckpoint(contractPath){
 const contract=await json(contractPath);if(!contract.ownerCostAssumption)throw new Error('PipelineCostAssumptionRequired');
 for(const binding of contract.sourceBindings)if(hash(await readFile(resolve(projectRoot,binding.path)))!==binding.sha256)throw new Error('PipelineSourceBindingChanged');
 await loadSixCaptureManifest(contract.manifestPath,contract.manifestSha256);
 const lock=await open(resolve(contract.directory,'pipeline-run.lock'),'wx');let budget,db;
 try{
  budget=createOpenLearnPipelineBudget({storePath:contract.budgetStorePath,priorStorePath:contract.priorStorePath,priorAccounting:contract.priorAccounting,catalogs:contract.catalogs,ownerCostAssumption:contract.ownerCostAssumption,failedReviewCostPolicy:contract.failedReviewCostPolicy??undefined,fetch:async()=>{throw new Error('PipelineOfflineRepairCannotDispatch');}});db=new DatabaseSync(contract.applicationStorePath);
  const now=()=>new Date(budget.nowMs()).toISOString(),logger=()=>{},database=createD1Port(db),repository=new D1KnowledgeWorkflowRepository({database,logger}),service=createKnowledgeWorkflowService(repository,{now,createId:()=>contract.identity.runId,logger}),{ownerId,runId,sourceId}=contract.identity,log=entry=>appendFile(resolve(contract.directory,'pipeline-recovery-audit.jsonl'),JSON.stringify({at:new Date().toISOString(),...entry})+'\n');
  let run=unwrap(await repository.findById(ownerId,runId));if(!run||run.sourceId!==sourceId||run.sourceRevision!==1||run.contentSignature!==contract.manifestSha256||run.canonicalSourceIdentity!==contract.sourceUrl)throw new Error('PipelinePersistedRunBindingInvalid');
  if(contract.evaluatorConfigRefresh&&run.configDigests['question-evaluator']===contract.evaluatorConfigRefresh.previousDigest){const historical=await json(contract.ownerCostAssumption.resultPath);run=await persistPipelineFailure({service,ownerId,runId,outcome:historical.outcome,log})??run;}
  const configs={},loader=createAgentConfigurationLoader({sha256:async text=>'sha256:'+hash(text)});for(const role of ['rights-assessor','knowledge-scraper','question-generator','question-evaluator'])configs[role]=unwrap(await loader.load({source:await readFile(resolve(projectRoot,'agent-config',role+'.yaml'),'utf8'),expectedRole:role}));
  if(contract.evaluatorConfigRefresh){const binding=contract.evaluatorConfigRefresh,bytes=await readFile(binding.path),authorityBytes=await readFile(contract.ownerCostAssumption.path);if(hash(bytes)!==binding.sha256||hash(authorityBytes)!==contract.ownerCostAssumption.sha256)throw new Error('PipelineRecoveryBindingChanged');const previousEvaluator=unwrap(await loader.load({source:bytes.toString(),expectedRole:'question-evaluator',expectedDigest:binding.previousDigest}));run=await refreshEvaluatorTimeout({db,repository,run,configSnapshots:configs,previousEvaluator,authority:{document:JSON.parse(authorityBytes),sha256:hash(authorityBytes)},now,log});}
  if(Object.entries(configs).some(([role,c])=>run.configDigests[role]!==c.digest))throw new Error('PipelineConfigurationSnapshotInvalid');
  await saveApplicationProjections({db,contract});const result={run,accounting:budget.snapshot()};await save(resolve(contract.directory,'offline-recovery-result.json'),result);return result;
 }finally{try{db?.close();}finally{try{budget?.close();}finally{await lock.close();const {rm}=await import('node:fs/promises');await rm(resolve(contract.directory,'pipeline-run.lock'));}}}
}

export async function runSixPagePipeline(contractPath){
 const contractBytes=await readFile(contractPath),contract=JSON.parse(contractBytes),directory=contract.directory,snapshot=await json(resolve(directory,'snapshot-result.json'));
 if(contract.version!=='openlearn-six-page-pipeline-v1'||fileURLToPath(import.meta.url)!==resolve(snapshot.path,'files/scripts/openlearn-six-page-pipeline.mjs'))throw new Error('PipelineCanonicalSourceRequired');
 for(const binding of contract.sourceBindings)if(hash(await readFile(resolve(snapshot.path,'files',binding.path)))!==binding.sha256)throw new Error('PipelineSourceBindingChanged');
 if(contract.continuation&&(contract.continuation.ownerAuthorized!==true||contract.continuation.externalScoringHasPublicationAuthority!==false||hash(await readFile(contract.continuation.sourcePath))!==contract.continuation.sourceSha256||hash(await readFile(contract.applicationStorePath))!==contract.continuation.checkpointSha256))throw new Error('PipelineContinuationCheckpointChanged');
 if(hash(await readFile(contract.ownerAuthorizationPath))!==contract.ownerAuthorizationSha256||hash(await readFile(contract.preferencesPath))!==contract.preferencesSha256)throw new Error('PipelineAuthorizationOrPreferencesChanged');
 const loaded=await loadSixCaptureManifest(contract.manifestPath,contract.manifestSha256),browserImages=contract.browserImages?await loadCapturedBrowserImages(contract.browserImages.path,contract.browserImages.sha256,loaded.captures):undefined;if(contract.browserImages?.evidenceBindings&&JSON.stringify(browserImages.evidenceBindings)!==JSON.stringify(contract.browserImages.evidenceBindings))throw new Error('PipelineBrowserImageEvidenceChanged');const lock=await open(resolve(directory,'pipeline-run.lock'),'wx');let db,budget,pixels,outcome,failureService,recoveryHooks,lastModelStage,finalReport,cleanup={ok:false};const tracePath=resolve(directory,'pipeline-trace.jsonl');let traceWrites=Promise.resolve();const log=entry=>{traceWrites=traceWrites.then(()=>appendFile(tracePath,JSON.stringify({at:new Date().toISOString(),...entry})+'\n'));void traceWrites.catch(()=>{});return traceWrites;};
 try{
  if(existsSync('.env'))process.loadEnvFile('.env');if(!process.env.OPENROUTER_API_KEY)throw new Error('PipelineModelCredentialMissing');
  budget=createOpenLearnPipelineBudget({storePath:contract.budgetStorePath,priorStorePath:contract.priorStorePath,priorAccounting:contract.priorAccounting,catalogs:contract.catalogs,...(contract.reviewerModel?{evaluatorModel:contract.reviewerModel,automaticReviewerRouting:true}:{}),logger:entry=>{void log(entry);},onResponse:entry=>log({phase:'paid-model-response',...entry}),ownerCostAssumption:contract.ownerCostAssumption??undefined,failedReviewCostPolicy:contract.failedReviewCostPolicy??undefined,ownerContinuation:contract.ownerContinuation??undefined,ownerRecovery:contract.ownerRecovery??undefined,ownerExecutionOverride:contract.ownerExecutionOverride??undefined});
  db=new DatabaseSync(contract.applicationStorePath);for(const name of (await readdir(resolve(snapshot.path,'files/worker/migrations'))).filter(n=>n.endsWith('.sql')).sort()){db.exec('CREATE TABLE IF NOT EXISTS pipeline_migrations(name TEXT PRIMARY KEY)');if(!db.prepare('SELECT name FROM pipeline_migrations WHERE name=?').get(name)){db.exec(await readFile(resolve(snapshot.path,'files/worker/migrations',name),'utf8'));db.prepare('INSERT INTO pipeline_migrations VALUES(?)').run(name);}}
  const database=createD1Port(db),bucket=createFileBucket(contract.objectDirectory),now=()=>new Date(budget.nowMs()).toISOString(),logger=entry=>{void log(entry);},repository=new D1KnowledgeWorkflowRepository({database,logger}),service=createKnowledgeWorkflowService(repository,{now,createId:()=>contract.identity.runId,logger});
  const configs={},loader=createAgentConfigurationLoader({sha256:async text=>'sha256:'+hash(text)});for(const role of ['rights-assessor','knowledge-scraper','question-generator','question-evaluator'])configs[role]=unwrap(await loader.load({source:await readFile(resolve(snapshot.path,'files/agent-config',role+'.yaml'),'utf8'),expectedRole:role}));
  const {ownerId,sourceId,runId}=contract.identity;
  db.prepare('INSERT OR IGNORE INTO library_sources(owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(ownerId,sourceId,contract.requestedSourceUrl,contract.sourceUrl,'An introduction to music theory','Actual isolated six-page OpenLearn pipeline',JSON.stringify({id:'website',version:'isolated-capture-replay-v1',granularity:'page',capabilities:[]}),'[]','active',now(),now(),1);
  const preferences=await json(contract.preferencesPath);await seedIsolatedPreferences({db,database,ownerId,sourceUrl:contract.sourceUrl,preferences,now,logger,authorizationAt:contract.preparedAt});
  const priorRun=unwrap(await repository.findById(ownerId,runId));
  let continuationAuthority=null;if(contract.ownerContinuation){const raw=await readFile(contract.ownerContinuation.path);if(hash(raw)!==contract.ownerContinuation.sha256)throw Error('PipelineContinuationAuthorityChanged');continuationAuthority=JSON.parse(raw);}
  let recoveryAuthority=null;if(contract.ownerRecovery){const raw=await readFile(contract.ownerRecovery.path);if(hash(raw)!==contract.ownerRecovery.sha256)throw Error('PipelineRecoveryAuthorityChanged');recoveryAuthority=JSON.parse(raw);}
  let run;
  if(priorRun){
   if(priorRun.sourceId!==sourceId||priorRun.sourceRevision!==1||priorRun.canonicalSourceIdentity!==contract.sourceUrl||priorRun.contentSignature!==contract.manifestSha256||priorRun.userAuthorization?.ownerId!==ownerId)throw new Error('PipelinePersistedRunBindingInvalid');run=priorRun;
   if(contract.ownerCostAssumption&&contract.evaluatorConfigRefresh&&run.configDigests['question-evaluator']===contract.evaluatorConfigRefresh.previousDigest){const historical=await json(contract.ownerCostAssumption.resultPath);run=await persistPipelineFailure({service,ownerId,runId,outcome:historical.outcome,log})??run;}
   if(contract.evaluatorConfigRefresh){const binding=contract.evaluatorConfigRefresh,bytes=await readFile(binding.path);if(hash(bytes)!==binding.sha256)throw new Error('PipelinePreviousConfigurationChanged');const previousEvaluator=unwrap(await loader.load({source:bytes.toString(),expectedRole:'question-evaluator',expectedDigest:binding.previousDigest})),authorityBytes=await readFile(contract.ownerCostAssumption.path);if(hash(authorityBytes)!==contract.ownerCostAssumption.sha256)throw new Error('PipelineCostAssumptionChanged');run=await refreshEvaluatorTimeout({db,repository,run,configSnapshots:configs,previousEvaluator,authority:{document:JSON.parse(authorityBytes),sha256:hash(authorityBytes)},now,log});}
   if(Object.entries(configs).some(([role,c])=>run.configDigests[role]!==c.digest))throw new Error('PipelineConfigurationSnapshotInvalid');
   if(recoveryAuthority?.additionalMilliseconds)run=await extendContinuationDeadline({db,repository,run,authority:recoveryAuthority,authorizationSha256:contract.ownerRecovery.sha256,now,log});
   else if(continuationAuthority&&!recoveryAuthority)run=await extendContinuationDeadline({db,repository,run,authority:continuationAuthority,authorizationSha256:contract.ownerContinuation.sha256,now,log});
   if(run.state==='retryable-failure'){if(typeof run.extractionDeadlineAt!=='string'||Date.parse(now())>=Date.parse(run.extractionDeadlineAt))throw new Error('PipelineOriginalExtractionDeadlineExceeded');run=unwrap(await service.control({ownerId,runId,expectedRevision:run.revision,action:'resume',idempotencyKey:'pipeline-retry:'+run.revision}));await log({phase:'pipeline-retry-resumed',runId,revision:run.revision,extractionStartedAt:run.extractionStartedAt,extractionDeadlineAt:run.extractionDeadlineAt});}
  }else run=unwrap(await service.createRun({ownerId,sourceId,sourceRevision:1,canonicalSourceIdentity:contract.sourceUrl,contentSignature:contract.manifestSha256,idempotencyKey:runId,configDigests:Object.fromEntries(Object.entries(configs).map(([role,c])=>[role,c.digest])),userAuthorization:{kind:'user-authorized-link',ownerId,sourceId,sourceRevision:1,url:contract.sourceUrl,recordedAt:contract.preparedAt}})).run;
  if(run.state==='source-added')run=unwrap(await service.advance({ownerId,runId,expectedRevision:run.revision,nextState:'rights-assessment'}));
  failureService=service;
  pixels=await createPixelRuntime();const publicEgress=createCapturedMediaEgress(loaded.captures),mediaRepository=new D1KnowledgeMediaRepository({database,bucket,logger});const media=createMediaPipeline({publicEgress,digest:async bytes=>ok('sha256:'+hash(bytes)),quarantine:{put:async({key,bytes,mediaType})=>{await bucket.put(key,bytes,{httpMetadata:{contentType:mediaType}});return ok(null);},remove:async key=>{await bucket.delete(key);return ok(null);}},derivatives:{create:pixels.derivative},repository:mediaRepository,createId:randomUUID,now,logger});
  const modelProtocols=Object.fromEntries(Object.entries(configs).map(([role,c])=>[role,pipelineProtocol(contract.catalogs[c.model.name],role,Boolean(contract.reviewerModel),contract.reviewerModel,Boolean(contract.ownerExecutionOverride))]));
  recoveryHooks=(contract.failedReviewCostPolicy||contract.ownerExecutionOverride)?createFailedReviewRecoveryHooks({db,budget,identity:contract.identity,log}):null;
  const continuationRecovery=continuationAuthority?createContinuationRecovery({db,authority:continuationAuthority,authorizationSha256:contract.ownerContinuation.sha256,log}):null;
  const ownerRecovery=recoveryAuthority?createContinuationRecovery({db,authority:recoveryAuthority,authorizationSha256:contract.ownerRecovery.sha256,log}):null;
  const executionAccounting=budget.snapshot().current,additionalDurationMs=(executionAccounting.effectiveDeadlineAtMs??executionAccounting.deadlineAtMs)-executionAccounting.deadlineAtMs;
  const runtime=createKnowledgeWorkflowRuntime({...(recoveryHooks?{preflightModelWork:(role,stage)=>{recoveryHooks.preflightModelWork(role,stage);lastModelStage={role,...stage};},authorizeFailedReviewCall:async stage=>await ownerRecovery?.(stage)??await continuationRecovery?.(stage)??await recoveryHooks.authorizeFailedReviewCall(stage)}:{}),webpageStructuredOutput:true,...(additionalDurationMs?{extractionDurationMs:WEBPAGE_EXTRACTION_POLICY.maximumDurationMs+additionalDurationMs}:{}),imagePolicy:WEBPAGE_IMAGE_POLICY,database,fetch:budget.modelFetch,browser:createSixCaptureReplayBrowser(loaded.captures,browserImages),apiKey:process.env.OPENROUTER_API_KEY,endpoint:'https://openrouter.ai/api/v1/chat/completions',now,nowMs:budget.nowMs,logger,configSnapshots:configs,modelProtocols,reviewedNavigation:loaded.navigation,media,publicEgress,mediaBucket:bucket,reviewMedia:{readOriginal:scope=>mediaRepository.readOriginal(scope)},decodeImage:pixels.decode,resolveAddresses:async hostname=>{try{const addresses=await lookup(hostname,{all:true});return addresses.length&&addresses.every(a=>!isForbiddenAddress(a.address))?ok(addresses.map(a=>a.address)):fail('AddressUnsafe');}catch{return fail('AddressResolutionFailed');}},transition:({run:current,nextState,...rest})=>service.advance({ownerId,runId,expectedRevision:current.revision,nextState,...rest})});
  outcome=await executePipelineModelRetries({run,runtime,service,now,log,authorize:contract.ownerExecutionOverride?()=>lastModelStage?recoveryHooks.recoveryForStage(lastModelStage):null:null,remainingMilliseconds:()=>budget.snapshot().remainingMilliseconds});
 }catch(error){outcome=fail(error instanceof Error?error.message:'PipelineExecutionFailed');if(failureService)try{await persistPipelineFailure({service:failureService,ownerId:contract.identity.ownerId,runId:contract.identity.runId,outcome,log});}catch(persistenceError){outcome={ok:false,error:{kind:'PipelineFailurePersistenceFailed',detailKind:persistenceError instanceof Error?persistenceError.message:'WorkflowPersistenceFailed',originalFailure:outcome.error}};}}
 finally{
  try{
   try{await pixels?.close();cleanup={ok:true};}catch{cleanup={ok:false};}
   try{if(db)await saveApplicationProjections({db,contract});}catch(error){outcome={ok:false,error:{kind:'PipelineProjectionFailed',detailKind:error instanceof Error?error.name:'UnknownFailure'},priorOutcome:outcome};}
   let reviewRecovery=null;
   try{reviewRecovery=outcome?.ok===false&&cleanup.ok&&lastModelStage?.role==='question-evaluator'?await recoveryHooks?.recoveryForStage(lastModelStage)??null:null;}catch(error){outcome={ok:false,error:{kind:'PipelineRecoveryProofFailed',detailKind:error instanceof Error?error.name:'UnknownFailure'},priorOutcome:outcome};}
   if(reviewRecovery?.retryAtMs!==undefined&&!await waitForReviewRetryAfter({proof:reviewRecovery,remainingMilliseconds:budget.snapshot().remainingMilliseconds,log}))reviewRecovery=null;
   const accounting=budget?.snapshot()??{priorAccounting:contract.priorAccounting,current:null,cumulativeModelCostNanodollars:contract.priorAccounting.modelCostNanodollars,reservedBrowserCredits:contract.priorAccounting.reservedBrowserCredits};
   const recordedAt=new Date().toISOString();await log({at:recordedAt,phase:'pipeline-stopped',outcome,cleanup,accounting});await traceWrites;
   const result={version:'openlearn-six-page-pipeline-result-v1',recordedAt,outcome,cleanup,accounting,identity:contract.identity,manifestSha256:contract.manifestSha256,reviewRecovery};
   const resultBytes=Buffer.from(JSON.stringify(result,null,2)+'\n'),resultPath=resolve(directory,'pipeline-result-'+hash(resultBytes)+'.json');if(!existsSync(resultPath))await writeFile(resultPath,resultBytes,{flag:'wx'});await save(resolve(directory,'pipeline-result.json'),result);
   const traceBytes=await readFile(tracePath),immutableTracePath=resolve(directory,'pipeline-trace-'+hash(traceBytes)+'.jsonl');if(!existsSync(immutableTracePath))await writeFile(immutableTracePath,traceBytes,{flag:'wx'});
   const current=accounting.current;let preparationPauseAcknowledged=false;if(cleanup.ok&&current&&!current.cancelled&&accounting.remainingMilliseconds>0){budget?.pauseForPreparation({resultPath,resultSha256:hash(resultBytes),tracePath:immutableTracePath,traceSha256:hash(traceBytes)});preparationPauseAcknowledged=true;}
   finalReport={...result,preparationPauseAcknowledged};console.log(JSON.stringify(finalReport));
  }finally{
   try{budget?.close();}finally{try{db?.close();}finally{await lock.close();const {rm}=await import('node:fs/promises');await rm(resolve(directory,'pipeline-run.lock'));}}
  }
 }
 return finalReport;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,...args]=process.argv.slice(2);if(command==='--prepare')console.log(JSON.stringify(await prepareSixPagePipeline({ownerAuthorizationPath:args[0],directory:args[1]?resolve(args[1]):defaultDirectory})));else if(command==='--repair-checkpoint')console.log(JSON.stringify(await repairSixPageCheckpoint(resolve(args[0]??resolve(defaultDirectory,'pipeline-contract.json')))));else if(command==='--run'){const path=resolve(args[0]??resolve(defaultDirectory,'pipeline-contract.json'));if((await json(path)).ownerExecutionOverride)await runSixPagePipeline(path);else await executeAuthorizedReviewRetries(()=>runSixPagePipeline(path));}else throw new Error('Use --prepare OWNER_AUTHORIZATION_JSON [DIRECTORY], --repair-checkpoint CONTRACT_JSON or --run CONTRACT_JSON');
}
