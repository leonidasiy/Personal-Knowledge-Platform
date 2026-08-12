// @ts-check

/** @import { LibrarySource, SourceInterestArea, SourceSearchMode } from "../features/source-library/contracts.js" */

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
  if (!model.recallAvailable) {
    return `<div class="state-panel review-state"><h2>Review queue needs attention</h2><p>Your source catalog remains available. Open Review to recover incompatible scheduling history.</p><a class="button secondary" href="#review">Open Review</a></div>`;
  }
  if (model.queue.length === 0) {
    return `<div class="state-panel review-state"><h2>Review queue is empty</h2><p>Scheduled prompts will appear here after your first finalized recall.</p></div>`;
  }
  return `<ol class="queue-list">${
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
}

/** @param {LibraryRouteModel} model */
function validate(model) {
  if (model.page !== "collection" && model.page !== "review-queue") {
    throw new TypeError("Library page is invalid.");
  }
  if (
    !Array.isArray(model.collection.items) ||
    !Array.isArray(model.collection.interestAreas) ||
    !Array.isArray(model.queue) || typeof model.escapeHtml !== "function" ||
    typeof model.formatDate !== "function"
  ) throw new TypeError("Library model is invalid.");
}

export {};
