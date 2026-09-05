# -*- coding: utf-8 -*-
"""從原始來源重建 prototype/ 的所有資料檔（L5 可重現性）。

為什麼需要這支：資料是在對話過程中零散抓下來的，沒有腳本就無法在乾淨機器上
重建，也無法更新。這裡把五個來源整合成一個可重跑的管線。

用法：
    python rebuild_data.py            重建全部
    python rebuild_data.py tle stars  只重建指定項目
    python rebuild_data.py --list     列出可重建項目

原始回應快取在 .cache/ 底下（dot 開頭，Cloudflare Pages 會略過），
重跑時若快取存在就不重新下載，避免對來源造成不必要負擔。
刪掉 .cache/ 即為完整重抓。
"""
import json, os, ssl, sys, time, math, csv, io, gzip, urllib.request, urllib.parse
from datetime import datetime, timezone

ssl._create_default_https_context = ssl._create_unverified_context
ROOT  = os.path.dirname(os.path.abspath(__file__))
OUT   = os.path.join(ROOT, 'prototype')
CACHE = os.path.join(ROOT, '.cache')
os.makedirs(CACHE, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) satlink-sim/1.4'}
NOW = lambda: datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def fetch(url, cache_name, headers=UA, binary=False, force=False):
    """取回並快取。TDX 與 YouTube 需要瀏覽器 UA，否則回 401/擋掉。"""
    p = os.path.join(CACHE, cache_name)
    if os.path.exists(p) and os.path.getsize(p) > 200 and not force:
        return open(p, 'rb').read() if binary else open(p, encoding='utf-8', errors='replace').read()
    raw = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=180).read()
    with open(p, 'wb') as f: f.write(raw)
    time.sleep(1.0)                      # 對來源溫和一點
    return raw if binary else raw.decode('utf-8', 'replace')

def write(name, obj, note=''):
    p = os.path.join(OUT, name)
    json.dump(obj, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'  → {name}  {os.path.getsize(p)/1024:.0f} KB  {note}')

# ── 1. 衛星 TLE ──────────────────────────────────────────────
def build_tle():
    def group(g, supplemental=False):
        url = (f'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE={g}&FORMAT=tle'
               if supplemental else
               f'https://celestrak.org/NORAD/elements/gp.php?GROUP={g}&FORMAT=tle')
        L = [l.rstrip() for l in fetch(url, f'tle_{g}.txt').splitlines() if l.strip()]
        return [(L[i].strip(), L[i+1], L[i+2]) for i in range(0, len(L)-2, 3)]

    sel, seen = [], set()
    def add(rows, cls, grp, limit=None, pred=None, src='CelesTrak GP'):
        n = 0
        for name, l1, l2 in rows:
            if pred and not pred(name): continue
            if any(k in name.upper() for k in (' DEB', 'R/B', 'DEBRIS')): continue
            cat = l1[2:7].strip()
            if cat in seen: continue
            seen.add(cat)
            sel.append({'name': name, 'tle1': l1, 'tle2': l2, 'class': cls,
                        'group': grp, 'norad': int(cat), 'tleSrc': src})
            n += 1
            if limit and n >= limit: break

    not_geo_wx = lambda n: not any(k in n.upper() for k in
                   ('METEOSAT','ELEKTRO','FENGYUN-2','FENGYUN-4','GOES'))
    for g, cls, grp, lim, pred in [
        ('stations','station_vhf','stations',None,None),
        ('weather','leo_vhf','weather',None,not_geo_wx),
        ('goes','goes_l','goes',None,None),
        ('gps-ops','gnss_gps','gnss',None,None),
        ('galileo','gnss_gal','gnss',None,None),
        ('glo-ops','gnss_glo','gnss',None,None),
        ('beidou','gnss_bds','gnss',None,None),
        ('iridium-NEXT','iridium_l','iridium',66,None),
        ('science','science_s','science',30,None),
        ('amateur','amateur_uhf','amateur',60,None),
        ('resource','eo_xband','eo',30,None),
        ('oneweb','oneweb_ku','oneweb',50,None)]:
        add(group(g), cls, grp, lim, pred)

    # GEO：優先納入真正有窄點波束的現代高通量衛星，否則會挑到一堆舊星
    geo = group('geo')
    PRI = ['VIASAT-3','VIASAT-2','VIASAT-1','JUPITER 3','ECHOSTAR 24','ECHOSTAR 19','ECHOSTAR 17',
           'INMARSAT GX','INMARSAT-6','INMARSAT 5-F1','INMARSAT 5-F2','INMARSAT 5-F3','INMARSAT 5-F4',
           'KA-SAT','SES-12','SES-14','SES-15','SES-17','EUTELSAT KONNECT','EUTELSAT QUANTUM',
           'THAICOM 4','THAICOM 8','MEASAT-3D','APSTAR-6D','CHINASAT 16','KOREASAT 6A','KOREASAT 7',
           'JCSAT-110R','NILESAT 301','INTELSAT 35E','INTELSAT 37E','INTELSAT 40E']
    for pat in PRI:
        add([r for r in geo if pat in r[0].upper()], 'geo_spot', 'geo', 1)
    add(sorted(geo, key=lambda r: -int(r[1][2:7])), 'geo_spot', 'geo', 30 - sum(
        1 for s in sel if s['group'] == 'geo'))
    add(group('starlink', supplemental=True), 'leo_phased', 'starlink', 120,
        src='CelesTrak Supplemental（SpaceX 提供，精度優於一般 GP）')

    write('tle_cache.json', {'fetched_utc': NOW(),
          'source': 'CelesTrak GP + Supplemental (celestrak.org)', 'sats': sel},
          f'{len(sel)} 顆')

