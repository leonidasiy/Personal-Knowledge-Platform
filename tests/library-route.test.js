// @ts-check

import { renderLibraryRoute } from "../src/routes/library.js";
import { createLibraryPage } from "../src/startup/library-page.js";

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = Object.freeze({
  id: "source-a",
  ownerId: "owner-a",
  submittedUrl: "https://publisher.example/learn",
  canonicalUrl: "https://publisher.example/learn",
  title: "Harmony source",
  description: "Lessons on harmonic motion.",
  adapter: Object.freeze({
    id: "publisher adapter",
    version: "1",
    granularity: "course root",
    capabilities: Object.freeze(["metadata", "bounded pages"]),
  }),
  interestAreaIds: Object.freeze(["area-a"]),
  identityEvidence: Object.freeze([]),
  state: /** @type {const} */ ("active"),
  approvedAt: "2026-07-22T08:00:00.000Z",
  updatedAt: "2026-07-22T08:00:00.000Z",
  revision: 2,
});

/** @returns {import("../src/routes/library.js").LibraryRouteModel} */
function baseModel() {
  return {
    collection: {
      state: /** @type {const} */ ("success"),
      items: [source],
      interestAreas: [{
        id: "area-a",
        ownerId: "owner-a",
        title: "Music",
        provenance: "configured",
      }],
      nextCursor: "signed",
      query: "",
      mode: /** @type {const} */ ("combined"),
      pendingSourceId: null,
      message: null,
    },
    queue: [],
    reviewQueue: {
      state: /** @type {const} */ ("success"),
      sources: [],
      tasks: [],
      message: null,
      pendingTaskId: null,
    },
    page: /** @type {const} */ ("collection"),
    recallAvailable: true,
    now: "2026-07-22T09:00:00.000Z",
    escapeHtml: (value) =>
      value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll(
        "<",
        "&lt;",
      ),
    formatDate: () => "Jul 22, 2026",
  };
}

Deno.test("Library renders grouped source search, provenance, progressive reveal, and removal", () => {
  const html = renderLibraryRoute(baseModel());
  for (
    const expected of [
      "Search saved sources",
      "Combined",
      "Music",
      "Harmony source",
      "Open original source",
      "data-library-disable",
      "data-library-load-more",
      "Policy assessment pending",
    ]
  ) {
    assert(html.includes(expected), `Missing ${expected}.`);
  }
  assert(
    html.includes('target="_blank" rel="noopener noreferrer"'),
    "External source link must be isolated.",
  );
  assert(
    !html.includes("Erase local data"),
    "Legacy browser collection controls must be retired.",
  );
  assert(
    !html.includes("Studied ·"),
    "Source catalog must not masquerade as lesson status.",
  );
  assert(
    !html.includes('name="mode"'),
    "Library must not expose a search-method selector.",
  );
});

Deno.test("Library preserves a dedicated scheduled Review queue subpage", () => {
  const html = renderLibraryRoute({
    ...baseModel(),
    page: "review-queue",
    queue: [{
      promptId: "prompt-a",
      title: "Cadential motion",
      dueAt: null,
      reviewCount: 3,
    }],
  });
  assert(
    html.includes('aria-current="page">Review queue'),
    "Queue tab must be current.",
  );
  assert(
    html.includes("Cadential motion"),
    "Scheduled prompt must remain visible.",
  );
  assert(
    html.includes("#review/scheduled/prompt-a"),
    "Queue must link to the focused review.",
  );
});

Deno.test("Library Review queue explains automatic generation and exposes human Keep/Discard controls", () => {
  const html = renderLibraryRoute({
    ...baseModel(),
    page: "review-queue",
    reviewQueue: {
      state: "success",
      sources: [{ sourceId: "source-a", title: "Harmony source", status: "ready-for-review", generationId: "generation-a", pendingTaskCount: 1, reviewedTaskCount: 0, failureKind: null }],
      tasks: [{ id: "task-a", sourceId: "source-a", kind: "short-response", prompt: "Explain the cadence.", explanation: "The cited unit supports this.", sourceAnchorIds: ["unit-a:anchor"], choices: null, correctChoiceIds: null, expectedConcepts: ["cadence"], minimumWords: 1, stimulus: null, responseKind: "text", status: "pending-review", revision: 1 }],
      message: null,
      pendingTaskId: null,
    },
  });
  for (const expected of ["Questions generated; human review required", "Explain the cadence.", "Keep", "Discard", "unit-a:anchor", "data-learning-review-decision=\"approve\"", "data-learning-review-decision=\"reject\""]) assert(html.includes(expected), `Missing ${expected}.`);
});

