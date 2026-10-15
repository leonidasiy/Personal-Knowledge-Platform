import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyEvaluationFailure,isTerminalPipelineFailure,runIndependentEvaluation,scoreSemanticEvaluation,runEvaluation,reportWholeCases} from '../scripts/webpage-image-evaluation.mjs';
import {runReviewedHiddenCase} from '../scripts/benchmark-hidden-learning.mjs';
import {runBenchmarkQuizzes} from '../scripts/benchmark-learning-quiz.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createEvaluationLedger} from '../scripts/evaluation-budget.mjs';
import {createSyntheticSelectedEvaluationFixture} from './fixtures/evaluation/synthetic-selected.mjs';
import {readFrozenEvaluationCatalog} from './fixtures/evaluation/catalog.mjs';
import {createSyntheticEvaluationFixture} from './fixtures/evaluation/synthetic.mjs';
const ok=value=>({ok:true,value});
const idle={activeRequests:0,admissionHalted:null,cancelled:false,requests:0};

test('operation origin distinguishes application reviewer failures, independent judge failures, external providers and accounting stops',()=>{
 assert.equal(classifyEvaluationFailure({kind:'KnowledgeModelResponseInvalid'},'pipeline'),'pipeline');
 assert.equal(classifyEvaluationFailure({kind:'KnowledgeModelResponseInvalid'},'evaluator'),'evaluator');
 assert.equal(classifyEvaluationFailure({kind:'QuizEvaluatorFailed',causeKind:'KnowledgeModelUnavailable'}),'external');
 for(const origin of ['pipeline','evaluator']){
  assert.equal(classifyEvaluationFailure({kind:'EvaluationProviderError',httpStatus:429},origin),'external');
  assert.equal(classifyEvaluationFailure({kind:'EvaluationBudgetExceeded'},origin),'stop');
 }
 assert.equal(isTerminalPipelineFailure({kind:'KnowledgeModelCommandInvalid'},idle),true);
 assert.equal(isTerminalPipelineFailure({kind:'EvaluationPipelineRequestRejected',httpStatus:400},idle),true);
 for(const usage of [{...idle,activeRequests:1},{...idle,admissionHalted:'EvaluationUsageInvalid'},{...idle,effectiveCancelled:true}])assert.equal(isTerminalPipelineFailure({kind:'KnowledgeModelCommandInvalid'},usage),false);
});

test('actual semantic evaluator retries technical output errors, keeps valid prior judgments, and stops on an actual false grade',async()=>{
 const {config,corpus}=createSyntheticEvaluationFixture(),item=corpus.cases[0],predictions=item.labels.map(l=>({caseId:item.id,summary:l.summary,imageId:l.matchable?'i':null,status:l.matchable?'match':'no-support'})),calls=[];
 let malformed=3;
 const generate=async c=>{
  calls.push(c);assert.equal(c.failureOrigin,'evaluator');
  if(c.input.operation==='judge-source-summary-equivalence')return ok({verdicts:predictions.map((p,i)=>({predictionIndex:i,labelIds:[],fullySupported:false,clauses:[p.summary]})),coverage:item.labels.map(l=>({labelId:l.id,predictionIndices:[],fullyCovered:false}))});
  if(c.input.operation==='judge-source-support'){
   if(malformed-->0)return ok({verdicts:['invalid grader object']});
   return ok({verdicts:predictions.map((p,i)=>({predictionIndex:i,fullySupported:false,clauses:[{text:p.summary,evidence:[]}]}))});
  }
  return ok({verdicts:predictions.map((p,i)=>({predictionIndex:i,supportClausesEquivalent:true,semanticClausesEquivalent:true}))});
 };
 const result=await runIndependentEvaluation({generate,evaluate:generate=>scoreSemanticEvaluation({cases:[item],predictions,thresholds:config.thresholds,generate})});
 assert(result.ok);assert.equal(result.value.wholeCases[0].passes,false);
 assert.equal(calls.filter(c=>c.input.operation==='judge-source-summary-equivalence').length,1);
 const support=calls.filter(c=>c.input.operation==='judge-source-support');assert.equal(support.length,4);assert.equal(new Set(support.map(c=>c.taskId)).size,4);
 assert(support.some(c=>c.taskId.includes(':evaluator-retry-')));
});

