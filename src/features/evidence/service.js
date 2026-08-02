// @ts-check

const freeze = Object.freeze;

import {
  contentFormMatchesSource,
  isEvidenceContentForm,
  isEvidenceSourceKind,
  isNonEmptyText,
  isRecord,
} from "./contracts.js";

/** @import { ActiveEvidenceContent, EvidenceAnchor, EvidenceAttribution, EvidenceContentForm, EvidenceContentRecord, EvidenceFailure, EvidenceProvenance, EvidenceRetention, EvidenceRightsBasis, EvidenceSourceKind, EvidenceStatus, Result } from "./contracts.js" */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly evidenceId: string,
 *   readonly contentVersion: number,
 *   readonly sourceKind: EvidenceSourceKind,
 *   readonly contentForm: EvidenceContentForm,
 *   readonly content: string,
 *   readonly anchors: readonly EvidenceAnchor[],
 *   readonly attribution: EvidenceAttribution | null,
 *   readonly rights: EvidenceRightsBasis,
 *   readonly provenance: readonly EvidenceProvenance[],
 *   readonly occurredAt: string,
 *   readonly idempotencyKey: string
 * }} ParsedActiveCommand
 */

/** @typedef {ParsedActiveCommand & { readonly expectedVersion: number }} ParsedReplaceCommand */

/** @typedef {{ readonly maximumContentCharacters: number, readonly maximumAnchors: number, readonly maximumProvenanceEntries: number }} EvidenceContentLimits */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly evidenceId: string,
 *   readonly contentVersion: number,
 *   readonly expectedVersion: number,
 *   readonly reason: string,
 *   readonly occurredAt: string,
 *   readonly idempotencyKey: string
 * }} ParsedStatusCommand
 */

export class EvidenceContentRepository {
  /** @type {Map<string, readonly EvidenceContentRecord[]>} */
  #histories = new Map();
  /** @type {Map<string, EvidenceContentRecord>} */
  #commands = new Map();

  /**
   * @param {EvidenceContentRecord} record
   * @returns {Result<EvidenceContentRecord, EvidenceFailure>}
   */
  appendCreate(record) {
    const replay = this.#replay(record);
    if (!replay.ok) return replay;
    if (replay.value !== null) return { ok: true, value: replay.value };
    const key = ownerKey(record.ownerId, record.evidenceId);
    if (this.#histories.has(key)) {
      return conflict(record.evidenceId, "evidenceId");
    }
    const frozen = freezeRecord(record);
    this.#histories.set(key, freeze([frozen]));
    this.#commands.set(ownerKey(record.ownerId, record.idempotencyKey), frozen);
    return { ok: true, value: frozen };
  }

  /**
   * @param {EvidenceContentRecord} record
   * @param {number} expectedVersion
   * @returns {Result<EvidenceContentRecord, EvidenceFailure>}
   */
  appendTransition(record, expectedVersion) {
    const replay = this.#replay(record);
    if (!replay.ok) return replay;
    if (replay.value !== null) return { ok: true, value: replay.value };
    const latest = this.latest(record.ownerId, record.evidenceId);
    if (!latest.ok) return latest;
    if (latest.value.contentVersion !== expectedVersion) {
      return {
        ok: false,
        error: {
          kind: "EvidenceVersionStale",
          evidenceId: record.evidenceId,
          expected: expectedVersion,
          actual: latest.value.contentVersion,
        },
      };
    }
    if (record.contentVersion !== expectedVersion + 1) {
      return conflict(record.evidenceId, "contentVersion");
    }
    if (
      record.sourceKind !== latest.value.sourceKind ||
      record.contentForm !== latest.value.contentForm ||
      record.retention !== latest.value.retention
    ) {
      return conflict(record.evidenceId, "sourceKind");
    }
    if (latest.value.status === "deleted") {
      return conflict(record.evidenceId, "status");
    }
    if (record.status === "active" && latest.value.status !== "active") {
      return conflict(record.evidenceId, "status");
    }
    if (record.status === "revoked" && latest.value.status !== "active") {
      return conflict(record.evidenceId, "status");
    }
    const key = ownerKey(record.ownerId, record.evidenceId);
    const history = this.#histories.get(key);
    if (!history) return missing(record.evidenceId);
    const frozen = freezeRecord(record);
    this.#histories.set(key, freeze([...history, frozen]));
    this.#commands.set(ownerKey(record.ownerId, record.idempotencyKey), frozen);
    return { ok: true, value: frozen };
  }

