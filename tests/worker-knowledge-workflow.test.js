// @ts-check

import { createDiscoveryWorker } from "../worker/handler.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

/** @param {{ readonly sourceFailureKind?: string, readonly sourceState?: string, readonly sourceReused?: boolean, readonly workflowMode?: "throw" | "hang" | "malformed" }} [options] */
function makeFixture(options = {}) {
  const source = { id: "source-a", ownerId: "owner-a", origin: "web", submittedUrl: "https://example.test/learn", canonicalUrl: "https://example.test/learn", title: "Learning source", description: "Description", adapter: { id: "adapter", version: "1", granularity: "root", capabilities: ["metadata"] }, interestAreaIds: ["area-a"], identityEvidence: [], state: "active", approvedAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", revision: 1 };
  /** @type {Record<string, unknown>[]} */ const started = [];
  /** @type {Record<string, unknown>[]} */ const rightsApproved = [];
  /** @type {Record<string, unknown>[]} */ const revoked = [];
  /** @type {Record<string, unknown>[]} */ const legacyIngestion = [];
  /** @type {Record<string, unknown>[]} */ const materials = [];
  /** @type {Record<string, unknown>[]} */ const privateDocuments = [];
  /** @type {Record<string, unknown>[]} */ const logs = [];
  const worker = createDiscoveryWorker({ allowedOrigin: "https://app.example", maximumCommandBytes: 4096, maximumBackendOperationMs: 5 }, {
    createRequestId: () => "corr-workflow",
    requestLogger: (entry) => { logs.push(entry); return { ok: true, value: null }; },
    now: () => "2026-08-13T00:05:00.000Z",
    authenticate: async () => ({ ok: true, value: { ownerId: "owner-a", email: "member@example.test" } }),
    acquireRss: async () => ({ ok: false, error: { kind: "DiscoveryFetchUnavailable" } }),
    sourceLibrary: {
      approve: async () => ({ ok: true, value: { source, job: null, reused: options.sourceReused ?? false } }),
      createPrivateDocument: async (command) => {
        privateDocuments.push(/** @type {Record<string, unknown>} */ (command));
        return { ok: true, value: { source: { ...source, id: "source-private", origin: "private-document", submittedUrl: "https://app.example/api/private-documents/source-private", canonicalUrl: "https://app.example/api/private-documents/source-private", title: "Week 3", description: "week3.pdf", adapter: { id: "private-document", version: "v1", granularity: "document", capabilities: ["owner-private-document", "processing-attested"] }, interestAreaIds: [] }, job: null, reused: options.sourceReused ?? false } };
      },
      revise: async () => ({ ok: true, value: source }),
      disable: async () => ({ ok: true, value: { ...source, state: "disabled" } }),
      restore: async () => ({ ok: true, value: source }),
      reject: async () => ({ ok: true, value: { suppression: {}, reused: false } }),
    },
    sourceRightsApproval: {
      approve: async () => ({ ok: true, value: { approvalId: "approval-a", registryId: "registry-a", sourceId: "source-a", sourceRevision: 1, jobId: null, requeued: false, reused: false } }),
    },
    sourceIngestion: {
      run: async (command) => { legacyIngestion.push(/** @type {Record<string, unknown>} */ (command)); return { ok: true, value: { state: "completed", itemsStored: 1 } }; },
    },
    knowledgeWorkflow: {
      start: async (command) => { started.push(/** @type {Record<string, unknown>} */ (command)); return { ok: true, value: { runId: "run-a", reused: false } }; },
      status: async () => {
        if (options.workflowMode === "throw") throw new Error("D1 unavailable");
        if (options.workflowMode === "hang") return await new Promise(() => {});
        if (options.workflowMode === "malformed") return /** @type {never} */ ({ ok: true });
        return { ok: true, value: { runId: "run-a", state: "extraction-loop", revision: 2, extractionStartedAt: "2026-08-13T00:00:00.000Z", decisionRequired: null, counts: { pages: 1, knowledgePoints: 1, acceptedQuizzes: 0, pendingQuizzes: 0 }, extractionDeadlineAt: "2026-08-13T00:30:00.000Z", failureKind: null } };
      },
      sourceStatus: async (command) => ({ ok: true, value: { ownerId: /** @type {{ readonly ownerId: string }} */ (command).ownerId, sourceId: /** @type {{ readonly sourceId: string }} */ (command).sourceId, run: { runId: "run-a", state: options.sourceState ?? "awaiting-upload", revision: 3, extractionStartedAt: "2026-08-13T00:00:00.000Z", decisionRequired: options.sourceState === "retryable-failure" ? null : "upload-material", counts: { pages: 1, knowledgePoints: 0, acceptedQuizzes: 0, pendingQuizzes: 0 }, extractionDeadlineAt: "2026-08-13T00:30:00.000Z", failureKind: options.sourceFailureKind ?? "KnowledgePagePaywallDetected" } } }),
      control: async (command) => { const value = /** @type {{ readonly action: string, readonly expectedRevision: number }} */ (command); return { ok: true, value: { state: value.action === "stop" ? "paused" : "per-point-quiz-loop", revision: value.expectedRevision + 1 } }; },
      rightsApproved: async (command) => { rightsApproved.push(/** @type {Record<string, unknown>} */ (command)); return { ok: true, value: { state: "robots-check", revision: 3 } }; },
      material: async (command) => { materials.push(/** @type {Record<string, unknown>} */ (command)); return { ok: true, value: { status: "attached", materialId: "material-a", runId: "run-a", reused: false } }; },
      revokeSource: async (command) => { revoked.push(/** @type {Record<string, unknown>} */ (command)); return { ok: true, value: null }; },
    },
    learningMedia: {
      serve: async (/** @type {unknown} */ command) => /** @type {Record<string, unknown>} */ (command).assetId === "media-a" ? { ok: true, value: { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" } } : { ok: false, error: { kind: "MediaDerivativeNotFound" } },
    },
  });
  return { worker, started, rightsApproved, revoked, legacyIngestion, materials, privateDocuments, logs };
}

Deno.test("source approval starts one owner-scoped knowledge workflow after persistence", async () => {
  const fixture = makeFixture();
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/source-library/approve", { method: "POST", headers: { origin: "https://app.example" }, body: JSON.stringify({ identityStatus: "resolved", submittedUrl: "https://example.test/learn", canonicalUrl: "https://example.test/learn", title: "Learning source", description: "Description", idempotencyKey: "source-approve-1", adapter: { id: "adapter", version: "1", granularity: "root", capabilities: ["metadata"] }, interestAreaIds: ["area-a"], identityEvidence: [] }) }));
  assertEquals(response.status, 200);
  assertEquals(fixture.started.length, 1);
  assertEquals(fixture.started[0].ownerId, "owner-a");
  assertEquals(fixture.started[0].sourceId, "source-a");
});

Deno.test("idempotent source approval rechecks the durable workflow launch", async () => {
  const fixture = makeFixture({ sourceReused: true });
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/source-library/approve", { method: "POST", headers: { origin: "https://app.example" }, body: JSON.stringify({ identityStatus: "resolved", submittedUrl: "https://example.test/learn", canonicalUrl: "https://example.test/learn", title: "Learning source", description: "Description", idempotencyKey: "source-approve-1", adapter: { id: "adapter", version: "1", granularity: "root", capabilities: ["metadata"] }, interestAreaIds: ["area-a"], identityEvidence: [] }) }));
  assertEquals(response.status, 200);
  assertEquals(fixture.started.length, 1);
});

Deno.test("owner-attested private document creates an awaiting-upload workflow without source ingestion", async () => {
  const fixture = makeFixture();
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/source-library/private-documents", { method: "POST", headers: { origin: "https://app.example" }, body: JSON.stringify({ title: "Week 3 student notes", fileName: "week3-student.pdf", idempotencyKey: "private-document-1", rightsAttestation: { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis: "learner-attested lawful copy", reference: "learner-attestation:1" } }) }));
  assertEquals(response.status, 200);
  assertEquals(fixture.privateDocuments.length, 1);
  assertEquals(fixture.privateDocuments[0].ownerId, "owner-a");
  assertEquals(fixture.privateDocuments[0].applicationOrigin, "https://app.example");
  assertEquals(fixture.started.length, 1);
  assertEquals(fixture.started[0].sourceId, "source-private");
  assertEquals(fixture.legacyIngestion.length, 0);
  const body = /** @type {{ readonly result: { readonly source: { readonly origin: string }, readonly runId: string } }} */ (await response.json());
  assertEquals(body.result.source.origin, "private-document");
  assertEquals(body.result.runId, "run-a");
});

Deno.test("private document route rejects an owner forgery before creation", async () => {
  const fixture = makeFixture();
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/source-library/private-documents", { method: "POST", headers: { origin: "https://app.example" }, body: JSON.stringify({ ownerId: "owner-b", title: "Week 3", fileName: "week3.pdf", idempotencyKey: "private-document-forgery", rightsAttestation: { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis: "learner-attested lawful copy", reference: "learner-attestation:forgery" } }) }));
  assertEquals(response.status, 400);
  assertEquals(fixture.privateDocuments.length, 0);
  assertEquals(fixture.started.length, 0);
});

Deno.test("workflow status and control routes preserve owner scope and typed commands", async () => {
  const fixture = makeFixture();
  const status = await fixture.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/status?runId=run-a", { headers: { origin: "https://app.example" } }));
  assertEquals(status.status, 200);
  const statusBody = /** @type {{ readonly result: Record<string, unknown> }} */ (await status.json());
  assertEquals(Object.hasOwn(statusBody.result, "canonicalSourceIdentity"), false);
  assertEquals(Object.hasOwn(statusBody.result, "contentSignature"), false);
  assertEquals(Object.hasOwn(statusBody.result, "idempotencyKey"), false);
  assertEquals(Object.hasOwn(statusBody.result, "configDigests"), false);
  assertEquals(statusBody.result.elapsedMs, 300000);
  assertEquals(statusBody.result.remainingMs, 1500000);
  const control = await fixture.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/control", { method: "POST", headers: { origin: "https://app.example" }, body: JSON.stringify({ runId: "run-a", expectedRevision: 2, action: "stop", idempotencyKey: "stop-1" }) }));
  assertEquals(control.status, 200);
  const foreign = await fixture.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/control", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ runId: "run-a", expectedRevision: 2, action: "stop", idempotencyKey: "stop-2" }) }));
  assertEquals(foreign.status, 403);
});

Deno.test("workflow status dependencies are bounded and classify backend failures", async () => {
  const timeout = makeFixture({ workflowMode: "hang" });
  const timeoutResponse = await timeout.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/status?runId=run-a", { headers: { origin: "https://app.example" } }));
  assertEquals(timeoutResponse.status, 504);
  assertEquals((await timeoutResponse.json()).error, "KnowledgeWorkflowDependencyTimedOut");
  assertEquals(timeout.logs.some((entry) => entry.failureKind === "KnowledgeWorkflowDependencyTimedOut"), true);

  const thrown = makeFixture({ workflowMode: "throw" });
  const thrownResponse = await thrown.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/status?runId=run-a"));
  assertEquals(thrownResponse.status, 503);
  assertEquals((await thrownResponse.json()).error, "KnowledgeWorkflowDependencyFailed");

  const malformed = makeFixture({ workflowMode: "malformed" });
  const malformedResponse = await malformed.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/status?runId=run-a"));
  assertEquals(malformedResponse.status, 503);
  assertEquals((await malformedResponse.json()).error, "KnowledgeWorkflowResultInvalid");
});

Deno.test("source workflow status explains paywall blocks without exposing internal workflow fields", async () => {
  const fixture = makeFixture();
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/source-status?sourceId=source-a", { headers: { origin: "https://app.example" } }));
  assertEquals(response.status, 200);
  const body = /** @type {{ readonly result: Record<string, unknown> }} */ (await response.json());
  assertEquals(body.result.reasonCode, "paywall-or-login");
  assertEquals(body.result.message, "This source could not be scraped because it is behind a paywall or requires sign-in. Upload authorized text, PDF, PPTX, or a transcript instead.");
  const run = /** @type {Record<string, unknown>} */ (body.result.run);
  assertEquals(Object.hasOwn(run, "canonicalSourceIdentity"), false);
});

Deno.test("source workflow status distinguishes an unverified robots file from an explicit robots denial", async () => {
  const fixture = makeFixture({ sourceFailureKind: "RobotsFetchUnavailable" });
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/source-status?sourceId=source-a", { headers: { origin: "https://app.example" } }));
  assertEquals(response.status, 200);
  const body = /** @type {{ readonly result: Record<string, unknown> }} */ (await response.json());
  assertEquals(body.result.reasonCode, "robots-check-unavailable");
  assertEquals(body.result.message, "This source's robots.txt could not be verified. Upload authorized text, PDF, PPTX, or a transcript instead.");
});

Deno.test("source workflow status explains when robots 403 is followed by an unreachable source page", async () => {
  const fixture = makeFixture({ sourceFailureKind: "RobotsTargetUnavailable" });
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/source-status?sourceId=source-a", { headers: { origin: "https://app.example" } }));
  assertEquals(response.status, 200);
  const body = /** @type {{ readonly result: Record<string, unknown> }} */ (await response.json());
  assertEquals(body.result.reasonCode, "robots-check-unavailable");
  assertEquals(body.result.message, "The source's robots.txt returned HTTP 403 and the source page could not be reached by the browser. Upload authorized text, PDF, PPTX, or a transcript instead.");
});

Deno.test("source workflow status exposes a retryable planner failure with an actionable explanation", async () => {
  const fixture = makeFixture({ sourceState: "retryable-failure", sourceFailureKind: "ExtractionPlanInvalid" });
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/source-status?sourceId=source-a", { headers: { origin: "https://app.example" } }));
  assertEquals(response.status, 200);
  const body = /** @type {{ readonly result: Record<string, unknown> }} */ (await response.json());
  assertEquals(body.result.reasonCode, "retryable-failure");
  assertEquals(body.result.message, "Automatic extraction stopped because the planner returned an invalid ExtractionPlan after one correction attempt (ExtractionPlanInvalid). Retry processing to try again.");
});

Deno.test("source workflow status does not mislabel a non-planner retryable failure", async () => {
  const fixture = makeFixture({ sourceState: "retryable-failure", sourceFailureKind: "WorkflowExtractionFailed" });
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/source-status?sourceId=source-a", { headers: { origin: "https://app.example" } }));
  assertEquals(response.status, 200);
  const body = /** @type {{ readonly result: Record<string, unknown> }} */ (await response.json());
  assertEquals(body.result.reasonCode, "retryable-failure");
  assertEquals(body.result.message, "Automatic extraction stopped because the workflow encountered a retryable error. Retry processing to try again.");
});

Deno.test("authorized material route derives owner, decodes pasted text, and preserves the attestation", async () => {
  const fixture = makeFixture();
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/knowledge-workflows/material", {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "application/json" },
    body: JSON.stringify({ runId: "run-a", sourceId: "source-a", sourceRevision: 1, sourceUrl: "https://example.test/learn", mediaType: "text/plain", fileName: "pasted-text.txt", idempotencyKey: "material-1", content: "A pasted concept.", rightsAttestation: { ownsOrPermitted: true, storageAllowed: true, transformationAllowed: true, processingAllowed: true, basis: "learner copy", reference: "attestation-1" } }),
  }));
  assertEquals(response.status, 200);
  assertEquals(fixture.materials.length, 1);
  assertEquals(fixture.materials[0].ownerId, "owner-a");
  assertEquals(fixture.materials[0].content, undefined);
  assertEquals(fixture.materials[0].bytes instanceof Uint8Array, true);
  assertEquals(new TextDecoder().decode(/** @type {Uint8Array} */ (fixture.materials[0].bytes)), "A pasted concept.");
  assertEquals(/** @type {Record<string, unknown>} */ (fixture.materials[0].rightsAttestation).processingAllowed, true);
});

