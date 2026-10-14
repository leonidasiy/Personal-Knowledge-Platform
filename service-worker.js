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
  "./assets/app-icon-192.png",
  "./assets/app-icon-512.png",
  "./service-worker.js",
  "./src/app.js",
  "./src/styles.css",
  "./assets/fonts/fraunces-latin.woff2",
  "./assets/fonts/manrope-latin.woff2",
  "./assets/fonts/syne-latin.woff2",
  "./assets/fonts/LICENSE.txt",
  "./assets/catalog-fixtures.json",
  "./assets/discovery-starters.json",
  "./assets/empty-states.svg",
  "./assets/fallback-media/Heungsoon%20Sheet%20Music.jpg",
  "./assets/fallback-media/Headphones%20Music%20Image.jpg",
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

self.addEventListener("push", (event) => {
  event.waitUntil(showReminder(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.notification.tag.startsWith("resonance-reminder:")) {
    event.waitUntil(openReminder("review"));
  } else if (event.notification.tag.startsWith("resonance-source:")) {
    event.waitUntil(openReminder("library"));
  }
});

async function showReminder(event) {
  let payload;
  try {
    payload = event.data?.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("ReminderPushInvalid");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      (payload.type !== "daily-reminder" && payload.type !== "source-ready" && payload.type !== "source-attention") ||
      typeof payload.id !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(payload.id) ||
      typeof payload.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.expiresAt) ||
      !Number.isFinite(Date.parse(payload.expiresAt)) || new Date(payload.expiresAt).toISOString() !== payload.expiresAt ||
      (payload.test !== undefined && (payload.type !== "daily-reminder" || typeof payload.test !== "boolean"))) {
    throw new Error("ReminderPushInvalid");
  }
  // Expired messages must not become a backlog after the phone reconnects.
  if (Date.parse(payload.expiresAt) <= Date.now()) return;
  if (Date.parse(payload.expiresAt) > Date.now() + 65 * 60_000) throw new Error("ReminderPushInvalid");
  await self.registration.showNotification("Resonance", {
    body: payload.type === "source-ready" ? "Your knowledge and quizzes are ready. Tap to explore them in Library." : payload.type === "source-attention" ? "A source needs your attention. Tap to open Library and see the next step." : payload.test ? "Your reminder is working. Tap to try your daily retrieval quiz." : "What do you remember? Tap to start your daily review.",
    icon: new URL("assets/app-icon-192.png", self.registration.scope).href,
    tag: `${payload.type === "daily-reminder" ? "resonance-reminder" : "resonance-source"}:${payload.id}`,
    renotify: false,
  });
}

async function openReminder(view) {
  const scope = new URL(self.registration.scope);
  const target = new URL(`?view=${view}`, scope).href;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = clients.find((client) => {
    const url = new URL(client.url);
    return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
  });
  if (existing) {
    existing.postMessage({ type: view === "review" ? "resonance-reminder-open" : "resonance-source-update-open" });
    await existing.focus();
  } else {
    await self.clients.openWindow(target);
  }
}

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