  /**
   * @param {string} ownerId
   * @param {string} evidenceId
   * @returns {Result<EvidenceContentRecord, EvidenceFailure>}
   */
  latest(ownerId, evidenceId) {
    const history = this.#histories.get(ownerKey(ownerId, evidenceId));
    if (history && history.length > 0) {
      return { ok: true, value: history[history.length - 1] };
    }
    const candidates = [...this.#histories.values()].filter((entries) =>
      entries.length > 0 && entries[0].evidenceId === evidenceId
    );
    if (candidates.length > 1) {
      return {
        ok: false,
        error: { kind: "EvidenceContentAmbiguous", evidenceId },
      };
    }
    if (candidates.length === 1) {
      return {
        ok: false,
        error: { kind: "EvidenceOwnerMismatch", ownerId, evidenceId },
      };
    }
    return missing(evidenceId);
  }

  /**
   * @param {string} ownerId
   * @param {string} evidenceId
   * @returns {Result<readonly EvidenceContentRecord[], EvidenceFailure>}
   */
  history(ownerId, evidenceId) {
    const latest = this.latest(ownerId, evidenceId);
    if (!latest.ok) return latest;
    const entries = this.#histories.get(ownerKey(ownerId, evidenceId));
    if (!entries) return missing(evidenceId);
    return { ok: true, value: freeze([...entries]) };
  }

  /** @param {string} ownerId @param {string} idempotencyKey @returns {EvidenceContentRecord | null} */
  command(ownerId, idempotencyKey) {
    return this.#commands.get(ownerKey(ownerId, idempotencyKey)) ?? null;
  }

  /**
   * @param {EvidenceContentRecord} candidate
   * @returns {Result<EvidenceContentRecord | null, EvidenceFailure>}
   */
  #replay(candidate) {
    const existing = this.#commands.get(
      ownerKey(candidate.ownerId, candidate.idempotencyKey),
    );
    if (!existing) return { ok: true, value: null };
    return sameSemantics(existing, candidate)
      ? { ok: true, value: existing }
      : conflict(candidate.evidenceId, "idempotencyKey");
  }
}

/**
 * Decodes one persisted immutable record before it is replayed into a fresh repository.
 *
 * @param {unknown} value
 * @param {EvidenceContentLimits} limits
 * @returns {Result<EvidenceContentRecord, EvidenceFailure>}
 */
export function decodeEvidenceContentRecord(value, limits) {
  if (
    !limits || !positiveInteger(limits.maximumContentCharacters) ||
    !positiveInteger(limits.maximumAnchors) ||
    !positiveInteger(limits.maximumProvenanceEntries)
  ) {
    throw new TypeError(
      "Evidence record decoding requires positive explicit limits.",
    );
  }
  if (!isRecord(value)) return invalid("record");
  const recordId = text(value, "recordId");
  if (!recordId.ok) return recordId;
  if (value.status === "active") {
    const parsed = parseActiveCommand(value, limits);
    if (!parsed.ok) return parsed;
    const expectedRetention = parsed.value.sourceKind === "learner-notes"
      ? "private-local"
      : "rights-cleared";
    if (value.retention !== expectedRetention) {
      return conflict(parsed.value.evidenceId, "retention");
    }
    if (value.reason !== null) {
      return conflict(parsed.value.evidenceId, "reason");
    }
    const expectedReplaced = parsed.value.contentVersion === 1
      ? null
      : parsed.value.contentVersion - 1;
    if (value.replacesVersion !== expectedReplaced) {
      return conflict(parsed.value.evidenceId, "replacesVersion");
    }
    return {
      ok: true,
      value: makeActive(recordId.value, parsed.value, expectedReplaced),
    };
  }
  if (value.status !== "revoked" && value.status !== "deleted") {
    return invalid("status");
  }
  if (
    !isEvidenceSourceKind(value.sourceKind) ||
    !isEvidenceContentForm(value.contentForm) ||
    !contentFormMatchesSource(value.sourceKind, value.contentForm)
  ) return invalid("sourceKind");
  const expectedRetention = value.sourceKind === "learner-notes"
    ? "private-local"
    : "rights-cleared";
  if (value.retention !== expectedRetention) {
    return conflict(
      isNonEmptyText(value.evidenceId) ? value.evidenceId : "",
      "retention",
    );
  }
  if (
    value.content !== null || value.attribution !== null ||
    value.rights !== null ||
    !Array.isArray(value.anchors) || value.anchors.length !== 0 ||
    !Array.isArray(value.provenance) || value.provenance.length !== 0
  ) {
    return conflict(
      isNonEmptyText(value.evidenceId) ? value.evidenceId : "",
      "tombstone",
    );
  }
  const parsed = parseStatusCommand({
    ...value,
    expectedVersion: value.replacesVersion,
  });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: freeze({
      recordId: recordId.value,
      ownerId: parsed.value.ownerId,
      evidenceId: parsed.value.evidenceId,
      contentVersion: parsed.value.contentVersion,
      sourceKind: value.sourceKind,
      contentForm: value.contentForm,
      retention: expectedRetention,
      status: value.status,
      content: null,
      anchors: freeze(/** @type {const} */ ([])),
      attribution: null,
      rights: null,
      provenance: freeze(/** @type {const} */ ([])),
      reason: parsed.value.reason,
      replacesVersion: parsed.value.expectedVersion,
      occurredAt: parsed.value.occurredAt,
      idempotencyKey: parsed.value.idempotencyKey,
    }),
  };
}

