import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeQualityReviewer,knowledgeReviewerPrompt,knowledgeRepairPrompt} from '../src/features/knowledge-workflows/quality-review.js';
import {syntheticAssessment} from './fixtures/knowledge-review-audit.mjs';

// Constructed judgments exercise unchanged native consequences, not model/source accuracy.
const context={lessOften:[],previousKnowledge:[],previousQuizzes:[]};
const summary='Opening the gate releases water downstream.';
const point={id:'constructed',sourceId:'source',sourceRevision:1,summary,normalizedHash:'constructed',evidenceAnchors:[{url:'https://synthetic.invalid/',selector:'#gate',quote:summary,clause:summary}],mediaCandidates:[{visualId:'image'}],coverageGoalIds:[],attribution:{sourceUrl:'https://synthetic.invalid/'},extractionVersion:'constructed'};
const ok=value=>({ok:true,value});
function assessment(current,{decision='pass',cue='',permission=true}={}) {
 const value=syntheticAssessment({knowledge:current,sourceMode:'text'},{decision,reasons:['Constructed contextual example, not whole-claim visual support.'],feedback:'Keep the supported relationship; use contextual illustration only.',matchedLessOftenIds:[],supportingImageEvidence:cue,allowTextOnly:permission});
 value.audit.finalClause.supportsWholeClaim=false;
 value.audit.finalClause.pixelEvidence=cue?[{imageId:'image',cue}]:[];
 return value;
}

test('prompts require retained support for introductory conditions and consistent supplied image role',()=>{
 assert.match(knowledgeReviewerPrompt,/Do not cite only the supported consequence while justifying its condition from a neighboring captured block/);
 assert.match(knowledgeReviewerPrompt,/Keep the supplied imagePurpose fixed/);
 assert.match(knowledgeReviewerPrompt,/supportsWholeClaim=false or pixelEvidence=\[\] requires qualityDecision=revise/);
 assert.match(knowledgeReviewerPrompt,/at least one audit clause and nonempty supportingImageEvidence/);
 assert.match(knowledgeReviewerPrompt,/Describe only inspected cues, never invent audit support/);
 assert.match(knowledgeRepairPrompt,/A condition mentioned only in neighboring captured context must be narrowed or omitted/);
 assert.match(knowledgeRepairPrompt,/Preserve the supplied imagePurpose/);
});

test('raw pass with contextual prose and empty pixels still receives bounded evidence-role repair',async()=>{
 let critics=0,repairs=0;
 const result=await createKnowledgeQualityReviewer({context,sourceMode:'text',imagePurpose:'evidence',sourceEvidence:{},digest:async()=> 'constructed',evaluate:async current=>{critics++;return ok(assessment(current));},regenerate:async(current,verdict)=>{
  repairs++;assert.equal(verdict.decision,'revise');assert.equal(verdict.audit.revisionReason,'image');assert.equal(verdict.allowTextOnly,false);
  return ok({summary,coverageGoalIds:[],useSupportingImage:true,evidenceClauses:[summary]});
 }}).review(point);
 assert.deepEqual(result,ok(null));assert.equal(critics,2);assert.equal(repairs,1);
});

test('explicit illustration retains full supported text with actual contextual cue and false whole-claim coverage',async()=>{
 const cue='Constructed gate shape beside stored water; no downstream flow is depicted.';
 const result=await createKnowledgeQualityReviewer({context,sourceMode:'text',imagePurpose:'illustration',sourceEvidence:{},digest:async()=>assert.fail('No repair'),evaluate:async current=>ok(assessment(current,{cue})),regenerate:async()=>assert.fail('No repair')}).review(point);
 assert(result.ok&&result.value);assert.equal(result.value.point.summary,summary);assert.deepEqual(result.value.point.mediaCandidates,point.mediaCandidates);assert.equal(result.value.verdict.imagePurpose,'illustration');assert.equal(result.value.verdict.supportingImageEvidence,cue);
});

test('negative evidence-role judgment permits one explicit optional-image removal without losing text',async()=>{
 let critics=0,repairs=0;
 const result=await createKnowledgeQualityReviewer({context,sourceMode:'text',imagePurpose:'evidence',sourceEvidence:{},digest:async()=> 'constructed',evaluate:async(current,attempt)=>{critics++;return ok(assessment(current,{decision:attempt===1?'revise':'pass'}));},regenerate:async(current,verdict)=>{
  repairs++;assert.equal(verdict.allowTextOnly,true);return ok({summary,coverageGoalIds:[],useSupportingImage:false,evidenceClauses:[summary]});
 }}).review(point);
 assert(result.ok&&result.value);assert.equal(result.value.point.summary,summary);assert.deepEqual(result.value.point.mediaCandidates,[]);assert.equal(critics,2);assert.equal(repairs,1);
});

// The real reviewer rejected a visible repeated label for lacking a circular path.
test('ordered printed sequences are assessed from visible labels without inventing a full cycle',()=>{
 for(const prompt of [knowledgeReviewerPrompt,knowledgeRepairPrompt]){
  assert.match(prompt,/printed ordered sequence/);
  assert.match(prompt,/source-established reading order/);
  assert.match(prompt,/unpictured complete cycle or universal rule/);
 }
 assert.match(knowledgeReviewerPrompt,/Such a displayed sequence needs no circular path or motion arrows/);
 assert.match(knowledgeReviewerPrompt,/inspect each adjacent pair/);
});
