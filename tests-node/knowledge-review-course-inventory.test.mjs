import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeQualityReviewer,knowledgeReviewerPrompt,knowledgeRepairPrompt} from '../src/features/knowledge-workflows/quality-review.js';
import {syntheticAssessment} from './fixtures/knowledge-review-audit.mjs';

const context={lessOften:[],previousKnowledge:[],previousQuizzes:[]};
const url='https://synthetic.invalid/lesson';
const point=(summary,quote=summary)=>({id:'synthetic-point',sourceId:'source',sourceRevision:1,summary,normalizedHash:'synthetic-point',evidenceAnchors:[{url,selector:'p',quote,clause:summary}],mediaCandidates:[],coverageGoalIds:[],attribution:{sourceUrl:url},extractionVersion:'synthetic'});
const assessment=(knowledge,decision)=>syntheticAssessment({knowledge,sourceMode:'text'},{decision,reasons:['Synthetic usefulness judgment; not a model accuracy claim.'],feedback:decision==='revise'?'Retain only a useful supported subject relationship; course inventory is unusable.':'Preserve the useful supported relationship.',matchedLessOftenIds:[],supportingImageEvidence:'',allowTextOnly:true});

test('reviewer and repair prompts reject course inventories as manufactured novelty without banning substantive introductions',()=>{
 assert.match(knowledgeReviewerPrompt,/Learning usefulness is independent of source fidelity and novelty/);
 assert.match(knowledgeReviewerPrompt,/Pure course\/chapter outlines, topic inventories, administrative inclusion statements and document section-location statements/);
 assert.match(knowledgeReviewerPrompt,/Return qualityDecision=revise for these even when accurately quoted, distinct from prior knowledge/);
 assert.match(knowledgeReviewerPrompt,/A question asking which topic the course includes does not establish learning usefulness/);
 assert.match(knowledgeReviewerPrompt,/Do not accept a course-content inventory as the replacement for a rejected duplicate/);
 assert.match(knowledgeReviewerPrompt,/Distinguish document navigation from a source-taught location or relationship within the subject itself/);
 assert.match(knowledgeRepairPrompt,/Do not manufacture novelty by replacing a duplicate with a pure course\/chapter outline/);
 assert.match(knowledgeRepairPrompt,/the existing final critic must reject the unusable point/);
 for(const prompt of [knowledgeReviewerPrompt,knowledgeRepairPrompt]){
  assert.match(prompt,/study\/practice strateg/);assert.match(prompt,/prerequisite/);assert.match(prompt,/scope condition/);assert.match(prompt,/concrete application/);
 }
 assert.match(knowledgeRepairPrompt,/Preserve the original independently answerable retrieval target/);
 assert.match(knowledgeRepairPrompt,/within the original retained evidence/);
});

test('synthetic duplicate repair to an accurately quoted course inventory remains rejected after the existing single repair',async()=>{
 const original=point('A chord relates several notes.','A chord relates several notes. The course includes a list of performance terms.'),inventory='The course includes a list of performance terms.';
 const before=structuredClone(original);let critics=0,repairs=0;
 const result=await createKnowledgeQualityReviewer({context,sourceMode:'text',sourceEvidence:{},digest:async()=> 'synthetic-new-hash',evaluate:async current=>{
  critics++;assert.equal(current.evidenceAnchors[0].quote,original.evidenceAnchors[0].quote);assert.equal(current.summary,critics===1?original.summary:inventory);
  return {ok:true,value:assessment(current,'revise')};
 },regenerate:async()=>{repairs++;return {ok:true,value:{summary:inventory,coverageGoalIds:[],useSupportingImage:false,evidenceClauses:[inventory]}};}}).review(original);
 assert.deepEqual(result,{ok:true,value:null});assert.equal(critics,2);assert.equal(repairs,1);assert.deepEqual(original,before);
});

for(const [name,summary] of [
 ['introductory definition','A ratio compares quantities by division.'],
 ['study strategy','Compare the two worked methods to identify when each applies.'],
 ['scope condition','Division by a quantity is defined when that quantity is nonzero.'],
 ['application','Dividing distance by elapsed time gives average speed for that interval.'],
])test(`synthetic useful ${name} retains the existing pass contract`,async()=>{
 const original=point(summary);let critics=0;
 const result=await createKnowledgeQualityReviewer({context,sourceMode:'text',sourceEvidence:{},digest:async()=> 'synthetic',evaluate:async current=>{critics++;return {ok:true,value:assessment(current,'pass')};},regenerate:async()=>assert.fail('A passed substantive relationship must not be repaired')}).review(original);
 assert(result.ok);assert(result.value);assert.equal(result.value.point.summary,summary);assert.equal(critics,1);
});
