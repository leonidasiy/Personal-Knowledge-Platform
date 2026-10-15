// @ts-check
import { createShellMarkup } from "../shell-markup.js";

import { countProcessingWorkflowStatuses } from "../features/source-library/gateway.js";
import { isRecord } from "../features/source-library/contracts.js";
import { SUBJECTS, isSubjectId } from "../features/knowledge-subjects/public.js";

/** @import { LibrarySource, SourceInterestArea, SourceSearchScope } from "../features/source-library/contracts.js" */
/** @import { WorkflowSourceStatus } from "../features/source-library/gateway.js" */

/**
 * @typedef {{
 *   readonly state: "loading" | "success" | "empty" | "error" | "offline",
 *   readonly items: readonly LibrarySource[],
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
 *   readonly knowledge?: readonly { readonly knowledgeId: string, readonly sourceId: string, readonly summary: string, readonly questionLocked: boolean, readonly primarySubject?: string | null, readonly sourceTopic?: string | null }[],
 *   readonly knowledgeSearchResults?: readonly { readonly knowledgeId: string, readonly sourceId: string, readonly sourceTitle: string, readonly summary: string, readonly sourceUrl: string, readonly evidenceAnchorIds?: readonly string[], readonly questionLocked: boolean, readonly score: number, readonly matchedBy: "exact" | "semantic" | "combined" }[],
 *   readonly workflowStatuses?: readonly WorkflowSourceStatus[],
 *   readonly cancellationRetries?: readonly string[],
 *   readonly escapeHtml: (value: string) => string,
 *   readonly formatDate: (value: string) => string
 * }} LibraryRouteModel
 */

/** @param {LibraryRouteModel} model */
export function renderLibraryRoute(model) {
  validate(model);
  return shellMarkup(0, "", renderCollection(model));
}

/** @param {{readonly workflowStatuses?: readonly WorkflowSourceStatus[], readonly escapeHtml:(value:string)=>string, readonly uploading?:boolean, readonly unavailable?:boolean}} model */
export function renderProcessingStatus(model) {
  const statuses = model.workflowStatuses ?? [];
  const count = countProcessingWorkflowStatuses(statuses);
  if (!model.uploading && !model.unavailable && count === 0) return "";
  const active = statuses.find(status => countProcessingWorkflowStatuses([status]) > 0);
  const stage = count === 1 && active?.run ? workflowStageMessage(active.run.state).replace(/^Processing:\s*/u, "") : null;
  const processing = `Processing ${count} ${count === 1 ? "source" : "sources"}${stage === null ? "" : ` · ${stage}`}`;
  const label = model.uploading ? `Uploading…${count && !model.unavailable ? ` · ${processing}` : ""}`
    : model.unavailable ? `Status unavailable${count ? ` · Last confirmed: ${processing}` : ""}` : processing;
  return shellMarkup(1, model.unavailable && !model.uploading ? "" : shellMarkup(65), model.escapeHtml(label));
}

/** @param {LibraryRouteModel} model */
function renderCollection(model) {
  const collection = model.collection;
  const escapeHtml = model.escapeHtml;
  const searchScope = collection.searchScope ?? "knowledge";
  const searchingKnowledge = searchScope === "knowledge" && collection.query.trim() !== "";
  const search = shellMarkup(2, searchScope === "sources" ? "selected" : "", searchScope === "knowledge" ? "selected" : "", escapeHtml(collection.query), searchScope === "knowledge" ? shellMarkup(21) : shellMarkup(22));
  if (collection.state === "loading" && collection.items.length === 0) {
    return shellMarkup(3, search, searchingKnowledge ? shellMarkup(23) : "Opening sources", searchingKnowledge ? shellMarkup(24) : shellMarkup(25));
  }
  if (collection.state === "error" || collection.state === "offline") {
    return shellMarkup(4, search, collection.state === "error" ? "alert" : "status", collection.state === "offline"
        ? shellMarkup(26)
        : shellMarkup(27), escapeHtml(collection.message ?? shellMarkup(28)));
  }
  if (searchingKnowledge) {
    return `${search}${renderKnowledgeSearchResults(model)}`;
  }
  if (collection.items.length === 0) {
    return shellMarkup(5, search, collection.query === "" ? shellMarkup(67) : shellMarkup(29), collection.query === ""
        ? shellMarkup(30)
        : shellMarkup(31));
  }
  const ordered = [...collection.items].sort((a, b) => b.approvedAt.localeCompare(a.approvedAt) || b.id.localeCompare(a.id));
  const selected = collection.subject ?? librarySourceSubjects(ordered[0].id, model.knowledge ?? [])[0];
  const subjects = [...SUBJECTS, { id: "unclassified", label: "Unclassified" }];
  const visible = ordered.filter(source => librarySourceSubjects(source.id, model.knowledge ?? []).includes(selected));
  const subjectControl = shellMarkup(6, subjects.map(s => shellMarkup(7, s.id, selected === s.id ? "selected" : "", escapeHtml(s.label))).join(""), visible.length, visible.length === 1 ? "" : "s");
  const content = shellMarkup(8, subjectControl, visible.map(source => renderSource(model, source)).join(""), visible.length ? "" : shellMarkup(9));
  const retainedNotice = collection.message === null
    ? ""
    : shellMarkup(10, escapeHtml(collection.message));
  const more = collection.nextCursor === null
    ? ""
    : shellMarkup(11, collection.state === "loading" ? "disabled" : "", collection.state === "loading" ? "Loading..." : shellMarkup(68));
  return shellMarkup(12, search, retainedNotice, content, more);
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
    return shellMarkup(13, hasQuery ? shellMarkup(32) : shellMarkup(33), hasQuery ? shellMarkup(34) : shellMarkup(35));
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
    return shellMarkup(14, knowledgeId, escapeHtml(result.summary), escapeHtml(result.sourceUrl), escapeHtml(result.sourceTitle), matchLabel, score, result.questionLocked ? shellMarkup(36) : shellMarkup(37), knowledgeId);
  }).join("");
  return shellMarkup(15, results.length, results.length === 1 ? "" : "s", content);
}

