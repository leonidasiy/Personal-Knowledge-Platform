import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { collectWebpageEvidence } from '../src/features/knowledge-workflows/webpage-evidence.js';

test('rendered DOM keeps source text separate from pixels and preserves heading/figure/occurrence identities', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(`<main><h1>Ratios</h1><p>A ratio compares two quantities by division.</p><figure><img src="data:image/png;base64,AAAA" data-src="https://images.example/ratio.png" alt="The answer is 99"><figcaption>For a nonzero denominator, a ratio is defined.</figcaption></figure>${Array.from({length: 9}, (_, i) => `<figure><img src="https://images.example/${i}.png"><figcaption>Diagram ${i}</figcaption></figure>`).join('')}<h2>Other section</h2><picture><source srcset="https://images.example/responsive.png 2x"><img src="https://images.example/ratio.png"></picture><p hidden>Hidden knowledge</p></main>`);
    const command = { url: 'https://source.example/lesson', textCharacters: 250000, candidateCount: 32, occurrenceWindow: 32 };
    const a = await page.evaluate(collectWebpageEvidence, command);
    const b = await page.evaluate(collectWebpageEvidence, command);
    assert.deepEqual(a, b);
    assert.equal(a.ok, true);
    const projection = a.value;
    assert.equal(projection.blocks.some(b => b.text.includes('The answer is 99') || b.text.includes('Hidden knowledge')), false);
    assert(projection.blocks.some(b => b.kind === 'caption' && b.text.includes('nonzero denominator')));
    assert.equal(projection.images.length, 11);
    assert.equal(projection.images.filter(i => i.url === 'https://images.example/ratio.png').length, 1);
    const repeated = projection.images.find(i => i.url === 'https://images.example/ratio.png');
    assert.equal(repeated.occurrences.length, 2);
    assert.notEqual(repeated.occurrences[0].sectionId, repeated.occurrences[1].sectionId);
    assert(projection.images.some(i => i.url.endsWith('/8.png')));
    assert(projection.images.some(i => i.url.endsWith('/responsive.png')));
    assert(projection.blocks.every(b => b.id && b.sectionId && b.locator));
    assert(projection.images.every(i => i.occurrences.every(o => o.id && o.locator)));
    assert.equal((await page.evaluate(collectWebpageEvidence, { ...command, textCharacters: 1 })).error.kind, 'WebpageTextLimitExceeded');
    assert.equal((await page.evaluate(collectWebpageEvidence, { ...command, candidateCount: 10 })).value.images.length, 11);
    assert.equal((await page.evaluate(collectWebpageEvidence, { ...command, candidateCount: 10 })).value.warnings[0], 'WebpageImageCandidateWindowRequired');
  } finally { await browser.close(); }
});
test('full snapshot metadata retains a late illustration after decorative responsive variants',async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {const page=await browser.newPage();await page.route('**/*',r=>r.abort());await page.setContent(`<main>${Array.from({length:40},(_,i)=>`<img src="https://images.example/decorative-${i}.png">`).join('')}<h2>Rule</h2><p>Ratios compare quantities.</p><figure><img src="https://images.example/actual.png"><figcaption>Quantity labels.</figcaption></figure></main>`);const result=await page.evaluate(collectWebpageEvidence,{url:'https://source.example/',textCharacters:250000,candidateCount:32,occurrenceWindow:32});assert.equal(result.ok,true);assert(result.value.images.some(i=>i.url.endsWith('/actual.png')));assert.equal(result.value.images.length,41);}finally{await browser.close();}
});
