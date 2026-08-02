// @ts-check

const freeze = Object.freeze;

import {
  isNonEmptyText,
  isRecord,
  validateHttpsUrl,
  validateIdentityEvidence,
} from "./contracts.js";

/** @import { DiscoveryDocumentParser, DiscoveryEvidenceAssociation, DiscoveryFailure, DiscoveryImportResult, DiscoverySourceRegistration, DiscoveryTriageDecision, DiscoveredItemVersion, IdentityEvidence, ParsedDiscoveryDocument, ParsedDiscoveryItem, Result, RetrievalProvenance, RightsAssessment, RightsState, TriageKind } from "./contracts.js" */
/** @import { DiscoveryRepository } from "./repository.js" */

export class DiscoveryService {
  /** @type {DiscoveryRepository} */
  #repository;
  /** @type {DiscoveryDocumentParser} */
  #parser;
  /** @type {ReadonlySet<string>} */
  #supportedAdapters;
  /** @type {() => string} */
  #createId;
  /** @type {number} */
  #maximumDocumentBytes;

  /**
   * @param {{
   *   readonly repository: DiscoveryRepository,
   *   readonly parser: DiscoveryDocumentParser,
   *   readonly supportedAdapters: ReadonlySet<string>,
   *   readonly createId: () => string,
   *   readonly maximumDocumentBytes: number
   * }} dependencies
   */
  constructor(dependencies) {
    if (
      !dependencies || typeof dependencies.parser?.parse !== "function" ||
      typeof dependencies.createId !== "function" ||
      !(dependencies.supportedAdapters instanceof Set) ||
      !Number.isInteger(dependencies.maximumDocumentBytes) || dependencies.maximumDocumentBytes < 1
    ) {
      throw new TypeError("DiscoveryService requires repository, parser, adapter registry, and ID factory.");
    }
    this.#repository = dependencies.repository;
    this.#parser = dependencies.parser;
    this.#supportedAdapters = dependencies.supportedAdapters;
    this.#createId = dependencies.createId;
    this.#maximumDocumentBytes = dependencies.maximumDocumentBytes;
  }