/** @param {LibraryRouteModel} model @param {LibrarySource} source */
function renderSource(model, source) {
  const escapeHtml = model.escapeHtml;
  const formatDate = model.formatDate;
  const collection = model.collection;
  const sourceId = escapeHtml(source.id);
  const pending = collection.pendingSourceId === source.id;
  const workflowStatus = (model.workflowStatuses ?? []).find((status) => status.sourceId === source.id) ?? null;
  const workflowMessage = workflowStatusMessage(source, workflowStatus);
  const progress = renderSourceProgress(workflowStatus,escapeHtml);
  const workflowNotice = (workflowMessage === null || progress && (!workflowStatus?.message || countProcessingWorkflowStatuses([workflowStatus])===0) ? "" : shellMarkup(16, escapeHtml(workflowMessage))) + progress;
  const retry = (quizzes=false) => shellMarkup(17, escapeHtml(workflowStatus?.run?.runId??""), workflowStatus?.run?.revision??0, `${pending?"disabled":""} ${quizzes?"data-library-workflow-quiz":""}`, shellMarkup(quizzes?89:workflowStatus?.reasonCode === "partial-failure"?82:83));
  const workflowRetry = workflowStatus?.run && (workflowStatus.reasonCode === "retryable-failure" || workflowStatus.reasonCode === "partial-failure") ? ((workflowStatus.reasonCode === "retryable-failure" || workflowStatus.run.progress?.failedItems?.length ? retry():"") + (workflowStatus.run.state==="completed"&&workflowStatus.run.progress?.failedQuizItems?.length?retry(true):"")) : "";
  const workflowCancel=workflowStatus?.run != null && (model.cancellationRetries?.includes(workflowStatus.run.runId) || !["completed","abandoned"].includes(workflowStatus.run.state)) ? shellMarkup(48,escapeHtml(workflowStatus.run.runId),workflowStatus.run.revision,pending?"disabled":"") : "";
  const upload = workflowStatus?.run?.state === "awaiting-upload"
    ? shellMarkup(18, escapeHtml(`#upload?${new URLSearchParams({sourceId:source.id,runId:workflowStatus.run.runId})}`))
    : workflowStatus?.reasonCode==="partial-failure"&&workflowStatus.run?.counts.knowledgePoints===0&&(source.origin??"web")==="web"?shellMarkup(84,sourceId):"";
  const knowledge = (model.knowledge ?? []).filter((card) => card.sourceId === source.id);
  const related = knowledge.length === 0
    ? ""
    : shellMarkup(19, sourceId, sourceId, escapeHtml(knowledgeOverview(knowledge)));
  return shellMarkup(20, sourceId, sourceId, sourceId, escapeHtml(source.title), escapeHtml(source.origin==="private-document"?"Uploaded material":new URL(source.canonicalUrl).hostname), formatDate(source.approvedAt), escapeHtml(source.description), workflowNotice + related + upload, workflowRetry + workflowCancel, escapeHtml(source.canonicalUrl), sourceId, source.revision, pending ? "disabled" : "", pending ? "Removing..." : "Remove");
}

