import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../worker/knowledge-workflow-runtime.js';
test('production image cache identity binds actual bytes, schema and config',async()=>{
 const command={taskId:'match',systemPrompt:'immutable',input:{candidateDigest:'unchanged'},maxOutputTokens:100,attachments:[{id:'image',mediaType:'image/png',bytes:new Uint8Array([1,2])}]};
 const key=await runtime.webpageImageCommandKey('model','config',command);
 assert.equal(key,await runtime.webpageImageCommandKey('model','config',command));
 assert.notEqual(key,await runtime.webpageImageCommandKey('model','config',{...command,attachments:[{...command.attachments[0],bytes:new Uint8Array([2,1])}]}));
 assert.notEqual(key,await runtime.webpageImageCommandKey('model','other',command));
 assert.notEqual(key,await runtime.webpageImageCommandKey('model','config',{...command,responseSchema:{name:'strict',schema:{type:'object'}}}));
});
