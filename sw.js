// ── Shuddhi QA — Service Worker ──────────────────────────────────────────────
// Strategy:
//   • Static assets  → Cache First (fast loads, offline capable)
//   • API calls      → Network First (always fresh, fallback to cache)
//   • HTML pages     → Network First (always latest, fallback to cache)
// ─────────────────────────────────────────────────────────────────────────────

const VERSION       = 'shuddhi-qa-v1.0';
const STATIC_CACHE  = `${VERSION}-static`;
const API_CACHE     = `${VERSION}-api`;
const ALL_CACHES    = [STATIC_CACHE, API_CACHE];

// ── Assets to pre-cache on install ───────────────────────────────────────────
const PRECACHE_ASSETS = [
  '/',
  '/app',
  '/index.html',
  '/app.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
];

// ── Offline fallback page ─────────────────────────────────────────────────────
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Shuddhi QA — Offline</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      background:#0b0d13;color:#F0EDE6;
      font-family:'DM Sans',system-ui,sans-serif;
      min-height:100vh;display:flex;align-items:center;justify-content:center;
      text-align:center;padding:24px;
    }
    .icon{
      width:80px;height:80px;border-radius:20px;
      background:linear-gradient(135deg,#E8A020,#C4851A);
      display:flex;align-items:center;justify-content:center;
      font-size:42px;margin:0 auto 24px;
      box-shadow:0 8px 32px rgba(232,162,32,.3);
    }
    h1{font-size:28px;font-weight:700;color:#E8A020;margin-bottom:12px}
    p{font-size:15px;color:#9AA3B2;line-height:1.6;max-width:360px;margin:0 auto 28px}
    button{
      background:linear-gradient(135deg,#E8A020,#C4851A);
      color:#0b0d13;border:none;padding:12px 28px;
      border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;
    }
    button:hover{opacity:.9}
  </style>
</head>
<body>
  <div>
    <div class="icon">श</div>
    <h1>You are offline</h1>
    <p>Shuddhi QA needs an internet connection to generate test cases and connect to Azure DevOps. Please check your connection and try again.</p>
    <button onclick="window.location.reload()">Try Again</button>
  </div>
</body>
</html>`;

// ── Install: pre-cache static assets ─────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache failed:', err))
  );
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !ALL_CACHES.includes(k))
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: routing strategy ───────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ── 1. Skip non-GET and cross-origin requests ──────────────────────────────
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // ── 2. API calls → Network First ──────────────────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  // ── 3. HTML navigation → Network First with offline fallback ──────────────
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache successful HTML responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then(c => c.put(request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(request)
            .then(cached => cached || new Response(OFFLINE_HTML, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }))
        )
    );
    return;
  }

  // ── 4. Static assets (JS, CSS, images, fonts) → Cache First ───────────────
  event.respondWith(cacheFirst(request, STATIC_CACHE));
});

// ── Helper: Cache First strategy ─────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 408, statusText: 'Offline' });
  }
}

// ── Helper: Network First strategy ───────────────────────────────────────────
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response(
      JSON.stringify({ error: 'offline', message: 'No network connection' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── Background sync: notify clients of SW updates ────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
