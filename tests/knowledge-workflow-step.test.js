// @ts-check

import { executeAuthoritativeWorkflowStep } from "../worker/knowledge-workflow-step.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

Deno.test("authoritative Workflow step reloads D1 on a replay before executing persistence work", async () => {
  /** @type {{ readonly state: "per-point-quiz-loop" | "completed" }} */
  let authoritative = { state: "per-point-quiz-loop" };
  /** @type {string[]} */
  const loadedStates = [];
  let persistenceCalls = 0;
  const result = await executeAuthoritativeWorkflowStep({
    step: {
      do: async (_name, callback) => {
        await callback();
        authoritative = { state: "completed" };
        return callback();
      },
    },
    name: "execute knowledge extraction and quiz stages",
    load: async () => ({ ok: true, value: authoritative }),
    execute: async (run) => {
      loadedStates.push(run.state);
      if (run.state === "completed") return { ok: true, value: { state: "completed" } };
      persistenceCalls += 1;
      return { ok: false, error: { kind: "TransientStepReplay" } };
    },
  });
  assertEquals(result.ok, true);
  assertEquals(loadedStates.join(","), "per-point-quiz-loop,completed");
  assertEquals(persistenceCalls, 1);
});

Deno.test("authoritative Workflow step preserves a typed load failure", async () => {
  const result = await executeAuthoritativeWorkflowStep({
    step: { do: async (_name, callback) => callback() },
    name: "reload authoritative run",
    load: async () => ({ ok: false, error: { kind: "WorkflowRunMissing" } }),
    execute: async () => ({ ok: true, value: null }),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "WorkflowRunMissing");
});
