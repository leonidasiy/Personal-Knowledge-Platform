// @ts-check

import {
  boundAuthorizedMaterialPlan,
  extractionPlanPrompt,
  extractionPlanRepairPrompt,
  pageObservationPrompt,
  pageObservationRepairPrompt,
  questionEvaluatorPrompt,
  questionGeneratorPrompt,
  requestExtractionPlan,
  requestPageObservation,
  requestMaterialBatch,
  materialBatchPrompt,
  materialImagePrompt,
  projectHtml,
  normalizePlannerOutput,
  readRobotsWithFallback,
} from "../worker/knowledge-workflow-runtime.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

/** @returns {import("../src/features/knowledge-workflows/extraction.js").ExtractionScratchpad} */
function scratchpad() {
  return {
    ownerId: "owner-a",
    runId: "run-a",
    sourceId: "source-a",
    sourceRevision: 1,
    processedUrls: ["https://example.test/learn#section=one"],
    acceptedHashes: ["hash-a"],
    similarityEvidence: [],
    coverage: ["goal-covered"],
    unresolvedGaps: [],
    consecutiveNoveltyZero: 0,
    revision: 2,
  };
}

/** @returns {import("../src/features/knowledge-workflows/extraction.js").ExtractionPlan} */
function plan() {
  return {
    revision: 2,
    frontier: ["https://example.test/learn#section=one", "https://example.test/learn#section=two"],
    coverageGoals: [
      { id: "goal-covered", priority: "normal", description: "Covered supplied concept." },
      { id: "goal-unavailable", priority: "high", description: "Concept not present in supplied material." },
    ],
    unresolvedGaps: [{ id: "gap-unavailable", priority: "high", description: "Needs an unavailable section." }],
    stopDecision: { decision: "continue", rationale: "The supplied material still has an unobserved section.", evidenceUrls: ["https://example.test/learn#section=one"], unresolvedGapIds: ["gap-unavailable"] },
  };
}

Deno.test("authorized material plan preserves frontier while supplied sections remain", () => {
  const value = plan();
  assertEquals(boundAuthorizedMaterialPlan(value, ["https://example.test/learn#section=two"], scratchpad()), value);
});

Deno.test("authorized material plan terminates after all supplied sections are processed", () => {
  const value = boundAuthorizedMaterialPlan(plan(), [], scratchpad());
  assertEquals(value.frontier.length, 0);
  assertEquals(JSON.stringify(value.coverageGoals.map((goal) => goal.id)), JSON.stringify(["goal-covered"]));
  assertEquals(value.unresolvedGaps.length, 0);
});

Deno.test("live planner adapter converts the known legacy goal and gap shape without accepting unsafe URLs", () => {
  const normalized = normalizePlannerOutput({
    revision: 1,
    frontier: ["https://example.test/learn/"],
    coverageGoals: [{ source: "https://example.test/learn/", goal: "Extract the page." }],
    unresolvedGaps: ["Find chapter links."],
  }, { rootUrl: "https://example.test/learn/" });
  assertEquals(JSON.stringify(normalized), JSON.stringify({
    revision: 1,
    frontier: ["https://example.test/learn/"],
    coverageGoals: [{ id: "goal-extract-the-page", priority: "normal", description: "Extract the page." }],
    unresolvedGaps: [{ id: "gap-find-chapter-links", priority: "normal", description: "Find chapter links." }],
    stopDecision: { decision: "continue", rationale: "Planner-adapted legacy output requires observation before a stopping decision can be trusted.", evidenceUrls: ["https://example.test/learn/"], unresolvedGapIds: ["gap-find-chapter-links"] },
  }));
  const unsafe = normalizePlannerOutput({ coverageGoals: ["goal"], unresolvedGaps: [], frontier: ["http://example.test/learn/"] }, { rootUrl: "https://example.test/learn/" });
  const unsafeRecord = /** @type {Record<string, unknown>} */ (unsafe);
  if (typeof unsafe !== "object" || unsafe === null || !Array.isArray(unsafeRecord.frontier)) throw new Error("Unsafe planner output was unexpectedly normalized.");
  assertEquals(unsafeRecord.frontier[0], "http://example.test/learn/");
});

