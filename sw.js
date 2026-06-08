const CACHE_NAME = 'pos-cache-v5';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './app.js',
  './style.css',
  // Daftarkan CDN agar aplikasi bisa benar-benar offline
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    }).then(() => self.skipWaiting()) // Memaksa SW baru langsung aktif
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Menghapus cache lama:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Abaikan request ke API Firebase agar real-time database tidak nyangkut di cache
  if (event.request.url.includes('firestore.googleapis.com') || event.request.url.includes('firebaseauthv1')) {
    return; 
  }

  event.respondWith(
    caches.match(event.request).then(response => {
      // Kembalikan dari cache, jika tidak ada baru ambil dari internet
      return response || fetch(event.request).catch(() => {
        // Fallback jika offline total
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});