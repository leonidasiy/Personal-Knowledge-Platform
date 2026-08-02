// @ts-check

import { SourceLibraryGatewayClient } from "../features/source-library/gateway.js";
import { renderLibraryRoute } from "../routes/library.js";

/** @import { LibrarySource, SourceInterestArea, SourceSearchMode } from "../features/source-library/contracts.js" */

const freeze = Object.freeze;

/** @typedef {{ readonly observe: (element: Element) => void, readonly disconnect: () => void }} PageObserver */
/** @typedef {{ readonly queue: readonly { readonly promptId: string, readonly title: string, readonly dueAt: string | null, readonly reviewCount: number }[], readonly page: "collection" | "review-queue", readonly recallAvailable: boolean, readonly now: string }} LibraryQueueModel */

/**
 * @param {{
 *   readonly fetch: typeof fetch,
 *   readonly gatewayBaseUrl: string,
 *   readonly escapeHtml: (value: string) => string,
 *   readonly formatDate: (value: string) => string,
 *   readonly createId: () => string,
 *   readonly confirmDisable: (source: LibrarySource) => boolean,
 *   readonly createObserver: (load: () => void) => PageObserver | null,
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
    typeof dependencies.onNotice !== "function" ||
    typeof dependencies.onError !== "function" ||
    typeof dependencies.rerender !== "function"
  ) {
    throw new TypeError("Library page dependencies are invalid.");
  }
  const gateway = new SourceLibraryGatewayClient({
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
  /** @type {SourceSearchMode} */ let mode = "keyword";
  /** @type {string | null} */ let message = null;
  /** @type {string | null} */ let pendingSourceId = null;
  /** @type {Promise<void> | null} */ let read = null;
  /** @type {PageObserver | null} */ let observer = null;

  const collection = () =>
    freeze({
      state,
      items: freeze([...items]),
      interestAreas: freeze([...interestAreas]),
      nextCursor,
      query,
      mode,
      pendingSourceId,
      message,
    });

  async function load(reset = true) {
    if (read !== null) return await read;
    read = (async () => {
      if (reset) {
        state = "loading";
        items = [];
        nextCursor = null;
        message = null;
        dependencies.rerender();
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
    })().finally(() => {
      read = null;
      dependencies.rerender();
    });
    return await read;
  }

  /** @param {HTMLFormElement} form */
  async function search(form) {
    if (read !== null) return;
    const data = new FormData(form);
    const rawQuery = data.get("query");
    const rawMode = data.get("mode");
    if (
      typeof rawQuery !== "string" ||
      (rawMode !== "keyword" && rawMode !== "semantic" &&
        rawMode !== "combined")
    ) return;
    const priorQuery = query;
    const priorMode = mode;
    query = rawQuery.trim();
    mode = rawMode;
    if (query === "") return await load(true);
    state = "loading";
    message = null;
    dependencies.rerender();
    read = (async () => {
      const result = await gateway.search({ query, mode, limit: 50 });
      if (!result.ok) {
        query = priorQuery;
        mode = priorMode;
        return setFailure(result.error, items.length > 0);
      }
      items = result.value.map((hit) => hit.source);
      nextCursor = null;
      state = items.length === 0 ? "empty" : "success";
    })().finally(() => {
      read = null;
      dependencies.rerender();
    });
    await read;
  }

  /** @param {HTMLButtonElement} button */
  async function disable(button) {
    const sourceId = button.getAttribute("data-library-disable");
    const revision = Number(button.getAttribute("data-source-revision"));
    const source = items.find((candidate) => candidate.id === sourceId);
    if (
      source === undefined || !Number.isInteger(revision) ||
      pendingSourceId !== null || !dependencies.confirmDisable(source)
    ) return;
    pendingSourceId = source.id;
    dependencies.rerender();
    const result = await gateway.disable({
      sourceId: source.id,
      expectedRevision: revision,
      idempotencyKey: `disable:${dependencies.createId()}`,
    });
    pendingSourceId = null;
    if (!result.ok) {
      dependencies.onError(friendly(result.error));
    } else {
      items = items.filter((candidate) => candidate.id !== source.id);
      state = items.length === 0 ? "empty" : "success";
      dependencies.onNotice(
        "Source removed from future ingestion and Feed selection. Study and review history is preserved.",
      );
    }
    dependencies.rerender();
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
        if (element instanceof HTMLButtonElement) void disable(element);
      })
    );
    const sentinel = root.querySelector("[data-library-sentinel]");
    if (sentinel !== null && nextCursor !== null && read === null) {
      observer = dependencies.createObserver(() => void load(false));
      observer?.observe(sentinel);
    }
  }

  /** @param {LibraryQueueModel} queue */
  function render(queue) {
    return renderLibraryRoute({
      collection: collection(),
      ...queue,
      escapeHtml: dependencies.escapeHtml,
      formatDate: dependencies.formatDate,
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

  return freeze({ load, bind, render });
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
    return "Semantic search is not available on this device yet. Choose Keyword search.";
  }
  if (
    failure.kind === "SourceGatewayRejected" &&
    failure.failureKind === "SourceRevisionStale"
  ) {
    return "This source changed elsewhere. Reload the Library before removing it.";
  }
  return "The source catalog could not complete this request.";
}

/** @param {readonly LibrarySource[]} current @param {readonly LibrarySource[]} next */
function merge(current, next) {
  const merged = new Map(current.map((source) => [source.id, source]));
  for (const source of next) merged.set(source.id, source);
  return [...merged.values()];
}

export {};
