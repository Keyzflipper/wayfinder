// sw.js — Wayfinder service worker
// Strategy: cache-first for the static app shell, network-first for /api/*,
// with a dedicated offline fallback page for failed navigations.

// Bump this whenever index.html/main.js/styles.css change — browsers detect
// a service worker update by diffing sw.js's own bytes, not anything cached
// inside it, so a version-only change here is what actually busts stale
// shells for returning users. (Last bumped: guide-upload UI, "more nearby",
// and the Trips/history view all landed without a bump — this catches up.)
const CACHE_VERSION = 'wayfinder-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const API_CACHE = `${CACHE_VERSION}-api`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
  '/src/main.js',
  '/src/styles.css',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
];

// ---- Install: pre-cache the app shell ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ---- Activate: drop old caches from previous versions ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('wayfinder-') && key !== SHELL_CACHE && key !== API_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---- Fetch ----
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests; let everything else (POSTs to
  // /api/identify with FormData, cross-origin calls, etc.) pass through untouched.
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

// ---- Strategies ----

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Static asset unavailable and not cached — for a page navigation,
    // fall back to the offline page. For anything else, let it fail.
    if (request.mode === 'navigate') {
      const offline = await caches.match('/offline.html');
      if (offline) return offline;
    }
    throw err;
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;

    // No network, no cached copy — return a real JSON error the app's
    // fetch handling in main.js can catch and surface, not a broken response.
    return new Response(
      JSON.stringify({ error: 'offline', message: 'No connection and no cached data for this request.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
