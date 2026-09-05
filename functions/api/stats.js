/**
 * /api/stats — 線上人數與累積瀏覽數（Cloudflare Pages Function + D1）
 *
 * 設計原則：
 *  1. 數字必須是真的。若 D1 綁定不存在或查詢失敗，回傳 503 並附上原因，
 *     前端據此隱藏計數徽章 —— 絕不顯示假造或推估的數字。
 *  2. 累積瀏覽數以「工作階段」計，同一個分頁重整不重複累加
 *     （由前端的 sessionStorage 決定何時送 new=1），
 *     因此它是「造訪次數」不是「不重複人數」，介面上如此標示。
 *  3. 線上人數＝最近 ONLINE_WINDOW 秒內有心跳的工作階段數。
 *  4. 不儲存 IP、不設 cookie、不做任何個人識別；sid 是前端隨機產生的
 *     一次性亂數，僅存活於該分頁的 sessionStorage。
 */
// 線上判定視窗。與前端心跳間隔一起決定 D1 的寫入量：
// D1 免費額度為每日 10 萬次寫入，每位訪客每分鐘寫入 60/心跳間隔 次。
// 心跳 45 秒 → 每人每分鐘 1.33 次 → 可支撐約 52 位持續在線一整天。
// 視窗設 120 秒（心跳的 2.7 倍）容許連續兩次遺漏，代價是離線者最多多顯示兩分鐘。
const ONLINE_WINDOW = 120;
const PRUNE_AFTER   = 600;     // 秒；超過此時間的列直接刪除

async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS presence (
                  sid TEXT PRIMARY KEY,
                  seen INTEGER NOT NULL
                )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_presence_seen ON presence(seen)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS counters (
                  k TEXT PRIMARY KEY,
                  v INTEGER NOT NULL
                )`),
    db.prepare(`INSERT OR IGNORE INTO counters (k, v) VALUES ('views', 0)`)
  ]);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) {
    return json({ ok: false, reason: 'D1 binding "DB" 未設定；未回傳任何數字' }, 503);
  }

  let body = {};
  try { body = await request.json(); } catch { /* 允許空 body */ }

  // sid：僅接受 8–64 字元的英數與 -_，避免被塞入任意內容
  const sid = typeof body.sid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.sid)
    ? body.sid : null;
  if (!sid) return json({ ok: false, reason: 'sid 格式不正確' }, 400);

  const now = Math.floor(Date.now() / 1000);

  try {
    await ensureSchema(db);

    const stmts = [
      db.prepare(`INSERT INTO presence (sid, seen) VALUES (?1, ?2)
                  ON CONFLICT(sid) DO UPDATE SET seen = ?2`).bind(sid, now),
      db.prepare(`DELETE FROM presence WHERE seen < ?1`).bind(now - PRUNE_AFTER)
    ];
    // 只有全新工作階段才累加造訪次數
    if (body.new === 1) {
      stmts.push(db.prepare(`UPDATE counters SET v = v + 1 WHERE k = 'views'`));
    }
    await db.batch(stmts);

    const online = await db.prepare(
      `SELECT COUNT(*) AS n FROM presence WHERE seen >= ?1`).bind(now - ONLINE_WINDOW).first();
    const views = await db.prepare(
      `SELECT v FROM counters WHERE k = 'views'`).first();

    return json({
      ok: true,
      online: online?.n ?? 0,
      views: views?.v ?? 0,
      window_s: ONLINE_WINDOW,
      note: 'views 為造訪次數（每個工作階段計一次），非不重複人數'
    });
  } catch (err) {
    return json({ ok: false, reason: 'D1 查詢失敗：' + (err && err.message) }, 500);
  }
}

// 唯讀查詢：不寫入、不計數，供外部檢視
export async function onRequestGet({ env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, reason: 'D1 binding "DB" 未設定' }, 503);
  try {
    await ensureSchema(db);
    const now = Math.floor(Date.now() / 1000);
    const online = await db.prepare(
      `SELECT COUNT(*) AS n FROM presence WHERE seen >= ?1`).bind(now - ONLINE_WINDOW).first();
    const views = await db.prepare(`SELECT v FROM counters WHERE k = 'views'`).first();
    return json({ ok: true, online: online?.n ?? 0, views: views?.v ?? 0 });
  } catch (err) {
    return json({ ok: false, reason: 'D1 查詢失敗：' + (err && err.message) }, 500);
  }
}
