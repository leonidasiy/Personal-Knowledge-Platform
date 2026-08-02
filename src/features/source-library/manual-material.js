// @ts-check

import { isIsoDateTime, isNonEmptyText, isPositiveInteger, isRecord } from "./ingestion-contracts.js";

/** @import { Result, SourceContentReference, SourceIngestionFailure, SourceRightsAssessment } from "./ingestion-contracts.js" */

const freeze = Object.freeze;

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly itemId: string,
 *   readonly itemVersionId: string,
 *   readonly mediaType: string,
 *   readonly content: string,
 *   readonly rightsAttestation: {
 *     readonly storageAllowed: true,
 *     readonly transformationAllowed: true,
 *     readonly basis: string,
 *     readonly reference: string
 *   },
 *   readonly idempotencyKey: string
 * }} ManualMaterialCommand
 */

/** @typedef {{ readonly fingerprint: string, readonly reference: SourceContentReference }} ManualMaterialReplay */

export class ManualMaterialService {
  #dependencies;

  /**
   * @param {{
   *   readonly sourceItems: { readonly find: (query: { readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly itemId: string, readonly itemVersionId: string }) => Promise<Result<{ readonly state: "active" | "disabled" }, SourceIngestionFailure>> },
   *   readonly repository: { readonly replay: (ownerId: string, idempotencyKey: string) => Promise<Result<ManualMaterialReplay | null, SourceIngestionFailure>>, readonly persist: (command: { readonly fingerprint: string, readonly idempotencyKey: string, readonly rightsAssessment: SourceRightsAssessment, readonly contentReference: SourceContentReference }) => Promise<Result<SourceContentReference, SourceIngestionFailure>> },
   *   readonly contentStore: { readonly stage: (command: { readonly objectId: string, readonly ownerId: string, readonly sourceId: string, readonly itemId: string, readonly itemVersionId: string, readonly content: Uint8Array, readonly contentDigest: string, readonly mediaType: string }) => Promise<Result<{ readonly objectKey: string }, SourceIngestionFailure>>, readonly remove: (objectKey: string) => Promise<Result<null, SourceIngestionFailure>> },
   *   readonly digest: (content: Uint8Array) => Promise<Result<string, SourceIngestionFailure>>,
   *   readonly createId: () => string,
   *   readonly now: () => string,
   *   readonly supportedMediaTypes: ReadonlySet<string>,
   *   readonly maximumBytes: number,
   *   readonly maximumCharacters: number
   * }} dependencies
   */
  constructor(dependencies) {
    if (typeof dependencies?.sourceItems?.find !== "function" ||
      typeof dependencies.repository?.replay !== "function" || typeof dependencies.repository.persist !== "function" ||
      typeof dependencies.contentStore?.stage !== "function" || typeof dependencies.contentStore.remove !== "function" ||
      typeof dependencies.digest !== "function" || typeof dependencies.createId !== "function" ||
      typeof dependencies.now !== "function" || !(dependencies.supportedMediaTypes instanceof Set) ||
      !isPositiveInteger(dependencies.maximumBytes) || !isPositiveInteger(dependencies.maximumCharacters)) {
      throw new TypeError("Manual-material dependencies are invalid.");
    }
    this.#dependencies = dependencies;
  }

