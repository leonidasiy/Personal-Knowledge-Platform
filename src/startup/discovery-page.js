// @ts-check

const freeze = Object.freeze;

import {
  createDiscoveryRuntime,
  renderDiscoverRoute,
  toDiscoverRouteModel,
} from "./discovery-runtime.js";
import { SourceLibraryGatewayClient } from "../features/source-library/gateway.js";
import { DiscoverySearchGatewayClient } from "../features/discovery/gateway.js";
import {
  createYouTubeConnectionController,
  friendlyDiscoveryFailure,
} from "./youtube-connection.js";

/** @import { PersistenceEnvelope, PersistenceFailure, RecordKind } from "../persistence/contracts.js" */
/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{appendBatch(records:readonly PersistenceEnvelope[]):Promise<Result<readonly PersistenceEnvelope[],PersistenceFailure>>,list(ownerId:string,kind:RecordKind):Promise<Result<readonly PersistenceEnvelope[],PersistenceFailure>>}} DiscoveryPersistence */

/**
 * @param {{readonly ownerId:string,readonly persistence:DiscoveryPersistence,readonly fetch:typeof fetch,readonly gatewayBaseUrl:string,readonly policyStorage:{readonly getItem:(key:string)=>string|null,readonly setItem:(key:string,value:string)=>void},readonly starterInventory:unknown,readonly markup:import("../routes/discover.js").DiscoverMarkup,readonly escapeHtml:(value:string)=>string,readonly createId:()=>string,readonly now:()=>string,readonly onNotice:(message:string)=>void,readonly onError:(message:string)=>void,readonly navigateToLibrary:(sourceId:string)=>void,readonly rerender:()=>void}} dependencies
 */
