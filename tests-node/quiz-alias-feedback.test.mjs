import assert from "node:assert/strict";
import {quizPairDraftValidationIssues, validateQuizPairDraft} from "../src/features/knowledge-workflows/quiz-pair.js";
const draft = aliases => ({knowledgeId:"synthetic",knowledgeRevision:1,canonicalAnswers:["NAD+"],citedEvidenceUrls:["https://example.test/source"],multipleChoice:{prompt:"Which synthetic carrier?",options:[{key:"a",text:"NAD+"},{key:"b",text:"Other carrier"}],correctOptionKeys:["a"],correctOptionAnswers:[{key:"a",canonicalAnswer:"NAD+"}],explanation:"Synthetic source supports this carrier."},fillBlank:{prompt:"The synthetic carrier is ____.",blanks:[{id:"blank-1",canonicalAnswer:"NAD+",acceptedAnswers:aliases}],explanation:"Synthetic source supports this carrier."}});
for (const aliases of [["NAD⁺","NAD+"],["NAD+"," nad+ "],["NAD+","NAD+","Other term"]]) {
 const value=draft(aliases),saved=structuredClone(value);
 assert.equal(validateQuizPairDraft(value),false);
 const issues=quizPairDraftValidationIssues(value);
 assert(issues.some(issue=>issue.includes('fillBlank.blanks[0].acceptedAnswers:')&&issue.includes('normalize to "nad+"')&&issue.includes('entire array')));
 assert.deepEqual(value,saved);
}
for (const aliases of [["NAD+"],["NAD+","oxidized carrier"]]) {
 const value=draft(aliases);assert.equal(validateQuizPairDraft(value),true);assert.deepEqual(quizPairDraftValidationIssues(value),[]);
}
console.log(JSON.stringify({syntheticAliasCasesPassed:5,strictValidationUnchanged:true,mutations:0,paidCalls:0}));
