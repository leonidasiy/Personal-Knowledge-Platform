// @ts-check

const freeze = Object.freeze;

/** @import { DiscoveryFailure, DiscoveryDocumentParser, IdentityEvidence, ParsedDiscoveryDocument, ParsedDiscoveryItem, Result } from "./contracts.js" */
/** @import { DiscoveryXmlFailure, DiscoveryXmlParser, DiscoveredXmlItem, ParsedDiscoveryDocument as XmlDocument } from "./xml-parser.js" */

/** @typedef {{ readonly parse: (document: unknown, context: unknown) => Result<XmlDocument, DiscoveryXmlFailure> }} DiscoveryXmlParserPort */

export class DiscoveryXmlParserAdapter {
  /** @type {DiscoveryXmlParserPort} */
  #parser;
  /** @type {string} */
  #parserVersion;
  /** @type {(value: string) => Promise<Result<string, DiscoveryFailure>>} */
  #digest;

  /**
   * @param {{
   *   readonly parser: DiscoveryXmlParserPort,
   *   readonly parserVersion: string,
   *   readonly digest: (value: string) => Promise<Result<string, DiscoveryFailure>>
   * }} dependencies
   */
  constructor(dependencies) {
    if (
      typeof dependencies.parser?.parse !== "function" ||
      typeof dependencies.parserVersion !== "string" ||
      dependencies.parserVersion.trim() === "" ||
      typeof dependencies.digest !== "function"
    ) {
      throw new TypeError(
        "Discovery XML parser adapter dependencies are invalid.",
      );
    }
    this.#parser = dependencies.parser;
    this.#parserVersion = dependencies.parserVersion;
    this.#digest = dependencies.digest;
  }

  /**
   * @param {unknown} document
   * @param {{
   *   readonly ownerId: string,
   *   readonly sourceId: string,
   *   readonly adapterId: string,
   *   readonly adapterVersion: string,
   *   readonly provenance: import("./contracts.js").RetrievalProvenance
   * }} context
   * @returns {Promise<Result<ParsedDiscoveryDocument, DiscoveryFailure>>}
   */
  async parse(document, context) {
    const parsed = this.#parser.parse(document, {
      sourceRecordId: context.sourceId,
      documentUrl: context.provenance.canonicalUrl,
      acquiredAt: context.provenance.acquiredAt,
    });
    if (!parsed.ok) return mapFailure(parsed.error, document);
    const sourceEvidence = mapEvidence(parsed.value.source.identityEvidence);
    /** @type {ParsedDiscoveryItem[]} */
    const items = [];
    for (const item of parsed.value.items) {
      const contentDigest = await this.#digest(stableItemProjection(item));
      if (!contentDigest.ok) return contentDigest;
      const evidence = mapEvidence(item.identityEvidence);
      items.push(freeze({
        identity: freeze({
          status: /** @type {const} */ ("established"),
          key: item.id,
          evidence,
        }),
        title: item.title,
        canonicalUrl: item.canonicalUrl,
        contentDigest: contentDigest.value,
        publisherLabel: item.publisherLabel,
        publishedAt: item.publishedAt,
        boundedExcerpt: null,
      }));
    }
    /** @type {ParsedDiscoveryDocument} */
    const result = freeze({
      format: parsed.value.format,
      parserVersion: this.#parserVersion,
      sourceIdentityEvidence: sourceEvidence,
      items: freeze(items),
    });
    return { ok: true, value: result };
  }
}

/** @param {XmlDocument["source"]["identityEvidence"] | DiscoveredXmlItem["identityEvidence"]} evidence */
function mapEvidence(evidence) {
  return freeze(evidence.map((
    /** @type {DiscoveredXmlItem["identityEvidence"][number]} */ entry,
  ) =>
    freeze({
      reference: `${entry.kind}:${entry.value}`,
      provenance: JSON.stringify({
        source: "parsed-feed-document",
        kind: entry.kind,
        canonicalUrl: entry.canonicalUrl,
        isPermaLink: entry.isPermaLink,
      }),
    })
  ));
}

/** @param {DiscoveredXmlItem} item */
function stableItemProjection(item) {
  return JSON.stringify({
    id: item.id,
    title: item.title,
    canonicalUrl: item.canonicalUrl,
    publisherLabel: item.publisherLabel,
    publishedAt: item.publishedAt,
    identityEvidence: item.identityEvidence,
  });
}

/**
 * @param {DiscoveryXmlFailure} failure
 * @param {unknown} document
 * @returns {Result<never, DiscoveryFailure>}
 */
function mapFailure(failure, document) {
  switch (failure.kind) {
    case "DiscoveryCommandInvalid":
      return {
        ok: false,
        error: { kind: "DiscoveryCommandInvalid", field: failure.field },
      };
    case "DiscoverySourceUrlInvalid":
      return {
        ok: false,
        error: { kind: "DiscoverySourceUrlInvalid", field: "canonicalUrl" },
      };
    case "DiscoveryPayloadTooLarge":
      return {
        ok: false,
        error: {
          kind: "DiscoveryPayloadTooLarge",
          maximum: failure.limit,
          actual: typeof document === "string" ? document.length : 0,
        },
      };
    case "DiscoveryFeedMetadataMissing":
      return {
        ok: false,
        error: { kind: "DiscoveryFeedMetadataMissing", field: failure.field },
      };
    case "DiscoveryItemMalformed":
      return {
        ok: false,
        error: {
          kind: "DiscoveryItemMalformed",
          field: `${failure.itemIndex}.${failure.field}`,
        },
      };
    case "DiscoveryItemIdentityMissing":
      return {
        ok: false,
        error: {
          kind: "DiscoveryItemIdentityMissing",
          itemIndex: failure.itemIndex,
        },
      };
    case "DiscoveryIdentityAmbiguous":
      return {
        ok: false,
        error: failure.scope === "item"
          ? {
            kind: "DiscoveryIdentityAmbiguous",
            itemIndex: failure.itemIndex ?? 0,
          }
          : { kind: "DiscoveryFeedMetadataMissing", field: "identity" },
      };
    case "DiscoveryIdentityConflict":
      return {
        ok: false,
        error: {
          kind: "DiscoveryIdentityConflict",
          itemIndex: failure.secondItemIndex,
        },
      };
    default:
      return { ok: false, error: failure };
  }
}

export {};
