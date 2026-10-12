import {syntheticAssessment,syntheticReviewAudit} from './fixtures/knowledge-review-audit.mjs';
import { WEBPAGE_IMAGE_POLICY } from '../worker/webpage-image-budget.js';
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
import { createRenderer } from "../acquisition/renderer.ts";
import { ACQUISITION_POLICY } from "../worker/acquisition-policy.js";

test("production upload runtime resumes text batches and processes selected PDF page images with observation, extraction and source review", async () => {
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
    for (const role of ["rights-assessor", "knowledge-scraper", "question-generator", "question-evaluator"]) configs[role] = unwrap(await loader.load({ source: (await readFile(new URL(`../agent-config/${role}.yaml`, import.meta.url), "utf8")).replace(/name: [^\n]+/, `name: synthetic/${role}`), expectedRole: role }));
    const sections = Array.from({ length: 7 }, (_, index) => ({ id: `page-${index + 1}`, title: `Page ${index + 1}`, locator: `page:${index + 1}`, text: index === 1 ? "" : `Synthetic source relationship ${index + 1}.` }));
    const material = { ownerId, runId, sourceId, sourceRevision: 1, sourceUrl, mediaType: "application/pdf", fileName: "synthetic.pdf", contentDigest: "sha256:synthetic", sections, media: [], provenance: { kind: "authorized-user-material", attestationReference: "synthetic-test", basis: "test-owned", processingAllowed: true } };
    let run = unwrap(await service.createRun({ ownerId, sourceId, sourceRevision: 1, canonicalSourceIdentity: sourceUrl, contentSignature: material.contentDigest, idempotencyKey: runId, sourceOrigin: "private-document", configDigests: Object.fromEntries(Object.entries(configs).map(([role, config]) => [role, config.digest])) })).run;
    unwrap(await materials.persist({ ownerId, runId, materialId: "batch-material", idempotencyKey: runId, fingerprint: material.contentDigest, objectKey: "synthetic-only", material, createdAt: clock() }));
    run = unwrap(await service.attachMaterial({ ownerId, runId, materialId: "batch-material" }));
    db.prepare("INSERT INTO library_sources (owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(ownerId, sourceId, sourceUrl, sourceUrl, "Synthetic source", "Offline batching fixture", JSON.stringify({ kind: "private-document" }), "[]", "active", clock(), clock(), 1);
    const batchSizes = [];
    const imageBatchSizes = [];
    const imageObservationSizes = [];
    const materialReviews = [];
    const qualityReviews = [];
    let modelCalls = 0; let invalidPairedDraftInjected = false, pairedFeedbackSeen = false;
    const transport = async (_url, init) => {
      assert(++modelCalls < 80, "Bound the synthetic model fixture.");
      const body = JSON.parse(init.body);
      const message = body.messages[1].content;
      const envelope = Array.isArray(message) ? message[0].text : message;
      const modelInput = JSON.parse(envelope.slice(envelope.indexOf("\n") + 1, envelope.lastIndexOf("\n")));
      const task = modelInput.task;
      assert.equal(body.model,configs[modelInput.contract.role].model.name);
      assert.deepEqual(body.reasoning, { effort: configs[modelInput.contract.role].model.reasoningEffort });
      if(body.response_format?.json_schema?.name==='quiz_evaluation_v3'){
        assert.equal(body.max_tokens,2048);assert.equal(modelInput.contract.role,'question-evaluator');
        assert.match(body.messages[0].content,/paired-question-evaluator-v8/);
        assert.match(body.messages[0].content,/A faithful narrower relationship need not restore an unrelated or nonessential removed qualifier/);
        assert.match(body.messages[0].content,/Conditions, negations, units and causal qualifications necessary to preserve that relationship remain required/);
        assert.match(body.messages[0].content,/entire retained knowledge.summary/);
        assert.match(body.messages[0].content,/Quiz regeneration changes only the quiz/);
        assert(body.response_format.json_schema.schema.required.includes('knowledgeGroundingProblems'));
      }
      if(body.response_format?.json_schema?.name==='paired_quiz_v3'){
        assert.match(body.messages[0].content,/Unicode NFKC normalization, trimming, case folding, and collapsing whitespace/);
        assert.match(body.messages[0].content,/exact canonical answer alone is sufficient/);
        assert.match(body.messages[0].content,/Synonyms are optional/);
        assert.match(body.response_format.json_schema.schema.properties.fillBlank.properties.blanks.items.properties.acceptedAnswers.description,/exact canonical answer alone is sufficient/);
        assert.match(body.response_format.json_schema.schema.properties.fillBlank.properties.blanks.items.properties.acceptedAnswers.description,/unique after Unicode NFKC/);
      }
      let output;
      if (body.response_format?.json_schema?.name==='knowledge_quality_review_v11') {
        qualityReviews.push(task.sourceMode);
        assert.equal(modelInput.contract.role,'question-evaluator');
        assert(task.sourceEvidence.sections.some(section=>section.locator===task.knowledge.evidenceAnchors[0].selector));
        output={decision:'pass',reasons:['Synthetic source/pixel review fixture.'],feedback:'Accepted fixture.',matchedLessOftenIds:[],supportingImageEvidence:task.sourceMode==='image'?'Synthetic pixel cue for the fixture.':'',allowTextOnly:task.sourceMode==='text'};output=syntheticAssessment(task,output);
      } else if (task.source && task.points) output = { mainSubject: "music", topic: "Synthetic source relationships" };
      else if (task.operation === "plan-authorized-material" || task.operation === "replan-authorized-material") {
        // Even a sparse planner cannot drop supplied file pages.
        output = { revision: 1, frontier: [], coverageGoals: [], unresolvedGaps: [], stopDecision: { decision: "continue", rationale: "Observe supplied inventory.", evidenceUrls: [], unresolvedGapIds: [] } };
        assert.equal(task.scratchpad.pendingBatch, undefined);
      } else if (task.operation === "review-material-source") {
        materialReviews.push(task.mode);
        assert.equal(body.response_format.type, "json_object");
        output = { notes: "Synthetic source review.", reviews: task.candidates.map(candidate => ({ candidateIndex: candidate.candidateIndex, points: [{ summary: candidate.summary, visibleEvidence: candidate.evidenceAnchors[0].visibleEvidence ?? "Synthetic source relationship." }] })) };
      } else if (task.sections) {
        if (task.mode === "image") {
          (task.operation === "observe-material-image" ? imageObservationSizes : imageBatchSizes).push(task.sections.length);
          assert.equal(message.length, 3);
          assert.equal(message[1].type, "text");
          assert.equal(message[1].text, `Attachment ID: visual:${imageMaterial.contentDigest}:${task.sections[0].id}; mediaType: image/png. The following image belongs only to this ID.`);
          assert.equal(message[2].type, "image_url");
          assert.equal(message[2].image_url.url, `data:image/png;base64,${Buffer.from(png).toString("base64")}`);
        } else batchSizes.push(task.sections.length);
        assert.equal(body.max_tokens, 16384);
        if (task.operation !== "observe-material-image") assert(body.messages[0].content.includes("selection-v3"));
        if (task.mode === "image") {
          if (task.operation !== "observe-material-image") {
            assert.match(body.messages[0].content, /first identify the named curve pair/);
            assert.deepEqual(task.visualObservations, { notes: "Synthetic observation.", observations: [{ id: "observed-1", description: "Two cases are labeled." }] });
          }
          assert.equal(body.response_format.type, "json_schema");
          assert.equal(body.response_format.json_schema.strict, true);
          if (task.operation !== "observe-material-image") assert.match(body.response_format.json_schema.schema.properties.candidates.items.properties.visibleEvidence.description, /actual curve pair/);
          else assert.equal(body.response_format.json_schema.name, "material_image_observation_v1");
          assert.equal(body.provider.require_parameters, true);
          assert.equal(body.provider.sort, "throughput");
        } else {
          assert.equal(body.response_format.type, "json_schema");
          assert.equal(body.response_format.json_schema.name, "material_text_v1");
          assert.equal(body.response_format.json_schema.strict, true);
          assert.match(body.messages[0].content, /# PDF text scope/);
          assert(task.sections.every(section => section.textIntegrity.replacementCharacterCount === 0));
          assert.doesNotMatch(body.messages[0].content, /Aim for 30–80 words/);
        }
        output = task.operation === "observe-material-image"
          ? { notes: "Synthetic observation.", observations: [{ id: "observed-1", description: "Two cases are labeled." }] }
          : task.mode === "image"
          ? { notes: "Synthetic concise progress.", candidates: [{ summary: "The figure distinguishes two cases.", visibleEvidence: "Two cases are labeled in the figure.", normalizedHash: `fixture-image-${imageBatchSizes.length}`, coverageGoalIds: [] }] }
          : { pages: task.sections.map((section) => ({ url: section.url, notes: "Synthetic concise progress.", candidates: section.text === "" ? [] : [{ summary: section.text, normalizedHash: section.id, evidenceAnchors: [{ url: section.url, selector: section.locator }], coverageGoalIds: [], mediaCandidates: [] }] })) };
      } else if (task.source && task.points) output = { mainSubject: "music", topic: "Synthetic material" };
      else if (task.draft) output = { score: 9, reasons: ["Synthetic fixture"], feedback: "Accepted fixture", groundingProblems: [], knowledgeGroundingProblems: [] };
      else if (task.knowledge) output = { knowledgeId: task.knowledge.id, knowledgeRevision: task.knowledge.sourceRevision, canonicalAnswers: ["fixture"], citedEvidenceUrls: task.knowledge.evidenceAnchors.map((anchor) => anchor.url), multipleChoice: { prompt: `Which fixture belongs to ${task.knowledge.normalizedHash}?`, options: [{ key: "choice-a", text: "Fixture" }, { key: "choice-b", text: "Other" }], correctOptionKeys: ["choice-a"], correctOptionAnswers: [{ key: "choice-a", canonicalAnswer: "fixture" }], explanation: "Fixture is supported by the source." }, fillBlank: { prompt: "The supported answer is ____.", blanks: [{ id: "blank-1", canonicalAnswer: "fixture", acceptedAnswers: ["fixture"] }], explanation: "Fixture is supported by the source." } };
      else assert.fail("Unexpected synthetic model task");
      if(body.response_format?.json_schema?.name === "paired_quiz_v3") {
        if (!invalidPairedDraftInjected) { invalidPairedDraftInjected=true; output.fillBlank.blanks[0].canonicalAnswer="other";output.fillBlank.blanks[0].acceptedAnswers=["other","ＯＴＨＥＲ"]; }
        else if(task.feedback?.includes("Paired-quiz validation issues")) { pairedFeedbackSeen=true;assert.match(task.feedback,/canonicalAnswer:/);assert.match(task.feedback,/acceptedAnswers\[0\]:/);assert.match(task.feedback,/NFKC-equivalent/);assert.equal(task.attempt,2);assert(task.sourceEvidence.sections.length>0); }
      }
      return Response.json({ id: `fixture-${modelCalls}`, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } });
    };
    const forbidden = async () => { assert.fail("Uploads must not use browser acquisition."); };
    let sawInterruption = false;
    for (let step = 0; step < 8 && run.state !== "completed"; step++) {
      if (run.state === "awaiting-time-limit-decision") run = unwrap(await service.advance({ ownerId, runId, expectedRevision: run.revision, nextState: "extraction-loop" }));
      const runtime = createKnowledgeWorkflowRuntime({imagePolicy:WEBPAGE_IMAGE_POLICY, database, fetch: transport, browser: { readPage: forbidden, readRobots: forbidden, screenshot: forbidden, close: async () => ({ ok: true, value: null }) }, apiKey: "offline-fixture", endpoint: "https://example.test/model", now: clock, nowMs: Date.now, logger, configSnapshots: configs, imageSearch: { search: async () => assert.fail("Do not search for decorative images.") }, fallbackManifest: { entries: [], resolve: () => assert.fail("Do not attach a fallback to a text point.") }, material: materials, transition: ({ run: current, nextState, ...rest }) => service.advance({ ownerId, runId, expectedRevision: current.revision, nextState, ...rest }) });
      const executed = await runtime.execute(run);
      if (!executed.ok) {
        assert.equal(sawInterruption, false, JSON.stringify(executed.error));
        assert(JSON.stringify(executed.error).includes("ScratchpadPersistenceFailed"), JSON.stringify(executed.error));
        sawInterruption = true;
      }
      run = unwrap(await repository.findById(ownerId, runId));
    }
    assert.equal(sawInterruption, true);assert.equal(pairedFeedbackSeen,true);
    assert.equal(run.state, "completed");
    assert.deepEqual(batchSizes, [5, 2]);
    assert.equal(run.counts.pages, 7);
    assert.equal(run.counts.knowledgePoints, 6);
    assert.equal(run.counts.acceptedQuizzes, 6);
    const scratchpad = JSON.parse(db.prepare("SELECT scratchpad_json FROM extraction_scratchpads").get().scratchpad_json);
    assert.equal(scratchpad.pendingBatch, undefined);
    assert.equal(scratchpad.processedUrls.length, 7);

    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));
    const decoder = createRenderer({ policy: ACQUISITION_POLICY, chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", nodePath: process.execPath, platform: process.platform, request: forbidden });
    let decodeCalls = 0;
    const decodeImage = async (bytes, mediaType) => {
      decodeCalls++;
      assert.deepEqual(bytes, png);
      assert.equal(mediaType, "image/png");
      return decoder.decodeImage(bytes, mediaType, new AbortController().signal);
    };
    const packed = unwrap(packImageBundle([2, 4, 6].map((number) => ({ name: `Page ${number}`, locator: `page:${number}`, mediaType: "image/png", bytes: png }))));
    const imageRunId = "image-run", imageSourceId = "image-source", imageSourceUrl = "https://example.test/private-figures";
    const imageMaterial = unwrap(await parseAuthorizedMaterial({ ownerId, runId: imageRunId, sourceId: imageSourceId, sourceRevision: 1, sourceUrl: imageSourceUrl, mode: "image", mediaType: BUNDLE_TYPE, fileName: "figures.pdf.pkpi", bytes: packed, idempotencyKey: imageRunId, rightsAttestation: { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis: "test-owned", reference: "synthetic-test" } }, { digest: async (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`, maximumBytes: 104_857_600, maximumCharacters: 1_000_000 }));
    const imageService = createKnowledgeWorkflowService(repository, { now: clock, createId: () => imageRunId, logger });
    let imageRun = unwrap(await imageService.createRun({ ownerId, sourceId: imageSourceId, sourceRevision: 1, canonicalSourceIdentity: imageSourceUrl, contentSignature: imageMaterial.contentDigest, idempotencyKey: imageRunId, sourceOrigin: "private-document", configDigests: Object.fromEntries(Object.entries(configs).map(([role, config]) => [role, config.digest])) })).run;
    unwrap(await materials.persist({ ownerId, runId: imageRunId, materialId: "image-material", idempotencyKey: imageRunId, fingerprint: imageMaterial.contentDigest, objectKey: "synthetic-images", material: imageMaterial, createdAt: clock() }));
    imageRun = unwrap(await imageService.attachMaterial({ ownerId, runId: imageRunId, materialId: "image-material" }));
    db.prepare("INSERT INTO library_sources (owner_id,source_id,submitted_url,canonical_url,title,description,adapter_json,identity_evidence_json,state,approved_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(ownerId, imageSourceId, imageSourceUrl, imageSourceUrl, "Synthetic figures", "Offline visual fixture", JSON.stringify({ kind: "private-document" }), "[]", "active", clock(), clock(), 1);
    let imageReads = 0;
    const originals=new Map();
    const media={ingest:async()=>assert.fail('Uploaded originals must use bytes.'),ingestBytes:async command=>{
      assert.equal(command.ownerId,ownerId);assert.equal(command.runId,imageRunId);assert.deepEqual(command.bytes,png);
      assert.equal(command.binding.originalDigest,`sha256:${createHash('sha256').update(png).digest('hex')}`);
      originals.set(command.knowledgeId,{id:command.binding.imageId,bytes:command.bytes,mediaType:'image/png'});return {ok:true,value:null};
    }};
    const reviewMedia={readOriginal:async scope=>{assert.equal(scope.ownerId,ownerId);assert.equal(scope.runId,imageRunId);assert.equal(scope.sourceRevision,1);return {ok:true,value:originals.get(scope.knowledgeId)??null};}};
    let reviewRuntime;
    for (let step = 0; step < 8 && imageRun.state !== "completed"; step++) {
      const runtime = createKnowledgeWorkflowRuntime({imagePolicy:WEBPAGE_IMAGE_POLICY, database, fetch: transport, browser: { readPage: forbidden, readRobots: forbidden, screenshot: forbidden, close: async () => ({ ok: true, value: null }) }, apiKey: "offline-fixture", endpoint: "https://example.test/model", now: clock, nowMs: Date.now, logger, configSnapshots: configs, material: materials, media, reviewMedia, decodeImage, materialContent: { read: async () => { imageReads++; return { ok: true, value: packed }; } }, transition: ({ run: current, nextState, ...rest }) => imageService.advance({ ownerId, runId: imageRunId, expectedRevision: current.revision, nextState, ...rest }) });
      reviewRuntime=runtime;
      const executed = await runtime.execute(imageRun);
      assert.equal(executed.ok, true, JSON.stringify(executed.error));
      imageRun = unwrap(await repository.findById(ownerId, imageRunId));
    }
    assert.equal(imageRun.state, "completed");
    assert.deepEqual(imageBatchSizes, [1, 1, 1]);
    assert.deepEqual(imageObservationSizes, [1, 1, 1]);
    assert.deepEqual(materialReviews, []); // The new verdict-only critic replaces the legacy rewriting normalizer.
    assert.deepEqual(qualityReviews,[...Array(6).fill('text'),...Array(3).fill('image')]); // Interrupted text checkpoint replays completed review decisions.
    assert.equal(originals.size,3);
    assert.equal(imageReads, 1);
    assert.equal(decodeCalls, 12); // Acquisition, attachment, independent review and media handoff each validate original pixels.
    assert.equal(imageRun.counts.pages, 3);
    assert.equal(imageRun.counts.knowledgePoints, 3);
    const stage=JSON.parse(db.prepare("SELECT result_json FROM knowledge_workflow_stages WHERE owner_id=? AND run_id=? AND stage_key LIKE 'knowledge-quality:%' ORDER BY stage_key LIMIT 1").get(ownerId,imageRunId).result_json).value;
    const originalEvidence=JSON.parse(db.prepare("SELECT evidence_json FROM knowledge_workflow_review_evidence WHERE owner_id=? AND run_id=? AND knowledge_id=?").get(ownerId,imageRunId,stage.point.id).evidence_json);
    const beforeReplay=modelCalls;
    const replayed=unwrap(await reviewRuntime.reviewCapturedCandidate({run:imageRun,point:stage.point,sourceEvidence:originalEvidence,sourceMode:'image',supportingImage:originals.get(stage.point.id)}));
    assert.equal(replayed.point.id,stage.point.id);
    assert.equal(replayed.binding,undefined); // Original raster uses its scoped uploaded-source binding.
    const actor=unwrap(reviewRuntime.createQuizActorForRun(imageRun));
    const replayedQuiz=unwrap(await actor.run({ownerId,runId:imageRunId,points:[stage.point]}));
    assert.equal(replayedQuiz.dispositions[0].status,'accepted');
    assert.equal((await actor.run({ownerId:'another-owner',runId:imageRunId,points:[stage.point]})).error.kind,'QuizCommandInvalid');
    assert.equal((await reviewRuntime.reviewCapturedCandidate({run:imageRun,point:{...stage.point,sourceId:'another-source'},sourceEvidence:originalEvidence,sourceMode:'image',supportingImage:originals.get(stage.point.id)})).error.kind,'KnowledgeReviewCommandInvalid');
    assert.equal(modelCalls,beforeReplay); // Both shared public seams replay actual completed application stages.

  } finally { db.close(); }
});
