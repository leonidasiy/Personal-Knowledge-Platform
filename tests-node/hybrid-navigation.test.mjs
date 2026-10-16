import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverHybridNavigation,boundHybridExtractionPlan,navigateHybridLesson,createRobotsNavigationHandoff} from '../worker/hybrid-navigation.js';
// Constructed agent/API fixtures, not live model decisions or course coverage evidence.
const course='https://example.test/course/';
const source=course+'overview?tab=description';
const urls=[course+'lesson-1',course+'lesson-2?part=main',course+'lesson-3'];
const control=(id,label,url,order,role='link')=>({id,label,url,order,role,selected:false,region:'Course content'});
const initial={navigation:{url:source,title:'Example course',controls:[control('tab','Course content',null,0,'tab')],truncated:false}};
const opened={navigation:{url:source,title:'Example course',controls:urls.map((url,i)=>control('lesson-'+i,'Lesson '+(i+1),url,i)),truncated:false}};
const choice=(action='ready',lessonUrls=urls)=>({action,targetId:action==='click'?'tab':null,sourceRootUrl:course,lessonUrls:action==='ready'?lessonUrls:[],rationale:'Select the observed course tab and follow its lesson order.'});
function fixture(outputs=[choice('click'),choice()]) {
  const calls=[],memories=[],inputs=[];
  const deps={sourceUrl:source,processedUrls:[urls[0]],lessOften:[{id:'skip',summary:'A synthetic unwanted concept.'}],maximumTurns:8,deadlineAtMs:100000,nowMs:()=>1,inspect:async c=>{calls.push(['inspect',c]);return {ok:true,value:initial};},click:async c=>{calls.push(['click',c]);return {ok:true,value:opened};},screenshot:async c=>{calls.push(['screenshot',c]);return {ok:true,value:{bytes:new Uint8Array([1]),mediaType:'image/png'}};},generate:async c=>{inputs.push(c);return {ok:true,value:outputs.shift()};},remember:async p=>{memories.push(p);return {ok:true,value:null};},checkRobots:async url=>{calls.push(['robots',url]);return {ok:true,value:null};}};
  return {deps,calls,memories,inputs};
}
test('agent infers and opens a tab from live controls, retains preferences and records decisions',async()=>{
  const f=fixture(),r=await discoverHybridNavigation(f.deps);
  assert.equal(r.ok,true);assert.deepEqual(r.value.lessonUrls,urls);assert.equal(r.value.sourceRootUrl,course);
  assert.equal(f.calls.filter(c=>c[0]==='click').length,1);assert.equal(f.calls.find(c=>c[0]==='click')[1].targetId,'tab');
  assert.deepEqual(f.inputs[1].input.processedUrls,[urls[0]]);assert.deepEqual(f.inputs[1].input.lessOften,f.deps.lessOften);
  assert.deepEqual(f.memories.map(m=>m.phase),['navigation-observed','navigation-decision','navigation-action-result','navigation-observed','navigation-decision']);
});
test('reversed lessons, invented URLs, unsafe roots and invented control IDs are rejected',async()=>{
  for(const value of [choice('ready',[urls[2],urls[0]]),choice('ready',[course+'invented']),{...choice(),sourceRootUrl:'https://foreign.test/'},{...choice('click'),targetId:'invented'}]){
    const f=fixture([choice('click'),value,value]);const r=await discoverHybridNavigation(f.deps);assert.equal(r.ok,false);
    assert.ok(['NavigationActionRepeated','NavigationOutputInvalid','NavigationTargetInvalid'].includes(r.error.kind));
    assert.equal(f.calls.filter(c=>c[0]==='click').length,1);
  }
});
test('query variants keep their meaning and the order boundary ignores model reordering',()=>{
  const plan={revision:1,frontier:[urls[2],urls[1]],coverageGoals:[],unresolvedGaps:[],stopDecision:{decision:'complete',rationale:'Proposed finish.',evidenceUrls:[],unresolvedGapIds:[]}};
  const result=boundHybridExtractionPlan(plan,{lessonUrls:urls},{processedUrls:[urls[0]]});
  assert.deepEqual(result.frontier,urls.slice(1));assert.equal(result.stopDecision.decision,'continue');
});
test('screenshots reach the existing scraper model and preserve the current panel',async()=>{
  const f=fixture([choice('click'),choice('screenshot'),choice()]);const r=await discoverHybridNavigation(f.deps);
  assert.equal(r.ok,true);assert.equal(f.inputs[2].attachments[0].mediaType,'image/png');assert.equal(f.calls.find(c=>c[0]==='screenshot')[1].url,source);
});
test('obstructed clicks refresh live dialog evidence and let the agent choose dismissal before retry',async()=>{
  for(const duringRobots of [false,true]){
    const dismiss=control('dismiss','Close',null,0,'button');dismiss.region='dialog';
    const obstructed={navigation:{...initial.navigation,controls:[dismiss,{...initial.navigation.controls[0],order:1}]}};
    const outputs=[choice('click'),{...choice('click'),targetId:'dismiss'},choice('click'),choice()];
    const f=fixture(outputs);let inspections=0,attempts=0,shown=true;
    f.deps.inspect=async c=>{f.calls.push(['inspect',c]);return {ok:true,value:++inspections===1?initial:obstructed};};
    f.deps.checkRobots=async (_url,_root,c)=>{
      if(duringRobots&&shown&&c?.targetId==='tab'){attempts++;return {ok:false,error:{kind:'RobotsTargetUnavailable',causeKind:'KnowledgeBrowserClickObstructed'}};}
      return {ok:true,value:null};
    };
    f.deps.click=async c=>{
      f.calls.push(['click',c]);
      if(c.targetId==='dismiss'){shown=false;return {ok:true,value:initial};}
      attempts++;return shown?{ok:false,error:{kind:'KnowledgeBrowserClickObstructed'}}:{ok:true,value:opened};
    };
    const r=await discoverHybridNavigation(f.deps);assert.equal(r.ok,true);assert.equal(attempts,2);
    assert.deepEqual(f.calls.filter(c=>c[0]==='click').map(c=>c[1].targetId),duringRobots?['dismiss','tab']:['tab','dismiss','tab']);
    assert.equal(f.inputs[1].input.lastActionFailure.kind,'KnowledgeBrowserClickObstructed');
    assert.equal(f.inputs[1].input.currentPage.controls[0].region,'dialog');assert.equal(f.inputs[1].attachments[0].id,'obstruction-0');
    assert.ok(f.memories.some(m=>m.phase==='navigation-obstruction-observed'));
  }
});
test('obstruction recovery does not bypass access denials or repeat an unchanged failed action',async()=>{
  const denied=fixture();denied.deps.checkRobots=async (_url,_root,c)=>c?{ok:false,error:{kind:'RobotsTargetUnavailable',causeKind:'KnowledgePageBotAccessDenied'}}:{ok:true,value:null};
  assert.equal((await discoverHybridNavigation(denied.deps)).error.kind,'RobotsTargetUnavailable');assert.equal(denied.calls.filter(c=>c[0]==='screenshot').length,0);
  const repeated=fixture([choice('click'),choice('click')]);repeated.deps.click=async()=>({ok:false,error:{kind:'KnowledgeBrowserClickObstructed'}});
  assert.equal((await discoverHybridNavigation(repeated.deps)).error.kind,'NavigationActionRepeated');assert.equal(repeated.inputs.length,2);
  const remapped=fixture([choice('click'),{...choice('click'),targetId:'fresh-tab'}]);let reads=0,clicks=0;
  remapped.deps.inspect=async()=>({ok:true,value:++reads===1?initial:{navigation:{...initial.navigation,controls:[control('close','Close',null,0,'button'),{...initial.navigation.controls[0],id:'fresh-tab',order:1}]}}});
  remapped.deps.click=async()=>{clicks++;return {ok:false,error:{kind:'KnowledgeBrowserClickObstructed'}};};
  assert.equal((await discoverHybridNavigation(remapped.deps)).error.kind,'NavigationActionRepeated');assert.equal(clicks,1,'Fresh IDs must not permit the same obstructed intent before recovery.');
});
test('cancellation, deadlines, denied robots, persistence errors and repeated actions stop dispatch',async()=>{
  const canceled=fixture();canceled.deps.stopRequested=async()=>true;assert.equal((await discoverHybridNavigation(canceled.deps)).error.kind,'NavigationCancelled');assert.equal(canceled.calls.length,0);
  const expired=fixture();expired.deps.nowMs=()=>100001;assert.equal((await discoverHybridNavigation(expired.deps)).error.kind,'NavigationDeadlineExceeded');assert.equal(expired.calls.length,0);
  const denied=fixture();denied.deps.checkRobots=async()=>({ok:false,error:{kind:'RobotsDenied'}});assert.equal((await discoverHybridNavigation(denied.deps)).error.kind,'RobotsDenied');assert.equal(denied.calls.length,0);
  const broken=fixture();broken.deps.remember=async()=>({ok:false,error:{kind:'MemoryFailed'}});assert.equal((await discoverHybridNavigation(broken.deps)).error.kind,'MemoryFailed');assert.equal(broken.inputs.length,0);
  const repeated=fixture([choice('click'),choice('click')]);repeated.deps.click=async()=>({ok:true,value:initial});assert.equal((await discoverHybridNavigation(repeated.deps)).error.kind,'NavigationActionRepeated');
});
test('a standalone source page can be a lesson; truncated inventories cannot claim coverage',async()=>{
  const single=fixture([choice('ready',[source])]);const result=await discoverHybridNavigation(single.deps);assert.equal(result.ok,true);
  const truncated=fixture([choice('click'),choice()]);truncated.deps.click=async()=>({ok:true,value:{navigation:{...opened.navigation,truncated:true}}});assert.equal((await discoverHybridNavigation(truncated.deps)).error.kind,'NavigationEvidenceTruncated');
});

