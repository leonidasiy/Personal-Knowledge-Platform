import {captureCitationSources} from '../worker/webpage-citations.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as facts from '../worker/webpage-facts.js';
import {createOpenRouterKnowledgeModel} from '../worker/knowledge-workflow-model.js';
import {requestPageObservation} from '../worker/knowledge-workflow-runtime.js';
import {associateWebpageImages,imageHash} from '../worker/webpage-images.js';

const url='https://fixture.test/lesson';
const block={id:'block:1',locator:'main > p',sectionId:'section:1',figureId:null,kind:'text',text:'Ratios compare quantities. Units must agree.'};
const evidence={url,blocks:[block],headings:[],images:[],warnings:[]};
const capture=await captureCitationSources({owner:url,sources:[{id:block.id,locator:block.locator,text:block.text}]});assert(capture.ok);
const candidate=(quote=block.text)=>({summary:quote,normalizedHash:'ratio',coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{reference:capture.value.sources[0].reference,clause:quote}]});
const caps={extraction:1,grounding:1,match:2,verify:2,requests:6};
async function extract(payload,{source=evidence,capability=false}={}){
 const calls=[];
 const result=await facts.requestWebpageFacts({taskId:'fixture',input:{url:source.url,evidence:source,coverageGoals:[]},maxOutputTokens:4096,structuredOutput:capability,logger:()=>{},generate:async c=>{calls.push(c);return {ok:true,value:c.input.operation==='extract-webpage-facts'?payload:{verdicts:c.input.candidates.map(f=>({normalizedHash:f.normalizedHash,grounded:true}))}};}});
 return {result,calls};
}
for(const notes of ['', 'No useful facts.'])test('empty output accepts string notes '+JSON.stringify(notes),async()=>{const {result,calls}=await extract({notes,candidates:[]});assert.equal(result.ok,true);assert.equal(calls.length,1);});
for(const quote of [block.text,'Ratios compare quantities.'])test('canonical whole-block reference preserves summary clause '+quote,async()=>{const {result,calls}=await extract({notes:'',candidates:[candidate(quote)]});assert.equal(result.ok,true);assert.equal(calls.length,2);assert.deepEqual(result.value.candidates[0].evidenceAnchors,[{blockId:block.id,quote:block.text,clause:quote,url,selector:block.locator,quoteDigest:await facts.quoteHash(block.text)}]);});
for(const payload of [{notes:[],candidates:[]},{notes:{},candidates:[]},{notes:'',candidates:{}},{notes:'x'.repeat(2001),candidates:[]},{notes:'',candidates:[],extra:true},{notes:'',candidates:Array(51).fill(candidate())}])test('wrong type/key/limit is rejected without retry '+JSON.stringify(payload).slice(0,65),async()=>{const {result,calls}=await extract(payload);assert.equal(result.ok,false);assert.equal(calls.length,1);});
for(const [name,alter] of Object.entries({foreign:a=>{a.blockId='foreign';},url:a=>{a.url='https://foreign.test/';},selector:a=>{a.selector='foreign';},digest:a=>{a.quoteDigest='sha256:'+'0'.repeat(64);},quote:a=>{a.quote='Altered source';},extra:a=>{a.extra=true;}}))test('supplied provenance cannot be repaired '+name,async()=>{const c=candidate();alter(c.evidenceAnchors[0]);const {result,calls}=await extract({notes:'Valid notes.',candidates:[c]});assert(result.ok);assert.equal(result.value.status,'empty');assert.equal(result.value.partialIssues[0].kind,'WebpageCandidateEvidenceInvalid');assert.equal(calls.length,1);});
test('legacy supplied digest cannot replace canonical reference; stale captured revision rejected',async()=>{
 const c=candidate();Object.assign(c.evidenceAnchors[0],{url,selector:block.locator,quoteDigest:await facts.quoteHash(block.text)});
 const legacy=await extract({notes:'',candidates:[c]});assert(legacy.result.ok);assert.equal(legacy.result.value.partialIssues[0].kind,'WebpageCandidateEvidenceInvalid');assert.equal(legacy.calls.length,1);
 const stale=await extract({notes:'',candidates:[candidate()]},{source:{...evidence,blocks:[{...block,text:'New revision.'}]}});assert(stale.result.ok);assert.equal(stale.result.value.partialIssues[0].kind,'WebpageCandidateEvidenceInvalid');assert.equal(stale.calls.length,1);
});
test('unsupported additions require independent grounding and explicit rejection',async()=>{
 const c=candidate('Ratios compare quantities.');c.summary+=' Unsupported claim.';let calls=0;
 const result=await facts.requestWebpageFacts({taskId:'unsupported',input:{url,evidence,coverageGoals:[]},maxOutputTokens:4096,logger:()=>{},generate:async command=>{calls++;return {ok:true,value:command.phase==='extraction'?{notes:'',candidates:[c]}:{verdicts:[{normalizedHash:'ratio',grounded:false}]}};}});
 assert(result.ok);assert.equal(result.value.partialIssues[0].kind,'WebpageCandidateGroundingRejected');assert.equal(result.value.candidates.length,0);assert.equal(calls,2);
});
test('explicit schema/types/examples; capability controls strict schema',async()=>{const a=await extract({notes:'',candidates:[]});assert.match(a.calls[0].systemPrompt,/notes.*string/s);assert.match(a.calls[0].systemPrompt,/candidates.*array/s);assert.match(a.calls[0].systemPrompt,/"notes":"","candidates":\[\]/);assert.equal(a.calls[0].responseSchema,undefined);const b=await extract({notes:'',candidates:[]},{capability:true});assert.equal(b.calls[0].responseSchema.schema.additionalProperties,false);assert.deepEqual(b.calls[0].responseSchema.schema.required,['notes','candidates']);});
test('central phase and request caps admit grounding but deny duplicate extraction',async()=>{assert.equal(typeof facts.createWebpageAttemptPolicy,'function');const policy=facts.createWebpageAttemptPolicy(caps),calls=[];const generate=async c=>{calls.push(c.phase);return {ok:true,value:{}};};const command=phase=>({phase,taskId:phase,systemPrompt:'Synthetic',input:{phase},maxOutputTokens:10});assert.equal((await policy.dispatch(command('extraction'),generate)).ok,true);assert.equal((await policy.dispatch(command('extraction'),generate)).error.kind,'WebpagePhaseAttemptLimitExceeded');assert.equal((await policy.dispatch(command('grounding'),generate)).ok,true);assert.deepEqual(calls,['extraction','grounding']);const limited=facts.createWebpageAttemptPolicy({...caps,requests:1});await limited.dispatch(command('extraction'),generate);assert.equal((await limited.dispatch(command('grounding'),generate)).error.kind,'WebpageRequestLimitExceeded');});
test('central policy rejects invalid caps, unknown phase and simultaneous dispatch',async()=>{assert.equal(typeof facts.createWebpageAttemptPolicy,'function');assert.throws(()=>facts.createWebpageAttemptPolicy({...caps,requests:0}));const p=facts.createWebpageAttemptPolicy(caps);assert.equal((await p.dispatch({phase:'foreign'},async()=>{throw Error('never');})).error.kind,'WebpagePhaseCommandInvalid');let release;const pending=p.dispatch({phase:'extraction',taskId:'a',systemPrompt:'x',input:{},maxOutputTokens:1},()=>new Promise(r=>{release=r;}));assert.equal((await p.dispatch({phase:'grounding',taskId:'b',systemPrompt:'x',input:{},maxOutputTokens:1},async()=>({ok:true,value:{}}))).error.kind,'WebpageRequestInFlight');release({ok:true,value:{}});await pending;});
const response=usage=>({id:'synthetic',choices:[{finish_reason:'stop',message:{content:'{"notes":"","candidates":[]}',reasoning:'PRIVATE_REASONING'}}],...(usage===undefined?{}:{usage})});
function model(fetch,logs=[],timeoutMs=1000){return createOpenRouterKnowledgeModel({apiKey:'synthetic',endpoint:'https://fixture.test/model',model:'fixture',timeoutMs,maximumInputCharacters:100000,fetch,now:Date.now,logger:e=>logs.push(e)});}
const command={role:'knowledge-scraper',systemPrompt:'Synthetic',input:{},maxOutputTokens:100,phase:'extraction'};
test('pre-cancel does not dispatch and differs from timer',async()=>{let calls=0;const c=new AbortController();c.abort();const r=await model(async()=>{calls++;return Response.json(response());}).generate({...command,signal:c.signal});assert.equal(r.error.kind,'KnowledgeModelCancelled');assert.equal(calls,0);});
for(const location of ['fetch','body'])test('caller cancellation during '+location,async()=>{const c=new AbortController(),logs=[];const pending=model(async()=>{if(location==='fetch'){setTimeout(()=>c.abort(),2);await new Promise(r=>setTimeout(r,8));return Response.json(response());}return {ok:true,status:200,json:async()=>{setTimeout(()=>c.abort(),2);await new Promise(r=>setTimeout(r,8));return response();}};},logs).generate({...command,signal:c.signal});assert.equal((await pending).error.kind,'KnowledgeModelCancelled');assert.equal(logs.at(-1).phase,'extraction');assert.equal(logs.at(-1).diagnosticToken,location==='fetch'?'caller-cancelled-fetch':'caller-cancelled-body');assert(!JSON.stringify(logs).includes('PRIVATE_REASONING'));});
test('timer expiry rejects a noncooperative late response',async()=>{const logs=[];const r=await model(async()=>{await new Promise(r=>setTimeout(r,15));return Response.json(response());},logs,2).generate(command);assert.equal(r.error.kind,'KnowledgeModelTimeout');assert.equal(logs.at(-1).diagnosticToken,'timer-expired-fetch');});
test('response read transport error is a named failure',async()=>{const r=await model(async()=>({ok:true,status:200,json:async()=>{throw new TypeError('synthetic body connection lost');}})).generate(command);assert.equal(r.error.kind,'KnowledgeModelResponseReadFailed');});
for(const usage of [{prompt_tokens:-1,completion_tokens:1},{prompt_tokens:1,completion_tokens:'2'},null])test('invalid usage is diagnosed '+JSON.stringify(usage),async()=>{const logs=[];const r=await model(async()=>Response.json(response(usage)),logs).generate(command);assert.equal(r.error.kind,'KnowledgeModelUsageInvalid');assert.match(r.error.field,/^usage(?:\.|$)/);assert(!JSON.stringify(logs).includes('PRIVATE_REASONING'));});
test('missing usage stays unknown rather than zero',async()=>{const r=await model(async()=>Response.json(response())).generate(command);assert.equal(r.ok,true);assert.equal(r.value.inputTokens,null);assert.equal(r.value.outputTokens,null);assert.equal(r.value.reasoningTrace,null);});
test('real observation -> grounding -> association failure retains text and canonical provenance, zero network',async()=>{let forbidden=0;const original=globalThis.fetch;globalThis.fetch=()=>{forbidden++;throw Error('ZERO_NETWORK_SENTINEL');};try{const phases=[];const output=await requestPageObservation({taskId:'real-path',input:{url,evidence,coverageGoals:[]},maxOutputTokens:4096,structuredOutput:true,logger:()=>{},generate:async c=>{phases.push(c.input.operation);const adapter=model(async(_url,init)=>{const body=JSON.parse(init.body);assert.equal(body.response_format.type,'json_schema');return Response.json({...response({prompt_tokens:1,completion_tokens:1}),choices:[{finish_reason:'stop',message:{content:JSON.stringify(c.input.operation==='extract-webpage-facts'?{notes:'',candidates:[candidate()]}:{verdicts:[{normalizedHash:'ratio',grounded:true}]})}}]});});const r=await adapter.generate({...command,...c});return r.ok?{ok:true,value:r.value.output}:r;}});assert.equal(output.ok,true);const digest=output.value.candidates[0].evidenceAnchors[0].quoteDigest;const image={id:'image:1',url:'https://fixture.test/image.png',occurrences:[{id:'occ:1',locator:'img',sectionId:'section:1',figureId:null,captionId:null,alt:''}],occurrenceWindows:[['occ:1']]};const a=await associateWebpageImages({scope:{ownerId:'fixture',runId:'fixture',sourceRevision:1},facts:output.value.candidates,evidence:{...evidence,images:[image]},budget:{reserve:async()=>({ok:true,value:{deadlineAtMs:Date.now()+1000,maximumBytes:100}}),settle:async()=>({ok:true,value:null})},readImage:async()=>({ok:true,value:{bytes:new Uint8Array([1]),mediaType:'image/png'}}),digest:imageHash,generate:async()=>({ok:false,error:{kind:'SyntheticAssociationFailed'}}),logger:()=>{}});assert.equal(a.ok,true);assert.equal(a.value[0].failureKind,'SyntheticAssociationFailed');assert.equal(output.value.candidates[0].summary,block.text);assert.equal(output.value.candidates[0].evidenceAnchors[0].quoteDigest,digest);assert.deepEqual(phases,['extract-webpage-facts','verify-webpage-facts']);assert.equal(forbidden,0);}finally{globalThis.fetch=original;}});
test('same injected authority gates extraction, grounding and association transport',async()=>{const policy=facts.createWebpageAttemptPolicy({...caps,requests:2});const phases=[];const generate=async c=>{phases.push(c.phase);return {ok:true,value:c.phase==='extraction'?{notes:'',candidates:[candidate()]}:{verdicts:[{normalizedHash:'ratio',grounded:true}]}};};const output=await facts.requestWebpageFacts({taskId:'caps',input:{url,evidence,coverageGoals:[]},maxOutputTokens:1000,attemptPolicy:policy,logger:()=>{},generate});assert.equal(output.ok,true);const image={id:'image:1',url:url+'.png',occurrences:[{id:'occ:1',locator:'img',sectionId:'section:1',figureId:null,captionId:null,alt:''}],occurrenceWindows:[['occ:1']]};const r=await associateWebpageImages({scope:{ownerId:'fixture',runId:'fixture',sourceRevision:1},facts:output.value.candidates,evidence:{...evidence,images:[image]},attemptPolicy:policy,budget:{reserve:async()=>({ok:true,value:{deadlineAtMs:Date.now()+1000,maximumBytes:100}}),settle:async()=>({ok:true,value:null})},readImage:async()=>({ok:true,value:{bytes:new Uint8Array([1]),mediaType:'image/png'}}),digest:imageHash,generate,logger:()=>{}});assert.equal(r.ok,true);assert.equal(r.value[0].failureKind,'WebpageRequestLimitExceeded');assert.deepEqual(phases,['extraction','grounding']);});
test('designated backend log sink preserves safe phase/usage/elapsed diagnostics only',async()=>{const {createKnowledgeWorkflowLogger}=await import('../worker/knowledge-workflow-logging.js');const records=[];const logger=createKnowledgeWorkflowLogger({sink:r=>records.push(r),now:()=>new Date().toISOString()});assert.equal(logger({event:'knowledge-model-failure',phase:'extraction',failureKind:'KnowledgeModelUsageInvalid',diagnosticToken:'usage.prompt_tokens',durationMs:7,requestId:'synthetic-request',inputTokens:null,outputTokens:3,reasoning:'PRIVATE_REASONING'}).ok,true);assert.equal(records[0].phase,'extraction');assert.equal(records[0].durationMs,7);assert.equal(records[0].requestId,'synthetic-request');assert.equal(records[0].inputTokens,null);assert.equal(records[0].outputTokens,3);assert(!JSON.stringify(records).includes('PRIVATE_REASONING'));assert.equal(logger({event:'knowledge-model-failure',phase:'foreign'}).ok,false);assert.equal(logger({event:'knowledge-model-success',inputTokens:-1}).ok,false);});
for(const first of ['caller','timer'])test('first abort cause remains authoritative when both signals fire: '+first,async()=>{const c=new AbortController(),logs=[];const r=await model(async()=>{setTimeout(()=>c.abort(),first==='caller'?1:8);await new Promise(r=>setTimeout(r,16));return Response.json(response());},logs,first==='caller'?8:1).generate({...command,signal:c.signal});assert.equal(r.error.kind,first==='caller'?'KnowledgeModelCancelled':'KnowledgeModelTimeout');assert.equal(logs.at(-1).diagnosticToken,first==='caller'?'caller-cancelled-fetch':'timer-expired-fetch');});
test('caller-provided deadline signal is distinguished from voluntary cancellation',async()=>{const c=new AbortController();c.abort(new DOMException('synthetic deadline','TimeoutError'));const logs=[];const r=await model(async()=>assert.fail('never dispatch'),logs).generate({...command,signal:c.signal});assert.equal(r.error.kind,'KnowledgeModelTimeout');assert.equal(logs.at(-1).diagnosticToken,'caller-deadline-fetch');});
test('domain invalid result never falls back from strict schema after provider rejection',async()=>{let calls=0;const r=await facts.requestWebpageFacts({taskId:'strict',input:{url,evidence,coverageGoals:[]},structuredOutput:true,maxOutputTokens:4096,logger:()=>{},generate:async c=>{calls++;assert(c.responseSchema);const generated=await model(async()=>new Response(null,{status:400})).generate({...command,...c});return generated.ok?{ok:true,value:generated.value.output}:generated;}});assert.equal(r.error.kind,'KnowledgeModelRejected');assert.equal(calls,1);});


