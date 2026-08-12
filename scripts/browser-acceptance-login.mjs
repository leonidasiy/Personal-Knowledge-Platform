// @ts-check

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright-core";

import { composeBrowserAcceptanceConfig } from "./browser-acceptance-composition.mjs";
import { bootstrapBrowserSession } from "./browser-acceptance-login-core.mjs";
import { saveBrowserSessionState } from "./browser-session-state.mjs";

const fileSystem = Object.freeze({ chmod, mkdir, readFile, rename, rm, writeFile });

/** @param {{ readonly kind: string }} error */
function printFailure(error) { console.error(error.kind); }

async function main() {
  const composed = composeBrowserAcceptanceConfig(Object.freeze({}), import.meta.url);
  if (!composed.ok) { printFailure(composed.error); process.exitCode = 1; return; }
  console.info("BrowserAcceptanceLoginWindowOpened");
  const result = await bootstrapBrowserSession(
    Object.freeze({
      projectRoot: composed.value.artifactRoots[0].replace(/\/logs$/, ""),
      targetUrl: composed.value.targetUrl,
      chromePath: composed.value.chromePath,
      storageStatePath: composed.value.storageStatePath,
      loginTimeoutMs: 300_000,
    }),
    Object.freeze({
      launch: (/** @type {{ readonly executablePath: string, readonly headless: false }} */ options) => chromium.launch(options),
      saveSessionState: (/** @type {string} */ path, /** @type {unknown} */ state) => saveBrowserSessionState(path, state, fileSystem, randomUUID),
    }),
  );
  if (!result.ok) { printFailure(result.error); process.exitCode = 1; return; }
  console.info(`BrowserAcceptanceSessionReady workerVersion=${result.value.workerVersion}`);
}

main().catch(() => { printFailure({ kind: "BrowserAcceptanceLoginConfigInvalid" }); process.exitCode = 1; });
