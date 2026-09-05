<?php
/**
 * stats.php — 線上人數與累積造訪（NAS 版，PHP + SQLite）
 *
 * 這是 Cloudflare Pages Function（functions/api/stats.js）的等價實作，
 * 供自架於 NAS 的 Apache 使用。兩者的 JSON 契約完全相同，
 * 前端不需要知道自己跑在哪邊。
 *
 * 設計原則與 Cloudflare 版一致：
 *  1. 數字必須是真的。資料庫開不起來就回 503，前端據此隱藏徽章，
 *     絕不顯示假造或推估的數字。
 *  2. 累積造訪以「工作階段」計 —— 是造訪次數，不是不重複人數，回應中明講。
 *  3. 不儲存 IP、不設 cookie、不做任何個人識別。sid 是前端產生的隨機字串。
 */

const ONLINE_WINDOW = 120;   // 秒；與前端 45 秒心跳搭配，容許連續兩次遺漏
const PRUNE_AFTER   = 600;   // 秒；超過此時間的列直接刪除
const DB_PATH       = __DIR__ . '/../data/stats.sqlite';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out(array $o, int $code = 200): void {
    http_response_code($code);
    echo json_encode($o, JSON_UNESCAPED_UNICODE);
    exit;
}

$dir = dirname(DB_PATH);
if (!is_dir($dir) && !@mkdir($dir, 0770, true)) {
    out(['ok' => false, 'reason' => '無法建立資料目錄；未回傳任何數字'], 503);
}

try {
    $db = new PDO('sqlite:' . DB_PATH, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_TIMEOUT => 5,
    ]);
    // WAL：多個 Apache 子行程同時讀寫時避免整庫鎖死
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec('PRAGMA busy_timeout=4000');
    $db->exec('CREATE TABLE IF NOT EXISTS presence (sid TEXT PRIMARY KEY, seen INTEGER NOT NULL)');
    $db->exec('CREATE INDEX IF NOT EXISTS idx_presence_seen ON presence(seen)');
    $db->exec('CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
    $db->exec("INSERT OR IGNORE INTO counters (k, v) VALUES ('views', 0)");
} catch (Throwable $e) {
    out(['ok' => false, 'reason' => 'SQLite 開啟失敗：' . $e->getMessage()], 503);
}

$now    = time();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

function readCounts(PDO $db, int $now): array {
    $online = (int) $db->query(
        'SELECT COUNT(*) FROM presence WHERE seen >= ' . ($now - ONLINE_WINDOW))->fetchColumn();
    $views  = (int) $db->query("SELECT v FROM counters WHERE k='views'")->fetchColumn();
    return [$online, $views];
}

if ($method === 'GET') {
    // 唯讀：不寫入、不計數
    [$online, $views] = readCounts($db, $now);
    out(['ok' => true, 'online' => $online, 'views' => $views]);
}

if ($method !== 'POST') {
    out(['ok' => false, 'reason' => '僅接受 GET 與 POST'], 405);
}

$body = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
$sid  = $body['sid'] ?? null;

// 只接受 8–64 字元的英數與 -_，避免被塞入任意內容
if (!is_string($sid) || !preg_match('/^[A-Za-z0-9_-]{8,64}$/', $sid)) {
    out(['ok' => false, 'reason' => 'sid 格式不正確'], 400);
}

try {
    $db->beginTransaction();
    $st = $db->prepare('INSERT INTO presence (sid, seen) VALUES (:s, :t)
                        ON CONFLICT(sid) DO UPDATE SET seen = :t');
    $st->execute([':s' => $sid, ':t' => $now]);
    $db->prepare('DELETE FROM presence WHERE seen < :t')->execute([':t' => $now - PRUNE_AFTER]);
    if (($body['new'] ?? 0) === 1) {
        // 只有全新工作階段才累加造訪次數
        $db->exec("UPDATE counters SET v = v + 1 WHERE k='views'");
    }
    $db->commit();
} catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    out(['ok' => false, 'reason' => '寫入失敗：' . $e->getMessage()], 500);
}

[$online, $views] = readCounts($db, $now);
out([
    'ok'       => true,
    'online'   => $online,
    'views'    => $views,
    'window_s' => ONLINE_WINDOW,
    'note'     => 'views 為造訪次數（每個工作階段計一次），非不重複人數',
]);
