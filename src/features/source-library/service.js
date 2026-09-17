// @ts-check

import {
  isIsoDateTime,
  isNonEmptyText,
  isPublicHttpsUrl,
  isRecord,
} from "./contracts.js";

/** @import { LibrarySource, LibrarySourceEvent, Result, SourceIdentityEvidence, SourceLibraryFailure, SourceAdapterContract, SourceIngestionJob, LibrarySourceState, SourceSuppression, SourceApprovalInitialItem } from "./contracts.js" */

const freeze = Object.freeze;

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly submittedUrl: string,
 *   readonly canonicalUrl: string,
 *   readonly title: string,
 *   readonly description: string,
 *   readonly idempotencyKey: string,
 *   readonly adapter: SourceAdapterContract,
 *   readonly interestAreaIds: readonly string[],
 *   readonly identityEvidence: readonly SourceIdentityEvidence[]
 *   readonly initialItem: SourceApprovalInitialItem | null
 * }} ValidatedApproval
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceId: string,
 *   readonly idempotencyKey: string,
 *   readonly expectedRevision: number
 * }} ValidatedTransition
 */

/**
 * @typedef {ValidatedTransition & {
 *   readonly title: string,
 *   readonly description: string,
 *   readonly interestAreaIds: readonly string[]
 * }} ValidatedRevision
 */

/**
 * @typedef {{
 *   readonly approve: (commit: import("./repository.js").ApprovalCommit) => Promise<Result<{ readonly source: LibrarySource, readonly job: SourceIngestionJob | null, readonly reused: boolean }, SourceLibraryFailure>>,
 *   readonly revise: (commit: import("./repository.js").RevisionCommit) => Promise<Result<LibrarySource, SourceLibraryFailure>>,
 *   readonly transition: (commit: import("./repository.js").TransitionCommit) => Promise<Result<LibrarySource, SourceLibraryFailure>>
 *   readonly suppress: (commit: import("./repository.js").SuppressionCommit) => Promise<Result<{ readonly suppression: SourceSuppression, readonly reused: boolean }, SourceLibraryFailure>>
 * }} SourceLibraryRepositoryPort
 */

/**
 * @typedef {{
 *   readonly repository: SourceLibraryRepositoryPort,
 *   readonly createId: () => string,
 *   readonly now: () => string,
 *   readonly ingestionPolicyVersion: string
 * }} SourceLibraryDependencies
 */

export class SourceLibraryService {
  /** @type {SourceLibraryDependencies} */
  #dependencies;

