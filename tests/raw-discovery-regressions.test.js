// @ts-check
// Raw-provider regressions extracted from the preserved legacy review-blockers test.
// All provider/HTTP responses are synthetic; no actual model quality is claimed.
import { createYouTubeSearchProvider } from '../worker/youtube-search-provider.js';
import { createBraveSearchProvider } from '../worker/brave-search-adapter.js';
import { createCentralDiscoverySearch } from '../worker/discovery-search.js';
import { createEducationalSearchPolicy } from '../worker/educational-search-policy.js';
import { DiscoverySearchGatewayClient } from '../src/features/discovery/gateway.js';
import { createDiscoveryPage } from '../src/startup/discovery-page.js';
import { MemoryPersistence } from '../src/persistence/memory.js';
import { SourceLibraryService } from '../src/features/source-library/service.js';
import { D1SourceLibraryRepository } from '../worker/source-library-d1.js';
/** @param {unknown} actual @param {unknown} expected */
function equal(actual, expected) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
const url = 'https://material.example/harmony';
const policy = createEducationalSearchPolicy({version:'source-quality-v1',maximumSubmittedCharacters:120,maximumProviderCharacters:240});
const braveConfig = {providerId:'web',label:'Web',resultKind:'web',priority:1,enabled:true,maximumResults:20,apiVersion:'1'};
function candidate() { return {providerId:'web',resultKind:'web',sourceLevel:/** @type {const} */('document'),title:'Harmony',description:null,canonicalUrl:url,publisherLabel:null,publishedAt:null,identityEvidence:[{attribute:'provider-result-page',value:url,provenanceUrl:url}]}; }
/** @param {readonly unknown[]} items */
function envelope(items) {return {items,providerFailures:[],submittedQuery:'harmony',providerQuery:'harmony',policyVersion:'raw-v1'};}
Deno.test('review blocker 1: real YouTube provider -> UI approval/rejection -> D1 bindings retain no description', async()=>{
  const preview = 'TRANSIENT_DESCRIPTION_DO_NOT_RETAIN';
  const provider = createYouTubeSearchProvider({providerId:'youtube',label:'YouTube',resultKind:'video',priority:1,enabled:true},{adapter:{search:async()=>({ok:true,value:[{videoId:'video-a',channelId:'channel-a',title:'Transient title',description:preview,publisherLabel:'Channel',publishedAt:'2026-10-05T00:00:00.000Z',canonicalUrl:'https://www.youtube.com/watch?v=video-a',embedUrl:'https://www.youtube-nocookie.com/embed/video-a',madeForKids:false,refreshBy:'2026-11-04T00:00:00.000Z'}]})}});
  const provided = await provider.search({providerId:'youtube',query:'harmony',limit:1});
  if(!provided.ok) throw new Error(provided.error.kind);
  equal(provided.value[0].description,preview);
  /** @type {(string|number|null)[][]} */ const writes=[];
  /** @type {import('../worker/source-library-d1.js').D1DatabasePort} */ const database={
    prepare(query) { let bindings=/** @type {(string|number|null)[]} */([]); const statement=/** @type {import('../worker/source-library-d1.js').D1Statement} */({bind(...values){bindings=[...values];return statement;},first:async()=>query.includes('FROM interest_areas')?{interest_area_id:'area-a'}:null,all:async()=>({success:true,results:[]}),run:async()=>{writes.push(bindings);return {success:true,meta:{changes:1}};}});return statement;},
    batch:async statements=>{for(const statement of statements) await statement.run();return statements.map(()=>({success:true,meta:{changes:1}}));}
  };
  let id=0;const now=()=> '2026-10-05T00:00:00.000Z';
  const service=new SourceLibraryService({repository:new D1SourceLibraryRepository(database),createId:()=>`db-${++id}`,now,ingestionPolicyVersion:'fixture'});
  const markup=JSON.parse((await Deno.readTextFile('index.html')).match(/<script id="app-copy" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? '{}').discoverMarkup;
  /** @type {string[]} */ const errors=[];
  const page=createDiscoveryPage({ownerId:'owner-a',persistence:new MemoryPersistence(),gatewayBaseUrl:'https://app.example/',starterInventory:JSON.parse(await Deno.readTextFile('assets/discovery-starters.json')),markup,escapeHtml:value=>value,createId:()=>`ui-${++id}`,now,policyStorage:{getItem:()=>JSON.stringify({version:'youtube-api-services-v1',acceptedAt:now()}),setItem:()=>{}},onNotice:()=>{},onError:value=>errors.push(value),navigateToLibrary:()=>{},navigateToUpload:()=>{},rerender:()=>{},fetch:async(input,init)=>{
    const request=new Request(input,init);const path=new URL(request.url).pathname;
    if(path.endsWith('/capabilities'))return Response.json({result:[provider.descriptor]});
    if(path==='/api/source-library')return Response.json({result:{items:[],interestAreas:[{id:'area-a',ownerId:'owner-a',title:'Music',provenance:'configured'}],nextCursor:null}});
    if(path.endsWith('/suppressions/check'))return Response.json({result:[]});
    if(path.endsWith('/search'))return Response.json({result:envelope(provided.value)});
    const command=await request.json();
    if(path.endsWith('/approve')){const result=await service.approve({...command,ownerId:'owner-a'});if(!result.ok)throw new Error(result.error.kind);return Response.json({result:result.value});}
    if(path.endsWith('/reject')){const result=await service.reject({...command,ownerId:'owner-a'});if(!result.ok)throw new Error(result.error.kind);return Response.json({result:result.value});}
    throw new Error(`Unexpected fixture path ${path}`);
  }});
  await page.load();await page.search({query:'harmony',providerIds:['youtube'],limit:5});
  const rendered=page.render({online:true,selectedItemId:null});const itemId=rendered.match(/data-discovery-item-id="([^"]+)"/)?.[1];
  if(!itemId)throw new Error(`No provider result rendered: ${errors.join(',')}`);
  await page.approve(itemId,'area-a');equal(writes.length,0);await page.reject(itemId);
  equal(errors,['Extraction is unavailable for this format. Explore the source or provide permitted learning material.']);equal(writes.length,1);
  equal(JSON.stringify(writes).includes(preview),false);
  equal(JSON.stringify(writes).includes('youtube-api-description'),false);
});


