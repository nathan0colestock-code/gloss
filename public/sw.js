// Gloss service worker — minimal offline fallback.
//
// Strategy:
//   - Precache the offline page + a handful of static assets on install.
//   - Network-first for everything else. On failure, if the request is a
//     navigation (HTML), serve /offline.html so users get *something*
//     instead of the browser's default error page.
//   - Bump CACHE_NAME when static assets change — old caches are purged on
//     activate so clients pick up new content deterministically.

const CACHE_NAME = 'gloss-v1-2026-04-23';
const PRECACHE = [
  '/offline.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET; POSTs (auth, mutations) must always hit the network.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Don't intercept cross-origin — let the browser handle those directly.
  if (url.origin !== self.location.origin) return;

  // API calls: network-only. Caching stale state would be worse than an
  // honest failure for a note-taking app.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(req)
      .then((resp) => {
        // Opportunistically cache static assets we just fetched.
        if (resp.ok && /\.(css|js|png|svg|woff2?|ico|json)$/.test(url.pathname)) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req);
        if (cached) return cached;
        // Navigation request with no cached copy → offline fallback page.
        if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
          const offline = await cache.match('/offline.html');
          if (offline) return offline;
        }
        return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      })
  );
});
