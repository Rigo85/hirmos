/* Retires the Angular service worker used by early Hirmos beta releases. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.registration.unregister();
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith('ngsw:')).map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

// Deliberately no fetch handler: every request goes directly to the network.
