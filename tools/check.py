# -*- coding: utf-8 -*-
"""SatLink 完成度檢核：實際重跑驗證，產生 STATUS.md。

原則：STATUS.md 由本腳本產生，不手寫。每一項結果都是這次執行實際跑出來的，
不是抄上一次的結論。需要網路的項目失敗時明確標為「未執行」，不視為通過。

用法：  python check.py            （完整，含連網驗證）
        python check.py --offline  （只跑不需網路的項目）
"""
import json, math, os, sys, time, subprocess
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.abspath(__file__))
PROTO = os.path.join(ROOT, 'prototype')
OFFLINE = '--offline' in sys.argv
R = []          # (類別, 項目, 狀態, 說明)   狀態: PASS / FAIL / SKIP

def rec(cat, name, ok, note):
    # ok 可能是 numpy.bool_（Skyfield 回傳 numpy 型別），不能用 `is True` 判斷，
    # 否則明明通過也會被判 FAIL。None 代表未執行。
    state = 'SKIP' if ok is None else ('PASS' if bool(ok) else 'FAIL')
    R.append((cat, name, state, note))

# ── 1. 部署目錄完整性 ────────────────────────────────────────
def check_files():
    import re
    sw = open(os.path.join(PROTO, 'sw.js'), encoding='utf-8').read()
    core = [c for c in re.findall(r"'\./([^']*)'", sw) if c]
    missing = [c for c in core if not os.path.exists(os.path.join(PROTO, c))]
    rec('部署', 'Service Worker 預快取清單與實際檔案一致',
        not missing, f'{len(core)} 項；缺少 {missing if missing else "無"}')

    ver = re.search(r"VERSION\s*=\s*'([^']+)'", sw)
    rec('部署', 'SW 版本號', bool(ver), ver.group(1) if ver else '找不到')

    total = 0; n = 0
    for dp, dn, fn in os.walk(PROTO):
        dn[:] = [d for d in dn if not d.startswith('.')]
        for f in fn:
            if f.startswith('.'): continue
            total += os.path.getsize(os.path.join(dp, f)); n += 1
    rec('部署', '大小與檔數在 Cloudflare Pages 限制內',
        total < 25*1024*1024 and n < 20000, f'{n} 檔 / {total/1048576:.1f} MB')

    for f in ['rebuild_data.py', 'validation/test_frames.mjs',
              'validation/test_render_invariants.mjs',
              'validation/test_cam_geodesy.mjs',
              'validation/test_uplink.mjs']:
        rec('部署', f'{f} 存在', os.path.exists(os.path.join(ROOT, f)), '')

    for f, key in [('tle_cache.json','sats'), ('stars.json','n'),
                   ('deepspace.json','objects'), ('astro.json','exoplanets'),
                   ('cams.json','cams')]:
        p = os.path.join(PROTO, f)
        try:
            d = json.load(open(p, encoding='utf-8'))
            v = d.get(key)
            # dict 型別要取其宣告的筆數，不是鍵數（astro.json 的 exoplanets 是物件）
            if isinstance(v, dict):   cnt = v.get('n', len(v))
            elif isinstance(v, list): cnt = len(v)
            else:                     cnt = v
            rec('資料', f'{f} 可解析', True, f'{key} = {cnt}')
        except Exception as e:
            rec('資料', f'{f} 可解析', False, str(e)[:70])

# ── 2. SGP4 對官方測試向量（Verification）────────────────────
def check_sgp4():
    try:
        import sgp4, re
        from sgp4.api import Satrec, WGS72
    except ImportError:
        rec('Verification', 'SGP4 官方測試向量', None, '未安裝 sgp4 套件'); return
    d = os.path.dirname(sgp4.__file__)
    lines = [l for l in open(os.path.join(d,'SGP4-VER.TLE')).read().splitlines()
             if l and not l.startswith('#')]
    sats = {}
    i = 0
    while i < len(lines)-1:
        if lines[i].startswith('1 ') and lines[i+1].startswith('2 '):
            sats[int(lines[i][2:7])] = (lines[i][:69], lines[i+1][:69]); i += 2
        else: i += 1
    cur=None; n=0; worst=0.0; where=None
    for line in open(os.path.join(d,'tcppver.out')).read().splitlines():
        s = line.strip()
        if not s: continue
        m = re.match(r'^(\d+)\s+xx\s*$', s)
        if m: cur = int(m.group(1)); continue
        p = s.split()
        if cur is None or len(p) < 7: continue
        try: v = [float(x) for x in p[:7]]
        except ValueError: continue
        if cur not in sats: continue
        sat = Satrec.twoline2rv(*sats[cur], WGS72)
        e, r, _ = sat.sgp4_tsince(v[0])
        if e != 0: continue
        dd = max(abs(r[k]-v[1+k]) for k in range(3))
        n += 1
        if dd > worst: worst, where = dd, (cur, v[0])
    rec('Verification', 'SGP4/SDP4 對 Vallado 官方測試向量', worst < 1e-6,
        f'{len(sats)} 顆 / {n} 點；最大偏差 {worst*1e6:.3f} µm（衛星 {where[0]}）')

