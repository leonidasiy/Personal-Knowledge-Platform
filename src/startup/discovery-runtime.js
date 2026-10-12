// @ts-check

const freeze = Object.freeze;

export { renderDiscoverRoute } from "../routes/discover.js";

/** @typedef {{readonly sourceId:string,readonly authoritativeIdentity:string,readonly identityEvidence:readonly {readonly reference:string,readonly provenance:string}[],readonly adapterId:string,readonly adapterVersion:string,readonly submittedUrl:string,readonly canonicalUrl:string}} GatewayRssSource */
/** @typedef {{readonly itemId:string,readonly identityEvidence:readonly {readonly reference:string,readonly provenance:string}[],readonly title:string,readonly canonicalUrl:string,readonly contentDigest:string,readonly publisherLabel:string|null,readonly publishedAt:string|null,readonly podcast:null|{readonly transcripts:readonly unknown[],readonly enclosure:unknown},readonly expiresAt?:string|null}} GatewayRssItem */
/** @typedef {{readonly status:"acquired",readonly source:GatewayRssSource,readonly items:readonly GatewayRssItem[],readonly retrievedAt:string}|{readonly status:"not-modified",readonly submittedUrl:string,readonly canonicalUrl:string,readonly retrievedAt:string}} GatewayRssResult */
/** @import { PersistenceEnvelope, PersistenceFailure, RecordKind } from "../persistence/contracts.js" */
/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{appendBatch(records:readonly PersistenceEnvelope[]):Promise<Result<readonly PersistenceEnvelope[],PersistenceFailure>>,list(ownerId:string,kind:RecordKind):Promise<Result<readonly PersistenceEnvelope[],PersistenceFailure>>}} DiscoveryPersistence */
/** @typedef {{encode(value:DiscoveryCursor):Result<string,RuntimeFailure>,decode(token:string):Result<unknown,RuntimeFailure>}} CursorCodec */
/** @typedef {{readonly ownerId:string,readonly kind:"discovery-inbox",readonly revision:number,readonly offset:number,readonly limit:number}} DiscoveryCursor */
/** @typedef {{readonly kind:"DiscoveryRuntimeCommandInvalid",readonly field:string}|{readonly kind:"DiscoveryRuntimeNotLoaded"}|{readonly kind:"DiscoveryRuntimeRecordInvalid",readonly recordKind:string,readonly recordId:string}|{readonly kind:"DiscoveryRuntimeSelectedItemUnknown",readonly itemId:string}|{readonly kind:"DiscoveryRuntimeClockUnavailable"}|{readonly kind:"DiscoveryRuntimeIdUnavailable"}|{readonly kind:"DiscoveryStarterInventoryInvalid",readonly field:string}|{readonly kind:"DiscoveryPageCursorInvalid",readonly reason:string}} DiscoveryRuntimeFailure */
/** @typedef {DiscoveryRuntimeFailure|PersistenceFailure} RuntimeFailure */
/** @typedef {{readonly sourceId:string,readonly adapterId:string,readonly adapterVersion:string,readonly authoritativeIdentity:string,readonly identityEvidence:readonly Evidence[],readonly canonicalUrl:string}} YouTubeSourceContract */
/** @typedef {{readonly reference:string,readonly provenance:string}} Evidence */
/** @typedef {{readonly id:string,readonly ownerId:string,readonly identity:string,readonly evidence:readonly Evidence[],readonly adapterId:string,readonly adapterVersion:string,readonly submittedUrl:string,readonly canonicalUrl:string,readonly observedAt:string}} SourceRecord */
/** @typedef {{readonly id:string,readonly ownerId:string,readonly sourceId:string,readonly version:number,readonly identityEvidence:readonly Evidence[],readonly title:string,readonly canonicalUrl:string,readonly contentDigest:string,readonly publisherLabel:string|null,readonly publishedAt:string|null,readonly podcastReferenceLabel:string|null,readonly expiresAt:string|null,readonly observedAt:string}} ItemRecord */
/** @typedef {{readonly sources:Map<string,SourceRecord>,readonly items:Map<string,ItemRecord>,readonly revision:number}} Snapshot */
/** @typedef {{readonly itemId:string,readonly itemVersion:number,readonly title:string,readonly publisherLabel:string|null,readonly observedAt:string,readonly canonicalUrl:string,readonly contentDigest:string,readonly publishedAt:string|null,readonly identityEvidence:readonly Evidence[],readonly source:SourceRecord,readonly podcastReferenceLabel:string|null}} InboxItem */
/** @typedef {{readonly page:{readonly items:readonly InboxItem[],readonly nextCursor:string|null},readonly selectedItem:InboxItem|null,readonly online:boolean}} DiscoveryRenderModel */
/** @typedef {{readonly itemVersions:readonly ItemRecord[]}} DiscoveryImportResult */
/** @typedef {{readonly source:GatewayRssSource,readonly items:readonly GatewayRssItem[],readonly sessionSeed:string}} StarterInventory */