export class EvidenceContentService {
  /** @type {EvidenceContentRepository} */
  #repository;
  /** @type {() => string} */
  #createId;
  /** @type {() => string} */
  #now;
  /** @type {number} */
  #maximumContentCharacters;
  /** @type {number} */
  #maximumAnchors;
  /** @type {number} */
  #maximumProvenanceEntries;

  /**
   * @param {{
   *   readonly repository: EvidenceContentRepository,
   *   readonly createId: () => string,
   *   readonly now: () => string,
   *   readonly maximumContentCharacters: number,
   *   readonly maximumAnchors: number,
   *   readonly maximumProvenanceEntries: number
   * }} dependencies
   */
  constructor(dependencies) {
    if (
      !dependencies ||
      !(dependencies.repository instanceof EvidenceContentRepository) ||
      typeof dependencies.createId !== "function" ||
      typeof dependencies.now !== "function" ||
      !positiveInteger(dependencies.maximumContentCharacters) ||
      !positiveInteger(dependencies.maximumAnchors) ||
      !positiveInteger(dependencies.maximumProvenanceEntries)
    ) {
      throw new TypeError(
        "EvidenceContentService requires explicit repository, ID, clock, and positive limits.",
      );
    }
    this.#repository = dependencies.repository;
    this.#createId = dependencies.createId;
    this.#now = dependencies.now;
    this.#maximumContentCharacters = dependencies.maximumContentCharacters;
    this.#maximumAnchors = dependencies.maximumAnchors;
    this.#maximumProvenanceEntries = dependencies.maximumProvenanceEntries;
  }

  /** @param {unknown} command @returns {Result<ActiveEvidenceContent, EvidenceFailure>} */
  create(command) {
    const parsed = parseActiveCommand(command, {
      maximumContentCharacters: this.#maximumContentCharacters,
      maximumAnchors: this.#maximumAnchors,
      maximumProvenanceEntries: this.#maximumProvenanceEntries,
    });
    if (!parsed.ok) return parsed;
    if (parsed.value.contentVersion !== 1) return invalid("contentVersion");
    const current = this.#currentInstant();
    if (!current.ok) return current;
    const expiry = validateExpiry(
      parsed.value.evidenceId,
      parsed.value.rights.expiresAt,
      current.value,
    );
    if (!expiry.ok) return expiry;
    const id = this.#nextId("create");
    if (!id.ok) return id;
    return narrowActive(
      this.#repository.appendCreate(makeActive(id.value, parsed.value, null)),
    );
  }

