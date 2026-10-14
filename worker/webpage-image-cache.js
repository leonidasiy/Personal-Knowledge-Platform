// @ts-check
import { acquireImageBytes } from '../src/features/knowledge-workflows/media.js';
import { imageHash } from './webpage-images.js';
import { ACQUISITION_POLICY } from './acquisition-policy.js';

/** @typedef {import('./webpage-image-budget.js').Result<null>} CacheWriteResult */
/** @typedef {{bytes:Uint8Array,mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif'}} OriginalImage */
/** @typedef {{ownerId:string,runId:string,sourceRevision:number,pageUrl:string}} CacheScope */
/** @typedef {{id:string,url:string}} ImageIdentity */
/** @typedef {import('./knowledge-workflow-media-d1.js').MediaBucket} ImageCacheBucket */
/** @typedef {{version:'webpage-original-image-v1',ownerId:string,runId:string,sourceRevision:number,pageUrl:string,imageId:string,imageUrl:string,mediaType:OriginalImage['mediaType'],byteLength:number,originalDigest:string,objectKey:string}} OriginalImageReceipt */
/** @typedef {{load:(image:ImageIdentity)=>Promise<import('./webpage-image-budget.js').Result<OriginalImage|null>>,save:(image:ImageIdentity,original:OriginalImage)=>Promise<CacheWriteResult>}} OriginalImageCache */
const version='webpage-original-image-v1';
/** @param {unknown} v @returns {v is Record<string,unknown>} */
const record=v=>typeof v==='object'&&v!==null&&!Array.isArray(v);
/** @param {unknown} v @returns {v is string} */
const text=v=>typeof v==='string'&&v.trim()!=='';
/** @param {OriginalImageReceipt} receipt */
async function objectKey(receipt) {
 const identity=await imageHash(new TextEncoder().encode(JSON.stringify({ownerId:receipt.ownerId,runId:receipt.runId,sourceRevision:receipt.sourceRevision,pageUrl:receipt.pageUrl,imageId:receipt.imageId,imageUrl:receipt.imageUrl})));
 return `workflow-image-originals/${identity.slice(7)}/${receipt.originalDigest.slice(7)}`;
}

/** Validates cleanup keys as well as read receipts; never accepts a caller-supplied R2 key.
 * @param {unknown} value @param {CacheScope} scope @param {ImageIdentity} image
 * @returns {Promise<OriginalImageReceipt|null>} */
export async function parseOriginalImageReceipt(value,scope,image) {
 if(!record(value)||Object.keys(value).sort().join(',')!=='byteLength,imageId,imageUrl,mediaType,objectKey,originalDigest,ownerId,pageUrl,runId,sourceRevision,version'||value.version!==version||value.ownerId!==scope.ownerId||value.runId!==scope.runId||value.sourceRevision!==scope.sourceRevision||value.pageUrl!==scope.pageUrl||value.imageId!==image.id||value.imageUrl!==image.url||!['image/png','image/jpeg','image/webp','image/gif'].includes(String(value.mediaType))||!Number.isSafeInteger(value.byteLength)||Number(value.byteLength)<=0||Number(value.byteLength)>ACQUISITION_POLICY.imageBytes||!text(value.originalDigest)||!/^sha256:[a-f0-9]{64}$/.test(value.originalDigest)||!text(value.objectKey))return null;
 const receipt=/** @type {OriginalImageReceipt} */(value);
 return receipt.objectKey===await objectKey(receipt)?receipt:null;
}

/** Private pre-publication storage. The receipt is journaled before the R2 write
 * so cancellation/retry can find the key even when a write finishes late.
 * @param {{database:import('./knowledge-workflow-content-d1.js').D1DatabasePort,bucket:ImageCacheBucket,budget:import('./webpage-image-budget.js').PersistentImageBudget,scope:CacheScope,logger:(entry:{event:string,failureKind?:string})=>void}} deps
 * @returns {OriginalImageCache} */
