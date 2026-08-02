// @ts-check

import {
  isIsoDateTime,
  isNonEmptyText,
  isRecord,
} from "../src/features/source-library/contracts.js";

/** @import { Result, SourceLibraryFailure } from "../src/features/source-library/contracts.js" */
/** @import { SourceCursorValue } from "../src/features/source-library/query.js" */

const encoder = new TextEncoder();

/**
 * @param {string} secret
 * @param {SubtleCrypto} subtle
 */
export function createSourceCursorCodec(secret, subtle) {
  if (secret.length < 32 || typeof subtle?.importKey !== "function") {
    throw new TypeError("Source cursor codec dependencies are invalid.");
  }
  const key = subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return Object.freeze({
    /** @param {SourceCursorValue} value @returns {Promise<Result<string, SourceLibraryFailure>>} */
    async encode(value) {
      const body = base64Url(encoder.encode(JSON.stringify(value)));
      const signature = await subtle.sign(
        "HMAC",
        await key,
        encoder.encode(body),
      );
      return {
        ok: true,
        value: `${body}.${base64Url(new Uint8Array(signature))}`,
      };
    },
    /** @param {string} cursor @returns {Promise<Result<SourceCursorValue, SourceLibraryFailure>>} */
    async decode(cursor) {
      const parts = cursor.split(".");
      if (parts.length !== 2) return invalid();
      const signature = fromBase64Url(parts[1]);
      const body = fromBase64Url(parts[0]);
      if (signature === null || body === null) return invalid();
      const verified = await subtle.verify(
        "HMAC",
        await key,
        signature,
        encoder.encode(parts[0]),
      );
      if (!verified) return invalid();
      let value;
      try {
        value = /** @type {unknown} */ (
          JSON.parse(new TextDecoder().decode(body))
        );
      } catch (error) {
        if (error instanceof SyntaxError) return invalid();
        throw error;
      }
      if (
        !isRecord(value) || !isNonEmptyText(value.ownerId) ||
        !isIsoDateTime(value.approvedAt) || !isNonEmptyText(value.sourceId) ||
        !isNonEmptyText(value.catalogRevision)
      ) {
        return invalid();
      }
      return {
        ok: true,
        value: Object.freeze({
          ownerId: value.ownerId,
          approvedAt: value.approvedAt,
          sourceId: value.sourceId,
          catalogRevision: value.catalogRevision,
        }),
      };
    },
  });
}

/** @param {Uint8Array} bytes */
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

/** @param {string} value */
function fromBase64Url(value) {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

/** @returns {Result<never, Extract<SourceLibraryFailure, { readonly kind: "SourceCursorInvalid" }>>} */
function invalid() {
  return { ok: false, error: { kind: "SourceCursorInvalid" } };
}

export {};
