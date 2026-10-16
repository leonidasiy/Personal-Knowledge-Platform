import assert from 'node:assert/strict';
import {test} from 'node:test';
import {summarizeWorkflowMetrics} from '../scripts/knowledge-workflow-metrics.mjs';

test('throughput includes waits, failures, and known cost without treating missing charges as free',()=>{
  const event=(event,rest={})=>({runId:'run-a',event,...rest,sourceText:'private fixture'});
  const [r]=summarizeWorkflowMetrics([
    event('knowledge-model-entry'),event('knowledge-model-usage',{costNanodollars:1000}),event('knowledge-model-entry'),event('knowledge-model-failure',{failureKind:'KnowledgeModelTimeout'}),event('quiz-technical-retry'),
    ...[10,20,100].map(durationMs=>event('quiz-stage-duration',{stage:'generation',durationMs})),
    event('quiz-stage-wait',{stage:'review',durationMs:40}),event('workflow-first-usable-quiz',{durationMs:120}),event('workflow-completion',{durationMs:400,count:2,itemCount:1}),
  ]);
  assert.equal(r.firstUsableQuizMs,120);assert.equal(r.completionMs,400);assert.equal(r.acceptedPairs,2);assert.equal(r.pendingPairs,1);
  assert.deepEqual(r.stages.generation,{count:3,totalMs:130,p50Ms:20,p95Ms:100});assert.equal(r.stages['review-wait'].p95Ms,40);
  assert.equal(r.knownCostPerAcceptedPairNanodollars,500);assert.equal(r.allObservedCallsPriced,false);assert.equal(r.unpricedOrUncertainCalls,1);assert.equal(r.retries,1);assert.equal(r.modelFailures,1);
  assert(!JSON.stringify(r).includes('private'));
});
