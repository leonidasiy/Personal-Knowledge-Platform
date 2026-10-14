import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {createWebpageImageBudget,WEBPAGE_IMAGE_POLICY} from '../worker/webpage-image-budget.js';
test('actual SQLite preserves page/run counters and original attempt deadline across resume, memory limits and cancellation',async()=>{
 const db=new DatabaseSync(':memory:');try{
 for(const f of (await readdir('worker/migrations')).filter(f=>f.endsWith('.sql')).sort())db.exec(await readFile('worker/migrations/'+f,'utf8'));
 db.prepare("INSERT INTO knowledge_workflow_runs(owner_id,run_id,source_id,source_revision,canonical_source_identity,content_signature,state,revision,idempotency_key,config_digests_json,counts_json,reused,created_at,updated_at,run_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('owner','run','source',1,'https://source.example/','hash','extraction',1,'key','{}','{}',0,'now','now','{}');
 const database={prepare(sql){let values=[];return {bind(...v){values=v;return this;},first:async()=>db.prepare(sql).get(...values)??null,run:async()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}})};}};
 let now=100;const deps={database,policy:WEBPAGE_IMAGE_POLICY,scope:{ownerId:'owner',runId:'run',pageUrl:'https://source.example/'},maximumPages:2,deadlineAtMs:1000,now:()=>now,logger:()=>{}};
 const budget=createWebpageImageBudget(deps),a={key:'read:a',evaluations:1,decodedBytes:20*1024*1024,timeoutMs:300};
 assert.equal((await budget.reserve(a)).value.deadlineAtMs,400);assert.equal((await budget.settle(a.key,8)).ok,true);assert.equal((await budget.complete(a.key,{matches:[]})).ok,true);assert.deepEqual((await budget.lookup(a.key)).value,{matches:[]});
 now=200;const resumed=createWebpageImageBudget(deps);assert.equal((await resumed.reserve(a)).error.kind,'WebpageImageBudgetNotEvaluated');assert.equal(db.prepare('SELECT deadline_at_ms FROM knowledge_workflow_image_attempts').get().deadline_at_ms,400);
 assert.equal((await resumed.reserve({...a,key:'eval',evaluations:31,decodedBytes:0})).ok,true);
 assert.equal((await resumed.reserve({...a,key:'extra',decodedBytes:0})).ok,true);
 assert.equal(db.prepare('SELECT SUM(evaluations) n FROM knowledge_workflow_image_attempts').get().n,33);
 const second=createWebpageImageBudget({...deps,scope:{...deps.scope,pageUrl:'https://source.example/2'}});
 assert.equal((await second.reserve({...a,key:'almost-all',evaluations:31,decodedBytes:127*1024*1024})).ok,true);
 const tail=await second.reserve({...a,key:'all-bytes',evaluations:1,decodedBytes:20*1024*1024});assert.equal(tail.value.maximumBytes,1024*1024);
 assert.equal((await second.reserve({...a,key:'byte-extra',evaluations:0,decodedBytes:1})).ok,false);
 const third=createWebpageImageBudget({...deps,scope:{...deps.scope,pageUrl:'https://source.example/3'}});assert.equal((await third.reserve({...a,key:'page-acquisition',evaluations:0,decodedBytes:0})).ok,false);
 const changed=createWebpageImageBudget({...deps,policy:{...WEBPAGE_IMAGE_POLICY,version:'changed'}});assert.equal((await changed.reserve({...a,key:'policy-change',evaluations:0,decodedBytes:0})).ok,false);
 assert.equal((await second.settle('all-bytes',128*1024*1024+1)).ok,false);
 db.prepare("UPDATE knowledge_workflow_runs SET state='abandoned'").run();assert.equal((await second.settle('all-bytes',1)).ok,false);assert.equal((await second.reserve({...a,key:'late',evaluations:0,decodedBytes:0})).ok,false);
 now=1000;assert.equal((await resumed.reserve({...a,key:'expired'})).error.kind,'WebpageImageRunDeadlineExceeded');
 assert.equal(db.prepare('SELECT SUM(evaluations) n FROM knowledge_workflow_image_attempts').get().n,65);
 }finally{db.close();}
});
test('revision page reads retain legacy deadlines/debits and count distinct pages across retries',async()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const f of (await readdir('worker/migrations')).filter(f=>f.endsWith('.sql')).sort())db.exec(await readFile('worker/migrations/'+f,'utf8'));
  db.prepare("INSERT INTO knowledge_workflow_runs(owner_id,run_id,source_id,source_revision,canonical_source_identity,content_signature,state,revision,idempotency_key,config_digests_json,counts_json,reused,created_at,updated_at,run_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('owner','run','source',1,'https://source.example/','hash','extraction',1,'key','{}','{}',0,'now','now','{}');
  const database={prepare(sql){let values=[];return {bind(...v){values=v;return this;},first:async()=>db.prepare(sql).get(...values)??null,run:async()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}})};}};
  let now=100;const deps={database,policy:WEBPAGE_IMAGE_POLICY,scope:{ownerId:'owner',runId:'run',pageUrl:'https://source.example/1'},maximumPages:2,deadlineAtMs:1000,now:()=>now,logger:()=>{}};
  const budget=createWebpageImageBudget(deps),page={key:'page-acquisition',evaluations:0,decodedBytes:0,timeoutMs:100};
  assert.equal((await budget.reserve(page)).value.deadlineAtMs,200);
  assert.equal((await budget.reserve({key:'read:uncertain',evaluations:1,decodedBytes:20*1024*1024,timeoutMs:100})).ok,true);
  assert.equal((await budget.reserve({key:'model:cached',evaluations:0,decodedBytes:0,timeoutMs:100})).ok,true);
  assert.equal((await budget.complete('model:cached',{source:'persisted'})).ok,true);
  const historical=db.prepare('SELECT * FROM knowledge_workflow_image_attempts ORDER BY attempt_key').all();
  now=300;const resumed=createWebpageImageBudget(deps),newPage={...page,key:'page-acquisition:2'};
  assert.equal((await resumed.reserve(page)).error.kind,'WebpageImageBudgetNotEvaluated');
  assert.equal((await resumed.reserve(newPage)).value.deadlineAtMs,400);
  assert.equal((await resumed.reserve(newPage)).error.kind,'WebpageImageBudgetNotEvaluated','Same-revision repeat cannot renew its admitted read.');
  assert.deepEqual((await resumed.lookup('model:cached')).value,{source:'persisted'});
  assert.deepEqual(db.prepare("SELECT * FROM knowledge_workflow_image_attempts WHERE attempt_key<>'page-acquisition:2' ORDER BY attempt_key").all(),historical);
  const second=createWebpageImageBudget({...deps,scope:{...deps.scope,pageUrl:'https://source.example/2'}});
  assert.equal((await second.reserve({...page,key:'page-acquisition:2'})).ok,true);
  assert.equal((await second.reserve({...page,key:'page-acquisition:3'})).ok,true,'Retries count the same page once.');
  const third=createWebpageImageBudget({...deps,scope:{...deps.scope,pageUrl:'https://source.example/3'}});
  assert.equal((await third.reserve({...page,key:'page-acquisition:4'})).error.kind,'WebpageImageBudgetNotEvaluated','Versioned keys cannot bypass the distinct-page ceiling.');
  assert.equal((await third.reserve(page)).error.kind,'WebpageImageBudgetNotEvaluated','Legacy keys share the same ceiling.');
  assert.equal(db.prepare('SELECT SUM(evaluations) evaluations,SUM(decoded_bytes) bytes FROM knowledge_workflow_image_attempts').get().evaluations,1);
  assert.equal(db.prepare('SELECT SUM(decoded_bytes) bytes FROM knowledge_workflow_image_attempts').get().bytes,20*1024*1024);
  now=1000;assert.equal((await resumed.reserve({...page,key:'page-acquisition:5'})).error.kind,'WebpageImageRunDeadlineExceeded');
  now=400;db.prepare("UPDATE knowledge_workflow_runs SET state='abandoned'").run();assert.equal((await resumed.reserve({...page,key:'page-acquisition:6'})).ok,false);
 }finally{db.close();}
});

