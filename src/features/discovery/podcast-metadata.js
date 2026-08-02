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
 *   readonly childNodes: ArrayLike<PodcastXmlNodePort>,
 *   readonly attributes?: ArrayLike<PodcastXmlAttributePort>
 * }} PodcastXmlNodePort
 */

/**
 * @typedef {{
 *   readonly name: string,
 *   readonly localName: string | null,
 *   readonly namespaceURI: string | null,
 *   readonly value: string
 * }} PodcastXmlAttributePort
 */

/** @typedef {PodcastXmlNodePort & { readonly nodeType: 1 }} PodcastXmlElementPort */

/**
 * @typedef {{
 *   readonly reference: string,
 *   readonly provenance: string
 * }} PodcastIdentityEvidence
 */

/**
 * @typedef {{
 *   readonly sourceRecordId: string,
 *   readonly itemId: string,
 *   readonly identityEvidence: readonly PodcastIdentityEvidence[],
 *   readonly documentUrl: string,
 *   readonly acquiredAt: string,
 *   readonly documentDigest: string
 * }} PodcastMetadataProvenance
 */

/**
 * @typedef {{
 *   readonly value: string,
 *   readonly selector: string
 * }} AuthoritativeFeedLanguage
 */

/**
 * @typedef {{
 *   readonly url: string,
 *   readonly type: string,
 *   readonly language: string | null,
 *   readonly languageSource: "transcript" | "feed" | null,
 *   readonly rel: string | null,
 *   readonly sourceIndex: number
 * }} PodcastTranscriptReference
 */

/**
 * @typedef {{
 *   readonly url: string,
 *   readonly type: string,
 *   readonly declaredLength: number
 * }} PodcastEnclosureReference
 */

/**
 * @typedef {{
 *   readonly namespaceUri: string,
 *   readonly namespaceContractReference: string,
 *   readonly parserVersion: string,
 *   readonly selectorVersion: string,
 *   readonly selectorReference: string,
 *   readonly selectedTranscriptIndex: number,
 *   readonly feedLanguageSelector: string | null,
 *   readonly transcripts: readonly PodcastTranscriptReference[],
 *   readonly selectedTranscript: PodcastTranscriptReference,
 *   readonly enclosure: PodcastEnclosureReference,
 *   readonly digest: string,
 *   readonly provenance: PodcastMetadataProvenance
 * }} PodcastEpisodeMetadata
 */

/**
 * @typedef {{ readonly kind: "PodcastNamespaceMalformed", readonly field: string }
 * | { readonly kind: "PodcastTranscriptReferenceInvalid", readonly transcriptIndex: number, readonly field: string }
 * | { readonly kind: "PodcastTranscriptLimitExceeded", readonly maximum: number }
 * | { readonly kind: "PodcastTranscriptSelectionUnavailable", readonly reason: "missing" | "no-match" | "ambiguous" | "selector-invalid" }
 * | { readonly kind: "PodcastEnclosureReferenceInvalid", readonly field: string }
 * } PodcastMetadataFailure
 */

/**
 * @typedef {{
 *   readonly version: string,
 *   readonly reference: string,
 *   select(references: readonly PodcastTranscriptReference[]): Result<number, PodcastMetadataFailure>
 * }} TranscriptReferencePolicy
 */