Deno.test("robots Browser Run failure never invokes raw Worker fetch", async () => {
  let fetchCalls = 0;
  const result = await readRobotsWithFallback({
    browser: {
      readRobots: async () => ({ ok: false, error: { kind: "KnowledgeBrowserNavigationFailed" } }),
      readPage: async () => ({ ok: false, error: { kind: "KnowledgeBrowserNavigationFailed" } }),
      screenshot: async () => ({ ok: false, error: { kind: "KnowledgeScreenshotFailed" } }),
      close: async () => ({ ok: true, value: null }),
    },
    fetch: async () => { fetchCalls += 1; return new Response("must not fetch", { status: 200 }); },
    logger: () => {},
  }, { sourceUrl: "https://example.test/learn", robotsUrl: "https://example.test/robots.txt" });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgeBrowserNavigationFailed");
  assertEquals(fetchCalls, 0);
});

Deno.test("robots denial never invokes raw Worker fetch", async () => {
  let fetchCalls = 0;
  const result = await readRobotsWithFallback({
    browser: {
      readRobots: async () => ({ ok: false, error: { kind: "RobotsDenied", diagnosticToken: "robots-denied" } }),
      readPage: async () => ({ ok: false, error: { kind: "KnowledgeBrowserNavigationFailed" } }),
      screenshot: async () => ({ ok: false, error: { kind: "KnowledgeScreenshotFailed" } }),
      close: async () => ({ ok: true, value: null }),
    },
    fetch: async () => { fetchCalls += 1; return new Response("must not fetch", { status: 200 }); },
    logger: () => {},
  }, { sourceUrl: "https://example.test/learn", robotsUrl: "https://example.test/robots.txt" });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "RobotsDenied");
  assertEquals(fetchCalls, 0);
});

Deno.test("live quiz prompts enumerate the exact generator and evaluator contracts", () => {
  if (!questionGeneratorPrompt.includes("meaningful complete mapping") || !questionEvaluatorPrompt.includes("arbitrary word-order permutations")) throw new Error("Quiz prompts did not require meaningful distinctions.");
  if (!questionGeneratorPrompt.includes("multiple blanks") || !questionGeneratorPrompt.includes("acceptedAnswers")) throw new Error("Quiz prompt omitted the supported multi-blank contract.");
  if (questionGeneratorPrompt.includes("visibleEvidence")) throw new Error("Quiz prompt requested extraction evidence cues.");
  for (const field of ["id", "knowledgeId", "knowledgeRevision", "kind", "prompt", "options", "answer", "citedEvidenceUrls"]) {
    if (!questionGeneratorPrompt.includes(field)) throw new Error(`Generator prompt omitted ${field}.`);
  }
  for (const field of ["score", "reasons", "feedback", "groundingProblems"]) {
    if (!questionEvaluatorPrompt.includes(field)) throw new Error(`Evaluator prompt omitted ${field}.`);
  }
  for (const prompt of [questionGeneratorPrompt, questionEvaluatorPrompt]) {
    assertEquals(prompt.includes("Language fidelity"), true);
    assertEquals(prompt.includes("Mandarin/Chinese"), true);
    assertEquals(prompt.includes("never translate"), true);
  }
  assertEquals(questionGeneratorPrompt.includes("discards the point"), true);
});

