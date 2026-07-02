const CACHE = '43note-v5';

// App shell + 版本固定的 Firebase SDK（預快取，保證離線可啟動）
const PRECACHE = [
  './',
  './manifest.json',
  './icon.svg',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache =>
        // allSettled：任一失敗不阻塞其他項目
        Promise.allSettled(PRECACHE.map(url => cache.add(url)))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 只排除 Firebase 即時 API，不排除字型 CDN
const isFirebaseApi = (hostname) =>
  hostname.includes('firebaseio.com') ||
  hostname === 'identitytoolkit.googleapis.com' ||
  hostname === 'securetoken.googleapis.com';

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Firebase 即時連線由 SDK 自行管理，不攔截
  if (isFirebaseApi(url.hostname)) return;

  const isCDN = url.hostname !== self.location.hostname;

  if (isCDN) {
    // CDN 資源（React、Firebase SDK、字型）：優先走快取
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached ||
        fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
      )
    );
  } else {
    // App shell：優先走網路，離線時回落快取
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});