  /** @param {SourceLibraryDependencies} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies.repository?.approve !== "function" ||
      typeof dependencies.repository?.revise !== "function" ||
      typeof dependencies.repository?.transition !== "function" ||
      typeof dependencies.repository?.suppress !== "function" ||
      typeof dependencies.createId !== "function" ||
      typeof dependencies.now !== "function" ||
      !isNonEmptyText(dependencies.ingestionPolicyVersion)
    ) {
      throw new TypeError("Source library dependencies are invalid.");
    }
    this.#dependencies = dependencies;
  }

  /** @param {unknown} command @returns {Promise<Result<LibrarySource, SourceLibraryFailure>>} */
  async revise(command) {
    const validated = validateRevisionCommand(command);
    if (!validated.ok) return validated;
    const occurredAt = this.#dependencies.now();
    if (!isIsoDateTime(occurredAt)) {
      throw new TypeError("Source library clock returned an invalid time.");
    }
    const event = freeze({
      id: this.#id("source-event"),
      ownerId: validated.value.ownerId,
      sourceId: validated.value.sourceId,
      kind: /** @type {const} */ ("revised"),
      sourceRevision: validated.value.expectedRevision + 1,
      idempotencyKey: validated.value.idempotencyKey,
      occurredAt,
    });
    return await this.#dependencies.repository.revise({
      ...validated.value,
      event,
      fingerprint: revisionFingerprint(validated.value),
    });
  }

  /**
   * @param {unknown} command
   * @returns {Promise<Result<{ readonly source: LibrarySource, readonly job: SourceIngestionJob | null, readonly reused: boolean }, SourceLibraryFailure>>}
   */
  async approve(command) {
    const validated = validateApprovalCommand(command);
    if (!validated.ok) return validated;
    const approvedAt = this.#dependencies.now();
    if (!isIsoDateTime(approvedAt)) {
      throw new TypeError("Source library clock returned an invalid time.");
    }
    const sourceId = this.#id("source");
    const eventId = this.#id("source-event");
    const jobId = this.#id("source-job");
    const source = freeze({
      id: sourceId,
      ownerId: validated.value.ownerId,
      origin: /** @type {const} */ ("web"),
      submittedUrl: validated.value.submittedUrl,
      canonicalUrl: validated.value.canonicalUrl,
      title: validated.value.title,
      description: validated.value.description,
      adapter: validated.value.adapter,
      interestAreaIds: validated.value.interestAreaIds,
      identityEvidence: validated.value.identityEvidence,
      state: /** @type {const} */ ("active"),
      approvedAt,
      updatedAt: approvedAt,
      revision: 1,
    });
    const event = freeze({
      id: eventId,
      ownerId: source.ownerId,
      sourceId,
      kind: /** @type {const} */ ("approved"),
      sourceRevision: 1,
      idempotencyKey: validated.value.idempotencyKey,
      occurredAt: approvedAt,
    });
    const job = freeze({
      id: jobId,
      ownerId: source.ownerId,
      sourceId,
      sourceRevision: 1,
      policyVersion: this.#dependencies.ingestionPolicyVersion,
      state: /** @type {const} */ ("pending"),
      createdAt: approvedAt,
    });
    return await this.#dependencies.repository.approve({
      source,
      event,
      job,
      initialItem: validated.value.initialItem === null ? null : freeze({
        ownerId: source.ownerId,
        sourceId,
        sourceRevision: 1,
        ...validated.value.initialItem,
      }),
      fingerprint: approvalFingerprint(validated.value),
    });
  }

  /** @param {unknown} command @returns {Promise<Result<{ readonly source: LibrarySource, readonly job: SourceIngestionJob | null, readonly reused: boolean }, SourceLibraryFailure>>} */
  async createPrivateDocument(command) {
    const validated = validatePrivateDocumentCommand(command);
    if (!validated.ok) return validated;
    const approvedAt = this.#dependencies.now();
    if (!isIsoDateTime(approvedAt)) throw new TypeError("Source library clock returned an invalid time.");
    const sourceId = this.#id("source");
    const canonicalUrl = new URL(`api/private-documents/${encodeURIComponent(sourceId)}`, validated.value.applicationOrigin).href;
    const source = freeze({
      id: sourceId, ownerId: validated.value.ownerId,
      origin: /** @type {const} */ ("private-document"), submittedUrl: canonicalUrl, canonicalUrl,
      title: validated.value.title, description: validated.value.fileName,
      adapter: freeze({ id: "private-document", version: "v1", granularity: "document", capabilities: freeze(["owner-private-document", "processing-attested"]) }),
      interestAreaIds: freeze([]),
      identityEvidence: freeze([
        freeze({ attribute: "owner-attested-processing", value: "storage, transformation, and processing allowed", provenanceUrl: canonicalUrl, observedAt: approvedAt }),
        freeze({ attribute: "processing-basis", value: validated.value.basis, provenanceUrl: canonicalUrl, observedAt: approvedAt }),
        freeze({ attribute: "processing-reference", value: validated.value.reference, provenanceUrl: canonicalUrl, observedAt: approvedAt }),
        freeze({ attribute: "file-name", value: validated.value.fileName, provenanceUrl: canonicalUrl, observedAt: approvedAt }),
      ]), state: /** @type {const} */ ("active"), approvedAt, updatedAt: approvedAt, revision: 1,
    });
    const event = freeze({ id: this.#id("source-event"), ownerId: source.ownerId, sourceId, kind: /** @type {const} */ ("approved"), sourceRevision: 1, idempotencyKey: validated.value.idempotencyKey, occurredAt: approvedAt });
    return await this.#dependencies.repository.approve({ source, event, job: null, initialItem: null, fingerprint: JSON.stringify(validated.value) });
  }

  /** @param {unknown} command @returns {Promise<Result<LibrarySource, SourceLibraryFailure>>} */
  async disable(command) {
    return await this.#transition(command, "disabled");
  }

  /** @param {unknown} command @returns {Promise<Result<LibrarySource, SourceLibraryFailure>>} */
  async restore(command) {
    return await this.#transition(command, "active");
  }

  /** @param {unknown} command @returns {Promise<Result<{ readonly suppression: SourceSuppression, readonly reused: boolean }, SourceLibraryFailure>>} */
  async reject(command) {
    const validated = validateSuppressionCommand(command);
    if (!validated.ok) return validated;
    const createdAt = this.#dependencies.now();
    if (!isIsoDateTime(createdAt)) {
      throw new TypeError("Source library clock returned an invalid time.");
    }
    const suppression = freeze({
      id: this.#id("source-suppression"),
      ownerId: validated.value.ownerId,
      canonicalIdentity: validated.value.canonicalIdentity,
      identityEvidence: validated.value.identityEvidence,
      idempotencyKey: validated.value.idempotencyKey,
      createdAt,
    });
    return await this.#dependencies.repository.suppress({
      suppression,
      fingerprint: JSON.stringify(validated.value),
    });
  }

  /** @param {unknown} command @param {LibrarySourceState} targetState @returns {Promise<Result<LibrarySource, SourceLibraryFailure>>} */
  async #transition(command, targetState) {
    const validated = validateTransitionCommand(command);
    if (!validated.ok) return validated;
    const occurredAt = this.#dependencies.now();
    if (!isIsoDateTime(occurredAt)) {
      throw new TypeError("Source library clock returned an invalid time.");
    }
    const event = freeze({
      id: this.#id("source-event"),
      ownerId: validated.value.ownerId,
      sourceId: validated.value.sourceId,
      kind: targetState === "disabled"
        ? /** @type {const} */ ("disabled")
        : /** @type {const} */ ("restored"),
      sourceRevision: validated.value.expectedRevision + 1,
      idempotencyKey: validated.value.idempotencyKey,
      occurredAt,
    });
    return await this.#dependencies.repository.transition({
      ...validated.value,
      targetState,
      event,
      fingerprint: transitionFingerprint(validated.value, targetState),
    });
  }

  /** @param {string} prefix */
  #id(prefix) {
    const id = this.#dependencies.createId();
    if (!isNonEmptyText(id)) {
      throw new TypeError(
        "Source library identity generator returned an invalid value.",
      );
    }
    return `${prefix}:${id}`;
  }
}

