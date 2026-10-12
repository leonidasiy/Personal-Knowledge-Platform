// @ts-check
import { imageHash } from './webpage-images.js';
/** @typedef {{ownerId:string,runId:string,locator:string,visualId:string,digest:string}} UploadedImageIdentity */
/** @typedef {(bytes:Uint8Array,mediaType:string)=>Promise<{ok:true,value:null}|{ok:false,error:{kind:string}}>} ImageDecoder */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const record=value=>typeof value==='object'&&value!==null&&!Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const text=value=>typeof value==='string'&&value.trim()!=='';
/** @param {{identity?:UploadedImageIdentity,expected:{ownerId:string,runId:string,locator:string,visualId:string},attachments?:readonly import('./knowledge-workflow-model.js').KnowledgeModelAttachment[],decode?:ImageDecoder}} command @returns {Promise<{ok:true,value:null}|{ok:false,error:{kind:'UploadedImageIdentityInvalid'|'UploadedImageAttachmentInvalid'|'UploadedImageHashMismatch'|'UploadedImageDecoderUnavailable'|'UploadedImageDecodeFailed'}}> } */
export async function validateUploadedImage(command) {
 if(!record(command)||!record(command.identity)||!record(command.expected)||/** @type {const} */(['ownerId','runId','locator','visualId']).some(key=>!text(command.expected[key])||command.identity?.[key]!==command.expected[key]))return {ok:false,error:{kind:'UploadedImageIdentityInvalid'}};
 const attachments=command.attachments;
 if(!Array.isArray(attachments)||attachments.length!==1||!record(attachments[0])||attachments[0].id!==command.identity.visualId||!(attachments[0].bytes instanceof Uint8Array)||attachments[0].url!==undefined||attachments[0].bytes.length===0||attachments[0].bytes.length>20*1024*1024||typeof attachments[0].mediaType!=='string'||!['image/png','image/jpeg','image/webp','image/gif'].includes(attachments[0].mediaType))return {ok:false,error:{kind:'UploadedImageAttachmentInvalid'}};
 if(command.identity.digest!==await imageHash(attachments[0].bytes))return {ok:false,error:{kind:'UploadedImageHashMismatch'}};
 if(typeof command.decode!=='function')return {ok:false,error:{kind:'UploadedImageDecoderUnavailable'}};
 let decoded;
 try{decoded=await command.decode(attachments[0].bytes,attachments[0].mediaType);}catch(error){if(!(error instanceof Error))throw error;return {ok:false,error:{kind:'UploadedImageDecodeFailed'}};}
 if(!decoded.ok)return {ok:false,error:{kind:'UploadedImageDecodeFailed'}};
 return {ok:true,value:null};
}