# ── 2. 恆星 ──────────────────────────────────────────────────
def build_stars():
    raw = fetch('https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/'
                'hygdata_v40.csv.gz', 'hyg.csv.gz', binary=True)
    keep = []
    with gzip.open(io.BytesIO(raw), 'rt', encoding='utf-8', errors='replace') as f:
        for d in csv.DictReader(f):
            try:
                mag = float(d['mag'])
                if mag > 6.5: continue
                ra, dec = float(d['ra']), float(d['dec'])
            except Exception:
                continue
            if (d.get('proper') or '').strip() == 'Sol':      # 目錄含太陽，須剔除
                continue
            try: ci = float(d.get('ci', ''))
            except Exception: ci = 0.65
            keep.append((ra, dec, mag, ci, (d.get('proper') or '').strip()))
    keep.sort(key=lambda s: s[2])
    write('stars.json', {
        'source': 'HYG Database v4.0 (astronexus, CC BY-SA 2.5) — Hipparcos/Yale BSC/Gliese 合併',
        'epoch': 'J2000.0', 'limit_mag': 6.5, 'n': len(keep),
        'note': '已排除目錄中的太陽(Sol)；太陽以獨立光源呈現',
        'ra_h': [round(k[0], 4) for k in keep], 'dec_d': [round(k[1], 4) for k in keep],
        'mag': [round(k[2], 2) for k in keep], 'ci': [round(k[3], 3) for k in keep],
        'named': {k[4]: i for i, k in enumerate(keep) if k[4]}}, f'{len(keep)} 顆')

# ── 3. 月球與深空任務星曆 ────────────────────────────────────
HORIZONS = [('火星','499','planet','行星'),('金星','299','planet','行星'),
 ('水星','199','planet','行星'),('木星','599','planet','行星'),('土星','699','planet','行星'),
 ('JWST 韋伯太空望遠鏡','-170','L2','日地 L2 暈輪軌道'),('Gaia 蓋亞','-139479','L2','日地 L2'),
 ('SOHO 太陽觀測站','-21','L1','日地 L1'),('DSCOVR','-78','L1','日地 L1'),
 ('ACE','-92','L1','日地 L1（太陽風）'),
 ('Voyager 1 航海家一號','-31','deep','星際空間'),('Voyager 2 航海家二號','-32','deep','星際空間'),
 ('New Horizons 新視野','-98','deep','古柏帶'),('Parker 太陽探測器','-96','deep','近日'),
 ('Juno 朱諾','-61','deep','木星軌道'),('Lucy 露西','-49','deep','特洛伊小行星'),
 ('Psyche 靈神星','-255','deep','前往靈神星'),('Europa Clipper','-159','deep','前往木衛二'),
 ('BepiColombo','-121','deep','水星'),('JUICE 木星冰月','-28','deep','前往木星'),
 ('Curiosity 好奇號','-76','mars','火星地表'),('MRO 火星偵察軌道器','-74','mars','火星軌道'),
 ('Mars Express','-41','mars','火星軌道'),('Tianwen-1 天問一號','-55','mars','火星軌道'),
 ('Hayabusa2 隼鳥二號','-37','deep','擴展任務'),('OSIRIS-APEX','-64','deep','前往 Apophis')]

