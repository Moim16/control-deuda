// =============================================================================
//  Service worker minimo: cachea el "cascaron" (HTML, manifest, iconos) para que
//  la app ABRA rapido y aunque no haya señal. Las llamadas a /api/ NUNCA se
//  cachean: los saldos siempre salen del servidor.
// =============================================================================

const CACHE = "deudas-v1";
const SHELL = [
  "/", "/index.html", "/manifest.webmanifest",
  "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;   // datos: siempre de la red

  // Network-first: si hay red se ve lo ultimo; si no, sale del cache.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html")))
  );
});
