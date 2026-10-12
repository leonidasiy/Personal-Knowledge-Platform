import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chromium} from 'playwright-core';
import {captureThemeScreenshot} from '../scripts/browser-theme-ready.mjs';

test('screenshots await requested theme, inherited contrast and finite motion at 320px/200%', async () => {
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:320,height:1000}});
    await page.setContent(`<style>
      :root{--text:#222d30;--canvas:#f1f2ec;--surface:#fcfcf7}
      :root[data-theme=dark]{--text:#edf3f2;--canvas:#101922;--surface:#17242f}
      body{color:var(--text);background:var(--canvas);font-size:30px;transition:color 120ms}
      section{background:var(--surface)}
      @media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}
      :root[data-motion=off] *{transition:none!important}
    </style><main class="settings-page"><h1>Settings</h1><section><fieldset><legend>Appearance</legend><label>Daily learning</label><p>Learning targets</p></fieldset></section></main>`);
    await page.evaluate(()=>{document.documentElement.dataset.theme="light";});
    const observations=[];
    for(const motion of ['reduce','no-preference','off']) {
      await page.emulateMedia({reducedMotion:motion==='reduce'?'reduce':'no-preference'});
      for(const theme of ['dark','light']) {
        await page.evaluate(({theme,motion})=>{
          document.documentElement.dataset.motion=motion==='off'?'off':'on';
          setTimeout(()=>{document.documentElement.dataset.theme=theme;},200);
        },{theme,motion});
        const evidence=await captureThemeScreenshot(page,{theme});
        assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme,'Theme request must be applied before screenshot');
        assert.equal(await page.locator('h1').evaluate(e=>getComputedStyle(e).color),theme==='dark'?'rgb(237, 243, 242)':'rgb(34, 45, 48)','Inherited heading color must finish transitioning');
        assert(evidence.minimumContrast>=4.5,'Every heading/label/body text keeps AA contrast');
        observations.push(evidence);
      }
    }
    // An actual wrong inherited text color must fail rather than be masked by waiting.
    await page.addStyleTag({content:'body{color:#f1f2ec!important}'});
    await assert.rejects(captureThemeScreenshot(page,{theme:'light'}),/ThemeTextMismatch|TextContrastInvalid/);
    console.log(JSON.stringify({themeReadyChecks:observations.length,minimumContrast:Math.min(...observations.map(e=>e.minimumContrast))}));
  } finally {await browser.close();}
});

test('full-page capture normalizes scroll without removing the skip link or keyboard focus', async () => {
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:320,height:240}});
    await page.setContent(`<style>:root{--text:#222d30}body{color:var(--text);background:#f1f2ec;min-height:3000px}.skip-link{position:fixed;top:12px;padding:12px 16px;transform:translateY(-160%)}.skip-link:focus{transform:none}main{padding-top:1500px}</style><a class="skip-link" href="#main-content">Skip to learning content</a><main id="main-content" class="settings-page"><h1>Settings</h1><label>Draft<input value="Synthetic draft"></label></main>`);
    await page.evaluate(()=>{document.documentElement.dataset.theme='light';document.querySelector('input').focus();});
    assert(await page.evaluate(()=>scrollY)>0,'Regression needs a scrolled keyboard workflow');
    await captureThemeScreenshot(page,{theme:'light'});
    assert.equal(await page.evaluate(()=>scrollY),0,'Full-page capture starts at the document top');
    assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'INPUT','Keyboard focus remains on the real control');
    assert.equal(await page.locator('.skip-link').count(),1,'Skip link stays in the DOM');
    assert(await page.locator('.skip-link').evaluate(e=>e.getBoundingClientRect().bottom<0),'Unfocused skip link remains above the viewport');
  } finally {await browser.close();}
});
