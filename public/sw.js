// Keeps the location-words page working offline in the field.
// Only these static files are cached; the API and audio always go to the network.
const CACHE = 'sl-v2';
const OFFLINE = ['/where', '/js/geowords.js', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !OFFLINE.includes(url.pathname)) return;
  // Network first (so updates arrive), cached copy when there's no signal
  // or when the network answers with a sign-in redirect instead of the file.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res.ok && !res.redirected) { cache.put(e.request, res.clone()); return res; }
      return (await cache.match(e.request)) || res;
    } catch {
      return (await cache.match(e.request)) || Response.error();
    }
  })());
});
