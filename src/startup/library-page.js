// @ts-check

import {
  countProcessingWorkflowStatuses,
  SourceLibraryGatewayClient,
} from "../features/source-library/gateway.js";
import { LearningBatchGatewayClient } from "../features/learning-generation/batches-gateway.js";
import { renderLibraryRoute, renderProcessingStatus, librarySourceSubjects } from "../routes/library.js";
import { isSubjectId } from "../features/knowledge-subjects/public.js";
import { BUNDLE_TYPE, packImageBundle } from "../features/knowledge-workflows/image-upload.js";
import { renderPdfPageImages } from "./pdf-image-pages.js";

/** @import { LibrarySource, SourceInterestArea, SourceSearchScope } from "../features/source-library/contracts.js" */
/** @import { WorkflowSourceStatus } from "../features/source-library/gateway.js" */

const freeze = Object.freeze;
const WORKFLOW_STATUS_REFRESH_MS = 60_000;

/** @typedef {{ readonly observe: (element: Element) => void, readonly disconnect: () => void }} PageObserver */
/** @typedef {{ readonly batchId: string, readonly learningDay: string, readonly status: "open" | "completed", readonly itemIds: readonly string[], readonly revision: number, readonly createdAt: string, readonly completedAt: string | null }} LibraryBatchModel */
/** @typedef {{ readonly knowledgeId: string, readonly sourceId: string, readonly summary: string, readonly questionLocked: boolean, readonly primarySubject: string|null, readonly sourceTopic: string|null }} LibraryKnowledgeCard */
/** @typedef {{ readonly knowledgeId: string, readonly sourceId: string, readonly sourceTitle: string, readonly summary: string, readonly sourceUrl: string, readonly evidenceAnchorIds: readonly string[], readonly questionLocked: boolean, readonly score: number, readonly matchedBy: "exact" | "semantic" | "combined" }} LibraryKnowledgeSearchCard */

