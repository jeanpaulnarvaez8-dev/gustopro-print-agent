#!/usr/bin/env node
/**
 * Agente di stampa locale GustoPro
 * ---------------------------------
 * Fa da ponte tra gestione.gustopro.it (cloud) e la stampante termica ESC/POS
 * sulla LAN del locale. Riceve il conto in JSON via HTTP e lo invia in ESC/POS
 * "raw" alla stampante sulla porta 9100 (come faceva `printf | nc`, ma dietro
 * un endpoint HTTP richiamabile dal bottone "Stampa").
 *
 * Avvio:   node agent.js
 *
 * Config (variabili d'ambiente, tutte opzionali):
 *   PRINTER_IP    default 192.168.1.24   (la POS80D del preconto)
 *   PRINTER_PORT  default 9100
 *   LISTEN_PORT   default 9110           (porta locale dell'agente)
 *   ALLOW_ORIGIN  default *              (in produzione: https://gestione.gustopro.it)
 *   BIND          default 127.0.0.1      (solo questo PC; 0.0.0.0 = tutta la LAN)
 *
 * Endpoint:
 *   GET  /health   -> { ok, printer }
 *   POST /print    -> body JSON del conto, vedi buildReceipt()
 */
'use strict';
const http  = require('http');
const https = require('https');
const net   = require('net');

const PRINTER_IP   = process.env.PRINTER_IP   || '192.168.1.24';
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '9100', 10);
const LISTEN_PORT  = parseInt(process.env.LISTEN_PORT  || '9110', 10);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const BIND         = process.env.BIND || '127.0.0.1';

// JP 2026-06-03: polling cloud queue.
// Il backend Hetzner accetta job dai tablet (POST /api/print/enqueue) e li
// tiene in memoria. Noi li scarichiamo ogni POLL_SECONDS e li stampiamo.
// Stampante = stessa di /print POST: TP808 .24:9100.
const CLOUD_BASE    = process.env.CLOUD_BASE    || 'https://gestione.gustopro.it/api';
const TENANT_SLUG   = process.env.TENANT_SLUG   || 'riva-beach';
const PRINT_TOKEN   = process.env.PRINT_AGENT_TOKEN || '1122b524f5c872216f26adccaf64e6e387c7cdede66813d4';
const POLL_SECONDS  = parseInt(process.env.POLL_SECONDS || '2', 10);

// JP 2026-06-04: Custom Q3X-F fiscale (al Riva). IP e porta vanno
// configurati DAL TECNICO PdiEsse (0832 231105) prima del go-live.
// Lascio default vuoto: senza IP, i job kind='fiscal' vengono saltati
// con un log esplicito invece di crashare.
const FISCAL_IP     = process.env.FISCAL_PRINTER_IP   || '';
const FISCAL_PORT   = parseInt(process.env.FISCAL_PRINTER_PORT || '9100', 10);

// JP 2026-06-05: stampante CUCINA per ticket "pronto al pass". E' la
// stessa Q3X-F in modalita' non-fiscale (default 192.168.1.23:9100).
// Quando il chef preme CHIAMA CAMERIERE → esce un mini ticket con
// TAVOLO X + NOME PIATTO + QTY → il cameriere prende e porta.
const KITCHEN_IP    = process.env.KITCHEN_PRINTER_IP   || '192.168.1.23';
const KITCHEN_PORT  = parseInt(process.env.KITCHEN_PRINTER_PORT || '9100', 10);

// JP 2026-06-05: stampante BAR (cocktail/birre/vini/caffe'/digestivi).
// Default: 192.168.1.21 al Riva. Quando il cameriere manda un ordine con
// bevande, esce un ticket sulla bar printer con TAV X + lista bevande.
const BAR_IP        = process.env.BAR_PRINTER_IP       || '192.168.1.21';
const BAR_PORT      = parseInt(process.env.BAR_PRINTER_PORT || '9100', 10);

const ESC = 0x1B, GS = 0x1D;
const WIDTH = 32; // colonne stampabili (sicuro sia a 58 sia a 80mm)

const euro = (n) => Number(n || 0).toFixed(2).replace('.', ',');

