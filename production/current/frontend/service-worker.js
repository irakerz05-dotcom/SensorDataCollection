const CACHE_PREFIX = "verde-pwa-";
const CACHE = `${CACHE_PREFIX}v27`;
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=26",
  "./js/app.js?v=26",
  "./js/verde-ui.js?v=26",
  "./js/services/verde-api.js?v=26",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then(async (names) => {
    const oldCaches = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE);
    await Promise.all(oldCaches.map((name) => caches.delete(name)));
    await self.clients.claim();
  }));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (new URL(request.url).pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request)
      .then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put("./index.html", response.clone()));
        return response;
      })
      .catch(() => caches.match("./index.html")));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});
