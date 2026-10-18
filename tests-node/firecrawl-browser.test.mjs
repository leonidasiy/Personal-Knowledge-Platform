import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { createFirecrawlWorkflowBrowser } from '../worker/firecrawl-browser.js';
const root='https://example.org/course',first=root+'/lesson-1',second=root+'/lesson-2';
const policy={htmlBytes:100_000,robotsBytes:262_144,screenshotBytes:100_000,imageBytes:100_000,attachmentCount:1,attachmentBytes:100_000,pageRedirects:3,mediaRedirects:3,encodedResourceBytes:100_000,encodedOperationBytes:100_000,decodedOperationBytes:100_000,resources:100,operationMilliseconds:30_000,requestMilliseconds:20_000,pixels:2_000_000,frames:1,aggregatePixels:2_000_000,renderedTextCharacters:10_000,links:100,urlCharacters:2048,viewportWidth:1000,viewportHeight:800};
const png=Buffer.from([137,80,78,71,13,10,26,10,1]);
function fixture(options={}){
 let clock=1000,location='about:blank',token='',status=200,closedRobots=0,imagesVisible=true;
 const calls=[],reserves=[],logs=[],listeners=new Map(),files=new Map();let guard;
 const nativeRequire=createRequire(import.meta.url),sandboxRequire=name=>name==='node:dns'?{promises:{lookup:async()=>[{address:'8.8.8.8'}]}}:name==='node:fs'?{writeFileSync:(path,data)=>files.set(path,data),readFileSync:path=>{assert(files.has(path),'Transfer file exists');return files.get(path);},unlinkSync:path=>files.delete(path)}:nativeRequire(name);
 const evidence=()=>({url:location,headings:[],blocks:[{id:'p1',locator:'p',sectionId:'root',kind:'text',text:options.changedEvidence&&reserves.length>1?'Changed source content.':'Fixture educational text.',figureId:null}],images:(imagesVisible?options.images??[]:[]).map((image,i)=>({id:'image:'+i,url:image.url,occurrences:[{id:'occurrence:'+i,locator:'main img',sectionId:'root',figureId:null,captionId:null,alt:'Fixture raster'}],occurrenceWindows:[['occurrence:'+i]]})),warnings:[]});
 let bodyReads=0,lazyLoads=0,loaded=false;
 function emitImages(lazy){for(const image of options.images??[]){if(!!image.lazy!==lazy)continue;let request=null;for(const url of image.chain??[image.url]){const previous=request;request={url:()=>url,isNavigationRequest:()=>false,resourceType:()=>image.resourceType??'image',redirectedFrom:()=>previous};}listeners.get('response')?.({request:()=>request,status:()=>image.status??200,headers:()=>({'content-type':image.mediaType??'image/png',...(image.declaredBytes===undefined?{}:{'content-length':String(image.declaredBytes)})}),body:async()=>{bodyReads++;if(image.bodyError)throw new Error('Fixture body unavailable');if(image.bodyWait)return image.bodyWait();return image.bytes??png;}});}}
 const page={
  url:()=>location,mainFrame:()=>page,
  unroute:async()=>{guard=null;},route:async(_pattern,handler)=>{guard=handler;},
  on:(name,handler)=>listeners.set(name,handler),off:name=>listeners.delete(name),
  async goto(url,options){loaded=options?.waitUntil==='load';location=url;listeners.get('response')?.({request:()=>({isNavigationRequest:()=>true,frame:()=>page}),status:()=>status,headers:()=>({'content-type':'text/html'})});emitImages(false);},
  emulateMedia:async()=>{},pdf:async()=>Buffer.from(options.pdf??'%PDF-fixture'),waitForLoadState:async()=>{if(options.waitError)throw options.waitError;},content:async()=>options.html??'<main><p>Fixture educational text.</p></main>',screenshot:async()=>png,
  locator:()=>({click:async()=>{if(options.clickError)throw options.clickError;location=second;await page.goto(second);}}),
  async evaluate(fn,arg){
   if(fn.name==='collectWebpageEvidence')return {ok:true,value:{...evidence(),...(options.delayedContent&&!loaded?{blocks:[]}: {})}};
   if(fn.toString().includes('image.scrollIntoView')){lazyLoads++;if(options.lazyDom)return runInContext('('+fn.toString()+')(command)',createContext({...options.lazyDom,command:arg,URL,setTimeout,clearTimeout}));emitImages(true);return;}
   if(fn.toString().includes('const valid='))throw new Error('Unexpected fixture branch');
   if(fn.toString().includes('document.documentElement.setAttribute')){token=arg.token;if(options.navigationDom)return runInContext('('+fn.toString()+')(command)',createContext({...options.navigationDom,command:arg,URL}));const navigation={url:location,title:'Fixture lesson',controls:[{id:'control-0',label:'Next lesson',role:'link',url:second,region:'course contents',order:0,selected:false},{id:'control-1',label:'Course content',role:'tab',url:null,region:'tabs',order:1,selected:true}],truncated:false};const transformed=options.navigationTransform?options.navigationTransform(navigation,reserves.length):navigation;return {...transformed,controls:transformed.controls.map(c=>({...c,id:arg.token+'-'+c.id}))};}
   if(fn.toString().includes('data-pkp-navigation-id'))return arg.token===token;
   return 'Fixture educational text.';
  }
 };
 let vmContext;
 const fetcher=async(url,init)=>{
  const body=init.body?JSON.parse(init.body):null;calls.push({url,method:init.method,body});
  if(init.method==='DELETE')return options.deleteSession?options.deleteSession({url,init}):Response.json({success:true});
  if(url.endsWith('/interact')&&options.createSession)return options.createSession({url,init});
  if(url.endsWith('/interact')&&reserves.length>1){location='about:blank';token='';}
  if(url.endsWith('/interact'))return Response.json({success:true,id:'fixture-session-'+reserves.length,expiresAt:new Date(clock+body.ttl*1000).toISOString()});
  if(options.execute)return options.execute({url,init,body,page});
  let stdout='';const console={log:line=>{stdout+=line+'\n';}};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  if(options.persistentVm){vmContext??=createContext({page,URL,Buffer,setTimeout,clearTimeout,require:sandboxRequire});vmContext.console=console;await runInContext(body.code.replace(/^await /,''),vmContext);}else{await new AsyncFunction('page','console','require',body.code)(page,console,sandboxRequire);}
  if(options.transformOutput)stdout=JSON.stringify(options.transformOutput(JSON.parse(stdout)));
  const truncated=options.providerOutputLimit&&Buffer.byteLength(stdout)>options.providerOutputLimit;
  if(truncated)stdout=Buffer.from(stdout).subarray(0,options.providerOutputLimit).toString()+'[output truncated]';
  return Response.json({success:true,stdout,stderr:'',exitCode:0,truncated:!!truncated});
 };
 const browser=createFirecrawlWorkflowBrowser({sessionTtlSeconds:options.sessionTtlSeconds,apiKey:options.noKey?null:'fixture-credential',fetch:fetcher,policy:options.policy??policy,resolveAddresses:async()=>({ok:true,value:options.privateAddress?['127.0.0.1']:['8.8.8.8']}),reserveSession:async command=>{reserves.push(command);return options.denyReserve?{ok:false,error:{kind:'BudgetExceeded'}}:{ok:true,value:null};},nowMs:()=>clock,logger:entry=>logs.push(entry),readRobots:async()=>({ok:true,value:{status:404,headers:{},bytes:new Uint8Array()}}),closeRobots:async()=>{closedRobots++;return {ok:true,value:null};}});
 return {browser,calls,reserves,logs,page,files,get guard(){return guard;},advance:ms=>{clock+=ms;},setStatus:code=>{status=code;},setImagesVisible:value=>{imagesVisible=value;},get closedRobots(){return closedRobots;},get bodyReads(){return bodyReads;},get lazyLoads(){return lazyLoads;}};
}
test('reserves session before launch, captures grounded DOM controls, clicks and screenshots same browser panel',async()=>{
 const f=fixture();const read=await f.browser.readPage({url:first,rootUrl:root});assert.equal(read.ok,true);assert.equal(read.value.responseUrl,first);assert.equal(read.value.evidence.blocks[0].text,'Fixture educational text.');assert.equal(read.value.navigation.controls[0].order,0);
 assert.deepEqual(f.reserves,[{credits:4,ttlSeconds:120}]);assert.deepEqual(f.calls[0].body,{ttl:120,activityTtl:120,streamWebView:false,blockAds:true});
 const cached=await f.browser.readPage({url:first,rootUrl:root});assert.equal(cached.ok,true);assert.equal(f.calls.length,2);
 const clicked=await f.browser.click({url:first,rootUrl:root,targetId:'observation-1-control-0'});assert.equal(clicked.ok,true);assert.equal(clicked.value.responseUrl,second);assert.equal(clicked.value.url,second);
 const shot=await f.browser.screenshot({url:second,rootUrl:root});assert.equal(shot.ok,true);assert.deepEqual(shot.value.bytes,new Uint8Array(png));assert.equal(f.reserves.length,1);
 await f.browser.close();assert.equal(f.closedRobots,1);assert.equal(f.calls.at(-1).method,'DELETE');assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,'KnowledgeBrowserClosed');
});
test('automatically follows observed matching links without accepting executable model data',async()=>{
 const f=fixture();await f.browser.readPage({url:first,rootUrl:root});const next=await f.browser.readPage({url:second,rootUrl:root});assert.equal(next.ok,true);assert.equal(next.value.url,second);assert.match(f.calls.at(-1).body.code,/"operation":"click"/);assert.match(f.calls.at(-1).body.code,/"targetId":"observation-1-control-0"/);
 const before=f.calls.length;assert.equal((await f.browser.click({url:second,rootUrl:root,targetId:'control-0; malicious()'})).error.kind,'KnowledgeBrowserTargetRejected');assert.equal(f.calls.length,before);await f.browser.close();
});
test('rejects credentials, private addresses, out of scope and stale observations before dispatch',async()=>{
 const f=fixture();for(const url of ['https://u:p@example.org/course','https://127.0.0.1/course','https://example.org:444/course','https://example.org/other'])assert.equal((await f.browser.readPage({url,rootUrl:root})).error.kind,'KnowledgeBrowserNavigationRejected');assert.equal(f.reserves.length,0);
 assert.equal((await fixture({privateAddress:true}).browser.readPage({url:first,rootUrl:root})).error.kind,'KnowledgeBrowserNetworkRejected');
 await f.browser.readPage({url:first,rootUrl:root});assert.equal((await f.browser.click({url:second,rootUrl:root,targetId:'observation-1-control-0'})).error.kind,'KnowledgeBrowserTargetRejected');assert.equal((await f.browser.screenshot({url:second,rootUrl:root})).error.kind,'KnowledgeBrowserObservationStale');await f.browser.close();
});
test('fixed route refuses mutation and private destinations, permits public HTTPS resources',async()=>{
 const f=fixture();await f.browser.readPage({url:first,rootUrl:root});
 async function route(url,method='GET',main=false){let outcome='';await f.guard({request:()=>({url:()=>url,method:()=>method,isNavigationRequest:()=>main,frame:()=>f.page}),abort:async()=>{outcome='abort';},continue:async()=>{outcome='continue';}});return outcome;}
 assert.equal(await route('https://assets.example.org/style.css'),'continue');assert.equal(await route(first,'POST'),'abort');assert.equal(await route('https://127.0.0.1/private'),'abort');assert.equal(await route('https://example.org/outside','GET',true),'abort');assert.equal(await route('https://example.org/course/lesson-3','GET',true),'continue');await f.browser.close();
});
test('expiry deletes old session and reserves replacement; screenshot cannot reopen lost panel',async()=>{
 const f=fixture();await f.browser.readPage({url:first,rootUrl:root});f.advance(120_001);assert.equal((await f.browser.screenshot({url:first,rootUrl:root})).error.kind,'KnowledgeBrowserObservationStale');assert.equal(f.reserves.length,1);const read=await f.browser.readPage({url:first,rootUrl:root});assert.equal(read.ok,true);assert.equal(f.reserves.length,2);await f.browser.close();
});
test('reservation rejection prevents launch, missing credentials and API success with error fail explicitly',async()=>{
 const denied=fixture({denyReserve:true});assert.equal((await denied.browser.readPage({url:first,rootUrl:root})).error.kind,'BudgetExceeded');assert.equal(denied.calls.length,0);
 const absent=fixture({noKey:true});assert.equal((await absent.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserCredentialUnavailable');assert.equal(absent.reserves.length,0);
 const failed=fixture({execute:async()=>Response.json({success:true,error:'fixture-credential private provider diagnostic',stdout:'{}'})});assert.equal((await failed.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserApiFailed');assert.equal(failed.calls.at(-1).method,'DELETE');assert.equal(JSON.stringify(failed.logs).includes('fixture-credential'),false);
});
test('maps actual HTTP blockers and closes failed session',async()=>{
 for(const [status,kind] of [[401,'KnowledgePageAuthenticationRequired'],[402,'KnowledgePagePaywallDetected'],[403,'KnowledgePageBotAccessDenied'],[429,'KnowledgePageRateLimited']]){const f=fixture();f.setStatus(status);assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,kind);assert.equal(f.calls.at(-1).method,'DELETE');}
});
test('cancellation aborts execution and deletes live session; pre-cancelled work has no cost',async()=>{
 let executing;const started=new Promise(resolve=>{executing=resolve;});
 const f=fixture({execute:async({init})=>{executing();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('fixture transport abort')),{once:true}));}});
 const controller=new AbortController();const result=f.browser.readPage({url:first,rootUrl:root,signal:controller.signal});await started;controller.abort();assert.equal((await result).error.kind,'Cancelled');assert.equal(f.calls.at(-1).method,'DELETE');await f.browser.close();
 const before=fixture();assert.equal((await before.browser.readPage({url:first,rootUrl:root,signal:AbortSignal.abort()})).error.kind,'Cancelled');assert.equal(before.reserves.length,0);
});

