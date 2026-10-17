/* Service worker: keeps the app files on the phone so the app opens without internet.
 * It never caches the Apps Script API — data goes through the outbox in sync.js. */
var CACHE = 'ortho-__BUILD__';
var SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'ledger.js', 'core.js', 'sync.js', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('ortho-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  var sameOrigin = url.origin === self.location.origin;
  var fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !fonts) return;                    // API, Google sign-in: always live
  // stale-while-revalidate: answer from the phone at once, refresh in the background
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: sameOrigin }).then(function (hit) {
      var net = fetch(req).then(function (res) { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(function () { return hit || (req.mode === 'navigate' ? c.match('index.html') : undefined); });
      return hit || net;
    });
  }));
});
