// @ts-check

import { countProcessingWorkflowStatuses } from "../features/source-library/gateway.js";
import { isRecord } from "../features/source-library/contracts.js";
import { SUBJECTS, isSubjectId } from "../features/knowledge-subjects/public.js";

/** @import { LibrarySource, SourceInterestArea, SourceSearchScope } from "../features/source-library/contracts.js" */
/** @import { WorkflowSourceStatus } from "../features/source-library/gateway.js" */

/**
 * @typedef {{
 *   readonly state: "loading" | "success" | "empty" | "error" | "offline",
 *   readonly items: readonly LibrarySource[],
 *   readonly interestAreas: readonly SourceInterestArea[],
 *   readonly nextCursor: string | null,
 *   readonly query: string,
 *   readonly subject?: string | null,
 *   readonly searchScope?: SourceSearchScope,
 *   readonly pendingSourceId: string | null,
 *   readonly message: string | null
 * }} SourceCollectionModel
 */

/**
 * @typedef {{
 *   readonly collection: SourceCollectionModel,
 *   readonly knowledge?: readonly { readonly knowledgeId: string, readonly sourceId: string, readonly summary: string, readonly questionLocked: boolean, readonly primarySubject?: string | null }[],
 *   readonly knowledgeSearchResults?: readonly { readonly knowledgeId: string, readonly sourceId: string, readonly sourceTitle: string, readonly summary: string, readonly sourceUrl: string, readonly evidenceAnchorIds?: readonly string[], readonly questionLocked: boolean, readonly score: number, readonly matchedBy: "exact" | "semantic" | "combined" }[],
 *   readonly workflowStatuses?: readonly WorkflowSourceStatus[],
 *   readonly escapeHtml: (value: string) => string,
 *   readonly formatDate: (value: string) => string
 * }} LibraryRouteModel
 */

/** @param {LibraryRouteModel} model */
export function renderLibraryRoute(model) {
  validate(model);
  return `<section class="wide-view" aria-labelledby="library-title">
    <div class="section-heading"><div><p class="eyebrow">Library · source collection</p><h1 id="library-title">A shelf for your curiosity.</h1><p>Sources worth keeping. Ideas worth coming back to.</p></div>${renderProcessingStatus(model)}</div>
    ${renderCollection(model)}<section class="library-intake"><div><p class="eyebrow">Make a connection</p><h2>Bring something worth keeping.</h2><p>Add your own authorized material. Knowledge cards and paired questions appear in Feed and Review after processing.</p></div>${renderUploadForm("", model.collection.pendingSourceId !== null)}</section>
  </section>`;
}

/** @param {string} sourceId HTML-escaped source identity, or empty for a new document. @param {boolean} pending */
function renderUploadForm(sourceId, pending) {
  return `<details class="library-upload" data-library-details-key="upload:${sourceId}"><summary>${sourceId === "" ? "Upload a private document" : "Upload authorized content"}</summary><form data-library-upload="${sourceId}">${sourceId === "" ? '<label>Title (optional for files)<input name="title" maxlength="300"></label>' : ""}<label><input type="checkbox" name="imageProcessing"> Process images in uploads</label><label>PDF pages (blank means all; e.g. 1,3-5)<input name="pageRange" inputmode="numeric" maxlength="300"></label><label>Paste text<textarea name="content" rows="5"></textarea></label><label>Or choose documents or images<input type="file" name="file" multiple accept=".txt,.md,.pdf,.pptx,.png,.jpg,.jpeg,.webp,.gif"></label><p>Text processing is the default. Image processing sends each selected image or PDF page to the vision model. Images are limited to 20 MiB each; the total upload limit is 100 MiB.</p><label><input type="checkbox" name="attested" required>I own this content or have permission for storage, transformation, and external AI processing.</label><button class="button secondary" type="submit" ${pending ? "disabled" : ""}>${pending ? "Uploading..." : "Upload and process"}</button><p role="alert" data-library-upload-message></p></form></details>`;
}