// Replay the deployed forwarding expression with the real designated sink.
async function productionLogger(records) {
  const { readFileSync } = await import('node:fs');
  const { createKnowledgeWorkflowLogger } = await import('../worker/knowledge-workflow-logging.js');
  const source = readFileSync('worker/knowledge-workflow-entry.mjs', 'utf8');
  const line = source.split('\n').find(l => l.includes('logger: (entry) => logger({ event: entry.event') && l.includes('diagnosticToken: entry.diagnosticToken'));
  assert(line, 'Production runtime logger forwarder must exist');
  const expression = line.trim().slice('logger: '.length, -1);
  const sink = createKnowledgeWorkflowLogger({ sink: r => records.push(r), now: () => '2026-10-07T00:00:00.000Z' });
  return Function('logger', 'ownerId', 'return (' + expression + ')')(sink, 'synthetic-owner');
}

test('review R1: actual production forwarder preserves bounded phase, elapsed and usage diagnostics', async () => {
  const records = [], logger = await productionLogger(records);
  assert.equal(logger({ event: 'knowledge-model-success', phase: 'extraction', requestId: 'synthetic-request', durationMs: 7, inputTokens: 2, outputTokens: 3, reasoning: 'PRIVATE_REASONING', providerText: 'PRIVATE_PROVIDER_TEXT', apiKey: 'PRIVATE_SECRET' }).ok, true);
  assert.equal(records[0].phase, 'extraction');
  assert.equal(records[0].durationMs, 7);
  assert.equal(records[0].requestId, 'synthetic-request');
  assert.equal(records[0].inputTokens, 2);
  assert.equal(records[0].outputTokens, 3);
  assert.equal(records[0].ownerId, 'synthetic-owner');
  assert(!JSON.stringify(records).includes('PRIVATE_'));
});

