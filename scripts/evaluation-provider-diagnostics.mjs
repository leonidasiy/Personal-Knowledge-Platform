// @ts-check
import {projectProviderMessage,isProviderMessage} from '../worker/provider-error.js';
// Closed canonical vocabulary: OpenRouter errors-and-debugging, retrieved 2026-10-07.
export const errorTypes=Object.freeze(['context_length_exceeded', 'max_tokens_exceeded', 'token_limit_exceeded', 'string_too_long', 'authentication', 'permission_denied', 'payment_required', 'rate_limit_exceeded', 'provider_overloaded', 'provider_unavailable', 'invalid_request', 'invalid_prompt', 'not_found', 'precondition_failed', 'payload_too_large', 'unprocessable', 'content_policy_violation', 'refusal', 'invalid_image', 'image_too_large', 'image_too_small', 'unsupported_image_format', 'image_not_found', 'image_download_failed', 'server', 'timeout', 'unmapped']);
export const limitSources=Object.freeze(['openrouter_in_flight_budget','openrouter_key_limit','openrouter_credits']);
export const reasons=Object.freeze(['in_flight_budget_exhausted','weight_exceeds_budget']);
/** @typedef {{source:'delta-seconds'|'http-date',retryAtMs:number}} RetryAfter */
/** @typedef {Partial<import('../worker/provider-error.js').ProviderMessage> & {authenticated:boolean,capturedAtMs:number,errorType:string,reason:string,limitSource:string,providerCode:string,providerIdentifier:'unknown',retryAfter:{source:'missing'|'invalid'|'delta-seconds'|'http-date',retryAtMs?:number},rateLimit:{limit?:number,remaining?:number,reset?:number},noExecutionEvidence:boolean}} ProviderFailure */
/** Preserve opaque upstream tokens without accepting prose, echoes or credentials. @param {unknown} value @param {readonly unknown[]} [privateInputs] @returns {value is string} */
function isProviderCode(value,privateInputs=[]){return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)&&projectProviderMessage(value,privateInputs).messageDisposition==='retained';}
/** @param {unknown} value @param {number} now @returns {{ok:true,value:RetryAfter}|{ok:false,error:{kind:'EvaluationRetryAfterInvalid'}}} */
export function parseRetryAfter(value,now){
 if(!Number.isSafeInteger(now)||now<0)throw new TypeError('EvaluationClockInvalid');
 if(typeof value==='string'&&/^(0|[1-9][0-9]{0,4})$/.test(value)&&Number(value)<=86400&&Number.isSafeInteger(now+Number(value)*1000))return {ok:true,value:{source:'delta-seconds',retryAtMs:now+Number(value)*1000}};
 if(typeof value==='string'&&/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)){
  const date=Date.parse(value);if(Number.isFinite(date)&&new Date(date).toUTCString()===value&&date>=now&&date-now<=86400000)return {ok:true,value:{source:'http-date',retryAtMs:date}};
 }
 return {ok:false,error:{kind:'EvaluationRetryAfterInvalid'}};
}
/** No provider-string allowlist has authoritative composition metadata yet: preserve named unknown.
 * @param {unknown} document @param {Headers} headers @param {number} now @param {boolean} authenticated @param {readonly unknown[]} [privateInputs] @returns {ProviderFailure} */
export function projectProviderFailure(document,headers,now,authenticated,privateInputs=[]){
 if(!(headers instanceof Headers)||typeof authenticated!=='boolean'||!Number.isSafeInteger(now)||now<0)throw new TypeError('EvaluationDiagnosticsCommandInvalid');
 const object=(/** @type {unknown} */v)=>typeof v==='object'&&v!==null&&!Array.isArray(v);
 const d=object(document)?/** @type {Record<string,unknown>} */(document):{};
 const error=object(d.error)?/** @type {Record<string,unknown>} */(d.error):{};
 const metadata=object(error.metadata)?/** @type {Record<string,unknown>} */(error.metadata):{};
 const retry=headers.get('retry-after'),parsed=retry===null?null:parseRetryAfter(retry,now);
 /** @type {{limit?:number,remaining?:number,reset?:number}} */const rateLimit={};
 for(const [header,key] of /** @type {[string,'limit'|'remaining'|'reset'][]} */([['x-ratelimit-limit','limit'],['x-ratelimit-remaining','remaining'],['x-ratelimit-reset','reset']])){const v=headers.get(header);if(v!==null&&/^(0|[1-9][0-9]{0,14})$/.test(v)&&Number.isSafeInteger(Number(v)))rateLimit[key]=Number(v);}
 const excluded=[...privateInputs,d.input,d.output,d.prompt,d.answer,d.choices];
 return {...projectProviderMessage(error.message,excluded),authenticated,capturedAtMs:now,errorType:typeof metadata.error_type==='string'&&errorTypes.includes(metadata.error_type)?metadata.error_type:'unknown',reason:typeof metadata.reason==='string'&&reasons.includes(metadata.reason)?metadata.reason:'unknown',limitSource:typeof metadata.limit_source==='string'&&limitSources.includes(metadata.limit_source)?metadata.limit_source:'unknown',providerCode:isProviderCode(metadata.provider_code,excluded)?metadata.provider_code:'unknown',providerIdentifier:'unknown',retryAfter:retry===null?{source:'missing'}:parsed?.ok?parsed.value:{source:'invalid'},rateLimit,noExecutionEvidence:object(d.error)&&[429,502,503].includes(Number(error.code))&&!Object.hasOwn(d,'id')&&!Object.hasOwn(d,'choices')};
}
/** @param {unknown} value @returns {value is ProviderFailure} */
export function isProviderFailure(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const v=/** @type {Record<string,unknown>} */(value);
 const integer=(/** @type {unknown} */n)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
 const legacy=Object.keys(v).sort().join(',')==='authenticated,capturedAtMs,errorType,limitSource,noExecutionEvidence,providerCode,providerIdentifier,rateLimit,reason,retryAfter';
 if(!legacy&&Object.keys(v).sort().join(',')!=='authenticated,capturedAtMs,errorMessage,errorType,limitSource,messageDisposition,noExecutionEvidence,providerCode,providerIdentifier,rateLimit,reason,retryAfter'||(!legacy&&!isProviderMessage({errorMessage:v.errorMessage,messageDisposition:v.messageDisposition}))||typeof v.authenticated!=='boolean'||!integer(v.capturedAtMs)||typeof v.noExecutionEvidence!=='boolean'||typeof v.errorType!=='string'||!['unknown',...errorTypes].includes(v.errorType)||typeof v.reason!=='string'||!['unknown',...reasons].includes(v.reason)||typeof v.limitSource!=='string'||!['unknown',...limitSources].includes(v.limitSource)||!isProviderCode(v.providerCode)||v.providerIdentifier!=='unknown')return false;
 const r=/** @type {Record<string,unknown>} */(v.retryAfter),h=/** @type {Record<string,unknown>} */(v.rateLimit);
 return !!r&&typeof r==='object'&&!Array.isArray(r)&&['missing','invalid','delta-seconds','http-date'].includes(String(r.source))&&Object.keys(r).sort().join(',')===(['missing','invalid'].includes(String(r.source))?'source':'retryAtMs,source')&&(r.retryAtMs===undefined||integer(r.retryAtMs)&&Number(r.retryAtMs)>=Number(v.capturedAtMs)&&Number(r.retryAtMs)-Number(v.capturedAtMs)<=86400000)&&!!h&&typeof h==='object'&&!Array.isArray(h)&&Object.keys(h).every(k=>['limit','remaining','reset'].includes(k)&&integer(h[k]));
}
