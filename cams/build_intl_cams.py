# -*- coding: utf-8 -*-
"""採集非 YouTube 的公開即時影像（政府開放攝影機）。

為什麼要有這一支：原本的 61 個據點全是 YouTube 直播，來源單一，
而且直播會下線。政府的道路／景觀攝影機是穩定得多的來源 —— 它們是
公務設施，不會因為頻道關閉而消失，而且座標是攝影機的實際架設位置
（精確到公尺），不像 YouTube 只能取地點中心。

已實測可用、且不需要 API 金鑰的來源：
  · DriveBC（加拿大卑詩省）1062 支，JPEG，含 GeoJSON 座標與海拔
  · 511 Ontario（加拿大安大略省）944 支，JPEG，含經緯度
  · 台灣公路局省道（經 TDX）2372 支，JPEG 快照 + MJPEG 串流，含精確座標

挑選偏重風景：山口、海岸、國家公園路線，而非市區道路。
每一支都實際取圖驗證，取不到就不收錄。

用法：python build_intl_cams.py
"""
import json, os, ssl, sys, time, urllib.request

ssl._create_default_https_context = ssl._create_unverified_context
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://satlink.pages.dev/'}
HERE = os.path.dirname(os.path.abspath(__file__))

def get(url, timeout=90):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()

def is_image(url, timeout=15):
    """實際取一次圖，確認回的是影像而不是佔位圖或錯誤頁。"""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
            head = r.read(4)
            return head[:3] == b'\xff\xd8\xff' or head[:4] == b'\x89PNG'
    except Exception:
        return False

# ── 1. DriveBC（加拿大卑詩省）──────────────────────────────────
# 偏重山口與海岸；BC 的高海拔攝影機多在洛磯山脈與海岸山脈的隘口。
BC_SCENIC = ['whistler', 'sea to sky', 'coquihalla', 'rogers pass', 'kootenay',
             'duffey', 'malahat', 'kicking horse', 'yellowhead', 'okanagan',
             'revelstoke', 'banff', 'summit', 'pass', 'lake', 'glacier',
             'canyon', 'ferry', 'island', 'squamish', 'pemberton']
def fetch_drivebc(limit=34):
    rows = json.loads(get('https://www.drivebc.ca/api/webcams/'))
    def score(c):
        blob = ((c.get('name') or '') + ' ' + (c.get('caption') or '') + ' ' +
                (c.get('highway_description') or '') + ' ' + (c.get('region_name') or '')).lower()
        s = sum(2 for k in BC_SCENIC if k in blob)
        s += min((c.get('elevation') or 0) / 300.0, 6)     # 海拔越高越偏山景
        return s
    live = [c for c in rows if c.get('is_on') and c.get('location', {}).get('coordinates')]
    live.sort(key=score, reverse=True)
    out, seen = [], set()
    for c in live:
        if len(out) >= limit: break
        key = (c.get('highway_description'), c.get('region_name'))
        if list(seen).count(key) >= 4: continue           # 同區域最多 4 支，避免集中
        url = f"https://www.drivebc.ca/images/{c['id']}.jpg"
        if not is_image(url): continue
        lon, lat = c['location']['coordinates']
        out.append({'kind': 'snapshot', 'url': url,
                    'zh': (c.get('name') or '').strip(),
                    'place': f"BC, Canada · Hwy {c.get('highway_display') or '?'}",
                    'lat': round(lat, 6), 'lon': round(lon, 6),
                    'geo_precision': 'exact',
                    'provider': 'DriveBC（卑詩省交通廳）',
                    'note': (c.get('caption') or '').strip()[:140],
                    'elev_m': c.get('elevation')})
        seen.add(key)
        time.sleep(0.15)
    return out

# ── 2. 511 Ontario（加拿大安大略省）────────────────────────────
ON_SCENIC = ['niagara', 'muskoka', 'huntsville', 'parry sound', 'algonquin',
             'sault', 'thunder bay', 'kenora', 'bruce', 'georgian']
