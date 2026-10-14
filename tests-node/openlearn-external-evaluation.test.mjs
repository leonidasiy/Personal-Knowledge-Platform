import assert from 'node:assert/strict';import {test} from 'node:test';import {validateExternalReport,evaluateSavedOutputs,acquireExternalAttempt} from '../scripts/openlearn-external-evaluation.mjs';
test('external evaluator reports low scores without mutating outputs or publishing',async()=>{
 const input={points:[{id:'point'}],quizzes:[{id:'pair'}]},before=structuredClone(input);let calls=0;
 const result=await evaluateSavedOutputs({input,generate:async c=>{calls++;assert.equal(c.role,'review-grader');assert.match(c.systemPrompt,/report-only/);return {ok:true,value:{output:{score:1,summary:'Synthetic failed quality observation.',findings:['Synthetic finding'],unassessed:['Pixels']}}};}});
 assert.equal(result.ok,true);assert.equal(calls,1);assert.deepEqual(input,before);
});
test('external report rejects malformed scores and extra authority fields',()=>{
 const value={score:9,summary:'Synthetic report.',findings:[],unassessed:['Pixels']};assert(validateExternalReport(value));assert.equal(validateExternalReport({...value,publish:true}),false);assert.equal(validateExternalReport({...value,score:11}),false);
});

test('external attempt is exclusive and single-use even after releasing the shared run lock',async()=>{
 const {mkdtemp,rm,open}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const directory=await mkdtemp(join(tmpdir(),'external-observer-'));
 try{
  const release=await acquireExternalAttempt(directory,'a'.repeat(64));
  await assert.rejects(acquireExternalAttempt(directory,'b'.repeat(64)),{code:'EEXIST'});
  await release();await assert.rejects(acquireExternalAttempt(directory,'a'.repeat(64)),{code:'EEXIST'});
  const lock=await open(join(directory,'pipeline-run.lock'),'wx');await lock.close();
 }finally{await rm(directory,{recursive:true,force:true});}
});
