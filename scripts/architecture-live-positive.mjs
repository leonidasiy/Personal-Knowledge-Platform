import process from 'node:process';
// Offline preparation only. Paid activation belongs to the canonical authority runner.
const {DatabaseSync}=await import('node:sqlite');
import {readFile,readdir,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createKnowledgeWorkflowRuntime} from '../worker/knowledge-workflow-runtime.js';
import {createEvaluationTransport} from './evaluation-budget.mjs';
import {validateEvaluationRoleProfiles,createEvaluationRoleGenerate} from './webpage-image-evaluation.mjs';
/** @param {unknown} v @returns {v is Record<string,unknown>} */
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
/** @param {import("node:crypto").BinaryLike} b */
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
/** Preparation metadata never contains credentials, model answers, or frozen gold.
 * @param {unknown} value */
export function validatePositivePreparation(value){
 const issues=[];if(!object(value)||value.version!=='positive-canary-v1')return {ok:/** @type {const} */(false),issues:['PositivePreparationInvalid']};
 const v=value;
 if(!object(v.source)||typeof v.source.url!=='string'||!URL.canParse(v.source.url)||new URL(v.source.url).protocol!=='https:'||new URL(v.source.url).username||new URL(v.source.url).password||typeof v.source.family!=='string'||!v.source.family)issues.push('PositiveSourceInvalid');
 if(!Array.isArray(v.holdoutFamilies)||!v.holdoutFamilies.length||!v.holdoutFamilies.every(x=>typeof x==='string'&&x))issues.push('PositiveHoldoutProvenanceRequired');
 if(Array.isArray(v.holdoutFamilies)&&v.holdoutFamilies.includes(object(v.source)?v.source.family:undefined))issues.push('PositiveHoldoutFamilyOverlap');
 if(!Array.isArray(v.expected)||!v.expected.length||!v.expected.every(e=>object(e)&&typeof e.factQuote==='string'&&e.factQuote&&typeof e.imageMeaning==='string'&&e.imageMeaning&&typeof e.imageUrl==='string'&&URL.canParse(e.imageUrl)&&typeof e.independentReviewer==='string'&&e.independentReviewer&&typeof e.sourceAttribution==='string'&&e.sourceAttribution))issues.push('PositiveIndependentLabelsRequired');
 if(!object(v.rights)||!['storage','display','transformation'].every(k=>object(v.rights)&&v.rights[k]==='allowed')||typeof v.rights.licenseUrl!=='string'||!URL.canParse(v.rights.licenseUrl)||typeof v.rights.attribution!=='string'||!v.rights.attribution)issues.push('PositiveRightsUnverified');
 if(!object(v.provenance)||typeof v.provenance.sourceMetadataSha256!=='string'||!/^sha256:[a-f0-9]{64}$/.test(v.provenance.sourceMetadataSha256)||typeof v.provenance.reviewedAt!=='string'||!Number.isFinite(Date.parse(v.provenance.reviewedAt)))issues.push('PositiveProvenanceUnverified');
 return issues.length?{ok:/** @type {const} */(false),issues}:{ok:/** @type {const} */(true),value:v};
}
/** Exact offline CLI grammar; no launch flag or credential handling. */
/** @param {string[]} args */
export function parsePositiveCli(args){if(args.length!==4||args[0]!=='--prepare'||args[2]!=='--output'||!args[1]||!args[3])throw new TypeError('PositiveCliOfflineOnly');return {config:args[1],output:args[3]};}
/** @typedef {{exec:(sql:string)=>unknown,prepare:(sql:string)=>{run:(...values:(string|number|null)[])=>{changes:number|bigint},get:(...values:(string|number|null)[])=>Record<string,unknown>|undefined,all:(...values:(string|number|null)[])=>Record<string,unknown>[]},close:()=>void}} PositiveSQLite */
/** Actual migrations, transactions and private file object bytes.
 * @param {{directory?:string}} [options] */
