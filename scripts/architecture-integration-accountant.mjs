// Exact CLI adapter; caller must finish loading the evaluator before this TLA import.
import process from 'node:process';
import {readFile,stat} from 'node:fs/promises';
import {openEvaluationGrant,createEstimatedRequestPlanner} from './evaluation-budget.mjs';
import {evaluationHash} from './webpage-image-evaluation.mjs';
import {createIntegrationCheckpoint} from './architecture-integration-checkpoint.ts';
import {readJson,contractFile,openAccountant,outputRoot} from './architecture-integration.ts';
const contractPath=process.env.PKP_INTEGRATION_GATE_CLONE_CONTRACT??contractFile;
const contract=await readJson(contractPath);
const canonical=await readJson(contractFile);
if(contractPath!==contractFile){const cloneIdentity=await stat(contract.grant.storePath),canonicalIdentity=await stat(canonical.grant.storePath);if(cloneIdentity.dev===canonicalIdentity.dev&&cloneIdentity.ino===canonicalIdentity.ino||contract.runtimePolicy.codeSha256!==canonical.runtimePolicy.codeSha256)throw new TypeError('IntegrationGateCloneInvalid');}
else{const gate=await readJson(outputRoot+'/independent-review/gate.json');const {hash}=await import('./architecture-integration-checkpoint.ts');if(gate.verdict!=='PASS'||gate.BLOCKING!=='NONE'||gate.nonzeroProbes<1||gate.contractHash!==hash(await readFile(contractFile))||JSON.stringify(gate.hashes)!==JSON.stringify(contract.sourceFiles))throw new TypeError('IntegrationIndependentGateRejected');}
const opened=await openAccountant(contract,contract.grant.storePath);await opened.close();
export const runtimePolicy=contract.runtimePolicy,originalGrantSha256=runtimePolicy.originalGrantSha256,roleProfiles=contract.roleProfiles,reasoningSettings=contract.reasoningSettings,costPolicy=contract.costPolicy;
export const requestPlanner=createEstimatedRequestPlanner({metadata:roleProfiles.roles['knowledge-scraper'].catalog,costPolicy,sourceContract:contract.ownerDecision,now:Date.now});
const {testPixelDecoder}=await import('../tests-node/evaluation-pixel-decoder.mjs');
/** @type {Awaited<ReturnType<typeof testPixelDecoder>>|undefined} */ let decoder;
/** @type {import("./webpage-image-evaluation.mjs").EvaluationPixelDecoder} */
export const decodePixels=async(bytes,mediaType)=>{decoder??=await testPixelDecoder();return decoder.decodePixels(bytes,mediaType);};
/** @type {import("../worker/upload-image-boundary.js").ImageDecoder} */
export const decodeImage=async(bytes,mediaType)=>{const r=await decodePixels(bytes,mediaType);return r.ok?{ok:true,value:null}:r;};
export async function close(){await decoder?.close();}