/**
 * @typedef {{
 *   readonly digest: (canonicalMetadata: string) => Promise<Result<string, PodcastMetadataFailure>>
 * }} PodcastMetadataDigest
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

export class PodcastNamespaceExtractor {
  /** @type {string} */
  #namespaceUri;
  /** @type {string} */
  #namespaceContractReference;
  /** @type {string} */
  #parserVersion;
  /** @type {TranscriptReferencePolicy} */
  #transcriptPolicy;
  /** @type {PodcastMetadataDigest["digest"]} */
  #digest;

  /**
   * @param {{
   *   readonly namespaceUri: string,
   *   readonly namespaceContractReference: string,
   *   readonly parserVersion: string,
   *   readonly transcriptPolicy: TranscriptReferencePolicy,
   *   readonly digest: PodcastMetadataDigest["digest"]
   * }} dependencies
   */
  constructor(dependencies) {
    if (!validDependencies(dependencies)) {
      throw new TypeError(
        "Podcast namespace extractor dependencies are invalid.",
      );
    }
    this.#namespaceUri = dependencies.namespaceUri;
    this.#namespaceContractReference = dependencies.namespaceContractReference;
    this.#parserVersion = dependencies.parserVersion;
    this.#transcriptPolicy = dependencies.transcriptPolicy;
    this.#digest = dependencies.digest;
  }

  /**
   * Extracts bounded reference metadata from one already-parsed RSS item.
   * This boundary never dereferences any retained URL.
   *
   * @param {unknown} itemInput
   * @param {{
   *   readonly feedLanguage: AuthoritativeFeedLanguage | null,
   *   readonly provenance: PodcastMetadataProvenance
   * }} contextInput
   * @returns {Promise<Result<PodcastEpisodeMetadata, PodcastMetadataFailure>>}
   */
  async extract(itemInput, contextInput) {
    const item = parseItemElement(itemInput);
    if (!item.ok) return item;
    const context = parseContext(contextInput);
    if (!context.ok) return context;

    const referenceSet = extractReferenceSet(
      item.value,
      context.value.feedLanguage,
      this.#namespaceUri,
      Number.MAX_SAFE_INTEGER,
    );
    if (!referenceSet.ok) return referenceSet;
    const transcripts = referenceSet.value.transcripts;

    const selected = this.#transcriptPolicy.select(freeze(transcripts));
    if (!selected.ok) return selected;
    if (
      !Number.isSafeInteger(selected.value) || selected.value < 0 ||
      selected.value >= transcripts.length
    ) {
      return failure({
        kind: "PodcastTranscriptSelectionUnavailable",
        reason: "selector-invalid",
      });
    }

    const canonicalMetadata = JSON.stringify({
      enclosure: referenceSet.value.enclosure,
      namespaceUri: this.#namespaceUri,
      parserVersion: this.#parserVersion,
      selectedTranscriptIndex: selected.value,
      selectorReference: this.#transcriptPolicy.reference,
      selectorVersion: this.#transcriptPolicy.version,
      transcripts,
    });
    const digest = await this.#digest(canonicalMetadata);
    if (!digest.ok) return digest;
    if (!nonEmptyText(digest.value)) {
      return failure({ kind: "PodcastNamespaceMalformed", field: "digest" });
    }

    return success(freeze({
      namespaceUri: this.#namespaceUri,
      namespaceContractReference: this.#namespaceContractReference,
      parserVersion: this.#parserVersion,
      selectorVersion: this.#transcriptPolicy.version,
      selectorReference: this.#transcriptPolicy.reference,
      selectedTranscriptIndex: selected.value,
      feedLanguageSelector: context.value.feedLanguage?.selector ?? null,
      transcripts: freeze(transcripts),
      selectedTranscript: transcripts[selected.value],
      enclosure: referenceSet.value.enclosure,
      digest: digest.value,
      provenance: context.value.provenance,
    }));
  }
}

/**
 * Extracts reference metadata without dereferencing the transcript or media.
 * Namespace identity and the output bound are explicit caller contracts.
 *
 * @param {unknown} itemInput
 * @param {AuthoritativeFeedLanguage | null} feedLanguageInput
 * @param {{ readonly namespaceUri: string, readonly maximumTranscripts: number }} configuration
 * @returns {Result<{
 *   readonly transcripts: readonly PodcastTranscriptReference[],
 *   readonly enclosure: PodcastEnclosureReference
 * }, PodcastMetadataFailure>}
 */
export function extractPodcastReferenceSet(
  itemInput,
  feedLanguageInput,
  configuration,
) {
  const item = parseItemElement(itemInput);
  if (!item.ok) return item;
  const feedLanguage = parseFeedLanguage(feedLanguageInput);
  if (!feedLanguage.ok) return feedLanguage;
  if (
    configuration === null || typeof configuration !== "object" ||
    canonicalHttpsUrl(configuration.namespaceUri) === null ||
    !Number.isSafeInteger(configuration.maximumTranscripts) ||
    configuration.maximumTranscripts < 1
  ) {
    throw new TypeError("Podcast reference configuration is invalid.");
  }
  return extractReferenceSet(
    item.value,
    feedLanguage.value,
    configuration.namespaceUri,
    configuration.maximumTranscripts,
  );
}

