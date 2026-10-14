// Real Chrome + the application's fixed browser program. Local transport replaces
// Firecrawl execution only; source responses and archived pixels are real.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createContext,runInContext} from 'node:vm';
import {lookup} from 'node:dns/promises';
import {chromium} from 'playwright-core';
import {createFirecrawlWorkflowBrowser} from '../worker/firecrawl-browser.js';
import {ACQUISITION_POLICY} from '../worker/acquisition-policy.js';
import {isForbiddenAddress} from '../worker/knowledge-workflow-network.js';

const root=resolve('test-results/openlearn-six-page-pipeline-20261013');
const output=resolve('output/playwright/openlearn-browser-images');
const manifest=JSON.parse(await readFile(resolve(root,'capture-manifest.json'),'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const ok=value=>({ok:true,value});
const report={version:'openlearn-browser-image-probe-v1',startedAt:new Date().toISOString(),transport:'local-headed-chrome-running-production-browser-program',applicationAgentNavigation:false,firecrawlServiceVerified:false,firecrawlApiCalls:0,modelApiCalls:0,blockerBypass:false,pages:[],assets:[],failures:[],cleanup:{ok:false}};
await mkdir(resolve(output,'originals'),{recursive:true});
if(process.argv.includes('--resume')){
 const previousBytes=await readFile(resolve(output,'capture-result.json')),previous=JSON.parse(previousBytes);
 assert.equal(previous.cleanup.ok,true);assert.equal(previous.result,'CAPTURE_PARTIAL');assert.equal(previous.firecrawlApiCalls,0);assert.equal(previous.modelApiCalls,0);
 for(let i=0;i<previous.pages.length;i++){const page=previous.pages[i];assert.equal(page.url,manifest.captures[i].url);assert.deepEqual(page.missingImageUrls,[]);for(const image of page.images)assert.equal(digest(await readFile(image.path)),image.sha256);}
 report.pages=previous.pages;report.assets=previous.assets;report.previousCapturePath=resolve(output,'capture-result-'+digest(previousBytes)+'.json');report.previousCaptureSha256=digest(previousBytes);report.resumedPages=previous.pages.length;
}
let chrome,browser,stdout='',vm;
const require=createRequire(import.meta.url);
try{
 chrome=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false});
 const context=await chrome.newContext({viewport:{width:1280,height:720}});
 const page=await context.newPage();
 vm=createContext({page,require,Buffer,URL,setTimeout,clearTimeout,console:{log:value=>{stdout=String(value);}}});
 const localTransport=async(url,init)=>{
  assert.equal(new URL(url).origin,'https://api.firecrawl.dev');
  const command=init.body?JSON.parse(init.body):null;
  if(init.method==='DELETE'){await chrome.close();return Response.json({success:true});}
  if(new URL(url).pathname==='/v2/interact')return Response.json({success:true,id:'local-chrome-image-probe',expiresAt:new Date(Date.now()+600_000).toISOString()});
  assert.equal(init.method,'POST');assert.equal(new URL(url).pathname,'/v2/interact/local-chrome-image-probe/execute');
  stdout='';await runInContext(command.code.replace(/^await /,''),vm,{timeout:1000});
  assert.ok(stdout);return Response.json({success:true,stdout,exitCode:0});
 };
 browser=createFirecrawlWorkflowBrowser({apiKey:'local-transport-placeholder',sessionTtlSeconds:600,fetch:localTransport,policy:ACQUISITION_POLICY,resolveAddresses:async hostname=>{const addresses=await lookup(hostname,{all:true});return addresses.length&&addresses.every(v=>!isForbiddenAddress(v.address))?ok(addresses.map(v=>v.address)):{ok:false,error:{kind:'KnowledgeBrowserNetworkRejected'}};},reserveSession:async()=>ok(null),nowMs:Date.now,logger:entry=>{if(entry.failureKind)report.failures.push(entry);},readRobots:async()=>({ok:false,error:{kind:'RobotsFetchUnavailable'}}),closeRobots:async()=>ok(null)});
 assert.equal(typeof browser.readImage,'function','Application browser image capability must exist before probe');
 const stored=new Map(report.assets.map(asset=>[asset.sha256,asset]));
 for(const entry of manifest.captures.slice(report.pages.length)){
  const saved=JSON.parse(await readFile(entry.path,'utf8'));
  const wanted=new Set(saved.evidence.images.map(image=>image.url));
  let result=await browser.readPage({rootUrl:manifest.sourceRootUrl,url:entry.url});
  if(!result.ok){report.failures.push({pageUrl:entry.url,failureKind:result.error.kind});break;}
  // Consent controls can arrive after DOMContentLoaded; use a fresh observation.
  await page.waitForTimeout(1000);
  const refreshed=await browser.inspect({rootUrl:manifest.sourceRootUrl,url:result.value.responseUrl});assert.ok(refreshed.ok);
  result=refreshed;
  const rejectCookies=refreshed.value.navigation.controls.find(control=>control.role==='button'&&control.label==='Reject All');
  if(rejectCookies){const dismissed=await browser.click({rootUrl:manifest.sourceRootUrl,url:result.value.responseUrl,targetId:rejectCookies.id});assert.ok(dismissed.ok);result=dismissed;}
  const closeDialog=result.value.navigation.controls.find(control=>control.role==='button'&&control.region==='dialog'&&['Close','×'].includes(control.label));
  if(closeDialog){const dismissed=await browser.click({rootUrl:manifest.sourceRootUrl,url:result.value.responseUrl,targetId:closeDialog.id});assert.ok(dismissed.ok);result=dismissed;}
  const current={url:entry.url,responseUrl:result.value.responseUrl,title:result.value.renderedTitle,expectedImageUrls:[...wanted],images:[]};report.pages.push(current);
  const evidenceBytes=Buffer.from(JSON.stringify(result.value.evidence,null,2)+'\n'),evidencePath=resolve(output,'page-'+digest(evidenceBytes)+'.json');
  await writeFile(evidencePath,evidenceBytes,{mode:0o600});current.evidencePath=evidencePath;current.navigationControls=result.value.navigation.controls;
  for(const image of result.value.evidence.images.filter(image=>wanted.has(image.url))){
   const read=await browser.readImage({rootUrl:manifest.sourceRootUrl,pageUrl:current.responseUrl,url:image.url,maximumBytes:ACQUISITION_POLICY.imageBytes,signal:AbortSignal.timeout(ACQUISITION_POLICY.operationMilliseconds)});
   if(!read.ok){current.images.push({url:image.url,failureKind:read.error.kind});continue;}
   const bytes=read.value.bytes,sha256=digest(bytes);
   assert.ok(bytes.length>0&&bytes.length<=ACQUISITION_POLICY.imageBytes);
   const type=read.value.mediaType,extension={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif'}[type];assert.ok(extension);
   const path=resolve(output,'originals',sha256+extension);await writeFile(path,bytes,{mode:0o600});
   assert.equal(digest(await readFile(path)),sha256);
   const dimensions=await page.evaluate(async({base64,type})=>{const image=await createImageBitmap(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type}));try{return {width:image.width,height:image.height};}finally{image.close();}},{base64:Buffer.from(bytes).toString('base64'),type});
   assert.ok(dimensions.width>0&&dimensions.height>0);
   current.images.push({url:image.url,sha256,byteLength:bytes.length,mediaType:type,path,...dimensions});
   const asset=stored.get(sha256)??{sha256,byteLength:bytes.length,mediaType:type,path,...dimensions,sourceUrls:[],pageUrls:[]};
   if(!asset.sourceUrls.includes(image.url))asset.sourceUrls.push(image.url);if(!asset.pageUrls.includes(current.responseUrl))asset.pageUrls.push(current.responseUrl);stored.set(sha256,asset);
  }
  current.missingImageUrls=[...wanted].filter(url=>!current.images.some(image=>image.url===url&&image.sha256));
  await page.screenshot({path:resolve(output,'page-'+report.pages.length+'.png'),fullPage:false});
 }
 report.assets=[...stored.values()];report.result=report.pages.length===manifest.captures.length&&report.pages.every(p=>p.missingImageUrls.length===0)?'CAPTURE_PASS':'CAPTURE_PARTIAL';
}catch(error){report.result='CAPTURE_FAILED';report.failures.push({failureKind:error instanceof Error?error.name:'UnknownFailure'});throw error;}
finally{
 try{if(browser){const closed=await browser.close();report.cleanup=closed;}else if(chrome){await chrome.close();report.cleanup=ok(null);}}finally{report.finishedAt=new Date().toISOString();const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');await writeFile(resolve(output,'capture-result-'+digest(bytes)+'.json'),bytes,{mode:0o600});await writeFile(resolve(output,'capture-result.json'),bytes,{mode:0o600});}
}
console.log(JSON.stringify({result:report.result,pages:report.pages.length,uniqueStoredImages:report.assets.length,bytes:report.assets.reduce((n,a)=>n+a.byteLength,0),modelApiCalls:0,firecrawlApiCalls:0,report:resolve(output,'capture-result.json')}));
