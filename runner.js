#!/usr/bin/env node
'use strict';

/**
 * ALPS Server Runner — v9.2 Stage 1 Cognition Shadow Core
 * ------------------
 * This is intentionally a wrapper around the existing ALPS browser app.
 * It does not rewrite the strategy engine. It runs the same index.html in a
 * persistent server-side Chromium profile, keeps the Browser Runner alive,
 * executes catch-up checks every minute, and exposes health/report endpoints.
 *
 * Why this design?
 * - Preserves the current aggressive ALPS research logic.
 * - Avoids Android/Chrome background freezing.
 * - Keeps the phone as a monitor only.
 */

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const { buildTradeExport, buildTradesMarkdown } = require('./alpsTradeExport');

const ROOT_DIR = path.resolve(process.env.ALPS_APP_DIR || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.ALPS_DATA_DIR || path.join(__dirname, 'data'));
const REPORT_DIR = path.resolve(process.env.ALPS_REPORT_DIR || path.join(__dirname, 'reports'));
const PROFILE_DIR = path.resolve(process.env.ALPS_PROFILE_DIR || path.join(DATA_DIR, 'chromium-profile'));
const PORT = Number(process.env.PORT || process.env.ALPS_RUNNER_PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = String(process.env.ALPS_RUNNER_TOKEN || '').trim();
const APP_URL_ENV = String(process.env.ALPS_APP_URL || '').trim();
const AUTO_START_WATCH = String(process.env.ALPS_AUTO_START_WATCH || '1') !== '0';
const AUTO_START_LAB = String(process.env.ALPS_AUTO_START_LAB || '0') === '1';
const TICK_MS = Number(process.env.ALPS_TICK_MS || 60_000);
const REPORT_EVERY_MS = Number(process.env.ALPS_REPORT_EVERY_MS || 60_000);
const HEADLESS = String(process.env.ALPS_HEADLESS || '1') !== '0';
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();

// ALPS Recovery Patch v1.2.1: paper-forward continuity, stale-forward detection, snapshot history.
const RECOVERY_PATCH_VERSION = 'v9.2-stage1-cognition-shadow-core';
const RECOVERY_STATE_FILE = path.join(DATA_DIR, 'recovery-state.json');
const RECOVERY_SEED_FILE = path.join(__dirname, 'recovery', 'previous-ledger-seed.json');
const TRADE_VAULT_FILE = path.join(DATA_DIR, 'trade-vault.json');
const TRADE_VAULT_SEED_FILE = path.join(__dirname, 'recovery', 'previous-trade-vault-seed.json');
const COGNITION_PATCH_VERSION = 'v9.2-stage1-cognition-shadow-core';
const COGNITION_STATE_FILE = path.join(DATA_DIR, 'cognition-state.json');
const COGNITION_LEDGER_FILE = path.join(DATA_DIR, 'cognition-decision-ledger.jsonl');
const EMBEDDED_PREVIOUS_TRADE_VAULT_SEED = {
  "source": "ALPS_AHI_Command_Report_2026-07-03_13-18.md",
  "note": "Previous known ALPS paper-forward trades before QuantEdge export sync. Historical continuity only; not current positions.",
  "export": {
    "schema": "quantedge.alps.tradeExport.v1",
    "generatedAt": "2026-07-03T09:18:58.866Z",
    "openTrades": [
      {
        "tradeId": "1783065637747_BTCUSDT_4h_HA_POC_R15",
        "pair": "BTCUSDT",
        "timeframe": "4h",
        "direction": "LONG",
        "strategy": "HA + POC Filter",
        "entry": 61750.47,
        "current": null,
        "stop": 60321.12,
        "target": 63894.495,
        "pnlPct": null,
        "status": "OPEN",
        "openedAt": 1783065637747,
        "mfeBps": 0,
        "maeBps": 0,
        "ariAction": "EXPLORE",
        "ariConfidence": 70,
        "regime": "MIXED / HIGH_VOL / IN_VALUE_AREA",
        "freshness": "FRESH",
        "source": "seed.from.ALPS_AHI_Command_Report_2026-07-03_13-18"
      },
      {
        "tradeId": "1783036835549_BTCUSDT_4h_HA_POC_R15",
        "pair": "BTCUSDT",
        "timeframe": "4h",
        "direction": "LONG",
        "strategy": "HA + POC Filter",
        "entry": 61560,
        "current": null,
        "stop": 60136.061,
        "target": 63695.9085,
        "pnlPct": null,
        "status": "OPEN",
        "openedAt": 1783036835549,
        "mfeBps": 0,
        "maeBps": 0,
        "ariAction": "EXPLORE",
        "ariConfidence": 70,
        "regime": "MIXED / HIGH_VOL / IN_VALUE_AREA",
        "freshness": "FRESH",
        "source": "seed.from.ALPS_AHI_Command_Report_2026-07-03_13-18"
      }
    ],
    "closedTrades": [],
    "stats": {
      "openTrades": 2,
      "closedTrades": 0,
      "sourceStats": {
        "openSources": [
          {
            "source": "seed.previous.report.forwardWatch.recentSignals",
            "count": 2
          }
        ],
        "closedSources": [
          {
            "source": "seed.previous.report.forwardWatch.recentSignals",
            "count": 0
          }
        ]
      }
    },
    "note": "Seeded from previous ALPS report; historical continuity only. Fingerprints are not treated as executable live trades."
  }
};
const FORWARD_STALE_MS = Number(process.env.ALPS_FORWARD_STALE_MS || 90 * 60 * 1000);
const MAX_SNAPSHOT_HISTORY = Number(process.env.ALPS_SNAPSHOT_HISTORY_LIMIT || 500);
const AUTO_RELOAD_STALE_FORWARD = String(process.env.ALPS_AUTO_RELOAD_STALE_FORWARD || '1') !== '0';
const STALE_RECOVERY_COOLDOWN_MS = Number(process.env.ALPS_STALE_RECOVERY_COOLDOWN_MS || 30 * 60 * 1000);
const RESET_PROFILE_ON_LAUNCH_ERROR = String(process.env.ALPS_RESET_PROFILE_ON_LAUNCH_ERROR || '1') !== '0';


let staticBaseUrl = '';
let page = null;
let context = null;
let browserServerReady = false;
let lastHealth = {
  status: 'BOOTING',
  startedAt: Date.now(),
  lastTickAt: 0,
  lastReportAt: 0,
  lastError: '',
  appUrl: '',
  appVersion: '',
  candidates: 0,
  fwRunning: false,
  labRunning: false,
  openPositions: 0,
  closedTrades: 0,
  paperSignals: 0,
  rejectedSignals: 0,
  winRate: null,
  missedForwardCycles: null,
  serverRunner: 'ON'
};
let lastReport = null;
let lastReportMarkdown = '';
let lastTradeExport = buildTradeExport({ openTrades: [], closedTrades: [] });
let tradeVaultState = null;
let cognitionState = null;
let lastCognitionView = null;
let lastNotifyCounts = { paperSignals: 0, closedTrades: 0, openPositions: 0 };
let tickBusy = false;
let recoveryState = null;
let lastStaleRecoveryAt = 0;
let lastLaunchError = null;
let launchAttempts = 0;


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function errorInfo(err) {
  if (!err) return { name: 'UnknownError', message: 'Unknown error', stack: '' };
  const message = String(err.message || err.toString?.() || 'No message provided by thrown error');
  return {
    name: String(err.name || 'Error'),
    message,
    stack: String(err.stack || '').slice(0, 4000),
    code: err.code || undefined
  };
}

async function closeBrowserContextSafe() {
  try { if (context) await context.close(); } catch (_) {}
  context = null;
  page = null;
}

async function resetChromiumProfile(reason) {
  try {
    await closeBrowserContextSafe();
    const backup = `${PROFILE_DIR}.bad.${Date.now()}`;
    await fsp.rename(PROFILE_DIR, backup).catch(() => null);
    await fsp.mkdir(PROFILE_DIR, { recursive: true });
    log(`Chromium profile reset after ${reason}. Backup=${backup}`);
    return true;
  } catch (e) {
    log('Chromium profile reset failed:', errorInfo(e));
    return false;
  }
}

function isAuthed(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || '';
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return auth === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN;
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(REPORT_DIR, { recursive: true });
  await fsp.mkdir(PROFILE_DIR, { recursive: true });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const out = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization'
  });
  res.end(out);
}

function readBody(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(ROOT_DIR, '.' + pathname);
  if (!target.startsWith(ROOT_DIR)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  try {
    const st = await fsp.stat(target);
    if (st.isDirectory()) return send(res, 403, 'Directory listing disabled', 'text/plain; charset=utf-8');
    const ext = path.extname(target).toLowerCase();
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60'
    });
    res.end(data);
  } catch (e) {
    if (pathname !== '/index.html') return serveStatic({ ...req, url: '/index.html' }, res, new URL('/index.html', staticBaseUrl));
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
}

