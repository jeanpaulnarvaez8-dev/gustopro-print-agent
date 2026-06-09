/**
 * QR IP Logger - Riva Beach Salento / GustoPro
 * --------------------------------------------
 * Server locale sul PC del ristorante. Il QR del tavolo punta a
 *   http://<IP-DEL-PC>:3000/t/<n-tavolo>
 * Quando un cliente scansiona registra (ora, tavolo, IP, UA, locale/esterno)
 * e redirige al menu pubblico.
 *
 * Dashboard locale: http://localhost:3000/admin?key=<ADMIN_KEY>
 *
 * GDPR — base legale: legittimo interesse del titolare (sicurezza /
 * antifrode locale). Citare nell'informativa privacy del Riva. Retention
 * massima: 90 giorni (log auto-ruotato sotto).
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG (override via env) ───────────────────────────────────
const PORT          = parseInt(process.env.QR_LOGGER_PORT || '3000', 10);
const ADMIN_KEY     = process.env.QR_LOGGER_ADMIN_KEY || 'riva-cambia-questo';
// MENU_BASE_URL: dove redirige dopo log. {slug} e {table} interpolati.
const MENU_BASE_URL = process.env.MENU_BASE_URL ||
  'https://gestione.gustopro.it/menu/{slug}/{table}';
const TENANT_SLUG   = process.env.TENANT_SLUG || 'riva-beach';
// Dove salvare il log (append, 1 riga JSON per scan). Auto-rotate a 90 giorni.
const LOG_DIR       = process.env.QR_LOG_DIR  || path.join(__dirname, 'logs');
const RETENTION_DAYS = parseInt(process.env.QR_RETENTION_DAYS || '90', 10);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'qr-scans.jsonl');

// In-memory cache per /admin (ultimi 5000)
const scans = [];

// ─── Helpers ─────────────────────────────────────────────────────
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  let ip = fwd ? String(fwd).split(',')[0].trim() : (req.socket?.remoteAddress || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);          // IPv4-mapped IPv6
  if (ip === '::1') ip = '127.0.0.1';
  return ip || 'sconosciuto';
}
function isLocalNetwork(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return false;
}
function logScan(entry) {
  scans.unshift(entry);
  while (scans.length > 5000) scans.pop();
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', () => {});
}
function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function parseUrl(url) {
  const u = new URL(url, 'http://x');
  return { pathname: u.pathname, params: u.searchParams };
}

// ─── Rotate log su retention ─────────────────────────────────────
function rotateLogIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    const ageDays = (Date.now() - stat.mtimeMs) / 86_400_000;
    if (ageDays > RETENTION_DAYS) {
      const archived = path.join(LOG_DIR, `qr-scans.${new Date().toISOString().slice(0,10)}.jsonl`);
      fs.renameSync(LOG_FILE, archived);
      console.log(`[rotate] archiviato ${archived}`);
    }
    // Cancella archive piu' vecchi del retention
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^qr-scans\.\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const stA = fs.statSync(path.join(LOG_DIR, f));
      if ((Date.now() - stA.mtimeMs) / 86_400_000 > RETENTION_DAYS) {
        fs.unlinkSync(path.join(LOG_DIR, f));
        console.log(`[rotate] eliminato ${f}`);
      }
    }
  } catch (e) { console.error('[rotate]', e.message); }
}
setInterval(rotateLogIfNeeded, 6 * 3600_000); // ogni 6 ore
rotateLogIfNeeded();

// ─── Load cache da log file all'avvio ────────────────────────────
function loadInitialScans() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const last = lines.slice(-5000);
    for (const line of last) {
      try { scans.unshift(JSON.parse(line)); } catch {}
    }
    console.log(`[boot] caricati ${scans.length} scan dal log`);
  } catch {}
}
loadInitialScans();

// ─── HTTP server ─────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const { pathname, params } = parseUrl(req.url);

  // /t/:table — cattura + redirect al menu
  const m = pathname.match(/^\/t\/(.+)$/);
  if (m) {
    const table = decodeURIComponent(m[1]).slice(0, 20);
    const ip = clientIp(req);
    const entry = {
      time: new Date().toISOString(),
      table,
      ip,
      local: isLocalNetwork(ip),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 250),
    };
    logScan(entry);
    const target = MENU_BASE_URL
      .replace('{slug}', encodeURIComponent(TENANT_SLUG))
      .replace('{table}', encodeURIComponent(table));
    res.writeHead(302, { Location: target });
    return res.end();
  }

  // /admin — dashboard locale, protetta da ADMIN_KEY
  if (pathname === '/admin') {
    if (params.get('key') !== ADMIN_KEY) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Accesso negato. Aggiungi ?key=IL-TUO-TOKEN');
    }
    const rows = scans.map(s => `
      <tr class="${s.local ? 'ok' : 'ext'}">
        <td>${new Date(s.time).toLocaleString('it-IT')}</td>
        <td><b>${htmlEscape(s.table)}</b></td>
        <td><code>${htmlEscape(s.ip)}</code></td>
        <td>${s.local ? '🟢 Rete locale' : '🔴 ESTERNO'}</td>
        <td class="ua" title="${htmlEscape(s.userAgent)}">${htmlEscape((s.userAgent || '').slice(0, 90))}</td>
      </tr>`).join('');
    const totals = {
      total: scans.length,
      ext: scans.filter(s => !s.local).length,
      local: scans.filter(s => s.local).length,
    };
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Scansioni QR — Riva Beach</title>
<style>
*{box-sizing:border-box}body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:0;background:#f4f5f7;color:#1f2430}
header{background:#0d1f2e;color:#fff;padding:16px 22px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header h1{margin:0;font-size:18px;font-weight:600}
header .stat{background:rgba(255,255,255,.08);padding:6px 12px;border-radius:8px;font-size:13px}
header .stat b{color:#d4af37;margin-right:6px}
.wrap{padding:22px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;
box-shadow:0 1px 3px rgba(0,0,0,.08);font-size:14px}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #eef0f3}
th{background:#fafbfc;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280}
tr.ext td{background:#fff7f6}
td:nth-child(4){font-weight:600}
tr.ok td:nth-child(4){color:#15803d}
tr.ext td:nth-child(4){color:#dc2626}
code{background:#f1f3f5;padding:2px 6px;border-radius:4px}
.ua{max-width:340px;font-size:12px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{padding:40px;text-align:center;color:#9aa0a6}
</style></head><body>
<header>
  <h1>🔍 Scansioni QR tavoli</h1>
  <div class="stat"><b>${totals.total}</b>totali</div>
  <div class="stat"><b style="color:#22c55e">${totals.local}</b>rete locale</div>
  <div class="stat"><b style="color:#ef4444">${totals.ext}</b>esterni</div>
  <div class="stat" style="margin-left:auto;font-size:11px;opacity:.7">auto-refresh 30s</div>
</header>
<div class="wrap">
<table>
  <thead><tr><th>Data/ora</th><th>Tavolo</th><th>IP</th><th>Origine</th><th>Dispositivo</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5" class="empty">Nessuna scansione ancora.</td></tr>'}</tbody>
</table>
</div></body></html>`);
  }

  // /export — snapshot JSONL completo del log corrente (per backup off-site)
  // Usato dal Mac di JP (mac-backup.sh) per copia di sicurezza titolare/GDPR.
  if (pathname === '/export') {
    if (params.get('key') !== ADMIN_KEY) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('forbidden');
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    if (fs.existsSync(LOG_FILE)) {
      return fs.createReadStream(LOG_FILE).pipe(res);
    }
    return res.end();
  }

  // /export/archive — lista archive ruotati disponibili (per backup completo)
  if (pathname === '/export/archive') {
    if (params.get('key') !== ADMIN_KEY) {
      res.writeHead(401); return res.end('forbidden');
    }
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => /^qr-scans\.\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ archives: files }));
  }

  // /health — per checks
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, scans: scans.length }));
  }

  // Root
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>QR IP Logger attivo</h1><p>I QR puntano a <code>/t/&lt;tavolo&gt;</code>.</p><p><a href="/admin?key=' + htmlEscape(ADMIN_KEY) + '">Dashboard</a></p>');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[qr-logger] in ascolto su http://0.0.0.0:${PORT}`);
  console.log(`[qr-logger] QR target: http://<IP-PC>:${PORT}/t/<n-tavolo>`);
  console.log(`[qr-logger] menu redirect: ${MENU_BASE_URL.replace('{slug}', TENANT_SLUG)}`);
  console.log(`[qr-logger] dashboard: http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
  console.log(`[qr-logger] retention log: ${RETENTION_DAYS} giorni`);
});
