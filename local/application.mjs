import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import webPush from 'web-push';
import { createCloudflareDiscoveryWorker, YouTubeQuotaDurableObject, PublisherTranscriptAuthorizationDurableObject } from '../worker/main.js';
import { executeKnowledgeWorkflow } from '../worker/knowledge-workflow-executor.mjs';
import { resumeInterruptedKnowledgeWorkflows } from '../worker/knowledge-workflow-auto-resume.js';
import { createKnowledgeWorkflowRestrictionReaper } from '../worker/knowledge-workflow-reaper.js';
import { D1QuizRepository } from '../worker/knowledge-workflow-content-d1.js';
import { createReminderRuntime } from '../worker/reminders/runtime.js';
import { createAcquisitionRuntime } from '../acquisition/runtime.ts';
import { createImageDecoder } from '../acquisition/image-decoder.ts';
import { ACQUISITION_POLICY } from '../worker/acquisition-policy.js';
import { openLocalDatabase, createFileBucket, durableSqlStorage } from './storage.mjs';
import { createAgentConfigurationLoader } from '../src/features/knowledge-workflows/config.js';
import { createLocalAuth } from './auth.mjs';
import { createLocalWorkflows } from './workflows.mjs';
import { localImages } from './images.mjs';
import { createAcquisitionClient, createAcquisitionWorkflowBrowser } from '../worker/acquisition-client.js';
import { createFirecrawlWorkflowBrowser } from '../worker/firecrawl-browser.js';
import { createFirecrawlPdfCapture } from '../worker/firecrawl-pdf.js';
import { resolvePublicAddresses } from '../worker/knowledge-workflow-network.js';

const roles=['rights-assessor','knowledge-scraper','question-generator','question-evaluator'];
const providerKeys=['OPENROUTER_API_KEY','FIRECRAWL_API_KEY','BRAVE_SEARCH_API_KEY','YOUTUBE_API_KEY','TADDY_USER_ID','TADDY_API_KEY'];
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.woff2':'font/woff2','.webmanifest':'application/manifest+json'};

