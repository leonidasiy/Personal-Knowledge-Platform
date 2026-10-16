// @ts-check

/** @param {string|null} value @param {number} now @returns {number|undefined} */
export function retryAfterMilliseconds(value, now) {
  if(value===null)return undefined;
  const seconds=/^\d+(?:\.\d+)?$/.test(value.trim())?Number(value):NaN;
  const delay=Number.isFinite(seconds)?seconds*1000:Date.parse(value)-now;
  return Number.isFinite(delay)&&delay>=0&&delay<=2_147_483_647?Math.ceil(delay):undefined;
}

/** Format repair remains immediate; only known transport/congestion failures wait.
 * @param {unknown} failure @param {number} attempt @param {()=>number} [random] */
export function transientRetryDelay(failure, attempt, random=Math.random) {
  if(!failure||typeof failure!=='object')return 0;
  const value=/** @type {{kind?:string,status?:number,retryAfterMs?:number,causeKind?:string}} */(failure);
  if(value.kind==='KnowledgeModelRejected'&&![408,429,500,502,503,504].includes(value.status??0)||!['KnowledgeModelRejected','KnowledgeModelUnavailable','KnowledgeModelResponseReadFailed','DatabaseTransientFailure'].includes(value.kind??''))return 0;
  const backoff=Math.ceil(Math.min(30_000,500*2**(attempt-1))*(0.5+random()*0.5));
  return Math.max(backoff,Number.isSafeInteger(value.retryAfterMs)&&/** @type {number} */(value.retryAfterMs)>=0?/** @type {number} */(value.retryAfterMs):0);
}

/** @param {unknown} failure @param {number} attempt @param {(ms:number)=>Promise<void>} [sleep] @param {()=>number} [random] */
export async function waitForTransientRetry(failure,attempt,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),random=Math.random) {
  const delay=transientRetryDelay(failure,attempt,random);
  if(delay)await sleep(delay);
  return delay;
}
