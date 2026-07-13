const CACHE_NAME = 'wbdl-shell-v1';

const SHELL_ASSETS = [
    '/style.css',
    '/nav.js',
    '/assets/icon.png',
    '/assets/icon-192.png',
    '/assets/icon-512.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Never cache API calls or auth-sensitive routes - always go to network.
    if (url.pathname.startsWith('/api/')) return;

    // Static assets: cache-first, fall back to network and populate cache.
    if (url.pathname.startsWith('/assets/') || url.pathname === '/style.css' || url.pathname === '/nav.js') {
        event.respondWith(
            caches.match(req).then((cached) => {
                if (cached) return cached;
                return fetch(req).then((res) => {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
                    return res;
                });
            })
        );
        return;
    }

    // HTML pages: network-first so content stays fresh, cache as offline fallback.
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
                    return res;
                })
                .catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
        );
    }
});