export async function createLocalApplication({root,dataDirectory,password,origin='http://127.0.0.1:8787',port=8787,environment={},fetch=globalThis.fetch,acquisitionBinding,logger=entry=>console.info(JSON.stringify(entry))}) {
  await mkdir(dataDirectory,{recursive:true,mode:0o700});
  const database=await openLocalDatabase(join(dataDirectory,'resonance.sqlite'),root);
  let workflows;
  try {
    const auth=createLocalAuth({database,password,origin,port});
    const bucket=await createFileBucket(join(dataDirectory,'objects'),database);
    const configPath=join(dataDirectory,'credentials.json');
    let credentials;
    try { const text=await readFile(configPath,'utf8');try{credentials=JSON.parse(text);}catch{throw new Error('Local credentials are invalid; restore credentials.json from your backup.');} }
    catch(error){if(error.code!=='ENOENT')throw error;credentials={cursorSecret:randomBytes(32).toString('hex'),acquisitionToken:randomBytes(32).toString('hex'),vapid:webPush.generateVAPIDKeys()};await writeFile(configPath,JSON.stringify(credentials),{mode:0o600,flag:'wx'});}
    if(typeof credentials.cursorSecret!=='string'||credentials.cursorSecret.length<32||typeof credentials.acquisitionToken!=='string'||credentials.acquisitionToken.length<32||!credentials.vapid?.publicKey||!credentials.vapid?.privateKey)throw new Error('Local credentials are invalid; restore credentials.json from your backup.');
    const sources=Object.fromEntries(await Promise.all(roles.map(async role=>[role,await readFile(join(root,'agent-config',`${role}.yaml`),'utf8')])));
    const loader=createAgentConfigurationLoader({sha256:async value=>`sha256:${createHash('sha256').update(value).digest('hex')}`});
    const digests={};
    for(const role of roles){const loaded=await loader.load({source:sources[role],expectedRole:role});if(!loaded.ok)throw new Error(`Local agent configuration failed: ${loaded.error.kind}`);digests[role]=loaded.value.digest;}
    const acquisition=acquisitionBinding??{fetch:createAcquisitionRuntime({
      policy:ACQUISITION_POLICY,tokens:new Map([[credentials.acquisitionToken,'local-owner']]),
      chromePath:resolve(dataDirectory,'unused-browser'),nodePath:process.execPath,platform:'portable',nowMs:Date.now,
      logger,maximumActive:2,maximumRetained:100,retentionMilliseconds:60_000,
      transport:{kind:'loopback-fixture'},decodeImage:createImageDecoder({policy:ACQUISITION_POLICY,nodePath:process.execPath}),
    }).handler};
    const env={
      ALLOWED_ORIGIN:'https://local-resonance.invalid',ACCESS_ISSUER:auth.issuer,ACCESS_AUDIENCE:auth.audience,
      ACCESS_OWNER_EMAIL:'owner@local.invalid',ACCESS_OWNER_ID:'self-host-owner-v1',TRANSCRIPT_LANGUAGES:'en',
      SOURCE_LIBRARY_DB:database,SOURCE_CONTENT_BUCKET:bucket,IMAGES:localImages,
      SOURCE_CURSOR_SECRET:credentials.cursorSecret,SOURCE_INGESTION_POLICY_VERSION:'bounded-source-v1',
      SOURCE_MANUAL_MAX_BYTES:'104857600',SOURCE_MANUAL_MAX_CHARACTERS:'1000000',
      SOURCE_MANUAL_MEDIA_TYPES:'text/plain,text/vtt,image/png,image/jpeg,image/webp,image/gif',
      SOURCE_R2_ACCOUNT_SCOPE:'self-host-r2-v1',SOURCE_R2_STORED_BYTES_LIMIT:'8589934592',
      SOURCE_R2_CLASS_A_MONTHLY_LIMIT:'100000',SOURCE_R2_CLASS_B_MONTHLY_LIMIT:'1000000',SOURCE_R2_OBSERVATION_MAX_AGE_MS:'86400000',
      YOUTUBE_SEARCH_DAILY_LIMIT:'100',YOUTUBE_GENERAL_DAILY_LIMIT:'10000',
      KNOWLEDGE_WORKFLOW_ENABLED:'true',KNOWLEDGE_WORKFLOW_CONFIG_DIGESTS:JSON.stringify(digests),
      PUBLIC_ACQUISITION:acquisition,PUBLIC_ACQUISITION_ENDPOINT:'https://acquisition.local.invalid',PUBLIC_ACQUISITION_TOKEN:credentials.acquisitionToken,
      VAPID_PUBLIC_KEY:credentials.vapid.publicKey,VAPID_PRIVATE_KEY:credentials.vapid.privateKey,VAPID_SUBJECT:origin.startsWith('https:')?origin:'mailto:owner@local.invalid',
      REMINDER_PUSH_ORIGINS:JSON.stringify(['https://fcm.googleapis.com']),
    };
    for(const key of providerKeys)if(typeof environment[key]==='string'&&environment[key].trim())env[key]=environment[key].trim();
    const shutdown=new AbortController();
    const outbound=async(input,init)=>new URL(input instanceof Request?input.url:input).href===auth.jwksUrl?Response.json(auth.jwks):fetch(input,{...init,signal:AbortSignal.any([shutdown.signal,...(init?.signal?[init.signal]:input instanceof Request?[input.signal]:[])])});
    workflows=createLocalWorkflows({database,execute:(event,step)=>executeKnowledgeWorkflow(env,event,step,sources,outbound),logger:message=>logger(JSON.parse(message))});
    env.KNOWLEDGE_WORKFLOW=workflows;
    env.YOUTUBE_QUOTA={fetch:(input,init)=>youtubeQuota.fetch(new Request(input,init))};
    env.TRANSCRIPT_AUTHORIZATION={fetch:(input,init)=>transcriptAuthorization.fetch(new Request(input,init))};
    const storage=durableSqlStorage(database);
    const youtubeQuota=new YouTubeQuotaDurableObject({storage},env);
    const transcriptAuthorization=new PublisherTranscriptAuthorizationDurableObject({storage});
    database.sqlite.exec('CREATE TABLE IF NOT EXISTS local_pdf_credits (capture_id TEXT NOT NULL, reservation_id TEXT PRIMARY KEY, credits INTEGER NOT NULL, ttl_seconds INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT');
    const client=createAcquisitionClient({binding:acquisition,endpoint:env.PUBLIC_ACQUISITION_ENDPOINT,token:env.PUBLIC_ACQUISITION_TOKEN,policy:ACQUISITION_POLICY,createId:()=>crypto.randomUUID()});
    const urlCapture=createFirecrawlPdfCapture({fetch:outbound,resolveAddresses:hostname=>resolvePublicAddresses(hostname,outbound),now:Date.now,logger,createBrowser:()=>{
      const captureId=crypto.randomUUID(),robots=createAcquisitionWorkflowBrowser({client,policy:ACQUISITION_POLICY,logger});
      return createFirecrawlWorkflowBrowser({apiKey:env.FIRECRAWL_API_KEY??null,fetch:outbound,policy:ACQUISITION_POLICY,resolveAddresses:hostname=>resolvePublicAddresses(hostname,outbound),nowMs:Date.now,logger,readRobots:robots.readRobots,closeRobots:robots.close,
        reserveSession:async({credits,ttlSeconds})=>{
          const written=database.sqlite.prepare('INSERT INTO local_pdf_credits SELECT ?,?,?,?,? WHERE COALESCE((SELECT SUM(credits) FROM local_pdf_credits WHERE capture_id=?),0)<=100-?').run(captureId,crypto.randomUUID(),credits,ttlSeconds,new Date().toISOString(),captureId,credits);
          return written.changes===1?{ok:true,value:null}:{ok:false,error:{kind:'BrowserCreditLimitExceeded'}};
        },
      });
    }});
    const pending=new Set();
    const worker=createCloudflareDiscoveryWorker(env,{fetch:outbound,urlCapture,now:()=>new Date(),subtle:crypto.subtle,randomBytes:length=>crypto.getRandomValues(new Uint8Array(length)),waitUntil:promise=>{pending.add(promise);promise.catch(()=>logger({event:'local-background-failure'})).finally(()=>pending.delete(promise));}});
    if(!worker.ok)throw new Error(`Local application configuration failed: ${worker.error.field??worker.error.kind}`);
    const reminders=createReminderRuntime({environment:env,database,now:()=>new Date(),fetch:outbound,logger});
    const quizRepository=new D1QuizRepository({database,bucket,now:()=>new Date().toISOString(),logger});
    const reaper=createKnowledgeWorkflowRestrictionReaper({database,quizRepository,now:()=>new Date().toISOString(),logger});
    let timer,tickPromise;
    function tick(){
      if(tickPromise)return tickPromise;
      tickPromise=(async()=>{
        for(const result of await Promise.all([resumeInterruptedKnowledgeWorkflows({database,binding:workflows,ownerId:env.ACCESS_OWNER_ID,now:()=>new Date().toISOString(),logger}),reminders.run(),reaper.run()]))if(!result.ok)logger({event:'local-schedule-failure',failureKind:result.error.kind});
      })().finally(()=>{tickPromise=undefined;});
      return tickPromise;
    }
    return {
      database,environment:env,workflows,auth,
      async fetch(request){
        const denied=await auth.authorize(request);if(denied)return denied;
        const url=new URL(request.url);
        if(url.pathname==='/api'||url.pathname.startsWith('/api/')){
          const headers=new Headers(request.headers);
          headers.set('cf-access-jwt-assertion',auth.assertion());
          if(headers.has('origin'))headers.set('origin',env.ALLOWED_ORIGIN);
          const backendUrl=new URL(url.pathname+url.search,env.ALLOWED_ORIGIN);
          const rewritten=new Request(backendUrl,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,duplex:'half',signal:request.signal});
          const result=await worker.value.fetch(rewritten);
          const responseHeaders=new Headers(result.headers);
          if(responseHeaders.get('access-control-allow-origin')===env.ALLOWED_ORIGIN)responseHeaders.set('access-control-allow-origin',request.headers.get('origin')??url.origin);
          return new Response(result.body,{status:result.status,headers:responseHeaders});
        }
        if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed.',{status:405});
        let pathname;
        try{pathname=decodeURIComponent(url.pathname);}catch{return new Response('Not found.',{status:404});}
        if(pathname.includes('\0'))return new Response('Not found.',{status:404});
        const directory=resolve(root,'dist'),path=resolve(directory,`.${pathname==='/'?'/index.html':pathname}`);
        if(!path.startsWith(directory+sep))return new Response('Not found.',{status:404});
        try{
          const bytes=await readFile(path),extension=path.slice(path.lastIndexOf('.'));
          return new Response(request.method==='HEAD'?null:bytes,{headers:{'content-type':mime[extension]??'application/octet-stream','cache-control':extension==='.html'?'no-store':'private, max-age=3600','x-content-type-options':'nosniff'}});
        }catch(error){if(['ENOENT','EISDIR','ENOTDIR'].includes(error.code))return new Response('Not found.',{status:404});throw error;}
      },
      async start(){
        for(const row of database.sqlite.prepare("SELECT w.id FROM local_workflows w JOIN knowledge_workflow_runs r ON r.run_id=json_extract(w.payload,'$.runId') AND r.owner_id=json_extract(w.payload,'$.ownerId') WHERE w.status='errored' AND r.state='source-added'").all())await (await workflows.get(row.id)).restart();
        workflows.restore();await tick();timer=setInterval(()=>{void tick().catch(()=>logger({event:'local-schedule-failure'}));},60_000);timer.unref();},
      async close(){if(timer)clearInterval(timer);shutdown.abort();await workflows.close();await Promise.allSettled([...pending,...(tickPromise?[tickPromise]:[])]);database.close();},
    };
  }catch(error){await workflows?.close();database.close();throw error;}
}
