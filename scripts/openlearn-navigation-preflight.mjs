import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createExtractionRunner} from '../src/features/knowledge-workflows/extraction.js';

// Offline diagnostics of the real runner, using deliberately constructed observations
// and planner outputs. This file never contacts a model or acquisition provider.
const directory=resolve('test-results/openlearn-navigation-20261013');
const course='https://www.open.edu/openlearn/history-the-arts/music/an-introduction-music-theory/';
const rootUrl=course+'content-section-0?active-tab=description-tab';
const displayedOrder=['content-section-1.1','content-section-2.1','content-section-2.2'].map(path=>course+path);
await mkdir(directory,{recursive:true});
const preferencesPath=directory+'/less-often.json';
try{await readFile(preferencesPath);}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(preferencesPath,JSON.stringify({lessOften:[{id:'isolated-treble-clef',summary:'The treble clef marks G above middle C on the second staff line.'},{id:'isolated-bass-clef',summary:'The bass clef marks F below middle C on the fourth staff line.'}]},null,2)+'\n',{flag:'wx',mode:0o600});}
const preferences=JSON.parse(await readFile(preferencesPath,'utf8'));
if(Object.keys(preferences).join(',')!=='lessOften'||!Array.isArray(preferences.lessOften)||!preferences.lessOften.every(item=>typeof item.id==='string'&&typeof item.summary==='string'))throw new Error('IsolatedLessOftenFileInvalid');

async function exercise({root,frontier,reorder=false,alias=false,resume=false}){
  const scope={ownerId:'isolated-openlearn',runId:'offline-fixture',sourceId:'openlearn-course',sourceRevision:1};
  let scratchpad={...scope,processedUrls:[],frontier:[],discoveredUrls:[],acceptedHashes:[],similarityEvidence:[],coverage:[],unresolvedGaps:[],consecutiveNoveltyZero:0,pageNotes:[],revision:1};
  const fetches=[],decisions=[];
  let pause=resume;
  const plan=(urls,revision=1)=>({revision,frontier:urls,coverageGoals:[],unresolvedGaps:[],stopDecision:{decision:urls.length?'continue':'complete',rationale:'Constructed offline plan; not a real model decision.',evidenceUrls:[],unresolvedGapIds:[]}});
  const dependencies={rights:{status:'allowed',sourceId:scope.sourceId,sourceRevision:scope.sourceRevision},robots:{status:'allowed'},
    planner:{async plan(){return {ok:true,value:plan(frontier)};},async replan({previous,scratchpad}){let next=frontier.filter(url=>!scratchpad.processedUrls.includes(url));if(reorder&&next.length>1)next.reverse();return {ok:true,value:plan(next,previous.revision+1)};}},
    acquirer:{async fetchPage({url}){fetches.push(url);return {ok:true,value:{url,title:'Constructed lesson fixture',byteCount:50,redirects:0,links:[],observedAt:'2026-10-13T00:00:00.000Z',candidates:[{summary:'Constructed educational relationship; not extracted from OpenLearn.',normalizedHash:alias?'same-content':url,evidenceAnchors:[{url,selector:'main'}],coverageGoalIds:[],mediaCandidates:[]}]}};}},
    scratchpad:{async load(){return {ok:true,value:scratchpad};},async save(value){scratchpad=value;return {ok:true,value:null};}},knowledge:{async append(){return {ok:true,value:null};}},
    memory:{async append(record){if(record.kind==='decision')decisions.push(record.payload);return {ok:true,value:null};}},
    stopRequested:()=>pause&&fetches.length>0,now:()=> '2026-10-13T00:00:00.000Z',nowMs:()=>0,logger:()=>{},
    policy:{maximumFrontier:20,maximumPageBytes:1000,maximumRedirects:3,maximumPages:10,maximumDurationMs:1800000}};
  const command={...scope,rootUrl:root,startedAtMs:0,deadlineAtMs:1800000};
  const first=await createExtractionRunner(dependencies).run(command);
  if(resume){pause=false;await createExtractionRunner(dependencies).run(command);}
  return {fixtureResult:first.ok?first.value.state:first.error.kind,fetchedUrls:fetches,processedUrls:scratchpad.processedUrls,decisions};
}

