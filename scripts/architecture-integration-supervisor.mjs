// @ts-check
import process from 'node:process';
import {spawn} from 'node:child_process';
import {open,readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifySource,readJson,contractFile,runDirectory,runLive} from './architecture-integration.ts';
/** Run a reviewed driver in one owned process group. Deadline starts in canonical runtime state.
 * @param {{command:string,args:string[],deadline:()=>Promise<number|null|{deadlineAtMs:number|null,stopReason:'IntegrationRuntimeHalted'|'IntegrationRuntimeCancelled'|null}>,directory:string,pollMs?:number}} options */
export async function supervise(options){
 if(!options||!options.command||!Array.isArray(options.args)||typeof options.deadline!=='function'||!options.directory||options.pollMs!==undefined&&(!Number.isSafeInteger(options.pollMs)||options.pollMs<10))throw new TypeError('IntegrationSupervisorInvalid');
 const stdout=await open(options.directory+'/supervisor-stdout.log','a',0o600),stderr=await open(options.directory+'/supervisor-stderr.log','a',0o600);
 const child=spawn(options.command,options.args,{detached:true,stdio:['ignore',stdout.fd,stderr.fd]});const spawnError=new Promise(r=>child.once('error',r));await stdout.close();await stderr.close();if(!child.pid){const cause=await spawnError;const report={ownedPid:null,cleanupConfirmed:false,failure:'IntegrationSupervisorSpawnFailed',finishedAt:new Date().toISOString()};await appendFile(options.directory+'/supervisor-terminals.jsonl',JSON.stringify(report)+'\n',{mode:0o600});throw new TypeError('IntegrationSupervisorSpawnFailed',{cause});}
 let settled=false,stopping=false,killTimer,timer,monitorFailure;
 /** @type {string|null} */let stopReason=null;
 const kill=(/** @type {NodeJS.Signals} */ signal)=>{try{process.kill(-/** @type {number} */(child.pid),signal);}catch(error){if(!(error instanceof Error)||!('code'in error)||error.code!=='ESRCH')throw error;}};
 const stop=(reason='IntegrationSupervisorSignal')=>{if(stopping||settled)return;stopping=true;stopReason=reason;kill('SIGTERM');killTimer=setTimeout(()=>{try{kill('SIGKILL');}catch(error){monitorFailure??=error;}},5000);};
 const signalStop=()=>stop();process.once('SIGTERM',signalStop);process.once('SIGINT',signalStop);
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{settled=true;resolve({code,signal});});});
 async function monitor(){if(settled)return;let state;try{state=await options.deadline();}catch(error){if(error instanceof TypeError&&error.message==='MonitorDeadlineExceeded'){stop('IntegrationDeadlineExceeded');return;}throw error;}if(settled)return;const deadline=typeof state==='object'&&state!==null?state.deadlineAtMs:state;if(typeof state==='object'&&state!==null){if(Object.keys(state).sort().join(',')!=='deadlineAtMs,stopReason'||state.stopReason!==null&&!['IntegrationRuntimeHalted','IntegrationRuntimeCancelled'].includes(state.stopReason))throw new TypeError('IntegrationSupervisorStateInvalid');if(state.stopReason)stop(state.stopReason);}if(deadline!==null&&!Number.isSafeInteger(deadline))throw new TypeError('IntegrationSupervisorStateInvalid');if(deadline!==null&&Date.now()>=deadline)stop('IntegrationDeadlineExceeded');if(!settled)timer=setTimeout(()=>{void monitor().catch(error=>{monitorFailure=error;stop('IntegrationSupervisorMonitorFailed');});},options.pollMs??1000);}
 let result={code:null,signal:null},failure,cleanupConfirmed=false;
 try{await writeFile(options.directory+'/tracked-process.json',JSON.stringify({pid:child.pid,processGroup:child.pid,startedAt:new Date().toISOString(),deadlineSource:'canonical runtime'})+'\n',{mode:0o600});try{await monitor();}catch(error){monitorFailure=error;stop('IntegrationSupervisorMonitorFailed');}result=await exited;if(monitorFailure)failure=new TypeError('IntegrationSupervisorMonitorFailed',{cause:monitorFailure});}
 catch(error){failure=error;}
 finally{
  clearTimeout(timer);clearTimeout(killTimer);process.removeListener('SIGTERM',signalStop);process.removeListener('SIGINT',signalStop);
  try{kill('SIGTERM');let remaining=false;try{process.kill(-child.pid,0);remaining=true;}catch(error){if(!(error instanceof Error)||!('code'in error)||error.code!=='ESRCH')throw error;}if(remaining){kill('SIGKILL');await new Promise(r=>setTimeout(r,100));try{process.kill(-child.pid,0);throw new TypeError('IntegrationCleanupUnconfirmed');}catch(error){if(!(error instanceof Error)||!('code'in error)||error.code!=='ESRCH')throw error;}}cleanupConfirmed=true;}
  catch(error){failure=failure?new AggregateError([failure,error],'IntegrationCleanupFailed'):error;}
  const report={ownedPid:child.pid,...result,stopping,stopReason,cleanupConfirmed,monitorFailure:monitorFailure instanceof Error?monitorFailure.name:null,failure:failure instanceof Error?failure.name:null,finishedAt:new Date().toISOString()};
  await appendFile(options.directory+'/supervisor-terminals.jsonl',JSON.stringify(report)+'\n',{mode:0o600});await writeFile(options.directory+'/supervisor-terminal.json',JSON.stringify(report)+'\n',{mode:0o600});
 }
 if(failure)throw failure;return {...result,stopping,stopReason,cleanupConfirmed,finishedAt:new Date().toISOString()};
}
export async function runReviewedIntegration(){
 const contract=await readJson(contractFile);await verifySource(contract);
 const {DatabaseSync}=await import('node:sqlite');
 await mkdir(runDirectory(contract),{recursive:true});const result=await supervise({command:process.execPath,args:['scripts/architecture-integration.ts','--run'],directory:runDirectory(contract),deadline:async()=>{const db=new DatabaseSync(contract.grant.storePath,{readOnly:true});try{const row=db.prepare('SELECT * FROM evaluation_budgets WHERE budget_id=?').get(contract.grant.id);if(!row)throw new TypeError('IntegrationSupervisorBudgetMissing');if(row.runtime_control===undefined||row.runtime_control===null)return null;if(typeof row.runtime_control!=='string'||!row.runtime_control)throw new TypeError('IntegrationSupervisorStateInvalid');const state=JSON.parse(String(row.runtime_control));if(JSON.stringify(state.policy)!==JSON.stringify(contract.runtimePolicy)&&(contract.previousPolicy===undefined||JSON.stringify(state.policy)!==JSON.stringify(contract.previousPolicy)))throw new TypeError('IntegrationSupervisorContractChanged');return {deadlineAtMs:state.deadlineAtMs,stopReason:state.halted?'IntegrationRuntimeHalted':state.cancelled?'IntegrationRuntimeCancelled':null};}finally{db.close();}}});return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){if(process.argv.slice(2).join(' ')!=='--run')throw new TypeError('IntegrationSupervisorArgumentsInvalid');process.exitCode=(await runReviewedIntegration()).code??1;}