test('review R2: array phase rejects before fetch through the public model boundary', async () => {
  let calls = 0;
  const adapter = model(async () => { calls++; return Response.json(response()); });
  const result = await adapter.generate({ ...command, phase: ['extraction'] });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'KnowledgeModelCommandInvalid');
  assert.equal(calls, 0);
});

for (const phase of ['extraction', 'normalization', 'grounding', 'match', 'verify', undefined]) {
  test('public phase boundary accepts ' + String(phase), async () => {
    let calls = 0;
    const records = [], logger = await productionLogger(records);
    const adapter = createOpenRouterKnowledgeModel({ apiKey: 'synthetic', endpoint: 'https://synthetic.test/model', model: 'synthetic', timeoutMs: 1000, maximumInputCharacters: 1000, fetch: async () => { calls++; return Response.json(response()); }, now: Date.now, logger });
    assert.equal((await adapter.generate({ ...command, phase })).ok, true);
    assert.equal(calls, 1);
    assert.equal(records.at(-1).phase, phase);
    assert.equal(records.at(-1).inputTokens, null);
    assert.equal(records.at(-1).outputTokens, null);
  });
}

for (const [label, phase] of [['null', null], ['number', 1], ['boolean', true], ['empty', ''], ['unknown', 'foreign'], ['whitespace', ' extraction'], ['boxed', new String('extraction')], ['object', {}], ['array-grounding', ['grounding']], ['array-match', ['match']], ['array-verify', ['verify']]]) {
  test('public phase boundary rejects ' + label + ' before dispatch', async () => {
    let calls = 0;
    const records = [], logger = await productionLogger(records);
    const adapter = createOpenRouterKnowledgeModel({ apiKey: 'synthetic', endpoint: 'https://synthetic.test/model', model: 'synthetic', timeoutMs: 1000, maximumInputCharacters: 1000, fetch: async () => { calls++; return Response.json(response()); }, now: Date.now, logger });
    const result = await adapter.generate({ ...command, phase });
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'KnowledgeModelCommandInvalid');
    assert.equal(calls, 0);
    assert.equal(records.at(-1).failureKind, 'KnowledgeModelCommandInvalid');
    assert.equal(records.at(-1).field, 'command');
    assert.equal(records.at(-1).phase, undefined);
  });
}

