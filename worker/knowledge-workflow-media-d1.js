// @ts-check

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
    try {
      await this.#bucket.put(derivative.privateObjectKey, bytes, { httpMetadata: { contentType: derivative.mediaType }, customMetadata: { owner: asset.ownerId, asset: asset.assetId, variant: derivative.variant } });
      const statements = [
        this.#database.prepare("INSERT INTO knowledge_workflow_media_assets (owner_id, asset_id, run_id, knowledge_id, source_url, origin, kind, media_type, byte_count, digest, private_original_key, attribution, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(asset.ownerId, asset.assetId, asset.runId, asset.knowledgeId, asset.sourceUrl, asset.origin, asset.kind, asset.mediaType, asset.byteCount, asset.digest, asset.privateOriginalKey, asset.attribution, asset.createdAt),
        this.#database.prepare("INSERT INTO knowledge_workflow_media_derivatives (owner_id, derivative_id, asset_id, variant, media_type, byte_count, private_object_key, delivery_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(derivative.ownerId, derivative.derivativeId, derivative.assetId, derivative.variant, derivative.mediaType, derivative.byteCount, derivative.privateObjectKey, derivative.deliveryToken, derivative.createdAt),
      ];
      const results = await this.#database.batch(statements);
      if (results.length !== statements.length || results.some((result) => !changed(result))) {
        await this.#bucket.delete(derivative.privateObjectKey);
        return { ok: false, error: { kind: "MediaPersistenceFailed" } };
      }
      return { ok: true, value: null };
    } catch (error) {
      this.#logger({ event: "knowledge-media-d1-failure", ownerId: asset.ownerId, assetId: asset.assetId, failureKind: "MediaPersistenceFailed" });
      return { ok: false, error: { kind: "MediaPersistenceFailed" } };
    }
  }

  /** @param {{ readonly ownerId: string, readonly assetId: string, readonly variant: "feed" | "thumbnail" }} command @returns {Promise<{ readonly ok: true, readonly value: { readonly bytes: Uint8Array, readonly mediaType: string, readonly revoked: boolean } } | { readonly ok: false, readonly error: { readonly kind: "MediaDerivativeNotFound" | "MediaPersistenceFailed" } }>} */
  async read(command) {
    if (!text(command?.ownerId) || !text(command.assetId) || (command.variant !== "feed" && command.variant !== "thumbnail")) return { ok: false, error: { kind: "MediaDerivativeNotFound" } };
    try {
      const row = await this.#database.prepare("SELECT d.private_object_key, d.media_type, a.revoked_at FROM knowledge_workflow_media_derivatives d JOIN knowledge_workflow_media_assets a ON a.owner_id = d.owner_id AND a.asset_id = d.asset_id WHERE d.owner_id = ? AND d.asset_id = ? AND d.variant = ? LIMIT 1").bind(command.ownerId, command.assetId, command.variant).first();
      if (!record(row) || !text(row.private_object_key) || !text(row.media_type)) return { ok: false, error: { kind: "MediaDerivativeNotFound" } };
      const object = await this.#bucket.get(row.private_object_key);
      if (object === null) return { ok: false, error: { kind: "MediaDerivativeNotFound" } };
      const bytes = new Uint8Array(await object.arrayBuffer());
      return { ok: true, value: Object.freeze({ bytes, mediaType: row.media_type, revoked: row.revoked_at !== null }) };
    } catch (error) {
      this.#logger({ event: "knowledge-media-d1-failure", ownerId: command.ownerId, assetId: command.assetId, failureKind: "MediaPersistenceFailed" });
      return { ok: false, error: { kind: "MediaPersistenceFailed" } };
    }
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
