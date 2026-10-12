// @ts-check
/** @typedef {{version:string,provenance:string,candidateEvaluationsPerPage:number,decodedImageBytesPerPage:number}} WebpageImagePolicy */
/** Owner answered 2026-10-06: 32 candidate evaluations, 128 MiB decoded image data/page.
 * Request limits remain the existing 8 attachments / 32 MiB / 20 MiB per image.
 * @type {Readonly<WebpageImagePolicy>} */
export const WEBPAGE_IMAGE_POLICY=Object.freeze({version:'owner-2026-10-06',provenance:'Owner final-approved image closure, 2026-10-06',candidateEvaluationsPerPage:32,decodedImageBytesPerPage:128*1024*1024});
/** Existing authoritative website extraction limits; no new run defaults. */
export const WEBPAGE_EXTRACTION_POLICY=Object.freeze({maximumFrontier:500,maximumPageBytes:1_000_000,maximumRedirects:3,maximumPages:100,maximumDurationMs:30*60*1_000,maximumPagesPerExecution:5});
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:{kind:string}}} Result */
/** @typedef {{key:string,evaluations:number,decodedBytes:number,timeoutMs:number}} ImageAttempt */
/** @typedef {{reserve:(attempt:ImageAttempt)=>Promise<Result<{deadlineAtMs:number,maximumBytes:number}>>,settle:(key:string,decodedBytes:number)=>Promise<Result<null>>}} ImageBudget */
/** @typedef {ImageBudget&{lookup:(key:string)=>Promise<Result<Record<string,unknown>|null>>,complete:(key:string,output:Record<string,unknown>)=>Promise<Result<null>>}} PersistentImageBudget */
/** @param {unknown} p @returns {p is WebpageImagePolicy} */
export function isWebpageImagePolicy(p){return typeof p==='object'&&p!==null&&'version'in p&&typeof p.version==='string'&&p.version.trim()!==''&&'provenance'in p&&typeof p.provenance==='string'&&p.provenance.trim()!==''&&'candidateEvaluationsPerPage'in p&&Number.isSafeInteger(p.candidateEvaluationsPerPage)&&Number(p.candidateEvaluationsPerPage)>0&&'decodedImageBytesPerPage'in p&&Number.isSafeInteger(p.decodedImageBytesPerPage)&&Number(p.decodedImageBytesPerPage)>0;}
/** Durable reservations precede side effects. Crashed/failed reads retain their
 * worst-case reservation; completed reads reconcile to actual decoded bytes.
 * ponytail: uncertain reads retain their full reservation; reconcile only from verified transport accounting.
 * @param {{database:import('./knowledge-workflow-content-d1.js').D1DatabasePort,policy:WebpageImagePolicy,scope:{ownerId:string,runId:string,pageUrl:string},maximumPages:number,deadlineAtMs:number,now:()=>number,logger:(entry:{event:string,failureKind?:string})=>void}} deps
 * @returns {PersistentImageBudget} */
