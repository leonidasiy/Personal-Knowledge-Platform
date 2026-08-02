// @ts-check

import { validatePublisherDestination } from "./destination-policy.js";
import { extractPodcastReferenceSet } from "../src/features/discovery/podcast-metadata.js";

/** @import { Result, WorkerFailure } from "./contracts.js" */

/**
 * @typedef {{
 *   readonly name: string,
 *   readonly namespaceUri: string | null,
 *   readonly attributes: ReadonlyMap<string, string>,
 *   readonly children: readonly XmlElement[],
 *   readonly text: string
 * }} XmlElement
 */

/**
 * @typedef {{
 *   readonly kind: "atom-id" | "atom-link" | "rss-channel-link" | "rss-guid" | "rss-link",
 *   readonly value: string,
 *   readonly canonicalUrl: string | null,
 *   readonly isPermaLink: boolean | null
 * }} FeedIdentityEvidence
 */

/**
 * @typedef {{
 *   readonly identityKey: string,
 *   readonly identityEvidence: readonly FeedIdentityEvidence[],
 *   readonly title: string,
 *   readonly canonicalUrl: string,
 *   readonly publisherLabel: string,
 *   readonly publishedAt: string | null
 * }} ParsedFeedEntity
 */

/**
 * @typedef {ParsedFeedEntity & {
 *   readonly podcast: null | {
 *     readonly namespaceEvidencePresent: boolean,
 *     readonly namespaceUri: string | null,
 *     readonly namespaceContractReference: string | null,
 *     readonly feedLanguageSelector: string | null,
 *     readonly transcripts: readonly import("../src/features/discovery/podcast-metadata.js").PodcastTranscriptReference[],
 *     readonly enclosure: import("../src/features/discovery/podcast-metadata.js").PodcastEnclosureReference
 *   }
 * }} ParsedFeedItem
 */

/**
 * @typedef {{
 *   readonly format: "rss2" | "atom",
 *   readonly source: ParsedFeedEntity,
 *   readonly items: readonly ParsedFeedItem[]
 * }} ParsedFeed
 */

const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
const XINCLUDE_NAMESPACE = "http://www.w3.org/2001/XInclude";
// Podcast Namespace contract: https://podcasting2.org/docs/podcast-namespace/tags/transcript
const PODCAST_NAMESPACE = "https://podcastindex.org/namespace/1.0";
const PODCAST_NAMESPACE_CONTRACT =
  "https://podcasting2.org/docs/podcast-namespace/tags/transcript";
const MAXIMUM_PODCAST_TRANSCRIPTS = 16;
const MAXIMUM_DEPTH = 24;
const MAXIMUM_ITEMS = 100;
const MAXIMUM_ATTRIBUTES = 2_000;
const MAXIMUM_TEXT_CHARACTERS = 250_000;

/**
 * Parse a deliberately small, bounded RSS 2.0 / Atom metadata surface.
 * Content, summaries, descriptions, transcript bodies, and enclosure bodies
 * are never projected into the returned value. Podcast reference metadata is
 * retained without dereferencing it.
 *
 * @param {string} documentText
 * @param {string} documentUrl
 * @returns {Result<ParsedFeed, WorkerFailure>}
 */
export function parseNormalizedFeed(documentText, documentUrl) {
  if (typeof documentText !== "string" || documentText.trim() === "") {
    return failure({ kind: "DiscoveryXmlMalformed" });
  }
  const prohibited = prohibitedConstruct(documentText);
  if (prohibited !== null) return failure({ kind: prohibited });
  const tree = parseXml(documentText);
  if (!tree.ok) return tree;
  if (tree.value.name === "rss") return parseRss(tree.value, documentUrl);
  if (localName(tree.value.name) === "feed") {
    return parseAtom(tree.value, documentUrl);
  }
  return failure({ kind: "DiscoveryFormatUnsupported" });
}

