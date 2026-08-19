/**
 * sw.js — deliberately minimal.
 *
 * This is a live multiplayer game, so correctness matters more than
 * offline support: we always try the network FIRST for everything, and
 * only fall back to a cached copy if the network request fails (e.g. a
 * brief connection drop). This means a fresh `npm start` deploy is
 * always what players get while online — nothing here can serve stale
 * game code. Socket.io's own requests (`/socket.io/...`) and any
 * `/api/...` calls are left completely untouched.
 */

const CACHE_NAME = "mmg-shell-v1";
const SHELL_FILES = [
  "style.css",
  "faces.js",
  "sound.js",
  "icons.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return; // never touch POST/PUT/DELETE (admin API etc.)
  if (url.pathname.startsWith("/socket.io/") || url.pathname.startsWith("/api/")) return; // live data only

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
