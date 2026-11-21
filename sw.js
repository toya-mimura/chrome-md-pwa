/* Service Worker
 * - パスは相対指定（GitHub Pages などのサブパス配信でも動く）
 * - アプリ本体は stale-while-revalidate：キャッシュから即表示しつつ裏で更新し、
 *   次回起動時には新しい版が使われる
 * - 更新時は CACHE_VERSION を上げる
 */
const CACHE_VERSION = 'v2';
const CACHE_NAME = `md-viewer-${CACHE_VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './css/github-markdown.css',
  './css/app.css',
  './js/app.js',
  './js/vendor/marked.min.js',
  './js/vendor/purify.min.js',
  './manifest.json',
  './icons/icon16.png',
  './icons/icon48.png',
  './icons/icon128.png',
  './icons/icon192.png',
  './icons/icon512.png',
  './icons/maskable512.png',
  './test-markdown.md'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n.startsWith('md-viewer-') && n !== CACHE_NAME)
             .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 画面遷移（HTML）はネットワーク優先。オフライン時はキャッシュ
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // それ以外は stale-while-revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
