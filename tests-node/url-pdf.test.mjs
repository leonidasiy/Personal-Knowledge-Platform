import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createUrlPdfCapture} from '../worker/url-pdf.mjs';
function fixture({status=200,privateDns=false,resource=null,challenge=false,pdfFailure=false,robotsDenied=false}={}){
 const callbacks={},events=[],closed=[],reconciliations=[],dns=[];
 const response={status:()=>status,headers:()=>({'content-type':'text/html',...(challenge?{'cf-mitigated':'challenge'}:{})}),remoteAddress:()=>({ip:'[::1]',port:9001})};
 const page={setUserAgent:async()=>{},setRequestInterception:async()=>{},on:(event,callback)=>{callbacks[event]=callback;},url:()=> 'https://example.org/lesson',
 goto:async url=>{for(const target of [url,...resource?[resource]:[]])await callbacks.request({url:()=>target,method:()=> 'GET',isNavigationRequest:()=>target===url,continue:async()=>events.push('continue'),abort:async()=>events.push('abort')});return response;},
 emulateMediaType:async value=>events.push(value),pdf:async options=>{events.push(options);if(pdfFailure)throw new Error('provider prose');return new TextEncoder().encode('%PDF-fixture');}};
 const capture=createUrlPdfCapture({binding:{},fetch:async url=>{if(String(url).includes('/dns-query'))dns.push(String(url));return String(url).endsWith('/robots.txt')?new Response(robotsDenied?'User-agent: *\nDisallow: /':'User-agent: *\nAllow: /'):Response.json({Status:0,Answer:[{type:1,data:privateDns||String(url).includes('private.example')?'127.0.0.1':'8.8.8.8'}]});},now:()=>Date.now(),logger:entry=>events.push(entry),
 launcher:{launch:async()=>({newPage:async()=>page,close:async()=>closed.push(true)})},
 capacity:{reserve:async()=>({ok:true,value:{reservedMilliseconds:60_000}}),reconcile:async command=>{reconciliations.push(command);return {ok:true,value:null};}}});
 return {capture,events,closed,reconciliations,dns};
}
test('URL capture retains images, screen layout and valid PDF bytes while closing and reconciling',async()=>{
 const f=fixture();const result=await f.capture({ownerId:'owner-a',url:'https://example.org/lesson'});
 assert.equal(result.ok,true);assert.equal(new TextDecoder().decode(result.value),'%PDF-fixture');
 assert.equal(f.dns.length,2,'Repeated page, resource and robots checks share one DNS pair');assert.ok(f.events.includes('screen'));assert.ok(f.events.some(event=>event.printBackground===true));assert.equal(f.closed.length,1);assert.equal(f.reconciliations[0].outcome,'completed');
});
test('URL capture refuses blocked content and never sends a denial page to PDF extraction',async()=>{
 for(const options of [{status:403},{challenge:true}]){const f=fixture(options);const result=await f.capture({ownerId:'owner-a',url:'https://example.org/lesson'});assert.equal(result.error.kind,'KnowledgePageBotAccessDenied');assert.equal(f.closed.length,1);assert.equal(f.events.some(event=>event.printBackground),false);}
});
test('URL capture refuses private destinations and private subresources',async()=>{
 let f=fixture({privateDns:true});assert.equal((await f.capture({ownerId:'owner-a',url:'https://example.org/lesson'})).error.kind,'KnowledgeBrowserNetworkRejected');assert.equal(f.closed.length,0);
 f=fixture({resource:'https://private.example/image.png'});const result=await f.capture({ownerId:'owner-a',url:'https://example.org/lesson'});assert.equal(result.ok,false);assert.ok(f.events.includes('abort'));assert.equal(f.closed.length,1);
});
test('PDF failures preserve safe diagnostics and release browser quota',async()=>{
 const f=fixture({pdfFailure:true});const result=await f.capture({ownerId:'owner-a',url:'https://example.org/lesson'});assert.equal(result.error.kind,'KnowledgeBrowserNavigationFailed');assert.equal(JSON.stringify(f.events).includes('provider prose'),false);assert.equal(f.reconciliations.length,1);assert.equal(f.closed.length,1);
});

test('URL capture honors an explicit robots denial before PDF creation',async()=>{const f=fixture({robotsDenied:true});const result=await f.capture({ownerId:'owner-a',url:'https://example.org/lesson'});assert.equal(result.error.kind,'RobotsDenied');assert.equal(f.events.some(event=>event.printBackground),false);assert.equal(f.closed.length,1);});

test('URL capture migration preserves usage and shares the existing concurrency and daily limits',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {readFile}=await import('node:fs/promises');
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE source_ingestion_jobs(owner_id TEXT,job_id TEXT,PRIMARY KEY(owner_id,job_id)); INSERT INTO source_ingestion_jobs VALUES (\'owner-a\',\'crawl-job\');');
  const initial=await readFile(new URL('../worker/migrations/0003_browser_run_acquisition.sql',import.meta.url),'utf8');db.exec(initial.slice(initial.indexOf('CREATE TABLE source_browser_run_daily_capacity')));
  db.exec("INSERT INTO source_browser_run_daily_capacity VALUES ('scope','2026-10-14',0,0,'2026-10-14T00:00:00.000Z','2026-10-14T00:00:00.000Z')");
  const insert="INSERT INTO source_browser_run_reservations VALUES ('scope',?,'owner-a',?,'2026-10-14',60000,NULL,600000,1,20000,'2026-10-14T01:00:00.000Z','2026-10-14T01:00:20.000Z','active',NULL)";
  db.prepare(insert).run('old','crawl-job');const before=db.prepare('SELECT * FROM source_browser_run_daily_capacity').all();
  db.exec(await readFile(new URL('../worker/migrations/0029_browser_url_capture.sql',import.meta.url),'utf8'));
  assert.deepEqual(db.prepare('SELECT * FROM source_browser_run_daily_capacity').all(),before);assert.equal(db.prepare('SELECT state FROM source_browser_run_reservations WHERE reservation_id=?').get('old').state,'active');
  assert.throws(()=>db.prepare(insert).run('new','url-capture:one'),/concurrency-exceeded/);
  db.exec("UPDATE source_browser_run_reservations SET charged_milliseconds=12000,state='closed',closed_at='2026-10-14T01:00:10.000Z' WHERE reservation_id='old'; UPDATE source_browser_run_daily_capacity SET next_acquisition_at='2026-10-14T00:00:00.000Z'");
  db.prepare(insert).run('new','url-capture:one');const capacity=db.prepare('SELECT * FROM source_browser_run_daily_capacity').get();assert.equal(capacity.reserved_milliseconds,72000);assert.equal(capacity.active_sessions,1);
  db.exec("UPDATE source_browser_run_reservations SET charged_milliseconds=60000,state='uncertain' WHERE reservation_id='new'; UPDATE source_browser_run_daily_capacity SET reserved_milliseconds=600000,next_acquisition_at='2026-10-14T00:00:00.000Z'");
  assert.throws(()=>db.prepare(insert).run('over','url-capture:two'),/daily-budget-exceeded/);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
