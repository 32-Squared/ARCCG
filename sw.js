/* ARCCG service worker
 * Shell: precached at install (network-first on navigation so updates land).
 * Card/rulebook/UI images: cache-first at runtime (immutable content).
 * Bump VERSION on any shell change to invalidate old caches.
 */
const VERSION = 'arccg-v1';
const SHELL_CACHE = VERSION + '-shell';
const ASSET_CACHE = VERSION + '-assets';

const SHELL = [
  '/',
  '/index.html',
  '/engine.js',
  '/card_manifest.json',
  '/manifest.json',
  '/imgs/arccg.webp',
  '/imgs/cardback.webp',
  '/imgs/maniacs.webp',
  '/imgs/teku.webp',
  '/imgs/silencerz.webp',
  '/imgs/drones.webp',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;              // CDN fonts etc: default
  if (url.pathname.startsWith('/.netlify/')) return;       // never cache the AI function

  // Immutable game assets: cache-first
  if (/^\/(cards|thumbs|rules|imgs|icons)\//.test(url.pathname)) {
    e.respondWith(
      caches.open(ASSET_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  // Shell: network-first with cache fallback (offline play)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});
