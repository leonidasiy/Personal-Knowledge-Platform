import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runQuizPipeline} from '../worker/knowledge-workflow-quiz-pipeline.js';

function deferred() { let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; }
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('three drafts overlap while reviews and commits stay ordered',async()=>{
  const drafts=[deferred(),deferred(),deferred()],commit=deferred(),events=[];
  const result=runQuizPipeline([0,1,2,3],async(point,awaitReview)=>{
    events.push(`draft:${point}`);await drafts[point].promise;
    await awaitReview();events.push(`review:${point}`);
    if(point===0)await commit.promise;
    events.push(`commit:${point}`);return point;
  });
  assert.deepEqual(events,['draft:0','draft:1','draft:2']);
  drafts[2].resolve();drafts[1].resolve();await tick();
  assert.equal(events.length,3,'Later drafts cannot review ahead of their predecessors');
  drafts[0].resolve();await tick();
  assert.deepEqual(events.slice(3),['review:0']);
  commit.resolve();assert.deepEqual(await result,[0,1,2]);
  assert.deepEqual(events.slice(3),['review:0','commit:0','review:1','commit:1','review:2','commit:2']);
});

test('a failed generator cannot release later review ahead of an earlier commit',async()=>{
  const commit=deferred(),events=[],failure=new Error('Synthetic generation failure');
  const result=runQuizPipeline([0,1,2],async(point,awaitReview)=>{
    if(point===1)throw failure;
    await awaitReview();events.push(`review:${point}`);
    if(point===0)await commit.promise;
    events.push(`commit:${point}`);
  });
  const rejected=assert.rejects(result,error=>error===failure);
  await tick();assert.deepEqual(events,['review:0']);
  commit.resolve();await rejected;
  assert.deepEqual(events,['review:0','commit:0','review:2','commit:2']);
});

test('an execution boundary waits for every admitted operation before propagating',async()=>{
  const inFlight=deferred(),failure=new Error('Synthetic execution boundary');
  let finished=false,returned=false;
  const result=runQuizPipeline([0,1],async(point)=>{
    if(point===0)throw failure;
    await inFlight.promise;finished=true;
  });
  const rejected=assert.rejects(result,error=>{returned=true;return error===failure;});
  await tick();assert.equal(returned,false);
  inFlight.resolve();await rejected;assert.equal(finished,true);
});

test('empty input performs no work',async()=>{
  assert.deepEqual(await runQuizPipeline([],async()=>assert.fail('No work')),[]);
});
