import { renderLibraryRoute } from "../src/routes/library.js";
import { createLibraryPage } from "../src/startup/library-page.js";
import { SUBJECTS } from "../src/features/knowledge-subjects/public.js";

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
      pendingSourceId: null,
      message: null,
    },
    escapeHtml: (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    formatDate: () => "Jul 22, 2026",
  };
}

const sourceB = Object.freeze({
  ...source,
  id: "source-b",
  title: "Rhythm source",
  interestAreaIds: Object.freeze(["area-a"]),
});

Deno.test("Library shelves default to newest subject and sort newest first with stable ties", () => {
  const newer = { ...sourceB, approvedAt: "2026-09-19T08:00:00.000Z" };
  const tied = { ...newer, id: "source-c" };
  const knowledge = [source, newer, tied].map((item, i) => ({ knowledgeId: `k${i}`, sourceId: item.id, summary: "A retained idea.", questionLocked: true, primarySubject: SUBJECTS[i === 0 ? 0 : 1].id }));
  const model = { ...baseModel(), collection: { ...baseModel().collection, items: [source, newer, tied] }, knowledge };
  const html = renderLibraryRoute(model);
  assert(html.includes(`value="${SUBJECTS[1].id}" selected`), "Default shelf must follow the newest source, not incoming array order.");
  assert(!html.includes('data-library-source="source-a"'), "Other subjects must not be stacked into the selected shelf.");
  assert(html.indexOf('data-library-source="source-c"') < html.indexOf('data-library-source="source-b"'), "Tied dates need stable descending source identity.");
  const sameSubject = renderLibraryRoute({ ...model, knowledge: knowledge.map(point => ({ ...point, primarySubject: SUBJECTS[1].id })) });
  assert(sameSubject.indexOf('data-library-source="source-b"') < sameSubject.indexOf('data-library-source="source-a"'), "Newer dates must precede older sources.");
  assert(html.includes('data-reveal="source:source-b"'), "Source cards must participate in progressive reveal.");
});

Deno.test("Library sources appear on each represented primary subject and legacy sources only on Unclassified", () => {
  const knowledge = SUBJECTS.slice(0, 2).map((subject, i) => ({ knowledgeId: `k${i}`, sourceId: source.id, summary: "A retained idea.", questionLocked: true, primarySubject: subject.id }));
  for (const selected of [SUBJECTS[0].id, SUBJECTS[1].id, "unclassified", SUBJECTS[2].id]) {
    const html = renderLibraryRoute({ ...baseModel(), collection: { ...baseModel().collection, subject: selected, items: [source, sourceB] }, knowledge });
    assert(html.includes('data-library-source="source-a"') === [SUBJECTS[0].id, SUBJECTS[1].id].includes(selected), "A multi-subject source belongs to both matching shelves only.");
    assert(html.includes('data-library-source="source-b"') === (selected === "unclassified"), "Legacy source needs its explicit neutral shelf.");
    if (selected === SUBJECTS[2].id) assert(html.includes("No loaded sources in this subject"), "An empty selected shelf must offer recovery.");
  }
  let rejected = false;
  try { renderLibraryRoute({ ...baseModel(), collection: { ...baseModel().collection, subject: "invented-subject" } }); } catch (error) { rejected = error instanceof TypeError; }
  assert(rejected, "Unknown selected subjects must fail validation.");
});

Deno.test("Library restores subject selection and reports unavailable or invalid stored preferences", async () => {
  for (const stored of [SUBJECTS[1].id, "unclassified", "invalid", "throws", null]) {
    const errors = /** @type {string[]} */ ([]);
    const page = createLibraryPage({
      fetch: async input => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/source-library")) return Response.json({ result: { items: [source, sourceB], interestAreas: [], nextCursor: null } });
        if (path.endsWith("/library-knowledge")) return Response.json({ result: { items: [source, sourceB].map((item, i) => ({ knowledgeId: `k${i}`, sourceId: item.id, questionId: `q${i}`, title: item.title, summary: "A useful idea.", sourceUrl: item.canonicalUrl, evidenceAnchorIds: ["anchor"], media: null, questionLocked: true, classification: { version: 1, primarySubject: SUBJECTS[i].id, secondarySubjects: [], subcategory: "Source context" }, classificationRevision: 0 })) } });
        if (path.endsWith("/source-status")) return Response.json({ result: { sourceId: new URL(String(input)).searchParams.get("sourceId"), run: null, reasonCode: null, message: null } });
        throw new Error(`Unexpected fixture path: ${path}`);
      },
      storage: { getItem: key => { assert(key === "resonance-library-subject", "Use the documented preference key."); if (stored === "throws") throw new Error("Synthetic storage denial"); return stored; }, setItem: () => { throw new Error("Reading must not write preferences"); } },
      gatewayBaseUrl: "https://app.example/", escapeHtml: value => value, formatDate: value => value, createId: () => "id", confirmDisable: () => true,
      createObserver: () => null, schedule: () => 1, cancel: () => {}, onNotice: () => {}, onError: message => errors.push(message), rerender: () => {},
    });
    await page.load();
    const selected = stored === "unclassified" ? stored : SUBJECTS[1].id;
    assert(page.render({}).includes(`value="${selected}" selected`), "Valid saved choice or newest-source default must be selected.");
    assert(errors.length === (stored === "throws" || stored === "invalid" ? 1 : 0), "Invalid and inaccessible preferences need an explicit notice, missing storage does not.");
  }
});