  /** @param {unknown} command @returns {Result<DiscoverySourceRegistration, DiscoveryFailure>} */
  registerSource(command) {
    const parsed = parseSourceRegistration(command);
    if (!parsed.ok) return parsed;
    if (!this.#supportedAdapters.has(parsed.value.adapterId)) {
      return { ok: false, error: { kind: "DiscoveryAdapterUnknown", adapterId: parsed.value.adapterId } };
    }
    const id = this.#nextId("register-source");
    if (!id.ok) return id;
    return this.#repository.registerSource(freeze({
      id: id.value,
      sourceId: parsed.value.sourceId,
      ownerId: parsed.value.ownerId,
      revision: 1,
      authoritativeIdentity: parsed.value.authoritativeIdentity,
      identityEvidence: parsed.value.identityEvidence,
      adapterId: parsed.value.adapterId,
      adapterVersion: parsed.value.adapterVersion,
      submittedUrl: parsed.value.submittedUrl,
      canonicalUrl: parsed.value.canonicalUrl,
      state: "enabled",
      idempotencyKey: parsed.value.idempotencyKey,
      occurredAt: parsed.value.occurredAt,
    }));
  }

  /** @param {unknown} command @returns {Result<DiscoverySourceRegistration, DiscoveryFailure>} */
  reviseSource(command) {
    if (!isRecord(command)) return invalid("command");
    const ownerId = textField(command, "ownerId");
    const sourceId = textField(command, "sourceId");
    const idempotencyKey = textField(command, "idempotencyKey");
    const occurredAt = instantField(command, "occurredAt");
    const expectedRevision = integerField(command, "expectedRevision", 1);
    if (!ownerId.ok) return ownerId;
    if (!sourceId.ok) return sourceId;
    if (!idempotencyKey.ok) return idempotencyKey;
    if (!occurredAt.ok) return occurredAt;
    if (!expectedRevision.ok) return expectedRevision;
    if (command.state !== "enabled" && command.state !== "disabled" && command.state !== "deleted") {
      return invalid("state");
    }
    const source = this.#repository.getSource(ownerId.value, sourceId.value);
    if (!source.ok) return source;
    const id = this.#nextId("revise-source");
    if (!id.ok) return id;
    return this.#repository.reviseSource(freeze({
      ...source.value,
      id: id.value,
      revision: source.value.revision + 1,
      state: command.state,
      idempotencyKey: idempotencyKey.value,
      occurredAt: occurredAt.value,
    }), expectedRevision.value);
  }

  /** @param {unknown} command @returns {Promise<Result<DiscoveryImportResult, DiscoveryFailure>>} */
  async importDocument(command) {
    const parsedCommand = parseImportCommand(command);
    if (!parsedCommand.ok) return parsedCommand;
    const input = parsedCommand.value;
    if (input.provenance.byteCount > this.#maximumDocumentBytes) {
      return {
        ok: false,
        error: {
          kind: "DiscoveryPayloadTooLarge",
          maximum: this.#maximumDocumentBytes,
          actual: input.provenance.byteCount,
        },
      };
    }
    const source = this.#repository.getSource(input.ownerId, input.sourceId);
    if (!source.ok) return source;
    if (source.value.revision !== input.sourceRevision || source.value.state !== "enabled") {
      return { ok: false, error: { kind: "DiscoveryVersionConflict", itemId: input.sourceId } };
    }
    if (source.value.adapterVersion !== input.adapterVersion) {
      return { ok: false, error: { kind: "DiscoveryVersionConflict", itemId: input.sourceId } };
    }
    const replay = this.#repository.importReplay(input.ownerId, input.idempotencyKey, input.provenance.digest);
    if (!replay.ok || replay.value) return replay;

    /** @type {Awaited<ReturnType<DiscoveryDocumentParser["parse"]>>} */
    let parserResult;
    try {
      parserResult = await this.#parser.parse(input.document, {
        ownerId: input.ownerId,
        sourceId: input.sourceId,
        adapterId: source.value.adapterId,
        adapterVersion: input.adapterVersion,
        provenance: input.provenance,
      });
    } catch (error) {
      void error;
      return { ok: false, error: { kind: "DiscoveryBatchPersistenceFailed", operation: "parse-document" } };
    }
    if (!isRecord(parserResult) || typeof parserResult.ok !== "boolean") {
      return { ok: false, error: { kind: "DiscoveryBatchPersistenceFailed", operation: "parse-contract" } };
    }
    if (!parserResult.ok) return parserResult;
    const document = validateParsedDocument(parserResult.value);
    if (!document.ok) return document;

    /** @type {DiscoveredItemVersion[]} */
    const newVersions = [];
    const identities = new Set();
    for (let index = 0; index < document.value.items.length; index += 1) {
      const item = document.value.items[index];
      const identity = resolveIdentity(item, index);
      if (!identity.ok) return identity;
      if (identities.has(identity.value)) {
        return { ok: false, error: { kind: "DiscoveryIdentityConflict", itemIndex: index } };
      }
      identities.add(identity.value);
      const previous = this.#repository.latestByIdentity(input.ownerId, input.sourceId, identity.value);
      if (previous?.contentDigest === item.contentDigest) continue;
      let itemId = previous?.id ?? null;
      if (itemId === null) {
        const createdItemId = this.#nextId("import-item");
        if (!createdItemId.ok) return createdItemId;
        itemId = createdItemId.value;
      }
      newVersions.push(freeze({
        id: itemId,
        ownerId: input.ownerId,
        sourceId: input.sourceId,
        sourceRevision: input.sourceRevision,
        authoritativeIdentity: identity.value,
        identityEvidence: item.identity.evidence,
        version: previous ? previous.version + 1 : 1,
        title: item.title,
        canonicalUrl: item.canonicalUrl,
        contentDigest: item.contentDigest,
        publisherLabel: item.publisherLabel,
        publishedAt: item.publishedAt,
        boundedExcerpt: item.boundedExcerpt,
        provenance: input.provenance,
        parserVersion: document.value.parserVersion,
        observedAt: input.provenance.acquiredAt,
      }));
    }
    const eventId = this.#nextId("import-document");
    if (!eventId.ok) return eventId;
    return this.#repository.appendImport(freeze({
      id: eventId.value,
      ownerId: input.ownerId,
      sourceId: input.sourceId,
      sourceRevision: input.sourceRevision,
      documentDigest: input.provenance.digest,
      itemVersions: freeze(newVersions),
      idempotencyKey: input.idempotencyKey,
      importedAt: input.provenance.acquiredAt,
      replayed: false,
    }));
  }

  /** @param {unknown} command @returns {Result<RightsAssessment, DiscoveryFailure>} */
  assessRights(command) {
    const parsed = parseRightsCommand(command);
    if (!parsed.ok) return parsed;
    const item = this.#repository.getItem(parsed.value.ownerId, parsed.value.itemId, parsed.value.itemVersion);
    if (!item.ok) return item;
    const current = this.#repository.listRights(
      parsed.value.ownerId,
      parsed.value.itemId,
      parsed.value.itemVersion,
    ).filter(
      /** @param {RightsAssessment} entry */
      (entry) => entry.capability === parsed.value.capability,
    );
    const latest = current.length > 0 ? current[current.length - 1] : null;
    if (
      latest && latest.state !== parsed.value.state &&
      parsed.value.supersedesAssessmentId !== latest.id
    ) {
      return {
        ok: false,
        error: { kind: "DiscoveryRightsConflict", itemId: parsed.value.itemId, capability: parsed.value.capability },
      };
    }
    const id = this.#nextId("assess-rights");
    if (!id.ok) return id;
    return this.#repository.recordRights(freeze({
      id: id.value,
      ownerId: parsed.value.ownerId,
      itemId: parsed.value.itemId,
      itemVersion: parsed.value.itemVersion,
      capability: parsed.value.capability,
      state: parsed.value.state,
      basis: parsed.value.basis,
      attribution: parsed.value.attribution,
      assessedAt: parsed.value.assessedAt,
      expiresAt: parsed.value.expiresAt,
      idempotencyKey: parsed.value.idempotencyKey,
    }));
  }

  /** @param {unknown} command @returns {Result<DiscoveryTriageDecision, DiscoveryFailure>} */
  triage(command) {
    const parsed = parseTriageCommand(command);
    if (!parsed.ok) return parsed;
    const item = this.#repository.getItem(parsed.value.ownerId, parsed.value.itemId, parsed.value.itemVersion);
    if (!item.ok) return item;
    const required = parsed.value.decision === "save-link"
      ? ["link", "metadata-storage"]
      : parsed.value.decision === "save-excerpt"
      ? ["excerpt-storage", "display", "transform", "attribution"]
      : [];
    const rights = this.#requireRights(parsed.value.ownerId, parsed.value.itemId, parsed.value.itemVersion, required, parsed.value.decidedAt);
    if (!rights.ok) return rights;
    const id = this.#nextId("triage");
    if (!id.ok) return id;
    return this.#repository.recordTriage(freeze({
      id: id.value,
      ownerId: parsed.value.ownerId,
      itemId: parsed.value.itemId,
      itemVersion: parsed.value.itemVersion,
      decision: parsed.value.decision,
      expectedDecisionRevision: parsed.value.expectedDecisionRevision,
      decisionRevision: parsed.value.expectedDecisionRevision + 1,
      decidedAt: parsed.value.decidedAt,
      idempotencyKey: parsed.value.idempotencyKey,
    }));
  }

  /** @param {unknown} command @returns {Result<DiscoveryEvidenceAssociation, DiscoveryFailure>} */
  associateEvidence(command) {
    const parsed = parseEvidenceCommand(command);
    if (!parsed.ok) return parsed;
    const input = parsed.value;
    const item = this.#repository.getItem(input.ownerId, input.itemId, input.itemVersion);
    if (!item.ok) return item;
    if (input.sourceKind === "publisher-transcript" && input.sourceAnchors.length === 0) {
      return { ok: false, error: { kind: "IndependentTranscriptMissing", itemId: input.itemId } };
    }
    if (input.sourceAnchors.length === 0) {
      return { ok: false, error: { kind: "QuizEvidenceUnavailable", itemId: input.itemId } };
    }
    if (input.sourceKind === "user-original" && !input.rightsAttested) {
      return { ok: false, error: { kind: "UserContentRightsAttestationMissing", itemId: input.itemId } };
    }
    if (input.acquisitionMethod === "local-asr" && input.youtubeSourced) {
      return { ok: false, error: { kind: "LocalAsrYouTubeSourceDisallowed", itemId: input.itemId } };
    }
    const required = ["excerpt-storage", "display", "transform", "attribution"];
    const rights = this.#requireRights(input.ownerId, input.itemId, input.itemVersion, required, input.associatedAt);
    if (!rights.ok) {
      if (rights.error.kind === "DiscoveryRightsUnknown") {
        return { ok: false, error: { kind: "TranscriptRightsUnknown", itemId: input.itemId } };
      }
      if (rights.error.kind === "DiscoveryRightsConflict" && rights.error.capability === "excerpt-storage") {
        return { ok: false, error: { kind: "TranscriptStorageNotPermitted", itemId: input.itemId } };
      }
      if (rights.error.kind === "DiscoveryRightsConflict" && rights.error.capability === "transform") {
        return { ok: false, error: { kind: "TranscriptTransformationNotPermitted", itemId: input.itemId } };
      }
      return { ok: false, error: { kind: "QuizEvidenceUnavailable", itemId: input.itemId } };
    }
    const id = this.#nextId("associate-evidence");
    if (!id.ok) return id;
    return this.#repository.recordAssociation(freeze({
      id: id.value,
      ownerId: input.ownerId,
      itemId: input.itemId,
      itemVersion: input.itemVersion,
      evidenceId: input.evidenceId,
      evidenceContentVersion: input.evidenceContentVersion,
      sourceKind: input.sourceKind,
      acquisitionMethod: input.acquisitionMethod,
      retentionPolicy: input.retentionPolicy,
      rightsAssessmentIds: freeze(rights.value.map((entry) => entry.id)),
      sourceAnchors: input.sourceAnchors,
      associatedAt: input.associatedAt,
      idempotencyKey: input.idempotencyKey,
    }));
  }

  /**
   * @param {string} ownerId @param {string} itemId @param {number} itemVersion
   * @param {readonly string[]} capabilities @param {string} at
   * @returns {Result<readonly RightsAssessment[], DiscoveryFailure>}
   */
  #requireRights(ownerId, itemId, itemVersion, capabilities, at) {
    const assessments = this.#repository.listRights(ownerId, itemId, itemVersion);
    /** @type {RightsAssessment[]} */
    const selected = [];
    for (const capability of capabilities) {
      const matching = assessments.filter(
        /** @param {RightsAssessment} entry */
        (entry) => entry.capability === capability,
      );
      const latest = matching.length > 0 ? matching[matching.length - 1] : null;
      if (!latest || latest.state === "unknown" || (latest.expiresAt !== null && Date.parse(latest.expiresAt) <= Date.parse(at))) {
        return { ok: false, error: { kind: "DiscoveryRightsUnknown", itemId, capability } };
      }
      if (latest.state === "denied") {
        return { ok: false, error: { kind: "DiscoveryRightsConflict", itemId, capability } };
      }
      selected.push(latest);
    }
    return { ok: true, value: freeze(selected) };
  }

  /** @param {string} operation @returns {Result<string, DiscoveryFailure>} */
  #nextId(operation) {
    const id = this.#createId();
    return isNonEmptyText(id)
      ? { ok: true, value: id }
      : { ok: false, error: { kind: "DiscoveryBatchPersistenceFailed", operation } };
  }
}

