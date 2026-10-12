import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluationTransport,createEstimatedRequestPlanner} from '../scripts/evaluation-budget.mjs';
import {readFrozenEvaluationCatalog} from './fixtures/evaluation/catalog.mjs';
// Synthetic ledger port/provider replies; actual counted transport and finite clocks.
// No paid requests or model-accuracy claim.
const ok=value=>({ok:true,value}),flush=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
const decision={authority:'Synthetic offline timer contract',source:'benchmark-native-timeout.test.mjs',decision:'TreatUSD5asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'};
function ledgerPort(deadline){const rows=new Map();let cancelled=false,active=0;
 return {rows,ledger:{runtimePolicy:{maximumAdditionalRecoveries:null},accountingMode:'estimated',ownerDecision:decision,
  snapshot:()=>ok({deadlineAtMs:deadline,effectiveDeadlineAtMs:deadline,runtimeDeadlineAtMs:deadline,effectiveCancelled:cancelled,cancelled,admissionHalted:null,activeRequests:active}),
  reserve(c){rows.set(c.key,{...c,response:null});return ok(c);},complete(c){Object.assign(rows.get(c.key),c);return ok(null);},
  uncertain(c){const row=rows.get(c.key);if(row){row.uncertain=true;row.recoverable=!!(c.recoverableExternal||c.recoverableTimeout);}return {ok:false,error:{kind:c.kind}};},
  recoveryCandidate(base){const latest=[...rows.values()].filter(row=>row.key===base||row.baseKey===base).at(-1);return ok(latest?.uncertain&&latest.recoverable?{failedKey:latest.key,nextKey:base+':recovery-'+rows.size,retryAtMs:Date.now(),attempt:rows.size}:null);},
  replayResponse:()=>ok(null),pacingDue:()=>ok({retryAtMs:Date.now(),cooldown:false}),haltExecution:()=>ok(null),cancel(){cancelled=true;return ok(null);},
  trackAccounting(promise){active++;promise.then(()=>active--,()=>active--);return promise;}
 }};
}
function profilesFor(catalog){const reviewer=structuredClone(catalog);reviewer.model.id='synthetic/reviewer';reviewer.model.canonical_slug='synthetic/reviewer-v1';
 const protocol={source:'Synthetic offline native protocol',responseFormat:'json_schema',reasoningEffort:'high',receiptOptional:true,provider:{sort:'throughput',require_parameters:true,allow_fallbacks:true}},roles={'knowledge-scraper':{catalog,version:catalog.model.canonical_slug,protocol},'review-grader':{catalog:reviewer,version:reviewer.model.canonical_slug,protocol}};
 return {source:'Synthetic roles',roles,benchmarkContract:{source:'Synthetic approval',readiness:'owner-authorized-first-development-case',excludedCreators:['openai','anthropic','google','luna'],approved:Object.values(roles).map(p=>({id:p.catalog.model.id,creator:p.catalog.model.id.split('/')[0],canonicalSlug:p.version,catalogSha256:p.catalog.catalogSha256,prompt:p.catalog.model.pricing.prompt,completion:p.catalog.model.pricing.completion}))}};
}
const output={decision:'pass',reasons:['Synthetic retained text supports this claim.'],feedback:'Keep the supported relationship.',matchedLessOftenIds:[],supportingImageEvidence:'',allowTextOnly:true};
const response=model=>Response.json({id:'synthetic-recovered',model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:1,completion_tokens:1,cost:0}});
const hanging=init=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));