/** @param {LibraryRouteModel} model */
function renderProcessingStatus(model) {
  const count = countProcessingWorkflowStatuses(model.workflowStatuses ?? []);
  if (count === 0) return "";
  const noun = count === 1 ? "source" : "sources";
  const active = (model.workflowStatuses ?? []).find((status) => status.run !== null && status.run.state !== "completed");
  const stage = count === 1 && active?.run !== null && active?.run !== undefined
    ? workflowStageMessage(active.run.state).replace(/^Processing:\s*/u, "")
    : null;
  return `<div class="local-badge library-processing-status" data-library-processing-status role="status" aria-live="polite" aria-atomic="true"><span class="library-processing-spinner" aria-hidden="true">⟳</span><span>Processing ${count} ${noun}${stage === null ? "" : ` · ${model.escapeHtml(stage)}`}</span></div>`;
}

/** @param {LibraryRouteModel} model */
function renderCollection(model) {
  const collection = model.collection;
  const escapeHtml = model.escapeHtml;
  const searchScope = collection.searchScope ?? "sources";
  const searchingKnowledge = searchScope === "knowledge";
  const search = `<div class="discover-controls library-search"><form data-library-search>
    <label for="library-search-scope">Search in</label>
    <div class="library-search-row"><select id="library-search-scope" name="searchScope" aria-label="Search scope">
      <option value="sources" ${searchingKnowledge ? "" : "selected"}>Search saved sources</option>
      <option value="knowledge" ${searchingKnowledge ? "selected" : ""}>Search knowledge</option>
    </select><input id="library-search" name="query" type="search" value="${
    escapeHtml(collection.query)
    }" autocomplete="off" placeholder="${searchingKnowledge ? "Find an idea you remember…" : "Find something on your shelf…"}" aria-label="Search Library" aria-describedby="library-search-help">
    <button class="button primary" type="submit">Search</button></div>
    <label><input type="checkbox" name="externalProcessingAllowed"> Include AI semantic matches: send this query and candidate content to the configured external AI provider.</label>
    <p id="library-search-help">Searches exact terms by default. Optional AI ranking considers up to 20 candidates from active sources; it is not an exhaustive semantic search.</p>
  </form></div>`;
  if (collection.state === "loading" && collection.items.length === 0) {
    return `${search}<div class="state-panel" aria-busy="true"><h2>${searchingKnowledge ? "Searching knowledge" : "Opening sources"}</h2><p>${searchingKnowledge ? "Searching retained knowledge across your Library." : "Loading your approved Library sources."}</p></div>`;
  }
  if (collection.state === "error" || collection.state === "offline") {
    return `${search}<div class="state-panel" role="${
      collection.state === "error" ? "alert" : "status"
    }"><h2>${
      collection.state === "offline"
        ? "Library is offline"
        : "Library could not load"
    }</h2><p>${
      escapeHtml(collection.message ?? "Reconnect and try again.")
    }</p><button class="button secondary" type="button" data-library-retry>Try again</button></div>`;
  }
  if (searchingKnowledge) {
    return `${search}${renderKnowledgeSearchResults(model)}`;
  }
  if (collection.items.length === 0) {
    return `${search}<div class="state-panel"><h2>${
      collection.query === "" ? "No sources yet" : "No matching sources"
    }</h2><p>${
      collection.query === ""
        ? "Approve a source in Discover and it will appear here."
        : "Try a different term or search method."
    }</p><a class="button secondary" href="#discover">Open Discover</a></div>`;
  }
  const ordered = [...collection.items].sort((a, b) => b.approvedAt.localeCompare(a.approvedAt) || b.id.localeCompare(a.id));
  const selected = collection.subject ?? librarySourceSubjects(ordered[0].id, model.knowledge ?? [])[0];
  const subjects = [...SUBJECTS, { id: "unclassified", label: "Unclassified" }];
  const visible = ordered.filter(source => librarySourceSubjects(source.id, model.knowledge ?? []).includes(selected));
  const subjectControl = `<div class="library-subject-bar"><label for="library-subject">On this shelf<select id="library-subject" data-library-subject>${subjects.map(s => `<option value="${s.id}" ${selected === s.id ? "selected" : ""}>${escapeHtml(s.label)}</option>`).join("")}</select></label><p>${visible.length} loaded source${visible.length === 1 ? "" : "s"} · Newest first</p></div>`;
  const content = `${subjectControl}<div class="data-list">${visible.map(source => renderSource(model, source)).join("")}</div>${visible.length ? "" : '<p class="state-panel" role="status">No loaded sources in this subject. Choose another shelf or load more sources.</p>'}`;
  const retainedNotice = collection.message === null
    ? ""
    : `<div class="discover-notice" role="status"><p>${
      escapeHtml(collection.message)
    }</p><button class="button secondary" type="button" data-library-retry>Refresh sources</button></div>`;
  const more = collection.nextCursor === null
    ? ""
    : `<div class="load-more" data-library-sentinel><button class="button secondary" type="button" data-library-load-more ${
      collection.state === "loading" ? "disabled" : ""
    }>${
      collection.state === "loading" ? "Loading..." : "Load more"
    }</button></div>`;
  return `${search}${retainedNotice}<div class="library-collection">${content}${more}</div>`;
}

