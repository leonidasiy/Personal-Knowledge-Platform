// @ts-check

import { isMediaBindingPurpose } from "../src/features/knowledge-workflows/media.js";

/** @import { MediaAsset, MediaDerivative } from "../src/features/knowledge-workflows/media.js" */

/** @typedef {{ readonly success: boolean, readonly meta?: { readonly changes?: number } }} D1Result */
/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => D1Statement, readonly first: () => Promise<unknown | null>, readonly run: () => Promise<D1Result> }} D1Statement */
/** @typedef {{ readonly prepare: (query: string) => D1Statement, readonly batch: (statements: readonly D1Statement[]) => Promise<readonly D1Result[]> }} D1DatabasePort */
/** @typedef {{ readonly put: (key: string, value: Uint8Array, options?: { readonly httpMetadata?: { readonly contentType?: string }, readonly customMetadata?: Readonly<Record<string, string>> }) => Promise<unknown>, readonly get: (key: string) => Promise<{ readonly arrayBuffer: () => Promise<ArrayBuffer> } | null>, readonly delete: (key: string) => Promise<unknown> }} MediaBucket */
/** @typedef {{ readonly event: string, readonly ownerId?: string, readonly assetId?: string, readonly failureKind?: string }} MediaD1Log */
/** @typedef {{ readonly ok: true, readonly value: null } | { readonly ok: false, readonly error: { readonly kind: string } }} MediaD1Result */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function nonNegativeInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
/** @param {D1Result} result @returns {boolean} */
function changed(result) { return result.success === true && result.meta?.changes === 1; }