/**
 * @param {PodcastXmlElementPort} item
 * @param {AuthoritativeFeedLanguage | null} feedLanguage
 * @param {string} namespaceUri
 * @param {number} maximumTranscripts
 * @returns {Result<{
 *   readonly transcripts: readonly PodcastTranscriptReference[],
 *   readonly enclosure: PodcastEnclosureReference
 * }, PodcastMetadataFailure>}
 */
function extractReferenceSet(
  item,
  feedLanguage,
  namespaceUri,
  maximumTranscripts,
) {
  const structure = inspectNamespaceStructure(item, namespaceUri);
  if (!structure.ok) return structure;
  if (structure.value.transcripts.length > maximumTranscripts) {
    return failure({
      kind: "PodcastTranscriptLimitExceeded",
      maximum: maximumTranscripts,
    });
  }
  /** @type {PodcastTranscriptReference[]} */
  const transcripts = [];
  for (
    let index = 0;
    index < structure.value.transcripts.length;
    index += 1
  ) {
    const parsed = parseTranscript(
      structure.value.transcripts[index],
      index,
      feedLanguage,
    );
    if (!parsed.ok) return parsed;
    transcripts.push(parsed.value);
  }
  const enclosure = parseEnclosure(structure.value.enclosures);
  if (!enclosure.ok) return enclosure;
  return success(freeze({
    transcripts: freeze(transcripts),
    enclosure: enclosure.value,
  }));
}

/**
 * Creates a selector from injected, source-attributed preferences. Media types
 * remain open-ended rather than being encoded in discovery logic.
 *
 * @param {{
 *   readonly version: string,
 *   readonly reference: string,
 *   readonly preferredTypes: readonly string[],
 *   readonly preferredLanguage: string | null,
 *   readonly preferredRel: string | null
 * }} configuration
 * @returns {TranscriptReferencePolicy}
 */
export function createTranscriptReferencePolicy(configuration) {
  if (
    configuration === null || typeof configuration !== "object" ||
    !nonEmptyText(configuration.version) ||
    canonicalHttpsUrl(configuration.reference) === null ||
    !Array.isArray(configuration.preferredTypes) ||
    configuration.preferredTypes.length === 0 ||
    !configuration.preferredTypes.every(validMediaType) ||
    !optionalLanguage(configuration.preferredLanguage) ||
    !optionalToken(configuration.preferredRel)
  ) {
    throw new TypeError(
      "Transcript reference policy configuration is invalid.",
    );
  }
  const preferredTypes = freeze(
    configuration.preferredTypes.map((type) => type.trim().toLowerCase()),
  );
  const preferredLanguage = normalizeOptionalLanguage(
    configuration.preferredLanguage,
  );
  const preferredRel = normalizeOptionalToken(configuration.preferredRel);

  return freeze({
    version: configuration.version,
    reference: configuration.reference,
    /** @param {readonly PodcastTranscriptReference[]} references */
    select(references) {
      if (references.length === 0) {
        return failure({
          kind: "PodcastTranscriptSelectionUnavailable",
          reason: "missing",
        });
      }
      for (const type of preferredTypes) {
        const matches = references.filter((reference) =>
          reference.type === type &&
          (preferredLanguage === null ||
            reference.language === preferredLanguage) &&
          (preferredRel === null || reference.rel === preferredRel)
        );
        if (matches.length === 1) return success(matches[0].sourceIndex);
        if (matches.length > 1) {
          return failure({
            kind: "PodcastTranscriptSelectionUnavailable",
            reason: "ambiguous",
          });
        }
      }
      return failure({
        kind: "PodcastTranscriptSelectionUnavailable",
        reason: "no-match",
      });
    },
  });
}

/**
 * @param {PodcastXmlElementPort} item
 * @param {string} namespaceUri
 * @returns {Result<{
 *   readonly transcripts: PodcastXmlElementPort[],
 *   readonly enclosures: PodcastXmlElementPort[]
 * }, PodcastMetadataFailure>}
 */