/** A source appears under each primary subject present in its retained points.
 * @param {string} sourceId
 * @param {readonly {readonly sourceId:string,readonly primarySubject?:string|null}[]} knowledge
 */
export function librarySourceSubjects(sourceId, knowledge) {
  const subjects = [...new Set(knowledge.filter(point => point.sourceId === sourceId).flatMap(point => point.primarySubject ? [point.primarySubject] : []))];
  return subjects.length ? subjects : ["unclassified"];
}

/** @param {LibraryRouteModel} model @returns {string} */
function renderKnowledgeSearchResults(model) {
  const collection = model.collection;
  const escapeHtml = model.escapeHtml;
  const results = model.knowledgeSearchResults ?? [];
  if (results.length === 0) {
    const hasQuery = collection.query.trim() !== "";
    return `<div class="state-panel"><h2>${hasQuery ? "No matching knowledge points" : "Search retained knowledge"}</h2><p>${hasQuery ? "Try a different term or switch to source search." : "Enter a concept, fact, or explanation to search across your active sources."}</p></div>`;
  }
  const content = results.map((result) => {
    const knowledgeId = escapeHtml(result.knowledgeId);
    const matchLabel = result.matchedBy === "exact"
      ? "exact match"
      : result.matchedBy === "semantic"
      ? "semantic match"
      : "exact + semantic match";
    const score = Number.isFinite(result.score)
      ? ` · score ${result.score.toFixed(2)}`
      : "";
    return `<article class="library-knowledge-search-result" data-library-knowledge="${knowledgeId}"><div><p class="eyebrow">Knowledge point</p><h3>${escapeHtml(result.summary)}</h3><p>From <a href="${escapeHtml(result.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.sourceTitle)}</a> · <span class="signal-summary">${matchLabel}${score}</span></p><p class="settings-form-note">${result.questionLocked ? "Question unlocks after Feed study" : "Question available in Review"}</p></div><button class="button quiet" type="button" data-library-knowledge-remove="${knowledgeId}">Remove knowledge</button></article>`;
  }).join("");
  return `<section class="library-knowledge-search" aria-labelledby="library-knowledge-search-title"><div class="section-heading"><div><p class="eyebrow">Knowledge results</p><h2 id="library-knowledge-search-title">${results.length} matching knowledge point${results.length === 1 ? "" : "s"}</h2></div></div><div class="data-list">${content}</div></section>`;
}