const KINDS = /** @type {const} */ ([
  "discovery_source",
  "discovery_item_version",
]);
const PAGE_SIZE = 20;

/** @param {{readonly ownerId:string,readonly persistence:DiscoveryPersistence,readonly clock:{now():Result<string,DiscoveryRuntimeFailure>},readonly createId:()=>string,readonly cursorCodec:CursorCodec,readonly starterInventory:StarterInventory}} dependencies */
export function createDiscoveryRuntime(dependencies) {
  return new DiscoveryRuntime(dependencies);
}

/** @param {DiscoveryRenderModel} model @param {(value:string)=>string} escapeHtml */
export function toDiscoverRouteModel(model, escapeHtml) {
  if (typeof escapeHtml !== "function") {
    throw new TypeError("Invalid escape");
  }
  const items = model.page.items.map((item) => {
    const youtube = isYouTube(item.canonicalUrl);
    const itemGranularity = youtube || item.source.evidence.length > 1;
    const canonicalUrl = itemGranularity
      ? item.canonicalUrl
      : item.source.canonicalUrl;
    const evidence = itemGranularity
      ? item.identityEvidence
      : item.source.evidence;
    return freeze({
      id: item.itemId,
      version: item.itemVersion,
      title: item.title,
      sourceLabel: item.publisherLabel ?? "Public source",
      observedAtLabel: item.observedAt,
      rightsLabel: "Not assessed",
      provenanceLabel: item.canonicalUrl,
      sourceUrl: item.canonicalUrl,
      evidenceStatus: /** @type {const} */ ("link-only"),
      youtubeWatchUrl: youtube ? item.canonicalUrl : null,
      podcastReferenceLabel: item.podcastReferenceLabel,
      candidate: freeze({
        submittedUrl: itemGranularity
          ? item.canonicalUrl
          : item.source.submittedUrl,
        canonicalUrl,
        canonicalIdentity: canonicalUrl,
        title: item.publisherLabel ?? item.title,
        description: `Found via ${item.title}.`,
        adapter: freeze({
          id: item.source.adapterId,
          version: item.source.adapterVersion,
          granularity: youtube
            ? "individual-video"
            : itemGranularity
            ? "attributed-resource"
            : "publisher-root",
          capabilities: freeze(
            youtube
              ? ["metadata", "manual-transcript"]
              : ["metadata", "bounded-ingestion"],
          ),
        }),
        identityEvidence: freeze(evidence.map((entry) =>
          freeze({
            attribute: "discovery-identity",
            value: entry.reference,
            provenanceUrl: URL.canParse(entry.reference) &&
                new URL(entry.reference).protocol === "https:"
              ? entry.reference
              : canonicalUrl,
            observedAt: item.observedAt,
          })
        )),
        initialItem: itemGranularity
          ? freeze({
            itemId: item.itemId,
            versionId: String(item.itemVersion),
            canonicalUrl: item.canonicalUrl,
            title: item.title,
            description: `Metadata captured from ${
              item.publisherLabel ?? "the attributed provider"
            }.`,
            contentDigest: item.contentDigest,
            provenance: freeze([{
              method: "provider-metadata",
              reference: item.canonicalUrl,
            }]),
            observedAt: item.observedAt,
            publishedAt: item.publishedAt,
          })
          : null,
      }),
    });
  });
  return freeze({
    state: model.online
      ? items.length
        ? /** @type {const} */ ("success")
        : /** @type {const} */ ("empty")
      : /** @type {const} */ ("offline"),
    stateMessage: model.online
      ? null
      : "Saved recommendations remain available offline.",
    page: model.selectedItem
      ? /** @type {const} */ ("detail")
      : /** @type {const} */ ("list"),
    items: freeze(items),
    selectedItemId: model.selectedItem?.itemId ?? null,
    maxVisibleItems: PAGE_SIZE,
    areas: freeze([]),
    pendingId: null,
    canAct: false,
    search: freeze({
      query: "",
      limit: 10,
      capabilities: freeze([]),
      selectedProviderIds: freeze([]),
      available: false,
    }),
    escapeHtml,
  });
}

