import {readFileSync,writeFileSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Fixed runtime-capability probe; no page navigation, model calls or learner data.
// Uses the original isolated grant and original activation/deadline.
const directory=resolve('test-results/openlearn-navigation-20261013');
const contract=JSON.parse(readFileSync(resolve(directory,'live-contract.json'),'utf8'));
const snapshot=JSON.parse(readFileSync(resolve(directory,'snapshot-result.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const entry=readFileSync(new URL(import.meta.url));
const gate=JSON.parse(readFileSync(resolve(directory,'probe-gate.json'),'utf8'));
if(gate.decision!=='PASS'||gate.probeSha256!==hash(entry)||gate.snapshotDigest!==snapshot.digest||gate.contractSha256!==hash(readFileSync(resolve(directory,'live-contract.json'))))throw new Error('CapabilityProbeGateMissing');
const {createOpenLearnNavigationBudget}=await import(pathToFileURL(snapshot.path+'/files/scripts/openlearn-navigation-budget.mjs').href);
process.loadEnvFile('.env');
const budget=createOpenLearnNavigationBudget({storePath:contract.storePath,metadata:contract.modelMetadata});
const lockPath=resolve(directory,'live-run.lock');
const statePath=resolve(directory,'live-state.json');
const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{version:'openlearn-live-state-v1',sourceUrl:contract.sourceUrl,plan:null,processedPages:[],robotsEvidence:null};
if(state.cleanupUnconfirmedUntilMs&&Date.now()<state.cleanupUnconfirmedUntilMs)throw new Error('PriorCleanupUnconfirmed');
const lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,JSON.stringify({pid:process.pid,scope:'fixed-capability-probe'})+'\n');
let id=null,output=null,cleanup=null,launchDispatched=false;
const request=async(path,method,body)=>{
  const current=budget.snapshot();if(!current.ok)throw new Error(current.error.kind);
  const remaining=current.value.deadlineAtMs===null?30000:current.value.deadlineAtMs-Date.now();
  if(method!=='DELETE'&&(current.value.halted||remaining<=0))throw new Error(current.value.halted??'OriginalDeadlineExceeded');
  const timeout=method==='DELETE'?30000:Math.min(30000,remaining);
  if(method==='POST'&&path==='')launchDispatched=true;
  const response=await fetch('https://api.firecrawl.dev/v2/interact'+path,{method,headers:{Authorization:'Bearer '+process.env.FIRECRAWL_API_KEY,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout)});
  return {status:response.status,body:await response.json()};
};
try {
  const admitted=await budget.reserveSession({credits:4,ttlSeconds:120});if(!admitted.ok)throw new Error(admitted.error.kind);
  const created=await request('','POST',{ttl:120,activityTtl:120,streamWebView:false,blockAds:true});
  if(!created.body.success||typeof created.body.id!=='string')throw new Error('CapabilitySessionUnavailable');
  id=created.body.id;
  const code=`try { const dns = require('node:dns').promises; console.log(JSON.stringify({dnsLookup:typeof dns.lookup,page:typeof page,route:typeof page?.route,unroute:typeof page?.unroute})); } catch (error) { console.log(JSON.stringify({errorName:error.name,errorCode:error.code??null,message:error.message})); }`;
  const executed=await request('/'+encodeURIComponent(id)+'/execute','POST',{code,language:'node',timeout:15});
  const value=executed.body.stdout??executed.body.result;
  if(typeof value==='string'){
    try{const parsed=JSON.parse(value.trim().split('\n').at(-1));
      // Only known technical capability values and exception from the fixed import.
      output=Object.fromEntries(Object.entries(parsed).filter(([key,value])=>['dnsLookup','page','route','unroute','errorName','errorCode','message'].includes(key)&& (value===null||typeof value==='string')));
      if(typeof output.message==='string')output.message=output.message.replaceAll(process.env.FIRECRAWL_API_KEY,'[redacted]').replace(/(?:https?|wss?):\/\/\S+/g,'[url]').split('\n')[0].slice(0,250);
    }catch{output={status:executed.status,success:executed.body.success,exitCode:executed.body.exitCode,errorName:'ProbeOutputUnavailable'};}
  }else{const error=String(executed.body.error??executed.body.stderr??'ProbeOutputUnavailable').replaceAll(process.env.FIRECRAWL_API_KEY,'[redacted]').replace(/(?:https?|wss?):\/\/\S+/g,'[url]').split('\n')[0].slice(0,250);output={status:executed.status,success:executed.body.success,exitCode:executed.body.exitCode,errorName:'ProbeOutputUnavailable',message:error};}
}catch(error){output={errorName:error.message};}
finally{
  try{if(id){const closed=await request('/'+encodeURIComponent(id),'DELETE');cleanup={status:closed.status,confirmed:closed.body.success===true};}else if(launchDispatched)cleanup={confirmed:false,reason:'UnknownLaunch'};}catch{cleanup={confirmed:false,reason:'DeletionUnconfirmed'};}
  if(cleanup?.confirmed===false){state.cleanupUnconfirmedUntilMs=Date.now()+150000;writeFileSync(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});}
  const accounting=budget.snapshot();budget.close();closeSync(lock);unlinkSync(lockPath);
  const report={version:'fixed-browser-capability-probe-require-v2',recordedAt:new Date().toISOString(),output,cleanup,accounting,scope:'fixed DNS/Playwright capability introspection only; no model calls/page captures'};
  writeFileSync(resolve(directory,'browser-capability-probe.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report));
}
