const CACHE = "wait-what-shell-v16";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=14",
  "./app.js?v=14",
  "./core.js?v=13",
  "./manifest.webmanifest",
  "./icon.svg",
  "./data/shows.json",
  "./data/episodes.json",
  "./data/mtggoldfish.episodes.json",
  "./data/commander-clash.episodes.json",
  "./data/commander-clash-most-annoying.cues.json",
  "./data/hobbit-legends-review.cues.json",
  "./data/hobbit-cards-for-the-other-99.cues.json",
  "./data/commanders-with-keywords-to-support-bottom-up-builds.cues.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate" || url.pathname.includes("/data/")) {
    event.respondWith(fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request)));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