function importPageHtml() {
  const tokenHint = TOKEN ? '<p>Token is enabled. The page will use the token from the URL: <code>?token=...</code></p>' : '<p>No runner token is configured.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ALPS Server Runner Import</title><style>body{font-family:system-ui;background:#081018;color:#eaf7ff;margin:0;padding:24px}main{max-width:720px;margin:auto}textarea{width:100%;min-height:220px;background:#101b28;color:#eaf7ff;border:1px solid #29445e;border-radius:12px;padding:12px}input,button{font:inherit}button{background:#1dd7ff;color:#061018;border:0;border-radius:999px;padding:10px 16px;font-weight:800;margin-top:10px}.card{background:#0d1724;border:1px solid #25384d;border-radius:18px;padding:18px;margin:12px 0}code{color:#8ff}</style></head><body><main><h1>ALPS Server Runner Import</h1><div class="card"><p>Use this only if you exported a Browser Backup from the phone version and want the server runner to continue from that state.</p>${tokenHint}<input id="file" type="file" accept=".json,application/json"><p>or paste backup JSON:</p><textarea id="txt"></textarea><br><button onclick="sendIt()">Import backup into server runner</button><pre id="out"></pre></div></main><script>async function sendIt(){const params=new URLSearchParams(location.search);let raw=document.getElementById('txt').value.trim();const f=document.getElementById('file').files[0];if(f)raw=await f.text();if(!raw){out.textContent='No JSON selected.';return;}const token=params.get('token')||'';const r=await fetch('/runner/import-backup'+(token?'?token='+encodeURIComponent(token):''),{method:'POST',headers:{'content-type':'application/json'},body:raw});out.textContent=await r.text();}</script></body></html>`;
}


function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function pct(value) {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

function emptyRecoveryState() {
  return {
    version: RECOVERY_PATCH_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    seed: null,
    snapshots: [],
    maxObserved: {
      results: 0,
      paperSignals: 0,
      openPositions: 0,
      closedTrades: 0,
      rejectedSignals: 0,
      wins: 0,
      losses: 0,
      officialCandidates: 0,
      candidates: 0
    },
    lastNonZeroLedger: null,
    notes: []
  };
}

async function loadRecoveryState() {
  if (recoveryState) return recoveryState;
  await ensureDirs();
  try {
    recoveryState = JSON.parse(await fsp.readFile(RECOVERY_STATE_FILE, 'utf8'));
  } catch (_) {
    recoveryState = emptyRecoveryState();
  }
  await loadRecoverySeed();
  await saveRecoveryState();
  return recoveryState;
}

async function loadRecoverySeed() {
  if (!recoveryState) recoveryState = emptyRecoveryState();
  if (recoveryState.seed) return;
  try {
    const seed = JSON.parse(await fsp.readFile(RECOVERY_SEED_FILE, 'utf8'));
    recoveryState.seed = seed;
    const snap = snapshotFromMetrics(seed.metrics || {}, 'previous-ledger-seed', {
      generatedAt: seed.generatedAt,
      source: seed.source,
      appVersion: seed.appVersion,
      note: seed.note || ''
    });
    recoveryState.snapshots.push(snap);
    applySnapshotToMax(snap);
    recoveryState.lastNonZeroLedger = snap;
    recoveryState.notes.push(`Seed imported from ${seed.source || 'previous ledger seed'} at ${new Date().toISOString()}`);
  } catch (_) {
    // Seed is optional. The runner still works without it.
  }
}

async function saveRecoveryState() {
  if (!recoveryState) return;
  recoveryState.updatedAt = new Date().toISOString();
  await fsp.writeFile(RECOVERY_STATE_FILE, JSON.stringify(recoveryState, null, 2)).catch(e => log('Recovery state save failed:', e.message));
}

function emptyTradeVaultState() {
  return {
    schema: 'alps.runner.tradeContinuityVault.v1',
    version: 'v9.2-stage1-cognition-shadow-core',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    current: null,
    lastNonZero: null,
    history: [],
    notes: []
  };
}

function tradeExportCounts(exported) {
  const open = Array.isArray(exported?.openTrades) ? exported.openTrades.length : 0;
  const closed = Array.isArray(exported?.closedTrades) ? exported.closedTrades.length : 0;
  return { open, closed, total: open + closed };
}

function sameTradeExport(a, b) {
  try {
    return JSON.stringify(a?.export || a) === JSON.stringify(b?.export || b);
  } catch (_) {
    return false;
  }
}

async function loadTradeVaultState() {
  if (tradeVaultState) return tradeVaultState;
  await ensureDirs();
  try {
    tradeVaultState = JSON.parse(await fsp.readFile(TRADE_VAULT_FILE, 'utf8'));
  } catch (_) {
    tradeVaultState = emptyTradeVaultState();
  }

  if (!tradeVaultState.lastNonZero) {
    try {
      let seed = null;
      try {
        seed = JSON.parse(await fsp.readFile(TRADE_VAULT_SEED_FILE, 'utf8'));
      } catch (_) {
        seed = EMBEDDED_PREVIOUS_TRADE_VAULT_SEED;
      }
      const exported = seed.export || seed;
      const counts = tradeExportCounts(exported);
      if (counts.total > 0) {
        const entry = {
          id: `${Date.now()}_previous-trade-vault-seed`,
          capturedAt: new Date().toISOString(),
          source: seed.source || 'embedded-previous-trade-vault-seed',
          note: seed.note || 'Imported previous known ALPS paper-forward trades as historical snapshot only.',
          counts,
          export: exported
        };
        tradeVaultState.lastNonZero = entry;
        tradeVaultState.history.push(entry);
        tradeVaultState.notes.push(`Trade vault seed imported from ${entry.source} at ${entry.capturedAt}`);
      }
    } catch (_) {}
  }

  await saveTradeVaultState();
  return tradeVaultState;
}

async function saveTradeVaultState() {
  if (!tradeVaultState) return;
  tradeVaultState.updatedAt = new Date().toISOString();
  await fsp.writeFile(TRADE_VAULT_FILE, JSON.stringify(tradeVaultState, null, 2)).catch(e => log('Trade vault save failed:', e.message));
}

async function updateTradeVault(exported, source = 'report') {
  await loadTradeVaultState();
  const counts = tradeExportCounts(exported);
  const entry = {
    id: `${Date.now()}_${source}`,
    capturedAt: new Date().toISOString(),
    source,
    note: counts.total ? 'Current ALPS trade export contains live paper-forward rows.' : 'Current ALPS trade export is empty; lastNonZero is preserved separately.',
    counts,
    export: exported || buildTradeExport({ openTrades: [], closedTrades: [] })
  };

  const last = tradeVaultState.history[tradeVaultState.history.length - 1];
  tradeVaultState.current = entry;
  if (counts.total > 0) tradeVaultState.lastNonZero = entry;

  if (!last || counts.total > 0 || !sameTradeExport(last, entry)) {
    tradeVaultState.history.push(entry);
    while (tradeVaultState.history.length > 200) tradeVaultState.history.shift();
  }
  await saveTradeVaultState();
  return tradeVaultState;
}

function buildTradeVaultView() {
  const current = lastTradeExport || buildTradeExport({ openTrades: [], closedTrades: [] });
  const counts = tradeExportCounts(current);
  const lastKnown = tradeVaultState?.lastNonZero || null;
  return {
    schema: 'alps.runner.tradeContinuityVault.view.v1',
    generatedAt: new Date().toISOString(),
    current,
    currentCounts: counts,
    currentEmpty: counts.total === 0,
    lastNonZero: lastKnown,
    historyCount: tradeVaultState?.history?.length || 0,
    note: counts.total === 0 && lastKnown
      ? 'Current live ALPS ledger is empty. Previous known trades are preserved as historical snapshot only, not counted as current open/closed trades.'
      : 'Current live ALPS trade export is available.'
  };
}

function mdCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '/');
}

function buildTradeVaultMarkdown() {
  const view = buildTradeVaultView();
  const last = view.lastNonZero;
  const lines = [
    '',
    '## ALPS Trade Continuity Vault',
    `- Current export empty: ${view.currentEmpty ? 'YES' : 'NO'}`,
    `- Current open/closed: ${view.currentCounts.open}/${view.currentCounts.closed}`,
    `- History snapshots: ${view.historyCount}`,
    `- Note: ${view.note}`
  ];

  if (!last || !last.export) {
    lines.push('- Previous known non-zero trade snapshot: N/A');
    return lines.join('\n');
  }

  const exp = last.export || {};
  lines.push(
    '',
    '### Previous Known Non-Zero Trade Snapshot',
    `- Captured At: ${last.capturedAt || ''}`,
    `- Source: ${last.source || ''}`,
    `- Open Trades: ${(exp.openTrades || []).length}`,
    `- Closed Trades: ${(exp.closedTrades || []).length}`,
    '',
    '> These rows are historical continuity evidence only. They are not treated as current open positions unless the live ALPS report exports them again.',
    '',
    '#### Previous Open Trades',
    '| Trade ID | Pair | TF | Direction | Strategy | Entry | Stop | Target | Status |',
    '|---|---|---|---|---|---:|---:|---:|---|'
  );

  const open = exp.openTrades || [];
  if (!open.length) lines.push('|  |  |  |  | No previous open trades |  |  |  |  |');
  else for (const t of open) {
    lines.push(`| ${mdCell(t.tradeId)} | ${mdCell(t.pair)} | ${mdCell(t.timeframe)} | ${mdCell(t.direction)} | ${mdCell(t.strategy)} | ${mdCell(t.entry)} | ${mdCell(t.stop)} | ${mdCell(t.target)} | ${mdCell(t.status)} |`);
  }
  return lines.join('\n');
}



