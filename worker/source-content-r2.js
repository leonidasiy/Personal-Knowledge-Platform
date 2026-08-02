// @ts-check

/** @import { Result, SourceIngestionFailure } from "../src/features/source-library/ingestion-contracts.js" */

/** @typedef {{ readonly put: (key: string, value: Uint8Array, options: { readonly httpMetadata: { readonly contentType: string }, readonly customMetadata: Readonly<Record<string, string>> }) => Promise<unknown>, readonly delete: (key: string) => Promise<void> }} R2BucketPort */
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

  /** @param {{ readonly objectId: string, readonly ownerId: string, readonly sourceId: string, readonly itemId: string, readonly itemVersionId: string, readonly content: Uint8Array, readonly contentDigest: string, readonly mediaType: string }} command @returns {Promise<Result<{ readonly objectKey: string }, SourceIngestionFailure>>} */
  async stage(command) {
    if (!validIdentifier(command.objectId) || !validIdentifier(command.ownerId) ||
      !validIdentifier(command.sourceId) || !validIdentifier(command.itemId) ||
      !validIdentifier(command.itemVersionId) || !(command.content instanceof Uint8Array) ||
      command.content.byteLength === 0 || !validIdentifier(command.contentDigest) ||
      typeof command.mediaType !== "string" || !command.mediaType.startsWith("text/")) {
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

export {};