  /** @param {unknown} command @returns {Result<ActiveEvidenceContent, EvidenceFailure>} */
  replace(command) {
    const parsed = parseReplaceCommand(command, {
      maximumContentCharacters: this.#maximumContentCharacters,
      maximumAnchors: this.#maximumAnchors,
      maximumProvenanceEntries: this.#maximumProvenanceEntries,
    });
    if (!parsed.ok) return parsed;
    const current = this.#currentInstant();
    if (!current.ok) return current;
    const expiry = validateExpiry(
      parsed.value.evidenceId,
      parsed.value.rights.expiresAt,
      current.value,
    );
    if (!expiry.ok) return expiry;
    const id = this.#nextId("replace");
    if (!id.ok) return id;
    return narrowActive(this.#repository.appendTransition(
      makeActive(id.value, parsed.value, parsed.value.expectedVersion),
      parsed.value.expectedVersion,
    ));
  }

  /** @param {unknown} command @returns {Result<EvidenceContentRecord, EvidenceFailure>} */
  revoke(command) {
    return this.#changeStatus(command, "revoked");
  }

  /** @param {unknown} command @returns {Result<EvidenceContentRecord, EvidenceFailure>} */
  delete(command) {
    return this.#changeStatus(command, "deleted");
  }

  /**
   * @param {unknown} command
   * @param {"revoked" | "deleted"} status
   * @returns {Result<EvidenceContentRecord, EvidenceFailure>}
   */
  #changeStatus(command, status) {
    const parsed = parseStatusCommand(command);
    if (!parsed.ok) return parsed;
    const replay = this.#repository.command(
      parsed.value.ownerId,
      parsed.value.idempotencyKey,
    );
    if (replay) {
      return replay.evidenceId === parsed.value.evidenceId &&
          replay.status === status &&
          replay.contentVersion === parsed.value.contentVersion &&
          replay.replacesVersion === parsed.value.expectedVersion &&
          replay.reason === parsed.value.reason &&
          replay.occurredAt === parsed.value.occurredAt
        ? { ok: true, value: replay }
        : conflict(parsed.value.evidenceId, "idempotencyKey");
    }
    const latest = this.#repository.latest(
      parsed.value.ownerId,
      parsed.value.evidenceId,
    );
    if (!latest.ok) return latest;
    if (latest.value.contentVersion !== parsed.value.expectedVersion) {
      return stale(
        parsed.value.evidenceId,
        parsed.value.expectedVersion,
        latest.value.contentVersion,
      );
    }
    const id = this.#nextId(status);
    if (!id.ok) return id;
    return this.#repository.appendTransition(
      freeze({
        recordId: id.value,
        ownerId: parsed.value.ownerId,
        evidenceId: parsed.value.evidenceId,
        contentVersion: parsed.value.contentVersion,
        sourceKind: latest.value.sourceKind,
        contentForm: latest.value.contentForm,
        retention: latest.value.retention,
        status,
        content: null,
        anchors: freeze(/** @type {const} */ ([])),
        attribution: null,
        rights: null,
        provenance: freeze(/** @type {const} */ ([])),
        reason: parsed.value.reason,
        replacesVersion: parsed.value.expectedVersion,
        occurredAt: parsed.value.occurredAt,
        idempotencyKey: parsed.value.idempotencyKey,
      }),
      parsed.value.expectedVersion,
    );
  }

  /** @param {string} operation @returns {Result<string, EvidenceFailure>} */
  #nextId(operation) {
    const value = this.#createId();
    return isNonEmptyText(value)
      ? { ok: true, value }
      : { ok: false, error: { kind: "EvidenceIdFactoryInvalid", operation } };
  }

  /** @returns {Result<string, EvidenceFailure>} */
  #currentInstant() {
    const value = this.#now();
    return validInstant(value) ? { ok: true, value } : invalid("clock.now");
  }
}

/**
 * @param {unknown} command
 * @param {EvidenceContentLimits} limits
 * @returns {Result<ParsedActiveCommand, EvidenceFailure>}
 */
