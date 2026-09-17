// @ts-check

import { parseAuthorizedMaterial } from "../src/features/knowledge-workflows/material.js";
import { BUNDLE_TYPE, packImageBundle } from "../src/features/knowledge-workflows/image-upload.js";

const base = Object.freeze({
  ownerId: "owner-a",
  runId: "run-a",
  sourceId: "source-a",
  sourceRevision: 1,
  sourceUrl: "https://example.test/learn",
  idempotencyKey: "material-a",
  rightsAttestation: Object.freeze({ ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis: "learner-provided copy", reference: "https://example.test/permission" }),
});

/** @param {string} value */
function bytes(value) { return new TextEncoder().encode(value); }

/** @param {number} value @param {number} count */
function u32(value, count) { const result = new Uint8Array(count); new DataView(result.buffer).setUint32(0, value, true); return result; }

/** @param {readonly Uint8Array[]} parts */
function join(parts) { const size = parts.reduce((total, part) => total + part.byteLength, 0); const result = new Uint8Array(size); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.byteLength; } return result; }

/** @param {readonly { readonly name: string, readonly data: Uint8Array, readonly method?: number, readonly expandedSize?: number }[]} entries */
function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = bytes(entry.name);
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(8, entry.method ?? 0, true);
    view.setUint32(18, entry.data.byteLength, true);
    view.setUint32(22, entry.expandedSize ?? entry.data.byteLength, true);
    view.setUint16(26, name.byteLength, true);
    local.push(header, name, entry.data);
    const record = new Uint8Array(46);
    const centralView = new DataView(record.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x800, true);
    centralView.setUint16(10, entry.method ?? 0, true);
    centralView.setUint32(20, entry.data.byteLength, true);
    centralView.setUint32(24, entry.expandedSize ?? entry.data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.push(record, name);
    offset += header.byteLength + name.byteLength + entry.data.byteLength;
  }
  const centralBytes = join(central);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralBytes.byteLength, true);
  endView.setUint32(16, offset, true);
  return join([...local, centralBytes, end]);
}

/** @param {Uint8Array} value */
async function digest(value) {
  const hashed = await crypto.subtle.digest("SHA-256", value);
  return `sha256:${Array.from(new Uint8Array(hashed), (item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function dependencies() { return { digest, maximumBytes: 2_000_000, maximumCharacters: 250_000 }; }

/** @param {string} value */
function base64(value) { return Uint8Array.from(atob(value), (character) => character.codePointAt(0) ?? 0); }

/** @param {Uint8Array} value @param {number} size */
function padPdf(value, size) {
  if (value.byteLength > size) throw new RangeError("PDF fixture exceeds requested size.");
  const padded = new Uint8Array(size);
  padded.set(value);
  padded.fill(0x20, value.byteLength);
  return padded;
}

/** @param {readonly string[]} pages */
function pdf(pages) {
  const objects = ["", "<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const [index, page] of pages.entries()) {
    const pageId = 4 + index * 2;
    const content = page === "" ? "" : `BT /F1 12 Tf 72 720 Td (${page.replace(/[\\()]/gu, "\\$&")}) Tj ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }
  let output = "%PDF-1.7\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = output.length;
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = output.length;
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return bytes(output);
}

Deno.test("authorized pasted text becomes bounded, anchored material for the shared pipeline", async () => {
  const result = await parseAuthorizedMaterial({ ...base, mediaType: "text/plain", fileName: "pasted-text.txt", bytes: bytes("# Cadences\n\nAn authentic cadence resolves to the tonic." ) }, dependencies());
  if (!result.ok) throw new Error(result.error.kind);
  if (result.value.sections.length !== 1 || !result.value.sections[0].text.includes("authentic cadence")) throw new Error("Expected pasted text section.");
  if (result.value.provenance.kind !== "authorized-user-material" || result.value.provenance.processingAllowed !== true) throw new Error("Expected explicit processing authorization provenance.");
});

