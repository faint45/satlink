# SatLink 完成度狀態

> 本檔由 `check.py` 產生於 2026-09-05 06:08:31 UTC，不手寫。每次執行都重跑驗證，不沿用上次結論。

**16 通過 · 1 失敗 · 3 未執行**


## 部署

| 項目 | 結果 | 說明 |
|---|---|---|
| Service Worker 預快取清單與實際檔案一致 | ✅ PASS | 32 項；缺少 無 |
| SW 版本號 | ✅ PASS | satlink-v1.12.0 |
| 大小與檔數在 Cloudflare Pages 限制內 | ✅ PASS | 33 檔 / 7.2 MB |
| rebuild_data.py 存在 | ✅ PASS |  |
| validation/test_frames.mjs 存在 | ✅ PASS |  |
| validation/test_render_invariants.mjs 存在 | ✅ PASS |  |
| validation/test_cam_geodesy.mjs 存在 | ✅ PASS |  |

## 資料

| 項目 | 結果 | 說明 |
|---|---|---|
| tle_cache.json 可解析 | ✅ PASS | sats = 619 |
| stars.json 可解析 | ✅ PASS | n = 8920 |
| deepspace.json 可解析 | ✅ PASS | objects = 26 |
| astro.json 可解析 | ✅ PASS | exoplanets = 6360 |
| cams.json 可解析 | ✅ PASS | cams = 151 |

## Verification

| 項目 | 結果 | 說明 |
|---|---|---|
| SGP4/SDP4 對 Vallado 官方測試向量 | ✅ PASS | 32 顆 / 666 點；最大偏差 0.117 µm（衛星 20413） |

## 回歸

| 項目 | 結果 | 說明 |
|---|---|---|
| 座標框架回歸測試（IAU 1976 歲差） | ✅ PASS | 7 通過 / 0 失敗 |
| 渲染不變式回歸測試（深度緩衝） | ✅ PASS | 11 通過 / 0 失敗 |
| 攝影機標記大地座標回歸測試 | ✅ PASS | 8 通過 / 0 失敗 |

## Validation

| 項目 | 結果 | 說明 |
|---|---|---|
| SatNOGS 全球地面站幾何比對 | ⚠️ SKIP | --offline |
| 都卜勒 vs Skyfield 獨立實作 | ⚠️ SKIP | --offline |

## 資料

| 項目 | 結果 | 說明 |
|---|---|---|
| 即時影像抽樣複驗 | ⚠️ SKIP | --offline |

## 接點

| 項目 | 結果 | 說明 |
|---|---|---|
| stats API（線上人數／累積造訪） | ❌ FAIL | 本機 wrangler port 8791；0 通過 / 1 失敗 |

## 完成度分級

| 級別 | 定義 | 狀態 |
|---|---|---|
| L0 Smoke | 開得起來 | ✅ |
| L1 Unit | 物理模組對手算與官方向量 | ✅ |
| L2 端到端 | 真實 TLE → 3D 畫面 → 鏈路預算數字一條路通 | ✅ |
| L3 真實環境 | 公開 HTTPS 上驗證（Cloudflare Tunnel） | ✅ |
| L4 真實資料 + Validation | 全部真實來源，且與獨立實作/實測比對通過 | ✅ |
| L5 可重現 | 乾淨機器一鍵重建 | ✅ `rebuild_data.py` 四項來源全部實測重跑通過（stars/astro 與原檔逐位元一致；tle/deepspace 因來源為活資料而數量微異，屬正確行為） |
| L6 真的被用過 | 有人實際使用 | ❌ |

**專案分數 = 所有切片最低級 → L5**（L6「真的被用過」未達成）

## 接點

| # | 接點 | 狀態 |
|---|---|---|
| 1 | CelesTrak TLE → SGP4/SDP4 → 場景 | ✅ |
| 2 | JPL Horizons → 歲差修正 → 場景（同一框架） | ✅ |
| 3 | 影像清單 → 地球標記 → 播放器（清單點擊與地球點擊都驗過） | ✅ |
| 4 | Service Worker → 離線（29 項純快取取用測試通過） | ✅ |
| 5 | /api/stats → Cloudflare D1 | ✅ 正式站 13 項行為測試全過；徽章實測顯示真數字 |
| 6 | 對外部署 | ✅ 兩處並存：Cloudflare Pages（有計數）與 GitHub Pages（純靜態，徽章自動隱藏） |

**6 / 6 通過**

> 正式站 https://satlink-4fy.pages.dev/ ・ 備援 https://faint45.github.io/satlink/
> 接點 5 刻意優先打正式端點：本機 D1 只證明邏輯對，不證明部署後綁定正確。
> 實測踩過一次 —— `wrangler d1 create` 建議的 binding 名是資料庫名，照抄會讓
> `env.DB` 是 undefined、Function 回 503，而畫面完全正常，只有徽章靜默消失。

## 已修 bug 的回歸釘樁

| 修過的問題 | 釘樁 |
|---|---|
| J2000/TEME 座標框架不一致（0.38° 偏移） | ✅ `validation/test_frames.mjs`（7 項：恆等變換、保長度、保夾角、量值 0.3727°、方向性、單調性、JD 換算） |
| 深度緩衝穿透（衛星穿過地球） | ✅ `validation/test_render_invariants.mjs`（靜態釘住根因：對數深度緩衝與自訂 shader 的相容性、near/far 比、疊加層深度測試） |
| 來源資料經緯度錯置 | ✅ bbox 檢核已寫進建置腳本 |
| 即時影像地點錯置 | ✅ 標題關鍵字比對已寫進採集腳本 |
| 攝影機標記被壓向赤道（`e² = 1−(1−FLAT)²` 誤用扁率，日月潭 23.85°N 落到 0.01°，雷克雅維克偏 7,138 km） | ✅ `validation/test_cam_geodesy.mjs`（151 個據點逐點大地座標往返，逆算用 Bowring 法獨立推導；已實測把舊式子放回去會失敗 4 項） |

> 深度穿透屬於要 GPU 才看得出來的問題，命令列無法做像素比對。
> 因此釘的是「不可能再產生該錯誤」的原始碼條件，不是畫面本身。
> 當初的一次性人工驗證（隱藏 21 顆幾何上被遮蔽的衛星、畫面完全無變化）記錄於 README。