Deno.test("Library offers authorized material upload only for an awaiting-upload source", () => {
  const html = renderLibraryRoute({ ...baseModel(), workflowStatuses: [workflowStatus("awaiting-upload")] });
  assert(html.includes('data-library-upload="source-a"'), "Blocked existing sources need a usable upload form.");
  assert(html.includes('name="content"') && html.includes('name="file"'), "Both pasted text and documents must be offered.");
  assert(html.includes('name="attested"') && html.includes("AI processing"), "Upload must require informed processing attestation.");
  for (const state of ["completed", "extraction-loop", "abandoned"]) {
    assert(!renderLibraryRoute({ ...baseModel(), workflowStatuses: [workflowStatus(state)] }).includes('data-library-upload="source-a"'), `${state} must not offer a conflicting source attachment.`);
  }
});

Deno.test("Library offers private document creation without an existing source", async () => {
  assert(renderLibraryRoute({ ...baseModel(), collection: { ...baseModel().collection, items: [], state: "empty" } }).includes('data-library-upload=""'), "An empty Library must support standalone uploads.");
  const uploadForm = renderLibraryRoute({ ...baseModel(), collection: { ...baseModel().collection, items: [], state: "empty" } });
  assert(uploadForm.includes('type="checkbox" name="imageProcessing"') && !uploadForm.includes('name="imageProcessing" checked') && uploadForm.includes('name="pageRange"') && uploadForm.includes('name="file" multiple'), "Image processing must be an unchecked option with PDF ranges and multi-file selection.");
  const documentSource = { ...source, id: "private-source", origin: "private-document", canonicalUrl: "https://app.example/api/private-documents/private-source", submittedUrl: "https://app.example/api/private-documents/private-source" };
  const requests = /** @type {string[]} */ ([]);
  let fail = true;
  const page = createLibraryPage({
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/private-documents")) {
        requests.push("create");
        return Response.json({ result: { source: documentSource, runId: "private-run", reused: requests.filter((v) => v === "create").length > 1 } });
      }
      if (url.pathname.endsWith("/material")) {
        requests.push("upload");
        if (!(init?.body instanceof FormData)) throw new Error("A private file must use multipart.");
        assert(init.body.get("sourceId") === documentSource.id && init.body.get("runId") === "private-run", "Private upload must use its own source/run.");
        return fail ? Response.json({ error: "WorkflowMaterialStorageFailed" }, { status: 503 }) : Response.json({ result: { status: "attached", materialId: "material-private", runId: "private-run", reused: false } });
      }
      if (url.pathname.endsWith("/source-status")) return Response.json({ result: workflowStatus("awaiting-upload", documentSource.id) });
      throw new Error(`Unexpected ${url.pathname}`);
    },
    gatewayBaseUrl: "https://app.example/", escapeHtml: (value) => value, formatDate: (value) => value, createId: () => "doc-id", confirmDisable: () => true,
    createObserver: () => null, schedule: () => 1, cancel: () => {}, onNotice: () => {}, onError: () => {}, rerender: () => {},
  });
  const form = new FormData();
  form.set("file", new File(["Synthetic authorized notes"], "lecture.txt"));
  await page.uploadMaterial("", form);
  assert(requests.length === 0, "No source or content may be created before attestation.");
  form.set("attested", "on");
  await page.uploadMaterial("", form);
  fail = false;
  await page.uploadMaterial("", form);
  assert(requests.join(",") === "create,upload,create,upload", "A failed attachment must retry the idempotent creation and upload steps.");
});