/** @param {LibraryRouteModel} model @param {LibrarySource} source */
function renderSource(model, source) {
  const escapeHtml = model.escapeHtml;
  const formatDate = model.formatDate;
  const collection = model.collection;
  const sourceId = escapeHtml(source.id);
  const pending = collection.pendingSourceId === source.id;
  const capabilities = source.adapter.capabilities.join(", ");
  const workflowStatus = (model.workflowStatuses ?? []).find((status) => status.sourceId === source.id) ?? null;
  const workflowMessage = workflowStatusMessage(source, workflowStatus);
  const workflowNotice = workflowMessage === null ? "" : `<p class="library-workflow-status" role="status">${escapeHtml(workflowMessage)}</p>`;
  const workflowRetry = workflowStatus?.reasonCode === "retryable-failure" && workflowStatus.run !== null
    ? `<button class="button secondary" type="button" data-library-workflow-retry="${escapeHtml(workflowStatus.run.runId)}" data-library-workflow-retry-revision="${workflowStatus.run.revision}">Retry processing</button>`
    : "";
  const robotsNotice = renderRobotsEvidence(model, workflowStatus);
  const upload = workflowStatus?.run?.state === "awaiting-upload"
    ? renderUploadForm(sourceId, pending)
    : "";
  const knowledge = (model.knowledge ?? []).filter((card) => card.sourceId === source.id);
  const related = knowledge.length === 0
    ? `<p class="library-knowledge-empty settings-form-note">Knowledge is still being processed, or this source has no retained knowledge yet.</p>`
    : `<section class="library-knowledge" aria-labelledby="library-knowledge-${sourceId}"><h4 id="library-knowledge-${sourceId}">Related knowledge</h4><p class="library-knowledge-overview">${escapeHtml(knowledgeOverview(knowledge))}</p></section>`;
  return `<article data-reveal="source:${sourceId}" data-library-source="${
    sourceId
  }"><div><p class="eyebrow">${escapeHtml(source.adapter.id)}</p><h3>${
    escapeHtml(source.title)
  }</h3><p>${escapeHtml(source.description)}</p><p>${
    escapeHtml(source.adapter.granularity)
  }${
    capabilities === "" ? "" : ` · ${escapeHtml(capabilities)}`
  }</p><p>Added ${
    formatDate(source.approvedAt)
  } · Processing is automatic</p>${workflowNotice}${workflowRetry}${robotsNotice}${upload}<a href="${
    escapeHtml(source.canonicalUrl)
  }" target="_blank" rel="noopener noreferrer">Open original source</a>${related}</div><button class="button danger" type="button" data-library-disable="${
    sourceId
  }" data-source-revision="${source.revision}" ${pending ? "disabled" : ""}>${
    pending ? "Removing..." : "Remove"
  }</button></article>`;
}

/** @param {readonly { readonly summary: string }[]} knowledge @returns {string} */
function knowledgeOverview(knowledge) {
  // ponytail: first-sentence heuristic keeps this overview local and bounded; use persisted source summaries if topic quality becomes inadequate.
  const topics = [...new Set(knowledge.map(({ summary }) => summary.replace(/^(?:this|the)\s+\w+\s+(?:introduces|explains|covers)\s+/iu, "").split(/[.!?]/u, 1)[0].trim()))].filter(Boolean);
  const lead = `Contains ${knowledge.length} retained knowledge ${knowledge.length === 1 ? "point" : "points"} covering`;
  const text = topics.length === 0 ? "broad concepts from this source" : topics.join("; ");
  return `${lead} ${text.slice(0, 240 - lead.length - 1)}.`;
}

/** @param {LibraryRouteModel} model @param {WorkflowSourceStatus | null} status @returns {string} */
function renderRobotsEvidence(model, status) {
  const escapeHtml = model.escapeHtml;
  const formatDate = model.formatDate;
  const evidence = status?.run?.robotsEvidence ?? null;
  if (evidence === null) return "";
  const robotsUrl = escapeHtml(evidence.robotsUrl);
  const checked = `Checked ${formatDate(evidence.checkedAt)} · HTTP ${evidence.httpStatus}`;
  const detailsKey = `robots:${evidence.robotsUrl}`;
  if (evidence.availability === "absent") return `<details class="library-robots-evidence" data-library-details-key="${escapeHtml(detailsKey)}"><summary>robots.txt: no directives</summary><p>${escapeHtml(checked)}. The source returned no robots.txt file (HTTP ${evidence.httpStatus}).</p><a href="${robotsUrl}" target="_blank" rel="noopener noreferrer">Open robots.txt</a></details>`;
  if (evidence.availability === "unavailable") return `<details class="library-robots-evidence" data-library-details-key="${escapeHtml(detailsKey)}"><summary>robots.txt: unavailable (HTTP 403)</summary><p>${escapeHtml(checked)}. The source refused the robots.txt request, but the source page was reachable and extraction was allowed by the configured policy.</p><a href="${robotsUrl}" target="_blank" rel="noopener noreferrer">Open robots.txt</a></details>`;
  return `<details class="library-robots-evidence" data-library-details-key="${escapeHtml(detailsKey)}"><summary>View robots.txt</summary><p>${escapeHtml(checked)} · <a href="${robotsUrl}" target="_blank" rel="noopener noreferrer">Open robots.txt</a></p><pre>${escapeHtml(evidence.content)}</pre></details>`;
}

