// @ts-check

import { isRecord, isNonEmptyText, isIsoDateTime } from "./contracts.js";

/** @import { LibrarySource, LibrarySourceEvent, Result, SourceIngestionJob, SourceLibraryFailure, LibrarySourceState, SourceSuppression } from "./contracts.js" */
/** @import { SourceItemVersion } from "./ingestion-contracts.js" */

const freeze = Object.freeze;

/** Submitted Link observation time is server provenance, not request identity.
 * Normalizing stored fingerprints also preserves replay of earlier approvals.
 * @param {string} fingerprint @param {string} adapterId @returns {string}
 */
export function sourceApprovalFingerprint(fingerprint, adapterId) {
  if (typeof fingerprint !== "string" || !isNonEmptyText(adapterId)) throw new TypeError("Source approval fingerprint input is invalid.");
  if (adapterId !== "submitted-link") return fingerprint;
  let value;
  try { value = JSON.parse(fingerprint); }
  catch (error) { if (error instanceof SyntaxError) throw new TypeError("Source approval fingerprint is invalid JSON.", { cause: error }); throw error; }
  if (!isRecord(value) || !isRecord(value.adapter) || value.adapter.id !== "submitted-link" || value.adapter.version !== "v1" ||
    !Array.isArray(value.identityEvidence) || value.identityEvidence.length !== 1) return fingerprint;
  const evidence = value.identityEvidence[0];
  if (!isRecord(evidence) || evidence.attribute !== "user-submitted-url" || evidence.value !== value.submittedUrl ||
    evidence.provenanceUrl !== value.submittedUrl || !Object.hasOwn(evidence, "observedAt")) return fingerprint;
  if (!isIsoDateTime(evidence.observedAt)) throw new TypeError("Submitted Link observation time is invalid.");
  const { observedAt: _observation, ...identity } = evidence;
  return JSON.stringify({ ...value, identityEvidence: [identity] });
}

/**
 * @typedef {{
 *   readonly source: LibrarySource,
 *   readonly event: LibrarySourceEvent,
 *   readonly job: SourceIngestionJob | null,
 *   readonly initialItem?: SourceItemVersion | null,
 *   readonly fingerprint: string,
 *   readonly ownerUploadAuthorization?: true
 * }} ApprovalCommit
 */

/** @param {ApprovalCommit} commit @param {string} fingerprint @param {LibrarySource} source @returns {boolean} */
export function matchesPrivateDocumentReplay(commit, fingerprint, source) {
  if (commit.ownerUploadAuthorization !== true || commit.source.origin !== "private-document" || source.origin !== "private-document" || source.ownerId !== commit.source.ownerId) return false;
  let previous, current;
  try { previous = JSON.parse(fingerprint); current = JSON.parse(commit.fingerprint); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  if (!isRecord(previous) || !isRecord(current) || [previous, current].some(record => Object.keys(record).length !== 7) ||
    !isNonEmptyText(previous.basis) || !isNonEmptyText(previous.reference) || current.basis !== "user-owned upload authorization" || current.reference !== `user-upload:${commit.event.idempotencyKey}`) return false;
  const origin = previous.applicationOrigin;
  if (typeof origin !== "string") return false;
  for (const field of ["ownerId", "title", "fileName", "idempotencyKey", "applicationOrigin"]) {
    if (!isNonEmptyText(previous[field]) || previous[field] !== current[field]) return false;
  }
  if (previous.ownerId !== source.ownerId || previous.idempotencyKey !== commit.event.idempotencyKey || source.adapter.id !== "private-document" ||
    source.submittedUrl !== source.canonicalUrl || source.canonicalUrl !== new URL(`api/private-documents/${encodeURIComponent(source.id)}`, origin).href ||
    !source.adapter.capabilities.includes("processing-attested")) return false;
  return [["owner-attested-processing", "storage, transformation, and processing allowed"], ["processing-basis", previous.basis], ["processing-reference", previous.reference], ["file-name", previous.fileName]].every(([attribute, value]) => {
    const evidence = source.identityEvidence.filter(entry => entry.attribute === attribute);
    return evidence.length === 1 && evidence[0].value === value && evidence[0].provenanceUrl === source.canonicalUrl && isIsoDateTime(evidence[0].observedAt);
  });
}

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly expectedRevision: number,
 *   readonly targetState: LibrarySourceState,
 *   readonly event: LibrarySourceEvent,
 *   readonly fingerprint: string
 * }} TransitionCommit
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly expectedRevision: number,
 *   readonly title: string,
 *   readonly description: string,
 *   readonly interestAreaIds: readonly string[],
 *   readonly event: LibrarySourceEvent,
 *   readonly fingerprint: string
 * }} RevisionCommit
 */