Deno.test("source disable revokes all owner-scoped knowledge workflow descendants", async () => {
  const fixture = makeFixture();
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/source-library/disable", { method: "POST", headers: { origin: "https://app.example" }, body: JSON.stringify({ sourceId: "source-a", expectedRevision: 1, idempotencyKey: "source-disable-1" }) }));
  assertEquals(response.status, 200);
  assertEquals(fixture.revoked.length, 1);
  assertEquals(fixture.revoked[0].ownerId, "owner-a");
  assertEquals(fixture.revoked[0].sourceId, "source-a");
});

Deno.test("learning media route returns only authorized derivative bytes and a bounded public response", async () => {
  const fixture = makeFixture();
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/learning-media?assetId=media-a&variant=feed", { headers: { origin: "https://app.example" } }));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "image/png");
  assertEquals(response.headers.get("cache-control"), "private, max-age=3600");
  assertEquals(await response.arrayBuffer().then((value) => new Uint8Array(value).length), 3);
  const missing = await fixture.worker.fetch(new Request("https://worker.example/api/learning-media?assetId=media-missing&variant=feed", { headers: { origin: "https://app.example" } }));
  assertEquals(missing.status, 404);
});

Deno.test("rights approval advances the workflow and does not launch the legacy ingestion path", async () => {
  const fixture = makeFixture();
  const response = await fixture.worker.fetch(new Request("https://worker.example/api/source-library/rights/approve", {
    method: "POST",
    headers: { origin: "https://app.example" },
    body: JSON.stringify({ sourceId: "source-a", sourceRevision: 1 }),
  }));
  assertEquals(response.status, 200);
  assertEquals(fixture.rightsApproved.length, 1);
  assertEquals(fixture.rightsApproved[0].ownerId, "owner-a");
  assertEquals(fixture.legacyIngestion.length, 0);
});
