// @ts-check

import { createSourceClassificationBackfill } from "../src/features/source-classification/backfill.js";
import { createSourceClassifier } from "../src/features/source-classification/public.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Composes the backfill with the same source classifier and classification repository used by live ingestion.
 * @param {{ readonly backfillRepository: Pick<InstanceType<typeof import("./source-classification-backfill-d1.js").D1SourceClassificationBackfillRepository>, "pageSources" | "pagePoints" | "checkpoint">, readonly classificationRepository: Pick<InstanceType<typeof import("./source-classification-d1.js").D1SourceClassificationRepository>, "get" | "persistAgent" | "recordReviewIssue">, readonly classifier: ReturnType<typeof createSourceClassifier>, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }) => void }} dependencies
 */
export function createSourceClassificationBackfillRuntime(dependencies) {
  if (!record(dependencies) || typeof dependencies.backfillRepository?.pageSources !== "function" || typeof dependencies.backfillRepository?.pagePoints !== "function" || typeof dependencies.backfillRepository?.checkpoint !== "function" || typeof dependencies.classificationRepository?.get !== "function" || typeof dependencies.classificationRepository?.persistAgent !== "function" || typeof dependencies.classificationRepository?.recordReviewIssue !== "function" || typeof dependencies.classifier?.classify !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") throw new TypeError("SourceClassificationBackfillRuntimeDependenciesInvalid");
  return createSourceClassificationBackfill({
    pageSources: (command) => dependencies.backfillRepository.pageSources(command),
    pagePoints: (command) => dependencies.backfillRepository.pagePoints(command),
    checkpoint: (command) => dependencies.backfillRepository.checkpoint(command),
    getClassification: async (command) => {
      const result = await dependencies.classificationRepository.get(command);
      if (!record(result) || typeof result.ok !== "boolean") return { ok: false, error: { kind: "BackfillClassificationReadFailed" } };
      if (!result.ok) return { ok: false, error: { kind: "BackfillClassificationReadFailed" } };
      const value = result.value;
      if (value === null) return { ok: true, value: null };
      return record(value) && Number.isSafeInteger(value.sourceRevision) && typeof value.origin === "string" && typeof value.status === "string"
        ? { ok: true, value: { sourceRevision: /** @type {number} */ (value.sourceRevision), origin: value.origin, status: value.status } }
        : { ok: false, error: { kind: "BackfillClassificationReadFailed" } };
    },
    classify: (command) => dependencies.classifier.classify(command),
    persist: async (command) => {
      const result = await dependencies.classificationRepository.persistAgent(command);
      if (!record(result) || typeof result.ok !== "boolean") return { ok: false, error: { kind: "BackfillPersistenceFailed" } };
      if (!result.ok) return { ok: false, error: { kind: "BackfillPersistenceFailed" } };
      if (!record(result.value) || typeof result.value.inserted !== "boolean" || !record(result.value.value) || typeof result.value.value.origin !== "string" || typeof result.value.value.status !== "string") return { ok: false, error: { kind: "BackfillPersistenceFailed" } };
      return { ok: true, value: { origin: result.value.value.origin, status: result.value.value.status } };
    },
    review: (command) => dependencies.classificationRepository.recordReviewIssue(command),
    now: dependencies.now,
    logger: dependencies.logger,
  });
}

export {};