// Riga "voce .......... prezzo" allineata a WIDTH colonne
function line(left, right, width = WIDTH) {
  left = String(left); right = String(right);
  const gap = width - left.length - right.length;
  if (gap >= 1) return left + ' '.repeat(gap) + right;
  const max = Math.max(0, width - right.length - 1);
  return left.slice(0, max) + ' ' + right;
}

// Costruisce il buffer ESC/POS del preconto a partire dal JSON del conto
function buildReceipt(conto) {
  const bytes = [];
  const raw = (...b) => bytes.push(...b);
  const txt = (s) => { for (const c of Buffer.from(String(s), 'latin1')) bytes.push(c); };

  raw(ESC, 0x40);                                   // init
  raw(ESC, 0x61, 1);                                // allinea al centro
  raw(GS, 0x21, 0x11); txt('GUSTOPRO'); raw(GS, 0x21, 0x00); txt('\n'); // titolo doppio
  txt((conto.locale || 'Riva Beach Salento') + '\n');
  raw(ESC, 0x61, 0);                                // allinea a sinistra
  txt('-'.repeat(WIDTH) + '\n');
  txt(line('PRECONTO', conto.tavolo ? ('Tav. ' + conto.tavolo) : '') + '\n');
  if (conto.data) txt(conto.data + '\n');
  txt('-'.repeat(WIDTH) + '\n');
  for (const r of (conto.righe || [])) {
    txt(line(`${r.qta}x ${r.nome}`, euro(r.prezzo)) + '\n');
  }
  txt('-'.repeat(WIDTH) + '\n');
  raw(ESC, 0x45, 1);                                // grassetto ON
  txt(line('TOTALE', euro(conto.totale) + ' EUR') + '\n');
  raw(ESC, 0x45, 0);                                // grassetto OFF
  raw(ESC, 0x61, 1);                                // centro
  txt('\n(non e\' un documento fiscale)\nGustoPro\n');
  txt('\n\n\n');                                    // avanzamento carta
  raw(GS, 0x56, 0);                                 // taglio carta
  return Buffer.from(bytes);
}

// Una singola connessione TCP raw alla stampante + scrittura dei byte ESC/POS.
// Marca l'errore con `connected` per sapere se i byte erano gia' partiti.
function connectOnce(buf) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(PRINTER_PORT, PRINTER_IP);
    let settled = false, connected = false;
    const done = (err) => { if (settled) return; settled = true; err ? reject(Object.assign(err, { connected })) : resolve(); };
    sock.setTimeout(5000);
    sock.on('connect', () => { connected = true; sock.write(buf, () => sock.end()); });
    sock.on('error', done);
    sock.on('timeout', () => { sock.destroy(); done(new Error('timeout')); });
    sock.on('close', (hadErr) => done(hadErr ? new Error('connessione chiusa con errore') : null));
  });
}

// Invia con qualche tentativo: maschera i fallimenti "a freddo" (privacy Rete
// Locale di macOS dopo un riavvio, ARP non ancora caldo, stampante in standby).
// Ritenta SOLO se non eravamo ancora connessi, per non rischiare doppie stampe.
async function sendToPrinter(buf, retries = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await connectOnce(buf); }
    catch (e) {
      lastErr = e;
      console.error(`[print] tentativo ${attempt}/${retries}: ${e.message}`);
      if (e.connected) break;                       // byte forse gia' inviati -> stop
      if (attempt < retries) await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  throw lastErr;
}

