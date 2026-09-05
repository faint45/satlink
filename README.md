# SatLink — 太空視角衛星通聯模擬

真實 TLE 與 JPL 星曆驅動的 3D 地球。618 顆衛星、真實鏈路預算、多波束覆蓋、
26 個深空任務、6,360 顆系外行星、1,619 個深空天體、61 個全球公開即時影像據點。

**核心原則：畫面上每一個數字都要說得出出處，說不出來的就標明是近似或不顯示。**

---

## 執行

```bat
REM 本機
npm run serve                 REM http://localhost:8620

REM 外網（臨時公開網址，關掉即失效）
run-satlink.bat

REM 部署到 Cloudflare Pages（永久網址）
npm run login                 REM 需你本人 OAuth 授權
npm run db:create             REM 建立 D1，把印出的 id 填進 wrangler.toml
npm run deploy
```

本機開啟時**不註冊 Service Worker**（避免改檔後被舊快取供應）；正式站才啟用離線快取。

### 自架於 NAS（ASUSTOR ADM，不需要任何雲端帳號）

```bat
python deploy-nas.py                          REM → //192.168.1.111/Web/satlink
```

NAS 上的 Apache 已在 80/443 服務，Web 共用資料夾就是網站根目錄。
線上人數改用 `nas/api/stats.php`（PHP 8.3 + SQLite），與 Cloudflare Pages Function
的 JSON 契約完全相同；前端會自動偵測要打哪個端點，同一份建置兩種主機通用。
部署腳本會略過 `functions/` 與 `_headers`（那是 Cloudflare 專用）。

**實測結果與限制**：

| 項目 | http://192.168.1.111/satlink/ |
|---|---|
| 網站本體 | ✅ 正常（619 顆衛星、零錯誤） |
| 線上人數／累積造訪 | ✅ 正常（PHP 端點 13 項行為測試全過） |
| 資料庫外洩防護 | ✅ `data/stats.sqlite` 回 403 |
| PWA 安裝、離線 | ❌ 不可用 |

PWA 失效的原因是硬性規則，不是設定問題：Service Worker 只在**安全情境**下才存在，
實測 `isSecureContext` 為 `false`，`navigator.serviceWorker` 直接是 `undefined`。
NAS 的 443 是自簽憑證（嚴格驗證回 000），瀏覽器視為不安全，即使點過警告也一樣。

要恢復 PWA 就必須有**受信任的憑證**。見下一節。

### 對外公開（Cloudflare Tunnel on NAS，路由器不開埠）

```bat
python deploy-nas-tunnel.py       REM → //192.168.1.111/Docker/satlink
```

設定步驟見 `nas-tunnel/SETUP.md`。架構刻意不是「把 NAS 的 80 埠接出去」：

NAS 的 Web 資料夾還有 scaffold-sim、shoring-sim、traffic 等專案，ADM 管理介面也在同一台，
整台接出去等於把它們一起公開。改成跑一個**只掛載 SatLink 的容器**（`php:8.3-apache`，
網站唯讀掛載、只有 `data/` 可寫），Cloudflare Tunnel 只連到那個容器。

兩個容器都**不發布任何主機埠**，cloudflared 只做對外連線 —— 因此路由器不需要開任何埠，
NAS 也不會出現在網際網路的掃描結果裡。取得固定網址後 HTTPS 由 Cloudflare 提供，
PWA 的安裝與離線功能也隨之恢復。

需要一個你控制、已加入 Cloudflare 的網域。通道權杖只放在 NAS 的 `.env`。

---

## 資料來源

| 內容 | 來源 | 授權 / 條件 |
|---|---|---|
| 衛星軌道 618 顆 | CelesTrak GP + Supplemental（Starlink 用 SpaceX 提供的補充星曆，精度優於一般 GP） | 公開 |
| 軌道傳播 | SGP4 / SDP4（前端 satellite.js、驗證用 Python `sgp4`） | 開源 |
| 地表影像 | NASA GIBS，VIIRS/SNPP Corrected Reflectance True Color 每日全球鑲嵌 | 公眾領域 |
| 夜燈／地形／海洋遮罩 | NASA Blue Marble（經 three.js 範例） | 公眾領域 |
| 恆星 8,920 顆 | HYG Database v4.0（Hipparcos / Yale BSC / Gliese 合併） | CC BY-SA 2.5 |
| 深空天體 1,619 個 | OpenNGC（Mattia Verga） | CC BY-SA 4.0 |
| 系外行星 6,360 顆 | NASA Exoplanet Archive，Planetary Systems 表 default_flag=1 | 公眾領域 |
| 月球與深空任務星曆 | NASA/JPL Horizons，`CENTER='500@399'`、`REF_PLANE='FRAME'` | 公眾領域 |
| 即時影像 61 處 | YouTube 直播（逐一查證） | 官方 iframe 嵌入 |
| 影像座標 | OpenStreetMap Nominatim 地理編碼 | ODbL |
| 台灣國道 CCTV 1,777 支（未部署） | 交通部 TDX — 高公局即時影像 | 公開；建置時擷取清單，執行時直連串流 |

