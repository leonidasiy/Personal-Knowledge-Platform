import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createKnowledgeWorkflowRuntime } from "../worker/knowledge-workflow-runtime.js";
import { createKnowledgeWorkflowService } from "../src/features/knowledge-workflows/workflow.js";
import { createAgentConfigurationLoader } from "../src/features/knowledge-workflows/config.js";
import { D1KnowledgeWorkflowRepository } from "../worker/knowledge-workflow-d1.js";
import { D1KnowledgeWorkflowMaterialRepository } from "../worker/knowledge-workflow-material-d1.js";
import { parseAuthorizedMaterial } from "../src/features/knowledge-workflows/material.js";
import { packImageBundle, BUNDLE_TYPE } from "../src/features/knowledge-workflows/image-upload.js";

test("production upload runtime resumes text batches and processes selected PDF page images with one vision call each", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrations = new URL("../worker/migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) db.exec(await readFile(new URL(file, migrations), "utf8"));
    let interruptCheckpoint = true;
    const database = {
      prepare(query) {
        let values = [];
        const execute = () => {
          if (interruptCheckpoint && query.startsWith("INSERT INTO extraction_scratchpads") && JSON.parse(values[5]).processedUrls.length === 1) {
            interruptCheckpoint = false;
            return { success: false, meta: { changes: 0 } };
          }
          const result = db.prepare(query).run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        };
        return { bind(...bindings) { values = bindings; return this; }, async first() { return db.prepare(query).get(...values) ?? null; }, async all() { return { success: true, results: db.prepare(query).all(...values) }; }, async run() { return execute(); }, execute };
      },
      async batch(statements) {
        db.exec("BEGIN IMMEDIATE");
        try { const results = statements.map((statement) => statement.execute()); db.exec("COMMIT"); return results; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    };
    const unwrap = (result) => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value; };
    const logger = () => {};
    const clock = () => new Date().toISOString();
    const ownerId = "batch-owner", runId = "batch-run", sourceId = "batch-source", sourceUrl = "https://example.test/lesson.pdf";
    const repository = new D1KnowledgeWorkflowRepository({ database, logger });
    const materials = new D1KnowledgeWorkflowMaterialRepository({ database, logger });
    const service = createKnowledgeWorkflowService(repository, { now: clock, createId: () => runId, logger });
    const loader = createAgentConfigurationLoader({ sha256: async (value) => `sha256:${createHash("sha256").update(value).digest("hex")}` });
    const configs = {};
    for (const role of ["rights-assessor", "knowledge-scraper", "question-generator", "question-evaluator"]) configs[role] = unwrap(await loader.load({ source: await readFile(new URL(`../agent-config/${role}.yaml`, import.meta.url), "utf8"), expectedRole: role }));
    const sections = Array.from({ length: 7 }, (_, index) => ({ id: `page-${index + 1}`, title: `Page ${index + 1}`, locator: `page:${index + 1}`, text: index === 1 ? "" : `Synthetic source relationship ${index + 1}.` }));
    const material = { ownerId, runId, sourceId, sourceRevision: 1, sourceUrl, mediaType: "application/pdf", fileName: "synthetic.pdf", contentDigest: "sha256:synthetic", sections, media: [], provenance: { kind: "authorized-user-material", attestationReference: "synthetic-test", basis: "test-owned", processingAllowed: true } };
    let run = unwrap(await service.createRun({ ownerId, sourceId, sourceRevision: 1, canonicalSourceIdentity: sourceUrl, contentSignature: material.contentDigest, idempotencyKey: runId, sourceOrigin: "private-document", configDigests: Object.fromEntries(Object.entries(configs).map(([role, config]) => [role, config.digest])) })).run;
    unwrap(await materials.persist({ ownerId, runId, materialId: "batch-material", idempotencyKey: runId, fingerprint: material.contentDigest, objectKey: "synthetic-only", material, createdAt: clock() }));
    run = unwrap(await service.attachMaterial({ ownerId, runId, materialId: "batch-material" }));
    db.prepare("INSERT INTO library_sources (owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(ownerId, sourceId, sourceUrl, sourceUrl, "Synthetic source", "Offline batching fixture", JSON.stringify({ kind: "private-document" }), "[]", "active", clock(), clock(), 1);
    const batchSizes = [];
    const imageBatchSizes = [];
    let modelCalls = 0;
    const transport = async (_url, init) => {
      assert(++modelCalls < 80, "Bound the synthetic model fixture.");
      const body = JSON.parse(init.body);
      const message = body.messages[1].content;
      const envelope = Array.isArray(message) ? message[0].text : message;
      const task = JSON.parse(envelope.slice(envelope.indexOf("\n") + 1, envelope.lastIndexOf("\n"))).task;
      let output;
      if (task.operation === "plan-authorized-material" || task.operation === "replan-authorized-material") {
        // Even a sparse planner cannot drop supplied file pages.
        output = { revision: 1, frontier: [], coverageGoals: [], unresolvedGaps: [], stopDecision: { decision: "continue", rationale: "Observe supplied inventory.", evidenceUrls: [], unresolvedGapIds: [] } };
        assert.equal(task.scratchpad.pendingBatch, undefined);
      } else if (task.sections) {
        if (task.mode === "image") {
          imageBatchSizes.push(task.sections.length);
          assert.equal(message.length, 2);
          assert(message[1].image_url.url.startsWith("data:image/png;base64,"));
        } else batchSizes.push(task.sections.length);
        assert.equal(body.max_tokens, task.mode === "image" ? 4096 : 16384);
        assert(body.messages[0].content.includes("selection-v3"));
        if (task.mode === "image") {
          assert.equal(body.response_format.type, "json_schema");
          assert.equal(body.response_format.json_schema.strict, true);
          assert.equal(body.provider.require_parameters, true);
          assert.equal(body.provider.sort, "throughput");
          assert.equal(body.reasoning.effort, "low");
        } else assert.equal(body.response_format.type, "json_object");
        output = task.mode === "image"
          ? { notes: "Synthetic concise progress.", candidates: [{ summary: "The figure distinguishes two cases.", visibleEvidence: "Two cases are labeled in the figure.", normalizedHash: `fixture-image-${imageBatchSizes.length}`, coverageGoalIds: [], classification: { version: 1, primarySubject: null, secondarySubjects: [], subcategory: null } }] }
          : { pages: task.sections.map((section) => ({ url: section.url, notes: "Synthetic concise progress.", candidates: section.text === "" ? [] : [{ summary: section.text, normalizedHash: section.id, evidenceAnchors: [{ url: section.url, selector: section.locator }], coverageGoalIds: [], mediaCandidates: [], classification: { version: 1, primarySubject: null, secondarySubjects: [], subcategory: null } }] })) };
      } else if (task.draft) output = { score: 9, reasons: ["Synthetic fixture"], feedback: "Accepted fixture", groundingProblems: [] };
      else if (task.knowledge) output = { id: `quiz-${task.knowledge.normalizedHash}`, knowledgeId: task.knowledge.id, knowledgeRevision: 1, kind: "single-choice", prompt: `Which fixture belongs to ${task.knowledge.normalizedHash}?`, options: ["Fixture", "Other"], answer: "Fixture", explanation: "Synthetic explanation.", citedEvidenceUrls: task.knowledge.evidenceAnchors.map((anchor) => anchor.url) };
      else assert.fail("Unexpected synthetic model task");
      return Response.json({ id: `fixture-${modelCalls}`, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } });
    };
    const forbidden = async () => { assert.fail("Uploads must not use browser acquisition."); };
    let sawInterruption = false;
    for (let step = 0; step < 8 && run.state !== "completed"; step++) {
      if (run.state === "awaiting-time-limit-decision") run = unwrap(await service.advance({ ownerId, runId, expectedRevision: run.revision, nextState: "extraction-loop" }));
      const runtime = createKnowledgeWorkflowRuntime({ database, fetch: transport, browser: { readPage: forbidden, readRobots: forbidden, screenshot: forbidden, close: async () => ({ ok: true, value: null }) }, apiKey: "offline-fixture", endpoint: "https://example.test/model", now: clock, nowMs: Date.now, logger, configSnapshots: configs, imageSearch: { search: async () => assert.fail("Do not search for decorative images.") }, fallbackManifest: { entries: [], resolve: () => assert.fail("Do not attach a fallback to a text point.") }, material: materials, transition: ({ run: current, nextState, ...rest }) => service.advance({ ownerId, runId, expectedRevision: current.revision, nextState, ...rest }) });
      const executed = await runtime.execute(run);
      if (!executed.ok) {
        assert.equal(sawInterruption, false, JSON.stringify(executed.error));
        assert(JSON.stringify(executed.error).includes("ScratchpadPersistenceFailed"), JSON.stringify(executed.error));
        sawInterruption = true;
      }
      run = unwrap(await repository.findById(ownerId, runId));
    }
    assert.equal(sawInterruption, true);
    assert.equal(run.state, "completed");
    assert.deepEqual(batchSizes, [5, 2]);
    assert.equal(run.counts.pages, 7);
    assert.equal(run.counts.knowledgePoints, 6);
    assert.equal(run.counts.acceptedQuizzes, 6);
    const scratchpad = JSON.parse(db.prepare("SELECT scratchpad_json FROM extraction_scratchpads").get().scratchpad_json);
    assert.equal(scratchpad.pendingBatch, undefined);
    assert.equal(scratchpad.processedUrls.length, 7);

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const packed = unwrap(packImageBundle([2, 4, 6].map((number) => ({ name: `Page ${number}`, locator: `page:${number}`, mediaType: "image/png", bytes: png }))));
    const imageRunId = "image-run", imageSourceId = "image-source", imageSourceUrl = "https://example.test/private-figures";
    const imageMaterial = unwrap(await parseAuthorizedMaterial({ ownerId, runId: imageRunId, sourceId: imageSourceId, sourceRevision: 1, sourceUrl: imageSourceUrl, mode: "image", mediaType: BUNDLE_TYPE, fileName: "figures.pdf.pkpi", bytes: packed, idempotencyKey: imageRunId, rightsAttestation: { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis: "test-owned", reference: "synthetic-test" } }, { digest: async (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`, maximumBytes: 104_857_600, maximumCharacters: 1_000_000 }));
    const imageService = createKnowledgeWorkflowService(repository, { now: clock, createId: () => imageRunId, logger });
    let imageRun = unwrap(await imageService.createRun({ ownerId, sourceId: imageSourceId, sourceRevision: 1, canonicalSourceIdentity: imageSourceUrl, contentSignature: imageMaterial.contentDigest, idempotencyKey: imageRunId, sourceOrigin: "private-document", configDigests: Object.fromEntries(Object.entries(configs).map(([role, config]) => [role, config.digest])) })).run;
    unwrap(await materials.persist({ ownerId, runId: imageRunId, materialId: "image-material", idempotencyKey: imageRunId, fingerprint: imageMaterial.contentDigest, objectKey: "synthetic-images", material: imageMaterial, createdAt: clock() }));
    imageRun = unwrap(await imageService.attachMaterial({ ownerId, runId: imageRunId, materialId: "image-material" }));
    db.prepare("INSERT INTO library_sources (owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(ownerId, imageSourceId, imageSourceUrl, imageSourceUrl, "Synthetic figures", "Offline visual fixture", JSON.stringify({ kind: "private-document" }), "[]", "active", clock(), clock(), 1);
    let imageReads = 0;
    for (let step = 0; step < 8 && imageRun.state !== "completed"; step++) {
      const runtime = createKnowledgeWorkflowRuntime({ database, fetch: transport, browser: { readPage: forbidden, readRobots: forbidden, screenshot: forbidden, close: async () => ({ ok: true, value: null }) }, apiKey: "offline-fixture", endpoint: "https://example.test/model", now: clock, nowMs: Date.now, logger, configSnapshots: configs, material: materials, materialContent: { read: async () => { imageReads++; return { ok: true, value: packed }; } }, transition: ({ run: current, nextState, ...rest }) => imageService.advance({ ownerId, runId: imageRunId, expectedRevision: current.revision, nextState, ...rest }) });
      const executed = await runtime.execute(imageRun);
      assert.equal(executed.ok, true, JSON.stringify(executed.error));
      imageRun = unwrap(await repository.findById(ownerId, imageRunId));
    }
    assert.equal(imageRun.state, "completed");
    assert.deepEqual(imageBatchSizes, [1, 1, 1]);
    assert.equal(imageReads, 1);
    assert.equal(imageRun.counts.pages, 3);
    assert.equal(imageRun.counts.knowledgePoints, 3);
  } finally { db.close(); }
});