test('learner exclusions and previous knowledge reach the actual extraction prompt',async()=>{
  const {requestWebpageFacts}=await import('../worker/webpage-facts.js');
  const lessOften=[{id:'skip',summary:'Synthetic unwanted relationship.'}],previousKnowledge=[{id:'accepted',summary:'Synthetic previously accepted relationship.'}];
  const evidence={url:source,headings:[],images:[],warnings:[],blocks:[{id:'text',locator:'main > p',sectionId:'main',kind:'text',text:'A synthetic lesson claim used only for contract testing.',figureId:null}]};
  let command;
  const result=await requestWebpageFacts({taskId:'preference-contract',input:{url:source,evidence,coverageGoals:[],lessOften,previousKnowledge},maxOutputTokens:1000,generate:async c=>{command=c;return {ok:true,value:{candidates:[],notes:'Constructed empty result.'}};},logger:()=>{}});
  assert.equal(result.ok,true);assert.deepEqual(command.input.lessOften,lessOften);assert.deepEqual(command.input.previousKnowledge,previousKnowledge);
  assert.match(command.systemPrompt,/same central unwanted concept/);
  const invalid=await requestWebpageFacts({taskId:'invalid-preference',input:{url:source,evidence,coverageGoals:[],lessOften:[{id:'skip',summary:0}]},maxOutputTokens:1000,generate:async()=>{throw new Error('Unexpected dispatch');},logger:()=>{}});
  assert.equal(invalid.error.kind,'WebpageFactsCommandInvalid');
});

