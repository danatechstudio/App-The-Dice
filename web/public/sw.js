// Roll The Dice service worker: installability plus a usable offline diary.
// - Pages: network first, falling back to the last copy (then the app shell).
// - /assets/* (content-hashed): cache first.
// - Public diary API: network first, falling back to the last answer.
// - Staff, internal and anything cross-origin: never touched.

const SHELL = 'rtd-shell-v1';
const RUNTIME = 'rtd-runtime-v1';
// Event photos (/images/<hash>) never change at a URL, so they are cached for good.
const PRECACHE = ['/', '/manifest.webmanifest', '/brand/rtd-logo.webp', '/brand/rtd-dice-mark.webp', '/icons/icon-192.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isPublicApi = path =>
  path.startsWith('/api/events') || path.startsWith('/api/occurrences/') || path === '/api/health';

async function networkFirst(request, fallback) {
  const cache = await caches.open(RUNTIME);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = (await cache.match(request)) || (fallback && (await caches.match(fallback)));
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // A file missing after a deploy comes back as the app page (SPA fallback):
  // never store that under a script, style or image URL.
  const isPage = (response.headers.get('Content-Type') || '').includes('text/html');
  if (response.ok && !isPage) (await caches.open(RUNTIME)).put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/staff') || url.pathname.startsWith('/internal')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/'));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
  } else if (isPublicApi(url.pathname) && !url.pathname.endsWith('.ics')) {
    event.respondWith(networkFirst(request));
  } else if (url.pathname.startsWith('/brand/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/images/')) {
    event.respondWith(cacheFirst(request));
  }
});
