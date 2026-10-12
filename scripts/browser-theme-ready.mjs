import assert from 'node:assert/strict';

// Keep normal motion intact; readiness is an assertion, not an animation override.
export async function captureThemeScreenshot(page, {theme, path}) {
  await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme,{timeout:8000});
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForFunction(()=>document.getAnimations().every(animation=>
    !['running','pending'].includes(animation.playState) || animation.effect?.getComputedTiming().iterations===Infinity
  ),null,{timeout:8000});
  // Full-page capture can include an off-viewport fixed skip link when the document is scrolled.
  await page.evaluate(()=>{scrollTo({top:0,left:0,behavior:'instant'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  const evidence=await page.evaluate(()=>{
    const rgb=value=>{
      const match=value.match(/^rgba?\(([^)]+)\)$/u);
      if(!match)throw new Error(`ThemeColorUnsupported: ${value}`);
      const channels=match[1].split(',').map(Number);
      if(channels.length===3)channels.push(1);
      return channels;
    };
    const luminance=channels=>channels.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const token=document.createElement('span');token.style.color='var(--text)';token.hidden=true;document.body.append(token);
    const expectedText=getComputedStyle(token).color;token.remove();
    const elements=[...document.querySelectorAll('.brand, .library-processing-status, .upload-page :is(h1,label,p,small,summary,.button:disabled), .settings-page :is(h1,h2,h3,legend,label,strong,p,small,summary)')];
    const text=elements.filter(element=>element.getBoundingClientRect().width>0 && element.textContent.trim()).map(element=>{
      const style=getComputedStyle(element),foreground=rgb(style.color);
      let ancestor=element,background,opacity=1;
      while(ancestor){
        const current=getComputedStyle(ancestor);opacity*=Number(current.opacity);
        if(!background){const color=rgb(current.backgroundColor);if(color[3]>0){if(color[3]!==1)throw new Error('ThemeBackgroundUnsupported');background=color;}}
        ancestor=ancestor.parentElement;
      }
      if(!background)throw new Error('ThemeBackgroundMissing');
      const alpha=foreground[3]*opacity;
      const rendered=foreground.slice(0,3).map((channel,i)=>channel*alpha+background[i]*(1-alpha));
      const values=[luminance(rendered),luminance(background)].sort((a,b)=>a-b);
      return {label:element.textContent.trim().slice(0,60),color:style.color,background:background.slice(0,3),contrast:(values[1]+.05)/(values[0]+.05),opacity};
    });
    if(!text.length)throw new Error('ThemeTextMissing');
    return {scroll:{x:scrollX,y:scrollY},theme:document.documentElement.dataset.theme,motion:document.documentElement.dataset.motion,reducedMotion:matchMedia('(prefers-reduced-motion:reduce)').matches,bodyColor:getComputedStyle(document.body).color,expectedText,minimumContrast:Math.min(...text.map(item=>item.contrast)),text};
  });
  assert.deepEqual(evidence.scroll,{x:0,y:0},'ScreenshotScrollInvalid');
  assert.equal(evidence.bodyColor,evidence.expectedText,'ThemeTextMismatch: body must inherit the active text token');
  assert(evidence.minimumContrast>=4.5,`TextContrastInvalid: ${JSON.stringify(evidence.text.filter(item=>item.contrast<4.5))}`);
  await page.screenshot({path,fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme,'Theme changed during screenshot');
  return evidence;
}
