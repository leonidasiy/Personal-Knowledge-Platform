import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { notifyKnowledgeWorkflowOutcome } from "../worker/knowledge-workflow-notifications.js";
import { isWorkflowRetryStage } from "../src/features/knowledge-workflows/workflow.js";

const at = "2026-10-02T12:00:00.000Z";
const run = {
  ownerId: "owner",
  runId: "run",
  sourceId: "source",
  sourceRevision: 1,
  canonicalSourceIdentity: "private",
  contentSignature: "private",
  state: "completed",
  revision: 2,
  idempotencyKey: "id",
  configDigests: {},
  extractionStartedAt: at,
  extractionDeadlineAt: at,
  decisionRequired: null,
  counts: {
    pages: 1,
    knowledgePoints: 1,
    acceptedQuizzes: 1,
    pendingQuizzes: 0,
  },
  failureKind: null,
  reused: false,
  createdAt: at,
  updatedAt: at,
};

test("completed retries with only pending-review quizzes do not announce readiness", async () => {
  const current = {
    ...run,
    counts: { ...run.counts, acceptedQuizzes: 1, pendingQuizzes: 1 },
  };
  const calls = [];
  const result = await notifyKnowledgeWorkflowOutcome({
    run: current,
    now: () => at,
    load: async () => ({ ok: true, value: current }),
    notify: async (command) => {
      calls.push(command);
      return { ok: true, value: { sent: 1 } };
    },
  });
  assert.deepEqual(result, { ok: true, value: { sent: 0 } });
  assert.deepEqual(calls, []);
});

test("completed retries with one published and one pending-review quiz announce readiness", async () => {
  const current = {
    ...run,
    counts: { ...run.counts, knowledgePoints: 2, acceptedQuizzes: 2, pendingQuizzes: 1 },
  };
  const calls = [];
  const result = await notifyKnowledgeWorkflowOutcome({
    run: current,
    now: () => at,
    load: async () => ({ ok: true, value: current }),
    notify: async (command, isCurrent) => {
      assert.deepEqual(await isCurrent(), { ok: true, value: true });
      calls.push(command.kind);
      return { ok: true, value: { sent: 1 } };
    },
  });
  assert.deepEqual(result, { ok: true, value: { sent: 1 } });
  assert.deepEqual(calls, ["source-ready"]);
});
test("workflow alerts select final readiness and actionable states, not chunks, scraping or user pauses", async () => {
  for (
    const state of [
      "source-added",
      "rights-assessment",
      "robots-check",
      "extraction-loop",
      "paused",
      "extraction-finalized",
      "per-point-quiz-loop",
      "abandoned",
      "completed",
      "awaiting-upload",
      "awaiting-rights-review",
      "retryable-failure",
      "awaiting-time-limit-decision",
    ]
  ) {
    const current = { ...run, state };
    const calls = [];
    const result = await notifyKnowledgeWorkflowOutcome({
      run: current,
      now: () => at,
      load: async () => ({ ok: true, value: current }),
      notify: async (command, isCurrent) => {
        assert.deepEqual(await isCurrent(), { ok: true, value: true });
        calls.push(command);
        return { ok: true, value: { sent: 1 } };
      },
    });
    assert.ok(result.ok);
    const expected = state === "completed" ? "source-ready" : [
        "awaiting-upload",
        "awaiting-rights-review",
        "retryable-failure",
        "awaiting-time-limit-decision",
      ].includes(state)
      ? "source-attention"
      : null;
    assert.equal(calls.length, expected ? 1 : 0, state);
    if (expected) assert.equal(calls[0].kind, expected);
  }
  const silent = async () => {
    throw new Error("UnexpectedAlert");
  };
  for (
    const current of [
      { ...run, counts: { ...run.counts, acceptedQuizzes: 0 } },
      {
        ...run,
        state: "awaiting-time-limit-decision",
        extractionDeadlineAt: "2026-10-02T13:00:00.000Z",
      },
    ]
  ) {
    assert.deepEqual(
      await notifyKnowledgeWorkflowOutcome({
        run: current,
        now: () => at,
        load: async () => ({ ok: true, value: current }),
        notify: silent,
      }),
      { ok: true, value: { sent: 0 } },
    );
  }
});
test("workflow alerts recheck authoritative ownership/revision and report invalid input and reads", async () => {
  for (
    const latest of [{ ...run, revision: 3 }, { ...run, ownerId: "other" }, {
      ...run,
      state: "abandoned",
    }]
  ) {
    await notifyKnowledgeWorkflowOutcome({
      run,
      now: () => at,
      load: async () => ({ ok: true, value: latest }),
      notify: async (command, current) => {
        assert.deepEqual(await current(), { ok: true, value: false });
        return { ok: true, value: { sent: 0 } };
      },
    });
  }
  for (
    const loaded of [{
      ok: false,
      error: { kind: "WorkflowRepositoryUnavailable" },
    }, { ok: true, value: {} }]
  ) {
    const r = await notifyKnowledgeWorkflowOutcome({
      run,
      now: () => at,
      load: async () => loaded,
      notify: async (command, current) => current(),
    });
    assert.equal(r.ok, false);
  }
  const base = {
    now: () => at,
    load: async () => ({ ok: true, value: run }),
    notify: async () => ({ ok: true, value: { sent: 0 } }),
  };
  assert.equal(
    (await notifyKnowledgeWorkflowOutcome({ ...base, run: null })).error.kind,
    "ReminderCommandInvalid",
  );
  assert.equal(
    (await notifyKnowledgeWorkflowOutcome({ ...base, run, now: () => "bad" }))
      .error.kind,
    "ReminderClockInvalid",
  );
  let calls = 0;
  const notify = async (command) => {
    calls++;
    assert.equal(command.kind, "source-attention");
    return { ok: true, value: { sent: 1 } };
  };
  await notifyKnowledgeWorkflowOutcome({
    ...base,
    run: { ...run, state: "extraction-loop" },
    notify,
  });
  await notifyKnowledgeWorkflowOutcome({ ...base, run:{...run,state:"retryable-failure"}, notify });
  assert.equal(calls, 1);
});

