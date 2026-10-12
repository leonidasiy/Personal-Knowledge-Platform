import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseAuthorizedMaterial} from '../src/features/knowledge-workflows/material.js';
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const dependencies={digest:async bytes=>hash(bytes),maximumBytes:20*1024*1024,maximumCharacters:1000};
function pdf(pages){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${pages.length} >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
 for(const [i,text] of pages.entries()){const stream=`BT /F1 12 Tf 20 80 Td (${text.replace(/[()\\]/g,'\\$&').replace(/¯/gu,'\\257')}) Tj ET`;objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);}
 let body='%PDF-1.4\n',offsets=[];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(body);
}
const pages=['First selected fact.','Second selected fact.',...Array.from({length:99},()=> 'Other page.')],bytes=pdf(pages);
const select=(page=1,start=0,end=pages[page-1].length)=>({sourceDigest:hash(bytes),physicalPage:page,textCodepointRange:[start,end],excerptDigest:hash(pages[page-1].slice(start,end))});
const command=selection=>({ownerId:'fixture',runId:'fixture',sourceId:'fixture',sourceRevision:1,sourceUrl:'https://fixture.invalid/source',mediaType:'application/pdf',fileName:'arbitrary.pdf',mode:'text',idempotencyKey:'fixture',bytes:new Uint8Array(bytes),pdfTextSelection:selection});
function failure(result,kind){assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.error.kind,kind);}
test('production selects authoritative range in >100-page document, keeps raw bytes/digest and no images',async()=>{
 const original=Buffer.from(bytes),r=await parseAuthorizedMaterial(command(select()),dependencies);assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(bytes,original);assert.equal(r.value.contentDigest,hash(bytes));assert.equal(r.value.mode,'text');assert.deepEqual(r.value.media,[]);assert.equal(r.value.sections.length,1);assert.equal(r.value.sections[0].text,pages[0]);assert.equal(r.value.sections[0].locator,'pdf:page=1;text-codepoints=0:20');
 failure(await parseAuthorizedMaterial({...command(select()),pdfTextSelection:undefined},dependencies),'MaterialPdfSelectionMissing');
 const full=command(select());delete full.pdfTextSelection;failure(await parseAuthorizedMaterial(full,dependencies),'MaterialPdfPageLimitExceeded');
});
for(const [name,selection,kind] of [
 ['missing',undefined,'MaterialPdfSelectionMissing'],['ambiguous',[select(),select(2)],'MaterialPdfSelectionAmbiguous'],['invalid shape',{},'MaterialPdfSelectionInvalid'],['negative start',{...select(),textCodepointRange:[-1,4]},'MaterialPdfSelectionInvalid'],['empty range',{...select(),textCodepointRange:[4,4]},'MaterialPdfSelectionInvalid'],['outside page',{...select(),physicalPage:102},'MaterialPdfSelectionInvalid'],['outside text',{...select(),textCodepointRange:[0,1000]},'MaterialPdfSelectionInvalid'],['raw conflict',{...select(),sourceDigest:hash('other')},'MaterialPdfSelectionConflict'],['excerpt conflict',{...select(),excerptDigest:hash('other')},'MaterialPdfSelectionConflict']
])test('range named failure: '+name,async()=>{failure(await parseAuthorizedMaterial(command(selection),dependencies),kind);});
test('application byte/text limits and PDF mode are enforced',async()=>{
 failure(await parseAuthorizedMaterial(command(select()),{...dependencies,maximumBytes:bytes.length-1}),'MaterialByteLimitExceeded');failure(await parseAuthorizedMaterial(command(select()),{...dependencies,maximumCharacters:19}),'MaterialTextLimitExceeded');failure(await parseAuthorizedMaterial({...command(select()),mode:'image'},dependencies),'MaterialImageModeUnsupported');
});
test('explicit codepoint range preserves compatibility glyphs and extracts only selected interval',async()=>{
 const raw=pdf(['¯x']),selection={sourceDigest:hash(raw),physicalPage:1,textCodepointRange:[0,2],excerptDigest:hash('¯x')};
 const r=await parseAuthorizedMaterial({...command(selection),bytes:new Uint8Array(raw)},dependencies);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.value.sections[0].text,'¯x');
 const slice=select(1,6,14),partial=await parseAuthorizedMaterial(command(slice),{...dependencies,maximumCharacters:8});assert.equal(partial.ok,true,JSON.stringify(partial));assert.equal(partial.value.sections[0].text,pages[0].slice(6,14));
});
