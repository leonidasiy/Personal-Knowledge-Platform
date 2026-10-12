#!/usr/bin/env node
// @ts-check
import process from 'node:process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isRuntimePolicy} from './evaluation-runtime-control.mjs';
/** External composition supplies canonical accountant and positive driver; no guessed package identity.
 * @typedef {{runtimePolicy:import('./evaluation-runtime-control.mjs').RuntimePolicy,sourceFiles:Record<string,string>,accountantModule:string,driverModule:string}} LaunchConfig */
/** Preparation only. A later reviewed composition owns activation and owned-process supervision.
 * @param {{configFile:string,outputFile:string}} command */
export async function prepareRuntimeLaunch({configFile,outputFile}){
 if(typeof configFile!=='string'||!configFile||typeof outputFile!=='string'||!outputFile)throw new TypeError('EvaluationLaunchArgumentsInvalid');
 const config=/** @type {LaunchConfig} */(JSON.parse(await readFile(configFile,'utf8')));
 if(!isRuntimePolicy(config.runtimePolicy)||!config.sourceFiles||typeof config.sourceFiles!=='object'||!Object.keys(config.sourceFiles).length||typeof config.accountantModule!=='string'||typeof config.driverModule!=='string')throw new TypeError('EvaluationLaunchCompositionInvalid');
 for(const [file,expected]of Object.entries(config.sourceFiles)){if(!/^[a-f0-9]{64}$/.test(expected)||createHash('sha256').update(await readFile(file)).digest('hex')!==expected)throw new TypeError('EvaluationLaunchSourceChanged');}
 for(const module of [config.accountantModule,config.driverModule])if(!Object.hasOwn(config.sourceFiles,module))throw new TypeError('EvaluationLaunchSourceMissing');
 const contractSha256=createHash('sha256').update(JSON.stringify(config)).digest('hex');
 const output={version:1,prepared:true,activation:false,contractSha256,config,requires:['fresh-independent-source-bound-gate','exact-cli-accountant-loader-regression','owned-process-group-cleanup','positive-fresh-web-correct-nonnull-image-verified-persisted-rendered','fixed45-15development-30holdout'],dispatchInterface:{accountantModule:config.accountantModule,driverModule:config.driverModule,sequence:['positiveCanary','fixed45'],ledger:'same canonical accountant for every paid role',holdoutRepairs:false}};
 await writeFile(outputFile,JSON.stringify(output,null,2)+'\n',{flag:'wx',mode:0o600});return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const args=process.argv.slice(2);if(args.length===1&&args[0]==='--execute'){const {runReviewedIntegration}=await import('./architecture-integration-supervisor.mjs');process.exitCode=(await runReviewedIntegration()).code??1;}else{if(args.length!==3||args[0]!=='--prepare')throw new TypeError('EvaluationLaunchArgumentsInvalid');await prepareRuntimeLaunch({configFile:args[1],outputFile:args[2]});}}
