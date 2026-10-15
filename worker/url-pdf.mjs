import { createRobotsGate } from '../src/features/knowledge-workflows/robots.js';
import puppeteer from '@cloudflare/puppeteer';
import { validatePublisherDestination } from './destination-policy.js';
import { resolvePublicAddresses } from './knowledge-workflow-network.js';

// One explicitly selected public page; source traversal remains the learner's choice.
/** @param {{binding:import('@cloudflare/puppeteer').BrowserWorker,capacity:Pick<import('./browser-run-capacity-d1.js').D1BrowserRunCapacityLedger,'reserve'|'reconcile'>,fetch:typeof globalThis.fetch,now:()=>number,logger:(entry:{event:string,ownerId:string,failureKind?:string})=>void,launcher?:Pick<typeof puppeteer,'launch'>}} dependencies */
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
    if(!authorized.ok)return fail('KnowledgeBrowserNetworkRejected');
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
      await page.setUserAgent("knowledge-platform");
      /** @type {string|null} */ let rejection=null;
      await page.setRequestInterception(true);
      page.on('request',async request=>{
        try {
          const target=request.url();
          if(target.startsWith('data:')||target==='about:blank')return await request.continue();
          const checked=validatePublisherDestination(target);
          const resolved=checked.ok ? await lookup(new URL(target).hostname) : {ok:false};
          if(!resolved.ok){
            rejection='KnowledgeBrowserNetworkRejected';
            return await request.abort();
          }
          if(!['GET','HEAD'].includes(request.method()))return await request.abort();
          await request.continue();
        }catch{rejection='KnowledgeBrowserNetworkRejected';await request.abort().catch(()=>{});}
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
          if(rejection)throw new Error(rejection);
          const bytes=await page.pdf({format:'A4',printBackground:true,timeout:Math.max(1,reserved.value.reservedMilliseconds-(now()-started))});
          result=bytes.byteLength>104_857_600||new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-' ? fail('MaterialByteLimitExceeded') : {ok:true,value:bytes};
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
