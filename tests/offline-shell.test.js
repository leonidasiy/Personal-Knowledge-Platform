// @ts-check

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test({
  name: "Access-protected shell loads its manifest with the session credential",
  async fn() {
    const document = await Deno.readTextFile(
      new URL("../index.html", import.meta.url),
    );
    assert(
      /<link\s+rel="manifest"\s+href="\.\/manifest\.webmanifest"\s+crossorigin="use-credentials"\s+\/>/
        .test(
          document,
        ),
      "The manifest request must carry the Cloudflare Access session cookie.",
    );
    assert(
      document.includes(
        '<link rel="icon" href="./assets/icon-192.webp" type="image/webp" />',
      ),
      "The shell must declare its existing icon instead of relying on /favicon.ico.",
    );
  },
});

const SOURCE_ENTRY = "./src/app.js";
const DYNAMIC_IMPORT_BOUNDARIES = Object.freeze([
  "./src/features/daily-learning/runtime.js",
  "./src/features/questions/grading.js",
  "./src/features/recall/service.js",
  "./src/features/recall/ts-fsrs-adapter.js",
  "./src/routes/library.js",
  "./src/routes/review.js",
  "./src/startup/discovery-page.js",
  "./src/startup/library-page.js",
  "./src/startup/experience-actions.js",
  "./src/startup/local-data-actions.js",
  "./src/startup/local-runtime.js",
]);

/**
 * Walk literal local runtime imports without treating JSDoc type imports as
 * browser dependencies.
 *
 * @param {URL} root
 * @returns {Promise<ReadonlySet<string>>}
 */
async function runtimeSourceGraph(root) {
  const discovered = new Set([SOURCE_ENTRY]);
  const pending = [SOURCE_ENTRY];
  while (pending.length > 0) {
    const modulePath = pending.shift();
    if (modulePath === undefined) throw new Error("Source graph is corrupted.");
    const moduleUrl = new URL(modulePath, root);
    const source = await Deno.readTextFile(moduleUrl);
    for (const specifier of runtimeImportSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const dependencyUrl = new URL(specifier, moduleUrl);
      assert(
        dependencyUrl.href.startsWith(root.href),
        `${specifier} resolves outside the application root.`,
      );
      const dependencyPath = `./${
        decodeURIComponent(
          dependencyUrl.href.slice(root.href.length),
        )
      }`;
      if (discovered.has(dependencyPath)) continue;
      discovered.add(dependencyPath);
      pending.push(dependencyPath);
    }
  }
  return discovered;
}

/** @param {string} source @returns {ReadonlySet<string>} */
function runtimeImportSpecifiers(source) {
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const specifiers = new Set();
  const patterns = [
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+(?:[\w*$,\s{}]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of executableSource.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.add(match[1]);
    }
  }
  return specifiers;
}

Deno.test({
  name: "offline shell installs source dependencies or generated lazy chunks",
  async fn() {
    const root = new URL("../", import.meta.url);
    const serviceWorker = await Deno.readTextFile(
      new URL("service-worker.js", root),
    );
    assert(
      serviceWorker.includes('const CACHE_PREFIX = "resonance-shell-"') &&
        serviceWorker.includes('"__RESONANCE_BUILD_ID__"') &&
        serviceWorker.includes("`${CACHE_PREFIX}${BUILD_CACHE_ID}`"),
      "The source worker must expose a build-generated cache identity.",
    );
    assert(
      serviceWorker.includes("readAssetManifest()") &&
        serviceWorker.includes('"./asset-manifest.json"'),
      "Offline installation must consume the generated split-build graph.",
    );
    assert(
      serviceWorker.includes("const installUrls = new Set(") &&
        serviceWorker.includes("cache.addAll([...installUrls])"),
      "Source shell and generated chunk URLs must be deduplicated before install.",
    );
    assert(
      !serviceWorker.includes('"./src/features/') &&
        !serviceWorker.includes('"./src/routes/') &&
        !serviceWorker.includes('"./src/startup/'),
      "Production precache literals must not name source-only bundled modules.",
    );
    const cached = new Set(
      [...serviceWorker.matchAll(/"(\.\/[^"]*)"/g)].map((match) => match[1]),
    );
    const expected = new Set([
      "./",
      "./index.html",
      "./manifest.webmanifest",
      "./service-worker.js",
      "./asset-manifest.json",
      "./src/app.js",
      "./src/styles.css",
      "./assets/catalog-fixtures.json",
      "./assets/suspension-study-640.webp",
      "./assets/suspension-study.webp",
      "./assets/filter-spectrum-640.webp",
      "./assets/filter-spectrum.webp",
      "./assets/rhythmic-displacement-640.webp",
      "./assets/rhythmic-displacement.webp",
      "./assets/icon-192.webp",
      "./assets/icon-512.webp",
    ]);

    for (const artifactPath of expected) {
      assert(
        cached.has(artifactPath),
        `${artifactPath} is missing from the production offline shell.`,
      );
    }
    for (const path of expected) {
      if (path === "./") continue;
      const stat = await Deno.stat(new URL(path, root));
      assert(stat.isFile, `${path} must resolve to a file.`);
    }
    const parsedSourceManifest = /** @type {unknown} */ (JSON.parse(
      await Deno.readTextFile(new URL("asset-manifest.json", root)),
    ));
    assert(
      Array.isArray(parsedSourceManifest) &&
        parsedSourceManifest.every((path) => typeof path === "string"),
      "The source graph must be a string array.",
    );
    const sourceManifest = /** @type {string[]} */ (parsedSourceManifest);
    assertEquals(
      new Set(sourceManifest).size,
      sourceManifest.length,
    );
    const sortedManifest = [...sourceManifest].sort();
    assertEquals(
      JSON.stringify(sourceManifest),
      JSON.stringify(sortedManifest),
    );
    for (const path of sourceManifest) {
      const stat = await Deno.stat(new URL(path, root));
      assert(stat.isFile, `${path} must resolve to a source module.`);
    }

    const runtimeGraph = await runtimeSourceGraph(root);
    const expectedManifest = [...runtimeGraph]
      .filter((path) => path !== SOURCE_ENTRY)
      .sort();
    assertEquals(
      JSON.stringify(sourceManifest),
      JSON.stringify(expectedManifest),
    );
    for (const boundary of DYNAMIC_IMPORT_BOUNDARIES) {
      assert(
        runtimeGraph.has(boundary),
        `${boundary} must remain reachable and cached for offline activation.`,
      );
    }

    assert(
      !serviceWorker.includes('"./src/chunks/'),
      "Generated chunk names must come from the production asset manifest.",
    );
  },
});