function parseActiveCommand(command, limits) {
  if (!isRecord(command)) return invalid("command");
  const ownerId = text(command, "ownerId");
  const evidenceId = text(command, "evidenceId");
  const contentVersion = integer(command, "contentVersion");
  const occurredAt = instant(command, "occurredAt");
  const idempotencyKey = text(command, "idempotencyKey");
  if (!ownerId.ok) return ownerId;
  if (!evidenceId.ok) return evidenceId;
  if (!contentVersion.ok) return contentVersion;
  if (!occurredAt.ok) return occurredAt;
  if (!idempotencyKey.ok) return idempotencyKey;
  if (!isEvidenceSourceKind(command.sourceKind)) {
    return {
      ok: false,
      error: {
        kind: "EvidenceSourceKindUnknown",
        sourceKind: typeof command.sourceKind === "string"
          ? command.sourceKind
          : "",
      },
    };
  }
  if (!isEvidenceContentForm(command.contentForm)) {
    return invalid("contentForm");
  }
  if (!contentFormMatchesSource(command.sourceKind, command.contentForm)) {
    return invalid("contentForm");
  }
  if (
    !isNonEmptyText(command.content) ||
    command.content.length > limits.maximumContentCharacters
  ) {
    return invalid("content");
  }
  const anchors = parseAnchors(command.anchors, limits.maximumAnchors);
  if (!anchors.ok) return anchors;
  const attribution = parseAttribution(
    command.attribution,
    evidenceId.value,
    command.sourceKind,
  );
  if (!attribution.ok) return attribution;
  const rights = parseRights(command.rights);
  if (!rights.ok) return rights;
  const provenance = parseProvenance(
    command.provenance,
    limits.maximumProvenanceEntries,
  );
  if (!provenance.ok) return provenance;
  return {
    ok: true,
    value: freeze({
      ownerId: ownerId.value,
      evidenceId: evidenceId.value,
      contentVersion: contentVersion.value,
      sourceKind: command.sourceKind,
      contentForm: command.contentForm,
      content: command.content,
      anchors: anchors.value,
      attribution: attribution.value,
      rights: rights.value,
      provenance: provenance.value,
      occurredAt: occurredAt.value,
      idempotencyKey: idempotencyKey.value,
    }),
  };
}

/**
 * @param {unknown} command
 * @param {EvidenceContentLimits} limits
 * @returns {Result<ParsedReplaceCommand, EvidenceFailure>}
 */
function parseReplaceCommand(command, limits) {
  const active = parseActiveCommand(command, limits);
  if (!active.ok) return active;
  if (!isRecord(command)) return invalid("command");
  const expectedVersion = integer(command, "expectedVersion");
  if (!expectedVersion.ok) return expectedVersion;
  if (active.value.contentVersion !== expectedVersion.value + 1) {
    return invalid("contentVersion");
  }
  return {
    ok: true,
    value: freeze({
      ...active.value,
      expectedVersion: expectedVersion.value,
    }),
  };
}

/** @param {unknown} command @returns {Result<ParsedStatusCommand, EvidenceFailure>} */
function parseStatusCommand(command) {
  if (!isRecord(command)) return invalid("command");
  const ownerId = text(command, "ownerId");
  const evidenceId = text(command, "evidenceId");
  const contentVersion = integer(command, "contentVersion");
  const expectedVersion = integer(command, "expectedVersion");
  const reason = text(command, "reason");
  const occurredAt = instant(command, "occurredAt");
  const idempotencyKey = text(command, "idempotencyKey");
  if (!ownerId.ok) return ownerId;
  if (!evidenceId.ok) return evidenceId;
  if (!contentVersion.ok) return contentVersion;
  if (!expectedVersion.ok) return expectedVersion;
  if (!reason.ok) return reason;
  if (!occurredAt.ok) return occurredAt;
  if (!idempotencyKey.ok) return idempotencyKey;
  if (contentVersion.value !== expectedVersion.value + 1) {
    return invalid("contentVersion");
  }
  return {
    ok: true,
    value: freeze({
      ownerId: ownerId.value,
      evidenceId: evidenceId.value,
      contentVersion: contentVersion.value,
      expectedVersion: expectedVersion.value,
      reason: reason.value,
      occurredAt: occurredAt.value,
      idempotencyKey: idempotencyKey.value,
    }),
  };
}

/** @param {unknown} value @param {number} maximum @returns {Result<readonly EvidenceAnchor[], EvidenceFailure>} */
function parseAnchors(value, maximum) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    return invalid("anchors");
  }
  /** @type {EvidenceAnchor[]} */
  const anchors = [];
  const identities = new Set();
  for (const candidate of value) {
    if (
      !isRecord(candidate) || !isNonEmptyText(candidate.kind) ||
      !isNonEmptyText(candidate.value)
    ) {
      return invalid("anchors");
    }
    const identity = `${candidate.kind}\u0000${candidate.value}`;
    if (identities.has(identity)) return conflict("", "anchors");
    identities.add(identity);
    anchors.push(
      freeze({ kind: candidate.kind, value: candidate.value }),
    );
  }
  return { ok: true, value: freeze(anchors) };
}