Deno.test("planner retries one malformed response and then accepts the exact ExtractionPlan contract", async () => {
  let calls = 0;
  /** @type {string[]} */ const prompts = [];
  /** @type {Record<string, unknown>[]} */ const logs = [];
  const result = await requestExtractionPlan({
    taskId: "scraper-plan",
    input: { operation: "plan", rootUrl: "https://example.test/learn", scratchpad: scratchpad() },
    maxOutputTokens: 2048,
    logger: (/** @type {{ readonly event: string, readonly failureKind?: string }} */ entry) => logs.push(entry),
    generate: async (/** @type {{ readonly systemPrompt: string }} */ { systemPrompt }) => {
      prompts.push(systemPrompt);
      calls += 1;
      return calls === 1
        ? { ok: true, value: { revision: 1, frontier: ["https://example.test/learn/"], coverageGoals: [{ source: "https://example.test/learn/", goal: "Extract the page." }], unresolvedGaps: ["Find chapter links."] } }
        : { ok: true, value: { revision: 1, frontier: ["https://example.test/learn/"], coverageGoals: [{ id: "goal-root", priority: "high", description: "Extract the page." }], unresolvedGaps: [{ id: "gap-links", priority: "normal", description: "Find chapter links." }], stopDecision: { decision: "continue", rationale: "The page still needs observation.", evidenceUrls: ["https://example.test/learn/"], unresolvedGapIds: ["gap-links"] } } };
    },
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.coverageGoals[0].id, "goal-root");
  assertEquals(result.value.unresolvedGaps[0].id, "gap-links");
  assertEquals(calls, 2);
  assertEquals(prompts[0].includes("coverageGoals (an array of objects with id, priority, and description)"), true);
  assertEquals(prompts[1].includes("The previous planner response was invalid"), true);
  assertEquals(logs.some((entry) => entry.event === "knowledge-workflow-planner-schema-retry"), true);
});

Deno.test("planner returns a typed ExtractionPlanInvalid failure after the bounded retry is exhausted", async () => {
  let calls = 0;
  /** @type {Record<string, unknown>[]} */ const logs = [];
  const result = await requestExtractionPlan({
    taskId: "scraper-plan",
    input: { operation: "plan", rootUrl: "https://example.test/learn", scratchpad: scratchpad() },
    maxOutputTokens: 2048,
    logger: (/** @type {{ readonly event: string, readonly failureKind?: string }} */ entry) => logs.push(entry),
    generate: async () => {
      calls += 1;
      return { ok: true, value: { coverageGoals: [{ source: "https://example.test/learn/", goal: "wrong shape" }], unresolvedGaps: ["wrong shape"] } };
    },
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.kind, "ExtractionPlanInvalid");
  assertEquals(calls, 2);
  assertEquals(logs.some((entry) => entry.event === "knowledge-workflow-planner-schema-failure" && entry.failureKind === "ExtractionPlanInvalid"), true);
});

Deno.test("page observation retries one malformed response and accepts the exact candidates contract", async () => {
  let calls = 0;
  /** @type {string[]} */ const prompts = [];
  /** @type {Record<string, unknown>[]} */ const logs = [];
  const result = await requestPageObservation({
    taskId: "scraper-observe-page",
    input: { operation: "observe", url: "https://example.test/learn/", text: "A concept." },
    maxOutputTokens: 4096,
    logger: (/** @type {{ readonly event: string, readonly failureKind?: string, readonly diagnosticToken?: string }} */ entry) => logs.push(entry),
    generate: async (/** @type {{ readonly systemPrompt: string }} */ { systemPrompt }) => {
      prompts.push(systemPrompt);
      calls += 1;
      return calls === 1
        ? { ok: true, value: { candidates: [{ summary: "A concept can be applied.", normalizedHash: "hash-concept", evidenceAnchors: [{ url: "https://example.test/learn/", selector: "main" }], coverageGoalIds: ["goal-root"], mediaCandidates: [], action: "publish" }] } }
        : { ok: true, value: { candidates: [{ summary: "A concept can be applied.", normalizedHash: "hash-concept", evidenceAnchors: [{ url: "https://example.test/learn/", selector: "main" }], coverageGoalIds: ["goal-root"], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }] } };
    },
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.candidates[0].normalizedHash, "hash-concept");
  assertEquals(calls, 2);
  assertEquals(prompts[0].includes("exactly one top-level JSON object with exactly these fields: notes and candidates"), true);
  assertEquals(prompts[1].includes("previous page-observation response was invalid"), true);
  assertEquals(logs.some((entry) => entry.event === "knowledge-workflow-observation-schema-retry" && entry.diagnosticToken === "candidate-shape"), true);
  assertEquals(logs.some((entry) => entry.event === "knowledge-workflow-observation-schema-retry-success"), true);
});

Deno.test("page observation returns a typed failure after the bounded schema retry is exhausted", async () => {
  let calls = 0;
  /** @type {Record<string, unknown>[]} */ const logs = [];
  const result = await requestPageObservation({
    taskId: "scraper-observe-page",
    input: { operation: "observe", url: "https://example.test/learn/" },
    maxOutputTokens: 4096,
    logger: (/** @type {{ readonly event: string, readonly failureKind?: string, readonly diagnosticToken?: string }} */ entry) => logs.push(entry),
    generate: async () => {
      calls += 1;
      return { ok: true, value: { observation: "wrong shape" } };
    },
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.kind, "KnowledgeObservationInvalid");
  assertEquals(calls, 2);
  assertEquals(logs.some((entry) => entry.event === "knowledge-workflow-observation-schema-failure" && entry.failureKind === "KnowledgeObservationInvalid" && entry.diagnosticToken === "missing-candidates"), true);
});

Deno.test("web observation rejects missing and unknown classifications", async () => {
  for (const classification of [undefined, { version: 1, primarySubject: "unknown", secondarySubjects: [], subcategory: "topic" }]) {
    let calls = 0;
    const result = await requestPageObservation({ taskId: "classification-web", input: { url: "https://example.test/learn" }, maxOutputTokens: 1024, logger: () => {}, generate: async () => {
      calls += 1;
      const candidate = { summary: "A supported claim.", normalizedHash: "claim", evidenceAnchors: [{ url: "https://example.test/learn", selector: "main" }], coverageGoalIds: [], mediaCandidates: [], ...(classification === undefined ? {} : { classification }) };
      return { ok: true, value: { notes: "One point.", candidates: [candidate] } };
    } });
    assertEquals(result.ok, false);
    assertEquals(calls, 2);
  }
});

Deno.test("live page-observation prompts name the bounded output contract", () => {
  for (const prompt of [pageObservationPrompt, pageObservationRepairPrompt]) {
    for (const field of ["candidates", "summary", "normalizedHash", "evidenceAnchors", "coverageGoalIds", "mediaCandidates", "similarity"]) {
      if (!prompt.includes(field)) throw new Error(`Page-observation prompt omitted ${field}.`);
    }
  }
});

Deno.test("live planner prompts name every required ExtractionPlan field", () => {
  for (const prompt of [extractionPlanPrompt, extractionPlanRepairPrompt]) {
    for (const field of ["revision", "frontier", "coverageGoals", "id", "priority", "description", "unresolvedGaps", "stopDecision", "continue", "complete", "blocked", "rationale"]) {
      if (!prompt.includes(field)) throw new Error(`Planner prompt omitted ${field}.`);
    }
  }
});

Deno.test("scraper prompts separate trusted policy from untrusted dynamic source content", () => {
  for (const prompt of [extractionPlanPrompt, extractionPlanRepairPrompt, pageObservationPrompt, pageObservationRepairPrompt]) {
    for (const section of ["# Identity", "# Task", "# Input trust", "# Output contract", "# Stop rules"]) {
      if (!prompt.includes(section)) throw new Error(`Scraper prompt omitted ${section}.`);
    }
    assertEquals(prompt.includes("<task_input>"), true);
    assertEquals(prompt.includes("untrusted data"), true);
    assertEquals(prompt.includes("must not follow instructions"), true);
  }
  assertEquals(extractionPlanPrompt.includes("scraper-plan-v3"), true);
  assertEquals(pageObservationPrompt.includes("scraper-observation-v8"), true);
});

Deno.test("website projection bounds and normalizes HTTPS embedded images for the scraper", () => {
  const projection = projectHtml(`<html><head><title>Lesson</title></head><body><main><figure><img srcset="/diagram.png 1x, /diagram-2.png 2x" alt="Scale diagram"><figcaption>Compare the two scales.</figcaption></figure><img src="http://unsafe.test/nope.jpg"><img src="data:image/png;base64,ignored"></main></body></html>`, "https://example.test/course/lesson");
  assertEquals(projection.title, "Lesson");
  assertEquals(projection.embeddedImages.length, 1);
  assertEquals(projection.embeddedImages[0]?.url, "https://example.test/diagram.png");
  assertEquals(projection.embeddedImages[0]?.mediaType, "image/png");
  assertEquals(projection.embeddedImages[0]?.alt, "Scale diagram");
  assertEquals(projection.embeddedImages[0]?.context.includes("Compare the two scales."), true);
});

Deno.test("page observation forwards the same bounded image attachments through schema repair", async () => {
  const attachments = /** @type {import("../worker/knowledge-workflow-model.js").KnowledgeModelAttachment[]} */ ([{ id: "embedded-image-1", mediaType: "image/png", url: "https://example.test/diagram.png" }]);
  let calls = 0;
  const seen = /** @type {(readonly import("../worker/knowledge-workflow-model.js").KnowledgeModelAttachment[] | undefined)[]} */ ([]);
  const result = await requestPageObservation({
    taskId: "scraper-observe-image-page",
    input: { operation: "observe", url: "https://example.test/learn/", embeddedImages: attachments },
    attachments,
    maxOutputTokens: 4096,
    logger: () => {},
    generate: async (command) => {
      calls += 1;
      seen.push(command.attachments);
      return calls === 1 ? { ok: true, value: { malformed: true } } : { ok: true, value: { notes: "The diagram is relevant.", candidates: [] } };
    },
  });
  assertEquals(result.ok, true);
  assertEquals(calls, 2);
  assertEquals(JSON.stringify(seen[0]), JSON.stringify(attachments));
  assertEquals(JSON.stringify(seen[1]), JSON.stringify(attachments));
});

Deno.test("approved selection policy reaches page, repair, text, and image prompts", () => {
  for (const prompt of [pageObservationPrompt, pageObservationRepairPrompt, materialBatchPrompt, materialImagePrompt]) {
    for (const phrase of ["selection-v3", "Be concise", "detailed derivations", "plotting", "Truth alone", "zero", "variable meanings", "Language fidelity", "never translate"]) assertEquals(prompt.includes(phrase), true);
    assertEquals(prompt.includes("KEEP that explanation of standardization"), false);
  }
  for (const prompt of [materialBatchPrompt, materialImagePrompt]) assertEquals(prompt.includes("30–80 words"), true);
  assertEquals(materialImagePrompt.includes("Never add words merely to reach 30"), true);
  assertEquals(materialImagePrompt.includes("visibleEvidence"), true);
  assertEquals(materialImagePrompt.includes("A generic table or page reference is not enough"), true);
  assertEquals(materialImagePrompt.includes("cite the visible group header in visibleEvidence"), true);
  assertEquals(materialImagePrompt.includes("cumulative probability"), true);
});

Deno.test("material batch validates every supplied page and repairs wrong provenance once", async () => {
  const sections = Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, url: `https://example.test/#section=p${index}`, title: `Page ${index + 1}`, locator: `page:${index + 1}`, text: "Source evidence" }));
  const pages = sections.map((section) => ({ url: section.url, notes: "No central claim on this page.", candidates: [] }));
  let calls = 0;
  const result = await requestMaterialBatch({ taskId: "batch", input: { sections, coverageGoals: [], fileName: "example.pdf", progress: {} }, maxOutputTokens: 16384, logger: () => {}, generate: async (command) => {
    calls++;
    assertEquals(command.maxOutputTokens, 16384);
    assertEquals(command.systemPrompt.includes("selection-v3"), true);
    return { ok: true, value: { pages: calls === 1 ? pages.slice(1) : pages } };
  } });
  assertEquals(result.ok, true);
  assertEquals(calls, 2);
  if (result.ok) assertEquals(result.value.length, 5);
});

Deno.test("material batch fails closed on malformed pages, unsupported anchors, goals, and exhausted repair", async () => {
  const section = { id: "p1", url: "https://example.test/#section=p1", title: "Page 1", locator: "page:1", text: "Evidence" };
  const candidate = { summary: "Supported relationship", normalizedHash: "hash", evidenceAnchors: [{ url: section.url, selector: section.locator }], coverageGoalIds: [], mediaCandidates: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } };
  const page = { url: section.url, notes: "Brief note", candidates: [candidate] };
  for (const output of [
    { pages: [] }, { pages: [page, page] }, { pages: [{ ...page, url: "https://other.test/" }] },
    { pages: [{ ...page, notes: "x".repeat(601) }] }, { pages: [page], extra: true },
    { pages: [{ ...page, candidates: [{ ...candidate, evidenceAnchors: [{ url: section.url, selector: "page:2" }] }] }] },
    { pages: [{ ...page, candidates: [{ ...candidate, coverageGoalIds: ["invented"] }] }] },
    { pages: [{ ...page, candidates: [{ ...candidate, mediaCandidates: [{ url: "invented" }] }] }] },
    { pages: [{ ...page, candidates: [{ ...candidate, classification: { version: 1, primarySubject: "invented", secondarySubjects: [], subcategory: "topic" } }] }] },
  ]) {
    let calls = 0;
    const result = await requestMaterialBatch({ taskId: "batch", input: { sections: [section], coverageGoals: [], fileName: "example.pdf", progress: {} }, maxOutputTokens: 16384, logger: () => {}, generate: async () => { calls++; return { ok: true, value: output }; } });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "KnowledgeMaterialBatchInvalid");
    assertEquals(calls, 2);
  }
  let calls = 0;
  const invalid = await requestMaterialBatch({ taskId: "batch", input: { sections: [], coverageGoals: [], fileName: "example.pdf", progress: {} }, maxOutputTokens: 16384, logger: () => {}, generate: async () => { calls++; return { ok: false, error: { kind: "KnowledgeModelTimeout" } }; } });
  assertEquals(invalid.ok, false);
  assertEquals(calls, 0);
  const failed = await requestMaterialBatch({ taskId: "batch", input: { sections: [section], coverageGoals: [], fileName: "example.pdf", progress: {} }, maxOutputTokens: 16384, logger: () => {}, generate: async () => { calls++; return { ok: false, error: { kind: "KnowledgeModelTimeout" } }; } });
  assertEquals(failed.ok, false);
  if (!failed.ok) assertEquals(failed.error.kind, "KnowledgeModelTimeout");
  assertEquals(calls, 2);
});

