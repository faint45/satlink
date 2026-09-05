/* test_render_invariants.mjs — 渲染不變式回歸測試（靜態原始碼分析）
 *
 * 釘住的是這個實際發生過的錯誤：
 *   WebGLRenderer 開了 logarithmicDepthBuffer，但自訂的 ShaderMaterial
 *   （地球、大氣、恆星、衛星點、深空天體、影像標記）沒有納入 three.js 的
 *   logdepthbuf shader chunk。兩者寫入的深度值基準不同，深度比較失效，
 *   結果是衛星、軌道線穿透地球被畫出來。
 *
 * 為什麼是靜態檢查而不是像素比對：穿透與否要有 GPU 才看得出來，
 *   而 CI／命令列沒有。所以這裡釘的是「不可能再產生該錯誤」的原始碼條件 ——
 *   要嘛不開對數深度緩衝，要嘛每個自訂 shader 都納入對應 chunk。
 *   當時的實際驗證方式（隱藏 21 顆幾何上被遮蔽的衛星、畫面完全無變化）
 *   仍記錄在 README，那是一次性的人工驗證，不是這支測試能取代的。
 *
 * 執行：node validation/test_render_invariants.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = f => join(ROOT, 'prototype', f);
const SOURCES = ['app.js', 'astro.js', 'cams.js', 'beams.js', 'satmodels.js'];

let fails = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
}

console.log('渲染不變式回歸測試（靜態分析）');

const src = {};
for (const f of SOURCES) {
  if (!existsSync(P(f))) { check(`原始檔存在：${f}`, false, '找不到'); continue; }
  src[f] = readFileSync(P(f), 'utf8');
}
const all = Object.values(src).join('\n');

/* 1. 對數深度緩衝與自訂 shader 的相容性 —— 這就是穿透 bug 的根因 */
{
  const logDepthOn = /new\s+THREE\.WebGLRenderer\s*\(\s*\{[^}]*logarithmicDepthBuffer\s*:\s*true/s.test(all);
  // 粗略切出每個 ShaderMaterial 區塊，看是否含 logdepthbuf chunk
  const blocks = all.split('new THREE.ShaderMaterial').slice(1);
  const withoutChunk = blocks.filter(b => !/logdepthbuf/.test(b.slice(0, 2500))).length;

  check('自訂 ShaderMaterial 數量可被偵測', blocks.length > 0, `${blocks.length} 個`);

  if (logDepthOn) {
    check('開啟對數深度緩衝時，所有自訂 shader 皆納入 logdepthbuf chunk',
      withoutChunk === 0,
      withoutChunk === 0 ? '全部相容'
        : `${withoutChunk} 個缺少 chunk —— 深度基準不一致，衛星會穿透地球`);
  } else {
    check('未開啟對數深度緩衝（自訂 shader 與內建材質使用同一深度基準）',
      true, `${blocks.length} 個自訂 shader，皆使用一般深度緩衝`);
  }
}

/* 2. 近裁剪面不可過小 —— 過小會耗盡深度精度，同樣造成穿透 */
{
  const m = all.match(/new\s+THREE\.PerspectiveCamera\s*\(\s*([\d.]+)\s*,[^,]+,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (!m) { check('可解析相機近／遠裁剪面', false, '找不到 PerspectiveCamera 宣告'); }
  else {
    const near = parseFloat(m[2]), far = parseFloat(m[3]);
    const ratio = far / near;
    check('近裁剪面不過小', near >= 0.1, `near = ${near}`);
    // 24 位元深度緩衝在 far/near 約 1e5 以內可維持足夠精度
    check('far/near 比在深度精度可接受範圍', ratio <= 1e5,
      `far/near = ${ratio.toExponential(1)}（near ${near} / far ${far}）`);
  }
}

/* 3. 地球必須寫入深度，否則沒有東西能遮擋 */
{
  const earthBlock = (src['app.js'] || '').match(/earthMat\s*=\s*new THREE\.ShaderMaterial\([\s\S]{0,3000}?\}\)/);
  const body = earthBlock ? earthBlock[0] : '';
  check('地球材質未關閉深度寫入', !/depthWrite\s*:\s*false/.test(body),
    earthBlock ? '未見 depthWrite:false' : '（未能定位 earthMat，跳過內容檢查）');
}

/* 4. 疊加圖層允許不寫深度，但不得關閉深度測試 —— 關掉就會畫在地球前面 */
{
  const offenders = [];
  for (const [f, s] of Object.entries(src)) {
    // 只看疊加在地球上的圖層，標籤（Sprite）本來就該永遠可見，不在此列
    const re = /new THREE\.(?:Points|Line|LineSegments|LineLoop|Mesh)\([\s\S]{0,900}?depthTest\s*:\s*false/g;
    let m2;
    while ((m2 = re.exec(s))) {
      const seg = m2[0];
      if (/Sprite|SpriteMaterial|labelSprite/.test(seg)) continue;
      offenders.push(f);
    }
  }
  check('地球上的疊加圖層未關閉深度測試',
    offenders.length === 0,
    offenders.length ? `違規檔案：${[...new Set(offenders)].join(', ')}` : '無');
}

/* 5. 主迴圈必須有例外守門 —— 否則畫面凍住卻沒有任何訊息（曾發生過） */
{
  const app = src['app.js'] || '';
  const hasGuard = /try\s*\{\s*frame\(\)/.test(app) && /loopDead/.test(app);
  check('主迴圈有例外守門並會大聲失敗', hasGuard,
    hasGuard ? '例外會停止迴圈並顯示於畫面' : '缺少 try/catch，例外會讓畫面靜默凍結');
}

/* 6. 環繞距離下限只能由 updateCtlLimits() 推導，不得散落在各條路徑上。
   釘住的 bug：MIN_FREE 是「離地心」的下限，而 flyToCam 把 ctl.target 移到地表某點
   卻沒有跟著改下限，於是相機被夾在離該點 6,394 km 外 —— 表面症狀是
   「滾輪推近完全沒反應，只有拉遠有作用」，畫面本身看起來完全正常，很難察覺。
   根治方式是從 ctl.target 推導，而不是每條路徑各自去設；這裡靜態釘住那個約定。 */
{
  const app = src['app.js'] || '';
  const hasFn = /function updateCtlLimits\(\)/.test(app);
  check('存在集中推導距離下限的 updateCtlLimits()', hasFn,
    hasFn ? '下限由 ctl.target 決定，不由「進入了哪個模式」決定' : '找不到 updateCtlLimits()');

  const assigns = [...app.matchAll(/ctl\.minDistance\s*=/g)].length;
  check('未在其他路徑直接指派 ctl.minDistance', assigns <= 2,
    `共 ${assigns} 處（允許 2：初始化一次 + updateCtlLimits 內部一次）`);

  const inLoop = /updateRoam\(\);[\s\S]{0,40}?updateCtlLimits\(\);[\s\S]{0,40}?ctl\.update\(\);/.test(app);
  check('主迴圈在 ctl.update() 之前套用下限', inLoop,
    inLoop ? '每幀重新推導，新增的移動視角路徑不必記得這件事'
           : '未在 ctl.update() 之前呼叫 updateCtlLimits()');

  const hasExit = /function clearSurfaceView\(\)/.test(app);
  check('有離開地表視角的回頭路', hasExit,
    hasExit ? 'clearSurfaceView()：關面板／點空白處／關圖層都交還地心'
            : '缺少 clearSurfaceView()，從清單點攝影機後將永遠留在地表視角');
}

/* 7. app.js 取用的每一個元素 id，都必須真的存在於 index.html。
   釘住的 bug：加上行讀數時，新版 app.js 寫 $('sec_up').style.opacity，
   但 Service Worker 更新期間瀏覽器可能是「舊 HTML + 新 JS」，
   那個元素不存在 → TypeError → **整個主迴圈被殺掉**，畫面凍住。
   已改成安全取元素當作最後防線，但根本問題是兩個檔案不同步，
   這裡在部署前就把它擋下來。 */
{
  const app  = src['app.js'] || '';
  const html = readFileSync(join(ROOT, 'prototype', 'index.html'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
  // app.js 也會自己建元素（圖層鈕、搜尋框），那些 id 同樣算「存在」
  for (const m of app.matchAll(/\.id\s*=\s*'([A-Za-z0-9_-]+)'/g)) htmlIds.add(m[1]);
  for (const m of app.matchAll(/\sid="([A-Za-z0-9_-]+)"/g))        htmlIds.add(m[1]);
  // 動態產生的 id（清單列、圖層鈕等）以字串拼接而成，這裡只查字面常數
  const dynamic = /^(el\d+|sat|grp)/;
  const used = [...app.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
  const usedGet = [...app.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
  const all = [...new Set([...used, ...usedGet])].filter(id => !dynamic.test(id));
  const missing = all.filter(id => !htmlIds.has(id));
  check('app.js 取用的元素 id 都存在於 index.html',
    missing.length === 0,
    missing.length ? `index.html 缺少：${missing.join(', ')}` : `${all.length} 個 id 全部對得上`);

  const guarded = /const \$ = id => document\.getElementById\(id\) \|\| _NULLEL;/.test(app);
  check('取元素有安全網（缺元素不會殺掉主迴圈）', guarded,
    guarded ? '$() 回傳空物件代理而非 null' : '$() 直接回傳 getElementById，缺元素會丟 TypeError');
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