/** @param {XmlElement} root @param {string} documentUrl @returns {Result<ParsedFeed, WorkerFailure>} */
function parseRss(root, documentUrl) {
  if (root.attributes.get("version") !== "2.0") {
    return failure({ kind: "DiscoveryFormatUnsupported" });
  }
  const channelResult = exactlyOne(root, "channel", "identity", null);
  if (!channelResult.ok) return channelResult;
  const channel = channelResult.value;
  const title = requiredText(channel, "title", "title", null);
  if (!title.ok) return title;
  const link = requiredSingleUrl(channel, "link", documentUrl, null);
  if (!link.ok) return link;
  const publishedAt = optionalDate(
    firstText(channel, "lastBuildDate") ?? firstText(channel, "pubDate"),
    null,
  );
  if (!publishedAt.ok) return publishedAt;
  const itemElements = directChildren(channel, "item");
  const languageElements = directChildren(channel, "language");
  if (itemElements.length > MAXIMUM_ITEMS) {
    return failure({ kind: "DiscoveryLimitExceeded", limit: "items" });
  }
  /** @type {ParsedFeedItem[]} */
  const items = [];
  for (let index = 0; index < itemElements.length; index += 1) {
    const parsed = parseRssItem(
      itemElements[index],
      index,
      title.value,
      documentUrl,
      languageElements,
    );
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  const unique = uniqueIdentities(items);
  if (!unique.ok) return unique;
  return success(Object.freeze({
    format: /** @type {const} */ ("rss2"),
    source: Object.freeze({
      identityKey: link.value.canonicalUrl,
      identityEvidence: Object.freeze([
        evidence(
          "rss-channel-link",
          link.value.raw,
          link.value.canonicalUrl,
          null,
        ),
      ]),
      title: title.value,
      canonicalUrl: link.value.canonicalUrl,
      publisherLabel: title.value,
      publishedAt: publishedAt.value,
    }),
    items: Object.freeze(items),
  }));
}

/** @param {XmlElement} element @param {number} index @param {string} publisherLabel @param {string} documentUrl @param {readonly XmlElement[]} languageElements @returns {Result<ParsedFeedItem, WorkerFailure>} */
function parseRssItem(
  element,
  index,
  publisherLabel,
  documentUrl,
  languageElements,
) {
  const title = requiredText(element, "title", "title", index);
  if (!title.ok) return title;
  const guidElements = directChildren(element, "guid");
  const linkElements = directChildren(element, "link");
  if (guidElements.length > 1 || linkElements.length > 1) {
    return failure({ kind: "DiscoveryIdentityAmbiguous", itemIndex: index });
  }
  const rawGuid = guidElements.length === 1
    ? normalize(guidElements[0].text)
    : "";
  const rawLink = linkElements.length === 1
    ? normalize(linkElements[0].text)
    : "";
  if (rawGuid === "" && rawLink === "") {
    return failure({ kind: "DiscoveryItemIdentityMissing", itemIndex: index });
  }
  const linkUrl = rawLink === "" ? null : safeHttpsUrl(rawLink, documentUrl);
  const isPermaLink = guidElements.length === 1
    ? guidElements[0].attributes.get("isPermaLink") !== "false"
    : null;
  const guidUrl = rawGuid !== "" && isPermaLink
    ? safeHttpsUrl(rawGuid, documentUrl)
    : null;
  if (
    rawLink !== "" && linkUrl === null ||
    rawGuid !== "" && isPermaLink && guidUrl === null
  ) {
    return failure({
      kind: "DiscoveryItemMalformed",
      itemIndex: index,
      field: "canonicalUrl",
    });
  }
  if (linkUrl !== null && guidUrl !== null && linkUrl !== guidUrl) {
    return failure({ kind: "DiscoveryIdentityConflict", itemIndex: index });
  }
  const canonicalUrl = linkUrl ?? guidUrl;
  if (canonicalUrl === null) {
    return failure({
      kind: "DiscoveryItemMalformed",
      itemIndex: index,
      field: "canonicalUrl",
    });
  }
  const publishedAt = optionalDate(firstText(element, "pubDate"), index);
  if (!publishedAt.ok) return publishedAt;
  /** @type {FeedIdentityEvidence[]} */
  const identityEvidence = [];
  if (rawGuid !== "") {
    identityEvidence.push(evidence("rss-guid", rawGuid, guidUrl, isPermaLink));
  }
  if (rawLink !== "") {
    identityEvidence.push(evidence("rss-link", rawLink, linkUrl, null));
  }
  const podcast = parsePodcastMetadata(element, languageElements, index);
  if (!podcast.ok) return podcast;
  return success(Object.freeze({
    identityKey: rawGuid || canonicalUrl,
    identityEvidence: Object.freeze(identityEvidence),
    title: title.value,
    canonicalUrl,
    publisherLabel,
    publishedAt: publishedAt.value,
    podcast: podcast.value,
  }));
}

/** @param {XmlElement} root @param {string} documentUrl @returns {Result<ParsedFeed, WorkerFailure>} */
function parseAtom(root, documentUrl) {
  const prefix = qualifiedPrefix(root.name);
  const namespaceAttribute = prefix === "" ? "xmlns" : `xmlns:${prefix}`;
  if (root.attributes.get(namespaceAttribute) !== ATOM_NAMESPACE) {
    return failure({ kind: "DiscoveryFormatUnsupported" });
  }
  const childName = (/** @type {string} */ name) =>
    prefix === "" ? name : `${prefix}:${name}`;
  const id = requiredText(root, childName("id"), "identity", null);
  if (!id.ok) return id;
  const title = requiredText(root, childName("title"), "title", null);
  if (!title.ok) return title;
  const link = atomLink(root, childName("link"), documentUrl, null);
  if (!link.ok) return link;
  const publishedAt = optionalDate(firstText(root, childName("updated")), null);
  if (!publishedAt.ok) return publishedAt;
  const entries = directChildren(root, childName("entry"));
  if (entries.length > MAXIMUM_ITEMS) {
    return failure({ kind: "DiscoveryLimitExceeded", limit: "items" });
  }
  /** @type {ParsedFeedItem[]} */
  const items = [];
  for (let index = 0; index < entries.length; index += 1) {
    const parsed = parseAtomItem(
      entries[index],
      index,
      title.value,
      documentUrl,
      childName,
    );
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  const unique = uniqueIdentities(items);
  if (!unique.ok) return unique;
  return success(Object.freeze({
    format: /** @type {const} */ ("atom"),
    source: Object.freeze({
      identityKey: id.value,
      identityEvidence: Object.freeze([
        evidence("atom-id", id.value, null, null),
        evidence("atom-link", link.value.raw, link.value.canonicalUrl, null),
      ]),
      title: title.value,
      canonicalUrl: link.value.canonicalUrl,
      publisherLabel: title.value,
      publishedAt: publishedAt.value,
    }),
    items: Object.freeze(items),
  }));
}

/** @param {XmlElement} element @param {number} index @param {string} publisherLabel @param {string} documentUrl @param {(name: string) => string} childName @returns {Result<ParsedFeedItem, WorkerFailure>} */
function parseAtomItem(element, index, publisherLabel, documentUrl, childName) {
  const id = requiredText(element, childName("id"), "identity", index);
  if (!id.ok) return id;
  const title = requiredText(element, childName("title"), "title", index);
  if (!title.ok) return title;
  const link = atomLink(element, childName("link"), documentUrl, index);
  if (!link.ok) return link;
  const publishedAt = optionalDate(
    firstText(element, childName("published")) ??
      firstText(element, childName("updated")),
    index,
  );
  if (!publishedAt.ok) return publishedAt;
  return success(Object.freeze({
    identityKey: id.value,
    identityEvidence: Object.freeze([
      evidence("atom-id", id.value, null, null),
      evidence("atom-link", link.value.raw, link.value.canonicalUrl, null),
    ]),
    title: title.value,
    canonicalUrl: link.value.canonicalUrl,
    publisherLabel,
    publishedAt: publishedAt.value,
    podcast: null,
  }));
}

/** @param {XmlElement} item @param {readonly XmlElement[]} languageElements @param {number} itemIndex @returns {Result<null | {
 * readonly namespaceUri: string,
 * readonly namespaceContractReference: string,
 * readonly feedLanguageSelector: string | null,
 * readonly transcripts: readonly import("../src/features/discovery/podcast-metadata.js").PodcastTranscriptReference[],
 * readonly enclosure: import("../src/features/discovery/podcast-metadata.js").PodcastEnclosureReference
 * }, WorkerFailure>} */
function parsePodcastMetadata(item, languageElements, itemIndex) {
  const namespaceEvidencePresent = containsPodcastTranscript(item);
  const enclosurePresent = item.children.some((child) =>
    localName(child.name) === "enclosure" && child.namespaceUri === ""
  );
  if (!namespaceEvidencePresent && !enclosurePresent) return success(null);
  if (languageElements.length > 1) {
    return failure({
      kind: "DiscoveryPodcastMetadataMalformed",
      itemIndex,
      field: "feedLanguage",
    });
  }
  const language = normalize(languageElements[0]?.text ?? "");
  const feedLanguage = language === "" ? null : Object.freeze({
    value: language,
    selector: "rss/channel/language",
  });
  const extracted = extractPodcastReferenceSet(
    toPodcastElementPort(item),
    feedLanguage,
    {
      namespaceUri: PODCAST_NAMESPACE,
      maximumTranscripts: MAXIMUM_PODCAST_TRANSCRIPTS,
    },
  );
  if (!extracted.ok) {
    const error = extracted.error;
    if (error.kind === "PodcastTranscriptReferenceInvalid") {
      return failure({
        kind: "DiscoveryPodcastTranscriptReferenceInvalid",
        itemIndex,
        transcriptIndex: error.transcriptIndex,
        field: error.field,
      });
    }
    if (error.kind === "PodcastEnclosureReferenceInvalid") {
      return failure({
        kind: "DiscoveryPodcastEnclosureReferenceInvalid",
        itemIndex,
        field: error.field,
      });
    }
    if (error.kind === "PodcastTranscriptLimitExceeded") {
      return failure({
        kind: "DiscoveryLimitExceeded",
        limit: "podcast-transcripts",
      });
    }
    return failure({
      kind: "DiscoveryPodcastMetadataMalformed",
      itemIndex,
      field: error.kind === "PodcastNamespaceMalformed"
        ? error.field
        : "transcriptSelection",
    });
  }
  return success(Object.freeze({
    namespaceEvidencePresent,
    namespaceUri: namespaceEvidencePresent ? PODCAST_NAMESPACE : null,
    namespaceContractReference: namespaceEvidencePresent
      ? PODCAST_NAMESPACE_CONTRACT
      : null,
    feedLanguageSelector: extracted.value.transcripts.length === 0
      ? null
      : feedLanguage?.selector ?? null,
    transcripts: extracted.value.transcripts,
    enclosure: extracted.value.enclosure,
  }));
}

/** @param {XmlElement} element @returns {boolean} */
function containsPodcastTranscript(element) {
  return element.children.some((child) =>
    (localName(child.name) === "transcript" &&
      child.namespaceUri === PODCAST_NAMESPACE) ||
    containsPodcastTranscript(child)
  );
}

/** @param {XmlElement} element @returns {import("../src/features/discovery/podcast-metadata.js").PodcastXmlElementPort} */
function toPodcastElementPort(element) {
  /** @type {import("../src/features/discovery/podcast-metadata.js").PodcastXmlNodePort[]} */
  const children = element.children.map(toPodcastElementPort);
  if (element.text !== "") {
    children.push(Object.freeze({
      nodeType: 3,
      nodeName: "#text",
      localName: null,
      namespaceURI: null,
      nodeValue: element.text,
      childNodes: Object.freeze([]),
    }));
  }
  return Object.freeze({
    nodeType: 1,
    nodeName: element.name,
    localName: localName(element.name),
    namespaceURI: element.namespaceUri,
    nodeValue: null,
    attributes: Object.freeze(
      [...element.attributes].map(([name, value]) =>
        Object.freeze({
          name,
          localName: localName(name),
          namespaceURI: qualifiedPrefix(name) === "" ? null : "urn:qualified",
          value,
        })
      ),
    ),
    childNodes: Object.freeze(children),
  });
}

/** @param {XmlElement} parent @param {string} name @param {string} field @param {number | null} itemIndex @returns {Result<XmlElement, WorkerFailure>} */
function exactlyOne(parent, name, field, itemIndex) {
  const matches = directChildren(parent, name);
  if (matches.length === 1) return success(matches[0]);
  if (itemIndex !== null && matches.length === 0) {
    return failure({ kind: "DiscoveryItemMalformed", itemIndex, field });
  }
  return matches.length === 0
    ? failure({ kind: "DiscoveryFeedMetadataMissing", field })
    : failure({ kind: "DiscoveryIdentityAmbiguous", itemIndex });
}

/** @param {XmlElement} parent @param {string} name @param {string} field @param {number | null} itemIndex @returns {Result<string, WorkerFailure>} */
function requiredText(parent, name, field, itemIndex) {
  const matches = directChildren(parent, name);
  if (matches.length !== 1) {
    return itemIndex === null
      ? failure({ kind: "DiscoveryFeedMetadataMissing", field })
      : matches.length === 0
      ? failure({ kind: "DiscoveryItemMalformed", itemIndex, field })
      : failure({ kind: "DiscoveryIdentityAmbiguous", itemIndex });
  }
  const value = normalize(matches[0].text);
  return value === ""
    ? itemIndex === null
      ? failure({ kind: "DiscoveryFeedMetadataMissing", field })
      : failure({ kind: "DiscoveryItemMalformed", itemIndex, field })
    : success(value);
}

/** @param {XmlElement} parent @param {string} name @param {string} baseUrl @param {number | null} itemIndex */
function requiredSingleUrl(parent, name, baseUrl, itemIndex) {
  const raw = requiredText(parent, name, "canonicalUrl", itemIndex);
  if (!raw.ok) return raw;
  const canonicalUrl = safeHttpsUrl(raw.value, baseUrl);
  return canonicalUrl === null
    ? itemIndex === null
      ? failure({ kind: "DiscoveryFeedMetadataMissing", field: "canonicalUrl" })
      : failure({
        kind: "DiscoveryItemMalformed",
        itemIndex,
        field: "canonicalUrl",
      })
    : success(Object.freeze({ raw: raw.value, canonicalUrl }));
}

/** @param {XmlElement} parent @param {string} name @param {string} baseUrl @param {number | null} itemIndex */
function atomLink(parent, name, baseUrl, itemIndex) {
  const links = directChildren(parent, name).filter((element) => {
    const rel = element.attributes.get("rel");
    return rel === undefined || rel === "alternate";
  });
  if (links.length !== 1) {
    return itemIndex === null
      ? failure({ kind: "DiscoveryFeedMetadataMissing", field: "canonicalUrl" })
      : links.length === 0
      ? failure({
        kind: "DiscoveryItemMalformed",
        itemIndex,
        field: "canonicalUrl",
      })
      : failure({ kind: "DiscoveryIdentityAmbiguous", itemIndex });
  }
  const raw = normalize(links[0].attributes.get("href") ?? "");
  const canonicalUrl = safeHttpsUrl(raw, baseUrl);
  return canonicalUrl === null
    ? itemIndex === null
      ? failure({ kind: "DiscoveryFeedMetadataMissing", field: "canonicalUrl" })
      : failure({
        kind: "DiscoveryItemMalformed",
        itemIndex,
        field: "canonicalUrl",
      })
    : success(Object.freeze({ raw, canonicalUrl }));
}

/** @param {string | null} value @param {number | null} itemIndex */
function optionalDate(value, itemIndex) {
  if (value === null || normalize(value) === "") return success(null);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? success(new Date(parsed).toISOString())
    : itemIndex === null
    ? failure({ kind: "DiscoveryFeedMetadataMissing", field: "publishedAt" })
    : failure({
      kind: "DiscoveryItemMalformed",
      itemIndex,
      field: "publishedAt",
    });
}

/** @param {readonly ParsedFeedEntity[]} items @returns {Result<true, WorkerFailure>} */
function uniqueIdentities(items) {
  const seen = new Set();
  for (let index = 0; index < items.length; index += 1) {
    if (seen.has(items[index].identityKey)) {
      return failure({ kind: "DiscoveryIdentityConflict", itemIndex: index });
    }
    seen.add(items[index].identityKey);
  }
  return success(true);
}

/** @param {string} documentText @returns {WorkerFailure["kind"] | null} */
function prohibitedConstruct(documentText) {
  const markup = documentText
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (/<!\s*DOCTYPE\b/i.test(markup)) return "DiscoveryDoctypeForbidden";
  if (/<!\s*ENTITY\b/i.test(markup)) return "DiscoveryEntityForbidden";
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(markup)) {
    return "DiscoveryEntityForbidden";
  }
  if (/<\?xml-stylesheet\b/i.test(markup)) {
    return "DiscoveryStylesheetForbidden";
  }
  if (
    new RegExp(XINCLUDE_NAMESPACE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      .test(markup)
  ) {
    return "DiscoveryXIncludeForbidden";
  }
  return null;
}

/** @param {string} source @returns {Result<XmlElement, WorkerFailure>} */
function parseXml(source) {
  /** @type {{ name: string, namespaceUri: string | null, namespaces: Map<string, string>, attributes: Map<string, string>, children: XmlElement[], textParts: string[] }[]} */
  const stack = [];
  /** @type {XmlElement | null} */
  let root = null;
  let index = 0;
  let attributes = 0;
  let textCharacters = 0;
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0) return failure({ kind: "DiscoveryXmlMalformed" });
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      if (end < 0 || stack.length === 0) {
        return failure({ kind: "DiscoveryXmlMalformed" });
      }
      const text = source.slice(index + 9, end);
      textCharacters += text.length;
      if (textCharacters > MAXIMUM_TEXT_CHARACTERS) {
        return failure({ kind: "DiscoveryLimitExceeded", limit: "text" });
      }
      stack[stack.length - 1].textParts.push(text);
      index = end + 3;
      continue;
    }
    if (source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index + 2);
      if (end < 0) return failure({ kind: "DiscoveryXmlMalformed" });
      index = end + 2;
      continue;
    }
    if (source[index] !== "<") {
      const end = source.indexOf("<", index);
      const next = end < 0 ? source.length : end;
      const decoded = decodeXml(source.slice(index, next));
      if (decoded === null) return failure({ kind: "DiscoveryXmlMalformed" });
      textCharacters += decoded.length;
      if (textCharacters > MAXIMUM_TEXT_CHARACTERS) {
        return failure({ kind: "DiscoveryLimitExceeded", limit: "text" });
      }
      if (stack.length > 0) stack[stack.length - 1].textParts.push(decoded);
      else if (decoded.trim() !== "") {
        return failure({ kind: "DiscoveryXmlMalformed" });
      }
      index = next;
      continue;
    }
    const end = tagEnd(source, index + 1);
    if (end < 0) return failure({ kind: "DiscoveryXmlMalformed" });
    const token = source.slice(index + 1, end).trim();
    if (token.startsWith("!")) {
      return failure({ kind: "DiscoveryXmlMalformed" });
    }
    if (token.startsWith("/")) {
      const name = token.slice(1).trim();
      const frame = stack.pop();
      if (frame === undefined || frame.name !== name) {
        return failure({ kind: "DiscoveryXmlMalformed" });
      }
      const element = Object.freeze({
        name: frame.name,
        namespaceUri: frame.namespaceUri,
        attributes:
          /** @type {ReadonlyMap<string, string>} */ (frame.attributes),
        children: Object.freeze(frame.children),
        text: frame.textParts.join(""),
      });
      if (stack.length === 0) {
        if (root !== null) return failure({ kind: "DiscoveryXmlMalformed" });
        root = element;
      } else {
        stack[stack.length - 1].children.push(element);
        stack[stack.length - 1].textParts.push(element.text);
      }
      index = end + 1;
      continue;
    }
    const selfClosing = token.endsWith("/");
    const opening = selfClosing ? token.slice(0, -1).trim() : token;
    const parsedTag = parseOpeningTag(opening);
    if (parsedTag === null) return failure({ kind: "DiscoveryXmlMalformed" });
    attributes += parsedTag.attributes.size;
    if (attributes > MAXIMUM_ATTRIBUTES) {
      return failure({ kind: "DiscoveryLimitExceeded", limit: "attributes" });
    }
    if (
      localName(parsedTag.name).toLowerCase() === "include" &&
      qualifiedPrefix(parsedTag.name) !== ""
    ) {
      return failure({ kind: "DiscoveryXIncludeForbidden" });
    }
    const namespaces = new Map(stack.at(-1)?.namespaces ?? []);
    for (const [name, value] of parsedTag.attributes) {
      if (name === "xmlns") namespaces.set("", value);
      else if (name.startsWith("xmlns:")) {
        namespaces.set(name.slice("xmlns:".length), value);
      }
    }
    const prefix = qualifiedPrefix(parsedTag.name);
    const namespaceUri = namespaces.get(prefix) ?? (prefix === "" ? "" : null);
    stack.push({
      ...parsedTag,
      namespaceUri,
      namespaces,
      children: [],
      textParts: [],
    });
    if (stack.length > MAXIMUM_DEPTH) {
      return failure({ kind: "DiscoveryLimitExceeded", limit: "depth" });
    }
    if (selfClosing) {
      const frame = stack.pop();
      if (frame === undefined) {
        throw new Error("XML parser stack invariant failed.");
      }
      const element = Object.freeze({
        name: frame.name,
        namespaceUri: frame.namespaceUri,
        attributes:
          /** @type {ReadonlyMap<string, string>} */ (frame.attributes),
        children: Object.freeze(frame.children),
        text: "",
      });
      if (stack.length === 0) {
        if (root !== null) return failure({ kind: "DiscoveryXmlMalformed" });
        root = element;
      } else stack[stack.length - 1].children.push(element);
    }
    index = end + 1;
  }
  return stack.length === 0 && root !== null
    ? success(root)
    : failure({ kind: "DiscoveryXmlMalformed" });
}

