import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {reopenEmptyPageCheckpoints} from '../scripts/openlearn-six-page-pipeline.mjs';

test('isolated false-empty repair preserves committed knowledge, good pages and historical notes',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE extraction_scratchpads(owner_id TEXT,run_id TEXT,revision INTEGER,scratchpad_json TEXT);CREATE TABLE saved_outputs(content TEXT);INSERT INTO saved_outputs VALUES(\'actual fixture preserved\');');
  const identity={ownerId:'owner',runId:'run'},captures=[1,2,3].map(i=>({sourceUrl:`https://example.test/${i}`,responseUrl:`https://example.test/${i}`,evidence:{blocks:[{kind:'text',text:`fixture${i}`}],headings:[],images:[]}}));
  const digests=captures.map(c=>'sha256:'+createHash('sha256').update(JSON.stringify({blocks:c.evidence.blocks,headings:[],images:[]})).digest('hex'));
  const before={...identity,revision:7,processedUrls:captures.map(c=>c.sourceUrl),processedResponseUrls:captures.map(c=>c.responseUrl),processedContentDigests:digests,pageNotes:captures.map((c,i)=>({url:c.sourceUrl,candidateCount:i===1?2:0,note:'Historical fixture note'})),acceptedHashes:['retained-knowledge'],coverage:['retained-goal'],reviewedCandidateCount:3,consecutiveNoveltyZero:2};
  db.prepare('INSERT INTO extraction_scratchpads VALUES(?,?,?,?)').run(identity.ownerId,identity.runId,7,JSON.stringify(before));
  assert.throws(()=>reopenEmptyPageCheckpoints({db,identity,captures,urls:[captures[1].sourceUrl]}),/Invalid/);assert.throws(()=>reopenEmptyPageCheckpoints({db,identity,captures,urls:['https://foreign.test/']}),/Invalid/);
  const audit=reopenEmptyPageCheckpoints({db,identity,captures,urls:[captures[0].sourceUrl,captures[2].sourceUrl]});const after=JSON.parse(db.prepare('SELECT scratchpad_json FROM extraction_scratchpads').get().scratchpad_json);
  assert.deepEqual(after.processedUrls,[captures[1].sourceUrl]);assert.deepEqual(after.processedResponseUrls,[captures[1].responseUrl]);assert.deepEqual(after.processedContentDigests,[digests[1]]);assert.deepEqual(after.frontier,[captures[0].sourceUrl,captures[2].sourceUrl]);assert.equal(after.revision,8);assert.equal(after.consecutiveNoveltyZero,0);
  for(const key of ['acceptedHashes','coverage','reviewedCandidateCount','pageNotes'])assert.deepEqual(after[key],before[key]);assert.equal(db.prepare('SELECT content FROM saved_outputs').get().content,'actual fixture preserved');assert.deepEqual(audit.before,before);assert.deepEqual(audit.after,after);assert.equal(createHash('sha256').update(db.prepare('SELECT audit_json FROM pipeline_empty_page_repairs').get().audit_json).digest('hex'),audit.auditSha256);
  assert.throws(()=>db.exec('DELETE FROM pipeline_empty_page_repairs'),/Immutable/);assert.throws(()=>reopenEmptyPageCheckpoints({db,identity,captures,urls:[captures[0].sourceUrl]}),/Invalid/);
 }finally{db.close();}
});
