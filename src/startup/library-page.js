// @ts-check

import { SourceLibraryGatewayClient } from "../features/source-library/gateway.js";
import { LearningGenerationBrowserGatewayClient } from "../features/learning-generation/browser-gateway.js";
import { renderLibraryRoute } from "../routes/library.js";

/** @import { LibrarySource, SourceInterestArea, SourceSearchMode } from "../features/source-library/contracts.js" */
/** @import { LearningReviewQueue, LearningReviewQueueSource, LearningReviewQueueTask } from "../features/learning-generation/contracts.js" */

const freeze = Object.freeze;

/** @typedef {{ readonly observe: (element: Element) => void, readonly disconnect: () => void }} PageObserver */
/** @typedef {{ readonly queue: readonly { readonly promptId: string, readonly title: string, readonly dueAt: string | null, readonly reviewCount: number }[], readonly page: "collection" | "review-queue", readonly recallAvailable: boolean, readonly now: string }} LibraryQueueModel */
/** @typedef {{ readonly state: "idle" | "loading" | "success" | "error" | "offline", readonly sources: LearningReviewQueue["sources"], readonly tasks: LearningReviewQueueTask[], readonly message: string | null, readonly pendingTaskId: string | null }} ReviewQueueState */

/**
 * @param {{
 *   readonly fetch: typeof fetch,
 *   readonly gatewayBaseUrl: string,
 *   readonly escapeHtml: (value: string) => string,
 *   readonly formatDate: (value: string) => string,
 *   readonly createId: () => string,
 *   readonly now: () => string,
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
    typeof dependencies.now !== "function" ||
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
  const learningGateway = new LearningGenerationBrowserGatewayClient({
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
  /** @type {SourceSearchMode} */ let mode = "combined";
  /** @type {string | null} */ let message = null;
  /** @type {string | null} */ let pendingSourceId = null;
  /** @type {ReviewQueueState} */ let reviewQueue = { state: "idle", sources: [], tasks: [], message: null, pendingTaskId: null };
  /** @type {Promise<void> | null} */ let read = null;
  /** @type {Promise<void> | null} */ let reviewRead = null;
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
    if (
      typeof rawQuery !== "string"
    ) return;
    const priorQuery = query;
    const priorMode = mode;
    query = rawQuery.trim();
    mode = "combined";
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

  async function loadReviewQueue() {
    if (reviewRead !== null) return await reviewRead;
    reviewQueue = { ...reviewQueue, state: "loading", message: null };
    dependencies.rerender();
    reviewRead = (async () => {
      const result = await learningGateway.listQueue();
      if (!result.ok) {
        reviewQueue = { ...reviewQueue, state: result.error.kind === "LearningGatewayUnavailable" || result.error.kind === "LearningGatewayTimedOut" ? "offline" : "error", message: friendlyLearning(result.error) };
        return;
      }
      reviewQueue = { state: "success", sources: [...result.value.sources], tasks: [...result.value.tasks], message: null, pendingTaskId: null };
    })().finally(() => {
      reviewRead = null;
      dependencies.rerender();
    });
    return await reviewRead;
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

  /** @param {HTMLButtonElement} button */
  async function decideReview(button) {
    const taskId = button.getAttribute("data-learning-task-id");
    const revision = Number(button.getAttribute("data-learning-task-revision"));
    const decision = button.getAttribute("data-learning-review-decision");
    if (taskId === null || !Number.isInteger(revision) || revision < 1 || (decision !== "approve" && decision !== "reject") || reviewQueue.pendingTaskId !== null) return;
    reviewQueue = { ...reviewQueue, pendingTaskId: taskId };
    dependencies.rerender();
    const result = await learningGateway.decide({ taskId, expectedRevision: revision, decision, reviewedAt: dependencies.now(), idempotencyKey: `learning-review:${dependencies.createId()}` });
    if (!result.ok) {
      reviewQueue = { ...reviewQueue, pendingTaskId: null };
      dependencies.onError(friendlyLearning(result.error));
    } else {
      const task = reviewQueue.tasks.find((candidate) => candidate.id === taskId);
      reviewQueue = { ...reviewQueue, pendingTaskId: null, tasks: reviewQueue.tasks.filter((candidate) => candidate.id !== taskId), sources: reviewQueue.sources.map((/** @type {LearningReviewQueueSource} */ source) => source.sourceId !== task?.sourceId ? source : { ...source, pendingTaskCount: Math.max(0, source.pendingTaskCount - 1), reviewedTaskCount: source.reviewedTaskCount + 1, status: source.pendingTaskCount > 1 ? "ready-for-review" : "reviewed" }) };
      dependencies.onNotice(decision === "approve" ? "Question kept and published to study after review." : "Question discarded; it will not enter study.");
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
    root.querySelectorAll("[data-learning-review-decision]").forEach((element) =>
      element.addEventListener("click", () => {
        if (element instanceof HTMLButtonElement) void decideReview(element);
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
      reviewQueue,
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

  return freeze({ load, loadReviewQueue, bind, render });
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

/** @param {import("../features/learning-generation/browser-gateway.js").LearningGatewayFailure} failure */
function friendlyLearning(failure) {
  if (failure.kind === "LearningGatewayUnavailable" || failure.kind === "LearningGatewayTimedOut") return "Reconnect to check generated questions and human review status.";
  if (failure.kind === "LearningGatewayUnauthenticated" || failure.kind === "LearningGatewayUnauthorized") return "Sign in through the private source service to review generated questions.";
  if (failure.kind === "LearningGatewayRejected" && failure.failureKind === "LearningReviewRevisionStale") return "This question changed elsewhere. Refresh the Review queue before deciding.";
  return "Generated questions could not be loaded or reviewed. The source remains in your Library.";
}

/** @param {readonly LibrarySource[]} current @param {readonly LibrarySource[]} next */
function merge(current, next) {
  const merged = new Map(current.map((source) => [source.id, source]));
  for (const source of next) merged.set(source.id, source);
  return [...merged.values()];
}

export {};