function inspectNamespaceStructure(item, namespaceUri) {
  const children = arrayFrom(item.childNodes);
  if (children === null) {
    return failure({ kind: "PodcastNamespaceMalformed", field: "item" });
  }
  /** @type {PodcastXmlElementPort[]} */
  const transcripts = [];
  /** @type {PodcastXmlElementPort[]} */
  const enclosures = [];
  /** @type {PodcastXmlNodePort[]} */
  const descendants = [...children];
  while (descendants.length > 0) {
    const current = descendants.shift();
    if (current === undefined) break;
    if (isElement(current)) {
      if (
        localName(current) === "transcript" &&
        namespace(current) === namespaceUri
      ) {
        if (!children.includes(current)) {
          return failure({
            kind: "PodcastNamespaceMalformed",
            field: "transcript.parent",
          });
        }
        transcripts.push(current);
      }
      if (
        localName(current) === "enclosure" && namespace(current) === "" &&
        children.includes(current)
      ) {
        enclosures.push(current);
      }
    }
    const nested = arrayFrom(current.childNodes);
    if (nested === null) {
      return failure({ kind: "PodcastNamespaceMalformed", field: "item" });
    }
    descendants.push(...nested);
  }
  return success({ transcripts, enclosures });
}

/**
 * @param {PodcastXmlElementPort} element
 * @param {number} transcriptIndex
 * @param {AuthoritativeFeedLanguage | null} feedLanguage
 * @returns {Result<PodcastTranscriptReference, PodcastMetadataFailure>}
 */
function parseTranscript(element, transcriptIndex, feedLanguage) {
  if (!emptyElement(element)) {
    return failure({
      kind: "PodcastNamespaceMalformed",
      field: `transcripts[${transcriptIndex}].content`,
    });
  }
  const url = singleAttribute(element, "url");
  if (!url.ok || url.value === null) {
    return transcriptInvalid(transcriptIndex, "url");
  }
  const canonicalUrl = canonicalHttpsUrl(url.value);
  if (canonicalUrl === null) return transcriptInvalid(transcriptIndex, "url");

  const type = singleAttribute(element, "type");
  if (!type.ok || type.value === null || !validMediaType(type.value)) {
    return transcriptInvalid(transcriptIndex, "type");
  }
  const languageAttribute = singleAttribute(element, "language");
  if (!languageAttribute.ok) {
    return transcriptInvalid(transcriptIndex, "language");
  }
  if (!optionalLanguage(languageAttribute.value)) {
    return transcriptInvalid(transcriptIndex, "language");
  }
  const rel = singleAttribute(element, "rel");
  if (!rel.ok || !optionalToken(rel.value)) {
    return transcriptInvalid(transcriptIndex, "rel");
  }

  const ownLanguage = normalizeOptionalLanguage(languageAttribute.value);
  return success(freeze({
    url: canonicalUrl,
    type: type.value.trim().toLowerCase(),
    language: ownLanguage ?? feedLanguage?.value ?? null,
    languageSource: ownLanguage === null
      ? feedLanguage === null ? null : /** @type {const} */ ("feed")
      : /** @type {const} */ ("transcript"),
    rel: normalizeOptionalToken(rel.value),
    sourceIndex: transcriptIndex,
  }));
}

/**
 * @param {PodcastXmlElementPort[]} enclosures
 * @returns {Result<PodcastEnclosureReference, PodcastMetadataFailure>}
 */
function parseEnclosure(enclosures) {
  if (enclosures.length !== 1) {
    return enclosureInvalid("count");
  }
  const enclosure = enclosures[0];
  if (!emptyElement(enclosure)) return enclosureInvalid("content");

  const url = singleAttribute(enclosure, "url");
  if (!url.ok || url.value === null) return enclosureInvalid("url");
  const canonicalUrl = canonicalHttpsUrl(url.value);
  if (canonicalUrl === null) return enclosureInvalid("url");

  const type = singleAttribute(enclosure, "type");
  if (!type.ok || type.value === null || !validMediaType(type.value)) {
    return enclosureInvalid("type");
  }
  const length = singleAttribute(enclosure, "length");
  if (
    !length.ok || length.value === null || !/^\d+$/.test(length.value) ||
    !Number.isSafeInteger(Number(length.value))
  ) {
    return enclosureInvalid("length");
  }
  return success(freeze({
    url: canonicalUrl,
    type: type.value.trim().toLowerCase(),
    declaredLength: Number(length.value),
  }));
}

/**
 * @param {unknown} value
 * @returns {Result<PodcastXmlElementPort, PodcastMetadataFailure>}
 */
