// 電波がない時もアプリを開けるようにする（画面のファイルとFirebaseの部品を端末に残す）
// データそのもの（Firestore）はここでは扱わない
const CACHE = 'houmon-v1';
const SDK = 'https://www.gstatic.com/firebasejs/13.1.0/';
const FILES = ['./', './index.html', './db.js', './manifest.json',
  SDK + 'firebase-app.js', SDK + 'firebase-auth.js', SDK + 'firebase-firestore.js'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firebaseの部品：版を固定しているので、端末に残したものを使う
  if (req.url.startsWith(SDK)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;
  // 自分のファイル：まずネットから新しいものを取る。4秒で来なければ端末に残したものを使う
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; });
    const late = new Promise(res => setTimeout(res, 4000));
    try {
      const r = await Promise.race([net, late.then(() => null)]);
      if (r) return r;
    } catch (_) { /* 圏外 */ }
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || net;
  })());
});
