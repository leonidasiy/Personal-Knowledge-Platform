import assert from 'node:assert/strict';
import {test} from 'node:test';
import {executeIsolatedWorkflowChunk,executeRetryingWorkflowStep} from '../worker/knowledge-workflow-step.js';

test('sequential chunks use independent invocation allowances and join completed children on replay',async()=>{
  const instances=new Map();let active=0,maximumActive=0,childQueries=0,parentQueries=0,executions=0;
  const binding={
    async create({id,params}) {
      if(instances.has(id))throw Error('Instance exists');
      maximumActive=Math.max(maximumActive,++active);executions++;
      let allowance=1000;
      for(let query=0;query<268;query++){assert(--allowance>=0);childQueries++;}
      active--;instances.set(id,{status:'complete',output:{ok:true,value:params}});
    },
    async get(id){return {status:async()=>{assert(++parentQueries<1000);return instances.get(id)??{status:'unknown'};}};},
  };
  for(let chunk=0;chunk<200;chunk++) {
    const command={binding,id:`chunk-${chunk}`,params:{revision:chunk},sleep:async()=>assert.fail('Already complete')};
    assert.deepEqual(await executeIsolatedWorkflowChunk(command),{ok:true,value:command.params});
    assert.deepEqual(await executeIsolatedWorkflowChunk(command),{ok:true,value:command.params});
  }
  assert.equal(maximumActive,1);assert.equal(executions,200);assert.equal(childQueries,53600);
});

test('child status polling retains failures and never creates another child while it is running',async()=>{
  let created=0,polls=0;const sleeps=[];
  const binding={create:async()=>{created++;},get:async()=>({status:async()=>++polls===1?{status:'running'}:{status:'complete',output:{ok:false,error:{kind:'WorkflowExtractionFailed'}}}})};
  assert.deepEqual(await executeIsolatedWorkflowChunk({binding,id:'child',params:{},sleep:async ms=>sleeps.push(ms)}),{ok:false,error:{kind:'WorkflowExtractionFailed'}});
  assert.equal(created,1);assert.deepEqual(sleeps,[5000]);
  binding.get=async()=>({status:async()=>({status:'errored',error:{message:'private unexpected error'}})});
  assert.deepEqual(await executeIsolatedWorkflowChunk({binding,id:'child',params:{}}),{ok:false,error:{kind:'WorkflowExecutionStopped'}});
  binding.get=async()=>({status:async()=>({status:'errored',error:{message:'Worker exceeded CPU time limit.'}})});
  await assert.rejects(executeIsolatedWorkflowChunk({binding,id:'child',params:{}}),/Worker exceeded CPU time limit/);
});

test('child admission failure is preserved and malformed output cannot become success',async()=>{
  const failure=Error('Admission failed'),binding={create:async()=>{throw failure;},get:async()=>({status:async()=>({status:'unknown'})})};
  await assert.rejects(executeIsolatedWorkflowChunk({binding,id:'child',params:{}}),error=>error===failure);
  binding.create=async()=>{};
  binding.get=async()=>({status:async()=>({status:'complete',output:{state:'completed'}})});
  await assert.rejects(executeIsolatedWorkflowChunk({binding,id:'child',params:{}}),/WorkflowRuntimeOutputInvalid/);
});

test('bounded CPU retry supplies distinct deterministic child attempt identities',async()=>{
  const attempts=[];
  const result=await executeRetryingWorkflowStep({step:{do:async(_name,_config,callback)=>callback(),sleepUntil:async()=>{}},name:'chunk',now:()=>0,load:async()=>({ok:true,value:{revision:4}}),execute:async(run,name)=>{assert.equal(run.revision,4);attempts.push(name);if(attempts.length<2)throw Error('Worker exceeded CPU time limit.');return {ok:true,value:'done'};}});
  assert.equal(result.value,'done');assert.deepEqual(attempts,['chunk: attempt 1','chunk: attempt 2']);
});
