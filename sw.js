const CACHE = '43note-v4';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // 跳過 Firebase realtime/auth 連線（這些由 Firestore SDK 自行管理）
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('firebaseio.com')) return;

  const isCDN = url.hostname !== self.location.hostname;

  if (isCDN) {
    // CDN 資源（React、Firebase JS）版本固定，優先走快取
    e.respondWith(
      caches.match(e.request).then(cached => cached ||
        fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
      )
    );
  } else {
    // App shell（index.html 等）優先走網路，離線時回落到快取
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