test('unverified robots executes the selected sibling click once and transfers its fresh observation',async()=>{
  const {createRobotsGate}=await import('../src/features/knowledge-workflows/robots.js');
  const {createRobotsNavigationHandoff}=await import('../worker/hybrid-navigation.js');
  let current=source,clicks=0;
  const handoff=createRobotsNavigationHandoff({sourceUrl:source,readPage:async({url})=>{current=url;return {ok:true,value:current===source?initial:{navigation:{...opened.navigation,url:current}}};},click:async command=>{
    assert.equal(command.url,current,'A robots check must not navigate away before the selected click.');clicks++;
    if(command.targetId==='tab')return {ok:true,value:opened};
    current=urls[0];return {ok:true,value:{navigation:{...opened.navigation,url:current}}};
  }});
  const gate=createRobotsGate({fetch:async()=>{throw new Error('Constructed unavailable robots.');},robotsUnavailablePolicy:'allow-unverified-if-public',resolveAddresses:async()=>({ok:true,value:['93.184.216.34']}),verifyTargetReachable:async({targetUrl})=>{const r=await handoff.captureTarget(targetUrl);return r.ok?{ok:true,value:null}:r;},now:()=> '2026-10-13T00:00:00.000Z',logger:()=>{}});
  const f=fixture([choice('click'),{...choice('click'),targetId:'lesson-0'},choice()]);
  f.deps.checkRobots=(targetUrl,rootUrl,action)=>{handoff.prepare(targetUrl,rootUrl,action);return gate.check({rights:{status:'allowed',canonicalUrl:source},targetUrl});};
  f.deps.click=handoff.click;
  const result=await discoverHybridNavigation(f.deps);
  assert.equal(result.ok,true);assert.equal(clicks,2);assert.equal(current,urls[0]);assert.equal(result.value.observations.at(-1).url,urls[0]);
});