// JP 2026-06-07: invia a IP/porta arbitrari (per routing preconto asporto
// → BAR .21). Stessa logica di sendToPrinter ma parametrica.
function connectOnceTo(buf, ip, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, ip);
    let settled = false, connected = false;
    const done = (err) => { if (settled) return; settled = true; err ? reject(Object.assign(err, { connected })) : resolve(); };
    sock.setTimeout(5000);
    sock.on('connect', () => { connected = true; sock.write(buf, () => sock.end()); });
    sock.on('error', done);
    sock.on('timeout', () => { sock.destroy(); done(new Error('timeout')); });
    sock.on('close', (hadErr) => done(hadErr ? new Error('connessione chiusa con errore') : null));
  });
}
async function sendToCustomPrinter(buf, ip, port, retries = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await connectOnceTo(buf, ip, port); }
    catch (e) {
      lastErr = e;
      console.error(`[print ${ip}:${port}] tentativo ${attempt}/${retries}: ${e.message}`);
      if (e.connected) break;
      if (attempt < retries) await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  throw lastErr;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    return json(200, { ok: true, printer: `${PRINTER_IP}:${PRINTER_PORT}` });
  }

  if (req.method === 'POST' && req.url.startsWith('/print')) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let conto = {};
      if (body) { try { conto = JSON.parse(body); } catch { return json(400, { ok: false, error: 'JSON non valido' }); } }
      try { await sendToPrinter(buildReceipt(conto)); json(200, { ok: true }); }
      catch (e) { json(502, { ok: false, error: 'Stampante non raggiungibile: ' + e.message }); }
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(LISTEN_PORT, BIND, () => {
  console.log(`[GustoPro print agent] in ascolto su http://${BIND}:${LISTEN_PORT}`);
  console.log(`  -> stampa verso ${PRINTER_IP}:${PRINTER_PORT}`);
  console.log(`  -> POST /print (JSON conto)   |   GET /health`);
});

// ───────────────────────────────────────────────────────────────────────────
// Cloud queue polling (JP 2026-06-03)
// Pollo /api/public/print-pending/<slug>. Drena la coda di job inseriti dai
// tablet via POST /api/print/enqueue. Per ogni job scarico i byte ESC/POS
// gia' formattati dal backend (/api/public/preconto-escpos/<id>) e li
// scarico su sendToPrinter(). Niente buildReceipt() locale: il backend ha
// fiscal_data + coperto + items, qui sono solo bytes.
// ───────────────────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
                   path: u.pathname + u.search, headers };
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

let _polling = false;
async function pollOnce() {
  if (_polling) return;
  _polling = true;
  try {
    const url = `${CLOUD_BASE}/public/print-pending/${TENANT_SLUG}`;
    const r = await httpsGet(url, { 'X-Print-Token': PRINT_TOKEN });
    if (r.status !== 200) {
      // Log solo errori inattesi, non i 401/503 ricorrenti (rumore)
      if (r.status !== 401 && r.status !== 503) {
        console.error(`[poll] status ${r.status}`);
      }
      return;
    }
    let data;
    try { data = JSON.parse(r.body.toString('utf8')); } catch { return; }
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    for (const job of jobs) {
      if (!job.order_id) continue;
      // JP 2026-06-05: ticket "pronto al pass" — un mini ticket per ogni
      // piatto che diventa ready. Stampato sulla Q3X-F in modalita'
      // non-fiscale (no impatto AdE). Tentiamo PRIMA ESC/POS standard
      // (esce su qualsiasi termica), FALLBACK XML Custom non-fiscale.
      if (job.kind === 'kitchen-pass') {
        const p = normalizeKitchenPayload(job.payload || {});
        const desc = p.items.map(it => `${it.quantity}x ${it.name}`).join(', ');
        console.log(`[poll] job KITCHEN tav=${p.table_number} [${desc}]`);
        try {
          await sendKitchenTicket(p);
          console.log(`  ✓ stampato su ${KITCHEN_IP}:${KITCHEN_PORT}`);
        } catch (e) {
          console.error(`  ✗ kitchen: ${e.message}`);
        }
        continue;
      }
      // JP 2026-06-05: ticket BAR per cocktail/birre/vini/caffe'/digestivi.
      // Stampato sulla termica bar (.21). Same shape del kitchen-pass:
      // { table_number, items: [{name, quantity}] }.
      if (job.kind === 'bar-pass') {
        const p = normalizeKitchenPayload(job.payload || {});
        const desc = p.items.map(it => `${it.quantity}x ${it.name}`).join(', ');
        console.log(`[poll] job BAR tav=${p.table_number} [${desc}]`);
        try {
          await sendBarTicket(p);
          console.log(`  ✓ stampato su ${BAR_IP}:${BAR_PORT}`);
        } catch (e) {
          console.error(`  ✗ bar: ${e.message}`);
        }
        continue;
      }
      // JP 2026-06-04: job fiscale (Custom Q3X-F). Payload completo nel
      // job stesso, agent costruisce il protocollo Custom Q3X.
      if (job.kind === 'fiscal') {
        console.log(`[poll] job FISCAL order=${job.order_id}`);
        if (!FISCAL_IP) {
          console.error('  ✗ FISCAL_PRINTER_IP non configurato — skip');
          continue;
        }
        try {
          await sendToFiscalPrinter(job.payload);
          console.log(`  ✓ scontrino fiscale inviato a ${FISCAL_IP}:${FISCAL_PORT}`);
        } catch (e) {
          console.error(`  ✗ fiscale: ${e.message}`);
        }
        continue;
      }
      // Decido endpoint da chiamare in base al kind del job.
      let url;
      if (job.kind === 'preconto') {
        url = `${CLOUD_BASE}/public/preconto-escpos/${job.order_id}`;
      } else if (job.kind === 'auto' && Array.isArray(job.item_ids) && job.item_ids.length > 0) {
        url = `${CLOUD_BASE}/public/auto-print-escpos/${job.order_id}?items=${job.item_ids.join(',')}`;
      } else {
        continue;
      }
      // JP 2026-06-07: routing destinazione. Se il backend ha settato
      // job.target='bar' (per asporti), invia alla stampante BAR .21.
      // Altrimenti default → sala .24.
      const target = job.target === 'bar' ? { ip: BAR_IP, port: BAR_PORT, label: 'BAR' } : null;
      console.log(`[poll] job ${job.kind} order=${job.order_id}${target ? ` → ${target.label}` : ''}`);
      try {
        const escpos = await httpsGet(url);
        if (escpos.status !== 200) { console.error(`  ✗ escpos status ${escpos.status}`); continue; }
        if (target) {
          await sendToCustomPrinter(escpos.body, target.ip, target.port);
        } else {
          await sendToPrinter(escpos.body);
        }
        console.log(`  ✓ stampato (${escpos.body.length} byte)`);
      } catch (e) {
        console.error(`  ✗ ${e.message}`);
      }
    }
  } catch (e) {
    // Errori di rete: silenzia se transienti (la backend potrebbe essere giu')
    if (!String(e.message).includes('timeout') && !String(e.message).includes('ENOTFOUND')) {
      console.error(`[poll] ${e.message}`);
    }
  } finally {
    _polling = false;
  }
}