test('pixel-only web support retry receives exact failed judgment and validator feedback before returning a terminal negative',async()=>{
 const {config,corpus}=createSyntheticEvaluationFixture(),item=corpus.cases[0],predictions=item.labels.map(label=>({caseId:item.id,summary:label.summary,imageId:label.matchable?'i':null,status:label.matchable?'match':'no-support'})),calls=[];
 const invalid={verdicts:predictions.map((prediction,predictionIndex)=>({predictionIndex,fullySupported:true,clauses:[{text:prediction.summary,evidence:[{kind:'pixels',id:'i',cue:'Synthetic visible relationship.'}]}]}))};
 let supportCalls=0,originalInput;
 const generate=async command=>{
  calls.push(command);
  if(command.input.operation==='judge-source-summary-equivalence')return ok({verdicts:predictions.map((prediction,predictionIndex)=>({predictionIndex,labelIds:[item.labels[predictionIndex].id],fullySupported:true,clauses:[prediction.summary]})),coverage:item.labels.map((label,index)=>({labelId:label.id,predictionIndices:[index],fullyCovered:true}))});
  if(command.input.operation==='judge-source-support'){
   supportCalls++;
   if(supportCalls===1){originalInput=structuredClone(command.input);assert.equal(command.input.evaluatorCorrection,undefined);return ok(invalid);}
   assert(supportCalls<=3,'A valid negative judgment must terminate evaluator retries.');
   assert.deepEqual(command.input.evaluatorCorrection,{validationError:{kind:'EvaluationSemanticEvidenceInvalid',field:'unsupported clause: predictionIndex=0, clauseIndex=0, reason=missing captured text for webpage-text'},previousJudgment:invalid});
   const {evaluatorCorrection,...input}=command.input;assert.deepEqual(input,originalInput);
   assert.match(command.systemPrompt,/untrusted diagnostic data/);assert.match(command.systemPrompt,/Do not change pipeline predictions/);assert.match(command.systemPrompt,/otherwise set fullySupported=false/);assert.match(command.systemPrompt,/Never invent or select an arbitrary reference/);
   if(supportCalls===2)return ok(structuredClone(invalid));
   return ok({verdicts:predictions.map((prediction,predictionIndex)=>({predictionIndex,fullySupported:false,clauses:[{text:prediction.summary,evidence:[]}]}))});
  }
  assert.equal(command.input.operation,'judge-complete-claim-clauses');
  return ok({verdicts:predictions.map((_,predictionIndex)=>({predictionIndex,supportClausesEquivalent:true,semanticClausesEquivalent:true}))});
 };
 const result=await runIndependentEvaluation({generate,evaluate:generate=>scoreSemanticEvaluation({cases:[item],predictions,thresholds:config.thresholds,generate})});
 assert(result.ok);assert.equal(result.value.wholeCases[0].passes,false);
 assert.equal(calls.filter(command=>command.input.operation==='judge-source-summary-equivalence').length,1);
 assert.equal(calls.filter(command=>command.input.operation==='judge-complete-claim-clauses').length,1);
 const support=calls.filter(command=>command.input.operation==='judge-source-support');assert.equal(support.length,3);assert.equal(new Set(support.map(command=>command.taskId)).size,3);
 assert.deepEqual(support.map(command=>command.taskId),[item.id+':source-support-v1',item.id+':source-support-v1:evaluator-retry-1',item.id+':source-support-v1:evaluator-retry-2']);
});

for(const stage of ['source-support','semantic'])test(`complete ${stage} coverage feedback repairs only its mapped task and dependent audit`,async()=>{
 const calls=[],original={verdicts:[{predictionIndex:0,complete:false}]},corrected={verdicts:[{predictionIndex:0,complete:true}]},auditInvalid={verdicts:[{predictionIndex:0,supportClausesEquivalent:true,semanticClausesEquivalent:true},{predictionIndex:1,supportClausesEquivalent:stage!=='source-support',semanticClausesEquivalent:stage!=='semantic'}]},auditValid={verdicts:[0,1].map(predictionIndex=>({predictionIndex,supportClausesEquivalent:true,semanticClausesEquivalent:true}))};
 const failure={kind:stage==='source-support'?'EvaluationSemanticEvidenceInvalid':'EvaluationSemanticJudgmentInvalid',field:`complete ${stage} claim coverage`};
 const task='synthetic:'+stage+'-v1',audit='synthetic:complete-claim-clauses-v1';
 const generate=async command=>{
  calls.push(command);
  if(command.taskId===task)return ok(original);
  if(command.taskId===task+':evaluator-retry-1'){
   assert.deepEqual(command.input.evaluatorCorrection,{validationError:failure,previousJudgment:original,completeClaimAudit:{taskId:audit,verdicts:auditInvalid.verdicts}});
   assert.deepEqual(command.input.predictions,['Immutable prediction.','A second immutable prediction.']);assert.match(command.systemPrompt,/false equivalence identifies a representation mismatch, not source truth/);assert.match(command.systemPrompt,/never fill a gap with source-only or reference-only facts/);assert.deepEqual(original,{verdicts:[{predictionIndex:0,complete:false}]});assert.equal(command.maxOutputTokens,1);return ok(corrected);
  }
  if(command.taskId===audit)return ok(auditInvalid);
  if(command.taskId===audit+':evaluator-retry-1'){
   assert.deepEqual(command.input.evaluatorCorrection,{validationError:failure,previousJudgment:auditInvalid});return ok(auditValid);
  }
  assert.equal(command.taskId,'synthetic:valid-prior');return ok({valid:true});
 };
 const evaluate=async dispatch=>{
  await dispatch({taskId:'synthetic:valid-prior',input:{operation:'valid'},systemPrompt:'fixture',maxOutputTokens:1});
  const judgment=await dispatch({taskId:task,input:{operation:stage,predictions:['Immutable prediction.','A second immutable prediction.']},systemPrompt:'fixture',maxOutputTokens:1});
  const checked=await dispatch({taskId:audit,input:{operation:'audit',predictions:['Immutable prediction.','A second immutable prediction.']},systemPrompt:'fixture',maxOutputTokens:1});
  return judgment.value.verdicts[0].complete&&checked.value.verdicts.every(v=>v.supportClausesEquivalent&&v.semanticClausesEquivalent)?ok({passes:false}):{ok:false,error:failure};
 };
 assert.deepEqual(await runIndependentEvaluation({generate,evaluate}),ok({passes:false}));
 assert.deepEqual(calls.map(command=>command.taskId),['synthetic:valid-prior',task,audit,task+':evaluator-retry-1',audit+':evaluator-retry-1']);
});