Deno.test("Library uploads validated material to its persisted run and preserves retry after failure", async () => {
  /** @type {RequestInit[]} */ const uploads = [];
  /** @type {string[]} */ const errors = [];
  let failUpload = true;
  const page = createLibraryPage({
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/source-library")) return Response.json({ result: { items: [source], interestAreas: [], nextCursor: null } });
      if (url.pathname.endsWith("/library-knowledge")) return Response.json({ result: { items: [] } });
      if (url.pathname.endsWith("/source-status")) return Response.json({ result: workflowStatus("awaiting-upload") });
      if (url.pathname.endsWith("/material")) {
        uploads.push(init ?? {});
        return failUpload ? Response.json({ error: "WorkflowMaterialStorageFailed" }, { status: 503 }) : Response.json({ result: { status: "attached", materialId: "material-a", runId: "run-source-a", reused: false } });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    },
    gatewayBaseUrl: "https://app.example/", escapeHtml: (value) => value,
    formatDate: (value) => value, createId: () => "upload-id", confirmDisable: () => true,
    createObserver: () => null, schedule: () => 1, cancel: () => {},
    onNotice: () => {}, onError: (message) => errors.push(message), rerender: () => {},
  });
  await page.load();
  const form = new FormData();
  form.set("content", "A synthetic source explains a musical relation.");
  await page.uploadMaterial("source-a", form);
  assert(uploads.length === 0, "Unattested content must not be transmitted.");
  form.set("attested", "on");
  await page.uploadMaterial("unknown-source", form);
  assert(uploads.length === 0, "Unknown sources must not be transmitted.");
  await page.uploadMaterial("source-a", form);
  assert(uploads.length === 1 && errors.length > 0, "Storage failure must be reported.");
  assert(page.render({}).includes("data-library-upload"), "Failure must leave a retry action available.");
  const body = JSON.parse(String(uploads[0].body));
  assert(body.runId === "run-source-a" && body.sourceId === source.id && body.sourceRevision === source.revision && body.sourceUrl === source.canonicalUrl, "Upload must use the loaded source/run binding.");
  assert(!Object.hasOwn(body, "ownerId"), "The server owns authentication identity.");
  failUpload = false;
  await page.uploadMaterial("source-a", form);
  assert(uploads.length === 2, "A failed upload must remain retryable.");
  form.set("file", new File(["synthetic document"], "notes.txt", { type: "text/plain" }));
  await page.uploadMaterial("source-a", form);
  assert(uploads.length === 2, "Ambiguous pasted and file content must not be selected silently.");
  form.delete("content");
  await page.uploadMaterial("source-a", form);
  assert(uploads.length === 3 && uploads[2].body instanceof FormData, "Documents must use the existing multipart transport.");
  form.set("file", new File(["unsupported"], "archive.zip", { type: "application/zip" }));
  await page.uploadMaterial("source-a", form);
  assert(uploads.length === 3, "Unsupported formats must fail before transmission.");
});

Deno.test("Library image option is off by default and batches selected raster files only when enabled", async () => {
  /** @type {FormData[]} */ const uploads = [];
  const page = createLibraryPage({
    fetch: async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/source-library")) return Response.json({ result: { items: [source], interestAreas: [], nextCursor: null } });
      if (pathname.endsWith("/library-knowledge")) return Response.json({ result: { items: [] } });
      if (pathname.endsWith("/source-status")) return Response.json({ result: workflowStatus("awaiting-upload") });
      if (pathname.endsWith("/material")) {
        if (!(init?.body instanceof FormData)) throw new Error("Expected multipart image upload.");
        uploads.push(init.body);
        return Response.json({ result: { status: "attached", materialId: "material-images", runId: "run-source-a", reused: false } });
      }
      throw new Error(`Unexpected ${pathname}`);
    },
    gatewayBaseUrl: "https://app.example/", escapeHtml: (value) => value, formatDate: (value) => value,
    createId: () => "image-id", confirmDisable: () => true, createObserver: () => null,
    schedule: () => 1, cancel: () => {}, onNotice: () => {}, onError: () => {}, rerender: () => {},
  });
  await page.load();
  const form = new FormData();
  form.set("attested", "on");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 1; index <= 3; index++) form.append("file", new File([png], `figure-${index}.png`, { type: "image/png" }));
  await page.uploadMaterial("source-a", form);
  assert(uploads.length === 0, "Default-off processing must reject a multi-image upload.");
  form.set("imageProcessing", "on");
  await page.uploadMaterial("source-a", form);
  assert(uploads.length === 1 && uploads[0].get("mode") === "image" && uploads[0].get("mediaType") === "application/x-knowledge-images", "Enabled processing must send one image bundle.");
});

/** @param {string} state @param {string} sourceId */
function workflowStatus(state, sourceId = "source-a") {
  return {
    sourceId,
    run: {
      runId: `run-${sourceId}`,
      state,
      revision: 1,
      counts: { pages: 0, knowledgePoints: 0, acceptedQuizzes: 0, pendingQuizzes: 0 },
      extractionStartedAt: null,
      extractionDeadlineAt: null,
      elapsedMs: null,
      remainingMs: null,
      decisionRequired: null,
      failureKind: null,
      robotsEvidence: null,
    },
    reasonCode: null,
    message: null,
  };
}

