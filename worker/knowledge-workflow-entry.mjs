import { WorkflowEntrypoint } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { D1KnowledgeWorkflowRepository } from "./knowledge-workflow-d1.js";
import { D1KnowledgeWorkflowMaterialRepository } from "./knowledge-workflow-material-d1.js";
import { createKnowledgeWorkflowService } from "../src/features/knowledge-workflows/workflow.js";
import { createKnowledgeWorkflowRuntime } from "./knowledge-workflow-runtime.js";
import { createAgentConfigurationLoader } from "../src/features/knowledge-workflows/config.js";
import { KNOWLEDGE_WORKFLOW_CONFIG_SOURCES } from "./knowledge-workflow-config-sources.js";
import { D1KnowledgeMediaRepository } from "./knowledge-workflow-media-d1.js";
import { createMediaPipeline, createMediaPublicEgress, createUserAttestedLocalManifest } from "../src/features/knowledge-workflows/media.js";
import { resolvePublicAddresses } from "./knowledge-workflow-network.js";
import { createCloudflareImageDerivative, isCloudflareImageBinding } from "./knowledge-workflow-media-transform.js";
import { createKnowledgeWorkflowLogger } from "./knowledge-workflow-logging.js";
import { executeAuthoritativeWorkflowStep } from "./knowledge-workflow-step.js";
import { createKnowledgeWorkflowBrowser } from "./knowledge-workflow-browser.js";
import { createOpenSourceImageSearch } from "./open-source-image-search.js";
import fallbackMediaEntries from "../assets/fallback-media/manifest.json" with { type: "json" };

const roleNames = /** @type {const} */ (["rights-assessor", "knowledge-scraper", "question-generator", "question-evaluator"]);
const supportedTools = new Set([
  "rights-evidence.read",
  "browser.page.read",
  "browser.screenshot.capture",
  "extraction.frontier.observe",
  "extraction.knowledge.commit",
  "quiz.question.validate",
  "quiz.evidence.lookup",
  "quiz.duplicate.check",
]);

const KNOWLEDGE_BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const KNOWLEDGE_BROWSER_HEADERS = Object.freeze({
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
});

/** @param {unknown} value @param {string} currentTime @returns {boolean} */
function isAutomaticExtractionContinuation(value, currentTime) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value.state !== "awaiting-time-limit-decision" || !Number.isFinite(Date.parse(currentTime))) return false;
  if (!("run" in value) || typeof value.run !== "object" || value.run === null || Array.isArray(value.run)) return false;
  if (!("extractionDeadlineAt" in value.run) || typeof value.run.extractionDeadlineAt !== "string" || !Number.isFinite(Date.parse(value.run.extractionDeadlineAt))) return false;
  return Date.parse(currentTime) < Date.parse(value.run.extractionDeadlineAt);
}

