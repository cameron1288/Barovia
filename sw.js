// Service worker: makes the Chronicle an installable, fast, offline-capable app.
//
// - Site pages, styles, and scripts: served instantly from the on-device cache, then
//   re-checked with GitHub in the background ("stale-while-revalidate"). If something
//   changed, open pages get a message and show a "tap to refresh" notice.
// - Images, audio, PDFs: cached the first time they're viewed (cache-first).
// - The AI chat relay and anything on other sites pass straight through, uncached.
//
// Bump VERSION only if the caching logic itself changes; content updates don't need it.

const VERSION = 'v1';
const SHELL_CACHE = `barovia-shell-${VERSION}`;
const MEDIA_CACHE = `barovia-media-${VERSION}`;

const SHELL = [
    './', 'index.html', 'css/style.css', 'js/chronicle.js', 'manifest.webmanifest',
    'icons/icon-192.png', 'icons/icon-512.png',
    ...['overview', 'players', 'inventory', 'sessions', 'timeline', 'npcs', 'quests', 'battles',
        'lore', 'codex', 'locations', 'map', 'tarokka', 'library'].map(f => `content/${f}.html`),
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            // Individually, so one missing file can't block installation.
            .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {}))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys
                .filter(k => k.startsWith('barovia-') && k !== SHELL_CACHE && k !== MEDIA_CACHE)
                .map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

function isMedia(url) {
    return /\.(png|jpe?g|webp|gif|svg|mp3|wav|pdf)$/i.test(url.pathname);
}

async function notifyUpdated() {
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'chronicle-updated' }));
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(SHELL_CACHE);
    // ignoreSearch: '?v=…' style cache-busters still hit the cached copy.
    const cached = await cache.match(request, { ignoreSearch: true });
    const network = fetch(request).then(async response => {
        if (response && response.ok) {
            // Only announce real changes: compare GitHub's ETag / Last-Modified headers.
            const tag = r => r && (r.headers.get('etag') || r.headers.get('last-modified'));
            const changed = cached && tag(cached) && tag(response) && tag(cached) !== tag(response);
            await cache.put(request, response.clone());
            if (changed) notifyUpdated();
        }
        return response;
    }).catch(() => cached);
    return cached || network;
}

async function cacheFirst(request) {
    const cache = await caches.open(MEDIA_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    // Audio is fetched in ranges (206), which can't be cached whole; only cache full responses.
    if (response && response.status === 200) cache.put(request, response.clone());
    return response;
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;          // chat relay, CDNs, other sites
    if (request.headers.has('range')) return;                  // let the browser stream audio
    event.respondWith(isMedia(url) ? cacheFirst(request) : staleWhileRevalidate(request));
});