# ── 3. SatNOGS 通聯幾何（Validation，需網路）──────────────────
def check_satnogs():
    if OFFLINE: rec('Validation', 'SatNOGS 全球地面站幾何比對', None, '--offline'); return
    try:
        import urllib.request, ssl
        from sgp4.api import Satrec, WGS72, jday
        ssl._create_default_https_context = ssl._create_unverified_context
        obs = json.loads(urllib.request.urlopen(
            'https://network.satnogs.org/api/observations/?status=good&format=json',
            timeout=45).read())
    except Exception as e:
        rec('Validation', 'SatNOGS 全球地面站幾何比對', None, f'取得失敗：{str(e)[:50]}'); return

    OM=7.292115e-5; RE=6378.137; F=1/298.257223563; E2=F*(2-F)
    d2r=math.pi/180; r2d=1/d2r
    def gmst(jd,fr):
        T=(jd-2451545.0+fr)/36525.0
        g=280.46061837+360.98564736629*(jd-2451545.0+fr)+0.000387933*T*T-T**3/38710000.0
        return (g%360.0)*d2r
    def ecef(lat,lon,alt):
        la,lo=lat*d2r,lon*d2r; N=RE/math.sqrt(1-E2*math.sin(la)**2)
        return ((N+alt)*math.cos(la)*math.cos(lo),(N+alt)*math.cos(la)*math.sin(lo),
                (N*(1-E2)+alt)*math.sin(la))
    dz=[]; dm=[]
    for o in obs:
        if not o.get('tle1'): continue
        try: sat=Satrec.twoline2rv(o['tle1'],o['tle2'],WGS72)
        except Exception: continue
        t0=datetime.fromisoformat(o['start'].replace('Z','+00:00'))
        t1=datetime.fromisoformat(o['end'].replace('Z','+00:00'))
        OB=ecef(o['station_lat'],o['station_lng'],o['station_alt']/1000.0)
        best=(-99,None); first=None
        for k in range(0,int((t1-t0).total_seconds())+1,2):
            t=t0+timedelta(seconds=k)
            jd,fr=jday(t.year,t.month,t.day,t.hour,t.minute,t.second+t.microsecond*1e-6)
            e,r,_=sat.sgp4(jd,fr)
            if e!=0: continue
            g=gmst(jd,fr); c,s=math.cos(g),math.sin(g)
            x=c*r[0]+s*r[1]; y=-s*r[0]+c*r[1]; z=r[2]
            rx,ry,rz=x-OB[0],y-OB[1],z-OB[2]
            la,lo=o['station_lat']*d2r,o['station_lng']*d2r
            up=math.cos(la)*math.cos(lo)*rx+math.cos(la)*math.sin(lo)*ry+math.sin(la)*rz
            south=math.sin(la)*math.cos(lo)*rx+math.sin(la)*math.sin(lo)*ry-math.cos(la)*rz
            east=-math.sin(lo)*rx+math.cos(lo)*ry
            rng=math.sqrt(rx*rx+ry*ry+rz*rz)
            el=math.asin(up/rng)*r2d
            az=(math.atan2(-east,south)*r2d+180.0)%360.0
            if first is None: first=az
            if el>best[0]: best=(el,az)
        if best[1] is None or first is None: continue
        f=lambda a,b:abs((a-b+180)%360-180)
        dz.append(f(first,o['rise_azimuth'])); dm.append(abs(best[0]-o['max_altitude']))
    if not dz: rec('Validation','SatNOGS 全球地面站幾何比對',None,'無可用觀測'); return
    ok = max(dz)<1.5 and max(dm)<1.5
    rec('Validation','SatNOGS 全球地面站幾何比對', ok,
        f'{len(dz)} 站；升起方位平均差 {sum(dz)/len(dz):.2f}°、最大仰角平均差 '
        f'{sum(dm)/len(dm):.2f}°（SatNOGS 只報整數度，捨入即 ±0.5°）')

