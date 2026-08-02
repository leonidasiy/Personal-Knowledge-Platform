// @ts-check

const freeze = Object.freeze;

import { isNonEmptyText, isRecord } from "./contracts.js";

/** @import { DiscoveryCursorCodec, DiscoveryFailure, DiscoveryPageCursor, Result, RightsState } from "./contracts.js" */
/** @import { DiscoveryRepository } from "./repository.js" */

/**
 * @typedef {{
 *   readonly capability: string,
 *   readonly state: RightsState
 * }} DiscoveryRightsSummary
 */

/**
 * @typedef {{
 *   readonly itemId: string,
 *   readonly itemVersion: number,
 *   readonly sourceId: string,
 *   readonly title: string,
 *   readonly canonicalUrl: string,
 *   readonly publisherLabel: string | null,
 *   readonly publishedAt: string | null,
 *   readonly observedAt: string,
 *   readonly triage: "save-link" | "save-excerpt" | "defer" | "reject" | null,
 *   readonly quizSourceStatus: "Link only" | "Your notes" | "Publisher transcript" | "Your original",
 *   readonly rights: readonly DiscoveryRightsSummary[]
 * }} DiscoveryInboxItem
 */

/**
 * @typedef {{
 *   readonly revision: number,
 *   readonly items: readonly DiscoveryInboxItem[],
 *   readonly nextCursor: string | null
 * }} DiscoveryInboxPage
 */

export class DiscoveryProjection {
  /** @type {DiscoveryRepository} */
  #repository;
  /** @type {DiscoveryCursorCodec} */
  #cursorCodec;
  /** @type {number} */
  #maximumPageSize;

  /**
   * @param {{
   *   readonly repository: DiscoveryRepository,
   *   readonly cursorCodec: DiscoveryCursorCodec,
   *   readonly maximumPageSize: number
   * }} dependencies
   */
  constructor(dependencies) {
    if (
      !dependencies || typeof dependencies.cursorCodec?.encode !== "function" ||
      typeof dependencies.cursorCodec?.decode !== "function" ||
      !Number.isInteger(dependencies.maximumPageSize) || dependencies.maximumPageSize < 1
    ) {
      throw new TypeError("DiscoveryProjection requires repository, cursor codec, and a positive page bound.");
    }
    this.#repository = dependencies.repository;
    this.#cursorCodec = dependencies.cursorCodec;
    this.#maximumPageSize = dependencies.maximumPageSize;
  }