/** @param {unknown} command @returns {Result<ValidatedApproval, SourceLibraryFailure>} */
export function validateApprovalCommand(command) {
  if (!isRecord(command)) return invalid("body");
  if (command.identityStatus === "missing") {
    return {
      ok: /** @type {const} */ (false),
      error: { kind: /** @type {const} */ ("SourceIdentityMissing") },
    };
  }
  if (command.identityStatus === "ambiguous") {
    return {
      ok: /** @type {const} */ (false),
      error: { kind: /** @type {const} */ ("SourceIdentityAmbiguous") },
    };
  }
  if (command.identityStatus === "conflicting") {
    return {
      ok: /** @type {const} */ (false),
      error: { kind: /** @type {const} */ ("SourceIdentityConflict") },
    };
  }
  if (command.identityStatus !== "resolved") return invalid("identityStatus");
  for (const field of ["ownerId", "title", "description", "idempotencyKey"]) {
    if (!isNonEmptyText(command[field])) return invalid(field);
  }
  if (!isPublicHttpsUrl(command.submittedUrl)) return invalid("submittedUrl");
  if (!isPublicHttpsUrl(command.canonicalUrl)) return invalid("canonicalUrl");
  const adapter = validateAdapter(command.adapter);
  if (!adapter.ok) return adapter;
  if (adapter.value.id === "private-document") return invalid("adapter.id");
  const areas = uniqueText(command.interestAreaIds);
  if (areas === null || areas.length === 0) return invalid("interestAreaIds");
  const evidence = validateIdentityEvidence(command.identityEvidence);
  if (!evidence.ok) return evidence;
  const initialItem = validateInitialItem(command.initialItem);
  if (!initialItem.ok) return initialItem;
  return {
    ok: /** @type {const} */ (true),
    value: freeze({
      ownerId: /** @type {string} */ (command.ownerId).trim(),
      submittedUrl: new URL(/** @type {string} */ (command.submittedUrl)).href,
      canonicalUrl: new URL(/** @type {string} */ (command.canonicalUrl)).href,
      title: /** @type {string} */ (command.title).trim(),
      description: /** @type {string} */ (command.description).trim(),
      idempotencyKey: /** @type {string} */ (command.idempotencyKey).trim(),
      adapter: adapter.value,
      interestAreaIds: freeze(areas),
      identityEvidence: evidence.value,
      initialItem: initialItem.value,
    }),
  };
}

