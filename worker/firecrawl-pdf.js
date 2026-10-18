// @ts-check
import { createRobotsGate } from '../src/features/knowledge-workflows/robots.js';
import { packUrlCapture } from '../src/features/knowledge-workflows/url-capture.js';
import { validatePublisherDestination } from './destination-policy.js';

/** The computer backend uses the same isolated provider as web extraction.
 * @param {{createBrowser:()=>ReturnType<import('./firecrawl-browser.js').createFirecrawlWorkflowBrowser>,fetch:typeof fetch,resolveAddresses:(hostname:string)=>Promise<{ok:true,value:readonly string[]}|{ok:false,error:{kind:string}}>,now:()=>number,logger:(entry:{event:string,ownerId:string,failureKind?:string})=>void}} dependencies */
export function createFirecrawlPdfCapture(dependencies) {
  return async (/** @type {{ownerId:string,url:string}} */ {ownerId,url}) => {
    if(!validatePublisherDestination(url).ok)return {ok:/** @type {const} */(false),error:{kind:'SourceExtractionUrlInvalid'}};
    const browser=dependencies.createBrowser();
    /** @type {{ok:true,value:Uint8Array}|{ok:false,error:{kind:string}}} */
    let result;
    try {
      result=await (async()=>{
        const rootUrl=new URL(url).origin;
        const observed=await browser.readPage({url,rootUrl});
        if(!observed.ok)return observed;
        const page=observed.value;
        const robots=await createRobotsGate({fetch:dependencies.fetch,fetchRobots:browser.readRobots,resolveAddresses:dependencies.resolveAddresses,now:()=>new Date(dependencies.now()).toISOString(),robotsUnavailablePolicy:'allow-unverified-if-public',verifyTargetReachable:async()=>({ok:true,value:null}),logger:entry=>dependencies.logger({...entry,ownerId})}).check({rights:{status:'allowed',canonicalUrl:page.responseUrl},userAgent:'knowledge-platform'});
        if(!robots.ok)return robots;
        const pdf=await browser.capturePdf({url:page.responseUrl,rootUrl});
        if(!pdf.ok)return pdf;
        /** @type {import('../src/features/knowledge-workflows/url-capture.js').CapturedImage[]} */const images=[];
        const blocks=new Map(page.evidence.blocks.map(block=>[block.id,block.text]));
        for(const image of page.evidence.images){
          const read=await browser.readImage({url:image.url,pageUrl:page.responseUrl,rootUrl,maximumBytes:20*1024*1024});
          if(!read.ok){dependencies.logger({event:'url-capture-image-unavailable',ownerId,failureKind:read.error.kind});continue;}
          const occurrence=image.occurrences[0];
          images.push({path:`image:${images.length+1}`,url:image.url,alt:occurrence?.alt??'',caption:blocks.get(occurrence?.captionId??'')??'',context:[...new Set(image.occurrenceWindows.flat())].map(id=>blocks.get(id)??'').filter(Boolean).join('\n'),mediaType:read.value.mediaType,bytes:read.value.bytes});
        }
        return packUrlCapture({sourceUrl:url,responseUrl:page.responseUrl,pdf:pdf.value,images});
      })();
    } catch(error) {
      if(!(error instanceof Error))throw error;
      dependencies.logger({event:'url-capture-failure',ownerId,failureKind:'KnowledgeBrowserCaptureFailed'});
      result={ok:false,error:{kind:'KnowledgeBrowserCaptureFailed'}};
    } finally {
      const closed=await browser.close();
      if(!closed.ok)result={ok:false,error:closed.error};
    }
    return result;
  };
}
