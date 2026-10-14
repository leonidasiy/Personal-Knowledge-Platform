// @ts-check
import {createHash} from 'node:crypto';
import {readFileSync,statSync,realpathSync,existsSync} from 'node:fs';
import process from 'node:process';
import {isWebpageEvidence} from '../worker/webpage-facts.js';

/** @typedef {{source:string,sourceSha256:string,iterationId:string,startingReservations:number,maximumRequests:20}} NavigationDiagnostic */
/** @param {import('node:crypto').BinaryLike} bytes */
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
/** @param {unknown} value */
const hash=value=>sha(JSON.stringify(value));
/** @param {unknown} value @returns {value is Record<string,any>} */
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** @param {unknown} value @returns {value is string} */
const text=value=>typeof value==='string'&&value.trim()!=='';
/** @param {unknown} valid @param {string} field @returns {asserts valid} */
function requireProof(valid,field){if(!valid)throw new TypeError('EvaluationNavigationDiagnosticInvalid:'+field);}
/** @param {unknown} a @param {unknown} b */
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** @param {unknown} value @returns {value is NavigationDiagnostic} */
export function isNavigationDiagnostic(value){
 return record(value)&&Object.keys(value).sort().join(',')==='iterationId,maximumRequests,source,sourceSha256,startingReservations'&&text(value.source)&&digest(value.sourceSha256)&&text(value.iterationId)&&Number.isSafeInteger(value.startingReservations)&&value.startingReservations>=0&&value.maximumRequests===20;
}

/** @param {unknown} ref */
function read(ref){requireProof(record(ref)&&text(ref.source)&&digest(ref.sha256),'file reference');const bytes=readFileSync(ref.source);requireProof(sha(bytes)===ref.sha256,'source changed');return JSON.parse(bytes.toString('utf8'));}

/** A diagnostic is explicitly outside hidden-case scoring; it reuses the canonical ledger and approved models.
 * Called inside the same transaction as runtime advancement.
 * @param {import('./evaluation-runtime-control.mjs').RuntimePolicy} previous
 * @param {import('./evaluation-runtime-control.mjs').RuntimePolicy} next
 * @param {import('./evaluation-budget.mjs').LedgerDatabase} database
 */