test('evaluator technical errors retry beyond previous count and hard budget fences stop execution',async()=>{
 const calls=[];let remaining=45;
 const result=await runIndependentEvaluation({generate:async c=>{calls.push(c.taskId);return remaining-->0?{ok:false,error:{kind:'KnowledgeModelResponseInvalid'}}:{ok:false,error:{kind:'EvaluationBudgetExceeded'}};},evaluate:async generate=>generate({taskId:'synthetic:judge',role:'review-grader',input:{},systemPrompt:'fixture',maxOutputTokens:1})});
 assert.equal(result.error.kind,'EvaluationBudgetExceeded');assert.equal(calls.length,46);assert.equal(new Set(calls).size,46);
});

for(const stage of ['extract','quiz','current'])test('reviewed hidden '+stage+' pipeline failure is terminal without benchmark retries',async()=>{
 const calls=[];
 const application={directory:'synthetic',extract:async()=>{calls.push('extract');return stage==='extract'?{ok:false,error:{kind:'KnowledgeModelCommandInvalid'}}:ok({facts:{status:'complete'}});},quiz:async()=>{calls.push('quiz');return stage==='quiz'?{ok:false,error:{kind:'QuizEvaluatorFailed',causeKind:'KnowledgeModelResponseInvalid'}}:ok({passes:true});},current:async()=>{calls.push('current');return {ok:false,error:{kind:'ReviewedKnowledgeIdentityConflict'}};}};
 const result=await runReviewedHiddenCase({application,input:{id:'synthetic'},config:{runPolicy:{maximumPages:1}},generate:async()=>assert.fail('no evaluator on a pipeline failure'),deadline:100,getUsage:()=>ok(idle)});
 assert.equal(result.status,'failed');assert.equal(result.passes,false);assert.equal(calls.length,['extract','quiz','current'].indexOf(stage)+1);
});

test('reviewed hidden provider failure and ledger halt remain resumable stops, never pipeline scores',async()=>{
 for(const [failure,usage] of [[{kind:'EvaluationProviderError'},idle],[{kind:'KnowledgeModelCommandInvalid'},{...idle,admissionHalted:'EvaluationUsageInvalid'}]]){
  const application={directory:'synthetic',extract:async()=>({ok:false,error:failure})};
  await assert.rejects(runReviewedHiddenCase({application,input:{id:'synthetic'},config:{runPolicy:{maximumPages:1}},getUsage:()=>ok(usage)}),error=>error.failure.kind===failure.kind);
 }
});

test('legacy benchmark command failure stops without quality attempts and persists a nonpassing disposition',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'quiz-failure-policy-')),file=join(directory,'quiz.json'),calls=[];
 try{
  const point={id:'synthetic:knowledge',sourceId:'synthetic',sourceRevision:1,summary:'A synthetic concept.',normalizedHash:'synthetic',coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{url:'https://synthetic.invalid',selector:'p'}]};
  const result=await runBenchmarkQuizzes({caseId:'synthetic',points:[point],file,maximumEvaluatorOutputTokens:1024,generate:async command=>{calls.push(command);assert.equal(command.failureOrigin,'pipeline');return {ok:false,error:{kind:'KnowledgeModelCommandInvalid'}};}});
  assert.equal(result.passes,false);assert.equal(result.dispositions[0].status,'abandoned');assert.equal(result.dispositions[0].attempts,0);assert.equal(calls.length,1);
  const saved=JSON.parse(await readFile(file));assert.equal(saved.dispositions.length,1);assert.equal(saved.attempts.length,0);
  await runBenchmarkQuizzes({caseId:'synthetic',points:[point],file,maximumEvaluatorOutputTokens:1024,generate:async()=>assert.fail('terminal case is not retried')});
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('actual selected execution scores zero-request application faults and continues every later case',async()=>{
 const {config,corpus,negativeTargets,selectedRun}=createSyntheticSelectedEvaluationFixture(),catalog=await readFrozenEvaluationCatalog(),db=new DatabaseSync(':memory:'),calls=[];
 const ownerDecision={authority:'synthetic fixture; no actual spend',source:'benchmark-failure-policy.test.mjs',decision:'TreatUSD1asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'};
 const ledger=createEvaluationLedger({database:db,budgetId:'owner-approved-image-benchmark',policy:config.budget,now:()=>1000,logger:()=>{},accountingMode:'estimated',ownerDecision});
 try{
  const result=await runEvaluation({config,corpus,negativeTargets,selectedRun,catalog,ledger,mode:'estimated',ownerDecision,iterationId:'synthetic',now:()=>1000,logger:()=>{},signal:new AbortController().signal,requestPlanner:async()=>assert.fail('no paid planning'),database:{prepare:()=>assert.fail('no application database')},scope:{ownerId:'synthetic',runId:'synthetic'},allowNetwork:true,budgetAuthorized:true,apiKey:'synthetic-not-a-credential',fetch:async()=>assert.fail('no provider call'),reviewedApplication:{extract:async({item})=>{calls.push(item.id);if(calls.length===2)throw new TypeError('synthetic application bug');return {ok:false,error:{kind:'KnowledgeModelCommandInvalid'}};}}});
  assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.value.status,'completed');assert.equal(result.value.wholeCaseReport.denominator,45);assert.equal(result.value.wholeCaseReport.rows.filter(r=>r.status==='failed').length,45);assert.equal(calls.length,45);assert.equal(new Set(calls).size,45);assert.equal(ledger.snapshot().value.requests,0);
 }finally{db.close();}
});

