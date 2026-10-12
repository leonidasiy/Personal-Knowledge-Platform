// @ts-check
import { validateUploadedImage } from '../worker/upload-image-boundary.js';
import { imageHash } from '../worker/webpage-images.js';
function assert(/** @type {boolean} */ value){if(!value)throw Error('Upload image boundary failed');}
const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);
for(const defect of ['none','absent','id','owner','locator','hash','corrupt']) Deno.test(`uploaded image exact identity and decode ${defect}`,async()=>{
 const digest=await imageHash(bytes);
 const identity={ownerId:'owner',runId:'run',locator:'image:1',visualId:'visual:1',digest};
 const result=await validateUploadedImage({identity,expected:{ownerId:'owner',runId:'run',locator:'image:1',visualId:'visual:1'},attachments:defect==='absent'?[]:[{id:defect==='id'?'foreign':'visual:1',bytes,mediaType:'image/png'}],decode:async()=>defect==='corrupt'?{ok:false,error:{kind:'UploadedImageDecodeFailed'}}:{ok:true,value:null},...(defect==='owner'?{identity:{...identity,ownerId:'foreign'}}:defect==='locator'?{identity:{...identity,locator:'image:2'}}:defect==='hash'?{identity:{...identity,digest:'sha256:wrong'}}:{})});
 assert(result.ok===(defect==='none'));
});

Deno.test('all malformed uploaded attachments return a typed attachment failure',async()=>{
 const identity={ownerId:'owner',runId:'run',locator:'image:1',visualId:'visual:1',digest:await imageHash(bytes)};
 for(const attachments of [[null],[undefined],[0],['image'],[[]],[{}],[{id:'visual:1',bytes:null,mediaType:'image/png'}]]) {
  const result=await validateUploadedImage({identity,expected:identity,attachments:/** @type {any} */(attachments),decode:async()=>{throw Error('Malformed attachment must never decode');}});
  assert(!result.ok&&result.error.kind==='UploadedImageAttachmentInvalid');
 }
});
