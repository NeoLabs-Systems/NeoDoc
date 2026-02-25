/* DocumentNeo Service Worker
   Provides offline shell caching + background sync readiness */

const CACHE_NAME  = 'docneo-v5';
const SHELL_URLS  = [
  '/',
  '/css/app.css',
  '/js/app.js',
  '/js/theme-init.js',
  '/js/login.js',
  '/js/state.js',
  '/js/core/auth.js',
  '/js/core/ui.js',
  '/js/core/helpers.js',
  '/js/views/documents.js',
  '/js/views/chat.js',
  '/js/views/ai.js',
  '/js/views/upload.js',
  '/js/views/tags.js',
  '/js/views/types.js',
  '/js/views/correspondents.js',
  '/js/views/settings.js',
  '/fonts/inter-latin.woff2',
  '/manifest.json',
];

// ── Install: cache the app shell ──────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch strategy ────────────────────────────────────
// - API calls: Network-only (always fresh)
// - Static assets (JS/CSS): Cache-first, update in background
// - HTML navigation: Network-first, cache fallback

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests — let the browser handle them natively
  if (url.origin !== location.origin) return;

  // Never cache API requests
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // HTML navigation: network-first, serve cached shell on failure
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return resp;
        })
        .catch(() => caches.match('/') || caches.match(request))
    );
    return;
  }

  // Static assets: cache-first, async update
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return resp;
      });
      return cached || network;
    })
  );
});