test('exclusive live execution rejects overlapping requests and close cancels pending work',async()=>{
 let executing;const started=new Promise(resolve=>{executing=resolve;});
 const f=fixture({execute:async({init})=>{executing();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('fixture abort')),{once:true}));}});
 const pending=f.browser.readPage({url:first,rootUrl:root});await started;
 assert.equal((await f.browser.readPage({url:second,rootUrl:root})).error.kind,'KnowledgeBrowserOperationConflict');
 const closed=await f.browser.close();assert.equal(closed.ok,true);assert.equal((await pending).error.kind,'Cancelled');assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
});
test('invalid provider projection fails without caching success',async()=>{
 const f=fixture({execute:async()=>Response.json({success:true,stdout:JSON.stringify({html:'fixture',url:first,status:200,contentType:'text/html',redirects:0,renderedText:'fixture',evidence:{url:first,headings:[],blocks:[],images:[],warnings:[]},navigation:{url:first,title:'fixture',controls:[{id:'control-0',label:'Sign in',role:'link',url:'https://user:password@example.org/course',region:'header',order:0,selected:false}],truncated:false}})})});
 assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserResponseInvalid');assert.equal(f.calls.at(-1).method,'DELETE');
});

test('failed deletion retains cleanup state, blocks new work, and close retries acknowledgement',async()=>{
 let deleteCalls=0;
 const f=fixture({deleteSession:async()=>Response.json(++deleteCalls<3?{success:false,error:'fixture service unavailable'}:{success:true})});
 f.setStatus(403);
 const blocked=await f.browser.readPage({url:first,rootUrl:root});assert.equal(blocked.error.kind,'KnowledgeBrowserSessionCloseFailed');
 assert.equal(f.reserves.length,1);assert.equal(deleteCalls,1);
 const retry=await f.browser.readPage({url:second,rootUrl:root});assert.equal(retry.error.kind,'KnowledgeBrowserSessionCloseFailed');assert.equal(f.reserves.length,1);assert.equal(deleteCalls,2);
 assert.equal((await f.browser.close()).ok,true);assert.equal(deleteCalls,3);assert.equal(f.reserves.length,1);
 assert.equal(f.logs.some(entry=>entry.failureKind==='KnowledgeBrowserSessionCloseFailed'),true);
});
test('hard TTL permits new session after lost cleanup acknowledgement without resetting consumed reservations',async()=>{
 const f=fixture({deleteSession:async()=>Response.json({success:false})});f.setStatus(403);
 assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,'KnowledgeBrowserSessionCloseFailed');
 f.advance(120_001);f.setStatus(200);
 assert.equal((await f.browser.readPage({url:second,rootUrl:root})).ok,true);assert.equal(f.reserves.length,2);
 assert.equal((await f.browser.close()).error.kind,'KnowledgeBrowserSessionCloseFailed');
 f.advance(120_001);assert.equal((await f.browser.close()).ok,true);
});
test('cancellation reports cleanup failure until a later close acknowledges deletion',async()=>{
 let executing,deleteCalls=0;const started=new Promise(resolve=>{executing=resolve;});
 const f=fixture({deleteSession:async()=>Response.json(++deleteCalls===1?{success:false}:{success:true}),execute:async({init})=>{executing();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('fixture abort')),{once:true}));}});
 const controller=new AbortController(),pending=f.browser.readPage({url:first,rootUrl:root,signal:controller.signal});await started;controller.abort();
 assert.equal((await pending).error.kind,'KnowledgeBrowserSessionCloseFailed');assert.equal(deleteCalls,1);
 assert.equal((await f.browser.close()).ok,true);assert.equal(deleteCalls,2);assert.equal(f.reserves.length,1);
});