Deno.test("image material batches derive exact source and media identifiers and never exceed one section", async () => {
  const section = { id: "image-1", url: "https://example.test/source#section=image-1", title: "chapter5-page-001.png", locator: "image:1", text: "" };
  const visualId = "visual:sha256:source:image-1";
  const candidate = { summary: "The diagram distinguishes the two cases.", visibleEvidence: "The diagram labels the two cases separately.", normalizedHash: "hash-diagram", coverageGoalIds: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } };
  let calls = 0;
  const seen = /** @type {(readonly import("../worker/knowledge-workflow-model.js").KnowledgeModelAttachment[] | undefined)[]} */ ([]);
  const accepted = await requestMaterialBatch({ taskId: "image-batch", input: { sections: [section], coverageGoals: [], fileName: "chapter5-page-001.png", sourceContext: { title: "Harmony lesson", overview: "A lesson on harmonic function." }, progress: {}, mode: "image", visualId }, attachments: [{ id: visualId, mediaType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }], maxOutputTokens: 4_096, logger: () => {}, generate: async (command) => { calls += 1; seen.push(command.attachments); assertEquals(command.timeoutMs, 90_000); assertEquals(command.responseSchema?.name, "material_image_v4"); assertEquals(command.reasoningEffort, "low"); assertEquals(command.providerSort, "throughput"); assertEquals(JSON.stringify(command.input).includes("chapter5"), false); assertEquals(JSON.stringify(command.input).includes("Harmony lesson"), true); assertEquals(JSON.stringify(command.input).includes("harmonic function"), true); return { ok: true, value: { notes: "The diagram contributes one distinction.", candidates: [candidate] } }; } });
  assertEquals(accepted.ok, true);
  assertEquals(calls, 1);
  assertEquals(seen[0]?.length, 1);
  if (accepted.ok) { assertEquals(accepted.value[0].url, section.url); assertEquals(accepted.value[0].candidates[0].evidenceAnchors[0].selector, section.locator); assertEquals(JSON.stringify(accepted.value[0].candidates[0].mediaCandidates), JSON.stringify([{ visualId }])); }
  const wrong = await requestMaterialBatch({ taskId: "image-batch-wrong", input: { sections: [section, { ...section, id: "image-2", url: "https://example.test/source#section=image-2", locator: "image:2" }], coverageGoals: [], fileName: "chapter5.png", progress: {}, mode: "image", visualId }, maxOutputTokens: 16_384, logger: () => {}, generate: async () => ({ ok: true, value: { pages: [] } }) });
  assertEquals(wrong.ok, false);
  if (!wrong.ok) assertEquals(wrong.error.kind, "KnowledgeMaterialBatchCommandInvalid");
});

