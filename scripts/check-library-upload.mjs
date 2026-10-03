// Local isolated browser contract. All API responses are synthetic.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const origin = 'http://127.0.0.1:4321';
const output = '/tmp/pkp-library-upload-evidence';
const navFailures = [];
await mkdir(output,{recursive:true});
const source={id:'source-a',ownerId:'sample-owner',title:'Synthetic source',description:'Synthetic acceptance fixture.',submittedUrl:'https://publisher.example/',canonicalUrl:'https://publisher.example/',adapter:{id:'web',version:'1',granularity:'page',capabilities:['metadata']},interestAreaIds:[],identityEvidence:[],state:'active',approvedAt:'2026-10-03T00:00:00.000Z',updatedAt:'2026-10-03T00:00:00.000Z',revision:1};
const browser = await chromium.launch({...(process.env.LOCAL_HEADLESS_EXECUTABLE ? {executablePath:process.env.LOCAL_HEADLESS_EXECUTABLE} : {channel:'chrome'}),headless:true});
try {
  const context = await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  await context.route('**/*',async route=>{
    const url = new URL(route.request().url());
    if(url.origin!==origin) return route.abort();
    if(!url.pathname.startsWith('/api/')) return route.continue();
    if(url.pathname.endsWith('/upload-context')) return url.searchParams.get('sourceId')==='source-a' && url.searchParams.get('runId')==='run-a' ? route.fulfill({json:{result:{source,runId:'run-a',reason:'This source requires an authorized copy.'}}}) : route.fulfill({status:404,json:{error:'SourceUploadContextUnavailable'}});
    if(url.pathname.endsWith('/rename')) {
      const command=route.request().postDataJSON();
      assert.equal(command.expectedRevision,1);
      if(command.expectedTitle!==source.title)return route.fulfill({status:409,json:{error:'SourceRenameConflict'}});
      source.title=command.title;
      return route.fulfill({json:{result:{sourceId:source.id,runId:'run-a',title:source.title,revision:1,reused:false}}});
    }
    if(url.pathname.endsWith('/review-batch')) return route.fulfill({json:{result:{batch:{batchId:'review-sample',learningDay:'2026-10-03',status:'open',itemIds:['q'],revision:1,createdAt:'2026-10-03T00:00:00.000Z',completedAt:null},questions:[{questionId:'q',knowledgeId:'k',title:'Synthetic review',prompt:'What is the synthetic answer?',kind:'fill-blank',choices:null,blanks:null,sourceAnchorIds:['a'],revision:1}],dueCount:1}}});
    if(url.pathname.endsWith('/feed-batch')) return route.fulfill({json:{result:{batch:null,items:[]}}});
    if(url.pathname==='/api/source-library') return route.fulfill({json:{result:{items:[],interestAreas:[],nextCursor:null}}});
    if(url.pathname.endsWith('/library-knowledge')) return route.fulfill({json:{result:{items:[]}}});
    return route.fulfill({status:503,json:{error:'SyntheticUnavailable'}});
  });
  await page.goto(origin);
  await page.locator('.primary-nav [data-view="upload"]').click();
  await page.locator('#upload-title').waitFor();
  assert.equal(await page.locator('input[name=title]').count(),1);
  for (const mode of ['light','dark']) {
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.locator(`[data-setting="theme"][value="${mode}"]`).check();
    await page.locator('.primary-nav [data-view="upload"]').click();
    for(const width of [1440,320,375]) {
      await page.setViewportSize({width,height:1000});
      for(const input of ['text','documents','pdf','images']) {
        await page.locator('[data-upload-input]').selectOption(input);
        assert.equal(await page.locator('[name=pageRange]').count(),input==='pdf'?1:0);
        assert.equal(await page.locator('[name=imageProcessing]').count(),['pdf','images'].includes(input)?1:0);
        await page.locator('[name=title]').fill('Synthetic title');
      }
      await page.locator('[data-upload-input]').selectOption('text');
      await page.locator('[name=content]').fill('Synthetic retry draft.');
      await page.locator('[name=attested]').check();
      await page.getByRole('button',{name:'Upload and process'}).click();
      await page.getByText('Upload failed:',{exact:false}).waitFor();
      assert.equal(await page.locator('[name=content]').inputValue(),'Synthetic retry draft.');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
      const geometry=await page.locator('.primary-nav button.active .nav-label').evaluate(label=>{
        const style=getComputedStyle(label,'::after');
        return {width:label.getBoundingClientRect().width,left:parseFloat(style.left),right:parseFloat(style.right)};
      });
      assert.ok(geometry.width>0 && Number.isFinite(geometry.left) && Number.isFinite(geometry.right) && Math.abs(geometry.left)<=0.5 && Math.abs(geometry.right)<=0.5,'Upload underline fills and centers within its text label');
      await page.screenshot({path:`${output}/${mode}-${width}.png`,fullPage:true});
      await page.locator('.primary-nav [data-view="review"]').click();
      await page.locator('.nav-notification-dot').waitFor();
      if (width === 320 || width === 375) {
        assert.ok(await page.locator('.primary-nav [data-view="review"]').isVisible(), 'Review must be visible');
        assert.ok(await page.locator('.primary-nav [data-view="review"] .nav-notification-dot').isVisible(), 'Review notification dot must be visible');
        await page.evaluate(() => document.fonts.ready);
        const labels = await page.locator('.primary-nav button').evaluateAll(buttons => buttons.filter(button => button.checkVisibility()).map(button => {
          const label = button.querySelector('.nav-label');
          if (!label) throw new Error('Visible nav button has no label');
          const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
          const rects = [];
          let node;
          while ((node = walker.nextNode())) {
            if (!node.textContent.trim() || !node.parentElement.checkVisibility()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            rects.push(...Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0));
          }
          const bounds = button.getBoundingClientRect();
          return { text: label.textContent.trim(), button: {left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom}, rects:rects.map(rect => ({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom})) };
        }));
        const check = (condition, message) => { if (!condition) navFailures.push(`${mode} ${width}px: ${message}`); };
        check(labels.length === 6, `Exactly six navigation labels must be visible (actual ${labels.length})`);
        for (const label of labels) {
          check(label.rects.length > 0, `${label.text} must have visible text rects`);
          check(label.rects.every(rect => rect.left >= label.button.left && rect.right <= label.button.right && rect.top >= label.button.top && rect.bottom <= label.button.bottom), `${label.text} text must stay within its own button`);
        }
        const rows = new Map();
        for (const label of labels) {
          if (!rows.has(label.button.top)) rows.set(label.button.top, []);
          rows.get(label.button.top).push(label);
        }
        for (const row of rows.values()) {
          row.sort((a,b) => a.button.left - b.button.left);
          for (let i = 1; i < row.length; i++) {
            const previous = row[i-1], next = row[i];
            const gap = Math.min(...next.rects.map(rect => rect.left)) - Math.max(...previous.rects.map(rect => rect.right));
            check(gap >= 8, `${previous.text} → ${next.text} text gap must be at least 8px (actual ${gap.toFixed(2)}px)`);
          }
        }
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'No horizontal overflow with Review and its dot visible');
        await page.screenshot({path:`${output}/${mode}-${width}-review-nav.png`,fullPage:true});
      }
      const reviewGeometry=await page.locator('.primary-nav button.active .nav-label').evaluate(label=>{
        const style=getComputedStyle(label,'::after');return {width:label.getBoundingClientRect().width,left:parseFloat(style.left),right:parseFloat(style.right)};
      });
      assert.ok(reviewGeometry.width>0 && Number.isFinite(reviewGeometry.left) && Number.isFinite(reviewGeometry.right) && Math.abs(reviewGeometry.left)<=0.5 && Math.abs(reviewGeometry.right)<=0.5,'Review underline fills and centers within its text label despite the notification dot');
      await page.locator('.primary-nav [data-view="upload"]').click();
    }
  }
  await page.goto(`${origin}/#upload?sourceId=source-a&runId=run-a`);
  await page.locator('[name=title]').fill('Renamed synthetic source');
  await page.getByRole('button',{name:'Save title',exact:true}).click();
  await page.getByText('Title saved. You can upload material when ready.').waitFor();
  await page.locator('[name=content]').fill('Retained synthetic material');
  await page.locator('[name=attested]').check();
  await page.getByRole('button',{name:'Upload and process'}).click();
  await page.getByText('Title saved. Upload failed:',{exact:false}).waitFor();
  assert.equal(await page.locator('[name=title]').inputValue(),'Renamed synthetic source');
  await page.reload();await page.locator('#upload-title').waitFor();
  assert.equal(await page.locator('[name=title]').inputValue(),'Renamed synthetic source');
  await page.getByRole('link',{name:'Back to Library',exact:true}).click();
  await page.locator('#library-title').waitFor();await page.goBack();await page.locator('#upload-title').waitFor();
  await page.goForward();await page.locator('#library-title').waitFor();
  await page.goto(`${origin}/#upload?sourceId=`);
  await page.getByRole('heading',{name:'Upload unavailable'}).waitFor();
  assert.equal(await page.locator('[data-upload-form]').count(),0);
  assert.deepEqual(navFailures, [], 'Mobile nav labels must fit their buttons and have at least 8px separation without horizontal overflow');
  console.log('Upload local input, retry, context, theme and geometry checks passed');
} finally {
  if (navFailures.length) console.error('Mobile navigation failures:\n' + navFailures.join('\n'));
  await browser.close();
}