/** @param {WorkflowSourceStatus|null} status @param {(value:string)=>string} escapeHtml */
function renderSourceProgress(status,escapeHtml){
  const run=status?.run;if(!run||run.state==="abandoned")return "";
  const progress=run.progress;
  const points=progress?.knowledgePoints??[];
  const failures=progress?.failedItems??[];
  const completed=run.state==="completed";
  const active=countProcessingWorkflowStatuses([status])>0;
  const knowledgeCount=Math.max(run.counts.knowledgePoints,points.length);
  const questions=progress?shellMarkup(64,progress.generatedQuizQuestions):shellMarkup(57);
  const stage=completed?shellMarkup(status.reasonCode==="partial-failure"?72:58):(active?progress?.stage:status.message)??workflowStageMessage(run.state);
  const pageCount=progress?.processedPageCount??run.counts.pages;
  const total=progress?.totalPages;
  const attempted=Math.min(total??Infinity,pageCount+failures.length);
  const meter=completed&&failures.length?shellMarkup(86,total??attempted,attempted,`${attempted}${total==null?"":` of ${total}`}`,pageCount,failures.length):shellMarkup(69,total??1,total==null?(active?"":`value="${completed?1:0}"`):`value="${pageCount}"`,active?"library-processing-spinner":"",`${pageCount}${total==null?"":` of ${total}`}`,active&&progress?.sectionTitle?` · ${escapeHtml(progress.sectionTitle)}`:"");
  const failureCopy=JSON.parse(shellMarkup(71));
  const report=failures.length&&completed?shellMarkup(73,failures.length,failures.map(item=>shellMarkup(74,escapeHtml(item.url),escapeHtml(item.title.replace(/^https:\/\/\S+ — captured page\.pdf\.pkpi — (Page \d+)$/u,"$1")),shellMarkup(failureCopy[item.failureKind]??81),item.attempts)).join("")):"";
  const quizFailures=progress?.failedQuizItems??[];
  const quizReport=completed&&quizFailures.length?shellMarkup(87,quizFailures.length,quizFailures.map(item=>shellMarkup(88,escapeHtml(item.summary),item.attempts)).join("")):"";
  const summaries=points.length?shellMarkup(52,points.map(point=>shellMarkup(51,escapeHtml(point.summary))).join("")):shellMarkup(knowledgeCount?54:53);
  return shellMarkup(49,escapeHtml(status.sourceId),escapeHtml(status.sourceId),escapeHtml(stage),escapeHtml(shellMarkup(66,knowledgeCount,knowledgeCount===1?"point":"points",questions)),meter+(points.length?shellMarkup(70,escapeHtml(points.at(-1)?.summary??"")):""),knowledgeCount,summaries,report+quizReport+(active?shellMarkup(55):""));
}

/** @param {readonly { readonly summary: string, readonly sourceTopic?: string|null }[]} knowledge @returns {string} */
function knowledgeOverview(knowledge) {
  const sourceTopic = [...new Set(knowledge.map(({ sourceTopic }) => sourceTopic?.trim() ?? "").filter(Boolean))][0];
  const lead = `Contains ${knowledge.length} retained knowledge ${knowledge.length === 1 ? "point" : "points"}`;
  return sourceTopic === undefined ? `${lead}.` : `${lead} · Source topic: ${sourceTopic.slice(0, 240 - lead.length - 18)}.`;
}

/** @param {LibrarySource} source @param {WorkflowSourceStatus | null} status @returns {string | null} */
function workflowStatusMessage(source, status) {
  if (status === null) return null;
  if (status.reasonCode === "rights-not-verified" && sourceHasAudioVideo(source)) return shellMarkup(39);
  if (status.message !== null) return status.message;
  if (status.run?.state === "completed") return shellMarkup(40);
  if (status.run !== null && status.run.state !== "awaiting-upload") return workflowStageMessage(status.run.state);
  return null;
}

/** @param {NonNullable<WorkflowSourceStatus["run"]>["state"]} state @returns {string} */
function workflowStageMessage(state) {
  if (state === "source-added") return shellMarkup(41);
  if (state === "rights-assessment") return shellMarkup(42);
  if (state === "robots-check") return shellMarkup(43);
  if (state === "extraction-loop") return shellMarkup(44);
  if (state === "extraction-finalized") return shellMarkup(45);
  if (state === "per-point-quiz-loop") return shellMarkup(46);
  return shellMarkup(47);
}

/** @param {LibrarySource} source @returns {boolean} */
function sourceHasAudioVideo(source) {
  return [source.adapter.granularity, ...source.adapter.capabilities].some((value) => /audio|video|podcast|episode/u.test(value.toLowerCase()));
}

/** @param {LibraryRouteModel} model */
function validate(model) {
  if (
    !Array.isArray(model.collection.items) ||
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

const shellMarkup = createShellMarkup("library-markup");
