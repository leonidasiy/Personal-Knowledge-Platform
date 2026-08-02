// @ts-check

const freeze = Object.freeze;

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {{
 *   readonly nodeType: number,
 *   readonly nodeName: string,
 *   readonly localName: string | null,
 *   readonly namespaceURI: string | null,
 *   readonly nodeValue: string | null,
 *   readonly childNodes: ArrayLike<XmlNodePort>,
 *   readonly attributes?: ArrayLike<XmlAttributePort>
 * }} XmlNodePort
 */

/**
 * @typedef {{
 *   readonly name: string,
 *   readonly localName: string | null,
 *   readonly namespaceURI: string | null,
 *   readonly value: string
 * }} XmlAttributePort
 */

/** @typedef {XmlNodePort & { readonly nodeType: 1 }} XmlElementPort */

/**
 * @typedef {{
 *   readonly documentElement: XmlElementPort | null
 * }} XmlDocumentPort
 */

/**
 * @typedef {{
 *   readonly parseFromString: (
 *     source: string,
 *     mediaType: "application/xml"
 *   ) => XmlDocumentPort | null
 * }} DomParserPort
 */

/**
 * @typedef {{
 *   readonly sourceRecordId: string,
 *   readonly documentUrl: string,
 *   readonly acquiredAt: string
 * }} DiscoveryParseContext
 */

/**
 * @typedef {{
 *   readonly maxDocumentChars: number,
 *   readonly maxDepth: number,
 *   readonly maxItems: number,
 *   readonly maxTotalAttributes: number,
 *   readonly maxTextChars: number
 * }} DiscoveryXmlLimits
 */

/**
 * @typedef {{
 *   readonly kind: "atom-id" | "atom-link" | "rss-channel-link" | "rss-guid" | "rss-link",
 *   readonly value: string,
 *   readonly canonicalUrl: string | null,
 *   readonly isPermaLink: boolean | null
 * }} DiscoveryIdentityEvidence
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly title: string,
 *   readonly canonicalUrl: string,
 *   readonly publisherLabel: string,
 *   readonly publishedAt: string | null,
 *   readonly identityEvidence: readonly DiscoveryIdentityEvidence[]
 * }} DiscoveredXmlItem
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly canonicalUrl: string,
 *   readonly publisherLabel: string,
 *   readonly publishedAt: string | null,
 *   readonly identityEvidence: readonly DiscoveryIdentityEvidence[]
 * }} DiscoveredXmlSource
 */

/**
 * @typedef {{
 *   readonly format: "rss2" | "atom",
 *   readonly provenance: DiscoveryParseContext,
 *   readonly source: DiscoveredXmlSource,
 *   readonly items: readonly DiscoveredXmlItem[]
 * }} ParsedDiscoveryDocument
 */

/**
 * @typedef {{
 *   readonly kind: "DiscoveryCommandInvalid",
 *   readonly field: "document" | "context"
 * } | {
 *   readonly kind: "DiscoverySourceUrlInvalid"
 * } | {
 *   readonly kind: "DiscoveryPayloadTooLarge",
 *   readonly limit: number
 * } | {
 *   readonly kind: "DiscoveryDoctypeForbidden"
 * } | {
 *   readonly kind: "DiscoveryEntityForbidden"
 * } | {
 *   readonly kind: "DiscoveryXIncludeForbidden"
 * } | {
 *   readonly kind: "DiscoveryStylesheetForbidden"
 * } | {
 *   readonly kind: "DiscoveryParserUnavailable"
 * } | {
 *   readonly kind: "DiscoveryXmlMalformed"
 * } | {
 *   readonly kind: "DiscoveryFormatUnsupported"
 * } | {
 *   readonly kind: "DiscoveryLimitExceeded",
 *   readonly limit: "depth" | "items" | "attributes" | "text"
 * } | {
 *   readonly kind: "DiscoveryFeedMetadataMissing",
 *   readonly field: "identity" | "title" | "canonicalUrl"
 * } | {
 *   readonly kind: "DiscoveryItemMalformed",
 *   readonly itemIndex: number,
 *   readonly field: "title" | "canonicalUrl" | "publishedAt"
 * } | {
 *   readonly kind: "DiscoveryItemIdentityMissing",
 *   readonly itemIndex: number
 * } | {
 *   readonly kind: "DiscoveryIdentityAmbiguous",
 *   readonly scope: "source" | "item",
 *   readonly itemIndex: number | null
 * } | {
 *   readonly kind: "DiscoveryIdentityConflict",
 *   readonly firstItemIndex: number,
 *   readonly secondItemIndex: number
 * }} DiscoveryXmlFailure
 */

