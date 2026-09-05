# -*- coding: utf-8 -*-
"""stats API 行為測試（線上人數／累積造訪）。

需要先啟動帶本機 D1 的 wrangler：

    npx wrangler pages dev prototype --d1 DB --port 8790 --compatibility-date 2026-09-04

不需要 Cloudflare 帳號 —— D1 在本機以 miniflare 模擬。

為什麼一定要跑這支：這段程式碼寫完後曾長時間完全沒被執行過，而且它的
失敗模式是「靜默」—— 用戶端設計成拿不到真實數字就隱藏徽章，所以就算
Function 根本沒被部署，畫面也只是少一個角落的字，不會有任何錯誤訊息。
實測時就抓到 Function 目錄放錯位置（見 README「部署陷阱」），
那個錯誤會讓整個功能永遠不作用而沒人發現。

    python validation/test_stats_api.py [port]
"""
import json, sys, secrets, urllib.request, urllib.error

# 每次執行都用新的隨機 sid：固定 sid 在 75 秒的線上判定視窗內重跑會殘留，
# 讓「線上人數 +1」不成立 —— 那是測試不具冪等性，不是 API 的問題。
SID_A = 'test' + secrets.token_hex(8)
SID_B = 'test' + secrets.token_hex(8)

# 參數可以是埠號（本機 wrangler）或完整網址（NAS 的 PHP 端點）
ARG  = sys.argv[1] if len(sys.argv) > 1 else '8790'
BASE = ARG if ARG.startswith('http') else f'http://127.0.0.1:{ARG}/api/stats'
fails = []

def call(method, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE, data=data,
        headers={'content-type': 'application/json'}, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=25)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {'_raw': raw[:160].decode('utf-8', 'replace')}

post = lambda b: call('POST', b)
get  = lambda: call('GET')

def t(name, cond, detail=''):
    print(f"  {'✅' if cond else '❌'} {name}{' — ' + detail if detail else ''}")
    if not cond: fails.append(name)

def main():
    print(f'stats API 行為測試（{BASE}）')
    try:
        s1, j1 = post({'sid': SID_A, 'new': 1})
    except Exception as e:
        print(f'  ❌ 無法連線：{e}')
        print('     本機請先啟動：npx wrangler pages dev prototype --d1 DB --port 8790')
        return 2

    t('新工作階段建立成功（含自動建表）', s1 == 200 and j1.get('ok'),
      f"HTTP {s1} online={j1.get('online')} views={j1.get('views')}")
    if not j1.get('ok'):
        print('  詳細：', j1); return 1
    v0, o0 = j1['views'], j1['online']

    _, j2 = post({'sid': SID_A, 'new': 0})
    t('同一 sid 心跳不重複累加造訪數', j2['views'] == v0, f"{v0} → {j2['views']}")
    t('同一 sid 不重複計入線上人數', j2['online'] == o0, f"{o0} → {j2['online']}")

    _, j3 = post({'sid': SID_B, 'new': 1})
    t('第二個工作階段線上人數 +1', j3['online'] == o0 + 1, f"{o0} → {j3['online']}")
    t('第二個工作階段造訪數 +1', j3['views'] == v0 + 1, f"{v0} → {j3['views']}")

    for label, body in [('過短 sid', {'sid': 'x'}),
                        ('含空白與驚嘆號的 sid', {'sid': 'bad sid with spaces!!'}),
                        ('缺少 sid', {}),
                        ('過長 sid', {'sid': 'A' * 65, 'new': 1})]:
        code, _ = post(body)
        t(f'{label} 被拒 400', code == 400, f'HTTP {code}')

    s8, j8 = get()
    t('GET 唯讀且數值一致', s8 == 200 and j8['views'] == j3['views'],
      f"HTTP {s8} online={j8['online']} views={j8['views']}")
    _, j9 = get()
    t('GET 不累加造訪數', j9['views'] == j8['views'], f"{j8['views']} → {j9['views']}")
    t('回傳線上判定視窗秒數', j3.get('window_s') == 120, f"window_s={j3.get('window_s')}")
    t('附帶「造訪次數非不重複人數」說明', bool(j3.get('note')), (j3.get('note') or '')[:36])

    print(f"\n{len(fails)} 項失敗：{fails}" if fails else "\n全部通過")
    return 1 if fails else 0

if __name__ == '__main__':
    sys.exit(main())
