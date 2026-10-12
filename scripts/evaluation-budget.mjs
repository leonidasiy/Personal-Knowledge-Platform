// @ts-check
import {AgentExecutionBoundaryFailure} from '../src/features/knowledge-workflows/harness.js';
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {createRuntimeControl,isRuntimePolicy} from './evaluation-runtime-control.mjs';
import {projectProviderFailure,isProviderFailure} from './evaluation-provider-diagnostics.mjs';
import {isProviderErrorTermination} from '../worker/provider-error.js';
import {isKnowledgeModelProvider} from '../worker/knowledge-workflow-model.js';
const authenticatedDiagnostics=new WeakSet();
/** @typedef {{maximumRequests:number,maximumInputTokens:number,maximumOutputTokens:number,maximumMilliseconds:number,maximumCostNanodollars:number}} EvaluationBudgetPolicy */
/** @typedef {{isTransaction?:boolean,exec:(sql:string)=>unknown,prepare:(sql:string)=>{run:(...values:(string|number|null)[])=>unknown,get:(...values:(string|number|null)[])=>unknown,all:(...values:(string|number|null)[])=>unknown[]}}} LedgerDatabase */
/** @typedef {{key:string,inputTokens:number,outputTokens:number,costNanodollars:number}} Reservation */
/** @typedef {{source:string,retrievedAt:string,catalogSha256:string,model:{id:string,canonical_slug:string,context_length:number,supported_parameters?:string[],architecture:{input_modalities:string[]},pricing:{prompt:string,completion:string},reasoning?:{supported_efforts?:string[]|null,mandatory?:boolean}}}} EvaluationCatalog */
/** @typedef {'EvaluationProviderError'|'EvaluationCatalogInvalid'|'EvaluationLedgerPersistenceFailed'|'EvaluationReservationInvalid'|'EvaluationCancelled'|'EvaluationAccountingHalted'|'EvaluationDeadlineExceeded'|'EvaluationLeaseUnresolved'|'EvaluationReservationConflict'|'EvaluationReservationUncertain'|'EvaluationBudgetExceeded'|'EvaluationUsageInvalid'|'EvaluationReservationMissing'|'EvaluationReservationAlreadyCompleted'|'EvaluationUsageExceedsReservation'|'EvaluationServedProviderMismatch'|'EvaluationServedModelMismatch'|'EvaluationTransportUncertain'|'EvaluationBillingConflict'|'EvaluationContinuationInvalid'|'EvaluationContinuationConflict'|'EvaluationExecutionAuthorityInvalid'|'EvaluationExecutionAuthorityConflict'|'EvaluationExecutionDebtConflict'|'EvaluationRecoveryAttemptsExhausted'|'EvaluationRecoveryEvidenceInvalid'|'EvaluationRecoveryCooldown'|'EvaluationResponseBodyTooLarge'|'EvaluationResponseReadFailed'} LedgerFailureKind */
/** Private structural metadata only; generation identity is never forwarded to logs.
 * @typedef {{httpStatus:number,errorEnvelope:boolean,errorCode?:number,bodyKind:'json'|'invalid-json',generationId?:string,finishReason?:'error',providerFailure?:import('./evaluation-provider-diagnostics.mjs').ProviderFailure}} EvaluationResponseDiagnostics */
const immutableSnapshots=new WeakSet();
/** Copy data descriptors only. Never read accessors or pass caller objects to serialization.
 * @param {unknown} value @param {Set<object>} [seen] @returns {Result<unknown>} */
function primitiveSnapshot(value,seen=new Set()){
 if(value===undefined||value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return {ok:true,value};
 if(typeof value!=='object'||types.isProxy(value)||seen.has(value))return failure('EvaluationUsageInvalid');
 if(immutableSnapshots.has(value))return {ok:true,value};
 const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
 if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)return failure('EvaluationUsageInvalid');
 seen.add(value);
 /** @type {Record<string,unknown>} */const copy=Object.create(null);
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
 for(const key of keys){
  if(array&&key==='length')continue;
  if(typeof key!=='string'||!descriptors[key].enumerable||!('value' in descriptors[key])||array&&!/^(0|[1-9][0-9]*)$/.test(key))return failure('EvaluationUsageInvalid');
  const checked=primitiveSnapshot(descriptors[key].value,seen);if(!checked.ok)return checked;copy[key]=checked.value;
 }
 seen.delete(value);
 if(!array){Object.freeze(copy);immutableSnapshots.add(copy);return {ok:true,value:copy};}
 const length=descriptors.length.value;
 if(Object.keys(copy).length!==length)return failure('EvaluationUsageInvalid');
 const result=Array.from({length},(_,i)=>copy[String(i)]);
 // Own safe shadow prevents even an inherited Array.prototype.toJSON from running.
 Object.defineProperty(result,'toJSON',{value:undefined});Object.freeze(result);immutableSnapshots.add(result);
 return {ok:true,value:result};
}
/** @param {unknown} v @returns {v is EvaluationResponseDiagnostics} */
function responseDiagnostics(v){return record(v)&&(v.providerFailure===undefined||isProviderFailure(v.providerFailure))&&Object.keys(v).every(k=>['httpStatus','errorEnvelope','errorCode','bodyKind','generationId','finishReason','providerFailure'].includes(k))&&(v.finishReason===undefined||v.finishReason==='error')&&count(v.httpStatus)&&v.httpStatus>=200&&v.httpStatus<=599&&typeof v.errorEnvelope==='boolean'&&typeof v.bodyKind==='string'&&['json','invalid-json'].includes(v.bodyKind)&&(v.errorCode===undefined||count(v.errorCode)&&v.errorCode>=100&&v.errorCode<=599)&&(v.generationId===undefined||typeof v.generationId==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(v.generationId));}
/** Sanitized SQLite structure; raw SQL/messages may contain private values.
 * @typedef {{name:string,code:string,errcode:number|null,cause:string|null}} SQLiteFailure */
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:{kind:LedgerFailureKind,field?:string,persistence?:SQLiteFailure}}} Result */
/** @param {unknown} v @returns {v is Record<string,unknown>} */
const record=v=>typeof v==='object'&&v!==null&&!Array.isArray(v);
/** Exact current and authoritative legacy optional receipt fields; never project an untrusted receipt.
 * @param {unknown} value @returns {value is EvaluationProviderReceipt} */
function providerReceipt(value){
 /** @param {unknown} v @param {string[]} keys @returns {v is Record<string,unknown>} */
 const fields=(v,keys)=>record(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null)&&Object.keys(v).every(k=>keys.includes(k))&&Object.values(Object.getOwnPropertyDescriptors(v)).every(p=>'value' in p);
 /** @param {unknown} v @param {string[]} keys @param {boolean} [money] */
 const numbers=(v,keys,money=false)=>fields(v,keys)&&Object.values(v).every(n=>n===undefined||(money?typeof n==='number'&&Number.isFinite(n)&&n>=0:count(n)));
 if(!fields(value,['httpStatus','error','id','model','choices','usage']))return false;
 if(value.httpStatus!==undefined&&(!count(value.httpStatus)||value.httpStatus<200||value.httpStatus>599)||value.id!==undefined&&(typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(value.id))||value.model!==undefined&&typeof value.model!=='string')return false;
 if(value.error!==undefined&&(!fields(value.error,['code'])||value.error.code!==undefined&&(!count(value.error.code)||value.error.code<100||value.error.code>599)))return false;
 if(value.choices!==undefined&&(!Array.isArray(value.choices)||!value.choices.every(c=>c===null||fields(c,['index','finish_reason','message'])&&(c.index===undefined||count(c.index))&&(c.finish_reason===undefined||c.finish_reason===null||typeof c.finish_reason==='string')&&(c.message===undefined||fields(c.message,['role','content'])&&(c.message.role===undefined||typeof c.message.role==='string')&&(c.message.content===undefined||c.message.content===null||typeof c.message.content==='string')))))return false;
 if(value.usage!==undefined){
  const u=value.usage;
  if(!fields(u,['prompt_tokens','completion_tokens','total_tokens','cost','is_byok','cost_details','prompt_tokens_details','completion_tokens_details'])||!numbers({prompt_tokens:u.prompt_tokens,completion_tokens:u.completion_tokens,total_tokens:u.total_tokens},['prompt_tokens','completion_tokens','total_tokens'])||u.cost!==undefined&&(typeof u.cost!=='number'||!Number.isFinite(u.cost)||u.cost<0)||u.is_byok!==undefined&&typeof u.is_byok!=='boolean')return false;
  if(u.cost_details!==undefined&&!numbers(u.cost_details,['upstream_inference_cost','upstream_inference_prompt_cost','upstream_inference_completions_cost'],true)||u.prompt_tokens_details!==undefined&&!numbers(u.prompt_tokens_details,['cached_tokens','audio_tokens','video_tokens'])||u.completion_tokens_details!==undefined&&!numbers(u.completion_tokens_details,['reasoning_tokens','audio_tokens','accepted_prediction_tokens','rejected_prediction_tokens']))return false;
 }
 return true;
}
/** @param {unknown} v @returns {v is number} */
const count=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
/** @param {unknown} v @returns {v is string} */
const text=v=>typeof v==='string'&&v.trim()!=='';
/** @param {LedgerFailureKind} kind @param {string} [field] */
const failure=(kind,field)=>({ok:/** @type {const} */(false),error:{kind,...(field?{field}:{})}});
/** Exact decimal conversion: no floating-point rounding under a money ceiling.
 * @param {unknown} value @returns {number|null} */
export function nanodollars(value){
 if(typeof value!=='string'||!/^\d+(?:\.\d{1,9})?$/.test(value))return null;
 const [whole,fraction='']=value.split('.'),n=BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));
 return n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;
}
/** Provider JSON numbers are charged by their decimal representation, rounded up to a nanodollar.
 * @param {number} value @returns {number|null} */
function chargedNanodollars(value){
 if(!Number.isFinite(value)||value<0)return null;
 const [decimal,exponent='0']=String(value).split('e'),[whole,fraction='']=decimal.split('.');
 const digits=BigInt(whole+fraction),power=9+Number(exponent)-fraction.length;
 const amount=power>=0?digits*10n**BigInt(power):(digits+10n**BigInt(-power)-1n)/10n**BigInt(-power);
 return amount<=BigInt(Number.MAX_SAFE_INTEGER)?Number(amount):null;
}
/** @typedef {{source:string,readiness:'owner-authorized-first-development-case',excludedCreators:string[],approved:{id:string,canonicalSlug:string,creator:string,catalogSha256:string,prompt:string,completion:string}[]}} BenchmarkModelContract */
/** Catalogue namespaces are raw identities, authorized explicitly by the owner; no alias inference.
 * @param {EvaluationCatalog} catalog @param {unknown} contract
 * @returns {{ok:true,value:BenchmarkModelContract}|{ok:false,error:{kind:'EvaluationBenchmarkContractMissing'|'EvaluationBenchmarkContractInvalid'|'EvaluationBenchmarkModelExcluded'|'EvaluationBenchmarkModelUnknown'|'EvaluationBenchmarkContractConflict',field:string}}} */
export function validateBenchmarkModelContract(catalog,contract){
 const fail=(/** @type {'EvaluationBenchmarkContractMissing'|'EvaluationBenchmarkContractInvalid'|'EvaluationBenchmarkModelExcluded'|'EvaluationBenchmarkModelUnknown'|'EvaluationBenchmarkContractConflict'} */kind)=>({ok:/** @type {const} */(false),error:{kind,field:'benchmark model identity/source'}});
 if(contract===undefined)return fail('EvaluationBenchmarkContractMissing');
 if(!record(contract)||Object.keys(contract).sort().join(',')!=='approved,excludedCreators,readiness,source'||!text(contract.source)||contract.readiness!=='owner-authorized-first-development-case'||!Array.isArray(contract.excludedCreators)||!contract.excludedCreators.every(text)||!Array.isArray(contract.approved)||!contract.approved.length||contract.approved.some(a=>!record(a)||Object.keys(a).sort().join(',')!=='canonicalSlug,catalogSha256,completion,creator,id,prompt'||![a.id,a.canonicalSlug,a.creator,a.catalogSha256,a.prompt,a.completion].every(text)||String(a.id).split('/')[0]!==a.creator||/** @type {unknown[]} */(contract.excludedCreators).includes(a.creator)))return fail('EvaluationBenchmarkContractInvalid');
 if(!catalog||!catalog.model||!text(catalog.model.id))return fail('EvaluationBenchmarkContractInvalid');
 if(contract.excludedCreators.includes(catalog.model.id.split('/')[0]))return fail('EvaluationBenchmarkModelExcluded');
 const a=contract.approved.find(a=>a.id===catalog.model.id);
 if(!a)return fail('EvaluationBenchmarkModelUnknown');
 if(a.canonicalSlug!==catalog.model.canonical_slug||a.catalogSha256!==catalog.catalogSha256||a.prompt!==catalog.model.pricing.prompt||a.completion!==catalog.model.pricing.completion)return fail('EvaluationBenchmarkContractConflict');
 return {ok:true,value:structuredClone(/** @type {BenchmarkModelContract} */(contract))};
}
/** @param {unknown} value @param {string} model @returns {Result<EvaluationCatalog>} */
export function validateEvaluationCatalog(value,model){
 if(!text(model)||!record(value)||!['https://openrouter.ai/api/v1/models','https://openrouter.ai/api/v1/models/user','https://openrouter.ai/api/v1/models/'+model+'/endpoints'].includes(String(value.source))||!text(value.retrievedAt)||!Number.isFinite(Date.parse(value.retrievedAt))||typeof value.catalogSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.catalogSha256)||!record(value.model)||value.model.id!==model||!text(value.model.canonical_slug)||!count(value.model.context_length)||value.model.context_length===0||!record(value.model.architecture)||!Array.isArray(value.model.architecture.input_modalities)||!value.model.architecture.input_modalities.includes('text')||!value.model.architecture.input_modalities.includes('image')||!record(value.model.pricing)||nanodollars(value.model.pricing.prompt)===null||nanodollars(value.model.pricing.completion)===null)return failure('EvaluationCatalogInvalid','model/vision/pricing/provenance');
 return {ok:true,value:/** @type {EvaluationCatalog} */(value)};
}
/** @typedef {'configured'|'estimated'} EvaluationAccountingMode */
/** @typedef {{authority:string,source:string,decision:'TreatUSD1asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'|'TreatUSD5asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'}} EvaluationOwnerDecision */
/** @param {unknown} value @returns {value is EvaluationOwnerDecision} */
export function isEstimatedOwnerDecision(value){return record(value)&&Object.keys(value).sort().join(',')==='authority,decision,source'&&text(value.authority)&&text(value.source)&&['TreatUSD1asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest','TreatUSD5asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'].includes(String(value.decision));}
/** Planning only: measured UTF8 bytes/4 plus 8000 tokens per attached image from cost-estimate-v3.
 * These uncalibrated assumptions are never a tokenizer or binding billing ceiling.
 * @typedef {{inputTokens:number,outputTokens:number,costNanodollars:number,reference:string,source:string,approximate:true,textBytes:number,images:number,plannedAtMs:number}} EstimatedRequest */