async function transportFixture({t,plannerGate,waitGate,deadlineOffset=1800000,runtime=true,fetch,requestTimeoutMs=60000,callerSignal,explicit=true}={}){
 const catalog=await readFrozenEvaluationCatalog(),profiles=profilesFor(catalog),start=Date.now();let elapsed=0,calls=0;
 const port=ledgerPort(start+deadlineOffset);if(!runtime)delete port.ledger.runtimePolicy;
 const caller=callerSignal??new AbortController().signal,owner=new AbortController(),now=()=>start+elapsed,planner=createEstimatedRequestPlanner({metadata:catalog,costPolicy:{source:'Synthetic estimate',bytesPerToken:4,visualTokensPerImage:8000},sourceContract:decision,now}),logs=[];
 const transport=createEvaluationTransport({ledger:port.ledger,catalog,model:catalog.model.id,endpoint:'https://openrouter.ai/api/v1/chat/completions',iterationId:'synthetic-dispatch-timer',fetch:async(url,init)=>{calls++;return fetch?fetch(url,init,calls):response(catalog.model.id);},now,signal:owner.signal,logger:e=>logs.push(e),billingMode:'estimated',ownerDecision:decision,requestPlanner:async(...args)=>{if(plannerGate)await plannerGate;return planner(...args);},benchmarkContract:profiles.benchmarkContract,...(explicit?{requestTimeoutMs}:{}),...(waitGate?{wait:async()=>waitGate}:{} )});
 t.mock.timers.enable({apis:['setTimeout']});
 const begin=()=>transport('https://openrouter.ai/api/v1/chat/completions',{method:'POST',body:JSON.stringify({model:catalog.model.id,max_tokens:4096,messages:[{role:'user',content:'Constructed timer fixture.'}],provider:profiles.roles['knowledge-scraper'].protocol.provider}),signal:caller});
 return {port,owner,logs,begin,tick(ms){elapsed+=ms;t.mock.timers.tick(ms);},calls:()=>calls};
}
test('local planning may consume caller/window time without consuming the explicit physical attempt60s',async t=>{
 let plan,reply;const planning=new Promise(resolve=>{plan=resolve;}),provider=new Promise(resolve=>{reply=resolve;}),f=await transportFixture({t,plannerGate:planning,fetch:async()=>provider});
 try{
  const pending=f.begin();await flush();f.tick(40000);await flush();assert.equal(f.calls(),0);assert.equal(f.port.rows.size,0);plan();await flush();assert.equal(f.calls(),1);assert.equal(f.port.rows.size,1);
  f.tick(40000);await flush();assert.equal(f.calls(),1);assert.equal([...f.port.rows.values()][0].uncertain,undefined);reply(response((await readFrozenEvaluationCatalog()).model.id));const result=await pending;assert(result.ok);assert.equal(f.port.rows.size,1);assert.equal([...f.port.rows.values()][0].response.model,(await readFrozenEvaluationCatalog()).model.id);
 }finally{t.mock.timers.reset();}
});
test('local pacing wait does not consume physical60s and a dispatched timeout retains full reserve before accounted recovery',async t=>{
 let ready;const gate=new Promise(resolve=>{ready=resolve;}),catalog=await readFrozenEvaluationCatalog(),f=await transportFixture({t,waitGate:gate,fetch:async(_url,init,call)=>call===1?hanging(init):response(catalog.model.id)});f.port.ledger.runtimePolicy.renewal={};
 try{
  const pending=f.begin();await flush();f.tick(80000);await flush();assert.equal(f.calls(),0);assert.equal(f.port.rows.size,0);ready();await flush();assert.equal(f.calls(),1);f.tick(59000);await flush();assert.equal(f.calls(),1);f.tick(1000);await flush();const result=await pending;assert(result.ok);assert.equal(f.calls(),2);assert.equal(f.port.rows.size,2);const first=[...f.port.rows.values()][0];assert.equal(first.response,null);assert.equal(first.uncertain,true);assert.equal(first.recoverable,true);assert(first.costNanodollars>0);
 }finally{t.mock.timers.reset();}
});
for(const mode of ['caller','owner','window'])test(`pre-dispatch ${mode} deadline still stops planning without reservation or fetch`,async t=>{
 let finish;const gate=new Promise(resolve=>{finish=resolve;}),caller=new AbortController(),f=await transportFixture({t,plannerGate:gate,callerSignal:caller.signal,deadlineOffset:mode==='window'?30000:1800000});
 try{
  const pending=f.begin().catch(error=>error);await flush();if(mode==='caller')caller.abort(new DOMException('Hard logical caller deadline','TimeoutError'));else if(mode==='owner')f.owner.abort(new DOMException('Owner cancellation','AbortError'));else f.tick(30000);await flush();finish();const error=await pending;assert.equal(error.name,'EvaluationTransportFailure');assert.equal(error.notStarted,true);assert.equal(error.failure.kind,mode==='owner'?'EvaluationCancelled':'EvaluationDeadlineExceeded');if(mode==='caller')assert.equal(error.failure.field,'caller-deadline-expired');assert.equal(f.calls(),0);assert.equal(f.port.rows.size,0);
 }finally{t.mock.timers.reset();}
});
test('caller deadline during dispatched provider request remains hard and does not gain another attempt',async t=>{
 const caller=new AbortController(),f=await transportFixture({t,callerSignal:caller.signal,fetch:async(_url,init)=>hanging(init)});
 try{const pending=f.begin().catch(error=>error);await flush();assert.equal(f.calls(),1);caller.abort(new DOMException('Hard logical caller deadline','TimeoutError'));const error=await pending;assert.equal(error.failure.kind,'EvaluationDeadlineExceeded');assert.equal(error.failure.field,'caller-deadline-expired');assert.equal(f.calls(),1);assert.equal(f.port.rows.size,1);assert.equal([...f.port.rows.values()][0].response,null);assert.equal([...f.port.rows.values()][0].recoverable,false);}finally{t.mock.timers.reset();}
});
test('legacy non-runtime explicit60s still bounds planning and dispatch together',async t=>{
 let plan;const gate=new Promise(resolve=>{plan=resolve;}),f=await transportFixture({t,plannerGate:gate,runtime:false});
 try{const pending=f.begin().catch(error=>error);await flush();f.tick(60000);await flush();plan();const error=await pending;assert.equal(error.failure.kind,'EvaluationDeadlineExceeded');assert.equal(error.failure.field,'request-timer-expired');assert.equal(f.calls(),0);assert.equal(f.port.rows.size,0);}finally{t.mock.timers.reset();}
});
test('synchronous ledger replay work exceeding60s cannot exhaust the physical provider timer before reservation',async t=>{
 const f=await transportFixture({t});f.port.ledger.replayResponse=()=>{f.tick(80000);return ok(null);};
 try{const result=await f.begin();assert.equal(result.ok,true);assert.equal(f.calls(),1);assert.equal(f.port.rows.size,1);assert.equal([...f.port.rows.values()][0].uncertain,undefined);}finally{t.mock.timers.reset();}
});
test('explicit90s caller clock still includes80s local pacing and stops its provider after the remaining10s',async t=>{
 let ready;const gate=new Promise(resolve=>{ready=resolve;}),caller=new AbortController(),f=await transportFixture({t,waitGate:gate,callerSignal:caller.signal,fetch:async(_url,init)=>hanging(init)});f.port.ledger.runtimePolicy.renewal={};setTimeout(()=>caller.abort(new DOMException('Hard90s caller deadline','TimeoutError')),90000);
 try{const pending=f.begin().catch(error=>error);await flush();f.tick(80000);await flush();assert.equal(f.calls(),0);ready();await flush();assert.equal(f.calls(),1);f.tick(10000);const error=await pending;assert.equal(error.failure.field,'caller-deadline-expired');assert.equal(f.calls(),1);assert.equal([...f.port.rows.values()][0].recoverable,false);}finally{t.mock.timers.reset();}
});
for(const runtime of [true,false])test(`default ${runtime?'runtime window':'non-runtime60s'} timer semantics remain unchanged`,async t=>{
 let plan;const gate=new Promise(resolve=>{plan=resolve;}),f=await transportFixture({t,plannerGate:gate,runtime,explicit:false});
 try{const pending=f.begin().catch(error=>error);await flush();f.tick(80000);await flush();plan();const result=await pending;if(runtime){assert(result.ok);assert.equal(f.calls(),1);}else{assert.equal(result.failure.kind,'EvaluationDeadlineExceeded');assert.equal(f.calls(),0);} }finally{t.mock.timers.reset();}
});
test('remaining execution window still shortens the physical attempt after local preflight',async t=>{
 let ready;const gate=new Promise(resolve=>{ready=resolve;}),f=await transportFixture({t,waitGate:gate,deadlineOffset:90000,fetch:async(_url,init)=>hanging(init)});f.port.ledger.runtimePolicy.renewal={};
 try{const pending=f.begin().catch(error=>error);await flush();f.tick(80000);await flush();ready();await flush();assert.equal(f.calls(),1);f.tick(10000);await flush();const error=await pending;assert.equal(error.failure.kind,'EvaluationDeadlineExceeded');assert.equal(f.calls(),1);assert.equal(f.port.rows.size,1);assert.equal([...f.port.rows.values()][0].response,null);}finally{t.mock.timers.reset();}
});
test('slow synchronous reserve cannot dispatch after its hard caller deadline',async t=>{
 const caller=new AbortController(),f=await transportFixture({t,callerSignal:caller.signal}),reserve=f.port.ledger.reserve;f.port.ledger.reserve=c=>{const result=reserve(c);caller.abort(new DOMException('Hard caller deadline during local reservation','TimeoutError'));return result;};
 try{const error=await f.begin().catch(error=>error);assert.equal(error.failure.kind,'EvaluationDeadlineExceeded');assert.equal(f.calls(),0);assert.equal(f.port.rows.size,1);assert.equal([...f.port.rows.values()][0].response,null);assert.equal([...f.port.rows.values()][0].recoverable,false);}finally{t.mock.timers.reset();}
});
