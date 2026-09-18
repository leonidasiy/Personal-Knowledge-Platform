// @ts-check

import { packImageBundle, parsePdfPageRange } from "../features/knowledge-workflows/image-upload.js";

/** @typedef {{ readonly ok: true, readonly value: Uint8Array } | { readonly ok: false, readonly error: { readonly kind: string } }} RenderResult */

/** @param {File} file @param {string} pageRange @param {AbortSignal} [signal] @returns {Promise<RenderResult>} */
export async function renderPdfPageImages(file, pageRange, signal) {
  if (!(file instanceof File) || file.type !== "application/pdf" && (file.type !== "" || !/\.pdf$/iu.test(file.name)) || typeof pageRange !== "string" || (signal !== undefined && !(signal instanceof AbortSignal))) return { ok: false, error: { kind: "PdfRenderCommandInvalid" } };
  if (signal?.aborted) return { ok: false, error: { kind: "PdfRenderCancelled" } };
  let loadingTask;
  try {
    // This self-hosted asset is loaded only after the learner enables image processing.
    const path = "/pdfjs.mjs";
    const pdfjs = await import(path);
    pdfjs.GlobalWorkerOptions.workerSrc = path;
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useWorkerFetch: false, isEvalSupported: false, maxImageSize: 16_777_216 });
    const pdfDocument = await loadingTask.promise;
    const selected = parsePdfPageRange(pageRange, pdfDocument.numPages);
    if (!selected.ok) return selected;
    const pages = [];
    for (const pageNumber of selected.value) {
      if (signal?.aborted) return { ok: false, error: { kind: "PdfRenderCancelled" } };
      const page = await pdfDocument.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(1.5, Math.sqrt(16_777_216 / (natural.width * natural.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (context === null) return { ok: false, error: { kind: "PdfRenderUnavailable" } };
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      canvas.width = 0;
      canvas.height = 0;
      if (!(blob instanceof Blob) || blob.size < 1 || blob.size > 20 * 1024 * 1024) return { ok: false, error: { kind: "PdfRenderImageInvalid" } };
      pages.push({ name: `Page ${pageNumber}`, locator: `page:${pageNumber}`, mediaType: "image/png", bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    const bundle = packImageBundle(pages);
    return bundle.ok ? { ok: true, value: bundle.value } : { ok: false, error: { kind: bundle.error.kind } };
  } catch (error) {
    return { ok: false, error: { kind: error instanceof Error && error.name === "PasswordException" ? "PdfRenderEncrypted" : "PdfRenderFailed" } };
  } finally {
    if (loadingTask !== undefined) {
      try { await loadingTask.destroy(); } catch { return { ok: false, error: { kind: "PdfRenderCleanupFailed" } }; }
    }
  }
}
