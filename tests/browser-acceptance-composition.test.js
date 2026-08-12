// @ts-check

import { composeBrowserAcceptanceConfig } from "../scripts/browser-acceptance-composition.mjs";

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @template T @param {T} actual @param {T} expected */
function equal(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

Deno.test("browser acceptance composition injects fixed public settings and the isolated session path", () => {
  const result = composeBrowserAcceptanceConfig(
    Object.freeze({
      UNRELATED_PROCESS_VALUE: "must-not-be-forwarded",
    }),
    import.meta.url,
  );

  assert(result.ok, "The fixed composition boundary must create a valid configuration.");
  if (!result.ok) return;
  const projectRoot = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "");
  equal(result.value.targetUrl, "https://resonance-discovery.lirenleonidas.workers.dev");
  equal(result.value.navigationTimeoutMs, 15_000);
  equal(result.value.actionTimeoutMs, 15_000);
  equal(result.value.chromePath, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  equal(result.value.storageStatePath, `${projectRoot}/.private/browser-acceptance/storage-state.json`);
  assert(!JSON.stringify(result.value).includes("must-not-be-forwarded"), "Unrelated process values must not enter configuration.");
});

Deno.test("browser acceptance composition rejects a module URL that cannot establish the project boundary", () => {
  const result = composeBrowserAcceptanceConfig(Object.freeze({}), "https://example.invalid/scripts/browser-acceptance.mjs");
  assert(!result.ok, "A non-file module URL must not produce a configuration.");
  if (result.ok) return;
  equal(result.error.kind, "BrowserAcceptanceConfigInvalid");
  if (result.error.kind === "BrowserAcceptanceConfigInvalid") equal(result.error.field, "moduleUrl");
});

Deno.test("browser acceptance composition derives artifact roots from its module URL, not caller cwd", () => {
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir("/private/tmp");
    const result = composeBrowserAcceptanceConfig(Object.freeze({}), import.meta.url);

    assert(result.ok, "A valid module URL must compose configuration.");
    if (!result.ok) return;
    const projectRoot = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "");
    equal(result.value.artifactRoots[0], `${projectRoot}/logs`);
    equal(result.value.artifactRoots[1], `${projectRoot}/test-results/browser-acceptance`);
    assert(!result.value.artifactRoots[0].startsWith("/private/tmp/"), "Foreign cwd must not redirect logs.");
  } finally {
    Deno.chdir(originalCwd);
  }
});
