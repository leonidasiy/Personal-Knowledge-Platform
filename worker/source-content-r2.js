// @ts-check

/** @import { Result, SourceIngestionFailure } from "../src/features/source-library/ingestion-contracts.js" */

/** @typedef {{ readonly put: (key: string, value: Uint8Array, options: { readonly httpMetadata: { readonly contentType: string }, readonly customMetadata: Readonly<Record<string, string>> }) => Promise<unknown>, readonly get: (key: string) => Promise<{ readonly customMetadata: Readonly<Record<string, string>>, readonly arrayBuffer: () => Promise<ArrayBuffer> } | null>, readonly delete: (key: string) => Promise<void> }} R2BucketPort */
/** @typedef {{readonly reservationId:string,readonly accountScope:string,readonly ownerId:string,readonly objectKey:string,readonly operation:"write"|"read"|"delete",readonly expectedStoredBytes:number,readonly month:string,readonly reservedAt:string}} R2CapacityReservation */
/** @typedef {{readonly reserve:(command:{readonly ownerId:string,readonly objectKey:string,readonly operation:"write"|"read"|"delete",readonly expectedStoredBytes:number})=>Promise<Result<R2CapacityReservation,SourceIngestionFailure>>,readonly reconcile:(command:{readonly reservation:R2CapacityReservation,readonly outcome:"completed"|"not-started"|"uncertain",readonly measuredStoredBytes:number})=>Promise<Result<null,SourceIngestionFailure>>}} R2CapacityPort */

export class R2SourceContentStore {
  /** @type {R2BucketPort} */
  #bucket;
  /** @type {R2CapacityPort} */
  #capacity;
  /** @type {string} */
  #capacityOwnerId;