/**
 * @param {unknown} value
 * @param {string} evidenceId
 * @param {EvidenceSourceKind} sourceKind
 * @returns {Result<EvidenceAttribution | null, EvidenceFailure>}
 */
function parseAttribution(value, evidenceId, sourceKind) {
  if (Array.isArray(value)) {
    return {
      ok: false,
      error: { kind: "EvidenceAttributionAmbiguous", evidenceId },
    };
  }
  if (value === null || value === undefined) {
    return sourceKind === "publisher-transcript"
      ? { ok: false, error: { kind: "EvidenceAttributionMissing", evidenceId } }
      : { ok: true, value: null };
  }
  if (
    !isRecord(value) || !isNonEmptyText(value.label) ||
    !validHttpsUrl(value.sourceUrl)
  ) {
    return invalid("attribution");
  }
  return {
    ok: true,
    value: freeze({
      label: value.label,
      sourceUrl: /** @type {string} */ (value.sourceUrl),
    }),
  };
}

/** @param {unknown} value @returns {Result<EvidenceRightsBasis, EvidenceFailure>} */
function parseRights(value) {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: { kind: "EvidenceRightsMissing", field: "rights" },
    };
  }
  for (const field of ["basis", "reference", "assessedAt"]) {
    if (!isNonEmptyText(value[field])) {
      return {
        ok: false,
        error: { kind: "EvidenceRightsMissing", field: `rights.${field}` },
      };
    }
  }
  if (!validInstant(value.assessedAt)) return invalid("rights.assessedAt");
  if (value.expiresAt !== null && !validInstant(value.expiresAt)) {
    return invalid("rights.expiresAt");
  }
  for (
    const field of ["storageAllowed", "displayAllowed", "transformationAllowed"]
  ) {
    if (value[field] !== true) {
      return {
        ok: false,
        error: { kind: "EvidenceRightsNotPermitted", field: `rights.${field}` },
      };
    }
  }
  return {
    ok: true,
    value: freeze({
      basis: /** @type {string} */ (value.basis),
      reference: /** @type {string} */ (value.reference),
      assessedAt: /** @type {string} */ (value.assessedAt),
      expiresAt: /** @type {string | null} */ (value.expiresAt),
      storageAllowed: true,
      displayAllowed: true,
      transformationAllowed: true,
    }),
  };
}

/** @param {unknown} value @param {number} maximum @returns {Result<readonly EvidenceProvenance[], EvidenceFailure>} */
function parseProvenance(value, maximum) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    return {
      ok: false,
      error: { kind: "EvidenceProvenanceInvalid", field: "provenance" },
    };
  }
  /** @type {EvidenceProvenance[]} */
  const entries = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      return {
        ok: false,
        error: { kind: "EvidenceProvenanceInvalid", field: "provenance" },
      };
    }
    for (const field of ["method", "sourceReference", "acquiredAt", "digest"]) {
      if (!isNonEmptyText(candidate[field])) {
        return {
          ok: false,
          error: {
            kind: "EvidenceProvenanceInvalid",
            field: `provenance.${field}`,
          },
        };
      }
    }
    if (!validInstant(candidate.acquiredAt)) {
      return {
        ok: false,
        error: {
          kind: "EvidenceProvenanceInvalid",
          field: "provenance.acquiredAt",
        },
      };
    }
    entries.push(freeze({
      method: /** @type {string} */ (candidate.method),
      sourceReference: /** @type {string} */ (candidate.sourceReference),
      acquiredAt: /** @type {string} */ (candidate.acquiredAt),
      digest: /** @type {string} */ (candidate.digest),
    }));
  }
  return { ok: true, value: freeze(entries) };
}

/** @param {string} recordId @param {ParsedActiveCommand} input @param {number | null} replacesVersion @returns {ActiveEvidenceContent} */
function makeActive(recordId, input, replacesVersion) {
  /** @type {EvidenceRetention} */
  const retention = input.sourceKind === "learner-notes"
    ? "private-local"
    : "rights-cleared";
  return freeze({
    recordId,
    ownerId: input.ownerId,
    evidenceId: input.evidenceId,
    contentVersion: input.contentVersion,
    sourceKind: input.sourceKind,
    contentForm: input.contentForm,
    retention,
    status: "active",
    content: input.content,
    anchors: input.anchors,
    attribution: input.attribution,
    rights: input.rights,
    provenance: input.provenance,
    reason: null,
    replacesVersion,
    occurredAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey,
  });
}

