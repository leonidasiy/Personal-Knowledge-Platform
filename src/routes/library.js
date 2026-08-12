// @ts-check

/** @import { LibrarySource, SourceInterestArea, SourceSearchMode } from "../features/source-library/contracts.js" */
/** @import { LearningChoice, LearningReviewQueueStatus, LearningReviewQueueTask } from "../features/learning-generation/contracts.js" */

/** @typedef {{ readonly state: "idle" | "loading" | "success" | "error" | "offline", readonly sources: readonly { readonly sourceId: string, readonly title: string, readonly status: LearningReviewQueueStatus, readonly generationId: string | null, readonly pendingTaskCount: number, readonly reviewedTaskCount: number, readonly failureKind: string | null }[], readonly tasks: readonly LearningReviewQueueTask[], readonly message: string | null, readonly pendingTaskId: string | null }} LibraryReviewQueueModel */

/**
 * @typedef {{
 *   readonly state: "loading" | "success" | "empty" | "error" | "offline",
 *   readonly items: readonly LibrarySource[],
 *   readonly interestAreas: readonly SourceInterestArea[],
 *   readonly nextCursor: string | null,
 *   readonly query: string,
 *   readonly mode: SourceSearchMode,
 *   readonly pendingSourceId: string | null,
 *   readonly message: string | null
 * }} SourceCollectionModel
 */

/**
 * @typedef {{
 *   readonly collection: SourceCollectionModel,
 *   readonly queue: readonly { readonly promptId: string, readonly title: string, readonly dueAt: string | null, readonly reviewCount: number }[],
 *   readonly reviewQueue: LibraryReviewQueueModel,
 *   readonly page: "collection" | "review-queue",
 *   readonly recallAvailable: boolean,
 *   readonly now: string,
 *   readonly escapeHtml: (value: string) => string,
 *   readonly formatDate: (value: string) => string
 * }} LibraryRouteModel
 */

/** @param {LibraryRouteModel} model */
export function renderLibraryRoute(model) {
  validate(model);
  const tabs = `<nav class="section-tabs" aria-label="Library sections">
    <a href="#library" ${
    model.page === "collection" ? 'aria-current="page"' : ""
  }>Sources</a>
    <a href="#library/review-queue" ${
    model.page === "review-queue" ? 'aria-current="page"' : ""
  }>Review queue</a>
  </nav>`;
  return `<section class="wide-view" aria-labelledby="library-title">
    <div class="section-heading"><div><p class="eyebrow">Knowledge sources</p><h1 id="library-title">Library</h1></div></div>
    ${tabs}${
    model.page === "review-queue" ? renderQueue(model) : renderCollection(model)
  }
  </section>`;
}