def _horizons(cid, t0, t1, step, tag):
    q = {'format':'text','COMMAND':f"'{cid}'",'OBJ_DATA':'NO','MAKE_EPHEM':'YES',
         'EPHEM_TYPE':'VECTORS','CENTER':"'500@399'",'REF_PLANE':'FRAME',
         'START_TIME':f"'{t0}'",'STOP_TIME':f"'{t1}'",'STEP_SIZE':f"'{step}'",
         'VEC_TABLE':'1','OUT_UNITS':'KM-S','CSV_FORMAT':'YES'}
    return fetch('https://ssd.jpl.nasa.gov/api/horizons.api?' + urllib.parse.urlencode(q),
                 f'hz_{tag}.txt')

def _parse(t):
    rows = [r for r in t.split('$$SOE')[1].split('$$EOE')[0].strip().split('\n') if r.strip()]
    jd, xyz = [], []
    for r in rows:
        c = [x.strip() for x in r.split(',')]
        jd.append(float(c[0])); xyz += [round(float(c[2]),1), round(float(c[3]),1), round(float(c[4]),1)]
    return jd, xyz

def build_deepspace():
    import re
    MON = {m: i+1 for i, m in enumerate(
        ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'])}
    T0, T1 = '2026-07-01', '2027-01-01'
    objs = []
    for name, cid, kind, note in HORIZONS:
        tag = cid.replace('-', 'm')
        t = _horizons(cid, T0, T1, '1 d', tag)
        if '$$SOE' not in t:
            # JPL 的預報軌跡有終點，超出即無資料。取其可用範圍，不外插。
            m = re.search(r'No ephemeris for target .*? after A\.D\. (\d{4})-([A-Z]{3})-(\d{2})', t)
            if not m: print(f'  跳過 {name}'); continue
            from datetime import date, timedelta
            end = date(int(m.group(1)), MON[m.group(2)], int(m.group(3))) - timedelta(days=2)
            t = _horizons(cid, T0, end.isoformat(), '1 d', tag + '_short')
            if '$$SOE' not in t: print(f'  跳過 {name}'); continue
            cov = end.isoformat()
        else:
            cov = None
        jd, xyz = _parse(t)
        o = {'name': name, 'id': cid, 'kind': kind, 'note': note,
             'n': len(jd), 'xyz': xyz, 'jd0': jd[0]}
        if cov: o['coverage_end'] = cov
        objs.append(o)
        print(f'  {name:26s} {len(jd)} 點' + (f'（涵蓋至 {cov}）' if cov else ''))
    mjd, mxyz = _parse(_horizons('301', T0, T1, '2 h', 'moon2h'))
    write('deepspace.json', {'fetched_utc': NOW(),
        'source': 'NASA/JPL Horizons API，CENTER=500@399 地心，REF_PLANE=FRAME (ICRF 赤道)',
        'jd0': objs[0]['jd0'] if objs else None, 'step_days': 1.0, 'objects': objs,
        'moon': {'jd0': mjd[0], 'step_days': mjd[1]-mjd[0], 'n': len(mjd), 'xyz': mxyz,
                 'interp': 'Catmull-Rom'}}, f'{len(objs)} 個目標 + 月球 {len(mjd)} 點')

# ── 4. 系外行星與深空天體 ────────────────────────────────────
def build_astro():
    q = ('select pl_name,hostname,ra,dec,sy_dist,discoverymethod,disc_year,'
         'pl_orbper,pl_rade,pl_bmasse,st_spectype from ps where default_flag=1')
    rows = [r for r in csv.DictReader(io.StringIO(fetch(
        'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?' +
        urllib.parse.urlencode({'query': q, 'format': 'csv'}), 'exo.csv')))
        if r['ra'] and r['dec']]
    METH = {'Transit':0,'Radial Velocity':1,'Microlensing':2,'Imaging':3,
            'Transit Timing Variations':4,'Eclipse Timing Variations':5,'Astrometry':6,
            'Pulsar Timing':7,'Pulsation Timing Variations':8,
            'Orbital Brightness Modulation':9,'Disk Kinematics':10}
    f = lambda v: (round(float(v), 4) if v else None)
    exo = {'n': len(rows),
        'ra':[round(float(r['ra']),4) for r in rows], 'dec':[round(float(r['dec']),4) for r in rows],
        'dist_pc':[f(r['sy_dist']) for r in rows], 'name':[r['pl_name'] for r in rows],
        'host':[r['hostname'] for r in rows],
        'method':[METH.get(r['discoverymethod'], 11) for r in rows],
        'year':[int(r['disc_year']) if r['disc_year'] else None for r in rows],
        'rade':[f(r['pl_rade']) for r in rows], 'per':[f(r['pl_orbper']) for r in rows],
        'method_names':[k for k,_ in sorted(METH.items(), key=lambda x:x[1])] + ['其他']}

    KEEP = {'OCl':'疏散星團','GCl':'球狀星團','Cl+N':'星團＋星雲','PN':'行星狀星雲',
            'Neb':'瀰漫星雲','EmN':'發射星雲','RfN':'反射星雲','SNR':'超新星殘骸',
            'HII':'電離氫區','G':'星系','GGroup':'星系群','GPair':'星系對'}
    TYPES = list(KEEP)
    def hms(s):
        try: h, m, x = [float(v) for v in s.split(':')]; return (h + m/60 + x/3600)*15
        except Exception: return None
    def dms(s):
        try:
            s = s.strip(); sg = -1.0 if s[0] == '-' else 1.0
            d, m, x = [float(v) for v in s.lstrip('+-').split(':')]
            return sg*(d + m/60 + x/3600)
        except Exception: return None
    dso = {k: [] for k in ('ra','dec','type','mag','size','name','common','messier')}
    for r in csv.DictReader(io.StringIO(fetch(
            'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv',
            'ngc.csv')), delimiter=';'):
        t = r['Type']
        if t not in KEEP: continue
        ra, de = hms(r['RA']), dms(r['Dec'])
        if ra is None or de is None: continue
        mag = None
        for col in ('V-Mag', 'B-Mag'):
            try: mag = float(r[col]); break
            except Exception: pass
        M = (r.get('M') or '').strip()
        # 星團與星雲全收；星系只收梅西耶或亮於 11 等，否則一萬多個會蓋掉畫面
        if t in ('G','GPair','GGroup') and not M and (mag is None or mag > 11.0): continue
        try: sz = round(float(r['MajAx']), 3)
        except Exception: sz = None
        dso['ra'].append(round(ra,4)); dso['dec'].append(round(de,4))
        dso['type'].append(TYPES.index(t)); dso['mag'].append(round(mag,2) if mag is not None else None)
        dso['size'].append(sz); dso['name'].append(r['Name'].strip())
        dso['common'].append((r.get('Common names') or '').split(',')[0].strip())
        dso['messier'].append(int(M) if M else None)
    dso['n'] = len(dso['ra']); dso['type_names'] = [KEEP[t] for t in TYPES]
    write('astro.json', {'exoplanets': exo, 'dso': dso, 'sources': {
        'exoplanets': 'NASA Exoplanet Archive, Planetary Systems (ps) 表，default_flag=1',
        'dso': 'OpenNGC (Mattia Verga)，CC-BY-SA-4.0',
        'note': '座標為 J2000 赤道座標；繪製時做 J2000→當日歲差修正'}},
        f"系外行星 {exo['n']} · 深空天體 {dso['n']}")

TASKS = {'tle': build_tle, 'stars': build_stars,
         'deepspace': build_deepspace, 'astro': build_astro}

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    if '--list' in sys.argv:
        print('可重建項目：' + '  '.join(TASKS)); print('即時影像清單見 cams/harvest2.py（需逐一查證直播狀態）')
        sys.exit(0)
    todo = args or list(TASKS)
    bad = [t for t in todo if t not in TASKS]
    if bad: sys.exit(f'未知項目：{bad}；可用：{list(TASKS)}')
    for t in todo:
        print(f'\n[{t}]')
        TASKS[t]()
    print('\n完成。cams.json 需另行執行 cams/harvest2.py（直播狀態必須逐一查證，不宜盲目重跑）。')