Deno.test("offline upgrade retires only older Resonance caches", async () => {
  const root = new URL("../", import.meta.url);
  const serviceWorker = await Deno.readTextFile(
    new URL("service-worker.js", root),
  );
  assert(
    serviceWorker.indexOf("await cache.addAll([...installUrls])") <
      serviceWorker.indexOf("await self.skipWaiting()"),
    "Every manifest asset, including lazy chunks, must install before activation.",
  );
  assert(
    serviceWorker.includes(
      "key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME",
    ),
    "Activation must delete only obsolete Resonance shell caches.",
  );
  assert(
    serviceWorker.includes("cached = await cache.match(request)") &&
      !serviceWorker.includes("cached = await caches.match(request)"),
    "Fetches must never resolve through an obsolete or unrelated cache.",
  );
  assert(
    serviceWorker.indexOf("installShell()") <
      serviceWorker.indexOf("upgradeShell()"),
    "The worker lifecycle must install the complete graph before old-cache cleanup.",
  );
  assert(
      serviceWorker.includes("const NETWORK_FIRST_PATHS = new Set(") &&
      serviceWorker.includes('request.mode === "navigate"') &&
      serviceWorker.includes('networkFirst ? { cache: "no-store" } : undefined') &&
      serviceWorker.includes('"/asset-manifest.json"') &&
      serviceWorker.includes('"/service-worker.js"'),
    "Navigations and build identity assets must refresh from the network before using the offline cache.",
  );
  assert(
    serviceWorker.indexOf("if (networkFirst)") <
      serviceWorker.indexOf("if (cached !== undefined) return cached;"),
    "Network-first requests must prefer the fresh response and only fall back to cached content after failure.",
  );
});

Deno.test("authenticated discovery API responses never enter the offline cache", async () => {
  const root = new URL("../", import.meta.url);
  const serviceWorker = await Deno.readTextFile(
    new URL("service-worker.js", root),
  );
  assert(
    serviceWorker.includes('requestUrl.pathname.startsWith("/api/")') &&
      serviceWorker.indexOf('requestUrl.pathname.startsWith("/api/")') <
        serviceWorker.indexOf("event.respondWith"),
    "The fetch handler must bypass API requests before cache resolution.",
  );
});

Deno.test("offline lifecycle reports every named failure without raw details", async () => {
  const root = new URL("../", import.meta.url);
  const serviceWorker = await Deno.readTextFile(
    new URL("service-worker.js", root),
  );
  const application = await Deno.readTextFile(new URL("src/app.js", root));
  for (
    const kind of [
      "OfflineCacheInstallFailed",
      "OfflineUpgradeFailed",
      "OfflineCacheMiss",
    ]
  ) {
    assert(
      serviceWorker.includes(`"${kind}"`),
      `${kind} must be emitted by the service worker.`,
    );
    assert(
      application.includes(`"${kind}"`),
      `${kind} must be handled by the application.`,
    );
  }
  assert(
    application.includes('"OfflineRegistrationFailed"'),
    "Registration failure must be handled at the browser composition boundary.",
  );
  assert(
    application.includes("friendlyOfflineFailure(kind)"),
    "Offline failures must be converted to non-technical messages.",
  );
  assert(
    !application.includes("event.data.message"),
    "Raw worker failure details must never reach user-facing messages.",
  );
});

Deno.test({
  name: "manifest declares existing install icons at both required sizes",
  async fn() {
    const root = new URL("../", import.meta.url);
    const manifest = JSON.parse(
      await Deno.readTextFile(new URL("manifest.webmanifest", root)),
    );
    assertEquals(Array.isArray(manifest.icons), true);
    assertEquals(manifest.icons.length, 2);
    assertEquals(manifest.icons[0].sizes, "192x192");
    assertEquals(manifest.icons[1].sizes, "512x512");
    for (const icon of manifest.icons) {
      const stat = await Deno.stat(new URL(icon.src, root));
      assert(stat.isFile, `${icon.src} must exist.`);
    }
  },
});