/** @param {string} source @param {number} start */
function tagEnd(source, start) {
  /** @type {'"' | "'" | null} */
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote === null && (character === '"' || character === "'")) {
      quote = character;
    } else if (quote === character) quote = null;
    else if (quote === null && character === ">") return index;
  }
  return -1;
}

/** @param {string} token */
function parseOpeningTag(token) {
  const nameMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s|$)/.exec(token);
  if (nameMatch === null) return null;
  const name = nameMatch[1];
  const attributes = new Map();
  let rest = token.slice(name.length);
  while (rest.trim() !== "") {
    const match = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/
      .exec(rest);
    if (match === null || attributes.has(match[1])) return null;
    const decoded = decodeXml(match[3] ?? match[4] ?? "");
    if (decoded === null) return null;
    attributes.set(match[1], decoded);
    rest = rest.slice(match[0].length);
  }
  return { name, attributes };
}

/** @param {string} value */
function decodeXml(value) {
  /** @type {string | null} */
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(/&([^;]+);/g)) {
    const prefix = value.slice(cursor, match.index);
    if (prefix.includes("&")) return null;
    result += prefix;
    const entity = match[1];
    const decoded = entity === "amp"
      ? "&"
      : entity === "lt"
      ? "<"
      : entity === "gt"
      ? ">"
      : entity === "quot"
      ? '"'
      : entity === "apos"
      ? "'"
      : numericEntity(entity);
    if (decoded === null) return null;
    result += decoded;
    cursor = (match.index ?? 0) + match[0].length;
  }
  const tail = value.slice(cursor);
  if (tail.includes("&")) return null;
  result += tail;
  return result;
}

