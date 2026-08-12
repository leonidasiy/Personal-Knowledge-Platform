// @ts-check

import { validateBrowserAcceptanceConfig } from "./browser-acceptance-core.mjs";

const TARGET_URL = "https://resonance-discovery.lirenleonidas.workers.dev";
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NAVIGATION_TIMEOUT_MS = "15000";
const ACTION_TIMEOUT_MS = "15000";

/** @typedef {ReturnType<typeof validateBrowserAcceptanceConfig>} BrowserAcceptanceConfigResult */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return typeof value === "object" && value !== null;
}

/** @param {unknown} moduleUrl */
function projectRootFromModuleUrl(moduleUrl) {
  if (typeof moduleUrl !== "string") return null;
  try {
    const directory = new URL("../", moduleUrl);
    return directory.protocol === "file:" ? decodeURIComponent(directory.pathname).replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * Creates browser-acceptance configuration from fixed operational settings.
 * The authenticated browser state is read from the project's private runtime
 * directory and no credential value crosses this composition boundary.
 * @param {unknown} environment
 * @param {unknown} moduleUrl
 * @returns {BrowserAcceptanceConfigResult}
 */
export function composeBrowserAcceptanceConfig(environment, moduleUrl) {
  if (!record(environment)) {
    return validateBrowserAcceptanceConfig(environment, Object.freeze({}));
  }
  const projectRoot = projectRootFromModuleUrl(moduleUrl);
  if (projectRoot === null) {
    return {
      ok: false,
      error: Object.freeze({ kind: "BrowserAcceptanceConfigInvalid", field: "moduleUrl" }),
    };
  }
  return validateBrowserAcceptanceConfig(
    Object.freeze({
      BROWSER_ACCEPTANCE_TARGET_URL: TARGET_URL,
      BROWSER_ACCEPTANCE_CHROME_PATH: CHROME_PATH,
      BROWSER_ACCEPTANCE_NAVIGATION_TIMEOUT_MS: NAVIGATION_TIMEOUT_MS,
      BROWSER_ACCEPTANCE_ACTION_TIMEOUT_MS: ACTION_TIMEOUT_MS,
      BROWSER_ACCEPTANCE_STORAGE_STATE_PATH: `${projectRoot}/.private/browser-acceptance/storage-state.json`,
    }),
    Object.freeze({ projectRoot }),
  );
}