test('known session with malformed expiry is retained for deletion and failed acknowledgement retries',async()=>{
 let deleteCalls=0;
 const f=fixture({createSession:async()=>Response.json({success:true,id:'fixture-known-malformed-expiry',expiresAt:'invalid'}),deleteSession:async()=>Response.json(++deleteCalls===1?{success:false}:{success:true})});
 const result=await f.browser.readPage({url:first,rootUrl:root});assert.equal(result.error.kind,'KnowledgeBrowserSessionCloseFailed');
 assert.equal(f.calls.at(-1).url,'https://api.firecrawl.dev/v2/interact/fixture-known-malformed-expiry');assert.equal(f.calls.at(-1).method,'DELETE');
 assert.equal((await f.browser.close()).ok,true);assert.equal(deleteCalls,2);assert.equal(f.reserves.length,1);
 const acknowledged=fixture({createSession:async()=>Response.json({success:true,id:'fixture-known-malformed-expiry',expiresAt:'invalid'})});
 assert.equal((await acknowledged.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserResponseInvalid');assert.equal(acknowledged.calls.at(-1).method,'DELETE');assert.equal((await acknowledged.browser.close()).ok,true);
});
test('timed-out launch with no ID blocks new launches and close remains unconfirmed until hard bound',async()=>{
 const boundedPolicy={...policy,requestMilliseconds:5,operationMilliseconds:5};
 const f=fixture({policy:boundedPolicy,createSession:async({init})=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('fixture timeout')),{once:true}))});
 assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserTimedOut');assert.equal(f.reserves.length,1);
 assert.equal((await f.browser.readPage({url:second,rootUrl:root})).error.kind,'KnowledgeBrowserSessionCloseFailed');assert.equal(f.reserves.length,1);assert.equal(f.calls.length,1);
 assert.equal((await f.browser.close()).error.kind,'KnowledgeBrowserSessionCloseFailed');
 f.advance(120_004);assert.equal((await f.browser.close()).error.kind,'KnowledgeBrowserSessionCloseFailed');f.advance(1);assert.equal((await f.browser.close()).ok,true);assert.equal(f.reserves.length,1);
});
test('an explicit launch rate-limit refusal retains its reservation without inventing an unknown session',async()=>{
 const f=fixture({createSession:async()=>Response.json({success:false,error:'Rate limit exceeded'},{status:429})});
 assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserApiFailed');
 assert.equal(f.reserves.length,1);assert.equal((await f.browser.close()).ok,true);
 assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
 const uncertain=fixture({createSession:async()=>Response.json({success:false,error:'Server error'},{status:500})});
 assert.equal((await uncertain.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserApiFailed');
 assert.equal((await uncertain.browser.close()).error.kind,'KnowledgeBrowserSessionCloseFailed');assert.equal(uncertain.reserves.length,1);
});
test('aborted launch and invalid ID preserve unknown launch guard without refunding reservation',async()=>{
 let creating;const started=new Promise(resolve=>{creating=resolve;});
 const f=fixture({createSession:async({init})=>{creating();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('fixture aborted creation')),{once:true}));}});
 const controller=new AbortController(),pending=f.browser.readPage({url:first,rootUrl:root,signal:controller.signal});await started;controller.abort();assert.equal((await pending).error.kind,'Cancelled');
 assert.equal((await f.browser.readPage({url:second,rootUrl:root})).error.kind,'KnowledgeBrowserSessionCloseFailed');assert.equal((await f.browser.close()).error.kind,'KnowledgeBrowserSessionCloseFailed');assert.equal(f.reserves.length,1);
 f.advance(150_000);assert.equal((await f.browser.close()).ok,true);
 const missing=fixture({createSession:async()=>Response.json({success:true,expiresAt:new Date(121000).toISOString()})});
 assert.equal((await missing.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserResponseInvalid');assert.equal((await missing.browser.close()).error.kind,'KnowledgeBrowserSessionCloseFailed');assert.equal(missing.reserves.length,1);
});
test('API diagnostics expose safe execution reason and HTTP stage without secrets, URLs, code or source content',async()=>{
 const f=fixture({execute:async()=>Response.json({success:true,error:{message:'ReferenceError: page is not defined\nfixture-credential\nwss://private-cdp.invalid/session?token=credential\nconst input={confidential: true};\nPRIVATE SOURCE CONTENT'},stderr:'ReferenceError: page is not defined\nhttps://private-live-view.invalid/credential',stdout:'PRIVATE STDOUT CONTENT',exitCode:1,killed:false})});
 assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserApiFailed');
 const diagnostic=f.logs.find(entry=>entry.event==='firecrawl-browser-api-failure');
 assert.deepEqual(diagnostic,{event:'firecrawl-browser-api-failure',failureKind:'FirecrawlBrowserApiFailed',httpStatus:200,stage:'execute',method:'POST',diagnosticToken:'sandbox-page-unavailable',diagnosticMessage:'ReferenceError: page is not defined',failureName:'ReferenceError',exitCode:1,killed:false});
 const logged=JSON.stringify(f.logs);for(const secret of ['fixture-credential','private-cdp','private-live-view','const input','PRIVATE SOURCE CONTENT','PRIVATE STDOUT CONTENT'])assert.equal(logged.includes(secret),false);
});
test('diagnostics report supported technical categories and discard arbitrary provider error prose',async()=>{
 for(const [message,expected] of [["Error: Cannot find module 'node:dns/promises'",'sandbox-dns-module-unavailable'],["SyntaxError: Identifier 'input' has already been declared",'sandbox-execution-bindings-reused'],['TypeError: page.unroute is not a function','sandbox-playwright-api-unavailable'],['Unsupported language: node','sandbox-node-language-unsupported'],['PRIVATE SOURCE CONTENT fixture-credential https://private-cdp.invalid/secret','provider-api-rejected']]){
  const f=fixture({execute:async()=>Response.json({success:false,error:message},{status:400})});await f.browser.readPage({url:first,rootUrl:root});
  const diagnostic=f.logs.find(entry=>entry.event==='firecrawl-browser-api-failure');assert.equal(diagnostic.httpStatus,400);assert.equal(diagnostic.stage,'execute');assert.equal(diagnostic.diagnosticToken,expected);const logged=JSON.stringify(f.logs);assert.equal(logged.includes('fixture-credential'),false);assert.equal(logged.includes('PRIVATE SOURCE CONTENT'),false);assert.equal(logged.includes('private-cdp'),false);
 }
});

test('generated browser program uses supported CommonJS DNS while keeping public-address route guard',async()=>{
 const f=fixture();assert.equal((await f.browser.readPage({url:first,rootUrl:root})).ok,true);
 const code=f.calls.find(call=>call.url.endsWith('/execute')).body.code;
 assert.match(code,/const \{lookup\}=require\('node:dns'\)\.promises;/);assert.doesNotMatch(code,/await import\(/);
 assert.match(code,/await lookup\(host,\{all:true\}\)/);assert.match(code,/resolved\.every\(value=>!isForbiddenAddress\(value\.address\)\)/);assert.match(code,/!await publicHost\(request\.url\(\)\)/);await f.browser.close();
});

test('fixed browser program uses isolated bindings across captures in a persistent VM context',async()=>{
 const f=fixture({persistentVm:true});const firstRead=await f.browser.readPage({url:first,rootUrl:root});assert.equal(firstRead.ok,true);
 const secondRead=await f.browser.readPage({url:second,rootUrl:root});assert.equal(secondRead.ok,true);assert.equal(secondRead.value.responseUrl,second);
 const screenshot=await f.browser.screenshot({url:second,rootUrl:root});assert.equal(screenshot.ok,true);
 const executions=f.calls.filter(call=>call.url.endsWith('/execute'));assert.equal(executions.length,3);for(const execution of executions)assert.match(execution.body.code,/^await \(async \(\) => \{/);
 await f.browser.close();
});

test('fixed click program distinguishes obstruction and timeout phases without leaking error prose',async()=>{
 for(const [message,name,kind,token] of [['locator.click: Timeout 15000ms exceeded. PRIVATE CONTENT <div> intercepts pointer events','TimeoutError','KnowledgeBrowserClickObstructed','click-pointer-intercepted'],['Element is not visible PRIVATE CONTENT','Error','KnowledgeBrowserClickTargetUnavailable','click-target-not-visible-or-stable'],['locator.click: Timeout 15000ms exceeded PRIVATE CONTENT','TimeoutError','KnowledgeBrowserClickTimedOut','click-timeout']]){
  const clickError=new Error(message);clickError.name=name;const f=fixture({clickError});assert.equal((await f.browser.readPage({url:first,rootUrl:root})).ok,true);
  assert.equal((await f.browser.click({url:first,rootUrl:root,targetId:'observation-1-control-0'})).error.kind,kind);const diagnostic=f.logs.find(entry=>entry.event==='firecrawl-browser-operation-failure');assert.equal(diagnostic.operationStage,'click');assert.equal(diagnostic.diagnosticToken,token);assert.equal(JSON.stringify(f.logs).includes('PRIVATE CONTENT'),false);if(kind==='KnowledgeBrowserClickObstructed'){assert.equal(f.calls.some(call=>call.method==='DELETE'),false);await f.browser.close();}else{assert.equal(f.calls.at(-1).method,'DELETE');}
 }
 const waitError=new Error('PRIVATE CONTENT waiting for document load');waitError.name='TimeoutError';const f=fixture({waitError});await f.browser.readPage({url:first,rootUrl:root});assert.equal((await f.browser.click({url:first,rootUrl:root,targetId:'observation-1-control-0'})).error.kind,'KnowledgeBrowserLoadTimedOut');assert.equal(f.logs.find(entry=>entry.event==='firecrawl-browser-operation-failure').operationStage,'wait-load');assert.equal(JSON.stringify(f.logs).includes('PRIVATE CONTENT'),false);
});

test('expired session safely rehydrates unchanged observed page before applying same click intent',async()=>{
 const f=fixture();const observed=await f.browser.readPage({url:first,rootUrl:root});assert.equal(observed.ok,true);f.advance(120_001);
 const clicked=await f.browser.click({url:first,rootUrl:root,targetId:'observation-1-control-0'});assert.equal(clicked.ok,true,JSON.stringify(clicked));assert.equal(clicked.value.responseUrl,second);assert.equal(f.reserves.length,2);
 const latest=f.calls.filter(call=>call.url.endsWith('/execute')).slice(-2);assert.equal(latest.length,2);assert.match(latest[0].body.code,/"operation":"read"/);assert.match(latest[1].body.code,/"operation":"click"/);await f.browser.close();
});

test('expiry recovery rebinds only the same unique control intent using its fresh identifier',async()=>{
 const f=fixture({navigationTransform:(navigation,launches)=>{if(launches>1)navigation.controls[0].id='control-99';return navigation;}});await f.browser.readPage({url:first,rootUrl:root});f.advance(120_001);
 const clicked=await f.browser.click({url:first,rootUrl:root,targetId:'observation-1-control-0'});assert.equal(clicked.ok,true);assert.match(f.calls.filter(call=>call.url.endsWith('/execute')).at(-1).body.code,/"targetId":"observation-2-control-99"/);assert.equal(f.logs.some(entry=>entry.event==='firecrawl-browser-observation-restored'),true);await f.browser.close();
});
test('expiry recovery refuses changed content, changed panels and missing or ambiguous control intent',async()=>{
 const mutations=[{changedEvidence:true},{navigationTransform:(nav,launches)=>{if(launches>1)nav.controls[1].selected=false;return nav;}},{navigationTransform:(nav,launches)=>{if(launches>1)nav.controls[0].url=second+'?different-intent=1';return nav;}},{navigationTransform:(nav,launches)=>{if(launches>1)nav.controls.push({...nav.controls[0],id:'control-99',order:2});return nav;}}];
 for(const mutation of mutations){const f=fixture(mutation);await f.browser.readPage({url:first,rootUrl:root});f.advance(120_001);const result=await f.browser.click({url:first,rootUrl:root,targetId:'observation-1-control-0'});assert.equal(result.error.kind,'KnowledgeBrowserObservationStale');const execute=f.calls.filter(call=>call.url.endsWith('/execute'));assert.equal(execute.length,2);assert.match(execute.at(-1).body.code,/"operation":"read"/);assert.equal(f.calls.at(-1).method,'DELETE');await f.browser.close();}
});

test('inspect refreshes actual current panel while cached content reads avoid another browser capture',async()=>{
 let modalVisible=false;
 const f=fixture({navigationTransform:navigation=>{if(modalVisible)navigation.controls.push({id:'control-2',label:'Close',role:'button',url:null,region:'dialog',order:2,selected:false});return navigation;}});
 const initial=await f.browser.readPage({url:first,rootUrl:root});assert.equal(initial.value.navigation.controls.length,2);modalVisible=true;
 const cached=await f.browser.readPage({url:first,rootUrl:root});assert.equal(cached.value.navigation.controls.length,2);assert.equal(f.calls.filter(call=>call.url.endsWith('/execute')).length,1);
 const fresh=await f.browser.inspect({url:first,rootUrl:root});assert.equal(fresh.ok,true);assert.equal(fresh.value.navigation.controls[2].region,'dialog');assert.equal(f.calls.filter(call=>call.url.endsWith('/execute')).length,2);
 await f.browser.readPage({url:first,rootUrl:root});assert.equal(f.calls.filter(call=>call.url.endsWith('/execute')).length,2);assert.equal(f.reserves.length,1);
 const code=f.calls.filter(call=>call.url.endsWith('/execute')).at(-1).body.code;assert.match(code,/role="dialog"/);assert.match(code,/aria-modal="true"/);assert.match(code,/region\?\.getAttribute\('role'\)/);await f.browser.close();
});
test('obstructed click preserves session for fresh inspection and screenshot until explicit close',async()=>{
 const clickError=new Error('locator.click: Timeout 15000ms exceeded: backdrop intercepts pointer events');clickError.name='TimeoutError';let modalVisible=false;
 const f=fixture({clickError,navigationTransform:navigation=>{if(modalVisible)navigation.controls.push({id:'control-2',label:'Close',role:'button',url:null,region:'dialog',order:2,selected:false});return navigation;}});
 await f.browser.readPage({url:first,rootUrl:root});modalVisible=true;
 assert.equal((await f.browser.click({url:first,rootUrl:root,targetId:'observation-1-control-0'})).error.kind,'KnowledgeBrowserClickObstructed');assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
 const fresh=await f.browser.inspect({url:first,rootUrl:root});assert.equal(fresh.ok,true);assert.equal(fresh.value.navigation.controls[2].label,'Close');assert.equal((await f.browser.screenshot({url:first,rootUrl:root})).ok,true);assert.equal(f.reserves.length,1);
 assert.equal((await f.browser.close()).ok,true);assert.equal(f.calls.filter(call=>call.method==='DELETE').length,1);
});

test('fresh DOM inspection clears old hidden control IDs before assigning unique visible identifiers',async()=>{
 const staleAttributes=new Map([['data-pkp-navigation-id','control-0']]),visibleAttributes=new Map();
 const dialog={tagName:'DIV',getAttribute:name=>name==='role'?'dialog':null};
 const node=(attributes,hidden)=>({tagName:'BUTTON',textContent:hidden?'Old button':'Close',getClientRects:()=>[{}],getAttribute:name=>attributes.get(name)??null,setAttribute:(name,value)=>attributes.set(name,value),removeAttribute:name=>attributes.delete(name),matches:()=>false,closest:selector=>hidden&&selector.includes('[hidden]')?{}:!hidden&&selector.includes('[role="dialog"]')?dialog:null});
 const hidden=node(staleAttributes,true),visible=node(visibleAttributes,false),elements=[hidden,visible],rootAttributes=new Map();
 const navigationDom={document:{documentElement:{setAttribute:(name,value)=>rootAttributes.set(name,value)},title:'Fixture lesson',querySelectorAll:selector=>selector==='[data-pkp-navigation-id]'?elements.filter(element=>element.getAttribute('data-pkp-navigation-id')):elements},location:new URL(first),getComputedStyle:()=>({visibility:'visible'})};
 const f=fixture({navigationDom});const read=await f.browser.readPage({url:first,rootUrl:root});assert.equal(read.ok,true);assert.equal(read.value.navigation.controls[0].region,'dialog');assert.equal(staleAttributes.has('data-pkp-navigation-id'),false);assert.equal(visibleAttributes.get('data-pkp-navigation-id'),'observation-1-control-0');await f.browser.close();
});
test('fresh observation IDs cannot collide with historical controls at the same DOM index',async()=>{
 let refreshed=false;
 const f=fixture({navigationTransform:navigation=>{if(refreshed)navigation.controls[0]={...navigation.controls[0],label:'Skip to content',url:first+'#content'};return navigation;}});
 const old=await f.browser.readPage({url:first,rootUrl:root});refreshed=true;const fresh=await f.browser.inspect({url:first,rootUrl:root});
 assert.equal(old.value.navigation.controls[0].id,'observation-1-control-0');assert.equal(fresh.value.navigation.controls[0].id,'observation-2-control-0');assert.equal(fresh.value.navigation.controls[0].label,'Skip to content');
 const before=f.calls.length;assert.equal((await f.browser.click({url:first,rootUrl:root,targetId:old.value.navigation.controls[0].id})).error.kind,'KnowledgeBrowserTargetRejected');assert.equal(f.calls.length,before,'A historical ID must not dispatch a different current control.');
 await f.browser.close();
});
test('configurable documented session TTL reserves all requested credits before launch and retains panel past 120 seconds',async()=>{
 const f=fixture({sessionTtlSeconds:480});await f.browser.readPage({url:first,rootUrl:root});assert.deepEqual(f.reserves,[{credits:16,ttlSeconds:480}]);assert.deepEqual(f.calls[0].body,{ttl:480,activityTtl:480,streamWebView:false,blockAds:true});
 f.advance(120_001);assert.equal((await f.browser.click({url:first,rootUrl:root,targetId:'observation-1-control-0'})).ok,true);assert.equal(f.reserves.length,1);await f.browser.close();
 const denied=fixture({sessionTtlSeconds:480,denyReserve:true});assert.equal((await denied.browser.readPage({url:first,rootUrl:root})).error.kind,'BudgetExceeded');assert.equal(denied.calls.length,0);assert.deepEqual(denied.reserves,[{credits:16,ttlSeconds:480}]);
 for(const sessionTtlSeconds of [29,3601,NaN,30.5])assert.throws(()=>fixture({sessionTtlSeconds}),/FirecrawlBrowserConfigurationInvalid/);
});

const cover='https://assets.example.org/cover.png';
const imageCommand=(url=cover,pageUrl=first,maximumBytes=policy.imageBytes)=>({rootUrl:root,pageUrl,url,maximumBytes});
test('archives original observed raster bytes from normal browser responses with no image fetch or screenshot request',async()=>{
 const f=fixture({images:[{url:cover}]});assert.equal((await f.browser.readPage({url:first,rootUrl:root})).ok,true);
 const calls=f.calls.length;const image=await f.browser.readImage(imageCommand());assert.equal(image.ok,true);assert.deepEqual(image.value.bytes,new Uint8Array(png));assert.equal(image.value.mediaType,'image/png');assert.equal(f.calls.length,calls);assert.equal(f.bodyReads,1);
 image.value.bytes[0]=0;assert.equal((await f.browser.readImage(imageCommand())).value.bytes[0],137);
 await f.browser.inspect({url:first,rootUrl:root});assert.equal((await f.browser.readImage(imageCommand())).ok,true);assert.equal(f.bodyReads,1);await f.browser.close();assert.equal((await f.browser.readImage(imageCommand())).error.kind,'KnowledgeBrowserClosed');
});
test('captures validated final redirect response and binds the original observed image URL',async()=>{
 const final='https://cdn.example.org/original.png';const f=fixture({persistentVm:true,images:[{url:cover,chain:[cover,final]}]});assert.equal((await f.browser.readPage({url:first,rootUrl:root})).ok,true);assert.equal((await f.browser.readImage(imageCommand())).ok,true);
 assert.equal((await f.browser.readImage(imageCommand(final))).error.kind,'KnowledgeBrowserObservationStale');assert.equal(f.bodyReads,1);await f.browser.close();
 for(const chain of [[cover,'https://127.0.0.1/private.png'],[cover,'https://user:password@cdn.example.org/a.png'],[cover,'https://cdn.example.org:444/a.png'],[cover,'https://a.example.org/1','https://a.example.org/2','https://a.example.org/3','https://a.example.org/4']]){const invalid=fixture({images:[{url:cover,chain}]});assert.equal((await invalid.browser.readPage({url:first,rootUrl:root})).ok,true);assert.equal((await invalid.browser.readImage(imageCommand())).error.kind,'MediaFetchFailed');assert.equal(invalid.bodyReads,0);await invalid.browser.close();}
});
test('ordinary lazy image scroll captures original bytes and fixed DOM program restores scroll position',async()=>{
 const f=fixture({images:[{url:cover,lazy:true}]});assert.equal((await f.browser.readPage({url:first,rootUrl:root})).ok,true);assert.equal(f.lazyLoads,1);assert.equal((await f.browser.readImage(imageCommand())).ok,true);await f.browser.close();
 let observedScrolls=0,unobservedScrolls=0,restored=null;
 const image={currentSrc:cover,src:cover,complete:true,getAttribute:()=>null,scrollIntoView:()=>{observedScrolls++;}};
 const other={...image,currentSrc:'https://assets.example.org/unobserved.png',src:'https://assets.example.org/unobserved.png',scrollIntoView:()=>{unobservedScrolls++;}};
 const dom=fixture({images:[{url:cover}],lazyDom:{document:{querySelector:()=>({querySelectorAll:()=>[image,other]})},location:{href:first},scrollX:12,scrollY:34,scrollTo:(x,y)=>{restored=[x,y];},requestAnimationFrame:callback=>setImmediate(callback)}});
 assert.equal((await dom.browser.readPage({url:first,rootUrl:root})).ok,true);assert.equal(observedScrolls,1);assert.equal(unobservedScrolls,0);assert.deepEqual(restored,[12,34]);await dom.browser.close();
});
test('does not capture redirect bodies, HTML challenge, HTTP blocker, non-image request or failed browser body',async()=>{
 for(const image of [{url:cover,status:302},{url:cover,status:403},{url:cover,status:401},{url:cover,mediaType:'text/html'},{url:cover,resourceType:'fetch'},{url:cover,bodyError:true}]){
  const f=fixture({images:[image]});assert.equal((await f.browser.readPage({url:first,rootUrl:root})).ok,true);const calls=f.calls.length;const read=await f.browser.readImage(imageCommand());assert.equal(read.ok,false);assert.equal(read.error.kind,image.mediaType==='text/html'?'MediaUnsupportedType':'MediaFetchFailed');assert.equal(f.calls.length,calls);assert.equal(f.bodyReads,image.bodyError?1:0);await f.browser.close();
 }
});
test('validates raster signatures and MIME declarations instead of accepting browser HTML or arbitrary bytes',async()=>{
 for(const [bytes,mediaType,expected] of [[Buffer.from('<html>challenge</html>'),'image/png','MediaUnsupportedType'],[png,'image/jpeg','MediaMimeSignatureConflict'],[Buffer.from('GIF89a-fixture'),'image/gif',null],[Buffer.from([255,216,255,1]),'image/jpeg',null],[Buffer.from('RIFF0000WEBP'),'image/webp',null]]){
  const f=fixture({images:[{url:cover,bytes,mediaType}]});assert.equal((await f.browser.readPage({url:first,rootUrl:root})).ok,true);const read=await f.browser.readImage(imageCommand());if(expected)assert.equal(read.error.kind,expected);else assert.equal(read.value.mediaType,mediaType);await f.browser.close();
 }
});
test('enforces individual, aggregate, caller and resource-count image limits without new network calls',async()=>{
 for(const [override,image,bodyReads] of [[{imageBytes:8},{url:cover},1],[{encodedResourceBytes:8},{url:cover},1],[{imageBytes:8},{url:cover,declaredBytes:9},0]]){
  const f=fixture({policy:{...policy,...override},images:[image]});assert.equal((await f.browser.readPage({url:first,rootUrl:root})).ok,true);assert.equal((await f.browser.readImage(imageCommand(cover,first,8))).error.kind,'MediaPayloadTooLarge');assert.equal(f.bodyReads,bodyReads);await f.browser.close();
 }
 const other='https://assets.example.org/other.png';const aggregate=fixture({policy:{...policy,encodedOperationBytes:10},images:[{url:cover},{url:other}]});assert.equal((await aggregate.browser.readPage({url:first,rootUrl:root})).ok,true);assert.equal((await aggregate.browser.readImage(imageCommand())).ok,true);assert.equal((await aggregate.browser.readImage(imageCommand(other))).error.kind,'MediaPayloadTooLarge');assert.equal((await aggregate.browser.readImage(imageCommand(cover,first,8))).error.kind,'MediaPayloadTooLarge');await aggregate.browser.close();
 const count=fixture({policy:{...policy,resources:1},images:[{url:cover},{url:other}]});assert.equal((await count.browser.readPage({url:first,rootUrl:root})).ok,true);assert.equal(count.bodyReads,1);assert.equal((await count.browser.readImage(imageCommand(other))).error.kind,'MediaFetchFailed');await count.browser.close();
});
test('original image archive is scoped to current observed page, source and exact observed image identity',async()=>{
 const f=fixture({images:[{url:cover}]});assert.equal((await f.browser.readImage(imageCommand())).error.kind,'KnowledgeBrowserObservationStale');assert.equal(f.calls.length,0);
 await f.browser.readPage({url:first,rootUrl:root});const calls=f.calls.length;
 assert.equal((await f.browser.readImage({...imageCommand(),rootUrl:'https://example.org/other'})).error.kind,'MediaNetworkRejected');assert.equal((await f.browser.readImage({...imageCommand(),rootUrl:'https://example.org'})).error.kind,'KnowledgeBrowserObservationStale');assert.equal((await f.browser.readImage(imageCommand('https://user:secret@assets.example.org/image'))).error.kind,'MediaNetworkRejected');assert.equal((await f.browser.readImage(imageCommand('https://127.0.0.1/image'))).error.kind,'MediaNetworkRejected');assert.equal((await f.browser.readImage({...imageCommand(),maximumBytes:0})).error.kind,'MediaCommandInvalid');assert.equal((await f.browser.readImage({...imageCommand(),signal:AbortSignal.abort()})).error.kind,'Cancelled');assert.equal(f.calls.length,calls);
 await f.browser.readPage({url:second,rootUrl:root});assert.equal((await f.browser.readImage(imageCommand())).error.kind,'KnowledgeBrowserObservationStale');assert.equal((await f.browser.readImage(imageCommand(cover,second))).ok,true);await f.browser.close();
});
test('rejects tampered provider image projections and oversized API envelope',async()=>{
 for(const transformOutput of [output=>({...output,images:[{...output.images[0],url:'https://assets.example.org/not-observed.png'}]}),output=>({...output,images:[{...output.images[0],chain:[cover,'https://127.0.0.1/image']}]}),output=>({...output,images:[{...output.images[0],status:403}]}),output=>({...output,images:[{...output.images[0],base64:'INVALID!'}]})]){
  const f=fixture({images:[{url:cover}],transformOutput});assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserResponseInvalid');assert.equal(f.calls.at(-1).method,'DELETE');
 }
 const f=fixture({policy:{...policy,htmlBytes:1,screenshotBytes:1,encodedOperationBytes:1,resources:1,urlCharacters:100},execute:async()=>new Response('x'.repeat(20000))});assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserResponseTooLarge');assert.equal(f.calls.at(-1).method,'DELETE');
});
test('image body deadline returns typed failure without retry and archives bytes before session expiry',async()=>{
 const bounded=fixture({policy:{...policy,requestMilliseconds:5,operationMilliseconds:100},images:[{url:cover,bodyWait:()=>new Promise(()=>{})}]});assert.equal((await bounded.browser.readPage({url:first,rootUrl:root})).ok,true);const before=bounded.calls.length;assert.equal((await bounded.browser.readImage(imageCommand())).error.kind,'MediaPublicEgressTimeout');assert.equal(bounded.calls.length,before);await bounded.browser.close();
 const f=fixture({images:[{url:cover}]});await f.browser.readPage({url:first,rootUrl:root});f.advance(120_001);const calls=f.calls.length;assert.equal((await f.browser.readImage(imageCommand())).ok,true);assert.equal(f.calls.length,calls);assert.equal(f.reserves.length,1);await f.browser.close();
});
test('aborted capture cannot repopulate an image archive after cleanup acknowledges deletion',async()=>{
 const controller=new AbortController();const f=fixture({images:[{url:cover}],transformOutput:output=>{controller.abort();return output;}});
 const result=await f.browser.readPage({url:first,rootUrl:root,signal:controller.signal});assert.equal(result.error.kind,'Cancelled');assert.equal(f.calls.at(-1).method,'DELETE');assert.equal((await f.browser.readImage(imageCommand())).error.kind,'KnowledgeBrowserObservationStale');await f.browser.close();
});
test('same-page hidden panel retains bounded original archive but cannot expose unobserved images',async()=>{
 const f=fixture({images:[{url:cover}]});await f.browser.readPage({url:first,rootUrl:root});assert.equal((await f.browser.readImage(imageCommand())).ok,true);assert.equal(f.bodyReads,1);
 f.setImagesVisible(false);const hidden=await f.browser.inspect({url:first,rootUrl:root});assert.equal(hidden.ok,true);assert.equal(hidden.value.evidence.images.length,0);const before=f.calls.length;assert.equal((await f.browser.readImage(imageCommand())).error.kind,'KnowledgeBrowserObservationStale');assert.equal(f.calls.length,before);
 f.setImagesVisible(true);const visible=await f.browser.inspect({url:first,rootUrl:root});assert.equal(visible.ok,true);assert.equal(visible.value.evidence.images[0].url,cover);const calls=f.calls.length;const restored=await f.browser.readImage(imageCommand());assert.equal(restored.ok,true);assert.deepEqual(restored.value.bytes,new Uint8Array(png));assert.equal(f.calls.length,calls);assert.equal(f.bodyReads,1);
 f.setImagesVisible(false);await f.browser.readPage({url:second,rootUrl:root});f.setImagesVisible(true);await f.browser.inspect({url:second,rootUrl:root});assert.equal((await f.browser.readImage(imageCommand(cover,second))).error.kind,'MediaFetchFailed');await f.browser.close();
});

test('waits for page scripts to load before capturing educational evidence',async()=>{
 const f=fixture({delayedContent:true});try{const result=await f.browser.readPage({url:first,rootUrl:root});assert.equal(result.ok,true);assert.equal(result.value.evidence.blocks.length,1);}finally{await f.browser.close();}
});

for(const incompressible of [false,true])test('provider stdout ceiling preserves complete large HTML and original raster bytes; incompressible='+incompressible,async()=>{
 const image=Buffer.concat([png,(incompressible?randomBytes(1_500_000):Buffer.alloc(1_000_000))]),html='<main>'+('漢字🎶 &quot; '.repeat(30000))+'</main>';
 const f=fixture({providerOutputLimit:1_048_000,html,images:[{url:cover,bytes:image}],policy:{...policy,htmlBytes:1_000_000,imageBytes:2_000_000,encodedResourceBytes:2_000_000,encodedOperationBytes:3_000_000}});
 try{const result=await f.browser.readPage({url:first,rootUrl:root});assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(new TextDecoder().decode(result.value.bytes),html);const read=await f.browser.readImage({...imageCommand(),maximumBytes:2_000_000});assert.equal(read.ok,true);assert.deepEqual(read.value.bytes,new Uint8Array(image));assert.equal(f.reserves.length,1);assert.equal(f.files.size,0,'Transfer files are removed after successful assembly');}finally{await f.browser.close();}
});

for(const corruption of ['length','offset','base64'])test('invalid segmented transfers fail closed and close the session: '+corruption,async()=>{
 const f=fixture({images:[{url:cover,bytes:Buffer.concat([png,randomBytes(800000)])}],policy:{...policy,imageBytes:1_000_000,encodedResourceBytes:1_000_000,encodedOperationBytes:1_000_000},transformOutput:value=>{
  if(corruption==='length'&&value.transport)value.total=Number.MAX_SAFE_INTEGER;
  if(corruption==='offset'&&value.offset)value.offset++;
  if(corruption==='base64'&&value.transport)value.data='!'.repeat(value.data.length);
  return value;
 }});
 try{assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,'FirecrawlBrowserResponseInvalid');assert.equal(f.calls.at(-1).method,'DELETE');assert.equal(f.reserves.length,1);}finally{await f.browser.close();}
});
test('decompression respects the existing payload budget and explicit provider truncation stays diagnostic',async()=>{
 for(const truncated of [false,true]){
  const data=gzipSync(Buffer.alloc(10_000_000,32)).toString('base64');
  const f=fixture({execute:async()=>Response.json({success:true,truncated,stdout:JSON.stringify({transport:'gzip-base64',total:data.length,data})})});
  try{assert.equal((await f.browser.readPage({url:first,rootUrl:root})).error.kind,truncated?'FirecrawlBrowserOutputTruncated':'FirecrawlBrowserResponseTooLarge');assert.equal(f.calls.at(-1).method,'DELETE');if(truncated)assert(f.logs.some(e=>e.diagnosticToken==='provider-output-truncated'));}finally{await f.browser.close();}
 }
});


test('PDF capture prints only a current observed public page, validates bytes and never relaunches an expired observation',async()=>{
 const f=fixture();assert.equal((await f.browser.capturePdf({url:first,rootUrl:root})).error.kind,'KnowledgeBrowserObservationStale');
 assert.equal((await f.browser.readPage({url:first,rootUrl:root})).ok,true);
 const printed=await f.browser.capturePdf({url:first,rootUrl:root});assert.equal(printed.ok,true);assert.equal(new TextDecoder().decode(printed.value),'%PDF-fixture');
 assert.equal((await f.browser.capturePdf({url:second,rootUrl:root})).error.kind,'KnowledgeBrowserObservationStale');
 f.advance(121000);assert.equal((await f.browser.capturePdf({url:first,rootUrl:root})).error.kind,'KnowledgeBrowserObservationStale');assert.equal(f.reserves.length,1);
 const bad=fixture({pdf:'not a PDF'});assert.equal((await bad.browser.readPage({url:first,rootUrl:root})).ok,true);assert.equal((await bad.browser.capturePdf({url:first,rootUrl:root})).error.kind,'MaterialUrlCaptureInvalid');
});

test('PDF output size failures keep their named limit and safe diagnostic stage',async()=>{
 const f=fixture({pdf:'%PDF-'+ 'x'.repeat(policy.encodedOperationBytes)});
 assert.equal((await f.browser.readPage({url:first,rootUrl:root})).ok,true);
 assert.equal((await f.browser.capturePdf({url:first,rootUrl:root})).error.kind,'MaterialByteLimitExceeded');
 assert(f.logs.some(entry=>entry.operationStage==='pdf'&&entry.failureKind==='MaterialByteLimitExceeded'));
});