export class DiscoveryRuntime {
  /** @type {string} */ #owner;
  /** @type {DiscoveryPersistence} */ #persistence;
  /** @type {{now():Result<string,DiscoveryRuntimeFailure>}} */ #clock;
  /** @type {()=>string} */ #createId;
  /** @type {CursorCodec} */ #cursor;
  /** @type {unknown} */ #starter;
  /** @type {Map<string,number>} */ #starterOrder = new Map();
  /** @type {Snapshot|null} */ #snapshot = null;
  /** @type {Promise<Result<true,RuntimeFailure>>|null} */ #loading = null;

  /** @param {{readonly ownerId:string,readonly persistence:DiscoveryPersistence,readonly clock:{now():Result<string,DiscoveryRuntimeFailure>},readonly createId:()=>string,readonly cursorCodec:CursorCodec,readonly starterInventory:unknown}} dependencies */
  constructor(dependencies) {
    if (
      !text(dependencies?.ownerId) ||
      typeof dependencies.persistence?.appendBatch !== "function" ||
      typeof dependencies.persistence?.list !== "function" ||
      typeof dependencies.clock?.now !== "function" ||
      typeof dependencies.createId !== "function" ||
      typeof dependencies.cursorCodec?.encode !== "function" ||
      typeof dependencies.cursorCodec?.decode !== "function"
    ) {
      throw new TypeError("Invalid dependencies.");
    }
    this.#owner = dependencies.ownerId;
    this.#persistence = dependencies.persistence;
    this.#clock = dependencies.clock;
    this.#createId = dependencies.createId;
    this.#cursor = dependencies.cursorCodec;
    this.#starter = dependencies.starterInventory;
  }

