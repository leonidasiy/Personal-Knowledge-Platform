// Offline smoke only: substitute one known synthetic pixel fixture, never publisher pixels.
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
const target=fileURLToPath(new URL('../tests-node/evaluation-pixel-decoder.mjs',import.meta.url));
registerHooks({load(url,context,next){
 if(url.startsWith('file:')&&fileURLToPath(url)===target)return {format:'module',shortCircuit:true,source:`
 import {createHash} from 'node:crypto';
 export async function testPixelDecoder(){return {close:async()=>{},decodePixels:async(bytes,type)=>{
 if(type!=='image/png'||createHash('sha256').update(bytes).digest('hex')!=='4ff6ab670a58c14270e034e2090d9a432caa263a14e0a25785386b0c12f880b5')throw new TypeError('BenchmarkOfflineForeignPixels');
 return {ok:true,value:{width:1,height:1,rgba:new Uint8Array([255,0,0,255])}};
 }}};
 `};
 return next(url,context);
}});
