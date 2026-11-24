/* 历史知识库 · 离线缓存
 * 策略：
 *  - 导航请求：网络优先，失败回退到缓存的 index.html
 *  - 静态资源：缓存优先 + 后台更新（stale-while-revalidate）
 * 重新部署后如资源有变，改下面的 CACHE 版本号即可整体换新。
 */
const CACHE = 'hs-static-v15';
const ASSETS = [
  './',
  './index.html',
  './detail.html',
  './assets/css/app.css',
  './assets/css/editorial.css',
  './assets/css/hidden-fix.css',
  './assets/js/app.js',
  './assets/js/chrome.js',
  './assets/js/store.js',
  './assets/js/search-worker.js',
  './assets/vendor/pdfjs/pdf.min.mjs',
  './assets/vendor/pdfjs/pdf.worker.min.mjs',
  './data/knowledge.json',
  './data/books.json',
  './data/aliases.json',
  './data/pinyin.json',
  './timeline.html',
  './assets/css/timeline.css',
  './assets/css/timeline-editorial.css',
  './assets/css/timeline-plus.css',
  './assets/css/detail.css',
  './assets/js/timeline.js',
  './assets/js/detail.js',
  './data/timeline.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航：先走网络，断网时回退首页
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req);
          if (hit) return hit;
          if (url.pathname.endsWith('/detail.html')) return caches.match('./detail.html');
          if (url.pathname.endsWith('/timeline.html')) return caches.match('./timeline.html');
          return caches.match('./index.html');
        })
    );
    return;
  }

  // 其余静态资源：缓存优先，同时后台刷新
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
