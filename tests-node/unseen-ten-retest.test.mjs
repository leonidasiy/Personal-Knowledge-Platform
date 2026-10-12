import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyUnseenTenRetest,verifyUnseenTenRetestIteration} from '../scripts/evaluation-unseen-ten-scope.ts';
import {createSyntheticSelectedEvaluationFixture} from './fixtures/evaluation/synthetic-selected.mjs';
import {composeUnseenTenEvaluation,evaluationHash,selectedCaseBinding} from '../scripts/webpage-image-evaluation.mjs';
const h='a'.repeat(64),ref={source:'synthetic-proof.json',sha256:h};
function fixture(){
 const f=createSyntheticSelectedEvaluationFixture({textOnly:true}),cases=f.corpus.cases.slice(60,70);
 for(const [i,c] of cases.entries()){const b=Buffer.concat([Buffer.from(c.images[0].base64,"base64"),Buffer.from([i])]);c.images[0].base64=b.toString("base64");c.images[0].digest="sha256:"+createHash("sha256").update(b).digest("hex");c.labels[0].matchable=true;c.labels[0].acceptableImageIds=["i"];}
 const corpus={version:f.corpus.version,cases};corpus.hash=evaluationHash(corpus);
 const config={...f.config,corpusHash:corpus.hash,minimumDevelopmentCases:0,minimumHoldoutCases:10};
 const targets=f.negativeTargets.targets.filter(t=>cases.some(c=>c.id===t.caseId)),refs=new Set(targets.flatMap(t=>t.evidence.map(e=>e.reference)));
 return {config,corpus,negativeTargets:{...f.negativeTargets,corpusHash:corpus.hash,targets,sources:f.negativeTargets.sources.filter(s=>refs.has(s.reference))},selectedRun:{version:'owner-unseen-ten-run-v1',source:ref.source,sourceSha256:h,originalSelection:ref,exposure:ref,prerequisites:ref,corpusHash:corpus.hash,cases:cases.map(selectedCaseBinding)}};
}
test('exposed retest filters only after verifying all ten original commitments',()=>{
 const f=fixture(),caseIds=[f.corpus.cases[0].id,f.corpus.cases[3].id];
 const full=composeUnseenTenEvaluation(f);assert.equal(full.ok,true,JSON.stringify(full));
 const result=composeUnseenTenEvaluation({...f,caseIds});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.value.corpus.cases.map(c=>c.id),caseIds);assert.equal(result.value.config.minimumHoldoutCases,2);assert.equal(result.value.selectedRun.cases.length,10);assert.equal(result.value.negativeTargets.targets.length,2);
 const damaged=structuredClone(f);damaged.corpus.cases[9].labels[0].summary+=' unbound change';assert.equal(composeUnseenTenEvaluation({...damaged,caseIds}).ok,false);
});
test('exposed retest rejects duplicates, unknown IDs, and empty selection',()=>{const f=fixture();for(const caseIds of [[],['unknown'],[f.corpus.cases[0].id,f.corpus.cases[0].id]])assert.equal(composeUnseenTenEvaluation({...f,caseIds}).ok,false);});

