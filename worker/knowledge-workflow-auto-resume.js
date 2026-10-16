// @ts-check
import {createKnowledgeWorkflowService, isWorkflowRetryStage} from '../src/features/knowledge-workflows/workflow.js';
import {D1KnowledgeWorkflowRepository} from './knowledge-workflow-d1.js';
import {deliverKnowledgeWorkflowControl, workflowInstanceId, workflowControlRollback} from './main.js';
import {workflowPersistenceDiagnostic} from './knowledge-workflow-logging.js';

/** Resume only interrupted work; explicit pauses, consent decisions and terminal runs stay authoritative.
 * @param {{database:import('./knowledge-workflow-d1.js').D1DatabasePort,binding:import('./main.js').KnowledgeWorkflowBinding,ownerId:string,now:()=>string,logger:(entry:import('./knowledge-workflow-logging.js').KnowledgeWorkflowLogEntry)=>void}} dependencies
 * @returns {Promise<{ok:true,value:number}|{ok:false,error:{kind:string}}>}
 */
export async function resumeInterruptedKnowledgeWorkflows({database,binding,ownerId,now,logger}) {
  const service=createKnowledgeWorkflowService(new D1KnowledgeWorkflowRepository({database,logger}),{now,createId:()=>crypto.randomUUID(),logger});
  let resumed=0;
  try {
    const selected=await database.prepare("SELECT r.run_id FROM knowledge_workflow_runs r JOIN library_sources s ON s.owner_id=r.owner_id AND s.source_id=r.source_id AND s.revision=r.source_revision AND s.state='active' WHERE r.owner_id=? AND r.state IN ('rights-assessment','robots-check','extraction-loop','extraction-finalized','per-point-quiz-loop','retryable-failure','awaiting-time-limit-decision') AND r.run_id=(SELECT latest.run_id FROM knowledge_workflow_runs latest WHERE latest.owner_id=r.owner_id AND latest.source_id=r.source_id AND latest.source_revision=r.source_revision ORDER BY latest.created_at DESC,latest.run_id DESC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id=r.owner_id AND t.run_id=r.run_id) ORDER BY r.updated_at,r.run_id").bind(ownerId).all();
    if(!selected.success)return {ok:false,error:{kind:'WorkflowAutoResumeQueryFailed'}};
    for(const row of selected.results) {
      if(!row||typeof row!=='object'||!('run_id' in row)||typeof row.run_id!=='string')return {ok:false,error:{kind:'WorkflowAutoResumeRowInvalid'}};
      const loaded=await service.status({ownerId,runId:row.run_id});
      if(!loaded.ok)return loaded;
      const run=loaded.value;
      const currentTime=Date.parse(now());
      if(!Number.isFinite(currentTime))throw new TypeError('Workflow auto-resume clock is invalid.');
      if(!(isWorkflowRetryStage(run.state)||run.state==='retryable-failure'||run.state==='awaiting-time-limit-decision'))continue;
      const instance=await binding.get(workflowInstanceId(run.runId));
      if(typeof instance.status!=='function')throw new TypeError('Workflow instance status is unavailable.');
      const status=(await instance.status()).status;
      if(isWorkflowRetryStage(run.state)) {
        if(status!=='errored')continue;
        // Persist discovery time: an old checkpoint is not the time the crash happened.
        const marked=await service.advance({ownerId,runId:run.runId,expectedRevision:run.revision,nextState:'retryable-failure',failureKind:'WorkflowExecutionStopped'});
        if(!marked.ok&&marked.error.kind!=='WorkflowControlStale')return marked;
        continue;
      }
      if(currentTime-Date.parse(run.updatedAt)<120_000)continue;
      if(run.state==='awaiting-time-limit-decision'&&(run.extractionDeadlineAt===null||currentTime<Date.parse(run.extractionDeadlineAt)+120_000))continue;
      if(!['waiting','errored','complete'].includes(status))continue;
      const command={ownerId,runId:run.runId,expectedRevision:run.revision,action:'resume',idempotencyKey:`auto-resume:${crypto.randomUUID()}`};
      const controlled=await service.control(command);
      if(!controlled.ok) {
        if(['WorkflowControlStale','WorkflowControlInvalid'].includes(controlled.error.kind))continue;
        return controlled;
      }
      try {await deliverKnowledgeWorkflowControl(instance,'resume',status==='complete');}
      catch(error) {
        const rollback=workflowControlRollback(command,loaded,controlled)??{ownerId,runId:run.runId,expectedRevision:controlled.value.revision,nextState:/** @type {const} */('retryable-failure'),failureKind:'WorkflowInstanceControlFailed'};
        const restored=await service.advance(rollback);
        if(!restored.ok)return restored;
        throw error;
      }
      resumed++;
      logger({event:'knowledge-workflow-auto-resume-success',ownerId,runId:run.runId,count:resumed});
    }
    return {ok:true,value:resumed};
  }catch(error) {
    if(!(error instanceof Error))throw error;
    logger({event:'knowledge-workflow-auto-resume-failure',failureKind:'WorkflowAutoResumeFailed',diagnosticToken:workflowPersistenceDiagnostic(error)});
    return {ok:false,error:{kind:'WorkflowAutoResumeFailed'}};
  }
}