test('terminal pipeline failures remain denominator nonpasses while permitting measured threshold completion',()=>{
 const cases=Array.from({length:30},(_,i)=>({id:'synthetic-'+i,split:'holdout'}));
 const rows=cases.map((c,i)=>({...c,caseId:c.id,status:i<26?'completed':'failed',passes:i<26,judgeResultRefs:i<26?['synthetic-validated-judgment']:[],...(i<26?{}:{terminalReason:'KnowledgeModelCommandInvalid'})}));rows.forEach(r=>delete r.id);
 let report=reportWholeCases(cases,rows);assert(report.ok);assert.equal(report.value.status,'completed');assert.equal(report.value.passed,26);assert.equal(report.value.denominator,30);assert.equal(report.value.passes,true);
 rows[29].terminalReason='EvaluationTransportUncertain';report=reportWholeCases(cases,rows);assert(report.ok);assert.equal(report.value.status,'incomplete');assert.equal(report.value.passes,false);
});

test('actual reviewed execution quizzes before grading and discards points purged by the quiz actor',async()=>{
 const {config,corpus,negativeTargets,selectedRun}=createSyntheticSelectedEvaluationFixture(),catalog=await readFrozenEvaluationCatalog(),db=new DatabaseSync(':memory:'),calls=[];
 const ownerDecision={authority:'synthetic fixture; no actual spend',source:'benchmark-failure-policy.test.mjs',decision:'TreatUSD1asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'};
 const ledger=createEvaluationLedger({database:db,budgetId:'owner-approved-image-benchmark',policy:config.budget,now:()=>1000,logger:()=>{},accountingMode:'estimated',ownerDecision});
 try{
  const application={extract:async({item})=>{calls.push(item.id+':extract');return ok({predictions:item.labels.map(label=>({caseId:item.id,summary:label.summary,imageId:label.matchable?label.acceptableImageIds[0]:null,status:label.matchable?'match':'no-support'}))});},quiz:async item=>{calls.push(item.id+':quiz');return calls.length===5?{ok:false,error:{kind:'QuizEvaluatorOutputInvalid'}}:ok({passes:false});},current:async item=>{calls.push(item.id+':current');return ok({predictions:[]});}};
  const result=await runEvaluation({config,corpus,negativeTargets,selectedRun,catalog,ledger,mode:'estimated',ownerDecision,iterationId:'synthetic',now:()=>1000,logger:()=>{},signal:new AbortController().signal,requestPlanner:async()=>assert.fail('no stale point is graded'),database:{prepare:()=>assert.fail('no application database')},scope:{ownerId:'synthetic',runId:'synthetic'},allowNetwork:true,budgetAuthorized:true,apiKey:'synthetic-not-a-credential',fetch:async()=>assert.fail('no stale extracted prediction may reach evaluator'),reviewedApplication:application});
  assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.value.wholeCaseReport.rows.length,45);assert.equal(result.value.wholeCaseReport.passed,0);assert.equal(result.value.wholeCaseReport.rows[1].terminalReason,'QuizEvaluatorOutputInvalid');assert.equal(result.value.wholeCaseReport.rows[1].status,'failed');assert.equal(calls.length,134);
  assert.deepEqual(calls.slice(0,6),['synthetic-0:extract','synthetic-0:quiz','synthetic-0:current','synthetic-1:extract','synthetic-1:quiz','synthetic-2:extract']);
  assert.equal(ledger.snapshot().value.requests,0);
 }finally{db.close();}
});

