import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createSourceClassificationBackfill } from "../src/features/source-classification/backfill.js";

/** @typedef {Parameters<typeof createSourceClassificationBackfill>[0]} Dependencies */
/** @typedef {Parameters<Dependencies["pageSources"]>[0]} SourcePageCommand */
/** @typedef {Parameters<Dependencies["pagePoints"]>[0]} PointPageCommand */
/** @typedef {Parameters<Dependencies["classify"]>[0]} ClassificationCommand */
/** @typedef {Parameters<Dependencies["persist"]>[0]} PersistCommand */
/** @typedef {Parameters<Dependencies["review"]>[0]} ReviewCommand */
/** @typedef {Parameters<Dependencies["checkpoint"]>[0]} CheckpointCommand */
/** @param {string} _name @param {() => void} run */ const describe = (_name, run) => run();
/** @param {string} name @param {() => void | Promise<void>} run */ const it = (name, run) => Deno.test(name, run);

/** @param {string} id @param {Record<string, unknown>} [extra] */ const point = (id, extra = {}) => ({ id, summary: `summary ${id}`, attribution: { sourceUrl: "https://example.test/source" }, ...extra });
const classified = { mainSubject: "music", topic: "Music history" };
/** @template T, E @param {{ ok: true, value: T } | { ok: false, error: E }} result @returns {asserts result is { ok: true, value: T }} */
function assertSuccess(result) { assert(result.ok); }

/** @param {Partial<Dependencies>} [overrides] */
function setup(overrides = {}) {
  /** @type {{ pages: SourcePageCommand[], pointPages: PointPageCommand[], inferences: ClassificationCommand[], persist: PersistCommand[], issues: ReviewCommand[], checkpoint: CheckpointCommand[] }} */
  const calls = { pages: [], pointPages: [], inferences: [], persist: [], issues: [], checkpoint: [] };
  /** @type {Dependencies} */ const deps = {
    pageSources: async (command) => { calls.pages.push(command); return { ok: true, value: { sources: [{ ownerId: command.ownerId, id: "s1", revision: 2, title: "title" }], nextCursor: null } }; },
    pagePoints: async (command) => { calls.pointPages.push(command); return { ok: true, value: { points: [point("p1", { classification: { mainSubject: "legacy-a" } }), point("p2", { classification: null })], nextCursor: null } }; },
    classify: async (command) => { calls.inferences.push(command); return { ok: true, value: classified }; },
    getClassification: async () => ({ ok: true, value: null }),
    persist: async (command) => { calls.persist.push(command); return { ok: true, value: { origin: "backfill", status: "classified" } }; },
    review: async (command) => { calls.issues.push(command); return { ok: true, value: null }; },
    checkpoint: async (command) => { calls.checkpoint.push(command); return { ok: true, value: null }; },
    now: () => "2026-10-04T00:00:00.000Z",
    logger: () => {},
    ...overrides,
  };
  return { calls, backfill: createSourceClassificationBackfill(deps) };
}

