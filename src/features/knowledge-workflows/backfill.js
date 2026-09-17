// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {import("../source-library/contracts.js").LibrarySource} LibrarySource */
/** @typedef {import("../source-library/rights-profile.js").SourceRightsProfile} SourceRightsProfile */

export const BACKFILL_CONFIRMATION = "MILESTONE_5_EXISTING_LIBRARY_BACKFILL";
export const BACKFILL_VERIFICATION_MARKER = "MILESTONE_5_LOCAL_VERIFIED";
export const REPLAY_CONFIRMATION = "MILESTONE_5_EXISTING_LIBRARY_REPLAY";
export const REPLAY_VERIFICATION_MARKER = "MILESTONE_5_REPLAY_LOCAL_VERIFIED";
// The first replay generation is already terminal in the deployed database. Bump
// this only for an intentional repair replay so a fixed workflow is not hidden
// behind the old completion marker or run idempotency key.
const REPLAY_EXECUTION_VERSION = "v22";

/** @typedef {{ readonly ownerId: string, readonly backfillKey: string, readonly sourceCount: number, readonly runIds: readonly string[], readonly createdAt: string }} BackfillMarker */
/** @typedef {{ readonly status: "completed" | "already-completed", readonly ownerId: string, readonly sourceCount: number, readonly runIds: readonly string[] }} BackfillResult */
/** @typedef {{ readonly kind: "BackfillCommandInvalid", readonly field: string } | { readonly kind: "BackfillConfirmationRequired" } | { readonly kind: "BackfillVerificationRequired" } | { readonly kind: "BackfillAlreadyCompleted" } | { readonly kind: "BackfillSourceListFailed" } | { readonly kind: "BackfillSourceInvalid" } | { readonly kind: "BackfillStartFailed", readonly sourceId: string } | { readonly kind: "BackfillReuseInvalidationFailed", readonly sourceId: string } | { readonly kind: "BackfillMarkerReadFailed" } | { readonly kind: "BackfillMarkerWriteFailed" } | { readonly kind: "BackfillContentResetFailed" }} BackfillFailure */
/** @typedef {{ readonly sourceId: string, readonly title: string, readonly reasonCode: "rights-not-verified" | "audio-video-transcription-unavailable", readonly message: string }} ReplayBlockedSource */
/** @typedef {{ readonly status: "completed" | "already-completed", readonly ownerId: string, readonly sourceCount: number, readonly runIds: readonly string[], readonly blockedSources: readonly ReplayBlockedSource[] }} ReplayResult */
/** @typedef {{ readonly kind: "ReplayCommandInvalid", readonly field: string } | { readonly kind: "ReplayConfirmationRequired" } | { readonly kind: "ReplayVerificationRequired" } | { readonly kind: "ReplaySourceListFailed" } | { readonly kind: "ReplaySourceInvalid" } | { readonly kind: "ReplayStartFailed", readonly sourceId: string } | { readonly kind: "ReplayReuseInvalidationFailed", readonly sourceId: string } | { readonly kind: "ReplayMarkerReadFailed" } | { readonly kind: "ReplayMarkerWriteFailed" } | { readonly kind: "ReplayContentResetFailed" }} ReplayFailure */

const freeze = Object.freeze;

/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is Readonly<Record<string, string>>} */
function configDigests(value) { return record(value) && Object.keys(value).length > 0 && Object.values(value).every(text); }
/** @param {unknown} value @returns {value is LibrarySource} */
function activeSource(value) {
  return record(value) && text(value.id) && text(value.ownerId) && value.state === "active" && positiveInteger(value.revision) && text(value.canonicalUrl) && URL.canParse(value.canonicalUrl) && new URL(value.canonicalUrl).protocol === "https:" && text(value.title) && text(value.description);
}

/** @param {LibrarySource} source @returns {boolean} */
function requiresNativeTranscription(source) {
  const descriptors = [source.adapter.granularity, ...source.adapter.capabilities].map((value) => value.toLowerCase());
  return descriptors.some((value) => /audio|video|podcast|episode/u.test(value));
}

