import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAgentConfigurationLoader} from '../src/features/knowledge-workflows/config.js';

const loader=createAgentConfigurationLoader({sha256:value=>Promise.resolve(`sha256:${createHash('sha256').update(value).digest('hex')}`)});
const digests={};
for(const role of ['rights-assessor','knowledge-scraper','question-generator','question-evaluator']){
  const source=await readFile(new URL(`../agent-config/${role}.yaml`,import.meta.url),'utf8');
  const result=await loader.load({source,expectedRole:role});
  if(!result.ok)throw new Error(`${role}: ${result.error.kind}`);
  digests[role]=result.value.digest;
}
console.log(JSON.stringify(digests));