Deno.test("Library is source-only and renders a broad related-knowledge overview", () => {
  const html = renderLibraryRoute({
    ...baseModel(),
    knowledge: [{ knowledgeId: "knowledge-a", sourceId: "source-a", summary: "This lesson introduces harmonic motion, cadences, and how tonal tension resolves across a phrase.", questionLocked: true }],
  });
  for (const expected of [
    "Search saved sources",
    "Music",
    "Harmony source",
    "Open original source",
    "data-library-disable",
    "data-library-load-more",
    "Processing is automatic",
    "Related knowledge",
    "1 retained knowledge point",
    "harmonic motion, cadences",
  ]) assert(html.includes(expected), `Missing ${expected}.`);
  assert(!html.includes("data-library-knowledge-remove"), "Source cards must not expose individual knowledge controls.");
  assert(!html.includes("Question unlocks after Feed study"), "Source overviews must not expose quiz state for individual points.");
  assert(html.includes("Library · source collection") && !html.includes('aria-label="Library sections"'), "The source collection must be identified without the retired one-item tab bar.");
  assert(!html.includes("Review queue"), "Library must not render a human or scheduled review queue.");
  assert(!html.includes("Keep") && !html.includes("Discard"), "Library must not render human approval controls.");
});

Deno.test("Library can render a cross-source knowledge search result separately from source search", () => {
  const html = renderLibraryRoute({
    ...baseModel(),
    collection: { ...baseModel().collection, query: "cadence", searchScope: "knowledge" },
    knowledgeSearchResults: [{
      knowledgeId: "knowledge-cadence",
      sourceId: "source-a",
      sourceTitle: "Harmony source",
      summary: "A cadence resolves harmonic tension.",
      sourceUrl: source.canonicalUrl,
      score: 0.84,
      matchedBy: "semantic",
      questionLocked: true,
    }],
  });
  assert(html.includes("Search knowledge"), "Library must expose the knowledge search scope.");
  assert(html.includes("A cadence resolves harmonic tension."), "Knowledge search must render the matching point.");
  assert(html.includes('<a href="https://publisher.example/learn" target="_blank" rel="noopener noreferrer">Harmony source</a>'), "Knowledge search must embed the source link in its attribution.");
  assert(!html.includes(">Open source</a>"), "Knowledge search must not render a redundant separate source link.");
  assert(html.includes("semantic match"), "Knowledge search must disclose the match mode.");
});

Deno.test("Library source search renders source cards with only a broad knowledge overview", () => {
  const knowledge = [
    { knowledgeId: "knowledge-a", sourceId: "source-a", summary: "This lesson introduces the piano keyboard and grand staff, including middle C and clefs.", questionLocked: true },
    { knowledgeId: "knowledge-b", sourceId: "source-a", summary: "This lesson explains half steps, whole steps, and accidentals in staff notation.", questionLocked: false },
  ];
  const html = renderLibraryRoute({
    ...baseModel(),
    collection: { ...baseModel().collection, query: "harmony", searchScope: "sources" },
    knowledge,
  });
  assert(html.includes("Harmony source"), "Source search must render the matching source card.");
  assert(html.includes("Related knowledge"), "Source search must retain the broad related-knowledge overview.");
  assert(html.includes("2 retained knowledge points"), "The overview must include the retained knowledge count.");
  assert(html.includes("piano keyboard and grand staff"), "The overview must expose broad topics.");
  assert(html.includes("half steps, whole steps, and accidentals"), "The overview must combine broad topics across points.");
  assert(!html.includes(knowledge[0].summary) && !html.includes(knowledge[1].summary), "Source search must not render individual knowledge summaries.");
  assert(!html.includes("data-library-knowledge-remove"), "Source search must not expose individual knowledge controls.");
  assert(html.includes("Open original source"), "Source search must retain the source link.");
});

Deno.test("Library related-knowledge overview is bounded, deduplicated, and escaped", () => {
  const repeated = "This lesson covers scales, modes, and tonal centers in music theory.";
  const html = renderLibraryRoute({
    ...baseModel(),
    knowledge: [
      { knowledgeId: "knowledge-a", sourceId: "source-a", summary: repeated, questionLocked: true },
      { knowledgeId: "knowledge-b", sourceId: "source-a", summary: repeated, questionLocked: false },
      { knowledgeId: "knowledge-c", sourceId: "source-a", summary: `${repeated} <script>alert(1)</script>`, questionLocked: true },
    ],
  });
  assert(html.includes("3 retained knowledge points"), "The overview count must include every retained point.");
  assert(html.includes("scales, modes, and tonal centers"), "The overview must retain a useful broad topic.");
  assert(!html.includes("<script>alert(1)</script>"), "Overview text must be escaped.");
  assert(html.match(/scales, modes, and tonal centers/g)?.length === 1, "Repeated topics must appear once in the overview.");
  const overview = html.match(/<p class="library-knowledge-overview">([\s\S]*?)<\/p>/)?.[1] ?? "";
  assert(overview.length <= 300, "The related-knowledge overview must remain bounded.");
});

