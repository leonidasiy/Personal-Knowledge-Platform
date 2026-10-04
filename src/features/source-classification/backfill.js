// @ts-check

import { parseSourceClassification } from "./public.js";

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {{ readonly ownerId: string, readonly id: string, readonly revision: number, readonly title: string }} BackfillSource */
/** @typedef {{ readonly id: string, readonly summary: string, readonly attribution: { readonly sourceUrl: string }, readonly classification?: unknown }} BackfillPoint */
/** @typedef {{ readonly ownerId: string, readonly afterSourceId: string | null, readonly limit: number }} SourcePageCommand */
/** @typedef {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly afterKnowledgeId: string | null, readonly limit: number }} PointPageCommand */
/** @typedef {{ readonly sources: readonly BackfillSource[], readonly nextCursor: string | null }} SourcePage */
/** @typedef {{ readonly points: readonly BackfillPoint[], readonly nextCursor: string | null }} PointPage */
/** @typedef {{ readonly kind: "BackfillCommandInvalid" | "BackfillSourceListFailed" | "BackfillPointListFailed" | "BackfillSourceInvalid" | "BackfillPointInvalid" | "BackfillClassificationReadFailed" | "BackfillCheckpointReadFailed" | "BackfillCheckpointWriteFailed" | "BackfillPersistenceFailed" | "BackfillReviewWriteFailed" }} BackfillFailure */
/** @typedef {{ scanned: number, classified: number, needsReview: number, alreadyProcessed: number, manualPreserved: number }} BackfillCounts */
/** @typedef {{ readonly ownerId: string, readonly counts: BackfillCounts }} BackfillOutcome */
/** @typedef {{ readonly pageSources: (command: SourcePageCommand) => Promise<Result<SourcePage, unknown>>, readonly pagePoints: (command: PointPageCommand) => Promise<Result<PointPage, unknown>>, readonly classify: (command: { readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly title: string, readonly points: readonly BackfillPoint[] }) => Promise<Result<{ readonly mainSubject: string, readonly topic: string }, unknown>>, readonly getClassification: (command: { readonly ownerId: string, readonly sourceId: string }) => Promise<Result<{ readonly sourceRevision: number, readonly origin: string, readonly status?: string } | null, unknown>>, readonly persist: (command: { readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly classification: { readonly mainSubject: string, readonly topic: string }, readonly legacyAudit: readonly unknown[] }) => Promise<Result<{ readonly origin: string, readonly status: string }, unknown>>, readonly review: (command: { readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly issueKind: "inference-failed" | "legacy-unclassified" }) => Promise<Result<null, unknown>>, readonly checkpoint: (command: { readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly status: "read" | "completed" | "needs-review" | "manual-preserved" }) => Promise<Result<string | null, unknown>>, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }) => void }} BackfillDependencies */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} source @param {string} ownerId @returns {source is BackfillSource} */
function validSource(source, ownerId) { return record(source) && source.ownerId === ownerId && text(source.id) && Number.isSafeInteger(source.revision) && /** @type {number} */ (source.revision) > 0 && text(source.title); }
/** @param {unknown} point @returns {point is BackfillPoint} */
function validPoint(point) { return record(point) && text(point.id) && text(point.summary) && record(point.attribution) && typeof point.attribution.sourceUrl === "string" && URL.canParse(point.attribution.sourceUrl) && new URL(point.attribution.sourceUrl).protocol === "https:"; }