// Actual settled public source-support replies are regression inputs, not accuracy evidence.
// Neutral semantic scaffolding reaches the source validator without reading gold claims.
test('all eight actual public v14 source-support judgments remain invalid with exact prediction/clause diagnostics',async()=>{
 const saved=JSON.parse(await readFile(new URL('./fixtures/evaluation/saved-public-source-support-invalid.json',import.meta.url),'utf8')),item=structuredClone(saved.item),predictions=saved.predictions;
 item.labels=[{id:'offline-neutral',summary:'Unused neutral offline reference placeholder.',useful:false,matchable:false,acceptableImageIds:[]}];
 const semantic={verdicts:predictions.map((p,predictionIndex)=>({predictionIndex,labelIds:[],fullySupported:false,clauses:[p.summary]})),coverage:[{labelId:'offline-neutral',predictionIndices:[],fullyCovered:false}]},error={kind:'EvaluationSemanticEvidenceInvalid',field:'unsupported clause: predictionIndex=1, clauseIndex=1, reason=missing captured text for webpage-text'},thresholds={precision:1,matchableFactRecall:1,abstention:1,usefulTextCoverage:1};
 assert.equal(saved.receipts.length,8);
 for(const receipt of saved.receipts){
  assert.equal(receipt.httpStatus,200);assert.equal(receipt.finishReason,'stop');
  const result=await scoreSemanticEvaluation({cases:[item],predictions,thresholds,generate:async command=>{
   if(command.input.operation==='judge-source-summary-equivalence')return ok(semantic);
   assert.equal(command.input.operation,'judge-source-support');return ok(receipt.value);
  }});
  assert.deepEqual(result,{ok:false,error});assert.equal(classifyEvaluationFailure(result.error,'evaluator'),'evaluator');
 }
 let supportIndex=0,semanticCalls=0,auditCalls=0;const taskIds=[];
 const result=await runIndependentEvaluation({evaluate:generate=>scoreSemanticEvaluation({cases:[item],predictions,thresholds,generate}),generate:async command=>{
  if(command.input.operation==='judge-source-summary-equivalence'){semanticCalls++;return ok(semantic);}
  if(command.input.operation==='judge-complete-claim-clauses'){auditCalls++;return ok({verdicts:predictions.map((_,predictionIndex)=>({predictionIndex,supportClausesEquivalent:true,semanticClausesEquivalent:true}))});}
  assert.equal(command.input.operation,'judge-source-support');taskIds.push(command.taskId);
  if(supportIndex){assert.deepEqual(command.input.evaluatorCorrection,{validationError:error,previousJudgment:saved.receipts[supportIndex-1].value});assert.match(command.systemPrompt,/otherwise set fullySupported=false/);assert.match(command.systemPrompt,/Never invent or select an arbitrary reference/);}
  assert.deepEqual(command.input.predictions,predictions.map((p,predictionIndex)=>({predictionIndex,summary:p.summary})));
  if(supportIndex<saved.receipts.length)return ok(saved.receipts[supportIndex++].value);
  return ok({verdicts:predictions.map((p,predictionIndex)=>({predictionIndex,fullySupported:false,clauses:[{text:p.summary,evidence:[]}]}))});
 }});
 assert.equal(result.ok,true);assert.equal(result.value.wholeCases[0].passes,false);assert.equal(semanticCalls,1);assert.equal(auditCalls,1);assert.equal(taskIds.length,9);assert.equal(new Set(taskIds).size,9);
});
for(const mode of ['webpage-text','pdf-text','uploaded-raster'])test(`source-support diagnostic preserves empty-evidence and pixel-only rules for ${mode}`,async()=>{
 const {config,corpus}=createSyntheticEvaluationFixture(),item=structuredClone(corpus.cases[0]),predictions=[{caseId:item.id,summary:'Synthetic relation.',imageId:null,status:'no-support'}];
 if(mode==='pdf-text'){item.input.material={kind:mode,sections:[{id:'s',locator:'page:1',text:'Synthetic relation.'}]};item.images=[];}
 if(mode==='uploaded-raster')item.input.material={kind:mode,sections:[{id:'s',locator:'pixels',text:''}]};
 const semantic={verdicts:[{predictionIndex:0,labelIds:[],fullySupported:false,clauses:['Synthetic relation.']}],coverage:item.labels.map(l=>({labelId:l.id,predictionIndices:[],fullyCovered:false}))};
 const execute=(evidence,fullySupported)=>scoreSemanticEvaluation({cases:[item],predictions,thresholds:config.thresholds,generate:async command=>{
  if(command.input.operation==='judge-source-summary-equivalence')return ok(semantic);
  if(command.input.operation==='judge-source-support')return ok({verdicts:[{predictionIndex:0,fullySupported,clauses:[{text:'Synthetic relation.',evidence:evidence==='captured-text'?[command.input.citationSources[0].reference]:evidence}]}]});
  assert.equal(command.input.operation,'judge-complete-claim-clauses');return ok({verdicts:[{predictionIndex:0,supportClausesEquivalent:true,semanticClausesEquivalent:true}]});
 }});
 assert.deepEqual(await execute([],true),{ok:false,error:{kind:'EvaluationSemanticEvidenceInvalid',field:'unsupported clause: predictionIndex=0, clauseIndex=0, reason=empty evidence'}});
 const negative=await execute([],false);assert.equal(negative.ok,true);assert.equal(negative.value.wholeCases[0].passes,false);
 if(mode!=='pdf-text'){
  const pixel=await execute([{kind:'pixels',id:'i',cue:'Synthetic visible relation.'}],true);
  if(mode==='uploaded-raster')assert.equal(pixel.ok,true,'raster pixels remain sufficient for the source support contract');
  else assert.deepEqual(pixel,{ok:false,error:{kind:'EvaluationSemanticEvidenceInvalid',field:'unsupported clause: predictionIndex=0, clauseIndex=0, reason=missing captured text for webpage-text'}});
 }
 if(mode!=='uploaded-raster')assert.equal((await execute('captured-text',true)).ok,true,'actual captured text references remain accepted');
});


