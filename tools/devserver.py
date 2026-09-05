# -*- coding: utf-8 -*-
"""SatLink 開發用靜態伺服器。

存在的理由：`python -m http.server` 只送 Last-Modified，瀏覽器會用啟發式快取
把改過的 .js / .css 留在本機，導致「檔案已改、畫面沒變」。這在本次開發中
反覆發生過數次，每次都要手動清快取才看得到結果。

這支伺服器對所有回應送 no-store，開發時所見即檔案內容。
正式站不用這支 —— Cloudflare Pages 由 _headers 控制快取策略。
"""
import sys, os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prototype')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8620

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        # ES modules 需要正確的 MIME；Windows 的登錄檔有時把 .js 對應成 text/plain
        super().end_headers()

    def guess_type(self, path):
        # 一律附上 charset：位元組本來就是 UTF-8，但不宣告會留下模糊地帶
        # （CSS 未宣告時會沿用引用文件的編碼，而非預設 UTF-8）
        p = str(path).lower()
        if p.endswith(('.js', '.mjs')):  return 'text/javascript; charset=utf-8'
        if p.endswith('.css'):           return 'text/css; charset=utf-8'
        if p.endswith('.json'):          return 'application/json; charset=utf-8'
        if p.endswith('.webmanifest'):   return 'application/manifest+json; charset=utf-8'
        if p.endswith(('.html', '.htm')):return 'text/html; charset=utf-8'
        if p.endswith('.svg'):           return 'image/svg+xml; charset=utf-8'
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        # 只記錄非 200，避免刷版
        if args and len(args) > 1 and str(args[1]) != '200':
            sys.stderr.write("%s %s\n" % (self.path, args[1]))

if __name__ == '__main__':
    if not os.path.isdir(ROOT):
        sys.exit(f'找不到目錄：{ROOT}')
    print(f'SatLink dev server  http://localhost:{PORT}  (no-store，改檔即生效)')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
