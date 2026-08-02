// @ts-check

const freeze = Object.freeze;

/** @import { DiscoveryEvidenceAssociation, DiscoveryFailure, DiscoveryImportResult, DiscoverySourceRegistration, DiscoveryTriageDecision, DiscoveredItemVersion, Result, RightsAssessment } from "./contracts.js" */

export class DiscoveryRepository {
  /** @type {Map<string, readonly DiscoverySourceRegistration[]>} */
  #sources = new Map();
  /** @type {Map<string, DiscoverySourceRegistration>} */
  #sourceCommands = new Map();
  /** @type {Map<string, string>} */
  #sourceIdentity = new Map();
  /** @type {Map<string, readonly DiscoveredItemVersion[]>} */
  #items = new Map();
  /** @type {Map<string, string>} */
  #itemIdentity = new Map();
  /** @type {Map<string, DiscoveryImportResult>} */
  #imports = new Map();
  /** @type {RightsAssessment[]} */
  #rights = [];
  /** @type {DiscoveryTriageDecision[]} */
  #triage = [];
  /** @type {DiscoveryEvidenceAssociation[]} */
  #associations = [];
  /** @type {Map<string, number>} */
  #ownerRevisions = new Map();

  /**
   * @param {DiscoverySourceRegistration} registration
   * @returns {Result<DiscoverySourceRegistration, DiscoveryFailure>}
   */
  registerSource(registration) {
    const identityKey = ownerKey(registration.ownerId, registration.authoritativeIdentity);
    const sourceKey = ownerKey(registration.ownerId, registration.sourceId);
    const commandKey = ownerKey(registration.ownerId, registration.idempotencyKey);
    if (
      this.#sourceIdentity.has(identityKey) || this.#sources.has(sourceKey) ||
      this.#sourceCommands.has(commandKey)
    ) {
      return {
        ok: false,
        error: {
          kind: "DiscoverySourceDuplicate",
          authoritativeIdentity: registration.authoritativeIdentity,
        },
      };
    }
    const frozen = freezeSource(registration);
    this.#sources.set(sourceKey, freeze([frozen]));
    this.#sourceIdentity.set(identityKey, registration.sourceId);
    this.#sourceCommands.set(commandKey, frozen);
    this.#advance(registration.ownerId);
    return { ok: true, value: frozen };
  }

  /**
   * @param {DiscoverySourceRegistration} registration
   * @param {number} expectedRevision
   * @returns {Result<DiscoverySourceRegistration, DiscoveryFailure>}
   */
  reviseSource(registration, expectedRevision) {
    const commandKey = ownerKey(registration.ownerId, registration.idempotencyKey);
    const replay = this.#sourceCommands.get(commandKey);
    if (replay) {
      return replay.sourceId === registration.sourceId && replay.state === registration.state
        ? { ok: true, value: replay }
        : { ok: false, error: { kind: "DiscoveryVersionConflict", itemId: registration.sourceId } };
    }
    const found = this.getSource(registration.ownerId, registration.sourceId);
    if (!found.ok) return found;
    if (found.value.revision !== expectedRevision) {
      return {
        ok: false,
        error: {
          kind: "DiscoveryVersionConflict",
          itemId: registration.sourceId,
        },
      };
    }
    const sourceKey = ownerKey(registration.ownerId, registration.sourceId);
    const revisions = this.#sources.get(sourceKey);
    if (!revisions) {
      return { ok: false, error: { kind: "DiscoveryBatchPersistenceFailed", operation: "revise-source" } };
    }
    const frozen = freezeSource(registration);
    this.#sources.set(sourceKey, freeze([...revisions, frozen]));
    this.#sourceCommands.set(commandKey, frozen);
    this.#advance(registration.ownerId);
    return { ok: true, value: frozen };
  }

  /**
   * @param {string} ownerId
   * @param {string} sourceId
   * @returns {Result<DiscoverySourceRegistration, DiscoveryFailure>}
   */
  getSource(ownerId, sourceId) {
    const revisions = this.#sources.get(ownerKey(ownerId, sourceId));
    if (!revisions || revisions.length === 0) {
      const belongsToAnotherOwner = [...this.#sources.values()].some((entries) =>
        entries.length > 0 && entries[entries.length - 1].sourceId === sourceId
      );
      if (belongsToAnotherOwner) {
        return { ok: false, error: { kind: "DiscoverySourceOwnerMismatch", ownerId } };
      }
      return {
        ok: false,
        error: { kind: "DiscoveryCommandInvalid", field: "sourceId" },
      };
    }
    const latest = revisions[revisions.length - 1];
    return { ok: true, value: latest };
  }

  /**
   * @param {string} ownerId
   * @param {string} sourceId
   * @param {string} authoritativeIdentity
   * @returns {DiscoveredItemVersion | null}
   */
  latestByIdentity(ownerId, sourceId, authoritativeIdentity) {
    const itemId = this.#itemIdentity.get(ownerKey(ownerId, sourceId, authoritativeIdentity));
    if (!itemId) return null;
    const versions = this.#items.get(ownerKey(ownerId, itemId));
    return versions && versions.length > 0 ? versions[versions.length - 1] : null;
  }