  /** @returns {Promise<Result<true,RuntimeFailure>>} */
  async load() {
    if (this.#loading !== null) return this.#loading;
    this.#loading = (async () => {
      const restored = await this.#restore();
      if (!restored.ok) return restored;
      this.#snapshot = restored.value;
      const starters = starterInventory(this.#starter);
      if (!starters.ok) {
        return latestItems(restored.value).size === 0
          ? starters
          : { ok: true, value: true };
      }
      this.#starterOrder = starterOrder(
        starters.value.items,
        starters.value.sessionSeed,
      );
      if (latestItems(restored.value).size === 0) {
        const now = this.#now();
        if (!now.ok) return now;
        const seeded = await this.#import(
          starters.value.source,
          starters.value.items,
          now.value,
        );
        if (!seeded.ok) {
          if (seeded.error.kind !== "PersistenceDuplicate") return seeded;
          const raced = await this.#restore();
          if (!raced.ok) return raced;
          const source = raced.value.sources.get(
            starters.value.source.sourceId,
          );
          if (
            source?.identity !== starters.value.source.authoritativeIdentity ||
            ![...latestItems(raced.value).values()].some((item) =>
              item.sourceId === source.id
            )
          ) return seeded;
          this.#snapshot = raced.value;
        }
      }
      return { ok: /** @type {const} */ (true), value: true };
    })();
    const result = await this.#loading;
    this.#loading = null;
    return result;
  }

  /** @param {unknown} route @returns {Result<DiscoveryRenderModel,RuntimeFailure>} */
  renderModel(route) {
    const snapshot = this.#snapshot;
    if (snapshot === null) {
      return {
        ok: /** @type {const} */ (false),
        error: { kind: /** @type {const} */ ("DiscoveryRuntimeNotLoaded") },
      };
    }
    if (
      !record(route) || route.name !== "discover" ||
      typeof route.online !== "boolean" ||
      (route.cursor !== null && typeof route.cursor !== "string") ||
      (route.selectedItemId !== null && !text(route.selectedItemId)) ||
      (route.starterOnly !== undefined && typeof route.starterOnly !== "boolean")
    ) return invalid("route");
    let offset = 0;
    if (typeof route.cursor === "string") {
      const decoded = this.#cursor.decode(route.cursor);
      if (!decoded.ok) return decoded;
      if (!cursorValue(decoded.value, this.#owner, snapshot.revision)) {
        return {
          ok: false,
          error: {
            kind: "DiscoveryPageCursorInvalid",
            reason: "tampered-or-stale",
          },
        };
      }
      offset = decoded.value.offset;
    }
    const current = this.#now();
    if (!current.ok) return current;
    /** @type {Map<string,ItemRecord>} */ const canonical = new Map();
    for (const item of latestItems(snapshot).values()) {
      if (
        isYouTube(item.canonicalUrl) &&
        (item.expiresAt === null ||
          Date.parse(item.expiresAt) <= Date.parse(current.value))
      ) continue;
      const prior = canonical.get(item.canonicalUrl);
      if (
        prior === undefined || prior.observedAt < item.observedAt ||
        (prior.observedAt === item.observedAt && item.id < prior.id)
      ) canonical.set(item.canonicalUrl, item);
    }
    const starterOnly = route.starterOnly === true;
    const all = [...canonical.values()].filter((item) =>
      !starterOnly || this.#starterOrder.has(item.canonicalUrl)
    ).sort((a, b) => {
      const aStarter = this.#starterOrder.get(a.canonicalUrl);
      const bStarter = this.#starterOrder.get(b.canonicalUrl);
      if (aStarter === undefined && bStarter !== undefined) return -1;
      if (aStarter !== undefined && bStarter === undefined) return 1;
      if (aStarter !== undefined && bStarter !== undefined) {
        return aStarter - bStarter;
      }
      return b.observedAt.localeCompare(a.observedAt) ||
        a.id.localeCompare(b.id);
    });
    const visible = all.slice(offset, offset + PAGE_SIZE).map((item) =>
      project(item, snapshot)
    );
    let nextCursor = null;
    if (offset + PAGE_SIZE < all.length) {
      const encoded = this.#cursor.encode({
        ownerId: this.#owner,
        kind: "discovery-inbox",
        revision: snapshot.revision,
        offset: offset + PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      if (!encoded.ok) return encoded;
      nextCursor = encoded.value;
    }
    const selected = route.selectedItemId === null
      ? null
      : visible.find((item) => item.itemId === route.selectedItemId) ?? null;
    if (route.selectedItemId !== null && selected === null) {
      return {
        ok: false,
        error: {
          kind: "DiscoveryRuntimeSelectedItemUnknown",
          itemId: route.selectedItemId,
        },
      };
    }
    return {
      ok: true,
      value: freeze({
        page: freeze({ items: freeze(visible), nextCursor }),
        selectedItem: selected,
        online: route.online,
      }),
    };
  }

  /** @param {GatewayRssSource} incoming @param {readonly GatewayRssItem[]} incomingItems @param {string} observedAt */
  async #import(incoming, incomingItems, observedAt) {
    const snapshot = this.#snapshot;
    if (snapshot === null) {
      return {
        ok: /** @type {const} */ (false),
        error: { kind: /** @type {const} */ ("DiscoveryRuntimeNotLoaded") },
      };
    }
    let source = [...snapshot.sources.values()].find((entry) =>
      entry.identity === incoming.authoritativeIdentity
    );
    /** @type {PersistenceEnvelope[]} */ const envelopes = [];
    if (!source) {
      source = freeze({
        id: incoming.sourceId,
        ownerId: this.#owner,
        identity: incoming.authoritativeIdentity,
        evidence: incoming.identityEvidence,
        adapterId: incoming.adapterId,
        adapterVersion: incoming.adapterVersion,
        submittedUrl: incoming.submittedUrl,
        canonicalUrl: incoming.canonicalUrl,
        observedAt,
      });
      envelopes.push(envelope("discovery_source", source, observedAt));
    }
    const latest = latestItems(snapshot);
    /** @type {ItemRecord[]} */ const itemVersions = [];
    for (const incomingItem of incomingItems) {
      const id = `${source.id}|${incomingItem.itemId}`;
      const prior = latest.get(id);
      let item = prior;
      if (!prior || prior.contentDigest !== incomingItem.contentDigest) {
        const podcastReferenceLabel = podcastLabel(incomingItem.podcast);
        if (podcastReferenceLabel === undefined) {
          return invalid("podcast");
        }
        /** @type {string|null} */ let expiresAt = null;
        if ("expiresAt" in incomingItem) {
          if (
            typeof incomingItem.expiresAt !== "string" ||
            !instant(incomingItem.expiresAt)
          ) return invalid("expiresAt");
          expiresAt = incomingItem.expiresAt;
        }
        item = freeze({
          id,
          ownerId: this.#owner,
          sourceId: source.id,
          version: (prior?.version ?? 0) + 1,
          identityEvidence: incomingItem.identityEvidence,
          title: incomingItem.title,
          canonicalUrl: incomingItem.canonicalUrl,
          contentDigest: incomingItem.contentDigest,
          publisherLabel: incomingItem.publisherLabel,
          publishedAt: incomingItem.publishedAt,
          podcastReferenceLabel,
          expiresAt,
          observedAt,
        });
        envelopes.push(envelope("discovery_item_version", item, observedAt));
      }
      itemVersions.push(/** @type {ItemRecord} */ (item));
    }
    return this.#commit(
      envelopes,
      freeze({ itemVersions: freeze(itemVersions) }),
    );
  }

  /** @template T @param {readonly PersistenceEnvelope[]} records @param {T} value @returns {Promise<Result<T,RuntimeFailure>>} */
  async #commit(records, value) {
    const saved = await this.#persistence.appendBatch(records);
    if (!saved.ok) return saved;
    const restored = await this.#restore();
    if (!restored.ok) return restored;
    this.#snapshot = restored.value;
    return { ok: true, value };
  }

  /** @returns {Promise<Result<Snapshot,RuntimeFailure>>} */
  async #restore() {
    /** @type {Map<string,SourceRecord>} */ const sources = new Map();
    /** @type {Map<string,ItemRecord>} */ const items = new Map();
    /** @type {Map<string,unknown>[]} */ const maps = [sources, items];
    for (let index = 0; index < KINDS.length; index += 1) {
      const listed = await this.#persistence.list(this.#owner, KINDS[index]);
      if (!listed.ok) return listed;
      for (const entry of listed.value) {
        const parsed = payload(entry, this.#owner, KINDS[index]);
        if (!parsed.ok) return parsed;
        maps[index].set(recordId(KINDS[index], parsed.value), parsed.value);
      }
    }
    for (const item of items.values()) {
      if (!sources.has(item.sourceId)) {
        return corrupt("discovery_item_version", item.id);
      }
    }
    return {
      ok: true,
      value: {
        sources,
        items,
        revision: items.size,
      },
    };
  }

  /** @returns {Result<string,DiscoveryRuntimeFailure>} */
  #id() {
    const value = this.#createId();
    return text(value)
      ? { ok: true, value }
      : { ok: false, error: { kind: "DiscoveryRuntimeIdUnavailable" } };
  }
  /** @returns {Result<string,DiscoveryRuntimeFailure>} */
  #now() {
    const result = this.#clock.now();
    return result.ok && instant(result.value)
      ? result
      : { ok: false, error: { kind: "DiscoveryRuntimeClockUnavailable" } };
  }
}