function parseItemElement(value) {
  if (
    !isElement(value) || localName(value) !== "item" || namespace(value) !== ""
  ) {
    return failure({ kind: "PodcastNamespaceMalformed", field: "item" });
  }
  return success(value);
}

/**
 * @param {unknown} value
 * @returns {Result<{
 *   readonly feedLanguage: AuthoritativeFeedLanguage | null,
 *   readonly provenance: PodcastMetadataProvenance
 * }, PodcastMetadataFailure>}
 */
function parseContext(value) {
  if (value === null || typeof value !== "object") {
    return failure({ kind: "PodcastNamespaceMalformed", field: "context" });
  }
  const context = /** @type {Record<string, unknown>} */ (value);
  const provenance = parseProvenance(context.provenance);
  if (!provenance.ok) return provenance;
  const feedLanguage = parseFeedLanguage(context.feedLanguage);
  if (!feedLanguage.ok) return feedLanguage;
  return success(freeze({
    feedLanguage: feedLanguage.value,
    provenance: provenance.value,
  }));
}

/**
 * @param {unknown} value
 * @returns {Result<PodcastMetadataProvenance, PodcastMetadataFailure>}
 */
function parseProvenance(value) {
  if (value === null || typeof value !== "object") {
    return failure({ kind: "PodcastNamespaceMalformed", field: "provenance" });
  }
  const provenance = /** @type {Record<string, unknown>} */ (value);
  if (
    !nonEmptyText(provenance.sourceRecordId) ||
    !nonEmptyText(provenance.itemId) ||
    !Array.isArray(provenance.identityEvidence) ||
    provenance.identityEvidence.length === 0 ||
    !provenance.identityEvidence.every(validIdentityEvidence) ||
    canonicalHttpsUrl(provenance.documentUrl) === null ||
    !nonEmptyText(provenance.acquiredAt) ||
    !Number.isFinite(Date.parse(provenance.acquiredAt)) ||
    !nonEmptyText(provenance.documentDigest)
  ) {
    return failure({ kind: "PodcastNamespaceMalformed", field: "provenance" });
  }
  return success(freeze({
    sourceRecordId: provenance.sourceRecordId,
    itemId: provenance.itemId,
    identityEvidence: freeze(
      provenance.identityEvidence.map((evidence) =>
        freeze({
          reference: evidence.reference,
          provenance: evidence.provenance,
        })
      ),
    ),
    documentUrl: canonicalHttpsUrl(provenance.documentUrl) ?? "",
    acquiredAt: new Date(provenance.acquiredAt).toISOString(),
    documentDigest: provenance.documentDigest,
  }));
}

/**
 * @param {unknown} value
 * @returns {Result<AuthoritativeFeedLanguage | null, PodcastMetadataFailure>}
 */
function parseFeedLanguage(value) {
  if (value === null) return success(null);
  if (value === null || typeof value !== "object") {
    return failure({
      kind: "PodcastNamespaceMalformed",
      field: "feedLanguage",
    });
  }
  const language = /** @type {Record<string, unknown>} */ (value);
  if (!validLanguage(language.value) || !nonEmptyText(language.selector)) {
    return failure({
      kind: "PodcastNamespaceMalformed",
      field: "feedLanguage",
    });
  }
  return success(freeze({
    value: normalizeLanguage(language.value),
    selector: language.selector,
  }));
}

/**
 * @param {PodcastXmlElementPort} element
 * @param {string} name
 * @returns {Result<string | null, PodcastMetadataFailure>}
 */
function singleAttribute(element, name) {
  const attributes = arrayFrom(element.attributes);
  if (attributes === null) {
    return failure({ kind: "PodcastNamespaceMalformed", field: "attributes" });
  }
  const matches = attributes.filter((attribute) =>
    (attribute.localName ?? attribute.name) === name &&
    (attribute.namespaceURI ?? "") === ""
  );
  if (matches.length > 1) {
    return failure({ kind: "PodcastNamespaceMalformed", field: name });
  }
  return success(matches[0]?.value ?? null);
}

/** @param {PodcastXmlElementPort} element */
function emptyElement(element) {
  const children = arrayFrom(element.childNodes);
  if (children === null) return false;
  return children.every((node) =>
    (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) &&
    (node.nodeValue ?? "").trim() === ""
  );
}