/** @typedef {(body:Record<string,unknown>,catalog:EvaluationCatalog,signal:AbortSignal)=>Promise<EstimatedRequest>} EstimatedRequestPlanner */
/** @param {{metadata:EvaluationCatalog,costPolicy:{source:string,bytesPerToken:4,visualTokensPerImage:8000},sourceContract:EvaluationOwnerDecision,now:()=>number}} dependencies @returns {EstimatedRequestPlanner} */
export function createEstimatedRequestPlanner({metadata,costPolicy,sourceContract,now}){
 if(!isEstimatedOwnerDecision(sourceContract))throw new TypeError('EvaluationAccountingDecisionInvalid');
 const checked=validateEvaluationCatalog(metadata,metadata?.model?.id);if(!checked.ok)throw new EvaluationTransportFailure(checked.error);
 if(!record(costPolicy)||Object.keys(costPolicy).sort().join(',')!=='bytesPerToken,source,visualTokensPerImage'||!text(costPolicy.source)||costPolicy.bytesPerToken!==4||costPolicy.visualTokensPerImage!==8000||typeof now!=='function')throw new TypeError('EvaluationEstimatePolicyInvalid');
 const catalog=structuredClone(checked.value),policy=structuredClone(costPolicy),decision=structuredClone(sourceContract);
 return async(body,current,signal)=>{
  if(!(signal instanceof AbortSignal)||signal.aborted||JSON.stringify(current)!==JSON.stringify(catalog)||!record(body)||body.model!==catalog.model.id||!count(body.max_tokens)||body.max_tokens===0||!Array.isArray(body.messages))throw new EvaluationTransportFailure({kind:'EvaluationEstimateRequestInvalid'});
  let images=0;
  const textBody=JSON.stringify(body,(key,value)=>{if(record(value)&&value.type==='image_url'){if(!record(value.image_url)||!text(value.image_url.url))throw new EvaluationTransportFailure({kind:'EvaluationEstimateRequestInvalid',field:'image'});images++;return {type:'image_url'};}return value;});
  const textBytes=new TextEncoder().encode(textBody).length,inputTokens=Math.ceil(textBytes/policy.bytesPerToken)+images*policy.visualTokensPerImage;
  const costNanodollars=inputTokens*Number(nanodollars(catalog.model.pricing.prompt))+body.max_tokens*Number(nanodollars(catalog.model.pricing.completion)),plannedAtMs=now();
  if(!count(costNanodollars)||!count(plannedAtMs))throw new EvaluationTransportFailure({kind:'EvaluationEstimateRequestInvalid'});
  return {inputTokens,outputTokens:body.max_tokens,costNanodollars,reference:decision.source,source:policy.source,approximate:true,textBytes,images,plannedAtMs};
 };
}
/** @typedef {{key:string,estimatedDebitNanodollars:number,uncertaintyVersion:number}} EvaluationPriorUnknown */
/** @typedef {{ownerAuthorized:true,authority:string,source:string,decisionId:string,decision:'ContinueNamedPriorUnknownEstimatesOnly',originalStartedAtMs:number,originalDeadlineAtMs:number,haltKind:string,priorUnknowns:EvaluationPriorUnknown[]}} EvaluationContinuationDecision */
/** @param {unknown} c @returns {c is EvaluationContinuationDecision} */
export function isEvaluationContinuationDecision(c){return record(c)&&Object.keys(c).sort().join(',')==='authority,decision,decisionId,haltKind,originalDeadlineAtMs,originalStartedAtMs,ownerAuthorized,priorUnknowns,source'&&c.ownerAuthorized===true&&c.decision==='ContinueNamedPriorUnknownEstimatesOnly'&&[c.authority,c.source,c.decisionId,c.haltKind].every(text)&&count(c.originalStartedAtMs)&&count(c.originalDeadlineAtMs)&&Array.isArray(c.priorUnknowns)&&c.priorUnknowns.length>0&&new Set(c.priorUnknowns.map(u=>record(u)?u.key:undefined)).size===c.priorUnknowns.length&&c.priorUnknowns.every(u=>record(u)&&Object.keys(u).sort().join(',')==='estimatedDebitNanodollars,key,uncertaintyVersion'&&text(u.key)&&count(u.estimatedDebitNanodollars)&&count(u.uncertaintyVersion)&&u.uncertaintyVersion>0);}
/** @typedef {{ownerAuthorized:true,authority:string,source:string,decisionId:string,decision:'ContinueExactPriorUnknownsWith30MinuteWindow'|'RecoverExactThreeUnknownsWith30MinuteWindow',recovery?:{previousWindowSha256:string,maximumDiagnosticAttempts:3,priorRowsSha256:string},rateRecovery?:{maximumAdditionalAttempts:2|8,consumedBefore:1|2,missingHeaderBackoffMs:1000,maximumRetryAfterMs:86400000,documentation:'https://openrouter.ai/docs/api_reference/limits',ownerPolicy:string},new45?:{judgeModel:string,judgeVersion:string,attemptSource:string,previousRecoveryDispatches:2,canaryCaseId:string},renewal?:{version?:2|3|4,previousWindowSha256:string,ledgerStateSha256:string,consumedDiagnosticAttempts:1,remainingDiagnosticAttempts:2},maximumMilliseconds:1800000,originalGrantSha256:string,budgetId:string,storePath:string,device:number,inode:number,originalStartedAtMs:number,originalDeadlineAtMs:number,originalCancelled:true,haltKind:string,codeSha256:string,sourceSha256:string,modelsSha256:string,selectionSha256:string,priorUnknowns:EvaluationPriorUnknown[]}} EvaluationExecutionAuthority */
/** @typedef {{authority:EvaluationExecutionAuthority,startedAtMs:number,deadlineAtMs:number,cancelled:boolean}} EvaluationExecutionWindow */
/** @param {unknown} c @returns {c is EvaluationExecutionAuthority} */
export function isEvaluationExecutionAuthority(c){
 if(!record(c))return false;
 const recovery=c.decision==='RecoverExactThreeUnknownsWith30MinuteWindow';
 const keys='authority,budgetId,codeSha256,decision,decisionId,device,haltKind,inode,maximumMilliseconds,modelsSha256,originalCancelled,originalDeadlineAtMs,originalGrantSha256,originalStartedAtMs,ownerAuthorized,priorUnknowns,selectionSha256,source,sourceSha256,storePath'.split(',');
 if(recovery)keys.push('recovery');
 if(c.renewal!==undefined)keys.push('renewal');
 const v3=record(c.renewal)&&[3,4].includes(Number(c.renewal.version));
 const v2=record(c.renewal)&&[2,3,4].includes(Number(c.renewal.version));
 if(v3){keys.push('new45');if(!record(c.new45)||Object.keys(c.new45).sort().join(',')!=='attemptSource,canaryCaseId,judgeModel,judgeVersion,previousRecoveryDispatches'||c.new45.judgeModel!=='qwen/qwen3.8-flash'||c.new45.judgeVersion!=='qwen/qwen3.8-flash-20260826'||!text(c.new45.attemptSource)||!text(c.new45.canaryCaseId)||c.new45.previousRecoveryDispatches!==2)return false;}else if(c.new45!==undefined)return false;
 if(c.rateRecovery!==undefined)keys.push('rateRecovery');
 if(v2?!record(c.rateRecovery)||Object.keys(c.rateRecovery).sort().join(',')!=='consumedBefore,documentation,maximumAdditionalAttempts,maximumRetryAfterMs,missingHeaderBackoffMs,ownerPolicy'||c.rateRecovery.maximumAdditionalAttempts!==(v3?8:2)||c.rateRecovery.consumedBefore!==(v3?2:1)||c.rateRecovery.missingHeaderBackoffMs!==1000||c.rateRecovery.maximumRetryAfterMs!==86400000||c.rateRecovery.documentation!=='https://openrouter.ai/docs/api_reference/limits'||!text(c.rateRecovery.ownerPolicy):c.rateRecovery!==undefined)return false;
 return Object.keys(c).sort().join(',')===keys.sort().join(',')&&c.ownerAuthorized===true&&c.originalCancelled===true&&(recovery||c.decision==='ContinueExactPriorUnknownsWith30MinuteWindow')&&c.maximumMilliseconds===1800000&&[c.authority,c.source,c.decisionId,c.budgetId,c.storePath,c.haltKind].every(text)&&[c.device,c.inode,c.originalStartedAtMs,c.originalDeadlineAtMs].every(count)&&[c.originalGrantSha256,c.codeSha256,c.sourceSha256,c.modelsSha256,c.selectionSha256].every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))&&(!recovery||record(c.recovery)&&Object.keys(c.recovery).sort().join(',')==='maximumDiagnosticAttempts,previousWindowSha256,priorRowsSha256'&&c.recovery.maximumDiagnosticAttempts===3&&[c.recovery.previousWindowSha256,c.recovery.priorRowsSha256].every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h)))&&(c.renewal===undefined||recovery&&record(c.renewal)&&Object.keys(c.renewal).sort().join(',')===(v2?'consumedDiagnosticAttempts,ledgerStateSha256,previousWindowSha256,remainingDiagnosticAttempts,version':'consumedDiagnosticAttempts,ledgerStateSha256,previousWindowSha256,remainingDiagnosticAttempts')&&c.renewal.consumedDiagnosticAttempts===1&&c.renewal.remainingDiagnosticAttempts===2&&[c.renewal.previousWindowSha256,c.renewal.ledgerStateSha256].every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h)))&&Array.isArray(c.priorUnknowns)&&c.priorUnknowns.length===(v3?7:v2?4:recovery?3:2)&&new Set(c.priorUnknowns.map(u=>record(u)?u.key:undefined)).size===c.priorUnknowns.length&&c.priorUnknowns.every(u=>record(u)&&Object.keys(u).sort().join(',')==='estimatedDebitNanodollars,key,uncertaintyVersion'&&text(u.key)&&count(u.estimatedDebitNanodollars)&&count(u.uncertaintyVersion)&&u.uncertaintyVersion>0);
}
/** Canonical predecessor state digest; renewal columns are append-only additions.
 * @param {LedgerDatabase} database @param {1|2|3|4} [version] @returns {string} */
export function evaluationRenewalStateHash(database,version=1){
 if(!database||typeof database.prepare!=='function')throw new TypeError('EvaluationRenewalStoreInvalid');
 const budget=database.prepare('SELECT * FROM evaluation_budgets').get();if(!record(budget))throw new TypeError('EvaluationLedgerStateInvalid');
 const prior=Object.fromEntries(Object.entries(budget).filter(([key])=>!(version===4?key.startsWith('renewal_v4_'):version===3?key.startsWith('renewal_v3_')||key==='rate_recovery_v3_events'||key==='new45_checkpoints':version===2?key.startsWith('renewal_v2_')||key==='rate_recovery_events':key.startsWith('renewal_'))));
 return createHash('sha256').update(JSON.stringify({budget:prior,reservations:database.prepare('SELECT * FROM evaluation_reservations ORDER BY rowid').all()})).digest('hex');
}
/** Durable isolated SQLite ledger. BEGIN IMMEDIATE serializes independent process reservations.
 * @param {{database:LedgerDatabase,budgetId:string,policy:EvaluationBudgetPolicy,now:()=>number,logger:(entry:{event:string,failureKind?:string,persistence?:SQLiteFailure})=>void,accountingMode?:EvaluationAccountingMode,ownerDecision?:EvaluationOwnerDecision,validateStore?:()=>void,executionAuthority?:EvaluationExecutionAuthority,runtimePolicy?:import('./evaluation-runtime-control.mjs').RuntimePolicy}} dependencies */
