import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createLearningBatchService} from '../worker/learning-batches-d1.js';
import {D1KnowledgeContentRepository} from '../worker/knowledge-workflow-content-d1.js';

function fixture(days=8,due='2026-10-17T00:00:00.000Z',studied='2026-10-09T00:00:00.000Z') {
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../worker/migrations/0012_learner_batches.sql',import.meta.url),'utf8'));
  db.exec('CREATE TABLE extraction_knowledge_points(owner_id TEXT, knowledge_id TEXT, source_id TEXT);');
  db.prepare('INSERT INTO extraction_knowledge_points VALUES(?,?,?)').run('test-owner','point','music-source');
  db.prepare('INSERT INTO learner_knowledge_state VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('test-owner','point','music-source',3,1,days,due,studied,2,0,'2026-10-09T00:00:00.000Z');
  const database={prepare(query){let bindings=[];return {bind(...values){bindings=values;return this;},async first(){return db.prepare(query).get(...bindings)??null;},async all(){return {success:true,results:db.prepare(query).all(...bindings)};},async run(){const r=db.prepare(query).run(...bindings);return {success:true,meta:{changes:Number(r.changes)}};}};},async batch(statements){db.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const service=createLearningBatchService({database,now:()=> '2026-10-13T00:00:00.000Z',random:()=>0.5,logger:()=>{}});
  return {db,database,service,state:()=>db.prepare('SELECT * FROM learner_knowledge_state').get(),feedback:()=>db.prepare('SELECT * FROM learner_preference_feedback').get()};
}
const command=(choice,idempotencyKey)=>({ownerId:'test-owner',knowledgeId:'point',choice,idempotencyKey});
test('more shortens and less extends adjacent cooldown; retries leave recall history intact',async()=>{
  const f=fixture();try{
    assert.equal((await f.service.setPreference(command('more','more-once'))).ok,true);
    const after=f.state();assert.equal(after.scheduled_days,4);assert.equal(after.due_at,'2026-10-13T00:00:00.000Z');
    assert.equal((await f.service.setPreference(command('more','more-once'))).ok,true);assert.deepEqual(f.state(),after);
    assert.equal((await f.service.setPreference(command('less','less-once'))).ok,true);
    assert.equal(f.state().scheduled_days,8);assert.equal(f.state().due_at,'2026-10-17T00:00:00.000Z');
    assert.equal(f.feedback().choice,'less');assert.equal(f.state().review_count,2);assert.equal(f.state().view_count,3);assert.equal(f.state().last_answer_correct,1);
  }finally{f.db.close();}
});
test('one-day and 365-day endpoints and intermediate intervals follow the existing ladder',async()=>{
  for(const [days,choice,expected] of [[1,'more',1],[365,'less',365],[365,'more',256],[3,'more',2],[3,'less',4]]){
    const f=fixture(days);try{assert.equal((await f.service.setPreference(command(choice,'one'))).ok,true);assert.equal(f.state().scheduled_days,expected);}finally{f.db.close();}
  }
});
test('initial studied content moves from an immediate due date to one day on see-less',async()=>{
  const f=fixture(0,'2026-10-13T00:00:00.000Z');try{
    assert.equal((await f.service.setPreference(command('more','initial-more'))).ok,true);
    assert.equal(f.state().scheduled_days,0);assert.equal(f.state().due_at,'2026-10-13T00:00:00.000Z');
    assert.equal((await f.service.setPreference(command('less','initial-less'))).ok,true);
    assert.equal(f.state().scheduled_days,1);assert.equal(f.state().due_at,'2026-10-14T00:00:00.000Z');
  }finally{f.db.close();}
});
test('unlearned content stays unlearned; foreign owners and unknown points cannot create preferences',async()=>{
  const f=fixture(0,null,null);try{
    assert.equal((await f.service.setPreference(command('less','unlearned'))).ok,true);
    assert.equal(f.state().scheduled_days,0);assert.equal(f.state().due_at,null);assert.equal(f.state().studied_at,null);
    assert.equal((await f.service.setPreference({...command('more','foreign'),ownerId:'foreign-owner'})).ok,false);
    assert.equal((await f.service.setPreference({...command('more','unknown'),knowledgeId:'unknown'})).ok,false);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM learner_preference_feedback').get().n,1);
  }finally{f.db.close();}
});

test('see-less review context stays within the source main subject and owner',async()=>{
  const f=fixture();try{
    f.db.exec(`ALTER TABLE extraction_knowledge_points ADD COLUMN run_id TEXT;
      ALTER TABLE extraction_knowledge_points ADD COLUMN point_json TEXT;
      ALTER TABLE extraction_knowledge_points ADD COLUMN created_at TEXT;
      CREATE TABLE source_classifications(owner_id TEXT,source_id TEXT,main_subject TEXT,status TEXT);
      CREATE TABLE knowledge_workflow_quizzes(owner_id TEXT,source_id TEXT,knowledge_id TEXT,run_id TEXT,created_at TEXT,quiz_id TEXT,draft_json TEXT);`);
    f.db.prepare('DELETE FROM extraction_knowledge_points').run();
    for(const [owner,source,subject,id] of [['test-owner','music-source','music','same-source'],['test-owner','other-music','music','same-subject'],['test-owner','other-subject','employment','different-subject'],['foreign-owner','foreign-source','music','foreign-owner']]){
      f.db.prepare('INSERT INTO source_classifications VALUES(?,?,?,?)').run(owner,source,subject,'classified');
      const point={id,sourceId:source,sourceRevision:1,summary:'A synthetic unwanted concept.',normalizedHash:id,evidenceAnchors:[]};
      f.db.prepare('INSERT INTO extraction_knowledge_points VALUES(?,?,?,?,?,?)').run(owner,id,source,'old-run',JSON.stringify(point),'2026-10-09T00:00:00.000Z');
      f.db.prepare('INSERT INTO learner_preference_feedback VALUES(?,?,?,?,?)').run(owner,id,-1,'less','2026-10-09T00:00:00.000Z');
    }
    const repository=new D1KnowledgeContentRepository({database:f.database,logger:()=>{}});
    const context=await repository.reviewContext({ownerId:'test-owner',sourceId:'music-source',runId:'current-run',knowledgeId:'current-point'});
    assert.equal(context.ok,true);
    assert.deepEqual(context.value.lessOften.map(point=>point.id).sort(),['same-source','same-subject']);
    assert.deepEqual(context.value.previousKnowledge.map(point=>point.id),['same-source']);
    f.db.prepare("UPDATE source_classifications SET status='needs-review' WHERE source_id='music-source'").run();
    const unknown=await repository.reviewContext({ownerId:'test-owner',sourceId:'music-source',runId:'current-run',knowledgeId:'current-point'});
    assert.deepEqual(unknown.value.lessOften.map(point=>point.id).sort(),['different-subject','same-source','same-subject']);
    f.db.prepare("DELETE FROM source_classifications WHERE source_id='music-source'").run();
    const initial=await repository.reviewContext({ownerId:'test-owner',sourceId:'music-source',runId:'initial-run',knowledgeId:'current-point'});
    assert.deepEqual(initial.value.lessOften.map(point=>point.id).sort(),['different-subject','same-source','same-subject']);
  }finally{f.db.close();}
});