Deno.test("image mode accepts a signed raster upload and rejects unsupported or mismatched image input", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const accepted = await parseAuthorizedMaterial({ ...base, mode: "image", mediaType: "image/png", fileName: "chapter5-page-001.png", bytes: png }, dependencies());
  if (!accepted.ok) throw new Error(accepted.error.kind);
  if (accepted.value.mode !== "image" || accepted.value.sections.length !== 1 || accepted.value.sections[0]?.locator !== "image:1" || accepted.value.sections[0]?.text !== "") throw new Error("Expected one empty, image-anchored section.");
  const oversizedImage = new Uint8Array(20 * 1024 * 1024 + 1);
  oversizedImage.set(png);
  const overImageLimit = await parseAuthorizedMaterial({ ...base, mode: "image", mediaType: "image/png", fileName: "large.png", bytes: oversizedImage, idempotencyKey: "material-image-large" }, { ...dependencies(), maximumBytes: 100 * 1024 * 1024 });
  if (overImageLimit.ok || overImageLimit.error.kind !== "MaterialByteLimitExceeded" || overImageLimit.error.maximum !== 20 * 1024 * 1024) throw new Error("Expected the vision attachment byte ceiling.");
  const pdfImageMode = await parseAuthorizedMaterial({ ...base, mode: "image", mediaType: "application/pdf", fileName: "slides.pdf", bytes: pdf(["text"]), idempotencyKey: "material-image-pdf" }, dependencies());
  if (pdfImageMode.ok || pdfImageMode.error.kind !== "MaterialImageModeUnsupported") throw new Error("Expected image-mode PDF conversion boundary.");
  const mismatch = await parseAuthorizedMaterial({ ...base, mode: "image", mediaType: "image/jpeg", fileName: "wrong.jpg", bytes: png, idempotencyKey: "material-image-mismatch" }, dependencies());
  if (mismatch.ok || mismatch.error.kind !== "MaterialImageInvalid") throw new Error("Expected MIME/signature mismatch failure.");
});

Deno.test("image batches retain distinct PDF page anchors and require image mode", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const packed = packImageBundle([{ name: "Page 2", locator: "page:2", mediaType: "image/png", bytes: png }, { name: "Page 5", locator: "page:5", mediaType: "image/png", bytes: png }]);
  if (!packed.ok) throw new Error(packed.error.kind);
  const command = { ...base, mode: "image", mediaType: BUNDLE_TYPE, fileName: "manual.pdf.pkpi", bytes: packed.value };
  const accepted = await parseAuthorizedMaterial(command, dependencies());
  if (!accepted.ok || accepted.value.sections.map((section) => section.locator).join(",") !== "page:2,page:5" || accepted.value.media.length !== 2) throw new Error("Image bundle lost source anchors.");
  const rejected = await parseAuthorizedMaterial({ ...command, mode: "text" }, dependencies());
  if (rejected.ok || rejected.error.kind !== "MaterialImageModeUnsupported") throw new Error("Text mode accepted a vision bundle.");
});