/** Bounded read-only monitor; retries only numeric SQLITE_BUSY5, never initializes a shared store.
 * @param {{databasePath:string,budgetId:string,runtimeColumn:'runtime_control'|'benchmark_runtime'|'runtime_renewal'|'runtime_continuation'|'runtime_successor'|'runtime_persistence_recovery'|'runtime_resumption',policy:unknown,initializationPending?:true,maximumReadMs?:number,retryLimit?:number,knownDeadlineAtMs?:number|null,signal?:AbortSignal}} c
 * @returns {Promise<{policy:unknown,deadlineAtMs:number|null,cancelled:boolean,halted:string|null,windows:{deadlineAtMs:number}[]}|null>} */
export async function readMonitorState(c){
 if(!c||typeof c.databasePath!=='string'||!c.databasePath||typeof c.budgetId!=='string'||!c.budgetId||!['runtime_control','benchmark_runtime','runtime_renewal','runtime_continuation','runtime_successor','runtime_persistence_recovery','runtime_resumption'].includes(c.runtimeColumn)||!c.policy||c.initializationPending!==undefined&&c.initializationPending!==true||c.maximumReadMs!==undefined&&(!Number.isSafeInteger(c.maximumReadMs)||c.maximumReadMs<1||c.maximumReadMs>1000)||c.retryLimit!==undefined&&(!Number.isSafeInteger(c.retryLimit)||c.retryLimit<1||c.retryLimit>40)||c.knownDeadlineAtMs!==undefined&&c.knownDeadlineAtMs!==null&&!Number.isSafeInteger(c.knownDeadlineAtMs)||c.signal!==undefined&&!(c.signal instanceof AbortSignal))throw new TypeError('MonitorCommandInvalid');
 const {DatabaseSync}=await import('node:sqlite');const bound=Date.now()+(c.maximumReadMs??500);let attempts=0;
 while(true){
  if(c.signal?.aborted)throw new TypeError('MonitorCancelled');
  if(c.knownDeadlineAtMs!=null&&Date.now()>=c.knownDeadlineAtMs)throw new TypeError('MonitorDeadlineExceeded');
  let db;
  try{db=new DatabaseSync(c.databasePath,{readOnly:true});if(!db.prepare('PRAGMA table_info(evaluation_budgets)').all().some(r=>r.name===c.runtimeColumn)){if(c.initializationPending===true)return null;throw new TypeError('MonitorRuntimeColumnMissing');}const row=db.prepare('SELECT '+c.runtimeColumn+' AS runtime FROM evaluation_budgets WHERE budget_id=?').get(c.budgetId);if(!row)throw new TypeError('MonitorBudgetMissing');if(row.runtime===null)return null;if(typeof row.runtime!=='string')throw new TypeError('MonitorStateInvalid');let state;try{state=JSON.parse(row.runtime);}catch(error){throw new TypeError('MonitorStateInvalid',{cause:error});}if(!state||typeof state!=='object'||typeof state.cancelled!=='boolean'||state.halted!==null&&typeof state.halted!=='string'||state.deadlineAtMs!==null&&!Number.isSafeInteger(state.deadlineAtMs)||!Array.isArray(state.windows)||state.windows.some((/** @type {{deadlineAtMs:number}} */ w)=>!w||!Number.isSafeInteger(w.deadlineAtMs)))throw new TypeError('MonitorStateInvalid');if(JSON.stringify(state.policy)!==JSON.stringify(c.policy))throw new TypeError('MonitorContractChanged');return (state.policy.benchmarkIteration&&state.benchmarkIterationActivatedAtMs===undefined||state.policy.resumedExecution&&state.resumedExecutionActivatedAtMs===undefined||state.policy.resumption&&state.resumptionActivatedAtMs===undefined)?{...state,deadlineAtMs:null,windows:[]}:state;
  }catch(error){if(error instanceof TypeError)throw error;if(!(error instanceof Error)||!('errcode'in error)||error.errcode!==5)throw new TypeError('MonitorDatabaseFailure',{cause:error});if(++attempts>=(c.retryLimit??20)||Date.now()>=bound)throw new TypeError('MonitorDatabaseBusyExhausted',{cause:error});}
  finally{db?.close();}
  await new Promise(r=>setTimeout(r,Math.max(1,Math.min(25,bound-Date.now(),c.knownDeadlineAtMs==null?25:c.knownDeadlineAtMs-Date.now()))));
 }
}