/**
 * @param {unknown} command
 * @returns {Result<Omit<DiscoverySourceRegistration, "id" | "revision" | "state">, DiscoveryFailure>}
 */
function parseSourceRegistration(command) {
  if (!isRecord(command)) return invalid("command");
  const ownerId = textField(command, "ownerId");
  const sourceId = textField(command, "sourceId");
  const authoritativeIdentity = textField(command, "authoritativeIdentity");
  const adapterId = textField(command, "adapterId");
  const adapterVersion = textField(command, "adapterVersion");
  const idempotencyKey = textField(command, "idempotencyKey");
  const occurredAt = instantField(command, "occurredAt");
  const identityEvidence = validateIdentityEvidence(command.identityEvidence);
  if (!ownerId.ok) return ownerId;
  if (!sourceId.ok) return sourceId;
  if (!authoritativeIdentity.ok) return authoritativeIdentity;
  if (!adapterId.ok) return adapterId;
  if (!adapterVersion.ok) return adapterVersion;
  if (!idempotencyKey.ok) return idempotencyKey;
  if (!occurredAt.ok) return occurredAt;
  if (!identityEvidence.ok) return identityEvidence;
  const submittedUrl = urlField(command, "submittedUrl");
  if (!submittedUrl.ok) return submittedUrl;
  const canonicalUrl = urlField(command, "canonicalUrl");
  if (!canonicalUrl.ok) return canonicalUrl;
  return { ok: true, value: freeze({
    ownerId: ownerId.value,
    sourceId: sourceId.value,
    authoritativeIdentity: authoritativeIdentity.value,
    identityEvidence: identityEvidence.value,
    adapterId: adapterId.value,
    adapterVersion: adapterVersion.value,
    submittedUrl: submittedUrl.value,
    canonicalUrl: canonicalUrl.value,
    idempotencyKey: idempotencyKey.value,
    occurredAt: occurredAt.value,
  }) };
}

