import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {createWebpageImageBudget,WEBPAGE_IMAGE_POLICY} from '../worker/webpage-image-budget.js';
import {createWebpageImageCache} from '../worker/webpage-image-cache.js';
import {associateWebpageImages,imageHash} from '../worker/webpage-images.js';
import {createKnowledgeWorkflowCleanup} from '../worker/knowledge-workflow-cleanup.js';

const scope={ownerId:'owner',runId:'run',sourceRevision:1,pageUrl:'https://source.example/lesson'};
const image={id:'source-image',url:'https://images.example/chart.png'};
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
const evidence={url:scope.pageUrl,headings:[],blocks:[{id:'b',locator:'p',sectionId:'s',kind:'text',text:'Ratios compare quantities.',figureId:null}],images:[{...image,occurrences:[{id:'o',locator:'img',sectionId:'s',figureId:null,captionId:null,alt:'Chart'}],occurrenceWindows:[['o']]}],warnings:[]};
const fact={summary:'Ratios compare quantities.',normalizedHash:'ratio',evidenceAnchors:[{url:scope.pageUrl,selector:'p'}],coverageGoalIds:[],mediaCandidates:[]};

async function fixture(){
 const db=new DatabaseSync(':memory:');
 for(const name of(await readdir('worker/migrations')).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile('worker/migrations/'+name,'utf8'));
 db.prepare("INSERT INTO knowledge_workflow_runs(owner_id,run_id,source_id,source_revision,canonical_source_identity,content_signature,state,revision,idempotency_key,config_digests_json,counts_json,reused,created_at,updated_at,run_json)VALUES(?,?,?,?,?,?,'extraction-loop',1,'key','{}','{}',0,'now','now','{}')").run(scope.ownerId,scope.runId,'source',1,scope.pageUrl,'hash');
 const database={prepare(sql){let values=[];const statement={bind(...v){values=v;return this;},first:async()=>db.prepare(sql).get(...values)??null,all:async()=>({success:true,results:db.prepare(sql).all(...values)}),run:async()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}})};return statement;},async batch(statements){db.exec('BEGIN IMMEDIATE');try{const results=[];for(const statement of statements)results.push(await statement.run());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const objects=new Map(),logs=[],deleted=[];let clock=100,putHook,deleteFailure=false;
 const bucket={async put(key,bytes){if(putHook)await putHook(key);objects.set(key,bytes.slice());},async get(key){const bytes=objects.get(key);return bytes?{arrayBuffer:async()=>bytes.slice().buffer}:null;},async delete(key){deleted.push(key);if(deleteFailure)throw Error('Synthetic deletion unavailable');objects.delete(key);}};
 const makeBudget=()=>createWebpageImageBudget({database,policy:WEBPAGE_IMAGE_POLICY,scope,maximumPages:100,deadlineAtMs:5000,now:()=>clock,logger:e=>logs.push(e)});
 const budget=makeBudget(),makeCache=(b=budget)=>createWebpageImageCache({database,bucket,budget:b,scope,logger:e=>logs.push(e)});
 const run={...scope,sourceId:'source',canonicalSourceIdentity:scope.pageUrl,state:'extraction-loop'};
 const cleanup=createKnowledgeWorkflowCleanup({database,bucket,now:()=> '2026-10-13T00:00:00.000Z',logger:e=>logs.push(e),workflowRepository:{listBySource:async()=>({ok:true,value:[run]}),invalidateReuse:async()=>({ok:true,value:null}),markAbandoned:async()=>{db.prepare("UPDATE knowledge_workflow_runs SET state='abandoned'").run();return {ok:true,value:null};}}});
 const reserve=()=>budget.reserve({key:`read:${image.id}`,evaluations:1,decodedBytes:20*1024*1024,timeoutMs:100});
 const save=async()=>{assert.equal((await reserve()).ok,true);assert.equal((await budget.settle(`read:${image.id}`,png.length)).ok,true);return makeCache().save(image,{bytes:png,mediaType:'image/png'});};
 return {db,database,bucket,objects,logs,deleted,budget,makeBudget,makeCache,cleanup,run,save,set clock(v){clock=v;},set putHook(v){putHook=v;},set deleteFailure(v){deleteFailure=v;}};
}

test('original images resume before reservation with unchanged settled debit and exact private bytes',async()=>{
 const f=await fixture();try{
  let reads=0;
  const associate=budget=>associateWebpageImages({scope,facts:[fact],evidence,deferQualityReview:true,budget,originalImageCache:f.makeCache(budget),readImage:async()=>{reads++;return {ok:true,value:{bytes:png,mediaType:'image/png'}};},digest:imageHash,logger:()=>{},generate:async command=>({ok:true,value:{matches:[{normalizedHash:'ratio',status:'match',imageId:image.id,imageDigest:command.input.candidates[0].digest}]}})});
  const first=await associate(f.budget);assert(first.ok);assert.equal(first.value[0].status,'review-pending');
  const before=f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').all();assert.equal(before.length,1);assert.equal(before[0].evaluations,1);assert.equal(before[0].decoded_bytes,png.length);assert.equal(before[0].settled,1);assert(before[0].output_json.length<1000);assert(!before[0].output_json.includes('base64'));
  f.clock=1000;const resumed=await associate(f.makeBudget());assert(resumed.ok);assert.equal(resumed.value[0].status,'review-pending');assert.deepEqual(resumed.value[0].image.bytes,png);assert.equal(reads,1);assert.deepEqual(f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').all(),before);
  resumed.value[0].image.bytes[0]=0;assert.deepEqual((await f.makeCache().load(image)).value.bytes,png);
 }finally{f.db.close();}
});

test('corrupt bytes, foreign identities and arbitrary storage keys never fall back to another read',async()=>{
 for(const variant of ['bytes','owner','url','key','mime']){
  const f=await fixture();try{assert.equal((await f.save()).ok,true);const row=f.db.prepare('SELECT output_json FROM knowledge_workflow_image_attempts').get(),receipt=JSON.parse(row.output_json);
   if(variant==='bytes')f.objects.set(receipt.objectKey,new Uint8Array(png.length));
   else{if(variant==='owner')receipt.ownerId='other';if(variant==='url')receipt.imageUrl='https://images.example/other.png';if(variant==='key')receipt.objectKey='private-other-owner';if(variant==='mime')receipt.mediaType='image/jpeg';f.db.prepare('UPDATE knowledge_workflow_image_attempts SET output_json=?').run(JSON.stringify(receipt));}
   const before=f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').all();
   const result=await associateWebpageImages({scope,facts:[fact],evidence,budget:f.budget,originalImageCache:f.makeCache(),readImage:async()=>assert.fail('Cache rejection must not download'),digest:imageHash,generate:async()=>assert.fail('Cache rejection must not match'),logger:()=>{}});
   assert(result.ok);assert.equal(result.value[0].status,'not-evaluated');assert.deepEqual(f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').all(),before);
  }finally{f.db.close();}
 }
});

test('historical settled or unknown reads without a receipt remain blocked and unchanged',async()=>{
 for(const settled of [false,true]){const f=await fixture();try{
  assert.equal((await f.budget.reserve({key:`read:${image.id}`,evaluations:1,decodedBytes:20*1024*1024,timeoutMs:100})).ok,true);if(settled)assert.equal((await f.budget.settle(`read:${image.id}`,png.length)).ok,true);
  const before=f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').all();f.clock=1000;
  const result=await associateWebpageImages({scope,facts:[fact],evidence,budget:f.budget,originalImageCache:f.makeCache(),readImage:async()=>assert.fail('Unproven legacy bytes cannot be read'),digest:imageHash,generate:async()=>assert.fail('No pixels'),logger:()=>{}});
  assert(result.ok);assert.equal(result.value[0].failureKind,'WebpageImageBudgetNotEvaluated');assert.deepEqual(f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').all(),before);
 }finally{f.db.close();}}
});

test('verified settled originals journal receipts after read expiry without changing deadline or debit',async()=>{
 const f=await fixture();try{
  assert.equal((await f.budget.reserve({key:`read:${image.id}`,evaluations:1,decodedBytes:20*1024*1024,timeoutMs:100})).ok,true);
  assert.equal((await f.budget.settle(`read:${image.id}`,png.length)).ok,true);
  const before=f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').get();f.clock=1000;
  assert.equal((await f.budget.complete(`read:${image.id}`,{modelOutput:true})).error.kind,'WebpageImageBudgetModelCompletionFailed');
  assert.equal((await f.makeCache().save(image,{bytes:png,mediaType:'image/png'})).ok,true);
  const after=f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').get();assert(after.output_json);
  assert.deepEqual({...after,output_json:null},{...before});assert.deepEqual((await f.makeCache().load(image)).value.bytes,png);
  const duplicate=await f.makeCache().save(image,{bytes:png,mediaType:'image/png'});assert.equal(duplicate.error.kind,'WebpageImageCacheReceiptAlreadyStored');assert.deepEqual(f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').get(),after);
 }finally{f.db.close();}
});

test('receipt restoration refuses unknown, wrong length, policy, source revision and cancelled reads',async()=>{
 for(const variant of ['unknown','length','policy','revision','cancelled']){
  const f=await fixture();try{
   assert.equal((await f.budget.reserve({key:`read:${image.id}`,evaluations:1,decodedBytes:20*1024*1024,timeoutMs:100})).ok,true);
   if(variant!=='unknown')assert.equal((await f.budget.settle(`read:${image.id}`,variant==='length'?png.length+1:png.length)).ok,true);
   if(variant==='policy')f.db.prepare("UPDATE knowledge_workflow_image_attempts SET policy_json='{}'").run();
   if(variant==='revision')f.db.prepare('UPDATE knowledge_workflow_runs SET source_revision=2').run();
   if(variant==='cancelled')assert.equal((await f.cleanup.abandonRun({run:f.run,reason:'user-cancelled'})).ok,true);
   const before=f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').all();f.clock=1000;
   assert.equal((await f.makeCache().save(image,{bytes:png,mediaType:'image/png'})).ok,false);
   assert.equal(f.objects.size,0);assert.deepEqual(f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').all(),before);
  }finally{f.db.close();}
 }
});

test('cancelled late writes delete the object and retain a cleanup key for failed deletion retries',async()=>{
 const f=await fixture();try{
  let release,started;const pending=new Promise(r=>release=r),putStarted=new Promise(r=>started=r);f.putHook=async()=>{started();await pending;};
  const saving=f.save();await putStarted;
  assert.equal((await f.cleanup.abandonRun({run:f.run,reason:'user-cancelled'})).ok,true);assert.equal(f.objects.size,0);
  f.deleteFailure=true;release();assert.equal((await saving).error.kind,'WebpageImageCacheUnavailable');assert.equal(f.objects.size,1);assert(f.logs.some(e=>e.failureKind==='WebpageImageCacheCleanupFailed'));
  assert.equal((await f.makeCache().load(image)).value,null); // native budget fence hides abandoned receipts
  const before=f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').all();assert(before[0].output_json);assert.equal(before[0].settled,1);
  f.deleteFailure=false;assert.equal((await f.cleanup.abandonRun({run:f.run,reason:'user-cancelled'})).ok,true);assert.equal(f.objects.size,0);assert.deepEqual(f.db.prepare('SELECT * FROM knowledge_workflow_image_attempts').all(),before);
 }finally{f.db.close();}
});

test('non-terminal purge fences pending cache writes before remote deletion',async()=>{
 const f=await fixture();try{
  let release,started;const pending=new Promise(r=>release=r),putStarted=new Promise(r=>started=r);f.putHook=async()=>{started();await pending;};
  const saving=f.save();await putStarted;assert.equal((await f.cleanup.abandonRun({run:f.run,reason:'replacement'})).ok,true);
  assert.equal(f.db.prepare('SELECT state FROM knowledge_workflow_runs').get().state,'extraction-loop');release();assert.equal((await saving).error.kind,'WebpageImageCacheUnavailable');assert.equal(f.objects.size,0);
 }finally{f.db.close();}
});

test('cleanup refuses a tampered cache object key and never deletes another private object',async()=>{
 const f=await fixture();try{assert.equal((await f.save()).ok,true);const receipt=JSON.parse(f.db.prepare('SELECT output_json FROM knowledge_workflow_image_attempts').get().output_json);receipt.objectKey='foreign-private-original';f.db.prepare('UPDATE knowledge_workflow_image_attempts SET output_json=?').run(JSON.stringify(receipt));assert.equal((await f.cleanup.abandonRun({run:f.run,reason:'cancelled'})).error.kind,'WorkflowCleanupFailed');assert(!f.deleted.includes('foreign-private-original'));}finally{f.db.close();}
});