/** @param {unknown} value */
function canonicalHttpsUrl(value) {
  if (!nonEmptyText(value) || !URL.canParse(value)) return null;
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" || parsed.username !== "" ||
    parsed.password !== ""
  ) return null;
  parsed.hash = "";
  return parsed.href;
}

/** @param {unknown} value @returns {value is PodcastXmlElementPort} */
function isElement(value) {
  return isNode(value) && value.nodeType === ELEMENT_NODE;
}

/** @param {unknown} value @returns {value is PodcastXmlNodePort} */
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

/** @param {PodcastXmlNodePort} node */
function localName(node) {
  return node.localName ?? node.nodeName.split(":").at(-1) ?? node.nodeName;
}

/** @param {PodcastXmlNodePort} node */
function namespace(node) {
  return node.namespaceURI ?? "";
}

/** @template T @param {ArrayLike<T> | undefined} value @returns {T[] | null} */
function arrayFrom(value) {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object") return null;
  try {
    return Array.from(value);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/** @param {unknown} value */
function validDependencies(value) {
  if (value === null || typeof value !== "object") return false;
  const dependencies = /** @type {Record<string, unknown>} */ (value);
  return canonicalHttpsUrl(dependencies.namespaceUri) !== null &&
    canonicalHttpsUrl(dependencies.namespaceContractReference) !== null &&
    nonEmptyText(dependencies.parserVersion) &&
    validTranscriptPolicy(dependencies.transcriptPolicy) &&
    typeof dependencies.digest === "function";
}

/** @param {unknown} value @returns {value is TranscriptReferencePolicy} */
function validTranscriptPolicy(value) {
  if (value === null || typeof value !== "object") return false;
  const policy = /** @type {Record<string, unknown>} */ (value);
  return nonEmptyText(policy.version) &&
    canonicalHttpsUrl(policy.reference) !== null &&
    typeof policy.select === "function";
}

/** @param {unknown} value @returns {value is PodcastIdentityEvidence} */
function validIdentityEvidence(value) {
  if (value === null || typeof value !== "object") return false;
  const evidence = /** @type {Record<string, unknown>} */ (value);
  return nonEmptyText(evidence.reference) && nonEmptyText(evidence.provenance);
}

/** @param {unknown} value @returns {value is string} */
function nonEmptyText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value */
function validMediaType(value) {
  return nonEmptyText(value) &&
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(
      value.trim(),
    );
}

/** @param {unknown} value */
function validLanguage(value) {
  if (!nonEmptyText(value)) return false;
  try {
    new Intl.Locale(value);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** @param {unknown} value */
function optionalLanguage(value) {
  return value === null || value === undefined || value === "" ||
    validLanguage(value);
}

/** @param {unknown} value */
function normalizeLanguage(value) {
  if (typeof value !== "string") {
    throw new TypeError("A validated language must be a string.");
  }
  return new Intl.Locale(value).toString().toLowerCase();
}

/** @param {unknown} value */
function normalizeOptionalLanguage(value) {
  return value === null || value === undefined || value === ""
    ? null
    : normalizeLanguage(value);
}

/** @param {unknown} value */
function optionalToken(value) {
  return value === null || value === undefined || value === "" ||
    (nonEmptyText(value) && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.trim()));
}

/** @param {unknown} value */
function normalizeOptionalToken(value) {
  return value === null || value === undefined || value === ""
    ? null
    : String(value).trim().toLowerCase();
}

/**
 * @param {number} transcriptIndex
 * @param {string} field
 * @returns {Result<never, PodcastMetadataFailure>}
 */
function transcriptInvalid(transcriptIndex, field) {
  return failure({
    kind: /** @type {const} */ ("PodcastTranscriptReferenceInvalid"),
    transcriptIndex,
    field,
  });
}

/**
 * @param {string} field
 * @returns {Result<never, PodcastMetadataFailure>}
 */
function enclosureInvalid(field) {
  return failure({
    kind: /** @type {const} */ ("PodcastEnclosureReferenceInvalid"),
    field,
  });
}

/** @template T @param {T} value */
function success(value) {
  return /** @type {const} */ ({ ok: true, value });
}

/** @template E @param {E} error */
function failure(error) {
  return /** @type {const} */ ({ ok: false, error });
}