export function verifyNavigationDiagnosticIteration(previous,next,database){
 const diagnostic=next.navigationDiagnostic,iteration=next.benchmarkIteration;
 requireProof(isNavigationDiagnostic(diagnostic)&&iteration&&diagnostic.iterationId===iteration.iterationId,'iteration');
 requireProof(previous.modelsSha256===next.modelsSha256&&previous.selectionSha256===next.selectionSha256&&same(previous.unseenTenScopeExtension,next.unseenTenScopeExtension),'retained models and historical scope');
 const proof=read({source:diagnostic.source,sha256:diagnostic.sourceSha256});
 requireProof(proof.version==='navigation-diagnostic-v1'&&proof.decision==='RunPublicNavigationPhaseDiagnostic'&&proof.ownerAuthorized===true&&proof.recordsActualOwnerAnswer===true&&text(proof.ownerAnswer)&&proof.freshHiddenCredit===false,'owner and diagnostic scope');
 requireProof(proof.maximumPages===3&&proof.maximumModelRequests===diagnostic.maximumRequests&&proof.startingReservations===diagnostic.startingReservations&&proof.cumulativeCapNanodollars===next.maximumCostNanodollars&&proof.maximumRequests===next.requestExtension?.maximumRequests&&proof.resetCounters===false&&proof.resetOriginalStart===false&&proof.retainAllUnknownReserves===true,'retained limits');
 requireProof(text(proof.contractSource)&&proof.contractSource===next.source,'candidate path');
 const current=JSON.parse(readFileSync(proof.contractSource,'utf8')),prior=read(proof.previousContract);
 requireProof(current.version==='navigation-phase-contract-v1'&&current.iterationId===iteration.iterationId&&same(current.runtimePolicy,next)&&record(current.sourceFiles)&&hash(current.sourceFiles)===next.codeSha256,'actual candidate');
 requireProof(same(prior.runtimePolicy,previous)&&same({...current.grant,device:prior.grant.device,inode:prior.grant.inode},prior.grant)&&same(current.roleProfiles,prior.roleProfiles)&&hash(current.roleProfiles)===next.modelsSha256&&same(current.costPolicy,prior.costPolicy)&&same(current.ownerDecision,prior.ownerDecision),'same accounting and model authority');
 for(const [path,bound] of Object.entries(current.sourceFiles))requireProof(digest(bound)&&sha(readFileSync(path))===bound,'candidate source changed');
 if(!same(current.grant,prior.grant)){
  const identity=read(proof.canonicalIdentity),path=current.grant.storePath,file=statSync(path),budgets=database.prepare('SELECT * FROM evaluation_budgets ORDER BY budget_id').all(),reservations=database.prepare('SELECT * FROM evaluation_reservations ORDER BY budget_id,key').all();
  requireProof(current.sourceFiles[proof.canonicalIdentity.source]===proof.canonicalIdentity.sha256&&identity.version==='navigation-canonical-identity-v1'&&identity.canonicalPath===path&&realpathSync(path)===path&&'location' in database&&typeof database.location==='function'&&realpathSync(database.location())===path&&identity.previousDevice===prior.grant.device&&identity.previousInode===prior.grant.inode&&identity.device===file.dev&&identity.inode===file.ino&&current.grant.device===file.dev&&current.grant.inode===file.ino&&identity.databaseSha256===sha(readFileSync(path))&&identity.budgetsSha256===hash(budgets)&&identity.reservationsSha256===hash(reservations),'restored canonical identity and all accounting rows');
  for(const suffix of ['-wal','-shm'])requireProof(identity.sqliteSidecars[suffix]===(existsSync(path+suffix)?sha(readFileSync(path+suffix)):null),'SQLite sidecar context');
  const summary=read(identity.closedSummary),result=read(identity.closedResult);
  requireProof(current.sourceFiles[identity.closedSummary.source]===identity.closedSummary.sha256&&current.sourceFiles[identity.closedResult.source]===identity.closedResult.sha256&&summary.supervisorCleanupConfirmed===true&&summary.remainingRequests===(next.requestExtension?.maximumRequests??0)-diagnostic.startingReservations&&Math.round(summary.cumulativeCostUSD*1e9)===proof.cumulativeCapNanodollars-Math.round(summary.remainingUSD*1e9)&&result.ok===true&&result.value?.executionScope==='post-hoc-selected-case-retest'&&result.value.status==='completed'&&result.value.aggregateUsage.requests===diagnostic.startingReservations&&result.value.aggregateUsage.costNanodollars===Math.round(summary.cumulativeCostUSD*1e9)&&result.value.aggregateUsage.activeRequests===0,'closed run accounting provenance');
 }

 for(const ref of [proof.previousContract,proof.rootCapture,proof.driver,proof.closedRun,proof.timingAuthority,{source:diagnostic.source,sha256:diagnostic.sourceSha256}])requireProof(current.sourceFiles[ref.source]===ref.sha256,'source binding');
 const clock=read({source:iteration.source,sha256:iteration.sourceSha256}),timing=read(proof.timingAuthority);
 requireProof(current.sourceFiles[iteration.source]===iteration.sourceSha256&&proof.timingAuthority.source===previous.benchmarkIteration?.source&&proof.timingAuthority.sha256===previous.benchmarkIteration?.sourceSha256&&timing.ownerAuthorized===true&&clock.ownerAnswer===timing.ownerAnswer&&clock.ownerAuthorized===true&&clock.durationMilliseconds===7200000&&clock.cumulativeCapNanodollars===next.maximumCostNanodollars&&same(clock.navigationDiagnostic,{source:diagnostic.source,sha256:diagnostic.sourceSha256}),'retained timing authority');
 const capture=read(proof.rootCapture),url=URL.canParse(proof.rootUrl)?new URL(proof.rootUrl):null;
 requireProof(url&&url.protocol==='https:'&&!url.username&&!url.password&&capture.ok===true&&capture.value?.responseUrl===url.href&&isWebpageEvidence(capture.value.evidence)&&capture.value.evidence.url===url.href&&Array.isArray(capture.value.visibleLinks)&&capture.value.visibleLinks.length>=2,'captured public root');
 requireProof(same(current.navigationScope,{rootUrl:url.href,maximumPages:3,maximumModelRequests:20,selectedLinks:'two-observed-same-origin-path-links',rootCapture:proof.rootCapture,driver:proof.driver,freshHiddenCredit:false}),'navigation scope');
 const closure=read(proof.closedRun);requireProof(closure.cleanupConfirmed===true&&closure.code===0&&closure.signal===null&&closure.monitorFailure===null&&closure.failure===null&&Number.isSafeInteger(closure.ownedPid)&&closure.ownedPid>0,'previous execution closed');
 try{process.kill(closure.ownedPid,0);requireProof(false,'previous process active');}catch(error){requireProof(error instanceof Error&&'code' in error&&error.code==='ESRCH','previous process status');}
 const state=database.prepare('SELECT '+(previous.resumption?'runtime_resumption':previous.persistenceRecovery?'runtime_persistence_recovery':previous.successor?'runtime_successor':previous.continuation?'runtime_continuation':previous.renewal?'runtime_renewal':'benchmark_runtime')+' runtime FROM evaluation_budgets WHERE budget_id=?').get(previous.budgetId);
 requireProof(record(state)&&typeof state.runtime==='string'&&sha(state.runtime)===iteration.previousRuntimeSha256,'exact previous runtime');
 const runtime=JSON.parse(state.runtime),count=database.prepare('SELECT COUNT(*) n FROM evaluation_reservations WHERE budget_id=?').get(previous.budgetId);
 requireProof(record(count)&&count.n===diagnostic.startingReservations&&runtime.cancelled===false&&runtime.halted===null,'unchanged stopped accounting');
 requireProof(current.grant.id===previous.budgetId&&current.grant.storePath===prior.grant.storePath,'canonical grant');
 return {kind:'public-navigation-phase-diagnostic',freshHiddenCredit:false,maximumPages:3,maximumModelRequests:20};
}
