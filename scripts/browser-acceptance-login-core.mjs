// @ts-check

const APPROVED_TARGET_URL = "https://resonance-discovery.lirenleonidas.workers.dev";
const APPROVED_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APPROVED_LOGIN_TIMEOUT_MS = 300_000;

/** @typedef {{ readonly kind: "BrowserAcceptanceLoginConfigInvalid" | "BrowserAcceptanceChromeLaunchFailed" | "BrowserAcceptanceBrowserSetupFailed" | "BrowserAcceptanceLoginTimedOut" | "BrowserAcceptanceLoginNavigationFailed" | "BrowserAcceptanceAccessRedirected" | "BrowserAcceptanceLoginDocumentFailed" | "BrowserAcceptanceWorkerVersionUnavailable" | "BrowserAcceptanceSessionStateWriteFailed" | "BrowserAcceptanceLoginCleanupFailed", readonly status?: number }} LoginFailure */
/** @typedef {{ readonly ok: true, readonly value: { readonly workerVersion: string } } | { readonly ok: false, readonly error: LoginFailure }} LoginResult */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null; }
/** @param {unknown} value */
function uuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
/** @param {unknown} value */
function timeout(value) { return record(value) && (value.name === "TimeoutError" || value.code === "ETIMEDOUT"); }
/** @param {unknown} value */
function canonicalProjectRoot(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/") return false;
  const parts = value.split("/").slice(1);
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}
/** @param {string} expected @param {unknown} actual */
function canonical(expected, actual) {
  try { const target = new URL(expected); const observed = new URL(typeof actual === "string" ? actual : ""); return target.origin === observed.origin && [target.pathname, `${target.pathname}/`].includes(observed.pathname) && observed.search === "" && observed.hash === "" && observed.username === "" && observed.password === ""; } catch { return false; }
}
/** @param {unknown} value @param {string} method @param {unknown} [argument] */
async function action(value, method, argument) {
  if (!record(value) || typeof value[method] !== "function") throw new Error();
  return argument === undefined ? value[method]() : value[method](argument);
}

/**
 * Opens a fresh headed browser, waits for the account owner to complete Access,
 * verifies the canonical deployed Worker, and persists only Playwright state.
 * @param {unknown} config
 * @param {unknown} dependencies
 * @returns {Promise<LoginResult>}
 */
export async function bootstrapBrowserSession(config, dependencies) {
  if (!record(config) || !canonicalProjectRoot(config.projectRoot) || config.targetUrl !== APPROVED_TARGET_URL || config.chromePath !== APPROVED_CHROME_PATH || config.storageStatePath !== `${config.projectRoot}/.private/browser-acceptance/storage-state.json` || config.loginTimeoutMs !== APPROVED_LOGIN_TIMEOUT_MS || !record(dependencies) || typeof dependencies.launch !== "function" || typeof dependencies.saveSessionState !== "function") return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceLoginConfigInvalid" }) };
  const targetUrl = config.targetUrl;
  const chromePath = config.chromePath;
  const storageStatePath = config.storageStatePath;
  const loginTimeoutMs = /** @type {number} */ (config.loginTimeoutMs);
  /** @type {Record<string, unknown> | null} */ let browser = null;
  /** @type {Record<string, unknown> | null} */ let context = null;
  /** @type {Record<string, unknown> | null} */ let page = null;
  /** @type {LoginFailure | null} */ let failure = null;
  /** @type {string | null} */ let workerVersion = null;
  try {
    try { browser = await dependencies.launch({ executablePath: chromePath, headless: false }); if (!record(browser)) throw new Error(); }
    catch { failure = Object.freeze({ kind: "BrowserAcceptanceChromeLaunchFailed" }); }
    if (failure === null) try { context = await action(browser, "newContext", { serviceWorkers: "allow" }); page = await action(context, "newPage"); }
    catch { failure = Object.freeze({ kind: "BrowserAcceptanceBrowserSetupFailed" }); }
    if (failure === null) try {
      if (!record(page) || typeof page.goto !== "function" || typeof page.waitForURL !== "function") throw new Error();
      await page.goto(targetUrl, { timeout: loginTimeoutMs, waitUntil: "domcontentloaded" });
      await page.waitForURL((/** @type {URL} */ url) => canonical(targetUrl, url.toString()), { timeout: loginTimeoutMs, waitUntil: "domcontentloaded" });
    } catch (error) { failure = Object.freeze({ kind: timeout(error) ? "BrowserAcceptanceLoginTimedOut" : "BrowserAcceptanceLoginNavigationFailed" }); }
    let response = null;
    if (failure === null) try { if (!record(page) || typeof page.reload !== "function") throw new Error(); response = await page.reload({ timeout: loginTimeoutMs, waitUntil: "domcontentloaded" }); }
    catch (error) { failure = Object.freeze({ kind: timeout(error) ? "BrowserAcceptanceLoginTimedOut" : "BrowserAcceptanceLoginNavigationFailed" }); }
    if (failure === null) {
      const finalUrl = await action(response, "url");
      if (!canonical(targetUrl, finalUrl)) failure = Object.freeze({ kind: "BrowserAcceptanceAccessRedirected" });
      else {
        const status = await action(response, "status");
        if (!Number.isInteger(status) || /** @type {number} */ (status) < 200 || /** @type {number} */ (status) >= 300) failure = Object.freeze({ kind: "BrowserAcceptanceLoginDocumentFailed", status: typeof status === "number" ? status : 0 });
        else {
          const headers = await action(response, "headers");
          workerVersion = record(headers) && uuid(headers["x-resonance-worker-version"]) ? String(headers["x-resonance-worker-version"]) : null;
          if (workerVersion === null) failure = Object.freeze({ kind: "BrowserAcceptanceWorkerVersionUnavailable" });
        }
      }
    }
    if (failure === null) {
      const sessionState = await action(context, "storageState");
      const saved = await dependencies.saveSessionState(storageStatePath, sessionState);
      if (!record(saved) || saved.ok !== true) failure = Object.freeze({ kind: "BrowserAcceptanceSessionStateWriteFailed" });
    }
  } catch { failure = Object.freeze({ kind: "BrowserAcceptanceLoginNavigationFailed" }); }
  finally {
    for (const value of [page, context, browser]) try { if (record(value) && typeof value.close === "function") await value.close(); } catch { if (failure === null) failure = Object.freeze({ kind: "BrowserAcceptanceLoginCleanupFailed" }); }
  }
  return failure === null && workerVersion !== null ? { ok: true, value: Object.freeze({ workerVersion }) } : { ok: false, error: failure ?? Object.freeze({ kind: "BrowserAcceptanceWorkerVersionUnavailable" }) };
}
