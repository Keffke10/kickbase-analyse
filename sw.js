// Service Worker: cached NUR die App-Dateien, niemals API-Antworten oder persönliche Daten.
const VERSION = 'kba-v3';
const SHELL = [
  './', 'index.html', 'datenschutz.html', 'css/app.css',
  'js/app.js', 'js/api.js', 'js/model.js', 'js/charts.js', 'js/util.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // Kickbase-Anfragen unangetastet
  // Network-first, damit Updates sofort ankommen; offline aus dem Cache
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