/**
 * @param {unknown} command
 * @returns {Result<{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly adapterVersion: string, readonly idempotencyKey: string, readonly document: unknown, readonly provenance: RetrievalProvenance }, DiscoveryFailure>}
 */
function parseImportCommand(command) {
  if (!isRecord(command)) return invalid("command");
  const ownerId = textField(command, "ownerId");
  const sourceId = textField(command, "sourceId");
  const sourceRevision = integerField(command, "sourceRevision", 1);
  const adapterVersion = textField(command, "adapterVersion");
  const idempotencyKey = textField(command, "idempotencyKey");
  if (!ownerId.ok) return ownerId;
  if (!sourceId.ok) return sourceId;
  if (!sourceRevision.ok) return sourceRevision;
  if (!adapterVersion.ok) return adapterVersion;
  if (!idempotencyKey.ok) return idempotencyKey;
  if (!("document" in command)) return invalid("document");
  const provenance = parseProvenance(command.provenance);
  if (!provenance.ok) return provenance;
  return { ok: true, value: freeze({
    ownerId: ownerId.value,
    sourceId: sourceId.value,
    sourceRevision: sourceRevision.value,
    adapterVersion: adapterVersion.value,
    idempotencyKey: idempotencyKey.value,
    document: command.document,
    provenance: provenance.value,
  }) };
}