export function createEvaluationLedger(dependencies){
 if(!record(dependencies)||types.isProxy(dependencies)||![Object.prototype,null].includes(Object.getPrototypeOf(dependencies))||Object.values(Object.getOwnPropertyDescriptors(dependencies)).some(d=>!('value' in d)))throw new TypeError('EvaluationLedgerCommandInvalid');
 const {database:db,budgetId,now,logger}=dependencies??{};
 const policySnapshot=primitiveSnapshot(dependencies?.policy);
 if(!policySnapshot.ok)throw new TypeError('EvaluationLedgerCommandInvalid');
 const policy=/** @type {EvaluationBudgetPolicy} */(policySnapshot.value);
 /** Every ledger JSON projection is immutable primitive data before serialization.
  * @param {unknown} value @returns {string} */
 function persistedJson(value){const snapshot=primitiveSnapshot(value);if(!snapshot.ok)throw new EvaluationTransportFailure({kind:'EvaluationUsageInvalid',field:'persistence'});return JSON.stringify(snapshot.value);}
 const accountingMode=dependencies.accountingMode??'configured';
 if(!['configured','estimated'].includes(accountingMode))throw new TypeError('EvaluationAccountingModeInvalid');
 const decisionSnapshot=primitiveSnapshot(dependencies.ownerDecision);
 if(accountingMode==='estimated'&&(!decisionSnapshot.ok||!isEstimatedOwnerDecision(decisionSnapshot.value)))throw new TypeError('EvaluationAccountingDecisionInvalid');
 if(accountingMode==='estimated'&&(budgetId!=='owner-approved-image-benchmark'||!record(policy)||policy.maximumCostNanodollars!==1000000000))throw new TypeError('EvaluationAccountingContractInvalid');
 const authoritySnapshot=primitiveSnapshot(dependencies.executionAuthority);
 if(dependencies.executionAuthority!==undefined&&(!authoritySnapshot.ok||!isEvaluationExecutionAuthority(authoritySnapshot.value)))throw new EvaluationTransportFailure({kind:'EvaluationExecutionAuthorityInvalid'});
 const executionAuthority=/** @type {EvaluationExecutionAuthority|undefined} */(authoritySnapshot.ok?authoritySnapshot.value:undefined);
 if(accountingMode==='estimated'&&decisionSnapshot.ok&&record(decisionSnapshot.value)&&decisionSnapshot.value.decision==='TreatUSD5asestimatedbudget withautomaticstopping;acceptpossibleoveragefromoneinflightrequest'&&dependencies.runtimePolicy===undefined)throw new TypeError('EvaluationAccountingDecisionInvalid');
 const ownerDecision=accountingMode==='estimated'?/** @type {EvaluationOwnerDecision} */(decisionSnapshot.ok?decisionSnapshot.value:undefined):undefined;
 if(!db||typeof db.exec!=='function'||typeof db.prepare!=='function'||!text(budgetId)||typeof now!=='function'||typeof logger!=='function'||!record(policy)||Object.keys(policy).sort().join(',')!=='maximumCostNanodollars,maximumInputTokens,maximumMilliseconds,maximumOutputTokens,maximumRequests'||!Object.values(policy).every(v=>count(v)&&v>0)||policy.maximumRequests>1200||policy.maximumInputTokens>3000000||policy.maximumOutputTokens>3000000||policy.maximumMilliseconds>10800000||policy.maximumCostNanodollars>5000000000)throw new TypeError('EvaluationLedgerCommandInvalid');
 /** @returns {number} */const instant=()=>{const n=now();if(!count(n))throw new TypeError('EvaluationClockInvalid');return n;};
 /** @template T @param {()=>T} operation @returns {T} */
 function atomic(operation){dependencies.validateStore?.();db.exec('BEGIN IMMEDIATE');try{const value=operation();db.exec('COMMIT');return value;}catch(error){if(db.isTransaction!==false)db.exec('ROLLBACK');throw error;}}
 if(dependencies.validateStore!==undefined&&typeof dependencies.validateStore!=='function')throw new TypeError('EvaluationStoreValidatorInvalid');
 dependencies.validateStore?.();
 // Wait only for SQLite locks; never redispatch or retry a provider request.
 db.exec('PRAGMA busy_timeout=1000');
 db.exec('CREATE TABLE IF NOT EXISTS evaluation_budgets (budget_id TEXT PRIMARY KEY, policy TEXT NOT NULL, started INTEGER NOT NULL, deadline INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, halted TEXT); CREATE TABLE IF NOT EXISTS evaluation_reservations (budget_id TEXT NOT NULL, key TEXT NOT NULL, allowance TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost INTEGER NOT NULL, response TEXT, PRIMARY KEY(budget_id,key));');
 db.exec("CREATE TRIGGER IF NOT EXISTS evaluation_grant_immutable BEFORE UPDATE OF budget_id,policy,started,deadline ON evaluation_budgets BEGIN SELECT RAISE(ABORT,'EvaluationGrantImmutable'); END; CREATE TRIGGER IF NOT EXISTS evaluation_grant_no_delete BEFORE DELETE ON evaluation_budgets BEGIN SELECT RAISE(ABORT,'EvaluationGrantImmutable'); END;");
 if(dependencies.runtimePolicy?.version===2&&!db.prepare('PRAGMA table_info(evaluation_reservations)').all().some(row=>record(row)&&row.name==='sanitized_envelope'))db.exec('ALTER TABLE evaluation_reservations ADD COLUMN sanitized_envelope TEXT');
 if(!db.prepare('PRAGMA table_info(evaluation_reservations)').all().some(row=>record(row)&&row.name==='known_usage'))db.exec('ALTER TABLE evaluation_reservations ADD COLUMN known_usage TEXT');
 if(!db.prepare('PRAGMA table_info(evaluation_reservations)').all().some(row=>record(row)&&row.name==='diagnostics'))db.exec('ALTER TABLE evaluation_reservations ADD COLUMN diagnostics TEXT');
 if(!db.prepare('PRAGMA table_info(evaluation_budgets)').all().some(row=>record(row)&&row.name==='continuations'))db.exec('ALTER TABLE evaluation_budgets ADD COLUMN continuations TEXT');
 if(!db.prepare('PRAGMA table_info(evaluation_reservations)').all().some(row=>record(row)&&row.name==='uncertainty_version'))atomic(()=>{db.exec('ALTER TABLE evaluation_reservations ADD COLUMN uncertainty_version INTEGER NOT NULL DEFAULT 0');db.prepare('UPDATE evaluation_reservations SET uncertainty_version=1 WHERE response IS NULL AND budget_id IN (SELECT budget_id FROM evaluation_budgets WHERE halted IS NOT NULL)').run();});
 /** @type {Set<Promise<Response>>} */const pendingAccounting=new Set();
 const runtime=dependencies.runtimePolicy===undefined?undefined:createRuntimeControl({database:db,policy:dependencies.runtimePolicy,now,serialized:true});
 const v4=executionAuthority?.renewal?.version===4;
 const v3=v4||executionAuthority?.renewal?.version===3;
 const v2=v3||executionAuthority?.renewal?.version===2;
 const recoveryLimit=v3?8:2,eventColumn=v3?'rate_recovery_v3_events':'rate_recovery_events';
 const windowColumn=v4?'renewal_v4_window':v3?'renewal_v3_window':v2?'renewal_v2_window':executionAuthority?.renewal?'renewal_window':executionAuthority?.recovery?'recovery_window':'execution_window';
 const cancelColumn=windowColumn.replace('window','cancelled'),haltColumn=windowColumn.replace('window','halted');
 /** @returns {{kind:'admit'|'dispatch',key:string,cost?:number,uncertaintyVersion?:number,sourceKey?:string,baseKey?:string,attempt?:number}[]} */
 function recoveryEvents(){const b=db.prepare('SELECT * FROM evaluation_budgets WHERE budget_id=?').get(budgetId);if(!record(b))throw new TypeError('EvaluationLedgerStateInvalid');const events=b[eventColumn]==null?[]:JSON.parse(String(b[eventColumn]));if(!Array.isArray(events)||events.some(e=>!record(e)||!text(e.key)||(e.kind==='admit'?!count(e.cost)||!count(e.uncertaintyVersion):e.kind!=='dispatch'||!text(e.sourceKey)||!text(e.baseKey)||!Number.isInteger(e.attempt)||Number(e.attempt)<1||Number(e.attempt)>recoveryLimit)))throw new TypeError('EvaluationRecoveryStateInvalid');return events;}
 const ceilings=Object.freeze({...policy,...(runtime?{maximumCostNanodollars:runtime.policy.maximumCostNanodollars,maximumRequests:runtime.policy.requestExtension?.maximumRequests??policy.maximumRequests,maximumInputTokens:runtime.policy.inputTokenExtension?.maximumInputTokens??policy.maximumInputTokens,maximumOutputTokens:runtime.policy.outputTokenExtension?.maximumOutputTokens??policy.maximumOutputTokens}:{})});
 const serialized=persistedJson(policy);
 atomic(()=>{const total=db.prepare('SELECT COUNT(*) count FROM evaluation_budgets').get();if(!record(total)||!count(total.count)||total.count>1)throw new TypeError('EvaluationLedgerGrantConflict');const existing=db.prepare('SELECT * FROM evaluation_budgets WHERE budget_id=?').get(budgetId);if(existing){if(!record(existing)||existing.policy!==serialized)throw new TypeError('EvaluationLedgerPolicyConflict');}else{const other=db.prepare('SELECT budget_id FROM evaluation_budgets LIMIT 1').get();if(other)throw new TypeError('EvaluationLedgerGrantConflict');const started=instant();db.prepare('INSERT INTO evaluation_budgets(budget_id,policy,started,deadline) VALUES(?,?,?,?)').run(budgetId,serialized,started,started+ceilings.maximumMilliseconds);}});
 /** @returns {{startedAtMs:number,deadlineAtMs:number,cancelled:boolean,halted:string|null,requests:number,inputTokens:number,outputTokens:number,costNanodollars:number,unresolvedRequests:number,activeRequests:number,admissionHalted:string|null,remainingRecoveryAttempts?:number|null,continuationHistory:EvaluationContinuationDecision[],executionWindow?:EvaluationExecutionWindow,effectiveDeadlineAtMs?:number,effectiveCancelled?:boolean,runtimeStartedAtMs?:number|null,runtimeDeadlineAtMs?:number|null}} */
 function state(){
 if(runtime){
 const r=runtime.snapshot(),row=/** @type {{started:number,deadline:number,cancelled:number,halted:string|null}} */(db.prepare('SELECT * FROM evaluation_budgets WHERE budget_id=?').get(budgetId));
 const rows=/** @type {{key:string,cost:number,uncertainty_version:number,response:string|null,input_tokens:number,output_tokens:number}[]} */(db.prepare('SELECT * FROM evaluation_reservations WHERE budget_id=?').all(budgetId));
 const admitted=[...r.policy.priorUnknowns.map(u=>({key:u.key,cost:u.estimatedDebitNanodollars,uncertaintyVersion:u.uncertaintyVersion})),...r.admissions];
 return {runtimeStartedAtMs:r.startedAtMs,runtimeDeadlineAtMs:r.deadlineAtMs,startedAtMs:row.started,deadlineAtMs:row.deadline,cancelled:row.cancelled===1,halted:row.halted,requests:rows.length,inputTokens:rows.reduce((n,v)=>n+v.input_tokens,0),outputTokens:rows.reduce((n,v)=>n+v.output_tokens,0),costNanodollars:rows.reduce((n,v)=>n+v.cost,0)+(r.policy.lineage?.diagnosticDebitNanodollars??0),unresolvedRequests:rows.filter(v=>v.response===null).length,activeRequests:rows.filter(v=>v.response===null&&!admitted.some(a=>a.key===v.key&&a.cost===v.cost&&a.uncertaintyVersion===v.uncertainty_version)).length,admissionHalted:r.halted,remainingRecoveryAttempts:r.remainingRecoveryAttempts,effectiveDeadlineAtMs:r.windows.at(-1)?.deadlineAtMs??0,effectiveCancelled:r.cancelled,continuationHistory:[]};
 }
 for(const row of db.prepare('SELECT allowance FROM evaluation_reservations').all()){if(!record(row))throw new TypeError('EvaluationLedgerStateInvalid');const a=JSON.parse(String(row.allowance));if((a.accountingMode??'configured')!==accountingMode||(accountingMode==='estimated'&&persistedJson(a.ownerDecision)!==persistedJson(ownerDecision)))throw new TypeError('EvaluationAccountingModeConflict');}
 const row=db.prepare('SELECT * FROM evaluation_budgets WHERE budget_id=?').get(budgetId),s=db.prepare('SELECT COUNT(*) requests,COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(output_tokens),0) outputTokens,COALESCE(SUM(cost),0) costNanodollars FROM evaluation_reservations WHERE budget_id=?').get(budgetId);
 if(!record(row)||row.policy!==serialized||!record(s)||(row.halted!==null&&!text(row.halted))||!count(row.started)||!count(row.deadline)||![0,1].includes(Number(row.cancelled))||![s.requests,s.inputTokens,s.outputTokens,s.costNanodollars].every(count))throw new TypeError('EvaluationLedgerStateInvalid');
 /** @type {unknown} */const history=row.continuations===null?[]:JSON.parse(String(row.continuations));
 if(!Array.isArray(history)||!history.every(isEvaluationContinuationDecision))throw new TypeError('EvaluationLedgerStateInvalid');
 const recovery=executionAuthority?.recovery;
 if(recovery){
  if(typeof row.execution_window!=='string'||createHash('sha256').update(persistedJson({window:JSON.parse(row.execution_window),cancelled:row.execution_cancelled,halted:row.execution_halted})).digest('hex')!==recovery.previousWindowSha256)throw new EvaluationTransportFailure({kind:'EvaluationExecutionAuthorityConflict',field:'previous terminal window'});
  if(executionAuthority?.renewal){
   const renewal=executionAuthority.renewal;
   if(typeof row[v4?'renewal_v3_window':v3?'renewal_v2_window':v2?'renewal_window':'recovery_window']!=='string'||createHash('sha256').update(persistedJson({window:JSON.parse(String(row[v4?'renewal_v3_window':v3?'renewal_v2_window':v2?'renewal_window':'recovery_window'])),cancelled:row[v4?'renewal_v3_cancelled':v3?'renewal_v2_cancelled':v2?'renewal_cancelled':'recovery_cancelled'],halted:row[v4?'renewal_v3_halted':v3?'renewal_v2_halted':v2?'renewal_halted':'recovery_halted']})).digest('hex')!==renewal.previousWindowSha256)throw new EvaluationTransportFailure({kind:'EvaluationExecutionAuthorityConflict',field:'renewal predecessor'});
   if(row[windowColumn]!=null){row.execution_window=row[windowColumn];row.execution_cancelled=row[cancelColumn];row.execution_halted=row[haltColumn];}
   else{row.execution_window=row.recovery_window;row.execution_cancelled=1;row.execution_halted=row.recovery_halted;}
  }else if(row.recovery_window!==undefined&&row.recovery_window!==null){row.execution_window=row.recovery_window;row.execution_cancelled=row.recovery_cancelled;row.execution_halted=row.recovery_halted;}
 }
 /** @type {EvaluationExecutionWindow|undefined} */let executionWindow;
 if(row.execution_window!==undefined&&row.execution_window!==null){if(!executionAuthority)throw new EvaluationTransportFailure({kind:'EvaluationExecutionAuthorityInvalid',field:'active execution window requires bound authority'});const w=JSON.parse(String(row.execution_window));if((row.execution_halted!==null&&!text(row.execution_halted))||!record(w)||!isEvaluationExecutionAuthority(w.authority)||!count(w.startedAtMs)||w.deadlineAtMs!==w.startedAtMs+1800000||![0,1].includes(Number(row.execution_cancelled)))throw new TypeError('EvaluationLedgerStateInvalid');executionWindow={authority:w.authority,startedAtMs:w.startedAtMs,deadlineAtMs:Number(w.deadlineAtMs),cancelled:row.execution_cancelled===1};if(executionAuthority&&!(recovery&&row.recovery_window==null)&&!(executionAuthority.renewal&&row[windowColumn]==null)&&persistedJson(executionAuthority)!==persistedJson(w.authority))throw new EvaluationTransportFailure({kind:'EvaluationExecutionAuthorityConflict'});}
 const continuation=accountingMode==='estimated'?history.at(-1):undefined;
 const unknowns=db.prepare('SELECT key,cost,uncertainty_version FROM evaluation_reservations WHERE response IS NULL').all();
 const admitted=(/** @type {unknown} */ u)=>record(u)&&((executionWindow?.authority??continuation)?.priorUnknowns.some(p=>p.key===u.key&&p.estimatedDebitNanodollars===u.cost&&p.uncertaintyVersion===u.uncertainty_version)||(v2&&[2,3,4].includes(executionWindow?.authority.renewal?.version??0)&&recoveryEvents().some(e=>e.kind==='admit'&&e.key===u.key&&e.cost===u.cost&&e.uncertaintyVersion===u.uncertainty_version)));
 const windowValid=executionWindow&&executionWindow.authority.budgetId===budgetId&&executionWindow.authority.originalStartedAtMs===row.started&&executionWindow.authority.originalDeadlineAtMs===row.deadline&&executionWindow.authority.originalCancelled===(row.cancelled===1)&&executionWindow.authority.haltKind===row.halted&&executionWindow.authority.priorUnknowns.every(p=>unknowns.some(u=>record(u)&&u.key===p.key&&admitted(u)))&&unknowns.every(u=>admitted(u)||(record(u)&&u.uncertainty_version===0));
 const valid=windowValid||(!executionWindow&&continuation&&continuation.originalStartedAtMs===row.started&&continuation.originalDeadlineAtMs===row.deadline&&continuation.haltKind===row.halted&&continuation.priorUnknowns.every(p=>unknowns.some(u=>record(u)&&u.key===p.key&&admitted(u)))&&unknowns.every(u=>admitted(u)||(record(u)&&u.uncertainty_version===0)));
 const activeRequests=unknowns.filter(u=>!valid||!admitted(u)).length;
 return {...(v2?{remainingRecoveryAttempts:recoveryLimit-recoveryEvents().filter(e=>e.kind==='dispatch').length}:{}),...(executionWindow?{executionWindow,effectiveDeadlineAtMs:executionWindow.deadlineAtMs,effectiveCancelled:executionWindow.cancelled}:{}),admissionHalted:typeof row.execution_halted==='string'?row.execution_halted:row.halted!==null&&!valid?String(row.halted):null,activeRequests,continuationHistory:history,startedAtMs:row.started,deadlineAtMs:row.deadline,cancelled:row.cancelled===1,halted:row.halted===null?null:String(row.halted),requests:Number(s.requests),inputTokens:Number(s.inputTokens),outputTokens:Number(s.outputTokens),costNanodollars:Number(s.costNanodollars),unresolvedRequests:Number(/** @type {Record<string,unknown>} */(db.prepare('SELECT COUNT(*) count FROM evaluation_reservations WHERE response IS NULL').get()).count)};
 }
 state();
 /** @template T @param {()=>Result<T>} operation @returns {Result<T>} */
 function guarded(operation){logger({event:'evaluation-ledger-entry'});try{const result=atomic(operation);logger(result.ok?{event:'evaluation-ledger-success'}:{event:'evaluation-ledger-failure',failureKind:result.error.kind});return result;}catch(error){if(runtime&&error instanceof TypeError){const kind=/** @type {LedgerFailureKind[]} */(['EvaluationCancelled','EvaluationAccountingHalted','EvaluationDeadlineExceeded','EvaluationRecoveryAttemptsExhausted','EvaluationRecoveryEvidenceInvalid','EvaluationRecoveryCooldown','EvaluationExecutionDebtConflict','EvaluationExecutionAuthorityConflict']).find(k=>k===error.message);if(kind){logger({event:'evaluation-ledger-failure',failureKind:kind});return failure(kind);}}if(!(error instanceof Error)||!record(error)||error.code!=='ERR_SQLITE_ERROR')throw error;const persistence={name:/^[A-Za-z]+$/.test(error.name)?error.name:'Error',code:'ERR_SQLITE_ERROR',errcode:typeof error.errcode==='number'&&Number.isSafeInteger(error.errcode)?error.errcode:null,cause:typeof error.errstr==='string'&&['database is locked','database table is locked','disk I/O error','database or disk is full','constraint failed','readonly database','SQL logic error','not an error'].includes(error.errstr)?error.errstr:null};logger({event:'evaluation-ledger-failure',failureKind:'EvaluationLedgerPersistenceFailed',persistence});return {ok:false,error:{kind:'EvaluationLedgerPersistenceFailed',field:'transaction',persistence}};}}
 /** @param {Record<string,unknown>} row @returns {{inputTokens:number,outputTokens:number,costNanodollars:number}} */
 function knownUsage(row){const known=row.known_usage===null?{}:JSON.parse(String(row.known_usage));if(!record(known)||Object.keys(known).some(k=>!['inputTokens','outputTokens','costNanodollars'].includes(k))||Object.values(known).some(v=>!count(v)))throw new TypeError('EvaluationLedgerStateInvalid');return {inputTokens:Number(known.inputTokens??0),outputTokens:Number(known.outputTokens??0),costNanodollars:Number(known.costNanodollars??0)};}
 /** Persist uncertainty and any independently known usage before allowing another call.
  * @param {{key:string,kind:LedgerFailureKind,inputTokens?:number,outputTokens?:number,costNanodollars?:number,diagnostics?:EvaluationResponseDiagnostics,recoverableTimeout?:true,recoverableExternal?:true,terminalPipeline?:true}} c @returns {Result<null>} */
 function uncertain(c){
  const trusted=c?.diagnostics!==undefined&&authenticatedDiagnostics.has(c.diagnostics);
  const snapshot=primitiveSnapshot(c);if(!snapshot.ok)return failure('EvaluationUsageInvalid');c=/** @type {typeof c} */(snapshot.value);
  if(!record(c)||!text(c.key)||!['EvaluationUsageInvalid','EvaluationServedProviderMismatch','EvaluationServedModelMismatch','EvaluationTransportUncertain','EvaluationProviderError','EvaluationResponseBodyTooLarge','EvaluationResponseReadFailed'].includes(c.kind)||(c.diagnostics!==undefined&&!responseDiagnostics(c.diagnostics))||[c.inputTokens,c.outputTokens,c.costNanodollars].some(v=>v!==undefined&&!count(v)))return failure('EvaluationUsageInvalid');
  return guarded(()=>{state();const row=db.prepare('SELECT * FROM evaluation_reservations WHERE budget_id=? AND key=?').get(budgetId,c.key);if(!record(row))return failure('EvaluationReservationMissing');if(runtime?.isPredecessor(c.key))return failure('EvaluationReservationUncertain','immutable predecessor');
   const repeated=(c.diagnostics!==undefined&&row.diagnostics===persistedJson(c.diagnostics)||runtime&&(c.recoverableTimeout===true||c.recoverableExternal===true||c.terminalPipeline===true)&&runtime.isAdmitted(c.key,Number(row.cost),Number(row.uncertainty_version)))&&Number(row.uncertainty_version)>0&&[c.inputTokens,c.outputTokens,c.costNanodollars].every(v=>v===undefined);
   if(repeated)return failure(c.kind);
   if(c.diagnostics!==undefined)db.prepare('UPDATE evaluation_reservations SET diagnostics=? WHERE budget_id=? AND key=?').run(persistedJson(c.diagnostics),budgetId,c.key);
   const previous=knownUsage(row),known={inputTokens:Math.max(previous.inputTokens,c.inputTokens??0),outputTokens:Math.max(previous.outputTokens,c.outputTokens??0),costNanodollars:Math.max(previous.costNanodollars,c.costNanodollars??0)};
   const previousFields=row.known_usage===null?{}:JSON.parse(String(row.known_usage));
   const observed=Object.fromEntries(['inputTokens','outputTokens','costNanodollars'].filter(k=>Object.hasOwn(previousFields,k)||c[/** @type {'inputTokens'|'outputTokens'|'costNanodollars'} */(k)]!==undefined).map(k=>[k,known[/** @type {'inputTokens'|'outputTokens'|'costNanodollars'} */(k)]]));
   db.prepare('UPDATE evaluation_reservations SET uncertainty_version=uncertainty_version+1,known_usage=? WHERE budget_id=? AND key=?').run(Object.keys(observed).length?persistedJson(observed):null,budgetId,c.key);
   db.prepare('UPDATE evaluation_reservations SET input_tokens=?,output_tokens=?,cost=? WHERE budget_id=? AND key=?').run(Math.max(Number(row.input_tokens),c.inputTokens??0),Math.max(Number(row.output_tokens),c.outputTokens??0),Math.max(Number(row.cost),c.costNanodollars??0),budgetId,c.key);
   const d=c.diagnostics,p=d?.providerFailure;
   if(runtime){
    if(runtime.policy.maximumAdditionalRecoveries===null&&c.terminalPipeline===true&&['EvaluationProviderError','EvaluationResponseReadFailed'].includes(c.kind)&&d?.httpStatus===400&&p?.authenticated){runtime.admit(c.key,'pipeline-failed',instant());return failure(c.kind);}
    if(runtime.policy.maximumAdditionalRecoveries===null&&c.recoverableExternal===true&&['EvaluationProviderError','EvaluationTransportUncertain','EvaluationResponseReadFailed','EvaluationUsageInvalid'].includes(c.kind)){const a=JSON.parse(String(row.allowance));const due=runtime.policy.renewal?runtime.outcome(a.model,d?.httpStatus===429?'429':'external',p?.retryAfter.retryAtMs??0):Math.max(instant(),p?.retryAfter.retryAtMs??0);runtime.admit(c.key,'external',due);return failure(c.kind);}
    if(c.recoverableTimeout===true&&c.kind==='EvaluationTransportUncertain'){if(runtime.policy.version!==2)runtime.activate();const a=JSON.parse(String(row.allowance));const due=runtime.policy.renewal?runtime.outcome(a.model,'timeout',0):instant();runtime.admit(c.key,'timeout',due);return failure(c.kind);}
    if(trusted&&c.kind==='EvaluationProviderError'&&d&&[429,502,503].includes(d.httpStatus)&&d.errorCode===d.httpStatus&&d.bodyKind==='json'&&d.errorEnvelope&&!d.generationId&&p?.authenticated&&p.noExecutionEvidence){if(runtime.policy.version!==2)runtime.activate();const type=/** @type {'429'|'502'|'503'} */(String(d.httpStatus));const a=JSON.parse(String(row.allowance)),r=runtime.snapshot(),retryAtMs=runtime.policy.renewal?runtime.outcome(a.model,type,p.retryAfter.retryAtMs??0):p.retryAfter.retryAtMs??instant()+Math.min(60000,1000*2**r.dispatches.length);runtime.admit(c.key,type,retryAtMs);return failure(c.kind);}
    runtime.halt(c.kind);return failure(c.kind);
   }
   if(v2&&trusted&&c.kind==='EvaluationProviderError'&&d?.httpStatus===429&&d.errorCode===429&&d.bodyKind==='json'&&d.errorEnvelope&&!d.generationId&&p?.authenticated&&p.noExecutionEvidence&&p.retryAfter.source!=='invalid'&&(p.errorType==='unknown'||p.errorType==='rate_limit_exceeded')&&row.response===null){
    const events=recoveryEvents();events.push({kind:'admit',key:c.key,cost:Math.max(Number(row.cost),c.costNanodollars??0),uncertaintyVersion:Number(row.uncertainty_version)+1});db.prepare(`UPDATE evaluation_budgets SET ${eventColumn}=? WHERE budget_id=?`).run(persistedJson(events),budgetId);return failure(c.kind);
   }
   db.prepare('UPDATE evaluation_budgets SET halted=COALESCE(halted,?) WHERE budget_id=?').run(c.kind,budgetId);const current=state();if(current.executionWindow)db.prepare(`UPDATE evaluation_budgets SET ${haltColumn}=COALESCE(${haltColumn},?) WHERE budget_id=?`).run(c.kind,budgetId);return failure(c.kind);
  });
 }
 return Object.freeze({
 /** Durable sanitized response BEFORE accounting/consumer JSON parsing. No headers or reasoning prose.
  * @param {{key:string,envelope:EvaluationSanitizedEnvelope}} c @returns {Result<null>} */
 persistEnvelope(c){
  const copied=primitiveSnapshot(c);if(!copied.ok)return failure('EvaluationUsageInvalid','envelope');c=/** @type {typeof c} */(copied.value);
  const e=c?.envelope;
  if(!text(c?.key)||!record(e)||!providerReceipt(Object.fromEntries(Object.entries(e).filter(([k])=>!['provider','accounting'].includes(k))))||(e.provider!==undefined&&!text(e.provider))||(e.accounting!==undefined&&(!record(e.accounting)||!['ESTIMATED_FROM_USAGE_TOKENS','CONSERVATIVE_RESERVATION_BASED_ESTIMATE'].includes(String(e.accounting.label))||!text(e.accounting.catalogSha256)||!count(e.accounting.costNanodollars))))return failure('EvaluationUsageInvalid','envelope');
  return guarded(()=>{if(!db.prepare('PRAGMA table_info(evaluation_reservations)').all().some(row=>record(row)&&row.name==='sanitized_envelope'))db.exec('ALTER TABLE evaluation_reservations ADD COLUMN sanitized_envelope TEXT');const row=db.prepare('SELECT * FROM evaluation_reservations WHERE budget_id=? AND key=?').get(budgetId,c.key);if(!record(row))return failure('EvaluationReservationMissing');if(runtime?.isPredecessor(c.key))return failure('EvaluationReservationUncertain','immutable predecessor');const value=persistedJson(e);if(row.sanitized_envelope!==null&&row.sanitized_envelope!==value)return failure('EvaluationReservationConflict','envelope');db.prepare('UPDATE evaluation_reservations SET sanitized_envelope=? WHERE budget_id=? AND key=?').run(value,budgetId,c.key);return {ok:true,value:null};});
 },
 policy:ceilings,originalPolicy:Object.freeze({...policy}),accountingMode,ownerDecision,uncertain,
 runtimePolicy:runtime?.policy,
 /** Receipt selection does not consume recovery or reserve again. @param {string} baseKey @returns {Result<Record<string,unknown>|null>} */
 replayResponse(baseKey){if(!text(baseKey))return failure('EvaluationReservationInvalid');return guarded(()=>{state();const key=runtime?runtime.receiptKey(baseKey):v2?recoveryEvents().filter(e=>e.kind==='dispatch'&&e.baseKey===baseKey).at(-1)?.key??baseKey:baseKey;const row=db.prepare('SELECT * FROM evaluation_reservations WHERE budget_id=? AND key=?').get(budgetId,key);if(!record(row)||row.response===null)return {ok:true,value:null};const response=JSON.parse(String(row.sanitized_envelope??row.response));if(!record(response))throw new TypeError('EvaluationReplayInvalid');return {ok:true,value:response};});},
 /** @param {string} model @returns {Result<{retryAtMs:number,cooldown:boolean}>} */
 pacingDue(model){if(!text(model))return failure('EvaluationReservationInvalid');return guarded(()=>({ok:true,value:runtime?.policy.renewal?runtime.pacingDue(model):{retryAtMs:instant(),cooldown:false}}));},
 activateRuntimeWindow(){return guarded(()=>{if(!runtime)return failure('EvaluationExecutionAuthorityInvalid');return {ok:true,value:runtime.activate()};});},
 /** Persist terminal operational faults in the approved v2 window without altering receipts.
  * @param {LedgerFailureKind} kind @returns {Result<null>} */
 haltExecution(kind){if(!['EvaluationLedgerPersistenceFailed','EvaluationProviderError','EvaluationBudgetExceeded','EvaluationRecoveryAttemptsExhausted','EvaluationRecoveryEvidenceInvalid','EvaluationResponseBodyTooLarge','EvaluationResponseReadFailed','EvaluationUsageInvalid','EvaluationServedProviderMismatch','EvaluationServedModelMismatch','EvaluationTransportUncertain'].includes(kind))return failure('EvaluationRecoveryEvidenceInvalid');return guarded(()=>{if(runtime){runtime.halt(kind);return {ok:true,value:null};}const s=state();if(v2&&[2,3,4].includes(s.executionWindow?.authority.renewal?.version??0))db.prepare(`UPDATE evaluation_budgets SET ${haltColumn}=COALESCE(${haltColumn},?) WHERE budget_id=?`).run(kind,budgetId);return {ok:true,value:null};});},
 /** Find latest authenticated failed attempt; immutable recorded evidence survives process restart.
  * @param {string} baseKey @returns {Result<{failedKey:string,nextKey:string,retryAtMs:number,attempt:number,costNanodollars:number,uncertaintyVersion:number}|null>} */
 recoveryCandidate(baseKey){if(!text(baseKey))return failure('EvaluationReservationInvalid');return guarded(()=>{
  if(runtime){const candidate=runtime.candidate(baseKey);if(!candidate)return {ok:true,value:null};const row=db.prepare('SELECT cost,uncertainty_version,response FROM evaluation_reservations WHERE budget_id=? AND key=?').get(budgetId,candidate.failedKey);if(!record(row)||row.response!==null||!count(row.cost)||!count(row.uncertainty_version)||!runtime.isAdmitted(candidate.failedKey,row.cost,row.uncertainty_version))return failure('EvaluationRecoveryEvidenceInvalid');return {ok:true,value:{...candidate,costNanodollars:row.cost,uncertaintyVersion:row.uncertainty_version}};}
  const s=state();if(!v2)return {ok:true,value:null};if(s.effectiveCancelled)return failure('EvaluationCancelled');if(s.admissionHalted)return failure('EvaluationAccountingHalted',s.admissionHalted);
  const events=recoveryEvents(),dispatches=events.filter(e=>e.kind==='dispatch'),last=dispatches.filter(e=>e.baseKey===baseKey).at(-1),key=last?.key??baseKey;
  const row=db.prepare('SELECT * FROM evaluation_reservations WHERE budget_id=? AND key=?').get(budgetId,key);if(!record(row)||row.response!==null||!events.some(e=>e.kind==='admit'&&e.key===key))return {ok:true,value:null};
  if(dispatches.length>=recoveryLimit){db.prepare(`UPDATE evaluation_budgets SET ${haltColumn}=COALESCE(${haltColumn},?) WHERE budget_id=?`).run('EvaluationRecoveryAttemptsExhausted',budgetId);return failure('EvaluationRecoveryAttemptsExhausted');}
  const d=JSON.parse(String(row.diagnostics));if(!responseDiagnostics(d)||!d.providerFailure)return failure('EvaluationRecoveryEvidenceInvalid');
  const attempt=dispatches.length+1,retryAtMs=d.providerFailure.retryAfter.retryAtMs??d.providerFailure.capturedAtMs+1000*2**(attempt-1);
  if(retryAtMs>=(s.effectiveDeadlineAtMs??s.deadlineAtMs)||instant()>=(s.effectiveDeadlineAtMs??s.deadlineAtMs))return failure('EvaluationDeadlineExceeded');
  return {ok:true,value:{failedKey:key,nextKey:baseKey+':recovery-'+attempt,retryAtMs,attempt,costNanodollars:Number(row.cost),uncertaintyVersion:Number(row.uncertainty_version)}};
 });},
 /** Explicit paid-launch boundary. Activation is immutable and restart cannot renew it.
  * @param {EvaluationExecutionAuthority} c @returns {Result<EvaluationExecutionWindow>} */
 activateExecutionWindow(c){
  const snapshot=primitiveSnapshot(c);if(!snapshot.ok)return failure('EvaluationExecutionAuthorityInvalid');c=/** @type {typeof c} */(snapshot.value);
  if(accountingMode!=='estimated'||!isEvaluationExecutionAuthority(c)||!executionAuthority)return failure('EvaluationExecutionAuthorityInvalid');
  if(persistedJson(c)!==persistedJson(executionAuthority))return failure('EvaluationExecutionAuthorityConflict');
  return guarded(()=>{const s=state();if(c.budgetId!==budgetId||c.originalStartedAtMs!==s.startedAtMs||c.originalDeadlineAtMs!==s.deadlineAtMs||c.originalCancelled!==s.cancelled||c.haltKind!==s.halted)return failure('EvaluationExecutionAuthorityConflict','original grant/history');
   if(c.recovery){
    const row=db.prepare('SELECT * FROM evaluation_budgets WHERE budget_id=?').get(budgetId);if(!record(row))throw new TypeError('EvaluationLedgerStateInvalid');
    if(v4){
     if(row.renewal_v4_window!=null){if(s.effectiveCancelled)return failure('EvaluationCancelled');if(instant()>=(s.effectiveDeadlineAtMs??0))return failure('EvaluationDeadlineExceeded');if(s.admissionHalted)return failure('EvaluationExecutionDebtConflict');if(!s.executionWindow)throw new TypeError('EvaluationLedgerStateInvalid');return {ok:true,value:s.executionWindow};}
     const unknowns=db.prepare('SELECT key,cost,uncertainty_version FROM evaluation_reservations WHERE response IS NULL').all();
     if(unknowns.length!==7||!unknowns.every(r=>record(r)&&c.priorUnknowns.some(u=>u.key===r.key&&u.estimatedDebitNanodollars===r.cost&&u.uncertaintyVersion===r.uncertainty_version)))return failure('EvaluationExecutionDebtConflict');
     const predecessor=typeof row.renewal_v3_window==='string'?JSON.parse(row.renewal_v3_window):undefined;
     if(!record(predecessor)||!isEvaluationExecutionAuthority(predecessor.authority)||predecessor.authority.renewal?.version!==3||!predecessor.authority.new45||predecessor.authority.originalGrantSha256!==c.originalGrantSha256)return failure('EvaluationExecutionAuthorityConflict','Qwen predecessor/grant');
     if(evaluationRenewalStateHash(db,4)!==c.renewal?.ledgerStateSha256||typeof row.renewal_v3_window!=='string'||row.renewal_v3_cancelled!==1||row.renewal_v3_halted!==null||row.rate_recovery_v3_events!=='[]'||row.new45_checkpoints!=='[]'||s.requests!==17||s.unresolvedRequests!==7||s.costNanodollars!==23870435)return failure('EvaluationExecutionAuthorityConflict','cancelled zero-dispatch Qwen predecessor');
     db.exec("ALTER TABLE evaluation_budgets ADD COLUMN renewal_v4_window TEXT; ALTER TABLE evaluation_budgets ADD COLUMN renewal_v4_cancelled INTEGER NOT NULL DEFAULT 0; ALTER TABLE evaluation_budgets ADD COLUMN renewal_v4_halted TEXT; CREATE TRIGGER evaluation_renewal_v4_window_immutable BEFORE UPDATE OF renewal_v4_window ON evaluation_budgets WHEN OLD.renewal_v4_window IS NOT NULL BEGIN SELECT RAISE(ABORT,'EvaluationRenewalWindowImmutable'); END; CREATE TRIGGER evaluation_renewal_v4_cancel_irreversible BEFORE UPDATE OF renewal_v4_cancelled ON evaluation_budgets WHEN OLD.renewal_v4_cancelled=1 AND NEW.renewal_v4_cancelled<>1 BEGIN SELECT RAISE(ABORT,'EvaluationRenewalCancellationImmutable'); END; CREATE TRIGGER evaluation_renewal_v4_halt_immutable BEFORE UPDATE OF renewal_v4_halted ON evaluation_budgets WHEN OLD.renewal_v4_halted IS NOT NULL AND NEW.renewal_v4_halted IS NOT OLD.renewal_v4_halted BEGIN SELECT RAISE(ABORT,'EvaluationRenewalHaltImmutable'); END;");
     const startedAtMs=instant(),window={authority:structuredClone(c),startedAtMs,deadlineAtMs:startedAtMs+1800000};db.prepare('UPDATE evaluation_budgets SET renewal_v4_window=? WHERE budget_id=?').run(persistedJson(window),budgetId);return {ok:true,value:{...window,cancelled:false}};
    }
    if(v3){
     if(row.renewal_v3_window!=null){if(s.effectiveCancelled)return failure('EvaluationCancelled');if(instant()>=(s.effectiveDeadlineAtMs??0))return failure('EvaluationDeadlineExceeded');if(s.admissionHalted)return failure('EvaluationExecutionDebtConflict');if(!s.executionWindow)throw new TypeError('EvaluationLedgerStateInvalid');return {ok:true,value:s.executionWindow};}
     const unknowns=db.prepare('SELECT key,cost,uncertainty_version FROM evaluation_reservations WHERE response IS NULL').all();
     if(unknowns.length!==7||!unknowns.every(r=>record(r)&&c.priorUnknowns.some(u=>u.key===r.key&&u.estimatedDebitNanodollars===r.cost&&u.uncertaintyVersion===r.uncertainty_version)))return failure('EvaluationExecutionDebtConflict');
     const old=JSON.parse(String(row.rate_recovery_events));
     if(evaluationRenewalStateHash(db,3)!==c.renewal?.ledgerStateSha256||typeof row.renewal_v2_window!=='string'||instant()<JSON.parse(row.renewal_v2_window).deadlineAtMs||!Array.isArray(old)||old.filter(e=>e.kind==='dispatch').length!==2)return failure('EvaluationExecutionAuthorityConflict','new45 predecessor/old exhausted allowance');
     db.exec("ALTER TABLE evaluation_budgets ADD COLUMN renewal_v3_window TEXT; ALTER TABLE evaluation_budgets ADD COLUMN renewal_v3_cancelled INTEGER NOT NULL DEFAULT 0; ALTER TABLE evaluation_budgets ADD COLUMN renewal_v3_halted TEXT; ALTER TABLE evaluation_budgets ADD COLUMN rate_recovery_v3_events TEXT; ALTER TABLE evaluation_budgets ADD COLUMN new45_checkpoints TEXT; CREATE TRIGGER evaluation_renewal_v3_window_immutable BEFORE UPDATE OF renewal_v3_window ON evaluation_budgets WHEN OLD.renewal_v3_window IS NOT NULL BEGIN SELECT RAISE(ABORT,'EvaluationRenewalWindowImmutable'); END; CREATE TRIGGER evaluation_renewal_v3_cancel_irreversible BEFORE UPDATE OF renewal_v3_cancelled ON evaluation_budgets WHEN OLD.renewal_v3_cancelled=1 AND NEW.renewal_v3_cancelled<>1 BEGIN SELECT RAISE(ABORT,'EvaluationRenewalCancellationImmutable'); END; CREATE TRIGGER evaluation_renewal_v3_halt_immutable BEFORE UPDATE OF renewal_v3_halted ON evaluation_budgets WHEN OLD.renewal_v3_halted IS NOT NULL AND NEW.renewal_v3_halted IS NOT OLD.renewal_v3_halted BEGIN SELECT RAISE(ABORT,'EvaluationRenewalHaltImmutable'); END;");
     const startedAtMs=instant(),window={authority:structuredClone(c),startedAtMs,deadlineAtMs:startedAtMs+1800000};db.prepare('UPDATE evaluation_budgets SET renewal_v3_window=?,rate_recovery_v3_events=?,new45_checkpoints=? WHERE budget_id=?').run(persistedJson(window),'[]','[]',budgetId);return {ok:true,value:{...window,cancelled:false}};
    }
    if(v2){
     if(row.renewal_v2_window!=null){if(s.effectiveCancelled)return failure('EvaluationCancelled');if(instant()>=(s.effectiveDeadlineAtMs??0))return failure('EvaluationDeadlineExceeded');if(s.admissionHalted)return failure('EvaluationExecutionDebtConflict');if(!s.executionWindow)throw new TypeError('EvaluationLedgerStateInvalid');return {ok:true,value:s.executionWindow};}
     const unknowns=db.prepare('SELECT key,cost,uncertainty_version FROM evaluation_reservations WHERE response IS NULL').all();
     if(unknowns.length!==4||!unknowns.every(r=>record(r)&&c.priorUnknowns.some(u=>u.key===r.key&&u.estimatedDebitNanodollars===r.cost&&u.uncertaintyVersion===r.uncertainty_version)))return failure('EvaluationExecutionDebtConflict');
     if(evaluationRenewalStateHash(db,2)!==c.renewal?.ledgerStateSha256||typeof row.renewal_window!=='string'||instant()<JSON.parse(row.renewal_window).deadlineAtMs||row.renewal_halted!=='EvaluationProviderError')return failure('EvaluationExecutionAuthorityConflict','v2 predecessor');
     const events=JSON.parse(String(row.recovery_checkpoints));if(!Array.isArray(events)||events.filter(e=>e.scope==='diagnostic'&&!e.row).length!==1)return failure('EvaluationExecutionAuthorityConflict','global consumed diagnostic');
     db.exec("ALTER TABLE evaluation_budgets ADD COLUMN renewal_v2_window TEXT; ALTER TABLE evaluation_budgets ADD COLUMN renewal_v2_cancelled INTEGER NOT NULL DEFAULT 0; ALTER TABLE evaluation_budgets ADD COLUMN renewal_v2_halted TEXT; ALTER TABLE evaluation_budgets ADD COLUMN rate_recovery_events TEXT; CREATE TRIGGER evaluation_renewal_v2_window_immutable BEFORE UPDATE OF renewal_v2_window ON evaluation_budgets WHEN OLD.renewal_v2_window IS NOT NULL BEGIN SELECT RAISE(ABORT,'EvaluationRenewalWindowImmutable'); END; CREATE TRIGGER evaluation_renewal_v2_cancel_irreversible BEFORE UPDATE OF renewal_v2_cancelled ON evaluation_budgets WHEN OLD.renewal_v2_cancelled=1 AND NEW.renewal_v2_cancelled<>1 BEGIN SELECT RAISE(ABORT,'EvaluationRenewalCancellationImmutable'); END; CREATE TRIGGER evaluation_renewal_v2_halt_immutable BEFORE UPDATE OF renewal_v2_halted ON evaluation_budgets WHEN OLD.renewal_v2_halted IS NOT NULL AND NEW.renewal_v2_halted IS NOT OLD.renewal_v2_halted BEGIN SELECT RAISE(ABORT,'EvaluationRenewalHaltImmutable'); END;");
     const startedAtMs=instant(),window={authority:structuredClone(c),startedAtMs,deadlineAtMs:startedAtMs+1800000};db.prepare('UPDATE evaluation_budgets SET renewal_v2_window=?,rate_recovery_events=? WHERE budget_id=?').run(persistedJson(window),'[]',budgetId);return {ok:true,value:{...window,cancelled:false}};
    }
    const unknowns=db.prepare('SELECT key,cost,uncertainty_version FROM evaluation_reservations WHERE response IS NULL').all();
    if(unknowns.length!==3||!unknowns.every(r=>record(r)&&c.priorUnknowns.some(u=>u.key===r.key&&u.estimatedDebitNanodollars===r.cost&&u.uncertaintyVersion===r.uncertainty_version&&u.uncertaintyVersion>0)))return failure(row.recovery_window?'EvaluationExecutionDebtConflict':'EvaluationExecutionAuthorityConflict','exact three prior unknowns');
    if(c.renewal){
     if(row.renewal_window!=null){if(s.effectiveCancelled)return failure('EvaluationCancelled');if(instant()>=(s.effectiveDeadlineAtMs??0))return failure('EvaluationDeadlineExceeded');if(s.admissionHalted)return failure('EvaluationExecutionDebtConflict');if(!s.executionWindow)throw new TypeError('EvaluationLedgerStateInvalid');return {ok:true,value:s.executionWindow};}
     if(evaluationRenewalStateHash(db)!==c.renewal.ledgerStateSha256)return failure('EvaluationExecutionAuthorityConflict','renewal canonical state');
     const predecessor=JSON.parse(String(row.recovery_window));
     if(instant()<predecessor.deadlineAtMs||row.recovery_halted!==null)return failure('EvaluationExecutionAuthorityConflict','predecessor not cleanly expired');
     const events=JSON.parse(String(row.recovery_checkpoints));
     if(!Array.isArray(events)||events.filter(e=>e.scope==='diagnostic'&&!e.row).length!==1||events.some(e=>e.scope!=='diagnostic'||e.attempt!==1)||!events.some(e=>e.row))return failure('EvaluationExecutionAuthorityConflict','consumed diagnostics');
     db.exec("ALTER TABLE evaluation_budgets ADD COLUMN renewal_window TEXT; ALTER TABLE evaluation_budgets ADD COLUMN renewal_cancelled INTEGER NOT NULL DEFAULT 0; ALTER TABLE evaluation_budgets ADD COLUMN renewal_halted TEXT; CREATE TRIGGER evaluation_renewal_window_immutable BEFORE UPDATE OF renewal_window ON evaluation_budgets WHEN OLD.renewal_window IS NOT NULL BEGIN SELECT RAISE(ABORT,'EvaluationRenewalWindowImmutable'); END; CREATE TRIGGER evaluation_renewal_cancel_irreversible BEFORE UPDATE OF renewal_cancelled ON evaluation_budgets WHEN OLD.renewal_cancelled=1 AND NEW.renewal_cancelled<>1 BEGIN SELECT RAISE(ABORT,'EvaluationRenewalCancellationImmutable'); END; CREATE TRIGGER evaluation_renewal_halt_immutable BEFORE UPDATE OF renewal_halted ON evaluation_budgets WHEN OLD.renewal_halted IS NOT NULL AND NEW.renewal_halted IS NOT OLD.renewal_halted BEGIN SELECT RAISE(ABORT,'EvaluationRenewalHaltImmutable'); END;");
     const startedAtMs=instant(),window={authority:structuredClone(c),startedAtMs,deadlineAtMs:startedAtMs+1800000};db.prepare('UPDATE evaluation_budgets SET renewal_window=? WHERE budget_id=?').run(persistedJson(window),budgetId);return {ok:true,value:{...window,cancelled:false}};
    }
    if(row.recovery_window!=null){if(s.effectiveCancelled)return failure('EvaluationCancelled');if(instant()>=(s.effectiveDeadlineAtMs??0))return failure('EvaluationDeadlineExceeded');if(s.admissionHalted)return failure('EvaluationExecutionDebtConflict');if(!s.executionWindow)throw new TypeError('EvaluationLedgerStateInvalid');return {ok:true,value:s.executionWindow};}
    if(!db.prepare('PRAGMA table_info(evaluation_budgets)').all().some(r=>record(r)&&r.name==='recovery_window'))db.exec("ALTER TABLE evaluation_budgets ADD COLUMN recovery_window TEXT; ALTER TABLE evaluation_budgets ADD COLUMN recovery_cancelled INTEGER NOT NULL DEFAULT 0; ALTER TABLE evaluation_budgets ADD COLUMN recovery_halted TEXT; CREATE TRIGGER evaluation_recovery_window_immutable BEFORE UPDATE OF recovery_window ON evaluation_budgets WHEN OLD.recovery_window IS NOT NULL BEGIN SELECT RAISE(ABORT,'EvaluationRecoveryWindowImmutable'); END; CREATE TRIGGER evaluation_recovery_cancel_irreversible BEFORE UPDATE OF recovery_cancelled ON evaluation_budgets WHEN OLD.recovery_cancelled=1 AND NEW.recovery_cancelled<>1 BEGIN SELECT RAISE(ABORT,'EvaluationRecoveryCancellationImmutable'); END; CREATE TRIGGER evaluation_recovery_halt_immutable BEFORE UPDATE OF recovery_halted ON evaluation_budgets WHEN OLD.recovery_halted IS NOT NULL AND NEW.recovery_halted IS NOT OLD.recovery_halted BEGIN SELECT RAISE(ABORT,'EvaluationRecoveryHaltImmutable'); END;");
    const startedAtMs=instant(),window={authority:structuredClone(c),startedAtMs,deadlineAtMs:startedAtMs+1800000};db.prepare('UPDATE evaluation_budgets SET recovery_window=? WHERE budget_id=?').run(persistedJson(window),budgetId);return {ok:true,value:{...window,cancelled:false}};
   }
   const unknowns=db.prepare('SELECT key,cost,uncertainty_version FROM evaluation_reservations WHERE response IS NULL').all();
   if(unknowns.length!==c.priorUnknowns.length||!unknowns.every(r=>record(r)&&c.priorUnknowns.some(u=>u.key===r.key&&u.estimatedDebitNanodollars===r.cost&&u.uncertaintyVersion===r.uncertainty_version)))return failure(s.executionWindow?'EvaluationExecutionDebtConflict':'EvaluationExecutionAuthorityConflict','exact prior unknowns');
   if(s.executionWindow){if(s.executionWindow.cancelled)return failure('EvaluationCancelled');if(instant()>=s.executionWindow.deadlineAtMs)return failure('EvaluationDeadlineExceeded');if(s.admissionHalted)return failure('EvaluationExecutionDebtConflict',s.admissionHalted);return {ok:true,value:s.executionWindow};}
   if(!db.prepare('PRAGMA table_info(evaluation_budgets)').all().some(r=>record(r)&&r.name==='execution_window')){db.exec('ALTER TABLE evaluation_budgets ADD COLUMN execution_window TEXT; ALTER TABLE evaluation_budgets ADD COLUMN execution_cancelled INTEGER NOT NULL DEFAULT 0; ALTER TABLE evaluation_budgets ADD COLUMN execution_halted TEXT;');db.exec("CREATE TRIGGER evaluation_execution_window_immutable BEFORE UPDATE OF execution_window ON evaluation_budgets WHEN OLD.execution_window IS NOT NULL BEGIN SELECT RAISE(ABORT,'EvaluationExecutionWindowImmutable'); END; CREATE TRIGGER evaluation_execution_cancel_irreversible BEFORE UPDATE OF execution_cancelled ON evaluation_budgets WHEN OLD.execution_cancelled=1 AND NEW.execution_cancelled<>1 BEGIN SELECT RAISE(ABORT,'EvaluationExecutionCancellationImmutable'); END; CREATE TRIGGER evaluation_execution_halt_immutable BEFORE UPDATE OF execution_halted ON evaluation_budgets WHEN OLD.execution_halted IS NOT NULL AND NEW.execution_halted IS NOT OLD.execution_halted BEGIN SELECT RAISE(ABORT,'EvaluationExecutionHaltImmutable'); END;");}
   const startedAtMs=instant(),w={authority:structuredClone(c),startedAtMs,deadlineAtMs:startedAtMs+1800000};db.prepare('UPDATE evaluation_budgets SET execution_window=? WHERE budget_id=?').run(persistedJson(w),budgetId);return {ok:true,value:{...w,cancelled:false}};
  });
 },
 /** Owner-only composition operation; appends admission evidence, never settles debt or clears halt.
  * @param {EvaluationContinuationDecision} c @returns {Result<null>} */
 authorizeContinuation(c){
  const snapshot=primitiveSnapshot(c);if(!snapshot.ok)return failure('EvaluationContinuationInvalid');c=/** @type {typeof c} */(snapshot.value);
  if(accountingMode!=='estimated'||!isEvaluationContinuationDecision(c))return failure('EvaluationContinuationInvalid');
  return guarded(()=>{const s=state();if(s.cancelled)return failure('EvaluationCancelled');if(instant()>=s.deadlineAtMs)return failure('EvaluationDeadlineExceeded');
   if(s.continuationHistory.some(d=>d.decisionId===c.decisionId))return failure('EvaluationContinuationConflict','decisionId');
   const rows=db.prepare('SELECT key,cost,uncertainty_version FROM evaluation_reservations WHERE response IS NULL').all();
   if(!s.halted||c.haltKind!==s.halted||c.originalStartedAtMs!==s.startedAtMs||c.originalDeadlineAtMs!==s.deadlineAtMs||rows.length!==c.priorUnknowns.length||!rows.every(r=>record(r)&&c.priorUnknowns.some(u=>u.key===r.key&&u.estimatedDebitNanodollars===r.cost&&u.uncertaintyVersion===r.uncertainty_version)))return failure('EvaluationContinuationConflict','exact prior unknowns/debt/grant/halt');
   db.prepare('UPDATE evaluation_budgets SET continuations=? WHERE budget_id=?').run(persistedJson([...s.continuationHistory,structuredClone(c)]),budgetId);return {ok:true,value:null};
  });
 },
 /** @param {Promise<Response>} pending */trackAccounting(pending){if(!(pending instanceof Promise))throw new TypeError('EvaluationAccountingPromiseInvalid');pendingAccounting.add(pending);pending.then(()=>pendingAccounting.delete(pending),()=>pendingAccounting.delete(pending));return pending;},
 /** @param {()=>void} close */closeWhenSettled(close){if(typeof close!=='function')throw new TypeError('EvaluationAccountingCloseInvalid');if(!pendingAccounting.size){close();return;}Promise.allSettled([...pendingAccounting]).then(close);},
 /** @param {Reservation & {recoveryOf?:string,baseKey?:string,model?:string}} c @returns {Result<{response?:Record<string,unknown>,deadlineAtMs:number}>} */
 reserve(c){
 const snapshot=primitiveSnapshot(c);if(!snapshot.ok)return failure('EvaluationReservationInvalid');c=/** @type {typeof c} */(snapshot.value);
 if(!record(c)||Object.keys(c).filter(k=>!['recoveryOf','baseKey','model'].includes(k)).sort().join(',')!=='costNanodollars,inputTokens,key,outputTokens'||((c.recoveryOf===undefined)!==(c.baseKey===undefined))||(c.recoveryOf!==undefined&&(!text(c.recoveryOf)||!text(c.baseKey)))||!text(c.key)||runtime?.policy.renewal&&!text(c.model)||c.model!==undefined&&!text(c.model)||![c.inputTokens,c.outputTokens,c.costNanodollars].every(count))return failure('EvaluationReservationInvalid');
 return guarded(()=>{const s=state();if(s.effectiveCancelled??s.cancelled)return failure('EvaluationCancelled');if(s.admissionHalted)return failure('EvaluationAccountingHalted',s.admissionHalted);if(instant()>=(s.effectiveDeadlineAtMs??s.deadlineAtMs))return failure('EvaluationDeadlineExceeded');
 if(s.costNanodollars>=ceilings.maximumCostNanodollars)return failure('EvaluationBudgetExceeded','costNanodollars');
 const previous=db.prepare('SELECT * FROM evaluation_reservations WHERE budget_id=? AND key=?').get(budgetId,c.key),allowance=persistedJson({...c,...(accountingMode==='estimated'?{accountingMode,ownerDecision}:{})});
 if(previous){if(!record(previous)||previous.allowance!==allowance)return failure('EvaluationReservationConflict');if(previous.response===null)return failure('EvaluationReservationUncertain');const response=JSON.parse(String(previous.sanitized_envelope??previous.response));if(!record(response))throw new TypeError('EvaluationReplayInvalid');return {ok:true,value:{response,deadlineAtMs:(s.effectiveDeadlineAtMs??s.deadlineAtMs)}};}
 for(const [field,total,limit] of /** @type {[string,number,number][]} */([['requests',s.requests+1,ceilings.maximumRequests],['inputTokens',s.inputTokens+c.inputTokens,ceilings.maximumInputTokens],['outputTokens',s.outputTokens+c.outputTokens,ceilings.maximumOutputTokens],['costNanodollars',s.costNanodollars+c.costNanodollars,ceilings.maximumCostNanodollars]]))if(!Number.isSafeInteger(total)||total>limit)return failure('EvaluationBudgetExceeded',field);
 if(s.activeRequests)return failure('EvaluationLeaseUnresolved','unresolved global reservation; reconciliation required');
 if(runtime?.policy.renewal)runtime.dispatch(/** @type {string} */(c.model));
 if(c.recoveryOf!==undefined&&runtime){
  const candidate=runtime.candidate(/** @type {string} */(c.baseKey));if(!candidate||candidate.failedKey!==c.recoveryOf||candidate.nextKey!==c.key)return failure('EvaluationRecoveryEvidenceInvalid');
  runtime.consume(c.recoveryOf,/** @type {string} */(c.baseKey),c.key);
 }else if(c.recoveryOf!==undefined){
  if(!v2)return failure('EvaluationRecoveryEvidenceInvalid');const events=recoveryEvents(),used=events.filter(e=>e.kind==='dispatch').length;if(used>=recoveryLimit)return failure('EvaluationRecoveryAttemptsExhausted');
  const source=db.prepare('SELECT * FROM evaluation_reservations WHERE budget_id=? AND key=?').get(budgetId,c.recoveryOf);
  if(!record(source)||source.response!==null||!events.some(e=>e.kind==='admit'&&e.key===source.key)||events.some(e=>e.kind==='dispatch'&&e.sourceKey===source.key)||c.key!==c.baseKey+':recovery-'+(used+1))return failure('EvaluationRecoveryEvidenceInvalid');
  const a=JSON.parse(String(source.allowance)),d=JSON.parse(String(source.diagnostics));
  if(!responseDiagnostics(d)||!d.providerFailure||[c.inputTokens,c.outputTokens,c.costNanodollars].some((v,i)=>v!==a[['inputTokens','outputTokens','costNanodollars'][i]])||(a.baseKey??source.key)!==c.baseKey||instant()<(d.providerFailure.retryAfter.retryAtMs??d.providerFailure.capturedAtMs+1000*2**used))return failure('EvaluationRecoveryEvidenceInvalid');
  events.push({kind:'dispatch',key:c.key,sourceKey:c.recoveryOf,baseKey:c.baseKey,attempt:used+1});db.prepare(`UPDATE evaluation_budgets SET ${eventColumn}=? WHERE budget_id=?`).run(persistedJson(events),budgetId);
 }
 db.prepare('INSERT INTO evaluation_reservations(budget_id,key,allowance,input_tokens,output_tokens,cost) VALUES(?,?,?,?,?,?)').run(budgetId,c.key,allowance,c.inputTokens,c.outputTokens,c.costNanodollars);return {ok:true,value:/** @type {{response?:Record<string,unknown>,deadlineAtMs:number}} */({deadlineAtMs:(s.effectiveDeadlineAtMs??s.deadlineAtMs)})};});
 },
 /** @param {Reservation & {response:EvaluationProviderReceipt,diagnostics?:EvaluationResponseDiagnostics,accounting?:ReservationBasedAccounting}} c @returns {Result<null>} */
 complete(c){
 const snapshot=primitiveSnapshot(c);
 if(!snapshot.ok){
  if(!record(c)||types.isProxy(c))return failure('EvaluationUsageInvalid');
  const d=Object.getOwnPropertyDescriptors(c),key=d.key?.value;
  if(!text(key))return failure('EvaluationUsageInvalid');
  return uncertain({key,kind:'EvaluationUsageInvalid',...Object.fromEntries(['inputTokens','outputTokens','costNanodollars'].flatMap(k=>count(d[k]?.value)?[[k,d[k].value]]:[]))});
 }
 c=/** @type {typeof c} */(snapshot.value);
 if(!record(c)||Object.keys(c).filter(k=>!['diagnostics','accounting'].includes(k)).sort().join(',')!=='costNanodollars,inputTokens,key,outputTokens,response'||(c.diagnostics!==undefined&&!responseDiagnostics(c.diagnostics))||!text(c.key)||![c.inputTokens,c.outputTokens,c.costNanodollars].every(count)||!record(c.response)){if(record(c)&&text(c.key))return uncertain({key:c.key,kind:'EvaluationUsageInvalid'});return failure('EvaluationUsageInvalid');}
 if(!providerReceipt(c.response))return uncertain({key:c.key,kind:'EvaluationUsageInvalid',inputTokens:c.inputTokens,outputTokens:c.outputTokens,costNanodollars:c.costNanodollars,...(c.diagnostics===undefined?{}:{diagnostics:c.diagnostics})});
 return guarded(()=>{const s=state();const row=db.prepare('SELECT * FROM evaluation_reservations WHERE budget_id=? AND key=?').get(budgetId,c.key);
 if(!record(row))return failure('EvaluationReservationMissing');if(runtime?.isAdmitted(c.key,Number(row.cost),Number(row.uncertainty_version))&&(runtime.policy.version!==2||runtime.policy.priorUnknowns.some(u=>u.key===c.key))||s.executionWindow?.authority.priorUnknowns.some(u=>u.key===c.key)||s.continuationHistory.some(d=>d.priorUnknowns.some(u=>u.key===c.key)))return failure('EvaluationReservationUncertain','owner-admitted unknown cannot settle through completion');if(row.response!==null)return failure('EvaluationReservationAlreadyCompleted');const a=/** @type {Reservation} */(JSON.parse(String(row.allowance)));
 if(c.accounting){const e=c.accounting,u=c.response.usage;
 if(accountingMode!=='estimated'||e.label!=='CONSERVATIVE_RESERVATION_BASED_ESTIMATE'||e.usageStatus!=='UNKNOWN'||!text(e.source)||!text(e.catalogSha256)||e.providerReportedCostNanodollars!==null&&!count(e.providerReportedCostNanodollars)||e.providerReportedCostNanodollars!==(u?.cost===undefined?null:chargedNanodollars(u.cost))||![e.reservedInputTokens,e.reservedOutputTokens,e.reservedCostNanodollars,e.promptRateNanodollars,e.completionRateNanodollars].every(count)||e.reservedInputTokens!==a.inputTokens||e.reservedOutputTokens!==a.outputTokens||e.reservedCostNanodollars!==a.costNanodollars||e.actualInputTokens!== (u?.prompt_tokens??null)||e.actualOutputTokens!==(u?.completion_tokens??null)||e.actualInputTokens!==null&&e.actualOutputTokens!==null||c.inputTokens!==Math.max(a.inputTokens,e.actualInputTokens??0)||c.outputTokens!==Math.max(a.outputTokens,e.actualOutputTokens??0)||c.costNanodollars!==e.costNanodollars||c.costNanodollars<Math.max(a.costNanodollars,e.providerReportedCostNanodollars??0))return failure('EvaluationUsageInvalid','reservation-based accounting');
 }
 if(accountingMode==='configured'&&(c.inputTokens>a.inputTokens||c.outputTokens>a.outputTokens||c.costNanodollars>a.costNanodollars)){
 db.prepare('UPDATE evaluation_reservations SET input_tokens=?,output_tokens=?,cost=? WHERE budget_id=? AND key=?').run(Math.max(c.inputTokens,a.inputTokens,Number(row.input_tokens)),Math.max(c.outputTokens,a.outputTokens,Number(row.output_tokens)),Math.max(c.costNanodollars,a.costNanodollars,Number(row.cost)),budgetId,c.key);
 db.prepare('UPDATE evaluation_budgets SET halted=? WHERE budget_id=?').run('EvaluationUsageExceedsReservation',budgetId);
 return failure('EvaluationUsageExceedsReservation');
 }
 if(c.diagnostics!==undefined)db.prepare('UPDATE evaluation_reservations SET diagnostics=? WHERE budget_id=? AND key=?').run(persistedJson(c.diagnostics),budgetId,c.key);
 const known=knownUsage(row),conflict=accountingMode==='estimated'&&(c.inputTokens<known.inputTokens||c.outputTokens<known.outputTokens||c.costNanodollars<known.costNanodollars);
 if(conflict){db.prepare('UPDATE evaluation_reservations SET known_usage=? WHERE budget_id=? AND key=?').run(persistedJson({inputTokens:Math.max(c.inputTokens,known.inputTokens),outputTokens:Math.max(c.outputTokens,known.outputTokens),costNanodollars:Math.max(c.costNanodollars,known.costNanodollars)}),budgetId,c.key);db.prepare('UPDATE evaluation_reservations SET input_tokens=?,output_tokens=?,cost=? WHERE budget_id=? AND key=?').run(Math.max(c.inputTokens,known.inputTokens),Math.max(c.outputTokens,known.outputTokens),Math.max(c.costNanodollars,known.costNanodollars),budgetId,c.key);db.prepare('UPDATE evaluation_budgets SET halted=COALESCE(halted,?) WHERE budget_id=?').run('EvaluationBillingConflict',budgetId);return failure('EvaluationAccountingHalted','EvaluationBillingConflict');}
 const observed=c.accounting?{...(c.accounting.actualInputTokens===null?{}:{inputTokens:c.accounting.actualInputTokens}),...(c.accounting.actualOutputTokens===null?{}:{outputTokens:c.accounting.actualOutputTokens}),...(c.accounting.providerReportedCostNanodollars===null?{}:{costNanodollars:c.accounting.providerReportedCostNanodollars})}:{inputTokens:c.inputTokens,outputTokens:c.outputTokens,costNanodollars:c.costNanodollars};
 db.prepare('UPDATE evaluation_reservations SET known_usage=?,uncertainty_version=uncertainty_version+? WHERE budget_id=? AND key=?').run(Object.keys(observed).length?persistedJson(observed):null,c.accounting?1:0,budgetId,c.key);
 const stopped=(s.effectiveCancelled??s.cancelled)?'EvaluationCancelled':s.admissionHalted?'EvaluationAccountingHalted':instant()>=(runtime?.policy.version===2?(s.runtimeDeadlineAtMs??s.effectiveDeadlineAtMs??s.deadlineAtMs):(s.effectiveDeadlineAtMs??s.deadlineAtMs))?'EvaluationDeadlineExceeded':null;
 db.prepare('UPDATE evaluation_reservations SET input_tokens=?,output_tokens=?,cost=?,response=? WHERE budget_id=? AND key=? AND response IS NULL').run(stopped&&accountingMode==='configured'?Math.max(c.inputTokens,Number(row.input_tokens)):c.inputTokens,stopped&&accountingMode==='configured'?Math.max(c.outputTokens,Number(row.output_tokens)):c.outputTokens,stopped&&accountingMode==='configured'?Math.max(c.costNanodollars,Number(row.cost)):c.costNanodollars,stopped?null:persistedJson(c.response),budgetId,c.key);if(runtime?.policy.renewal&&!stopped&&c.response.error===undefined)runtime.outcome(/** @type {Reservation & {model:string}} */(a).model,null,0);return stopped?failure(stopped):{ok:true,value:null};});
 },
 /** @returns {Result<null>} */cancel(){return guarded(()=>{if(runtime){runtime.cancel();return {ok:true,value:null};}const s=state();if(executionAuthority?.renewal&&!s.executionWindow?.authority.renewal)return failure('EvaluationCancelled');db.prepare(s.executionWindow?`UPDATE evaluation_budgets SET ${cancelColumn}=1 WHERE budget_id=?`:'UPDATE evaluation_budgets SET cancelled=1 WHERE budget_id=?').run(budgetId);return {ok:true,value:null};});},
 /** @returns {Result<ReturnType<typeof state>>} */snapshot(){return guarded(()=>({ok:true,value:state()}));}
 });
}
/** @typedef {ReturnType<typeof createEvaluationLedger>} EvaluationLedger */
/** @typedef {{inputTokens:number,reference:string}} InputTokenBound */
/** Binding all-in billed ceiling, not a planning estimate. The trusted accountant must substantiate every fee and billed token (including reasoning/images).
 * @typedef {{costNanodollars:number,reference:string}} EvaluationBillingBound */
