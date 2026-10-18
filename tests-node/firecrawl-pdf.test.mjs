import test from 'node:test';
import assert from 'node:assert/strict';
import {createFirecrawlPdfCapture} from '../worker/firecrawl-pdf.js';
import {parseUrlCapture} from '../src/features/knowledge-workflows/url-capture.js';
const url='https://example.org/lesson';
function fixture({robots='User-agent: *\nAllow: /',pdfFailure=false,closeFailure=false}={}){
 let closed=0,printed=0;const logs=[];
 const bytes=Uint8Array.from([137,80,78,71,13,10,26,10,1]);
 const browser={
  readPage:async()=>({ok:true,value:{responseUrl:url,evidence:{blocks:[{id:'caption',text:'Author figure'},{id:'text',text:'Relevant context'}],images:[{url:'https://example.org/figure.png',occurrences:[{alt:'Diagram',captionId:'caption'}],occurrenceWindows:[['text']]}]}}}),
  readRobots:async()=>({ok:true,value:{status:200,bytes:new TextEncoder().encode(robots)}}),
  capturePdf:async()=>{printed++;return pdfFailure?{ok:false,error:{kind:'ProviderUnavailable'}}:{ok:true,value:new TextEncoder().encode('%PDF-fixture')};},
  readImage:async()=>({ok:true,value:{bytes,mediaType:'image/png'}}),
  close:async()=>{closed++;return closeFailure?{ok:false,error:{kind:'KnowledgeBrowserSessionCloseFailed'}}:{ok:true,value:null};},
 };
 const capture=createFirecrawlPdfCapture({createBrowser:()=>browser,fetch:async()=>{throw Error('No direct network expected');},resolveAddresses:async()=>({ok:true,value:['8.8.8.8']}),now:()=>Date.parse('2026-10-18T00:00:00Z'),logger:entry=>logs.push(entry)});
 return {capture,bytes,logs,get closed(){return closed;},get printed(){return printed;}};
}
test('computer URL capture retains original image bytes and context in the standard material envelope',async()=>{
 const f=fixture(),r=await f.capture({ownerId:'local',url});assert.equal(r.ok,true);const parsed=parseUrlCapture(r.value);assert.equal(parsed.ok,true);assert.equal(parsed.value.sourceUrl,url);assert.equal(new TextDecoder().decode(parsed.value.pdf),'%PDF-fixture');assert.deepEqual(parsed.value.images[0].bytes,f.bytes);assert.equal(parsed.value.images[0].caption,'Author figure');assert.equal(parsed.value.images[0].context,'Relevant context');assert.equal(f.closed,1);
});
test('robots denial and provider failures remain named failures and always close the provider session',async()=>{
 const denied=fixture({robots:'User-agent: *\nDisallow: /'});assert.equal((await denied.capture({ownerId:'local',url})).error.kind,'RobotsDenied');assert.equal(denied.printed,0);assert.equal(denied.closed,1);
 const failed=fixture({pdfFailure:true});assert.equal((await failed.capture({ownerId:'local',url})).error.kind,'ProviderUnavailable');assert.equal(failed.closed,1);
 const unclosed=fixture({closeFailure:true});assert.equal((await unclosed.capture({ownerId:'local',url})).error.kind,'KnowledgeBrowserSessionCloseFailed');assert.equal(unclosed.closed,1);
});