Deno.test("Library announces the number of actively processing sources", () => {
  const html = renderLibraryRoute({
    ...baseModel(),
    workflowStatuses: [workflowStatus("extraction-loop")],
  });
  assert(html.includes('data-library-processing-status'), "Library must render a processing status chip for active work.");
  assert(html.includes("Processing 1 source"), "The status chip must report a singular active source.");
  assert(html.includes("extracting knowledge points"), "A single active source must expose its current processing stage.");
  assert(html.includes('role="status"'), "The processing chip must use status semantics.");
  assert(html.includes('aria-live="polite"'), "The processing chip must announce updates politely.");
  assert(html.includes('aria-atomic="true"'), "The processing announcement must be atomic.");
  assert(html.includes('aria-hidden="true"') && html.includes("⟳"), "The CSS spinner must be decorative and visible without replacing the text label.");
});

Deno.test("Library pluralizes active processing sources and excludes waiting states", () => {
  const active = renderLibraryRoute({
    ...baseModel(),
    collection: { ...baseModel().collection, items: [source, sourceB] },
    workflowStatuses: [
      workflowStatus("source-added", "source-a"),
      workflowStatus("per-point-quiz-loop", "source-b"),
      { ...workflowStatus("awaiting-upload", "source-a"), message: "Upload content instead." },
    ],
  });
  assert(active.includes("Processing 2 sources"), "The status chip must pluralize and count active sources once each.");
  assert(active.includes("generating and validating review quizzes"), "An active quiz-generation status must explain what processing is doing.");

  const terminal = renderLibraryRoute({
    ...baseModel(),
    workflowStatuses: [
      { ...workflowStatus("awaiting-upload"), message: "Upload content instead." },
      workflowStatus("completed", "source-b"),
    ],
  });
  assert(!terminal.includes('data-library-processing-status'), "Waiting and completed sources must not keep the spinner visible.");
  assert(terminal.includes("Upload content instead."), "The source card must retain the specific upload explanation.");
});

Deno.test("Library offers unchecked external AI search consent and explains its bounded scope", () => {
  const html = renderLibraryRoute(baseModel());
  const checkbox = html.match(/<input[^>]*name="externalProcessingAllowed"[^>]*>/)?.[0];
  assert(checkbox !== undefined && !checkbox.includes("checked"), "AI processing must be an explicit opt-in.");
  assert(html.includes("configured external AI provider"), "Search must disclose external processing.");
  assert(html.includes("20 candidates"), "Search must disclose its bounded candidate scope.");
});

Deno.test("Library search has the approved dedicated search composition and shared select styling", async () => {
  const css = await Deno.readTextFile(new URL("../src/styles.css", import.meta.url));
  assert(!css.includes(".library-knowledge-search {"), "Knowledge search must use the shared section layout.");
  assert(css.includes(".library-search .library-search-row {"), "Approved redesign gives Library a distinct responsive search composition.");
  assert(!css.includes(".library-search-row select {"), "Library search must not add a one-off select rule.");
});

Deno.test("Library processing spinner respects reduced-motion CSS", async () => {
  const css = await Deno.readTextFile(new URL("../src/styles.css", import.meta.url));
  assert(css.includes(".library-processing-spinner"), "The processing indicator must have a dedicated spinner style.");
  assert(css.includes("@media (prefers-reduced-motion: reduce)"), "The stylesheet must declare reduced-motion behavior.");
  assert(css.includes("animation-duration: 0.01ms"), "Reduced motion must shorten the spinner animation.");
});

Deno.test("Library renders a truthful empty knowledge state while processing is incomplete", () => {
  const html = renderLibraryRoute({ ...baseModel(), knowledge: [] });
  assert(html.includes("Knowledge is still being processed"), "Processing state must not masquerade as a completed source.");
  assert(!html.includes("Policy assessment pending"), "Retired policy placeholder must not remain in Library.");
});

Deno.test("Library explains why a blocked source needs uploaded content", () => {
  const html = renderLibraryRoute({
    ...baseModel(),
    workflowStatuses: [{
      sourceId: "source-a",
      run: null,
      reasonCode: "audio-video-transcription-unavailable",
      message: "This source contains audio or video, but native audio/video transcription is not available yet. Upload an authorized transcript or text/document instead.",
    }],
  });
  assert(html.includes("native audio/video transcription is not available yet"), "Library must display the concrete upload reason.");
  assert(html.includes("Upload an authorized transcript"), "Library must tell the learner what to upload.");
});

Deno.test("Library shows the planner failure reason and retry action", () => {
  const html = renderLibraryRoute({
    ...baseModel(),
    workflowStatuses: [{
      ...workflowStatus("retryable-failure"),
      reasonCode: "retryable-failure",
      message: "Automatic extraction stopped because the planner returned an invalid ExtractionPlan after one correction attempt (ExtractionPlanInvalid). Retry processing to try again.",
    }],
  });
  assert(html.includes("invalid ExtractionPlan"), "Library must show the concrete planner failure.");
  assert(html.includes("Retry processing"), "Library must offer a retry action.");
  assert(html.includes('data-library-workflow-retry="run-source-a"'), "Retry action must carry the workflow run ID.");
  assert(!html.includes("data-library-processing-status"), "Retryable failure must not keep the processing spinner visible.");
});