/** @typedef {(body:Record<string,unknown>,catalog:EvaluationCatalog,signal:AbortSignal)=>Promise<EvaluationBillingBound>} EvaluationBillingAccountant */
/** A named exception carries deterministic transport/ledger failures through the production adapter. */
export class EvaluationTransportFailure extends AgentExecutionBoundaryFailure {
 /** @param {{kind:string,field?:string,httpStatus?:number,errorCode?:number,finishReason?:'error'}} failure */
 constructor(failure){super(failure);this.name='EvaluationTransportFailure';}
}
// Only this deterministic predispatch check can brand an early window deferral.
const windowFitFailures=new WeakSet();
/** @param {unknown} error @returns {error is EvaluationTransportFailure} */
export function isEvaluationWindowFitFailure(error){return error instanceof EvaluationTransportFailure&&error.notStarted===true&&windowFitFailures.has(error);}
/** Use the already declared physical attempt duration; no latency estimate or grace.
 * @param {{effectiveDeadlineAtMs?:number,runtimeDeadlineAtMs?:number|null,deadlineAtMs:number,effectiveCancelled?:boolean,cancelled?:boolean,admissionHalted?:string|null}} usage
 * @param {number} requestTimeoutMs @param {number} at @param {number} [dueAtMs] */
export function requireEvaluationRequestWindow(usage,requestTimeoutMs,at,dueAtMs=at){
 const deadline=usage.effectiveDeadlineAtMs;
 if((usage.effectiveCancelled??usage.cancelled)||usage.admissionHalted){const error=new EvaluationTransportFailure({kind:(usage.effectiveCancelled??usage.cancelled)?'EvaluationCancelled':'EvaluationAccountingHalted'});error.notStarted=true;throw error;}
 if(!count(at)||!count(dueAtMs)||!count(requestTimeoutMs)||requestTimeoutMs===0||!count(deadline)||!count(usage.runtimeDeadlineAtMs)||/** @type {number} */(usage.runtimeDeadlineAtMs)< /** @type {number} */(deadline))throw new TypeError('EvaluationRequestWindowInvalid');
 if(at>=/** @type {number} */(deadline)){const error=new EvaluationTransportFailure({kind:'EvaluationDeadlineExceeded'});error.notStarted=true;throw error;}
 if(/** @type {number} */(deadline)-Math.max(at,dueAtMs)>=requestTimeoutMs)return;
 const error=new EvaluationTransportFailure({kind:'EvaluationDeadlineExceeded',field:'request-does-not-fit-window'});error.notStarted=true;windowFitFailures.add(error);throw error;
}
/** Scan raw JSON object keys before whole-document parsing can discard duplicates.
 * @param {string} raw */
