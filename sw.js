// Naikkan versi cache agar browser memuat ulang file terbaru
const CACHE_NAME = 'pos-cache-v12'; 

// Daftarkan SEMUA file lokal penting ke dalam memori offline
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

// Hapus cache versi lama secara otomatis agar memori browser tidak penuh
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      // Kembalikan dari cache lokal jika ada, jika tidak, unduh dari internet
      return response || fetch(event.request);
    })
  );
});