console.log(`[poll] cloud=${CLOUD_BASE} tenant=${TENANT_SLUG} every ${POLL_SECONDS}s`);
console.log(`[fiscal] ${FISCAL_IP ? FISCAL_IP + ':' + FISCAL_PORT : 'NON CONFIGURATA'}`);
console.log(`[kitchen] ${KITCHEN_IP}:${KITCHEN_PORT} (ESC/POS + XML fallback)`);
console.log(`[bar] ${BAR_IP}:${BAR_PORT} (ESC/POS)`);
setInterval(pollOnce, POLL_SECONDS * 1000);
pollOnce();

// ──────────────────────────────────────────────────────────────────────
// Custom Q3X-F (RT fiscale italiana) — JP 2026-06-04
//
// Protocollo: TCP raw socket. Custom Q3X usa comandi XML wrapped in
// preambolo "<?xml" / chiusura "</PrintCommand>" tipici dei Custom RT.
// Per Q3X-F specifico, il manuale fornito da PdiEsse contiene le sequenze
// esatte. Quello che faccio QUI e' un payload XML che la Custom Q3X-F
// dovrebbe accettare per emissione documento commerciale RT.
//
// Documenti commerciali RT (post-2020) hanno questa struttura logica:
//   1. printerFiscalReceipt (apertura)
//   2. printRecItem (una per riga, con qty, price, tax_rate)
//   3. printRecSubtotal (opzionale)
//   4. printRecTotal (con metodo pagamento)
//   5. (auto-close, l'RT firma e invia all'AdE in background)
//
// Codici pagamento Custom Q3X (da confermare col tecnico):
//   1 = contanti  2 = carta  3 = altro  4 = ticket
// ──────────────────────────────────────────────────────────────────────
function escXml(s) {
  return String(s ?? '').replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

function buildCustomQ3XPayload(p) {
  // p = { items, payment_method, total, table_number, customer_name, coperto_total, ... }
  const payCode = { card: 2, digital: 2, ticket: 4, cash: 1 }[p.payment_method] || 2;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<printerFiscalReceipt>');
  lines.push('  <beginFiscalReceipt operator="1" />');
  // Items
  for (const it of (p.items || [])) {
    const desc = escXml(it.name).slice(0, 38); // limite display Custom Q3X
    const qty = Number(it.quantity || 1).toFixed(3);
    const unitPrice = Number(it.unit_price || 0).toFixed(2);
    const department = Math.round(Number(it.tax_rate || 10)); // dipartimento IVA
    lines.push(`  <printRecItem description="${desc}" quantity="${qty}" unitPrice="${unitPrice}" department="${department}" />`);
  }
  // Coperto come riga separata
  if (p.coperto_total && Number(p.coperto_total) > 0) {
    const cop = Number(p.coperto_total).toFixed(2);
    lines.push(`  <printRecItem description="COPERTO x${p.covers}" quantity="1.000" unitPrice="${cop}" department="10" />`);
  }
  // Totale + metodo
  const total = Number(p.total || 0).toFixed(2);
  lines.push(`  <printRecTotal description="TOTALE" payment="${total}" paymentType="${payCode}" />`);
  lines.push('  <endFiscalReceipt />');
  lines.push('</printerFiscalReceipt>');
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

// ──────────────────────────────────────────────────────────────────────
// Ticket cucina "pronto al pass" — JP 2026-06-05
//
// Costruisce due payload da provare in cascata:
//   1. ESC/POS standard (testo big TAVOLO X + nome piatto + linea)
//   2. Custom XML <printerNonFiscal> (se la Q3X-F rifiuta ESC/POS)
//
// Layout pensato perche' il cameriere lo prenda al pass e capisca
// in 1 secondo: TAVOLO XX gigante, sotto QTY x NOME, sotto "PRONTO".
// ──────────────────────────────────────────────────────────────────────
// JP 2026-06-05: payload aggregato { table_number, items: [{name,quantity},...] }.
// Compat legacy: se arriva singolo item_name/quantity (versioni vecchie del
// backend), lo normalizziamo a items[]. Cosi' niente rotture durante rollout.
function normalizeKitchenPayload(p) {
  if (Array.isArray(p?.items) && p.items.length > 0) return p;
  if (p?.item_name) return { table_number: p.table_number, items: [{ name: p.item_name, quantity: p.quantity || 1 }] };
  return { table_number: p?.table_number || '?', items: [] };
}

function buildKitchenTicketEscPos(payload) {
  const { table_number, items } = normalizeKitchenPayload(payload);
  const ESC = 0x1B, GS = 0x1D;
  const parts = [];
  const w = (b) => parts.push(Buffer.from(b));
  const t = (s) => parts.push(Buffer.from(String(s) + '\n', 'utf8'));
  // Init + align center
  w([ESC, 0x40]);
  w([ESC, 0x61, 1]);
  // TAVOLO X gigante (height x2 + width x2 + bold)
  w([GS, 0x21, 0x33]);
  w([ESC, 0x45, 1]);
  t(`TAV ${table_number}`);
  w([ESC, 0x45, 0]);
  w([GS, 0x21, 0x00]);
  t('================');
  // Items: align left, ogni riga "qty x nome" in altezza doppia + bold
  w([ESC, 0x61, 0]);
  w([GS, 0x21, 0x01]);
  w([ESC, 0x45, 1]);
  for (const it of items) {
    t(`${it.quantity}x ${it.name}`);
  }
  w([ESC, 0x45, 0]);
  w([GS, 0x21, 0x00]);
  t('');
  w([ESC, 0x61, 1]);
  t('--- IN COTTURA ---');
  t('');
  t('');
  // Feed + partial cut
  w([ESC, 0x64, 3]);
  w([GS, 0x56, 0x01]);
  return Buffer.concat(parts);
}

function buildKitchenTicketCustomXML(payload) {
  const { table_number, items } = normalizeKitchenPayload(payload);
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<printerNonFiscal>');
  lines.push('  <beginNonFiscalReceipt />');
  lines.push(`  <printNormal operator="1" font="2" data="TAVOLO ${escXml(String(table_number))}" />`);
  for (const it of items) {
    lines.push(`  <printNormal operator="1" font="1" data="${escXml(String(it.quantity))}x ${escXml(it.name)}" />`);
  }
  lines.push('  <printNormal operator="1" font="1" data="--- IN COTTURA ---" />');
  lines.push('  <endNonFiscalReceipt />');
  lines.push('</printerNonFiscal>');
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

function sendKitchenRaw(buf) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(KITCHEN_PORT, KITCHEN_IP);
    sock.setTimeout(5000);
    sock.on('connect', () => sock.write(buf, () => sock.end()));
    sock.on('error', reject);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout cucina')); });
    sock.on('close', () => resolve());
  });
}