/** @param {EvidenceContentRecord} record @returns {EvidenceContentRecord} */
function freezeRecord(record) {
  if (record.status !== "active") {
    return freeze({
      ...record,
      anchors: freeze(/** @type {const} */ ([])),
      provenance: freeze(/** @type {const} */ ([])),
    });
  }
  return freeze({
    ...record,
    anchors: freeze(
      record.anchors.map((anchor) => freeze({ ...anchor })),
    ),
    attribution: record.attribution
      ? freeze({ ...record.attribution })
      : null,
    rights: freeze({ ...record.rights }),
    provenance: freeze(
      record.provenance.map((entry) => freeze({ ...entry })),
    ),
  });
}

/** @param {EvidenceContentRecord} left @param {EvidenceContentRecord} right */
function sameSemantics(left, right) {
  const { recordId: leftId, ...leftValue } = left;
  const { recordId: rightId, ...rightValue } = right;
  void leftId;
  void rightId;
  return JSON.stringify(leftValue) === JSON.stringify(rightValue);
}

/** @param {Result<EvidenceContentRecord, EvidenceFailure>} result @returns {Result<ActiveEvidenceContent, EvidenceFailure>} */
function narrowActive(result) {
  if (!result.ok) return result;
  return result.value.status === "active"
    ? { ok: true, value: result.value }
    : conflict(result.value.evidenceId, "status");
}

/** @param {string} evidenceId @param {string | null} expiresAt @param {string} current */
function validateExpiry(evidenceId, expiresAt, current) {
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(current)) {
    return /** @type {const} */ ({
      ok: false,
      error: { kind: "EvidenceRightsExpired", evidenceId, expiresAt },
    });
  }
  return /** @type {const} */ ({ ok: true, value: null });
}

/** @param {Record<string, unknown>} value @param {string} field @returns {Result<string, EvidenceFailure>} */
function text(value, field) {
  return isNonEmptyText(value[field])
    ? { ok: true, value: value[field] }
    : invalid(field);
}

/** @param {Record<string, unknown>} value @param {string} field @returns {Result<number, EvidenceFailure>} */
function integer(value, field) {
  const candidate = value[field];
  return positiveInteger(candidate)
    ? { ok: true, value: candidate }
    : invalid(field);
}

/** @param {Record<string, unknown>} value @param {string} field @returns {Result<string, EvidenceFailure>} */
function instant(value, field) {
  const candidate = value[field];
  return validInstant(candidate)
    ? { ok: true, value: candidate }
    : invalid(field);
}

/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @param {unknown} value @returns {value is string} */
function validInstant(value) {
  return typeof value === "string" && value.trim() !== "" &&
    Number.isFinite(Date.parse(value));
}

/** @param {unknown} value */
function validHttpsUrl(value) {
  return typeof value === "string" && URL.canParse(value) &&
    new URL(value).protocol === "https:";
}

/** @param {string} ownerId @param {string} value */
function ownerKey(ownerId, value) {
  return `${ownerId.length}:${ownerId}${value}`;
}

/** @param {string} field @returns {Result<never, EvidenceFailure>} */
function invalid(field) {
  return { ok: false, error: { kind: "EvidenceCommandInvalid", field } };
}

/** @param {string} evidenceId @returns {Result<never, EvidenceFailure>} */
function missing(evidenceId) {
  return { ok: false, error: { kind: "EvidenceContentMissing", evidenceId } };
}

/** @param {string} evidenceId @param {string} field @returns {Result<never, EvidenceFailure>} */
function conflict(evidenceId, field) {
  return { ok: false, error: { kind: "EvidenceConflict", evidenceId, field } };
}

/** @param {string} evidenceId @param {number} expected @param {number} actual @returns {Result<never, EvidenceFailure>} */
function stale(evidenceId, expected, actual) {
  return {
    ok: false,
    error: { kind: "EvidenceVersionStale", evidenceId, expected, actual },
  };
}