export function createDiscoveryPage(dependencies) {
  if (
    typeof dependencies.ownerId !== "string" ||
    dependencies.ownerId.trim() === "" ||
    typeof dependencies.persistence?.appendBatch !== "function" ||
    typeof dependencies.persistence?.list !== "function" ||
    typeof dependencies.fetch !== "function" ||
    !URL.canParse(dependencies.gatewayBaseUrl) ||
    typeof dependencies.policyStorage?.getItem !== "function" ||
    typeof dependencies.policyStorage?.setItem !== "function" ||
    typeof dependencies.escapeHtml !== "function" ||
    typeof dependencies.createId !== "function" ||
    typeof dependencies.now !== "function" ||
    typeof dependencies.onNotice !== "function" ||
    typeof dependencies.onError !== "function" ||
    typeof dependencies.navigateToLibrary !== "function" ||
    typeof dependencies.rerender !== "function"
  ) throw new TypeError("Discovery page dependencies are invalid.");
  const {
    createId,
    fetch: requestFetch,
    gatewayBaseUrl,
    navigateToLibrary,
    now,
    policyStorage,
  } = dependencies;
  const markup = dependencies.markup;
  const escapeHtml = dependencies.escapeHtml;
  const onNotice = dependencies.onNotice;
  const onError = dependencies.onError;
  const rerender = dependencies.rerender;
  const issued = new Map();
  const sessionSeed = createId();
  const runtime = createDiscoveryRuntime({
    ownerId: dependencies.ownerId,
    persistence: dependencies.persistence,
    clock: freeze({
      now: () => ({
        ok: /** @type {const} */ (true),
        value: now(),
      }),
    }),
    createId,
    cursorCodec: freeze({
      encode: (cursor) => {
        const token = createId();
        issued.set(token, cursor);
        return { ok: true, value: token };
      },
      decode: (token) => {
        const cursor = issued.get(token);
        return cursor === undefined
          ? {
            ok: false,
            error: {
              kind: /** @type {const} */ ("DiscoveryPageCursorInvalid"),
              reason: "unknown-or-tampered",
            },
          }
          : { ok: true, value: cursor };
      },
    }),
    starterInventory:
      /** @type {Parameters<typeof createDiscoveryRuntime>[0]["starterInventory"]} */ (
        withSessionSeed(dependencies.starterInventory, sessionSeed)
      ),
  });
  const sourceLibrary = new SourceLibraryGatewayClient({
    fetch: requestFetch,
    baseUrl: gatewayBaseUrl,
    timeoutMs: 15_000,
  });
  const centralGateway = new DiscoverySearchGatewayClient({
    fetch: requestFetch,
    baseUrl: gatewayBaseUrl,
    timeoutMs: 15_000,
  });
  const youtubeConnection = createYouTubeConnectionController({
    storage: policyStorage,
    now,
    markup,
    onNotice,
    onError,
    rerender,
  });
  let searchPending = false;
  let searchInitialized = false;
  let searchGeneration = 0;
  /** @type {import("../features/discovery/gateway.js").GatewaySearchCapability[]} */ let searchCapabilities = [];
  /** @type {import("../routes/discover.js").DiscoverRouteItem[]|null} */ let centralRouteItems = null;
  /** @type {string|null} */ let searchFailure = null;
  let searchQuery = "";
  let searchLimit = 10;
  /** @type {string[]} */ let selectedProviderIds = [];
  /** @type {string | null} */ let pendingDecisionItemId = null;
  /** @type {import("../features/source-library/contracts.js").SourceInterestArea[]} */ let interestAreas =
    [];
  /** @type {Map<string, import("../routes/discover.js").DiscoverRouteItem>} */ const routeItems =
    new Map();
  /** @type {Set<string>} */ const suppressed = new Set();
  let sourceActionsAvailable = false;
  return freeze({
    async load() {
      const youtubePolicy = youtubeConnection.load();
      if (!youtubePolicy.ok) {
        onError("YouTube policy preference could not be read.");
      }
      const [loaded, capabilities, areas] = await Promise.all([
        runtime.load(),
        centralGateway.capabilities(),
        sourceLibrary.browse({ limit: 1 }),
      ]);
      if (capabilities.ok) {
        searchCapabilities = [...capabilities.value];
        if (!searchInitialized) {
          selectedProviderIds = searchCapabilities.filter((provider) =>
            provider.enabled
          ).map((provider) => provider.id);
          searchFailure = null;
        }
      } else if (!searchInitialized) {
        searchFailure = friendlyDiscoveryFailure(
          capabilities.error,
          markup,
        );
      }
      if (areas.ok) {
        interestAreas = [...areas.value.interestAreas];
        sourceActionsAvailable = true;
      }
      if (loaded.ok && sourceActionsAvailable) await syncSuppressions();
      return loaded;
    },
    /** @param {{readonly selectedItemId:string|null,readonly online:boolean}} route */
    render(route) {
      if (searchPending) return loading(escapeHtml, markup);
      const projected = runtime.renderModel({
        name: "discover",
        cursor: null,
        selectedItemId: route.selectedItemId,
        online: route.online,
        starterOnly: route.online && centralRouteItems === null,
      });

      if (projected.ok) {
        return renderItems(projected.value, route, centralRouteItems);
      }

      if (
        projected.error.kind === "DiscoveryRuntimeSelectedItemUnknown" &&
        route.selectedItemId !== null
      ) {
        const list = runtime.renderModel({
          name: "discover",
          cursor: null,
          selectedItemId: null,
          online: route.online,
          starterOnly: route.online && centralRouteItems === null,
        });

        if (list.ok) {
          return renderItems(list.value, route, centralRouteItems);
        }
      }
      return renderDiscoverRoute({
        ...emptyRoute(escapeHtml, markup),
        state: "error",
        stateMessage: friendlyDiscoveryFailure(
          projected.error,
          markup,
        ),
        markup,
        search: searchModel(route.online),
      });
    },
    /** @param {ParentNode} root */
    bind(root) {
      youtubeConnection.bind(root);
      const searchForm = root.querySelector("[data-discovery-search-form]");
      searchForm?.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          if (!(event.currentTarget instanceof HTMLFormElement)) return;
          const form = new FormData(event.currentTarget);
          const query = form.get("query");
          const providerIds = form.getAll("provider").filter((value) =>
            typeof value === "string"
          );
          const limit = Number(form.get("limit"));
          if (typeof query === "string") {
            void search({ query, providerIds, limit });
          }
        },
      );
      searchForm?.setAttribute("data-discovery-search-bound", "true");
      root.querySelectorAll("[data-discovery-approve]").forEach((element) =>
        element.addEventListener("submit", (event) => {
          event.preventDefault();
          if (!(event.currentTarget instanceof HTMLFormElement)) return;
          const itemId = event.currentTarget.getAttribute(
            "data-discovery-approve",
          );
          const areaId = new FormData(event.currentTarget).get("interest-area");
          if (itemId !== null && typeof areaId === "string") {
            void approve(itemId, areaId);
          }
        })
      );
      root.querySelectorAll("[data-discovery-reject]").forEach((element) =>
        element.addEventListener("click", () => {
          const itemId = element.getAttribute("data-discovery-reject");
          if (itemId !== null) void reject(itemId);
        })
      );
      root.querySelectorAll("[data-discovery-upload]").forEach((element) =>
        element.addEventListener("submit", (event) => {
          event.preventDefault();
          if (!(event.currentTarget instanceof HTMLFormElement)) return;
          const itemId = event.currentTarget.getAttribute(
            "data-discovery-upload",
          );
          const data = new FormData(event.currentTarget);
          const areaId = data.get("interest-area");
          const fileValue = data.get("material");
          const file = fileValue instanceof File && fileValue.size > 0
            ? fileValue
            : null;
          const contentValue = data.get("content");
          const content = typeof contentValue === "string" &&
              contentValue.trim() !== ""
            ? contentValue
            : null;
          const attested = data.get("rights-attestation") === "on";
          if (
            itemId !== null && typeof areaId === "string" &&
            (file !== null || content !== null)
          ) {
            void approveAndUpload(itemId, areaId, file, content, attested);
          }
        })
      );
    },
    search,
    approve,
    reject,
  });

  /**
   * Render one stable item projection. Central search results are intentionally
   * kept in memory until the user approves them, so they must remain the
   * source of truth while a result detail is open.
   *
   * @param {import("./discovery-runtime.js").DiscoveryRenderModel} projected
   * @param {{readonly selectedItemId:string|null,readonly online:boolean}} route
   * @param {import("../routes/discover.js").DiscoverRouteItem[]|null} liveItems
   */
  function renderItems(projected, route, liveItems) {
    const projectedModel = toDiscoverRouteModel(
      projected,
      escapeHtml,
    );
    const visibleItems = liveItems ?? [...projectedModel.items];
    const items = visibleItems.filter((item) =>
      !suppressed.has(item.candidate.canonicalIdentity)
    );
    routeItems.clear();
    for (const item of items) routeItems.set(item.id, item);
    return renderDiscoverRoute(
      freeze({
        ...projectedModel,
        page: route.selectedItemId !== null
          ? /** @type {const} */ ("detail")
          : /** @type {const} */ ("list"),
        items: freeze(items),
        state: route.online
          ? searchFailure === null
            ? items.length === 0
              ? /** @type {const} */ ("empty")
              : /** @type {const} */ ("success")
            : /** @type {const} */ ("partial")
          : projectedModel.state,
        stateMessage: route.online
          ? searchFailure
          : projectedModel.stateMessage,
        selectedItemId: route.selectedItemId,
        areas: freeze(
          interestAreas.map((area) =>
            freeze({ id: area.id, title: area.title })
          ),
        ),
        pendingId: pendingDecisionItemId,
        canAct: sourceActionsAvailable && route.online,
        search: searchModel(route.online),
        markup,
      }),
    );
  }

  /** @param {unknown} command */
  async function search(command) {
    const stagedCommand = searchCommand(command);
    const generation = ++searchGeneration;
    if (
      stagedCommand !== null && stagedCommand.providerIds.includes("youtube") &&
      !youtubeConnection.isAccepted()
    ) {
      searchInitialized = true;
      searchQuery = stagedCommand.query;
      selectedProviderIds = [...stagedCommand.providerIds];
      searchLimit = stagedCommand.limit;
      const failure = { kind: /** @type {const} */ ("YouTubePolicyAcceptanceRequired") };
      searchFailure = friendlyDiscoveryFailure(failure, markup);
      onError(searchFailure);
      rerender();
      return { ok: false, error: failure };
    }
    if (stagedCommand !== null && !searchInitialized) {
      searchInitialized = true;
      searchQuery = stagedCommand.query;
      selectedProviderIds = [...stagedCommand.providerIds];
      searchLimit = stagedCommand.limit;
    }
    searchPending = true;
    rerender();
    const result = await centralGateway.search(command);
    if (generation !== searchGeneration) {
      return {
        ok: false,
        error: { kind: /** @type {const} */ ("DiscoverySearchSuperseded") },
      };
    }
    searchPending = false;
    if (!result.ok) {
      searchFailure = friendlyDiscoveryFailure(result.error, markup);
      onError(searchFailure);
      rerender();
      return result;
    }
    searchQuery = result.value.submittedQuery;
    if (stagedCommand !== null) {
      selectedProviderIds = [...stagedCommand.providerIds];
      searchLimit = stagedCommand.limit;
    }
    centralRouteItems = result.value.items.map((item) =>
      centralRouteItem(item, result.value.policyVersion)
    );
    searchFailure = result.value.providerFailures.length === 0
      ? null
      : "Some selected source types could not be searched. Available results are shown.";
    if (sourceActionsAvailable) {
      await syncIdentities(centralRouteItems.map((item) =>
        item.candidate.canonicalIdentity
      ), generation);
    }
    if (generation !== searchGeneration) {
      return {
        ok: false,
        error: { kind: /** @type {const} */ ("DiscoverySearchSuperseded") },
      };
    }
    rerender();
    return result;
  }

  /** @param {string} itemId @param {string} areaId */
  async function approve(itemId, areaId) {
    if (pendingDecisionItemId !== null) return;
    const item = routeItems.get(itemId);
    if (
      item === undefined ||
      !interestAreas.some((area) => area.id === areaId)
    ) {
      onError(markup.sourceAreaRequired);
      rerender();
      return;
    }
    pendingDecisionItemId = item.id;
    rerender();
    const result = await sourceLibrary.approve({
      ...item.candidate,
      identityStatus: "resolved",
      interestAreaIds: [areaId],
      idempotencyKey: `approve:${createId()}`,
    });
    pendingDecisionItemId = null;
    if (!result.ok) {
      onError(friendlySource(result.error, markup));
    } else {
      onNotice(
        result.value.reused
          ? markup.sourceAlreadyAdded
          : markup.sourceAdded,
      );
      navigateToLibrary(result.value.source.id);
    }
    rerender();
  }

  /** @param {string} itemId @param {string} areaId @param {File | null} file @param {string | null} content @param {boolean} attested */
  async function approveAndUpload(itemId, areaId, file, content, attested) {
    if (pendingDecisionItemId !== null) return;
    const item = routeItems.get(itemId);
    if (
      item === undefined || !attested || (file === null && content === null) ||
      !interestAreas.some((area) => area.id === areaId)
    ) {
      onError(markup.uploadRequired);
      rerender();
      return;
    }
    pendingDecisionItemId = item.id;
    rerender();
    const approved = await sourceLibrary.approve({
      ...item.candidate,
      identityStatus: "resolved",
      interestAreaIds: [areaId],
      idempotencyKey: `approve:${createId()}`,
    });
    if (!approved.ok) {
      pendingDecisionItemId = null;
      onError(friendlySource(approved.error, markup));
      rerender();
      return;
    }
    if (approved.value.workflow === null) {
      pendingDecisionItemId = null;
      onError(markup.uploadStoreFailed);
      rerender();
      return;
    }
    const uploaded = await sourceLibrary.uploadWorkflowMaterial({
      runId: approved.value.workflow.runId,
      sourceId: approved.value.source.id,
      sourceRevision: approved.value.source.revision,
      sourceUrl: approved.value.source.canonicalUrl,
      mediaType: file === null ? "text/plain" : materialMediaType(file),
      fileName: file === null ? "paste.txt" : file.name,
      rightsAttestation: {
        ownsOrPermitted: true,
        storageAllowed: true,
        transformationAllowed: true,
        processingAllowed: true,
        basis: "learner-attested lawful copy",
        reference: `learner-attestation:${now()}`,
      },
      idempotencyKey: `workflow-material:${createId()}`,
      ...(file === null ? { content } : { file }),
    });
    pendingDecisionItemId = null;
    if (!uploaded.ok) {
      onError(markup.uploadStoreFailed);
    } else {
      onNotice(markup.uploadStored);
      navigateToLibrary(approved.value.source.id);
    }
    rerender();
  }

  /** @param {File} file @returns {string} */
  function materialMediaType(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf")) return "application/pdf";
    if (name.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    if (name.endsWith(".md")) return "text/markdown";
    if (name.endsWith(".vtt")) return "text/plain";
    return file.type.startsWith("text/") ? "text/plain" : file.type || "text/plain";
  }

  /** @param {string} itemId */
  async function reject(itemId) {
    if (pendingDecisionItemId !== null) return;
    const item = routeItems.get(itemId);
    if (item === undefined) return;
    pendingDecisionItemId = item.id;
    rerender();
    const result = await sourceLibrary.reject({
      canonicalIdentity: item.candidate.canonicalIdentity,
      identityEvidence: item.candidate.identityEvidence,
      idempotencyKey: `reject:${createId()}`,
    });
    pendingDecisionItemId = null;
    if (!result.ok) {
      onError(friendlySource(result.error, markup));
    } else {
      suppressed.add(item.candidate.canonicalIdentity);
      onNotice(markup.sourceRejected);
    }
    rerender();
  }

  async function syncSuppressions() {
    const projected = runtime.renderModel({
      name: "discover",
      cursor: null,
      selectedItemId: null,
      online: true,
    });
    if (!projected.ok) return;
    const identities = [
      ...new Set(
        toDiscoverRouteModel(projected.value, escapeHtml).items
          .map((item) => item.candidate.canonicalIdentity),
      ),
    ];
    await syncIdentities(identities);
  }

  /** @param {readonly string[]} identities @param {number|null} [generation] */
  async function syncIdentities(identities, generation = null) {
    if (identities.length === 0) return;
    const checked = await sourceLibrary.suppressed(identities);
    if (generation !== null && generation !== searchGeneration) return;
    if (!checked.ok) {
      sourceActionsAvailable = false;
      return;
    }
    for (const identity of checked.value) suppressed.add(identity);
  }

  /** @param {boolean} online */
  function searchModel(online) {
    return freeze({
      query: searchQuery,
      limit: searchLimit,
      capabilities: freeze([...searchCapabilities]),
      selectedProviderIds: freeze([...selectedProviderIds]),
      available: online && searchCapabilities.some((provider) => provider.enabled),
    });
  }

  /** @param {import("../features/discovery/gateway.js").GatewayCentralCandidate} item @param {string} policyVersion */
  function centralRouteItem(item, policyVersion) {
    const observedAt = now();
    const providerId = item.providerId;
    const canonicalUrl = item.canonicalUrl;
    const provider = searchCapabilities.find((entry) => entry.id === providerId);
    const youtube = item.sourceLevel === "video";
    const feed = item.sourceLevel === "feed";
    const id = createId();
    const retainedTitle = youtube ? "Saved YouTube video" : feed ? "Saved podcast feed" : item.title;
    const retainedDescription = youtube
      ? "Saved video link. Upload a permitted transcript to create learning material."
      : feed
      ? "Saved podcast feed link. Review eligibility and rights before acquiring material."
      : item.description ?? "The provider did not supply a description.";
    return freeze({
      id,
      version: 1,
      title: item.title,
      sourceLabel: item.publisherLabel ?? provider?.label ?? item.resultKind,
      observedAtLabel: observedAt,
      rightsLabel: "Not assessed",
      provenanceLabel: canonicalUrl,
      sourceUrl: canonicalUrl,
      evidenceStatus: /** @type {const} */ ("link-only"),
      youtubeWatchUrl: youtube ? item.canonicalUrl : null,
      podcastReferenceLabel: null,
      candidate: freeze({
        submittedUrl: canonicalUrl,
        canonicalUrl,
        canonicalIdentity: canonicalUrl,
        title: retainedTitle,
        description: retainedDescription,
        adapter: freeze({
          id: `central-search:${providerId}`,
          version: policyVersion,
          granularity: item.sourceLevel,
          capabilities: freeze(youtube ? ["metadata", "manual-transcript"] : feed ? ["metadata"] : ["metadata", "bounded-ingestion"]),
        }),
        identityEvidence: freeze(item.identityEvidence.map((evidence) => freeze({ ...evidence, observedAt }))),
        initialItem: youtube ? freeze({
          itemId: id,
          versionId: policyVersion,
          canonicalUrl,
          title: retainedTitle,
          description: retainedDescription,
          contentDigest: `provider-metadata:${policyVersion}:${canonicalUrl}`,
          provenance: freeze([{ method: "provider-metadata", reference: canonicalUrl }]),
          observedAt,
          publishedAt: null,
        }) : null,
      }),
    });
  }
}