describe("source classification backfill", () => {
  it("infers every source from all current-revision points and preserves conflicting/missing/consistent legacy audit", async () => {
    const { calls, backfill } = setup({ pagePoints: async (command) => ({ ok: true, value: { points: [point("a", { classification: { mainSubject: "old" } }), point("b", { classification: null }), point("c", { classification: { mainSubject: "old" } }), point("d")], nextCursor: null } }) });
    const result = await backfill.run({ ownerId: "owner", pageSize: 2 });
    assertEquals(result.ok, true);
    assertSuccess(result);
    assertEquals(calls.inferences.length, 1);
    assertEquals(calls.inferences[0].points.map(({ id }) => id), ["a", "b", "c", "d"]);
    assertEquals(calls.persist[0].legacyAudit.length, 4);
    assertEquals(Object.hasOwn(/** @type {object} */ (calls.persist[0].legacyAudit[1]), "classification"), true);
    assertEquals((/** @type {{ classification?: unknown }} */ (calls.persist[0].legacyAudit[1])).classification, null);
    assertEquals(Object.hasOwn(/** @type {object} */ (calls.persist[0].legacyAudit[3]), "classification"), false);
    assertEquals(calls.checkpoint.map(({ status }) => status), ["read", "completed"]);
  });
  it("uses keyset pagination and reports nonzero outcome counts", async () => {
    const { calls, backfill } = setup({ pageSources: async (command) => { calls.pages.push(command); return { ok: true, value: command.afterSourceId === null ? { sources: [{ ownerId: "owner", id: "a", revision: 1, title: "A" }], nextCursor: "a" } : { sources: [{ ownerId: "owner", id: "b", revision: 1, title: "B" }], nextCursor: null } }; } });
    const result = await backfill.run({ ownerId: "owner", pageSize: 1 });
    assertEquals(result.ok, true);
    assertSuccess(result);
    assertEquals(calls.pages.map(({ afterSourceId }) => afterSourceId), [null, "a"]);
    assertEquals(result.value.counts, { scanned: 2, classified: 2, needsReview: 0, alreadyProcessed: 0, manualPreserved: 0 });
  });
  it("rejects cross-owner source rows and stops on list/point/persistence failures", async () => {
    /** @type {Partial<Dependencies>[]} */ const overrides = [
      { pageSources: async () => ({ ok: true, value: { sources: [{ ownerId: "other", id: "x", revision: 1, title: "X" }], nextCursor: null } }) },
      { pageSources: async () => ({ ok: false, error: { kind: "SourceListFailed" } }) },
      { pagePoints: async () => ({ ok: false, error: { kind: "PointListFailed" } }) },
      { persist: async () => ({ ok: false, error: { kind: "PersistenceFailed" } }) },
    ];
    for (const override of overrides) {
      const { backfill } = setup(override);
      const result = await backfill.run({ ownerId: "owner", pageSize: 1 });
      assertEquals(result.ok, false);
    }
  });
  it("records inference failures and continues to subsequent sources", async () => {
    let calls = 0;
    const { calls: observed, backfill } = setup({ pageSources: async (command) => ({ ok: true, value: { sources: command.afterSourceId === null ? [{ ownerId: "owner", id: "a", revision: 1, title: "A" }] : [{ ownerId: "owner", id: "b", revision: 1, title: "B" }], nextCursor: command.afterSourceId === null ? "a" : null } }), classify: async (cmd) => { observed.inferences.push(cmd); return ++calls === 1 ? { ok: false, error: { kind: "SourceClassificationInferenceFailed" } } : { ok: true, value: classified }; } });
    const result = await backfill.run({ ownerId: "owner", pageSize: 1 });
    assertEquals(result.ok, true);
    assertSuccess(result);
    assertEquals(observed.issues.length, 1);
    assertEquals(observed.inferences.length, 2);
  });
  it("preserves manual classifications present before or racing inference", async () => {
    for (const manualDuring of [false, true]) {
      const { calls, backfill } = setup({
        getClassification: async () => manualDuring ? { ok: true, value: null } : { ok: true, value: { origin: "manual", sourceRevision: 2 } },
        persist: async (command) => { calls.persist.push(command); return { ok: true, value: { origin: "manual", status: "classified" } }; },
      });
      const result = await backfill.run({ ownerId: "owner", pageSize: 5 });
      assertEquals(result.ok, true);
      assertSuccess(result);
      if (manualDuring) assertEquals(calls.persist.length, 1);
      else assertEquals(calls.inferences.length, 0);
    }
  });
  it("stops on review and checkpoint persistence failures", async () => {
    /** @type {Partial<Dependencies>[]} */ const overrides = [
      { classify: async () => ({ ok: false, error: { kind: "SourceClassificationInferenceFailed" } }), review: async () => ({ ok: false, error: { kind: "ReviewWriteFailed" } }) },
      { checkpoint: async () => ({ ok: false, error: { kind: "CheckpointWriteFailed" } }) },
    ];
    for (const override of overrides) {
      const { backfill } = setup(override);
      const result = await backfill.run({ ownerId: "owner", pageSize: 5 });
      assertEquals(result.ok, false);
    }
  });
  it("isolates owner and current source revision when loading points", async () => {
    const { calls, backfill } = setup();
    await backfill.run({ ownerId: "owner", pageSize: 4 });
    assertEquals(calls.pointPages[0].ownerId, "owner");
    assertEquals(calls.pointPages[0].sourceRevision, 2);
  });
  it("retries a stale completed checkpoint when its classification row is missing", async () => {
    const { calls, backfill } = setup({ checkpoint: async (command) => command.status === "read" ? { ok: true, value: "completed" } : { ok: true, value: null } });
    const result = await backfill.run({ ownerId: "owner", pageSize: 5 });
    assertEquals(result.ok, true);
    assertSuccess(result);
    assertEquals(calls.inferences.length, 1);
    assertEquals(result.value.counts.classified, 1);
  });
  it("marks sources with no points for review and rejects malformed classifier output", async () => {
    const empty = setup({ pagePoints: async () => ({ ok: true, value: { points: [], nextCursor: null } }) });
    const reviewed = await empty.backfill.run({ ownerId: "owner", pageSize: 5 });
    assertEquals(reviewed.ok, true);
    assertSuccess(reviewed);
    assertEquals(reviewed.value.counts.needsReview, 1);
    assertEquals(empty.calls.issues[0].issueKind, "legacy-unclassified");
    const malformed = setup({ classify: async () => ({ ok: true, value: { mainSubject: "invented", topic: "x" } }) });
    const invalid = await malformed.backfill.run({ ownerId: "owner", pageSize: 5 });
    assertEquals(invalid.ok, false);
    assertEquals(malformed.calls.persist.length, 0);
  });
});
