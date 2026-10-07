const BUILD_ID = (
  new URL(self.location.href).searchParams.get('build') || 'development'
)
  .replace(/[^a-z0-9._-]/gi, '')
  .slice(0, 48) || 'development';

const CACHE_PREFIX = 'event-watch-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png?v=3', '/icons/favicon.svg?v=3'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE.map(async (path) => {
      try {
        const response = await fetch(path, { cache: 'reload' });
        if (response.ok) await cache.put(path, response);
      } catch {
        // A single cache miss must never prevent the worker from installing.
      }
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) ?? caches.match(OFFLINE_URL)),
    );
    return;
  }

  const isStaticAsset =
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/styles.css' ||
    url.pathname === '/app.js' ||
    url.pathname === '/detail.js' ||
    url.pathname === '/detail.html' ||
    url.pathname.startsWith('/icons/');

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const updated = fetch(request)
          .then((response) => {
            if (response.ok) {
              caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
            }
            return response;
          })
          .catch(() => cached);

        return cached ?? updated;
      }),
    );
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Show a visible fallback. */ }
  event.waitUntil(self.registration.showNotification(payload.title || 'Event Watch update', {
    body: payload.body || 'One of your watched pages has changed.',
    icon: '/icons/icon-192.png?v=3', badge: '/icons/icon-192.png?v=3',
    tag: payload.tag || 'event-watch-update',
    data: { url: payload.url || '/' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || '/', self.location.origin);
    if (target.origin !== self.location.origin) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('navigate' in client) { await client.navigate(target.href); await client.focus(); return; }
    }
    await self.clients.openWindow(target.href);
  })());
});
