// @ts-check
import process from 'node:process';
import {createHash} from 'node:crypto';
import {readFile,appendFile,writeFile} from 'node:fs/promises';
const path=process.env.PKP_MISTRAL_BENCHMARK_CONTRACT;
if(typeof path!=='string'||!path)throw new TypeError('BenchmarkPoisonContractMissing');
const contract=/** @type {import('./mistral-benchmark.ts').BenchmarkContract} */(JSON.parse(await readFile(path,'utf8')));
/** Offline terminal sentinel: it NEVER delegates to HTTP. @type {typeof fetch} */
globalThis.fetch=async function mistralBenchmarkPoison(_url,init){
 const request=/** @type {{body?:unknown}} */(init);
 if(String(_url)!=='https://openrouter.ai/api/v1/chat/completions'||typeof request?.body!=='string')throw new TypeError('BenchmarkPoisonUnexpectedTransport');
 const body=JSON.parse(/** @type {string} */(request.body));const input=body.messages[1].content;const text=typeof input==='string'?input:input[0].text;
 const task=JSON.parse(text.slice(text.indexOf('\n')+1,text.lastIndexOf('\n')));const item=contract.selection.find(c=>c.evidenceIdentity===task.url);if(!item)throw new TypeError('BenchmarkPoisonSourceIdentityMismatch');
 await writeFile(contract.directory+'/first-request.json',request.body+'\n',{mode:0o600});
 await appendFile(contract.directory+'/poison-sentinel.jsonl',JSON.stringify({model:body.model,caseId:item.caseId,sourceUrl:task.url,promptOperation:task.operation,requestSha256:createHash('sha256').update(request.body).digest('hex'),sentinel:'SENTINEL0',paidHTTP:0})+'\n',{mode:0o600});throw new TypeError('BenchmarkOfflineDispatchPoison');
};