async function sendKitchenTicket(payload) {
  // Tentativo 1: ESC/POS (passa su quasi qualsiasi termica + Q3X-F in
  // passthrough non-fiscale)
  try {
    await sendKitchenRaw(buildKitchenTicketEscPos(payload));
    return;
  } catch (e) {
    // continua col tentativo XML
  }
  // Tentativo 2: Custom XML printerNonFiscal
  await sendKitchenRaw(buildKitchenTicketCustomXML(payload));
}

// ──────────────────────────────────────────────────────────────────────
// BAR ticket — JP 2026-06-05.
// Stampante .21 al Riva. Stesso layout del kitchen ma con header "BAR"
// invece di "IN COTTURA". Solo ESC/POS standard (termica generica 80mm).
// ──────────────────────────────────────────────────────────────────────
function buildBarTicketEscPos(payload) {
  const { table_number, items } = normalizeKitchenPayload(payload);
  const parts = [];
  const w = arr => parts.push(Buffer.from(arr));
  const t = s => parts.push(Buffer.from(String(s) + '\n', 'latin1'));
  w([ESC, 0x40]);                          // init
  w([ESC, 0x61, 0x01]);                    // align center
  w([ESC, 0x45, 0x01]);                    // bold on
  w([GS, 0x21, 0x33]);                     // size 4x4
  t(`TAV ${table_number}`);
  w([GS, 0x21, 0x00]);                     // size normal
  w([ESC, 0x45, 0x00]);                    // bold off
  w([ESC, 0x61, 0x00]);                    // align left
  t('');
  t('-'.repeat(WIDTH));
  // Lista bevande: nome + qty in doppia altezza (height x2 + bold)
  w([GS, 0x21, 0x01]);                     // height x2
  w([ESC, 0x45, 0x01]);                    // bold on
  for (const it of items) {
    t(`${it.quantity}x ${it.name}`);
  }
  w([ESC, 0x45, 0x00]);
  w([GS, 0x21, 0x00]);
  t('');
  w([ESC, 0x61, 0x01]);                    // center
  t('--- BAR ---');
  t('');
  t('');
  w([ESC, 0x64, 0x03]);                    // feed 3
  w([GS, 0x56, 0x01]);                     // partial cut
  return Buffer.concat(parts);
}

function sendBarRaw(buf) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(BAR_PORT, BAR_IP);
    sock.setTimeout(5000);
    sock.on('connect', () => sock.write(buf, () => sock.end()));
    sock.on('error', reject);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout bar')); });
    sock.on('close', () => resolve());
  });
}

async function sendBarTicket(payload) {
  await sendBarRaw(buildBarTicketEscPos(payload));
}

function sendToFiscalPrinter(payload) {
  return new Promise((resolve, reject) => {
    const buf = buildCustomQ3XPayload(payload);
    const sock = net.createConnection(FISCAL_PORT, FISCAL_IP);
    sock.setTimeout(10000);
    let response = '';
    sock.on('connect', () => sock.write(buf));
    sock.on('data', d => { response += d.toString('utf8'); });
    sock.on('error', reject);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout RT')); });
    sock.on('close', () => {
      // L'RT Custom risponde con XML contenente success=true/false
      if (/success="?true"?/i.test(response) || response.length > 0) resolve();
      else reject(new Error('nessuna risposta dalla RT'));
    });
  });
}
