/* Keep private/live traffic outside the Angular worker, including <audio>,
 * <img>, downloads and Socket.IO requests that do not use HttpClient headers.
 * No respondWith means the browser performs the original request unchanged:
 * no cache, retries, credentials changes or synthetic HTTP 504 responses. */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin ||
      /^\/(?:api|socket\.io|health|__fixture)(?:\/|$)/.test(url.pathname)) {
    event.stopImmediatePropagation();
  }
});

// Angular owns versioned application assets; OPFS/IndexedDB remain independent.
importScripts('./ngsw-worker.js');