test('phase validation never invokes object coercion', async () => {
  let coercions = 0, calls = 0;
  const phase = { [Symbol.toPrimitive]() { coercions++; return 'extraction'; } };
  const result = await model(async () => { calls++; return Response.json(response()); }).generate({ ...command, phase });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'KnowledgeModelCommandInvalid');
  assert.equal(calls, 0);
  assert.equal(coercions, 0);
});

test('production failure field reaches the sink with type and maximum bounds', async () => {
  const records = [], logger = await productionLogger(records);
  const adapter = createOpenRouterKnowledgeModel({ apiKey: 'synthetic', endpoint: 'https://synthetic.test/model', model: 'synthetic', timeoutMs: 1000, maximumInputCharacters: 1000, fetch: async () => Response.json(response({ prompt_tokens: -1 })), now: Date.now, logger });
  const result = await adapter.generate(command);
  assert.equal(result.error.kind, 'KnowledgeModelUsageInvalid');
  assert.equal(records.at(-1).field, 'usage.prompt_tokens');
  assert.equal(logger({ event: 'knowledge-model-failure', field: 'f'.repeat(128) }).ok, true);
  for (const field of ['f'.repeat(129), '', ['usage'], {}, 7, null, 'PRIVATE provider prose']) {
    const count = records.length;
    assert.deepEqual(logger({ event: 'knowledge-model-failure', field }), { ok: false, error: { kind: 'KnowledgeWorkflowLogEntryInvalid' } });
    assert.equal(records.length, count);
  }
  for (const extra of [{ phase: ['extraction'] }, { durationMs: -1 }, { durationMs: Number.MAX_SAFE_INTEGER + 1 }, { requestId: 'r'.repeat(129) }, { inputTokens: '2' }, { outputTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    const count = records.length;
    assert.deepEqual(logger({ event: 'knowledge-model-success', ...extra }), { ok: false, error: { kind: 'KnowledgeWorkflowLogEntryInvalid' } });
    assert.equal(records.length, count);
  }
});


test('real runtime model forwarder retains failure field through production sink', async () => {
  const { readFileSync } = await import('node:fs');
  const records = [], logger = await productionLogger(records);
  const source = readFileSync('worker/knowledge-workflow-runtime.js', 'utf8');
  const line = source.split('\n').find(l => l.includes('const model = createRoleConfiguredKnowledgeModel('));
  assert(line, 'Runtime model composition must exist');
  const match = line.match(/logger: (\(entry\) => dependencies\.logger\(\{.*\}\)) \}\);$/);
  assert(match, 'Actual runtime model logger expression must exist');
  const forwarder = Function('dependencies', 'return (' + match[1] + ')')({ logger });
  const adapter = createOpenRouterKnowledgeModel({ apiKey: 'synthetic', endpoint: 'https://synthetic.test/model', model: 'synthetic', timeoutMs: 1000, maximumInputCharacters: 1000, fetch: async () => Response.json(response({ prompt_tokens: -1 })), now: Date.now, logger: forwarder });
  assert.equal((await adapter.generate(command)).error.kind, 'KnowledgeModelUsageInvalid');
  assert.equal(records.at(-1).field, 'usage.prompt_tokens');
  assert.equal(records.at(-1).phase, 'extraction');
  assert.equal(records.at(-1).stage, 'knowledge-scraper');
  assert.equal(records.at(-1).diagnosticToken, 'usage.prompt_tokens');
  assert.equal(typeof records.at(-1).durationMs, 'number');
});
