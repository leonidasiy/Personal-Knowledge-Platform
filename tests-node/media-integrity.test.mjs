import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { D1KnowledgeMediaRepository } from '../worker/knowledge-workflow-media-d1.js';
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
for (const purpose of [undefined, 'evidence', 'illustration']) test(`actual migrated SQLite retains ${purpose ?? 'legacy evidence'} purpose and verifies binding/object integrity`,async()=>{
 const db=new DatabaseSync(':memory:');
 try{
 for(const file of (await readdir('worker/migrations')).filter(f=>f.endsWith('.sql')).sort())db.exec(await readFile('worker/migrations/'+file,'utf8'));
 // Narrow repository fixture still uses actual foreign keys/schema; runtime integration owns full run lifecycle.
 db.prepare("INSERT INTO knowledge_workflow_runs(owner_id,run_id,source_id,source_revision,canonical_source_identity,content_signature,state,revision,idempotency_key,config_digests_json,counts_json,reused,created_at,updated_at,run_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('owner','run','source',1,'https://source.example/','hash','completed',1,'key','{}','{}',0,'now','now','{}');
 const point={summary:'Ratios compare quantities.',normalizedHash:'ratio',evidenceAnchors:[{url:'https://source.example/',selector:'p'}]};
 db.prepare('INSERT INTO extraction_knowledge_points VALUES(?,?,?,?,?,?,?,?)').run('owner','run','fact','source',1,'ratio',JSON.stringify(point),'now');
 const database={prepare(sql){let values=[];return {bind(...v){values=v;return this;},first:async()=>db.prepare(sql).get(...values)??null,run:async()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}})};},batch:async statements=>{db.exec("BEGIN");try{const results=[];for(const s of statements)results.push(await s.run());db.exec("COMMIT");return results;}catch(e){db.exec("ROLLBACK");throw e;}}};
 const objects=new Map(); const bucket={put:async(k,b)=>objects.set(k,b.slice()),get:async k=>objects.has(k)?{arrayBuffer:async()=>objects.get(k).slice().buffer}:null,delete:async k=>objects.delete(k)};
 const repo=new D1KnowledgeMediaRepository({database,bucket,logger:()=>{}});
 const bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64'));
 objects.set('original',bytes.slice());
 const binding={kind:'webpage-support',ownerId:'owner',runId:'run',sourceRevision:1,factHash:hash(JSON.stringify(point)),imageId:'actual',originalDigest:hash(bytes),evidence:'Two visible quantity labels.',...(purpose===undefined?{}:{purpose})};
 const asset={ownerId:'owner',runId:'run',knowledgeId:'fact',assetId:'asset',sourceUrl:'https://image.example/a.png',origin:'https://image.example',kind:'image',mediaType:'image/png',byteCount:bytes.length,digest:hash(bytes),privateOriginalKey:'original',attribution:'Fixture',createdAt:'now',binding};
 const derivative={ownerId:'owner',assetId:'asset',derivativeId:'derivative',variant:'feed',mediaType:'image/png',byteCount:bytes.length,privateObjectKey:'derivative',deliveryToken:'token',createdAt:'now'};
 const bad=await repo.save(asset,{...derivative,assetId:'foreign'},bytes);assert.equal(bad.ok,false);assert.equal(objects.size,1);
 for(const invalid of [{...binding,purpose:'unknown'},{...binding,kind:'uploaded-source',purpose:'illustration',locator:'page:1',sourceDigest:'original-source'}]) {
 const rejected=await repo.save({...asset,binding:invalid},derivative,bytes);assert.equal(rejected.ok,false);assert.equal(objects.size,1);
 }
 const saved=await repo.save(asset,derivative,bytes);assert.equal(saved.ok,true,JSON.stringify(saved));
 const good=await repo.read({ownerId:'owner',assetId:'asset',variant:'feed'});assert.equal(good.ok,true,JSON.stringify(good));assert.equal(good.value.purpose,purpose);
 const original=await repo.readOriginal({ownerId:'owner',runId:'run',knowledgeId:'fact',sourceRevision:1});assert.equal(original.ok,true);assert.equal(original.value.purpose,purpose);
 assert.equal((await repo.read({ownerId:'foreign',assetId:'asset',variant:'feed'})).ok,false);
 for(const [field,value] of [['ownerId','foreign'],['runId','foreign'],['factHash',hash('changed')],['imageId',''],['originalDigest',hash('changed')],['sourceRevision',2],['purpose','unknown']]) {
 const altered={...binding,[field]:value};db.prepare('UPDATE knowledge_workflow_media_assets SET binding_json=?').run(JSON.stringify(altered));
 const rejected=await repo.read({ownerId:'owner',assetId:'asset',variant:'feed'});assert.equal(rejected.ok,false,`read must reject ${field}`);
 assert.equal((await repo.readOriginal({ownerId:'owner',runId:'run',knowledgeId:'fact',sourceRevision:1})).ok,false,`original must reject ${field}`);
 } db.prepare('UPDATE knowledge_workflow_media_assets SET binding_json=?').run(JSON.stringify(binding));
 const swapped=bytes.slice();swapped[swapped.length-1]^=1;objects.set('original',swapped);assert.equal((await repo.read({ownerId:'owner',assetId:'asset',variant:'feed'})).ok,false);objects.set('original',bytes);
 const corrupt=bytes.slice();corrupt[corrupt.length-1]^=1;objects.set('derivative',corrupt);
 const changed=await repo.read({ownerId:'owner',assetId:'asset',variant:'feed'});assert.equal(changed.ok,false);assert.equal(changed.error.kind,'MediaIntegrityMismatch');
 assert.equal(db.prepare('SELECT point_json FROM extraction_knowledge_points').get().point_json,JSON.stringify(point));
 }finally{db.close();}
});