// ===== ALPS v9.2 Stage 1 — Cognition Shadow Core =====
// Deterministic, auditable, no LLM, no execution changes.
// This layer reads ALPS paper-forward evidence and writes only shadow recommendations.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function emptyCognitionState() {
  return {
    schema: 'alps.cognition.state.v1',
    version: COGNITION_PATCH_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    seq: 0,
    prevHash: 'GENESIS',
    seenDecisionKeys: [],
    lastView: null
  };
}

async function loadCognitionState() {
  if (cognitionState) return cognitionState;
  await ensureDirs();
  try {
    cognitionState = JSON.parse(await fsp.readFile(COGNITION_STATE_FILE, 'utf8'));
  } catch (_) {
    cognitionState = emptyCognitionState();
  }
  if (!Array.isArray(cognitionState.seenDecisionKeys)) cognitionState.seenDecisionKeys = [];
  if (!cognitionState.prevHash) cognitionState.prevHash = 'GENESIS';
  if (!Number.isFinite(Number(cognitionState.seq))) cognitionState.seq = 0;
  return cognitionState;
}

async function saveCognitionState() {
  if (!cognitionState) return;
  cognitionState.updatedAt = new Date().toISOString();
  await fsp.writeFile(COGNITION_STATE_FILE, JSON.stringify(cognitionState, null, 2)).catch(e => log('Cognition state save failed:', e.message));
}

