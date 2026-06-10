// Cache-first service worker — makes the app fully offline once installed.
// Bump VERSION whenever any file changes so installed phones pick up updates.
const VERSION = 'wtt-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './data.js',
  './app.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(cached =>
      cached ||
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
