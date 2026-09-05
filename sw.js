/* sw.js — SatLink Service Worker
   策略：全量預快取（約 6.5 MB），之後 cache-first。
   本應用的資料全部是「取得當下的快照」（TLE 快取、JPL 星曆表、VIIRS 影像），
   本來就不是即時串流，因此離線與線上結果一致 —— 這點必須誠實對使用者說明：
   離線可用不代表資料是即時的，TLE 年齡與星曆涵蓋期都顯示在介面上。
   版本號改動即觸發重新預快取並淘汰舊版。 */
const VERSION = 'satlink-v1.19.0';
const CORE = [
  './',
  './index.html',
  './manifest.json',
  './theme.css',
  './app.js',
  './physics.js',
  './beams.js',
  './satmodels.js',
  './deepspace.js',
  './lib/three.module.js',
  './lib/OrbitControls.js',
  './lib/satellite.min.js',
  './tle_cache.json',
  './stars.json',
  './deepspace.json',
  './astro.js',
  './astro.json',
  './cams.js',
  './cams.json',
  './tex/earth_atmos_2048.jpg',
  './tex/earth_lights_2048.png',
  './tex/earth_specular_2048.jpg',
  './tex/earth_normal_2048.jpg',
  './tex/earth_clouds_1024.png',
  './tex/gibs_truecolor.jpg',
  './tex/moon_1024.jpg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // 逐項加入：任何一項失敗不應讓整個安裝失敗（例如某張貼圖暫時 404）
    const results = await Promise.allSettled(CORE.map(u => c.add(new Request(u, {cache:'reload'}))));
    const failed = CORE.filter((u,i) => results[i].status === 'rejected');
    if (failed.length) console.warn('[SatLink SW] 這些資產未快取:', failed);
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // /api/* 為即時資料（線上人數等），一律走網路，不得快取
  if (new URL(req.url).pathname.startsWith('/api/')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 外部請求不攔截

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    // ignoreSearch：貼圖帶有 ?v=<hash> 的快取破壞參數，需忽略查詢字串比對
    const hit = await cache.match(req, {ignoreSearch:true});
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      // 離線且未快取：導覽請求退回應用外殼
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