function cogNum(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(String(value).replace(/[,%$≈]/g, '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function cogRound(value, dp = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function cogText(value) {
  return String(value || '').trim();
}

function cogRootStrategy(strategy) {
  const s = cogText(strategy).toUpperCase();
  if (/HA\s*\+\s*POC|HA_POC/.test(s)) return 'HA_POC';
  if (/EMA\s+TREND|EMA_TREND/.test(s)) return 'EMA_TREND';
  if (/VAH\/VAL|VAH_VAL/.test(s)) return 'VAH_VAL';
  if (/BB\s+SQUEEZE|BB_SQUEEZE/.test(s)) return 'BB_SQUEEZE';
  if (/BOLLINGER/.test(s)) return 'BOLLINGER';
  return s.replace(/G\d+\s+/g, '').replace(/\s*\+\s*NO EXTRA FILTER/g, '').slice(0, 80) || 'UNKNOWN_STRATEGY';
}

function cogRegime(trade) {
  return cogText(trade?.regime || trade?.marketRegime || trade?.regimeSummary || 'UNKNOWN_REGIME').split('/').slice(0, 3).map(x => x.trim()).join(' / ') || 'UNKNOWN_REGIME';
}

function cogTradeTs(trade) {
  const raw = trade?.openedAt || trade?.closedAt || trade?.ts || trade?.generatedAt || '';
  const n = Number(raw);
  if (Number.isFinite(n) && n > 10_000_000_000) return n;
  if (Number.isFinite(n) && n > 1_000_000_000) return n * 1000;
  const p = Date.parse(String(raw));
  return Number.isFinite(p) ? p : 0;
}

function cogTfMs(tf) {
  const s = String(tf || '').toLowerCase();
  if (s === '5m') return 5 * 60 * 1000;
  if (s === '15m') return 15 * 60 * 1000;
  if (s === '30m') return 30 * 60 * 1000;
  if (s === '1h') return 60 * 60 * 1000;
  if (s === '4h') return 4 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function cogPnlBps(trade) {
  const direct = cogNum(trade?.pnlBps, null);
  if (direct !== null) return direct;
  const pctVal = cogNum(trade?.pnlPct, null);
  if (pctVal !== null) return pctVal * 100;
  return null;
}

function cogTradeFamilyKey(trade) {
  return [
    cogText(trade?.pair).toUpperCase(),
    cogText(trade?.timeframe),
    cogRootStrategy(trade?.strategy),
    cogText(trade?.direction).toUpperCase(),
    cogRegime(trade)
  ].join('||');
}

function cogTradeSubject(trade) {
  return [cogText(trade?.pair).toUpperCase(), cogText(trade?.timeframe), cogRootStrategy(trade?.strategy), cogRegime(trade)].join(' | ');
}

function cogNearDuplicate(a, b) {
  if (!a || !b) return false;
  if (cogTradeFamilyKey(a) !== cogTradeFamilyKey(b)) return false;
  const ea = cogNum(a.entry, null), eb = cogNum(b.entry, null);
  if (ea === null || eb === null) return false;
  const relDiff = Math.abs(ea - eb) / Math.max(1e-9, (Math.abs(ea) + Math.abs(eb)) / 2);
  const priceOk = relDiff <= 0.006; // 0.6% keeps same-candle close variants together while avoiding broad merging.
  const ta = cogTradeTs(a), tb = cogTradeTs(b);
  const tfWindow = cogTfMs(a.timeframe || b.timeframe) * 1.25;
  const timeOk = !ta || !tb || Math.abs(ta - tb) <= tfWindow;
  return priceOk && timeOk;
}

function cogClusterTrades(trades = []) {
  const clusters = [];
  for (const t of trades || []) {
    if (!t || typeof t !== 'object') continue;
    let placed = false;
    for (const c of clusters) {
      if (cogNearDuplicate(t, c.rep)) {
        c.members.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ rep: t, members: [t] });
  }
  return clusters.map((c, idx) => {
    const pnls = c.members.map(cogPnlBps).filter(x => Number.isFinite(x));
    const pnlAvg = pnls.length ? pnls.reduce((a,b)=>a+b,0) / pnls.length : null;
    const wins = c.members.filter(t => String(t.result || '').toUpperCase() === 'WIN' || cogPnlBps(t) > 0).length;
    const losses = c.members.filter(t => String(t.result || '').toUpperCase() === 'LOSS' || cogPnlBps(t) < 0).length;
    const stopCount = c.members.filter(t => /STOP/i.test(String(t.exitReason || ''))).length;
    return {
      clusterId: `${cogTradeFamilyKey(c.rep)}::C${idx + 1}`,
      subject: cogTradeSubject(c.rep),
      familyKey: cogTradeFamilyKey(c.rep),
      size: c.members.length,
      effectiveWeight: 1,
      pair: cogText(c.rep.pair).toUpperCase(),
      timeframe: cogText(c.rep.timeframe),
      root: cogRootStrategy(c.rep.strategy),
      direction: cogText(c.rep.direction).toUpperCase(),
      regime: cogRegime(c.rep),
      entryAvg: cogRound(c.members.map(t => cogNum(t.entry, 0)).reduce((a,b)=>a+b,0) / Math.max(1, c.members.length), 6),
      pnlBpsAvg: cogRound(pnlAvg, 2),
      wins,
      losses,
      stopCount,
      tradeIds: c.members.map(t => t.tradeId || t.id).filter(Boolean).slice(0, 12)
    };
  });
}

function cogGroupByFamily(trades = []) {
  const map = new Map();
  for (const t of trades || []) {
    const key = cogTradeFamilyKey(t);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return Array.from(map.entries()).map(([key, rows]) => ({ key, rows }));
}

function cogBetaBeliefFromClusters(clusters = []) {
  let w = 0, l = 0;
  for (const c of clusters) {
    if (c.wins > c.losses) w += 1;
    else if (c.losses > c.wins) l += 1;
  }
  const alpha = 1 + w;
  const beta = 1 + l;
  return { alpha, beta, winsEff: w, lossesEff: l, nEff: w + l, mean: cogRound(alpha / (alpha + beta), 4) };
}

function cognitionAnalyse(exported = {}, report = {}) {
  const openTrades = Array.isArray(exported?.openTrades) ? exported.openTrades : [];
  const closedTrades = Array.isArray(exported?.closedTrades) ? exported.closedTrades : [];
  const allTrades = [...openTrades, ...closedTrades];
  const openClusters = cogClusterTrades(openTrades);
  const closedClusters = cogClusterTrades(closedTrades);
  const allClusters = cogClusterTrades(allTrades);

  const families = [];
  const familyKeys = new Set([...cogGroupByFamily(allTrades).map(g => g.key)]);
  for (const key of familyKeys) {
    const openRows = openTrades.filter(t => cogTradeFamilyKey(t) === key);
    const closedRows = closedTrades.filter(t => cogTradeFamilyKey(t) === key);
    const oc = cogClusterTrades(openRows);
    const cc = cogClusterTrades(closedRows);
    const belief = cogBetaBeliefFromClusters(cc);
    const rawWins = closedRows.filter(t => String(t.result || '').toUpperCase() === 'WIN' || cogPnlBps(t) > 0).length;
    const rawLosses = closedRows.filter(t => String(t.result || '').toUpperCase() === 'LOSS' || cogPnlBps(t) < 0).length;
    const stopLosses = closedRows.filter(t => /STOP/i.test(String(t.exitReason || ''))).length;
    const maeVals = closedRows.map(t => cogNum(t.maeBps, null)).filter(x => Number.isFinite(x));
    const mfeVals = closedRows.map(t => cogNum(t.mfeBps, null)).filter(x => Number.isFinite(x));
    const pnlVals = closedRows.map(cogPnlBps).filter(x => Number.isFinite(x));
    const rep = allTrades.find(t => cogTradeFamilyKey(t) === key) || {};
    families.push({
      key,
      subject: cogTradeSubject(rep),
      pair: cogText(rep.pair).toUpperCase(),
      timeframe: cogText(rep.timeframe),
      root: cogRootStrategy(rep.strategy),
      direction: cogText(rep.direction).toUpperCase(),
      regime: cogRegime(rep),
      rawOpen: openRows.length,
      rawClosed: closedRows.length,
      rawWins,
      rawLosses,
      stopLosses,
      nEffOpen: oc.length,
      nEffClosed: cc.length,
      duplicateCompressionOpen: openRows.length - oc.length,
      duplicateCompressionClosed: closedRows.length - cc.length,
      avgPnlBps: cogRound(pnlVals.length ? pnlVals.reduce((a,b)=>a+b,0) / pnlVals.length : null, 2),
      avgMaeBps: cogRound(maeVals.length ? maeVals.reduce((a,b)=>a+b,0) / maeVals.length : null, 2),
      avgMfeBps: cogRound(mfeVals.length ? mfeVals.reduce((a,b)=>a+b,0) / mfeVals.length : null, 2),
      betaBelief: belief,
      lifecycleShadow: belief.nEff < 5 ? 'WAIT_N_EFF' : (belief.lossesEff > belief.winsEff ? 'SHADOW_REVIEW' : 'MONITOR'),
      closedClusters: cc,
      openClusters: oc
    });
  }

  families.sort((a,b) => (b.rawClosed + b.rawOpen) - (a.rawClosed + a.rawOpen));

  const decisions = [];
  function pushDecision(action, trigger, subject, evidence, reason, severity = 'INFO') {
    const key = `${action}::${trigger}::${subject}::${stableStringify(evidence).slice(0, 500)}`;
    decisions.push({ key, action, trigger, subject, severity, evidence, reason, reversible: true });
  }

  if (allTrades.length > allClusters.length) {
    pushDecision(
      'DEDUP_SAMPLE_WEIGHT',
      'DUPLICATE_CLUSTER_DETECTED',
      'GLOBAL_FORWARD_LEDGER',
      { rawTrades: allTrades.length, effectiveClusters: allClusters.length, compression: allTrades.length - allClusters.length },
      `Detected correlated trade clusters. Raw count ${allTrades.length} is treated as ${allClusters.length} effective samples for judgement only; no trade execution is changed.`,
      'HIGH'
    );
  }

  for (const f of families) {
    if (f.rawClosed > 0 && f.rawClosed > f.nEffClosed) {
      pushDecision(
        'COUNT_CLOSED_AS_EFFECTIVE_SAMPLE',
        'CORRELATED_CLOSED_TRADES',
        f.subject,
        { rawClosed: f.rawClosed, nEffClosed: f.nEffClosed, compression: f.duplicateCompressionClosed, rawLosses: f.rawLosses, rawWins: f.rawWins },
        `${f.subject}: ${f.rawClosed} closed trades compress to ${f.nEffClosed} effective samples. Strategy judgement must use nEff, not raw count.`,
        'HIGH'
      );
    }
    if (f.rawClosed > 0 && f.nEffClosed < 5) {
      pushDecision(
        'WAIT_FOR_EFFECTIVE_SAMPLE',
        'MIN_SAMPLE_NOT_MET',
        f.subject,
        { rawClosed: f.rawClosed, nEffClosed: f.nEffClosed, required: 5, betaMean: f.betaBelief.mean },
        `${f.subject}: forward evidence remains low-sample after deduplication. Keep learning in Shadow/WAITING_RESULTS until nEff >= 5.`,
        'MEDIUM'
      );
    }
    if (f.rawClosed > 0 && f.rawLosses === f.rawClosed && f.stopLosses / Math.max(1, f.rawClosed) >= 0.8) {
      pushDecision(
        'SHADOW_ENTRY_STOP_REVIEW',
        'STOP_CLUSTER_BEFORE_THESIS',
        f.subject,
        { rawClosed: f.rawClosed, nEffClosed: f.nEffClosed, stopLosses: f.stopLosses, avgMfeBps: f.avgMfeBps, avgMaeBps: f.avgMaeBps, avgPnlBps: f.avgPnlBps },
        `${f.subject}: losses are stop-driven. Stage 1 only recommends Entry Timing / Stop ATR review in Shadow; no live stop widening is applied.`,
        'HIGH'
      );
    }
    if (f.rawOpen > f.nEffOpen && f.rawOpen >= 2) {
      pushDecision(
        'OPEN_EXPOSURE_DEDUP_VIEW',
        'CORRELATED_OPEN_TRADES',
        f.subject,
        { rawOpen: f.rawOpen, nEffOpen: f.nEffOpen, compression: f.duplicateCompressionOpen },
        `${f.subject}: ${f.rawOpen} open trades are approximately ${f.nEffOpen} independent open hypotheses. Keep current ARI exposure limits; report nEff separately.`,
        'MEDIUM'
      );
    }
  }

  const summary = {
    rawOpen: openTrades.length,
    rawClosed: closedTrades.length,
    rawTotal: allTrades.length,
    nEffOpen: openClusters.length,
    nEffClosed: closedClusters.length,
    nEffTotal: allClusters.length,
    duplicateCompression: allTrades.length - allClusters.length,
    families: families.length,
    shadowDecisions: decisions.length,
    noExecutionChanges: true,
    mode: 'SHADOW_ONLY'
  };

  return {
    schema: 'alps.cognition.view.v1',
    version: COGNITION_PATCH_VERSION,
    generatedAt: new Date().toISOString(),
    summary,
    families,
    clusters: { open: openClusters, closed: closedClusters, all: allClusters },
    shadowDecisions: decisions,
    note: 'Stage 1 reads evidence, deduplicates correlated samples, logs decisions, and emits shadow recommendations only. It never opens/closes/modifies trades.'
  };
}

async function appendCognitionDecision(decision) {
  await loadCognitionState();
  if (cognitionState.seenDecisionKeys.includes(decision.key)) return null;
  cognitionState.seq += 1;
  const payload = {
    seq: cognitionState.seq,
    decisionId: sha256(`${decision.key}::${cognitionState.seq}`).slice(0, 24),
    ts: new Date().toISOString(),
    version: COGNITION_PATCH_VERSION,
    ...decision,
    prevHash: cognitionState.prevHash
  };
  const currHash = sha256(stableStringify(payload) + cognitionState.prevHash);
  const record = { ...payload, currHash };
  await fsp.appendFile(COGNITION_LEDGER_FILE, JSON.stringify(record) + '\n').catch(e => log('Cognition ledger append failed:', e.message));
  cognitionState.prevHash = currHash;
  cognitionState.seenDecisionKeys.push(decision.key);
  while (cognitionState.seenDecisionKeys.length > 1000) cognitionState.seenDecisionKeys.shift();
  return record;
}

async function updateCognitionState(report, exported) {
  await loadCognitionState();
  const view = cognitionAnalyse(exported || {}, report || {});
  const appended = [];
  for (const d of view.shadowDecisions) {
    const rec = await appendCognitionDecision(d);
    if (rec) appended.push(rec);
  }
  view.ledger = {
    seq: cognitionState.seq,
    prevHash: cognitionState.prevHash,
    appendedThisRun: appended.length,
    path: COGNITION_LEDGER_FILE,
    tamperEvident: true
  };
  cognitionState.lastView = view;
  lastCognitionView = view;
  await saveCognitionState();
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-cognition.json'), JSON.stringify(view, null, 2)).catch(() => null);
  return view;
}

function buildCognitionMarkdown(view = lastCognitionView) {
  if (!view) return '## ALPS v9.2 Cognition Shadow Core\n- No cognition view yet.';
  const s = view.summary || {};
  const lines = [
    '',
    '## ALPS v9.2 Cognition Shadow Core',
    `- Version: ${view.version}`,
    `- Mode: ${s.mode || 'SHADOW_ONLY'}`,
    `- No execution changes: ${s.noExecutionChanges ? 'YES' : 'NO'}`,
    `- Raw open/closed: ${s.rawOpen}/${s.rawClosed}`,
    `- Effective open/closed: ${s.nEffOpen}/${s.nEffClosed}`,
    `- Duplicate compression: ${s.duplicateCompression}`,
    `- Families tracked: ${s.families}`,
    `- Shadow decisions: ${s.shadowDecisions}`,
    `- Decision ledger seq: ${view.ledger?.seq ?? 0}`,
    `- Hash chain head: ${view.ledger?.prevHash || 'GENESIS'}`,
    '',
    '### Family Effective Sample Summary',
    '| Subject | Raw Open | Eff Open | Raw Closed | Eff Closed | W/L | Avg PnL bps | Avg MFE/MAE | Shadow Lifecycle |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|'
  ];
  for (const f of (view.families || []).slice(0, 16)) {
    lines.push(`| ${mdCell(f.subject)} | ${f.rawOpen} | ${f.nEffOpen} | ${f.rawClosed} | ${f.nEffClosed} | ${f.rawWins}/${f.rawLosses} | ${mdCell(f.avgPnlBps ?? '')} | ${mdCell((f.avgMfeBps ?? '—') + '/' + (f.avgMaeBps ?? '—'))} | ${mdCell(f.lifecycleShadow)} |`);
  }
  lines.push('', '### Shadow Recommendations / Decision Reasons', '| Action | Severity | Subject | Reason |', '|---|---|---|---|');
  for (const d of (view.shadowDecisions || []).slice(0, 20)) {
    lines.push(`| ${mdCell(d.action)} | ${mdCell(d.severity)} | ${mdCell(d.subject)} | ${mdCell(d.reason)} |`);
  }
  lines.push('', '> Cognition note: Stage 1 only changes interpretation and logging. It does not widen stops, ban patterns, open trades, close trades, or alter AHI/ARI execution.');
  return lines.join('\n');
}



function snapshotFromMetrics(metrics = {}, source = 'unknown', extra = {}) {
  const closedTrades = n(metrics.closedTrades ?? metrics.closed ?? metrics.closedTradeLedger, 0);
  const wins = n(metrics.wins, 0);
  const losses = n(metrics.losses, 0);
  const winRate = pct(metrics.winRate) ?? (closedTrades ? wins / closedTrades * 100 : null);
  return {
    id: `${Date.now()}_${source}`,
    capturedAt: new Date().toISOString(),
    source,
    generatedAt: extra.generatedAt || null,
    appVersion: extra.appVersion || metrics.appVersion || '',
    note: extra.note || '',
    status: metrics.status || '',
    forwardStatus: metrics.forwardStatus || '',
    results: n(metrics.results, 0),
    candidates: n(metrics.candidates, 0),
    officialCandidates: n(metrics.officialCandidates, 0),
    paperSignals: n(metrics.paperSignals, 0),
    openPositions: n(metrics.openPositions, 0),
    closedTrades,
    rejectedSignals: n(metrics.rejectedSignals, 0),
    wins,
    losses,
    winRate,
    lastForwardRefresh: n(metrics.lastForwardRefresh, 0),
    latestClosedCandleTs: n(metrics.latestClosedCandleTs, 0)
  };
}

function snapshotFromReport(report, source = 'report') {
  const fw = report?.forwardWatch || {};
  const research = report?.research || {};
  const runtime = report?.runtime || {};
  const meta = report?.meta || {};
  return snapshotFromMetrics({
    status: runtime.fwRunning ? 'RUNNING' : (runtime.labRunning ? 'LAB_RUNNING' : ''),
    appVersion: meta.version || '',
    results: research.strategies || fw.totalGeneratedStrategies || 0,
    candidates: fw.candidatesMonitored || 0,
    officialCandidates: fw.candidatesMonitored || 0,
    paperSignals: fw.paperSignals || fw.freshness?.freshOpened || 0,
    openPositions: fw.openPositions || 0,
    closedTrades: fw.closedTrades || fw.closed || 0,
    rejectedSignals: fw.rejectedSignals || 0,
    wins: fw.wins || 0,
    losses: fw.losses || 0,
    winRate: fw.winRate,
    lastForwardRefresh: runtime.lastForwardRefresh ? Date.parse(runtime.lastForwardRefresh) : 0,
    latestClosedCandleTs: fw.freshness?.latestClosedCandleTs || 0
  }, source, { generatedAt: meta.generatedAt || null, appVersion: meta.version || '' });
}

function applySnapshotToMax(snap) {
  if (!recoveryState) return;
  const keys = ['results', 'paperSignals', 'openPositions', 'closedTrades', 'rejectedSignals', 'wins', 'losses', 'officialCandidates', 'candidates'];
  for (const k of keys) recoveryState.maxObserved[k] = Math.max(n(recoveryState.maxObserved[k], 0), n(snap[k], 0));
  if (snap.closedTrades > 0 || snap.paperSignals > 0) recoveryState.lastNonZeroLedger = snap;
}

function sameLedgerMetrics(a, b) {
  if (!a || !b) return false;
  return ['results','paperSignals','openPositions','closedTrades','wins','losses','rejectedSignals'].every(k => n(a[k], -1) === n(b[k], -2));
}

async function recordSnapshot(snap) {
  await loadRecoveryState();
  if (!snap) return;
  const last = recoveryState.snapshots[recoveryState.snapshots.length - 1];
  const changed = !sameLedgerMetrics(last, snap) || (Date.now() - Date.parse(last?.capturedAt || 0) > REPORT_EVERY_MS * 5);
  if (changed) recoveryState.snapshots.push(snap);
  while (recoveryState.snapshots.length > MAX_SNAPSHOT_HISTORY) recoveryState.snapshots.shift();
  applySnapshotToMax(snap);
  await saveRecoveryState();
}

function computeForwardAge(lastForwardRefresh) {
  const last = n(lastForwardRefresh, 0);
  if (!last) return null;
  const age = Date.now() - last;
  return age >= 0 ? age : null;
}

function computeForwardStatus(h = {}) {
  const lastForwardAgeMs = computeForwardAge(h.lastForwardRefresh);
  const stale = !!h.fwRunning && lastForwardAgeMs != null && lastForwardAgeMs > FORWARD_STALE_MS;
  const noLedger = n(h.paperSignals, 0) === 0 && n(h.openPositions, 0) === 0 && n(h.closedTrades, 0) === 0;
  let status = 'IDLE';
  if (stale) status = 'STALE_FORWARD';
  else if (h.fwRunning && noLedger) status = 'WAITING_FOR_FRESH_CANDLE';
  else if (h.fwRunning) status = 'LIVE_FORWARD';
  else if (h.labRunning) status = 'LAB_RUNNING';
  return {
    forwardStatus: status,
    forwardStale: stale,
    lastForwardAgeMs,
    lastForwardAgeMin: lastForwardAgeMs == null ? null : Math.round(lastForwardAgeMs / 60000),
    staleThresholdMs: FORWARD_STALE_MS,
    staleThresholdMin: Math.round(FORWARD_STALE_MS / 60000)
  };
}

function enhanceHealth(h = {}) {
  const forward = computeForwardStatus(h);
  const out = { ...h, ...forward, recoveryPatch: RECOVERY_PATCH_VERSION };
  if (forward.forwardStale) out.status = 'STALE_FORWARD';
  return out;
}

function buildRecoveryView() {
  const state = recoveryState || emptyRecoveryState();
  const current = snapshotFromMetrics(lastHealth || {}, 'current-health');
  const previous = state.lastNonZeroLedger || state.seed || null;
  const maxObserved = state.maxObserved || {};
  const deltaFromPrevious = previous && previous.metrics ? null : previous ? {
    paperSignals: current.paperSignals - n(previous.paperSignals, 0),
    openPositions: current.openPositions - n(previous.openPositions, 0),
    closedTrades: current.closedTrades - n(previous.closedTrades, 0),
    wins: current.wins - n(previous.wins, 0),
    losses: current.losses - n(previous.losses, 0),
    results: current.results - n(previous.results, 0)
  } : null;
  return {
    patchVersion: RECOVERY_PATCH_VERSION,
    current,
    previousNonZeroLedger: previous,
    maxObserved,
    deltaFromPrevious,
    historyCount: state.snapshots?.length || 0,
    seedLoaded: !!state.seed,
    forward: computeForwardStatus(lastHealth || {}),
    notes: state.notes || []
  };
}

function appendRecoveryMarkdown(md) {
  const rv = buildRecoveryView();
  const f = rv.forward;
  const prev = rv.previousNonZeroLedger || {};
  const max = rv.maxObserved || {};
  const line = (k, v) => `- ${k}: ${v == null || v === '' ? '—' : v}`;
  const delta = rv.deltaFromPrevious || {};
  return `${md}\n\n## Server Runner Recovery / Ledger Continuity\n` +
    line('Recovery Patch', rv.patchVersion) + '\n' +
    line('Forward Status', f.forwardStatus) + '\n' +
    line('Forward stale', f.forwardStale ? `YES — last refresh age ${f.lastForwardAgeMin} min, threshold ${f.staleThresholdMin} min` : 'NO') + '\n' +
    line('History snapshots', rv.historyCount) + '\n' +
    line('Seed loaded', rv.seedLoaded ? 'YES' : 'NO') + '\n\n' +
    `### Current Paper Ledger\n` +
    line('Results', rv.current.results) + '\n' +
    line('Paper signals', rv.current.paperSignals) + '\n' +
    line('Open positions', rv.current.openPositions) + '\n' +
    line('Closed trades', rv.current.closedTrades) + '\n' +
    line('Wins/Losses', `${rv.current.wins}/${rv.current.losses}`) + '\n\n' +
    `### Previous Non-Zero / Historical Ledger\n` +
    line('Source', prev.source || prev.note || '—') + '\n' +
    line('Generated at', prev.generatedAt || prev.capturedAt || '—') + '\n' +
    line('Paper signals', prev.paperSignals) + '\n' +
    line('Open positions', prev.openPositions) + '\n' +
    line('Closed trades', prev.closedTrades) + '\n' +
    line('Wins/Losses', `${prev.wins ?? '—'}/${prev.losses ?? '—'}`) + '\n\n' +
    `### Max Observed Counters\n` +
    line('Max results', max.results) + '\n' +
    line('Max paper signals', max.paperSignals) + '\n' +
    line('Max closed trades', max.closedTrades) + '\n' +
    line('Max wins/losses', `${max.wins}/${max.losses}`) + '\n\n' +
    `### Delta Current vs Previous Non-Zero\n` +
    line('Paper signals delta', delta.paperSignals) + '\n' +
    line('Closed trades delta', delta.closedTrades) + '\n' +
    line('Wins/Losses delta', `${delta.wins ?? '—'}/${delta.losses ?? '—'}`) + '\n\n' +
    `> Recovery note: this section does not invent trades. It separates the current empty paper-forward ledger from the last known non-zero ledger so reports no longer look as if historical results disappeared.\n`;
}

async function maybeRecoverStaleForward() {
  if (!AUTO_RELOAD_STALE_FORWARD || !lastHealth.forwardStale) return;
  if (Date.now() - lastStaleRecoveryAt < STALE_RECOVERY_COOLDOWN_MS) return;
  lastStaleRecoveryAt = Date.now();
  log(`Forward stale detected. Attempting safe page reload/catch-up. age=${lastHealth.lastForwardAgeMin}m threshold=${lastHealth.staleThresholdMin}m`);
  try {
    if (page && !page.isClosed()) {
      await collectReport().catch(() => null);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(e => log('Page reload during stale recovery failed:', e.message));
      await page.waitForLoadState('load', { timeout: 120_000 }).catch(() => null);
    } else {
      await launchAppPage();
    }
    await ensureRuntimeStarted();
    await pageEval(async () => {
      if (typeof catchUpForwardWatch === 'function') await catchUpForwardWatch('stale-forward recovery catch-up');
      if (typeof saveRuntimeSnapshotThrottled === 'function') await saveRuntimeSnapshotThrottled(false);
      if (typeof renderAll === 'function') renderAll();
      return true;
    }).catch(e => log('Stale forward catch-up failed:', e.message));
    const h = enhanceHealth(await getPageHealth());
    Object.assign(lastHealth, h, { lastTickAt: Date.now(), lastError: '' });
    await recordSnapshot(snapshotFromMetrics(lastHealth, 'stale-forward-recovery'));
  } catch (e) {
    lastHealth.lastError = `Stale forward recovery failed: ${e.message}`;
    log(lastHealth.lastError);
  }
}

async function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/runner/health') { await loadRecoveryState(); await loadTradeVaultState(); await loadCognitionState(); return send(res, 200, { ...lastHealth, browserServerReady, recovery: buildRecoveryView(), tradeVault: { currentCounts: tradeExportCounts(lastTradeExport), hasLastNonZero: !!tradeVaultState?.lastNonZero, historyCount: tradeVaultState?.history?.length || 0 }, cognition: { version: COGNITION_PATCH_VERSION, summary: lastCognitionView?.summary || cognitionState?.lastView?.summary || null, ledgerSeq: cognitionState?.seq || 0, hashHead: cognitionState?.prevHash || 'GENESIS' } }); }
      if (url.pathname === '/runner/recovery') { await loadRecoveryState(); return send(res, 200, buildRecoveryView()); }
      if (url.pathname === '/runner/history') { await loadRecoveryState(); return send(res, 200, recoveryState); }
      if (url.pathname === '/runner/export-recovery-state') { await loadRecoveryState(); return send(res, 200, recoveryState); }
      if (url.pathname === '/runner/import-recovery-state' && req.method === 'POST') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        const raw = await readBody(req);
        const incoming = JSON.parse(raw);
        if (!incoming || typeof incoming !== 'object') return send(res, 400, { error: 'Invalid recovery state' });
        recoveryState = incoming;
        await saveRecoveryState();
        return send(res, 200, { ok: true, recovery: buildRecoveryView() });
      }
      if (url.pathname === '/runner/report') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        const r = await collectReport().catch(e => ({ error: e.message, health: lastHealth }));
        return send(res, r.error ? 500 : 200, r);
      }
      if (url.pathname === '/runner/report.md') {
        if (!isAuthed(req)) return send(res, 401, 'Unauthorized', 'text/plain; charset=utf-8');
        await collectReport().catch(() => null);
        return send(res, 200, lastReportMarkdown || '# ALPS Server Runner\nNo report yet.', 'text/markdown; charset=utf-8');
      }
      if (url.pathname === '/runner/trades.json') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        await collectReport().catch(() => null);
        return send(res, 200, lastTradeExport || buildTradeExport({ openTrades: [], closedTrades: [] }));
      }
      if (url.pathname === '/runner/trades-vault.json') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        await loadTradeVaultState();
        await collectReport().catch(() => null);
        return send(res, 200, buildTradeVaultView());
      }
      if (url.pathname === '/runner/cognition.json') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        await loadCognitionState();
        await collectReport().catch(() => null);
        return send(res, 200, lastCognitionView || cognitionState.lastView || { error: 'No cognition view yet' });
      }
      if (url.pathname === '/runner/cognition.md') {
        if (!isAuthed(req)) return send(res, 401, 'Unauthorized', 'text/plain; charset=utf-8');
        await loadCognitionState();
        await collectReport().catch(() => null);
        return send(res, 200, buildCognitionMarkdown(lastCognitionView || cognitionState.lastView), 'text/markdown; charset=utf-8');
      }
      if (url.pathname === '/runner/cognition-ledger.json') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        await loadCognitionState();
        const raw = await fsp.readFile(COGNITION_LEDGER_FILE, 'utf8').catch(() => '');
        const rows = raw.split('\n').filter(Boolean).slice(-200).map(line => { try { return JSON.parse(line); } catch (_) { return { raw: line }; } });
        return send(res, 200, { schema: 'alps.cognition.ledger.tail.v1', version: COGNITION_PATCH_VERSION, seq: cognitionState.seq, hashHead: cognitionState.prevHash, rows });
      }
      if (url.pathname === '/runner/trades.md') {
        if (!isAuthed(req)) return send(res, 401, 'Unauthorized', 'text/plain; charset=utf-8');
        await loadTradeVaultState();
        await collectReport().catch(() => null);
        return send(res, 200, `${buildTradesMarkdown(lastTradeExport || buildTradeExport({ openTrades: [], closedTrades: [] }))}\n\n${buildTradeVaultMarkdown()}`, 'text/markdown; charset=utf-8');
      }
      if (url.pathname === '/runner/import') return send(res, 200, importPageHtml(), 'text/html; charset=utf-8');
      if (url.pathname === '/runner/import-backup' && req.method === 'POST') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        const raw = await readBody(req);
        const backup = JSON.parse(raw);
        const result = await importBackupIntoPage(backup);
        return send(res, result.ok ? 200 : 500, result);
      }
      if (url.pathname === '/runner/command' && req.method === 'POST') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        const raw = await readBody(req, 1024 * 1024);
        const body = raw ? JSON.parse(raw) : {};
        const result = await runCommand(body.command || body.action || 'tick', body.args || {});
        return send(res, result.ok ? 200 : 500, result);
      }
      if (url.pathname.startsWith('/runner/')) return send(res, 404, { error: 'Unknown runner endpoint' });
      return serveStatic(req, res, url);
    } catch (e) {
      lastHealth.lastError = e.message;
      send(res, 500, { error: e.message });
    }
  });
  await new Promise(resolve => server.listen(PORT, HOST, resolve));
  staticBaseUrl = `http://127.0.0.1:${PORT}`;
  browserServerReady = true;
  log(`ALPS static/API server listening on ${HOST}:${PORT}`);
  return server;
}

