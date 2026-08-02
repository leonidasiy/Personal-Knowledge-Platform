// @ts-check

const freeze = Object.freeze;
export const YOUTUBE_POLICY_VERSION = "youtube-api-services-v1";
const STORAGE_KEY = "resonance.youtube-policy";

/** @typedef {{readonly status:"accepted"|"pending"|"unavailable"}} YouTubeConnection */
/** @typedef {Pick<import("../routes/discover.js").DiscoverMarkup,"youtubeConnected"|"youtubeDisconnected"|"youtubeUnavailable"|"failureMessages">} YouTubeConnectionMarkup */
/** @typedef {{readonly getItem:(key:string)=>string|null,readonly setItem:(key:string,value:string)=>void}} PolicyStorage */
/** @typedef {{readonly kind:"YouTubePolicyStorageUnavailable"}|{readonly kind:"YouTubePolicyRecordInvalid"}} YouTubePolicyFailure */
/** @template T @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:YouTubePolicyFailure}} Result */

/** @param {{readonly storage:PolicyStorage,readonly now:()=>string,readonly markup:YouTubeConnectionMarkup,readonly onNotice:(message:string)=>void,readonly onError:(message:string)=>void,readonly rerender:()=>void}} dependencies */
export function createYouTubeConnectionController(dependencies) {
  if (
    typeof dependencies.storage?.getItem !== "function" ||
    typeof dependencies.storage?.setItem !== "function" ||
    typeof dependencies.now !== "function" ||
    typeof dependencies.onNotice !== "function" ||
    typeof dependencies.onError !== "function" ||
    typeof dependencies.rerender !== "function"
  ) throw new TypeError("YouTube policy dependencies are invalid.");

  /** @type {YouTubeConnection} */ let connection = freeze({
    status: "pending",
  });
  return freeze({
    /** @returns {Result<YouTubeConnection>} */
    load() {
      let stored;
      try {
        stored = dependencies.storage.getItem(STORAGE_KEY);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        connection = freeze({ status: "unavailable" });
        return {
          ok: false,
          error: { kind: "YouTubePolicyStorageUnavailable" },
        };
      }
      if (stored === null) {
        connection = freeze({ status: "pending" });
        return { ok: true, value: connection };
      }
      const parsed = parseAcceptance(stored);
      if (!parsed.ok) {
        connection = freeze({ status: "pending" });
        return parsed;
      }
      connection = freeze({ status: "accepted" });
      return { ok: true, value: connection };
    },
    isAccepted() {
      return connection.status === "accepted";
    },
    /** @param {ParentNode} root */
    bind(root) {
      const mount = root.querySelector("[data-youtube-connection]");
      if (!(mount instanceof HTMLElement)) return;
      const offline =
        root.querySelector('[data-discovery-state="offline"]') !== null;
      mount.innerHTML = renderYouTubeConnection(
        connection,
        offline,
        dependencies.markup,
      );
      mount.querySelector("[data-youtube-policy-accept]")?.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          const acceptedAt = dependencies.now();
          if (!Number.isFinite(Date.parse(acceptedAt))) {
            dependencies.onError(
              "YouTube policy acceptance could not be saved.",
            );
            return;
          }
          try {
            dependencies.storage.setItem(
              STORAGE_KEY,
              JSON.stringify({ version: YOUTUBE_POLICY_VERSION, acceptedAt }),
            );
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            connection = freeze({ status: "unavailable" });
            dependencies.onError(
              "YouTube policy acceptance could not be saved.",
            );
            dependencies.rerender();
            return;
          }
          connection = freeze({ status: "accepted" });
          dependencies.onNotice("YouTube search enabled.");
          dependencies.rerender();
        },
      );
    },
  });
}

/** @param {YouTubeConnection} connection @param {boolean} offline @param {YouTubeConnectionMarkup} markup */
export function renderYouTubeConnection(connection, offline, markup) {
  const disabled = offline ? " disabled" : "";
  const template = connection.status === "accepted"
    ? markup.youtubeConnected
    : connection.status === "pending"
    ? markup.youtubeDisconnected
    : markup.youtubeUnavailable;
  return template.replaceAll("{{disabled}}", disabled);
}

/** @param {{readonly kind:string,readonly failureKind?:string}} failure @param {YouTubeConnectionMarkup} markup */
export function friendlyDiscoveryFailure(failure, markup) {
  const kind = failure.kind === "DiscoveryGatewayRejected"
    ? failure.failureKind ?? failure.kind
    : failure.kind;
  return markup.failureMessages[kind] ?? markup.failureMessages.default;
}

/** @param {string} value @returns {Result<{readonly version:string,readonly acceptedAt:string}>} */
function parseAcceptance(value) {
  /** @type {unknown} */ let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error: { kind: "YouTubePolicyRecordInvalid" } };
  }
  if (
    !record(parsed) || parsed.version !== YOUTUBE_POLICY_VERSION ||
    typeof parsed.acceptedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.acceptedAt)) ||
    Object.keys(parsed).length !== 2
  ) return { ok: false, error: { kind: "YouTubePolicyRecordInvalid" } };
  return {
    ok: true,
    value: freeze({ version: parsed.version, acceptedAt: parsed.acceptedAt }),
  };
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
