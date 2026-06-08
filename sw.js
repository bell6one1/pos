const CACHE_NAME = 'pos-cache-v7'; // Naikkan versi cache
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './style.css',
  './app.js',
  './firebase-config.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.url.includes('firestore.googleapis.com') || event.request.url.includes('firebaseauthv1')) {
    return; 
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if(response.status === 200 && urlsToCache.some(url => event.request.url.includes(url.replace('./','')))) {
           let responseClone = response.clone();
           caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});