async function launchAppPage(options = {}) {
  const appUrl = APP_URL_ENV || `${staticBaseUrl}/index.html`;
  lastHealth.appUrl = appUrl;
  const allowProfileReset = options.allowProfileReset !== false;
  const launchArgs = {
    headless: HEADLESS,
    viewport: { width: 430, height: 920 },
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,BackForwardCache,IntensiveWakeUpThrottling',
      '--autoplay-policy=no-user-gesture-required'
    ]
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    launchAttempts += 1;
    try {
      await closeBrowserContextSafe();
      log(`Launching ALPS Chromium context. attempt=${attempt} profile=${PROFILE_DIR}`);
      context = await chromium.launchPersistentContext(PROFILE_DIR, launchArgs);
      page = context.pages()[0] || await context.newPage();
      page.on('console', msg => {
        const text = msg.text();
        if (/ALPS|PAPER SIGNAL|Runner|error|failed|Wake|catch-up/i.test(text)) log('[page]', text.slice(0, 500));
      });
      page.on('pageerror', err => {
        const info = errorInfo(err);
        lastHealth.lastError = info.message;
        log('[pageerror]', info.message);
      });
      await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForLoadState('load', { timeout: 120_000 }).catch(() => null);
      await page.waitForFunction(() => typeof buildRunReportObject === 'function' || typeof startWatch === 'function', null, { timeout: 120_000 }).catch(() => null);
      lastLaunchError = null;
      delete lastHealth.pageLaunchError;
      Object.assign(lastHealth, { status: 'PAGE_LOADED', lastError: '', pageReady: true, launchAttempts });
      log(`ALPS app loaded: ${appUrl}`);
      return true;
    } catch (e) {
      const info = errorInfo(e);
      lastLaunchError = info;
      Object.assign(lastHealth, {
        status: 'PAGE_LAUNCH_FAILED',
        pageReady: false,
        launchAttempts,
        lastError: `PAGE_LAUNCH_FAILED: ${info.name}: ${info.message}`,
        pageLaunchError: info
      });
      log('ALPS page launch failed:', JSON.stringify(info, null, 2));
      await closeBrowserContextSafe();
      if (attempt === 1 && allowProfileReset && RESET_PROFILE_ON_LAUNCH_ERROR) {
        await resetChromiumProfile('page launch failure');
        continue;
      }
      await recordSnapshot(snapshotFromMetrics(lastHealth, 'page-launch-failed')).catch(() => null);
      return false;
    }
  }
  return false;
}

