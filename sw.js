/* ComicCam — Service Worker (modo offline)
   Estrategia:
   - App shell (index, manifest, íconos): se precachea al instalar.
   - Librerías (JSZip, jsPDF) y tipografías (Google Fonts): se precachean al instalar
     y, si falta algo, se guarda la primera vez que se pide (cache-first).
   - La API de Gemini (IA) NUNCA se cachea: necesita internet.
   Al cambiar cualquier archivo, subí la versión de CACHE. */
const VERSION = 'v1';
const CACHE = 'comiccam-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// Debe ser EXACTAMENTE la misma URL que el <link> del index.html
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Bangers&family=Permanent+Marker&family=Anton&family=Luckiest+Guy&family=Comic+Neue:wght@400;700&family=Space+Grotesk:wght@400;500;600;700&display=swap';

async function cacheFonts(cache) {
  const res = await fetch(new Request(FONTS_CSS, { mode: 'cors' }));
  if (!res.ok) return;
  await cache.put(FONTS_CSS, res.clone());
  const css = await res.text();
  // Solo subconjuntos latin / latin-ext (alcanzan para español)
  const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{[^}]*?url\((https:[^)]+)\)/g;
  const urls = [];
  let m;
  while ((m = re.exec(css))) {
    if (m[1] === 'latin' || m[1] === 'latin-ext') urls.push(m[2]);
  }
  await Promise.allSettled(urls.map(u => cache.add(new Request(u, { mode: 'cors' }))));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // El shell es obligatorio; lo demás es "mejor esfuerzo" (si no hay red, se cachea luego)
    await cache.addAll(SHELL);
    await Promise.allSettled([
      ...LIBS.map(u => cache.add(new Request(u, { mode: 'cors' }))),
      cacheFonts(cache)
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('comiccam-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Nunca interceptar la API de IA ni otros esquemas
  if (!/^https?:$/.test(url.protocol)) return;
  if (url.hostname === 'generativelanguage.googleapis.com') return;

  // Navegación (abrir la app): red primero (para recibir actualizaciones), caché si no hay internet
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // Resto (mismo origen, cdnjs, Google Fonts): caché primero, y se guarda lo que falte
  const sameOrigin = url.origin === self.location.origin;
  const allowed = sameOrigin ||
    url.hostname === 'cdnjs.cloudflare.com' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com';
  if (!allowed) return;

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
