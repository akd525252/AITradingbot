// Simple Service Worker for PWA compliance
const CACHE_NAME = 'gainex-pwa-v6';
const ASSETS = [
  '/landing.html',
  '/css/landing.css',
  '/images/laptop-mockup.png',
  '/images/mobile-mockup.png',
  '/favicon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Do not intercept or cache / or /index.html dynamically to ensure backend cookie routing works correctly
  const url = new URL(event.request.url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return;
  }

  // Network-first for JS and CSS files to prevent stale cached scripts
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