Deno.test('raw Brave duplicates preserve exact snippets and both attributed authors without assessment',async()=>{
  const claims=['Alice: explanatory musical examples','Bob: unrelated promotion'];
  const provider=createBraveSearchProvider(braveConfig,{credential:()=>({ok:true,value:'fixture'}),fetch:async()=>Response.json({web:{results:claims.map((description,index)=>({url,title:'Harmony',description,author:['Alice','Bob'][index]}))}})});
  const result=await createCentralDiscoverySearch({maximumLimit:20},{policy,providers:[provider],budget:{timeoutMs:25000,now:Date.now,timeoutSignal:AbortSignal.timeout}}).search({query:'harmony',providerIds:['web'],limit:2});
  equal(result.ok,true);if(!result.ok)throw new Error(result.error.kind);
  equal(result.value.items.map(item=>item.description),claims);
  equal(result.value.items.flatMap(item=>item.identityEvidence).filter(entry=>entry.attribute==='provider-result-author').map(entry=>entry.value),['Alice','Bob']);
});

for(const stage of ['providers']) {
  Deno.test(`review blocker 4: shared deadline aborts actual ${stage} fetch and discards late completion without retries`,async()=>{
    /** @type {AbortSignal|null} */let retrievalSignal=null;let retrievalCalls=0;
    const provider=createBraveSearchProvider(braveConfig,{credential:()=>({ok:true,value:'fixture'}),fetch:async(_input,init)=>{
      retrievalCalls++;retrievalSignal=init?.signal ?? null;
      if(stage==='providers')await new Promise(resolve=>setTimeout(resolve,80));
      return Response.json({web:{results:[{url,title:'Harmony',description:'Attributed musical explanation'}]}});
    }});
    const dependencies={policy,providers:[provider],budget:{timeoutMs:40,now:Date.now,timeoutSignal:AbortSignal.timeout}};
    const result=await createCentralDiscoverySearch({maximumLimit:20},dependencies).search({query:'harmony',providerIds:['web'],limit:1});
    // Let the deliberately uncooperative transport settle; it must never trigger a later assessment/retry.
    await new Promise(resolve=>setTimeout(resolve,100));
    equal(result.ok,false);if(!result.ok)equal(result.error,{kind:'CentralSearchTimedOut',stage});
    equal(retrievalCalls,1);
    equal((/** @type {AbortSignal|null} */(retrievalSignal))?.aborted,true);
  });
}