export function createWebpageImageCache(deps) {
 const {database,bucket,budget,scope}=deps;
 /** @param {string} kind */const failed=kind=>({ok:/** @type {const} */(false),error:{kind}});
 /** @param {ImageIdentity} image @param {number} byteLength */
 async function allowed(image,byteLength) {
  const row=await database.prepare("SELECT a.settled,a.decoded_bytes FROM knowledge_workflow_image_attempts a JOIN knowledge_workflow_runs r ON r.owner_id=a.owner_id AND r.run_id=a.run_id WHERE a.owner_id=? AND a.run_id=? AND a.page_url=? AND a.attempt_key=? AND r.source_revision=? AND r.state<>'abandoned' AND NOT EXISTS(SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id=a.owner_id AND t.run_id=a.run_id)").bind(scope.ownerId,scope.runId,scope.pageUrl,`read:${image.id}`,scope.sourceRevision).first();
  return record(row)&&row.settled===1&&row.decoded_bytes===byteLength;
 }
 /** @param {string} key */
 async function remove(key) {
  try{await bucket.delete(key);}catch(error){if(!(error instanceof Error))throw error;deps.logger({event:'webpage-image-cache-cleanup-failure',failureKind:'WebpageImageCacheCleanupFailed'});}
 }
 return Object.freeze({
  async load(image) {
   try{
    const cached=await budget.lookup(`read:${image.id}`);if(!cached.ok)return cached;if(cached.value===null)return {ok:true,value:null};
    const receipt=await parseOriginalImageReceipt(cached.value,scope,image);if(!receipt)return failed('WebpageImageCacheReceiptInvalid');
    if(!await allowed(image,receipt.byteLength))return failed('WebpageImageCacheUnavailable');
    const stored=await bucket.get(receipt.objectKey);if(stored===null)return failed('WebpageImageCacheMissing');
    const bytes=new Uint8Array(await stored.arrayBuffer());
    if(bytes.length!==receipt.byteLength||await imageHash(bytes)!==receipt.originalDigest)return failed('WebpageImageCacheBytesChanged');
    const validated=await acquireImageBytes({fetch:async()=>({ok:true,value:new Response(bytes,{headers:{'content-type':receipt.mediaType}})})},image.url,undefined,ACQUISITION_POLICY.imageBytes);
    if(!validated.ok)return validated;
    if(!await allowed(image,receipt.byteLength))return failed('WebpageImageCacheUnavailable');
    return {ok:true,value:validated.value};
   }catch(error){if(!(error instanceof Error))throw error;return failed('WebpageImageCacheReadFailed');}
  },
  async save(image,original) {
   /** @type {string|undefined} */let key;
   try{
    const bytes=original.bytes.slice();
    const validated=await acquireImageBytes({fetch:async()=>({ok:true,value:new Response(bytes,{headers:{'content-type':original.mediaType}})})},image.url,undefined,ACQUISITION_POLICY.imageBytes);
    if(!validated.ok)return validated;
    if(!await allowed(image,bytes.length))return failed('WebpageImageCacheUnavailable');
    const receipt=/** @type {OriginalImageReceipt} */({version,...scope,imageId:image.id,imageUrl:image.url,mediaType:original.mediaType,byteLength:bytes.length,originalDigest:await imageHash(bytes),objectKey:''});
    key=receipt.objectKey=await objectKey(receipt);
    // This journals already settled original bytes, not a new model result.
    // Keep the historical read deadline and debit intact even after expiry.
    const attempt=await database.prepare('SELECT policy_json FROM knowledge_workflow_image_attempts WHERE owner_id=? AND run_id=? AND page_url=? AND attempt_key=?').bind(scope.ownerId,scope.runId,scope.pageUrl,`read:${image.id}`).first();
    if(!record(attempt)||!text(attempt.policy_json))return failed('WebpageImageCacheUnavailable');
    const existing=await budget.lookup(`read:${image.id}`);if(!existing.ok)return existing;
    if(existing.value!==null)return failed('WebpageImageCacheReceiptAlreadyStored');
    const saved=await database.prepare("UPDATE knowledge_workflow_image_attempts SET output_json=? WHERE owner_id=? AND run_id=? AND page_url=? AND attempt_key=? AND policy_json=? AND output_json IS NULL AND settled=1 AND decoded_bytes=? AND EXISTS(SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id=? AND r.run_id=? AND r.source_revision=? AND r.state<>'abandoned') AND NOT EXISTS(SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id=? AND t.run_id=?)").bind(JSON.stringify(receipt),scope.ownerId,scope.runId,scope.pageUrl,`read:${image.id}`,attempt.policy_json,bytes.length,scope.ownerId,scope.runId,scope.sourceRevision,scope.ownerId,scope.runId).run();
    if(!saved.success||saved.meta?.changes!==1)return failed('WebpageImageCacheReceiptPersistenceFailed');
    if(!await allowed(image,bytes.length))return failed('WebpageImageCacheUnavailable');
    await bucket.put(key,bytes,{httpMetadata:{contentType:original.mediaType},customMetadata:{owner:scope.ownerId,run:scope.runId,digest:receipt.originalDigest}});
    if(!await allowed(image,bytes.length)){await remove(key);return failed('WebpageImageCacheUnavailable');}
    return {ok:true,value:null};
   }catch(error){if(!(error instanceof Error))throw error;if(key!==undefined)await remove(key);return failed('WebpageImageCacheWriteFailed');}
  },
 });
}