/** @param {ItemRecord} item @param {Snapshot} snapshot @returns {InboxItem} */
function project(item, snapshot) {
  const source = snapshot.sources.get(item.sourceId);
  if (source === undefined) {
    throw new TypeError("Missing item source");
  }
  return freeze({
    itemId: item.id,
    itemVersion: item.version,
    title: item.title,
    publisherLabel: item.publisherLabel,
    observedAt: item.observedAt,
    canonicalUrl: item.canonicalUrl,
    contentDigest: item.contentDigest,
    publishedAt: item.publishedAt,
    identityEvidence: item.identityEvidence,
    source,
    podcastReferenceLabel: item.podcastReferenceLabel,
  });
}

/** @param {Snapshot} snapshot */
function latestItems(snapshot) {
  /** @type {Map<string,ItemRecord>} */ const latest = new Map();
  for (const item of snapshot.items.values()) {
    if ((latest.get(item.id)?.version ?? 0) < item.version) {
      latest.set(item.id, item);
    }
  }
  return latest;
}

/** @param {(typeof KINDS)[number]} kind @param {SourceRecord|ItemRecord} value @param {string} recordedAt */
function envelope(kind, value, recordedAt) {
  const id = recordId(kind, value);
  return freeze({
    id: `${kind}:${id}`,
    ownerId: value.ownerId,
    kind,
    payloadJson: JSON.stringify(value),
    recordedAt,
  });
}