async function pageEval(fn, arg) {
  if (!page) throw new Error('ALPS page is not ready');
  return page.evaluate(fn, arg);
}

async function getPageHealth() {
  return pageEval(() => {
    function val(expr, fallback) { try { return expr(); } catch (_) { return fallback; } }
    const closed = val(() => closedTrades || [], []);
    const wins = closed.filter(x => Number(x.pnl || 0) > 0).length;
    const losses = closed.filter(x => Number(x.pnl || 0) <= 0).length;
    return {
      appVersion: val(() => APP_VERSION, ''),
      fwRunning: val(() => !!fwRunning, false),
      labRunning: val(() => !!labRunning, false),
      rtPrepared: val(() => !!rtPrepared, false),
      candidates: val(() => typeof activeForwardCandidatePool === 'function' ? activeForwardCandidatePool().length : 0, 0),
      officialCandidates: val(() => typeof forwardCandidatePool === 'function' ? forwardCandidatePool().length : 0, 0),
      results: val(() => (results || []).length, 0),
      paperSignals: val(() => (paperSignals || []).length, 0),
      openPositions: val(() => (openPositions || []).length, 0),
      closedTrades: closed.length,
      rejectedSignals: val(() => (rejectedSignals || []).length, 0),
      wins,
      losses,
      winRate: closed.length ? wins / closed.length * 100 : null,
      missedForwardCycles: val(() => fwMissedCycles, null),
      lastForwardRefresh: val(() => lastForwardRefreshTs, 0),
      fwRefreshRunning: val(() => !!fwRefreshRunning, false),
      emergencyStopActive: val(() => !!emergencyStopActive, false),
      preflight: val(() => preflightStatus, ''),
      engineReady: val(() => !!engineReady, false)
    };
  });
}