/** @param {Uint8Array|string} bytes */
async function digest(bytes){return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",typeof bytes==="string"?new TextEncoder().encode(bytes):bytes)),b=>b.toString(16).padStart(2,"0")).join("")}`;}
/** @param {string} pointJson */
async function factDigest(pointJson){const point=JSON.parse(pointJson);return digest(JSON.stringify({summary:point.summary,normalizedHash:point.normalizedHash,evidenceAnchors:point.evidenceAnchors}));}
export class D1KnowledgeMediaRepository {
  /** @type {D1DatabasePort} */ #database;
  /** @type {MediaBucket} */ #bucket;
  /** @type {(entry: MediaD1Log) => void} */ #logger;

  /** @param {{ readonly database: D1DatabasePort, readonly bucket: MediaBucket, readonly logger: (entry: MediaD1Log) => void }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.database?.prepare !== "function" || typeof dependencies.database.batch !== "function" || typeof dependencies.bucket?.put !== "function" || typeof dependencies.bucket.get !== "function" || typeof dependencies.bucket.delete !== "function" || typeof dependencies.logger !== "function") throw new TypeError("D1 knowledge-media dependencies are invalid.");
    this.#database = dependencies.database;
    this.#bucket = dependencies.bucket;
    this.#logger = dependencies.logger;
  }

  /** @param {MediaAsset} asset @param {MediaDerivative} derivative @param {Uint8Array} bytes @returns {Promise<MediaD1Result>} */
  async save(asset, derivative, bytes) {
    if (!validAsset(asset) || !validDerivative(derivative) || !(bytes instanceof Uint8Array) || bytes.byteLength !== derivative.byteCount || asset.ownerId !== derivative.ownerId) return { ok: false, error: { kind: "MediaPersistenceFailed" } };
    if(asset.assetId!==derivative.assetId)return {ok:false,error:{kind:"MediaAssetIdentityMismatch"}};
    const binding=asset.binding;
    if(binding!==undefined){
      if(!record(binding)||!isMediaBindingPurpose(binding)||(binding.kind!=="webpage-support"&&binding.kind!=="uploaded-source")||(binding.kind==="uploaded-source"&&(!text(binding.locator)||!text(binding.sourceDigest)))||binding.ownerId!==asset.ownerId||binding.runId!==asset.runId||binding.originalDigest!==asset.digest||!text(binding.imageId)||!text(binding.evidence)||typeof binding.sourceRevision!=="number"||!Number.isSafeInteger(binding.sourceRevision)||binding.sourceRevision<=0)return {ok:false,error:{kind:"MediaAssetIdentityMismatch"}};
      const point=await this.#database.prepare("SELECT point_json FROM extraction_knowledge_points WHERE owner_id=? AND run_id=? AND knowledge_id=? AND source_revision=?").bind(asset.ownerId,asset.runId,asset.knowledgeId,binding.sourceRevision).first();
      if(!record(point)||!text(point.point_json)||await factDigest(point.point_json)!==binding.factHash)return {ok:false,error:{kind:"MediaAssetIdentityMismatch"}};
    }
    const derivativeDigest=await digest(bytes);
    let written=false;
    this.#logger({event:"knowledge-media-d1-entry",ownerId:asset.ownerId,assetId:asset.assetId});
    try {
      await this.#bucket.put(derivative.privateObjectKey, bytes, { httpMetadata: { contentType: derivative.mediaType }, customMetadata: { owner: asset.ownerId, asset: asset.assetId, variant: derivative.variant } });
      written=true;
      const statements = [
        this.#database.prepare("INSERT INTO knowledge_workflow_media_assets (owner_id, asset_id, run_id, knowledge_id, source_url, origin, kind, media_type, byte_count, digest, private_original_key, attribution, created_at, binding_json, source_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(asset.ownerId, asset.assetId, asset.runId, asset.knowledgeId, asset.sourceUrl, asset.origin, asset.kind, asset.mediaType, asset.byteCount, asset.digest, asset.privateOriginalKey, asset.attribution, asset.createdAt, binding===undefined?null:JSON.stringify(binding),binding?.sourceRevision??null),
        this.#database.prepare("INSERT INTO knowledge_workflow_media_derivatives (owner_id, derivative_id, asset_id, variant, media_type, byte_count, private_object_key, delivery_token, created_at, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(derivative.ownerId, derivative.derivativeId, derivative.assetId, derivative.variant, derivative.mediaType, derivative.byteCount, derivative.privateObjectKey, derivative.deliveryToken, derivative.createdAt,derivativeDigest),
      ];
      const results = await this.#database.batch(statements);
      if (results.length !== statements.length || results.some((result) => !changed(result))) {
        await this.#bucket.delete(derivative.privateObjectKey);
        return { ok: false, error: { kind: "MediaPersistenceFailed" } };
      }
      this.#logger({event:"knowledge-media-d1-success",ownerId:asset.ownerId,assetId:asset.assetId});
      return { ok: true, value: null };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (written) {
        try {await this.#bucket.delete(derivative.privateObjectKey);} catch(cleanupError) {
          if (!(cleanupError instanceof Error)) throw cleanupError;
          this.#logger({event:"knowledge-media-d1-cleanup-failure",ownerId:asset.ownerId,assetId:asset.assetId,failureKind:"MediaCleanupFailed"});
          return {ok:false,error:{kind:"MediaCleanupFailed"}};
        }
      }
      this.#logger({ event: "knowledge-media-d1-failure", ownerId: asset.ownerId, assetId: asset.assetId, failureKind: "MediaPersistenceFailed" });
      return { ok: false, error: { kind: "MediaPersistenceFailed" } };
    }
  }

  /** @param {{ readonly ownerId: string, readonly assetId: string, readonly variant: "feed" | "thumbnail" }} command @returns {Promise<{ readonly ok: true, readonly value: { readonly bytes: Uint8Array, readonly mediaType: string, readonly revoked: boolean, readonly purpose?: "illustration" | "evidence" } } | { readonly ok: false, readonly error: { readonly kind: "MediaDerivativeNotFound" | "MediaPersistenceFailed" | "MediaIntegrityMismatch" | "MediaBindingUnverified" | "MediaObjectReadFailed" } }>} */
  async read(command) {
    if (!text(command?.ownerId) || !text(command.assetId) || (command.variant !== "feed" && command.variant !== "thumbnail")) return { ok: false, error: { kind: "MediaDerivativeNotFound" } };
    try {
      const row = await this.#database.prepare("SELECT d.private_object_key, d.media_type, d.byte_count, d.digest, a.binding_json, a.revoked_at, a.run_id, a.source_revision, a.digest AS original_digest, a.byte_count AS original_byte_count, a.private_original_key, kp.point_json FROM knowledge_workflow_media_derivatives d JOIN knowledge_workflow_media_assets a ON a.owner_id = d.owner_id AND a.asset_id = d.asset_id JOIN extraction_knowledge_points kp ON kp.owner_id=a.owner_id AND kp.run_id=a.run_id AND kp.knowledge_id=a.knowledge_id AND kp.source_revision=a.source_revision WHERE d.owner_id = ? AND d.asset_id = ? AND d.variant = ? LIMIT 1").bind(command.ownerId, command.assetId, command.variant).first();
      if (!record(row) || !text(row.private_object_key) || !text(row.media_type)) return { ok: false, error: { kind: "MediaDerivativeNotFound" } };
      if(!text(row.binding_json))return {ok:false,error:{kind:"MediaBindingUnverified"}};
      let binding;
      try {binding=JSON.parse(row.binding_json);} catch(error) {if(!(error instanceof SyntaxError))throw error;return {ok:false,error:{kind:"MediaBindingUnverified"}};}
      if(!record(binding)||!isMediaBindingPurpose(binding)||(binding.kind!=="webpage-support"&&binding.kind!=="uploaded-source")||binding.ownerId!==command.ownerId||binding.runId!==row.run_id||binding.sourceRevision!==row.source_revision||binding.originalDigest!==row.original_digest||!text(binding.imageId)||!text(binding.evidence)||!text(row.point_json)||await factDigest(row.point_json)!==binding.factHash||(binding.kind==="uploaded-source"&&(!text(binding.locator)||!text(binding.sourceDigest))))return {ok:false,error:{kind:"MediaBindingUnverified"}};
      if(!text(row.private_original_key))return {ok:false,error:{kind:"MediaIntegrityMismatch"}};
      const original=await this.#bucket.get(row.private_original_key);
      if(original===null)return {ok:false,error:{kind:"MediaIntegrityMismatch"}};
      const originalBytes=new Uint8Array(await original.arrayBuffer());
      if(originalBytes.length!==row.original_byte_count||await digest(originalBytes)!==row.original_digest)return {ok:false,error:{kind:"MediaIntegrityMismatch"}};
      const object = await this.#bucket.get(row.private_object_key);
      if (object === null) return { ok: false, error: { kind: "MediaDerivativeNotFound" } };
      const bytes = new Uint8Array(await object.arrayBuffer());
      if(bytes.byteLength!==row.byte_count||!text(row.digest)||await digest(bytes)!==row.digest)return {ok:false,error:{kind:"MediaIntegrityMismatch"}};
      const mime=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71?"image/png":bytes[0]===255&&bytes[1]===216?"image/jpeg":new TextDecoder().decode(bytes.subarray(0,3))==="GIF"?"image/gif":new TextDecoder().decode(bytes.subarray(0,4))==="RIFF"&&new TextDecoder().decode(bytes.subarray(8,12))==="WEBP"?"image/webp":null;
      if(mime!==row.media_type)return {ok:false,error:{kind:"MediaIntegrityMismatch"}};
      return { ok: true, value: Object.freeze({ bytes, mediaType: row.media_type, revoked: row.revoked_at !== null, ...(binding.purpose === undefined ? {} : { purpose: /** @type {"illustration" | "evidence"} */ (binding.purpose) }) }) };
    } catch (error) {
      this.#logger({ event: "knowledge-media-d1-failure", ownerId: command.ownerId, assetId: command.assetId, failureKind: "MediaPersistenceFailed" });
      return { ok: false, error: { kind: "MediaPersistenceFailed" } };
    }
  }

  /** Original pixels for the owner/run-scoped reviewer, never a public delivery URL.
   * @param {{ownerId:string,runId:string,knowledgeId:string,sourceRevision:number}} scope
   * @returns {Promise<{ok:true,value:{id:string,bytes:Uint8Array,mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif',purpose?:'illustration'|'evidence'}|null}|{ok:false,error:{kind:string}}>} */
  async readOriginal(scope) {
    try {
      const row=await this.#database.prepare('SELECT a.private_original_key,a.media_type,a.byte_count,a.digest,a.binding_json,kp.point_json FROM knowledge_workflow_media_assets a JOIN extraction_knowledge_points kp ON kp.owner_id=a.owner_id AND kp.run_id=a.run_id AND kp.knowledge_id=a.knowledge_id AND kp.source_revision=a.source_revision WHERE a.owner_id=? AND a.run_id=? AND a.knowledge_id=? AND a.source_revision=? AND a.revoked_at IS NULL LIMIT 1').bind(scope.ownerId,scope.runId,scope.knowledgeId,scope.sourceRevision).first();
      if(row===null)return {ok:true,value:null};
      if(!record(row)||!text(row.binding_json)||!text(row.private_original_key)||!text(row.point_json)||!['image/png','image/jpeg','image/webp','image/gif'].includes(String(row.media_type)))return {ok:false,error:{kind:'MediaBindingUnverified'}};
      const binding=JSON.parse(row.binding_json);
      if(!record(binding)||!isMediaBindingPurpose(binding)||(binding.kind!=='webpage-support'&&binding.kind!=='uploaded-source')||binding.ownerId!==scope.ownerId||binding.runId!==scope.runId||binding.sourceRevision!==scope.sourceRevision||binding.originalDigest!==row.digest||!text(binding.imageId)||!text(binding.evidence)||await factDigest(row.point_json)!==binding.factHash||(binding.kind==='uploaded-source'&&(!text(binding.locator)||!text(binding.sourceDigest))))return {ok:false,error:{kind:'MediaBindingUnverified'}};
      const object=await this.#bucket.get(row.private_original_key);
      if(object===null)return {ok:false,error:{kind:'MediaObjectReadFailed'}};
      const bytes=new Uint8Array(await object.arrayBuffer());
      if(bytes.length!==row.byte_count||await digest(bytes)!==row.digest)return {ok:false,error:{kind:'MediaIntegrityMismatch'}};
      return {ok:true,value:{id:binding.imageId,bytes,mediaType:/** @type {'image/png'|'image/jpeg'|'image/webp'|'image/gif'} */(row.media_type),...(binding.purpose===undefined?{}:{purpose:/** @type {'illustration'|'evidence'} */(binding.purpose)})}};
    }catch(error){return {ok:false,error:{kind:'MediaObjectReadFailed'}};}
  }

  /** @param {{ readonly ownerId: string, readonly assetId: string }} command @returns {Promise<MediaD1Result>} */
  async revoke(command) {
    if (!text(command?.ownerId) || !text(command.assetId)) return { ok: false, error: { kind: "MediaPersistenceFailed" } };
    try {
      const result = await this.#database.prepare("UPDATE knowledge_workflow_media_assets SET revoked_at = CURRENT_TIMESTAMP WHERE owner_id = ? AND asset_id = ? AND revoked_at IS NULL").bind(command.ownerId, command.assetId).run();
      return result.success === true ? { ok: true, value: null } : { ok: false, error: { kind: "MediaPersistenceFailed" } };
    } catch (error) {
      this.#logger({ event: "knowledge-media-d1-failure", ownerId: command.ownerId, assetId: command.assetId, failureKind: "MediaPersistenceFailed" });
      return { ok: false, error: { kind: "MediaPersistenceFailed" } };
    }
  }
}

/** @param {unknown} value @returns {value is MediaAsset} */
function validAsset(value) { return record(value) && text(value.ownerId) && text(value.runId) && text(value.knowledgeId) && text(value.assetId) && text(value.sourceUrl) && text(value.origin) && (value.kind === "image" || value.kind === "screenshot") && text(value.mediaType) && nonNegativeInteger(value.byteCount) && text(value.digest) && text(value.privateOriginalKey) && text(value.attribution) && text(value.createdAt); }
/** @param {unknown} value @returns {value is MediaDerivative} */
function validDerivative(value) { return record(value) && text(value.ownerId) && text(value.assetId) && text(value.derivativeId) && (value.variant === "feed" || value.variant === "thumbnail") && text(value.mediaType) && nonNegativeInteger(value.byteCount) && text(value.privateObjectKey) && text(value.deliveryToken) && text(value.createdAt); }

export {};
