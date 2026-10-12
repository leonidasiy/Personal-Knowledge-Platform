import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createSyntheticEvaluationFixture} from './synthetic.mjs';
import {evaluationHash} from '../../../scripts/webpage-image-evaluation.mjs';
// Entirely constructed cases, including simulated split names. Never reads benchmark gold.
export function createSyntheticSelectedEvaluationFixture({textOnly=false}={}){
 const fixture=createSyntheticEvaluationFixture();
 const cases=Array.from({length:180},(_,i)=>{
  const c=structuredClone(fixture.corpus.cases[0]);c.id='synthetic-'+i;c.split=i<60?'development':'holdout';c.sourceFamily='synthetic:'+c.split;
  c.origin={kind:'independent-labelled-source',reference:'SYNTHETIC origin-shape fixture; no real annotation or independence claimed',annotator:'scripted synthetic unit fixture'};c.input.evidence.url='https://synthetic.invalid/'+i;
  c.labels.forEach(l=>{if(textOnly&&i!==89){l.matchable=false;l.acceptableImageIds=[];}l.id=c.id+':'+l.id;l.summary=l.summary.replace('.',` ${i}.`);});c.input.evidence.blocks[0].text=c.labels.map(l=>l.summary).join(' ');return c;
 });
 const corpus={version:'synthetic-selected-v1',cases};corpus.hash=evaluationHash(corpus);
 const config={...JSON.parse(readFileSync('test-results/full-image-review/corpus/frozen-v3/config-v3.json','utf8')),corpusVersion:corpus.version,corpusHash:corpus.hash,minimumDevelopmentCases:60,minimumHoldoutCases:120,thresholds:{precision:.98,matchableFactRecall:.9,abstention:.98,usefulTextCoverage:.9},budget:{maximumRequests:1200,maximumInputTokens:3000000,maximumOutputTokens:3000000,maximumMilliseconds:10800000,maximumCostNanodollars:1000000000},sourceFamilySplits:{development:['synthetic:development'],holdout:['synthetic:holdout']}};
 const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
 const sha=text=>createHash('sha256').update(text).digest('hex');
 const digest=v=>sha(JSON.stringify(sorted(v)).replace(/[\u0080-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
 const chosen=[...cases.slice(0,15),...cases.slice(60,90)];
 const selectedRun={version:'owner-selected-run-v1',authority:'SYNTHETIC contract fixture; never owner selection or measured accuracy',source:'tests-node/fixtures/evaluation/synthetic-selected.mjs',parentHash:corpus.hash,developmentCases:15,holdoutCases:30,maximumCostNanodollars:1000000000,cases:chosen.map(c=>({caseId:c.id,split:c.split,sourceFamily:c.sourceFamily,kind:'web',evidenceIdentity:c.input.evidence.url,contentDigest:digest({blocks:c.input.evidence.blocks,headings:c.input.evidence.headings}),sourceCaseDigest:digest(c)}))};
 const sources=cases.map(c=>({reference:c.id,text:c.input.evidence.blocks[0].text,digest:'sha256:'+sha(c.input.evidence.blocks[0].text),sourceDigest:'sha256:'+sha(c.input.evidence.blocks[0].text)}));
 const negativeTargets={version:'rejection-targets-v1',corpusHash:corpus.hash,sources,targets:cases.map((c,i)=>({id:'negative-'+c.id,caseId:c.id,kind:'claim',text:'Synthetic unsupported addition '+i,reasonCode:'unsupported',disposition:'unsupported',imageIds:[],decisionPath:'synthetic-fixture',evidence:[{reference:c.id,sourceDigest:sources[i].sourceDigest,textDigest:sources[i].digest,codepointRange:[0,Array.from(sources[i].text).length],quote:sources[i].text}]}))};
 return {config,corpus,negativeTargets,selectedRun};
}
