// Synthetic local fixture only: no hosted requests, fresh browser context.
import assert from 'node:assert/strict';
import { buildProgress } from '../src/features/progress/public.js';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { chromium } from 'playwright-core';
import {captureThemeScreenshot} from './browser-theme-ready.mjs';
const uploadStatusOnly = process.argv.includes('--upload-status-only');
const imageCardsOnly = process.argv.includes('--image-cards-only');
const statusChecks = !process.argv.includes('--layout-only') && !imageCardsOnly;
const diagnostic = process.argv.includes('--diagnostic-shell');
const root = resolve(process.argv.find(argument => argument.startsWith('--build-root='))?.slice('--build-root='.length) ?? 'dist');
const output = resolve('test-results/ui-fixes', `${process.argv.includes('--layout-only') ? 'layout' : 'browser'}-${Date.now()}`);
await mkdir(output, {recursive:true});
const report = { status:'RUNNING', checks:0, buildRoot:root, diagnosticShell:diagnostic, providerExecution:'mocked-local-fixtures', modelExecution:'mocked-local-fixtures; runtime separately tested in SQLite', actions:[], screenshots:[], failures:[], errors:[], requests:[], serverResponses:[], cleanup:{context:false,browser:false,server:false} };
const server = createServer((req,res) => {
  res.once('finish', () => report.serverResponses.push({path:new URL(req.url,'http://localhost').pathname,method:req.method,status:res.statusCode}));
  // Match the packaged filenames, including URL-encoded spaces in offline shell assets.
  const path = resolve(root, `.${decodeURIComponent(new URL(req.url,'http://localhost').pathname)}`);
  if (path !== root && !path.startsWith(root+sep)) return res.writeHead(403).end();
  const file = path === root ? resolve(root,'index.html') : path;
  const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2'};
  res.setHeader('content-type',types[extname(file)] ?? 'application/octet-stream');
  const stream = createReadStream(file);
  stream.on('error', () => {res.writeHead(404);res.end();});
  stream.pipe(res);
});
await new Promise((done,reject) => {server.once('error',reject);server.listen(0,'localhost',done);});
const origin = `http://localhost:${server.address().port}`;
const title = 'Actual synthetic source <title> & ' + 'Long source title '.repeat(12);
const filename = 'long-synthetic-filename-'.repeat(10)+'.pdf';
const fixtureSource = id => ({id,ownerId:'fixture-owner',origin:'private-document',submittedUrl:`https://example.test/api/private-documents/${id}`,canonicalUrl:`https://example.test/api/private-documents/${id}`,title:'Synthetic owned material',description:'fixture.txt',adapter:{id:'private-document',version:'1',granularity:'document',capabilities:['owner-private-document']},interestAreaIds:[],identityEvidence:[],state:'active',revision:1,approvedAt:'2026-10-05T00:00:00.000Z',updatedAt:'2026-10-05T00:00:00.000Z'});
let workflowPhase='extraction-loop', statusOutage=false, materialUploadCount=0, extractCount=0, cancelFailure=false, searchSequence=0;
const extracted=new Map(), suppressed=new Set();
let supportingImage;
const cardFacts = ['A ratio compares two quantities by division.', 'A denominator must be nonzero.', 'Equivalent ratios preserve the same comparison.', 'Units provide context for quantities.', 'A comparison must identify both quantities.'];
const cardItems = cardFacts.map((summary,index)=>({knowledgeId:`fixture-card-${index}`,sourceId:'fixture-card-source',sourceRevision:1,questionId:`fixture-question-${index}`,title:'Synthetic ratio lesson',summary,sourceUrl:'https://example.test/ratios',evidenceAnchorIds:[`fixture-text-${index}`],sourceClassification:null,sourceClassificationRevision:0,questionLocked:true,media:index===0?{assetId:'fixture-support',kind:'image',url:'/api/learning-media?assetId=fixture-support&variant=feed',attribution:'Synthetic quantity comparison'}:null}));
const workflowStatus = id => extracted.has(id) ? {sourceId:id,run:{...workflowStatus('fixture-second').run,runId:`run-${id}`,state:extracted.get(id).state,revision:extracted.get(id).revision??1},reasonCode:null,message:extracted.get(id).warning??null} : ({sourceId:id,run:{runId:`run-${id}`,state:id==='fixture-first'?'completed':workflowPhase,revision:1,counts:{pages:0,knowledgePoints:0,acceptedQuizzes:0,pendingQuizzes:0},extractionStartedAt:null,extractionDeadlineAt:null,elapsedMs:null,remainingMs:null,decisionRequired:null,failureKind:null,robotsEvidence:null},reasonCode:null,message:null});
let browser, context, page;
const check = (condition,message) => {report.checks++; if(!condition) report.failures.push(message);};
try {
  browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  context = await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'allow'});
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {
      report.requests.push({external:url.href});
      // A new-tab target is fulfilled locally, never fetched from outside.
      return route.fulfill({contentType:'text/html',body:'<h1>Synthetic source target</h1>'});
    }
    if(!url.pathname.startsWith('/api/')) return route.continue();
    report.requests.push({path:url.pathname,method:request.method(),sourceId:url.searchParams.get('sourceId'),cursor:url.searchParams.get('cursor'),at:Date.now()});
    if(url.pathname.endsWith('/progress')) return route.fulfill({json:{result:buildProgress({from:'2026-09-06T00:00:00.000Z',to:'2026-10-05T23:59:59.999Z',subject:null,batches:[],attempts:[],questions:[]})}});
    if(imageCardsOnly && url.pathname==='/api/learning-media') return route.fulfill({contentType:'image/png',body:supportingImage});
    if(url.pathname.endsWith('/feed-batch')) return route.fulfill({json:{result:imageCardsOnly?{batch:{batchId:'fixture-image-cards',learningDay:'2026-10-06',status:'open',itemIds:cardItems.map(item=>item.knowledgeId),revision:1,createdAt:'2026-10-06T00:00:00.000Z',completedAt:null},items:cardItems}:{batch:null,items:[]}}});
    if(url.pathname.endsWith('/review-batch')) return route.fulfill({json:{result:{batch:null,questions:[],dueCount:0}}});
    if(url.pathname === '/api/source-library') return route.fulfill({json:{result:{items:statusChecks?[fixtureSource(url.searchParams.has('cursor')?'fixture-second':'fixture-first'),...(!url.searchParams.has('cursor')?[...extracted.values()].map(entry=>entry.source):[])]:[],interestAreas:[{id:'area-a',ownerId:'fixture-owner',title:'Music',provenance:'configured'}],nextCursor:statusChecks&&!url.searchParams.has('cursor')?'page-two':null}}});
    if(url.pathname.endsWith('/source-status')) return route.fulfill({status:statusOutage?503:200,json:statusOutage?{error:'SyntheticUnavailable'}:{result:workflowStatus(url.searchParams.get('sourceId'))}});
    if(statusChecks && url.pathname.endsWith('/upload-context')) return route.fulfill({json:{result:{source:fixtureSource(url.searchParams.get('sourceId')),runId:url.searchParams.get('runId'),reason:'This synthetic source is awaiting attachment. Re-upload material.'}}});
    if(statusChecks && url.pathname.endsWith('/material')) {
      materialUploadCount++;
      const body=request.postData()??'';
      check(!body.includes('rightsAttestation')&&!body.includes('name="ownerId"'),'Upload sends no attestation/owner forgery');
      if(request.headers()['content-type']?.startsWith('multipart/')) check(/name="mode"\r\n\r\nimage/u.test(body),'Images use unconditional image mode');
      await new Promise(resolve=>setTimeout(resolve,1200));
      return route.fulfill({json:{result:{status:'attached',materialId:'fixture-material',runId:request.headers()['content-type']?.startsWith('multipart/')?body.match(/name="runId"\r\n\r\n([^\r\n]+)/u)?.[1]:JSON.parse(body).runId,reused:false}}});
    }
    if(url.pathname.endsWith('/library-knowledge')) return route.fulfill({json:{result:{items:[...extracted.values()].filter(entry=>entry.state==='completed').map(entry=>({knowledgeId:`knowledge-${entry.source.id}`,sourceId:entry.source.id,sourceRevision:1,sourceClassificationRevision:0,sourceClassification:null,questionId:`question-${entry.source.id}`,title:'Explicit mocked fixture point',sourceUrl:entry.source.canonicalUrl,evidenceAnchorIds:['main'],media:null,summary:'Mocked supported diagram relation; paired quizzes validated in the separate SQLite fixture.',questionLocked:true,primarySubject:null,sourceTopic:'Fixture course'}))}}});
    if(url.pathname.endsWith('/suppressions/check')) return route.fulfill({json:{result:JSON.parse(request.postData()).canonicalIdentities.filter(identity=>suppressed.has(identity))}});
    if(url.pathname.endsWith('/capabilities')) return route.fulfill({json:{result:[{id:'web',label:'Web sources',resultKind:'web',priority:1,enabled:true},{id:'secondary',label:'Secondary web provider',resultKind:'web',priority:2,enabled:true}]}});
    if(url.pathname === '/api/discovery/search') {
      const command=JSON.parse(request.postData()),sourceUrl=`https://example.test/actual-source?x=1&y=2&fixture=${++searchSequence}`;
      const candidate={providerId:'web',resultKind:'web',sourceLevel:'document',title,description:'Provider exact <snippet> & claim.',canonicalUrl:sourceUrl,publisherLabel:'Unverified provider label',publishedAt:null,identityEvidence:[{attribute:'canonical-url',value:sourceUrl,provenanceUrl:sourceUrl}]};
      const items=[candidate,{...candidate,providerId:'secondary',title:'Provider B exact <claim>'},candidate];
      return route.fulfill({json:{result:{items,providerFailures:command.query==='provider-error'?[{providerId:'secondary',failure:{kind:'SearchProviderTimedOut'}}]:[],submittedQuery:command.query,providerQuery:command.query,policyVersion:'fixture'}}});
    }
    if(url.pathname === '/api/source-library/extract') {
      const command=JSON.parse(request.postData());extractCount++;
      check(!Object.hasOwn(command,'ownerId')&&!Object.hasOwn(command,'rightsAttestation'),'Extraction uses session ownership without rights attestation');
      if((command.url??command.canonicalUrl).includes('access-denied'))return route.fulfill({status:422,json:{error:'KnowledgePageAuthenticationRequired'}});
      const id=`extract-${extractCount}`,sourceUrl=command.url??command.canonicalUrl;
      const source={...fixtureSource(id),origin:'external',submittedUrl:sourceUrl,canonicalUrl:sourceUrl,title:command.title,description:command.description??'',adapter:command.adapter??{id:'submitted-link',version:'v1',granularity:'document',capabilities:['metadata','bounded-ingestion']},interestAreaIds:command.interestAreaIds??[command.interestAreaId],identityEvidence:command.identityEvidence??[{attribute:'user-submitted-url',value:sourceUrl,provenanceUrl:sourceUrl,observedAt:'2026-10-06T00:00:00.000Z'}]};
      extracted.set(id,{source,state:'extraction-loop'});
      return route.fulfill({json:{result:{source,reused:false},workflow:{runId:`run-${id}`,reused:false}}});
    }
    if(url.pathname === '/api/source-library/reject') {
      const command=JSON.parse(request.postData());suppressed.add(command.canonicalIdentity);
      return route.fulfill({json:{result:{suppression:{id:'dismissal-fixture',ownerId:'fixture-owner',canonicalIdentity:command.canonicalIdentity,identityEvidence:command.identityEvidence,idempotencyKey:command.idempotencyKey,createdAt:'2026-10-06T00:00:00.000Z'},reused:false}}});
    }
    if(url.pathname === '/api/knowledge-workflows/control') {
      const command=JSON.parse(request.postData()),id=command.runId.slice(4);
      check(command.action==='abandon','Only cancellation is mutated in this isolated control fixture');
      if(cancelFailure){cancelFailure=false;extracted.get(id).state='abandoned';extracted.get(id).revision=2;return route.fulfill({status:503,json:{error:'WorkflowCleanupFailed'}});}
      extracted.get(id).state='abandoned';
      return route.fulfill({json:{result:workflowStatus(id).run}});
    }
    if(url.pathname.endsWith('/reminders') || url.pathname.endsWith('/preferences')) return route.fulfill({json:{result:{}}});
    return route.fulfill({status:503,json:{error:'SyntheticUnavailable'}});
  });
  page = await context.newPage();page.setDefaultTimeout(8000);
  await page.addInitScript(()=>{document.addEventListener('DOMContentLoaded',()=>{if(sessionStorage.getItem('fixture-text-scale')==='2'){const style=document.createElement('style');style.id='fixture-double-text';style.textContent='.discover-route :is(input,select,button,a,p),.upload-page :is(input,select,button,a,p){font-size:30px}';document.head.append(style);}});});
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(origin+'/#upload');
  await page.locator('[data-upload-form]').waitFor();
  for(let attempt=0;attempt<40;attempt++) {
    report.offlineBootstrap=await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();return {state:registration?.active?.state??null,controlled:navigator.serviceWorker.controller!==null,scriptURL:registration?.active?.scriptURL??null};});
    if(report.offlineBootstrap.state==='activated'&&report.offlineBootstrap.controlled)break;
    await page.waitForTimeout(200);
  }
  check(report.offlineBootstrap.state==='activated' && report.offlineBootstrap.controlled,'Native offline bootstrap activated and controls the page');
  report.actions.push('Await native offline bootstrap activation and page control; serve packaged assets without synthetic service responses');
  let screenshotTheme=await page.evaluate(()=>document.documentElement.dataset.theme);
  report.themeReadiness=[];
  const shot = async name => {
    check(await page.locator('.toast.error').count()===0,`${name}: no error notification obscures normal layout`);
    if(name.includes('-link')) {
      const close=page.locator('.toast:not(.error) [data-dismiss-notification]');
      if(await close.count()){await close.click();report.actions.push(name+': close preceding fixture notification using its native control');}
      await page.locator('.toast').waitFor({state:'detached'});
    }
    const path=resolve(output,name+'.png');
    report.themeReadiness.push({name,...await captureThemeScreenshot(page,{theme:screenshotTheme,path})});report.screenshots.push(path);
  };
  if(imageCardsOnly) {
    supportingImage=Buffer.from(await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=560;canvas.height=180;const ctx=canvas.getContext('2d');ctx.fillStyle='#f5f3ee';ctx.fillRect(0,0,560,180);ctx.fillStyle='#193f36';ctx.font='32px sans-serif';ctx.fillText('6 units ÷ 3 units = 2',55,90);ctx.font='20px sans-serif';ctx.fillText('Compare both quantities by division.',55,135);return canvas.toDataURL('image/png').split(',')[1];}),'base64');
    for(const theme of ['light','dark']) for(const width of [320,390,1440]) {
      await page.setViewportSize({width,height:1000});
      await page.getByRole('button',{name:'Settings',exact:true}).click();
      await page.locator(`[data-setting=theme][value=${theme}]`).check();screenshotTheme=theme;
      await page.getByRole('button',{name:'Feed',exact:true}).click();
      const cards=page.locator('.learning-card');await cards.first().waitFor();
      check(await cards.count()===5,`${theme}-${width}: five frozen text cards`);
      check(JSON.stringify(await cards.locator('.card-knowledge').allTextContents())===JSON.stringify(cardFacts),`${theme}-${width}: exact source facts unchanged`);
      const picture=cards.first().locator('[data-associated-media]');await picture.scrollIntoViewIfNeeded();
      await picture.evaluate(img=>img.decode());
      check(await picture.evaluate(img=>img.complete&&img.naturalWidth===560&&img.naturalHeight===180),`${theme}-${width}: supporting image actually decodes`);
      check(await cards.nth(1).locator('figure,img,figcaption').count()===0,`${theme}-${width}: unsupported card stays picture-free`);
      check(await page.locator('[data-associated-media]').count()===1,`${theme}-${width}: no invented or fallback media`);
      await cards.first().locator('.source-details summary').click();check(await cards.first().locator('.source-details').evaluate(details=>details.open),`${theme}-${width}: evidence disclosure opens`);
      await cards.first().locator('.source-details summary').click();
      check(await page.locator('[data-action="complete-learner-feed"]').isEnabled(),`${theme}-${width}: study action discoverable without submission`);
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${theme}-${width}: no horizontal overflow`);
      await shot(`${theme}-${width}-support-and-no-image-cards`);
      report.actions.push(`${theme}-${width}: navigate Settings/Feed, theme toggle, scroll to image, decode actual PNG, open/close source evidence, inspect picture-free card; no submissions.`);
    }
  } else {
  report.controlContrast=[];
  const contrast = async (selector, property='color', minimum=4.5, disabled=false) => {
    const evidence=await page.evaluate(({selector,property,disabled})=>{
      // Resolve and measure in one browser task; polling can detach locator handles between tasks.
      const original=document.querySelector(selector);
      if(!original)throw new Error(`ControlElementMissing: ${selector}`);
      // Render a native disabled sample in the same context; genuine pending uploads are checked below too.
      const element=disabled?original.cloneNode(true):original;
      if(disabled){element.disabled=true;original.after(element);}
      const rgb=value=>value.match(/[\d.]+/g).map(Number);
      const luminance=channels=>channels.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const disabledMatch=element.matches(':disabled');element.getBoundingClientRect();
      const style=getComputedStyle(element);let ancestor=element,background,opacity=1;
      while(ancestor){const current=getComputedStyle(ancestor);opacity*=Number(current.opacity);if(!background){const color=rgb(current.backgroundColor);if(color.length===3||color[3]>0)background=color;}ancestor=ancestor.parentElement;}
      if(!background)throw new Error('ControlBackgroundMissing');
      const foreground=rgb(style[property]),alpha=(foreground[3]??1)*opacity;
      const rendered=foreground.slice(0,3).map((v,i)=>v*alpha+background[i]*(1-alpha));
      const values=[luminance(rendered),luminance(background)].sort((a,b)=>a-b);
      const evidence={theme:document.documentElement.dataset.theme,disabled:element.disabled,disabledMatch,sample:disabled,property,color:style[property],background:background.slice(0,3),opacity,contrast:(values[1]+.05)/(values[0]+.05)};
      if(disabled)element.remove();return evidence;
    },{selector,property,disabled});
    report.controlContrast.push({selector,...evidence});
    if(disabled)check(evidence.disabled===true && evidence.disabledMatch,`${selector}: sample matches native disabled state`);
    check(evidence.contrast>=minimum,`${selector} ${property}: ${evidence.contrast} >= ${minimum}`);
  };
  const openDiscover=async()=>{
    const ready=Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/capabilities')),page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/source-library'&&url.searchParams.get('limit')==='1';})]);
    await page.locator('.primary-nav [data-view=discover]').click();await ready;await page.locator('[data-discovery-search-bound=true]').waitFor();
  };
  const headerBounds = async label => {
    const evidence=await page.locator('.topbar').evaluate(header=>{
      const brand=header.querySelector('.brand').getBoundingClientRect(), chip=header.querySelector('[data-library-processing-status]')?.getBoundingClientRect();
      return {overflow:document.documentElement.scrollWidth>innerWidth+1,overlap:chip?Math.min(brand.right,chip.right)>Math.max(brand.left,chip.left)+1&&Math.min(brand.bottom,chip.bottom)>Math.max(brand.top,chip.top)+1:false};
    });
    check(!evidence.overflow&&!evidence.overlap,`${label}: header has no overflow/brand-chip overlap ${JSON.stringify(evidence)}`);
    const chip=page.locator('.topbar [data-library-processing-status]');
    if(await chip.count()){await contrast('.topbar [data-library-processing-status]');await contrast('.topbar [data-library-processing-status]','borderTopColor',3);}
  };
  if(!uploadStatusOnly && !process.argv.includes('--layout-only')) {
    await page.locator('.primary-nav [data-view=discover]').click();
    await page.locator('[name=query]').fill('synthetic source');
    await page.locator('[data-discovery-search-form] button[type=submit]').click();
    await page.locator('.discover-results strong').filter({hasText:title}).first().waitFor();
    const explore = page.getByRole('link',{name:`Explore source: ${title} (new tab)`,exact:true}).first();
    check(await page.getByRole('link',{name:`Explore source: ${title} (new tab)`,exact:true}).count()===2,'Duplicate raw results retained with separate safe Explore actions');
    const popupPromise = page.waitForEvent('popup');
    await explore.click();const popup=await popupPromise;await popup.waitForLoadState();
    check(popup.url()==='https://example.test/actual-source?x=1&y=2&fixture=1','Explore opens the actual URL in a new tab');
    check(await popup.evaluate(()=>window.opener===null),'New tab has no opener');
    check(!page.url().includes('/item/'),'Explore leaves current route intact');await popup.close();await page.bringToFront();
    console.log('Raw Discover Explore complete');
    report.actions.push('Search synthetic result; click Explore; verify popup URL and null opener; close popup');
    await page.locator('[data-discovery-item-id]').first().click();
    await page.locator('[data-selected-item-id]').waitFor();
    check(await page.getByRole('heading',{name:title,exact:true}).count()===1,'Internal details preserve source title');
    check(await page.getByRole('button',{name:'Extract Knowledge Points',exact:true}).count()===1 && await page.getByRole('button',{name:'Reject',exact:true}).count()===1,'Other source actions retained');
    await shot('desktop-discover-detail');console.log('Initial Discover screenshot captured');
    await page.locator('[data-discovery-open-upload]').focus();
    await page.keyboard.press('Enter');await page.locator('[data-upload-form]').waitFor();
    check(await page.locator('[name=title]').inputValue()===title,'Direct Upload prefill equals actual source title');
    check(new URL(page.url()).hash==='#upload','Title and private draft stay out of URL');
    await page.locator('[name=title]').fill('User edited actual title');
    await page.locator('[data-upload-input]').selectOption('pdf');
    check(await page.locator('[name=title]').inputValue()==='User edited actual title','User edit survives mode rerender');
    report.actions.push('Open details/provenance; keyboard Enter to Upload; verify exact title; edit title and change mode');
  }
  if(!uploadStatusOnly && !process.argv.includes('--layout-only')) {
    for(const theme of ['light','dark']) {
      await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator(`[data-setting=theme][value=${theme}]`).check();screenshotTheme=theme;
      for(const width of [320,390,1440])for(const scale of [1,2]) {
        await page.setViewportSize({width,height:1000});
        await page.evaluate(scale=>{sessionStorage.setItem('fixture-text-scale',String(scale));document.getElementById('fixture-double-text')?.remove();if(scale===2){const style=document.createElement('style');style.id='fixture-double-text';style.textContent='.discover-route :is(input,select,button,a,p),.upload-page :is(input,select,button,a,p){font-size:30px}';document.head.append(style);}},scale);
        const label=`${theme}-${width}-${scale*100}-raw`;
        await openDiscover();
        await page.locator('[name=query]').fill('provider-error');
        const before=extractCount,searchResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/discovery/search');await page.locator('[data-discovery-search-form] button[type=submit]').click();await searchResponse;
        await page.locator('.discover-results strong').filter({hasText:title}).first().waitFor();
        check(extractCount===before,'Search does not start extraction or create a Library record');
        check((await page.locator('.discover-route').innerText()).includes('Unreviewed provider results'),'Visible unreviewed provider-results notice');
        check((await page.locator('.discover-route').innerText()).includes('secondary: SearchProviderTimedOut'),'Partial provider error remains explicit');
        check(JSON.stringify(await page.locator('.discover-results strong').allTextContents())===JSON.stringify([title,'Provider B exact <claim>',title]),'Provider concatenation order and duplicates retained exactly');
        check((await page.locator('.discover-results').innerText()).includes('Provider exact <snippet> & claim.'),'Exact provider snippet rendered safely');
        await page.locator('[data-discovery-item-id]').first().click();
        await page.locator('[data-selected-item-id]').waitFor();await shot(label+'-discover');
        const extractResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/source-library/extract');
        await page.locator('[data-discovery-approve] button[type=submit]').click();await extractResponse;
        await page.locator(`[data-library-source="extract-${extractCount}"]`).waitFor();
        const id=`extract-${extractCount}`,card=page.locator(`[data-library-source="${id}"]`);
        check((await card.textContent()).includes(title),'Discover extraction retains the provider title in Library');
        const baseCount=await page.locator('[data-library-source=fixture-first]').count();
        cancelFailure=true;await card.locator('[data-library-workflow-cancel]').click();
        await page.locator('.toast.error').filter({hasText:'WorkflowCleanupFailed'}).waitFor();
        const errorPath=resolve(output,label+'-cancel-error.png');report.themeReadiness.push({name:label+'-cancel-error',...await captureThemeScreenshot(page,{theme,path:errorPath})});report.screenshots.push(errorPath);
        check(extracted.get(id).state==='abandoned','Cleanup failure fences the attempt before cleanup retry');
        await page.locator('.toast.error').waitFor({state:'detached'});
        await card.locator('[data-library-workflow-cancel]').click();await card.locator('[data-library-workflow-cancel]').waitFor({state:'detached'});
        check(extracted.get(id).state==='abandoned'&&await page.locator('[data-library-source=fixture-first]').count()===baseCount,'Cancellation preserves preexisting fixture source');
        await page.locator('.primary-nav [data-view=upload]').click();await page.locator('[data-upload-input]').selectOption('link');
        await page.locator('[name=interest-area] option[value=area-a]').waitFor({state:'attached'});
        check(await page.locator('[name=file], [name=attested]').count()===0,'Link requires neither files nor attestation');
        const linkHelp=await page.locator('[data-upload-controls] + p').innerText();
        check(linkHelp.includes('public HTTPS page')&&!/MiB|vision model/u.test(linkHelp),label+': Link-specific helper without upload limits');
        await page.locator('[name=title]').fill('Editable Link title');await page.locator('[name=url]').fill('https://127.0.0.1/private');await page.locator('[name=interest-area]').selectOption('area-a');
        const beforeInvalid=extractCount;await page.locator('[data-upload-form] button[type=submit]').click();await page.locator('[data-upload-message]').filter({hasText:'Link is invalid: url'}).waitFor();check(extractCount===beforeInvalid,'Unsafe Link URL stops before transport');
        await page.locator('[name=url]').fill('https://example.test/access-denied');await page.locator('[data-upload-form] button[type=submit]').click();await page.locator('[data-upload-message]').filter({hasText:'This source requires sign-in.'}).waitFor();
        check(!(await page.locator('[data-upload-message]').innerText()).includes('KnowledgePage'),label+': no technical access identity displayed');await shot(label+'-link-access-error');
        check(await page.locator('[name=title]').inputValue()==='Editable Link title','Access error retains editable Link draft');
        await page.locator('[name=title]').fill('Owner edited Link title');await page.locator('[name=url]').fill('https://example.test/course/');await shot(label+'-link');
        const linkResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/source-library/extract');
        await page.locator('[data-upload-form] button[type=submit]').focus();await page.keyboard.press('Enter');await linkResponse;
        const linkId=`extract-${extractCount}`,link=extracted.get(linkId);await page.locator(`[data-library-source="${linkId}"]`).waitFor();
        check(link.source.title==='Owner edited Link title'&&link.source.interestAreaIds[0]==='area-a','Link selected editable title and interest use the shared extraction route');
        link.state='completed';link.warning='Image warning: MediaPublicEgressUnavailable. Text retained.';
        await page.reload();await page.locator(`[data-library-source="${linkId}"]`).getByText(link.warning,{exact:true}).waitFor();
        check((await page.locator(`[data-library-source="${linkId}"]`).innerText()).includes('1 retained knowledge point'),'Fixture completion shows retained knowledge overview');
        await shot(label+'-library-warning');
        const warningCardPath=resolve(output,label+'-warning-card.png'),warningCard=page.locator(`[data-library-source="${linkId}"]`);
        await warningCard.scrollIntoViewIfNeeded();const warningSettled=await page.waitForFunction(id=>{const card=document.querySelector(`[data-library-source="${id}"]`);if(!card)return false;let node=card;while(node){if(Number(getComputedStyle(node).opacity)!==1)return false;node=node.parentElement;}return card.getAnimations({subtree:true}).every(animation=>!['running','pending'].includes(animation.playState)||animation.effect?.getComputedTiming().iterations===Infinity);},linkId,{timeout:8000});
        check(await warningSettled.jsonValue()===true,label+': warning card is settled and visible');await warningSettled.dispose();await warningCard.screenshot({path:warningCardPath});report.screenshots.push(warningCardPath);
        check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+': no horizontal overflow');
        await page.evaluate(()=>{sessionStorage.removeItem('fixture-text-scale');document.getElementById('fixture-double-text')?.remove();});
        console.log('Fixture flow complete: '+label);
        report.actions.push(label+': raw order/duplicates/snippets; no search writes; explicit extraction; cancel cleanup failure/retry; preexisting source; Link unsafe/access/success/draft/title/interest; fixture completion/image warning.');
      }
    }
    await openDiscover();await page.locator('[name=query]').fill('dismissal');const dismissalResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/discovery/search');await page.locator('[data-discovery-search-form] button[type=submit]').click();await dismissalResponse;await page.locator('.discover-results strong').filter({hasText:title}).first().waitFor();await page.locator('[data-discovery-item-id]').first().click();
    const before=extractCount;await page.getByRole('button',{name:'Reject',exact:true}).click();await page.locator('.discover-results').waitFor({state:'detached'});check(extractCount===before,'Reject only records personal dismissal');
    report.actions.push('Reject both duplicate identities as a personal dismissal; no extraction or Library write.');
    extracted.clear(); // Isolated fixture reset; established status checks use their original two-source catalog.
    await page.goto(origin+'/#upload');await page.reload();await page.locator('[data-upload-form]').waitFor();
    // Refill a raw result for the established responsive Discover matrix.
    await openDiscover();await page.locator('[name=query]').fill('responsive');await page.locator('[data-discovery-search-form] button[type=submit]').click();await page.locator('[data-discovery-item-id]').first().waitFor();
  }
  for (const theme of ['light','dark']) {
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.locator(`[data-setting=theme][value=${theme}]`).check();
    screenshotTheme=theme;
    await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
    await captureThemeScreenshot(page,{theme});
    await page.locator('.primary-nav [data-view=upload]').click();
    await page.locator('[data-upload-form]').waitFor();
    for (const width of uploadStatusOnly ? [320,390,800,1440] : [320,360,390,560,800,801,1440]) {
      await page.setViewportSize({width,height:1000});
      for (const scale of [1,2]) {
        const style = scale===2 ? await page.addStyleTag({content:'body{font-size:30px}.upload-page :is(input,textarea,select,.button){font-size:30px}.primary-nav button{font-size:24px}.library-processing-status{font-size:24px}'}) : null;
        if (!uploadStatusOnly) {
        await page.locator('.primary-nav [data-view=discover]').click();
        await page.locator('[data-discovery-item-id]').first().click();
        await page.locator('[data-selected-item-id]').waitFor();
        const detailBounds = await page.locator('.discover-detail').evaluate(card=>{
          const bounds=card.getBoundingClientRect();
          return [...card.querySelectorAll('label,input,select,textarea,button,a')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0 && (r.left<bounds.left-1 || r.right>bounds.right+1)}).map(e=>e.tagName+': '+e.textContent.slice(0,32));
        });
        check(detailBounds.length===0,`${theme} ${width}px ${scale*100}% Discover control bounds: ${detailBounds}`);
        if(width===320)await shot(`${theme}-${width}-${scale*100}-discover`);
        }
        await page.locator('.primary-nav [data-view=upload]').click();
        await page.locator('[data-upload-form]').waitFor();
        for (const mode of ['text','documents','pdf','images']) {
          await page.locator('[data-upload-input]').selectOption(mode);
          await page.locator('[name=title]').fill(title);
          if(mode!=='text') await page.locator('[name=file]').setInputFiles({name:mode==='pdf'?filename:mode==='images'?filename+'.png':filename+'.txt',mimeType:'application/octet-stream',buffer:Buffer.from('Synthetic test data')});
          const label = `${theme} ${width}px ${scale*100}% ${mode}`;
          if(mode!=='text') {
            const expected=mode==='pdf'?filename:mode==='images'?filename+'.png':filename+'.txt';
            const file=page.locator('[name=file]'), details=page.locator('[data-upload-files]');
            check(await file.evaluate(e=>e.files[0]?.name)===expected,label+': native input keeps actual filename after render');
            check(await file.getAttribute('aria-describedby')==='upload-filenames',label+': native input describes full filename');
            check(await details.isVisible() && !await details.evaluate(e=>e.open),label+': full filename defaults to collapsed disclosure');
            check(await page.locator('#upload-filenames').textContent()===expected,label+': full exact filename retained');
            const height=await file.evaluate(e=>({height:e.getBoundingClientRect().height,line:parseFloat(getComputedStyle(e).lineHeight)}));
            check(height.height<=height.line*2+24,label+': native filename is a bounded row');
            const summary=details.locator('summary');await summary.focus();
            if(statusChecks && mode==='pdf' && width===320 && scale===2) {
              const previous=await summary.elementHandle();
              await page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/source-status'));
              await page.waitForFunction(element=>!element.isConnected,previous);
              check(await summary.evaluate(element=>document.activeElement===element),label+': status-poll rerender preserves disclosure focus');
              await previous.dispose();
            }
            await page.keyboard.press('Enter');
            check(await details.evaluate(e=>e.open),label+': keyboard expands filename');
            check(await page.locator('#upload-filenames').isVisible() && await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+': expanded full name wraps without horizontal overflow');
            if(mode==='pdf'&&width===320&&scale===2)await shot(`${theme}-${width}-${scale*100}-full-filename`);
            await summary.focus();await page.keyboard.press('Enter');
            check(!await details.evaluate(e=>e.open) && await file.evaluate(e=>e.files[0]?.name)===expected,label+': keyboard collapses disclosure without losing file');
            await page.locator('.primary-nav [data-view=upload]').click();
            check(await file.evaluate(e=>e.files[0]?.name)===expected && await page.locator('[name=title]').inputValue()===title,label+': repeated render preserves native selection and edited title');
          }
          if(mode==='pdf') {
            check(await page.getByRole('textbox',{name:'PDF pages',exact:true}).count()===1,label+': short pages label');
            check(await page.locator('[name=pageRange]').getAttribute('aria-describedby')==='upload-pages-help',label+': helper linked to pages');
            check((await page.locator('#upload-pages-help').textContent()).includes('Blank means all; e.g. 1,3-5.'),label+': helper keeps range semantics');
            check(!await page.locator('[name=imageProcessing]').isChecked(),label+': PDF starts text-first');
            await contrast('#upload-pages-help');
            await contrast('[name=imageProcessing]','outlineColor',3);
            await page.locator('[name=imageProcessing]').check();
          }
          // Probe the actual disabled style without submitting a material request.
          await contrast('[data-upload-form] button[type=submit]','color',4.5,true);
          await contrast('[data-upload-form] button[type=submit]','borderTopColor',3,true);
          await headerBounds(label);
          check(await page.locator('[name=attested]').count()===0,'Upload has no attestation checkbox');
          check(await page.locator('[name=imageProcessing]').count()===(mode==='pdf'?1:0),'Only PDF offers optional image processing');
          const bounds = await page.locator('.upload-page').evaluate(card => {
            const rect=card.getBoundingClientRect();
            const elements=[...card.querySelectorAll('label,input,select,textarea,button,a')];
            const defects=[];
            for(const element of elements) {
              const r=element.getBoundingClientRect();
              if(r.left<rect.left-1 || r.right>rect.right+1) defects.push(`${element.tagName} ${element.getAttribute('name')??element.textContent.slice(0,24)} [${r.left},${r.right}] outside [${rect.left},${rect.right}]`);
              if(element.tagName==='LABEL') {
                const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node;
                while((node=walker.nextNode())) {
                  if(!node.textContent.trim())continue;
                  const range=document.createRange();range.selectNodeContents(node);
                  for(const text of range.getClientRects()) if(text.left<rect.left-1 || text.right>rect.right+1) defects.push('Label text outside card: '+node.textContent.slice(0,24));
                }
              }
            }
            return {defects,scrollWidth:document.documentElement.scrollWidth,width:innerWidth,overflow:getComputedStyle(card).overflowX};
          });
          check(bounds.defects.length===0, label+': '+bounds.defects.join('; '));
          check(bounds.scrollWidth<=bounds.width+1,label+': document overflow');
          check(bounds.overflow==='visible',label+': no overflow masking');
          if(['pdf','images'].includes(mode) && [320,390,1440].includes(width)) {
            await page.locator(mode==='pdf'?'[name=pageRange]':'[data-upload-files] summary').focus();
            check(await page.locator('.skip-link').evaluate(element=>document.activeElement!==element),label+': normal capture keeps skip link available without focusing it');
            await shot(`${theme}-${width}-${scale*100}-${mode}`);
          }
        }
        const navDefects = await page.locator('.primary-nav button').evaluateAll(buttons=>buttons.flatMap(button=>{
          const bounds=button.getBoundingClientRect(),label=button.querySelector('.nav-label');const range=document.createRange();range.selectNodeContents(label);
          return [...range.getClientRects()].some(r=>r.left<bounds.left-1 || r.right>bounds.right+1) ? [label.textContent] : [];
        }));
        check(navDefects.length===0,`${theme} ${width}px ${scale*100}% navigation label clipping: ${navDefects}`);
        if(style)await style.evaluate(element=>element.remove());
      }
      report.actions.push(`${theme} ${width}px: all four modes, 100/200% text/chip, native selection retention, keyboard filename disclosure, PDF helper, disabled/checkbox/chip contrast, header/card bounds`);
    }
    // Retain unrelated ordinary Upload behavior and input permission semantics.
    await page.locator('[data-upload-input]').selectOption('text');
    await page.locator('[name=title]').fill('Editable title');
    await page.locator('[name=content]').fill('Isolated private draft');
    check(await page.locator('[name=attested]').count()===0,'Text upload is checkbox-free');
    await page.locator('.primary-nav [data-view=upload]').click();
    check(await page.locator('[name=title]').inputValue()==='Editable title','Rerender of current panel preserves user title');
    if(statusChecks) {
      await page.goto(origin+`/#upload?sourceId=fixture-${theme}-contrast&runId=run-${theme}-contrast`);await page.locator('[data-upload-form]').waitFor();
      await page.locator('[name=content]').fill('Synthetic contrast fixture only.');
      await page.locator('[data-upload-form] button[type=submit]').focus();await page.keyboard.press('Enter');
      await page.locator('.topbar [data-library-processing-status]').filter({hasText:'Uploading'}).waitFor();
      check(await page.locator('[data-upload-form] button[type=submit]').isDisabled(),`${theme}: real uploading disables submission`);
      await contrast('[data-upload-form] button[type=submit]');
      await contrast('[data-upload-form] button[type=submit]','borderTopColor',3);
      await shot(`${theme}-native-disabled-uploading`);
      await page.locator('[data-upload-message]').filter({hasText:'Content uploaded'}).waitFor();
    }
  }
  if(statusChecks) {
    // Isolate single-source catalog/stage checks from the two pending-upload contrast fixtures.
    await page.goto(origin+'/#upload');await page.reload();await page.locator('[data-upload-form]').waitFor();
    report.actions.push('Reload after isolated theme contrast uploads; restore the paginated catalog fixture for single-source stage checks');
    await page.setViewportSize({width:1440,height:1000});
    const chip=page.locator('.topbar [data-library-processing-status]');
    check(await page.locator('[data-library-processing-status]').count()===1,'Exactly one real processing chip in header');
    await chip.filter({hasText:'extracting knowledge points'}).waitFor();
    check(report.requests.some(r=>r.path==='/api/source-library'&&r.method==='GET'),'Global status initializes catalog');
    for(const view of ['feed','review','library','upload','progress']) {
      await page.locator(`.primary-nav [data-view=${view}]`).click();
      await chip.waitFor();check(await page.locator('[data-library-processing-status]').count()===1,`${view}: one global processing chip`);
    }
    await page.goto(origin+'/#upload?sourceId=fixture-upload&runId=run-fixture-upload');await page.locator('[data-upload-form]').waitFor();
    await page.locator('[name=title]').fill('Synthetic owned material');
    await page.locator('[name=content]').fill('Synthetic material only. No live model.');
    await page.locator('[data-upload-form] button[type=submit]').focus();await page.keyboard.press('Enter');
    await chip.filter({hasText:'Uploading'}).waitFor();await shot('desktop-local-uploading');
    await page.locator('[data-upload-message]').filter({hasText:'Content uploaded'}).waitFor();
    check(!(await chip.innerText()).includes('Uploading'),'Local upload indication stops after attachment');
    await page.goto(origin+'/#upload?sourceId=fixture-upload-images&runId=run-fixture-upload-images');await page.locator('[data-upload-form]').waitFor();
    await page.locator('[data-upload-input]').selectOption('images');
    await page.locator('[name=file]').setInputFiles([{name:'synthetic-a.png',mimeType:'image/png',buffer:Buffer.from([137,80,78,71,13,10,26,10])},{name:'synthetic-b.png',mimeType:'image/png',buffer:Buffer.from([137,80,78,71,13,10,26,10])}]);
    await page.locator('[data-upload-form] button[type=submit]').focus();await page.keyboard.press('Enter');
    await chip.filter({hasText:'Uploading'}).waitFor();
    await page.locator('[data-upload-message]').filter({hasText:'Content uploaded'}).waitFor();
    check(materialUploadCount===4,'Two theme contrast fixtures, checkbox-free text and signed image batch reach local synthetic handler');
    workflowPhase='per-point-quiz-loop';
    // Completion leaves one source actively generating quizzes for the stage announcement.
    await page.reload();await chip.filter({hasText:'generating and validating review quizzes'}).waitFor();
    for(const theme of ['light','dark']) {
      await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator(`[data-setting=theme][value=${theme}]`).check();
      screenshotTheme=theme;
      await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
    await captureThemeScreenshot(page,{theme});
      for(const width of [320,390,1440]) {
        await page.setViewportSize({width,height:1000});await chip.waitFor();
        await headerBounds(`${theme} ${width}: quiz stage`);
        check(await chip.locator('.library-processing-spinner').evaluate(e=>parseFloat(getComputedStyle(e).animationDuration)<=0.00001),`${theme} ${width}: reduced-motion spinner uses near-zero duration`);
        await shot(`${theme}-${width}-global-processing`);
      }
    }
    check(!/\d+%/u.test(await chip.innerText()),'Status uses real stages without invented percentages');
    await page.emulateMedia({reducedMotion:'no-preference'});
    check(await chip.locator('.library-processing-spinner').evaluate(e=>getComputedStyle(e).animationName==='lp' && getComputedStyle(e).animationIterationCount==='infinite'),'Confirmed work animates normally when motion is enabled');
    await page.locator('[data-setting=motion]').uncheck();
    check(await chip.locator('.library-processing-spinner').evaluate(e=>getComputedStyle(e).animationName==='none'),'Owner motion toggle stops animation');
    await page.locator('[data-setting=motion]').check();await page.emulateMedia({reducedMotion:'reduce'});
    check(await page.evaluate(async()=> (await navigator.serviceWorker.getRegistrations()).length)===1,'Navigation/reload keeps exactly one offline registration');
    statusOutage=true;await chip.filter({hasText:'Status unavailable'}).waitFor({timeout:8000});
    check(await chip.locator('.library-processing-spinner').count()===0,'Status outage stops animation and discloses last confirmation');
    const errorChipPath=resolve(output,'global-status-unavailable.png');
    report.themeReadiness.push({name:'global-status-unavailable',...await captureThemeScreenshot(page,{theme:screenshotTheme,path:errorChipPath})});report.screenshots.push(errorChipPath);
    statusOutage=false;workflowPhase='completed';await chip.waitFor({state:'detached',timeout:8000});
    report.actions.push('Synthetic checkbox-free text/image-batch uploads; source pagination; navigate all routes; reload to quiz stage; both-theme mobile/desktop header; outage stops animation; completion removes chip. No live model.');
  }
  }
  check(report.errors.length===0,'No browser errors: '+report.errors.join('; '));
  check(!report.serverResponses.some(response=>response.status>=400),'No failed local shell/bootstrap responses: '+JSON.stringify(report.serverResponses.filter(response=>response.status>=400)));
  check(!report.requests.some(r=>r.method==='POST' && !['/api/discovery/search','/api/source-library/suppressions/check',...(statusChecks?['/api/knowledge-workflows/material','/api/source-library/extract','/api/source-library/reject','/api/knowledge-workflows/control']:[])].includes(r.path)),'Only authorized synthetic fixture writes; no answer/reminder/hosted writes');
  assert.equal(report.failures.length,0,report.failures.join('\n'));
  report.status='PASS';
} catch(error) {report.status='FAIL';report.failure=String(error);process.exitCode=1;if(page){const path=resolve(output,'failure.png');try{await page.screenshot({path,fullPage:true,timeout:5000});report.screenshots.push(path);}catch(captureError){report.errors.push('FailureCapture: '+String(captureError));}}}
finally {
  if(context){await context.close();report.cleanup.context=true;}
  if(browser){await browser.close();report.cleanup.browser=true;}
  await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));report.cleanup.server=true;
  await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,checks:report.checks,failures:report.failures.length,output,cleanup:report.cleanup}));
}