Deno.test("Library treats an expired extraction as stopped and retryable", () => {
  const status = workflowStatus("extraction-loop");
  const html = renderLibraryRoute({
    ...baseModel(),
    workflowStatuses: [{
      ...status,
      run: {
        ...status.run,
        extractionStartedAt: "2026-08-13T00:00:00.000Z",
        extractionDeadlineAt: "2026-08-13T00:30:00.000Z",
        elapsedMs: 1_800_001,
        remainingMs: 0,
      },
      reasonCode: "retryable-failure",
      message: "Automatic extraction stopped after its processing deadline elapsed. Retry processing to try again.",
    }],
  });
  assert(!html.includes('data-library-processing-status'), "An expired extraction must not keep the processing spinner visible.");
  assert(html.includes("processing deadline elapsed"), "The expired run must explain why processing stopped.");
  assert(html.includes("Retry processing"), "The expired run must remain retryable.");
});

Deno.test("Library exposes bounded robots evidence and explicit robots-file absence", () => {
  const present = renderLibraryRoute({
    ...baseModel(),
    workflowStatuses: [{
      ...workflowStatus("completed"),
      run: {
        ...workflowStatus("completed").run,
        robotsEvidence: {
          robotsUrl: "https://publisher.example/robots.txt",
          targetUrl: source.canonicalUrl,
          httpStatus: 200,
          availability: "present",
          content: "User-agent: *\nDisallow: /private\n",
          checkedAt: "2026-07-22T08:05:00.000Z",
          matchedRule: null,
        },
      },
    }],
  });
  assert(present.includes("View robots.txt"), "Library must offer the robots evidence disclosure.");
  assert(present.includes("Disallow: /private"), "Library must show the bounded robots content.");
  assert(present.includes("Open robots.txt"), "Library must link to the source robots file.");

  const absent = renderLibraryRoute({
    ...baseModel(),
    workflowStatuses: [{
      ...workflowStatus("completed"),
      run: {
        ...workflowStatus("completed").run,
        robotsEvidence: {
          robotsUrl: "https://publisher.example/robots.txt",
          targetUrl: source.canonicalUrl,
          httpStatus: 404,
          availability: "absent",
          content: "",
          checkedAt: "2026-07-22T08:05:00.000Z",
          matchedRule: null,
        },
      },
    }],
  });
  assert(absent.includes("robots.txt: no directives"), "Library must distinguish an explicit missing robots file.");

  const unavailable = renderLibraryRoute({
    ...baseModel(),
    workflowStatuses: [{
      ...workflowStatus("completed"),
      run: {
        ...workflowStatus("completed").run,
        robotsEvidence: {
          robotsUrl: "https://publisher.example/robots.txt",
          targetUrl: source.canonicalUrl,
          httpStatus: 403,
          availability: "unavailable",
          content: "",
          checkedAt: "2026-07-22T08:05:00.000Z",
          matchedRule: null,
        },
      },
    }],
  });
  assert(unavailable.includes("robots.txt: unavailable (HTTP 403)"), "Library must disclose an origin robots 403 separately from an explicit denial.");
  assert(unavailable.includes("source page was reachable"), "Library must explain why extraction continued after the robots 403.");
});

Deno.test("Library controller loads source knowledge and removes one knowledge pair", async () => {
  /** @type {string[]} */ const requests = [];
  /** @type {(() => void) | null} */ let removeListener = null;
  const page = createLibraryPage({
    fetch: (input, init) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/source-library")) return Promise.resolve(Response.json({ result: { items: [source], interestAreas: [], nextCursor: null } }));
      if (url.pathname.endsWith("/library-knowledge")) return Promise.resolve(Response.json({ result: { items: [{ knowledgeId: "knowledge-a", sourceId: "source-a", questionId: "question-a", title: "Harmony source", summary: "A cadence resolves musical tension.", sourceUrl: source.canonicalUrl, evidenceAnchorIds: ["anchor-a"], media: null, questionLocked: false }] } }));
      if (url.pathname.endsWith("/knowledge-remove")) return Promise.resolve(Response.json({ result: { knowledgeId: "knowledge-a", removed: true } }));
      return Promise.resolve(Response.json({ error: "Not found" }, { status: 404 }));
    },
    gatewayBaseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    formatDate: (value) => value,
    createId: () => "id-a",
    confirmDisable: () => true,
    createObserver: () => null,
    schedule: () => 1,
    cancel: () => {},
    onNotice: () => {},
    onError: () => {},
    rerender: () => {},
  });
  await page.load();
  const initial = page.render({});
  assert(initial.includes("A cadence resolves musical tension."), "Library must show loaded knowledge.");
  page.bind(/** @type {HTMLElement} */ (/** @type {unknown} */ ({
    querySelector: () => null,
    querySelectorAll: (/** @type {string} */ selector) => selector === "[data-library-knowledge-remove]"
      ? [{ getAttribute: (/** @type {string} */ name) => name === "data-library-knowledge-remove" ? "knowledge-a" : null, addEventListener: (/** @type {string} */ _event, /** @type {() => void} */ listener) => { removeListener = listener; } }]
      : [],
  })));
  if (removeListener === null) throw new Error("Knowledge removal action was not bound.");
  const action = /** @type {() => void} */ (removeListener);
  action();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(requests.some((request) => request.includes("POST /api/learning-generation/knowledge-remove")), "Library must call the paired knowledge removal endpoint.");
  assert(!page.render({}).includes("A cadence resolves musical tension."), "Removed knowledge must disappear from the current Library projection.");
});

