/* TillTally service worker: cache the app shell so the installed app opens
 * offline. Data itself lives in localStorage / the sync Worker, never here.
 *
 * __TILLTALLY_VERSION__ is a placeholder: every deploy (scripts/deploy-pages.sh
 * locally, or the GitHub Actions workflow) stamps it with a unique version
 * (git short hash) in the deployed copy, so the cache name changes on every
 * deploy and installed apps pick the new shell up automatically — no
 * reinstall, no manual cache bump. The app also checks for updates on load
 * and whenever it returns to the foreground (see app.js). */
const CACHE = "tilltally-shell-__TILLTALLY_VERSION__";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./core.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin GETs (the shell). Sync API calls go to another
  // origin (the Worker) and must always hit the network.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
