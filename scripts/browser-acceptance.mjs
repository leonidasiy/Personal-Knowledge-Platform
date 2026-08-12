// @ts-check

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright-core";

import {
  runBrowserAcceptance,
} from "./browser-acceptance-core.mjs";
import { composeBrowserAcceptanceConfig } from "./browser-acceptance-composition.mjs";
import { loadBrowserSessionState } from "./browser-session-state.mjs";

const environment = Object.freeze({ ...process.env });

/** @param {string} root */
async function listFiles(root) {
  await mkdir(root, { recursive: true });
  /** @type {{ path: string, modifiedAt: string }[]} */
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listFiles(path));
    } else if (entry.isFile()) {
      const metadata = await stat(path);
      files.push(Object.freeze({ path, modifiedAt: metadata.mtime.toISOString() }));
    }
  }
  return files;
}

const fileSystem = Object.freeze({
  listFiles,
  /** @param {string} path */
  remove(path) {
    return rm(path, { force: false });
  },
  /** @param {string} path */
  mkdir(path) {
    return mkdir(path, { recursive: true });
  },
  /** @param {string} path @param {string} contents */
  writeTextFile(path, contents) {
    return writeFile(path, contents, "utf8");
  },
});

/** @param {{ readonly kind: string, readonly [key: string]: unknown }} error */
function printFailure(error) {
  const fields = ["field", "category", "status", "route", "assertion", "stage", "artifact", "resource"];
  const details = fields
    .filter((field) => typeof error[field] === "string" || typeof error[field] === "number")
    .map((field) => `${field}=${String(error[field])}`);
  console.error([error.kind, ...details].join(" "));
}

async function main() {
  const config = composeBrowserAcceptanceConfig(environment, import.meta.url);
  if (!config.ok) {
    printFailure(config.error);
    process.exitCode = 1;
    return;
  }

  const result = await runBrowserAcceptance(
    config.value,
    Object.freeze({
      launch: (/** @type {{ readonly executablePath: string }} */ options) => chromium.launch(options),
      loadSessionState: (/** @type {string} */ path) => loadBrowserSessionState(path, Object.freeze({ readFile })),
      fileSystem,
      now: () => new Date(),
      createId: randomUUID,
      log: (/** @type {unknown} */ evidence) => console.info(JSON.stringify(evidence)),
    }),
  );
  if (!result.ok) {
    printFailure(result.error);
    process.exitCode = 1;
  }
}

main().catch(() => {
  printFailure({ kind: "BrowserAcceptanceConfigInvalid", field: "composition" });
  process.exitCode = 1;
});
