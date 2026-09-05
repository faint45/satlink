/* PWA 安裝條件與行動版顯示的靜態檢核。

   這一類問題的共同點是**不會報錯**：manifest 少一個欄位、icon 尺寸不對、
   viewport 少了 viewport-fit，網站照樣跑，只是安裝不了或在 iPhone 上被瀏海
   吃掉一角。要在部署前擋下來，不能等使用者回報。

   node validation/test_pwa.mjs
*/
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROTO = join(ROOT, 'prototype');
const P = f => join(PROTO, f);

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
console.log('PWA 安裝條件檢核');

const html = readFileSync(P('index.html'), 'utf8');
const mf = JSON.parse(readFileSync(P('manifest.json'), 'utf8'));
const sw = readFileSync(P('sw.js'), 'utf8');

/* ── 1. manifest 必要欄位（Chrome 的可安裝條件）─────────────── */
for (const k of ['name', 'short_name', 'start_url', 'display', 'icons']) {
  t(`manifest 有 ${k}`, mf[k] !== undefined && mf[k] !== '', JSON.stringify(mf[k]).slice(0, 60));
}
t('display 為可安裝的模式', ['standalone', 'fullscreen', 'minimal-ui'].includes(mf.display), mf.display);

// 子目錄部署（GitHub Pages 在 /satlink/）時，絕對路徑會指到網站根而失效
for (const k of ['start_url', 'scope', 'id']) {
  t(`${k} 為相對路徑（子目錄部署才不會壞）`, typeof mf[k] === 'string' && !mf[k].startsWith('/'),
    `${k} = ${mf[k]}`);
}

/* ── 2. 圖示：檔案存在且尺寸與宣告相符 ───────────────────────── */
function pngSize(p) {
  const b = readFileSync(p);
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
const bad = [];
for (const ic of mf.icons) {
  const f = P(ic.src);
  if (!existsSync(f)) { bad.push(`${ic.src} 不存在`); continue; }
  const sz = pngSize(f);
  const [w, h] = ic.sizes.split('x').map(Number);
  if (!sz || sz[0] !== w || sz[1] !== h) bad.push(`${ic.src} 實際 ${sz} ≠ 宣告 ${ic.sizes}`);
}
t('manifest 宣告的圖示都存在且尺寸相符', bad.length === 0,
  bad.length ? bad.join('；') : `${mf.icons.length} 個圖示`);
t('有 192 與 512 的 any 用途圖示（Chrome 可安裝的門檻）',
  ['192x192', '512x512'].every(s => mf.icons.some(i => i.sizes === s && /any/.test(i.purpose || 'any'))));
t('有 maskable 圖示（Android 自適應圖示不會被裁掉邊）',
  mf.icons.some(i => /maskable/.test(i.purpose || '')));

/* ── 3. iOS：沒有安裝 API，全靠這幾個 meta ────────────────── */
t('viewport 帶 viewport-fit=cover（env(safe-area-inset-*) 生效的前提）',
  /viewport-fit\s*=\s*cover/.test(html));
const translucent = /apple-mobile-web-app-status-bar-style"\s+content="black-translucent"/.test(html);
t('黑色半透明狀態列與 viewport-fit=cover 成對出現',
  !translucent || /viewport-fit\s*=\s*cover/.test(html),
  translucent ? '兩者皆有（內容延伸到狀態列下，且取得到安全距離）' : '未使用 translucent');
t('有 apple-touch-icon', /rel="apple-touch-icon"/.test(html));
const ati = P('icons/apple-touch-icon.png');
t('apple-touch-icon 為 180×180（iOS 主畫面的標準尺寸）',
  existsSync(ati) && String(pngSize(ati)) === '180,180', String(pngSize(ati)));
t('有 apple-mobile-web-app-capable', /apple-mobile-web-app-capable"\s+content="yes"/.test(html));
t('有 apple-mobile-web-app-title', /apple-mobile-web-app-title"/.test(html));

/* ── 4. 安裝流程：兩個平台都要被處理 ─────────────────────── */
t('有攔截 Android 的 beforeinstallprompt', /beforeinstallprompt/.test(html));
t('有 iOS 專用的安裝說明（iOS 不會觸發 beforeinstallprompt）',
  /iPad\|iPhone\|iPod/.test(html) && /加入主畫面/.test(html));
t('偵測 iOS 上非 Safari 的瀏覽器（那些無法安裝）', /CriOS/.test(html));
t('已安裝狀態可偵測（display-mode 或 navigator.standalone）',
  /display-mode:\s*standalone/.test(html) && /navigator\.standalone/.test(html));
t('關於頁有常駐的安裝入口（提示關掉後仍找得到）', /a_inst/.test(html));

/* ── 5. 安全範圍：實際有用到 env()，不是只加了 meta ───────── */
const css = readFileSync(P('theme.css'), 'utf8');
const envCount = (css.match(/env\(safe-area-inset-/g) || []).length;
t('CSS 實際使用 safe-area-inset（不是只有 meta）', envCount >= 8, `${envCount} 處`);
for (const id of ['#mnav', '#time', '#layers']) {
  t(`${id} 有補安全距離`, new RegExp(`${id}[^{]*\{[^}]*safe-area-inset`).test(css.replace(/\n/g, ' ')));
}

/* ── 6. Service Worker：離線可用的前提 ───────────────────── */
t('SW 預快取 manifest 與圖示', /manifest\.json/.test(sw) && /icons\//.test(sw));
t('SW 有版本號', /satlink-v[\d.]+/.test(sw), (sw.match(/satlink-v[\d.]+/) || [])[0]);
t('/api/* 不進快取（計數必須是即時的）', /api\//.test(sw));

/* ── 7. 描述與實際內容一致（防止文案過時）─────────────────── */
const tle = JSON.parse(readFileSync(P('tle_cache.json'), 'utf8'));
const n = (tle.sats || tle).length ?? Object.keys(tle).length;
const claimed = (mf.description.match(/(\d+)\s*顆衛星/) || [])[1];
t('manifest 描述的衛星數與實際資料一致', claimed && Math.abs(+claimed - n) === 0,
  `描述 ${claimed} 顆 vs 實際 ${n} 顆`);

console.log(`\n${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