/** @param {LibrarySource} source @param {WorkflowSourceStatus | null} status @returns {string | null} */
function workflowStatusMessage(source, status) {
  if (status === null) return null;
  if (status.reasonCode === "rights-not-verified" && sourceHasAudioVideo(source)) return "This source contains audio or video, but native audio/video transcription is not available yet. Upload an authorized transcript or text/document instead.";
  if (status.message !== null) return status.message;
  if (status.run?.state === "completed") return "Knowledge extraction and paired question generation completed.";
  if (status.run !== null && status.run.state !== "awaiting-upload") return workflowStageMessage(status.run.state);
  return null;
}

/** @param {NonNullable<WorkflowSourceStatus["run"]>["state"]} state @returns {string} */
function workflowStageMessage(state) {
  if (state === "source-added") return "Processing: starting the knowledge workflow.";
  if (state === "rights-assessment") return "Processing: assessing source rights.";
  if (state === "robots-check") return "Processing: checking source access rules.";
  if (state === "extraction-loop") return "Processing: extracting knowledge points.";
  if (state === "extraction-finalized") return "Processing: finalizing extracted knowledge.";
  if (state === "per-point-quiz-loop") return "Processing: generating and validating review quizzes.";
  return "Processing: completing the knowledge workflow.";
}

/** @param {LibrarySource} source @returns {boolean} */
function sourceHasAudioVideo(source) {
  return [source.adapter.granularity, ...source.adapter.capabilities].some((value) => /audio|video|podcast|episode/u.test(value.toLowerCase()));
}

/** @param {LibraryRouteModel} model */
function validate(model) {
  if (
    !Array.isArray(model.collection.items) ||
    !Array.isArray(model.collection.interestAreas) ||
    (model.collection.subject !== undefined && model.collection.subject !== null && model.collection.subject !== "unclassified" && !isSubjectId(model.collection.subject)) ||
    (model.knowledge !== undefined && !Array.isArray(model.knowledge)) ||
    (model.collection.searchScope !== undefined && model.collection.searchScope !== "sources" && model.collection.searchScope !== "knowledge") ||
    (model.knowledgeSearchResults !== undefined && (!Array.isArray(model.knowledgeSearchResults) || model.knowledgeSearchResults.some((result) => !isKnowledgeSearchResult(result)))) ||
    typeof model.escapeHtml !== "function" ||
    typeof model.formatDate !== "function"
  ) throw new TypeError("Library model is invalid.");
}

/** @param {unknown} value @returns {boolean} */
function isKnowledgeSearchResult(value) {
  if (!isRecord(value)) return false;
  return typeof value.knowledgeId === "string" && value.knowledgeId.trim() !== "" &&
    typeof value.sourceId === "string" && value.sourceId.trim() !== "" &&
    typeof value.sourceTitle === "string" && value.sourceTitle.trim() !== "" &&
    typeof value.summary === "string" && value.summary.trim() !== "" &&
    typeof value.sourceUrl === "string" && URL.canParse(value.sourceUrl) &&
    new URL(value.sourceUrl).protocol === "https:" &&
    (value.evidenceAnchorIds === undefined || (Array.isArray(value.evidenceAnchorIds) && value.evidenceAnchorIds.every((anchor) => typeof anchor === "string" && anchor.trim() !== ""))) &&
    typeof value.questionLocked === "boolean" &&
    typeof value.score === "number" && Number.isFinite(value.score) &&
    (value.matchedBy === "exact" || value.matchedBy === "semantic" || value.matchedBy === "combined");
}

export {};
