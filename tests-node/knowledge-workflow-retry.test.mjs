import assert from 'node:assert/strict';
import {test} from 'node:test';
import {retryAfterMilliseconds,transientRetryDelay,waitForTransientRetry} from '../src/features/knowledge-workflows/retry.js';
import {createOpenRouterKnowledgeModel} from '../worker/knowledge-workflow-model.js';

test('Retry-After accepts delta seconds and HTTP dates, rejecting invalid timers',()=>{
  const now=Date.parse('2026-10-16T00:00:00Z');
  assert.equal(retryAfterMilliseconds('2.5',now),2500);
  assert.equal(retryAfterMilliseconds('Fri, 16 Oct 2026 00:00:10 GMT',now),10000);
  for(const value of [null,'junk','-1','9999999999999999'])assert.equal(retryAfterMilliseconds(value,now),undefined);
});

test('congestion waits honor provider delay; schema repair and permanent failures stay immediate',async()=>{
  const slept=[];
  assert.equal(await waitForTransientRetry({kind:'KnowledgeModelRejected',status:429,retryAfterMs:4000},1,async ms=>slept.push(ms),()=>0),4000);
  assert.deepEqual(slept,[4000]);
  assert.equal(transientRetryDelay({kind:'KnowledgeModelRejected',status:503},3,()=>1),2000);
  for(const failure of [{kind:'QuizDraftSchemaInvalid'},{kind:'KnowledgeModelResponseInvalid'},{kind:'KnowledgeModelRejected',status:401},{kind:'WorkflowStageCallUncertain'},{kind:'KnowledgeModelTimeout'}])assert.equal(transientRetryDelay(failure,1),0);
});

test('model rejection retains Retry-After without exposing provider content',async()=>{
  const logs=[];
  const model=createOpenRouterKnowledgeModel({apiKey:'fixture',endpoint:'https://example.test/model',model:'fixture',timeoutMs:1000,maximumInputCharacters:1000,fetch:async()=>Response.json({error:{message:'private response'}},{status:429,headers:{'retry-after':'7'}}),now:()=>0,logger:e=>logs.push(e)});
  const result=await model.generate({role:'question-evaluator',systemPrompt:'fixture',input:{},maxOutputTokens:20});
  assert.equal(result.error.retryAfterMs,7000);assert.equal(result.error.status,429);assert(!JSON.stringify(logs).includes('private response'));
});

test('usage cost is retained even when a received model response fails JSON validation',async()=>{
  const logs=[];
  const model=createOpenRouterKnowledgeModel({apiKey:'fixture',endpoint:'https://example.test/model',model:'fixture',timeoutMs:1000,maximumInputCharacters:1000,fetch:async()=>Response.json({id:'fixture-request',choices:[{finish_reason:'stop',message:{content:'invalid JSON'}}],usage:{cost:0.002,prompt_tokens:10,completion_tokens:3}}),now:()=>0,logger:e=>logs.push(e)});
  assert.equal((await model.generate({role:'question-evaluator',systemPrompt:'fixture',input:{},maxOutputTokens:20})).ok,false);
  assert.equal(logs.find(e=>e.event==='knowledge-model-usage').costNanodollars,2_000_000);
});