---

## 驗證結果

### Verification — 方程解得對不對

| 項目 | 結果 |
|---|---|
| SGP4 對 Vallado 官方測試向量 | 32 顆測試衛星、666 個比對點，**最大位置分量偏差 0.117 微米** |
| 大氣散射柱密度對解析解 ρ(h₀)√(2πR·H) | 切點高度 2/5/10/20 km，**誤差 < 0.11%**；NV 40→1280 結果不變（已收斂） |
| 月球星曆內插 | Catmull-Rom 對 JPL 獨立 37 分取樣 390 點，**最大誤差 51 公尺（0.13 ppm）** |

切點 0 km 時積分只有解析解的 50%，這是**正確的**：射線正切地表時遠側半程被地球遮蔽，
該 2 倍跳變即地平線亮線的成因。

### Validation — 解的是不是對的方程

| 項目 | 結果 |
|---|---|
| 通聯幾何 vs SatNOGS 全球 25 個獨立地面站 | 升起方位差 0.22°、落下方位 0.25°、最大仰角 0.26°（SatNOGS 只報整數度，四捨五入即 ±0.5°） |
| 都卜勒 vs Skyfield 獨立實作 | 過境擺幅 20,998 Hz，**最大差 0.23 Hz（11 ppm）** |
| 月相 vs JPL 觀測量星曆 | 照明比例 47.19% vs 47.18%、相位角差 **0.011°** |
| 多波束幾何 | 天底光斑 344.1×343.0 km vs 理論 343.5 km（**0.2%**）；臨邊短軸/天底 1.158 vs 斜距比 1.165（**0.6%**） |
| 高度抽查 | ISS 426.3 km、GEO 35,890 km、GPS 20,078 km、月球 370,046 km |
| 星表座標 | M31/M42/M13/M44 對文獻吻合；Sirius/Vega/Polaris 誤差 < 0.01° |
| 系外行星選擇效應 | 285 顆微透鏡行星有 **281 顆（98.6%）** 落在銀河中心 15° 內；2,778 顆凌日行星在克卜勒視場 10° 內 |

### 修正過的實際錯誤

1. **座標框架不一致**：JPL 給 ICRF/J2000，SGP4 給 TEME（當日），混用造成 0.38° 系統偏移
   （＝26 年歲差 26×50.3″）。加入 IAU 1976 歲差修正後殘差降到 0.011°，誤差縮小 35 倍。
2. **深度緩衝穿透**：自訂 Earth shader 未納入對數深度緩衝 chunk，深度基準不一致導致衛星穿透地球。
   改用一般深度緩衝並收緊 near/far。驗證方式：隱藏 21 顆幾何上被擋的衛星，畫面完全無變化。
3. **來源資料錯誤**：台灣國道一支 CCTV 的經度欄被填入緯度值，未臆測補值，直接剔除並記錄。
4. **即時影像地點錯置**：查「特羅姆瑟」回傳阿拉斯加 Fairbanks、查「大峽谷」回傳滑雪場纜車
   「Grand Canyon Express」。加入標題／頻道關鍵字比對後剔除 15 筆（含 8 組重複影片）。
5. **Pages Function 目錄放錯**：`functions/` 原本放在 `prototype/functions/`，
   但 `wrangler pages deploy prototype` 找的是**專案根目錄**的 `functions/`。
   放錯的後果特別惡劣 —— 用戶端設計成「拿不到真實數字就隱藏徽章」，
   所以功能永遠不作用時畫面只是少一個角落的字，不會有任何錯誤訊息。
   實測時 wrangler 印出 `No Functions. Shimming...`、POST 回 405 才抓到。

### 部署陷阱（會靜默出貨的那種）

**Pages Function 必須放在專案根目錄的 `functions/`，不是部署目錄裡面。**
`wrangler pages deploy prototype` 只上傳 `prototype/` 當靜態資產，Function 另從
cwd 的 `functions/` 讀取。放錯不會有錯誤，只會安靜地沒有 API。

驗證方式（不需要 Cloudflare 帳號，D1 由 miniflare 在本機模擬）：

```bat
npx wrangler pages dev prototype --d1 DB --port 8790 --compatibility-date 2026-09-04
python validation/test_stats_api.py 8790
```