/** @param {BackfillDependencies} dependencies */
export function createSourceClassificationBackfill(dependencies) {
  if (!record(dependencies) || typeof dependencies.pageSources !== "function" || typeof dependencies.pagePoints !== "function" || typeof dependencies.classify !== "function" || typeof dependencies.getClassification !== "function" || typeof dependencies.persist !== "function" || typeof dependencies.review !== "function" || typeof dependencies.checkpoint !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") throw new TypeError("SourceClassificationBackfillDependenciesInvalid");
  return Object.freeze({
    /** @param {unknown} command @returns {Promise<Result<{ readonly ownerId: string, readonly counts: BackfillCounts }, BackfillFailure>>} */
    async run(command) {
      if (!record(command) || Object.keys(command).sort().join(",") !== "ownerId,pageSize" || !text(command.ownerId) || !Number.isSafeInteger(command.pageSize) || /** @type {number} */ (command.pageSize) < 1 || /** @type {number} */ (command.pageSize) > 500) return { ok: false, error: { kind: "BackfillCommandInvalid" } };
      /** @type {{ readonly ownerId: string, readonly pageSize: number }} */ const validCommand = /** @type {never} */ (command);
      const ownerId = validCommand.ownerId.trim();
      /** @type {BackfillCounts} */ const counts = { scanned: 0, classified: 0, needsReview: 0, alreadyProcessed: 0, manualPreserved: 0 };
      dependencies.logger({ event: "source-classification-backfill-entry", ownerId });
      let afterSourceId = null;
      while (true) {
        let page;
        try { page = await dependencies.pageSources({ ownerId, afterSourceId, limit: validCommand.pageSize }); } catch (error) { if (!(error instanceof Error)) throw error; return failure("BackfillSourceListFailed"); }
        if (!record(page) || typeof page.ok !== "boolean" || !page.ok) return failure("BackfillSourceListFailed");
        if (!record(page.value)) return failure("BackfillSourceInvalid");
        const sources = page.value.sources;
        if (!Array.isArray(sources) || !sources.every((source) => validSource(source, ownerId)) || (page.value.nextCursor !== null && (!text(page.value.nextCursor) || page.value.nextCursor !== sources.at(-1)?.id))) return failure("BackfillSourceInvalid");
        for (const source of sources) {
          counts.scanned++;
          let current;
          try { current = await dependencies.getClassification({ ownerId, sourceId: source.id }); } catch (error) { if (!(error instanceof Error)) throw error; return failure("BackfillClassificationReadFailed", source.id); }
          if (!record(current) || typeof current.ok !== "boolean" || !current.ok || (current.value !== null && (!record(current.value) || !Number.isSafeInteger(current.value.sourceRevision) || typeof current.value.origin !== "string" || (current.value.status !== undefined && typeof current.value.status !== "string")))) return failure("BackfillClassificationReadFailed", source.id);
          if (current.value?.origin === "manual") { counts.manualPreserved++; if (!await checkpoint(source, "manual-preserved")) return failure("BackfillCheckpointWriteFailed", source.id); continue; }
          if (current.value?.sourceRevision === source.revision && current.value.origin !== "manual" && current.value.status === "classified") { counts.alreadyProcessed++; continue; }
          let existingCheckpoint;
          try { existingCheckpoint = await dependencies.checkpoint({ ownerId, sourceId: source.id, sourceRevision: source.revision, status: "read" }); } catch (error) { if (!(error instanceof Error)) throw error; return failure("BackfillCheckpointReadFailed", source.id); }
          if (!record(existingCheckpoint) || typeof existingCheckpoint.ok !== "boolean" || !existingCheckpoint.ok || ![null, "completed", "needs-review", "manual-preserved"].includes(existingCheckpoint.value)) return failure("BackfillCheckpointReadFailed", source.id);
          // Checkpoints track progress only; the classification row is the idempotency authority.
          /** @type {BackfillPoint[]} */ const points = [];
          let afterKnowledgeId = null;
          while (true) {
            let pointPage;
            try { pointPage = await dependencies.pagePoints({ ownerId, sourceId: source.id, sourceRevision: source.revision, afterKnowledgeId, limit: validCommand.pageSize }); } catch (error) { if (!(error instanceof Error)) throw error; return failure("BackfillPointListFailed", source.id); }
            if (!record(pointPage) || typeof pointPage.ok !== "boolean" || !pointPage.ok) return failure("BackfillPointListFailed", source.id);
            if (!record(pointPage.value)) return failure("BackfillPointInvalid", source.id);
            if (!Array.isArray(pointPage.value.points) || !pointPage.value.points.every(validPoint) || (pointPage.value.nextCursor !== null && (!text(pointPage.value.nextCursor) || pointPage.value.nextCursor !== pointPage.value.points.at(-1)?.id))) return failure("BackfillPointInvalid", source.id);
            points.push(...pointPage.value.points);
            if (pointPage.value.nextCursor === null) break;
            if (pointPage.value.nextCursor === afterKnowledgeId || pointPage.value.points.length === 0) return failure("BackfillPointInvalid", source.id);
            afterKnowledgeId = pointPage.value.nextCursor;
          }
          const audit = points.map((point) => Object.freeze(Object.hasOwn(point, "classification") ? { knowledgeId: point.id, classification: point.classification } : { knowledgeId: point.id }));
          if (points.length === 0) {
            let reviewed;
            try { reviewed = await dependencies.review({ ownerId, sourceId: source.id, sourceRevision: source.revision, issueKind: "legacy-unclassified" }); }
            catch (error) { if (!(error instanceof Error)) throw error; return failure("BackfillReviewWriteFailed", source.id); }
            if (!record(reviewed) || typeof reviewed.ok !== "boolean" || !reviewed.ok) return failure("BackfillReviewWriteFailed", source.id);
            let marked;
            try { marked = await dependencies.checkpoint({ ownerId, sourceId: source.id, sourceRevision: source.revision, status: "needs-review" }); }
            catch (error) { if (!(error instanceof Error)) throw error; return failure("BackfillCheckpointWriteFailed", source.id); }
            if (!record(marked) || typeof marked.ok !== "boolean" || !marked.ok) return failure("BackfillCheckpointWriteFailed", source.id);
            counts.needsReview++; continue;
          }
          /** @type {Result<{ readonly mainSubject: string, readonly topic: string }, unknown>} */ let inferred;
          try { inferred = await dependencies.classify({ ownerId, sourceId: source.id, sourceRevision: source.revision, title: source.title, points }); }
          catch (error) { if (!(error instanceof Error)) throw error; inferred = { ok: false, error: { kind: "SourceClassificationInferenceFailed" } }; }
          if (!record(inferred) || typeof inferred.ok !== "boolean") return failure("BackfillSourceInvalid", source.id);
          if (!inferred.ok) {
            let reviewed;
            try { reviewed = await dependencies.review({ ownerId, sourceId: source.id, sourceRevision: source.revision, issueKind: "inference-failed" }); } catch (error) { if (!(error instanceof Error)) throw error; return failure("BackfillReviewWriteFailed", source.id); }
            if (!record(reviewed) || typeof reviewed.ok !== "boolean" || !reviewed.ok) return failure("BackfillReviewWriteFailed", source.id);
            let marked;
            try { marked = await dependencies.checkpoint({ ownerId, sourceId: source.id, sourceRevision: source.revision, status: "needs-review" }); } catch (error) { if (!(error instanceof Error)) throw error; return failure("BackfillCheckpointWriteFailed", source.id); }
            if (!record(marked) || typeof marked.ok !== "boolean" || !marked.ok) return failure("BackfillCheckpointWriteFailed", source.id);
            counts.needsReview++; continue;
          }
          const validClassification = parseSourceClassification(inferred.value);
          if (!validClassification.ok) return failure("BackfillSourceInvalid", source.id);
          let persisted;
          try { persisted = await dependencies.persist({ ownerId, sourceId: source.id, sourceRevision: source.revision, classification: validClassification.value, legacyAudit: audit }); } catch (error) { if (!(error instanceof Error)) throw error; return failure("BackfillPersistenceFailed", source.id); }
          if (!record(persisted) || typeof persisted.ok !== "boolean" || !persisted.ok || !record(persisted.value) || typeof persisted.value.origin !== "string" || typeof persisted.value.status !== "string") return failure("BackfillPersistenceFailed", source.id);
          if (persisted.value.origin === "manual") { counts.manualPreserved++; if (!await checkpoint(source, "manual-preserved")) return failure("BackfillCheckpointWriteFailed", source.id); continue; }
          let marked;
          try { marked = await dependencies.checkpoint({ ownerId, sourceId: source.id, sourceRevision: source.revision, status: "completed" }); } catch (error) { if (!(error instanceof Error)) throw error; return failure("BackfillCheckpointWriteFailed", source.id); }
          if (!record(marked) || typeof marked.ok !== "boolean" || !marked.ok) return failure("BackfillCheckpointWriteFailed", source.id);
          counts.classified++;
        }
        if (page.value.nextCursor === null) break;
        if (page.value.nextCursor === afterSourceId || sources.length === 0) return failure("BackfillSourceInvalid");
        afterSourceId = page.value.nextCursor;
      }
      dependencies.logger({ event: "source-classification-backfill-success", ownerId });
      return { ok: true, value: Object.freeze({ ownerId, counts: Object.freeze({ ...counts }) }) };

      /** @param {BackfillSource} source @param {"completed" | "needs-review" | "manual-preserved"} status */
      async function checkpoint(source, status) {
        try { const result = await dependencies.checkpoint({ ownerId, sourceId: source.id, sourceRevision: source.revision, status }); return record(result) && result.ok === true; } catch (error) { if (!(error instanceof Error)) throw error; return false; }
      }
      /** @param {BackfillFailure["kind"]} kind @param {string} [sourceId] */
      /** @param {BackfillFailure["kind"]} kind @param {string} [sourceId] */
      function failure(kind, sourceId) {
        dependencies.logger({ event: "source-classification-backfill-failure", ownerId, sourceId, failureKind: kind });
        return /** @type {{ readonly ok: false, readonly error: BackfillFailure }} */ ({ ok: false, error: { kind } });
      }
    },
  });
}

export {};
