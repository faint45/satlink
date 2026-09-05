# -*- coding: utf-8 -*-
"""把 SatLink 發布到 GitHub Pages。

為什麼需要這一支：GitHub Pages 只能從 repo 根目錄或 /docs 供應網站，
而本專案的站台在 prototype/。與其為了它去改動開發時的目錄結構
（devserver、check.py、兩支 NAS 部署腳本都吃 prototype/），
不如比照 deploy-nas.py 的作法：組出一個發布用的工作區。

發布倉庫的長相：
    /                 ← prototype/ 的內容（Pages 供應的網站根目錄）
    validation/       ← 回歸與驗證腳本
    tools/            ← check.py、rebuild_data.py 等
    functions/, nas/  ← 另外兩種部署方式的端點原始碼（供對照，Pages 上不會執行）

與 Cloudflare/NAS 版的差別（會寫進發布倉庫的 README）：
Pages 是純靜態，跑不了 PHP 或 Pages Function，所以 /api/stats 不存在，
線上人數與累積造訪的徽章會自動隱藏 —— 那是既有設計（拿不到真數字就不顯示），
不是壞掉。

用法：
    python deploy-pages.py            # 同步 + 提交 + 推送
    python deploy-pages.py --no-push  # 只組出工作區，不推
"""
import filecmp, os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC  = os.path.join(ROOT, 'prototype')
DIST = os.path.join(ROOT, 'dist-pages')
REPO = 'satlink'

# _headers 是 Cloudflare Pages 專用；functions/ 在 Pages 上不會執行，
# 但保留原始碼供對照，放在子目錄不影響站台。
SKIP_FILES  = {'_headers'}
SKIP_PREFIX = ('_',)

def run(args, cwd=DIST, check=True):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    if check and r.returncode != 0:
        sys.exit(f'指令失敗：{" ".join(args)}\n{r.stdout}\n{r.stderr}')
    return r

def copy_tree(src, dest, skip_files=()):
    new = upd = same = 0
    for dp, dn, fn in os.walk(src):
        dn[:] = [d for d in dn if not d.startswith('.') and d != '__pycache__']
        rel = os.path.relpath(dp, src)
        tgt = dest if rel == '.' else os.path.join(dest, rel)
        os.makedirs(tgt, exist_ok=True)
        for f in fn:
            if f.startswith('.') or f in skip_files or f.startswith(SKIP_PREFIX):
                continue
            s, d = os.path.join(dp, f), os.path.join(tgt, f)
            if not os.path.exists(d):
                shutil.copy2(s, d); new += 1
            elif not filecmp.cmp(s, d, shallow=False):
                shutil.copy2(s, d); upd += 1
            else:
                same += 1
    return new, upd, same

os.makedirs(DIST, exist_ok=True)

a = copy_tree(SRC, DIST, SKIP_FILES)
print(f'  網站本體   新增 {a[0]}  更新 {a[1]}  未變 {a[2]}')

n = 0
for sub in ('validation', 'nas', 'functions', 'cams'):
    p = os.path.join(ROOT, sub)
    if os.path.isdir(p):
        r = copy_tree(p, os.path.join(DIST, sub))
        n += r[0] + r[1]
tools = os.path.join(DIST, 'tools')
os.makedirs(tools, exist_ok=True)
for f in ('check.py', 'rebuild_data.py', 'devserver.py',
          'deploy-nas.py', 'deploy-nas-tunnel.py', 'deploy-pages.py'):
    s = os.path.join(ROOT, f)
    if os.path.exists(s):
        d = os.path.join(tools, f)
        if not os.path.exists(d) or not filecmp.cmp(s, d, shallow=False):
            shutil.copy2(s, d); n += 1
for f in ('README.md', 'STATUS.md', 'LICENSE'):
    s = os.path.join(ROOT, f)
    if os.path.exists(s):
        d = os.path.join(DIST, f)
        if not os.path.exists(d) or not filecmp.cmp(s, d, shallow=False):
            shutil.copy2(s, d); n += 1
print(f'  工具與說明 寫入 {n} 個檔')

# .nojekyll：不加的話 Jekyll 會吃掉底線開頭的檔案，也會多一層無謂的建置
open(os.path.join(DIST, '.nojekyll'), 'w').close()
with open(os.path.join(DIST, '.gitignore'), 'w', encoding='utf-8') as f:
    f.write('__pycache__/\n*.pyc\n.DS_Store\n')

if not os.path.isdir(os.path.join(DIST, '.git')):
    run(['git', 'init', '-b', 'main'])
    print('  已初始化發布倉庫')

run(['git', 'add', '-A'])
st = run(['git', 'status', '--porcelain'])
if not st.stdout.strip():
    print('\n沒有變更，不需提交。')
else:
    n_ch = len(st.stdout.strip().splitlines())
    run(['git', 'commit', '-m',
         'Publish SatLink to GitHub Pages\n\n'
         'Static build of prototype/ plus validation and tooling for provenance.\n'
         '/api/stats is absent on Pages (no PHP or Functions); the visitor-count\n'
         'badge hides itself rather than showing an estimated number.\n\n'
         'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>'])
    print(f'\n已提交 {n_ch} 項變更')

print(f'\n工作區 → {DIST}')