啟動時 wrangler 必須印出 `✨ Compiled Worker successfully`。
若印的是 `No Functions. Shimming...`，就是目錄放錯了。

### 回歸釘樁

修好的 bug 若沒有東西防止它再壞，等於沒修。兩個曾實際發生的錯誤各有一支測試：

| 測試 | 釘住什麼 |
|---|---|
| `validation/test_frames.mjs` | J2000/TEME 框架混用。7 項：J2000 恆等變換、保長度、保夾角（排除縮放與反射）、J2000→2026 位移量值 0.3727°、方向性、時間單調性、JD 換算 |
| `validation/test_render_invariants.mjs` | 深度緩衝穿透。靜態釘住根因：對數深度緩衝與自訂 shader 的相容性、near/far 比、疊加層不得關閉深度測試、主迴圈須有例外守門 |
| `validation/test_stats_api.py` | Function 未部署／行為錯誤。13 項：自動建表、心跳不重複計數、第二工作階段計入、四種非法 sid 拒絕、GET 唯讀。使用隨機 sid 以確保可重複執行 |

深度穿透要有 GPU 才看得出來，命令列無法做像素比對，所以釘的是「不可能再產生該錯誤」的
原始碼條件。當初的一次性人工驗證（隱藏 21 顆幾何上被遮蔽的衛星、畫面完全無變化）
記錄在上方修正清單，那不是這支測試能取代的。

寫這支測試時它當場抓到一個未察覺的不一致：任務標記的圓環關閉了深度測試、
中心點卻沒有，導致地球背面的標記會有環穿透、點被擋住。已改為整組依幾何遮蔽判定，
並與獨立幾何計算比對，三種相機距離下 26/26 完全一致。

---

## 指令

```bat
python check.py              REM 重跑全部驗證並產生 STATUS.md
python check.py --offline    REM 只跑不需網路的項目
python rebuild_data.py       REM 從原始來源重建所有資料檔
python rebuild_data.py --list
node validation/test_frames.mjs
node validation/test_render_invariants.mjs
python validation/test_stats_api.py 8790   REM 需先啟動 wrangler pages dev
```

`rebuild_data.py` 把原本散落在對話裡的抓取步驟整合成可重跑的管線，
原始回應快取於 `.cache/`（刪掉即完整重抓）。即時影像清單刻意不放進去 ——
直播狀態必須逐一查證，盲目重跑會產生一堆已下線的連結。

---

## 誠實的邊界

- **恆星、星團、系外行星只有方向是真的**，距離一律畫在固定天球上（4.2 光年到數千萬光年，無法按比例）。
- **深空任務方向真、徑向對數壓縮**；真實距離與光行時間並列顯示。
- **衛星外形是辨識用示意**，非工程圖；圖示放大倍率即時顯示於介面。
- **鏈路參數分級**：頻率為 A 級（官方／ITU 分配），發射功率與天線增益多為 B 級公開代表值。
- **即時影像座標是地點中心**，非攝影機架設點，可差數公里；直播會下線，清單為查證當下快照。
- **多波束蜂巢是幾何示範**：真實系統只覆蓋服務區，波束指向由營運商規劃，非機械填滿盤面。
- **大氣散射僅單次散射**，未含多次散射與臭氧吸收；屬視覺模型，不供物理引用。
- **月球採潮汐鎖定近似**，未計天平動（±8°）。
- **離線可用不代表資料即時**：TLE、星曆、地表影像都是取得當下的快照。

---

## 檔案

```
prototype/            部署目錄（Cloudflare Pages 的 output dir）
  index.html          介面、PWA 掛載、計數用戶端
  app.js              主場景：地球、大氣、衛星、軌道、蜂巢、深空、影像
  physics.js          鏈路預算（Friis / ITU-R P.676 / P.618 / P.372）與幾何
  beams.js            多波束蜂巢覆蓋（四色頻率重用）
  satmodels.js        程序生成衛星本體（LVLH 姿態 + 太陽翼追日）
  deepspace.js        JPL 星曆內插 + J2000→當日歲差
  astro.js            深空天體與系外行星圖層
  cams.js             全球即時影像圖層
  theme.css           視覺語彙（轉角標記、刻度標尺、暖象牙＋琥珀、顆粒與暗角）
  sw.js               Service Worker（全量預快取，/api/ 不快取）
functions/api/        Cloudflare Pages Function ⚠️ 必須在根目錄，不可放進 prototype/
validation/           回歸測試與交叉驗證
cams/                 影像採集腳本與原始清單（含未部署的台灣國道 CCTV）
check.py              重跑全部驗證並產生 STATUS.md
rebuild_data.py       從原始來源重建所有資料檔
devserver.py          開發伺服器（送 no-store，避免改檔後被瀏覽器快取擋住）
```
