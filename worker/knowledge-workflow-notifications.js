// @ts-check
import { isKnowledgeWorkflowRun } from "../src/features/knowledge-workflows/workflow.js";

/** Notify only persisted outcomes that need the learner, never intermediate scraping/chunk progress.
 * @param {{run:unknown,notify:ReturnType<typeof import('./reminders/source-updates.js').createSourceNotificationService>['notify'],load:()=>Promise<import('../src/features/knowledge-workflows/workflow.js').Result<import('../src/features/knowledge-workflows/workflow.js').KnowledgeWorkflowRun,{kind:string}>>,now:()=>string}} input
 * @returns {Promise<import('./reminders/service.js').Result<{sent:number}>>} */
export async function notifyKnowledgeWorkflowOutcome(
  { run, notify, load, now },
) {
  if (
    !isKnowledgeWorkflowRun(run) ||
    typeof notify !== "function" || typeof load !== "function" ||
    typeof now !== "function"
  ) return { ok: false, error: { kind: "ReminderCommandInvalid" } };
  const instant = now();
  if (!Number.isFinite(Date.parse(instant))) {
    return { ok: false, error: { kind: "ReminderClockInvalid" } };
  }
  const ready = run.state === "completed" && run.counts.knowledgePoints > 0 &&
    run.counts.acceptedQuizzes > run.counts.pendingQuizzes;
  const attention = run.state === "awaiting-upload" ||
    run.state === "awaiting-rights-review" ||
    run.state === "retryable-failure" ||
    (run.state === "awaiting-time-limit-decision" &&
      run.extractionDeadlineAt !== null &&
      Date.parse(run.extractionDeadlineAt) <= Date.parse(instant));
  if (!ready && !attention) return { ok: true, value: { sent: 0 } };
  return notify({
    ownerId: run.ownerId,
    runId: run.runId,
    revision: run.revision,
    kind: ready ? "source-ready" : "source-attention",
    occurredAt: run.updatedAt,
  }, async () => {
    const latest = await load();
    if (!latest.ok) {
      return { ok: false, error: { kind: "ReminderReadUnavailable" } };
    }
    if (!isKnowledgeWorkflowRun(latest.value)) {
      return { ok: false, error: { kind: "ReminderDataInvalid" } };
    }
    return {
      ok: true,
      value: latest.value.ownerId === run.ownerId &&
        latest.value.runId === run.runId &&
        latest.value.revision === run.revision &&
        latest.value.state === run.state,
    };
  });
}
