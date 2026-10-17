import {syntheticRelationshipUnits} from './fixtures/webpage-condition-partition.mjs';
import {test} from 'node:test';
import {syntheticAssessment} from './fixtures/knowledge-review-audit.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createKnowledgeWorkflowRuntime} from '../worker/knowledge-workflow-runtime.js';
import {createKnowledgeWorkflowService} from '../src/features/knowledge-workflows/workflow.js';
import {createAgentConfigurationLoader} from '../src/features/knowledge-workflows/config.js';
import {D1SourceLibraryRepository} from '../worker/source-library-d1.js';
import {D1KnowledgeWorkflowRepository} from '../worker/knowledge-workflow-d1.js';
import {WEBPAGE_IMAGE_POLICY} from '../worker/webpage-image-budget.js';
import {quoteHash} from '../worker/webpage-facts.js';
import {createKnowledgeWorkflowLogger} from '../worker/knowledge-workflow-logging.js';

for(const partial of [false,true])test(`native application normalizes once at the configured reviewer ceiling and defers preliminary grounding partial=${partial}; no network`,async()=>{
 const db=new DatabaseSync(':memory:'),originalFetch=globalThis.fetch;let network=0;
 globalThis.fetch=()=>{network++;assert.fail('ZERO_NETWORK_SENTINEL');};
 try{
  for(const name of (await readdir('worker/migrations')).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile('worker/migrations/'+name,'utf8'));
  const database={prepare(sql){let values=[];const execute=()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}});return {bind(...v){values=v;return this;},first:async()=>db.prepare(sql).get(...values)??null,all:async()=>({success:true,results:db.prepare(sql).all(...values)}),run:async()=>execute(),execute};},async batch(statements){db.exec('BEGIN IMMEDIATE');try{const r=statements.map(s=>s.execute());db.exec('COMMIT');return r;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const unwrap=r=>{assert.equal(r.ok,true,JSON.stringify(r.error));return r.value;};
  const records=[],clock=()=>new Date().toISOString(),logger=createKnowledgeWorkflowLogger({sink:r=>records.push(r),now:clock});
  const ownerId='glm-fixture-owner',runId='glm-fixture-run',sourceId='glm-fixture-source',url='https://fixture.test/lesson';
  const loader=createAgentConfigurationLoader({sha256:async s=>'sha256:'+createHash('sha256').update(s).digest('hex')}),configs={};
  for(const role of ['rights-assessor','knowledge-scraper','question-generator','question-evaluator'])configs[role]=unwrap(await loader.load({source:await readFile('agent-config/'+role+'.yaml','utf8'),expectedRole:role}));

  const repository=new D1KnowledgeWorkflowRepository({database,logger}),service=createKnowledgeWorkflowService(repository,{now:clock,createId:()=>runId,logger});
  let run=unwrap(await service.createRun({ownerId,sourceId,sourceRevision:1,canonicalSourceIdentity:url,contentSignature:'fixture-revision',idempotencyKey:runId,configDigests:Object.fromEntries(Object.entries(configs).map(([role,c])=>[role,c.digest])),userAuthorization:{kind:'user-authorized-link',ownerId,sourceId,sourceRevision:1,url,recordedAt:clock()}})).run;
  run=unwrap(await service.advance({ownerId,runId,expectedRevision:run.revision,nextState:'rights-assessment'}));
  db.prepare('INSERT INTO library_sources(owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(ownerId,sourceId,url,url,'Fixture','Synthetic source','{"kind":"website"}','[]','active',clock(),clock(),1);
  const block={id:'block:1',locator:'main > p',sectionId:'section:root',kind:'text',figureId:null,text:'A ratio compares two quantities with matching units.'};
  const image={id:'image:1',url:'https://fixture.test/diagram.png',occurrences:[{id:'occurrence:1',locator:'main > img',sectionId:'section:root',figureId:null,captionId:null,alt:'Pixels must not create facts.'}],occurrenceWindows:[['occurrence:1']]};
  const evidence={url,blocks:[block],images:[image],headings:[],warnings:[]},operations=[];
  const fetch=async(_url,init)=>{
   const body=JSON.parse(init.body),message=body.messages[1].content,envelope=Array.isArray(message)?message[0].text:message;
   const parsed=JSON.parse(envelope.slice(envelope.indexOf('\n')+1,envelope.lastIndexOf('\n'))),initialTask=parsed.task??parsed;let task=initialTask;while(task.task)task=task.task;
   operations.push(task.operation??(task.draft?'critic':task.auditEvidence?'native-review':task.knowledge?'quiz':'classification'));
   if(['normalize-webpage-claim-boundaries','verify-webpage-facts'].includes(task.operation)){assert.equal(body.model,configs['question-evaluator'].model.name);assert.equal(body.reasoning.effort,'none');assert.equal(body.max_tokens,task.operation==='normalize-webpage-claim-boundaries'?32768:2048);}
   if(task.operation==='extract-webpage-facts')assert.equal(body.model,configs['knowledge-scraper'].model.name);
   let output;
   if(body.response_format?.json_schema?.name==='knowledge_batch_selection_v1')output={keptKnowledgeIds:task.points.map(point=>point.id)};
   else if(task.operation==='plan'||task.operation==='replan')output={revision:1,frontier:task.operation==='plan'?[url]:[],coverageGoals:[],unresolvedGaps:[],stopDecision:{decision:task.operation==='plan'?'continue':'complete',rationale:'Synthetic captured source.',evidenceUrls:[url],unresolvedGapIds:[]}};
   else if(task.operation==='extract-webpage-facts'){assert.equal(body.response_format.type,'json_schema');assert(!Array.isArray(message));output={notes:'',candidates:[...(partial?[null]:[]),{summary:block.text,normalizedHash:'ratio',coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{reference:task.citationSources.find(s=>s.sourceId===block.id).reference,clause:block.text}]}]};}
   else if(task.operation==='normalize-webpage-claim-boundaries'){assert.equal(body.response_format.type,'json_object','Existing application reviewer transport does not add an API schema feature');assert.match(body.messages[0].content,/webpage-claim-boundaries-v13-compact-unchanged/);output={notes:task.notes,additionalCandidates:[],reviews:task.candidates.map(c=>({sourceNormalizedHash:c.normalizedHash,relationshipUnits:syntheticRelationshipUnits([c]),candidates:[c]}))};}
  else if(task.operation==='verify-webpage-facts'){assert.equal(body.response_format.type,'json_object');assert.equal(task.candidates[0].evidenceAnchors[0].url,url);assert.equal(task.candidates[0].evidenceAnchors[0].quoteDigest,await quoteHash(block.text));output={verdicts:[{normalizedHash:'ratio',grounded:true,useful:true}]};}
   else if(task.operation==='match-webpage-images')return new Response(null,{status:502});
   else if(task.source&&task.points)output={mainSubject:'mathematics',topic:'Ratios'};
   else if(task.draft)output={score:9,reasons:['Synthetic supported answer.'],feedback:'Accepted synthetic fixture.',groundingProblems:[],knowledgeGroundingProblems:[]};
   else if(task.auditEvidence){assert.equal(body.max_tokens,4096);output=syntheticAssessment(task,{decision:'pass',reasons:['Synthetic supported relationship.'],feedback:'Retain supported text.',allowTextOnly:true,matchedLessOftenIds:[],supportingImageEvidence:''});}
   else if(task.knowledge)output={knowledgeId:task.knowledge.id,knowledgeRevision:1,canonicalAnswers:['ratio'],citedEvidenceUrls:[url],multipleChoice:{prompt:'Which relationship compares quantities?',options:[{key:'a',text:'A ratio'},{key:'b',text:'A date'}],correctOptionKeys:['a'],correctOptionAnswers:[{key:'a',canonicalAnswer:'ratio'}],explanation:'A ratio compares quantities.'},fillBlank:{prompt:'A ____ compares quantities.',blanks:[{id:'blank-1',canonicalAnswer:'ratio',acceptedAnswers:['ratio']}],explanation:'A ratio compares quantities.'}};
   else assert.fail('Unexpected fixture model task '+task.operation);
   return Response.json({id:'synthetic-'+operations.length,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output),reasoning:'PRIVATE_REASONING'}}],usage:{prompt_tokens:1,completion_tokens:1}});
  };
  const browser={readPage:async()=>({ok:true,value:{url,responseUrl:url,renderedTitle:'Synthetic ratio source',contentType:'text/html',bytes:new TextEncoder().encode('<main><p>'+block.text+'</p></main>'),redirects:0,evidence}}),readRobots:async()=>({ok:true,value:{status:200,bytes:new TextEncoder().encode('User-agent: *\nAllow: /')}}),screenshot:async()=>assert.fail('Text extraction must not screenshot.'),close:async()=>({ok:true,value:null})};
  const runtime=createKnowledgeWorkflowRuntime({webpageStructuredOutput:true,imagePolicy:WEBPAGE_IMAGE_POLICY,database,fetch,browser,apiKey:'synthetic',endpoint:'https://fixture.test/model',now:clock,nowMs:Date.now,logger,configSnapshots:configs,resolveAddresses:async()=>({ok:true,value:['93.184.216.34']}),publicEgress:{fetch:async()=>({ok:true,value:new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{'content-type':'image/png'}})})},transition:({run:current,nextState,...rest})=>service.advance({ownerId,runId,expectedRevision:current.revision,nextState,...rest})});
  const executed=await runtime.execute(run);assert(executed.ok,JSON.stringify({error:executed.error,operations,records}));
  const persisted=unwrap(await repository.findById(ownerId,runId));assert.equal(persisted.state,'completed');assert.equal(persisted.counts.knowledgePoints,1,JSON.stringify({operations,failures:records.filter(r=>r.failureKind)}));assert.equal(persisted.counts.acceptedQuizzes,1);
  const rows=db.prepare('SELECT point_json FROM extraction_knowledge_points WHERE owner_id=? AND run_id=?').all(ownerId,runId);assert.equal(rows.length,1);const point=JSON.parse(rows[0].point_json);assert.equal(point.summary,block.text);assert.deepEqual(point.mediaCandidates,[]);assert.equal(point.evidenceAnchors[0].quoteDigest,await quoteHash(block.text));
  const warnings=db.prepare('SELECT warnings_json FROM knowledge_workflow_page_image_warnings WHERE owner_id=? AND run_id=?').all(ownerId,runId);assert(warnings.some(r=>r.warnings_json.includes('KnowledgeModelRejected')&&r.warnings_json.includes('Text retained')));
  if(partial){const warning=warnings.map(r=>r.warnings_json).join('');assert(warning.includes('Text extraction partial'));assert(warning.includes('WebpageCandidateInvalid'));assert(warnings.flatMap(r=>JSON.parse(r.warnings_json)).some(w=>w.includes('\"candidateIndex\":0')));}
  const library=unwrap(await new D1SourceLibraryRepository(database).knowledgeSemanticCandidates({ownerId,limit:10}));assert.equal(library.candidates.length,1);assert.equal(library.candidates[0].knowledge.summary,block.text);assert.equal(library.privateDerivedCount,0);
  assert.equal(operations.filter(o=>o==='extract-webpage-facts').length,1);assert.equal(operations.filter(o=>o==='verify-webpage-facts').length,0);assert.equal(operations.filter(o=>o==='native-review').length,1);assert.equal(operations.filter(o=>o==='normalize-webpage-claim-boundaries').length,partial?0:1);assert.equal(operations.filter(o=>o==='match-webpage-images').length,4);assert(!operations.includes('verify-webpage-image'));assert(records.some(r=>r.stage==='knowledge-scraper'&&r.event==='knowledge-model-success'));assert(!JSON.stringify(records).includes('PRIVATE_REASONING'));assert.equal(network,0);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
