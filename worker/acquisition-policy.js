// @ts-check
/** @type {import('../acquisition/contracts.ts').Policy} */
export const ACQUISITION_POLICY = Object.freeze({
  htmlBytes: 1_000_000,
  robotsBytes: 256 * 1024,
  screenshotBytes: 2_000_000,
  imageBytes: 20 * 1024 * 1024,
  attachmentCount: 8,
  attachmentBytes: 32 * 1024 * 1024,
  pageRedirects: 3,
  mediaRedirects: 4,
  encodedResourceBytes: 20 * 1024 * 1024,
  encodedOperationBytes: 32 * 1024 * 1024,
  decodedOperationBytes: 32 * 1024 * 1024,
  resources: 64,
  operationMilliseconds: 30_000,
  requestMilliseconds: 15_000,
  pixels: 16_000_000,
  frames: 1,
  aggregatePixels: 32_000_000,
  renderedTextCharacters: 250_000,
  links: 200,
  urlCharacters: 8192,
  viewportWidth: 1280,
  viewportHeight: 720,
});
// Provenance: owner-approved acquisition scope (2026-10-06); additional caps are
// conservative product budgets, not provider limits. Rationale/sources:
// documentations/acquisition-service.md#budgets. Never read environment here.
