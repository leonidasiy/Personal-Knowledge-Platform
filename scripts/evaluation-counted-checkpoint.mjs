// @ts-check
import {isEvaluationExecutionAuthority} from './evaluation-budget.mjs';
import {evaluationHash,reportWholeCases} from './webpage-image-evaluation.mjs';
/** @typedef {import('./webpage-image-evaluation.mjs').WholeCaseRow} Row */
/** @typedef {import('./evaluation-budget.mjs').LedgerDatabase} Database */
/** @param {{database:Database,authority:import('./evaluation-budget.mjs').EvaluationExecutionAuthority,iterationId:string,cases:import('./webpage-image-evaluation.mjs').EvaluationCase[],priorRows:Row[],pauseAfterNextDevelopmentCase:boolean}} command */
export function createCountedCheckpoint(command){
 if(!command||typeof command!=='object')throw new TypeError('EvaluationCheckpointInvalid');
 const {database:db,authority,iterationId,cases,priorRows,pauseAfterNextDevelopmentCase}=command;
 if(!db||typeof db.prepare!=='function'||typeof db.exec!=='function'||!isEvaluationExecutionAuthority(authority)||typeof iterationId!=='string'||!iterationId||typeof pauseAfterNextDevelopmentCase!=='boolean'||!reportWholeCases(cases,priorRows).ok||priorRows.length!==(authority.new45?0:5))throw new TypeError('EvaluationCheckpointInvalid');
 const authorityHash=evaluationHash(authority),column=authority.new45?'new45_checkpoints':'counted_checkpoints';
 const fail=(/** @type {string} */ kind)=>({ok:/** @type {const} */(false),error:{kind}});
 const read=()=>{
  const budget=/** @type {{counted_checkpoints:string|null}} */(db.prepare(`SELECT ${column} AS counted_checkpoints FROM evaluation_budgets WHERE budget_id=?`).get(authority.budgetId));
  if(!budget)throw new TypeError('EvaluationCheckpointStoreConflict');
  /** @type {{authorityHash:string,caseId:string,split:'development'|'holdout',row?:Row,receipts?:unknown[],receiptHash?:string}[]} */const events=budget.counted_checkpoints===null?[]:JSON.parse(budget.counted_checkpoints);
  if(!Array.isArray(events)||events.some(e=>!e||typeof e!=='object'||e.authorityHash!==authorityHash||!cases.some(c=>c.id===e.caseId&&c.split===e.split)||priorRows.some(r=>r.caseId===e.caseId)))throw new TypeError('EvaluationCheckpointProvenanceInvalid');
  return events;
 };
 const receipts=(/** @type {string} */ caseId)=>db.prepare('SELECT * FROM evaluation_reservations ORDER BY rowid').all().filter(r=>typeof r==='object'&&r!==null&&'key' in r&&typeof r.key==='string'&&r.key.startsWith(iterationId+':'+caseId+':'));
 const append=(/** @type {ReturnType<typeof read>[number]} */ event)=>{db.exec('BEGIN IMMEDIATE');try{const events=read();if(events.some(e=>e.caseId===event.caseId&&(event.row?e.row!==undefined:true)))throw new TypeError('EvaluationCheckpointReplayForbidden');events.push(event);db.prepare(`UPDATE evaluation_budgets SET ${column}=? WHERE budget_id=?`).run(JSON.stringify(events),authority.budgetId);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}};
 /** @returns {Row[]} */const rows=()=>{
  const events=read();
  const terminal=events.filter(e=>e.row);
  for(const e of terminal){if(!e.row||e.row.caseId!==e.caseId||e.row.split!==e.split||e.receiptHash!==evaluationHash(e.receipts)||evaluationHash(receipts(e.caseId))!==e.receiptHash||!reportWholeCases(cases,[/** @type {Row} */(e.row)]).ok)throw new TypeError('EvaluationCheckpointReceiptConflict');}
  // A started case cannot be replayed after interruption, even with a different request hash.
  return [...priorRows,...events.filter(e=>!e.row).map(e=>terminal.find(t=>t.caseId===e.caseId)?.row??{caseId:e.caseId,split:e.split,status:/** @type {const} */('failed'),passes:false,judgeResultRefs:[],terminalReason:'EvaluationCheckpointInterrupted'})];
 };
 const countedBoundary={pauseAfterNextDevelopmentCase,
  /** @param {{caseId:string,split:'development'|'holdout'}} item */
  beforeCase:async item=>{if(!item||typeof item!=='object'||typeof item.caseId!=='string'||!['development','holdout'].includes(item.split))return fail('EvaluationCheckpointInvalid');if(!cases.some(c=>c.id===item.caseId&&c.split===item.split)||rows().some(r=>r.caseId===item.caseId))return fail('EvaluationCheckpointReplayForbidden');const next=cases.filter(c=>c.split==='development').find(c=>!rows().some(r=>r.caseId===c.id));if(pauseAfterNextDevelopmentCase&&(authority.new45?.canaryCaseId??next?.id)!==item.caseId)return fail('EvaluationCanarySelectionConflict');append({authorityHash,...item});return {ok:/** @type {const} */(true),value:null};},
  /** @param {Row} row */
  afterCase:async row=>{
   if(!row||typeof row!=='object')return fail('EvaluationCheckpointInvalid');
   if(!read().some(e=>e.caseId===row.caseId&&!e.row)||!reportWholeCases(cases,[row]).ok)return fail('EvaluationCheckpointInvalid');
   const saved=receipts(row.caseId);
   if(row.status==='completed'){
    const b=/** @type {{rate_recovery_v3_events?:string}} */(db.prepare('SELECT * FROM evaluation_budgets WHERE budget_id=?').get(authority.budgetId));
    /** @type {{kind:string,key:string}[]} */const admitted=authority.new45?JSON.parse(b.rate_recovery_v3_events??'[]'):[];
    if(!saved.length||saved.some(r=>!r||typeof r!=='object'||!('response' in r)||r.response===null&&(!('key' in r)||!admitted.some(e=>e.kind==='admit'&&e.key===r.key))))return fail('EvaluationCheckpointReceiptConflict');
    for(const ref of row.judgeResultRefs){const [task,hash]=ref.split('#');if(!saved.some(r=>r&&typeof r==='object'&&'key' in r&&typeof r.key==='string'&&r.key.startsWith(iterationId+':'+task+':')&&'response' in r&&typeof r.response==='string'&&evaluationHash(JSON.parse(JSON.parse(r.response).choices[0].message.content))===hash))return fail('EvaluationCheckpointJudgeConflict');}
   }
   append({authorityHash,caseId:row.caseId,split:row.split,row,receipts:saved,receiptHash:evaluationHash(saved)});
   if(evaluationHash(rows().find(r=>r.caseId===row.caseId))!==evaluationHash(row))return fail('EvaluationCheckpointReadbackFailed');
   return {ok:/** @type {const} */(true),value:null};
  }};
 return {rows,countedBoundary};
}