/** @param {unknown} command @returns {Result<{ readonly ownerId: string, readonly title: string, readonly fileName: string, readonly idempotencyKey: string, readonly applicationOrigin: string, readonly basis: string, readonly reference: string }, SourceLibraryFailure>} */
export function validatePrivateDocumentCommand(command) {
  if (!isRecord(command)) return invalid("body");
  for (const field of ["ownerId", "title", "fileName", "idempotencyKey", "applicationOrigin"]) {
    if (!isNonEmptyText(command[field])) return invalid(field);
  }
  if (!isRecord(command.rightsAttestation) || command.rightsAttestation.ownsOrPermitted !== true || command.rightsAttestation.storageAllowed !== true || command.rightsAttestation.transformationAllowed !== true || command.rightsAttestation.processingAllowed !== true || !isNonEmptyText(command.rightsAttestation.basis) || !isNonEmptyText(command.rightsAttestation.reference)) return invalid("rightsAttestation");
  if (!isPublicHttpsUrl(command.applicationOrigin)) return invalid("applicationOrigin");
  return { ok: true, value: freeze({
    ownerId: /** @type {string} */ (command.ownerId).trim(), title: /** @type {string} */ (command.title).trim(), fileName: /** @type {string} */ (command.fileName).trim(),
    idempotencyKey: /** @type {string} */ (command.idempotencyKey).trim(), applicationOrigin: new URL(/** @type {string} */ (command.applicationOrigin)).href,
    basis: command.rightsAttestation.basis.trim(), reference: command.rightsAttestation.reference.trim(),
  }) };
}

/** @param {unknown} value @returns {Result<SourceApprovalInitialItem | null, Extract<SourceLibraryFailure, { readonly kind: "SourceCatalogCommandInvalid" }>>} */
function validateInitialItem(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isRecord(value)) return invalid("initialItem");
  for (const field of ["itemId", "versionId", "title", "description", "contentDigest"]) {
    if (!isNonEmptyText(value[field])) return invalid(`initialItem.${field}`);
  }
  if (!isPublicHttpsUrl(value.canonicalUrl)) return invalid("initialItem.canonicalUrl");
  if (!isIsoDateTime(value.observedAt) || !(value.publishedAt === null || isIsoDateTime(value.publishedAt))) return invalid("initialItem.observedAt");
  if (!Array.isArray(value.provenance) || value.provenance.length === 0) return invalid("initialItem.provenance");
  const provenance = [];
  for (const entry of value.provenance) {
    if (!isRecord(entry) || !isNonEmptyText(entry.method) || !isNonEmptyText(entry.reference)) return invalid("initialItem.provenance");
    provenance.push(freeze({ method: entry.method.trim(), reference: entry.reference.trim() }));
  }
  return { ok: true, value: freeze({
    itemId: /** @type {string} */ (value.itemId).trim(), versionId: /** @type {string} */ (value.versionId).trim(),
    canonicalUrl: new URL(/** @type {string} */ (value.canonicalUrl)).href,
    title: /** @type {string} */ (value.title).trim(), description: /** @type {string} */ (value.description).trim(),
    contentDigest: /** @type {string} */ (value.contentDigest).trim(), provenance: freeze(provenance),
    observedAt: /** @type {string} */ (value.observedAt), publishedAt: /** @type {string | null} */ (value.publishedAt),
  }) };
}

/** @param {unknown} command @returns {Result<ValidatedTransition, Extract<SourceLibraryFailure, { readonly kind: "SourceCatalogCommandInvalid" }>>} */
export function validateTransitionCommand(command) {
  if (!isRecord(command)) return invalid("body");
  for (const field of ["ownerId", "sourceId", "idempotencyKey"]) {
    if (!isNonEmptyText(command[field])) return invalid(field);
  }
  if (
    typeof command.expectedRevision !== "number" ||
    !Number.isInteger(command.expectedRevision) ||
    command.expectedRevision < 1
  ) {
    return invalid("expectedRevision");
  }
  return {
    ok: /** @type {const} */ (true),
    value: freeze({
      ownerId: /** @type {string} */ (command.ownerId).trim(),
      sourceId: /** @type {string} */ (command.sourceId).trim(),
      idempotencyKey: /** @type {string} */ (command.idempotencyKey).trim(),
      expectedRevision: /** @type {number} */ (command.expectedRevision),
    }),
  };
}

