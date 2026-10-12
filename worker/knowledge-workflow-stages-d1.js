// @ts-check
import {AgentExecutionBoundaryFailure} from '../src/features/knowledge-workflows/harness.js';

/** @typedef {import('./knowledge-workflow-content-d1.js').D1DatabasePort} Database */
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:{kind:string,causeKind?:string,status?:number}}} Result */
/** @typedef {{ownerId:string,runId:string}} Scope */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === 'string' && value.trim() !== ''; }

export class D1WorkflowStageRepository {
  /** @type {Database} */ #database;
  /** @type {()=>string} */ #now;
  /** @param {{database:Database,now:()=>string}} dependencies */
  constructor(dependencies) { this.#database = dependencies.database; this.#now = dependencies.now; }

  /** A claimed call is deliberately never retried: its provider charge/output may be unknown.
   * @template T @param {Scope} scope @param {string} key @param {string} inputDigest
   * @param {()=>Promise<Result<T>>} work @param {{resumeSafe?:boolean,modelCall?:boolean,maximumProviderAttempts?:number,recoverClaimed?:(identity:{scope:Scope,key:string,inputDigest:string,createdAt:string})=>Promise<boolean>}} [options] @returns {Promise<Result<T>>} */
  async run(scope, key, inputDigest, work, options={}) {
    if (!text(scope?.ownerId) || !text(scope.runId) || !text(key) || !text(inputDigest)) return {ok:false,error:{kind:'WorkflowStageCommandInvalid'}};
    try {
      const active=await this.#database.prepare("SELECT state FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=? AND state <> 'abandoned' AND NOT EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones WHERE owner_id=? AND run_id=?)").bind(scope.ownerId,scope.runId,scope.ownerId,scope.runId).first();
      if(!record(active))return {ok:false,error:{kind:'WorkflowStageRunUnavailable'}};
      const claimed = await this.#database.prepare("INSERT INTO knowledge_workflow_stages (owner_id,run_id,stage_key,input_digest,status,created_at) SELECT ?,?,?,?,'claimed',? WHERE EXISTS (SELECT 1 FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=? AND state <> 'abandoned') AND NOT EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones WHERE owner_id=? AND run_id=?) ON CONFLICT DO NOTHING").bind(scope.ownerId,scope.runId,key,inputDigest,this.#now(),scope.ownerId,scope.runId,scope.ownerId,scope.runId).run();
      let acquiredCleanClaim=claimed.meta?.changes===1;
      if (!claimed.success) return {ok:false,error:{kind:'WorkflowStagePersistenceFailed'}};
      if (claimed.meta?.changes !== 1) {
        const row = await this.#database.prepare('SELECT input_digest,status,result_json,provider_failures,created_at,failures_json FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND stage_key=?').bind(scope.ownerId,scope.runId,key).first();
        if (!record(row)) return {ok:false,error:{kind:'WorkflowStagePersistenceFailed'}};
        if (row.input_digest !== inputDigest) return {ok:false,error:{kind:'WorkflowStageInputChanged'}};
        if(row.status==='not-started') {
          if(typeof row.provider_failures==='number'&&row.provider_failures>=(options.maximumProviderAttempts??1))return {ok:false,error:{kind:'WorkflowStageProviderRetryLimitReached'}};
          const retry=await this.#database.prepare("UPDATE knowledge_workflow_stages SET status='claimed',result_json=NULL,completed_at=NULL WHERE owner_id=? AND run_id=? AND stage_key=? AND input_digest=? AND status='not-started' AND EXISTS (SELECT 1 FROM knowledge_workflow_runs WHERE owner_id=? AND run_id=? AND state <> 'abandoned') AND NOT EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones WHERE owner_id=? AND run_id=?)").bind(scope.ownerId,scope.runId,key,inputDigest,scope.ownerId,scope.runId,scope.ownerId,scope.runId).run();
          if(!retry.success)return {ok:false,error:{kind:'WorkflowStagePersistenceFailed'}};
          if(retry.meta?.changes!==1)return {ok:false,error:{kind:'WorkflowStageCallUncertain'}};
          const failures=text(row.failures_json)?JSON.parse(row.failures_json):null;
          acquiredCleanClaim=row.provider_failures===0&&Array.isArray(failures)&&failures.length>0&&failures.every(f=>record(f)&&f.notStarted===true&&record(f.failure)&&['EvaluationCancelled','EvaluationDeadlineExceeded','EvaluationBudgetExceeded','EvaluationAccountingHalted'].includes(String(f.failure.kind)));
        } else if (row.status === 'claimed' && !options.resumeSafe && !(options.recoverClaimed&&text(row.created_at)&&await options.recoverClaimed({scope,key,inputDigest,createdAt:row.created_at}))) return {ok:false,error:{kind:'WorkflowStageCallUncertain'}};
        if(row.status==='completed') {
        const result = row.status === 'completed' && text(row.result_json) ? JSON.parse(row.result_json) : null;
        if (!record(result) || !(result.ok === true && 'value' in result || result.ok === false && record(result.error) && text(result.error.kind))) return {ok:false,error:{kind:'WorkflowStagePersistenceFailed'}};
        return /** @type {Result<T>} */ (result);
        }
      }
      let result;
      try { result = await work(); } catch (error) {
        if (error instanceof AgentExecutionBoundaryFailure) {
          if(options.modelCall===true&&!options.resumeSafe&&!acquiredCleanClaim)error.notStarted=false;
          // Only a fresh claim or its atomically reclaimed zero-start history can prove that no prior work began.
          if(options.modelCall===true&&!options.resumeSafe&&acquiredCleanClaim&&error.notStarted===true&&['EvaluationCancelled','EvaluationDeadlineExceeded','EvaluationBudgetExceeded','EvaluationAccountingHalted'].includes(error.failure.kind)){
            const at=this.#now();
            try {
            const saved=await this.#database.prepare("UPDATE knowledge_workflow_stages SET status='not-started',result_json=?,completed_at=?,failures_json=json_insert(failures_json,'$[#]',json(?)) WHERE owner_id=? AND run_id=? AND stage_key=? AND input_digest=? AND status='claimed'").bind(JSON.stringify({ok:false,error:error.failure}),at,JSON.stringify({occurredAt:at,failure:error.failure,notStarted:true}),scope.ownerId,scope.runId,key,inputDigest).run();
            if(!saved.success||saved.meta?.changes!==1){error.notStarted=false;error.cause=new Error('WorkflowStagePersistenceFailed',{cause:error.cause});}
            } catch(persistenceError){error.notStarted=false;error.cause=new Error('WorkflowStagePersistenceFailed',{cause:persistenceError});}
          }
          throw error;
        }
        if (!(error instanceof Error)) throw error;
        return {ok:false,error:{kind:'WorkflowStageCallUncertain'}};
      }
      if(!result.ok) {
        if(options.resumeSafe)return result;
        if(['KnowledgeModelTimeout','KnowledgeModelCancelled','KnowledgeModelUnavailable','KnowledgeModelResponseReadFailed','AgentLedgerPersistenceFailed'].includes(result.error.kind))return {ok:false,error:{kind:'WorkflowStageCallUncertain',causeKind:result.error.kind}};
        const knownRefusal=result.error.kind==='KnowledgeModelRejected'&&[401,403,429,503].includes(result.error.status??0);
        if(knownRefusal||['KnowledgeModelCredentialMissing','KnowledgeModelCommandInvalid','WorkflowExtractionClockInvalid','WebpageImageBudgetNotEvaluated','WebpageImageAttemptDeadlineExceeded'].includes(result.error.kind)) {
          const saved=await this.#database.prepare("UPDATE knowledge_workflow_stages SET status='not-started',result_json=?,completed_at=?,failures_json=json_insert(failures_json,'$[#]',json(?)),provider_failures=provider_failures+? WHERE owner_id=? AND run_id=? AND stage_key=? AND input_digest=? AND status='claimed'").bind(JSON.stringify(result),this.#now(),JSON.stringify({occurredAt:this.#now(),failure:result.error}),knownRefusal&&[429,503].includes(result.error.status??0)?1:0,scope.ownerId,scope.runId,key,inputDigest).run();
          return saved.success&&saved.meta?.changes===1?result:{ok:false,error:{kind:'WorkflowStagePersistenceFailed'}};
        }
      }
      const saved = await this.#database.prepare("UPDATE knowledge_workflow_stages SET status='completed',result_json=?,completed_at=? WHERE owner_id=? AND run_id=? AND stage_key=? AND input_digest=? AND status='claimed' AND NOT EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones WHERE owner_id=? AND run_id=?)").bind(JSON.stringify(result),this.#now(),scope.ownerId,scope.runId,key,inputDigest,scope.ownerId,scope.runId).run();
      return saved.success && saved.meta?.changes === 1 ? result : {ok:false,error:{kind:'WorkflowStagePersistenceFailed'}};
    } catch (error) {
      if (error instanceof AgentExecutionBoundaryFailure) throw error;
      if (!(error instanceof Error)) throw error;
      return {ok:false,error:{kind:'WorkflowStagePersistenceFailed'}};
    }
  }
}