/** @param {unknown} command */
function searchCommand(command) {
  if (typeof command !== "object" || command === null || Array.isArray(command)) return null;
  const value = /** @type {Record<string,unknown>} */ (command);
  const limit = value.limit;
  if (
    Object.keys(value).length !== 3 ||
    typeof value.query !== "string" || value.query.trim() === "" ||
    !Array.isArray(value.providerIds) || value.providerIds.length === 0 ||
    value.providerIds.length > 20 ||
    !value.providerIds.every((id) => typeof id === "string" && id.trim() !== "") ||
    new Set(value.providerIds).size !== value.providerIds.length ||
    typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20
  ) return null;
  return freeze({
    query: value.query,
    providerIds: freeze(/** @type {string[]} */ ([...value.providerIds])),
    limit,
  });
}

/** @param {(value:string)=>string} escapeHtml @param {import("../routes/discover.js").DiscoverMarkup} markup */
function emptyRoute(escapeHtml, markup) {
  return {
    state: /** @type {const} */ ("loading"),
    stateMessage: null,
    page: /** @type {const} */ ("list"),
    items: freeze([]),
    selectedItemId: null,
    maxVisibleItems: 20,
    areas: freeze([]),
    pendingId: null,
    canAct: false,
    search: freeze({ query: "", limit: 10, capabilities: freeze([]), selectedProviderIds: freeze([]), available: false }),
    markup,
    escapeHtml,
  };
}

/** @param {import("../features/source-library/gateway.js").SourceGatewayFailure} failure @param {import("../routes/discover.js").DiscoverMarkup} failureCopy */
function friendlySource(failure, failureCopy) {
  if (
    failure.kind === "SourceGatewayUnavailable" ||
    failure.kind === "SourceGatewayTimedOut"
  ) return failureCopy.sourceReconnect;
  if (failure.kind === "SourceGatewayUnauthenticated") {
    return failureCopy.sourceSignIn;
  }
  if (
    failure.kind === "SourceGatewayRejected" &&
    failure.failureKind === "SourceInterestAreaMissing"
  ) return failureCopy.sourceAreaMissing;
  return failureCopy.sourceDecisionFailed;
}

/** @param {(value:string)=>string} escapeHtml @param {import("../routes/discover.js").DiscoverMarkup} markup */
function loading(escapeHtml, markup) {
  return renderDiscoverRoute(emptyRoute(escapeHtml, markup));
}

/** @param {unknown} inventory @param {string} sessionSeed */
function withSessionSeed(inventory, sessionSeed) {
  return inventory !== null && typeof inventory === "object" &&
      !Array.isArray(inventory)
    ? freeze({ ...inventory, sessionSeed })
    : inventory;
}
