// @ts-check
import { prepareSubmittedLink } from '../src/features/source-library/submitted-link.js';
/** @param {unknown} actual @param {unknown} expected */
function equal(actual,expected){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);}
const input={title:'My link',url:'https://publisher.example/lesson',interestAreaId:'area-a',idempotencyKey:'link-a'};
Deno.test('Link prepares the shared extraction command without invented snippets or publisher identity',()=>{
 const result=prepareSubmittedLink(input,'2026-10-05T00:00:00.000Z');equal(result.ok,true);if(!result.ok)throw new Error(result.error.kind);
 equal(result.value.title,'My link');equal(result.value.description,'');equal(result.value.interestAreaIds,['area-a']);equal(result.value.initialItem,null);
 equal(result.value.identityEvidence,[{attribute:'user-submitted-url',value:input.url,provenanceUrl:input.url,observedAt:'2026-10-05T00:00:00.000Z'}]);
});
for(const url of ['', 'invalid','http://publisher.example/','https://secret@publisher.example/','https://publisher.example/#fragment','https://localhost/','https://127.0.0.1/','https://10.0.0.1/','https://169.254.169.254/','https://[::1]/','https://[fc00::1]/','https://[::ffff:127.0.0.1]/','https://publisher.example:8443/']){
 Deno.test(`Link rejects unsafe URL ${url}`,()=>equal(prepareSubmittedLink({...input,url},'2026-10-05T00:00:00.000Z').ok,false));
}
for(const change of [{title:''},{title:' '.repeat(3)},{title:'x'.repeat(301)},{interestAreaId:''},{file:'private.pdf'},{content:'private'},{attested:true},{ownerId:'foreign'}]){
 Deno.test(`Link rejects mixed/invalid field ${Object.keys(change)[0]}`,()=>equal(prepareSubmittedLink({...input,...change},'2026-10-05T00:00:00.000Z').ok,false));
}