/** @param {string} input @returns {Promise<string>} */
async function sha256(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** @param {Readonly<Record<string, string>>} expected @returns {Promise<import("../src/features/knowledge-workflows/config.js").Result<Readonly<Record<import("../src/features/knowledge-workflows/memory.js").AgentRole, import("../src/features/knowledge-workflows/config.js").AgentConfigurationSnapshot>>, { readonly kind: string }>>} */
async function loadConfigurationSnapshots(expected) {
  const loader = createAgentConfigurationLoader({ sha256, supportedModels: new Set(["openrouter/z-ai/glm-5.3-flash"]), supportedTools });
  /** @type {Partial<Record<import("../src/features/knowledge-workflows/memory.js").AgentRole, import("../src/features/knowledge-workflows/config.js").AgentConfigurationSnapshot>>} */
  const snapshots = {};
  for (const role of roleNames) {
    const source = KNOWLEDGE_WORKFLOW_CONFIG_SOURCES[role];
    const digest = expected[role];
    if (typeof source !== "string" || typeof digest !== "string") return { ok: false, error: { kind: "WorkflowConfigurationSnapshotInvalid" } };
    const loaded = await loader.load({ source, expectedRole: role, expectedDigest: digest });
    if (!loaded.ok) return { ok: false, error: { kind: loaded.error.kind } };
    snapshots[role] = loaded.value;
  }
  return { ok: true, value: Object.freeze(/** @type {Readonly<Record<import("../src/features/knowledge-workflows/memory.js").AgentRole, import("../src/features/knowledge-workflows/config.js").AgentConfigurationSnapshot>>} */ (snapshots)) };
}

/**
 * Cloudflare's Workflow runtime supplies the base class and step context. D1
 * remains authoritative; the Workflow result contains only bounded IDs and
 * lifecycle digests.
 */
export class KnowledgeExtractionWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      typeof payload.runId !== "string" || payload.runId.trim() === "" ||
      typeof payload.ownerId !== "string" || payload.ownerId.trim() === "") {
      throw new TypeError("Knowledge workflow payload is invalid.");
    }
    const runId = payload.runId;
    const ownerId = payload.ownerId;
    const database = this.env.SOURCE_LIBRARY_DB;
    if (!database || typeof database.prepare !== "function" || typeof database.batch !== "function") {
      throw new TypeError("Knowledge workflow database binding is unavailable.");
    }
    const bucket = this.env.SOURCE_CONTENT_BUCKET;
    if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function" || typeof bucket.delete !== "function") throw new TypeError("Knowledge workflow media bucket binding is unavailable.");
    if (!isCloudflareImageBinding(this.env.IMAGES)) throw new TypeError("Knowledge workflow image derivative binding is unavailable.");
    const browserBinding = this.env.SOURCE_BROWSER;
    if (!browserBinding || (typeof browserBinding !== "object" && typeof browserBinding !== "function")) throw new TypeError("Knowledge workflow browser binding is unavailable.");
    const now = () => new Date().toISOString();
    const workerFetch = globalThis.fetch.bind(globalThis);
    const logger = createKnowledgeWorkflowLogger({ sink: (record) => console.info(JSON.stringify(record)), now });
    const createBrowser = () => createKnowledgeWorkflowBrowser({
      launcher: {
        limits: (binding) => puppeteer.limits(binding),
        launch: (binding) => puppeteer.launch(binding),
      },
      binding: browserBinding,
      resolveAddresses: (hostname) => resolvePublicAddresses(hostname, workerFetch),
      browserRequest: typeof this.env.SOURCE_BROWSER_REQUEST === "function" ? this.env.SOURCE_BROWSER_REQUEST : undefined,
      nowMs: () => Date.now(),
      userAgent: KNOWLEDGE_BROWSER_USER_AGENT,
      extraHTTPHeaders: KNOWLEDGE_BROWSER_HEADERS,
      logger: (entry) => logger({ event: entry.event, ownerId, stage: "browser", failureKind: entry.failureKind, diagnosticToken: entry.diagnosticToken, httpStatus: entry.httpStatus }),
      navigationTimeoutMilliseconds: 15_000,
      maximumHtmlBytes: 1_000_000,
      maximumRobotsBytes: 256 * 1024,
      maximumScreenshotBytes: 2_000_000,
      minimumInterRequestDelayMilliseconds: 1_500,
      maximumRetryAfterMilliseconds: 30_000,
      maximumRateLimitRetries: 1,
      maximumCachedPages: 4,
      maximumVisibleLinks: 200,
      maximumRenderedTextCharacters: 250_000,
      renderSettleMilliseconds: 750,
      renderSettleTimeoutMilliseconds: 5_000,
    });
    const mediaRepository = new D1KnowledgeMediaRepository({ database, bucket, logger: (entry) => logger({ event: entry.event, ownerId: entry.ownerId, stage: "media", failureKind: entry.failureKind }) });
    const publicEgress = createMediaPublicEgress(this.env.MEDIA_PUBLIC_EGRESS);
    const fallbackManifest = createUserAttestedLocalManifest(fallbackMediaEntries);
    if (!fallbackManifest.ok) throw new Error(fallbackManifest.error.kind);
    const media = createMediaPipeline({
      publicEgress,
      digest: async (bytes) => {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return { ok: true, value: `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}` };
      },
      quarantine: {
        put: async ({ key, bytes, mediaType }) => { try { await bucket.put(key, bytes, { httpMetadata: { contentType: mediaType } }); return { ok: true, value: null }; } catch (error) { if (error instanceof Error) return { ok: false, error: { kind: "MediaQuarantineFailed" } }; throw error; } },
        remove: async (key) => { try { await bucket.delete(key); return { ok: true, value: null }; } catch (error) { if (error instanceof Error) return { ok: false, error: { kind: "MediaCleanupFailed" } }; throw error; } },
      },
      derivatives: { create: createCloudflareImageDerivative(/** @type {import("./knowledge-workflow-media-transform.js").ImageBinding} */ (this.env.IMAGES)) },
      repository: mediaRepository,
      createId: () => crypto.randomUUID(),
      now,
      logger: (entry) => logger({ event: entry.event, ownerId: entry.ownerId, stage: "media", failureKind: entry.failureKind }),
    });
    const imageSearch = createOpenSourceImageSearch({
      fetch: workerFetch,
      logger: (entry) => logger({ event: entry.event, ownerId, stage: "media", failureKind: entry.failureKind }),
    });
    const repository = new D1KnowledgeWorkflowRepository({
      database,
      logger: (entry) => logger({ event: entry.event, runId: entry.runId, ownerId: entry.ownerId, failureKind: entry.failureKind }),
    });
    const materialRepository = new D1KnowledgeWorkflowMaterialRepository({
      database,
      logger: (entry) => logger({ event: entry.event, runId: entry.runId, ownerId: entry.ownerId, stage: "material", failureKind: entry.failureKind }),
    });
    const materialContent = {
      read: async (materialOwnerId, objectKey) => {
        if (typeof materialOwnerId !== "string" || materialOwnerId.trim() === "" || typeof objectKey !== "string" || !objectKey.startsWith("source-content/") || objectKey.includes("..")) return { ok: false, error: { kind: "WorkflowMaterialImageUnavailable" } };
        try {
          const object = await bucket.get(objectKey);
          if (object === null || object.customMetadata?.owner !== materialOwnerId) return { ok: false, error: { kind: "WorkflowMaterialImageUnavailable" } };
          return { ok: true, value: new Uint8Array(await object.arrayBuffer()) };
        } catch (error) {
          if (error instanceof Error) return { ok: false, error: { kind: "WorkflowMaterialImageUnavailable" } };
          throw error;
        }
      },
    };
    const service = createKnowledgeWorkflowService(repository, {
      now,
      createId: () => crypto.randomUUID(),
      logger: (entry) => logger({ event: entry.event, runId: entry.runId, ownerId: entry.ownerId, action: entry.action, failureKind: entry.failureKind }),
    });
    let current = await step.do("load knowledge workflow run", async () => service.status({ ownerId, runId }));
    if (!current.ok) throw new Error(current.error.kind);
    const configurations = await step.do("validate workflow role configurations", async () => loadConfigurationSnapshots(current.value.configDigests));
    if (!configurations.ok) throw new Error(configurations.error.kind);
    const createRuntime = () => createKnowledgeWorkflowRuntime({
      database,
      fetch: workerFetch,
      browser: createBrowser(),
      apiKey: typeof this.env.OPENROUTER_API_KEY === "string" ? this.env.OPENROUTER_API_KEY : null,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      now,
      nowMs: () => Date.now(),
      logger: (entry) => logger({ event: entry.event, runId: entry.runId, ownerId, stage: entry.stage, failureKind: entry.failureKind, diagnosticToken: entry.diagnosticToken }),
      configSnapshots: configurations.value,
      media,
      imageSearch,
      fallbackManifest: fallbackManifest.value,
      mediaBucket: bucket,
      material: { read: (materialOwnerId, materialRunId) => materialRepository.read(materialOwnerId, materialRunId) },
      materialContent,
      resolveAddresses: (hostname) => resolvePublicAddresses(hostname, workerFetch),
      transition: (command) => service.advance({ ownerId: command.run.ownerId, runId: command.run.runId, expectedRevision: command.run.revision, nextState: command.nextState, ...(command.counts === undefined ? {} : { counts: command.counts }), ...(command.failureKind === undefined ? {} : { failureKind: command.failureKind }), ...(command.robotsEvidence === undefined ? {} : { robotsEvidence: command.robotsEvidence }) }),
    });
    /** @type {ReturnType<typeof createKnowledgeWorkflowRuntime> | null} */
    let runtime = null;
    if (current.value.state === "source-added") {
      const assessed = await step.do("begin rights assessment", async () => service.advance({ ownerId, runId, expectedRevision: current.value.revision, nextState: "rights-assessment" }));
      if (!assessed.ok) throw new Error(assessed.error.kind);
      current = { ok: true, value: assessed.value };
    }
    if (current.value.state === "awaiting-rights-review") {
      try {
        await step.waitForEvent("wait for rights approval", { type: "rights-approved", timeout: "24 hours" });
      } catch (error) {
        throw new Error("WorkflowRightsApprovalTimeout");
      }
      current = await step.do("reload after rights approval", async () => service.status({ ownerId, runId }));
      if (!current.ok) throw new Error(current.error.kind);
    }
    /** @param {string} stepName @returns {Promise<import("../src/features/knowledge-workflows/workflow.js").Result<unknown, { readonly kind: string, readonly detailKind?: string, readonly detailDiagnosticToken?: string }>>} */
    async function executeOrAwaitMaterial(stepName) {
      runtime = createRuntime();
      const executed = await executeAuthoritativeWorkflowStep({
        step,
        name: stepName,
        load: () => service.status({ ownerId, runId }),
        execute: (authoritativeRun) => /** @type {ReturnType<typeof createKnowledgeWorkflowRuntime>} */ (runtime).execute(authoritativeRun),
      });
      if (executed.ok) return executed;
      if (executed.error.kind !== "WorkflowRobotsFailed" && executed.error.kind !== "WorkflowUploadRequired") {
        const latest = await step.do("reload before marking retryable workflow failure", async () => service.status({ ownerId, runId }));
        if (!latest.ok) throw new Error(latest.error.kind);
        if (latest.value.state !== "extraction-loop") throw new Error(executed.error.kind);
        const failureKind = typeof executed.error.detailKind === "string" && executed.error.detailKind.trim() !== "" ? executed.error.detailKind : executed.error.kind;
        const diagnosticToken = typeof executed.error.detailDiagnosticToken === "string" && /^[a-z0-9-]+$/u.test(executed.error.detailDiagnosticToken) ? executed.error.detailDiagnosticToken : undefined;
        logger({ event: "knowledge-workflow-execution-failure", ownerId, runId, stage: "executor", failureKind, ...(diagnosticToken === undefined ? {} : { diagnosticToken }) });
        const persistedFailureKind = diagnosticToken === undefined ? failureKind : `${failureKind}:${diagnosticToken}`;
        const retryable = await step.do("persist retryable workflow failure", async () => service.advance({ ownerId, runId, expectedRevision: latest.value.revision, nextState: "retryable-failure", failureKind: persistedFailureKind }));
        if (!retryable.ok) throw new Error(retryable.error.kind);
        return { ok: true, value: { state: retryable.value.state, run: retryable.value } };
      }
      const latest = await step.do("reload before marking upload-required", async () => service.status({ ownerId, runId }));
      if (!latest.ok) throw new Error(latest.error.kind);
      const failureKind = typeof executed.error.detailKind === "string" && executed.error.detailKind.trim() !== "" ? executed.error.detailKind : executed.error.kind;
      const diagnosticToken = typeof executed.error.detailDiagnosticToken === "string" && /^[a-z0-9-]+$/u.test(executed.error.detailDiagnosticToken) ? executed.error.detailDiagnosticToken : undefined;
      logger({ event: "knowledge-workflow-execution-failure", ownerId, runId, stage: "executor", failureKind, ...(diagnosticToken === undefined ? {} : { diagnosticToken }) });
      const persistedFailureKind = diagnosticToken === undefined ? failureKind : `${failureKind}:${diagnosticToken}`;
      const awaitingUpload = await step.do("mark blocked workflow awaiting upload", async () => service.advance({ ownerId, runId, expectedRevision: latest.value.revision, nextState: "awaiting-upload", failureKind: persistedFailureKind }));
      if (!awaitingUpload.ok) throw new Error(awaitingUpload.error.kind);
      return { ok: true, value: { state: awaitingUpload.value.state, run: awaitingUpload.value } };
    }
    let executed = await executeOrAwaitMaterial("execute knowledge extraction and quiz stages");
    let result = executed.value;
    while (result && typeof result === "object" && !Array.isArray(result) && (result.state === "paused" || result.state === "awaiting-time-limit-decision" || result.state === "awaiting-upload" || result.state === "retryable-failure")) {
      if (isAutomaticExtractionContinuation(result, now())) {
        const chunkRun = /** @type {import("../src/features/knowledge-workflows/workflow.js").KnowledgeWorkflowRun} */ (result.run);
        const continued = await step.do(`continue bounded extraction chunk ${chunkRun.revision}`, async () => service.advance({ ownerId, runId, expectedRevision: chunkRun.revision, nextState: "extraction-loop" }));
        if (!continued.ok) throw new Error(continued.error.kind);
        await step.sleepUntil(`yield between bounded extraction chunks ${continued.value.revision}`, new Date(Date.now() + 1_000));
        current = await step.do(`reload after bounded extraction chunk ${continued.value.revision}`, async () => service.status({ ownerId, runId }));
        if (!current.ok) throw new Error(current.error.kind);
        executed = await executeOrAwaitMaterial(`execute bounded extraction chunk ${continued.value.revision}`);
        result = executed.value;
        continue;
      }
      try {
        await step.waitForEvent(result.state === "awaiting-upload" ? "wait for authorized material" : result.state === "retryable-failure" ? "wait for workflow retry" : "wait for workflow control", { type: result.state === "awaiting-upload" ? "workflow-material-ready" : "workflow-control", timeout: "24 hours" });
      } catch (error) {
        throw new Error(result.state === "awaiting-upload" ? "WorkflowMaterialTimeout" : "WorkflowControlTimeout");
      }
      current = await step.do(result.state === "awaiting-upload" ? "reload after authorized material" : "reload after workflow control", async () => service.status({ ownerId, runId }));
      if (!current.ok) throw new Error(current.error.kind);
      executed = await executeOrAwaitMaterial(result.state === "awaiting-upload" ? "start extraction from authorized material" : result.state === "retryable-failure" ? "retry knowledge extraction and quiz stages" : "resume knowledge extraction and quiz stages");
      result = executed.value;
    }
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.state !== "string") throw new Error("WorkflowRuntimeOutputInvalid");
    const finalRun = "run" in result && result.run && typeof result.run === "object" && !Array.isArray(result.run) ? result.run : current.value;
    if (!finalRun || typeof finalRun !== "object" || Array.isArray(finalRun) || typeof finalRun.revision !== "number") throw new Error("WorkflowRuntimeOutputInvalid");
    const restrictedUntil = "restrictedUntil" in result && typeof result.restrictedUntil === "string" ? result.restrictedUntil : null;
    const restrictedKnowledgeIds = "restrictedKnowledgeIds" in result && Array.isArray(result.restrictedKnowledgeIds) && result.restrictedKnowledgeIds.every((value) => typeof value === "string" && value.trim() !== "") ? result.restrictedKnowledgeIds : [];
    if (restrictedUntil !== null && restrictedKnowledgeIds.length > 0) {
      const expiryMs = Date.parse(restrictedUntil);
      if (!Number.isFinite(expiryMs)) throw new Error("WorkflowRuntimeOutputInvalid");
      await step.sleepUntil("wait for quiz-attempt retention expiry", new Date(expiryMs));
      for (const knowledgeId of restrictedKnowledgeIds) {
        const purged = await step.do(`purge retained quiz attempt ${knowledgeId}`, async () => (runtime ?? createRuntime()).purgeExpired({ run: /** @type {import("../src/features/knowledge-workflows/workflow.js").KnowledgeWorkflowRun} */ (finalRun), knowledgeId, restrictedUntil, before: restrictedUntil }));
        if (!purged.ok) throw new Error(purged.error.kind);
      }
    }
    return { runId, state: result.state, revision: finalRun.revision, configDigests: current.value.configDigests };
  }
}