test('completeness normalization keeps learner exclusions and prior knowledge',async()=>{
  const {requestWebpageFacts}=await import('../worker/webpage-facts.js');
  const lessOften=[{id:'skip',summary:'Synthetic unwanted relationship.'}],previousKnowledge=[{id:'known',summary:'Synthetic accepted relationship.'}];
  const summary='A synthetic retained relationship.';
  const evidence={url:source,headings:[],images:[],warnings:[],blocks:[{id:'text',locator:'main > p',sectionId:'main',kind:'text',text:summary,figureId:null}]};
  const commands=[];
  const result=await requestWebpageFacts({taskId:'normalization-preferences',input:{url:source,evidence,coverageGoals:[],lessOften,previousKnowledge},maxOutputTokens:1000,normalizeClaims:true,deferQualityReview:true,generate:async command=>{
    commands.push(command);
    if(command.phase==='extraction')return {ok:true,value:{notes:'',candidates:[{summary,normalizedHash:'retained',coverageGoalIds:[],mediaCandidates:[],evidenceAnchors:[{reference:command.input.citationSources[0].reference,clause:summary}]}]}};
    assert.deepEqual(command.input.lessOften,lessOften);assert.deepEqual(command.input.previousKnowledge,previousKnowledge);
    if(command.phase==='grounding')return {ok:true,value:{verdicts:command.input.candidates.map(c=>({normalizedHash:c.normalizedHash,matchedLessOftenIds:[]}))}};
    assert.equal(command.phase,'normalization');
    assert.match(command.systemPrompt,/do not restore a relationship intentionally omitted/);
    return {ok:true,value:{notes:'',additionalCandidates:[],reviews:[{sourceNormalizedHash:'retained',relationshipUnits:[{condition:null,relationship:summary,childNormalizedHash:'retained'}],candidates:command.input.candidates}]}};
  },logger:()=>{}});
  assert.equal(result.ok,true);assert.equal(result.value.candidates.length,1);assert.deepEqual(commands.map(c=>c.phase),['extraction','normalization','grounding']);
});
test('collapsed then expanded course index follows latest displayed child order',async()=>{
 const a=course+'section-a',child=course+'child-b',later=course+'section-c';
 const collapsed={navigation:{url:source,title:'Course',controls:[control('a','Section A',a,0),control('c','Section C',later,1),control('expand','Expand all',null,2,'button')],truncated:false}};
 const expanded={navigation:{...collapsed.navigation,controls:[control('a','Section A',a,0),control('b','Child B',child,1),control('c','Section C',later,2)]}};
 const f=fixture([{...choice('click'),targetId:'expand'},choice('ready',[a,child,later])]);f.deps.inspect=async()=>({ok:true,value:collapsed});f.deps.click=async()=>({ok:true,value:expanded});
 const result=await discoverHybridNavigation(f.deps);assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.value.lessonUrls,[a,child,later]);assert.equal(result.value.observations.length,2);
});
test('invalid ready scope produces model feedback then accepts corrected evidenced course scope',async()=>{
 const invalid={...choice('ready'),sourceRootUrl:source};const f=fixture([choice('click'),invalid,choice()]);const result=await discoverHybridNavigation(f.deps);
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.inputs[2].input.lastDecisionFailure.kind,'NavigationLessonScopeInvalid');assert.ok(f.memories.some(memory=>memory.phase==='navigation-plan-rejected'));assert.equal(result.value.observations.length,3);
});
test('identical invalid ready decisions halt rather than consuming the full turn cap',async()=>{
 const invalid=choice('ready',[urls[2],urls[0]]);const f=fixture([choice('click'),invalid,invalid]);const result=await discoverHybridNavigation(f.deps);
 assert.equal(result.error.kind,'NavigationActionRepeated');assert.equal(f.inputs.length,3);
});
test('latest complete index takes precedence over earlier partial previous and next navigation order',async()=>{
 const partial={navigation:{url:source,title:'Course',controls:[control('next','Next',urls[2],0),control('previous','Previous',urls[0],1),control('index','Course index',null,2,'button')],truncated:false}};
 const f=fixture([{...choice('click'),targetId:'index'},choice()]);f.deps.inspect=async()=>({ok:true,value:partial});f.deps.click=async()=>({ok:true,value:opened});assert.equal((await discoverHybridNavigation(f.deps)).ok,true);
});

