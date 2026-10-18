import { createRobotsGate } from '../src/features/knowledge-workflows/robots.js';
// shortcut: the browsers override covers remote use only; reassess before using Node launchers.
import puppeteer from '@cloudflare/puppeteer';
import { validatePublisherDestination } from './destination-policy.js';
import { resolvePublicAddresses } from './knowledge-workflow-network.js';
import { imageSignature } from '../src/features/knowledge-workflows/image-upload.js';
import { packUrlCapture } from '../src/features/knowledge-workflows/url-capture.js';

// One explicitly selected public page; source traversal remains the learner's choice.
/** @param {{binding:import('@cloudflare/puppeteer').BrowserWorker,capacity:Pick<import('./browser-run-capacity-d1.js').D1BrowserRunCapacityLedger,'reserve'|'reconcile'>,fetch:typeof globalThis.fetch,now:()=>number,logger:(entry:{event:string,ownerId:string,failureKind?:string,stage?:string,diagnosticToken?:string})=>void,launcher?:Pick<typeof puppeteer,'launch'>}} dependencies */
export function createUrlPdfCapture({binding,capacity,fetch,now,logger,launcher=puppeteer}) {
  return async (/** @type {{ownerId:string,url:string}} */ {ownerId,url}) => {
    /** @param {string} kind @returns {{ok:false,error:{kind:string}}} */
    const fail=kind=>({ok:false,error:{kind}});
    if(!validatePublisherDestination(url).ok)return fail('SourceExtractionUrlInvalid');
    // Share in-flight DNS checks within this bounded capture to stay within Worker subrequest limits.
    /** @type {Map<string,ReturnType<typeof resolvePublicAddresses>>} */ const addresses=new Map();
    const lookup=(/** @type {string} */ hostname)=>{
      let resolved=addresses.get(hostname);
      if(!resolved){resolved=resolvePublicAddresses(hostname,fetch);addresses.set(hostname,resolved);}
      return resolved;
    };
    const authorized=await lookup(new URL(url).hostname);
    if(!authorized.ok){logger({event:'url-capture-network-failure',ownerId,stage:'source',failureKind:authorized.error.kind});return fail('KnowledgeBrowserNetworkRejected');}
    const reserved=await capacity.reserve({ownerId,jobId:`url-capture:${crypto.randomUUID()}`});
    if(!reserved.ok)return reserved;
    const started=now();
    let browser, timer, closeFailed=false;
    /** @type {{ok:true,value:Uint8Array}|{ok:false,error:{kind:string}}} */
    let result=fail('KnowledgeBrowserNavigationFailed');
    try {
      browser=await launcher.launch(binding,{keep_alive:reserved.value.reservedMilliseconds});
      const session=browser;
      timer=setTimeout(()=>{void session.close().catch(()=>{closeFailed=true;});},Math.max(1,reserved.value.reservedMilliseconds-(now()-started)));
      const page=await browser.newPage();
      /** @template T @param {()=>Promise<T>} work @returns {Promise<T>} */
      const retryAsset=async work=>{for(let attempt=0;;attempt++){try{return await work();}catch(error){if(attempt===3||now()>=started+reserved.value.reservedMilliseconds)throw error;logger({event:'url-capture-image-retry',ownerId,failureKind:'KnowledgeBrowserImageReadFailed'});}}};
      const imageResponses=new Map();
      page.on('response',response=>{const request=response.request();if(request.resourceType()==='image'&&response.ok()&&imageResponses.size<100){imageResponses.set(response.url(),response);for(const redirect of request.redirectChain())imageResponses.set(redirect.url(),response);}});
      await page.setUserAgent("knowledge-platform");
      /** @type {string|null} */ let rejection=null;
      await page.setRequestInterception(true);
      page.on('request',async request=>{
        try {
          const target=request.url();
          if(target.startsWith('data:')||target==='about:blank')return await request.continue();
          if(!['GET','HEAD'].includes(request.method()))return await request.abort();
          const checked=validatePublisherDestination(target);
          const resolved=checked.ok ? await lookup(new URL(target).hostname) : {ok:false};
          if(!resolved.ok){
            const failureKind='error' in resolved?resolved.error.kind:'SourceExtractionUrlInvalid';
            // An unavailable asset stays blocked without discarding the public article.
            if(!(request.isNavigationRequest()&&request.frame()===page.mainFrame())&&failureKind==='WorkflowDnsLookupFailed')logger({event:'url-capture-resource-unavailable',ownerId,stage:'resource',failureKind});
            else{
              if(!rejection)logger({event:'url-capture-network-failure',ownerId,stage:request.isNavigationRequest()?'navigation':'resource',failureKind});
              rejection='KnowledgeBrowserNetworkRejected';
            }
            return await request.abort();
          }
          await request.continue(request.resourceType()==='image'?{headers:{...request.headers(),accept:'image/webp,image/png,image/jpeg,image/gif;q=0.8'}}:{});
        }catch(error){if(!rejection)logger({event:'url-capture-network-failure',ownerId,stage:'interception',failureKind:'KnowledgeBrowserNetworkRejected',diagnosticToken:error instanceof Error&&error.message.includes('Too many subrequests')?'subrequest-limit':error instanceof TypeError?'type-error':'request-failed'});rejection='KnowledgeBrowserNetworkRejected';await request.abort().catch(()=>{});}
      });
      // Cloudflare's CDP peer is its internal proxy; destinations are checked before each request.
      page.on('popup',popup=>{void popup?.close();});
      const response=await page.goto(url,{waitUntil:'networkidle2',timeout:Math.max(1,Math.min(45_000,reserved.value.reservedMilliseconds-(now()-started)))});
      if(rejection)result=fail(rejection);
      else if(!response)result=fail('KnowledgePageFetchFailed');
      else {
        const status=response.status(),headers=response.headers();
        const denied={401:'KnowledgePageAuthenticationRequired',402:'KnowledgePagePaywallDetected',403:'KnowledgePageBotAccessDenied',429:'KnowledgePageRateLimited'}[status];
        if(!validatePublisherDestination(page.url()).ok)result=fail('KnowledgeBrowserNetworkRejected');
        else if(denied||headers['cf-mitigated']==='challenge')result=fail(denied??'KnowledgePageBotAccessDenied');
        else if(status<200||status>299)result=fail('KnowledgePageFetchFailed');
        else if(!/^(text\/html|application\/xhtml\+xml)(;|$)/iu.test(headers['content-type']??''))result=fail('KnowledgePageTypeUnsupported');
        else {
          const robots=await createRobotsGate({fetch,resolveAddresses:lookup,now:()=>new Date(now()).toISOString(),logger:entry=>logger({...entry,ownerId}),robotsUnavailablePolicy:'allow-unverified-if-public',verifyTargetReachable:async()=>({ok:true,value:null})}).check({rights:{status:'allowed',canonicalUrl:page.url()},userAgent:'knowledge-platform'});
          if(!robots.ok){result=robots;}
          else {
          await page.emulateMediaType('screen');
          const bytes=await page.pdf({format:'A4',printBackground:true,timeout:Math.max(1,reserved.value.reservedMilliseconds-(now()-started))});
          let images=[];
          try {
            // Activate lazy figures and retain original responses, never page screenshots.
            const metadata=await page.evaluate(async deadline=>{
              const root=document.body;
              const images=Array.from(root.querySelectorAll('img')).slice(0,100);
              const x=scrollX,y=scrollY;
              try{for(const image of images){if(Date.now()>=deadline)break;image.loading='eager';image.scrollIntoView({block:'center',behavior:'instant'});await new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),Math.max(1,deadline-Date.now()));requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(null);}));});if(!image.complete)await new Promise(resolve=>{const done=()=>{clearTimeout(timer);image.removeEventListener('load',done);image.removeEventListener('error',done);resolve(null);};const timer=setTimeout(done,Math.max(1,deadline-Date.now()));image.addEventListener('load',done,{once:true});image.addEventListener('error',done,{once:true});if(image.complete)done();});}}
              finally{scrollTo(x,y);}
              return images.filter(image=>image.complete&&image.naturalWidth>0).map(image=>{const figure=image.closest('figure');return {url:image.currentSrc||image.src,alt:image.alt,caption:figure?.querySelector('figcaption')?.textContent?.trim()??image.parentElement?.nextElementSibling?.textContent?.trim()??'',context:(figure??image.parentElement)?.textContent?.trim()??''};});
            },started+reserved.value.reservedMilliseconds);
            let total=0;const seen=new Set();
            for(const entry of metadata){
              if(seen.has(entry.url)||!validatePublisherDestination(entry.url).ok)continue;seen.add(entry.url);
              const response=imageResponses.get(entry.url);if(!response)continue;
              try{const length=Number(response.headers()['content-length']);if(length>20*1024*1024)continue;let bytes=new Uint8Array(await retryAsset(()=>response.buffer())),mediaType=imageSignature(bytes);if(bytes.length>20*1024*1024)continue;
                if(!mediaType&&/^(image\/avif|image\/svg\+xml)(;|$)/iu.test(response.headers()['content-type']??'')){
                  // Decode only the original asset; never render PDF text or page screenshots.
                  bytes=new Uint8Array(await retryAsset(()=>page.evaluate(async data=>{const bitmap=await createImageBitmap(new Blob([new Uint8Array(data)]));try{if(bitmap.width*bitmap.height>16_777_216)throw new Error('ImagePixelLimitExceeded');const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);canvas.getContext('2d')?.drawImage(bitmap,0,0);return Array.from(new Uint8Array(await(await canvas.convertToBlob({type:'image/png'})).arrayBuffer()));}finally{bitmap.close();}},Array.from(bytes))));mediaType=imageSignature(bytes);
                }
                if(!mediaType||bytes.length>20*1024*1024||total+bytes.length>100*1024*1024)continue;total+=bytes.length;images.push({...entry,path:`image:${images.length+1}`,mediaType,bytes});}
              catch{logger({event:'url-capture-image-unavailable',ownerId,failureKind:'KnowledgeBrowserImageReadFailed'});}
            }
          }catch{logger({event:'url-capture-images-unavailable',ownerId,failureKind:'KnowledgeBrowserImageReadFailed'});}
          if(rejection)throw new Error(rejection);

          result=bytes.byteLength>104_857_600||new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-' ? fail('MaterialByteLimitExceeded') : images.length?packUrlCapture({sourceUrl:url,responseUrl:page.url(),pdf:bytes,images}):{ok:true,value:bytes};
          if(!result.ok&&result.error.kind==='MaterialByteLimitExceeded'&&bytes.byteLength<=104_857_600&&new TextDecoder().decode(bytes.subarray(0,5))==='%PDF-'){logger({event:'url-capture-images-unavailable',ownerId,failureKind:result.error.kind});result={ok:true,value:bytes};}
          }
        }
      }
    }catch(error){result=fail(error instanceof Error&&error.name==='TimeoutError'?'KnowledgeBrowserTimedOut':'KnowledgeBrowserNavigationFailed');}
    finally {
      clearTimeout(timer);
      if(browser)try{await browser.close();}catch{closeFailed=true;}
      const reconciled=await capacity.reconcile({reservation:reserved.value,outcome:closeFailed?'uncertain':browser?'completed':'uncertain',measuredMilliseconds:Math.max(0,now()-started)});
      if(!reconciled.ok)result=reconciled;
      if(closeFailed)result=fail('BrowserRunSessionCloseFailed');
      logger({event:result.ok?'url-capture-success':'url-capture-failure',ownerId,...(result.ok?{}:{failureKind:result.error.kind})});
    }
    return result;
  };
}
