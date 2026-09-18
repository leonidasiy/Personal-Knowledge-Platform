// @ts-check

import {
  countProcessingWorkflowStatuses,
  SourceLibraryGatewayClient,
} from "../features/source-library/gateway.js";
import { LearningBatchGatewayClient } from "../features/learning-generation/batches-gateway.js";
import { renderLibraryRoute } from "../routes/library.js";
import { BUNDLE_TYPE, packImageBundle } from "../features/knowledge-workflows/image-upload.js";
import { renderPdfPageImages } from "./pdf-image-pages.js";

/** @import { LibrarySource, SourceInterestArea, SourceSearchScope } from "../features/source-library/contracts.js" */
/** @import { WorkflowSourceStatus } from "../features/source-library/gateway.js" */

const freeze = Object.freeze;
const WORKFLOW_STATUS_REFRESH_MS = 5_000;

/** @typedef {{ readonly observe: (element: Element) => void, readonly disconnect: () => void }} PageObserver */
/** @typedef {{ readonly batchId: string, readonly learningDay: string, readonly status: "open" | "completed", readonly itemIds: readonly string[], readonly revision: number, readonly createdAt: string, readonly completedAt: string | null }} LibraryBatchModel */
/** @typedef {{ readonly knowledgeId: string, readonly sourceId: string, readonly summary: string, readonly questionLocked: boolean }} LibraryKnowledgeCard */
/** @typedef {{ readonly knowledgeId: string, readonly sourceId: string, readonly sourceTitle: string, readonly summary: string, readonly sourceUrl: string, readonly evidenceAnchorIds: readonly string[], readonly questionLocked: boolean, readonly score: number, readonly matchedBy: "exact" | "semantic" | "combined" }} LibraryKnowledgeSearchCard */

/**
 * @param {{
 *   readonly fetch: typeof fetch,
 *   readonly gatewayBaseUrl: string,
 *   readonly escapeHtml: (value: string) => string,
 *   readonly formatDate: (value: string) => string,
 *   readonly createId: () => string,
 *   readonly confirmDisable: (source: LibrarySource) => boolean,
 *   readonly createObserver: (load: () => void) => PageObserver | null,
 *   readonly schedule: (callback: () => void, delayMs: number) => number,
 *   readonly cancel: (handle: number) => void,
 *   readonly onNotice: (message: string) => void,
 *   readonly onError: (message: string) => void,
 *   readonly rerender: () => void
 * }} dependencies
 */
