// @ts-check
import {readFile,writeFile,mkdir,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isRuntimePolicy,runtimePredecessorHash} from './evaluation-runtime-control.mjs';
/** @typedef {import('./mistral-benchmark.ts').BenchmarkContract} Contract */
/** @typedef {NonNullable<import('./evaluation-runtime-control.mjs').RuntimePolicy['renewal']>['approval']} Approval */
/** @typedef {{version:1,status:'PREPARED_UNFROZEN',predecessorContract:string,predecessorContractSha256:string,predecessorLedgerSha256:string,predecessorStateSha256:string,directory:string,grant:Contract['grant'],runtimePolicy:Contract['runtimePolicy'],approvalFile:string,sourceCandidates:string[],counters:{reservations:number,responses:number,unknown:number,inputTokens:number,outputTokens:number,rowDebitNanodollars:number,diagnosticDebitNanodollars:number,inclusiveDebitNanodollars:number},attemptPlan:{development:string[],holdout:string[],denominator:45,requiredPasses:39,selection:'ONE_APPLICABLE_ATTEMPT_NEVER_BEST_SCORE'}}} RenewalProposal */
/** @param {import('node:crypto').BinaryLike} bytes */
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
/** @param {string} file @param {unknown} value */
const write=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
/** Preparation reads metadata/ledger/selection only; no corpus, gold, keys, activation or network.
 * @param {{directory:string,predecessorContract:string,approval:Approval,pacing:import('./evaluation-runtime-control.mjs').RuntimePacingConfiguration}} command */
export async function prepareRuntimeRenewal(command){
 if(!command||typeof command.directory!=='string'||!command.directory||typeof command.predecessorContract!=='string'||!command.predecessorContract)throw new TypeError('EvaluationRenewalCommandInvalid');
 const bytes=await readFile(command.predecessorContract),prior=/** @type {Contract} */(JSON.parse(bytes.toString()));
 if(!prior||!isRuntimePolicy(prior.runtimePolicy)||prior.runtimePolicy.version!==2||prior.runtimePolicy.renewal)throw new TypeError('EvaluationRenewalPredecessorInvalid');
 const {DatabaseSync}=await import('node:sqlite'),source=await realpath(prior.grant.storePath),ledgerBytes=await readFile(source),db=new DatabaseSync(source,{readOnly:true});
 /** @type {RenewalProposal['counters']} */let counters;
 /** @type {Contract['runtimePolicy']} */let runtimePolicy;
 let predecessorStateSha256;
 try{
  const row=db.prepare('SELECT * FROM evaluation_budgets WHERE budget_id=?').get(prior.grant.id);
  if(!row||typeof row.benchmark_runtime!=='string')throw new TypeError('EvaluationRenewalPredecessorInvalid');
  const state=JSON.parse(row.benchmark_runtime);
  if(JSON.stringify(state.policy)!==JSON.stringify(prior.runtimePolicy)||!Array.isArray(state.dispatches))throw new TypeError('EvaluationRenewalPredecessorInvalid');
  const rows=db.prepare('SELECT * FROM evaluation_reservations ORDER BY rowid').all();
  const priorUnknowns=rows.filter(r=>r.response===null).map(r=>({key:String(r.key),estimatedDebitNanodollars:Number(r.cost),uncertaintyVersion:Number(r.uncertainty_version)}));
  runtimePolicy={...prior.runtimePolicy,source:command.approval.source,maximumMilliseconds:5400000,maximumAdditionalRecoveries:20,predecessorSha256:runtimePredecessorHash(db,{includeRuntime:true,includeBenchmark:true}),priorUnknowns,renewal:{approval:structuredClone(command.approval),approvalSha256:hash(JSON.stringify(command.approval)),previousRuntimeSha256:hash(row.benchmark_runtime),pacing:structuredClone(command.pacing),maximumWindows:3}};
  if(!isRuntimePolicy(runtimePolicy))throw new TypeError('EvaluationRenewalApprovalInvalid');
  const n=db.prepare('SELECT COUNT(*) reservations,SUM(response IS NOT NULL) responses,SUM(response IS NULL) unknown,SUM(input_tokens) inputTokens,SUM(output_tokens) outputTokens,SUM(cost) rowDebitNanodollars FROM evaluation_reservations').get();
  if(!n)throw new TypeError('EvaluationRenewalPredecessorInvalid');
  const diagnosticDebitNanodollars=runtimePolicy.lineage?.diagnosticDebitNanodollars;
  if(diagnosticDebitNanodollars===undefined)throw new TypeError('EvaluationRenewalPredecessorInvalid');
  counters={reservations:Number(n.reservations),responses:Number(n.responses),unknown:Number(n.unknown),inputTokens:Number(n.inputTokens),outputTokens:Number(n.outputTokens),rowDebitNanodollars:Number(n.rowDebitNanodollars),diagnosticDebitNanodollars,inclusiveDebitNanodollars:Number(n.rowDebitNanodollars)+diagnosticDebitNanodollars};
  predecessorStateSha256=hash(JSON.stringify({budgets:db.prepare('SELECT * FROM evaluation_budgets ORDER BY budget_id').all(),reservations:rows}));
  await mkdir(command.directory,{recursive:false,mode:0o700});
  const directory=await realpath(command.directory),destination=directory+'/shared.sqlite';
  db.exec(`VACUUM INTO '${destination.replaceAll("'","''")}'`);
 }finally{db.close();}
 const directory=await realpath(command.directory),identity=await stat(directory+'/shared.sqlite'),grant={...prior.grant,storePath:directory+'/shared.sqlite',device:identity.dev,inode:identity.ino};
 const approvalFile=directory+'/owner-approval.json';await write(approvalFile,command.approval);await write(directory+'/grant.json',grant);
 if(!Array.isArray(prior.selection)||prior.selection.length!==45||new Set(prior.selection.map(s=>s.caseId)).size!==45||prior.selection.filter(s=>s.split==='development').length!==15||prior.selection.filter(s=>s.split==='holdout').length!==30)throw new TypeError('EvaluationRenewalSelectionInvalid');
 /** @type {RenewalProposal} */const proposal={version:1,status:'PREPARED_UNFROZEN',directory,predecessorContract:command.predecessorContract,predecessorContractSha256:hash(bytes),predecessorLedgerSha256:hash(ledgerBytes),predecessorStateSha256,grant,runtimePolicy,approvalFile,sourceCandidates:[...new Set([...Object.keys(prior.sourceFiles),'scripts/evaluation-runtime-renewal.mjs','tests-node/evaluation-runtime-renewal.test.mjs',command.predecessorContract,approvalFile,directory+'/grant.json'])],counters,attemptPlan:{development:prior.selection.filter(s=>s.split==='development').map(s=>s.caseId),holdout:prior.selection.filter(s=>s.split==='holdout').map(s=>s.caseId),denominator:45,requiredPasses:39,selection:'ONE_APPLICABLE_ATTEMPT_NEVER_BEST_SCORE'}};
 await write(directory+'/proposal.json',proposal);
 return proposal;
}
/** Integrator calls only after all source writers finish. This creates a contract, never a review PASS.
 * @param {{proposalFile:string,additionalSources?:string[]}} command @returns {Promise<Contract>} */