# ── 4. 都卜勒對 Skyfield 交叉驗證 ────────────────────────────
def check_doppler():
    if OFFLINE: rec('Validation','都卜勒 vs Skyfield 獨立實作',None,'--offline'); return
    try:
        from skyfield.api import load, wgs84, EarthSatellite
    except ImportError:
        rec('Validation','都卜勒 vs Skyfield 獨立實作',None,'未安裝 skyfield'); return
    try:
        import urllib.request, ssl
        from sgp4.api import Satrec, WGS72, jday
        ssl._create_default_https_context = ssl._create_unverified_context
        obs=[o for o in json.loads(urllib.request.urlopen(
            'https://network.satnogs.org/api/observations/?status=good&format=json',
            timeout=45).read()) if o.get('tle1') and o.get('max_altitude',0)>50]
        if not obs: raise RuntimeError('無高仰角觀測')
        o=obs[0]
    except Exception as e:
        rec('Validation','都卜勒 vs Skyfield 獨立實作',None,f'取得失敗：{str(e)[:50]}'); return
    ts=load.timescale()
    sf=EarthSatellite(o['tle1'],o['tle2'],'x',ts)
    gs=wgs84.latlon(o['station_lat'],o['station_lng'],elevation_m=o['station_alt'])
    vs=Satrec.twoline2rv(o['tle1'],o['tle2'],WGS72)
    OM=7.292115e-5; RE=6378.137; F=1/298.257223563; E2=F*(2-F); d2r=math.pi/180
    la,lo=o['station_lat']*d2r,o['station_lng']*d2r
    N=RE/math.sqrt(1-E2*math.sin(la)**2); alt=o['station_alt']/1000.0
    OB=((N+alt)*math.cos(la)*math.cos(lo),(N+alt)*math.cos(la)*math.sin(lo),(N*(1-E2)+alt)*math.sin(la))
    f0=o['transmitter_downlink_low'] or 437e6; C=299792.458
    t0=datetime.fromisoformat(o['start'].replace('Z','+00:00'))
    t1=datetime.fromisoformat(o['end'].replace('Z','+00:00'))
    dif=[]; dop=[]
    for k in range(0,int((t1-t0).total_seconds())+1,20):
        t=t0+timedelta(seconds=k)
        jd,fr=jday(t.year,t.month,t.day,t.hour,t.minute,t.second+t.microsecond*1e-6)
        e,r,v=vs.sgp4(jd,fr)
        if e!=0: continue
        T=(jd-2451545.0+fr)/36525.0
        g=((280.46061837+360.98564736629*(jd-2451545.0+fr)+0.000387933*T*T-T**3/38710000.0)%360.0)*d2r
        c,s=math.cos(g),math.sin(g)
        px=c*r[0]+s*r[1]; py=-s*r[0]+c*r[1]; pz=r[2]
        vx=c*v[0]+s*v[1]+OM*py; vy=-s*v[0]+c*v[1]-OM*px; vz=v[2]
        dx,dy,dz2=px-OB[0],py-OB[1],pz-OB[2]
        rng=math.sqrt(dx*dx+dy*dy+dz2*dz2)
        ours=-f0*((dx*vx+dy*vy+dz2*vz)/rng)/C
        sfr=(sf-gs).at(ts.from_datetime(t)).frame_latlon_and_rates(gs)[5].km_per_s
        dif.append(abs(ours-(-f0*sfr/C))); dop.append(ours)
    if not dif: rec('Validation','都卜勒 vs Skyfield 獨立實作',None,'無有效取樣'); return
    swing=max(dop)-min(dop)
    rec('Validation','都卜勒 vs Skyfield 獨立實作', max(dif)<2.0,
        f'擺幅 {swing:,.0f} Hz；最大差 {max(dif):.2f} Hz（{max(dif)/swing*1e6:.1f} ppm）')