  /**
   * @param {string} ownerId
   * @param {string} idempotencyKey
   * @param {string} documentDigest
   * @returns {Result<DiscoveryImportResult | null, DiscoveryFailure>}
   */
  importReplay(ownerId, idempotencyKey, documentDigest) {
    const existing = this.#imports.get(ownerKey(ownerId, idempotencyKey));
    if (!existing) return { ok: true, value: null };
    if (existing.documentDigest !== documentDigest) {
      return {
        ok: false,
        error: { kind: "DiscoveryVersionConflict", itemId: idempotencyKey },
      };
    }
    return {
      ok: true,
      value: freeze({ ...existing, replayed: true }),
    };
  }

  /**
   * Atomically records an import after validating every prospective version.
   *
   * @param {DiscoveryImportResult} result
   * @returns {Result<DiscoveryImportResult, DiscoveryFailure>}
   */
  appendImport(result) {
    const replay = this.importReplay(result.ownerId, result.idempotencyKey, result.documentDigest);
    if (!replay.ok) return replay;
    if (replay.value !== null) return { ok: true, value: replay.value };
    const source = this.getSource(result.ownerId, result.sourceId);
    if (!source.ok) return source;
    if (source.value.revision !== result.sourceRevision || source.value.state !== "enabled") {
      return {
        ok: false,
        error: { kind: "DiscoveryVersionConflict", itemId: result.sourceId },
      };
    }

    const batchIds = new Set();
    const batchIdentities = new Set();
    for (const item of result.itemVersions) {
      if (
        item.ownerId !== result.ownerId || item.sourceId !== result.sourceId ||
        item.sourceRevision !== result.sourceRevision || batchIds.has(item.id) ||
        batchIdentities.has(item.authoritativeIdentity)
      ) {
        return { ok: false, error: { kind: "DiscoveryBatchPersistenceFailed", operation: "import-items" } };
      }
      batchIds.add(item.id);
      batchIdentities.add(item.authoritativeIdentity);
      const existing = this.#items.get(ownerKey(item.ownerId, item.id));
      const expectedVersion = existing ? existing.length + 1 : 1;
      if (item.version !== expectedVersion) {
        return { ok: false, error: { kind: "DiscoveryVersionConflict", itemId: item.id } };
      }
      const identityItemId = this.#itemIdentity.get(
        ownerKey(item.ownerId, item.sourceId, item.authoritativeIdentity),
      );
      if (identityItemId && identityItemId !== item.id) {
        return { ok: false, error: { kind: "DiscoveryIdentityConflict", itemIndex: 0 } };
      }
    }