for(const [name,malformed] of [
 ['string flag',{verdicts:[{predictionIndex:0,supportClausesEquivalent:true,semanticClausesEquivalent:'false'}]}],
 ['foreign index',{verdicts:[{predictionIndex:1,supportClausesEquivalent:true,semanticClausesEquivalent:false}]}],
 ['extra property',{verdicts:[{predictionIndex:0,supportClausesEquivalent:true,semanticClausesEquivalent:false,reason:'Not in the contract.'}]}],
 ['missing verdict',{verdicts:[]}],
 ['extra verdict',{verdicts:[0,1].map(predictionIndex=>({predictionIndex,supportClausesEquivalent:true,semanticClausesEquivalent:false}))}],
])test(`routed coverage correction does not forward malformed complete audit: ${name}`,async()=>{
 const original={verdicts:[{predictionIndex:0,fullySupported:false}]},failure={kind:'EvaluationSemanticJudgmentInvalid',field:'complete semantic claim coverage'},task='synthetic:semantic-v1',audit='synthetic:complete-claim-clauses-v1';let runs=0;
 const result=await runIndependentEvaluation({generate:async command=>{
  if(command.taskId===task)return ok(original);
  if(command.taskId===audit)return ok(malformed);
  if(command.taskId===task+':evaluator-retry-1'){assert.deepEqual(command.input.evaluatorCorrection,{validationError:failure,previousJudgment:original});assert.doesNotMatch(command.systemPrompt,/supplied completeClaimAudit/);return ok(original);}
  assert.equal(command.taskId,audit+':evaluator-retry-1');assert.deepEqual(command.input.evaluatorCorrection,{validationError:failure,previousJudgment:malformed});return ok({verdicts:[{predictionIndex:0,supportClausesEquivalent:true,semanticClausesEquivalent:true}]});
 },evaluate:async dispatch=>{
  await dispatch({taskId:task,input:{predictions:['Immutable prediction.']},systemPrompt:'fixture',maxOutputTokens:1});
  await dispatch({taskId:audit,input:{predictions:['Immutable prediction.']},systemPrompt:'fixture',maxOutputTokens:1});
  return runs++?ok({passes:false}):{ok:false,error:failure};
 }});assert.deepEqual(result,ok({passes:false}));
 const {config,corpus}=createSyntheticEvaluationFixture(),item=corpus.cases[0],predictions=[{caseId:item.id,summary:'Immutable prediction.',imageId:null,status:'no-support'}];
 const shapeResult=await scoreSemanticEvaluation({cases:[item],predictions,thresholds:config.thresholds,generate:async command=>{
  if(command.input.operation==='judge-source-summary-equivalence')return ok({verdicts:[{predictionIndex:0,labelIds:[],fullySupported:false,clauses:['Immutable prediction.']}],coverage:item.labels.map(label=>({labelId:label.id,predictionIndices:[],fullyCovered:false}))});
  if(command.input.operation==='judge-source-support')return ok({verdicts:[{predictionIndex:0,fullySupported:false,clauses:[{text:'Immutable prediction.',evidence:[]}]}]});
  return ok(malformed);
 }});assert.deepEqual(shapeResult,{ok:false,error:{kind:'EvaluationSemanticEvidenceInvalid',field:'complete immutable claim coverage'}});
});

test('a noncoverage audit failure keeps only its own correction even with valid audit shape',async()=>{
 const audit='synthetic:complete-claim-clauses-v1',raw={verdicts:[{predictionIndex:0,supportClausesEquivalent:true,semanticClausesEquivalent:false}]},failure={kind:'EvaluationSemanticJudgmentInvalid',field:'other adjudication protocol failure'};let run=0;const calls=[];
 const result=await runIndependentEvaluation({generate:async command=>{
  calls.push(command.taskId);if(command.taskId.endsWith(':evaluator-retry-1'))assert.deepEqual(command.input.evaluatorCorrection,{validationError:failure,previousJudgment:raw});return ok(raw);
 },evaluate:async dispatch=>{await dispatch({taskId:audit,input:{predictions:['Immutable prediction.']},systemPrompt:'fixture',maxOutputTokens:1});return run++?ok({passes:false}):{ok:false,error:failure};}});
 assert.deepEqual(result,ok({passes:false}));assert.deepEqual(calls,[audit,audit+':evaluator-retry-1']);assert.deepEqual(raw,{verdicts:[{predictionIndex:0,supportClausesEquivalent:true,semanticClausesEquivalent:false}]});
});