Deno.test('raw retrieval exceeding the shared clock is discarded',async()=>{
  let now=0;
  const provider=createBraveSearchProvider(braveConfig,{credential:()=>({ok:true,value:'fixture'}),fetch:async()=>{now=26000;return Response.json({web:{results:[{url,title:'Harmony',description:'Unreviewed explanation'}]}});}});
  const result=await createCentralDiscoverySearch({maximumLimit:20},{policy,providers:[provider],budget:{timeoutMs:25000,now:()=>now,timeoutSignal:()=>new AbortController().signal}}).search({query:'harmony',providerIds:['web'],limit:1});
  equal(result,{ok:false,error:{kind:'CentralSearchTimedOut',stage:'providers'}});
});

Deno.test('shared deadline causes an actual in-flight fetch abort rejection',async()=>{
  let aborted=0;
  const provider=createBraveSearchProvider(braveConfig,{credential:()=>({ok:true,value:'fixture'}),fetch:(_input,init)=>new Promise((_resolve,reject)=>{if(!init?.signal)throw new Error('Missing provider abort signal');init.signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('Synthetic aborted fetch','AbortError'));},{once:true});})});
  const result=await createCentralDiscoverySearch({maximumLimit:20},{policy,providers:[provider],budget:{timeoutMs:20,now:Date.now,timeoutSignal:AbortSignal.timeout}}).search({query:'harmony',providerIds:['web'],limit:1});
  equal(aborted,1);equal(result,{ok:false,error:{kind:'CentralSearchTimedOut',stage:'providers'}});
});

Deno.test('gateway never accepts a transport completion after its own deadline',async()=>{
  const item={...candidate(),description:'Attributed summary'};
  const client=new DiscoverySearchGatewayClient({baseUrl:'https://app.example/',timeoutMs:5,fetch:async()=>{await new Promise(resolve=>setTimeout(resolve,20));return Response.json({result:envelope([item])});}});
  equal(await client.search({query:'harmony',providerIds:['web'],limit:1}),{ok:false,error:{kind:'DiscoveryGatewayTimedOut'}});
  await new Promise(resolve=>setTimeout(resolve,25)); // Complete the deliberate ignored transport timer after asserting the deadline.
});


Deno.test('HTTP boundary returns named 503 failures for bounded timeouts and unsupported source claims',async()=>{
  const {createDiscoveryWorker}=await import('../worker/handler.js');
  /** @type {import('../worker/discovery-search.js').CentralSearchFailure[]} */ const failures=[{kind:'CentralSearchTimedOut',stage:'providers'}];
  for(const failure of failures){
    const worker=createDiscoveryWorker({allowedOrigin:'https://app.example',maximumCommandBytes:512},{authenticate:async()=>({ok:true,value:{ownerId:'owner-a',email:'fixture@example.test'}}),acquireRss:async()=>({ok:false,error:{kind:'DiscoveryFetchUnavailable'}}),centralSearch:{capabilities:()=>[],search:async()=>({ok:false,error:failure})}});
    const response=await worker.fetch(new Request('https://worker.example/api/discovery/search',{method:'POST',body:JSON.stringify({query:'harmony',providerIds:['web'],limit:1})}));
    equal(response.status,503);equal(await response.json(),{error:failure.kind});
  }
});
