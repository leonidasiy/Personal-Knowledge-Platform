import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {createWebpageImageBudget,WEBPAGE_IMAGE_POLICY} from '../worker/webpage-image-budget.js';
test('actual SQLite preserves page/run counters and original attempt deadline across resume, caps and cancellation',async()=>{
 const db=new DatabaseSync(':memory:');try{
 for(const f of (await readdir('worker/migrations')).filter(f=>f.endsWith('.sql')).sort())db.exec(await readFile('worker/migrations/'+f,'utf8'));
 db.prepare("INSERT INTO knowledge_workflow_runs(owner_id,run_id,source_id,source_revision,canonical_source_identity,content_signature,state,revision,idempotency_key,config_digests_json,counts_json,reused,created_at,updated_at,run_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('owner','run','source',1,'https://source.example/','hash','extraction',1,'key','{}','{}',0,'now','now','{}');
 const database={prepare(sql){let values=[];return {bind(...v){values=v;return this;},first:async()=>db.prepare(sql).get(...values)??null,run:async()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}})};}};
 let now=100;const deps={database,policy:WEBPAGE_IMAGE_POLICY,scope:{ownerId:'owner',runId:'run',pageUrl:'https://source.example/'},maximumPages:2,deadlineAtMs:1000,now:()=>now,logger:()=>{}};
 const budget=createWebpageImageBudget(deps),a={key:'read:a',evaluations:1,decodedBytes:20*1024*1024,timeoutMs:300};
 assert.equal((await budget.reserve(a)).value.deadlineAtMs,400);assert.equal((await budget.settle(a.key,8)).ok,true);assert.equal((await budget.complete(a.key,{matches:[]})).ok,true);assert.deepEqual((await budget.lookup(a.key)).value,{matches:[]});
 now=200;const resumed=createWebpageImageBudget(deps);assert.equal((await resumed.reserve(a)).error.kind,'WebpageImageBudgetNotEvaluated');assert.equal(db.prepare('SELECT deadline_at_ms FROM knowledge_workflow_image_attempts').get().deadline_at_ms,400);
 assert.equal((await resumed.reserve({...a,key:'eval',evaluations:31,decodedBytes:0})).ok,true);
 assert.equal((await resumed.reserve({...a,key:'extra',decodedBytes:0})).ok,false);
 assert.equal(db.prepare('SELECT SUM(evaluations) n FROM knowledge_workflow_image_attempts').get().n,32);
 const second=createWebpageImageBudget({...deps,scope:{...deps.scope,pageUrl:'https://source.example/2'}});
 assert.equal((await second.reserve({...a,key:'almost-all',evaluations:31,decodedBytes:127*1024*1024})).ok,true);
 const tail=await second.reserve({...a,key:'all-bytes',evaluations:1,decodedBytes:20*1024*1024});assert.equal(tail.value.maximumBytes,1024*1024);
 assert.equal((await second.reserve({...a,key:'byte-extra',evaluations:0,decodedBytes:1})).ok,false);
 const third=createWebpageImageBudget({...deps,scope:{...deps.scope,pageUrl:'https://source.example/3'}});assert.equal((await third.reserve({...a,key:'page-acquisition',evaluations:0,decodedBytes:0})).ok,false);
 const changed=createWebpageImageBudget({...deps,policy:{...WEBPAGE_IMAGE_POLICY,version:'changed'}});assert.equal((await changed.reserve({...a,key:'policy-change',evaluations:0,decodedBytes:0})).ok,false);
 assert.equal((await second.settle('all-bytes',128*1024*1024+1)).ok,false);
 db.prepare("UPDATE knowledge_workflow_runs SET state='abandoned'").run();assert.equal((await second.settle('all-bytes',1)).ok,false);assert.equal((await second.reserve({...a,key:'late',evaluations:0,decodedBytes:0})).ok,false);
 now=1000;assert.equal((await resumed.reserve({...a,key:'expired'})).error.kind,'WebpageImageRunDeadlineExceeded');
 assert.equal(db.prepare('SELECT SUM(evaluations) n FROM knowledge_workflow_image_attempts').get().n,64);
 }finally{db.close();}
});
