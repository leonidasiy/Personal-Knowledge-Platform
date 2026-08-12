// @ts-check

const CACHE_PREFIX = "resonance-shell-";
const BUILD_CACHE_ID = "__RESONANCE_BUILD_ID__";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_CACHE_ID}`;
const NETWORK_FIRST_PATHS = new Set([
  "/",
  "/index.html",
  "/asset-manifest.json",
  "/service-worker.js",
]);
const OFFLINE_FAILURE_MESSAGE = "resonance-offline-failure";
const SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./service-worker.js",
  "./src/app.js",
  "./src/styles.css",
  "./assets/catalog-fixtures.json",
  "./assets/discovery-starters.json",
  "./assets/suspension-study-640.webp",
  "./assets/suspension-study.webp",
  "./assets/filter-spectrum-640.webp",
  "./assets/filter-spectrum.webp",
  "./assets/rhythmic-displacement-640.webp",
  "./assets/rhythmic-displacement.webp",
  "./assets/icon-192.webp",
  "./assets/icon-512.webp",
];
const FRESH_PATHS = new Set([
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/asset-manifest.json",
  "/src/app.js",
  "/src/styles.css",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(installShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(upgradeShell());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (requestUrl.pathname.startsWith("/api/")) return;

  event.respondWith(
    event.request.mode === "navigate" || FRESH_PATHS.has(requestUrl.pathname)
      ? resolveFreshRequest(event.request)
      : resolveSameOriginRequest(event.request),
  );
});

async function installShell() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const buildAssets = await readAssetManifest();
    const installUrls = new Set([
      ...SHELL_URLS,
      "./asset-manifest.json",
      ...buildAssets,
    ]);
    await cache.addAll([...installUrls]);
    await self.skipWaiting();
  } catch {
    try {
      await notifyOfflineFailure("OfflineCacheInstallFailed");
    } finally {
      throw new Error("OfflineCacheInstallFailed");
    }
  }
}

async function readAssetManifest() {
  const response = await fetch("./asset-manifest.json", { cache: "no-store" });
  if (!response.ok) throw new Error("OfflineAssetManifestMissing");
  const document = await response.json();
  if (
    !Array.isArray(document) ||
    !document.every((path) =>
      typeof path === "string" && path.startsWith("./") &&
      !path.startsWith("./../")
    )
  ) {
    throw new Error("OfflineAssetManifestInvalid");
  }
  return document;
}

async function upgradeShell() {
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  } catch {
    try {
      await notifyOfflineFailure("OfflineUpgradeFailed");
    } finally {
      throw new Error("OfflineUpgradeFailed");
    }
  }
}

async function resolveFreshRequest(request) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    await notifyOfflineFailure("OfflineCacheMiss");
    try {
      return await fetch(request, { cache: "no-store" });
    } catch (fetchError) {
      if (!(fetchError instanceof Error)) throw fetchError;
      return Response.error();
    }
  }

  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) {
      try {
        await cache.put(request, response.clone());
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        await notifyOfflineFailure("OfflineCacheMiss");
      }
    }
    return response;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    try {
      const fallback = await cache.match(request);
      if (fallback !== undefined) return fallback;
    } catch (cacheError) {
      if (!(cacheError instanceof Error)) throw cacheError;
    }
    await notifyOfflineFailure("OfflineCacheMiss");
    return Response.error();
  }
}

async function resolveSameOriginRequest(request) {
  const requestUrl = new URL(request.url);
  const networkFirst = request.mode === "navigate" ||
    NETWORK_FIRST_PATHS.has(requestUrl.pathname);
  if (networkFirst) return resolveFreshRequest(request);

  let cache;
  let cached;
  try {
    cache = await caches.open(CACHE_NAME);
    cached = await cache.match(request);
  } catch {
    await notifyOfflineFailure("OfflineCacheMiss");
    try {
      return await fetch(request);
    } catch {
      return Response.error();
    }
  }

  const fetched = fetch(
    request,
    networkFirst ? { cache: "no-store" } : undefined,
  ).then(async (response) => {
    if (response.ok) {
      try {
        await cache.put(request, response.clone());
      } catch {
        await notifyOfflineFailure("OfflineCacheMiss");
      }
    }
    return response;
  });
  if (cached !== undefined) return cached;
  try {
    return await fetched;
  } catch {
    await notifyOfflineFailure("OfflineCacheMiss");
    return Response.error();
  }
}

async function notifyOfflineFailure(kind) {
  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  for (const client of clients) {
    client.postMessage({ type: OFFLINE_FAILURE_MESSAGE, kind });
  }
}