test('partial observed indexes preserve each selected-link intersection while ready feedback keeps memory',async()=>{
 const partial={navigation:{url:source,title:'Course',controls:[control('a','First',urls[0],0),control('c','Third',urls[2],1),control('expand','Expand nested sections',null,2,'button')],truncated:false}};
 const expanded={navigation:{...partial.navigation,controls:[control('b','Second',urls[1],0),control('c','Third',urls[2],1)]}};
 const f=fixture([{...choice('click'),targetId:'expand'},choice('ready',[urls[1],urls[2],urls[0]]),choice()]);f.deps.inspect=async()=>({ok:true,value:partial});f.deps.click=async()=>({ok:true,value:expanded});
 const result=await discoverHybridNavigation(f.deps);assert.equal(result.ok,true);assert.equal(f.inputs[2].input.lastDecisionFailure.kind,'NavigationLessonOrderInvalid');assert.equal(f.inputs[2].input.observations.length,3);assert.match(f.inputs[0].systemPrompt,/expand collapsed indexes or nested section navigation/);
});
test('stale direct or robots-wrapped clicks refresh observations and let the agent choose fresh dialog recovery',async()=>{
 for(const duringRobots of [false,true]){
  const dialog={navigation:{...initial.navigation,controls:[{...control('dismiss','Close',null,0,'button'),region:'dialog'},{...initial.navigation.controls[0],id:'fresh-tab',order:1}]}};
  const f=fixture([choice('click'),{...choice('click'),targetId:'dismiss'},choice('click'),choice()]);let inspections=0,stale=true;
  f.deps.inspect=async()=>({ok:true,value:++inspections===1?initial:dialog});
  f.deps.checkRobots=async(_url,_root,action)=>{if(duringRobots&&stale&&action){stale=false;return {ok:false,error:{kind:'RobotsTargetUnavailable',causeKind:'KnowledgeBrowserObservationStale'}};}return {ok:true,value:null};};
  f.deps.click=async command=>{f.calls.push(['click',command]);if(!duringRobots&&stale){stale=false;return {ok:false,error:{kind:'KnowledgeBrowserObservationStale'}};}return {ok:true,value:command.targetId==='dismiss'?initial:opened};};
  const result=await discoverHybridNavigation(f.deps);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.inputs[1].input.lastActionFailure.kind,'KnowledgeBrowserObservationStale');assert.equal(f.inputs[1].input.currentPage.controls[0].region,'dialog');assert.deepEqual(f.inputs[1].input.processedUrls,[urls[0]]);assert.ok(f.memories.some(memory=>memory.phase==='navigation-stale-observed'));assert.equal(f.calls.some(call=>call[0]==='screenshot'),false);
 }
});
test('unchanged stale intent with remapped IDs halts, while authentication errors remain hard failures',async()=>{
 const repeated=fixture([choice('click'),{...choice('click'),targetId:'fresh-tab'}]);let inspections=0,clicks=0;
 repeated.deps.inspect=async()=>({ok:true,value:++inspections===1?initial:{navigation:{...initial.navigation,controls:[{...initial.navigation.controls[0],id:'fresh-tab'}]}}});repeated.deps.click=async()=>{clicks++;return {ok:false,error:{kind:'KnowledgeBrowserObservationStale'}};};
 assert.equal((await discoverHybridNavigation(repeated.deps)).error.kind,'NavigationActionRepeated');assert.equal(clicks,1);
 const denied=fixture();denied.deps.checkRobots=async(_url,_root,action)=>action?{ok:false,error:{kind:'RobotsTargetUnavailable',causeKind:'KnowledgePageAuthenticationRequired'}}:{ok:true,value:null};assert.equal((await discoverHybridNavigation(denied.deps)).error.causeKind,'KnowledgePageAuthenticationRequired');assert.equal(denied.inputs.length,1);assert.equal(denied.calls.filter(call=>call[0]==='inspect').length,1);
});
test('a changed stale navigation lets the agent select a fresh target but another unchanged stale attempt halts',async()=>{
 const fresh={navigation:{...initial.navigation,controls:[{...initial.navigation.controls[0],id:'fresh-tab'},control('extra','Additional navigation',null,1,'button')]}};
 const remapped={navigation:{...fresh.navigation,controls:fresh.navigation.controls.map((c,i)=>({...c,id:i===0?'newest-tab':c.id}))}};
 const f=fixture([choice('click'),{...choice('click'),targetId:'fresh-tab'},{...choice('click'),targetId:'newest-tab'}]);let inspections=0,clicks=0;
 f.deps.inspect=async()=>({ok:true,value:++inspections===1?initial:inspections===2?fresh:remapped});f.deps.click=async command=>{clicks++;f.calls.push(['click',command]);return {ok:false,error:{kind:'KnowledgeBrowserObservationStale'}};};
 const result=await discoverHybridNavigation(f.deps);assert.equal(result.error.kind,'NavigationActionRepeated');assert.equal(clicks,2);assert.deepEqual(f.calls.filter(call=>call[0]==='click').map(call=>call[1].targetId),['tab','fresh-tab']);assert.equal(f.memories.filter(memory=>memory.phase==='navigation-stale-observed').length,2);
});

