// @ts-check
import {workflowPersistenceDiagnostic} from './knowledge-workflow-logging.js';
import {waitForTransientRetry} from '../src/features/knowledge-workflows/retry.js';

/** @typedef {import('./knowledge-workflow-d1.js').D1DatabasePort} Database */
const observed=new WeakSet();
/** @type {WeakMap<object,ReturnType<Database['prepare']>>} */
const nativeStatements=new WeakMap();

/** Instrument the binding before repositories project failures. Never log SQL, bindings or raw errors.
 * Only SELECT reads retry; an uncertain write or paid model claim is never repeated here.
 * @param {Database} database
 * @param {(entry:import('./knowledge-workflow-logging.js').KnowledgeWorkflowLogEntry)=>void} logger
 * @param {{now?:()=>number,sleep?:(ms:number)=>Promise<void>,random?:()=>number}} [options]
 * @returns {Database} */
export function observeWorkflowDatabase(database,logger,options={}) {
  if(observed.has(database))return database;
  const now=options.now??Date.now;
  /** @param {string} diagnostic */
  const transient=diagnostic=>['sqlite-busy','d1-overloaded','d1-reset','d1-network'].includes(diagnostic);
  /** @param {string} operation @param {string} diagnosticToken @param {number} attempt */
  async function backoff(operation,diagnosticToken,attempt) {
    const durationMs=await waitForTransientRetry({kind:'DatabaseTransientFailure'},attempt,options.sleep,options.random);
    logger({event:'workflow-database-read-retry',field:operation,diagnosticToken,count:attempt+1,durationMs});
  }
  /** @template T @param {string} operation @param {boolean} read @param {()=>Promise<T>} work */
  async function execute(operation,read,work) {
    const started=now();
    for(let attempt=1;;attempt++) {
      try {
        const result=await work();
        const items=Array.isArray(result)?result:[result];
        let retryDiagnostic;
        for(const item of items)if(item&&typeof item==='object'&&'success' in item&&item.success===false) {
          const error='error' in item?new Error(String(item.error)):new Error('Database returned unsuccessful result');
          const diagnosticToken=workflowPersistenceDiagnostic(error);
          logger({event:'workflow-database-failure',field:operation,diagnosticToken,durationMs:Math.max(0,now()-started),count:attempt});
          if(transient(diagnosticToken))retryDiagnostic=diagnosticToken;
        }
        if(read&&attempt<4&&retryDiagnostic){await backoff(operation,retryDiagnostic,attempt);continue;}
        return result;
      }catch(error) {
        const diagnosticToken=workflowPersistenceDiagnostic(error);
        logger({event:'workflow-database-failure',field:operation,diagnosticToken,durationMs:Math.max(0,now()-started),count:attempt});
        if(!read||attempt===4||!transient(diagnosticToken))throw error;
        await backoff(operation,diagnosticToken,attempt);
      }
    }
  }
  /** @param {ReturnType<Database['prepare']>} native @param {string} operation @param {boolean} read @returns {ReturnType<Database['prepare']>} */
  function statement(native,operation,read) {
    const wrapped={
      /** @param {...(string|number|null)} values */
      bind:(...values)=>statement(native.bind(...values),operation,read),
      first:()=>execute(`${operation}.first`,read,()=>native.first()),
      all:()=>execute(`${operation}.all`,read,()=>native.all()),
      run:()=>execute(`${operation}.run`,false,()=>native.run()),
    };
    nativeStatements.set(wrapped,native);return wrapped;
  }
  const wrapped={
    prepare(/** @type {string} */sql) {
      const verb=/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.exec(sql)?.[1]?.toLowerCase()??'statement';
      const table=/\b(?:FROM|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)\b/i.exec(sql)?.[1]?.toLowerCase()??'unknown';
      try{return statement(database.prepare(sql),`${verb}.${table}`,verb==='select');}
      catch(error){logger({event:'workflow-database-failure',field:`${verb}.${table}.prepare`,diagnosticToken:workflowPersistenceDiagnostic(error),durationMs:0,count:1});throw error;}
    },
    batch:(/** @type {readonly ReturnType<Database['prepare']>[]} */statements)=>execute('batch',false,()=>database.batch(statements.map(s=>nativeStatements.get(s)??s))),
  };
  observed.add(wrapped);return wrapped;
}
