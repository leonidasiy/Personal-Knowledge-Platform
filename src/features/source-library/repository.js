// @ts-check

/** @import { LibrarySource, LibrarySourceEvent, Result, SourceIngestionJob, SourceLibraryFailure, LibrarySourceState, SourceSuppression } from "./contracts.js" */
/** @import { SourceItemVersion } from "./ingestion-contracts.js" */

const freeze = Object.freeze;

/**
 * @typedef {{
 *   readonly source: LibrarySource,
 *   readonly event: LibrarySourceEvent,
 *   readonly job: SourceIngestionJob,
 *   readonly initialItem?: SourceItemVersion | null,
 *   readonly fingerprint: string
 * }} ApprovalCommit
 */

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
      if (idempotency.fingerprint !== commit.fingerprint) {
        return {
          ok: false,
          error: {
            kind: "SourceIdempotencyConflict",
            idempotencyKey: commit.event.idempotencyKey,
          },
        };
      }
      const source = this.#sources.get(
        this.#sourceKey(commit.source.ownerId, idempotency.sourceId),
      );
      if (source === undefined) {
        throw new TypeError("Source idempotency invariant is broken.");
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
    this.#jobs.push(job);
    if (commit.initialItem != null) this.#items.push(structuredClone(commit.initialItem));
    this.#idempotency.set(
      this.#idempotencyKey(source.ownerId, event.idempotencyKey),
      freeze({
        fingerprint: commit.fingerprint,
        sourceId: source.id,
        jobId: job.id,
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