/** @param {LibrarySource} source @returns {ReplayBlockedSource} */
function blockedSource(source) {
  return requiresNativeTranscription(source)
    ? Object.freeze({ sourceId: source.id, title: source.title, reasonCode: "audio-video-transcription-unavailable", message: "This source contains audio or video, but native audio/video transcription is not available yet. Upload an authorized transcript or text/document instead." })
    : Object.freeze({ sourceId: source.id, title: source.title, reasonCode: "rights-not-verified", message: "Automatic scraping is blocked because this source has no verified server-side permission profile; a paywall, sign-in requirement, or other access restriction may apply. Upload authorized text, PDF, PPTX, or a transcript instead." });
}

/** @param {{ readonly list: (ownerId: string) => Promise<Result<readonly LibrarySource[], unknown>>, readonly start: (command: unknown) => Promise<Result<{ readonly runId: string, readonly reused: boolean }, unknown>>, readonly reset?: (ownerId: string) => Promise<Result<null, unknown>>, readonly invalidateReuse?: (command: { readonly canonicalSourceIdentity: string, readonly sourceRevision: number }) => Promise<Result<null, unknown>>, readonly marker: { readonly read: (ownerId: string, backfillKey: string) => Promise<Result<BackfillMarker | null, unknown>>, readonly write: (marker: BackfillMarker) => Promise<Result<null, unknown>> }, readonly profileFor: (canonicalUrl: string) => SourceRightsProfile | null, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }) => void }} dependencies */
export function createKnowledgeWorkflowBackfill(dependencies) {
  if (typeof dependencies?.list !== "function" || typeof dependencies.start !== "function" || typeof dependencies.marker?.read !== "function" || typeof dependencies.marker.write !== "function" || typeof dependencies.profileFor !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") throw new TypeError("Knowledge workflow backfill dependencies are invalid.");
  return Object.freeze({
    /** @param {unknown} command @returns {Promise<Result<BackfillResult, BackfillFailure>>} */
    async run(command) {
      if (!record(command) || !text(command.ownerId) || !configDigests(command.configDigests) || command.confirmation !== BACKFILL_CONFIRMATION || command.verificationMarker !== BACKFILL_VERIFICATION_MARKER) {
        if (!record(command) || !text(command.ownerId) || !configDigests(command?.configDigests)) return { ok: false, error: { kind: "BackfillCommandInvalid", field: "command" } };
        if (command.confirmation !== BACKFILL_CONFIRMATION) return { ok: false, error: { kind: "BackfillConfirmationRequired" } };
        return { ok: false, error: { kind: "BackfillVerificationRequired" } };
      }
      const ownerId = command.ownerId.trim();
      const backfillKey = `knowledge-workflow-backfill-v1:${ownerId}`;
      dependencies.logger({ event: "knowledge-workflow-backfill-entry", ownerId });
      let existing;
      try { existing = await dependencies.marker.read(ownerId, backfillKey); } catch (error) { return { ok: false, error: { kind: "BackfillMarkerReadFailed" } }; }
      if (!existing.ok) return { ok: false, error: { kind: "BackfillMarkerReadFailed" } };
      if (existing.value !== null) {
        dependencies.logger({ event: "knowledge-workflow-backfill-already-completed", ownerId });
        return { ok: true, value: freeze({ status: "already-completed", ownerId, sourceCount: existing.value.sourceCount, runIds: freeze([...existing.value.runIds]) }) };
      }
      if (dependencies.reset !== undefined) {
        const reset = await dependencies.reset(ownerId);
        if (!reset.ok) {
          dependencies.logger({ event: "knowledge-workflow-backfill-reset-failure", ownerId, failureKind: "BackfillContentResetFailed" });
          return { ok: false, error: { kind: "BackfillContentResetFailed" } };
        }
      }
      let listed;
      try { listed = await dependencies.list(ownerId); } catch (error) { return { ok: false, error: { kind: "BackfillSourceListFailed" } }; }
      if (!listed.ok) return { ok: false, error: { kind: "BackfillSourceListFailed" } };
      const listedSources = [...listed.value];
      if (!listedSources.every((source) => activeSource(source) && source.ownerId === ownerId)) return { ok: false, error: { kind: "BackfillSourceInvalid" } };
      const sources = listedSources.filter((source) => dependencies.profileFor(source.canonicalUrl) !== null);
      dependencies.logger({ event: "knowledge-workflow-backfill-sources-filtered", ownerId });
      /** @type {string[]} */ const runIds = [];
      for (const source of sources) {
        if (dependencies.invalidateReuse !== undefined) {
          const invalidated = await dependencies.invalidateReuse({ canonicalSourceIdentity: source.canonicalUrl, sourceRevision: source.revision });
          if (!invalidated.ok) {
            dependencies.logger({ event: "knowledge-workflow-backfill-reuse-invalidation-failure", ownerId, sourceId: source.id, failureKind: "BackfillReuseInvalidationFailed" });
            return { ok: false, error: { kind: "BackfillReuseInvalidationFailed", sourceId: source.id } };
          }
        }
        const started = await dependencies.start({ ownerId, sourceId: source.id, sourceRevision: source.revision, canonicalSourceIdentity: source.canonicalUrl, contentSignature: `source-revision:${source.canonicalUrl}:${source.revision}`, configDigests: command.configDigests, idempotencyKey: `knowledge-workflow-backfill:${source.id}:${source.revision}`, rightsProfile: dependencies.profileFor?.(source.canonicalUrl) ?? null });
        if (!started.ok || !text(started.value.runId)) {
          dependencies.logger({ event: "knowledge-workflow-backfill-failure", ownerId, sourceId: source.id, failureKind: "BackfillStartFailed" });
          return { ok: false, error: { kind: "BackfillStartFailed", sourceId: source.id } };
        }
        runIds.push(started.value.runId);
      }
      const createdAt = dependencies.now();
      if (!text(createdAt) || !Number.isFinite(Date.parse(createdAt))) throw new TypeError("Knowledge workflow backfill clock returned an invalid timestamp.");
      const written = await dependencies.marker.write(freeze({ ownerId, backfillKey, sourceCount: sources.length, runIds: freeze([...runIds]), createdAt }));
      if (!written.ok) return { ok: false, error: { kind: "BackfillMarkerWriteFailed" } };
      dependencies.logger({ event: "knowledge-workflow-backfill-success", ownerId });
      return { ok: true, value: freeze({ status: "completed", ownerId, sourceCount: sources.length, runIds: freeze(runIds) }) };
    },
  });
}

/** @param {{ readonly list: (ownerId: string) => Promise<Result<readonly LibrarySource[], unknown>>, readonly start: (command: unknown) => Promise<Result<{ readonly runId: string, readonly reused: boolean }, unknown>>, readonly reset: (ownerId: string) => Promise<Result<null, unknown>>, readonly invalidateReuse?: (command: { readonly canonicalSourceIdentity: string, readonly sourceRevision: number }) => Promise<Result<null, unknown>>, readonly marker: { readonly read: (ownerId: string, backfillKey: string) => Promise<Result<BackfillMarker | null, unknown>>, readonly write: (marker: BackfillMarker) => Promise<Result<null, unknown>> }, readonly profileFor: (canonicalUrl: string) => SourceRightsProfile | null, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly ownerId?: string, readonly sourceId?: string, readonly failureKind?: string }) => void }} dependencies */
export function createKnowledgeWorkflowReplay(dependencies) {
  if (typeof dependencies?.list !== "function" || typeof dependencies.start !== "function" || typeof dependencies.reset !== "function" || typeof dependencies.marker?.read !== "function" || typeof dependencies.marker.write !== "function" || typeof dependencies.profileFor !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function") throw new TypeError("Knowledge workflow replay dependencies are invalid.");
  return Object.freeze({
    /** @param {unknown} command @returns {Promise<Result<ReplayResult, ReplayFailure>>} */
    async run(command) {
      if (!record(command) || !text(command.ownerId) || !configDigests(command.configDigests) || command.confirmation !== REPLAY_CONFIRMATION || command.verificationMarker !== REPLAY_VERIFICATION_MARKER) {
        if (!record(command) || !text(command.ownerId) || !configDigests(command?.configDigests)) return { ok: false, error: { kind: "ReplayCommandInvalid", field: "command" } };
        if (command.confirmation !== REPLAY_CONFIRMATION) return { ok: false, error: { kind: "ReplayConfirmationRequired" } };
        return { ok: false, error: { kind: "ReplayVerificationRequired" } };
      }
      const ownerId = command.ownerId.trim();
      const replayKey = `knowledge-workflow-replay-${REPLAY_EXECUTION_VERSION}:${ownerId}`;
      dependencies.logger({ event: "knowledge-workflow-replay-entry", ownerId });
      let existing;
      try { existing = await dependencies.marker.read(ownerId, replayKey); } catch (error) { return { ok: false, error: { kind: "ReplayMarkerReadFailed" } }; }
      if (!existing.ok) return { ok: false, error: { kind: "ReplayMarkerReadFailed" } };
      if (existing.value !== null) {
        dependencies.logger({ event: "knowledge-workflow-replay-already-completed", ownerId });
        return { ok: true, value: Object.freeze({ status: "already-completed", ownerId, sourceCount: existing.value.sourceCount, runIds: Object.freeze([...existing.value.runIds]), blockedSources: Object.freeze([]) }) };
      }
      const reset = await dependencies.reset(ownerId);
      if (!reset.ok) {
        dependencies.logger({ event: "knowledge-workflow-replay-reset-failure", ownerId, failureKind: "ReplayContentResetFailed" });
        return { ok: false, error: { kind: "ReplayContentResetFailed" } };
      }
      let listed;
      try { listed = await dependencies.list(ownerId); } catch (error) { return { ok: false, error: { kind: "ReplaySourceListFailed" } }; }
      if (!listed.ok) return { ok: false, error: { kind: "ReplaySourceListFailed" } };
      const sources = [...listed.value];
      if (!sources.every((source) => activeSource(source) && source.ownerId === ownerId)) return { ok: false, error: { kind: "ReplaySourceInvalid" } };
      /** @type {string[]} */ const runIds = [];
      /** @type {ReplayBlockedSource[]} */ const blockedSources = [];
      for (const source of sources) {
        if (dependencies.invalidateReuse !== undefined) {
          const invalidated = await dependencies.invalidateReuse({ canonicalSourceIdentity: source.canonicalUrl, sourceRevision: source.revision });
          if (!invalidated.ok) {
            dependencies.logger({ event: "knowledge-workflow-replay-reuse-invalidation-failure", ownerId, sourceId: source.id, failureKind: "ReplayReuseInvalidationFailed" });
            return { ok: false, error: { kind: "ReplayReuseInvalidationFailed", sourceId: source.id } };
          }
        }
        const profile = dependencies.profileFor(source.canonicalUrl);
        const started = await dependencies.start({ ownerId, sourceId: source.id, sourceRevision: source.revision, canonicalSourceIdentity: source.canonicalUrl, contentSignature: `source-revision:${source.canonicalUrl}:${source.revision}`, configDigests: command.configDigests, idempotencyKey: `knowledge-workflow-replay-${REPLAY_EXECUTION_VERSION}:${source.id}:${source.revision}`, rightsProfile: profile });
        if (!started.ok || !text(started.value.runId)) {
          dependencies.logger({ event: "knowledge-workflow-replay-failure", ownerId, sourceId: source.id, failureKind: "ReplayStartFailed" });
          return { ok: false, error: { kind: "ReplayStartFailed", sourceId: source.id } };
        }
        runIds.push(started.value.runId);
        if (profile === null) blockedSources.push(blockedSource(source));
      }
      const createdAt = dependencies.now();
      if (!text(createdAt) || !Number.isFinite(Date.parse(createdAt))) throw new TypeError("Knowledge workflow replay clock returned an invalid timestamp.");
      const written = await dependencies.marker.write(Object.freeze({ ownerId, backfillKey: replayKey, sourceCount: sources.length, runIds: Object.freeze([...runIds]), createdAt }));
      if (!written.ok) return { ok: false, error: { kind: "ReplayMarkerWriteFailed" } };
      dependencies.logger({ event: "knowledge-workflow-replay-success", ownerId });
      return { ok: true, value: Object.freeze({ status: "completed", ownerId, sourceCount: sources.length, runIds: Object.freeze(runIds), blockedSources: Object.freeze(blockedSources) }) };
    },
  });
}

export {};
