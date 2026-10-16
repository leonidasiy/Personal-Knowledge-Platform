import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
const category=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const percentile=(values,fraction)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*fraction)-1]:null;

/** Summarize content-free structured workflow records, including failed calls and missing receipts. */
export function summarizeWorkflowMetrics(entries) {
  const runs=new Map();
  for(const entry of entries) {
    if(!entry||!category(entry.runId)||!category(entry.event))continue;
    let run=runs.get(entry.runId);
    if(!run){run={runId:entry.runId,modelCalls:0,pricedCalls:0,usageReceipts:0,knownCostNanodollars:0,modelFailures:0,retries:0,failures:{},stages:{},firstUsableQuizMs:null,completionMs:null,acceptedPairs:null,pendingPairs:null};runs.set(entry.runId,run);}
    if(entry.event==='knowledge-model-entry')run.modelCalls++;
    if(entry.event==='knowledge-model-usage') {
      run.usageReceipts++;
      if(nonnegative(entry.costNanodollars)){run.pricedCalls++;run.knownCostNanodollars+=entry.costNanodollars;}
    }
    if(entry.event==='knowledge-model-failure')run.modelFailures++;
    if(entry.event.endsWith('-retry'))run.retries++;
    if(category(entry.failureKind))run.failures[entry.failureKind]=(run.failures[entry.failureKind]??0)+1;
    if(['quiz-stage-duration','quiz-stage-wait'].includes(entry.event)&&category(entry.stage)&&nonnegative(entry.durationMs)) {
      const key=entry.stage+(entry.event==='quiz-stage-wait'?'-wait':'');
      (run.stages[key]??=[]).push(entry.durationMs);
    }
    if(entry.event==='workflow-first-usable-quiz'&&nonnegative(entry.durationMs))run.firstUsableQuizMs=run.firstUsableQuizMs===null?entry.durationMs:Math.min(run.firstUsableQuizMs,entry.durationMs);
    if(entry.event==='workflow-completion'&&nonnegative(entry.durationMs)) {
      run.completionMs=entry.durationMs;
      if(nonnegative(entry.count))run.acceptedPairs=entry.count;
      if(nonnegative(entry.itemCount))run.pendingPairs=entry.itemCount;
    }
  }
  return [...runs.values()].map(run=>({...run,unpricedOrUncertainCalls:Math.max(0,run.modelCalls-run.pricedCalls),coverage:'supplied-records-only',allObservedCallsPriced:run.modelCalls>0&&run.pricedCalls===run.modelCalls,knownCostPerAcceptedPairNanodollars:run.acceptedPairs>0?Math.round(run.knownCostNanodollars/run.acceptedPairs):null,stages:Object.fromEntries(Object.entries(run.stages).map(([stage,samples])=>[stage,{count:samples.length,totalMs:samples.reduce((a,b)=>a+b,0),p50Ms:percentile(samples,0.5),p95Ms:percentile(samples,0.95)}]))}));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  let input='';
  if(process.argv[2])input=await readFile(process.argv[2],'utf8');
  else {process.stdin.setEncoding('utf8');for await(const chunk of process.stdin)input+=chunk;}
  const entries=input.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
  console.log(JSON.stringify(summarizeWorkflowMetrics(entries),null,2));
}