test('evaluation counts beyond historical page/run quotas remain recorded without changing old receipts or cache',async()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const f of (await readdir('worker/migrations')).filter(f=>f.endsWith('.sql')).sort())db.exec(await readFile('worker/migrations/'+f,'utf8'));
  db.prepare("INSERT INTO knowledge_workflow_runs(owner_id,run_id,source_id,source_revision,canonical_source_identity,content_signature,state,revision,idempotency_key,config_digests_json,counts_json,reused,created_at,updated_at,run_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('owner','run','source',1,'https://source.example/','hash','extraction',1,'key','{}','{}',0,'now','now','{}');
  const database={prepare(sql){let values=[];return {bind(...v){values=v;return this;},first:async()=>db.prepare(sql).get(...values)??null,run:async()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}})};}};
  let now=100;const deps={database,policy:WEBPAGE_IMAGE_POLICY,scope:{ownerId:'owner',runId:'run',pageUrl:'https://source.example/1'},maximumPages:2,deadlineAtMs:1000,now:()=>now,logger:()=>{}};
  const original=createWebpageImageBudget(deps);
  assert.equal((await original.reserve({key:'historical',evaluations:32,decodedBytes:16,timeoutMs:100})).ok,true);
  assert.equal((await original.settle('historical',8)).ok,true);
  assert.equal((await original.complete('historical',{retained:'cached-output'})).ok,true);
  const historical=db.prepare("SELECT * FROM knowledge_workflow_image_attempts WHERE attempt_key='historical'").get();
  now=300;const resumed=createWebpageImageBudget(deps);
  assert.equal((await resumed.reserve({key:'repair',evaluations:1,decodedBytes:0,timeoutMs:100})).ok,true,'A repair remains admissible after32 prior evaluations.');
  assert.equal((await resumed.reserve({key:'more-page-evaluations',evaluations:40,decodedBytes:0,timeoutMs:100})).ok,true);
  const second=createWebpageImageBudget({...deps,scope:{...deps.scope,pageUrl:'https://source.example/2'}});
  assert.equal((await second.reserve({key:'more-run-evaluations',evaluations:40,decodedBytes:0,timeoutMs:100})).ok,true);
  assert.equal(db.prepare('SELECT SUM(evaluations) n FROM knowledge_workflow_image_attempts WHERE page_url=?').get(deps.scope.pageUrl).n,73);
  assert.equal(db.prepare('SELECT SUM(evaluations) n FROM knowledge_workflow_image_attempts').get().n,113);
  assert.deepEqual(db.prepare("SELECT * FROM knowledge_workflow_image_attempts WHERE attempt_key='historical'").get(),historical);
  assert.deepEqual((await resumed.lookup('historical')).value,{retained:'cached-output'});
  assert.equal((await resumed.reserve({key:'repair',evaluations:1,decodedBytes:0,timeoutMs:100})).error.kind,'WebpageImageBudgetNotEvaluated','An existing attempt cannot renew its deadline.');
  const third=createWebpageImageBudget({...deps,scope:{...deps.scope,pageUrl:'https://source.example/3'}});
  assert.equal((await third.reserve({key:'evaluation-on-new-page',evaluations:1,decodedBytes:0,timeoutMs:100})).ok,false,'Distinct-page scope remains bounded.');
  assert.equal((await resumed.reserve({key:'invalid-count',evaluations:-1,decodedBytes:0,timeoutMs:100})).error.kind,'WebpageImageBudgetCommandInvalid');
 }finally{db.close();}
});