function rejectDuplicateJsonKeys(raw){
 const tokens=raw.match(/"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)??[];
 let at=0;
 /** @returns {void} */function value(){
  const token=tokens[at++];
  if(token==='{'){
   const keys=new Set();if(tokens[at]==='}'){at++;return;}
   do{const key=tokens[at++];if(!key?.startsWith('"')||tokens[at++]!==':')throw new SyntaxError('EvaluationJsonInvalid');
    const decoded=JSON.parse(key);if(keys.has(decoded))throw new SyntaxError('EvaluationJsonDuplicateKey');keys.add(decoded);value();
   }while(tokens[at++]===',');
   if(tokens[at-1]!=='}')throw new SyntaxError('EvaluationJsonInvalid');
  }else if(token==='['){
   if(tokens[at]===']'){at++;return;}do{value();}while(tokens[at++]===',');if(tokens[at-1]!==']')throw new SyntaxError('EvaluationJsonInvalid');
  }else if(token===undefined||['}',']',':',','].includes(token))throw new SyntaxError('EvaluationJsonInvalid');
 }
 value();if(at!==tokens.length)throw new SyntaxError('EvaluationJsonInvalid');
}
/** @typedef {{httpStatus?:number,error?:{code?:number},id?:string,model?:string,choices?:({index?:number,finish_reason?:string|null,message?:{role?:string,content?:string|null}}|null)[],usage?:{prompt_tokens?:number,completion_tokens?:number,total_tokens?:number,cost?:number,is_byok?:boolean,cost_details?:Partial<Record<'upstream_inference_cost'|'upstream_inference_prompt_cost'|'upstream_inference_completions_cost',number>>,prompt_tokens_details?:Partial<Record<'cached_tokens'|'audio_tokens'|'video_tokens',number>>,completion_tokens_details?:Partial<Record<'reasoning_tokens'|'audio_tokens'|'accepted_prediction_tokens'|'rejected_prediction_tokens',number>>}}} EvaluationProviderReceipt */
/** Closed persistence contract; never copy provider objects or arbitrary nested fields.
 * Known billing is settled independently of answer validity.
 * @param {Record<string,unknown>} document @param {number} httpStatus @param {boolean} providerError @param {string} model @returns {EvaluationProviderReceipt} */
function evaluationProviderReceipt(document,httpStatus,providerError,model){
 /** @template {string} K @param {unknown} value @param {K[]} keys @param {boolean} [money] @returns {Partial<Record<K,number>>} */
 const numbers=(value,keys,money=false)=>{
  /** @type {Partial<Record<K,number>>} */const result={};
  if(record(value))for(const key of keys){const n=value[key];if(typeof n==='number'&&(money?Number.isFinite(n)&&n>=0:count(n)))result[key]=n;}
  return result;
 };
 return {
  httpStatus,
  ...(providerError&&(!isProviderErrorTermination(document)||Object.hasOwn(document,'error')||httpStatus>=400)?{error:{...(record(document.error)&&count(document.error.code)&&document.error.code>=100&&document.error.code<=599?{code:document.error.code}:{})}}:{}),
  ...(typeof document.id==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(document.id)?{id:document.id}:{}),
  ...(document.model===model?{model}:{}),
  ...(providerError&&isProviderErrorTermination(document)?{choices:[{finish_reason:'error'}]}:{}),
  ...(!providerError&&Array.isArray(document.choices)?{choices:document.choices.map(choice=>record(choice)?{
   ...(count(choice.index)?{index:choice.index}:{}),
   ...(typeof choice.finish_reason==='string'||choice.finish_reason===null?{finish_reason:choice.finish_reason}:{}),
   ...(record(choice.message)?{message:{
    ...(typeof choice.message.role==='string'?{role:choice.message.role}:{}),
    ...(typeof choice.message.content==='string'||choice.message.content===null?{content:choice.message.content}:{})
   }}:{})
  }:null)}:{}),
  ...(record(document.usage)?{usage:{
   ...numbers(document.usage,['prompt_tokens','completion_tokens','total_tokens']),
   ...numbers(document.usage,['cost'],true),
   ...(typeof document.usage.is_byok==='boolean'?{is_byok:document.usage.is_byok}:{}),
   ...(record(document.usage.cost_details)?{cost_details:numbers(document.usage.cost_details,['upstream_inference_cost','upstream_inference_prompt_cost','upstream_inference_completions_cost'],true)}:{}),
   ...(record(document.usage.prompt_tokens_details)?{prompt_tokens_details:numbers(document.usage.prompt_tokens_details,['cached_tokens','audio_tokens','video_tokens'])}:{}),
   ...(record(document.usage.completion_tokens_details)?{completion_tokens_details:numbers(document.usage.completion_tokens_details,['reasoning_tokens','audio_tokens','accepted_prediction_tokens','rejected_prediction_tokens'])}:{})
  }}:{})
 };
}
/** Explicit uncertainty: budget counters are estimates; actual counts remain nullable.
 * @typedef {{label:'CONSERVATIVE_RESERVATION_BASED_ESTIMATE',usageStatus:'UNKNOWN',actualInputTokens:number|null,actualOutputTokens:number|null,providerReportedCostNanodollars:number|null,reservedInputTokens:number,reservedOutputTokens:number,reservedCostNanodollars:number,costNanodollars:number,source:string,catalogSha256:string,promptRateNanodollars:number,completionRateNanodollars:number}} ReservationBasedAccounting */
/** @typedef {EvaluationProviderReceipt & {provider?:string,accounting?:ReservationBasedAccounting|{label:'ESTIMATED_FROM_USAGE_TOKENS',catalogSha256:string,costNanodollars:number}}} EvaluationSanitizedEnvelope */
/** @param {{requestTimeoutMs?:number,expectedRecoveryKey?:string,failureOrigin?:"pipeline"|"evaluator",expectedResponseFormat?:"json_object"|"json_schema",expectedReasoningEffort?:"none"|"low"|"high",requiredProviders?:readonly string[],estimateFromTokens?:boolean,ledger:EvaluationLedger,catalog:EvaluationCatalog,model:string,endpoint:string,iterationId:string,phase?:import("../worker/webpage-facts.js").WebpagePhase,fetch:typeof fetch,now:()=>number,signal:AbortSignal,inputTokenBound?:(body:Record<string,unknown>,catalog:EvaluationCatalog,signal:AbortSignal)=>Promise<InputTokenBound>,logger:(entry:{event:string,failureKind?:string,field?:string,persistence?:SQLiteFailure,phase?:import("../worker/webpage-facts.js").WebpagePhase,elapsedMs?:number})=>void,billingMode?:EvaluationAccountingMode,ownerDecision?:EvaluationOwnerDecision,requestPlanner?:EstimatedRequestPlanner,allInBillingBound?:EvaluationBillingAccountant,benchmarkContract?:BenchmarkModelContract,wait?:(milliseconds:number,signal:AbortSignal)=>Promise<void>}} dependencies @returns {typeof fetch} */
export function createEvaluationTransport(dependencies){
 const {ledger,catalog:suppliedCatalog,model,endpoint,iterationId,fetch:transport,now,signal,inputTokenBound,logger}=dependencies??{};
 if(ledger?.runtimePolicy&&dependencies.benchmarkContract===undefined)throw new EvaluationTransportFailure({kind:'EvaluationBenchmarkContractMissing'});
 if(ledger?.runtimePolicy&&dependencies.benchmarkContract){const c=dependencies.benchmarkContract;if(!['openai','anthropic','google'].every(id=>c.excludedCreators.includes(id))||c.approved.some(a=>a.id.toLowerCase().includes('luna')))throw new EvaluationTransportFailure({kind:'EvaluationBenchmarkModelExcluded'});}
 if(dependencies.benchmarkContract!==undefined){const approved=validateBenchmarkModelContract(suppliedCatalog,dependencies.benchmarkContract);if(!approved.ok)throw new EvaluationTransportFailure(approved.error);}
 const estimated=dependencies.billingMode==='estimated';
 const tokenEstimate=dependencies.estimateFromTokens===true;
 if(dependencies.requiredProviders!==undefined&&(!Array.isArray(dependencies.requiredProviders)||!dependencies.requiredProviders.length||!dependencies.requiredProviders.every(text)||new Set(dependencies.requiredProviders).size!==dependencies.requiredProviders.length))throw new TypeError('EvaluationProviderContractInvalid');
 if(dependencies.estimateFromTokens!==undefined&&typeof dependencies.estimateFromTokens!=='boolean'||tokenEstimate&&!estimated)throw new TypeError('EvaluationAccountingModeConflict');
 if(estimated&&!isEstimatedOwnerDecision(dependencies.ownerDecision))throw new TypeError('EvaluationAccountingDecisionInvalid');
 if(ledger?.accountingMode!==(estimated?'estimated':'configured')||(estimated&&JSON.stringify(ledger.ownerDecision)!==JSON.stringify(dependencies.ownerDecision)))throw new TypeError('EvaluationAccountingModeConflict');
 const validated=validateEvaluationCatalog(suppliedCatalog,model);
 if(!validated.ok)throw new EvaluationTransportFailure(validated.error);
 if(dependencies.expectedReasoningEffort!==undefined&&(!['none','low','high'].includes(dependencies.expectedReasoningEffort)||!suppliedCatalog.model.reasoning?.supported_efforts?.includes(dependencies.expectedReasoningEffort)||dependencies.expectedReasoningEffort!=='low'&&!suppliedCatalog.model.supported_parameters?.includes('reasoning')))throw new EvaluationTransportFailure({kind:'EvaluationReasoningSettingsInvalid',field:'transport capability'});
 const catalog=structuredClone(validated.value);Object.freeze(catalog.model.pricing);Object.freeze(catalog.model.architecture.input_modalities);Object.freeze(catalog.model.architecture);Object.freeze(catalog.model);Object.freeze(catalog);
 if((dependencies.failureOrigin!==undefined&&!['pipeline','evaluator'].includes(dependencies.failureOrigin))||(dependencies.expectedResponseFormat!==undefined&&!['json_object','json_schema'].includes(dependencies.expectedResponseFormat))||(dependencies.billingMode!==undefined&&!['configured','estimated'].includes(dependencies.billingMode))||!ledger||typeof ledger.reserve!=='function'||typeof ledger.uncertain!=='function'||['snapshot','complete','cancel','trackAccounting','recoveryCandidate','haltExecution','replayResponse','pacingDue'].some(k=>typeof /** @type {Record<string,unknown>} */(ledger)[k]!=='function')||(dependencies.phase!==undefined&&!['extraction','normalization','grounding','match','verify'].includes(dependencies.phase))||typeof transport!=='function'||typeof now!=='function'||(estimated?typeof dependencies.requestPlanner!=='function':typeof inputTokenBound!=='function')||typeof logger!=='function'||!(signal instanceof AbortSignal)||!text(iterationId)||!text(endpoint)||!URL.canParse(endpoint)||new URL(endpoint).href!=='https://openrouter.ai/api/v1/chat/completions')throw new TypeError('EvaluationTransportDependenciesInvalid');
 let startedAt=now();
 /** @param {{kind:string,field?:string,httpStatus?:number,errorCode?:number,finishReason?:'error'}} error @returns {never} */
 const fail=error=>{logger({event:'evaluation-transport-failure',failureKind:error.kind,...(error.field===undefined?{}:{field:error.field}),...('persistence'in error?{persistence:/** @type {SQLiteFailure} */(error.persistence)}:{}),...(dependencies.phase===undefined?{}:{phase:dependencies.phase}),elapsedMs:now()-startedAt});throw new EvaluationTransportFailure(error);};
 if(dependencies.expectedRecoveryKey!==undefined&&!text(dependencies.expectedRecoveryKey))throw new TypeError('EvaluationRecoveryEvidenceInvalid');
 if(dependencies.requestTimeoutMs!==undefined&&(!Number.isSafeInteger(dependencies.requestTimeoutMs)||dependencies.requestTimeoutMs<=0))throw new TypeError('EvaluationRequestTimeoutInvalid');
 if(dependencies.wait!==undefined&&typeof dependencies.wait!=='function')throw new TypeError('EvaluationRecoveryWaitInvalid');
 /** @param {Parameters<typeof fetch>[0]} url @param {Parameters<typeof fetch>[1]} init @param {(key:string)=>void} onKey @param {boolean} admittedRecovery @param {()=>void} accountingStarted */
 const send=async(url,init,onKey,admittedRecovery,accountingStarted)=>{
  startedAt=now();
  logger({event:'evaluation-transport-entry',phase:dependencies.phase});
  const requestInit=/** @type {{method?:string,body?:unknown,signal?:AbortSignal|null}} */(init);
  if(String(url)!==new URL(endpoint).href||requestInit?.method!=='POST'||typeof requestInit.body!=='string'||!(requestInit.signal instanceof AbortSignal))return fail({kind:'EvaluationTransportInvalid'});
  if(dependencies.benchmarkContract!==undefined){/** @type {unknown} */let raw;try{raw=JSON.parse(requestInit.body);}catch(error){if(error instanceof SyntaxError)return fail({kind:'EvaluationTransportInvalid',field:'body'});throw error;}const approved=validateBenchmarkModelContract({...catalog,model:{...catalog.model,id:record(raw)&&typeof raw.model==='string'?raw.model:''}},dependencies.benchmarkContract);if(!approved.ok)return fail(approved.error);}
  const resumableWindowAbort=()=>{if(ledger.runtimePolicy?.version!==2||!signal.aborted||!(signal.reason instanceof DOMException)||signal.reason.name!=='TimeoutError'||signal.reason.message!=='EvaluationWindowExpired')return false;const current=ledger.snapshot();return current.ok&&now()>=(current.value.effectiveDeadlineAtMs??Infinity)&&now()<(current.value.runtimeDeadlineAtMs??0);};
  const cancel=()=>{if(resumableWindowAbort())return;const c=ledger.cancel();if(!c.ok)logger({event:'evaluation-transport-failure',failureKind:c.error.kind});};
  if(signal.aborted){cancel();return fail({kind:'EvaluationCancelled'});}
  const snapshot=ledger.snapshot();if(!snapshot.ok)return fail(snapshot.error);
  if(snapshot.value.executionWindow?.authority.new45&&dependencies.benchmarkContract===undefined)return fail({kind:'EvaluationBenchmarkContractMissing'});
  if((snapshot.value.effectiveCancelled??snapshot.value.cancelled))return fail({kind:'EvaluationCancelled'});
  if(snapshot.value.admissionHalted)return fail({kind:'EvaluationAccountingHalted',field:snapshot.value.admissionHalted});
  let requestTimeoutSignal=requestInit.signal;
  const remaining=(snapshot.value.effectiveDeadlineAtMs??snapshot.value.deadlineAtMs)-now();if(dependencies.requestTimeoutMs===undefined&&ledger.runtimePolicy&&admittedRecovery&&requestTimeoutSignal?.aborted&&requestTimeoutSignal.reason instanceof DOMException&&requestTimeoutSignal.reason.name==='TimeoutError'&&remaining>0)requestTimeoutSignal=AbortSignal.timeout(Math.min(60000,remaining));if(!count(remaining)||remaining<=0||requestTimeoutSignal.aborted)return fail({kind:'EvaluationDeadlineExceeded'});
  /** @type {unknown} */let parsedBody;try{parsedBody=(JSON.parse(requestInit.body));}catch(error){if(!(error instanceof SyntaxError))throw error;return fail({kind:'EvaluationTransportInvalid',field:'body'});}
  if(!record(parsedBody)||parsedBody.model!==model||!count(parsedBody.max_tokens)||parsedBody.max_tokens===0||parsedBody.stream===true||Object.keys(parsedBody).some(k=>!['model','max_tokens','messages','provider','response_format','reasoning','stream'].includes(k))||(parsedBody.provider!==undefined&&!record(parsedBody.provider)))return fail({kind:'EvaluationTransportInvalid',field:'model/max_tokens/paid extensions'});
  const provider={sort:'throughput',require_parameters:true,allow_fallbacks:true,...(record(parsedBody.provider)?parsedBody.provider:{})};
  if(!isKnowledgeModelProvider(provider))return fail({kind:'EvaluationBenchmarkContractConflict',field:'provider routing/price contract'});
  // Official max_price uses USD/M tokens; reserve against the ceiling, not one endpoint's rate.
  const promptRate=provider.max_price?.prompt===undefined?Number(nanodollars(catalog.model.pricing.prompt)):provider.max_price.prompt*1000;
  const outputRate=provider.max_price?.completion===undefined?Number(nanodollars(catalog.model.pricing.completion)):provider.max_price.completion*1000;
  if(promptRate<Number(nanodollars(catalog.model.pricing.prompt))||outputRate<Number(nanodollars(catalog.model.pricing.completion)))return fail({kind:'EvaluationPricingInvalid',field:'routing ceiling below catalog rates'});
  const dynamic=provider.allow_fallbacks&&provider.only===undefined&&dependencies.requiredProviders===undefined;
  if(ledger.runtimePolicy?.continuation&&model==='z-ai/glm-5.3-flash'&&(!record(parsedBody.response_format)||parsedBody.response_format.type!==(dependencies.expectedResponseFormat??'json_schema')||!record(parsedBody.reasoning)||parsedBody.reasoning.effort!==(dependencies.expectedReasoningEffort??'low')||!record(parsedBody.provider)||!dynamic&&(JSON.stringify(parsedBody.provider.only)!=='["deepinfra/fp4"]'||parsedBody.provider.allow_fallbacks!==false)))return fail({kind:'EvaluationBenchmarkContractConflict',field:'GLM compatible routing/schema/'+(dependencies.expectedReasoningEffort??'low')});
  const mistralFormat=dependencies.expectedResponseFormat??'json_object';
  if(ledger.runtimePolicy?.renewal&&model==='mistralai/mistral-large-4-0'&&(!record(parsedBody.response_format)||parsedBody.response_format.type!==mistralFormat||(mistralFormat==='json_object'?Object.keys(parsedBody.response_format).join(',')!=='type':!record(parsedBody.response_format.json_schema))||!record(parsedBody.reasoning)||Object.keys(parsedBody.reasoning).join(',')!=='effort'||parsedBody.reasoning.effort!==(dependencies.expectedReasoningEffort??'none')||!record(parsedBody.provider)||!dynamic&&(JSON.stringify(parsedBody.provider.only)!=='["Mistral"]'||parsedBody.provider.allow_fallbacks!==false)))return fail({kind:'EvaluationBenchmarkContractConflict',field:'Mistral compatible routing/'+mistralFormat+'/'+(dependencies.expectedReasoningEffort??'none')});
  const body={...parsedBody,max_tokens:ledger.runtimePolicy?.renewal&&model==='mistralai/mistral-large-4-0'?Math.min(parsedBody.max_tokens,4096):parsedBody.max_tokens,stream:false,provider:{...(record(parsedBody.provider)?parsedBody.provider:{}),require_parameters:true,allow_fallbacks:provider.allow_fallbacks,max_price:{prompt:promptRate/1000,completion:outputRate/1000,request:0,image:0}}};
  Object.freeze(body.provider.max_price);Object.freeze(body.provider);Object.freeze(body);
  // With an explicit attempt bound, init.signal is a hard logical caller deadline and is never renewed.
  const logicalCallerAborted=()=>dependencies.requestTimeoutMs!==undefined&&requestTimeoutSignal.aborted;
  const physicalAttemptTimer=ledger.runtimePolicy!==undefined&&dependencies.requestTimeoutMs!==undefined;
  // Local accounting and pacing consume the caller/window clock; the physical attempt clock starts at dispatch.
  const timerController=new AbortController();let timer=setTimeout(()=>timerController.abort(),physicalAttemptTimer?remaining:Math.min(dependencies.requestTimeoutMs??(ledger.runtimePolicy?remaining:60000),remaining));
  const requestSignal=AbortSignal.any([signal,requestTimeoutSignal,timerController.signal]);
  const stopError=()=>({kind:signal.aborted&&!(signal.reason instanceof DOMException&&signal.reason.name==='TimeoutError')?'EvaluationCancelled':'EvaluationDeadlineExceeded',field:signal.aborted?'caller-cancelled':logicalCallerAborted()?'caller-deadline-expired':now()>=(snapshot.value.effectiveDeadlineAtMs??snapshot.value.deadlineAtMs)?'grant-deadline-expired':timerController.signal.aborted?'request-timer-expired':requestTimeoutSignal?.reason instanceof DOMException&&requestTimeoutSignal.reason.name==='TimeoutError'?'request-timer-expired':'request-cancelled'});
  signal.addEventListener('abort',cancel,{once:true});
  /** @template T @param {Promise<T>} pending @returns {Promise<T>} */
  const bounded=async pending=>{
   /** @type {()=>void} */let onAbort=()=>{};
   try{return await Promise.race([pending,new Promise((_,reject)=>{onAbort=()=>{const error=stopError();logger({event:'evaluation-transport-failure',failureKind:error.kind,field:error.field,phase:dependencies.phase,elapsedMs:now()-startedAt});reject(new EvaluationTransportFailure(error));};if(requestSignal.aborted)onAbort();else requestSignal.addEventListener('abort',onAbort,{once:true});})]);}
   finally{requestSignal.removeEventListener('abort',onAbort);}
  };
  try{
   let bound;try{bound=await bounded(estimated?/** @type {EstimatedRequestPlanner} */(dependencies.requestPlanner)(body,catalog,requestSignal):/** @type {NonNullable<typeof inputTokenBound>} */(inputTokenBound)(body,catalog,requestSignal));}catch(error){if(error instanceof EvaluationTransportFailure)throw error;if(!(error instanceof Error))throw error;return fail({kind:'EvaluationInputAccountingFailed'});}
   if(requestSignal.aborted||now()>=(snapshot.value.effectiveDeadlineAtMs??snapshot.value.deadlineAtMs))return fail(stopError());
   if(!record(bound)||(!estimated&&Object.keys(bound).sort().join(',')!=='inputTokens,reference')||(estimated&&(!('approximate' in bound)||bound.approximate!==true||!('costNanodollars' in bound)||!count(bound.costNanodollars)||!('outputTokens' in bound)||bound.outputTokens!==body.max_tokens))||!count(bound.inputTokens)||bound.inputTokens===0||!text(bound.reference)||bound.inputTokens+body.max_tokens>catalog.model.context_length)return fail({kind:'EvaluationInputAccountingInvalid'});
   let allowanceCost=estimated?Math.max(/** @type {EstimatedRequest} */(bound).costNanodollars,bound.inputTokens*promptRate+body.max_tokens*outputRate):bound.inputTokens*promptRate+body.max_tokens*outputRate;
   if(dependencies.billingMode==='configured'){
    if(typeof dependencies.allInBillingBound!=='function')return fail({kind:'EvaluationBillingBoundUnavailable'});
    const billing=await bounded(dependencies.allInBillingBound(body,catalog,requestSignal));
    if(!record(billing)||Object.keys(billing).sort().join(',')!=='costNanodollars,reference'||!count(billing.costNanodollars)||billing.costNanodollars<allowanceCost||!text(billing.reference))return fail({kind:'EvaluationBillingBoundUnavailable',field:'complete all-in reserve'});
    allowanceCost=billing.costNanodollars;
   }
   if(!count(allowanceCost))return fail({kind:'EvaluationPricingInvalid'});
   const {createHash}=await import('node:crypto');
   const computedKey=iterationId+':'+createHash('sha256').update(JSON.stringify({body,catalog,accounting:estimated?{...bound,plannedAtMs:undefined}:bound})).digest('hex');
   if(dependencies.expectedRecoveryKey!==undefined&&computedKey!==dependencies.expectedRecoveryKey)return fail({kind:'EvaluationRecoveryEvidenceInvalid',field:'native request/accounting key'});
   // Only an exact, independently source-bound corrected protocol request resumes its failed logical call.
   const baseKey=ledger.runtimePolicy?.protocolRepair?.correctedRequestKey===computedKey?ledger.runtimePolicy.protocolRepair.failedKey:computedKey;
   onKey(baseKey);let key=baseKey;
   const replay=ledger.replayResponse(baseKey);if(!replay.ok)return fail(replay.error);
   if(replay.value){accountingStarted();const receipt=replay.value;if(isProviderErrorTermination(receipt))return fail({kind:'EvaluationProviderError',httpStatus:typeof receipt.httpStatus==='number'?receipt.httpStatus:200,finishReason:'error'});if(receipt.error!==undefined)return fail({kind:'EvaluationProviderError',httpStatus:typeof receipt.httpStatus==='number'?receipt.httpStatus:200,...(record(receipt.error)&&count(receipt.error.code)?{errorCode:receipt.error.code}:{})});if(receipt.model!==model)return fail({kind:'EvaluationServedModelMismatch'});return new Response(JSON.stringify(receipt),{status:typeof receipt.httpStatus==='number'?receipt.httpStatus:200,headers:{'content-type':'application/json'}});}

   const candidate=ledger.recoveryCandidate(baseKey);if(!candidate.ok)return fail(candidate.error);
   if(candidate.value)accountingStarted();
   const pacing=ledger.pacingDue(model);if(!pacing.ok)return fail(pacing.error);if(pacing.value.cooldown&&ledger.runtimePolicy?.maximumAdditionalRecoveries!==null)return fail({kind:'EvaluationRecoveryCooldown'});
   if(candidate.value||ledger.runtimePolicy?.renewal){
    const dueAtMs=Math.max(candidate.value?.retryAtMs??0,pacing.value.retryAtMs),waitMs=Math.max(0,dueAtMs-now());
    if(dueAtMs>=(snapshot.value.effectiveDeadlineAtMs??snapshot.value.deadlineAtMs))return fail({kind:'EvaluationDeadlineExceeded'});
    logger({event:'evaluation-recovery-wait',phase:dependencies.phase});
    if(dependencies.wait)await bounded(dependencies.wait(waitMs,requestSignal));
    else await bounded(new Promise((resolve,reject)=>{const timer=setTimeout(done,waitMs);function done(){requestSignal.removeEventListener('abort',abort);resolve(undefined);}function abort(){clearTimeout(timer);requestSignal.removeEventListener('abort',abort);reject(new EvaluationTransportFailure(stopError()));}if(requestSignal.aborted)abort();else requestSignal.addEventListener('abort',abort,{once:true});}));
    if(requestSignal.aborted||now()>=(snapshot.value.effectiveDeadlineAtMs??snapshot.value.deadlineAtMs))return fail(stopError());
    if(candidate.value)key=candidate.value.nextKey;
   }
   if(ledger.runtimePolicy?.version===2&&dependencies.failureOrigin==='pipeline'&&dependencies.requestTimeoutMs!==undefined&&!candidate.value)requireEvaluationRequestWindow(snapshot.value,dependencies.requestTimeoutMs,now());
   const reserved=ledger.reserve({key,inputTokens:bound.inputTokens,outputTokens:body.max_tokens,costNanodollars:allowanceCost,...(ledger.runtimePolicy?.renewal?{model}:{}),...(candidate.value?{recoveryOf:candidate.value.failedKey,baseKey}:{})});if(!reserved.ok)return fail(reserved.error);
   accountingStarted();
   if(reserved.value.response){
    const receipt=reserved.value.response;
    if(isProviderErrorTermination(receipt))return fail({kind:'EvaluationProviderError',httpStatus:typeof receipt.httpStatus==='number'?receipt.httpStatus:200,finishReason:'error'});if(receipt.error!==undefined)return fail({kind:'EvaluationProviderError',httpStatus:typeof receipt.httpStatus==='number'?receipt.httpStatus:200,...(record(receipt.error)&&count(receipt.error.code)?{errorCode:receipt.error.code}:{})});
    if(receipt.model!==model)return fail({kind:'EvaluationServedModelMismatch'});
    return new Response(JSON.stringify(receipt),{status:typeof receipt.httpStatus==='number'?receipt.httpStatus:200,headers:{'content-type':'application/json'}});
   }
   /** Account even if a non-cooperative provider resolves after cancellation/deadline.
    * @param {Response} response @returns {Promise<Response>} */
   const account=async response=>{
    /** @type {unknown} */let document;
    if(!(response instanceof Response)){const stopped=ledger.uncertain({key,kind:'EvaluationResponseReadFailed'});return fail(stopped.ok||stopped.error.kind==='EvaluationResponseReadFailed'?{kind:'EvaluationResponseReadFailed'}:stopped.error);}
    /** @type {EvaluationResponseDiagnostics} */let diagnostics={httpStatus:response.status,errorEnvelope:false,bodyKind:'invalid-json'};
    if(!response.ok)diagnostics.providerFailure=projectProviderFailure(undefined,response.headers,now(),/^Bearer [^\s]+$/.test(new Headers(/** @type {{headers?:HeadersInit}} */(init)?.headers).get('authorization')??''),[parsedBody.messages]);
    /** @type {string} */let raw='';
    try{
     const reader=response.body?.getReader(),chunks=[];let size=0;
     if(reader)try{for(;;){const chunk=await bounded(reader.read());if(chunk.done)break;size+=chunk.value.byteLength;if(size>(response.ok?1048576:65536)){await bounded(reader.cancel());throw new EvaluationTransportFailure({kind:'EvaluationResponseBodyTooLarge'});}chunks.push(chunk.value);}}
     finally{reader.releaseLock();}
     const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);JSON.parse(raw);rejectDuplicateJsonKeys(raw);document=JSON.parse(raw);
    }catch(error){
     if(!(error instanceof Error))throw error;
     const kind=resumableWindowAbort()&&error instanceof EvaluationTransportFailure&&error.failure.kind==='EvaluationDeadlineExceeded'?'EvaluationTransportUncertain':error instanceof EvaluationTransportFailure&&error.failure.kind==='EvaluationResponseBodyTooLarge'?'EvaluationResponseBodyTooLarge':error instanceof SyntaxError?response.ok?'EvaluationUsageInvalid':'EvaluationProviderError':'EvaluationResponseReadFailed';
     const stopped=ledger.uncertain({key,kind,diagnostics,...(ledger.runtimePolicy?.maximumAdditionalRecoveries===null&&dependencies.failureOrigin==='pipeline'&&response.status===400?{terminalPipeline:/** @type {const} */(true)}:{}),...(ledger.runtimePolicy?.maximumAdditionalRecoveries===null&&!signal.aborted&&!logicalCallerAborted()&&(kind==='EvaluationResponseReadFailed'||response.status===429||response.status>=500||dependencies.failureOrigin==='evaluator'&&response.status===400||kind==='EvaluationUsageInvalid')?{recoverableExternal:/** @type {const} */(true)}:{}),...(ledger.runtimePolicy&&requestSignal.aborted&&(resumableWindowAbort()||!signal.aborted&&(timerController.signal.aborted||dependencies.requestTimeoutMs===undefined&&requestTimeoutSignal?.reason instanceof DOMException&&requestTimeoutSignal.reason.name==='TimeoutError'))&&now()<(snapshot.value.runtimeDeadlineAtMs??snapshot.value.deadlineAtMs)?{recoverableTimeout:/** @type {const} */(true)}:{})});if(!stopped.ok&&stopped.error.kind!==kind)return fail(stopped.error);if(requestSignal.aborted)return fail(stopError());return fail({kind:ledger.runtimePolicy?.maximumAdditionalRecoveries===null&&dependencies.failureOrigin==='pipeline'&&response.status===400?'EvaluationPipelineRequestRejected':kind,field:'response',httpStatus:response.status});
    }
    const errorTermination=response.ok&&isProviderErrorTermination(document);
    const providerError=!response.ok||record(document)&&Object.hasOwn(document,'error')||errorTermination;
    diagnostics={httpStatus:response.status,...(errorTermination?{finishReason:/** @type {const} */('error')}:{}),errorEnvelope:record(document)&&Object.hasOwn(document,'error'),bodyKind:'json',...(record(document)&&record(document.error)&&count(document.error.code)&&document.error.code>=100&&document.error.code<=599?{errorCode:document.error.code}:{}),...(record(document)&&typeof document.id==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(document.id)?{generationId:document.id}:{})};
    if(providerError){diagnostics.providerFailure=projectProviderFailure(document,response.headers,now(),/^Bearer [^\s]+$/.test(new Headers(/** @type {{headers?:HeadersInit}} */(init)?.headers).get('authorization')??''),[parsedBody.messages]);if(diagnostics.providerFailure.authenticated&&[429,502,503].includes(response.status))authenticatedDiagnostics.add(diagnostics);}
    const providerFailure={kind:'EvaluationProviderError',httpStatus:response.status,...(errorTermination?{finishReason:/** @type {const} */('error')}:{}),...(diagnostics.errorCode===undefined?{}:{errorCode:diagnostics.errorCode})};
    const usage=record(document)&&record(document.usage)?document.usage:{};
    const inputTokens=count(usage.prompt_tokens)?usage.prompt_tokens:undefined,outputTokens=count(usage.completion_tokens)?usage.completion_tokens:undefined;
    const charged=typeof usage.cost==='number'&&Number.isFinite(usage.cost)&&usage.cost>=0?chargedNanodollars(usage.cost):undefined;
    const tokenCost=inputTokens===undefined||outputTokens===undefined?undefined:inputTokens*promptRate+outputTokens*outputRate;
    const costNanodollars=estimated?tokenEstimate&&charged===undefined?tokenCost:charged:Math.max(count(charged)?charged:0,(inputTokens??0)*promptRate+(outputTokens??0)*outputRate);
    const malformed=tokenEstimate&&(record(document)&&Object.hasOwn(document,'usage')&&!record(document.usage)||['prompt_tokens','completion_tokens','total_tokens'].some(k=>Object.hasOwn(usage,k)&&!count(usage[k]))||Object.hasOwn(usage,'cost')&&!count(charged)||count(usage.total_tokens)&&inputTokens!==undefined&&outputTokens!==undefined&&usage.total_tokens!==inputTokens+outputTokens);
    const missingEstimate=tokenEstimate&&estimated&&!malformed&&!providerError&&(inputTokens===undefined||outputTokens===undefined);
    /** @type {ReservationBasedAccounting|undefined} */const accounting=missingEstimate?{label:'CONSERVATIVE_RESERVATION_BASED_ESTIMATE',usageStatus:'UNKNOWN',actualInputTokens:inputTokens??null,actualOutputTokens:outputTokens??null,providerReportedCostNanodollars:charged??null,reservedInputTokens:bound.inputTokens,reservedOutputTokens:body.max_tokens,reservedCostNanodollars:allowanceCost,costNanodollars:Math.max(allowanceCost,charged??0,Math.max(bound.inputTokens,inputTokens??0)*promptRate+Math.max(body.max_tokens,outputTokens??0)*outputRate),source:/** @type {EstimatedRequest} */(bound).source,catalogSha256:catalog.catalogSha256,promptRateNanodollars:promptRate,completionRateNanodollars:outputRate}:undefined;
    /** @type {EvaluationSanitizedEnvelope|undefined} */let envelope;
    if(tokenEstimate&&record(document)){
     const receipt=evaluationProviderReceipt(document,response.status,providerError,typeof document.model==='string'?document.model:model);
     envelope={...receipt,...(text(document.provider)?{provider:document.provider}:{}),...(accounting?{accounting}:charged===undefined&&count(tokenCost)?{accounting:{label:/** @type {const} */('ESTIMATED_FROM_USAGE_TOKENS'),catalogSha256:catalog.catalogSha256,costNanodollars:tokenCost}}:{})};
     const preserved=ledger.persistEnvelope({key,envelope});if(!preserved.ok)return fail(preserved.error);
    }
    // Interrupted output is a failed physical call, never a successful cached model result.
    if(errorTermination){const stopped=ledger.uncertain({key,kind:'EvaluationProviderError',...(ledger.runtimePolicy?.maximumAdditionalRecoveries===null&&!signal.aborted&&!logicalCallerAborted()?{recoverableExternal:/** @type {const} */(true)}:{}),diagnostics,...(inputTokens===undefined?{}:{inputTokens}),...(outputTokens===undefined?{}:{outputTokens}),...(count(costNanodollars)?{costNanodollars}:{})});return fail(!stopped.ok&&stopped.error.kind!=='EvaluationProviderError'?stopped.error:providerFailure);}
    if(providerError&&ledger.runtimePolicy?.maximumAdditionalRecoveries===null&&dependencies.failureOrigin==='pipeline'&&response.status===400){const stopped=ledger.uncertain({key,kind:'EvaluationProviderError',terminalPipeline:true,diagnostics,...(inputTokens===undefined?{}:{inputTokens}),...(outputTokens===undefined?{}:{outputTokens}),...(count(charged)?{costNanodollars:charged}:{})});return fail(!stopped.ok&&stopped.error.kind!=='EvaluationProviderError'?stopped.error:{...providerFailure,kind:'EvaluationPipelineRequestRejected'});}
    if(providerError&&ledger.runtimePolicy?.maximumAdditionalRecoveries===null&&(response.status===429||response.status>=500||dependencies.failureOrigin==='evaluator'&&response.status===400)){const stopped=ledger.uncertain({key,kind:'EvaluationProviderError',recoverableExternal:true,diagnostics,...(inputTokens===undefined?{}:{inputTokens}),...(outputTokens===undefined?{}:{outputTokens}),...(count(charged)?{costNanodollars:charged}:{})});return fail(!stopped.ok&&stopped.error.kind!=='EvaluationProviderError'?stopped.error:providerFailure);}
    if(!missingEstimate&&(inputTokens===undefined||outputTokens===undefined||(!tokenEstimate&&!count(charged))||malformed||!count(costNanodollars))||!record(document)){
     const stopped=ledger.uncertain({key,kind:providerError?'EvaluationProviderError':'EvaluationUsageInvalid',diagnostics,...(inputTokens===undefined?{}:{inputTokens}),...(outputTokens===undefined?{}:{outputTokens}),...(count(charged)?{costNanodollars:charged}:{})});return fail(providerError&&(!stopped.ok&&stopped.error.kind==='EvaluationProviderError')?providerFailure:stopped.ok||stopped.error.kind==='EvaluationUsageInvalid'?{kind:'EvaluationUsageInvalid',field:inputTokens===undefined?'usage.prompt_tokens':outputTokens===undefined?'usage.completion_tokens':!count(charged)?'usage.cost':'usage'}:stopped.error);
    }
    if(!providerError&&dependencies.requiredProviders&&document.provider!==undefined&&!dependencies.requiredProviders.includes(String(document.provider))){const stopped=ledger.uncertain({key,kind:'EvaluationServedProviderMismatch',inputTokens,outputTokens,costNanodollars:accounting?.costNanodollars??costNanodollars??undefined,diagnostics});return fail(stopped.ok?{kind:'EvaluationServedProviderMismatch'}:stopped.error);}
    if(!providerError&&document.model!==model){const stopped=ledger.uncertain({key,kind:'EvaluationServedModelMismatch',inputTokens,outputTokens,costNanodollars:accounting?.costNanodollars??costNanodollars??undefined,diagnostics});return fail(stopped.ok?{kind:'EvaluationServedModelMismatch'}:stopped.error);}
    const settled=ledger.complete({key,inputTokens:accounting?Math.max(accounting.reservedInputTokens,inputTokens??0):/** @type {number} */(inputTokens),outputTokens:accounting?Math.max(accounting.reservedOutputTokens,outputTokens??0):/** @type {number} */(outputTokens),costNanodollars:accounting?.costNanodollars??/** @type {number} */(costNanodollars),...(accounting?{accounting}:{}),response:evaluationProviderReceipt(document,response.status,providerError,model),diagnostics});if(!settled.ok)return fail(settled.error);
    if(providerError)return fail(providerFailure);
    if(requestSignal.aborted)return fail(stopError());
    logger({event:'evaluation-transport-success'});return new Response(envelope?JSON.stringify(envelope):raw,{status:response.status,headers:{'content-type':'application/json'}});
   };
   const pending=ledger.trackAccounting(Promise.resolve().then(()=>{
    if(physicalAttemptTimer){const dispatchRemaining=(snapshot.value.effectiveDeadlineAtMs??snapshot.value.deadlineAtMs)-now();if(requestSignal.aborted||dispatchRemaining<=0)throw new EvaluationTransportFailure(stopError());clearTimeout(timer);timer=setTimeout(()=>timerController.abort(),Math.min(/** @type {number} */(dependencies.requestTimeoutMs),dispatchRemaining));}
    return transport(url,{...init,body:JSON.stringify(body),signal:requestSignal});
   }).then(account, ()=>{
    const stopped=ledger.uncertain({key,kind:'EvaluationTransportUncertain',...(ledger.runtimePolicy?.maximumAdditionalRecoveries===null&&!signal.aborted&&!logicalCallerAborted()?{recoverableExternal:/** @type {const} */(true)}:{}),...(ledger.runtimePolicy&&(resumableWindowAbort()||(timerController.signal.aborted||dependencies.requestTimeoutMs===undefined&&requestTimeoutSignal?.reason instanceof DOMException&&requestTimeoutSignal.reason.name==='TimeoutError')&&!signal.aborted)&&now()<(snapshot.value.runtimeDeadlineAtMs??snapshot.value.effectiveDeadlineAtMs??snapshot.value.deadlineAtMs)?{recoverableTimeout:/** @type {const} */(true)}:{})});
    return fail(stopped.ok||stopped.error.kind==='EvaluationTransportUncertain'?{kind:'EvaluationTransportUncertain',field:'fetch'}:stopped.error);
   }));
   try{return await bounded(pending);}catch(error){if(requestSignal.aborted){const stopped=ledger.uncertain({key,kind:'EvaluationTransportUncertain',...(ledger.runtimePolicy?.maximumAdditionalRecoveries===null&&!signal.aborted&&!logicalCallerAborted()?{recoverableExternal:/** @type {const} */(true)}:{}),...(ledger.runtimePolicy&&(resumableWindowAbort()||(timerController.signal.aborted||dependencies.requestTimeoutMs===undefined&&requestTimeoutSignal?.reason instanceof DOMException&&requestTimeoutSignal.reason.name==='TimeoutError')&&!signal.aborted)&&now()<(snapshot.value.runtimeDeadlineAtMs??snapshot.value.effectiveDeadlineAtMs??snapshot.value.deadlineAtMs)?{recoverableTimeout:/** @type {const} */(true)}:{})});if(!stopped.ok)logger({event:'evaluation-transport-failure',failureKind:stopped.error.kind});}throw error;}
  }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
 };
 return async(url,init)=>{
  let baseKey='',accounted=false;
  // Count-unlimited recoveries still use the shared cost, request, token and time fences.
  for(let attempt=0;(ledger.runtimePolicy?.maximumAdditionalRecoveries===null||attempt<(ledger.runtimePolicy?ledger.runtimePolicy.maximumAdditionalRecoveries+1:9));attempt++){
   try{return await send(url,init,key=>{baseKey=key;},attempt>0,()=>{accounted=true;});}
   catch(error){
    if(error instanceof EvaluationTransportFailure&&!accounted&&['EvaluationCancelled','EvaluationDeadlineExceeded','EvaluationBudgetExceeded','EvaluationAccountingHalted'].includes(error.failure.kind))error.notStarted=true;
    if(ledger.runtimePolicy&&error instanceof EvaluationTransportFailure&&error.failure.kind==='EvaluationDeadlineExceeded'&&error.failure.field==='request-timer-expired'&&baseKey){const candidate=ledger.recoveryCandidate(baseKey);if(candidate.ok&&candidate.value)continue;}
    if(error instanceof EvaluationTransportFailure&&['EvaluationCancelled','EvaluationDeadlineExceeded'].includes(error.failure.kind)){const current=ledger.snapshot();if(!current.ok)return fail(current.error);if([2,3,4].includes(current.value.executionWindow?.authority.renewal?.version??0)){const stopped=ledger.cancel();if(!stopped.ok)return fail(stopped.error);}throw error;}
    if(!(error instanceof EvaluationTransportFailure))throw error;
    if(ledger.runtimePolicy&&error.failure.kind==='EvaluationTransportUncertain'&&baseKey){const candidate=ledger.recoveryCandidate(baseKey);if(candidate.ok&&candidate.value)continue;}
    if(ledger.runtimePolicy?.maximumAdditionalRecoveries===null&&['EvaluationProviderError','EvaluationResponseReadFailed','EvaluationUsageInvalid'].includes(error.failure.kind)&&baseKey){const candidate=ledger.recoveryCandidate(baseKey);if(candidate.ok&&candidate.value)continue;}
    if(error.failure.kind!=='EvaluationProviderError'||!(ledger.runtimePolicy?[429,502,503].includes(error.failure.httpStatus??0):error.failure.httpStatus===429)||error.failure.errorCode!==error.failure.httpStatus||!baseKey){
     const kinds=/** @type {LedgerFailureKind[]} */(['EvaluationLedgerPersistenceFailed','EvaluationProviderError','EvaluationBudgetExceeded','EvaluationResponseBodyTooLarge','EvaluationResponseReadFailed','EvaluationUsageInvalid','EvaluationServedProviderMismatch','EvaluationServedModelMismatch','EvaluationTransportUncertain']);
     const kind=kinds.find(k=>k===error.failure.kind);if(kind){const halted=ledger.haltExecution(kind);if(!halted.ok)return fail(halted.error);}throw error;
    }
    const pace=ledger.pacingDue(model);if(!pace.ok)return fail(pace.error);if(pace.value.cooldown&&ledger.runtimePolicy?.maximumAdditionalRecoveries!==null)return fail({kind:'EvaluationRecoveryCooldown'});
    const candidate=ledger.recoveryCandidate(baseKey);if(!candidate.ok){if(candidate.error.kind==='EvaluationAccountingHalted'&&candidate.error.field==='EvaluationProviderError')throw error;return fail(candidate.error);}if(!candidate.value){const halted=ledger.haltExecution('EvaluationProviderError');if(!halted.ok)return fail(halted.error);throw error;}
   }
  }
  return fail({kind:'EvaluationRecoveryAttemptsExhausted'});
 };
}
/** Trusted owner-provisioned grant. This API resumes an existing store; it never creates a grant.
 * @typedef {{id:string,storePath:string,device:number,inode:number,policy:EvaluationBudgetPolicy,startedAtMs:number,deadlineAtMs:number}} EvaluationGrant */