/** @param {unknown} value @returns {Result<RetrievalProvenance, DiscoveryFailure>} */
function parseProvenance(value) {
  if (!isRecord(value)) return invalid("provenance");
  const method = textField(value, "method");
  const acquiredAt = instantField(value, "acquiredAt");
  const byteCount = integerField(value, "byteCount", 0);
  const digest = textField(value, "digest");
  const mediaType = textField(value, "mediaType");
  const sourceLocator = textField(value, "sourceLocator");
  if (!method.ok) return method;
  if (!acquiredAt.ok) return acquiredAt;
  if (!byteCount.ok) return byteCount;
  if (!digest.ok) return digest;
  if (!mediaType.ok) return mediaType;
  if (!sourceLocator.ok) return sourceLocator;
  const submittedUrl = urlField(value, "submittedUrl");
  if (!submittedUrl.ok) return submittedUrl;
  const canonicalUrl = urlField(value, "canonicalUrl");
  if (!canonicalUrl.ok) return canonicalUrl;
  return { ok: true, value: freeze({
    method: method.value,
    acquiredAt: acquiredAt.value,
    byteCount: byteCount.value,
    digest: digest.value,
    mediaType: mediaType.value,
    submittedUrl: submittedUrl.value,
    canonicalUrl: canonicalUrl.value,
    sourceLocator: sourceLocator.value,
  }) };
}

