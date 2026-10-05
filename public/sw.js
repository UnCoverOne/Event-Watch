const CACHE_NAME = 'event-watch-v2';
const APP_SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));

    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(async (path) => {
      try {
        const response = await fetch(path, { cache: 'reload' });
        if (response.ok) await cache.put(path, response);
      } catch {
        // A single optional asset must never prevent service-worker activation.
      }
    }));

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('/', response.clone());
        }
        return response;
      } catch {
        return (await caches.match('/')) || new Response('Event Watch is offline.', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return (await caches.match(request)) || Response.error();
    }
  })());
});