for(const mode of ['supported','unsafe','legacy-cache','legacy-negative-cache','draft-only','draft-only-unsafe'])test(`fresh quiz batch ${mode} boundary preserves raw outputs and bounded actor behavior`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'quiz-claim-boundary-')),file=join(directory,'quiz.json'),calls=[];
 try{
  const point={id:'synthetic:knowledge',sourceId:'synthetic',sourceRevision:1,summary:'A synthetic concept.',normalizedHash:'synthetic',coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{url:'https://synthetic.invalid',selector:'p'}]};
  const quiz={knowledgeId:point.id,knowledgeRevision:1,canonicalAnswers:['concept'],citedEvidenceUrls:['https://synthetic.invalid'],multipleChoice:{prompt:'Which concept?',options:[{key:'A',text:'concept'},{key:'B',text:'alternative'}],correctOptionKeys:['A'],correctOptionAnswers:[{key:'A',canonicalAnswer:'concept'}],explanation:'Synthetic evidence.'},fillBlank:{prompt:'The relation is ____.',blanks:[{id:'blank-1',canonicalAnswer:'concept',acceptedAnswers:['concept']}],explanation:'Synthetic evidence.'}};
  const evaluation={score:9,reasons:['Synthetic support.'],feedback:'Keep.',groundingProblems:[],knowledgeGroundingProblems:mode==='unsafe'?[{claim:point.summary,kind:'unsupported',reason:'The supplied source does not establish this claim.'}]:[]};
  const generate=async command=>{calls.push(command);const schema=command.responseSchema.name;if(schema==='benchmark_quiz_batch_v1')return ok({quizzes:[quiz]});if(schema==='paired_quiz_v3')return ok(quiz);if(schema==='quiz_evaluation_v3')return ok({...evaluation,knowledgeGroundingProblems:mode==='draft-only-unsafe'?[{claim:point.summary,kind:'unsupported',reason:'The supplied source does not establish the retained relation.'}]:[]});return ok({evaluations:[{knowledgeId:point.id,evaluation:mode.startsWith('draft-only')?{...evaluation,groundingProblems:['The first draft adds an unsupported qualifier.']}:evaluation}]});};
  if(mode.startsWith('legacy-')){
   const {createHash}=await import('node:crypto'),batchId=createHash('sha256').update(JSON.stringify([point.id])).digest('hex').slice(0,16);
   const {writeFile}=await import('node:fs/promises');await writeFile(file,JSON.stringify({caseId:'synthetic',knowledgeIds:[point.id],attempts:[],outputs:[],accepted:[],dispositions:[],learnerPublication:false,batchOutputs:[{phase:'generation',batchId,result:ok({quizzes:[quiz]})},{phase:'evaluation',batchId,result:ok({evaluations:[{knowledgeId:point.id,evaluation:{score:9,reasons:['Cached legacy support.'],feedback:'Keep.',groundingProblems:[],...(mode==='legacy-negative-cache'?{knowledgeGroundingProblems:['Saved old point-level negative remains binding.']}: {})}}]})}]}));
  }
  const result=await runBenchmarkQuizzes({caseId:'synthetic',points:[point],file,maximumEvaluatorOutputTokens:1024,generate});
  assert.equal(result.passes,mode!=='unsafe'&&mode!=='draft-only-unsafe'&&mode!=='legacy-negative-cache');assert.equal(result.dispositions[0].attempts,mode.startsWith('draft-only')?2:1);
  if(mode==='unsafe'||mode==='draft-only-unsafe'||mode==='legacy-negative-cache')assert.equal(result.dispositions[0].failureKind,'QuizKnowledgeUngrounded');
  assert.equal(calls.length,mode.startsWith('legacy-')?0:mode.startsWith('draft-only')?4:2);
  const saved=JSON.parse(await readFile(file));
  if(!mode.startsWith('legacy-')){assert.equal(calls[1].responseSchema.name,'benchmark_quiz_evaluation_batch_v2');assert.deepEqual(saved.batchOutputs[1].result.value.evaluations[0].evaluation,mode.startsWith('draft-only')?{...evaluation,groundingProblems:['The first draft adds an unsupported qualifier.']}:evaluation);if(mode.startsWith('draft-only')){assert.equal(calls[3].responseSchema.name,'quiz_evaluation_v3');const raw=saved.outputs.findLast(x=>x.phase==='evaluation').result.value;assert.deepEqual(raw.knowledgeGroundingProblems,mode==='draft-only-unsafe'?[{claim:point.summary,kind:'unsupported',reason:'The supplied source does not establish the retained relation.'}]:[]);}}
  await runBenchmarkQuizzes({caseId:'synthetic',points:[point],file,maximumEvaluatorOutputTokens:1024,generate:async()=>assert.fail('Closed disposition must not dispatch again.')});
 }finally{await rm(directory,{recursive:true,force:true});}
});

