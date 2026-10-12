// @ts-check
import process from 'node:process';
import {readFile,writeFile} from 'node:fs/promises';
/** Refresh only official model/account metadata. No inference or secret response fields are persisted. */
const profiles=JSON.parse(await readFile('test-results/benchmark-recovery-20261007/judge-replacement-v1/loader-fix-v1/role-profile.json','utf8'));
const ids=Object.values(profiles.roles).map((/** @type {{catalog:{model:{id:string}}}} */ r)=>r.catalog.model.id);
if(!process.env.OPENROUTER_API_KEY)throw new TypeError('IntegrationCredentialMissing');
const requests=[];
for(const source of ['https://openrouter.ai/api/v1/models','https://openrouter.ai/api/v1/models/user','https://openrouter.ai/api/v1/credits']){
 const response=await fetch(source,{headers:{authorization:'Bearer '+process.env.OPENROUTER_API_KEY},signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new TypeError(response.status===401||response.status===403?'IntegrationMetadataAccessStopped':'IntegrationMetadataUnavailable');
 const body=await response.json();
 if(source.endsWith('/credits')){if(typeof body.data?.total_credits!=='number'||typeof body.data?.total_usage!=='number')throw new TypeError('IntegrationMetadataInvalid');requests.push({source,status:response.status,metadata:{total_credits:body.data.total_credits,total_usage:body.data.total_usage}});}
 else{if(!Array.isArray(body.data))throw new TypeError('IntegrationMetadataInvalid');requests.push({source,status:response.status,models:body.data.filter((/** @type {{id:string}} */ m)=>ids.includes(m.id))});}
}
await writeFile('test-results/architecture-recovery/integration-v1/official-metadata.json',JSON.stringify({retrievedAt:new Date().toISOString(),requests},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:'OfficialMetadataRefreshed',inferenceCalls:0}));