test("actual workflow entry sends before retention/waits and preserves extraction success on push failure", async () => {
  const source = await readFile(
    new URL("../worker/knowledge-workflow-entry.mjs", import.meta.url),
    "utf8",
  );
  for (
    const state of [
      "completed",
      "awaiting-upload",
      "awaiting-rights-review",
      "retryable-failure",
      "extraction-loop",
    ]
  ) {
    let current = { ...run, state, updatedAt: new Date().toISOString() };
    const actions = [];
    const noOp = () => ({});
    const bindings = {
      WorkflowEntrypoint: class {},
      puppeteer: {},
      D1KnowledgeWorkflowRepository: class {},
      D1KnowledgeWorkflowMaterialRepository: class {},
      D1KnowledgeMediaRepository: class {},
      createKnowledgeWorkflowService: () => ({
        status: async () => ({ ok: true, value: current }),
        advance: async(command)=>{current={...current,state:command.nextState,revision:current.revision+1};return {ok:true,value:current};},
      }),
      isWorkflowRetryStage,
      createKnowledgeWorkflowLogger: () => noOp,
      createKnowledgeWorkflowBrowser: noOp,
      createMediaPublicEgress: noOp,
      createMediaPipeline: noOp,
      createOpenSourceImageSearch: noOp,
      createUserAttestedLocalManifest: () => ({ ok: true, value: [] }),
      fallbackMediaEntries: [],
      isCloudflareImageBinding: () => true,
      createCloudflareImageDerivative: noOp,
      KNOWLEDGE_WORKFLOW_CONFIG_SOURCES: Object.fromEntries(
        [
          "rights-assessor",
          "knowledge-scraper",
          "question-generator",
          "question-evaluator",
        ].map((role) => [role, "config"]),
      ),
      createAgentConfigurationLoader: () => ({
        load: async () => ({ ok: true, value: {} }),
      }),
      createKnowledgeWorkflowRuntime: () => ({
        purgeExpired: async () => ({ ok: true, value: null }),
      }),
      executeAuthoritativeWorkflowStep: async () => {
        if (state === "extraction-loop") {
          throw new Error("ProviderRetriesExhausted");
        }
        return {
          ok: true,
          value: {
            state,
            run: current,
            restrictedUntil: "2026-11-02T00:00:00.000Z",
            restrictedKnowledgeIds: ["k"],
          },
        };
      },
      createReminderRuntime: () => ({
        notifySource: async (command, isCurrent) => {
          assert.deepEqual(await isCurrent(), { ok: true, value: true });
          actions.push(command.kind);
          return { ok: false, error: { kind: "ReminderDeliveryFailed" } };
        },
      }),
      notifyKnowledgeWorkflowOutcome,
    };
    current.configDigests = Object.fromEntries(
      Object.keys(bindings.KNOWLEDGE_WORKFLOW_CONFIG_SOURCES).map(
        (role) => [role, "digest"],
      ),
    );
    const Entry = new Function(
      ...Object.keys(bindings),
      source.replace(/^import .*;\n/gm, "").replace(
        "export class KnowledgeExtractionWorkflow",
        "class KnowledgeExtractionWorkflow",
      ) + "\nreturn KnowledgeExtractionWorkflow;",
    )(...Object.values(bindings));
    const entry = new Entry();
    entry.env = {
      SOURCE_LIBRARY_DB: { prepare: noOp, batch: noOp },
      SOURCE_CONTENT_BUCKET: { put: noOp, get: noOp, delete: noOp },
      SOURCE_BROWSER: {},
      IMAGES: {},
    };
    const step = {
      do: async (name, fn) => fn(),
      waitForEvent: async () => {
        actions.push("wait");
        throw new Error("TestWaitTimeout");
      },
      sleepUntil: async () => {
        actions.push("retention");
      },
    };
    if (state === "completed") {
      assert.equal(
        (await entry.run({ payload: { ownerId: "owner", runId: "run" } }, step))
          .state,
        "completed",
      );
      assert.deepEqual(actions, ["source-ready", "retention"]);
    } else {
      await assert.rejects(
        entry.run({ payload: { ownerId: "owner", runId: "run" } }, step),
        /Workflow(Material|RightsApproval|Control)Timeout/,
      );
      assert.equal(actions[0], "source-attention", state);
    }
  }
});