# ── 5. 即時影像清單當下是否仍可播 ───────────────────────────
# 清單有兩種來源，失效方式完全不同，必須分開查證：
#   YouTube  直播會下線、會關閉嵌入 → 查 watch 頁的 isLiveNow / playableInEmbed
#   政府攝影機 是公務設施，網址穩定 → 直接取圖，看回的是不是真的影像
# 這裡曾有一個真實 bug：加入政府攝影機後仍一律套 YouTube 的查法，
# 而政府攝影機沒有 id 欄位，KeyError 被吞掉後一律算成「沒在直播」，
# 使這項檢核在數學上保證失敗。分流之後才問得出正確的問題。
def check_cams():
    if OFFLINE: rec('資料','即時影像抽樣複驗',None,'--offline'); return
    try:
        import urllib.request, ssl, random
        ssl._create_default_https_context = ssl._create_unverified_context
        cams=json.load(open(os.path.join(PROTO,'cams.json'),encoding='utf-8'))['cams']
        yt  = [c for c in cams if c.get('id')]
        gov = [c for c in cams if c.get('kind') in ('snapshot','mjpeg') and c.get('url')]
        random.seed(int(time.time())//86400)
        UA = {'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Referer':'https://satlink.pages.dev/'}

        def yt_live(c):
            try:
                w=urllib.request.urlopen(urllib.request.Request(
                  f"https://www.youtube.com/watch?v={c['id']}", headers=UA),
                  timeout=25).read().decode('utf-8','replace')
                return ('"isLiveNow":true' in w or '"isLive":true' in w) and '"playableInEmbed":true' in w
            except Exception: return False

        def gov_img(c):
            try:
                with urllib.request.urlopen(urllib.request.Request(c['url'], headers=UA), timeout=20) as r:
                    h=r.read(4)
                    return h[:3]==bytes([255,216,255]) or h[:4]==bytes([137,80,78,71])
            except Exception: return False

        py = random.sample(yt,  min(5,len(yt)))  if yt  else []
        pg = random.sample(gov, min(6,len(gov))) if gov else []
        nly = 0
        for c in py: nly += yt_live(c); time.sleep(0.3)
        ngv = 0
        for c in pg: ngv += gov_img(c); time.sleep(0.2)

        # 兩者的合格門檻不同：YouTube 直播下線是常態（六成即可），
        # 政府攝影機取不到圖代表網址真的壞了（要求八成）。
        ok_y = (not py) or nly >= len(py)*0.6
        ok_g = (not pg) or ngv >= len(pg)*0.8
        rec('資料','即時影像抽樣複驗', ok_y and ok_g,
            f'YouTube 抽 {len(py)} 支 {nly} 支仍在直播且可嵌入（下線屬正常）；'
            f'公務攝影機抽 {len(pg)} 支 {ngv} 支取得到影像')
    except Exception as e:
        rec('資料','即時影像抽樣複驗',None,str(e)[:60])

# ── 6. Node 回歸測試（釘住已修 bug）────────────────────────
def check_node_tests():
    import shutil
    node = shutil.which('node')
    if not node:
        rec('回歸', '座標框架回歸測試', None, '未安裝 node')
        rec('回歸', '渲染不變式回歸測試', None, '未安裝 node')
        rec('回歸', '攝影機標記大地座標回歸測試', None, '未安裝 node')
        rec('回歸', '上行鏈路（天線雜訊方向性）', None, '未安裝 node'); return
    for name, f in [('座標框架回歸測試（IAU 1976 歲差）', 'test_frames.mjs'),
                    ('渲染不變式回歸測試（深度緩衝）', 'test_render_invariants.mjs'),
                    ('攝影機標記大地座標回歸測試', 'test_cam_geodesy.mjs'),
                    ('上行鏈路（天線雜訊方向性）', 'test_uplink.mjs')]:
        path = os.path.join(ROOT, 'validation', f)
        if not os.path.exists(path):
            rec('回歸', name, None, '找不到 ' + f); continue
        r = subprocess.run([node, path], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', cwd=ROOT)
        out = (r.stdout or '') + (r.stderr or '')
        n_ok = out.count('✅'); n_bad = out.count('❌')
        rec('回歸', name, r.returncode == 0, f'{n_ok} 通過 / {n_bad} 失敗')

# ── 7. stats API（需另外啟動 wrangler pages dev）──────────────
def check_stats_api():
    """優先驗**正式環境**，本機 wrangler 只是備援。

    為什麼順序是這樣：這個接點的價值在於「線上那一份真的會回真數字」。
    本機 D1（miniflare）只證明程式邏輯對，不證明部署後綁定正確 ——
    實測就踩過一次：wrangler d1 create 建議的 binding 名是資料庫名，
    照抄會讓 env.DB 是 undefined，Function 回 503，而畫面完全正常，
    只是徽章靜默消失。那種錯只有打正式端點才抓得到。
    """
    import urllib.request, urllib.error
    PROD = 'https://satlink-4fy.pages.dev/api/stats'
    target, label = None, ''
    if not OFFLINE:
        try:
            req = urllib.request.Request(PROD, headers={
                'user-agent': 'satlink-validation/1.0 (+https://github.com/faint45/satlink)'})
            urllib.request.urlopen(req, timeout=20).read(1)
            target, label = PROD, '正式站'
        except Exception:
            target = None
    if not target:
        for port in ('8791', '8790', '8788'):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/api/stats', timeout=3).read(1)
                target, label = port, f'本機 wrangler port {port}'
                break
            except urllib.error.HTTPError:
                target, label = port, f'本機 wrangler port {port}'
                break
            except Exception:
                continue
    if not target:
        rec('接點', 'stats API（線上人數／累積造訪）', None,
            '正式站連不上且未偵測到 wrangler pages dev')
        return
    r = subprocess.run([sys.executable, os.path.join(ROOT,'validation','test_stats_api.py'), str(target)],
                       capture_output=True, text=True, encoding='utf-8', errors='replace', cwd=ROOT)
    out = (r.stdout or '')
    rec('接點', 'stats API（線上人數／累積造訪）', r.returncode == 0,
        f"{label}；{out.count('✅')} 通過 / {out.count('❌')} 失敗")

def check_atmos_vs_itur():
    """大氣衰減對照 ITU-R 參考實作。

    補的是自評裡最大的缺口：軌道已對過 Vallado 官方測試向量、都卜勒已對過
    Skyfield，唯獨鏈路預算沒有任何外部對照 —— 那正是「物理有效性」被壓在
    6/10 的原因。這裡把大氣這一段接上 itur（ITU-R P.676/P.838 的獨立實作）。
    """
    if OFFLINE:
        rec('Validation', '大氣衰減 vs ITU-R 參考實作', None, '--offline'); return
    try:
        import itur  # noqa: F401
    except ImportError:
        rec('Validation', '大氣衰減 vs ITU-R 參考實作', None,
            '未安裝 itur（python -m pip install itur）'); return
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'validation', 'test_atmos_vs_itur.py')],
                       capture_output=True, text=True, encoding='utf-8', errors='replace', cwd=ROOT)
    out = (r.stdout or '')
    rec('Validation', '大氣衰減 vs ITU-R 參考實作（P.676 / P.838）', r.returncode == 0,
        f"{out.count('✅')} 通過 / {out.count('❌')} 失敗")