function proofFixture(){
 const f=fixture(),directory=mkdtempSync(join(tmpdir(),'pkp-retest-proof-')),sha=b=>createHash('sha256').update(b).digest('hex');
 const save=(name,value)=>{const source=join(directory,name),bytes=JSON.stringify(value);writeFileSync(source,bytes);return {source,sha256:sha(bytes)};};
 const owner=save('owner.json',{synthetic:true}),oldSelection=save('original45.json',{synthetic:true}),prerequisites=save('prerequisites.json',{synthetic:true});
 const captures=f.corpus.cases.map(c=>{const document=save(c.id+'-document.json',c.input.evidence),sourceDigest='sha256:'+document.sha256;const image=join(directory,c.id+'.png'),b=Buffer.from(c.images[0].base64,'base64');writeFileSync(image,b);return {caseId:c.id,sourceFamily:c.sourceFamily,canonicalUrl:c.input.evidence.url,contentDigest:selectedCaseBinding(c).contentDigest,sourceDigest,imageDigests:c.images.map(i=>i.digest),sourceFiles:[document,{source:image,sha256:sha(b)}]};});
 const exposure=save('exposure.json',{captures,captureDirectory:directory});f.selectedRun={...f.selectedRun,source:owner.source,sourceSha256:owner.sha256,originalSelection:oldSelection,prerequisites,exposure};
 const paths={},sourceFiles={};for(const [key,value] of Object.entries(f)){const ref=save(key+'.json',value);paths[key]=ref.source;sourceFiles[ref.source]=ref.sha256;}for(const ref of [owner,oldSelection,prerequisites,exposure])sourceFiles[ref.source]=ref.sha256;
 const scope={kind:'unseen-ten',authorization:owner,originalSelection:oldSelection,exposure,prerequisites},selection=f.selectedRun.cases,reviewPath=join(directory,'review.json'),runtimePolicy={codeSha256:sha(JSON.stringify(sourceFiles)),modelsSha256:h,selectionSha256:sourceFiles[paths.selectedRun],unseenTenScopeExtension:{synthetic:true}};
 const previous={directory,iterationId:'original',paths,sourceFiles,roleProfiles:{},grant:{},runtimePolicy,scope,selection,reviewFile:reviewPath};
 const contract=save('original-contract.json',previous),review=save('review.json',{verdict:'PASS',BLOCKING:'NONE',nonApplicationAuthor:true,actualAuthor:'synthetic-independent-reviewer',contractSha256:contract.sha256,codeSha256:runtimePolicy.codeSha256,modelsSha256:h,sourceFiles});
 const result=save('result.json',{ok:true,value:{status:'completed',corpusHash:f.corpus.hash,wholeCaseReport:{status:'completed',denominator:10,rows:selection.map((c,i)=>({caseId:c.caseId,status:'completed',passes:i===9}))}}});
 const retestOrigin={contract,result,review},caseIds=[selection[0].caseId,selection[3].caseId],current={...structuredClone(previous),iterationId:'retest',caseIds,retestOrigin,quizRun:{knowledgeIterationId:'retest'}};for(const ref of Object.values(retestOrigin))current.sourceFiles[ref.source]=ref.sha256;
 const cases=f.corpus.cases.filter(c=>caseIds.includes(c.id));return {f,current,previous,cases,save,directory,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
test('retest verifies original completed reviewed run and every original capture without claiming fresh eligibility',()=>{const p=proofFixture();try{const value=verifyUnseenTenRetest(p.f.selectedRun,p.current,p.cases);assert.equal(value.freshHiddenCredit,false);assert.equal(value.originalDenominator,10);assert.deepEqual(value.retestCaseIds,p.current.caseIds);const selected=p.f.corpus.cases[9];assert.throws(()=>verifyUnseenTenRetest(p.f.selectedRun,{...p.current,caseIds:[selected.id]},[selected]),/only exposed failed cases/);const unselectedCapture=join(p.directory,p.f.corpus.cases[8].id+'.png');writeFileSync(unselectedCapture,'changed');assert.throws(()=>verifyUnseenTenRetest(p.f.selectedRun,p.current,p.cases),/original capture bytes/);}finally{p.cleanup();}});
test('unseen-ten iteration exception requires source-bound actual candidate and exact exposed origin',()=>{const p=proofFixture();try{const contractSource=join(p.directory,'candidate-contract.json'),approval=p.save('iteration.json',{contractSource,retestOrigin:p.current.retestOrigin,caseIds:p.current.caseIds}),next={...p.current.runtimePolicy,codeSha256:createHash('sha256').update(JSON.stringify(p.current.sourceFiles)).digest('hex'),benchmarkIteration:{iterationId:'retest',source:approval.source,sourceSha256:approval.sha256}};p.current.runtimePolicy=next;writeFileSync(contractSource,JSON.stringify(p.current));assert.doesNotThrow(()=>verifyUnseenTenRetestIteration(p.previous.runtimePolicy,next));assert.throws(()=>verifyUnseenTenRetestIteration(p.previous.runtimePolicy,{...next,selectionSha256:'b'.repeat(64)}),/retained scope transition/);assert.throws(()=>verifyUnseenTenRetestIteration(p.previous.runtimePolicy,{...next,benchmarkIteration:{...next.benchmarkIteration,sourceSha256:'b'.repeat(64)}}),/source changed/);writeFileSync(contractSource,JSON.stringify({...p.current,caseIds:[p.current.caseIds[0]]}));assert.throws(()=>verifyUnseenTenRetestIteration(p.previous.runtimePolicy,next),/actual retest candidate identity/);}finally{p.cleanup();}});
