import {Buffer} from 'node:buffer';
import {chromium} from 'playwright-core';
// Actual offline Chromium decoder, shared only by evaluation test fixtures.
/** @returns {Promise<{close:()=>Promise<void>,decodePixels:import("../scripts/webpage-image-evaluation.mjs").EvaluationPixelDecoder}>} */
export async function testPixelDecoder(){
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext();await context.route('**/*',route=>route.abort());const page=await context.newPage();
 return {close:()=>browser.close(),decodePixels:async(bytes,mediaType)=>{
  const result=await page.evaluate(async({base64,mediaType})=>{
   let bitmap;try{bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:mediaType}),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');if(!ctx)throw new TypeError('FixtureCanvasUnavailable');ctx.drawImage(bitmap,0,0);
    return {ok:/** @type {const} */(true),value:{width:bitmap.width,height:bitmap.height,rgba:Array.from(ctx.getImageData(0,0,bitmap.width,bitmap.height).data)}};
   }catch(error){if(!(error instanceof Error))throw error;return {ok:/** @type {const} */(false),error:{kind:'FixturePixelDecodeFailed'}};}finally{bitmap?.close();}
  },{base64:Buffer.from(bytes).toString('base64'),mediaType});
  return result.ok?{ok:/** @type {const} */(true),value:{...result.value,rgba:Uint8Array.from(result.value.rgba)}}:result;
 }};
}
