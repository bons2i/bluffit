const CACHE = 'bluffit-v1';
const ASSETS = ['/', '/index.html', '/style.css', '/script.js', '/manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    // Socket.io Requests nie cachen
    if (e.request.url.includes('/socket.io')) return;
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request))
    );
});
