/* test_frames.mjs — 座標框架回歸測試
 *
 * 釘住的是這個實際發生過的錯誤：
 *   JPL Horizons 以 ICRF/J2000 輸出，SGP4 輸出 TEME（當日平春分點），
 *   本專案的太陽模型也是當日座標。混用會造成 0.38° 的系統性偏移
 *   （＝26 年 × 50.3″/年 的歲差），實測讓月面照明比例從 47.18% 偏到 47.51%。
 *   修法是對所有 JPL 資料套用 IAU 1976 歲差旋轉。
 *
 * 這支測試不需要網路，也不需要 GPU。用 `node validation/test_frames.mjs` 執行。
 */
import { precessJ2000ToDate, toJD } from '../prototype/deepspace.js';

let fails = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
}
const norm = v => Math.hypot(v[0], v[1], v[2]);
const dot  = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const angleDeg = (a,b) => Math.acos(Math.min(1, Math.max(-1, dot(a,b)/(norm(a)*norm(b))))) * 180/Math.PI;

console.log('座標框架回歸測試（IAU 1976 歲差）');

// 1. J2000 曆元本身不該被旋轉：T=0 時矩陣必須是單位矩陣。
{
  const JD2000 = 2451545.0;
  const v = [0.3, -0.5, 0.81];
  const p = precessJ2000ToDate(v, JD2000);
  const d = Math.max(...v.map((x,i) => Math.abs(x - p[i])));
  check('J2000 曆元為恆等變換', d < 1e-12, `最大分量差 ${d.toExponential(2)}`);
}

// 2. 必須是純旋轉：保長度、保夾角。若寫錯成含縮放或反射就會被抓到。
{
  const JD = 2461288.0;                       // 2026-09-04
  const a = [1, 0, 0], b = [0.2, 0.9, -0.386];
  const pa = precessJ2000ToDate(a, JD), pb = precessJ2000ToDate(b, JD);
  const dLen = Math.abs(norm(pa) - norm(a));
  const dAng = Math.abs(angleDeg(pa, pb) - angleDeg(a, b));
  check('保長度（不含縮放）', dLen < 1e-12, `Δ|v| = ${dLen.toExponential(2)}`);
  check('保夾角（不含反射／扭曲）', dAng < 1e-10, `Δ角 = ${dAng.toExponential(2)}°`);
}

// 3. 量值必須正確：J2000 → 2026 累積歲差。
//    赤經總歲差約 50.29″/年；26.67 年 ≈ 1341″ ≈ 0.3725°。
//    對春分點（赤經 0、赤緯 0）而言，位移量應落在 0.30°–0.45° 之間。
//    這正是先前月相偏差 0.38° 的來源 —— 數值跑掉就代表框架修正壞了。
{
  const JD = 2461288.0;
  const eq = [1, 0, 0];                        // 春分點方向
  const moved = angleDeg(eq, precessJ2000ToDate(eq, JD));
  check('J2000→2026 歲差量值在合理區間', moved > 0.30 && moved < 0.45,
        `位移 ${moved.toFixed(4)}°（理論約 0.37°）`);
}

// 4. 方向性：必須是 J2000 → 當日，不是反向。
//    歲差使恆星赤經隨時間增加，因此當日座標的赤經應大於 J2000 赤經。
{
  const JD = 2461288.0;
  const v = [Math.cos(0.5), Math.sin(0.5), 0];  // 赤經 0.5 rad、赤緯 0
  const p = precessJ2000ToDate(v, JD);
  const ra0 = Math.atan2(v[1], v[0]), ra1 = Math.atan2(p[1], p[0]);
  check('方向為 J2000→當日（赤經增加）', ra1 > ra0,
        `赤經 ${(ra0*180/Math.PI).toFixed(4)}° → ${(ra1*180/Math.PI).toFixed(4)}°`);
}

// 5. 時間單調性：越晚的曆元位移越大。
{
  const eq = [1,0,0];
  const d10 = angleDeg(eq, precessJ2000ToDate(eq, 2451545.0 + 3652.5));   // +10 年
  const d30 = angleDeg(eq, precessJ2000ToDate(eq, 2451545.0 + 10957.5));  // +30 年
  check('位移隨曆元單調增加', d30 > d10 * 2.5,
        `10 年 ${d10.toFixed(4)}° → 30 年 ${d30.toFixed(4)}°`);
}

// 6. toJD 對已知時刻的換算。J2000.0 = 2000-01-01 12:00 TT ≈ JD 2451545.0
{
  const jd = toJD(new Date(Date.UTC(2000, 0, 1, 12, 0, 0)));
  check('toJD 對 J2000.0 正確', Math.abs(jd - 2451545.0) < 1e-6,
        `得 ${jd}`);
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