export function createWebpageImageBudget(deps){
 if(!isWebpageImagePolicy(deps?.policy)||!Number.isSafeInteger(deps.maximumPages)||deps.maximumPages<=0||!Number.isSafeInteger(deps.deadlineAtMs)||deps.deadlineAtMs<=0||typeof deps.now!=='function'||typeof deps.logger!=='function'||!deps.scope?.ownerId||!deps.scope.runId||!URL.canParse(deps.scope.pageUrl)||new URL(deps.scope.pageUrl).protocol!=='https:'||typeof deps.database?.prepare!=='function')throw new TypeError('WebpageImageBudgetConfigurationInvalid');
 const {ownerId,runId,pageUrl}=deps.scope,p=deps.policy;
 /** @param {string} kind @returns {{ok:false,error:{kind:string}}} */
 const failed=kind=>{deps.logger({event:'webpage-image-budget-failure',failureKind:kind});return {ok:false,error:{kind}};};
 return {
  async lookup(key){
   if(typeof key!=='string'||!key.trim())return failed('WebpageImageBudgetCommandInvalid');
   deps.logger({event:'webpage-image-budget-lookup-entry'});
   try{const row=await deps.database.prepare(`SELECT output_json,policy_json FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=? AND page_url=? AND attempt_key=? AND EXISTS(SELECT 1 FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=? AND state<>'abandoned') AND NOT EXISTS(SELECT 1 FROM knowledge_workflow_run_tombstones WHERE owner_id=? AND run_id=?)`).bind(ownerId,runId,pageUrl,key,ownerId,runId,ownerId,runId).first();
    if(row===null)return {ok:true,value:null};
    if(typeof row!=='object'||!('policy_json'in row)||row.policy_json!==JSON.stringify(p)||!('output_json'in row))return failed('WebpageImageBudgetPersistenceFailed');
    if(row.output_json===null)return {ok:true,value:null};
    if(typeof row.output_json!=='string')return failed('WebpageImageBudgetPersistenceFailed');
    const output=JSON.parse(row.output_json);if(typeof output!=='object'||output===null||Array.isArray(output))return failed('WebpageImageBudgetPersistenceFailed');
    deps.logger({event:'webpage-image-budget-replay-success'});return {ok:true,value:output};
   }catch(error){if(!(error instanceof Error))throw error;return failed('WebpageImageBudgetPersistenceFailed');}
  },
  async complete(key,output){
   if(typeof key!=='string'||!key.trim()||typeof output!=='object'||output===null||Array.isArray(output))return failed('WebpageImageBudgetCommandInvalid');
   deps.logger({event:'webpage-image-budget-model-complete-entry'});
   try{const result=await deps.database.prepare(`UPDATE knowledge_workflow_image_attempts SET output_json=? WHERE owner_id=? AND run_id=? AND page_url=? AND attempt_key=? AND output_json IS NULL AND deadline_at_ms>? AND EXISTS(SELECT 1 FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=? AND state<>'abandoned') AND NOT EXISTS(SELECT 1 FROM knowledge_workflow_run_tombstones WHERE owner_id=? AND run_id=?)`).bind(JSON.stringify(output),ownerId,runId,pageUrl,key,deps.now(),ownerId,runId,ownerId,runId).run();
    if(!result.success||result.meta?.changes!==1)return failed('WebpageImageBudgetModelCompletionFailed');deps.logger({event:'webpage-image-budget-model-complete-success'});return {ok:true,value:null};
   }catch(error){if(!(error instanceof Error))throw error;return failed('WebpageImageBudgetPersistenceFailed');}
  },
  async reserve(a){
   if(!a||typeof a.key!=='string'||!a.key.trim()||![a.evaluations,a.decodedBytes,a.timeoutMs].every(Number.isSafeInteger)||a.evaluations<0||a.decodedBytes<0||a.timeoutMs<=0)return failed('WebpageImageBudgetCommandInvalid');
   const now=deps.now();if(!Number.isSafeInteger(now)||now<0)return failed('WebpageImageBudgetClockInvalid');
   if(now>=deps.deadlineAtMs)return failed('WebpageImageRunDeadlineExceeded');
   const deadline=Math.min(deps.deadlineAtMs,now+a.timeoutMs);
   deps.logger({event:'webpage-image-budget-entry'});
   try{
    const result=await deps.database.prepare(`INSERT INTO knowledge_workflow_image_attempts(owner_id,run_id,page_url,attempt_key,policy_version,policy_json,evaluations,decoded_bytes,deadline_at_ms,settled) SELECT ?,?,?,?,?,?,?,MIN(?,? - COALESCE((SELECT SUM(decoded_bytes) FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=? AND page_url=?),0),? - COALESCE((SELECT SUM(decoded_bytes) FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=?),0)),?,0
     WHERE EXISTS(SELECT 1 FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=? AND state <> 'abandoned')
     AND NOT EXISTS(SELECT 1 FROM knowledge_workflow_run_tombstones WHERE owner_id=? AND run_id=?)
     AND NOT EXISTS(SELECT 1 FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=? AND policy_json<>?)
     AND COALESCE((SELECT SUM(evaluations) FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=? AND page_url=?),0)+?<=?
     AND (?=0 OR COALESCE((SELECT SUM(decoded_bytes) FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=? AND page_url=?),0)<?)
     AND COALESCE((SELECT SUM(evaluations) FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=?),0)+?<=?
     AND (?=0 OR COALESCE((SELECT SUM(decoded_bytes) FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=?),0)<?)
     AND ((?<>'page-acquisition' AND ?=0 AND ?=0) OR EXISTS(SELECT 1 FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=? AND page_url=? AND (evaluations>0 OR decoded_bytes>0 OR attempt_key='page-acquisition')) OR (SELECT COUNT(DISTINCT page_url) FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=? AND (evaluations>0 OR decoded_bytes>0 OR attempt_key='page-acquisition'))<?)
     ON CONFLICT(owner_id,run_id,page_url,attempt_key) DO NOTHING RETURNING deadline_at_ms,decoded_bytes`).bind(ownerId,runId,pageUrl,a.key,p.version,JSON.stringify(p),a.evaluations,a.decodedBytes,p.decodedImageBytesPerPage,ownerId,runId,pageUrl,p.decodedImageBytesPerPage*deps.maximumPages,ownerId,runId,deadline,ownerId,runId,ownerId,runId,ownerId,runId,JSON.stringify(p),ownerId,runId,pageUrl,a.evaluations,p.candidateEvaluationsPerPage,a.decodedBytes,ownerId,runId,pageUrl,p.decodedImageBytesPerPage,ownerId,runId,a.evaluations,p.candidateEvaluationsPerPage*deps.maximumPages,a.decodedBytes,ownerId,runId,p.decodedImageBytesPerPage*deps.maximumPages,a.key,a.evaluations,a.decodedBytes,ownerId,runId,pageUrl,ownerId,runId,deps.maximumPages).first();
    if(result===null)return failed('WebpageImageBudgetNotEvaluated');
    if(typeof result!=='object'||!('deadline_at_ms'in result)||result.deadline_at_ms!==deadline||!('decoded_bytes'in result)||typeof result.decoded_bytes!=='number'||!Number.isSafeInteger(result.decoded_bytes)||result.decoded_bytes<0||result.decoded_bytes>a.decodedBytes)return failed('WebpageImageBudgetPersistenceFailed');
    deps.logger({event:'webpage-image-budget-success'});return {ok:true,value:{deadlineAtMs:deadline,maximumBytes:result.decoded_bytes}};
   }catch(error){if(!(error instanceof Error))throw error;return failed('WebpageImageBudgetPersistenceFailed');}
  },
  async settle(key,decodedBytes){
   if(typeof key!=='string'||!key.trim()||!Number.isSafeInteger(decodedBytes)||decodedBytes<0)return failed('WebpageImageBudgetCommandInvalid');
   try{const result=await deps.database.prepare(`UPDATE knowledge_workflow_image_attempts SET decoded_bytes=?,settled=1 WHERE owner_id=? AND run_id=? AND page_url=? AND attempt_key=? AND settled=0 AND decoded_bytes>=? AND EXISTS(SELECT 1 FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=? AND state<>'abandoned') AND NOT EXISTS(SELECT 1 FROM knowledge_workflow_run_tombstones WHERE owner_id=? AND run_id=?)`).bind(decodedBytes,ownerId,runId,pageUrl,key,decodedBytes,ownerId,runId,ownerId,runId).run();return result.success&&result.meta?.changes===1?{ok:true,value:null}:failed('WebpageImageBudgetSettlementFailed');}catch(error){if(!(error instanceof Error))throw error;return failed('WebpageImageBudgetPersistenceFailed');}
  }
 };
}