  /** @param {unknown} input @returns {Promise<Result<{ readonly status: "processing-ready", readonly reference: SourceContentReference, readonly reused: boolean }, SourceIngestionFailure>>} */
  async upload(input) {
    const command = validateCommand(input);
    if (!command.ok) return command;
    if (!this.#dependencies.supportedMediaTypes.has(command.value.mediaType)) {
      return fail({ kind: "ManualUploadContentTypeUnsupported" });
    }
    if (command.value.content.length > this.#dependencies.maximumCharacters) {
      return fail({ kind: "ManualUploadTextLimitExceeded", maximum: this.#dependencies.maximumCharacters });
    }
    if (!hasValidUnicodeEncoding(command.value.content)) {
      return fail({ kind: "ManualUploadEncodingInvalid" });
    }
    const bytes = new TextEncoder().encode(command.value.content);
    if (bytes.byteLength > this.#dependencies.maximumBytes) {
      return fail({ kind: "ManualUploadByteLimitExceeded", maximum: this.#dependencies.maximumBytes });
    }
    const sourceItem = await this.#dependencies.sourceItems.find(command.value);
    if (!sourceItem.ok) return sourceItem;
    if (sourceItem.value.state === "disabled") return fail({ kind: "ManualUploadSourceDisabled" });
    const digest = await this.#dependencies.digest(bytes);
    if (!digest.ok) return fail({ kind: "ManualUploadDigestUnavailable" });
    const fingerprint = fingerprintOf(command.value, digest.value);
    const replay = await this.#dependencies.repository.replay(command.value.ownerId, command.value.idempotencyKey);
    if (!replay.ok) return replay;
    if (replay.value !== null) {
      return replay.value.fingerprint === fingerprint
        ? { ok: true, value: freeze({ status: /** @type {const} */ ("processing-ready"), reference: replay.value.reference, reused: true }) }
        : fail({ kind: "ManualUploadIdempotencyConflict" });
    }
    const contentId = this.#id("manual-content");
    const rightsId = this.#id("manual-rights");
    const staged = await this.#dependencies.contentStore.stage({ objectId: contentId, ownerId: command.value.ownerId, sourceId: command.value.sourceId, itemId: command.value.itemId, itemVersionId: command.value.itemVersionId, content: bytes, contentDigest: digest.value, mediaType: command.value.mediaType });
    if (!staged.ok) return staged;
    const occurredAt = this.#dependencies.now();
    if (!isIsoDateTime(occurredAt)) throw new TypeError("Manual-material clock returned an invalid time.");
    const rightsAssessment = freeze({ id: rightsId, ownerId: command.value.ownerId, sourceId: command.value.sourceId, sourceRevision: command.value.sourceRevision, itemId: command.value.itemId, itemVersionId: command.value.itemVersionId, capabilities: freeze([{ capability: "storage", outcome: /** @type {const} */ ("allowed") }, { capability: "transformation", outcome: /** @type {const} */ ("allowed") }]), evidence: freeze([{ reference: command.value.rightsAttestation.reference, observedAt: occurredAt }]), assessedAt: occurredAt, expiresAt: null });
    const contentReference = freeze({ id: contentId, ownerId: command.value.ownerId, sourceId: command.value.sourceId, sourceRevision: command.value.sourceRevision, itemId: command.value.itemId, itemVersionId: command.value.itemVersionId, objectKey: staged.value.objectKey, contentDigest: digest.value, rightsAssessmentId: rightsId, state: /** @type {const} */ ("processing-ready"), createdAt: occurredAt });
    const persisted = await this.#dependencies.repository.persist({ fingerprint, idempotencyKey: command.value.idempotencyKey, rightsAssessment, contentReference });
    if (!persisted.ok) {
      const removed = await this.#dependencies.contentStore.remove(staged.value.objectKey);
      if (!removed.ok) return removed;
      return persisted;
    }
    return { ok: true, value: freeze({ status: /** @type {const} */ ("processing-ready"), reference: persisted.value, reused: false }) };
  }

  /** @param {string} prefix */
  #id(prefix) {
    const value = this.#dependencies.createId();
    if (!isNonEmptyText(value)) throw new TypeError("Manual-material ID factory returned an invalid ID.");
    return `${prefix}:${value}`;
  }
}

/** @param {unknown} value @returns {Result<ManualMaterialCommand, SourceIngestionFailure>} */
function validateCommand(value) {
  if (!isRecord(value)) return invalid("command");
  for (const field of ["ownerId", "sourceId", "itemId", "itemVersionId", "mediaType", "content", "idempotencyKey"]) {
    if (!isNonEmptyText(value[field])) return invalid(field);
  }
  if (!isPositiveInteger(value.sourceRevision)) return invalid("sourceRevision");
  if (!isRecord(value.rightsAttestation)) return fail({ kind: "UploadRightsAttestationMissing" });
  if (value.rightsAttestation.storageAllowed !== true || value.rightsAttestation.transformationAllowed !== true ||
    !isNonEmptyText(value.rightsAttestation.basis) || !isNonEmptyText(value.rightsAttestation.reference)) {
    return fail({ kind: "UploadRightsAttestationMissing" });
  }
  const checked = /** @type {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly itemId: string, readonly itemVersionId: string, readonly mediaType: string, readonly content: string, readonly idempotencyKey: string, readonly rightsAttestation: { readonly storageAllowed: true, readonly transformationAllowed: true, readonly basis: string, readonly reference: string } }} */ (value);
  return { ok: true, value: /** @type {ManualMaterialCommand} */ (freeze({
    ownerId: checked.ownerId.trim(), sourceId: checked.sourceId.trim(), sourceRevision: checked.sourceRevision,
    itemId: checked.itemId.trim(), itemVersionId: checked.itemVersionId.trim(), mediaType: checked.mediaType.trim().toLowerCase(),
    content: checked.content, idempotencyKey: checked.idempotencyKey.trim(), rightsAttestation: freeze({
      storageAllowed: true, transformationAllowed: true, basis: checked.rightsAttestation.basis.trim(), reference: checked.rightsAttestation.reference.trim(),
    }),
  })) };
}

/** @param {ManualMaterialCommand} command @param {string} digest */
function fingerprintOf(command, digest) {
  return JSON.stringify([command.ownerId, command.sourceId, command.sourceRevision, command.itemId, command.itemVersionId, command.mediaType, digest, command.rightsAttestation.basis, command.rightsAttestation.reference]);
}

/** @param {string} value */
function hasValidUnicodeEncoding(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return false;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

/** @param {string} field @returns {Result<never, SourceIngestionFailure>} */
function invalid(field) { return { ok: false, error: { kind: "ManualUploadCommandInvalid", field } }; }
/** @param {SourceIngestionFailure} error @returns {Result<never, SourceIngestionFailure>} */
function fail(error) { return { ok: false, error }; }

export {};