Deno.test("image material batches reject extra source fields and unsupported goals", async () => {
  const section = { id: "image-1", url: "https://example.test/source#section=image-1", title: "chapter5-page-001.png", locator: "image:1", text: "" };
  const visualId = "visual:sha256:source:image-1";
  for (const candidate of [
    { summary: "The image supports one distinction.", normalizedHash: "hash-image", coverageGoalIds: [] },
    { summary: "The image supports one distinction.", visibleEvidence: " ", normalizedHash: "hash-image", coverageGoalIds: [] },
    { summary: "The image supports one distinction.", visibleEvidence: "x".repeat(501), normalizedHash: "hash-image", coverageGoalIds: [] },
    { summary: "The image supports one distinction.", visibleEvidence: "The two cases are labeled.", normalizedHash: "hash-image", coverageGoalIds: [], evidenceAnchors: [{ url: section.url, locator: section.locator }] },
    { summary: "The image supports one distinction.", visibleEvidence: "The two cases are labeled.", normalizedHash: "hash-image", coverageGoalIds: ["invented"] },
    { summary: "The image supports one distinction.", visibleEvidence: "The two cases are labeled.", normalizedHash: "hash-image", coverageGoalIds: [], mediaCandidates: [{ visualId }] },
  ]) {
    let calls = 0;
    const result = await requestMaterialBatch({ taskId: "image-batch-extra-fields", input: { sections: [section], coverageGoals: [], fileName: "chapter5-page-001.png", progress: {}, mode: "image", visualId }, maxOutputTokens: 4_096, logger: () => {}, generate: async () => { calls += 1; return { ok: true, value: { notes: "The image contributes one distinction.", candidates: [candidate] } }; } });
    assertEquals(result.ok, false);
    assertEquals(calls, 2);
  }
});

