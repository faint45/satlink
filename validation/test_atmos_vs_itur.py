# -*- coding: utf-8 -*-
"""大氣衰減對照 ITU-R 官方模型的獨立實作（Python 套件 itur）。

補的是自評裡最大的缺口：軌道對過 Vallado 官方向量、都卜勒對過 Skyfield，
唯獨鏈路預算沒有任何外部對照。這支把「大氣」這一段補上。

方法：physics.js 由 test_atmos_vs_itur.mjs 產生自己的數值寫成 JSON，
本檔讀進來後用 itur 各自獨立算一次再比對 —— 兩邊不共用任何中間結果。

對照條件：ITU-R P.835 標準參考大氣（海平面 P=1013.25 hPa、T=288.15 K、
ρ=7.5 g/m³），與 physics.js 表格所宣稱的「中緯度標準大氣」對應。

    python validation/test_atmos_vs_itur.py
"""
import io, json, os, subprocess, sys, math

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MINE = os.path.join(HERE, '_mine.json')

fails = []
def t(name, ok, detail=''):
    print(f"  {'✅' if ok else '❌'} {name}{' — ' + detail if detail else ''}")
    if not ok: fails.append(name)

def val(x):
    """itur 可能回傳帶單位的量，統一取純數。"""
    return float(getattr(x, 'value', x))

# ── 產生我方數值 ────────────────────────────────────────────
node = None
for c in ('node', 'node.exe'):
    try:
        subprocess.run([c, '--version'], capture_output=True, check=True); node = c; break
    except Exception: pass
if node is None:
    print('  ⚠️ 未安裝 node，無法產生對照資料'); sys.exit(0)
r = subprocess.run([node, os.path.join(HERE, 'test_atmos_vs_itur.mjs')],
                   capture_output=True, text=True, encoding='utf-8', errors='replace', cwd=ROOT)
if r.returncode != 0:
    print('  ❌ 產生我方數值失敗：', (r.stderr or '')[:200]); sys.exit(1)
mine = json.loads(r.stdout)

try:
    import itur
    from itur.models import itu676, itu838
except ImportError:
    print('  ⚠️ 未安裝 itur（pip install itur），略過對照'); sys.exit(0)

print(f'大氣衰減對照 ITU-R 獨立實作（itur {itur.__version__}）')

# ── 1. FSPL：對照教科書封閉式 ───────────────────────────────
worst = 0.0
for row in mine['fspl']:
    # 用精確常數而非四捨五入的 32.45：20log10(4π·1e9/c)
    C0 = 20*math.log10(4*math.pi*1e9/299792458.0)
    ref = C0 + 20*math.log10(row['f_MHz']) + 20*math.log10(row['d_km'])
    worst = max(worst, abs(row['mine_dB'] - ref))
t('FSPL 與封閉式 32.45+20log f_MHz+20log d_km 一致', worst < 1e-6,
  f'最大偏差 {worst:.2e} dB（{len(mine["fspl"])} 點，含 1 km/1 GHz=92.448、GEO 11.7 GHz=204.886）')

# ── 2. 氣體衰減 P.676 ───────────────────────────────────────
P, T, RHO = 1013.25, 288.15, 7.5
rows = []
for row in mine['gas']:
    try:
        ref = val(itu676.gaseous_attenuation_slant_path(
            row['f_GHz'], row['el_deg'], RHO, P, T, mode='exact'))
    except Exception as e:
        ref = None
    if ref is None: continue
    rows.append((row['f_GHz'], row['el_deg'], row['mine_dB'], ref))

if not rows:
    t('氣體衰減可比對', False, 'itur 呼叫全部失敗')
else:
    # 分頻段看：本站實際大量使用的是 <30 GHz；22.2 GHz 是水氣吸收峰
    lo  = [r for r in rows if r[0] <= 15]
    hi  = [r for r in rows if r[0] > 15]
    def stat(rs):
        d = [abs(m - ref) for _,_,m,ref in rs]
        return (max(d), sum(d)/len(d)) if d else (0,0)
    mx_lo, av_lo = stat(lo); mx_hi, av_hi = stat(hi)
    t('≤15 GHz 氣體衰減與 P.676 逐譜線相符（< 0.05 dB）', mx_lo < 0.05,
      f'{len(lo)} 點；最大 {mx_lo:.4f} dB、平均 {av_lo:.4f} dB')
    t('>15 GHz 氣體衰減與 P.676 逐譜線相符（< 0.30 dB，含 5° 的 cosecant 殘差）',
      mx_hi < 0.30, f'{len(hi)} 點；最大 {mx_hi:.4f} dB、平均 {av_hi:.4f} dB')
    # 殘差主要來自 cosecant 近似（地球曲率），仰角越低越明顯 —— 分開量化
    lowel = [r for r in rows if r[1] <= 10]
    hiel  = [r for r in rows if r[1] >= 20]
    mxl,_ = stat(lowel); mxh,_ = stat(hiel)
    t('仰角 ≥20° 時殘差可忽略（< 0.02 dB）', mxh < 0.02,
      f'≥20°：最大 {mxh:.4f} dB　／　≤10°：最大 {mxl:.4f} dB（cosecant 忽略地球曲率）')
    # 最差的幾點列出來，讓誤差來源看得見
    worst5 = sorted(rows, key=lambda r: -abs(r[2]-r[3]))[:5]
    print('     最大偏差前五：' + '　'.join(
        f'{f:g}GHz/{el:g}° 我 {m:.2f} vs ITU {ref:.2f}' for f, el, m, ref in worst5))
    # 方向性：仰角越低衰減越大（cosecant 律），這一定要對
    mono = all(
        [r[2] for r in sorted([x for x in rows if x[0]==f], key=lambda x: x[1])] ==
        sorted([r[2] for r in rows if r[0]==f], reverse=True)
        for f in sorted({r[0] for r in rows}))
    t('仰角越低衰減越大（cosecant 律方向正確）', mono)

# ── 3. 雨衰比衰減 P.838 ─────────────────────────────────────
rr = []
for row in mine['rainGamma']:
    try:
        ref = val(itu838.rain_specific_attenuation(row['R_mmh'], row['f_GHz'], 30, 45))
    except Exception:
        continue
    rr.append((row['f_GHz'], row['R_mmh'], row['mine_dB_km'], ref))
if not rr:
    t('雨衰比衰減可比對', False, 'itur 呼叫失敗')
else:
    rel = [abs(m-ref)/ref*100 for _,_,m,ref in rr if ref > 1e-6]
    t('雨衰比衰減 γ_R 與 P.838 相符（最大相對誤差 < 3%）', max(rel) < 3.0,
      f'{len(rr)} 點；最大 {max(rel):.2f}%、中位 {sorted(rel)[len(rel)//2]:.2f}%')
    worst3 = sorted(rr, key=lambda r: -(abs(r[2]-r[3])/max(r[3],1e-6)))[:3]
    print('     最大偏差前三：' + '　'.join(
        f'{f:g}GHz/{R:g}mm/h 我 {m:.3f} vs ITU {ref:.3f} dB/km' for f, R, m, ref in worst3))
    mono_f = True
    for R in sorted({r[1] for r in rr}):
        v = [m for f,RR,m,_ in sorted(rr) if RR == R]
        mono_f = mono_f and all(v[i] <= v[i+1] for i in range(len(v)-1))
    t('雨衰隨頻率單調上升（方向正確）', mono_f)

print('\n全部通過' if not fails else f'\n{len(fails)} 項未通過：' + '、'.join(fails))
sys.exit(1 if fails else 0)
