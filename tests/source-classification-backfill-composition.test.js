import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createSourceClassificationBackfillRuntime } from "../worker/source-classification-backfill.js";

/** @typedef {Parameters<typeof createSourceClassificationBackfillRuntime>[0]} RuntimeDependencies */

Deno.test("backfill composition connects the dedicated classifier, audited persistence, review writer, and checkpoint repository", async () => {
  /** @type {{ classification: { readonly legacyAudit: readonly unknown[] } | null, review: { readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly issueKind: "inference-failed" | "legacy-conflict" | "legacy-unclassified" } | null, checkpoint: { readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly status: "read" | "completed" | "needs-review" | "manual-preserved" } | null }} */
  const seen = { classification: null, review: null, checkpoint: null };
  /** @type {RuntimeDependencies["classificationRepository"]} */
  const classificationRepository = {
    async get() { return { ok: true, value: null }; },
    async persistAgent(command) { seen.classification = command; return { ok: true, value: { inserted: true, value: { ownerId: command.ownerId, sourceId: command.sourceId, sourceRevision: command.sourceRevision, mainSubject: command.classification.mainSubject, topic: command.classification.topic, classificationRevision: 1, origin: "agent", status: "classified", legacyAudit: command.legacyAudit, updatedAt: "2026-10-04T00:00:00.000Z" } } }; },
    async recordReviewIssue(command) { seen.review = command; return { ok: true, value: null }; },
  };
  /** @type {RuntimeDependencies["backfillRepository"]} */
  const backfillRepository = {
    async pageSources(/** @type {{ ownerId: string, afterSourceId: string | null, limit: number }} */ command) { return { ok: true, value: { sources: [{ ownerId: command.ownerId, id: "s1", revision: 1, title: "A" }], nextCursor: null } }; },
    async pagePoints() { return { ok: true, value: { points: [{ id: "p1", summary: "Evidence", attribution: { sourceUrl: "https://example.test" }, classification: null }], nextCursor: null } }; },
    async checkpoint(/** @type {{ ownerId: string, sourceId: string, sourceRevision: number, status: "read" | "completed" | "needs-review" | "manual-preserved" }} */ command) { seen.checkpoint = command; return { ok: true, value: null }; },
  };
  /** @type {RuntimeDependencies["classifier"]} */
  const classifier = { async classify(/** @type {{ ownerId: string, sourceId: string, sourceRevision: number, title: string, points: readonly unknown[] }} */ command) { assertEquals(command.points.length, 1); return { ok: true, value: { mainSubject: "music", topic: "Theory" } }; } };
  const runtime = createSourceClassificationBackfillRuntime({
    backfillRepository, classificationRepository,
    classifier,
    now: () => "2026-10-04T00:00:00.000Z", logger: () => {},
  });
  const result = await runtime.run({ ownerId: "owner-a", pageSize: 10 });
  assertEquals(result.ok, true);
  assert(result.ok);
  assertEquals((/** @type {{ classification?: unknown }} */ (seen.classification?.legacyAudit[0])).classification, null);
  assertEquals(seen.checkpoint?.status, "completed");
  assertEquals(seen.review, null);
});
