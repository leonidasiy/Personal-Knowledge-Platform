// @ts-check
import process from 'node:process';
import {readFile} from 'node:fs/promises';
import {openBenchmarkAccountant,reviewBenchmark} from './mistral-benchmark.ts';
const path=process.env.PKP_MISTRAL_BENCHMARK_CONTRACT;
if(typeof path!=='string'||!path)throw new TypeError('BenchmarkArgumentsInvalid');
const contract=/** @type {import('./mistral-benchmark.ts').BenchmarkContract} */(JSON.parse(await readFile(path,'utf8')));
// Poison is an offline import installed by the smoke launcher; paid processes require Hermes review.
if(globalThis.fetch.name!=='mistralBenchmarkPoison'){const review=await reviewBenchmark(contract);if(!review.ok)throw new TypeError(review.error.kind);}
const accountant=await openBenchmarkAccountant(contract);
export const benchmarkContract=contract;
export const {caseIds,evaluationScope,runtimePolicy,originalGrantSha256,roleProfiles,reasoningSettings,costPolicy,requestPlanner,countedBoundary,resumeContract,resumeAuthorityHash,decodePixels,decodeImage,close}=accountant;