export function createLibraryPage(dependencies) {
  if (
    typeof dependencies.fetch !== "function" ||
    !URL.canParse(dependencies.gatewayBaseUrl) ||
    typeof dependencies.escapeHtml !== "function" ||
    typeof dependencies.formatDate !== "function" ||
    typeof dependencies.createId !== "function" ||
    typeof dependencies.confirmDisable !== "function" ||
    typeof dependencies.createObserver !== "function" ||
    typeof dependencies.schedule !== "function" ||
    typeof dependencies.cancel !== "function" ||
    typeof dependencies.onNotice !== "function" ||
    typeof dependencies.onError !== "function" ||
    typeof dependencies.rerender !== "function"
  ) {
    throw new TypeError("Library page dependencies are invalid.");
  }
  const {
    cancel,
    confirmDisable,
    createId,
    createObserver,
    escapeHtml,
    formatDate,
    onError,
    onNotice,
    rerender,
    schedule,
  } = dependencies;
  const gateway = new SourceLibraryGatewayClient({
    fetch: dependencies.fetch,
    baseUrl: dependencies.gatewayBaseUrl,
    timeoutMs: 15_000,
  });
  const learningGateway = new LearningBatchGatewayClient({
    fetch: dependencies.fetch,
    baseUrl: dependencies.gatewayBaseUrl,
    timeoutMs: 15_000,
  });
  /** @type {"loading" | "success" | "empty" | "error" | "offline"} */ let state =
    "loading";
  /** @type {LibrarySource[]} */ let items = [];
  /** @type {SourceInterestArea[]} */ let interestAreas = [];
  /** @type {string | null} */ let nextCursor = null;
  /** @type {string} */ let query = "";
  /** @type {SourceSearchScope} */ let searchScope = "sources";
  /** @type {string | null} */ let message = null;
  /** @type {string | null} */ let pendingSourceId = null;
  /** @type {LibraryKnowledgeCard[]} */ let knowledge = [];
  /** @type {LibraryKnowledgeSearchCard[]} */ let knowledgeSearchResults = [];
  /** @type {WorkflowSourceStatus[]} */ let workflowStatuses = [];
  /** @type {string | null} */ let pendingKnowledgeId = null;
  /** @type {Promise<void> | null} */ let read = null;
  /** @type {Promise<void> | null} */ let knowledgeRead = null;
  /** @type {Promise<void> | null} */ let workflowStatusRead = null;
  /** @type {number} */ let workflowStatusReadGeneration = -1;
  /** @type {number | null} */ let workflowStatusRefreshHandle = null;
  /** @type {number} */ let workflowStatusGeneration = 0;
  /** @type {PageObserver | null} */ let observer = null;

  const collection = () =>
    freeze({
      state,
      items: freeze([...items]),
      interestAreas: freeze([...interestAreas]),
      nextCursor,
      query,
      searchScope,
      pendingSourceId,
      message,
      knowledge: freeze(knowledge.map((card) => ({
        knowledgeId: card.knowledgeId,
        sourceId: card.sourceId,
        summary: card.summary,
        questionLocked: card.questionLocked,
      }))),
    });

  async function load(reset = true) {
    if (read !== null) return await read;
    stopWorkflowStatusPolling();
    read = (async () => {
      if (reset) {
        state = "loading";
        items = [];
        nextCursor = null;
        searchScope = "sources";
        knowledgeSearchResults = [];
        message = null;
        workflowStatuses = [];
        rerender();
      } else state = "loading";
      const result = await gateway.browse({
        limit: 20,
        cursor: reset ? null : nextCursor,
      });
      if (!result.ok) {
        setFailure(result.error, !reset && items.length > 0);
        return;
      }
      items = reset
        ? [...result.value.items]
        : merge(items, result.value.items);
      interestAreas = [...result.value.interestAreas];
      nextCursor = result.value.nextCursor;
      state = items.length === 0 ? "empty" : "success";
      message = null;
      rerender();
      await Promise.all([loadKnowledge(), loadWorkflowStatuses()]);
    })().finally(() => {
      read = null;
      rerender();
    });
    return await read;
  }

  /** @param {HTMLFormElement | FormData} form */
  async function search(form) {
    if (read !== null) return;
    const data = form instanceof FormData ? form : new FormData(form);
    const rawQuery = data.get("query");
    if (
      typeof rawQuery !== "string"
    ) return;
    const priorQuery = query;
    const priorSearchScope = searchScope;
    const priorItems = items;
    const priorKnowledgeSearchResults = knowledgeSearchResults;
    stopWorkflowStatusPolling();
    query = rawQuery.trim();
    const rawScope = data.get("searchScope");
    searchScope = rawScope === "knowledge" ? "knowledge" : "sources";
    if (query === "") return await load(true);
    state = "loading";
    message = null;
    rerender();
    read = (async () => {
      const externalProcessingAllowed =
        data.get("externalProcessingAllowed") === "on";
      const result = await gateway.search({
        query,
        scope: searchScope,
        limit: 50,
        mode: externalProcessingAllowed ? "combined" : "keyword",
        externalProcessingAllowed,
      });
      if (!result.ok) {
        query = priorQuery;
        searchScope = priorSearchScope;
        items = priorItems;
        knowledgeSearchResults = priorKnowledgeSearchResults;
        return setFailure(result.error, items.length > 0);
      }
      if (searchScope === "knowledge") {
        knowledgeSearchResults = result.value.map((hit) => {
          if (!("knowledge" in hit)) {
            throw new TypeError("Knowledge search response is invalid.");
          }
          return {
            ...hit.knowledge,
            score: hit.score,
            matchedBy: hit.matchedBy,
          };
        });
        items = [];
      } else {
        knowledgeSearchResults = [];
        items = result.value.map((hit) => {
          if (!("source" in hit)) {
            throw new TypeError("Source search response is invalid.");
          }
          return hit.source;
        });
      }
      nextCursor = null;
      state = searchScope === "knowledge"
        ? knowledgeSearchResults.length === 0 ? "empty" : "success"
        : items.length === 0
        ? "empty"
        : "success";
      if (searchScope === "sources") await loadWorkflowStatuses();
    })().finally(() => {
      read = null;
      rerender();
    });
    await read;
  }

  async function loadKnowledge() {
    if (knowledgeRead !== null) return await knowledgeRead;
    knowledgeRead = (async () => {
      const result = await learningGateway.listKnowledge();
      if (!result.ok) {
        onError(friendlyLearning(result.error));
        return;
      }
      knowledge = result.value.items.map((card) => ({
        knowledgeId: card.knowledgeId,
        sourceId: card.sourceId,
        summary: card.summary,
        questionLocked: card.questionLocked,
      }));
    })().finally(() => {
      knowledgeRead = null;
      rerender();
    });
    return await knowledgeRead;
  }

  async function loadWorkflowStatuses() {
    const generation = workflowStatusGeneration;
    if (
      workflowStatusRead !== null &&
      workflowStatusReadGeneration === generation
    ) return await workflowStatusRead;
    const currentRead = (async () => {
      const results = await Promise.all(
        items.map((source) => gateway.workflowStatus(source.id)),
      );
      if (generation !== workflowStatusGeneration) return;
      const sourceIds = new Set(items.map((source) => source.id));
      const known = new Map(
        workflowStatuses
          .filter((status) => sourceIds.has(status.sourceId))
          .map((status) => [status.sourceId, status]),
      );
      let failed = false;
      for (const result of results) {
        if (result.ok) known.set(result.value.sourceId, result.value);
        else failed = true;
      }
      workflowStatuses = items.flatMap((source) => {
        const status = known.get(source.id);
        return status === undefined ? [] : [status];
      });
      if (failed) {
        onError(
          "One or more source processing statuses could not be loaded. Refresh the Library to try again.",
        );
      }
      if (generation !== workflowStatusGeneration) return;
      if (countProcessingWorkflowStatuses(workflowStatuses) > 0) {
        scheduleWorkflowStatusRefresh(generation);
      } else {
        cancelWorkflowStatusRefresh();
      }
      rerender();
    })();
    workflowStatusRead = currentRead;
    workflowStatusReadGeneration = generation;
    try {
      await currentRead;
    } finally {
      if (workflowStatusRead === currentRead) {
        workflowStatusRead = null;
        workflowStatusReadGeneration = -1;
      }
    }
  }

  function cancelWorkflowStatusRefresh() {
    if (workflowStatusRefreshHandle === null) return;
    cancel(workflowStatusRefreshHandle);
    workflowStatusRefreshHandle = null;
  }

  /** @param {number} generation */
  function scheduleWorkflowStatusRefresh(generation) {
    if (
      generation !== workflowStatusGeneration ||
      workflowStatusRefreshHandle !== null ||
      countProcessingWorkflowStatuses(workflowStatuses) === 0
    ) return;
    workflowStatusRefreshHandle = schedule(() => {
      workflowStatusRefreshHandle = null;
      if (generation !== workflowStatusGeneration) return;
      void loadWorkflowStatuses();
    }, WORKFLOW_STATUS_REFRESH_MS);
  }

  function stopWorkflowStatusPolling() {
    cancelWorkflowStatusRefresh();
    workflowStatusGeneration += 1;
  }

  /** @param {HTMLButtonElement} button */
  async function disable(button) {
    const sourceId = button.getAttribute("data-library-disable");
    const revision = Number(button.getAttribute("data-source-revision"));
    const source = items.find((candidate) => candidate.id === sourceId);
    if (
      source === undefined || !Number.isInteger(revision) ||
      pendingSourceId !== null || !confirmDisable(source)
    ) return;
    pendingSourceId = source.id;
    stopWorkflowStatusPolling();
    rerender();
    const result = await gateway.disable({
      sourceId: source.id,
      expectedRevision: revision,
      idempotencyKey: `disable:${createId()}`,
    });
    pendingSourceId = null;
    if (!result.ok) {
      onError(friendly(result.error));
    } else {
      items = items.filter((candidate) => candidate.id !== source.id);
      knowledge = knowledge.filter((card) => card.sourceId !== source.id);
      knowledgeSearchResults = knowledgeSearchResults.filter((card) =>
        card.sourceId !== source.id
      );
      workflowStatuses = workflowStatuses.filter((status) =>
        status.sourceId !== source.id
      );
      state = items.length === 0 ? "empty" : "success";
      onNotice(
        "Source, knowledge, paired questions, media, and schedules removed. Activity history is preserved.",
      );
    }
    rerender();
  }

  /** @param {HTMLButtonElement} button */
  async function removeKnowledge(button) {
    const knowledgeId = button.getAttribute("data-library-knowledge-remove");
    if (
      knowledgeId === null || knowledgeId.trim() === "" ||
      pendingKnowledgeId !== null
    ) return;
    pendingKnowledgeId = knowledgeId;
    rerender();
    const result = await learningGateway.removeKnowledge(
      knowledgeId,
      `knowledge-remove:${createId()}`,
    );
    pendingKnowledgeId = null;
    if (!result.ok) {
      onError(friendlyLearning(result.error));
    } else {
      knowledge = knowledge.filter((candidate) =>
        candidate.knowledgeId !== knowledgeId
      );
      knowledgeSearchResults = knowledgeSearchResults.filter((candidate) =>
        candidate.knowledgeId !== knowledgeId
      );
      onNotice(
        "Knowledge, its paired question, media, and schedule were removed.",
      );
    }
    rerender();
  }

  /** @param {HTMLButtonElement} button */
  async function retryWorkflow(button) {
    const runId = button.getAttribute("data-library-workflow-retry");
    const expectedRevision = Number(
      button.getAttribute("data-library-workflow-retry-revision"),
    );
    if (
      runId === null || runId.trim() === "" ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    ) return;
    const status = workflowStatuses.find((candidate) =>
      candidate.run?.runId === runId
    );
    if (status?.run?.state !== "retryable-failure") return;
    stopWorkflowStatusPolling();
    const result = await gateway.retryWorkflow({
      runId,
      expectedRevision,
      idempotencyKey: `workflow-retry:${createId()}`,
    });
    if (!result.ok) {
      onError(friendly(result.error));
      rerender();
      return;
    }
    onNotice(
      "Retry started. The Library will refresh its processing status automatically.",
    );
    rerender();
    await loadWorkflowStatuses();
  }

  let uploadMessage = "";
  /** @param {string} message */
  function uploadFailure(message) {
    uploadMessage = message;
    onError(message);
  }

  /** @param {string} sourceId Empty creates a private document. @param {FormData} form */
  async function uploadMaterial(sourceId, form) {
    if (pendingSourceId !== null) return;
    uploadMessage = "";
    let source = items.find((candidate) => candidate.id === sourceId);
    const run = workflowStatuses.find((status) => status.sourceId === sourceId)
      ?.run;
    if (
      !(form instanceof FormData) ||
      (sourceId !== "" &&
        (source === undefined || run?.state !== "awaiting-upload")) ||
      form.get("attested") !== "on"
    ) {
      uploadFailure(
        "Select an awaiting source or a new private document and confirm processing permission.",
      );
      return;
    }
    const files = /** @type {File[]} */ (form.getAll("file").filter((item) => item instanceof File && item.size > 0));
    const file = files[0] ?? null;
    const mode = form.get("imageProcessing") === "on" ? "image" : "text";
    if (files.length > 100 || files.reduce((total, item) => total + item.size, 0) > 104_857_600) return uploadFailure("The upload exceeds the 100 MiB limit.");
    const pasted = form.get("content");
    const content = typeof pasted === "string" ? pasted.trim() : "";
    if (content.length > 1_000_000) return uploadFailure("Pasted text exceeds the one-million-character limit.");
    if ((file === null) === (content === "")) {
      uploadFailure("Provide either pasted text or one document.");
      return;
    }
    if (files.length > 1 && mode !== "image") return uploadFailure("Turn on image processing to upload several images together.");
    const extension = file?.name.split(".").at(-1)?.toLowerCase();
    // Closed upload-format contract; content interpretation belongs to the model.
    const mediaType = file === null || extension === "txt"
      ? "text/plain"
      : extension === "md"
      ? "text/markdown"
      : extension === "pdf"
      ? "application/pdf"
      : extension === "pptx"
      ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : extension === "png"
      ? "image/png"
      : extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : extension === "webp"
      ? "image/webp"
      : extension === "gif"
      ? "image/gif"
      : null;
    if (mediaType === null) {
      uploadFailure("Choose a text, Markdown, PDF, PowerPoint, or raster image file.");
      return;
    }
    if (mode === "image" && (file === null || mediaType !== "application/pdf" && !mediaType.startsWith("image/") || files.length > 1 && files.some((item) => !/\.(?:png|jpe?g|webp|gif)$/iu.test(item.name)))) return uploadFailure("Image processing requires a PDF or raster images.");
    if (mode === "image" && files.some((item) => item.size > 20 * 1024 * 1024 && mediaType !== "application/pdf")) return uploadFailure("Each image must be 20 MiB or less.");
    if (mode === "text" && mediaType.startsWith("image/")) return uploadFailure("Select image mode for raster image files.");
    const titleValue = form.get("title");
    const title = typeof titleValue === "string" && titleValue.trim() !== ""
      ? titleValue.trim()
      : file?.name;
    if (sourceId === "" && !title) {
      return uploadFailure("Give pasted material a title.");
    }
    const fileName = file?.name ?? "paste.txt";
    const pageRange = form.get("pageRange") ?? "";
    if (typeof pageRange !== "string" || pageRange.length > 300 || pageRange.trim() !== "" && (mode !== "image" || mediaType !== "application/pdf")) return uploadFailure("Page ranges apply only to PDF image processing.");
    pendingSourceId = sourceId;
    stopWorkflowStatusPolling();
    try {
      let id;
      let uploadFile = file;
      let uploadMediaType = mediaType;
      if (mode === "image" && file !== null && mediaType === "application/pdf") {
        const rendered = await renderPdfPageImages(file, pageRange);
        if (!rendered.ok) return uploadFailure(`PDF image processing failed: ${rendered.error.kind}.`);
        uploadFile = new File([rendered.value], `${file.name}.pkpi`, { type: BUNDLE_TYPE });
        uploadMediaType = BUNDLE_TYPE;
      } else if (mode === "image" && files.length > 1) {
        const types = /** @type {Record<string, string>} */ ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" });
        let pages;
        try { pages = await Promise.all(files.map(async (item, index) => ({ name: item.name, locator: `image:${index + 1}`, mediaType: item.type || types[item.name.split(".").at(-1)?.toLowerCase() ?? ""] || "", bytes: new Uint8Array(await item.arrayBuffer()) }))); }
        catch (error) { return uploadFailure("ImageBatchReadFailed: the selected images could not be read."); }
        const packed = packImageBundle(pages);
        if (!packed.ok) return uploadFailure(`Image batch failed: ${packed.error.kind}.`);
        uploadFile = new File([packed.value], `${file.name}.pkpi`, { type: BUNDLE_TYPE });
        uploadMediaType = BUNDLE_TYPE;
      }
      try {
        const bytes = uploadFile === null
          ? new TextEncoder().encode(content)
          : await uploadFile.arrayBuffer();
        const contentHash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        id = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(
                JSON.stringify([sourceId, title, fileName, mode, pageRange, contentHash]),
              ),
            ),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
      } catch (error) {
        return uploadFailure(
          "Upload fingerprinting failed. The document has not been sent.",
        );
      }
      const rightsAttestation = {
        ownsOrPermitted: true,
        storageAllowed: true,
        transformationAllowed: true,
        processingAllowed: true,
        basis: "learner-attested lawful copy",
        reference: `learner-attestation:${id}`,
      };
      let runId = run?.runId;
      if (sourceId === "") {
        const created = await gateway.createPrivateDocument({
          title,
          fileName,
          rightsAttestation,
          idempotencyKey: `private-document:${id}`,
        });
        if (!created.ok) return uploadFailure(friendly(created.error));
        source = created.value.source;
        runId = created.value.runId;
        if (!items.some((item) => item.id === source?.id)) items.push(source);
      }
      if (source === undefined || runId === undefined) {
        return uploadFailure(
          "The document's source/run binding is unavailable.",
        );
      }
      const uploaded = await gateway.uploadWorkflowMaterial({
        runId,
        sourceId: source.id,
        sourceRevision: source.revision,
        sourceUrl: source.canonicalUrl,
        mode,
        mediaType: uploadMediaType,
        fileName: uploadFile?.name ?? fileName,
        rightsAttestation,
        idempotencyKey: `workflow-material:${runId}:${id}`,
        ...(uploadFile === null ? { content } : { file: uploadFile }),
      });
      if (!uploaded.ok) {
        uploadFailure(friendly(uploaded.error));
        return;
      }
      uploadMessage =
        "Content uploaded. Knowledge and question processing will continue.";
      onNotice(uploadMessage);
      pendingSourceId = null;
      await loadWorkflowStatuses();
    } finally {
      pendingSourceId = null;
    }
  }

  /** @param {HTMLElement} root */
  function bind(root) {
    observer?.disconnect();
    observer = null;
    root.querySelector("[data-library-search]")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        if (event.currentTarget instanceof HTMLFormElement) {
          void search(
            event.currentTarget,
          );
        }
      },
    );
    root.querySelector("[data-library-retry]")?.addEventListener(
      "click",
      () => void load(true),
    );
    root.querySelector("[data-library-load-more]")?.addEventListener(
      "click",
      () => void load(false),
    );
    root.querySelectorAll("[data-library-disable]").forEach((element) =>
      element.addEventListener("click", () => {
        if (typeof element.getAttribute === "function") {
          void disable(/** @type {HTMLButtonElement} */ (element));
        }
      })
    );
    root.querySelectorAll("[data-library-knowledge-remove]").forEach((
      element,
    ) =>
      element.addEventListener("click", () => {
        if (typeof element.getAttribute === "function") {
          void removeKnowledge(/** @type {HTMLButtonElement} */ (element));
        }
      })
    );
    root.querySelectorAll("[data-library-workflow-retry]").forEach((element) =>
      element.addEventListener("click", () => {
        if (typeof element.getAttribute === "function") {
          void retryWorkflow(/** @type {HTMLButtonElement} */ (element));
        }
      })
    );
    root.querySelectorAll("[data-library-upload]").forEach((element) =>
      element.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!(form instanceof HTMLFormElement)) return;
        const button = form.querySelector("button[type='submit']");
        if (button instanceof HTMLButtonElement) button.disabled = true;
        try {
          await uploadMaterial(
            form.dataset.libraryUpload ?? "",
            new FormData(form),
          );
        } finally {
          if (button instanceof HTMLButtonElement) button.disabled = false;
          const feedback = form.querySelector("[data-library-upload-message]");
          if (feedback !== null) feedback.textContent = uploadMessage;
        }
      })
    );
    const sentinel = root.querySelector("[data-library-sentinel]");
    if (sentinel !== null && nextCursor !== null && read === null) {
      observer = createObserver(() => void load(false));
      observer?.observe(sentinel);
    }
  }

  /** @param {LibraryBatchModel | Record<string, unknown>} _queue */
  function render(_queue) {
    return renderLibraryRoute({
      collection: collection(),
      knowledge,
      knowledgeSearchResults,
      workflowStatuses,
      escapeHtml,
      formatDate,
    });
  }

  /** @param {import("../features/source-library/gateway.js").SourceGatewayFailure} failure */
  function setFailure(failure, preserveItems = false) {
    if (preserveItems) {
      state = "success";
      nextCursor = null;
      message = `${friendly(failure)} Previously loaded sources remain below.`;
      return;
    }
    state = failure.kind === "SourceGatewayUnavailable" ||
        failure.kind === "SourceGatewayTimedOut"
      ? "offline"
      : "error";
    message = friendly(failure);
  }

  return freeze({ load, search, uploadMaterial, bind, render });
}