Deno.test("PDF extraction returns one page-anchored section per text page and rejects image-only, encrypted, and over-page documents", async () => {
  const uploaded = pdf(["C major is a tonal center.", "Dominant resolves to tonic."]);
  const original = new Uint8Array(uploaded);
  const extracted = await parseAuthorizedMaterial({ ...base, mediaType: "application/pdf", fileName: "lesson.pdf", bytes: uploaded }, dependencies());
  if (!extracted.ok) throw new Error(extracted.error.kind);
  if (extracted.value.sections.length !== 2 || extracted.value.sections[0]?.locator !== "page:1" || extracted.value.sections[1]?.locator !== "page:2") throw new Error("Expected page anchors.");
  if (uploaded.byteLength !== original.byteLength || !uploaded.every((value, index) => value === original[index])) throw new Error("PDF parsing must not detach or modify upload bytes before staging.");
  const scan = await parseAuthorizedMaterial({ ...base, mediaType: "application/pdf", fileName: "scan.pdf", bytes: pdf([""]), idempotencyKey: "material-scan" }, dependencies());
  if (scan.ok || scan.error.kind !== "MaterialPdfTextExtractionUnavailable") throw new Error("Expected scan-only PDF failure.");
  const encrypted = await parseAuthorizedMaterial({ ...base, mediaType: "application/pdf", fileName: "encrypted.pdf", bytes: base64("JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDYyNzgxMmI5OGM+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA3MiA3MiBdCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1YgMgovUiAzCi9MZW5ndGggMTI4Ci9QIDQyOTQ5NjcyOTIKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDU0MjE3OGY5NmE1YWFhZjZmZTBhZmMzM2M1NWUxYzhkNGE3NjQ5ZWQ2ODQ1NmM0YzI3YjA3OTRkZThjNGU3OWM+Ci9VIDwyYjJlMmE3YWI5OTNkN2I3MjVlOWFkNjQ3MmQ2ZTg1OTI4YmY0ZTVlNGU3NThhNDE2NDAwNGU1NmZmZmEwMTA4Pgo+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNTkgMDAwMDAgbiAKMDAwMDAwMDExOCAwMDAwMCBuIAowMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI1OSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDY0NjY2MzYxNjYzNTM0MzIzNzM5MzAzMzMyMzAzNjY0NjQzMTMxMzEzNDM0MzE2NDMwNjIzNTYyNjEzOTM2MzE2Mj4gPDY0NjY2MzYxNjYzNTM0MzIzNzM5MzAzMzMyMzAzNjY0NjQzMTMxMzEzNDM0MzE2NDMwNjIzNTYyNjEzOTM2MzE2Mj4gXQovRW5jcnlwdCA1IDAgUgo+PgpzdGFydHhyZWYKNDc0CiUlRU9GCg=="), idempotencyKey: "material-encrypted" }, dependencies());
  if (encrypted.ok || encrypted.error.kind !== "MaterialPdfEncrypted") throw new Error("Expected encrypted PDF failure.");
  const capped = await parseAuthorizedMaterial({ ...base, mediaType: "application/pdf", fileName: "101-pages.pdf", bytes: pdf(Array.from({ length: 101 }, () => "page")), idempotencyKey: "material-page-cap" }, dependencies());
  if (capped.ok || capped.error.kind !== "MaterialPdfPageLimitExceeded" || capped.error.maximum !== 100) throw new Error("Expected 100-page PDF safety ceiling.");
});

Deno.test("PDF parsing rejects malformed input and enforces text limits at the exact boundary", async () => {
  const malformed = await parseAuthorizedMaterial({ ...base, mediaType: "application/pdf", fileName: "broken.pdf", bytes: bytes("%PDF-broken"), idempotencyKey: "material-broken" }, dependencies());
  if (malformed.ok || malformed.error.kind !== "MaterialPdfInvalid") throw new Error("Expected malformed PDF failure.");
  const exact = await parseAuthorizedMaterial({ ...base, mediaType: "application/pdf", fileName: "exact.pdf", bytes: pdf(["0123456789"]), idempotencyKey: "material-exact" }, { ...dependencies(), maximumCharacters: 10 });
  if (!exact.ok) throw new Error(exact.error.kind);
  const exceeded = await parseAuthorizedMaterial({ ...base, mediaType: "application/pdf", fileName: "exceeded.pdf", bytes: pdf(["01234567890"]), idempotencyKey: "material-exceeded" }, { ...dependencies(), maximumCharacters: 10 });
  if (exceeded.ok || exceeded.error.kind !== "MaterialTextLimitExceeded") throw new Error("Expected PDF text limit failure.");
});