/** @param {LibraryRouteModel} model */
function renderCollection(model) {
  const collection = model.collection;
  const search = `<div class="discover-controls"><form data-library-search>
    <label for="library-search">Search saved sources</label>
    <div><input id="library-search" name="query" type="search" value="${
    model.escapeHtml(collection.query)
  }" autocomplete="off" placeholder="Title, description, or topic" aria-describedby="library-search-help">
    <button class="button secondary" type="submit">Search</button></div>
    <p id="library-search-help">Combined search matches saved titles and descriptions by exact terms and related word forms.</p>
  </form></div>`;
  if (collection.state === "loading" && collection.items.length === 0) {
    return `${search}<div class="state-panel" aria-busy="true"><h2>Opening sources</h2><p>Loading your approved Library sources.</p></div>`;
  }
  if (collection.state === "error" || collection.state === "offline") {
    return `${search}<div class="state-panel" role="${
      collection.state === "error" ? "alert" : "status"
    }"><h2>${
      collection.state === "offline"
        ? "Library is offline"
        : "Library could not load"
    }</h2><p>${
      model.escapeHtml(collection.message ?? "Reconnect and try again.")
    }</p><button class="button secondary" type="button" data-library-retry>Try again</button></div>`;
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
  const areaById = new Map(
    collection.interestAreas.map((area) => [area.id, area]),
  );
  /** @type {Map<string, { readonly label: string, readonly items: LibrarySource[] }>} */
  const groups = new Map();
  for (const source of collection.items) {
    const ids = source.interestAreaIds.length === 0
      ? [""]
      : source.interestAreaIds;
    for (const id of ids) {
      const key = id === "" ? "unassigned" : id;
      const group = groups.get(key) ??
        /** @type {{ readonly label: string, readonly items: LibrarySource[] }} */ ({
          label: areaById.get(id)?.title ?? "Uncategorized",
          items: [],
        });
      group.items.push(source);
      groups.set(key, group);
    }
  }
  const content = [...groups.values()].map((group, index) =>
    `<section aria-labelledby="library-area-${index}"><h2 id="library-area-${index}">${
      model.escapeHtml(group.label)
    }</h2><div class="data-list">${
      group.items.map((source) => renderSource(model, source)).join("")
    }</div></section>`
  ).join("");
  const retainedNotice = collection.message === null
    ? ""
    : `<div class="discover-notice" role="status"><p>${
      model.escapeHtml(collection.message)
    }</p><button class="button secondary" type="button" data-library-retry>Refresh sources</button></div>`;
  const more = collection.nextCursor === null
    ? ""
    : `<div class="load-more" data-library-sentinel><button class="button secondary" type="button" data-library-load-more ${
      collection.state === "loading" ? "disabled" : ""
    }>${
      collection.state === "loading" ? "Loading..." : "Load more"
    }</button></div>`;
  return `${search}${retainedNotice}<div class="library-layout"><div>${content}${more}</div><aside class="data-controls"><h2>Source catalog</h2><p>Searches use sources already approved in your Library. Discovery is never called from this page.</p></aside></div>`;
}

/** @param {LibraryRouteModel} model @param {LibrarySource} source */
function renderSource(model, source) {
  const pending = model.collection.pendingSourceId === source.id;
  const capabilities = source.adapter.capabilities.join(", ");
  return `<article data-library-source="${
    model.escapeHtml(source.id)
  }"><div><p class="eyebrow">${model.escapeHtml(source.adapter.id)}</p><h3>${
    model.escapeHtml(source.title)
  }</h3><p>${model.escapeHtml(source.description)}</p><p>${
    model.escapeHtml(source.adapter.granularity)
  }${
    capabilities === "" ? "" : ` · ${model.escapeHtml(capabilities)}`
  }</p><p>Added ${
    model.formatDate(source.approvedAt)
  } · Policy assessment pending · Not yet refreshed</p><a href="${
    model.escapeHtml(source.canonicalUrl)
  }" target="_blank" rel="noopener noreferrer">Open original source</a></div><button class="button danger" type="button" data-library-disable="${
    model.escapeHtml(source.id)
  }" data-source-revision="${source.revision}" ${pending ? "disabled" : ""}>${
    pending ? "Removing..." : "Remove"
  }</button></article>`;
}

/** @param {LibraryRouteModel} model */
function renderQueue(model) {
  const generated = renderGeneratedReview(model);
  const scheduled = !model.recallAvailable
    ? `<div class="state-panel review-state"><h2>Review queue needs attention</h2><p>Your source catalog remains available. Open Review to recover incompatible scheduling history.</p><a class="button secondary" href="#review">Open Review</a></div>`
    : model.queue.length === 0
    ? `<div class="state-panel review-state"><h2>Scheduled review is empty</h2><p>Scheduled prompts will appear here after your first finalized recall.</p></div>`
    : `<ol class="queue-list">${
    model.queue.map((item) => {
      const due =
        item.dueAt === null || Date.parse(item.dueAt) <= Date.parse(model.now)
          ? "Due now"
          : `Next ${model.formatDate(item.dueAt)}`;
      return `<li class="queue-row"><div><strong>${
        model.escapeHtml(item.title)
      }</strong><span>${
        model.escapeHtml(due)
      } · ${item.reviewCount} reviews</span></div>${
        item.dueAt === null || Date.parse(item.dueAt) <= Date.parse(model.now)
          ? `<a class="button secondary" href="#review/scheduled/${
            encodeURIComponent(item.promptId)
          }">Review now</a>`
          : ""
      }</li>`;
    }).join("")
  }</ol>`;
  return `${generated}${scheduled}`;
}

/** @param {LibraryRouteModel} model */
function renderGeneratedReview(model) {
  const queue = model.reviewQueue;
  if (queue.state === "loading" || queue.state === "idle") {
    return `<div class="state-panel review-state" role="status" aria-busy="true"><h2>Preparing generated questions</h2><p>Checking whether questions are generating or ready for human review.</p></div>`;
  }
  if (queue.state === "error" || queue.state === "offline") {
    return `<div class="state-panel review-state" role="alert"><h2>Generated questions could not load</h2><p>${model.escapeHtml(queue.message ?? "Reconnect to check generation status and review items.")}</p></div>`;
  }
  const statusList = queue.sources.length === 0 ? "" : `<section class="review-generation-status" aria-labelledby="generated-status-title"><h2 id="generated-status-title">Question generation</h2><ul class="queue-list">${queue.sources.map((source) => `<li class="queue-row" data-generation-source="${model.escapeHtml(source.sourceId)}"><div><strong>${model.escapeHtml(source.title)}</strong><span data-generation-status="${model.escapeHtml(source.status)}">${model.escapeHtml(generationStatusText(source.status))}</span></div><span>${source.pendingTaskCount > 0 ? `${source.pendingTaskCount} awaiting review` : source.reviewedTaskCount > 0 ? `${source.reviewedTaskCount} reviewed` : "No questions ready yet"}</span></li>`).join("")}</ul></section>`;
  const tasks = queue.tasks.length === 0 ? "" : `<section class="generated-review-tasks" aria-labelledby="generated-review-title"><h2 id="generated-review-title">Human review required</h2><p>Keep the questions that are grounded and useful. Discard the rest before they enter study.</p><div class="data-list">${queue.tasks.map((task) => renderGeneratedTask(model, task, queue.pendingTaskId)).join("")}</div></section>`;
  const waiting = queue.sources.some((source) => source.status === "queued" || source.status === "generating");
  if (statusList === "" && tasks === "") return `<div class="state-panel review-state"><h2>No generated questions yet</h2><p>Approve an eligible source in Discover. Questions will appear here after automatic generation and human review preparation.</p></div>`;
  return `${statusList}${tasks}${waiting ? `<div class="discover-notice" role="status"><p>Questions generating soon. They will require human review afterward.</p></div>` : ""}`;
}

/** @param {LibraryRouteModel} model @param {LearningReviewQueueTask} task @param {string | null} pendingTaskId */
function renderGeneratedTask(model, task, pendingTaskId) {
  const choices = task.choices === null ? "" : `<ul>${task.choices.map((/** @type {LearningChoice} */ choice) => `<li>${model.escapeHtml(choice.label)}${task.correctChoiceIds?.includes(choice.id) ? " · expected" : ""}</li>`).join("")}</ul>`;
  const concepts = task.expectedConcepts === null ? "" : `<p>Expected concepts: ${model.escapeHtml(task.expectedConcepts.join(", "))}</p>`;
  const stimulus = task.stimulus === null ? "" : `<details><summary>Symbolic stimulus</summary><pre>${model.escapeHtml(typeof task.stimulus === "string" ? task.stimulus : JSON.stringify(task.stimulus))}</pre></details>`;
  return `<article class="data-card generated-review-card" data-generated-review-task="${model.escapeHtml(task.id)}"><p class="eyebrow">${model.escapeHtml(task.kind)}</p><h3>${model.escapeHtml(task.prompt)}</h3>${choices}${concepts}${stimulus}<p>Evidence anchors: ${model.escapeHtml(task.sourceAnchorIds.join(", "))}</p><p>${model.escapeHtml(task.explanation)}</p><div class="button-row"><button class="button" type="button" data-learning-review-decision="approve" data-learning-task-id="${model.escapeHtml(task.id)}" data-learning-task-revision="${task.revision}" ${pendingTaskId !== null ? "disabled" : ""}>${pendingTaskId === task.id ? "Keeping..." : "Keep"}</button><button class="button secondary" type="button" data-learning-review-decision="reject" data-learning-task-id="${model.escapeHtml(task.id)}" data-learning-task-revision="${task.revision}" ${pendingTaskId !== null ? "disabled" : ""}>${pendingTaskId === task.id ? "Deciding..." : "Discard"}</button></div></article>`;
}

/** @param {LearningReviewQueueStatus} status */
function generationStatusText(status) {
  if (status === "queued") return "Questions generating soon; human review will follow.";
  if (status === "generating") return "Questions are being generated; human review will follow.";
  if (status === "ready-for-review") return "Questions generated; human review required.";
  if (status === "reviewed") return "Review complete; approved questions can enter study.";
  if (status === "failed") return "Generation needs attention; the source remains available.";
  return "Automatic question generation is unavailable for this source.";
}

/** @param {LibraryRouteModel} model */
function validate(model) {
  if (model.page !== "collection" && model.page !== "review-queue") {
    throw new TypeError("Library page is invalid.");
  }
  if (
    !Array.isArray(model.collection.items) ||
    !Array.isArray(model.collection.interestAreas) ||
    !Array.isArray(model.queue) || !Array.isArray(model.reviewQueue.sources) ||
    !Array.isArray(model.reviewQueue.tasks) || typeof model.escapeHtml !== "function" ||
    typeof model.formatDate !== "function"
  ) throw new TypeError("Library model is invalid.");
}

export {};