Deno.test("Library controller searches retained knowledge across sources", async () => {
  const page = createLibraryPage({
    fetch: (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/source-library")) return Promise.resolve(Response.json({ result: { items: [source], interestAreas: [], nextCursor: null } }));
      if (url.pathname.endsWith("/library-knowledge")) return Promise.resolve(Response.json({ result: { items: [] } }));
      if (url.pathname.endsWith("/source-status")) return Promise.resolve(Response.json({ result: { sourceId: source.id, run: null, reasonCode: null, message: null } }));
      if (url.pathname.endsWith("/source-library/search")) return Promise.resolve(Response.json({ result: [{ knowledge: { knowledgeId: "knowledge-cadence", sourceId: source.id, sourceTitle: source.title, summary: "A cadence resolves harmonic tension.", sourceUrl: source.canonicalUrl, evidenceAnchorIds: ["anchor-cadence"], questionLocked: true }, score: 0.84, matchedBy: "semantic" }] }));
      return Promise.resolve(Response.json({ error: "Not found" }, { status: 404 }));
    },
    gatewayBaseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    formatDate: (value) => value,
    createId: () => "id-a",
    confirmDisable: () => true,
    createObserver: () => null,
    schedule: () => 1,
    cancel: () => {},
    onNotice: () => {},
    onError: () => {},
    rerender: () => {},
  });
  await page.load();
  const form = new FormData();
  form.set("query", "cadence");
  form.set("searchScope", "knowledge");
  await page.search(form);
  const html = page.render({});
  assert(html.includes("A cadence resolves harmonic tension."), "Knowledge search must replace source cards with retained knowledge matches.");
  assert(html.includes('<a href="https://publisher.example/learn" target="_blank" rel="noopener noreferrer">Harmony source</a>'), "Knowledge search must preserve linked source provenance.");
  assert(html.includes("semantic match"), "Knowledge search must preserve the match type.");
});

Deno.test("Library renders source cards before secondary knowledge requests finish", async () => {
  /** @type {(response: Response) => void} */ let resolveKnowledge = () => {};
  const knowledgePending = new Promise((resolve) => {
    resolveKnowledge = resolve;
  });
  let rendered = "";
  /** @type {ReturnType<typeof createLibraryPage>} */ let page;
  page = createLibraryPage({
    fetch: (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/source-library")) return Promise.resolve(Response.json({ result: { items: [source], interestAreas: [], nextCursor: null } }));
      if (url.pathname.endsWith("/library-knowledge")) return knowledgePending;
      if (url.pathname.endsWith("/source-status")) return Promise.resolve(Response.json({ result: { sourceId: source.id, run: null, reasonCode: null, message: null } }));
      return Promise.resolve(Response.json({ error: "Not found" }, { status: 404 }));
    },
    gatewayBaseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    formatDate: (value) => value,
    createId: () => "id-a",
    confirmDisable: () => true,
    createObserver: () => null,
    schedule: () => 1,
    cancel: () => {},
    onNotice: () => {},
    onError: () => {},
    rerender: () => {
      rendered = page.render({});
    },
  });
  const loading = page.load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(rendered.includes("Harmony source"), "Source cards must render before secondary knowledge loading completes.");
  resolveKnowledge(Response.json({ result: { items: [] } }));
  await loading;
});

Deno.test("Library controller loads workflow status so upload blockers survive a refresh", async () => {
  const page = createLibraryPage({
    fetch: (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/source-library")) return Promise.resolve(Response.json({ result: { items: [source], interestAreas: [], nextCursor: null } }));
      if (url.pathname.endsWith("/library-knowledge")) return Promise.resolve(Response.json({ result: { items: [] } }));
      if (url.pathname.endsWith("/source-status")) return Promise.resolve(Response.json({ result: { sourceId: "source-a", run: null, reasonCode: "paywall-or-login", message: "This source could not be scraped because it is behind a paywall or requires sign-in. Upload authorized text, PDF, PPTX, or a transcript instead." } }));
      return Promise.resolve(Response.json({ error: "Not found" }, { status: 404 }));
    },
    gatewayBaseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    formatDate: (value) => value,
    createId: () => "id-a",
    confirmDisable: () => true,
    createObserver: () => null,
    schedule: () => 1,
    cancel: () => {},
    onNotice: () => {},
    onError: () => {},
    rerender: () => {},
  });
  await page.load();
  assert(page.render({}).includes("behind a paywall"), "Library must show the persisted workflow blocker after reload.");
});