function lessonFixture(outputs=[{action:'click',targetId:'close',rationale:'Dismiss the observed ordinary dialog.'},{action:'click',targetId:'next',rationale:'Reach the fixed next lesson.'}]){
 const currentUrl=urls[0],targetUrl=urls[1],calls=[],inputs=[],memories=[];
 const close={...control('close','Close',null,0,'button'),region:'dialog'};
 const clear={navigation:{url:currentUrl,title:'First lesson',controls:[control('next','Next lesson',targetUrl,0),control('other','Another lesson',urls[2],1)],truncated:false},bytes:new Uint8Array([11])};
 const dialog={...clear,navigation:{...clear.navigation,controls:[close,...clear.navigation.controls.map(c=>({...c,order:c.order+1}))]}};
 const arrived={...clear,navigation:{...clear.navigation,url:targetUrl,title:'Second lesson'},bytes:new Uint8Array([22])};
 const deps={currentUrl,targetUrl,sourceRootUrl:course,processedUrls:[currentUrl],lessOften:[{id:'skip',summary:'Synthetic unwanted concept.'}],initialFailure:{kind:'RobotsTargetUnavailable',causeKind:'KnowledgeBrowserClickObstructed'},maximumTurns:8,deadlineAtMs:100000,nowMs:()=>1,inspect:async command=>{calls.push(['inspect',command]);return {ok:true,value:dialog};},click:async command=>{calls.push(['click',command]);return {ok:true,value:command.targetId==='close'?clear:arrived};},screenshot:async command=>{calls.push(['screenshot',command]);return {ok:true,value:{bytes:new Uint8Array([1]),mediaType:'image/png'}};},generate:async command=>{inputs.push(command);return {ok:true,value:outputs.shift()};},remember:async p=>{memories.push(p);return {ok:true,value:null};},checkRobots:async(url,root,command)=>{calls.push(['robots',url,root,command]);return {ok:true,value:null};}};
 return {deps,calls,inputs,memories,dialog,clear,arrived};
}
test('fixed lesson recovery lets the model dismiss an ordinary dialog then reaches the planned destination exactly once',async()=>{
 const f=lessonFixture();
 const handoff=createRobotsNavigationHandoff({sourceUrl:source,readPage:async()=>{throw new Error('Unselected navigation must not run.');},click:f.deps.click});
 f.deps.checkRobots=async(url,root,command)=>{handoff.prepare(url,root,command);return handoff.captureTarget(url);};f.deps.click=handoff.click;
 const result=await navigateHybridLesson(f.deps);
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value,f.arrived,'Return the actual full capture for extraction.');
 assert.deepEqual(f.calls.filter(c=>c[0]==='click').map(c=>c[1].targetId),['close','next']);
 assert.equal(f.inputs.length,2);assert.equal(f.inputs[0].input.targetUrl,urls[1]);assert.equal(f.inputs[0].input.sourceRootUrl,course);
 assert.deepEqual(f.inputs[0].input.processedUrls,[urls[0]]);assert.deepEqual(f.inputs[0].input.lessOften,f.deps.lessOften);
 assert.equal(f.inputs[0].input.lastActionFailure.kind,'KnowledgeBrowserClickObstructed');assert.equal(f.inputs[0].attachments[0].id,'lesson-obstruction-initial');
 assert.equal(f.inputs[1].input.lastActionFailure,null);assert.equal(f.inputs[1].input.observations.length,2);
 assert.deepEqual(f.deps.processedUrls,[urls[0]],'Navigation must not mutate extraction memory.');
 assert.ok(f.memories.some(m=>m.phase==='lesson-navigation-action-result'));
});
test('fixed lesson recovery rejects wandering, processed destinations, premature arrival and access blockers without bypass',async()=>{
 const wandering=lessonFixture([{action:'click',targetId:'other',rationale:'Try another lesson.'}]);assert.equal((await navigateHybridLesson(wandering.deps)).error.kind,'NavigationTargetInvalid');assert.equal(wandering.calls.filter(c=>c[0]==='click').length,0);
 const processed=lessonFixture();processed.deps.processedUrls.push(urls[1]);assert.equal((await navigateHybridLesson(processed.deps)).error.kind,'NavigationTargetAlreadyProcessed');assert.equal(processed.calls.length,0);
 const premature=lessonFixture([{action:'arrived',targetId:null,rationale:'Claim completion.'}]);assert.equal((await navigateHybridLesson(premature.deps)).error.kind,'NavigationTargetNotReached');
 const denied=lessonFixture();denied.deps.initialFailure={kind:'RobotsTargetUnavailable',causeKind:'KnowledgePageAuthenticationRequired'};assert.equal((await navigateHybridLesson(denied.deps)).error.causeKind,'KnowledgePageAuthenticationRequired');assert.equal(denied.calls.length,0);assert.equal(denied.inputs.length,0);
 const blocked=lessonFixture([{action:'blocked',targetId:null,rationale:'Observed access challenge.'}]);assert.equal((await navigateHybridLesson(blocked.deps)).error.kind,'NavigationBlocked');assert.equal(blocked.calls.filter(c=>c[0]==='click').length,0);
});
test('an unchanged dismissal cannot authorize retrying the obstructed destination',async()=>{
 const f=lessonFixture();f.deps.click=async command=>{f.calls.push(['click',command]);return {ok:true,value:{...f.dialog,navigation:{...f.dialog.navigation,controls:f.dialog.navigation.controls.map(c=>({...c,id:c.id==='close'?'fresh-close':c.id}))}}};};
 assert.equal((await navigateHybridLesson(f.deps)).error.kind,'NavigationActionRepeated');assert.deepEqual(f.calls.filter(c=>c[0]==='click').map(c=>c[1].targetId),['close']);
});
test('fixed lesson recovery refreshes direct or wrapped stale targets without replaying old IDs',async()=>{
 for(const wrapped of [false,true]){
  const f=lessonFixture([{action:'click',targetId:'next',rationale:'Reach next lesson.'},{action:'click',targetId:'close',rationale:'Dismiss observed ordinary dialog.'},{action:'click',targetId:'next',rationale:'Reach next lesson after dismissal.'}]);delete f.deps.initialFailure;
  let inspections=0,failed=false;
  f.deps.inspect=async()=>({ok:true,value:++inspections===1?f.clear:f.dialog});
  const fail=()=>({ok:false,error:wrapped?{kind:'RobotsTargetUnavailable',causeKind:'KnowledgeBrowserObservationStale'}:{kind:'KnowledgeBrowserObservationStale'}});
  const originalClick=f.deps.click;
  if(wrapped)f.deps.checkRobots=async(_url,_root,command)=>{if(!failed&&command.targetId==='next'){failed=true;return fail();}return {ok:true,value:null};};
  else f.deps.click=async command=>{if(!failed&&command.targetId==='next'){failed=true;return fail();}return originalClick(command);};
  const result=await navigateHybridLesson(f.deps);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.inputs[1].input.lastActionFailure.kind,'KnowledgeBrowserObservationStale');assert.equal(inspections,2);assert.equal(result.value,f.arrived);
 }
});
test('lesson transition retains cancellation, post-model deadlines and finite turns',async()=>{
 const canceled=lessonFixture();canceled.deps.stopRequested=async()=>true;assert.equal((await navigateHybridLesson(canceled.deps)).error.kind,'NavigationCancelled');assert.equal(canceled.calls.length,0);
 const expired=lessonFixture();let now=1;expired.deps.nowMs=()=>now;const generate=expired.deps.generate;expired.deps.generate=async command=>{const r=await generate(command);now=100001;return r;};assert.equal((await navigateHybridLesson(expired.deps)).error.kind,'NavigationDeadlineExceeded');assert.equal(expired.calls.filter(c=>c[0]==='click').length,0);
 const capped=lessonFixture();capped.deps.maximumTurns=1;assert.equal((await navigateHybridLesson(capped.deps)).error.kind,'NavigationTurnLimitExceeded');assert.equal(capped.inputs.length,1);
});
test('same-document fragment controls preserve the fixed target and arrival on the last permitted model turn succeeds',async()=>{
 const f=lessonFixture([{action:'click',targetId:'fragment',rationale:'Reveal the current document section.'},{action:'click',targetId:'next',rationale:'Reach the reviewed next lesson.'}]);delete f.deps.initialFailure;f.deps.maximumTurns=2;
 const fragment={...f.clear,navigation:{...f.clear.navigation,controls:[control('fragment','Lesson section',urls[0]+'#content',0),...f.clear.navigation.controls.map(c=>({...c,order:c.order+1}))]}};
 f.deps.inspect=async()=>({ok:true,value:fragment});f.deps.click=async command=>{f.calls.push(['click',command]);return {ok:true,value:command.targetId==='fragment'?{...f.clear,navigation:{...f.clear.navigation,url:urls[0]+'#content'}}:f.arrived};};
 const result=await navigateHybridLesson(f.deps);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value,f.arrived);assert.equal(f.inputs.length,2);assert.equal(f.inputs[1].input.currentPage.url,urls[0]+'#content');assert.equal(f.inputs[1].input.targetUrl,urls[1]);
});
test('lesson recovery rejects a historical Close ID and supplies fresh-control feedback without clicking Skip to content',async()=>{
 const f=lessonFixture([{action:'click',targetId:'observation-1-control-0',rationale:'Close the ordinary dialog.'},{action:'click',targetId:'observation-1-control-0',rationale:'Close the old dialog again.'},{action:'click',targetId:'observation-2-control-1',rationale:'Use the currently observed next lesson.'}]);
 f.dialog.navigation.controls=f.dialog.navigation.controls.map((c,i)=>({...c,id:'observation-1-control-'+i}));
 f.clear.navigation.controls=[control('observation-2-control-0','Skip to content',urls[0]+'#content',0),control('observation-2-control-1','Next lesson',urls[1],1)];
 f.deps.click=async command=>{f.calls.push(['click',command]);return {ok:true,value:command.targetId==='observation-1-control-0'?f.clear:f.arrived};};
 const r=await navigateHybridLesson(f.deps);assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(f.calls.filter(c=>c[0]==='click').map(c=>c[1].targetId),['observation-1-control-0','observation-2-control-1']);assert.equal(f.inputs[2].input.lastDecisionFailure.kind,'NavigationTargetObservationStale');assert.equal(f.inputs[2].input.lastDecisionFailure.targetId,'observation-1-control-0');assert.equal(f.inputs[2].input.currentPage.controls[0].label,'Skip to content');assert.ok(f.memories.some(m=>m.phase==='lesson-navigation-target-rejected'));assert.match(f.inputs[2].systemPrompt,/Only currentPage.controls supplies authoritative clickable IDs/);
});
test('unchanged repeated invalid IDs halt and discovery also returns typed fresh-ID feedback',async()=>{
 const staleChoice={action:'click',targetId:'historical-close',rationale:'Select an obsolete control.'};const repeated=lessonFixture([staleChoice,staleChoice]);assert.equal((await navigateHybridLesson(repeated.deps)).error.kind,'NavigationActionRepeated');assert.equal(repeated.calls.filter(c=>c[0]==='click').length,0);assert.equal(repeated.inputs.length,2);
 const f=fixture([choice('click'),choice('click'),choice()]);const r=await discoverHybridNavigation(f.deps);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(f.inputs[2].input.lastDecisionFailure.kind,'NavigationTargetObservationStale');assert.equal(f.inputs[2].input.lastDecisionFailure.targetId,'tab');assert.equal(f.calls.filter(c=>c[0]==='click').length,1);assert.ok(f.memories.some(m=>m.phase==='navigation-target-rejected'));assert.match(f.inputs[2].systemPrompt,/Only currentPage.controls supplies authoritative clickable IDs/);
});

test('platform navigation includes observed sibling courses and stays on the selected origin',async()=>{
  const sibling='https://example.test/other-course/lesson';
  const f=fixture([{...choice('ready',[source,sibling]),sourceRootUrl:'https://example.test/'}]);
  f.deps.extractionScope='platform';
  f.deps.inspect=async c=>{f.calls.push(['inspect',c]);return {ok:true,value:{navigation:{...initial.navigation,controls:[control('sibling','Other course',sibling,0)]}}};};
  const r=await discoverHybridNavigation(f.deps);
  assert.equal(r.ok,true);assert.deepEqual(r.value.lessonUrls,[source,sibling]);
  assert.equal(f.calls.find(c=>c[0]==='inspect')[1].rootUrl,'https://example.test/');
  assert.match(f.inputs[0].systemPrompt,/entire same-origin platform/);
  const narrowed=fixture([choice('ready',[source])]);narrowed.deps.extractionScope='platform';
  assert.equal((await discoverHybridNavigation(narrowed.deps)).error.kind,'NavigationLessonScopeInvalid');
});
