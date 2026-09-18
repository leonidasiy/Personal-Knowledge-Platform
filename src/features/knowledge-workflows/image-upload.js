// @ts-check

const MAX_IMAGES = 100;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const BUNDLE_TYPE = "application/x-knowledge-images";

/** @typedef {{ readonly name: string, readonly locator: string, readonly mediaType: string, readonly bytes: Uint8Array }} ImagePage */
/** @template T @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: { readonly kind: "ImageBundleInvalid" | "ImageBundleTooLarge" | "PdfPageRangeInvalid" } }} Result */

export { BUNDLE_TYPE };

/** @param {Uint8Array} bytes @returns {string | null} */
export function imageSignature(bytes) {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length >= 6 && (new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a")) return "image/gif";
  return null;
}

/** @param {string} expression @param {number} pageCount @returns {Result<readonly number[]>} */
export function parsePdfPageRange(expression, pageCount) {
  if (typeof expression !== "string" || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_IMAGES) return { ok: false, error: { kind: "PdfPageRangeInvalid" } };
  if (expression.trim() === "") return { ok: true, value: Array.from({ length: pageCount }, (_, index) => index + 1) };
  const pages = [];
  const seen = new Set();
  for (const part of expression.split(",")) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/u.exec(part);
    if (match === null) return { ok: false, error: { kind: "PdfPageRangeInvalid" } };
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > pageCount) return { ok: false, error: { kind: "PdfPageRangeInvalid" } };
    for (let page = first; page <= last; page += 1) if (!seen.has(page)) { seen.add(page); pages.push(page); }
  }
  return { ok: true, value: pages };
}

/** @param {readonly ImagePage[]} pages @returns {Result<Uint8Array>} */
export function packImageBundle(pages) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_IMAGES) return { ok: false, error: { kind: "ImageBundleInvalid" } };
  const locators = new Set();
  for (const page of pages) {
    if (typeof page?.name !== "string" || page.name.trim() === "" || page.name.length > 300 || typeof page.locator !== "string" || !/^(?:page|image):[1-9]\d*$/u.test(page.locator) || locators.has(page.locator) || !(page.bytes instanceof Uint8Array) || page.bytes.length < 1 || imageSignature(page.bytes) !== page.mediaType) return { ok: false, error: { kind: "ImageBundleInvalid" } };
    if (page.bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: { kind: "ImageBundleTooLarge" } };
    locators.add(page.locator);
  }
  const header = new TextEncoder().encode(JSON.stringify(pages.map(({ name, locator, mediaType, bytes }) => ({ name, locator, mediaType, length: bytes.length }))));
  const size = 8 + header.length + pages.reduce((total, page) => total + page.bytes.length, 0);
  if (header.length > 32_768 || size > MAX_BUNDLE_BYTES) return { ok: false, error: { kind: "ImageBundleTooLarge" } };
  // ponytail: one bounded in-memory upload; stage pages individually if large PDFs exceed browser memory.
  const output = new Uint8Array(size);
  output.set([0x50, 0x4b, 0x50, 0x49]);
  new DataView(output.buffer).setUint32(4, header.length, true);
  output.set(header, 8);
  let offset = 8 + header.length;
  for (const page of pages) { output.set(page.bytes, offset); offset += page.bytes.length; }
  return { ok: true, value: output };
}

/** @param {Uint8Array} bytes @returns {Result<readonly ImagePage[]>} */
export function parseImageBundle(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 10 || bytes.length > MAX_BUNDLE_BYTES || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x50 || bytes[3] !== 0x49) return { ok: false, error: { kind: "ImageBundleInvalid" } };
  const length = new DataView(bytes.buffer, bytes.byteOffset, 8).getUint32(4, true);
  if (length < 2 || length > 32_768 || 8 + length >= bytes.length) return { ok: false, error: { kind: "ImageBundleInvalid" } };
  let header;
  try { header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(8, 8 + length))); } catch { return { ok: false, error: { kind: "ImageBundleInvalid" } }; }
  if (!Array.isArray(header) || header.length < 1 || header.length > MAX_IMAGES) return { ok: false, error: { kind: "ImageBundleInvalid" } };
  /** @type {ImagePage[]} */ const pages = [];
  const locators = new Set();
  let offset = 8 + length;
  for (const item of header) {
    if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).sort().join(",") !== "length,locator,mediaType,name" || typeof item.name !== "string" || item.name.trim() === "" || item.name.length > 300 || typeof item.locator !== "string" || !/^(?:page|image):[1-9]\d*$/u.test(item.locator) || locators.has(item.locator) || !Number.isSafeInteger(item.length) || item.length < 1 || item.length > MAX_IMAGE_BYTES || offset + item.length > bytes.length) return { ok: false, error: { kind: "ImageBundleInvalid" } };
    const image = bytes.slice(offset, offset + item.length);
    if (imageSignature(image) !== item.mediaType) return { ok: false, error: { kind: "ImageBundleInvalid" } };
    pages.push({ name: item.name, locator: item.locator, mediaType: item.mediaType, bytes: image });
    locators.add(item.locator);
    offset += item.length;
  }
  return offset === bytes.length ? { ok: true, value: pages } : { ok: false, error: { kind: "ImageBundleInvalid" } };
}
