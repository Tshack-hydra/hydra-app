// Service worker: lets the app open instantly / offline. Always tries the network first so
// updates show up straight away; falls back to the cached copy when there's no signal.
//
// Updates: the GitHub publish workflow replaces __BUILD__ with the commit id, so every publish
// changes this file. Phones notice the new version, install it in the background and the app
// shows "New version available" — it only switches over when the person taps Update.
const BUILD = '__BUILD__';
const CACHE = 'hydra-' + BUILD;
const SHELL = [
  './', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest',
  'js/app.js', 'js/util.js', 'js/icons.js', 'js/google.js', 'js/dropbox.js', 'js/jobs.js',
  'js/calendar.js', 'js/tasks.js', 'js/sheets.js', 'js/crewing.js', 'js/freelancers.js', 'js/sitevisits.js', 'js/receipts.js', 'js/settings.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/hydra-wordmark.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' so the new version never picks up old files from the browser's HTTP cache
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'BUILD') e.source?.postMessage({ build: BUILD });
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never touch API calls
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