Deno.test("Library controller retains prior source pages when continuation fails", async () => {
  let call = 0;
  const page = createLibraryPage({
    fetch: () => {
      call += 1;
      return Promise.resolve(call === 1
        ? Response.json({ result: { items: [source], interestAreas: [], nextCursor: "signed-next" } })
        : Response.json({ error: "SourceCursorStale" }, { status: 409 }));
    },
    gatewayBaseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    formatDate: (value) => value,
    createId: () => "id-a",
    confirmDisable: () => true,
    createObserver: () => null,
    schedule: () => 1,
    cancel: () => {},
    onNotice: () => {},
    onError: () => {},
    rerender: () => {},
  });
  await page.load();
  await page.load(false);
  const html = page.render({});
  assert(html.includes("Harmony source"), "Loaded sources must remain visible.");
  assert(html.includes("Previously loaded sources remain below"), "The retained page must disclose its stale state.");
  assert(html.includes("Refresh sources"), "A stale continuation must offer a reset action.");
});

Deno.test("Library polls active workflow status and stops after completion", async () => {
  /** @type {{ readonly callback: () => void, readonly delayMs: number }[]} */
  const scheduled = [];
  let statusCalls = 0;
  const page = createLibraryPage({
    fetch: (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/source-library")) return Promise.resolve(Response.json({ result: { items: [source], interestAreas: [], nextCursor: null } }));
      if (url.pathname.endsWith("/library-knowledge")) return Promise.resolve(Response.json({ result: { items: [] } }));
      if (url.pathname.endsWith("/source-status")) {
        statusCalls += 1;
        return Promise.resolve(Response.json({ result: workflowStatus(statusCalls === 1 ? "extraction-loop" : "completed") }));
      }
      return Promise.resolve(Response.json({ error: "Not found" }, { status: 404 }));
    },
    gatewayBaseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    formatDate: (value) => value,
    createId: () => "id-a",
    confirmDisable: () => true,
    createObserver: () => null,
    schedule: (/** @type {() => void} */ callback, /** @type {number} */ delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length;
    },
    cancel: () => {},
    onNotice: () => {},
    onError: () => {},
    rerender: () => {},
  });
  await page.load();
  assert(statusCalls === 1, "Library must load workflow status with the source list.");
  assert(scheduled.length === 1 && scheduled[0].delayMs === 5_000, "Active work must schedule one five-second refresh.");
  assert(page.render({}).includes("Processing 1 source"), "The active source must be visible before the poll completes.");

  scheduled[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(statusCalls === 2, "The scheduled refresh must fetch the latest workflow status.");
  assert(!page.render({}).includes('data-library-processing-status'), "The chip must disappear after the source completes.");
  assert(scheduled.length === 1, "Polling must stop after a terminal workflow state.");
});

Deno.test("Library preserves a known active status when a poll fails", async () => {
  /** @type {(() => void)[]} */ const scheduled = [];
  /** @type {string[]} */ const errors = [];
  let statusCalls = 0;
  const page = createLibraryPage({
    fetch: (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/source-library")) return Promise.resolve(Response.json({ result: { items: [source], interestAreas: [], nextCursor: null } }));
      if (url.pathname.endsWith("/library-knowledge")) return Promise.resolve(Response.json({ result: { items: [] } }));
      if (url.pathname.endsWith("/source-status")) {
        statusCalls += 1;
        return statusCalls === 1
          ? Promise.resolve(Response.json({ result: workflowStatus("extraction-loop") }))
          : Promise.resolve(Response.json({ error: "temporary status outage" }, { status: 503 }));
      }
      return Promise.resolve(Response.json({ error: "Not found" }, { status: 404 }));
    },
    gatewayBaseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    formatDate: (value) => value,
    createId: () => "id-a",
    confirmDisable: () => true,
    createObserver: () => null,
    schedule: (/** @type {() => void} */ callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel: () => {},
    onNotice: () => {},
    onError: (message) => errors.push(message),
    rerender: () => {},
  });
  await page.load();
  scheduled[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(page.render({}).includes("Harmony source"), "A status outage must not erase the Library source.");
  assert(page.render({}).includes("Processing 1 source"), "A status outage must retain the last confirmed processing state.");
  assert(errors.length === 1, "A status outage must be reported to the user.");
  assert(scheduled.length === 2, "A known active source may retry with one replacement poll after a transient status failure.");
});