/** @param {unknown} value @returns {Result<ParsedDiscoveryDocument, DiscoveryFailure>} */
function validateParsedDocument(value) {
  if (!isRecord(value)) return { ok: false, error: { kind: "DiscoveryFeedMetadataMissing", field: "document" } };
  if (!isNonEmptyText(value.format)) return { ok: false, error: { kind: "DiscoveryFeedMetadataMissing", field: "format" } };
  if (!isNonEmptyText(value.parserVersion)) return { ok: false, error: { kind: "DiscoveryFeedMetadataMissing", field: "parserVersion" } };
  const sourceEvidence = validateIdentityEvidence(value.sourceIdentityEvidence);
  if (!sourceEvidence.ok) return { ok: false, error: { kind: "DiscoveryFeedMetadataMissing", field: "sourceIdentityEvidence" } };
  if (!Array.isArray(value.items)) return { ok: false, error: { kind: "DiscoveryFeedMetadataMissing", field: "items" } };
  /** @type {ParsedDiscoveryItem[]} */
  const items = [];
  for (let index = 0; index < value.items.length; index += 1) {
    const parsed = parseItem(value.items[index], index);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  return { ok: true, value: freeze({
    format: value.format,
    parserVersion: value.parserVersion,
    sourceIdentityEvidence: sourceEvidence.value,
    items: freeze(items),
  }) };
}

/** @param {unknown} value @param {number} index @returns {Result<ParsedDiscoveryItem, DiscoveryFailure>} */
function parseItem(value, index) {
  if (!isRecord(value) || !isRecord(value.identity)) return itemInvalid(index, "item");
  const identity = value.identity;
  if (identity.status !== "established" && identity.status !== "missing" && identity.status !== "ambiguous" && identity.status !== "conflicting") {
    return itemInvalid(index, "identity.status");
  }
  if (identity.key !== null && !isNonEmptyText(identity.key)) return itemInvalid(index, "identity.key");
  const evidence = validateIdentityEvidence(identity.evidence);
  if (!evidence.ok) return itemInvalid(index, "identity.evidence");
  const title = textField(value, "title");
  const contentDigest = textField(value, "contentDigest");
  if (!title.ok || !contentDigest.ok) return itemInvalid(index, !title.ok ? "title" : "contentDigest");
  const canonicalUrl = urlField(value, "canonicalUrl");
  if (!canonicalUrl.ok) return itemInvalid(index, "canonicalUrl");
  if (value.publisherLabel !== null && !isNonEmptyText(value.publisherLabel)) return itemInvalid(index, "publisherLabel");
  if (value.publishedAt !== null && (!isNonEmptyText(value.publishedAt) || !Number.isFinite(Date.parse(value.publishedAt)))) return itemInvalid(index, "publishedAt");
  if (value.boundedExcerpt !== null && typeof value.boundedExcerpt !== "string") return itemInvalid(index, "boundedExcerpt");
  return { ok: true, value: freeze({
    identity: freeze({ status: identity.status, key: identity.key, evidence: evidence.value }),
    title: title.value,
    canonicalUrl: canonicalUrl.value,
    contentDigest: contentDigest.value,
    publisherLabel: value.publisherLabel,
    publishedAt: value.publishedAt,
    boundedExcerpt: value.boundedExcerpt,
  }) };
}

/** @param {ParsedDiscoveryItem} item @param {number} index @returns {Result<string, DiscoveryFailure>} */
function resolveIdentity(item, index) {
  if (item.identity.status === "missing") return { ok: false, error: { kind: "DiscoveryItemIdentityMissing", itemIndex: index } };
  if (item.identity.status === "ambiguous") return { ok: false, error: { kind: "DiscoveryIdentityAmbiguous", itemIndex: index } };
  if (item.identity.status === "conflicting") return { ok: false, error: { kind: "DiscoveryIdentityConflict", itemIndex: index } };
  return item.identity.key === null
    ? { ok: false, error: { kind: "DiscoveryItemIdentityMissing", itemIndex: index } }
    : { ok: true, value: item.identity.key };
}

/**
 * @param {unknown} command
 * @returns {Result<{ readonly ownerId: string, readonly itemId: string, readonly itemVersion: number, readonly capability: string, readonly state: RightsState, readonly basis: string, readonly attribution: string | null, readonly assessedAt: string, readonly expiresAt: string | null, readonly idempotencyKey: string, readonly supersedesAssessmentId: string | null }, DiscoveryFailure>}
 */
function parseRightsCommand(command) {
  if (!isRecord(command)) return invalid("command");
  const ownerId = textField(command, "ownerId");
  const itemId = textField(command, "itemId");
  const itemVersion = integerField(command, "itemVersion", 1);
  const capability = textField(command, "capability");
  const basis = textField(command, "basis");
  const assessedAt = instantField(command, "assessedAt");
  const idempotencyKey = textField(command, "idempotencyKey");
  if (!ownerId.ok) return ownerId;
  if (!itemId.ok) return itemId;
  if (!itemVersion.ok) return itemVersion;
  if (!capability.ok) return capability;
  if (!basis.ok) return basis;
  if (!assessedAt.ok) return assessedAt;
  if (!idempotencyKey.ok) return idempotencyKey;
  if (command.state !== "allowed" && command.state !== "denied" && command.state !== "unknown") return invalid("state");
  const attribution = nullableText(command.attribution, "attribution");
  if (!attribution.ok) return attribution;
  const expiresAt = nullableInstant(command.expiresAt, "expiresAt");
  if (!expiresAt.ok) return expiresAt;
  const supersedes = nullableText(command.supersedesAssessmentId, "supersedesAssessmentId");
  if (!supersedes.ok) return supersedes;
  return { ok: true, value: freeze({
    ownerId: ownerId.value, itemId: itemId.value, itemVersion: itemVersion.value,
    capability: capability.value, state: command.state, basis: basis.value,
    attribution: attribution.value, assessedAt: assessedAt.value, expiresAt: expiresAt.value,
    idempotencyKey: idempotencyKey.value, supersedesAssessmentId: supersedes.value,
  }) };
}

/**
 * @param {unknown} command
 * @returns {Result<{ readonly ownerId: string, readonly itemId: string, readonly itemVersion: number, readonly decision: TriageKind, readonly expectedDecisionRevision: number, readonly decidedAt: string, readonly idempotencyKey: string }, DiscoveryFailure>}
 */
function parseTriageCommand(command) {
  if (!isRecord(command)) return invalid("command");
  const ownerId = textField(command, "ownerId");
  const itemId = textField(command, "itemId");
  const itemVersion = integerField(command, "itemVersion", 1);
  const expected = integerField(command, "expectedDecisionRevision", 0);
  const decidedAt = instantField(command, "decidedAt");
  const idempotencyKey = textField(command, "idempotencyKey");
  if (!ownerId.ok) return ownerId;
  if (!itemId.ok) return itemId;
  if (!itemVersion.ok) return itemVersion;
  if (!expected.ok) return expected;
  if (!decidedAt.ok) return decidedAt;
  if (!idempotencyKey.ok) return idempotencyKey;
  if (command.decision !== "save-link" && command.decision !== "save-excerpt" && command.decision !== "defer" && command.decision !== "reject") return invalid("decision");
  return { ok: true, value: freeze({
    ownerId: ownerId.value, itemId: itemId.value, itemVersion: itemVersion.value,
    decision: command.decision, expectedDecisionRevision: expected.value,
    decidedAt: decidedAt.value, idempotencyKey: idempotencyKey.value,
  }) };
}

/**
 * @param {unknown} command
 * @returns {Result<{ readonly ownerId: string, readonly itemId: string, readonly itemVersion: number, readonly evidenceId: string, readonly evidenceContentVersion: number, readonly sourceKind: "publisher-transcript" | "learner-notes" | "user-original", readonly acquisitionMethod: string, readonly retentionPolicy: string, readonly sourceAnchors: readonly string[], readonly associatedAt: string, readonly idempotencyKey: string, readonly rightsAttested: boolean, readonly youtubeSourced: boolean }, DiscoveryFailure>}
 */
function parseEvidenceCommand(command) {
  if (!isRecord(command)) return invalid("command");
  const ownerId = textField(command, "ownerId");
  const itemId = textField(command, "itemId");
  const itemVersion = integerField(command, "itemVersion", 1);
  const evidenceId = textField(command, "evidenceId");
  const evidenceContentVersion = integerField(command, "evidenceContentVersion", 1);
  const acquisitionMethod = textField(command, "acquisitionMethod");
  const retentionPolicy = textField(command, "retentionPolicy");
  const associatedAt = instantField(command, "associatedAt");
  const idempotencyKey = textField(command, "idempotencyKey");
  if (!ownerId.ok) return ownerId;
  if (!itemId.ok) return itemId;
  if (!itemVersion.ok) return itemVersion;
  if (!evidenceId.ok) return evidenceId;
  if (!evidenceContentVersion.ok) return evidenceContentVersion;
  if (!acquisitionMethod.ok) return acquisitionMethod;
  if (!retentionPolicy.ok) return retentionPolicy;
  if (!associatedAt.ok) return associatedAt;
  if (!idempotencyKey.ok) return idempotencyKey;
  if (command.sourceKind !== "publisher-transcript" && command.sourceKind !== "learner-notes" && command.sourceKind !== "user-original") return invalid("sourceKind");
  if (!Array.isArray(command.sourceAnchors) || command.sourceAnchors.some((entry) => !isNonEmptyText(entry))) return invalid("sourceAnchors");
  if (typeof command.rightsAttested !== "boolean") return invalid("rightsAttested");
  if (typeof command.youtubeSourced !== "boolean") return invalid("youtubeSourced");
  return { ok: true, value: freeze({
    ownerId: ownerId.value, itemId: itemId.value, itemVersion: itemVersion.value,
    evidenceId: evidenceId.value, evidenceContentVersion: evidenceContentVersion.value,
    sourceKind: command.sourceKind, acquisitionMethod: acquisitionMethod.value,
    retentionPolicy: retentionPolicy.value, sourceAnchors: freeze([...command.sourceAnchors]),
    associatedAt: associatedAt.value, idempotencyKey: idempotencyKey.value,
    rightsAttested: command.rightsAttested, youtubeSourced: command.youtubeSourced,
  }) };
}

/** @param {Record<string, unknown>} record @param {string} field @returns {Result<string, DiscoveryFailure>} */
function textField(record, field) {
  return isNonEmptyText(record[field]) ? { ok: true, value: record[field] } : invalid(field);
}

/** @param {Record<string, unknown>} record @param {string} field @param {number} minimum @returns {Result<number, DiscoveryFailure>} */
function integerField(record, field, minimum) {
  const value = record[field];
  return Number.isInteger(value) && typeof value === "number" && value >= minimum ? { ok: true, value } : invalid(field);
}

/** @param {Record<string, unknown>} record @param {string} field @returns {Result<string, DiscoveryFailure>} */
function instantField(record, field) {
  const value = record[field];
  return isNonEmptyText(value) && Number.isFinite(Date.parse(value)) ? { ok: true, value } : invalid(field);
}

/** @param {Record<string, unknown>} record @param {string} field @returns {Result<string, DiscoveryFailure>} */
function urlField(record, field) {
  const result = validateHttpsUrl(record[field]);
  if (!result.ok && result.error.kind === "DiscoverySourceUrlInvalid") {
    return { ok: false, error: { ...result.error, field } };
  }
  return result;
}

/** @param {unknown} value @param {string} field @returns {Result<string | null, DiscoveryFailure>} */
function nullableText(value, field) {
  return value === null ? { ok: true, value: null } : isNonEmptyText(value) ? { ok: true, value } : invalid(field);
}

/** @param {unknown} value @param {string} field @returns {Result<string | null, DiscoveryFailure>} */
function nullableInstant(value, field) {
  return value === null ? { ok: true, value: null } : isNonEmptyText(value) && Number.isFinite(Date.parse(value)) ? { ok: true, value } : invalid(field);
}

/** @param {number} index @param {string} field @returns {Result<never, DiscoveryFailure>} */
function itemInvalid(index, field) {
  return { ok: false, error: { kind: "DiscoveryItemMalformed", field: `items[${index}].${field}` } };
}

/** @param {string} field @returns {Result<never, DiscoveryFailure>} */
function invalid(field) {
  return { ok: false, error: { kind: "DiscoveryCommandInvalid", field } };
}