  /** @param {unknown} query @returns {Result<DiscoveryInboxPage, DiscoveryFailure>} */
  listInbox(query) {
    if (!isRecord(query) || !isNonEmptyText(query.ownerId)) {
      return { ok: false, error: { kind: "DiscoveryCommandInvalid", field: "ownerId" } };
    }
    if (
      !Number.isInteger(query.pageSize) || typeof query.pageSize !== "number" ||
      query.pageSize < 1 || query.pageSize > this.#maximumPageSize
    ) {
      return { ok: false, error: { kind: "DiscoveryCommandInvalid", field: "pageSize" } };
    }
    if (query.cursor !== null && typeof query.cursor !== "string") {
      return { ok: false, error: { kind: "DiscoveryPageCursorInvalid", reason: "malformed" } };
    }
    const snapshot = this.#repository.snapshot(query.ownerId);
    let offset = 0;
    if (typeof query.cursor === "string") {
      /** @type {ReturnType<DiscoveryCursorCodec["decode"]>} */
      let decoded;
      try {
        decoded = this.#cursorCodec.decode(query.cursor);
      } catch (error) {
        void error;
        return invalidCursor("codec-failed");
      }
      if (!decoded.ok) return invalidCursor("codec-rejected");
      const cursor = validateCursor(decoded.value);
      if (!cursor.ok) return cursor;
      if (cursor.value.ownerId !== query.ownerId) return invalidCursor("wrong-owner");
      if (cursor.value.kind !== "discovery-inbox") return invalidCursor("wrong-kind");
      if (cursor.value.limit !== query.pageSize) return invalidCursor("page-size-changed");
      if (cursor.value.revision !== snapshot.revision) return invalidCursor("stale");
      offset = cursor.value.offset;
    }

    const ordered = [...snapshot.items].sort((left, right) => {
      const byTime = right.observedAt.localeCompare(left.observedAt);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });
    if (offset < 0 || offset >= ordered.length && offset !== 0) return invalidCursor("offset-out-of-range");
    const selected = ordered.slice(offset, offset + query.pageSize);
    const items = selected.map((item) => {
      const rights = this.#repository.listRights(query.ownerId, item.id, item.version);
      const latestByCapability = new Map();
      for (const assessment of rights) latestByCapability.set(assessment.capability, assessment.state);
      const summaries = [...latestByCapability.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([capability, state]) => freeze({ capability, state }));
      const associations = this.#repository.listAssociations(query.ownerId).filter(
        /** @param {import("./contracts.js").DiscoveryEvidenceAssociation} entry */
        (entry) =>
        entry.itemId === item.id && entry.itemVersion === item.version
      );
      const association = associations.length > 0 ? associations[associations.length - 1] : null;
      const quizSourceStatus = association?.sourceKind === "learner-notes"
        ? "Your notes"
        : association?.sourceKind === "publisher-transcript"
        ? "Publisher transcript"
        : association?.sourceKind === "user-original"
        ? "Your original"
        : "Link only";
      const triage = this.#repository.latestTriage(query.ownerId, item.id);
      return freeze({
        itemId: item.id,
        itemVersion: item.version,
        sourceId: item.sourceId,
        title: item.title,
        canonicalUrl: item.canonicalUrl,
        publisherLabel: item.publisherLabel,
        publishedAt: item.publishedAt,
        observedAt: item.observedAt,
        triage: triage?.decision ?? null,
        quizSourceStatus,
        rights: freeze(summaries),
      });
    });
    const nextOffset = offset + selected.length;
    if (nextOffset >= ordered.length) {
      return { ok: true, value: freeze({ revision: snapshot.revision, items: freeze(items), nextCursor: null }) };
    }
    /** @type {ReturnType<DiscoveryCursorCodec["encode"]>} */
    let encoded;
    try {
      encoded = this.#cursorCodec.encode(freeze({
        ownerId: query.ownerId,
        kind: "discovery-inbox",
        revision: snapshot.revision,
        offset: nextOffset,
        limit: query.pageSize,
      }));
    } catch (error) {
      void error;
      return invalidCursor("encode-failed");
    }
    if (!encoded.ok) return invalidCursor("encode-failed");
    return { ok: true, value: freeze({
      revision: snapshot.revision,
      items: freeze(items),
      nextCursor: encoded.value,
    }) };
  }
}

/** @param {unknown} value @returns {Result<DiscoveryPageCursor, DiscoveryFailure>} */
function validateCursor(value) {
  if (
    !isRecord(value) || !isNonEmptyText(value.ownerId) || value.kind !== "discovery-inbox" ||
    !Number.isInteger(value.revision) || typeof value.revision !== "number" || value.revision < 0 ||
    !Number.isInteger(value.offset) || typeof value.offset !== "number" || value.offset < 1 ||
    !Number.isInteger(value.limit) || typeof value.limit !== "number" || value.limit < 1
  ) {
    return invalidCursor("malformed");
  }
  return { ok: true, value: freeze({
    ownerId: value.ownerId,
    kind: value.kind,
    revision: value.revision,
    offset: value.offset,
    limit: value.limit,
  }) };
}

/** @param {string} reason @returns {Result<never, DiscoveryFailure>} */
function invalidCursor(reason) {
  return { ok: false, error: { kind: "DiscoveryPageCursorInvalid", reason } };
}

export {};