Deno.test("Library Review queue keeps the pending status truthful while generation is queued", () => {
  const html = renderLibraryRoute({
    ...baseModel(),
    page: "review-queue",
    reviewQueue: {
      state: "success",
      sources: [{ sourceId: "source-a", title: "Harmony source", status: "queued", generationId: null, pendingTaskCount: 0, reviewedTaskCount: 0, failureKind: null }],
      tasks: [],
      message: null,
      pendingTaskId: null,
    },
  });
  assert(html.includes("Questions generating soon"), "Queued status must be explicit.");
  assert(html.includes("require human review afterward"), "Queue must set the review expectation.");
  assert(!html.includes("Review queue is empty"), "Queued generation must not look empty.");
});

Deno.test("Library controller distinguishes empty catalog from unavailable service", async () => {
  let response = Response.json({
    result: { items: [], interestAreas: [], nextCursor: null },
  });
  const page = createLibraryPage({
    fetch: () => Promise.resolve(response.clone()),
    gatewayBaseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    formatDate: (value) => value,
    createId: () => "id-a",
    now: () => "2026-07-22T09:00:00.000Z",
    confirmDisable: () => true,
    createObserver: () => null,
    onNotice: () => {},
    onError: () => {},
    rerender: () => {},
  });
  await page.load();
  const queue = {
    queue: [],
    page: /** @type {const} */ ("collection"),
    recallAvailable: true,
    now: "2026-07-22T09:00:00.000Z",
  };
  assert(
    page.render(queue).includes("No sources yet"),
    "Empty state must be truthful.",
  );

  response = Response.json({ error: "SourceCatalogReadFailed" }, {
    status: 503,
  });
  await page.load();
  const error = page.render(queue);
  assert(
    error.includes("Library could not load"),
    "Read failure must not render as empty.",
  );
  assert(error.includes("Try again"), "Read failure must remain actionable.");
});

Deno.test("Library controller loads generated review status independently of the source catalog", async () => {
  const queue = { sources: [{ sourceId: "source-a", title: "Harmony source", status: "queued", generationId: null, pendingTaskCount: 0, reviewedTaskCount: 0, failureKind: null }], tasks: [] };
  const page = createLibraryPage({
    fetch: (input) => {
      const path = new URL(String(input)).pathname;
      return Promise.resolve(path.endsWith("review-queue") ? Response.json({ result: queue }) : Response.json({ result: { items: [source], interestAreas: [], nextCursor: null } }));
    },
    gatewayBaseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    formatDate: (value) => value,
    createId: () => "id-a",
    now: () => "2026-07-22T09:00:00.000Z",
    confirmDisable: () => true,
    createObserver: () => null,
    onNotice: () => {},
    onError: () => {},
    rerender: () => {},
  });
  await page.load();
  await page.loadReviewQueue();
  const html = page.render({ queue: [], page: "review-queue", recallAvailable: true, now: "2026-07-22T09:00:00.000Z" });
  assert(html.includes("Questions generating soon"), "Controller must expose queued generation status.");
  assert(html.includes("Harmony source"), "Controller must preserve source title in the status projection.");
});

Deno.test("Library retains prior pages when a continuation fails", async () => {
  let call = 0;
  const page = createLibraryPage({
    fetch: () => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? Response.json({
            result: {
              items: [source],
              interestAreas: [{
                id: "area-a",
                ownerId: "owner-a",
                title: "Music",
                provenance: "configured",
              }],
              nextCursor: "signed-next",
            },
          })
          : Response.json({ error: "SourceCursorStale" }, { status: 409 }),
      );
    },
    gatewayBaseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    formatDate: (value) => value,
    createId: () => "id-a",
    now: () => "2026-07-22T09:00:00.000Z",
    confirmDisable: () => true,
    createObserver: () => null,
    onNotice: () => {},
    onError: () => {},
    rerender: () => {},
  });
  await page.load();
  await page.load(false);
  const html = page.render({
    queue: [],
    page: "collection",
    recallAvailable: true,
    now: "2026-07-22T09:00:00.000Z",
  });
  assert(
    html.includes("Harmony source"),
    "Loaded sources must remain visible.",
  );
  assert(
    html.includes("Previously loaded sources remain below"),
    "The retained page must disclose its stale state.",
  );
  assert(
    html.includes("Refresh sources"),
    "A stale continuation must offer a reset action.",
  );
});

Deno.test("Library gives dynamic area landmarks unique IDs", () => {
  const model = baseModel();
  const html = renderLibraryRoute({
    ...model,
    collection: {
      ...model.collection,
      items: [
        source,
        { ...source, id: "source-b", interestAreaIds: ["area-b"] },
      ],
      interestAreas: [
        ...model.collection.interestAreas,
        {
          id: "area-b",
          ownerId: "owner-a",
          title: "Music",
          provenance: "configured",
        },
      ],
    },
  });
  assert(
    html.includes('id="library-area-0"') &&
      html.includes('id="library-area-1"'),
    "Equal dynamic labels must retain distinct landmarks.",
  );
});