Deno.test("image material batches fail closed on missing and unknown classifications", async () => {
  const section = { id: "image-1", url: "https://example.test/source#section=image-1", title: "Figure", locator: "image:1", text: "" };
  for (const classification of [undefined, { version: 1, primarySubject: "invented", secondarySubjects: [], subcategory: "figure" }]) {
    let calls = 0;
    const result = await requestMaterialBatch({ taskId: "image-classification", input: { sections: [section], coverageGoals: [], fileName: "figure.png", progress: {}, mode: "image", visualId: "visual:image-1" }, maxOutputTokens: 4_096, logger: () => {}, generate: async () => {
      calls += 1;
      const candidate = { summary: "The figure distinguishes two cases.", visibleEvidence: "Two labels are visible.", normalizedHash: "cases", coverageGoalIds: [], ...(classification === undefined ? {} : { classification }) };
      return { ok: true, value: { notes: "One distinction.", candidates: [candidate] } };
    } });
    assertEquals(result.ok, false);
    assertEquals(calls, 2);
  }
});

Deno.test("failed initial image processing retries once without changing the selected page", async () => {
  const section = { id: "page-4", url: "https://example.test/source#section=page-4", title: "Page 4", locator: "page:4", text: "" };
  const visualId = "visual:source:page-4";
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const base = { taskId: "retry-image", input: { sections: [section], coverageGoals: [], fileName: "source.pdf", progress: {}, mode: /** @type {const} */ ("image"), visualId }, attachments: [{ id: visualId, mediaType: /** @type {const} */ ("image/png"), bytes: png }], maxOutputTokens: 16_384, logger: () => {} };
  let calls = 0;
  const recovered = await requestMaterialBatch({ ...base, generate: async (command) => {
    calls++;
    if (command.attachments?.[0]?.id !== visualId) throw new Error("Retry changed visual identity.");
    return calls === 1 ? { ok: false, error: { kind: "KnowledgeModelUnavailable" } } : { ok: true, value: { notes: "The figure distinguishes two cases.", candidates: [{ summary: "The figure distinguishes two cases.", visibleEvidence: "Two labeled cases are shown.", normalizedHash: "cases", coverageGoalIds: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }] } };
  } });
  if (!recovered.ok || calls !== 2) throw new Error("Initial provider failure did not recover in one bounded retry.");
  calls = 0;
  const exhausted = await requestMaterialBatch({ ...base, generate: async () => { calls++; return { ok: false, error: { kind: "KnowledgeModelUnavailable" } }; } });
  if (exhausted.ok || exhausted.error.kind !== "KnowledgeModelUnavailable" || calls !== 2) throw new Error("Provider retries were not bounded.");
});

