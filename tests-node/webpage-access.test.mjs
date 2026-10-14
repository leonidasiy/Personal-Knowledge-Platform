import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPublicWebpage} from '../worker/webpage-access.js';

// Constructed access fixtures; these are not measured website/model responses.
const evidence={url:'https://example.test/lesson',headings:[],images:[],warnings:[],blocks:[{id:'lesson',locator:'main',sectionId:'main',figureId:null,kind:'text',text:'A substantive relationship taught by the lesson.'}]};
test('public target requires supplied content evidence; optional signup is contextual evidence',async()=>{
  let command;
  const result=await verifyPublicWebpage({evidence,generate:async c=>{command=c;return {ok:true,value:{access:'public',reason:'Substantive content is readable; sign-in is optional.',evidenceBlockIds:['lesson']}};}});
  assert.deepEqual(result,{ok:true,value:null});
  assert.deepEqual(command.input.blocks,[{id:'lesson',text:evidence.blocks[0].text}]);
  assert.match(command.systemPrompt,/optional paid product/);
});
test('blockers, uncertainty, invalid citations and unavailable model cannot authorize processing',async()=>{
  for(const [value,kind] of [
    [{access:'blocked',reason:'Payment required.',evidenceBlockIds:['lesson']},'WebpageAccessBlocked'],
    [{access:'uncertain',reason:'Only a title.',evidenceBlockIds:[]},'WebpageAccessUncertain'],
    [{access:'public',reason:'Readable.',evidenceBlockIds:[]},'WebpageAccessOutputInvalid'],
    [{access:'public',reason:'Readable.',evidenceBlockIds:['invented']},'WebpageAccessOutputInvalid'],
    [{access:'public',reason:'Readable.',evidenceBlockIds:['lesson'],extra:true},'WebpageAccessOutputInvalid'],
  ]) assert.deepEqual(await verifyPublicWebpage({evidence,generate:async()=>({ok:true,value})}),{ok:false,error:{kind}});
  assert.deepEqual(await verifyPublicWebpage({evidence,generate:async()=>({ok:false,error:{kind:'KnowledgeModelUnavailable'}})}),{ok:false,error:{kind:'KnowledgeModelUnavailable'}});
});

test('empty captured content is uncertain without dispatching a model',async()=>{
  const result=await verifyPublicWebpage({evidence:{...evidence,blocks:[]},generate:async()=>{throw new Error('Unexpected model dispatch');}});
  assert.deepEqual(result,{ok:false,error:{kind:'WebpageAccessUncertain'}});
});
test('public access assessment reserves 4096 output tokens for configured reasoning and complete DOM citations',async()=>{
 const blockId='dom:html:nth-of-type(1) > body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > section:nth-of-type(2) > p:nth-of-type(4)';
 const result=await verifyPublicWebpage({evidence:{...evidence,blocks:[{...evidence.blocks[0],id:blockId}]},generate:async command=>{
  assert.equal(command.maxOutputTokens,4096);
  assert.deepEqual(command.responseSchema.schema.properties.evidenceBlockIds.items.enum,[blockId]);
  return {ok:true,value:{access:'public',reason:'Substantive source content is freely readable.',evidenceBlockIds:[blockId]}};
 }});
 assert.deepEqual(result,{ok:true,value:null});
});