/**
 * @param {{
 *   readonly fetch: typeof fetch,
 *   readonly storage?: Pick<Storage, "getItem"|"setItem">,
 *   readonly gatewayBaseUrl: string,
 *   readonly escapeHtml: (value: string) => string,
 *   readonly formatDate: (value: string) => string,
 *   readonly createId: () => string,
 *   readonly confirmDisable: (source: LibrarySource) => boolean,
 *   readonly confirmCancel?: (source: LibrarySource) => boolean,
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
  /** @type {string|null} */ let subject = null;
  try {
    const stored = dependencies.storage?.getItem("resonance-library-subject");
    if (stored === "unclassified" || isSubjectId(stored)) subject = stored;
    else if (stored !== null && stored !== undefined) onError(libraryCopy(0));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    onError(libraryCopy(1));
  }
  /** @type {SourceSearchScope} */ let searchScope = "knowledge";
  /** @type {string | null} */ let message = null;
  /** @type {string | null} */ let pendingSourceId = null;
  /** @type {LibraryKnowledgeCard[]} */ let knowledge = [];
  /** @type {LibraryKnowledgeSearchCard[]} */ let knowledgeSearchResults = [];
  /** @type {WorkflowSourceStatus[]} */ let workflowStatuses = [];
  /** @type {Set<string>} */const cancelledKnowledgeIds=new Set();
  /** @type {Map<string,Parameters<SourceLibraryGatewayClient["cancelWorkflow"]>[0]>} */ const cancellationRetries=new Map();
  const trackedSourceIds = new Set();
  let uploading = false;
  let statusDiscoveryPending = false;
  let statusUnavailable = false;
  let statusRetryAllowed = true;
  /** @type {string|null} */ let statusDiscoveryCursor = null;
  /** @type {string | null} */ let pendingKnowledgeId = null;
  /** @type {Promise<void> | null} */ let read = null;
  /** @type {Promise<void> | null} */ let knowledgeRead = null;
  /** @type {Promise<void> | null} */ let workflowStatusRead = null;
  /** @type {number} */ let workflowStatusReadGeneration = -1;
  /** @type {number | null} */ let workflowStatusRefreshHandle = null;
  /** @type {number} */ let workflowStatusGeneration = 0;
  /** @type {PageObserver | null} */ let observer = null;
  let disposed=false;
  /** @type {string|null} */let pendingFocusSourceId=null;
  /** @type {number|null} */let focusHandle=null;

  const collection = () =>
    freeze({
      state,
      items: freeze([...items]),
      interestAreas: freeze([...interestAreas]),
      nextCursor,
      query,
      subject,
      searchScope,
      pendingSourceId,
      message,
      knowledge: freeze([...knowledge]),
    });

  async function load(reset = true) {
    if(disposed)return;
    if (read !== null) return await read;
    stopWorkflowStatusPolling();
    read = (async () => {
      if (reset) {
        state = "loading";
        items = [];
        knowledge = [];
        nextCursor = null;
        searchScope = "knowledge";
        knowledgeSearchResults = [];
        message = null;
        rerender();
      } else state = "loading";
      const result = await gateway.browse({
        limit: 20,
        cursor: reset ? null : nextCursor,
      });
      if (!result.ok) {
        setFailure(result.error, !reset && items.length > 0);
        statusUnavailable = true;
        statusDiscoveryPending = reset;
        recordStatusFailure(result.error);
        if (statusRetryAllowed) scheduleWorkflowStatusRefresh(workflowStatusGeneration);
        return;
      }
      items = reset
        ? [...result.value.items]
        : merge(items, result.value.items);
      interestAreas = [...result.value.interestAreas];
      nextCursor = result.value.nextCursor;
      if (reset) { statusDiscoveryCursor = nextCursor; statusDiscoveryPending = false; }
      for (const source of result.value.items) trackedSourceIds.add(source.id);
      state = items.length === 0 ? "empty" : "success";
      message = null;
      rerender();
      await Promise.all([loadKnowledge(), loadWorkflowStatuses(true)]);
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
    query = rawQuery.trim();
    const rawScope = data.get("searchScope");
    searchScope = rawScope === "sources" ? "sources" : "knowledge";
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
            throw new TypeError(libraryCopy(2));
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
      if (searchScope === "sources") {
        for (const source of items) trackedSourceIds.add(source.id);
        knowledge = []; await Promise.all([loadKnowledge(), loadWorkflowStatuses(true)]);
      }
    })().finally(() => {
      read = null;
      rerender();
    });
    await read;
  }

  /** @param {boolean} [force] */
  async function loadKnowledge(force = false) {
    if (knowledgeRead !== null) {await knowledgeRead;if(!force)return;}
    knowledgeRead = (async () => {
      const result = await learningGateway.listKnowledge();
      if (!result.ok) {
        onError(friendlyLearning(result.error));
        return;
      }
      knowledge = result.value.items.filter(card=>!cancelledKnowledgeIds.has(card.knowledgeId)).map((card) => ({
        knowledgeId: card.knowledgeId,
        sourceId: card.sourceId,
        summary: card.summary,
        questionLocked: card.questionLocked,
        primarySubject: card.sourceClassification?.mainSubject ?? null,
        sourceTopic: card.sourceClassification?.topic ?? null,
      }));
      const newest = [...items].sort((a, b) => b.approvedAt.localeCompare(a.approvedAt) || b.id.localeCompare(a.id))[0];
      if (subject === null && newest) subject = librarySourceSubjects(newest.id, knowledge)[0];
    })().finally(() => {
      knowledgeRead = null;
      rerender();
    });
    return await knowledgeRead;
  }

  /** @param {boolean} [refreshAll] */
  async function loadWorkflowStatuses(refreshAll = false) {
    if (workflowStatusRead !== null) {
      const readingGeneration = workflowStatusReadGeneration;
      await workflowStatusRead;
      if (readingGeneration !== workflowStatusGeneration) await loadWorkflowStatuses(true);
      return;
    }
    const generation = workflowStatusGeneration;
    const currentRead = (async () => {
      let failed = false;
      statusRetryAllowed = true;
      const seenCursors = new Set();
      while (statusDiscoveryPending || statusDiscoveryCursor !== null) {
        const cursor = statusDiscoveryPending ? null : statusDiscoveryCursor;
        if (seenCursors.has(cursor)) { failed = true; break; }
        seenCursors.add(cursor);
        const page = await gateway.browse({limit:20,cursor});
        if (generation !== workflowStatusGeneration) return;
        if (!page.ok) { recordStatusFailure(page.error); failed = true; break; }
        for (const source of page.value.items) trackedSourceIds.add(source.id);
        const requested=page.value.items.find(source=>source.id===pendingFocusSourceId);
        if(requested)items=merge(items,[requested]);
        statusDiscoveryPending = false;
        statusDiscoveryCursor = page.value.nextCursor;
      }
      const knownById=new Map(workflowStatuses.map(status=>[status.sourceId,status]));
      const sourceIds=[...trackedSourceIds].filter(sourceId=>{const known=knownById.get(sourceId);return refreshAll||statusUnavailable||known===undefined||countProcessingWorkflowStatuses([known])>0||known.run!=null&&cancellationRetries.has(known.run.runId);});
      const results = await Promise.all(sourceIds.map(sourceId => gateway.workflowStatus(sourceId)));
      if (generation !== workflowStatusGeneration) return;
      const known = new Map(workflowStatuses.map(status => [status.sourceId,status]));
      for (const result of results) {
        if (result.ok) known.set(result.value.sourceId,result.value);
        else { recordStatusFailure(result.error); failed = true; }
      }
      workflowStatuses = statusRetryAllowed ? [...known.values()] : [];
      statusUnavailable = failed;
      if (failed) onError("Status unavailable.");
      if (statusRetryAllowed && (failed || countProcessingWorkflowStatuses(workflowStatuses) > 0)) scheduleWorkflowStatusRefresh(generation);
      else cancelWorkflowStatusRefresh();
      rerender();
    })();
    workflowStatusRead = currentRead;
    workflowStatusReadGeneration = generation;
    try { await currentRead; }
    finally {
      if (workflowStatusRead === currentRead) { workflowStatusRead = null; }
    }
  }

  /** @param {import("../features/source-library/gateway.js").SourceGatewayFailure} failure */
  function recordStatusFailure(failure) {
    if (failure.kind === "SourceGatewayUnauthenticated" || failure.kind === "SourceGatewayUnauthorized") {
      trackedSourceIds.clear();
      statusDiscoveryCursor = null;
      statusDiscoveryPending = false;
      workflowStatuses = [];
      statusRetryAllowed = false;
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
      disposed ||
      workflowStatusRefreshHandle !== null ||
      (!statusRetryAllowed || !statusUnavailable && countProcessingWorkflowStatuses(workflowStatuses) === 0)
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
      trackedSourceIds.delete(source.id);
      state = items.length === 0 ? "empty" : "success";
      onNotice(
        libraryCopy(3),
      );
    }
    await loadWorkflowStatuses(true);
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
        libraryCopy(4),
      );
    }
    rerender();
  }

  /** @param {HTMLButtonElement} button */
  async function retryWorkflow(button) {
    const cancel=button.hasAttribute("data-library-workflow-cancel");
    const attribute=cancel?"data-library-workflow-cancel":"data-library-workflow-retry";
    const runId = button.getAttribute(attribute);
    const expectedRevision = Number(
      button.getAttribute(`${attribute}-revision`),
    );
    if (
      runId === null || runId.trim() === "" ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    ) return;
    const status = workflowStatuses.find((candidate) =>
      candidate.run?.runId === runId
    );
    if (status?.run == null || pendingSourceId !== null || (cancel ? !cancellationRetries.has(runId) && ["completed","abandoned"].includes(status.run.state) : status.run.state !== "retryable-failure")) return;
    const source=items.find(source=>source.id===status.sourceId);
    if(cancel&&(source===undefined||!dependencies.confirmCancel?.(source)))return;
    pendingSourceId=status.sourceId;rerender();
    stopWorkflowStatusPolling();
    const command=cancellationRetries.get(runId) ?? {runId,expectedRevision,idempotencyKey:`workflow-${cancel?"cancel":"retry"}:${createId()}`};
    if(cancel)cancellationRetries.set(runId,command);
    const result = await gateway[cancel?"cancelWorkflow":"retryWorkflow"](command);
    pendingSourceId=null;
    if (!result.ok) {
      onError(cancel ? libraryCopy(5) : friendly(result.error));
      await loadWorkflowStatuses(true);
      rerender();
      return;
    }
    if(cancel){
      cancellationRetries.delete(runId);
      const removed=new Set(status.run.progress?.knowledgePoints.map(point=>point.knowledgeId)??[]);
      for(const id of removed)cancelledKnowledgeIds.add(id);
      knowledge=knowledge.filter(point=>!removed.has(point.knowledgeId));
      knowledgeSearchResults=knowledgeSearchResults.filter(point=>!removed.has(point.knowledgeId));
      workflowStatuses=workflowStatuses.map(candidate=>candidate.sourceId===status.sourceId?{...candidate,run:null,reasonCode:null,message:libraryCopy(6)}:candidate);
    }
    onNotice(
      cancel ? libraryCopy(6) : libraryCopy(7),
    );
    rerender();
    if(cancel)await loadKnowledge(true);
    trackedSourceIds.add(status.sourceId);
    await loadWorkflowStatuses(true);
  }

  let uploadMessage = "";
  let uploadSucceeded = false;
  /** @param {string} message */
  function uploadFailure(message) {
    uploadMessage = message;
  }

  /** @param {string} sourceId Empty creates a private document. @param {FormData} form @param {import("../features/uploads/page.js").UploadContext|null} [context] */
  async function uploadMaterial(sourceId, form, context = null) {
    if (pendingSourceId !== null) return;
    uploadMessage = "";
    uploadSucceeded = false;
    if (context !== null && (context.source.id !== sourceId || !context.runId || context.source.state !== "active")) return uploadFailure(uploadCopy(0));
    let source = context?.source ?? items.find((candidate) => candidate.id === sourceId);
    const run = context === null ? workflowStatuses.find((status) => status.sourceId === sourceId)?.run : {runId:context.runId,state:"awaiting-upload"};
    if (
      !(form instanceof FormData) ||
      (sourceId !== "" &&
        (source === undefined || run?.state !== "awaiting-upload"))
    ) {
      uploadFailure(
        uploadCopy(1),
      );
      return;
    }
    const files = /** @type {File[]} */ (form.getAll("file").filter((item) => item instanceof File && item.size > 0));
    const file = files[0] ?? null;
    const mode = files.length > 0 && files.every(file => /\.(?:png|jpe?g|webp|gif)$/iu.test(file.name)) || form.get("imageProcessing") === "on" ? "image" : "text";
    if (files.length > 100 || files.reduce((total, item) => total + item.size, 0) > 104_857_600) return uploadFailure(uploadCopy(2));
    const pasted = form.get("content");
    const content = typeof pasted === "string" ? pasted.trim() : "";
    if (content.length > 1_000_000) return uploadFailure(uploadCopy(3));
    if ((file === null) === (content === "")) {
      uploadFailure(uploadCopy(4));
      return;
    }
    if (files.length > 1 && mode !== "image") return uploadFailure(uploadCopy(5));
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
      uploadFailure(uploadCopy(6));
      return;
    }
    if (mode === "image" && (file === null || mediaType !== "application/pdf" && !mediaType.startsWith("image/") || files.length > 1 && files.some((item) => !/\.(?:png|jpe?g|webp|gif)$/iu.test(item.name)))) return uploadFailure(uploadCopy(7));
    if (mode === "image" && files.some((item) => item.size > 20 * 1024 * 1024 && mediaType !== "application/pdf")) return uploadFailure(uploadCopy(8));
    if (mode === "text" && mediaType.startsWith("image/")) return uploadFailure(uploadCopy(9));
    const titleValue = form.get("title");
    const title = typeof titleValue === "string" && titleValue.trim() !== ""
      ? titleValue.trim()
      : file?.name;
    if (sourceId === "" && !title) {
      return uploadFailure(uploadCopy(10));
    }
    const fileName = file?.name ?? "paste.txt";
    const pageRange = form.get("pageRange") ?? "";
    if (typeof pageRange !== "string" || pageRange.length > 300 || pageRange.trim() !== "" && (mode !== "image" || mediaType !== "application/pdf")) return uploadFailure(uploadCopy(11));
    pendingSourceId = sourceId;
    uploading = true;
    if (source) trackedSourceIds.add(source.id);
    stopWorkflowStatusPolling();
    rerender();
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
        catch (error) { return uploadFailure(libraryCopy(8)); }
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
          libraryCopy(9),
        );
      }
      let runId = run?.runId;
      if (sourceId === "") {
        const created = await gateway.createPrivateDocument({
          title,
          fileName,
          idempotencyKey: `private-document:${id}`,
        });
        if (!created.ok) return uploadFailure(friendly(created.error));
        source = created.value.source;
        trackedSourceIds.add(source.id);
        runId = created.value.runId;
        if (!items.some((item) => item.id === source?.id)) items.push(source);
      }
      if (source === undefined || runId === undefined) {
        return uploadFailure(
          libraryCopy(10),
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
        idempotencyKey: `workflow-material:${runId}:${id}`,
        ...(uploadFile === null ? { content } : { file: uploadFile }),
      });
      if (!uploaded.ok) {
        uploadFailure(friendly(uploaded.error));
        return;
      }
      uploadMessage =
        libraryCopy(11);
      uploadSucceeded = true;
      onNotice(uploadMessage);
      if (!items.some(item => item.id === source.id)) items.push(source);
    } finally {
      pendingSourceId = null;
      uploading = false;
      rerender();
      await loadWorkflowStatuses(true);
    }
  }

  /** @param {HTMLElement} root */
  function bind(root) {
    observer?.disconnect();
    observer = null;
    if(pendingFocusSourceId!==null){
      const requested=[...root.querySelectorAll("[data-library-source]")].find(element=>element.getAttribute("data-library-source")===pendingFocusSourceId);
      if(requested instanceof HTMLElement){
        if(focusHandle!==null)cancel(focusHandle);
        focusHandle=schedule(()=>{focusHandle=null;if(disposed||!requested.isConnected)return;requested.focus({preventScroll:true});requested.scrollIntoView({block:"center"});pendingFocusSourceId=null;},0);
      }
    }
    root.querySelector("[data-library-subject]")?.addEventListener("change", event => {
      const select = event.currentTarget;
      if (!(select instanceof HTMLSelectElement) || !(select.value === "unclassified" || isSubjectId(select.value))) return;
      subject = select.value;
      try { dependencies.storage?.setItem("resonance-library-subject", subject); }
      catch (error) { if (!(error instanceof Error)) throw error; onError(libraryCopy(12)); }
      rerender();
      const restored = root.querySelector("[data-library-subject]");
      if (restored instanceof HTMLElement) restored.focus();
    });
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
    root.querySelectorAll("[data-library-workflow-retry], [data-library-workflow-cancel]").forEach((element) =>
      element.addEventListener("click", () => {
        if (typeof element.getAttribute === "function") {
          void retryWorkflow(/** @type {HTMLButtonElement} */ (element));
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
      cancellationRetries:[...cancellationRetries.keys()],
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

  /** @param {string} sourceId @param {string} title */
  function renamed(sourceId, title) {
    items = items.map(source => source.id === sourceId ? freeze({...source,title}) : source);
    knowledgeSearchResults = knowledgeSearchResults.map(point => point.sourceId === sourceId ? {...point,sourceTitle:title} : point);
  }
  /** Open the source's shelf and focus its card, including a reused source on a later page.
   * @param {string} sourceId */
  async function revealSource(sourceId){
    if(disposed||!sourceId.trim())return;
    pendingFocusSourceId=sourceId;query="";searchScope="knowledge";
    await load();
    const requested=items.find(source=>source.id===sourceId);
    if(requested){subject=librarySourceSubjects(sourceId,knowledge)[0];rerender();}
    else{pendingFocusSourceId=null;onError(libraryCopy(13));}
  }
  function dispose(){disposed=true;stopWorkflowStatusPolling();observer?.disconnect();observer=null;if(focusHandle!==null){cancel(focusHandle);focusHandle=null;}pendingFocusSourceId=null;}
  async function resume(){if(!disposed)return;disposed=false;await loadWorkflowStatuses(true);}
  return freeze({ load, search, uploadMaterial, bind, render, renamed, revealSource, dispose, resume,
    renderProcessingStatus: () => renderProcessingStatus({workflowStatuses,escapeHtml,uploading,unavailable:statusUnavailable}), uploadResult: () => ({ok:uploadSucceeded,message:uploadMessage}) });
}

/** @param {import("../features/source-library/gateway.js").SourceGatewayFailure} failure */
function friendly(failure) {return failureCopy(failure,"source");}

/** @param {import("../features/learning-generation/batches-gateway.js").LearningBatchGatewayFailure} failure */
function friendlyLearning(failure) {return failureCopy(failure,"knowledge");}

/** User copy follows the closed gateway failure contract.
 * @param {{kind:string,failureKind?:string}} failure @param {string} group */
function failureCopy(failure,group){
 const messages=readLibraryCopy().libraryFailureMessages?.[group];
 const kind=failure.kind.endsWith("Rejected")?failure.failureKind:failure.kind;
 return libraryCopy(messages?.[kind??""]??messages?.default);
}

/** @param {readonly LibrarySource[]} current @param {readonly LibrarySource[]} next */
function merge(current, next) {
  const merged = new Map(current.map((source) => [source.id, source]));
  for (const source of next) merged.set(source.id, source);
  return [...merged.values()];
}

export {};

/** Static copy shares the cached application shell. @param {number} index @param {string} [group] */
function uploadCopy(index,group="uploadValidation") {
  const copy = readLibraryCopy()[group]?.[index];
  if (typeof copy !== "string") throw new TypeError("UploadCopyInvalid");
  return copy;
}

/** @param {number} index */
function libraryCopy(index){return uploadCopy(index,"libraryMessages");}

function readLibraryCopy(){
 const content=document.getElementById("app-copy")?.textContent;
 if(!content)throw new TypeError("LibraryCopyUnavailable");
 return JSON.parse(content);
}
