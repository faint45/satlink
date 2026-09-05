# -*- coding: utf-8 -*-
r"""部署到 ASUSTOR NAS 的 Apache（\192.168.1.111\Web\satlink）。

為什麼是這樣的組合：
  · 靜態檔直接放進 Web 共用資料夾，NAS 上的 Apache 已在 80/443 服務。
  · 線上人數改用 PHP + SQLite（nas/api/stats.php），與 Cloudflare Pages
    Function 的 JSON 契約完全相同，前端會自動偵測用哪個端點。
  · 因此 NAS 版不需要任何 Cloudflare 帳號或 D1。

用法：python deploy-nas.py [目標路徑]
"""
import os, shutil, sys, filecmp

SRC  = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prototype')
NAS  = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nas')
DEST = sys.argv[1] if len(sys.argv) > 1 else '//192.168.1.111/Web/satlink'
SKIP_DIRS  = {'functions'}          # Pages Function 只給 Cloudflare 用，NAS 走 PHP
SKIP_FILES = {'_headers'}
# 底線開頭的都是開發過程的暫存／備份，不該出貨
SKIP_PREFIX = ('_',)           # 同上：_headers 是 Cloudflare 專用

def copy_tree(src, dest, skip_dirs=(), skip_files=()):
    n_new = n_upd = n_same = 0
    for dp, dn, fn in os.walk(src):
        dn[:] = [d for d in dn if not d.startswith('.') and d not in skip_dirs]
        rel = os.path.relpath(dp, src)
        tgt = dest if rel == '.' else os.path.join(dest, rel)
        os.makedirs(tgt, exist_ok=True)
        for f in fn:
            if f.startswith('.') and f != '.htaccess': continue
            if f in skip_files or f.startswith(SKIP_PREFIX): continue
            s, d = os.path.join(dp, f), os.path.join(tgt, f)
            if not os.path.exists(d):        shutil.copy2(s, d); n_new += 1
            elif not filecmp.cmp(s, d, shallow=False): shutil.copy2(s, d); n_upd += 1
            else:                            n_same += 1
    return n_new, n_upd, n_same

if not os.path.isdir(os.path.dirname(DEST)):
    sys.exit(f'找不到目標上層目錄：{os.path.dirname(DEST)}（NAS 是否已連線／已認證？）')

os.makedirs(DEST, exist_ok=True)
a = copy_tree(SRC, DEST, SKIP_DIRS, SKIP_FILES)
print(f'  靜態檔  新增 {a[0]}  更新 {a[1]}  未變 {a[2]}')

# NAS 專用：PHP 端點、.htaccess、資料目錄
b = copy_tree(NAS, DEST)
print(f'  NAS 專用 新增 {b[0]}  更新 {b[1]}  未變 {b[2]}')

data = os.path.join(DEST, 'data')
os.makedirs(data, exist_ok=True)
print(f'\n完成 → {DEST}')
print('  http://192.168.1.111/satlink/')