/** @param {import("../features/source-library/gateway.js").SourceGatewayFailure} failure */
function friendly(failure) {
  if (failure.kind === "SourceGatewayUnauthenticated") {
    return "Sign in through the private source service, then try again.";
  }
  if (failure.kind === "SourceGatewayUnauthorized") {
    return "This account cannot access the private source catalog.";
  }
  if (
    failure.kind === "SourceGatewayUnavailable" ||
    failure.kind === "SourceGatewayTimedOut"
  ) {
    return "Reconnect to the source service and try again. No local change was saved.";
  }
  if (
    failure.kind === "SourceGatewayRejected" &&
    (failure.failureKind === "SourceEmbeddingUnavailable" ||
      failure.failureKind === "SourceSemanticIndexUnavailable")
  ) {
    return "Combined search is temporarily unavailable. Try again after the source catalog reconnects.";
  }
  if (
    failure.kind === "SourceGatewayRejected" &&
    failure.failureKind === "SourceRevisionStale"
  ) {
    return "This source changed elsewhere. Reload the Library before removing it.";
  }
  return "The source catalog could not complete this request.";
}

/** @param {import("../features/learning-generation/batches-gateway.js").LearningBatchGatewayFailure} failure */
function friendlyLearning(failure) {
  if (
    failure.kind === "LearningBatchGatewayUnavailable" ||
    failure.kind === "LearningBatchGatewayTimedOut"
  ) return "Reconnect to load the Library knowledge cards.";
  if (
    failure.kind === "LearningBatchGatewayUnauthenticated" ||
    failure.kind === "LearningBatchGatewayUnauthorized"
  ) {
    return "Sign in through the private source service to view Library knowledge.";
  }
  if (
    failure.kind === "LearningBatchGatewayRejected" &&
    failure.failureKind === "KnowledgePurgeFailed"
  ) return "Knowledge could not be removed. Refresh the Library and try again.";
  return "Library knowledge could not be loaded or removed. The source remains in your Library.";
}

/** @param {readonly LibrarySource[]} current @param {readonly LibrarySource[]} next */
function merge(current, next) {
  const merged = new Map(current.map((source) => [source.id, source]));
  for (const source of next) merged.set(source.id, source);
  return [...merged.values()];
}

export {};