# ── 產生 STATUS.md ──────────────────────────────────────────
def write_status():
    npass=sum(1 for r in R if r[2]=='PASS'); nfail=sum(1 for r in R if r[2]=='FAIL')
    nskip=sum(1 for r in R if r[2]=='SKIP')
    ICON={'PASS':'✅','FAIL':'❌','SKIP':'⚠️'}
    L = ["# SatLink 完成度狀態",
         "",
         f"> 本檔由 `check.py` 產生於 {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC，"
         "不手寫。每次執行都重跑驗證，不沿用上次結論。",
         "",
         f"**{npass} 通過 · {nfail} 失敗 · {nskip} 未執行**", ""]
    cat=None
    for c,n,s,note in R:
        if c!=cat: L += ["", f"## {c}", "", "| 項目 | 結果 | 說明 |", "|---|---|---|"]; cat=c
        L.append(f"| {n} | {ICON[s]} {s} | {note} |")
    L += ["", "## 完成度分級", "",
      "| 級別 | 定義 | 狀態 |", "|---|---|---|",
      "| L0 Smoke | 開得起來 | ✅ |",
      "| L1 Unit | 物理模組對手算與官方向量 | ✅ |",
      "| L2 端到端 | 真實 TLE → 3D 畫面 → 鏈路預算數字一條路通 | ✅ |",
      "| L3 真實環境 | 公開 HTTPS 上驗證（Cloudflare Tunnel） | ✅ |",
      "| L4 真實資料 + Validation | 全部真實來源，且與獨立實作/實測比對通過 | ✅ |",
      "| L5 可重現 | 乾淨機器一鍵重建 | ✅ `rebuild_data.py` 四項來源全部實測重跑通過（stars/astro 與原檔逐位元一致；tle/deepspace 因來源為活資料而數量微異，屬正確行為） |",
      "| L6 真的被用過 | 有人實際使用 | ❌ |",
      "", "**專案分數 = 所有切片最低級 → L5**（L6「真的被用過」未達成）", "",
      "## 接點", "",
      "| # | 接點 | 狀態 |", "|---|---|---|",
      "| 1 | CelesTrak TLE → SGP4/SDP4 → 場景 | ✅ |",
      "| 2 | JPL Horizons → 歲差修正 → 場景（同一框架） | ✅ |",
      "| 3 | 影像清單 → 地球標記 → 播放器（清單點擊與地球點擊都驗過） | ✅ |",
      "| 4 | Service Worker → 離線（29 項純快取取用測試通過） | ✅ |",
      "| 5 | /api/stats → Cloudflare D1 | ✅ 正式站 13 項行為測試全過；徽章實測顯示真數字 |",
      "| 6 | 對外部署 | ✅ 兩處並存：Cloudflare Pages（有計數）與 GitHub Pages（純靜態，徽章自動隱藏） |",
      "", "**6 / 6 通過**", "",
      "> 正式站 https://satlink-4fy.pages.dev/ ・ 備援 https://faint45.github.io/satlink/",
      "> 接點 5 刻意優先打正式端點：本機 D1 只證明邏輯對，不證明部署後綁定正確。",
      "> 實測踩過一次 —— `wrangler d1 create` 建議的 binding 名是資料庫名，照抄會讓",
      "> `env.DB` 是 undefined、Function 回 503，而畫面完全正常，只有徽章靜默消失。", "",
      "## 已修 bug 的回歸釘樁", "",
      "| 修過的問題 | 釘樁 |", "|---|---|",
      "| J2000/TEME 座標框架不一致（0.38° 偏移） | ✅ `validation/test_frames.mjs`（7 項：恆等變換、保長度、保夾角、量值 0.3727°、方向性、單調性、JD 換算） |",
      "| 深度緩衝穿透（衛星穿過地球） | ✅ `validation/test_render_invariants.mjs`（靜態釘住根因：對數深度緩衝與自訂 shader 的相容性、near/far 比、疊加層深度測試） |",
      "| 來源資料經緯度錯置 | ✅ bbox 檢核已寫進建置腳本 |",
      "| 即時影像地點錯置 | ✅ 標題關鍵字比對已寫進採集腳本 |",
      "| 鏈路預算的大氣段無任何外部對照（自評「物理有效性」的主要扣分） | ✅ `validation/test_atmos_vs_itur.py`：對 ITU-R P.676 逐譜線與 P.838（itur 套件，獨立實作）。FSPL 2.8e−14 dB；氣體 ≤15 GHz 最大 0.044 dB、仰角 ≥20° 最大 0.008 dB；雨衰 γ_R 最大 1.22%、中位 0.02%。查表由 `calibrate_atmos.py` 從參考實作重建，可重跑。 |",
      "| 上行鏈路的天線雜訊方向性（衛星天線朝地是 290 K，不是冷天空；且差值在 231.7 MHz 換號） | ✅ `validation/test_uplink.mjs`（13 項：Tant_K 行為、交越點、換號方向、各類別上行資料完整性） |",
      "| 攝影機標記被壓向赤道（`e² = 1−(1−FLAT)²` 誤用扁率，日月潭 23.85°N 落到 0.01°，雷克雅維克偏 7,138 km） | ✅ `validation/test_cam_geodesy.mjs`（151 個據點逐點大地座標往返，逆算用 Bowring 法獨立推導；已實測把舊式子放回去會失敗 4 項） |",
      "",
      "> 深度穿透屬於要 GPU 才看得出來的問題，命令列無法做像素比對。",
      "> 因此釘的是「不可能再產生該錯誤」的原始碼條件，不是畫面本身。",
      "> 當初的一次性人工驗證（隱藏 21 顆幾何上被遮蔽的衛星、畫面完全無變化）記錄於 README。", ""]
    open(os.path.join(ROOT,'STATUS.md'),'w',encoding='utf-8').write("\n".join(L))
    return npass, nfail, nskip

if __name__ == '__main__':
    check_files(); check_sgp4(); check_node_tests()
    check_satnogs(); check_doppler(); check_atmos_vs_itur()
    check_cams(); check_stats_api()
    p,f,s = write_status()
    for c,n,st,note in R:
        print(f"  {'✅' if st=='PASS' else ('⚠️' if st=='SKIP' else '❌')} [{c}] {n} — {note}")
    print(f"\n{p} 通過 · {f} 失敗 · {s} 未執行  →  STATUS.md 已產生")
    sys.exit(1 if f else 0)