/** @typedef {{ readonly fingerprint: string, readonly sourceId: string, readonly jobId: string | null }} IdempotencyRecord */

/** @typedef {{ readonly suppression: SourceSuppression, readonly fingerprint: string }} SuppressionCommit */

export class SourceLibraryRepository {
  /** @type {Map<string, LibrarySource>} */
  #sources = new Map();
  /** @type {Map<string, string>} */
  #canonicalSources = new Map();
  /** @type {LibrarySourceEvent[]} */
  #events = [];
  /** @type {SourceIngestionJob[]} */
  #jobs = [];
  /** @type {SourceItemVersion[]} */
  #items = [];
  /** @type {Map<string, IdempotencyRecord>} */
  #idempotency = new Map();
  /** @type {Map<string, SourceSuppression>} */
  #suppressions = new Map();
  /** @type {Map<string, { readonly fingerprint: string, readonly suppressionId: string }>} */
  #suppressionIdempotency = new Map();

  /** @param {string} ownerId @param {string} sourceId */
  listItemVersions(ownerId, sourceId) {
    return freeze(this.#items.filter((item) => item.ownerId === ownerId && item.sourceId === sourceId).map((item) => structuredClone(item)));
  }

  /** @param {SuppressionCommit} commit @returns {Promise<Result<{ readonly suppression: SourceSuppression, readonly reused: boolean }, SourceLibraryFailure>>} */
  async suppress(commit) {
    const commandKey = this.#idempotencyKey(
      commit.suppression.ownerId,
      commit.suppression.idempotencyKey,
    );
    const replay = this.#suppressionIdempotency.get(commandKey);
    if (replay !== undefined) {
      if (replay.fingerprint !== commit.fingerprint) {
        return {
          ok: false,
          error: {
            kind: "SourceIdempotencyConflict",
            idempotencyKey: commit.suppression.idempotencyKey,
          },
        };
      }
      const suppression = this.#suppressions.get(
        this.#canonicalKey(
          commit.suppression.ownerId,
          commit.suppression.canonicalIdentity,
        ),
      );
      if (
        suppression === undefined || suppression.id !== replay.suppressionId
      ) {
        throw new TypeError(
          "Source suppression idempotency invariant is broken.",
        );
      }
      return { ok: true, value: freeze({ suppression, reused: true }) };
    }
    const canonicalKey = this.#canonicalKey(
      commit.suppression.ownerId,
      commit.suppression.canonicalIdentity,
    );
    const existing = this.#suppressions.get(canonicalKey);
    const suppression = existing ?? structuredClone(commit.suppression);
    this.#suppressions.set(canonicalKey, suppression);
    this.#suppressionIdempotency.set(
      commandKey,
      freeze({
        fingerprint: commit.fingerprint,
        suppressionId: suppression.id,
      }),
    );
    return {
      ok: true,
      value: freeze({ suppression, reused: existing !== undefined }),
    };
  }

  /**
   * @param {ApprovalCommit} commit
   * @returns {Promise<Result<{ readonly source: LibrarySource, readonly job: SourceIngestionJob | null, readonly reused: boolean }, SourceLibraryFailure>>}
   */
  async approve(commit) {
    const idempotency = this.#idempotency.get(
      this.#idempotencyKey(commit.source.ownerId, commit.event.idempotencyKey),
    );
    if (idempotency !== undefined) {
      const source = this.#sources.get(this.#sourceKey(commit.source.ownerId, idempotency.sourceId));
      if (source === undefined) throw new TypeError("Source idempotency invariant is broken.");
      if (sourceApprovalFingerprint(idempotency.fingerprint, commit.source.adapter.id) !== commit.fingerprint && !matchesPrivateDocumentReplay(commit, idempotency.fingerprint, source)) {
        return {
          ok: false,
          error: {
            kind: "SourceIdempotencyConflict",
            idempotencyKey: commit.event.idempotencyKey,
          },
        };
      }
      const job = idempotency.jobId === null
        ? null
        : this.#jobs.find((candidate) => candidate.id === idempotency.jobId) ??
          null;
      return { ok: true, value: freeze({ source, job, reused: true }) };
    }

    const canonicalKey = this.#canonicalKey(
      commit.source.ownerId,
      commit.source.canonicalUrl,
    );
    const existingId = this.#canonicalSources.get(canonicalKey);
    if (existingId !== undefined) {
      const existing = this.#sources.get(
        this.#sourceKey(commit.source.ownerId, existingId),
      );
      if (existing === undefined) {
        throw new TypeError("Canonical source invariant is broken.");
      }
      if (existing.state !== "active") {
        return {
          ok: false,
          error: {
            kind: "SourceStateConflict",
            sourceId: existing.id,
            state: existing.state,
            revision: existing.revision,
          },
        };
      }
      this.#idempotency.set(
        this.#idempotencyKey(existing.ownerId, commit.event.idempotencyKey),
        freeze({
          fingerprint: commit.fingerprint,
          sourceId: existing.id,
          jobId: null,
        }),
      );
      return {
        ok: true,
        value: freeze({ source: existing, job: null, reused: true }),
      };
    }
    const sourceKey = this.#sourceKey(commit.source.ownerId, commit.source.id);
    if (this.#sources.has(sourceKey)) {
      return { ok: false, error: { kind: "SourceIdentityConflict" } };
    }
    const source = structuredClone(commit.source);
    const event = structuredClone(commit.event);
    const job = structuredClone(commit.job);
    this.#sources.set(sourceKey, source);
    this.#canonicalSources.set(canonicalKey, source.id);
    this.#events.push(event);
    if (job !== null) this.#jobs.push(job);
    if (commit.initialItem != null) this.#items.push(structuredClone(commit.initialItem));
    this.#idempotency.set(
      this.#idempotencyKey(source.ownerId, event.idempotencyKey),
      freeze({
        fingerprint: commit.fingerprint,
        sourceId: source.id,
        jobId: job?.id ?? null,
      }),
    );
    return {
      ok: true,
      value: freeze({ source, job, reused: false }),
    };
  }

  /**
   * @param {RevisionCommit} commit
   * @returns {Promise<Result<LibrarySource, SourceLibraryFailure>>}
   */
  async revise(commit) {
    const idempotencyKey = this.#idempotencyKey(
      commit.ownerId,
      commit.event.idempotencyKey,
    );
    const idempotency = this.#idempotency.get(idempotencyKey);
    if (idempotency !== undefined) {
      if (idempotency.fingerprint !== commit.fingerprint) {
        return {
          ok: false,
          error: {
            kind: "SourceIdempotencyConflict",
            idempotencyKey: commit.event.idempotencyKey,
          },
        };
      }
      const existing = this.#sources.get(
        this.#sourceKey(commit.ownerId, idempotency.sourceId),
      );
      if (existing === undefined) {
        throw new TypeError("Revision idempotency invariant is broken.");
      }
      return { ok: true, value: existing };
    }
    const source = this.#sources.get(
      this.#sourceKey(commit.ownerId, commit.sourceId),
    );
    if (source === undefined) {
      const ownerMismatch = [...this.#sources.values()].some((candidate) =>
        candidate.id === commit.sourceId
      );
      return ownerMismatch
        ? {
          ok: false,
          error: { kind: "SourceOwnerMismatch", sourceId: commit.sourceId },
        }
        : {
          ok: false,
          error: { kind: "SourceNotFound", sourceId: commit.sourceId },
        };
    }
    if (source.revision !== commit.expectedRevision) {
      return {
        ok: false,
        error: {
          kind: "SourceRevisionStale",
          expectedRevision: commit.expectedRevision,
          actualRevision: source.revision,
        },
      };
    }
    if (source.state !== "active") {
      return {
        ok: false,
        error: {
          kind: "SourceStateConflict",
          sourceId: source.id,
          state: source.state,
          revision: source.revision,
        },
      };
    }
    const next = structuredClone({
      ...source,
      title: commit.title,
      description: commit.description,
      interestAreaIds: commit.interestAreaIds,
      updatedAt: commit.event.occurredAt,
      revision: source.revision + 1,
    });
    this.#sources.set(this.#sourceKey(next.ownerId, next.id), next);
    this.#events.push(structuredClone(commit.event));
    this.#idempotency.set(
      idempotencyKey,
      freeze({
        fingerprint: commit.fingerprint,
        sourceId: next.id,
        jobId: null,
      }),
    );
    return { ok: true, value: next };
  }

  /**
   * @param {TransitionCommit} commit
   * @returns {Promise<Result<LibrarySource, SourceLibraryFailure>>}
   */
  async transition(commit) {
    const idempotencyKey = this.#idempotencyKey(
      commit.ownerId,
      commit.event.idempotencyKey,
    );
    const idempotency = this.#idempotency.get(idempotencyKey);
    if (idempotency !== undefined) {
      if (idempotency.fingerprint !== commit.fingerprint) {
        return {
          ok: false,
          error: {
            kind: "SourceIdempotencyConflict",
            idempotencyKey: commit.event.idempotencyKey,
          },
        };
      }
      const existing = this.#sources.get(
        this.#sourceKey(commit.ownerId, idempotency.sourceId),
      );
      if (existing === undefined) {
        throw new TypeError("Transition idempotency invariant is broken.");
      }
      return { ok: true, value: existing };
    }
    const source = this.#sources.get(
      this.#sourceKey(commit.ownerId, commit.sourceId),
    );
    if (source === undefined) {
      const ownerMismatch = [...this.#sources.values()].some((candidate) =>
        candidate.id === commit.sourceId
      );
      return ownerMismatch
        ? {
          ok: false,
          error: { kind: "SourceOwnerMismatch", sourceId: commit.sourceId },
        }
        : {
          ok: false,
          error: { kind: "SourceNotFound", sourceId: commit.sourceId },
        };
    }
    if (source.revision !== commit.expectedRevision) {
      return {
        ok: false,
        error: {
          kind: "SourceRevisionStale",
          expectedRevision: commit.expectedRevision,
          actualRevision: source.revision,
        },
      };
    }
    if (source.state === commit.targetState) {
      return {
        ok: false,
        error: {
          kind: "SourceStateConflict",
          sourceId: source.id,
          state: source.state,
          revision: source.revision,
        },
      };
    }
    const next = structuredClone({
      ...source,
      state: commit.targetState,
      updatedAt: commit.event.occurredAt,
      revision: source.revision + 1,
    });
    this.#sources.set(this.#sourceKey(next.ownerId, next.id), next);
    this.#events.push(structuredClone(commit.event));
    this.#idempotency.set(
      idempotencyKey,
      freeze({
        fingerprint: commit.fingerprint,
        sourceId: next.id,
        jobId: null,
      }),
    );
    return { ok: true, value: next };
  }

  /** @param {string} ownerId @param {string} sourceId */
  get(ownerId, sourceId) {
    return this.#sources.get(this.#sourceKey(ownerId, sourceId)) ?? null;
  }

  /** @param {string} ownerId */
  list(ownerId) {
    return freeze(
      [...this.#sources.values()].filter((source) =>
        source.ownerId === ownerId
      ),
    );
  }

  /** @param {string} ownerId */
  listEvents(ownerId) {
    return freeze(this.#events.filter((event) => event.ownerId === ownerId));
  }

  /** @param {string} ownerId */
  listIngestionJobs(ownerId) {
    return freeze(this.#jobs.filter((job) => job.ownerId === ownerId));
  }

  /** @param {string} ownerId */
  listSuppressions(ownerId) {
    return freeze(
      [...this.#suppressions.values()].filter((suppression) =>
        suppression.ownerId === ownerId
      ),
    );
  }

  /** @param {string} ownerId @param {string} sourceId */
  #sourceKey(ownerId, sourceId) {
    return `${ownerId}\u0000${sourceId}`;
  }

  /** @param {string} ownerId @param {string} canonicalUrl */
  #canonicalKey(ownerId, canonicalUrl) {
    return `${ownerId}\u0000${canonicalUrl}`;
  }

  /** @param {string} ownerId @param {string} idempotencyKey */
  #idempotencyKey(ownerId, idempotencyKey) {
    return `${ownerId}\u0000${idempotencyKey}`;
  }
}