/** @param {PersistenceEnvelope} entry @param {string} owner @param {(typeof KINDS)[number]} kind @returns {Result<SourceRecord|ItemRecord,DiscoveryRuntimeFailure>} */
function payload(entry, owner, kind) {
  if (
    entry.ownerId !== owner || entry.kind !== kind || !text(entry.id) ||
    !instant(entry.recordedAt)
  ) return corrupt(kind, entry.id);
  /** @type {unknown} */ let value;
  try {
    value = JSON.parse(entry.payloadJson);
  } catch (error) {
    if (error instanceof SyntaxError) return corrupt(kind, entry.id);
    throw error;
  }
  if (
    kind === "discovery_item_version" && record(value) &&
    !("podcastReferenceLabel" in value) && "podcast" in value
  ) {
    const podcastReferenceLabel = podcastLabel(value.podcast);
    if (podcastReferenceLabel === undefined) return corrupt(kind, entry.id);
    const { podcast: _, ...legacy } = value;
    value = { ...legacy, podcastReferenceLabel, expiresAt: null };
  } else if (
    kind === "discovery_item_version" && record(value) &&
    !("expiresAt" in value)
  ) {
    value = { ...value, expiresAt: null };
  }
  if (!validPayload(value, owner, kind)) return corrupt(kind, entry.id);
  const expected = `${kind}:${recordId(kind, value)}`;
  return entry.id === expected ? { ok: true, value } : corrupt(kind, entry.id);
}

/** @param {unknown} value @param {string} owner @param {(typeof KINDS)[number]} kind @returns {value is SourceRecord|ItemRecord} */
function validPayload(value, owner, kind) {
  if (
    !record(value) || value.ownerId !== owner ||
    Object.keys(value).length !== SCHEMA_SIZES[kind]
  ) return false;
  if (!text(value.id)) return false;
  if (kind === "discovery_source") {
    return text(value.identity) && evidence(value.evidence) &&
      text(value.adapterId) && text(value.adapterVersion) &&
      secure(value.submittedUrl) && secure(value.canonicalUrl) &&
      instant(value.observedAt);
  }
  if (kind === "discovery_item_version") {
    return text(value.sourceId) && positive(value.version) &&
      evidence(value.identityEvidence) && text(value.title) &&
      secure(value.canonicalUrl) && text(value.contentDigest) &&
      nullableText(value.publisherLabel) &&
      nullableInstant(value.publishedAt) &&
      nullableText(value.podcastReferenceLabel) &&
      (typeof value.canonicalUrl === "string" && isYouTube(value.canonicalUrl)
        ? nullableInstant(value.expiresAt)
        : value.expiresAt === null) &&
      instant(value.observedAt);
  }
  return false;
}

const SCHEMA_SIZES = freeze({
  discovery_source: 9,
  discovery_item_version: 13,
});