/** @param {unknown} command @returns {Result<ValidatedRevision, Extract<SourceLibraryFailure, { readonly kind: "SourceCatalogCommandInvalid" }>>} */
export function validateRevisionCommand(command) {
  const transition = validateTransitionCommand(command);
  if (!transition.ok) return transition;
  if (!isRecord(command)) return invalid("body");
  if (!isNonEmptyText(command.title)) return invalid("title");
  if (!isNonEmptyText(command.description)) return invalid("description");
  const interestAreaIds = uniqueText(command.interestAreaIds);
  if (interestAreaIds === null || interestAreaIds.length === 0) {
    return invalid("interestAreaIds");
  }
  return {
    ok: /** @type {const} */ (true),
    value: freeze({
      ...transition.value,
      title: command.title.trim(),
      description: command.description.trim(),
      interestAreaIds: freeze(interestAreaIds),
    }),
  };
}

/** @param {unknown} command @returns {Result<{ readonly ownerId: string, readonly canonicalIdentity: string, readonly identityEvidence: readonly SourceIdentityEvidence[], readonly idempotencyKey: string }, SourceLibraryFailure>} */
export function validateSuppressionCommand(command) {
  if (!isRecord(command)) return invalid("body");
  for (const field of ["ownerId", "canonicalIdentity", "idempotencyKey"]) {
    if (!isNonEmptyText(command[field])) return invalid(field);
  }
  const evidence = validateIdentityEvidence(command.identityEvidence);
  if (!evidence.ok) return evidence;
  return {
    ok: /** @type {const} */ (true),
    value: freeze({
      ownerId: /** @type {string} */ (command.ownerId).trim(),
      canonicalIdentity: /** @type {string} */ (command.canonicalIdentity)
        .trim(),
      identityEvidence: evidence.value,
      idempotencyKey: /** @type {string} */ (command.idempotencyKey).trim(),
    }),
  };
}

/** @param {unknown} value @returns {Result<SourceAdapterContract, Extract<SourceLibraryFailure, { readonly kind: "SourceCatalogCommandInvalid" }>>} */
function validateAdapter(value) {
  if (!isRecord(value)) return invalid("adapter");
  for (const field of ["id", "version", "granularity"]) {
    if (!isNonEmptyText(value[field])) return invalid(`adapter.${field}`);
  }
  const capabilities = uniqueText(value.capabilities);
  if (capabilities === null || capabilities.length === 0) {
    return invalid("adapter.capabilities");
  }
  return {
    ok: /** @type {const} */ (true),
    value: freeze({
      id: /** @type {string} */ (value.id).trim(),
      version: /** @type {string} */ (value.version).trim(),
      granularity: /** @type {string} */ (value.granularity).trim(),
      capabilities: freeze(capabilities),
    }),
  };
}

/** @param {unknown} value @returns {Result<readonly SourceIdentityEvidence[], SourceLibraryFailure>} */
function validateIdentityEvidence(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: /** @type {const} */ (false),
      error: { kind: /** @type {const} */ ("SourceIdentityMissing") },
    };
  }
  /** @type {SourceIdentityEvidence[]} */
  const evidence = [];
  for (const item of value) {
    if (!isRecord(item)) return invalid("identityEvidence");
    if (!isNonEmptyText(item.attribute) || !isNonEmptyText(item.value)) {
      return invalid("identityEvidence");
    }
    if (
      !isPublicHttpsUrl(item.provenanceUrl) || !isIsoDateTime(item.observedAt)
    ) {
      return invalid("identityEvidence");
    }
    evidence.push(freeze({
      attribute: item.attribute.trim(),
      value: item.value.trim(),
      provenanceUrl: new URL(item.provenanceUrl).href,
      observedAt: item.observedAt,
    }));
  }
  return { ok: /** @type {const} */ (true), value: freeze(evidence) };
}

/** @param {unknown} value */
function uniqueText(value) {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyText(item))) {
    return null;
  }
  const normalized = value.map((item) => /** @type {string} */ (item).trim());
  return new Set(normalized).size === normalized.length ? normalized : null;
}

/** @param {ValidatedApproval} value */
function approvalFingerprint(value) {
  return JSON.stringify(value);
}

/** @param {{ readonly ownerId: string, readonly sourceId: string, readonly expectedRevision: number, readonly idempotencyKey: string }} value @param {LibrarySourceState} targetState */
function transitionFingerprint(value, targetState) {
  return JSON.stringify({ ...value, targetState });
}

/** @param {ValidatedRevision} value */
function revisionFingerprint(value) {
  return JSON.stringify(value);
}

/** @param {string} field @returns {Result<never, Extract<SourceLibraryFailure, { readonly kind: "SourceCatalogCommandInvalid" }>>} */
function invalid(field) {
  return {
    ok: false,
    error: {
      kind: /** @type {const} */ ("SourceCatalogCommandInvalid"),
      field,
    },
  };
}

export {};
