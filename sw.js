/* Service Worker
 * - パスは相対指定（GitHub Pages などのサブパス配信でも動く）
 * - アプリ本体は stale-while-revalidate：キャッシュから即表示しつつ裏で更新し、
 *   次回起動時には新しい版が使われる
 * - 更新時は CACHE_VERSION を上げる
 * - Mermaid / KaTeX は大きいので事前キャッシュせず、初めて使ったときにキャッシュする
 * - Android の「共有」から送られたファイル/テキスト（Share Target）を受け取り、
 *   一時的にキャッシュへ置いてからアプリに渡す
 */
const CACHE_VERSION = 'v4';
const SHARE_CACHE = 'mdv-share-inbox';
const CACHE_NAME = `md-viewer-${CACHE_VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './css/github-markdown.css',
  './css/app.css',
  './js/app.js',
  './js/library.js',
  './js/search.js',
  './js/rich.js',
  './js/translate.js',
  './js/vendor/highlight.min.js',
  './css/vendor/hljs-github-dark.min.css',
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
  const reqUrl = new URL(req.url);

  // 共有メニューから送られてきたデータ（manifest.json の share_target）
  if (req.method === 'POST' && reqUrl.origin === self.location.origin && reqUrl.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(req));
    return;
  }

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

async function handleShare(request) {
  const redirectTo = new URL('./?shared=1', self.registration.scope).href;
  try {
    const form = await request.formData();
    const payload = {
      title: form.get('title') || '',
      text: form.get('text') || '',
      url: form.get('url') || ''
    };
    const file = form.get('file');
    if (file && typeof file === 'object' && 'text' in file) {
      payload.fileName = file.name || 'shared.md';
      payload.fileText = await file.text();
    }
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(new URL('./__shared__', self.registration.scope).href,
      new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {
    // 受け取りに失敗してもアプリは開く
  }
  return Response.redirect(redirectTo, 303);
}
