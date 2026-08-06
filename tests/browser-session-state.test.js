// @ts-check

import {
  loadBrowserSessionState,
  saveBrowserSessionState,
} from "../scripts/browser-session-state.mjs";
import { bootstrapBrowserSession } from "../scripts/browser-acceptance-login-core.mjs";

/** @param {boolean} condition @param {string} message */
function assert(condition, message) { if (!condition) throw new Error(message); }
/** @template T @param {T} actual @param {T} expected */
function equal(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

const path = "/project/.private/browser-acceptance/storage-state.json";
const state = Object.freeze({ cookies: Object.freeze([]), origins: Object.freeze([]) });

/** @param {{ read?: unknown, readError?: string, writeError?: boolean }} [options] */
function fileSystem(options = {}) {
  /** @type {unknown[][]} */ const calls = [];
  return Object.freeze({
    calls,
    /** @param {string} filePath @param {string} encoding */
    async readFile(filePath, encoding) {
      calls.push(["readFile", filePath, encoding]);
      if (options.readError !== undefined) throw Object.assign(new Error(), { code: options.readError });
      return options.read ?? JSON.stringify(state);
    },
    /** @param {string} target @param {unknown} settings */
    async mkdir(target, settings) { calls.push(["mkdir", target, settings]); },
    /** @param {string} target @param {number} mode */
    async chmod(target, mode) { calls.push(["chmod", target, mode]); },
    /** @param {string} target @param {string} contents @param {unknown} settings */
    async writeFile(target, contents, settings) { calls.push(["writeFile", target, contents, settings]); if (options.writeError) throw new Error(); },
    /** @param {string} source @param {string} destination */
    async rename(source, destination) { calls.push(["rename", source, destination]); },
    /** @param {string} target @param {unknown} settings */
    async rm(target, settings) { calls.push(["rm", target, settings]); },
  });
}

Deno.test("session state loader distinguishes missing, unreadable, and malformed files without returning contents", async () => {
  for (const [readError, kind] of [["ENOENT", "BrowserAcceptanceSessionStateMissing"], ["EACCES", "BrowserAcceptanceSessionStateUnreadable"]]) {
    const result = await loadBrowserSessionState(path, fileSystem({ readError }));
    assert(!result.ok, "Read failures must remain failures.");
    if (!result.ok) equal(result.error.kind, kind);
    assert(!JSON.stringify(result).includes("cookie"), "Failures must not contain session contents.");
  }
  for (const read of ["not-json", "{}", '{"cookies":{},"origins":[]}']) {
    const result = await loadBrowserSessionState(path, fileSystem({ read }));
    assert(!result.ok, "Malformed state must fail closed.");
    if (!result.ok) equal(result.error.kind, "BrowserAcceptanceSessionStateMalformed");
  }
});

Deno.test("session state loader returns a valid isolated Playwright state", async () => {
  const result = await loadBrowserSessionState(path, fileSystem());
  assert(result.ok, "Valid state must load.");
  if (result.ok) equal(JSON.stringify(result.value), JSON.stringify(state));
});

Deno.test("session state writer uses an atomic private file with exact directory and file modes", async () => {
  const fs = fileSystem();
  const result = await saveBrowserSessionState(path, state, fs, () => "run-1");
  assert(result.ok, "Valid state must be saved.");
  const temporary = `${path}.tmp-run-1`;
  equal(JSON.stringify(fs.calls), JSON.stringify([
    ["mkdir", "/project/.private/browser-acceptance", { recursive: true, mode: 0o700 }],
    ["chmod", "/project/.private/browser-acceptance", 0o700],
    ["writeFile", temporary, JSON.stringify(state), { encoding: "utf8", flag: "wx", mode: 0o600 }],
    ["chmod", temporary, 0o600],
    ["rename", temporary, path],
    ["chmod", path, 0o600],
  ]));
});

Deno.test("session state writer cleans its temporary file and returns a named write failure", async () => {
  const fs = fileSystem({ writeError: true });
  const result = await saveBrowserSessionState(path, state, fs, () => "run-2");
  assert(!result.ok, "Write failure must be returned.");
  if (!result.ok) equal(result.error.kind, "BrowserAcceptanceSessionStateWriteFailed");
  equal(JSON.stringify(fs.calls.at(-1)), JSON.stringify(["rm", `${path}.tmp-run-2`, { force: true }]));
});

/** @param {{ finalUrl?: string, workerVersion?: string, status?: number, timeout?: boolean, saveError?: boolean }} [options] */
function loginDependencies(options = {}) {
  /** @type {unknown[][]} */ const calls = [];
  const response = Object.freeze({ status: () => options.status ?? 200, url: () => options.finalUrl ?? "https://resonance-discovery.lirenleonidas.workers.dev/", headers: () => ({ "x-resonance-worker-version": options.workerVersion ?? "d4b1bfd8-0c02-494e-bad0-647c548f46ce" }) });
  const page = Object.freeze({
    /** @param {string} url @param {unknown} settings */
    async goto(url, settings) { calls.push(["goto", url, settings]); },
    /** @param {unknown} match @param {unknown} settings */
    async waitForURL(match, settings) { calls.push(["waitForURL", match, settings]); if (options.timeout) throw Object.assign(new Error(), { name: "TimeoutError" }); },
    /** @param {unknown} settings */
    async reload(settings) { calls.push(["reload", settings]); return response; },
    async close() { calls.push(["page.close"]); },
  });
  const context = Object.freeze({
    /** @param {unknown} script */
    async addInitScript(script) { calls.push(["addInitScript", script]); },
    async newPage() { calls.push(["newPage"]); return page; },
    async storageState() { calls.push(["storageState"]); return state; },
    async close() { calls.push(["context.close"]); },
  });
  const browser = Object.freeze({
    /** @param {unknown} settings */
    async newContext(settings) { calls.push(["newContext", settings]); return context; },
    async close() { calls.push(["browser.close"]); },
  });
  return Object.freeze({
    calls,
    /** @param {unknown} settings */
    async launch(settings) { calls.push(["launch", settings]); return browser; },
    /** @param {string} target @param {unknown} sessionState */
    async saveSessionState(target, sessionState) { calls.push(["saveSessionState", target, sessionState]); return options.saveError ? { ok: false, error: { kind: "BrowserAcceptanceSessionStateWriteFailed" } } : { ok: true }; },
  });
}

const loginConfig = Object.freeze({
  projectRoot: "/project",
  targetUrl: "https://resonance-discovery.lirenleonidas.workers.dev",
  chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  storageStatePath: path,
  loginTimeoutMs: 300_000,
});

Deno.test("login bootstrap persists state only after canonical Worker verification", async () => {
  const dependencies = loginDependencies();
  const result = await bootstrapBrowserSession(loginConfig, dependencies);
  assert(result.ok, "Canonical authenticated session must be saved.");
  assert(!dependencies.calls.some((call) => call[0] === "addInitScript"), "Native service-worker registration must not be overridden.");
  equal(JSON.stringify(dependencies.calls.find((call) => call[0] === "newContext")), JSON.stringify(["newContext", { serviceWorkers: "allow" }]));
  const save = dependencies.calls.find((call) => call[0] === "saveSessionState");
  assert(save !== undefined, "Verified state must be saved.");
  if (save !== undefined) equal(save[1], path);
  equal(JSON.stringify(dependencies.calls.slice(-3)), JSON.stringify([["page.close"], ["context.close"], ["browser.close"]]));
});

Deno.test("login bootstrap refuses redirects, expired login, invalid Worker versions, and state-write failures", async () => {
  /** @type {readonly [Parameters<typeof loginDependencies>[0], string][]} */ const cases = [
    [{ timeout: true }, "BrowserAcceptanceLoginTimedOut"],
    [{ finalUrl: "https://example.invalid/" }, "BrowserAcceptanceAccessRedirected"],
    [{ status: 500 }, "BrowserAcceptanceLoginDocumentFailed"],
    [{ workerVersion: "invalid" }, "BrowserAcceptanceWorkerVersionUnavailable"],
    [{ saveError: true }, "BrowserAcceptanceSessionStateWriteFailed"],
  ];
  for (const [options, kind] of cases) {
    const dependencies = loginDependencies(options);
    const result = await bootstrapBrowserSession(loginConfig, dependencies);
    assert(!result.ok, "Unsafe login outcome must fail.");
    if (!result.ok) equal(result.error.kind, kind);
    if (kind !== "BrowserAcceptanceSessionStateWriteFailed") assert(!dependencies.calls.some((call) => call[0] === "saveSessionState"), "Unverified state must never be saved.");
  }
});

Deno.test("login bootstrap rejects every value outside its fixed operational boundary", async () => {
  const cases = [
    { projectRoot: "/project/../outside" },
    { targetUrl: "https://example.invalid" },
    { chromePath: "/tmp/chrome" },
    { storageStatePath: "/project/other/storage-state.json" },
    { loginTimeoutMs: 299_999 },
  ];
  for (const replacement of cases) {
    const dependencies = loginDependencies();
    const result = await bootstrapBrowserSession(Object.freeze({ ...loginConfig, ...replacement }), dependencies);
    assert(!result.ok, "Invalid operational configuration must fail before launch.");
    if (!result.ok) equal(result.error.kind, "BrowserAcceptanceLoginConfigInvalid");
    equal(dependencies.calls.length, 0);
  }
});

Deno.test("browser session commands require no credential environment and private state is Git ignored", async () => {
  const projectRoot = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "");
  const denoConfiguration = JSON.parse(await Deno.readTextFile(`${projectRoot}/deno.json`));
  equal(denoConfiguration.tasks["browser:acceptance"], "node scripts/browser-acceptance.mjs");
  equal(denoConfiguration.tasks["browser:acceptance:login"], "node scripts/browser-acceptance-login.mjs");
  const ignored = (await Deno.readTextFile(`${projectRoot}/.gitignore`)).split(/\r?\n/);
  assert(ignored.includes(".private/"), "Private browser state must be excluded from Git.");
});