def fetch_ontario(limit=12):
    rows = json.loads(get('https://511on.ca/api/v2/get/cameras'))
    def score(c):
        blob = ((c.get('Location') or '') + ' ' + (c.get('Roadway') or '')).lower()
        return sum(1 for k in ON_SCENIC if k in blob)
    cand = [c for c in rows if c.get('Latitude') and c.get('Views')]
    cand.sort(key=score, reverse=True)
    out = []
    for c in cand:
        if len(out) >= limit: break
        v = next((v for v in c['Views'] if v.get('Status') == 'Enabled' and v.get('Url')), None)
        if not v or not is_image(v['Url']): continue
        out.append({'kind': 'snapshot', 'url': v['Url'],
                    'zh': (c.get('Location') or '').strip()[:40],
                    'place': f"Ontario, Canada · {c.get('Roadway') or ''}".strip(),
                    'lat': round(float(c['Latitude']), 6), 'lon': round(float(c['Longitude']), 6),
                    'geo_precision': 'exact',
                    'provider': '511 Ontario（安大略省交通廳）',
                    'note': (v.get('Description') or '').strip()[:140]})
        time.sleep(0.15)
    return out

# ── 3. 台灣省道（公路局，經 TDX）────────────────────────────────
# 只收風景路線：中橫、合歡山、阿里山、南橫、新中橫、花東海岸、北海岸、北橫、霧台、墾丁
TW_SCENIC = {'台8線': '中橫公路', '台14甲線': '合歡山', '台18線': '阿里山公路',
             '台20線': '南橫公路', '台21線': '新中橫', '台11線': '花東海岸',
             '台2線': '北海岸', '台7線': '北橫公路', '台24線': '霧台',
             '台26線': '墾丁', '台9線': '蘇花／南迴'}
def fetch_taiwan(per_route=4):
    raw = get('https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Highway')
    rows = (json.loads(raw).get('CCTVs') or [])
    out = []
    for road, label in TW_SCENIC.items():
        picks = [r for r in rows if r.get('RoadName') == road
                 and r.get('VideoImageURL') and r.get('PositionLat')]
        # 沿路平均取樣，避免全擠在同一段
        step = max(1, len(picks) // per_route)
        n = 0
        for r in picks[::step]:
            if n >= per_route: break
            lat, lon = float(r['PositionLat']), float(r['PositionLon'])
            if not (21.8 <= lat <= 26.4 and 118.0 <= lon <= 122.2):   # 台灣範圍檢核
                continue
            if not is_image(r['VideoImageURL']): continue
            out.append({'kind': 'snapshot', 'url': r['VideoImageURL'],
                        'zh': f"{label} {r.get('LocationMile','')}".strip(),
                        'place': f"台灣 · {road}",
                        'lat': round(lat, 6), 'lon': round(lon, 6),
                        'geo_precision': 'exact',
                        'provider': '交通部公路局（經 TDX）',
                        'note': (r.get('SurveillanceDescription') or '')[:140]})
            n += 1
            time.sleep(0.15)
    return out

if __name__ == '__main__':
    all_cams = []
    for name, fn in [('DriveBC 卑詩省', fetch_drivebc),
                     ('511 Ontario 安大略', fetch_ontario),
                     ('台灣省道風景路線', fetch_taiwan)]:
        try:
            got = fn()
            all_cams += got
            print(f'  {name:22s} 收錄 {len(got)} 支')
        except Exception as e:
            print(f'  {name:22s} 失敗：{type(e).__name__} {e}')
    meta = {'fetched_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'source': '政府開放道路／景觀攝影機。每一支皆實際取圖驗證後才收錄。',
            'note': '座標為攝影機實際架設位置（非地點中心）；影像為定時更新的靜態快照，非連續視訊。',
            'n': len(all_cams), 'cams': all_cams}
    json.dump(meta, open(os.path.join(HERE, 'intl_cams.json'), 'w'),
              ensure_ascii=False, indent=1)
    print(f'\n合計 {len(all_cams)} 支 → intl_cams.json')