async function collectPageTradeLedgers() {
  if (!page || page.isClosed()) return { openTrades: [], closedTrades: [], sourceStats: { reason: 'page-not-ready' } };
  return pageEval(async () => {
    function clone(value) {
      try { return JSON.parse(JSON.stringify(value || [])); } catch (_) { return []; }
    }
    function arrFromGlobal(name) {
      try {
        const value = globalThis[name];
        return Array.isArray(value) ? clone(value) : [];
      } catch (_) {
        return [];
      }
    }
    function collectNamedArrays(obj, out, seen, path) {
      if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
      seen.add(obj);
      if (Array.isArray(obj)) return;
      for (const [key, value] of Object.entries(obj)) {
        const nextPath = path ? `${path}.${key}` : key;
        if (Array.isArray(value)) {
          const lower = key.toLowerCase();
          if (/openpositions|opentrades|activepositions|activetrades|paperopen/.test(lower)) {
            out.open.push({ source: nextPath, rows: clone(value).slice(0, 500) });
          }
          if (/closedtrades|closedpositions|tradelog|paperclosed|completedtrades/.test(lower)) {
            out.closed.push({ source: nextPath, rows: clone(value).slice(0, 1000) });
          }
        } else if (value && typeof value === 'object' && nextPath.split('.').length < 5) {
          collectNamedArrays(value, out, seen, nextPath);
        }
      }
    }

    const out = { open: [], closed: [] };

    const openNames = [
      'openPositions',
      'openTrades',
      'activePositions',
      'activeTrades',
      'paperOpenTrades',
      'fwOpenPositions',
      'forwardOpenPositions'
    ];

    const closedNames = [
      'closedTrades',
      'closedPositions',
      'tradeLog',
      'paperClosedTrades',
      'completedTrades',
      'fwClosedTrades',
      'forwardClosedTrades'
    ];

    for (const name of openNames) {
      const rows = arrFromGlobal(name);
      if (rows.length) out.open.push({ source: `global.${name}`, rows: rows.slice(0, 500) });
    }

    for (const name of closedNames) {
      const rows = arrFromGlobal(name);
      if (rows.length) out.closed.push({ source: `global.${name}`, rows: rows.slice(0, 1000) });
    }

    try {
      const report = typeof buildRunReportObject === 'function' ? await buildRunReportObject() : null;
      if (report && typeof report === 'object') {
        const recentSignals = Array.isArray(report?.forwardWatch?.recentSignals) ? report.forwardWatch.recentSignals : [];
        if (recentSignals.length) {
          out.open.push({
            source: 'report.forwardWatch.recentSignals.OPEN',
            rows: recentSignals.filter(s => String(s?.outcome || '').toUpperCase() === 'OPEN')
          });
          out.closed.push({
            source: 'report.forwardWatch.recentSignals.CLOSED',
            rows: recentSignals.filter(s => String(s?.outcome || '').toUpperCase() !== 'OPEN')
          });
        }
        collectNamedArrays(report, out, new Set(), 'report');
      }
    } catch (_) {}

    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!/alps|runtime|snapshot|ledger|trade|position|paper|forward/i.test(key || '')) continue;
        const raw = localStorage.getItem(key);
        if (!raw || raw.length > 5_000_000) continue;
        try {
          const parsed = JSON.parse(raw);
          collectNamedArrays(parsed, out, new Set(), `localStorage.${key}`);
        } catch (_) {}
      }
    } catch (_) {}

    function flatten(groups) {
      const rows = [];
      const seen = new Set();
      for (const group of groups) {
        for (const item of group.rows || []) {
          if (!item || typeof item !== 'object') continue;
          const copy = { ...item, __alpsSource: group.source };
          const key = JSON.stringify(copy).slice(0, 1200);
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push(copy);
        }
      }
      return rows;
    }

    return {
      openTrades: flatten(out.open),
      closedTrades: flatten(out.closed),
      sourceStats: {
        openSources: out.open.map(x => ({ source: x.source, count: x.rows.length })),
        closedSources: out.closed.map(x => ({ source: x.source, count: x.rows.length }))
      }
    };
  });
}

async function ensureRuntimeStarted() {
  const h = await getPageHealth();
  Object.assign(lastHealth, enhanceHealth(h), { status: enhanceHealth(h).forwardStale ? 'STALE_FORWARD' : 'LOADED', lastError: '' });

  if (!h.rtPrepared) {
    await pageEval(async () => {
      if (typeof prepareAndroidRuntime === 'function') await prepareAndroidRuntime();
      if (typeof startEngineWorker === 'function') await startEngineWorker();
      if (typeof runFinalPreflight === 'function' && (!window.preflightStatus || preflightStatus === 'WAITING')) await runFinalPreflight();
    }).catch(e => { throw new Error('Runtime prepare failed: ' + e.message); });
  }

  const refreshed = await getPageHealth();
  Object.assign(lastHealth, enhanceHealth(refreshed));

  if (!refreshed.candidates && AUTO_START_LAB && !refreshed.labRunning) {
    log('No candidates found. ALPS_AUTO_START_LAB=1, starting full Lab. This can take time.');
    await pageEval(() => { if (typeof startLab === 'function') startLab(); return true; });
    return;
  }

  if (AUTO_START_WATCH && refreshed.candidates && !refreshed.fwRunning && !refreshed.emergencyStopActive) {
    log(`Starting Browser Runner inside server Chromium. candidates=${refreshed.candidates}`);
    await pageEval(async () => { if (typeof startWatch === 'function') await startWatch(); return true; });
  }
}

