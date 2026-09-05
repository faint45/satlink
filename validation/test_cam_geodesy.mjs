/* 攝影機標記的大地座標回歸測試。
   釘住的 bug：cams.js 的 camLocal 把「扁率 f」誤當成極/赤道半徑比，
   算出 e² ≈ 0.99999（正確 0.00669），使所有標記被壓向赤道
   —— 日月潭 23.85°N 被放到 0.01°，偏離約 2,650 km。
   點擊仍會開到正確的攝影機（pickCam 用同一組座標），所以肉眼不易察覺，
   必須用數值把每一個點釘住。

   做法：把 camLocal 的輸出逆算回大地緯經度，與 cams.json 宣告的值比對。
   逆算用 Bowring 法，與 camLocal 的正算是獨立的推導，不是把同一條式子抄兩遍。

   node validation/test_cam_geodesy.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PROTO = path.join(ROOT, 'prototype');

// 讓 cams.js 的 `import * as THREE from 'three'` 可以被解析：只用到 Vector3
const src = fs.readFileSync(path.join(PROTO, 'cams.js'), 'utf8')
  .replace(/^import \* as THREE from 'three';$/m,
           'const THREE = { Vector3: class { constructor(x,y,z){ this.x=x; this.y=y; this.z=z; } } };');
const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

const cams = JSON.parse(fs.readFileSync(path.join(PROTO, 'cams.json'), 'utf8')).cams;

const A = 6378.137, B = 6356.752314245;      // WGS84，km
const FLAT = B / A, U = 1000, ALT = 3;       // camLocal 的預設架設高
const d2r = Math.PI / 180, r2d = 180 / Math.PI;

/* 場景座標 → ECEF。camLocal 回傳 (x/U, z/U/FLAT, -y/U)，ellip 群組再乘上 (1,FLAT,1)。 */
function sceneToEcef(v){ return { X: v.x*U, Y: -v.z*U, Z: v.y*FLAT*U }; }

/* ECEF → 大地座標（Bowring 1976）。與 camLocal 的正算式各自獨立。 */
function ecefToGeodetic(X, Y, Z){
  const e2  = (A*A - B*B) / (A*A);
  const ep2 = (A*A - B*B) / (B*B);
  const p   = Math.hypot(X, Y);
  const th  = Math.atan2(Z*A, p*B);
  const lat = Math.atan2(Z + ep2*B*Math.sin(th)**3, p - e2*A*Math.cos(th)**3);
  const lon = Math.atan2(Y, X);
  const N   = A / Math.sqrt(1 - e2*Math.sin(lat)**2);
  return { lat: lat*r2d, lon: lon*r2d, h: p/Math.cos(lat) - N };
}

let pass = 0, fail = 0;
const t = (name, ok, detail='') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log(`攝影機標記大地座標回歸測試（${cams.length} 個據點）`);

// 1. 常數本身：e² 必須是 0.00669438，不是 0.99999
const e2_from_flat = 1 - FLAT*FLAT;
t('e² 由極/赤道半徑比正確導出', Math.abs(e2_from_flat - 0.00669437999) < 1e-9,
  `e² = ${e2_from_flat.toFixed(11)}（WGS84 定義值 0.00669437999）`);

// 2. 逐點往返：正算再逆算，緯經度必須回到宣告值
let maxLat = 0, maxLon = 0, maxH = 0, worst = null;
for(const c of cams){
  const v = mod.camLocal(c.lat, c.lon, U, FLAT, A, ALT);
  const e = sceneToEcef(v);
  const g = ecefToGeodetic(e.X, e.Y, e.Z);
  const dLat = Math.abs(g.lat - c.lat);
  const dLon = Math.abs(((g.lon - c.lon + 540) % 360) - 180);
  const dH   = Math.abs(g.h - ALT);
  if(dLat > maxLat){ maxLat = dLat; worst = c; }
  if(dLon > maxLon) maxLon = dLon;
  if(dH   > maxH)   maxH   = dH;
}
t('每一個據點的緯度往返一致', maxLat < 1e-6,
  `最大偏差 ${(maxLat*111.32*1000).toFixed(3)} m（${maxLat.toExponential(2)}°）` +
  (worst ? `，最差：${worst.zh}` : ''));
t('每一個據點的經度往返一致', maxLon < 1e-6, `最大偏差 ${maxLon.toExponential(2)}°`);
t('架設高度往返一致', maxH < 1e-6, `最大偏差 ${(maxH*1000).toFixed(3)} m`);

// 3. 高緯度是最會暴露這個 bug 的地方，單獨釘一個已知點
const HI = cams.filter(c => Math.abs(c.lat) > 45);
if(HI.length){
  const c = HI.reduce((a,b) => Math.abs(b.lat) > Math.abs(a.lat) ? b : a);
  const g = ecefToGeodetic(...Object.values(sceneToEcef(mod.camLocal(c.lat, c.lon, U, FLAT, A, ALT))));
  t(`最高緯度據點定位正確（${c.zh} ${c.lat.toFixed(2)}°）`,
    Math.abs(g.lat - c.lat) < 1e-6, `逆算 ${g.lat.toFixed(6)}° vs 宣告 ${c.lat.toFixed(6)}°`);
} else {
  t('最高緯度據點定位正確', true, '清單中無 |lat|>45° 的據點，略過');
}

// 4. 直接盯住舊 bug 的特徵：若 e² 寫錯，z 會被壓成接近 0
const mid = cams.find(c => Math.abs(c.lat) > 20) || cams[0];
const vz = mod.camLocal(mid.lat, mid.lon, U, FLAT, A, ALT).y * FLAT * U;
const expectZ = (A/Math.sqrt(1 - 0.00669437999*Math.sin(mid.lat*d2r)**2) * (1-0.00669437999) + ALT)
                * Math.sin(mid.lat*d2r);
t('z 分量未被壓向赤道（舊 bug 的特徵）', Math.abs(vz - expectZ) < 1e-6,
  `${mid.zh} z = ${vz.toFixed(3)} km（理論 ${expectZ.toFixed(3)} km）`);

console.log(`\n${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
