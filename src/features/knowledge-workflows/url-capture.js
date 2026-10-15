// @ts-check
import { imageSignature } from "./image-upload.js";
import { validatePublisherDestination } from "../source-library/contracts.js";

export const URL_CAPTURE_TYPE = "application/x-knowledge-url-capture";
const MAX_BYTES = 100 * 1024 * 1024;
/** @typedef {{readonly path:string,readonly url:string,readonly caption:string,readonly alt:string,readonly context:string,readonly mediaType:string,readonly bytes:Uint8Array}} CapturedImage */
/** @typedef {{readonly sourceUrl:string,readonly responseUrl:string,readonly pdf:Uint8Array,readonly images:readonly CapturedImage[]}} UrlCapture */
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:{kind:'MaterialUrlCaptureInvalid'}|{kind:'MaterialByteLimitExceeded',maximum:number}}} Result */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const record=value=>typeof value==='object'&&value!==null&&!Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const url=value=>typeof value==='string'&&validatePublisherDestination(value).ok;
/** @param {Uint8Array} bytes */
const pdf=bytes=>bytes.byteLength>5&&new TextDecoder().decode(bytes.subarray(0,5))==='%PDF-';
/** @template T @returns {Result<T>} */
const invalid=()=>({ok:false,error:{kind:'MaterialUrlCaptureInvalid'}});

/** One private, digest-bound material object; image bytes are never serialized into metadata.
 * @param {UrlCapture} capture @returns {Result<Uint8Array>} */
export function packUrlCapture(capture) {
  if(!url(capture?.sourceUrl)||!url(capture.responseUrl)||!(capture.pdf instanceof Uint8Array)||!pdf(capture.pdf)||!Array.isArray(capture.images)||capture.images.length>100)return invalid();
  const paths=new Set();
  for(const image of capture.images){
    if(!/^image:[1-9]\d*$/u.test(image.path)||paths.has(image.path)||!url(image.url)||![image.caption,image.alt,image.context].every(v=>typeof v==='string')||!(image.bytes instanceof Uint8Array)||image.bytes.byteLength===0||image.bytes.byteLength>20*1024*1024||imageSignature(image.bytes)!==image.mediaType)return invalid();
    paths.add(image.path);
  }
  const header=new TextEncoder().encode(JSON.stringify({sourceUrl:capture.sourceUrl,responseUrl:capture.responseUrl,pdfLength:capture.pdf.length,images:capture.images.map(({bytes,...image})=>({...image,length:bytes.length}))}));
  const size=8+header.length+capture.pdf.length+capture.images.reduce((n,image)=>n+image.bytes.length,0);
  if(size>MAX_BYTES)return {ok:false,error:{kind:'MaterialByteLimitExceeded',maximum:MAX_BYTES}};
  const bytes=new Uint8Array(size);bytes.set([0x50,0x4b,0x50,0x43]);new DataView(bytes.buffer).setUint32(4,header.length,true);bytes.set(header,8);bytes.set(capture.pdf,8+header.length);
  let offset=8+header.length+capture.pdf.length;for(const image of capture.images){bytes.set(image.bytes,offset);offset+=image.bytes.length;}
  return {ok:true,value:bytes};
}

/** @param {Uint8Array} bytes @returns {Result<UrlCapture>} */
export function parseUrlCapture(bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.length<10||bytes.length>MAX_BYTES||!bytes.subarray(0,4).every((v,i)=>v===[0x50,0x4b,0x50,0x43][i]))return invalid();
  const length=new DataView(bytes.buffer,bytes.byteOffset,8).getUint32(4,true);
  if(length<2||8+length>=bytes.length)return invalid();
  let header;try{header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(8,8+length)));}catch{return invalid();}
  if(!record(header)||Object.keys(header).sort().join(',')!=='images,pdfLength,responseUrl,sourceUrl'||!url(header.sourceUrl)||!url(header.responseUrl)||!Number.isSafeInteger(header.pdfLength)||typeof header.pdfLength!=='number'||header.pdfLength<6||!Array.isArray(header.images)||header.images.length>100)return invalid();
  let offset=8+length;
  if(offset+header.pdfLength>bytes.length)return invalid();
  const pdfBytes=bytes.subarray(offset,offset+header.pdfLength);offset+=header.pdfLength;
  if(!pdf(pdfBytes))return invalid();
  /** @type {CapturedImage[]} */const images=[];const paths=new Set();
  for(const image of header.images){
    if(!record(image)||Object.keys(image).sort().join(',')!=='alt,caption,context,length,mediaType,path,url'||typeof image.path!=='string'||!/^image:[1-9]\d*$/u.test(image.path)||paths.has(image.path)||!url(image.url)||typeof image.caption!=='string'||typeof image.alt!=='string'||typeof image.context!=='string'||typeof image.mediaType!=='string'||typeof image.length!=='number'||!Number.isSafeInteger(image.length)||image.length<1||image.length>20*1024*1024||offset+image.length>bytes.length)return invalid();
    const content=bytes.subarray(offset,offset+image.length);if(imageSignature(content)!==image.mediaType)return invalid();
    images.push({path:image.path,url:image.url,caption:image.caption,alt:image.alt,context:image.context,mediaType:image.mediaType,bytes:content});paths.add(image.path);offset+=image.length;
  }
  return offset===bytes.length?{ok:true,value:{sourceUrl:header.sourceUrl,responseUrl:header.responseUrl,pdf:pdfBytes,images}}:invalid();
}
