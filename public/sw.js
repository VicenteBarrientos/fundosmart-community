const CACHE_PREFIX = "fundosmart-shell";
const LEGACY_CACHE_PREFIX = "fundosmart-static-";
const CACHE_VERSION = "v7";
const SHELL_CACHE = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const LEGACY_OFFLINE_TILE_CACHES = ["fundosmart-offline-tiles-v1"];
const OFFLINE_URL = "/offline.html";
const SHELL_ASSETS = [
  OFFLINE_URL,
  "/offline-capture.js",
  "/favicon.ico",
  "/fundosmart-ultra-min-favicon.svg",
  "/fundosmart-ultra-min-favicon.ico",
  "/fundosmart-ultra-min-mark.svg",
  "/fundosmart-ultra-min-logo.svg",
  "/fundosmart-ultra-min-logo-inverse.svg",
  "/fundosmart-ultra-min-app-icon-192.png",
  "/fundosmart-ultra-min-app-icon-512.png",
  "/fundosmart-ultra-min-app-icon-maskable-512.png",
  "/manifest.webmanifest",
];
const PUBLIC_ASSET_PREFIXES = ["/assets/", "/landing/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => (
          (key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE)
          || key.startsWith(LEGACY_CACHE_PREFIX)
          || LEGACY_OFFLINE_TILE_CACHES.includes(key)
        ))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => offlineResponse()));
    return;
  }

  if (isPublicAsset(request, url)) event.respondWith(cachePublicAsset(request));
});

self.addEventListener("sync", (event) => {
  if (event.tag === "fundosmart-mutations") event.waitUntil(requestScopedForegroundFlush());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/app/ganado";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const client = clients.find((entry) => "focus" in entry);
      return client
        ? client.focus().then(() => client.navigate(target))
        : self.clients.openWindow(target);
    }),
  );
});

function isPublicAsset(_request, url) {
  return SHELL_ASSETS.includes(url.pathname)
    || PUBLIC_ASSET_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

async function offlineResponse() {
  const cache = await caches.open(SHELL_CACHE);
  return cache.match(OFFLINE_URL);
}

async function cachePublicAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic" && !hasPrivateCacheDirective(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}

function hasPrivateCacheDirective(response) {
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  return cacheControl.split(",").some((directive) => {
    const name = directive.trim().split("=", 1)[0].toLowerCase();
    return name === "private" || name === "no-store";
  });
}

async function requestScopedForegroundFlush() {
  // The service worker cannot identify the active organization/user/field behind
  // the current cookie. It therefore never sends queued writes by itself.
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "fundosmart:offline-sync-request" });
  }
}
