// Keeps the app shell working offline, so the Location tab works in the field.
// API calls and audio always go to the network.
const CACHE = 'sl-v3';
const SHELL = [
  '/', '/where', '/app.css', '/manifest.webmanifest', '/icon.svg',
  '/js/main.js', '/js/where.js', '/js/geowords.js', '/js/util.js', '/js/dsp.js', '/js/api.js',
  '/js/library.js', '/js/ingest.js', '/js/zip.js', '/js/wav.js', '/js/slate.js', '/js/clip.js',
  '/js/denoise.js', '/js/clip.worker.js',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(url.pathname)) return;
  // Network first (so updates arrive); the cached copy when there's no signal,
  // or when the network answers with a sign-in redirect instead of the file.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res.ok && !res.redirected) { cache.put(url.pathname, res.clone()); return res; }
      return (await cache.match(url.pathname)) || res;
    } catch {
      return (await cache.match(url.pathname)) || Response.error();
    }
  })());
});