export async function freezeRuntimeRenewal(command){
 const proposalFile=command?.proposalFile;
 if(typeof proposalFile!=='string'||!proposalFile||command.additionalSources!==undefined&&(!Array.isArray(command.additionalSources)||command.additionalSources.some(p=>typeof p!=='string'||!p)))throw new TypeError('EvaluationRenewalCommandInvalid');
 const proposal=/** @type {RenewalProposal} */(JSON.parse(await readFile(proposalFile,'utf8')));
 if(proposal.status!=='PREPARED_UNFROZEN'||!isRuntimePolicy(proposal.runtimePolicy)||!proposal.runtimePolicy.renewal)throw new TypeError('EvaluationRenewalProposalInvalid');
 const previousBytes=await readFile(proposal.predecessorContract),prior=/** @type {Contract} */(JSON.parse(previousBytes.toString()));
 if(hash(previousBytes)!==proposal.predecessorContractSha256||hash(await readFile(prior.grant.storePath))!==proposal.predecessorLedgerSha256||hash(JSON.stringify(JSON.parse(await readFile(proposal.approvalFile,'utf8'))))!==proposal.runtimePolicy.renewal.approvalSha256)throw new TypeError('EvaluationRenewalPredecessorChanged');
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(proposal.grant.storePath,{readOnly:true});
 try{if(runtimePredecessorHash(db,{includeRuntime:true,includeBenchmark:true})!==proposal.runtimePolicy.predecessorSha256)throw new TypeError('EvaluationRenewalPredecessorChanged');}finally{db.close();}
 /** @type {Record<string,string>} */const sourceFiles={};for(const file of new Set([...proposal.sourceCandidates,...(command.additionalSources??[])]))sourceFiles[file]=hash(await readFile(file));
 const directory=proposal.directory,paths={...prior.paths,grant:directory+'/grant.json',ownerDecision:directory+'/owner-decision.json'};
 const ownerDecision={...prior.ownerDecision,authority:'Actual owner personally approved90min from PAIDactivation;<=3 resumable30min windows;20 ADDITIONAL shared recoveries; unchangedUSD5 including all history/diagnostics/reserves',source:proposal.approvalFile};await write(paths.ownerDecision,ownerDecision);sourceFiles[paths.ownerDecision]=hash(await readFile(paths.ownerDecision));
 const runtimePolicy={...proposal.runtimePolicy,codeSha256:hash(JSON.stringify(sourceFiles))};
 /** @type {Contract} */const contract={...prior,directory,activated:false,grant:proposal.grant,runtimePolicy,ownerDecision,sourceFiles,paths,predecessor:{contractFile:proposal.predecessorContract,canonicalPath:prior.grant.storePath,canonicalSha256:proposal.predecessorLedgerSha256,canonicalStateSha256:proposal.predecessorStateSha256},iterationId:prior.iterationId+':renewal:'+runtimePolicy.codeSha256,forecastFile:directory+'/forecast.json',reviewFile:directory+'/HERMES-REVIEW.json'};
 const forecast=JSON.parse(await readFile(prior.forecastFile,'utf8'));await write(contract.forecastFile,{...forecast,inputScenarioFits:forecast.scenarios.map((/** @type {{inputTokens:number}} */ s)=>s.inputTokens<=contract.grant.policy.maximumInputTokens-proposal.counters.inputTokens),estimatedFits:forecast.scenarios.every((/** @type {{newRunEstimateUSD:number}} */ s)=>s.newRunEstimateUSD<(5000000000-proposal.counters.inclusiveDebitNanodollars)/1e9),predecessorInclusiveUSD:proposal.counters.inclusiveDebitNanodollars/1e9,remainingUSD:(5000000000-proposal.counters.inclusiveDebitNanodollars)/1e9,remainingTokenCapacity:{input:contract.grant.policy.maximumInputTokens-proposal.counters.inputTokens,output:contract.grant.policy.maximumOutputTokens-proposal.counters.outputTokens},notice:'Saved forecast scenarios retained; not a measured result or billed ceiling. Completion remains bounded by remaining tokens/time/cost.'});
 await write(directory+'/contract.json',contract);return contract;
}
