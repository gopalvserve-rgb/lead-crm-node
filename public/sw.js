/**
 * Service worker — minimal offline shell.
 * - Caches the app shell so it opens fast / works briefly offline.
 * - /api requests always go to the network (no caching of business data).
 */
const CACHE = 'lead-crm-shell-v1';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API, hook, setup, sample.csv — always network
  if (url.pathname.startsWith('/api/') || url.pathname === '/api' ||
      url.pathname.startsWith('/hook/') || url.pathname === '/setup' ||
      url.pathname === '/config.json') {
    return;
  }

  // Shell: cache-first, then network fallback
  ev.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(resp => {
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
      }
      return resp;
    }).catch(() => cached))
  );
});
