/* 上行鏈路的回歸測試。

   釘住兩件容易靜默退化的事：

   1. **天線雜訊溫度的方向性。** 下行時地面天線朝天，看到的是冷天空；
      上行時衛星天線朝地，整個視場被 ~290 K 的地球填滿。若上行沿用
      skyNoiseTemp_K，G/T 會被高估，而畫面上不會有任何異常 —— 餘裕只是變好看。
      這裡用數值把「朝地一定比朝天差」釘死，並檢查差值隨頻率變化的方向。

   2. **上行資料的完整性。** 每個類別要嘛有完整的 up 定義（含出處），
      要嘛明確寫出為什麼沒有上行。不允許漏掉而變成靜默無上行。

   node validation/test_uplink.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PHY = await import(pathToFileURL(path.join(ROOT, 'prototype', 'physics.js')).href);

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
console.log('上行鏈路回歸測試');

/* ── 1. Tant_K 的方向性 ─────────────────────────────────── */
const base = {
  range_m: 1.0e6, el_deg: 45, txPow_dBW: 3, txGain_dBi: 35, txFeed_dB: 0.8,
  rxGain_dBi: 33, rxFeed_dB: 0.8, rxNF_dB: 2.5,
  bitrate_bps: 2e6, mode: 'QPSK', txPol: 'circular', rxPol: 'circular', rxHpbw_deg: 2
};
{
  const f = 14.25e9;
  const sky   = PHY.linkBudget({ ...base, f_Hz: f });                 // 誤用：朝天
  const earth = PHY.linkBudget({ ...base, f_Hz: f, Tant_K: 290 });    // 正確：朝地
  t('未給 Tant_K 時沿用 skyNoiseTemp_K（預設行為未變）',
    Math.abs(sky.Tsky - PHY.skyNoiseTemp_K(f)) < 1e-9,
    `Tsky = ${sky.Tsky.toFixed(1)} K`);
  t('給了 Tant_K 就用它，不再問頻率', Math.abs(earth.Tsky - 290) < 1e-9,
    `Tsky = ${earth.Tsky.toFixed(1)} K`);
  t('Ku 頻段：朝地的 G/T 低於朝天（此頻率地球較吵）', earth.GT < sky.GT,
    `${earth.GT.toFixed(2)} < ${sky.GT.toFixed(2)} dB/K，差 ${(sky.GT - earth.GT).toFixed(2)} dB`);
  t('Ku 頻段：C/N₀ 與餘裕同步下降', earth.CN0 < sky.CN0 && earth.margin < sky.margin,
    `C/N₀ ${earth.CN0.toFixed(1)} < ${sky.CN0.toFixed(1)} dB-Hz`);
}
{
  // 差值隨頻率變化：Ku/Ka 的冷天空只有十幾 K，差距明顯；
  // VHF/UHF 的銀河雜訊本身就有數十至數百 K，差距小。方向性必須正確。
  const d = f => {
    const s = PHY.linkBudget({ ...base, f_Hz: f });
    const e = PHY.linkBudget({ ...base, f_Hz: f, Tant_K: 290 });
    return s.GT - e.GT;
  };
  const dVhf = d(145.99e6), dUhf = d(401.9e6), dKu = d(14.25e9);
  t('差值隨頻率單調上升（銀河雜訊在低頻本就高）', dVhf < dUhf && dUhf < dKu,
    `VHF ${dVhf.toFixed(2)} < UHF ${dUhf.toFixed(2)} < Ku ${dKu.toFixed(2)} dB`);

  /* 這一項是本檔最重要的釘樁。原本我寫成「朝地一定比較差」，
     但那只在高頻成立 —— 145.99 MHz 的銀河背景約 1019 K，比地球的 290 K 還吵，
     朝地反而比較安靜。差值會在交越頻率換號，介面文字也必須跟著換號。
     交越點由本檔的銀河模型 T=60·(408/f_MHz)^2.75 與 290 K 相交決定。 */
  const cross = (() => { let lo = 1e8, hi = 1e9;
    for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2;
      (PHY.skyNoiseTemp_K(m) > 290 ? lo = m : hi = m); }
    return lo; })();
  t('天空/地球雜訊的交越點落在 VHF 高段', cross > 2.0e8 && cross < 2.6e8,
    `${(cross / 1e6).toFixed(1)} MHz`);
  t('低於交越點時差值為負（朝地反而較安靜）', d(cross * 0.6) < 0,
    `${(cross * 0.6 / 1e6).toFixed(1)} MHz → ${d(cross * 0.6).toFixed(2)} dB`);
  t('高於交越點時差值為正（朝地較吵）', d(cross * 1.6) > 0,
    `${(cross * 1.6 / 1e6).toFixed(1)} MHz → ${d(cross * 1.6).toFixed(2)} dB`);
  t('差值量級合理（|Δ| < 8 dB）', Math.abs(dVhf) < 8 && Math.abs(dKu) < 8,
    `VHF ${dVhf.toFixed(2)} / Ku ${dKu.toFixed(2)} dB`);
}

/* ── 2. 上行資料完整性（靜態解析 app.js）───────────────── */
{
  const src = fs.readFileSync(path.join(ROOT, 'prototype', 'app.js'), 'utf8');
  const body = src.slice(src.indexOf('const PROFILE = {'), src.indexOf('const GS = {'));
  const classes = [...body.matchAll(/\n  ([a-z_]+):\{/g)].map(m => m[1]);
  t('抓得到全部類別', classes.length >= 14, `${classes.length} 個：${classes.join(', ')}`);

  const noUp = [], withUp = [], missing = [];
  for (const c of classes) {
    const seg = body.slice(body.indexOf(`\n  ${c}:{`));
    const end = seg.indexOf('\n  ', 3) > 0 ? seg.indexOf('\n\n') : seg.length;
    const block = seg.slice(0, end > 0 ? end : 1200);
    if (/up:null/.test(block)) {
      noUp.push(c);
      if (!/upNote:'[^']{8,}'/.test(block)) missing.push(`${c}（無上行卻沒說明原因）`);
    } else if (/up:\{/.test(block)) {
      withUp.push(c);
      if (!/up:\{[\s\S]*?src:'/.test(block)) missing.push(`${c}（上行缺出處）`);
      if (!/Tant_K:\s*\d/.test(block)) missing.push(`${c}（上行未指定 Tant_K，會誤用冷天空）`);
    } else {
      missing.push(`${c}（既無 up 也無 up:null）`);
    }
  }
  t('每個類別都有上行定義或明確的「無上行」說明', missing.length === 0,
    missing.length ? missing.join('；') : `有上行 ${withUp.length}、無上行 ${noUp.length}`);
  t('有上行的類別都指定了 Tant_K', !missing.some(m => m.includes('Tant_K')),
    withUp.join(', '));
  t('GNSS 一律無上行（使用者端純接收）',
    ['gnss_gps', 'gnss_gal', 'gnss_glo', 'gnss_bds'].every(c => noUp.includes(c)),
    `無上行者：${noUp.join(', ')}`);
}

console.log(`\n${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