export async function openPositiveStorage(options={}){
 const persistent=typeof options.directory==='string';
 const directory=typeof options.directory==='string'?options.directory:await mkdtemp(join(tmpdir(),'pkp-positive-'));
 await mkdir(directory,{recursive:true});
 const sqlite=/** @type {PositiveSQLite} */(new DatabaseSync(join(directory,'isolated.sqlite')));
 sqlite.exec('PRAGMA foreign_keys=ON');
 try{if(sqlite.prepare('PRAGMA user_version').get()?.user_version===0){for(const name of (await readdir(new URL('../worker/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(await readFile(new URL('../worker/migrations/'+name,import.meta.url),'utf8'));sqlite.exec('PRAGMA user_version=24');}}catch(error){sqlite.close();if(!persistent)await rm(directory,{recursive:true,force:true});throw error;}
 /** @type {{prepare:import('../worker/knowledge-workflow-content-d1.js').D1DatabasePort['prepare'],batch:(statements:readonly {run:()=>Promise<{success:boolean,meta?:{changes?:number}}> }[])=>Promise<readonly {success:boolean,meta?:{changes?:number}}[]>}} */
 const database={
  prepare(sql){
   /** @type {readonly (string|number|null)[]} */
   let values=[];
   return {bind(...v){values=v;return this;},first:async()=>sqlite.prepare(sql).get(...values)??null,all:async()=>({success:true,results:sqlite.prepare(sql).all(...values)}),run:async()=>({success:true,meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}})};
  },
  async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}
 };
 /** @param {string} key */
 const path=key=>{if(typeof key!=='string'||!key)throw new TypeError('PositiveObjectKeyInvalid');return join(directory,'objects',sha(key).slice(7));};
 /** @type {import('../worker/knowledge-workflow-media-d1.js').MediaBucket} */
 const bucket={async put(key,bytes){if(!(bytes instanceof Uint8Array))throw new TypeError('PositiveObjectBytesInvalid');const file=path(key);await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes);},async get(key){try{const encoded=(await readFile(path(key))).toString('base64');const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));return {arrayBuffer:async()=>bytes.buffer};}catch(error){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return null;throw error;}},async delete(key){await rm(path(key),{force:true});}};
 return {database,bucket,sqlite,directory,async close(){sqlite.close();if(!persistent)await rm(directory,{recursive:true,force:true});}};
}
/** Composition adapter for the authority owner. No second ledger, model transport, or extraction pipeline.
 * Caller supplies real acquisition/browser/media/auth/renderer ports and approved role snapshots.
 * This factory does not execute a model call. */
/** @param {{preparation:unknown,runtimeDependencies:Parameters<typeof createKnowledgeWorkflowRuntime>[0],roleDependencies:Parameters<typeof createEvaluationRoleGenerate>[0]}} command */
export function composePositiveRuntime({preparation,runtimeDependencies,roleDependencies}){
 const checked=validatePositivePreparation(preparation);if(!checked.ok)throw new TypeError(checked.issues?.join(','));
 const roles=validateEvaluationRoleProfiles(roleDependencies?.profiles);if(!roles.ok)throw new TypeError('PositiveRoleProfilesInvalid');
 const scraper=roles.value.roles['knowledge-scraper'].catalog;
 for(const snapshot of Object.values(runtimeDependencies.configSnapshots)){if(snapshot.model.name!==scraper.model.id)throw new TypeError('PositiveRuntimeRoleModelMismatch');}
 if(!runtimeDependencies.media||!runtimeDependencies.browser||!runtimeDependencies.publicEgress)throw new TypeError('PositiveProductionPortsRequired');
 const transport=createEvaluationTransport({...roleDependencies.transport,benchmarkContract:roles.value.benchmarkContract,catalog:scraper,model:scraper.model.id,endpoint:roleDependencies.modelConfig.endpoint});
 return {runtime:createKnowledgeWorkflowRuntime({...runtimeDependencies,fetch:transport}),judge:createEvaluationRoleGenerate(roleDependencies)};
}
/** @param {string[]} args */
export async function runPositivePreparationCli(args){const {config,output}=parsePositiveCli(args);const bytes=await readFile(config);const result=validatePositivePreparation(JSON.parse(bytes.toString()));await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify({version:'positive-preparation-receipt-v1',inferenceCalls:0,activated:false,configSha256:sha(bytes),...result},null,2)+'\n');return result.ok?0:2;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runPositivePreparationCli(process.argv.slice(2)).then(code=>{process.exitCode=code;},()=>{console.error('PositivePreparationFailed');process.exitCode=1;});
