/**
 * Service worker — minimal offline shell, network-first.
 * - Fetches the latest app shell from network; falls back to cache only offline.
 * - /api requests always go to the network.
 */
const CACHE = 'lead-crm-shell-v17';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API / hook / setup / config / csv — always network, never cache
  if (url.pathname.startsWith('/api/') || url.pathname === '/api' ||
      url.pathname.startsWith('/hook/') || url.pathname === '/setup' ||
      url.pathname === '/config.json') {
    return;
  }

  // Shell: network-first. Cache is only a fallback when offline.
  ev.respondWith(
    fetch(req).then(resp => {
      if (resp && resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match(req))
  );
});