  /** @param {{ readonly bucket: R2BucketPort, readonly capacity: R2CapacityPort, readonly capacityOwnerId: string }} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies?.bucket?.put !== "function" ||
      typeof dependencies.bucket.get !== "function" ||
      typeof dependencies.bucket.delete !== "function" ||
      typeof dependencies.capacity?.reserve !== "function" ||
      typeof dependencies.capacity.reconcile !== "function" ||
      !validIdentifier(dependencies.capacityOwnerId)
    ) {
      throw new TypeError("R2 source-content dependencies are invalid.");
    }
    this.#bucket = dependencies.bucket;
    this.#capacity = dependencies.capacity;
    this.#capacityOwnerId = dependencies.capacityOwnerId;
  }

  /** @param {string} ownerId @param {string} objectKey @returns {Promise<Result<Uint8Array, SourceIngestionFailure>>} */
  async read(ownerId, objectKey) {
    if (!validIdentifier(ownerId) || !validIdentifier(objectKey) || !objectKey.startsWith("source-content/") || objectKey === "source-content/" || objectKey.includes("..")) throw new TypeError("Source-content read command is invalid.");
    const reserved = await this.#capacity.reserve({ ownerId: this.#capacityOwnerId, objectKey, operation: "read", expectedStoredBytes: 0 });
    if (!reserved.ok) return reserved;
    try {
      const object = await this.#bucket.get(objectKey);
      if (object === null) {
        const reconciled = await this.#capacity.reconcile({ reservation: reserved.value, outcome: "completed", measuredStoredBytes: 0 });
        return reconciled.ok ? { ok: false, error: { kind: "SourceContentNotFound" } } : reconciled;
      }
      if (object.customMetadata?.owner !== ownerId) {
        const reconciled = await this.#capacity.reconcile({ reservation: reserved.value, outcome: "completed", measuredStoredBytes: 0 });
        return reconciled.ok ? { ok: false, error: { kind: "SourceContentOwnerMismatch" } } : reconciled;
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      const reconciled = await this.#capacity.reconcile({ reservation: reserved.value, outcome: "completed", measuredStoredBytes: bytes.byteLength });
      return reconciled.ok ? { ok: true, value: bytes } : reconciled;
    } catch (error) {
      if (error instanceof Error) {
        const reconciled = await this.#capacity.reconcile({ reservation: reserved.value, outcome: "uncertain", measuredStoredBytes: 0 });
        return reconciled.ok ? { ok: false, error: { kind: "R2CapacityUsageUncertain" } } : reconciled;
      }
      throw error;
    }
  }

  /** @param {{ readonly objectId: string, readonly ownerId: string, readonly sourceId: string, readonly itemId: string, readonly itemVersionId: string, readonly content: Uint8Array, readonly contentDigest: string, readonly mediaType: string }} command @returns {Promise<Result<{ readonly objectKey: string }, SourceIngestionFailure>>} */
  async stage(command) {
    if (!validIdentifier(command.objectId) || !validIdentifier(command.ownerId) ||
      !validIdentifier(command.sourceId) || !validIdentifier(command.itemId) ||
      !validIdentifier(command.itemVersionId) || !(command.content instanceof Uint8Array) ||
      command.content.byteLength === 0 || !validIdentifier(command.contentDigest) ||
      !supportedContentType(command.mediaType)) {
      throw new TypeError("Source-content stage command is invalid.");
    }
    const objectKey = `source-content/${encodeURIComponent(command.objectId)}`;
    const reserved = await this.#capacity.reserve({
      ownerId: this.#capacityOwnerId,
      objectKey,
      operation: "write",
      expectedStoredBytes: command.content.byteLength,
    });
    if (!reserved.ok) return reserved;
    try {
      await this.#bucket.put(objectKey, command.content, {
        httpMetadata: { contentType: command.mediaType },
        customMetadata: {
          owner: command.ownerId,
          source: command.sourceId,
          item: command.itemId,
          version: command.itemVersionId,
          digest: command.contentDigest,
        },
      });
      const reconciled = await this.#capacity.reconcile({
        reservation: reserved.value,
        outcome: "completed",
        measuredStoredBytes: command.content.byteLength,
      });
      if (!reconciled.ok) return reconciled;
      return { ok: true, value: Object.freeze({ objectKey }) };
    } catch (error) {
      if (error instanceof Error) {
        const reconciled = await this.#capacity.reconcile({
          reservation: reserved.value,
          outcome: "uncertain",
          measuredStoredBytes: 0,
        });
        return reconciled.ok
          ? { ok: false, error: { kind: "R2CapacityUsageUncertain" } }
          : reconciled;
      }
      throw error;
    }
  }

  /** @param {string} objectKey @returns {Promise<Result<null, SourceIngestionFailure>>} */
  async remove(objectKey) {
    if (!objectKey.startsWith("source-content/") || objectKey.includes("..")) {
      throw new TypeError("Source-content object key is invalid.");
    }
    const reserved = await this.#capacity.reserve({
      ownerId: this.#capacityOwnerId,
      objectKey,
      operation: "delete",
      expectedStoredBytes: 0,
    });
    if (!reserved.ok) return reserved;
    try {
      await this.#bucket.delete(objectKey);
      const reconciled = await this.#capacity.reconcile({
        reservation: reserved.value,
        outcome: "completed",
        measuredStoredBytes: 0,
      });
      if (!reconciled.ok) return reconciled;
      return { ok: true, value: null };
    } catch (error) {
      if (error instanceof Error) {
        const reconciled = await this.#capacity.reconcile({
          reservation: reserved.value,
          outcome: "uncertain",
          measuredStoredBytes: 0,
        });
        return reconciled.ok
          ? { ok: false, error: { kind: "R2CapacityUsageUncertain" } }
          : reconciled;
      }
      throw error;
    }
  }
}

/** @param {unknown} value */
function validIdentifier(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= 512;
}

/** @param {unknown} value @returns {value is string} */
function supportedContentType(value) {
  return typeof value === "string" && (value.startsWith("text/") || value === "application/pdf" || value === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif" || value === "application/x-knowledge-images");
}

export {};
