/* 大氣衰減對照獨立實作（ITU-R P.676 / P.838）。

   為什麼要有這一支：本站的 C/N₀、Eb/N₀、鏈路餘裕從頭到尾沒有對過任何
   外部來源 —— 上一輪自評把「物理有效性」壓在 6/10 就是因為這個缺口。
   軌道（對 Vallado 官方向量）與都卜勒（對 Skyfield）都已經有獨立比對，
   唯獨鏈路預算沒有。這裡補上大氣這一段。

   對照對象：Python 套件 `itur`（作者不同、實作獨立）的 ITU-R P.676 氣體
   衰減與 P.838 雨衰比衰減。本檔只負責產生「我方」的數值並輸出成 JSON，
   由 test_atmos_vs_itur.py 讀取後與 itur 比對 —— 兩邊各自獨立計算，
   不共用任何中間結果。

   node validation/test_atmos_vs_itur.mjs > <暫存檔>
*/
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PHY = await import(pathToFileURL(join(ROOT, 'prototype', 'physics.js')).href);

const out = { gas: [], rainGamma: [], fspl: [] };

// 氣體衰減：涵蓋本站實際用到的頻段（VHF 0.145 → Ka 30 GHz）與仰角
for (const f of [0.145, 0.4, 1.6, 2.05, 8.2, 11.7, 14.25, 19.95, 22.2, 29.75]) {
  for (const el of [5, 10, 20, 30, 45, 60, 90]) {
    out.gas.push({ f_GHz: f, el_deg: el, mine_dB: PHY.gasLoss_dB(f * 1e9, el) });
  }
}

// 雨衰比衰減 γ_R = k·R^α（P.838）。只比這一項，因為它是純係數問題，
// 路徑縮減因子牽涉雨高與統計假設，另外處理。
for (const f of [4, 8.2, 11.7, 14.25, 19.95, 29.75, 40]) {
  for (const R of [5, 10, 25, 50, 100]) {
    // 一定要呼叫 physics.js 的實作。先前這裡抄了一份公式，
    // 結果是「測試通過但受測物沒被執行」—— 改了實作也偵測不到。
    const { k, a } = PHY.rainKA(f);
    out.rainGamma.push({ f_GHz: f, R_mmh: R, mine_dB_km: k * Math.pow(R, a) });
  }
}

// FSPL：對照教科書封閉式 32.45 + 20log10(f_MHz) + 20log10(d_km)
for (const [d_km, f_MHz] of [[1, 1000], [100, 137.1], [1000, 2250], [35786, 11700], [500, 14250]]) {
  out.fspl.push({ d_km, f_MHz, mine_dB: PHY.fspl_dB(d_km * 1000, f_MHz * 1e6) });
}

console.log(JSON.stringify(out));