const siblings=await exercise({root:rootUrl,frontier:[displayedOrder[0]]});
const ordering=await exercise({root:course,frontier:displayedOrder,reorder:true});
const aliases=await exercise({root:course,frontier:[displayedOrder[0],displayedOrder[0]+'?fixture-alias=1'],alias:true});
const resumed=await exercise({root:course,frontier:displayedOrder.slice(0,2),resume:true});
// Connectivity checks are unauthenticated GETs, not model or scrape dispatches.
const connectivity=await Promise.all(['https://openrouter.ai/api/v1/models','https://api.firecrawl.dev/v2/team/credit-usage'].map(async url=>{
  try{const response=await fetch(url,{signal:AbortSignal.timeout(5000)});await response.body?.cancel();return {url,httpStatus:response.status,networkReached:true};}
  catch(error){return {url,networkReached:false,failure:error.cause?.code??error.name};}
}));
const report={version:'openlearn-navigation-preflight-v1',recordedAt:new Date().toISOString(),rootUrl,
  executionScope:'offline-real-runner-diagnostics-and-free-connectivity-probes',liveScraperStatus:connectivity.every(item=>item.networkReached)?'not-started':'not-started-network-unavailable',connectivity,liveCoverageVerified:false,
  sourceProvenance:{url:rootUrl,method:'independent read-only web inspection of course navigation; not scraper evidence',sampleDisplayedOrder:displayedOrder},
  preferences:{path:preferencesPath,provenance:'constructed isolated see-less-only test preferences',itemCount:preferences.lessOften.length,learnerRecordsModified:false},
  liveRunLimits:{modelApiUSD:1,firecrawlCredits:100,stopWhen:'either limit is reached; reserve before chargeable work',activation:null,modelRequests:0,modelApiUSDConsumed:0,firecrawlCreditsConsumed:0},
  offlineObservations:{siblings:{...siblings,requirementMet:siblings.fetchedUrls.includes(displayedOrder[0])},displayOrder:{...ordering,expectedOrder:displayedOrder,requirementMet:JSON.stringify(ordering.fetchedUrls)===JSON.stringify(displayedOrder)},contentAliases:{...aliases,requirementMet:aliases.fetchedUrls.length===1},exactUrlResume:{...resumed,requirementMet:resumed.fetchedUrls.length===2&&new Set(resumed.fetchedUrls).size===resumed.fetchedUrls.length}},
  remainingUnverified:['Actual model tab/panel reasoning and action selection','Complete useful lesson-content coverage','Semantic see-less exclusion before extraction','Live budget and credit enforcement','Live cancellation and removal of generated descendants'],
  deferredLibraryCard:{condition:'Implement after complete relevant live coverage is verified within the authorized budget',placement:'Source Library knowledge card; redirect to it immediately after Extract knowledge points',refreshMilliseconds:60000,fields:['current page URL','page or content title','current section','extracted knowledge points','generated quiz question count'],cancel:'After confirmation stop processing and remove every knowledge point and quiz generated by the current process'},
  visualApproachRecommendation:{status:'recommendation-only; not implemented',approach:'Model selects observed browser actions using labeled DOM/accessibility structure and screenshots as needed; text extraction remains source-grounded',providerDocs:'https://docs.firecrawl.dev/features/interact'},
  passed:false};
await writeFile(directory+'/report.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({report:directory+'/report.json',liveScraperStatus:report.liveScraperStatus,paidCalls:0,observations:Object.fromEntries(Object.entries(report.offlineObservations).map(([key,value])=>[key,{requirementMet:value.requirementMet,fixtureResult:value.fixtureResult}]))},null,2));