    for (const item of result.itemVersions) {
      const frozen = freezeItem(item);
      const itemKey = ownerKey(item.ownerId, item.id);
      const versions = this.#items.get(itemKey) ?? freeze([]);
      this.#items.set(itemKey, freeze([...versions, frozen]));
      this.#itemIdentity.set(
        ownerKey(item.ownerId, item.sourceId, item.authoritativeIdentity),
        item.id,
      );
    }
    const frozenResult = freezeImport(result);
    this.#imports.set(ownerKey(result.ownerId, result.idempotencyKey), frozenResult);
    this.#advance(result.ownerId);
    return { ok: true, value: frozenResult };
  }

  /**
   * @param {string} ownerId
   * @param {string} itemId
   * @param {number} version
   * @returns {Result<DiscoveredItemVersion, DiscoveryFailure>}
   */
  getItem(ownerId, itemId, version) {
    const versions = this.#items.get(ownerKey(ownerId, itemId));
    if (!versions || versions.length === 0) {
      const belongsToAnotherOwner = [...this.#items.values()].some((entries) =>
        entries.length > 0 && entries[0].id === itemId
      );
      if (belongsToAnotherOwner) {
        return { ok: false, error: { kind: "DiscoverySourceOwnerMismatch", ownerId } };
      }
      return { ok: false, error: { kind: "DiscoveryItemVersionUnknown", itemId, version } };
    }
    const item = versions.find((candidate) => candidate.version === version);
    return item
      ? { ok: true, value: item }
      : { ok: false, error: { kind: "DiscoveryItemVersionUnknown", itemId, version } };
  }

  /** @param {RightsAssessment} assessment @returns {Result<RightsAssessment, DiscoveryFailure>} */
  recordRights(assessment) {
    const existing = this.#rights.find((entry) =>
      entry.ownerId === assessment.ownerId && entry.idempotencyKey === assessment.idempotencyKey
    );
    if (existing) {
      return existing.itemId === assessment.itemId && existing.state === assessment.state &&
          existing.capability === assessment.capability
        ? { ok: true, value: existing }
        : { ok: false, error: { kind: "DiscoveryRightsConflict", itemId: assessment.itemId, capability: assessment.capability } };
    }
    const frozen = freeze({ ...assessment });
    this.#rights.push(frozen);
    this.#advance(assessment.ownerId);
    return { ok: true, value: frozen };
  }

  /**
   * @param {string} ownerId
   * @param {string} itemId
   * @param {number} itemVersion
   * @returns {readonly RightsAssessment[]}
   */
  listRights(ownerId, itemId, itemVersion) {
    return freeze(this.#rights.filter((entry) =>
      entry.ownerId === ownerId && entry.itemId === itemId && entry.itemVersion === itemVersion
    ));
  }

  /** @param {DiscoveryTriageDecision} decision @returns {Result<DiscoveryTriageDecision, DiscoveryFailure>} */
  recordTriage(decision) {
    const replay = this.#triage.find((entry) =>
      entry.ownerId === decision.ownerId && entry.idempotencyKey === decision.idempotencyKey
    );
    if (replay) {
      return replay.itemId === decision.itemId && replay.decision === decision.decision
        ? { ok: true, value: replay }
        : { ok: false, error: { kind: "DiscoveryTriageConflict", itemId: decision.itemId } };
    }
    const latest = this.latestTriage(decision.ownerId, decision.itemId);
    const actual = latest?.decisionRevision ?? 0;
    if (decision.expectedDecisionRevision !== actual) {
      return {
        ok: false,
        error: { kind: "DiscoveryTriageStale", itemId: decision.itemId, expected: decision.expectedDecisionRevision, actual },
      };
    }
    const frozen = freeze({ ...decision });
    this.#triage.push(frozen);
    this.#advance(decision.ownerId);
    return { ok: true, value: frozen };
  }

  /** @param {string} ownerId @param {string} itemId @returns {DiscoveryTriageDecision | null} */
  latestTriage(ownerId, itemId) {
    const matching = this.#triage.filter((entry) => entry.ownerId === ownerId && entry.itemId === itemId);
    return matching.length > 0 ? matching[matching.length - 1] : null;
  }

  /** @param {DiscoveryEvidenceAssociation} association @returns {Result<DiscoveryEvidenceAssociation, DiscoveryFailure>} */
  recordAssociation(association) {
    const replay = this.#associations.find((entry) =>
      entry.ownerId === association.ownerId && entry.idempotencyKey === association.idempotencyKey
    );
    if (replay) {
      return replay.itemId === association.itemId && replay.evidenceId === association.evidenceId
        ? { ok: true, value: replay }
        : { ok: false, error: { kind: "DiscoveryVersionConflict", itemId: association.itemId } };
    }
    const frozen = freeze({
      ...association,
      rightsAssessmentIds: freeze([...association.rightsAssessmentIds]),
      sourceAnchors: freeze([...association.sourceAnchors]),
    });
    this.#associations.push(frozen);
    this.#advance(association.ownerId);
    return { ok: true, value: frozen };
  }

  /**
   * @param {string} ownerId
   * @returns {{ readonly revision: number, readonly items: readonly DiscoveredItemVersion[] }}
   */
  snapshot(ownerId) {
    const items = [...this.#items.values()]
      .filter((versions) => versions.length > 0 && versions[0].ownerId === ownerId)
      .map((versions) => versions[versions.length - 1]);
    return freeze({
      revision: this.#ownerRevisions.get(ownerId) ?? 0,
      items: freeze(items),
    });
  }

  /** @param {string} ownerId @returns {readonly DiscoveryEvidenceAssociation[]} */
  listAssociations(ownerId) {
    return freeze(this.#associations.filter((entry) => entry.ownerId === ownerId));
  }

  /** @param {string} ownerId */
  #advance(ownerId) {
    this.#ownerRevisions.set(ownerId, (this.#ownerRevisions.get(ownerId) ?? 0) + 1);
  }
}

/** @param {string[]} parts */
function ownerKey(...parts) {
  return JSON.stringify(parts);
}

/** @param {DiscoverySourceRegistration} source @returns {DiscoverySourceRegistration} */
function freezeSource(source) {
  return freeze({
    ...source,
    identityEvidence: freeze(source.identityEvidence.map(
      /** @param {import("./contracts.js").IdentityEvidence} entry */
      (entry) => freeze({ ...entry }),
    )),
  });
}

/** @param {DiscoveredItemVersion} item @returns {DiscoveredItemVersion} */
function freezeItem(item) {
  return freeze({
    ...item,
    identityEvidence: freeze(item.identityEvidence.map(
      /** @param {import("./contracts.js").IdentityEvidence} entry */
      (entry) => freeze({ ...entry }),
    )),
    provenance: freeze({ ...item.provenance }),
  });
}

/** @param {DiscoveryImportResult} result @returns {DiscoveryImportResult} */
function freezeImport(result) {
  return freeze({
    ...result,
    itemVersions: freeze(result.itemVersions.map(freezeItem)),
  });
}
