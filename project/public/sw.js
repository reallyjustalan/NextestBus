const CACHE_PREFIX = "nus-bus-shell-";
const CACHE_NAME = "nus-bus-shell-v35";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/directions-planner.js",
  "/data/nus-map-locations.json",
  "/data/nusmods-venues.json",
  "/data/routing-topology.json",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        const staleShellCaches = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
        return Promise.all(staleShellCaches.map((key) => caches.delete(key)));
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html")));
    return;
  }

  if (url.pathname === "/data/routing-topology.json") {
    event.respondWith(
      caches.match(request).then(async (cached) => {
        const update = fetch(request).then((response) => {
          if (response?.status === 200) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          return response;
        });
        if (!cached) return update;
        event.waitUntil(update.catch(() => null));
        return cached;
      })
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (!response || response.status !== 200) return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
