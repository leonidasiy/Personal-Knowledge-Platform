// @ts-check
import { collectWebpageEvidence } from '../src/features/knowledge-workflows/webpage-evidence.js';
import { isWebpageEvidence } from './webpage-facts.js';
import { validatePolicy } from '../acquisition/contracts.ts';
import { isForbiddenAddress } from './knowledge-workflow-network.js';
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:{kind:string}}} Result */
/** @typedef {{url:string,rootUrl:string,signal?:AbortSignal}} PageCommand */
/** @typedef {{rootUrl:string,pageUrl:string,url:string,maximumBytes:number,signal?:AbortSignal}} ImageCommand */
/** @typedef {'image/png'|'image/jpeg'|'image/webp'|'image/gif'} RasterType */
/** @typedef {{id:string,label:string,role:'link'|'tab'|'button',url:string|null,region:string,order:number,selected:boolean}} Control */
/** @typedef {{url:string,title:string,controls:Control[],truncated:boolean}} Navigation */
/** @typedef {{url:string,responseUrl:string,contentType:string,bytes:Uint8Array,redirects:number,renderedTitle:string,renderedText:string,evidence:import('../acquisition/contracts.ts').WebpageEvidence,visibleLinks:string[],navigation:Navigation}} Capture */
/** @typedef {{event:string,failureKind?:string,httpStatus?:number,stage?:'launch'|'execute'|'delete',method?:string,diagnosticToken?:string,diagnosticMessage?:string,failureName?:string,operationStage?:string,exitCode?:number,killed?:boolean}} BrowserLogEntry */
/** @typedef {{apiKey:string|null,sessionTtlSeconds?:number,fetch:typeof globalThis.fetch,policy:import('../acquisition/contracts.ts').Policy,resolveAddresses:(hostname:string)=>Promise<Result<readonly string[]>>,reserveSession:(command:{credits:number,ttlSeconds:number})=>Promise<Result<null>>,nowMs:()=>number,logger:(entry:BrowserLogEntry)=>void,readRobots:(command:{sourceUrl:string,robotsUrl:string})=>Promise<Result<{status:number,bytes:Uint8Array}>>,closeRobots:()=>Promise<Result<null>>}} Dependencies */
const encoder = new TextEncoder();
const defaultTtlSeconds = 120;
// Live Interact output truncates near 1 MiB; leave room for JSON and provider framing.
const outputChunkCharacters = 512 * 1024;
/** @param {string} value */
function decodeBase64(value){
  const native=/** @type {typeof Uint8Array & {fromBase64?:(value:string)=>Uint8Array}} */(Uint8Array);
  return typeof native.fromBase64==='function'?native.fromBase64(value):Uint8Array.from(atob(value),c=>c.charCodeAt(0));
}
/** @param {Uint8Array} bytes @returns {RasterType|null} */
function rasterType(bytes){
  if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return 'image/png';
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  const prefix=new TextDecoder().decode(bytes.slice(0,12));
  if(bytes.length>=12&&prefix.startsWith('RIFF')&&prefix.slice(8)==='WEBP')return 'image/webp';
  if(bytes.length>=6&&['GIF87a','GIF89a'].includes(prefix.slice(0,6)))return 'image/gif';
  return null;
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** @param {string} kind @returns {{ok:false,error:{kind:string}}} */
const fail = kind => ({ok:false,error:{kind}});
/**
 * Only recognized technical messages leave the provider boundary. Arbitrary error
 * prose, echoed code, stdout, credentials and connection URLs never enter logs.
 * @param {unknown} value @param {string|null} apiKey
 * @returns {{diagnosticToken:string,diagnosticMessage?:string,failureName?:string}}
 */
function providerDiagnostic(value,apiKey){
  const sources=record(value)?[value.error,value.stderr,value.message,record(value.error)?value.error.message:null,record(value.error)?value.error.name:null]:[value];
  const raw=sources.filter(v=>typeof v==='string').map(v=>apiKey?String(v).split(apiKey).join('[redacted]'):String(v)).join('\n').slice(0,8192);
  const runtime=raw.match(/\b(ReferenceError|SyntaxError|TypeError|ModuleNotFoundError|NameError|TimeoutError|Error)\b/);
  /** @type {[RegExp,string,string][]} */const patterns=[
    [/\bpage is not defined\b/,'sandbox-page-unavailable','ReferenceError: page is not defined'],
    [/\b(?:browser|context) is not defined\b/,'sandbox-browser-binding-unavailable','Browser session binding is unavailable'],
    [/\bBuffer is not defined\b/,'sandbox-buffer-unavailable','ReferenceError: Buffer is not defined'],
    [/\brequire is not defined\b/,'sandbox-require-unavailable','ReferenceError: require is not defined'],
    [/Cannot (?:find|resolve) (?:module|package).*node:dns(?:\/promises)?/,'sandbox-dns-module-unavailable','Node DNS module is unavailable'],
    [/Cannot use import statement outside a module/,'sandbox-node-import-unsupported','SyntaxError: Cannot use import statement outside a module'],
    [/await is only valid in async functions|[Tt]op.level await.*(?:not|unsupported)/,'sandbox-async-code-unsupported','Top level await is unavailable'],
    [/Identifier ['"](?:input|text|lookup|publicUrl|isForbiddenAddress)['"] has already been declared/,'sandbox-execution-bindings-reused','Fixed browser program binding has already been declared'],
    [/page\.(?:unroute|route|evaluate|locator|goto|screenshot|on|off|mainFrame) is not a function/,'sandbox-playwright-api-unavailable','Required Playwright page method is unavailable'],
    [/Cannot read properties of undefined \(reading ['"](?:unroute|route|evaluate|locator|goto|screenshot)['"]\)/,'sandbox-page-unavailable','Playwright page is undefined'],
    [/(?:[Uu]nsupported|[Uu]nknown|[Ii]nvalid) language.*\bnode\b/,'sandbox-node-language-unsupported','Node execution language is unavailable'],
    [/not enough credits|insufficient credits|credit limit|credits exhausted/i,'provider-credit-unavailable','Provider reports insufficient credits'],
    [/session (?:not found|expired|does not exist)|browser session.*expired/i,'provider-session-unavailable','Provider session is unavailable'],
    [/execution (?:timed out|timeout)|code.*timed out/i,'sandbox-execution-timed-out','Provider execution timed out'],
  ];
  for(const [pattern,diagnosticToken,diagnosticMessage] of patterns)if(pattern.test(raw))return {diagnosticToken,diagnosticMessage,...(runtime?{failureName:runtime[1]}:{})};
  return {diagnosticToken:runtime?'provider-runtime-error':'provider-api-rejected',...(runtime?{failureName:runtime[1]}:{})};
}
/** @param {unknown} raw */
function safeHttps(raw) {
  if(typeof raw!=='string'||!URL.canParse(raw))return false;
  const u=new URL(raw),host=u.hostname.replace(/^\[|\]$/g,'');
  return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&host!=='localhost'&&!host.endsWith('.localhost')&&!host.endsWith('.local')&&(!(/^\d+\.\d+\.\d+\.\d+$/.test(host)||host.includes(':'))||!isForbiddenAddress(host));
}
/** @param {string} root @param {string} raw */
function scoped(root,raw){if(!safeHttps(root)||!safeHttps(raw))return false;const r=new URL(root),u=new URL(raw),path=r.pathname.replace(/\/$/,'');return r.origin===u.origin&&(path===''||u.pathname===path||u.pathname.startsWith(path+'/'));}
/** @param {Control} a @param {Control} b */
function sameControlIntent(a,b){return a.role===b.role&&a.label===b.label&&a.url===b.url&&a.region===b.region&&a.selected===b.selected;}
/** @param {Capture} before @param {Capture} after */
function sameCapturedPanel(before,after){
  const selected = (/** @type {Capture} */capture)=>capture.navigation.controls.filter(c=>c.role==='tab'||c.selected).map(c=>({role:c.role,label:c.label,url:c.url,region:c.region,selected:c.selected}));
  return before.responseUrl===after.responseUrl&&before.renderedTitle===after.renderedTitle&&before.renderedText===after.renderedText&&JSON.stringify(before.evidence)===JSON.stringify(after.evidence)&&JSON.stringify(selected(before))===JSON.stringify(selected(after));
}
/**
 * Fixed Playwright program. Only observed identifiers and validated URLs are data;
 * model output can never become executable browser code.
 * @param {Record<string,unknown>} input
 */
function browserProgram(input) {
  return `await (async () => {
const input=${JSON.stringify(input)};
const emit=value=>{const json=JSON.stringify(value);if(Buffer.byteLength(json,'utf8')<=${outputChunkCharacters}){console.log(json);return;}const data=require('node:zlib').gzipSync(Buffer.from(json)).toString('base64');if(data.length>${outputChunkCharacters})require('node:fs').writeFileSync(input.outputPath,data,{mode:0o600});console.log(JSON.stringify({transport:'gzip-base64',total:data.length,data:data.slice(0,${outputChunkCharacters})}));};
const text=value=>typeof value==='string'&&value.trim()!=='';
const isForbiddenAddress=${isForbiddenAddress.toString()};
const publicUrl=raw=>{try{const u=new URL(raw),h=u.hostname.toLowerCase().replace(/^\\[|\\]$/g,'');return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&h!=='localhost'&&!h.endsWith('.localhost')&&!h.endsWith('.local')&&(!(/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(h)||h.includes(':'))||!isForbiddenAddress(h));}catch{return false;}};
const scopedUrl = raw => {if(!publicUrl(raw))return false;const u=new URL(raw),r=new URL(input.rootUrl),p=r.pathname.replace(/\\/$/,'');return u.origin===r.origin&&(!p||u.pathname===p||u.pathname.startsWith(p+'/'));};
const {lookup}=require('node:dns').promises;
const addresses=new Map();
const publicHost=async raw=>{const host=new URL(raw).hostname.replace(/^\\[|\\]$/g,'');if(addresses.has(host))return addresses.get(host);let allowed=false;try{const resolved=await lookup(host,{all:true});allowed=resolved.length>0&&resolved.every(value=>!isForbiddenAddress(value.address));}catch{}addresses.set(host,allowed);return allowed;};
let rejection=null,status=input.previousStatus??null,contentType='text/html',redirects=0,operationStage='route-setup';
const imageResponses=new Map(),imageDeadline=Date.now()+input.timeoutMs;
await page.unroute('**/*');
await page.route('**/*',async route=>{const request=route.request();const main=request.isNavigationRequest()&&request.frame()===page.mainFrame();if(!['GET','HEAD'].includes(request.method())||!publicUrl(request.url())||(main&&!scopedUrl(request.url()))||!await publicHost(request.url())){if(main)rejection='KnowledgeBrowserNavigationRejected';await route.abort('blockedbyclient');return;}await route.continue();});
const onResponse=response=>{const request=response.request();if(request.isNavigationRequest()&&request.frame()===page.mainFrame()){status=response.status();contentType=response.headers()['content-type']??'';if(status>=300&&status<400)redirects++;}else if(request.resourceType?.()==='image'&&imageResponses.size<input.resources){let cursor=request;const chain=[];while(cursor&&chain.length<=input.mediaRedirects){chain.unshift(cursor.url());cursor=cursor.redirectedFrom();}if(!cursor&&chain.every(url=>publicUrl(url)&&url.length<=input.urlCharacters)&&(response.status()<300||response.status()>=400))imageResponses.set(request.url(),{response,chain});}};
page.on('response',onResponse);
try{
 if(input.operation==='screenshot'){operationStage='screenshot';
  if(page.url()!==input.url)throw new Error('KnowledgeBrowserObservationStale');
  emit({screenshot:(await page.screenshot({type:'png'})).toString('base64'),url:page.url()});
 }else{
  if(input.operation==='click'){operationStage='target-validation';
   if(page.url()!==input.url)throw new Error('KnowledgeBrowserObservationStale');
   const valid=await page.evaluate(({id,token})=>{const e=document.querySelector('[data-pkp-navigation-id="'+id+'"]');if(!e||document.documentElement.getAttribute('data-pkp-observation')!==token||e.closest('form')||e.matches('[disabled],[aria-disabled="true"]')||!e.getClientRects().length)return false;const role=e.getAttribute('role');return e.matches('a[href]')||role==='tab'||e.matches('button:not([type="submit"]):not([type="reset"])');},{id:input.targetId,token:input.previousToken});
   if(!valid)throw new Error('KnowledgeBrowserTargetRejected');
   operationStage='click';
   await page.locator('[data-pkp-navigation-id="'+input.targetId+'"]').click({timeout:input.timeoutMs});
   operationStage='wait-load';
   await page.waitForLoadState('domcontentloaded',{timeout:input.timeoutMs});
  }else if(page.url()!==input.url||input.previousStatus===null){operationStage='read-navigation';await page.goto(input.url,{waitUntil:'load',timeout:input.timeoutMs});}
  operationStage='navigation-verification';
  if(rejection)throw new Error(rejection);
  if(!scopedUrl(page.url()))throw new Error('KnowledgeBrowserNavigationRejected');
  if(redirects>input.redirectLimit)throw new Error('RedirectLimitExceeded');
  if(status===null)throw new Error('KnowledgeBrowserResponseInvalid');
  const statusKind={401:'KnowledgePageAuthenticationRequired',402:'KnowledgePagePaywallDetected',403:'KnowledgePageBotAccessDenied',429:'KnowledgePageRateLimited'}[status];
  if(statusKind)throw new Error(statusKind);if(status<200||status>299)throw new Error('KnowledgePageFetchFailed');
  if(!['text/html','application/xhtml+xml'].includes(contentType.split(';')[0].trim().toLowerCase()))throw new Error('KnowledgePageTypeUnsupported');
  operationStage='html-capture';
  const html=await page.content();if(Buffer.byteLength(html,'utf8')>input.htmlBytes)throw new Error('KnowledgePageTooLarge');
  operationStage='evidence-capture';
  const evidence=await page.evaluate(${collectWebpageEvidence.toString()},{url:page.url(),textCharacters:input.textCharacters,candidateCount:32,occurrenceWindow:32});if(!evidence.ok)throw new Error(evidence.error.kind);
  operationStage='image-capture';
  // Ordinary lazy image loading: scroll observed images into view, wait only for
  // their native load/error events within the existing operation deadline, restore.
  const imageUrls=evidence.value.images.map(image=>image.url).filter(url=>publicUrl(url)&&url.length<=input.urlCharacters).slice(0,input.resources);
  if(imageUrls.length)await page.evaluate(async({urls,deadline})=>{const x=scrollX,y=scrollY;try{for(const image of (document.querySelector('main,article')??document.body).querySelectorAll('img')){if(Date.now()>=deadline)break;const candidates=[image.currentSrc,image.src,image.getAttribute('data-src'),image.getAttribute('data-lazy-src')].filter(Boolean).filter(raw=>URL.canParse(raw,location.href)).map(raw=>new URL(raw,location.href).href);if(!candidates.some(url=>urls.includes(url)))continue;image.scrollIntoView({block:'center',behavior:'instant'});await new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),Math.max(1,deadline-Date.now()));requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(null);}));});if(Date.now()>=deadline)break;if(!image.complete)await new Promise(resolve=>{const done=()=>{clearTimeout(timer);image.removeEventListener('load',done);image.removeEventListener('error',done);resolve(null);};const timer=setTimeout(done,Math.max(1,deadline-Date.now()));image.addEventListener('load',done,{once:true});image.addEventListener('error',done,{once:true});if(image.complete)done();});}}finally{scrollTo(x,y);}},{urls:imageUrls,deadline:imageDeadline});
  const images=[];let imageBytes=0;
  for(const url of imageUrls){const observed=[...imageResponses.values()].find(value=>value.chain.includes(url));if(!observed)continue;const {response,chain}=observed,mediaType=(response.headers()['content-type']??'').split(';')[0].trim().toLowerCase();let kind=null;
   const maximum=Math.min(input.imageBytes,input.encodedResourceBytes,input.encodedOperationBytes-imageBytes);
   if(response.status()<200||response.status()>299)kind='MediaFetchFailed';
   else if(Number(response.headers()['content-length'])>maximum)kind='MediaPayloadTooLarge';
   else if(!['image/png','image/jpeg','image/webp','image/gif'].includes(mediaType))kind='MediaUnsupportedType';
   else if(Date.now()>=imageDeadline)kind='MediaPublicEgressTimeout';
   else{let timer;try{const bytes=await Promise.race([response.body(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('MediaPublicEgressTimeout')),Math.max(1,imageDeadline-Date.now()));})]);if(bytes.length>maximum)kind='MediaPayloadTooLarge';else{imageBytes+=bytes.length;images.push({url,chain,status:response.status(),mediaType,base64:bytes.toString('base64')});}}catch(error){kind=error?.message==='MediaPublicEgressTimeout'?'MediaPublicEgressTimeout':'MediaFetchFailed';}finally{clearTimeout(timer);}}
   if(kind)images.push({url,chain,failure:kind});
  }
  if(page.url()!==evidence.value.url||rejection)throw new Error(rejection??'KnowledgeBrowserObservationStale');
  operationStage='controls-capture';
  const navigation=await page.evaluate(({limit,token})=>{document.documentElement.setAttribute('data-pkp-observation',token);document.querySelectorAll('[data-pkp-navigation-id]').forEach(element=>element.removeAttribute('data-pkp-navigation-id'));const nodes=[...document.querySelectorAll('a[href],button,[role="tab"]')].filter(e=>e.getClientRects().length&&!e.closest('[hidden],[aria-hidden="true"],form')&&getComputedStyle(e).visibility!=='hidden'&&!e.matches('[disabled],[aria-disabled="true"],[type="submit"],[type="reset"]'));const controls=[];for(let i=0;i<nodes.length;i++){const e=nodes[i],label=(e.getAttribute('aria-label')||e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,500);if(!label)continue;let url=null;if(e.matches('a[href]')){try{const u=new URL(e.getAttribute('href'),location.href);if(u.protocol!=='https:'||u.origin!==location.origin||u.username||u.password||u.port)continue;url=u.href;}catch{continue;}}const id=token+'-control-'+i;e.setAttribute('data-pkp-navigation-id',id);const region=e.closest('[role="dialog"],dialog,[aria-modal="true"]')??e.closest('nav,aside,main,article,header,footer,[role="navigation"],[role="tablist"]');controls.push({id,label,role:e.getAttribute('role')==='tab'?'tab':e.matches('a[href]')?'link':'button',url,region:region?.getAttribute('aria-label')||region?.getAttribute('role')||region?.tagName.toLowerCase()||'page',order:controls.length,selected:e.getAttribute('aria-selected')==='true'||e.getAttribute('aria-current')==='page'});}return {url:location.href,title:document.title,controls:controls.slice(0,limit),truncated:controls.length>limit};},{limit:input.links,token:input.token});
  operationStage='text-capture';
  const renderedText=await page.evaluate(()=>document.body.innerText);if(renderedText.length>input.textCharacters)throw new Error('WebpageTextLimitExceeded');
  emit({html,url:page.url(),status,contentType,redirects,renderedText,evidence:evidence.value,navigation,images});
 }
}catch(error){
 const message=typeof error?.message==='string'?error.message:'';
 let failure=/^[A-Za-z]+$/.test(message)?message:'KnowledgeBrowserNavigationFailed',diagnosticToken='browser-operation-failed';
 if(operationStage==='click'&&/intercepts pointer events/i.test(message)){failure='KnowledgeBrowserClickObstructed';diagnosticToken='click-pointer-intercepted';}
 else if(operationStage==='click'&&/element is not visible|element is not stable/i.test(message)){failure='KnowledgeBrowserClickTargetUnavailable';diagnosticToken='click-target-not-visible-or-stable';}
 else if(operationStage==='click'&&/outside of the viewport/i.test(message)){failure='KnowledgeBrowserClickTargetUnavailable';diagnosticToken='click-target-outside-viewport';}
 else if(operationStage==='click'&&/element is not attached|element was detached/i.test(message)){failure='KnowledgeBrowserClickTargetUnavailable';diagnosticToken='click-target-detached';}
 else if(/Target page, context or browser has been closed/i.test(message)){failure='KnowledgeBrowserPageClosed';diagnosticToken='browser-page-closed';}
 else if(/Execution context was destroyed/i.test(message)){failure='KnowledgeBrowserCaptureInterrupted';diagnosticToken='capture-navigation-interrupted';}
 else if(error?.name==='TimeoutError'||/Timeout [0-9]+ms exceeded/i.test(message)){failure=operationStage==='click'?'KnowledgeBrowserClickTimedOut':operationStage==='wait-load'?'KnowledgeBrowserLoadTimedOut':operationStage==='read-navigation'?'KnowledgeBrowserTimedOut':'KnowledgeBrowserCaptureTimedOut';diagnosticToken=operationStage==='click'?'click-timeout':operationStage==='wait-load'?'load-timeout':'browser-operation-timeout';}
 const failureName=['TimeoutError','TypeError','ReferenceError','SyntaxError','Error'].includes(error?.name)?error.name:'Error';
 console.log(JSON.stringify({failure,operationStage,diagnosticToken,failureName}));
}finally{page.off('response',onResponse);}
})();`;
}
/** @param {Dependencies} dependencies */
export function createFirecrawlWorkflowBrowser(dependencies) {
  const {policy}=dependencies;
  const ttlSeconds=dependencies.sessionTtlSeconds??defaultTtlSeconds;
  if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<30||ttlSeconds>3600)throw new TypeError('FirecrawlBrowserConfigurationInvalid');
  validatePolicy(policy);
  if(typeof dependencies.fetch!=='function'||typeof dependencies.resolveAddresses!=='function'||typeof dependencies.reserveSession!=='function'||typeof dependencies.nowMs!=='function'||typeof dependencies.logger!=='function'||typeof dependencies.readRobots!=='function'||typeof dependencies.closeRobots!=='function')throw new TypeError('FirecrawlBrowserConfigurationInvalid');
  /** @type {{id:string,expires:number}|null} */let session=null;
  /** @type {{id:string,expires:number}|null} */let pendingCleanup=null;
  /** @type {number|null} */let unknownLaunchUntil=null;
  /** @type {Capture|null} */let current=null;
  /** @type {Map<string,Capture>} */const cache=new Map();
  /** @type {Map<string,Result<{bytes:Uint8Array,mediaType:RasterType}>>} */const imageArchive=new Map();
  let imagePageUrl='',imageRootUrl='';
  let closed=false,busy=false,tokenCounter=0,observationToken='';
  const shutdown=new AbortController();
  /** @type {Promise<Result<null>>|null} */let deleting=null;
  /** @param {string} path @param {string} method @param {unknown} [body] @param {AbortSignal} [signal] @returns {Promise<Result<Record<string,unknown>>>} */
  async function api(path,method,body,signal){
    if(!dependencies.apiKey)return fail('FirecrawlBrowserCredentialUnavailable');
    const stage=/** @type {'launch'|'execute'|'delete'} */(method==='DELETE'?'delete':path.endsWith('/execute')?'execute':'launch');
    /** @type {number|undefined} */let httpStatus;
    const timeoutController=new AbortController(),timeout=setTimeout(()=>timeoutController.abort(),Math.max(policy.requestMilliseconds,policy.operationMilliseconds));
    const requestSignal=signal?AbortSignal.any([signal,timeoutController.signal]):timeoutController.signal;
    try{
      const response=await dependencies.fetch('https://api.firecrawl.dev/v2/interact'+path,{method,headers:{Authorization:'Bearer '+dependencies.apiKey,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:requestSignal});
      httpStatus=response.status;
      const maximum=Math.max(policy.htmlBytes*4,Math.ceil(policy.screenshotBytes*4/3)+8192)+(stage==='execute'?Math.ceil(policy.encodedOperationBytes*4/3)+policy.resources*(policy.urlCharacters*(policy.mediaRedirects+2)*4+512):0),reader=response.body?.getReader();let size=0;const chunks=[];
      if(reader){while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>maximum){await reader.cancel();return fail('FirecrawlBrowserResponseTooLarge');}chunks.push(chunk.value);}}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const output=JSON.parse(new TextDecoder().decode(bytes));
      if(!response.ok||!record(output)||output.success!==true||output.error||output.killed||typeof output.exitCode==='number'&&output.exitCode!==0){dependencies.logger({event:'firecrawl-browser-api-failure',failureKind:'FirecrawlBrowserApiFailed',httpStatus,stage,method,...providerDiagnostic(output,dependencies.apiKey),...(record(output)&&typeof output.exitCode==='number'&&Number.isSafeInteger(output.exitCode)?{exitCode:output.exitCode}:{}),...(record(output)&&typeof output.killed==='boolean'?{killed:output.killed}:{})});return fail('FirecrawlBrowserApiFailed');}
      if(output.truncated===true){dependencies.logger({event:'firecrawl-browser-api-failure',failureKind:'FirecrawlBrowserOutputTruncated',stage,httpStatus,diagnosticToken:'provider-output-truncated'});return fail('FirecrawlBrowserOutputTruncated');}
      return {ok:true,value:output};
    }catch(error){const failureKind=signal?.aborted?'Cancelled':timeoutController.signal.aborted?'FirecrawlBrowserTimedOut':'FirecrawlBrowserApiFailed';dependencies.logger({event:'firecrawl-browser-api-failure',failureKind,...(httpStatus===undefined?{}:{httpStatus}),stage,method,...providerDiagnostic(error,dependencies.apiKey)});return fail(failureKind);}finally{clearTimeout(timeout);}
  }
  /** @returns {Promise<Result<null>>} */
  async function deleteSession(){
    if(deleting)return deleting;
    const old=session??pendingCleanup;session=null;current=null;cache.clear();imageArchive.clear();imagePageUrl='';imageRootUrl='';
    if(!old){if(unknownLaunchUntil!==null){if(dependencies.nowMs()<unknownLaunchUntil){dependencies.logger({event:'firecrawl-browser-launch-unconfirmed',failureKind:'KnowledgeBrowserSessionCloseFailed'});return fail('KnowledgeBrowserSessionCloseFailed');}unknownLaunchUntil=null;}return {ok:true,value:null};}
    pendingCleanup=old;
    // The configured hard TTL bounds a session even if deletion acknowledgement is lost.
    if(dependencies.nowMs()>=old.expires){pendingCleanup=null;return {ok:true,value:null};}
    deleting=(async()=>{const result=await api('/'+encodeURIComponent(old.id),'DELETE');if(result.ok){pendingCleanup=null;return {ok:/** @type {const} */(true),value:null};}dependencies.logger({event:'firecrawl-browser-cleanup-failure',failureKind:'KnowledgeBrowserSessionCloseFailed'});return fail('KnowledgeBrowserSessionCloseFailed');})();
    try{return await deleting;}finally{deleting=null;}
  }
  /** @param {AbortSignal} signal @returns {Promise<Result<null>>} */
  async function ensureSession(signal){
    if(signal.aborted)return fail('Cancelled');
    if(!dependencies.apiKey)return fail('FirecrawlBrowserCredentialUnavailable');
    if(unknownLaunchUntil!==null){const acknowledged=await deleteSession();if(!acknowledged.ok)return acknowledged;}
    if(pendingCleanup){const deleted=await deleteSession();if(!deleted.ok)return deleted;}
    if(session&&dependencies.nowMs()<session.expires)return {ok:true,value:null};
    if(session){const deleted=await deleteSession();if(!deleted.ok)return deleted;}
    const reserved=await dependencies.reserveSession({credits:Math.ceil(ttlSeconds/60)*2,ttlSeconds});if(!reserved.ok)return reserved;
    if(signal.aborted)return fail('Cancelled');
    const started=dependencies.nowMs(),hardExpiry=started+Math.max(policy.requestMilliseconds,policy.operationMilliseconds)+ttlSeconds*1000;
    // A launch can succeed remotely while its response is lost. Its reservation and
    // hard termination bound survive every failed/aborted request and close attempt.
    unknownLaunchUntil=hardExpiry;
    const created=await api('','POST',{ttl:ttlSeconds,activityTtl:ttlSeconds,streamWebView:false,blockAds:true},signal);
    if(!created.ok)return created;const value=created.value;
    if(typeof value.id!=='string'||!value.id)return fail('FirecrawlBrowserResponseInvalid');
    session={id:value.id,expires:hardExpiry};unknownLaunchUntil=null;
    const expires=typeof value.expiresAt==='string'?Date.parse(value.expiresAt):NaN;
    if(!Number.isFinite(expires)||expires<=dependencies.nowMs()){const deleted=await deleteSession();return deleted.ok?fail('FirecrawlBrowserResponseInvalid'):deleted;}
    session.expires=Math.min(hardExpiry,expires);
    if(signal.aborted){const deleted=await deleteSession();return deleted.ok?fail('Cancelled'):deleted;}return {ok:true,value:null};
  }
  /** @param {PageCommand} command @returns {Promise<Result<null>>} */
  async function authorize(command){
    if(!command||!scoped(command.rootUrl,command.url)||command.url.length>policy.urlCharacters)return fail('KnowledgeBrowserNavigationRejected');
    try{const resolved=await dependencies.resolveAddresses(new URL(command.url).hostname);if(!resolved.ok||!resolved.value.length||resolved.value.some(isForbiddenAddress))return fail('KnowledgeBrowserNetworkRejected');}catch{return fail('KnowledgeBrowserNetworkRejected');}return {ok:true,value:null};
  }
  /** @template T @param {PageCommand} command @param {(signal:AbortSignal)=>Promise<Result<T>>} operation @returns {Promise<Result<T>>} */
  async function exclusive(command,operation){
    if(closed)return fail('KnowledgeBrowserClosed');if(busy)return fail('KnowledgeBrowserOperationConflict');if(command.signal?.aborted)return fail('Cancelled');busy=true;
    const controller=new AbortController();
    /** @type {Promise<Result<null>>|null} */let abortCleanup=null;
    const abort=()=>{controller.abort();abortCleanup=deleteSession();};command.signal?.addEventListener('abort',abort,{once:true});shutdown.signal.addEventListener('abort',abort,{once:true});
    try{
      const authorized=await authorize(command);if(!authorized.ok)return authorized;
      const ready=await ensureSession(controller.signal);if(!ready.ok)return ready;
      const result=await operation(controller.signal);
      if(controller.signal.aborted||!result.ok&&result.error.kind!=='KnowledgeBrowserClickObstructed'){const deleted=await (abortCleanup??deleteSession());if(!deleted.ok)return deleted;}
      return controller.signal.aborted?fail('Cancelled'):result;
    }catch{
      const deleted=await (abortCleanup??deleteSession());dependencies.logger({event:'firecrawl-browser-failure',failureKind:'FirecrawlBrowserOperationFailed'});
      return deleted.ok?fail(controller.signal.aborted?'Cancelled':'FirecrawlBrowserOperationFailed'):deleted;
    }finally{command.signal?.removeEventListener('abort',abort);shutdown.signal.removeEventListener('abort',abort);busy=false;}
  }
  /** @param {Record<string,unknown>} input @param {AbortSignal} signal @returns {Promise<Result<Record<string,unknown>>>} */
  async function execute(input,signal){
    if(!session)return fail('KnowledgeBrowserClosed');
    const outputPath='/tmp/pkp-browser-'+crypto.randomUUID()+'.b64';
    const path='/'+encodeURIComponent(session.id)+'/execute';
    const output=await api(path,'POST',{code:browserProgram({...input,outputPath}),language:'node',timeout:Math.max(1,Math.ceil(policy.operationMilliseconds/1000))},signal);if(!output.ok)return output;
    const raw=typeof output.value.stdout==='string'&&output.value.stdout.trim()?output.value.stdout:output.value.result;if(typeof raw!=='string')return fail('FirecrawlBrowserResponseInvalid');
    const lines=raw.trim().split('\n');try{let parsed=JSON.parse(lines[lines.length-1]);if(!record(parsed))return fail('FirecrawlBrowserResponseInvalid');
    if(parsed.transport==='gzip-base64'){
      const maximum=Math.max(policy.htmlBytes*4,Math.ceil(policy.screenshotBytes*4/3)+8192)+Math.ceil(policy.encodedOperationBytes*4/3)+policy.resources*(policy.urlCharacters*(policy.mediaRedirects+2)*4+512);
      if(typeof parsed.total!=='number'||!Number.isSafeInteger(parsed.total)||parsed.total<=0||Number(parsed.total)>Math.ceil((maximum+1024)*4/3)||typeof parsed.data!=='string'||parsed.data.length!==Math.min(outputChunkCharacters,Number(parsed.total)))return fail('FirecrawlBrowserResponseInvalid');
      let data=parsed.data;const total=Number(parsed.total);
      while(data.length<total){
        if(signal.aborted)return fail('Cancelled');
        const offset=data.length,length=Math.min(outputChunkCharacters,total-offset);
        const chunk=await api(path,'POST',{language:'node',code:`await (async()=>{const fs=require('node:fs'),data=fs.readFileSync(${JSON.stringify(outputPath)},'utf8');console.log(JSON.stringify({offset:${offset},total:data.length,data:data.slice(${offset},${offset+length})}));${offset+length===total?`fs.unlinkSync(${JSON.stringify(outputPath)});`:''}})();`},signal);
        if(!chunk.ok)return chunk;
        const text=chunk.value.stdout||chunk.value.result;
        if(typeof text!=='string')return fail('FirecrawlBrowserResponseInvalid');
        const part=JSON.parse(text.trim().split('\n').at(-1)??'');
        if(!record(part)||part.offset!==offset||part.total!==total||typeof part.data!=='string'||part.data.length!==length)return fail('FirecrawlBrowserResponseInvalid');
        data+=part.data;
      }
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(data)||data.length%4!==0)return fail('FirecrawlBrowserResponseInvalid');
      const compressed=decodeBase64(data),reader=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const decoder=new TextDecoder('utf-8',{fatal:true});let json='',size=0;
      try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>maximum){await reader.cancel();return fail('FirecrawlBrowserResponseTooLarge');}json+=decoder.decode(chunk.value,{stream:true});}}finally{reader.releaseLock();}
      parsed=JSON.parse(json+decoder.decode());if(!record(parsed))return fail('FirecrawlBrowserResponseInvalid');
    }
if(typeof parsed.failure==='string'){const allowed=['KnowledgeBrowserClickObstructed','KnowledgeBrowserClickTargetUnavailable','KnowledgeBrowserClickTimedOut','KnowledgeBrowserLoadTimedOut','KnowledgeBrowserPageClosed','KnowledgeBrowserCaptureInterrupted','KnowledgeBrowserCaptureTimedOut','KnowledgeBrowserTimedOut','KnowledgeBrowserObservationStale','KnowledgeBrowserTargetRejected','KnowledgeBrowserNavigationRejected','RedirectLimitExceeded','KnowledgeBrowserResponseInvalid','KnowledgePageAuthenticationRequired','KnowledgePagePaywallDetected','KnowledgePageBotAccessDenied','KnowledgePageRateLimited','KnowledgePageFetchFailed','KnowledgePageTypeUnsupported','KnowledgePageTooLarge','WebpageTextLimitExceeded','KnowledgeBrowserNavigationFailed'];const kind=allowed.includes(parsed.failure)?parsed.failure:'KnowledgeBrowserNavigationFailed';
 const stages=['route-setup','screenshot','target-validation','click','wait-load','read-navigation','navigation-verification','html-capture','evidence-capture','image-capture','controls-capture','text-capture'];
 const tokens=['browser-operation-failed','click-pointer-intercepted','click-target-not-visible-or-stable','click-target-outside-viewport','click-target-detached','browser-page-closed','capture-navigation-interrupted','click-timeout','load-timeout','browser-operation-timeout'];
 dependencies.logger({event:'firecrawl-browser-operation-failure',failureKind:kind,...(typeof parsed.operationStage==='string'&&stages.includes(parsed.operationStage)?{operationStage:parsed.operationStage}:{}),...(typeof parsed.diagnosticToken==='string'&&tokens.includes(parsed.diagnosticToken)?{diagnosticToken:parsed.diagnosticToken}:{}),...(typeof parsed.failureName==='string'&&['TimeoutError','TypeError','ReferenceError','SyntaxError','Error'].includes(parsed.failureName)?{failureName:parsed.failureName}:{})});return fail(kind);}return {ok:true,value:parsed};}catch{return fail('FirecrawlBrowserResponseInvalid');}
  }
  /** @param {PageCommand} command @param {'read'|'click'} operation @param {AbortSignal} signal @param {string} [targetId] @returns {Promise<Result<Capture>>} */
  async function capture(command,operation,signal,targetId){
    const token='observation-'+(++tokenCounter);const output=await execute({operation,url:command.url,rootUrl:command.rootUrl,targetId,token,previousToken:observationToken,previousStatus:current?200:null,htmlBytes:policy.htmlBytes,textCharacters:policy.renderedTextCharacters,links:policy.links,redirectLimit:policy.pageRedirects,timeoutMs:policy.requestMilliseconds,imageBytes:policy.imageBytes,encodedResourceBytes:policy.encodedResourceBytes,encodedOperationBytes:policy.encodedOperationBytes,resources:policy.resources,mediaRedirects:policy.mediaRedirects,urlCharacters:policy.urlCharacters},signal);if(!output.ok)return output;
    if(signal.aborted)return fail('Cancelled');
    const v=output.value,n=v.navigation;
    if(!Number.isInteger(v.status)||Number(v.status)<200||Number(v.status)>299||typeof v.contentType!=='string'||!['text/html','application/xhtml+xml'].includes(v.contentType.split(';')[0].trim().toLowerCase())||typeof v.url!=='string'||!scoped(command.rootUrl,v.url)||typeof v.html!=='string'||encoder.encode(v.html).byteLength>policy.htmlBytes||typeof v.renderedText!=='string'||v.renderedText.length>policy.renderedTextCharacters||!isWebpageEvidence(v.evidence)||v.evidence.url!==v.url||!record(n)||n.url!==v.url||typeof n.title!=='string'||!Array.isArray(n.controls)||n.controls.length>policy.links||typeof n.truncated!=='boolean'||n.controls.some((c,i)=>!record(c)||typeof c.id!=='string'||!c.id.startsWith(token+'-control-')||!/^\d+$/.test(c.id.slice((token+'-control-').length))||typeof c.label!=='string'||!c.label.trim()||c.label.length>500||!['link','tab','button'].includes(String(c.role))||(c.url!==null&&(typeof c.url!=='string'||!safeHttps(c.url)||new URL(c.url).origin!==new URL(String(v.url)).origin))||typeof c.region!=='string'||c.order!==i||typeof c.selected!=='boolean')||new Set(n.controls.map(c=>record(c)?c.id:null)).size!==n.controls.length||!Number.isInteger(v.redirects)||Number(v.redirects)<0||Number(v.redirects)>policy.pageRedirects)return fail('FirecrawlBrowserResponseInvalid');
    /** @type {Capture} */const result={url:operation==='click'?v.url:command.url,responseUrl:v.url,contentType:'text/html',bytes:encoder.encode(v.html),redirects:Number(v.redirects),renderedTitle:n.title,renderedText:v.renderedText,evidence:v.evidence,visibleLinks:[...new Set(/** @type {Control[]} */(n.controls).flatMap(c=>c.url?[c.url]:[]))],navigation:/** @type {Navigation} */(n)};
    if(!Array.isArray(v.images)||v.images.length>policy.resources)return fail('FirecrawlBrowserResponseInvalid');
    const observedUrls=new Set(result.evidence.images.filter(image=>safeHttps(image.url)&&image.url.length<=policy.urlCharacters).slice(0,policy.resources).map(image=>image.url));
    if(imagePageUrl!==v.url||imageRootUrl!==command.rootUrl)imageArchive.clear();
    // An ordinary dialog can temporarily hide the main content without unloading
    // its images. Retain this bounded same-page archive; readImage still requires
    // the exact URL in the current observation before returning any bytes.
    let total=0;const returnedUrls=new Set();
    for(const image of v.images){
      if(!record(image)||typeof image.url!=='string'||!safeHttps(image.url)||image.url.length>policy.urlCharacters||!observedUrls.has(image.url)||returnedUrls.has(image.url)||!Array.isArray(image.chain)||!image.chain.includes(image.url)||image.chain.length<1||image.chain.length>policy.mediaRedirects+1||image.chain.some(url=>!safeHttps(url)||String(url).length>policy.urlCharacters))return fail('FirecrawlBrowserResponseInvalid');
      returnedUrls.add(image.url);
      if(!imageArchive.has(image.url)&&imageArchive.size>=policy.resources){const older=[...imageArchive.keys()].find(url=>!observedUrls.has(url));if(older!==undefined)imageArchive.delete(older);else return fail('FirecrawlBrowserResponseInvalid');}
      if(typeof image.failure==='string'){if(!['MediaPayloadTooLarge','MediaUnsupportedType','MediaPublicEgressTimeout','MediaFetchFailed'].includes(image.failure))return fail('FirecrawlBrowserResponseInvalid');imageArchive.set(image.url,fail(image.failure));continue;}
      if(!Number.isInteger(image.status)||Number(image.status)<200||Number(image.status)>299||typeof image.base64!=='string'||image.base64.length>Math.ceil(Math.min(policy.imageBytes,policy.encodedResourceBytes)*4/3)+4||! /^[A-Za-z0-9+/]*={0,2}$/.test(image.base64)||!['image/png','image/jpeg','image/webp','image/gif'].includes(String(image.mediaType)))return fail('FirecrawlBrowserResponseInvalid');
      let bytes;try{bytes=decodeBase64(image.base64);}catch{return fail('FirecrawlBrowserResponseInvalid');}
      total+=bytes.byteLength;if(bytes.byteLength>Math.min(policy.imageBytes,policy.encodedResourceBytes)||total>policy.encodedOperationBytes)return fail('FirecrawlBrowserResponseInvalid');
      const detected=rasterType(bytes);
      const retainedBytes=[...imageArchive.entries()].reduce((sum,[url,value])=>sum+(url!==image.url&&value.ok?value.value.bytes.byteLength:0),0);
      imageArchive.set(image.url,!detected?fail('MediaUnsupportedType'):detected!==image.mediaType?fail('MediaMimeSignatureConflict'):retainedBytes+bytes.byteLength>policy.encodedOperationBytes?fail('MediaPayloadTooLarge'):{ok:true,value:{bytes,mediaType:detected}});
    }
    imagePageUrl=v.url;imageRootUrl=command.rootUrl;
    if(operation==='click')cache.clear();current=result;observationToken=token;cache.set(result.url,result);cache.set(v.url,result);return {ok:true,value:structuredClone(result)};
  }
  /** @param {PageCommand} command @returns {Promise<Result<Capture>>} */
  async function readPage(command){return exclusive(command,async signal=>{const cached=cache.get(command.url);if(cached)return {ok:true,value:structuredClone(cached)};const observed=current;const control=observed?.navigation.controls.find(c=>c.role==='link'&&c.url===command.url);return control&&observed?capture({url:observed.navigation.url,rootUrl:command.rootUrl},'click',signal,control.id):capture(command,'read',signal);});}
  /** Live navigation inspection refreshes the current rendered panel. Page reads
   * retain their exact-URL cache; workflow content dedup remains a separate concern.
   * @param {PageCommand} command @returns {Promise<Result<Capture>>} */
  async function inspect(command){return exclusive(command,signal=>capture(command,'read',signal));}
  /** Original raster bytes from the current observed page's normal browser loads.
   * This local read never creates a session or initiates another network request.
   * Pixel decoding, rights, association and persistence remain the media boundary.
   * @param {ImageCommand} command @returns {Promise<Result<{bytes:Uint8Array,mediaType:RasterType}>>} */
  async function readImage(command){
    if(closed)return fail('KnowledgeBrowserClosed');if(busy)return fail('KnowledgeBrowserOperationConflict');if(command.signal?.aborted)return fail('Cancelled');
    if(!Number.isSafeInteger(command.maximumBytes)||command.maximumBytes<=0||command.maximumBytes>policy.imageBytes)return fail('MediaCommandInvalid');
    if(!scoped(command.rootUrl,command.pageUrl)||!safeHttps(command.url)||command.url.length>policy.urlCharacters)return fail('MediaNetworkRejected');
    if(!current||current.responseUrl!==command.pageUrl||imagePageUrl!==command.pageUrl||imageRootUrl!==command.rootUrl||!current.evidence.images.some(image=>image.url===command.url))return fail('KnowledgeBrowserObservationStale');
    const archived=imageArchive.get(command.url);if(!archived)return fail('MediaFetchFailed');if(!archived.ok)return archived;
    if(archived.value.bytes.byteLength>command.maximumBytes)return fail('MediaPayloadTooLarge');
    return {ok:true,value:{bytes:archived.value.bytes.slice(),mediaType:archived.value.mediaType}};
  }
  /** @param {PageCommand & {targetId:string}} command @returns {Promise<Result<Capture>>} */
  async function click(command){
    const observed=current;if(!observed||observed.navigation.url!==command.url)return fail('KnowledgeBrowserTargetRejected');
    const control=observed.navigation.controls.find(c=>c.id===command.targetId);if(!control)return fail('KnowledgeBrowserTargetRejected');
    if(control.url&&!scoped(command.rootUrl,control.url))return fail('KnowledgeBrowserNavigationRejected');
    return exclusive(command,async signal=>{
      let target=control;
      // A model round trip may outlive the remote session. Reacquire the page only
      // when its source revision and selected panel are unchanged, then rebind the
      // same uniquely observed intent to a fresh DOM identifier.
      if(current!==observed){
        const fresh=await capture(command,'read',signal);if(!fresh.ok)return fresh;
        if(!sameCapturedPanel(observed,fresh.value))return fail('KnowledgeBrowserObservationStale');
        const matches=fresh.value.navigation.controls.filter(candidate=>sameControlIntent(control,candidate));
        if(matches.length!==1)return fail('KnowledgeBrowserObservationStale');
        target=matches[0];dependencies.logger({event:'firecrawl-browser-observation-restored'});
      }
      return capture(command,'click',signal,target.id);
    });
  }
  /** @param {PageCommand} command @returns {Promise<Result<{url:string,bytes:Uint8Array,mediaType:'image/png'}>>} */
  async function screenshot(command){if(session&&dependencies.nowMs()>=session.expires){const deleted=await deleteSession();return deleted.ok?fail('KnowledgeBrowserObservationStale'):deleted;}if(!current||current.navigation.url!==command.url)return fail('KnowledgeBrowserObservationStale');return exclusive(command,async signal=>{if(!current)return fail('KnowledgeBrowserObservationStale');const output=await execute({operation:'screenshot',url:command.url,rootUrl:command.rootUrl},signal);if(!output.ok)return output;const v=output.value;if(v.url!==command.url||typeof v.screenshot!=='string'||v.screenshot.length>Math.ceil(policy.screenshotBytes*4/3)+4||! /^[A-Za-z0-9+/]*={0,2}$/.test(v.screenshot))return fail('KnowledgeScreenshotFailed');try{const bytes=decodeBase64(v.screenshot);if(bytes.byteLength>policy.screenshotBytes)return fail('KnowledgeScreenshotTooLarge');if(bytes.length<8||[137,80,78,71,13,10,26,10].some((b,i)=>bytes[i]!==b))return fail('KnowledgeScreenshotFailed');return {ok:true,value:{url:command.url,bytes,mediaType:'image/png'}};}catch{return fail('KnowledgeScreenshotFailed');}});}
  return Object.freeze({readPage,inspect,click,screenshot,readImage,readRobots:dependencies.readRobots,async close(){closed=true;shutdown.abort();const deleted=await deleteSession();try{const robotsClosed=await dependencies.closeRobots();if(!robotsClosed.ok)return robotsClosed;}catch{return fail('KnowledgeBrowserSessionCloseFailed');}return deleted;}});
}