async function runnerTick(reason = 'server-runner tick') {
  if (tickBusy) return { ok: true, skipped: 'tick already running' };
  tickBusy = true;
  try {
    if (!page || page.isClosed()) {
      const launched = await launchAppPage();
      if (!launched) {
        await recordSnapshot(snapshotFromMetrics(lastHealth, 'tick-page-launch-failed')).catch(() => null);
        return { ok: false, error: lastHealth.lastError || 'PAGE_LAUNCH_FAILED', health: lastHealth, recovery: buildRecoveryView() };
      }
    }
    await ensureRuntimeStarted();
    const before = enhanceHealth(await getPageHealth());

    if (before.fwRunning && !before.fwRefreshRunning) {
      await pageEval(async reasonText => {
        if (typeof catchUpForwardWatch === 'function') await catchUpForwardWatch(reasonText);
        if (typeof saveRuntimeSnapshotThrottled === 'function') await saveRuntimeSnapshotThrottled(false);
        if (typeof renderAll === 'function') renderAll();
        return true;
      }, reason).catch(e => { throw new Error('catch-up failed: ' + e.message); });
    }

    const after = enhanceHealth(await getPageHealth());
    Object.assign(lastHealth, after, { status: after.forwardStale ? 'STALE_FORWARD' : (after.fwRunning ? 'RUNNING' : (after.labRunning ? 'LAB_RUNNING' : 'READY')), lastTickAt: Date.now(), lastError: '' });
    await recordSnapshot(snapshotFromMetrics(lastHealth, 'tick'));
    await maybeRecoverStaleForward();
    await maybeNotify(lastHealth);
    if (Date.now() - (lastHealth.lastReportAt || 0) > REPORT_EVERY_MS) await collectReport().catch(e => log('Report collection failed:', e.message));
    return { ok: true, health: lastHealth };
  } catch (e) {
    lastHealth.status = 'ERROR';
    lastHealth.lastError = e.message;
    log('Runner tick error:', e.stack || e.message);
    return { ok: false, error: e.message, health: lastHealth };
  } finally {
    tickBusy = false;
  }
}

async function collectReport() {
  if (!page || page.isClosed()) throw new Error('ALPS page is not ready');
  const report = await pageEval(async () => {
    if (typeof buildRunReportObject !== 'function') throw new Error('buildRunReportObject not available');
    const r = await buildRunReportObject();
    r.serverRunner = {
      enabled: true,
      mode: 'server-side-chromium-wrapper',
      browserOnlyPhoneDependency: false,
      note: 'The same ALPS browser logic is running in a persistent server Chromium session.'
    };
    return r;
  });

  const rawTradeLedgers = await collectPageTradeLedgers().catch(e => ({
    openTrades: [],
    closedTrades: [],
    sourceStats: { error: e.message }
  }));

  lastTradeExport = buildTradeExport(rawTradeLedgers);
  await updateTradeVault(lastTradeExport, 'report');
  report.quantEdgeTradeExport = lastTradeExport;
  report.alpsTradeContinuityVault = buildTradeVaultView();
  report.alpsCognition = await updateCognitionState(report, lastTradeExport);

  let md = '';
  try {
    md = await pageEval(r => {
      if (typeof runReportToMarkdown === 'function') {
        const out = runReportToMarkdown(r);
        return `${out}\n\n## Server Runner\n- Enabled: YES\n- Mode: server-side Chromium wrapper\n- Phone dependency: OFF\n- Background reliability: server process controls the app page, not Android Chrome.\n`;
      }
      return JSON.stringify(r, null, 2);
    }, report);
  } catch (_) {
    md = JSON.stringify(report, null, 2);
  }
  lastReport = report;
  await recordSnapshot(snapshotFromReport(report, 'report'));
  md = `${md}\n\n${buildTradesMarkdown(lastTradeExport)}\n\n${buildTradeVaultMarkdown()}`;
  md = appendRecoveryMarkdown(md);
  lastReportMarkdown = md;
  lastHealth.lastReportAt = Date.now();
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-report.json'), JSON.stringify(report, null, 2));
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-report.md'), md);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-trades.json'), JSON.stringify(lastTradeExport, null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-trades-vault.json'), JSON.stringify(buildTradeVaultView(), null, 2)).catch(() => null);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.writeFile(path.join(REPORT_DIR, `ALPS_Server_Report_${stamp}.json`), JSON.stringify(report, null, 2)).catch(() => null);
  return report;
}

async function importBackupIntoPage(backup) {
  if (!page || page.isClosed()) await launchAppPage();
  await fsp.writeFile(path.join(DATA_DIR, `imported_backup_${Date.now()}.json`), JSON.stringify(backup, null, 2));
  const result = await pageEval(async backupObj => {
    if (!backupObj || typeof backupObj !== 'object') throw new Error('Invalid backup JSON');
    if (typeof safeResumeFromSnapshot !== 'function') throw new Error('safeResumeFromSnapshot not available in this ALPS build');
    safeResumeFromSnapshot(backupObj, 'server-runner import');
    if (typeof normalizeTradeLedgers === 'function') normalizeTradeLedgers();
    if (typeof saveRuntimeSnapshot === 'function') await saveRuntimeSnapshot();
    if (typeof renderAll === 'function') renderAll();
    return {
      imported: true,
      results: Array.isArray(backupObj.results) ? backupObj.results.length : 0,
      paperSignals: Array.isArray(backupObj.paperSignals) ? backupObj.paperSignals.length : 0,
      openPositions: Array.isArray(backupObj.openPositions) ? backupObj.openPositions.length : 0,
      closedTrades: Array.isArray(backupObj.closedTrades) ? backupObj.closedTrades.length : 0
    };
  }, backup);
  await runnerTick('after import');
  await recordSnapshot(snapshotFromMetrics(lastHealth, 'import-backup'));
  return { ok: true, ...result, health: lastHealth, recovery: buildRecoveryView() };
}

async function runCommand(command, args = {}) {
  if (!page || page.isClosed()) await launchAppPage();
  if (command === 'tick') return runnerTick('manual command');
  if (command === 'start-watch') {
    await pageEval(async () => { if (typeof startWatch === 'function') await startWatch(); return true; });
    return { ok: true, health: await getPageHealth() };
  }
  if (command === 'start-lab') {
    await pageEval(() => { if (typeof startLab === 'function') startLab(); return true; });
    return { ok: true, message: 'Lab started. This can take time.', health: await getPageHealth() };
  }
  if (command === 'stop') {
    await pageEval(() => { if (typeof emergencyStop === 'function') emergencyStop(); else if (typeof stopReq !== 'undefined') stopReq = true; return true; });
    return { ok: true, health: await getPageHealth() };
  }
  if (command === 'report') return { ok: true, report: await collectReport() };
  if (command === 'cognition') { await collectReport().catch(() => null); return { ok: true, cognition: lastCognitionView || cognitionState?.lastView || null }; }
  if (command === 'recovery') { await loadRecoveryState(); return { ok: true, recovery: buildRecoveryView(), state: recoveryState }; }
  if (command === 'recover-forward') { lastHealth = enhanceHealth({ ...lastHealth, forwardStale: true }); await maybeRecoverStaleForward(); return { ok: true, health: lastHealth, recovery: buildRecoveryView() }; }
  if (command === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ensureRuntimeStarted();
    return { ok: true, health: await getPageHealth() };
  }
  return { ok: false, error: `Unknown command: ${command}` };
}

async function maybeNotify(h) {
  const changed = [];
  if (h.paperSignals > lastNotifyCounts.paperSignals) changed.push(`signals ${lastNotifyCounts.paperSignals} → ${h.paperSignals}`);
  if (h.closedTrades > lastNotifyCounts.closedTrades) changed.push(`closed ${lastNotifyCounts.closedTrades} → ${h.closedTrades}`);
  if (h.openPositions !== lastNotifyCounts.openPositions) changed.push(`open ${lastNotifyCounts.openPositions} → ${h.openPositions}`);
  lastNotifyCounts = { paperSignals: h.paperSignals, closedTrades: h.closedTrades, openPositions: h.openPositions };
  if (!changed.length) return;
  log('ALPS update:', changed.join(' | '));
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || typeof fetch !== 'function') return;
  const text = `ALPS Server Runner\n${changed.join('\n')}\nWR: ${h.winRate == null ? '—' : h.winRate.toFixed(1) + '%'}\nStatus: ${lastHealth.status}`;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });
  } catch (e) {
    log('Telegram notify failed:', e.message);
  }
}

async function main() {
  await ensureDirs();
  await loadRecoveryState();
  await createServer();
  const launched = await launchAppPage();
  if (launched) {
    await runnerTick('startup');
  } else {
    log('ALPS web API is online in recovery-only mode because the browser page could not launch. Open /runner/health and /runner/recovery for details.');
  }
  setInterval(() => runnerTick('server-runner interval').catch(e => log('Interval tick failed:', errorInfo(e))), TICK_MS);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log('ALPS Server Runner is active. Health:', `http://127.0.0.1:${PORT}/runner/health`);
}

async function shutdown() {
  log('Shutting down ALPS Server Runner...');
  try { if (page && !page.isClosed()) await collectReport().catch(() => null); } catch (_) {}
  try { await saveRecoveryState(); } catch (_) {}
  try { if (context) await context.close(); } catch (_) {}
  process.exit(0);
}

main().catch(err => {
  const info = errorInfo(err);
  console.error('Fatal ALPS runner boot error:', JSON.stringify(info, null, 2));
  process.exit(1);
});