/** @param {string} entity */
function numericEntity(entity) {
  const value = entity.startsWith("#x")
    ? Number.parseInt(entity.slice(2), 16)
    : entity.startsWith("#")
    ? Number.parseInt(entity.slice(1), 10)
    : Number.NaN;
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff &&
      !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : null;
}

/** @param {XmlElement} parent @param {string} name */
function directChildren(parent, name) {
  return parent.children.filter((child) => child.name === name);
}

/** @param {XmlElement} parent @param {string} name */
function firstText(parent, name) {
  const matches = directChildren(parent, name);
  return matches.length === 0 ? null : matches[0].text;
}

/** @param {string} name */
function localName(name) {
  const separator = name.indexOf(":");
  return separator < 0 ? name : name.slice(separator + 1);
}

/** @param {string} name */
function qualifiedPrefix(name) {
  const separator = name.indexOf(":");
  return separator < 0 ? "" : name.slice(0, separator);
}

/** @param {string} value */
function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}

/** @param {string} value @param {string} baseUrl */
function safeHttpsUrl(value, baseUrl) {
  if (value === "" || !URL.canParse(value, baseUrl)) return null;
  const validated = validatePublisherDestination(new URL(value, baseUrl).href);
  return validated.ok ? validated.value.href : null;
}

/** @param {FeedIdentityEvidence["kind"]} kind @param {string} value @param {string | null} canonicalUrl @param {boolean | null} isPermaLink */
function evidence(kind, value, canonicalUrl, isPermaLink) {
  return Object.freeze({ kind, value, canonicalUrl, isPermaLink });
}

/** @template T @param {T} value @returns {Result<T, WorkerFailure>} */
function success(value) {
  return { ok: true, value };
}

/** @param {WorkerFailure} error @returns {Result<never, WorkerFailure>} */
function failure(error) {
  return { ok: false, error };
}

export {};