Deno.test("mixed text and blank PDF pages and PPT slides preserve physical batching positions", async () => {
  const extracted = await parseAuthorizedMaterial({ ...base, mediaType: "application/pdf", fileName: "mixed.pdf", bytes: pdf(["A concept", "", "Another concept"]) }, dependencies());
  if (!extracted.ok || extracted.value.sections.length !== 3 || extracted.value.sections[1].locator !== "page:2" || extracted.value.sections[1].text !== "") throw new Error("Blank PDF page lost its batch position.");
  const slides = storedZip([{ name: "ppt/slides/slide1.xml", data: bytes("<a:t>A concept</a:t>") }, { name: "ppt/slides/slide2.xml", data: bytes("<p:sld/>") }]);
  const ppt = await parseAuthorizedMaterial({ ...base, mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", fileName: "mixed.pptx", bytes: slides }, dependencies());
  if (!ppt.ok || ppt.value.sections.length !== 2 || ppt.value.sections[1].locator !== "slide:2" || ppt.value.sections[1].text !== "") throw new Error("Blank slide lost its batch position.");
});

Deno.test("PPTX accepts highly compressed text while bounding declared and actual expansion", async () => {
  const expanded = bytes(`<p:sld><a:t>${"A supported claim. ".repeat(500)}</a:t></p:sld>`);
  const compressed = new Uint8Array(await new Response(new Blob([expanded]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const entry = { name: "ppt/slides/slide1.xml", data: compressed, method: 8, expandedSize: expanded.byteLength };
  const archive = storedZip([entry]);
  if (archive.byteLength * 2 >= expanded.byteLength) throw new Error("Fixture must exceed the old compression-ratio ceiling.");
  const command = { ...base, mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", fileName: "compressed.pptx", bytes: archive };
  const accepted = await parseAuthorizedMaterial(command, dependencies());
  if (!accepted.ok || accepted.value.sections.length !== 1) throw new Error("Legitimate compressed slide was rejected.");
  const capped = await parseAuthorizedMaterial(command, { ...dependencies(), maximumBytes: archive.byteLength });
  if (capped.ok || capped.error.kind !== "MaterialArchiveTooLarge") throw new Error("Expected absolute expanded-size bound.");
  const lying = await parseAuthorizedMaterial({ ...command, bytes: storedZip([{ ...entry, expandedSize: 32 }]) }, dependencies());
  if (lying.ok || lying.error.kind !== "MaterialArchiveTooLarge") throw new Error("Expected streaming expansion bound.");
  const truncated = await parseAuthorizedMaterial({ ...command, bytes: archive.slice(0, -10) }, dependencies());
  if (truncated.ok || truncated.error.kind !== "MaterialPptxInvalid") throw new Error("Expected typed truncated ZIP failure.");
});

Deno.test("PPTX extraction returns slide text and embedded media metadata", async () => {
  const presentation = storedZip([
    { name: "ppt/slides/slide1.xml", data: bytes("<p:sld><a:t>First</a:t><a:t> slide</a:t></p:sld>") },
    { name: "ppt/media/image1.png", data: new Uint8Array([137, 80, 78, 71]) },
  ]);
  const result = await parseAuthorizedMaterial({ ...base, mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", fileName: "lesson.pptx", bytes: presentation }, dependencies());
  if (!result.ok) throw new Error(result.error.kind);
  if (result.value.sections[0]?.locator !== "slide:1" || result.value.sections[0]?.text !== "First slide") throw new Error("Expected slide text.");
  if (result.value.media.length !== 1 || result.value.media[0]?.path !== "ppt/media/image1.png") throw new Error("Expected embedded media metadata.");
});

Deno.test("material parsing fails closed for missing processing consent, oversized text, and the exact 25MiB byte boundary", async () => {
  const noConsent = await parseAuthorizedMaterial({ ...base, rightsAttestation: { ...base.rightsAttestation, processingAllowed: false }, mediaType: "text/plain", fileName: "notes.txt", bytes: bytes("notes") }, dependencies());
  if (noConsent.ok || noConsent.error.kind !== "MaterialRightsAttestationMissing") throw new Error("Expected consent failure.");
  const oversized = await parseAuthorizedMaterial({ ...base, idempotencyKey: "material-large", mediaType: "text/plain", fileName: "notes.txt", bytes: bytes("notes") }, { ...dependencies(), maximumCharacters: 2 });
  if (oversized.ok || oversized.error.kind !== "MaterialTextLimitExceeded") throw new Error("Expected text limit failure.");
  const maximumBytes = 25 * 1024 * 1024;
  const exactlyAtLimit = padPdf(pdf(["byte boundary"]), maximumBytes);
  const accepted = await parseAuthorizedMaterial({ ...base, idempotencyKey: "material-byte-exact", mediaType: "application/pdf", fileName: "boundary.pdf", bytes: exactlyAtLimit }, { ...dependencies(), maximumBytes });
  if (!accepted.ok) throw new Error(accepted.error.kind);
  const rejected = await parseAuthorizedMaterial({ ...base, idempotencyKey: "material-byte-over", mediaType: "application/pdf", fileName: "over-boundary.pdf", bytes: new Uint8Array(maximumBytes + 1) }, { ...dependencies(), maximumBytes });
  if (rejected.ok || rejected.error.kind !== "MaterialByteLimitExceeded" || rejected.error.maximum !== maximumBytes) throw new Error("Expected exact byte limit rejection.");
});