Deno.test("image processing repairs malformed JSON and retries rate limits, but not unsupported parameters", async () => {
  const section = { id: "image-1", url: "https://example.test/source#section=image-1", title: "Figure", locator: "image:1", text: "" };
  const base = { taskId: "image-repair", input: { sections: [section], coverageGoals: [], fileName: "figure.png", progress: {}, mode: /** @type {const} */ ("image"), visualId: "visual:image-1" }, maxOutputTokens: 4_096, logger: () => {} };
  for (const error of [{ kind: "KnowledgeModelResponseInvalid" }, { kind: "KnowledgeModelRejected", status: 429 }]) {
    let calls = 0;
    const result = await requestMaterialBatch({ ...base, generate: async (command) => { calls++; if (calls === 2 && error.kind === "KnowledgeModelResponseInvalid" && !command.systemPrompt.includes("# Correction")) throw new Error("Schema repair lacked targeted guidance."); return calls === 1 ? { ok: false, error } : { ok: true, value: { notes: "The figure supports one relationship.", candidates: [{ summary: "The figure distinguishes two cases.", visibleEvidence: "Two labeled cases are shown.", normalizedHash: "cases", coverageGoalIds: [], classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "theory" } }] } }; } });
    assertEquals(result.ok, true);
    assertEquals(calls, 2);
  }
  let calls = 0;
  const rejected = await requestMaterialBatch({ ...base, generate: async () => { calls++; return { ok: false, error: { kind: "KnowledgeModelRejected", status: 400 } }; } });
  assertEquals(rejected.ok, false);
  assertEquals(calls, 1);
});

Deno.test("planner accepts an explicit typed stop decision", async () => {
  const result = await requestExtractionPlan({
    taskId: "scraper-plan-stop-decision",
    input: { operation: "plan", rootUrl: "https://example.test/learn", scratchpad: scratchpad() },
    maxOutputTokens: 2048,
    logger: () => {},
    generate: async () => ({ ok: true, value: {
      revision: 3,
      frontier: [],
      coverageGoals: [{ id: "goal-covered", priority: "normal", description: "Covered supplied concept." }],
      unresolvedGaps: [],
      stopDecision: { decision: "complete", rationale: "The goal is covered and no relevant frontier remains.", evidenceUrls: ["https://example.test/learn"], unresolvedGapIds: [] },
    } }),
  });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.stopDecision.decision, "complete");
});