/** @param {{grant:EvaluationGrant,ledgerFile:string,now:()=>number,logger:(entry:{event:string,failureKind?:string,persistence?:SQLiteFailure})=>void,accountingMode?:EvaluationAccountingMode,ownerDecision?:EvaluationOwnerDecision,executionAuthority?:EvaluationExecutionAuthority,originalGrantSha256?:string,runtimePolicy?:import('./evaluation-runtime-control.mjs').RuntimePolicy}} command */
export async function openEvaluationGrant(command){
 const {grant:suppliedGrant,ledgerFile,now,logger}=command??{};
 if(command.runtimePolicy!==undefined&&(!isRuntimePolicy(command.runtimePolicy)||command.runtimePolicy.budgetId!==suppliedGrant.id||command.runtimePolicy.originalGrantSha256!==command.originalGrantSha256))throw new EvaluationTransportFailure({kind:'EvaluationExecutionAuthorityConflict'});
 const grant=structuredClone(suppliedGrant);
 if(!record(grant)||Object.keys(grant).sort().join(',')!=='deadlineAtMs,device,id,inode,policy,startedAtMs,storePath'||grant.id!=='owner-approved-image-benchmark'||!text(grant.storePath)||!text(ledgerFile)||![grant.device,grant.inode,grant.startedAtMs,grant.deadlineAtMs].every(count)||typeof now!=='function'||typeof logger!=='function')throw new EvaluationTransportFailure({kind:'EvaluationGrantInvalid'});
 if(command.executionAuthority!==undefined){const a=command.executionAuthority;if(!isEvaluationExecutionAuthority(a)||typeof command.originalGrantSha256!=='string'||!/^[a-f0-9]{64}$/.test(command.originalGrantSha256))throw new EvaluationTransportFailure({kind:'EvaluationExecutionAuthorityInvalid'});if(a.originalGrantSha256!==command.originalGrantSha256||a.budgetId!==grant.id||a.storePath!==grant.storePath||a.device!==grant.device||a.inode!==grant.inode||a.originalStartedAtMs!==grant.startedAtMs||a.originalDeadlineAtMs!==grant.deadlineAtMs)throw new EvaluationTransportFailure({kind:'EvaluationExecutionAuthorityConflict'});}
 const {realpath,stat}=await import('node:fs/promises'),{resolve}=await import('node:path');
 if(resolve(ledgerFile)!==grant.storePath)throw new EvaluationTransportFailure({kind:'EvaluationGrantStoreConflict'});
 let path,identity;try{path=await realpath(ledgerFile);identity=await stat(path);}catch(error){if(record(error)&&error.code==='ENOENT')throw new EvaluationTransportFailure({kind:'EvaluationGrantMissing'});throw error;}
 if(path!==grant.storePath||!identity.isFile()||identity.dev!==grant.device||identity.ino!==grant.inode)throw new EvaluationTransportFailure({kind:'EvaluationGrantStoreConflict'});
 const {DatabaseSync}=await import('node:sqlite'),{statSync,realpathSync}=await import('node:fs');const database=new DatabaseSync(path);
 // No asynchronous gap between opening, checking the opened location and ledger transactions.
 let bindingsVerified=false;
 const validateStore=()=>{let current;try{const location=database.location();if(location!==grant.storePath||realpathSync(location)!==grant.storePath)throw new EvaluationTransportFailure({kind:'EvaluationGrantStoreConflict'});current=statSync(location);}catch(error){if(error instanceof EvaluationTransportFailure)throw error;if(record(error)&&error.code==='ENOENT')throw new EvaluationTransportFailure({kind:'EvaluationGrantStoreConflict'});throw error;}if(!current.isFile()||current.dev!==grant.device||current.ino!==grant.inode)throw new EvaluationTransportFailure({kind:'EvaluationGrantStoreConflict'});if(bindingsVerified){const rows=database.prepare('SELECT * FROM evaluation_budgets').all(),row=rows[0];if(rows.length!==1||!row||row.budget_id!==grant.id||row.policy!==JSON.stringify(grant.policy)||row.started!==grant.startedAtMs||row.deadline!==grant.deadlineAtMs)throw new EvaluationTransportFailure({kind:'EvaluationGrantConflict'});}};
 try{
  validateStore();
  const tables=database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  if(tables.length!==2||tables.some(t=>!['evaluation_budgets','evaluation_reservations'].includes(String(t.name))))throw new EvaluationTransportFailure({kind:'EvaluationGrantMissing'});
  const rows=database.prepare('SELECT * FROM evaluation_budgets').all(),row=rows[0];
  if(rows.length!==1||!row||row.budget_id!==grant.id||row.policy!==JSON.stringify(grant.policy)||row.started!==grant.startedAtMs||row.deadline!==grant.deadlineAtMs||grant.deadlineAtMs-grant.startedAtMs!==grant.policy.maximumMilliseconds)throw new EvaluationTransportFailure({kind:'EvaluationGrantConflict'});
  bindingsVerified=true;let ledgerReturned=false;
  const ledger=createEvaluationLedger({database,budgetId:grant.id,policy:grant.policy,now,logger,accountingMode:command.accountingMode,ownerDecision:command.ownerDecision,executionAuthority:command.executionAuthority,runtimePolicy:command.runtimePolicy,validateStore:()=>{try{validateStore();}catch(error){if(ledgerReturned)database.close();throw error;}}});ledgerReturned=true;return {database,ledger};
 }catch(error){database.close();throw error;}
}