for(const mode of ['supported','unsafe','draft-only'])test(`fresh quiz batch interrupted ${mode} evaluation resumes its exact typed protocol without losing negatives`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'quiz-typed-resume-')),file=join(directory,'quiz.json'),calls=[];
 try{
  const point={id:'synthetic:knowledge',sourceId:'synthetic',sourceRevision:1,summary:'A synthetic concept.',normalizedHash:'synthetic',coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{url:'https://synthetic.invalid',selector:'p'}]};
  const quiz={knowledgeId:point.id,knowledgeRevision:1,canonicalAnswers:['concept'],citedEvidenceUrls:['https://synthetic.invalid'],multipleChoice:{prompt:'Which concept?',options:[{key:'A',text:'concept'},{key:'B',text:'alternative'}],correctOptionKeys:['A'],correctOptionAnswers:[{key:'A',canonicalAnswer:'concept'}],explanation:'Synthetic evidence.'},fillBlank:{prompt:'The relation is ____.',blanks:[{id:'blank-1',canonicalAnswer:'concept',acceptedAnswers:['concept']}],explanation:'Synthetic evidence.'}};
  const evaluation={score:9,reasons:['Synthetic source assessment.'],feedback:'Review.',groundingProblems:mode==='draft-only'?['The draft adds an unsupported qualifier.']:[],knowledgeGroundingProblems:mode==='unsafe'?[{claim:point.summary,kind:'unsupported',reason:'The supplied source does not establish this claim.'}]:[]};
  const generate=async command=>{calls.push(command);return command.role==='knowledge-scraper'?ok({quizzes:[quiz]}):ok({evaluations:[{knowledgeId:point.id,evaluation}]});};
  await assert.rejects(runBenchmarkQuizzes({caseId:'synthetic',points:[point],file,maximumEvaluatorOutputTokens:1024,generate,logger:entry=>{if(entry.event==='quiz-actor-critic-entry')throw Error('Synthetic interruption after raw batch persistence');}}),/Synthetic interruption/);
  const interrupted=JSON.parse(await readFile(file));assert.equal(calls.length,2);assert.deepEqual(interrupted.attempts,[]);assert.deepEqual(interrupted.dispositions,[]);
  assert.equal(interrupted.batchOutputs[1].evaluationProtocol,'quiz_evaluation_v3');assert.deepEqual(interrupted.batchOutputs[1].result.value.evaluations[0].evaluation,evaluation);
  const rawBytes=JSON.stringify(interrupted.batchOutputs);const resumedCalls=[];
  const result=await runBenchmarkQuizzes({caseId:'synthetic',points:[point],file,maximumEvaluatorOutputTokens:1024,generate:async command=>{resumedCalls.push(command);assert.equal(mode,'draft-only','Binding point negative and valid cached review must not dispatch again.');return command.role==='knowledge-scraper'?ok(quiz):ok({...evaluation,groundingProblems:[]});}});
  const saved=JSON.parse(await readFile(file));assert.equal(JSON.stringify(saved.batchOutputs),rawBytes,'Original raw evidence and protocol identity are immutable on reopen.');
  assert.equal(result.passes,mode!=='unsafe');assert.equal(result.dispositions[0].attempts,mode==='draft-only'?2:1);assert.equal(resumedCalls.length,mode==='draft-only'?2:0);
  if(mode==='unsafe'){assert.equal(result.dispositions[0].failureKind,'QuizKnowledgeUngrounded');assert.equal(saved.accepted.length,0);assert.equal(saved.attempts[0].score,9);}
  await runBenchmarkQuizzes({caseId:'synthetic',points:[point],file,maximumEvaluatorOutputTokens:1024,generate:async()=>assert.fail('Closed same-owner disposition must not dispatch.')});
  if(mode==='unsafe'){const {writeFile}=await import('node:fs/promises');const unmarked=structuredClone(interrupted);delete unmarked.batchOutputs[1].evaluationProtocol;await writeFile(file,JSON.stringify(unmarked));await assert.rejects(runBenchmarkQuizzes({caseId:'synthetic',points:[point],file,maximumEvaluatorOutputTokens:1024,generate:async()=>assert.fail('Unmarked typed negative must not retry.')}),/QuizBatchEvaluationProtocolMissing/);assert.deepEqual(JSON.parse(await readFile(file)).batchOutputs,unmarked.batchOutputs);}
  const before=await readFile(file,'utf8');saved.dispositions=[];saved.accepted=[];saved.attempts=[];saved.outputs=[];saved.batchOutputs[1].evaluationProtocol='unknown-future-protocol';
  const {writeFile}=await import('node:fs/promises');await writeFile(file,JSON.stringify(saved));
  await assert.rejects(runBenchmarkQuizzes({caseId:'synthetic',points:[point],file,maximumEvaluatorOutputTokens:1024,generate:async()=>assert.fail('Unknown protocol must fail before dispatch.')}),/QuizBatchEvaluationProtocolInvalid/);
  assert(before.length>0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