/** @param {unknown} value @param {string} owner @param {number} revision @returns {value is DiscoveryCursor} */
function cursorValue(value, owner, revision) {
  return record(value) &&
    Object.keys(value).length === 5 &&
    value.ownerId === owner && value.kind === "discovery-inbox" &&
    value.revision === revision && Number.isInteger(value.offset) &&
    typeof value.offset === "number" && value.offset >= 0 &&
    value.limit === PAGE_SIZE;
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string" && value.trim() !== "";
}
/** @param {unknown} value */
function positive(value) {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}
/** @param {unknown} value */
function instant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
/** @param {unknown} value */
function secure(value) {
  return typeof value === "string" && URL.canParse(value) &&
    new URL(value).protocol === "https:";
}
/** @param {unknown} value */
function nullableText(value) {
  return value === null || text(value);
}
/** @param {unknown} value */
function nullableInstant(value) {
  return value === null || instant(value);
}
/** @param {unknown} value */
function evidence(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 10 &&
    value.every((entry) =>
      record(entry) && Object.keys(entry).length === 2 &&
      text(entry.reference) && text(entry.provenance)
    );
}
/** @param {unknown} value */
function podcastLabel(value) {
  if (value === null) return null;
  if (
    !record(value) || !Array.isArray(value.transcripts) ||
    value.transcripts.length > 16 ||
    !value.transcripts.every((entry) => record(entry) && secure(entry.url)) ||
    !record(value.enclosure) || !secure(value.enclosure.url)
  ) return undefined;
  const count = value.transcripts.length;
  return `${count} publisher transcript reference${
    count === 1 ? "" : "s"
  }; enclosure available`;
}
/** @param {unknown} value @returns {Result<StarterInventory,DiscoveryRuntimeFailure>} */
function starterInventory(value) {
  if (!record(value)) return invalidStarter("inventory");
  if (Object.keys(value).length !== 3) {
    return invalidStarter("inventory");
  }
  if (!text(value.sessionSeed) || !starterSource(value.source)) {
    return invalidStarter(!text(value.sessionSeed) ? "sessionSeed" : "source");
  }
  if (
    !Array.isArray(value.items) || value.items.length < 1 ||
    value.items.length > PAGE_SIZE || !value.items.every(starterItem)
  ) return invalidStarter("items");
  const ids = new Set(value.items.map((item) => item.itemId));
  const urls = new Set(value.items.map((item) => item.canonicalUrl));
  if (ids.size !== value.items.length || urls.size !== value.items.length) {
    return invalidStarter("items");
  }
  return {
    ok: true,
    value: /** @type {StarterInventory} */ (value),
  };
}
/** @param {unknown} value */
function starterSource(value) {
  return record(value) && Object.keys(value).length === 7 &&
    text(value.sourceId) && text(value.authoritativeIdentity) &&
    evidence(value.identityEvidence) && text(value.adapterId) &&
    text(value.adapterVersion) && secure(value.submittedUrl) &&
    secure(value.canonicalUrl);
}
/** @param {unknown} value */
function starterItem(value) {
  return record(value) && Object.keys(value).length === 8 &&
    text(value.itemId) && evidence(value.identityEvidence) &&
    text(value.title) && secure(value.canonicalUrl) &&
    text(value.contentDigest) && text(value.publisherLabel) &&
    nullableInstant(value.publishedAt) &&
    podcastLabel(value.podcast) !== undefined;
}
/** @param {readonly GatewayRssItem[]} items @param {string} seed */
function starterOrder(items, seed) {
  const ordered = [...items].sort((a, b) => {
    const difference = stableHash(`${seed}\u0000${a.canonicalUrl}`) -
      stableHash(`${seed}\u0000${b.canonicalUrl}`);
    return difference || a.canonicalUrl.localeCompare(b.canonicalUrl);
  });
  return new Map(ordered.map((item, index) => [item.canonicalUrl, index]));
}
/** @param {string} value */
function stableHash(value) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
/** @param {unknown} value */
/** @param {string} value */
function isYouTube(value) {
  const host = new URL(value).hostname.toLowerCase();
  return host === "youtube.com" || host.endsWith(".youtube.com") ||
    host === "youtu.be";
}
/** @param {(typeof KINDS)[number]} kind @param {SourceRecord|ItemRecord} value */
function recordId(kind, value) {
  return kind === "discovery_item_version"
    ? `${/** @type {ItemRecord} */ (value).id}:${
      /** @type {ItemRecord} */ (value).version
    }`
    : /** @type {SourceRecord} */ (value).id;
}
/** @param {string} field @returns {Result<never,DiscoveryRuntimeFailure>} */
function invalid(field) {
  return {
    ok: false,
    error: { kind: "DiscoveryRuntimeCommandInvalid", field },
  };
}
/** @param {string} kind @param {string} id @returns {Result<never,DiscoveryRuntimeFailure>} */
function corrupt(kind, id) {
  return {
    ok: false,
    error: {
      kind: "DiscoveryRuntimeRecordInvalid",
      recordKind: kind,
      recordId: id,
    },
  };
}
/** @param {string} field @returns {Result<never,DiscoveryRuntimeFailure>} */
function invalidStarter(field) {
  return {
    ok: false,
    error: { kind: "DiscoveryStarterInventoryInvalid", field },
  };
}

export {};
