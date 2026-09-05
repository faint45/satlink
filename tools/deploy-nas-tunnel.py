# -*- coding: utf-8 -*-
"""把 SatLink 與 Cloudflare Tunnel 設定部署到 NAS 的 Docker 目錄。

與 deploy-nas.py 的差別：
  · deploy-nas.py    → //NAS/Web/satlink    給 NAS 既有的 Apache，區網用，無 HTTPS
  · deploy-nas-tunnel.py → //NAS/Docker/satlink  獨立容器 + Cloudflare Tunnel，
                            對外公開、固定網址、HTTPS，且只暴露這一個網站

用相對路徑掛載，因此不需要知道 NAS 上的絕對路徑（/volume1/... 各機不同）。

用法：python deploy-nas-tunnel.py [目標路徑]
"""
import os, shutil, sys, filecmp

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC  = os.path.join(ROOT, 'prototype')
NAS  = os.path.join(ROOT, 'nas')
TUN  = os.path.join(ROOT, 'nas-tunnel')
DEST = sys.argv[1] if len(sys.argv) > 1 else '//192.168.1.111/Docker/satlink'

# Cloudflare Pages 專用，NAS 走 PHP，不要帶過去
SKIP_DIRS  = {'functions'}
SKIP_FILES = {'_headers'}
# 底線開頭的都是開發過程的暫存／備份，不該出貨
SKIP_PREFIX = ('_',)

def copy_tree(src, dest, skip_dirs=(), skip_files=()):
    new = upd = same = 0
    for dp, dn, fn in os.walk(src):
        dn[:] = [d for d in dn if not d.startswith('.') and d not in skip_dirs]
        rel = os.path.relpath(dp, src)
        tgt = dest if rel == '.' else os.path.join(dest, rel)
        os.makedirs(tgt, exist_ok=True)
        for f in fn:
            if f.startswith('.') and f != '.htaccess': continue
            if f in skip_files or f.startswith(SKIP_PREFIX): continue
            s, d = os.path.join(dp, f), os.path.join(tgt, f)
            if not os.path.exists(d):
                shutil.copy2(s, d); new += 1
            elif not filecmp.cmp(s, d, shallow=False):
                shutil.copy2(s, d); upd += 1
            else:
                same += 1
    return new, upd, same

parent = os.path.dirname(DEST)
if not os.path.isdir(parent):
    sys.exit(f'找不到目標上層目錄：{parent}（NAS 是否已連線／已認證？）')

site = os.path.join(DEST, 'site')
os.makedirs(site, exist_ok=True)

a = copy_tree(SRC, site, SKIP_DIRS, SKIP_FILES)
print(f'  網站本體   新增 {a[0]}  更新 {a[1]}  未變 {a[2]}')

b = copy_tree(NAS, site)          # api/stats.php、.htaccess、data 佔位
print(f'  PHP 端點   新增 {b[0]}  更新 {b[1]}  未變 {b[2]}')

# 容器設定放在 site 的上一層，避免被當成網站內容供應出去
n = 0
for f in ('docker-compose.yml', '.env.example', 'SETUP.md', '.gitignore', 'up.sh'):
    s = os.path.join(TUN, f)
    if not os.path.exists(s): continue
    d = os.path.join(DEST, f)
    if not os.path.exists(d) or not filecmp.cmp(s, d, shallow=False):
        shutil.copy2(s, d); n += 1
print(f'  容器設定   寫入 {n} 個檔')

# SQLite 的可寫目錄。容器以唯讀掛載 site，只有這裡可寫。
data = os.path.join(DEST, 'data')
os.makedirs(data, exist_ok=True)
ht = os.path.join(data, '.htaccess')
if not os.path.exists(ht):
    with open(ht, 'w', encoding='utf-8') as f:
        f.write('# 資料庫不對外供應（內容僅隨機工作階段字串與計數器，無 IP、無個資）\n'
                'Require all denied\n')

print(f'\n完成 → {DEST}')
print('  下一步：照 SETUP.md 建立通道、把權杖寫進 .env，然後 docker compose up -d')
print('  （權杖請你本人貼進 NAS 上的 .env，不要經由任何聊天視窗）')
