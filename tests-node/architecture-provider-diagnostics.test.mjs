import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectProviderFailure,isProviderFailure} from '../scripts/evaluation-provider-diagnostics.mjs';
const project=message=>projectProviderFailure({error:{code:429,message,metadata:{raw:'PRIVATE',reasoning:'PRIVATE'}}},new Headers(),1000,true);
test('safe top-level provider message is bounded and typed',()=>{const d=project('  Rate limit exceeded.\n Please retry. ');assert.equal(d.errorMessage,'Rate limit exceeded. Please retry.');assert.equal(d.messageDisposition,'retained');assert(isProviderFailure(d));assert(!JSON.stringify(d).includes('PRIVATE'));});
for(const message of ['Bearer private-value','api_key=private-value','sk-or-v1-private-value','<task_input>private</task_input>','{"matches":["private"]}','prompt: private','output: private','https://private.invalid/token','data:image/png;base64,private'])test('omit unsafe diagnostic '+message.split(' ')[0],()=>{const d=project(message);assert.equal(d.errorMessage,null);assert.equal(d.messageDisposition,'omitted-unsafe');assert(isProviderFailure(d));});
test('oversized, controls and absent message have explicit omission',()=>{for(const s of ['x'.repeat(4097),'rate\u0000limit']){const d=project(s);assert.equal(d.errorMessage,null);assert.equal(d.messageDisposition,'omitted-unsafe');}assert.equal(project(undefined).messageDisposition,'absent');});
test('UTF8 bound does not split multibyte characters',()=>{const d=project('限'.repeat(200));assert(Buffer.byteLength(d.errorMessage)<=256);assert(!d.errorMessage.includes('\ufffd'));assert(isProviderFailure(d));assert(!isProviderFailure({...d,errorMessage:'a'.repeat(257)}));});
import {createOpenRouterKnowledgeModel} from '../worker/knowledge-workflow-model.js';
for(const status of [429,200])test('model preserves redacted parsed error before projection HTTP '+status,async()=>{
 const logs=[];const model=createOpenRouterKnowledgeModel({apiKey:'offline-fixture',endpoint:'https://example.invalid/',model:'fixture',timeoutMs:1000,maximumInputCharacters:1000,now:()=>1,logger:e=>logs.push(e),fetch:async()=>Response.json({error:{code:429,message:'Rate limit exceeded.',metadata:{raw:'PRIVATE'}}},{status})});
 const r=await model.generate({role:'knowledge-scraper',systemPrompt:'fixture',input:{task:'fixture'},maxOutputTokens:10});
 assert.equal(r.ok,false);assert.equal(r.error.kind,'KnowledgeModelRejected');assert.equal(r.error.providerDiagnostic.errorMessage,'Rate limit exceeded.');assert(!JSON.stringify(logs).includes('Rate limit exceeded.'));assert(!JSON.stringify(r).includes('PRIVATE'));
});
test('plain echoed input or output is omitted even without credential markers',()=>{for(const key of ['input','output','prompt','answer']){const d=projectProviderFailure({error:{message:'private source quotation'},[key]:'private source quotation'},new Headers(),1000,true);assert.equal(d.errorMessage,null);assert.equal(d.messageDisposition,'omitted-unsafe');}});

test('provider source echoes are omitted using actual request private inputs',()=>{const r=projectProviderFailure({error:{code:429,message:'Unable to process: exact sensitive source relationship'}},new Headers(),1000,true,[{role:'user',content:JSON.stringify({blocks:[{text:'A longer exact sensitive source relationship within supplied content.'}]})}]);assert.equal(r.errorMessage,null);assert.equal(r.messageDisposition,'omitted-unsafe');});

test('documented upstream provider code is retained without interpreting it',()=>{
 for(const code of ['rate_limited','provider_capacity_exceeded','x'.repeat(64)]){
  const d=projectProviderFailure({error:{code:429,metadata:{provider_code:code,raw:'PRIVATE',provider_name:'PRIVATE'}}},new Headers(),1000,true);
  assert.equal(d.providerCode,code);assert(isProviderFailure(d));assert.equal(d.providerIdentifier,'unknown');assert(!JSON.stringify(d).includes('PRIVATE'));
 }
});
test('unsafe, oversized, malformed and source-echo provider codes remain unknown',()=>{
 for(const code of [null,429,{},[], 'x'.repeat(65),'rate limit exceeded','Bearer_private','sk-or-v1-private','https://private.invalid','prompt:private','rate\u0000limited']){
  const d=projectProviderFailure({error:{code:429,metadata:{provider_code:code}}},new Headers(),1000,true);
  assert.equal(d.providerCode,'unknown');assert(isProviderFailure(d));
 }
 const echoed=projectProviderFailure({error:{code:429,metadata:{provider_code:'private_source_phrase'}}},new Headers(),1000,true,['private_source_phrase']);
 assert.equal(echoed.providerCode,'unknown');
 const nested=projectProviderFailure({error:{code:429,metadata:{raw:{provider_code:'rate_limited'}}}},new Headers(),1000,true);
 assert.equal(nested.providerCode,'unknown');
 for(const code of ['x'.repeat(65),'Bearer_private',{},429])assert(!isProviderFailure({...nested,providerCode:code}));
 assert(isProviderFailure(nested));
});
