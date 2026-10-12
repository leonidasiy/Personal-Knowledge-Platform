import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {DiscoverySearchGatewayClient} from '../src/features/discovery/gateway.js';

// Inspect the actual browser fixture without executing its browser/API workflow.
async function browserFixture(){
 const source=await readFile(new URL('../scripts/check-frontend-revamp.mjs',import.meta.url),'utf8');
 const expression=source.match(/if \(path === "\/api\/discovery\/search"\) return respond\((.+)\);/)?.[1];
 assert(expression,'Discover browser fixture must be discoverable');
 return JSON.parse(JSON.stringify(runInNewContext('('+expression+')',Object.create(null),{timeout:1000})));
}
const keys=['items','policyVersion','providerFailures','providerQuery','submittedQuery'];
const search=value=>new DiscoverySearchGatewayClient({baseUrl:'https://app.example/',timeoutMs:1000,fetch:async()=>Response.json({result:value})}).search({query:'patterns',providerIds:['web'],limit:20});
test('actual browser rawDiscover fixture has exactly five fields and gateway accepts its raw snippet',async()=>{
 const fixture=await browserFixture();assert.deepEqual(Object.keys(fixture).sort(),keys);
 const result=await search(fixture);assert.equal(result.ok,true);assert.deepEqual(result.value,fixture);
});
test('rawDiscover empty and twenty-item boundaries preserve exact provider text',async()=>{
 const fixture=await browserFixture();
 for(const count of [0,20]){const value={...fixture,items:Array.from({length:count},()=>structuredClone(fixture.items[0]))};const result=await search(value);assert.equal(result.ok,true);assert.deepEqual(result.value,value);}
 const result=await search({...fixture,items:Array.from({length:21},()=>fixture.items[0])});assert.deepEqual(result,{ok:false,error:{kind:'DiscoveryGatewayResponseInvalid'}});
});
test('obsolete assessed envelope and missing/extra raw fields are rejected by name',async()=>{
 const fixture=await browserFixture();
 for(const extra of [{assessments:[]},{selectionOutcome:'CoreSourcesSelected'},{assessments:[],selectionOutcome:'CoreSourcesSelected'},{unknown:true}])assert.deepEqual(await search({...fixture,...extra}),{ok:false,error:{kind:'DiscoveryGatewayResponseInvalid'}});
 for(const key of keys){const value=structuredClone(fixture);delete value[key];assert.deepEqual(await search(value),{ok:false,error:{kind:'DiscoveryGatewayResponseInvalid'}});}
});