const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
const XINCLUDE_NAMESPACE = "http://www.w3.org/2001/XInclude";
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

export class DiscoveryXmlParser {
  /** @type {() => DomParserPort} */
  #createDomParser;
  /** @type {DiscoveryXmlLimits} */
  #limits;

  /**
   * @param {{
   *   readonly createDomParser: () => DomParserPort,
   *   readonly limits: DiscoveryXmlLimits
   * }} dependencies
   */
  constructor(dependencies) {
    if (
      dependencies === null || typeof dependencies !== "object" ||
      typeof dependencies.createDomParser !== "function" ||
      !validLimits(dependencies.limits)
    ) {
      throw new TypeError("Discovery XML parser dependencies are invalid.");
    }
    this.#createDomParser = dependencies.createDomParser;
    this.#limits = freeze({ ...dependencies.limits });
  }

  /**
   * @param {unknown} input
   * @param {unknown} contextInput
   * @returns {Result<ParsedDiscoveryDocument, DiscoveryXmlFailure>}
   */
  parse(input, contextInput) {
    if (typeof input !== "string" || input.trim() === "") {
      return failure({ kind: "DiscoveryCommandInvalid", field: "document" });
    }
    const context = parseContext(contextInput);
    if (!context.ok) return context;
    if (input.length > this.#limits.maxDocumentChars) {
      return failure({
        kind: "DiscoveryPayloadTooLarge",
        limit: this.#limits.maxDocumentChars,
      });
    }

    const prohibited = prohibitedConstruct(input);
    if (prohibited !== null) return failure({ kind: prohibited });

    /** @type {DomParserPort} */
    let parser;
    try {
      parser = this.#createDomParser();
    } catch (error) {
      if (error instanceof Error) {
        return failure({ kind: "DiscoveryParserUnavailable" });
      }
      throw error;
    }
    if (
      parser === null || typeof parser !== "object" ||
      typeof parser.parseFromString !== "function"
    ) {
      return failure({ kind: "DiscoveryParserUnavailable" });
    }

    /** @type {XmlDocumentPort | null} */
    let document;
    try {
      document = parser.parseFromString(input, "application/xml");
    } catch (error) {
      if (error instanceof Error) {
        return failure({ kind: "DiscoveryXmlMalformed" });
      }
      throw error;
    }
    if (
      document === null || typeof document !== "object" ||
      !isElement(document.documentElement)
    ) {
      return failure({ kind: "DiscoveryXmlMalformed" });
    }

    const inspected = inspectTree(document.documentElement, this.#limits);
    if (!inspected.ok) return inspected;
    if (inspected.value.hasParserError) {
      return failure({ kind: "DiscoveryXmlMalformed" });
    }

    const root = document.documentElement;
    const rootName = localName(root);
    if (
      rootName === "rss" && namespace(root) === "" &&
      attributeValue(root, "version") === "2.0"
    ) {
      return parseRss(root, context.value, this.#limits);
    }
    if (rootName === "feed" && namespace(root) === ATOM_NAMESPACE) {
      return parseAtom(root, context.value, this.#limits);
    }
    return failure({ kind: "DiscoveryFormatUnsupported" });
  }
}

/**
 * @param {XmlElementPort} root
 * @param {DiscoveryParseContext} context
 * @param {DiscoveryXmlLimits} limits
 * @returns {Result<ParsedDiscoveryDocument, DiscoveryXmlFailure>}
 */
function parseRss(root, context, limits) {
  const channels = directElements(root, "channel", "");
  if (channels.length === 0) {
    return failure({
      kind: "DiscoveryFeedMetadataMissing",
      field: "identity",
    });
  }
  if (channels.length > 1) {
    return failure({
      kind: "DiscoveryIdentityAmbiguous",
      scope: "source",
      itemIndex: null,
    });
  }
  const channel = channels[0];
  const sourceTitle = requiredSingleText(channel, "title", "", "source", null);
  if (!sourceTitle.ok) return sourceTitle;
  const sourceLinks = directTextValues(channel, "link", "");
  const sourceLink = singleCanonicalLink(
    sourceLinks,
    context.documentUrl,
    "source",
    null,
  );
  if (!sourceLink.ok) return sourceLink;
  const sourceDate = optionalDate(
    firstDirectText(channel, "lastBuildDate", "") ??
      firstDirectText(channel, "pubDate", ""),
    "source",
    null,
  );
  if (!sourceDate.ok) return sourceDate;

  const itemElements = directElements(channel, "item", "");
  if (itemElements.length > limits.maxItems) {
    return failure({ kind: "DiscoveryLimitExceeded", limit: "items" });
  }
  /** @type {DiscoveredXmlItem[]} */
  const items = [];
  for (let index = 0; index < itemElements.length; index += 1) {
    const parsed = parseRssItem(
      itemElements[index],
      index,
      sourceTitle.value,
      context.documentUrl,
    );
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  const identityCheck = validateItemIdentitySet(items);
  if (!identityCheck.ok) return identityCheck;

  return success(freeze({
    format: /** @type {const} */ ("rss2"),
    provenance: context,
    source: freeze({
      id: sourceLink.value.canonicalUrl,
      canonicalUrl: sourceLink.value.canonicalUrl,
      publisherLabel: sourceTitle.value,
      publishedAt: sourceDate.value,
      identityEvidence: freeze([
        identityEvidence(
          "rss-channel-link",
          sourceLink.value.rawValue,
          sourceLink.value.canonicalUrl,
          null,
        ),
      ]),
    }),
    items: freeze(items),
  }));
}

/**
 * @param {XmlElementPort} element
 * @param {number} index
 * @param {string} publisherLabel
 * @param {string} baseUrl
 * @returns {Result<DiscoveredXmlItem, DiscoveryXmlFailure>}
 */
function parseRssItem(element, index, publisherLabel, baseUrl) {
  const title = requiredSingleText(element, "title", "", "item", index);
  if (!title.ok) return title;
  const guidElements = directElements(element, "guid", "");
  if (guidElements.length > 1) {
    return failure({
      kind: "DiscoveryIdentityAmbiguous",
      scope: "item",
      itemIndex: index,
    });
  }
  const rawLinks = directTextValues(element, "link", "");
  if (rawLinks.length > 1) {
    return failure({
      kind: "DiscoveryIdentityAmbiguous",
      scope: "item",
      itemIndex: index,
    });
  }

  const rawGuid = guidElements.length === 1
    ? normalizedText(guidElements[0])
    : "";
  const rawLink = rawLinks[0] ?? "";
  if (rawGuid === "" && rawLink === "") {
    return failure({ kind: "DiscoveryItemIdentityMissing", itemIndex: index });
  }
  const canonicalLink = rawLink === ""
    ? null
    : canonicalHttpsUrl(rawLink, baseUrl);
  const permaLink = guidElements.length === 1
    ? attributeValue(guidElements[0], "isPermaLink") !== "false"
    : null;
  const guidUrl = rawGuid !== "" && permaLink
    ? canonicalHttpsUrl(rawGuid, baseUrl)
    : null;
  if (
    canonicalLink !== null && guidUrl !== null &&
    canonicalLink !== guidUrl
  ) {
    return failure({
      kind: "DiscoveryIdentityConflict",
      firstItemIndex: index,
      secondItemIndex: index,
    });
  }
  const canonicalUrl = canonicalLink ?? guidUrl;
  if (canonicalUrl === null) {
    return failure({
      kind: "DiscoveryItemMalformed",
      itemIndex: index,
      field: "canonicalUrl",
    });
  }
  const date = optionalDate(
    firstDirectText(element, "pubDate", ""),
    "item",
    index,
  );
  if (!date.ok) return date;

  /** @type {DiscoveryIdentityEvidence[]} */
  const evidence = [];
  if (rawGuid !== "") {
    evidence.push(
      identityEvidence("rss-guid", rawGuid, guidUrl, permaLink),
    );
  }
  if (rawLink !== "") {
    evidence.push(
      identityEvidence("rss-link", rawLink, canonicalUrl, null),
    );
  }
  return success(freeze({
    id: rawGuid !== "" ? rawGuid : canonicalUrl,
    title: title.value,
    canonicalUrl,
    publisherLabel,
    publishedAt: date.value,
    identityEvidence: freeze(evidence),
  }));
}

/**
 * @param {XmlElementPort} root
 * @param {DiscoveryParseContext} context
 * @param {DiscoveryXmlLimits} limits
 * @returns {Result<ParsedDiscoveryDocument, DiscoveryXmlFailure>}
 */
function parseAtom(root, context, limits) {
  const sourceId = requiredSingleText(
    root,
    "id",
    ATOM_NAMESPACE,
    "source",
    null,
  );
  if (!sourceId.ok) return sourceId;
  const sourceTitle = requiredSingleText(
    root,
    "title",
    ATOM_NAMESPACE,
    "source",
    null,
  );
  if (!sourceTitle.ok) return sourceTitle;
  const sourceLink = atomCanonicalLink(
    root,
    context.documentUrl,
    "source",
    null,
  );
  if (!sourceLink.ok) return sourceLink;
  const sourceDate = optionalDate(
    firstDirectText(root, "updated", ATOM_NAMESPACE),
    "source",
    null,
  );
  if (!sourceDate.ok) return sourceDate;

  const entries = directElements(root, "entry", ATOM_NAMESPACE);
  if (entries.length > limits.maxItems) {
    return failure({ kind: "DiscoveryLimitExceeded", limit: "items" });
  }
  /** @type {DiscoveredXmlItem[]} */
  const items = [];
  for (let index = 0; index < entries.length; index += 1) {
    const parsed = parseAtomItem(
      entries[index],
      index,
      sourceTitle.value,
      context.documentUrl,
    );
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  const identityCheck = validateItemIdentitySet(items);
  if (!identityCheck.ok) return identityCheck;

  return success(freeze({
    format: /** @type {const} */ ("atom"),
    provenance: context,
    source: freeze({
      id: sourceId.value,
      canonicalUrl: sourceLink.value.canonicalUrl,
      publisherLabel: sourceTitle.value,
      publishedAt: sourceDate.value,
      identityEvidence: freeze([
        identityEvidence("atom-id", sourceId.value, null, null),
        identityEvidence(
          "atom-link",
          sourceLink.value.rawValue,
          sourceLink.value.canonicalUrl,
          null,
        ),
      ]),
    }),
    items: freeze(items),
  }));
}

/**
 * @param {XmlElementPort} element
 * @param {number} index
 * @param {string} publisherLabel
 * @param {string} baseUrl
 * @returns {Result<DiscoveredXmlItem, DiscoveryXmlFailure>}
 */
function parseAtomItem(element, index, publisherLabel, baseUrl) {
  const itemId = requiredSingleText(
    element,
    "id",
    ATOM_NAMESPACE,
    "item",
    index,
  );
  if (!itemId.ok) return itemId;
  const title = requiredSingleText(
    element,
    "title",
    ATOM_NAMESPACE,
    "item",
    index,
  );
  if (!title.ok) return title;
  const link = atomCanonicalLink(element, baseUrl, "item", index);
  if (!link.ok) return link;
  const date = optionalDate(
    firstDirectText(element, "published", ATOM_NAMESPACE) ??
      firstDirectText(element, "updated", ATOM_NAMESPACE),
    "item",
    index,
  );
  if (!date.ok) return date;
  return success(freeze({
    id: itemId.value,
    title: title.value,
    canonicalUrl: link.value.canonicalUrl,
    publisherLabel,
    publishedAt: date.value,
    identityEvidence: freeze([
      identityEvidence("atom-id", itemId.value, null, null),
      identityEvidence(
        "atom-link",
        link.value.rawValue,
        link.value.canonicalUrl,
        null,
      ),
    ]),
  }));
}

/**
 * @param {XmlElementPort} parent
 * @param {string} baseUrl
 * @param {"source" | "item"} scope
 * @param {number | null} itemIndex
 */
function atomCanonicalLink(parent, baseUrl, scope, itemIndex) {
  const links = directElements(parent, "link", ATOM_NAMESPACE)
    .filter((element) => {
      const relation = attributeValue(element, "rel");
      return relation === null || relation === "" || relation === "alternate";
    })
    .map((element) => attributeValue(element, "href") ?? "")
    .filter((value) => value.trim() !== "");
  return singleCanonicalLink(links, baseUrl, scope, itemIndex);
}

/**
 * @param {readonly string[]} rawLinks
 * @param {string} baseUrl
 * @param {"source" | "item"} scope
 * @param {number | null} itemIndex
 */
function singleCanonicalLink(rawLinks, baseUrl, scope, itemIndex) {
  const canonical = rawLinks.map((value) => ({
    rawValue: value,
    canonicalUrl: canonicalHttpsUrl(value, baseUrl),
  }));
  if (canonical.length === 0) {
    return scope === "source"
      ? failure({
        kind: /** @type {const} */ ("DiscoveryFeedMetadataMissing"),
        field: /** @type {const} */ ("canonicalUrl"),
      })
      : failure({
        kind: /** @type {const} */ ("DiscoveryItemMalformed"),
        itemIndex: itemIndex ?? 0,
        field: /** @type {const} */ ("canonicalUrl"),
      });
  }
  if (
    canonical.length !== 1 ||
    canonical[0].canonicalUrl === null
  ) {
    if (canonical.length !== 1) {
      return failure({
        kind: /** @type {const} */ ("DiscoveryIdentityAmbiguous"),
        scope,
        itemIndex,
      });
    }
    return scope === "source"
      ? failure({
        kind: /** @type {const} */ ("DiscoveryFeedMetadataMissing"),
        field: /** @type {const} */ ("canonicalUrl"),
      })
      : failure({
        kind: /** @type {const} */ ("DiscoveryItemMalformed"),
        itemIndex: itemIndex ?? 0,
        field: /** @type {const} */ ("canonicalUrl"),
      });
  }
  return success({
    rawValue: canonical[0].rawValue,
    canonicalUrl: canonical[0].canonicalUrl,
  });
}

/**
 * @param {readonly DiscoveredXmlItem[]} items
 * @returns {Result<true, DiscoveryXmlFailure>}
 */
function validateItemIdentitySet(items) {
  /** @type {Map<string, { readonly index: number, readonly canonicalUrl: string }>} */
  const byId = new Map();
  /** @type {Map<string, { readonly index: number, readonly id: string }>} */
  const byUrl = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const priorId = byId.get(item.id);
    if (priorId !== undefined) {
      if (priorId.canonicalUrl === item.canonicalUrl) {
        return failure({
          kind: "DiscoveryIdentityAmbiguous",
          scope: "item",
          itemIndex: index,
        });
      }
      return failure({
        kind: "DiscoveryIdentityConflict",
        firstItemIndex: priorId.index,
        secondItemIndex: index,
      });
    }
    const priorUrl = byUrl.get(item.canonicalUrl);
    if (priorUrl !== undefined && priorUrl.id !== item.id) {
      return failure({
        kind: "DiscoveryIdentityConflict",
        firstItemIndex: priorUrl.index,
        secondItemIndex: index,
      });
    }
    byId.set(item.id, { index, canonicalUrl: item.canonicalUrl });
    byUrl.set(item.canonicalUrl, { index, id: item.id });
  }
  return success(true);
}

/**
 * @param {XmlElementPort} parent
 * @param {string} name
 * @param {string} expectedNamespace
 * @param {"source" | "item"} scope
 * @param {number | null} itemIndex
 */
function requiredSingleText(
  parent,
  name,
  expectedNamespace,
  scope,
  itemIndex,
) {
  const elements = directElements(parent, name, expectedNamespace);
  if (elements.length > 1) {
    return failure({
      kind: /** @type {const} */ ("DiscoveryIdentityAmbiguous"),
      scope,
      itemIndex,
    });
  }
  const value = elements.length === 1 ? normalizedText(elements[0]) : "";
  if (value === "") {
    if (scope === "source") {
      const field = /** @type {"title" | "identity"} */ (
        name === "title" ? "title" : "identity"
      );
      return failure({
        kind: /** @type {const} */ ("DiscoveryFeedMetadataMissing"),
        field,
      });
    }
    if (name === "id") {
      return failure({
        kind: /** @type {const} */ ("DiscoveryItemIdentityMissing"),
        itemIndex: itemIndex ?? 0,
      });
    }
    return failure({
      kind: /** @type {const} */ ("DiscoveryItemMalformed"),
      itemIndex: itemIndex ?? 0,
      field: /** @type {const} */ ("title"),
    });
  }
  return success(value);
}

/**
 * @param {string | null} rawValue
 * @param {"source" | "item"} scope
 * @param {number | null} itemIndex
 */
function optionalDate(rawValue, scope, itemIndex) {
  if (rawValue === null || rawValue.trim() === "") return success(null);
  const value = rawValue.trim();
  if (!Number.isFinite(Date.parse(value))) {
    return scope === "source"
      ? failure({
        kind: /** @type {const} */ ("DiscoveryFeedMetadataMissing"),
        field: /** @type {const} */ ("identity"),
      })
      : failure({
        kind: /** @type {const} */ ("DiscoveryItemMalformed"),
        itemIndex: itemIndex ?? 0,
        field: /** @type {const} */ ("publishedAt"),
      });
  }
  return success(value);
}

/** @param {unknown} input */
function parseContext(input) {
  if (input === null || typeof input !== "object") {
    return failure({
      kind: /** @type {const} */ ("DiscoveryCommandInvalid"),
      field: /** @type {const} */ ("context"),
    });
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  if (
    typeof value.sourceRecordId !== "string" ||
    value.sourceRecordId.trim() === "" ||
    typeof value.documentUrl !== "string" ||
    typeof value.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(value.acquiredAt))
  ) {
    return failure({
      kind: /** @type {const} */ ("DiscoveryCommandInvalid"),
      field: /** @type {const} */ ("context"),
    });
  }
  const documentUrl = canonicalHttpsUrl(value.documentUrl, undefined);
  if (documentUrl === null) {
    return failure({
      kind: /** @type {const} */ ("DiscoverySourceUrlInvalid"),
    });
  }
  return success(freeze({
    sourceRecordId: value.sourceRecordId,
    documentUrl,
    acquiredAt: value.acquiredAt,
  }));
}

/** @param {string} source */
function prohibitedConstruct(source) {
  if (/<\s*!\s*DOCTYPE\b/i.test(source)) {
    return /** @type {const} */ ("DiscoveryDoctypeForbidden");
  }
  if (
    /<\s*!\s*ENTITY\b/i.test(source) ||
    /%\s*[A-Za-z_][\w.:-]*\s*;/.test(source) ||
    /&(?!(?:amp|lt|gt|apos|quot|#[xX][0-9a-fA-F]+|#[0-9]+);)[A-Za-z_][\w.:-]*;/
      .test(source)
  ) {
    return /** @type {const} */ ("DiscoveryEntityForbidden");
  }
  if (
    source.includes(XINCLUDE_NAMESPACE) ||
    /<\s*xi:include\b/i.test(source)
  ) {
    return /** @type {const} */ ("DiscoveryXIncludeForbidden");
  }
  if (/<\?xml-stylesheet\b/i.test(source)) {
    return /** @type {const} */ ("DiscoveryStylesheetForbidden");
  }
  return null;
}

/**
 * @param {XmlElementPort} root
 * @param {DiscoveryXmlLimits} limits
 */
function inspectTree(root, limits) {
  /** @type {{ readonly node: XmlNodePort, readonly depth: number }[]} */
  const stack = [{ node: root, depth: 1 }];
  let attributes = 0;
  let textChars = 0;
  let hasParserError = false;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.depth > limits.maxDepth) {
      return failure({
        kind: /** @type {const} */ ("DiscoveryLimitExceeded"),
        limit: /** @type {const} */ ("depth"),
      });
    }
    if (current.node.nodeType === ELEMENT_NODE) {
      if (localName(current.node) === "parsererror") hasParserError = true;
      const nodeAttributes = arrayFrom(current.node.attributes);
      if (nodeAttributes === null) {
        return failure({
          kind: /** @type {const} */ ("DiscoveryXmlMalformed"),
        });
      }
      attributes += nodeAttributes.length;
      if (attributes > limits.maxTotalAttributes) {
        return failure({
          kind: /** @type {const} */ ("DiscoveryLimitExceeded"),
          limit: /** @type {const} */ ("attributes"),
        });
      }
    }
    if (
      current.node.nodeType === TEXT_NODE ||
      current.node.nodeType === CDATA_NODE
    ) {
      textChars += current.node.nodeValue?.length ?? 0;
      if (textChars > limits.maxTextChars) {
        return failure({
          kind: /** @type {const} */ ("DiscoveryLimitExceeded"),
          limit: /** @type {const} */ ("text"),
        });
      }
    }
    const children = arrayFrom(current.node.childNodes);
    if (children === null) {
      return failure({ kind: /** @type {const} */ ("DiscoveryXmlMalformed") });
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (!isNode(child)) {
        return failure({
          kind: /** @type {const} */ ("DiscoveryXmlMalformed"),
        });
      }
      stack.push({ node: child, depth: current.depth + 1 });
    }
  }
  return success({ hasParserError });
}

/**
 * @param {XmlElementPort} parent
 * @param {string} name
 * @param {string} expectedNamespace
 * @returns {XmlElementPort[]}
 */
function directElements(parent, name, expectedNamespace) {
  const children = arrayFrom(parent.childNodes) ?? [];
  /** @type {XmlElementPort[]} */
  const matching = [];
  for (const node of children) {
    if (
      isElement(node) &&
      localName(node) === name &&
      namespace(node) === expectedNamespace
    ) {
      matching.push(node);
    }
  }
  return matching;
}

/**
 * @param {XmlElementPort} parent
 * @param {string} name
 * @param {string} expectedNamespace
 */
function directTextValues(parent, name, expectedNamespace) {
  return directElements(parent, name, expectedNamespace)
    .map(normalizedText)
    .filter((value) => value !== "");
}

/**
 * @param {XmlElementPort} parent
 * @param {string} name
 * @param {string} expectedNamespace
 */
function firstDirectText(parent, name, expectedNamespace) {
  return directTextValues(parent, name, expectedNamespace)[0] ?? null;
}

/** @param {XmlElementPort} element */
function normalizedText(element) {
  /** @type {string[]} */
  const text = [];
  /** @type {XmlNodePort[]} */
  const stack = [...(arrayFrom(element.childNodes) ?? [])];
  while (stack.length > 0) {
    const node = stack.shift();
    if (node === undefined) break;
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) {
      text.push(node.nodeValue ?? "");
    }
    stack.unshift(...(arrayFrom(node.childNodes) ?? []));
  }
  return text.join("").replace(/\s+/g, " ").trim();
}

/** @param {XmlElementPort} element @param {string} name */
function attributeValue(element, name) {
  const attributes = arrayFrom(element.attributes) ?? [];
  const matching = attributes.filter((attribute) =>
    attribute.localName === name || attribute.name === name
  );
  return matching.length === 1 ? matching[0].value : null;
}

/**
 * @param {DiscoveryIdentityEvidence["kind"]} kind
 * @param {string} value
 * @param {string | null} canonicalUrl
 * @param {boolean | null} isPermaLink
 */
function identityEvidence(kind, value, canonicalUrl, isPermaLink) {
  return freeze({ kind, value, canonicalUrl, isPermaLink });
}

/** @param {string} value @param {string | undefined} base */
function canonicalHttpsUrl(value, base) {
  try {
    const parsed = base === undefined ? new URL(value) : new URL(value, base);
    if (parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.href;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/** @param {XmlNodePort | null | undefined} value @returns {value is XmlElementPort} */
function isElement(value) {
  return isNode(value) && value.nodeType === ELEMENT_NODE;
}

/** @param {unknown} value @returns {value is XmlNodePort} */
function isNode(value) {
  if (value === null || typeof value !== "object") return false;
  const node = /** @type {Record<string, unknown>} */ (value);
  return typeof node.nodeType === "number" &&
    typeof node.nodeName === "string" &&
    (typeof node.localName === "string" || node.localName === null) &&
    (typeof node.namespaceURI === "string" || node.namespaceURI === null) &&
    (typeof node.nodeValue === "string" || node.nodeValue === null) &&
    node.childNodes !== null && typeof node.childNodes === "object";
}

/** @param {XmlNodePort} node */
function localName(node) {
  return node.localName ?? node.nodeName.split(":").at(-1) ?? node.nodeName;
}

/** @param {XmlNodePort} node */
function namespace(node) {
  return node.namespaceURI ?? "";
}

/** @template T @param {ArrayLike<T> | undefined} value @returns {T[] | null} */
function arrayFrom(value) {
  if (value === undefined || value === null || typeof value !== "object") {
    return value === undefined ? [] : null;
  }
  try {
    return Array.from(value);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/** @param {unknown} value @returns {value is DiscoveryXmlLimits} */
function validLimits(value) {
  if (value === null || typeof value !== "object") return false;
  const limits = /** @type {Record<string, unknown>} */ (value);
  return [
    limits.maxDocumentChars,
    limits.maxDepth,
    limits.maxItems,
    limits.maxTotalAttributes,
    limits.maxTextChars,
  ].every((limit) =>
    typeof limit === "number" && Number.isInteger(limit) && limit > 0
  );
}

/** @template T @param {T} value */
function success(value) {
  return /** @type {const} */ ({ ok: true, value });
}

/** @template E @param {E} error */
function failure(error) {
  return /** @type {const} */ ({ ok: false, error });
}
