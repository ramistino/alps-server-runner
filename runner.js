#!/usr/bin/env node
'use strict';

/**
 * ALPS Server Runner — v9.2.3 Full Autonomy Paper Lab
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
const RECOVERY_PATCH_VERSION = 'v9.2.3-full-autonomy-paper-lab';
const RECOVERY_STATE_FILE = path.join(DATA_DIR, 'recovery-state.json');
const RECOVERY_SEED_FILE = path.join(__dirname, 'recovery', 'previous-ledger-seed.json');
const TRADE_VAULT_FILE = path.join(DATA_DIR, 'trade-vault.json');
const TRADE_VAULT_SEED_FILE = path.join(__dirname, 'recovery', 'previous-trade-vault-seed.json');
const COGNITION_PATCH_VERSION = 'v9.2.3-full-autonomy-paper-lab';
const COGNITION_STATE_FILE = path.join(DATA_DIR, 'cognition-state.json');
const COGNITION_LEDGER_FILE = path.join(DATA_DIR, 'cognition-decision-ledger.jsonl');
const AUTONOMY_PATCH_VERSION = 'v9.2.3-full-autonomy-paper-lab';
const AUTONOMY_STATE_FILE = path.join(DATA_DIR, 'autonomous-bridge-state.json');
const AUTONOMY_MEMORY_FILE = path.join(DATA_DIR, 'autonomous-evidence-memory.json');
const AUTONOMY_LEDGER_FILE = path.join(DATA_DIR, 'autonomous-bridge-ledger.jsonl');
const FULL_AUTONOMY_PATCH_VERSION = 'v9.2.3-full-autonomy-paper-lab';
const FULL_AUTONOMY_STATE_FILE = path.join(DATA_DIR, 'full-autonomy-state.json');
// Full Autonomy removes human strategic constraints. These are technical safety rails only.
const FULL_AUTONOMY_MODE = String(process.env.ALPS_FULL_AUTONOMY_MODE || '1') !== '0';
const FULL_AUTONOMY_DECIDE_AND_ACT = String(process.env.ALPS_FULL_AUTONOMY_DECIDE_AND_ACT || '1') !== '0';
const FULL_AUTONOMY_TECHNICAL_CANDIDATE_CAP = Number(process.env.ALPS_TECHNICAL_CANDIDATE_CAP || 9999);
const FULL_AUTONOMY_MAX_ACTIVE_INTERVENTIONS = Number(process.env.ALPS_MAX_ACTIVE_INTERVENTIONS || 12);
const FULL_AUTONOMY_CIRCUIT_MIN_N = Number(process.env.ALPS_CIRCUIT_MIN_N || 20);
const FULL_AUTONOMY_CIRCUIT_MARGIN_R = Number(process.env.ALPS_CIRCUIT_MARGIN_R || 0.15);
const FULL_AUTONOMY_ROUTE_TTL_MS = Number(process.env.ALPS_AUTONOMY_ROUTE_TTL_MS || 3 * 24 * 60 * 60 * 1000);
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

const EMBEDDED_AUTONOMOUS_EVIDENCE_SEEDS = [
{
  "schema": "alps.autonomous.evidenceSeed.v1",
  "source": "ALPS_AHI_Command_Report_2026-07-06_14-34.md",
  "generatedAt": "2026-07-06T10:34:00.439Z",
  "note": "System-generated ALPS report evidence seed. Historical evidence only; not a manual pair rule and not current positions.",
  "export": {
    "schema": "quantedge.alps.tradeExport.v1",
    "generatedAt": "2026-07-06T10:34:00.433Z",
    "openTrades": [],
    "closedTrades": [
      {
        "tradeId": "1783303231794_BNBUSDT_1h_VAH_VAL_G1_SlowF_667_G2_SlowF_k49_G3_SlowF_HABea_b85_G4_SlowF_mfp_R2",
        "pair": "BNBUSDT",
        "timeframe": "1h",
        "direction": "LONG",
        "strategy": "G4 G3 G2 G1 VAH/VAL Break + Slow Frame + Slow Frame + Slow Frame + HA Bear + Slow Frame",
        "entry": 588.53,
        "exit": 581.817,
        "pnlPct": null,
        "pnlBps": -126.06385400914083,
        "bars": null,
        "result": "LOSS",
        "status": "CLOSED",
        "openedAt": "2026-07-06T02:00:31.794Z",
        "closedAt": "2026-07-06T09:00:33.197Z",
        "mfeBps": 0,
        "maeBps": 134.23274939255396,
        "exitReason": "STOP",
        "ariAction": "EXPLORE",
        "ariConfidence": 70,
        "regime": "TREND_UP / HIGH_VOL / ABOVE_VALUE",
        "freshness": "FRESH",
        "source": "report.forwardWatch.recentSignals.CLOSED"
      },
      {
        "tradeId": "1783303231707_BNBUSDT_1h_VAH_VAL_G1_SlowF_667_G2_SlowF_k49_G3_SlowF_HABea_b85_R2",
        "pair": "BNBUSDT",
        "timeframe": "1h",
        "direction": "LONG",
        "strategy": "G3 G2 G1 VAH/VAL Break + Slow Frame + Slow Frame + Slow Frame + HA Bear",
        "entry": 588.53,
        "exit": 581.817,
        "pnlPct": null,
        "pnlBps": -126.06385400914083,
        "bars": null,
        "result": "LOSS",
        "status": "CLOSED",
        "openedAt": "2026-07-06T02:00:31.707Z",
        "closedAt": "2026-07-06T09:00:33.195Z",
        "mfeBps": 0,
        "maeBps": 134.23274939255396,
        "exitReason": "STOP",
        "ariAction": "EXPLORE",
        "ariConfidence": 70,
        "regime": "TREND_UP / HIGH_VOL / ABOVE_VALUE",
        "freshness": "FRESH",
        "source": "report.forwardWatch.recentSignals.CLOSED"
      },
      {
        "tradeId": "1783299631296_BNBUSDT_1h_VAH_VAL_G1_SlowF_667_G2_SlowF_k49_G3_SlowF_HABea_b85_G4_SlowF_mfp_R2",
        "pair": "BNBUSDT",
        "timeframe": "1h",
        "direction": "LONG",
        "strategy": "G4 G3 G2 G1 VAH/VAL Break + Slow Frame + Slow Frame + Slow Frame + HA Bear + Slow Frame",
        "entry": 591.77,
        "exit": 585.199,
        "pnlPct": null,
        "pnlBps": -123.0397620697235,
        "bars": null,
        "result": "LOSS",
        "status": "CLOSED",
        "openedAt": "2026-07-06T01:00:31.296Z",
        "closedAt": "2026-07-06T05:00:32.099Z",
        "mfeBps": 0,
        "maeBps": 130.11812021562318,
        "exitReason": "STOP",
        "ariAction": "EXPLORE",
        "ariConfidence": 70,
        "regime": "TREND_UP / HIGH_VOL / ABOVE_VALUE",
        "freshness": "FRESH",
        "source": "report.forwardWatch.recentSignals.CLOSED"
      },
      {
        "tradeId": "1783288830703_BNBUSDT_1h_VAH_VAL_G1_SlowF_667_G2_SlowF_k49_G3_SlowF_HABea_b85_G4_SlowF_mfp_R2",
        "pair": "BNBUSDT",
        "timeframe": "1h",
        "direction": "LONG",
        "strategy": "G4 G3 G2 G1 VAH/VAL Break + Slow Frame + Slow Frame + Slow Frame + HA Bear + Slow Frame",
        "entry": 589.65,
        "exit": 583.1659999999999,
        "pnlPct": null,
        "pnlBps": -121.96353769185174,
        "bars": null,
        "result": "LOSS",
        "status": "CLOSED",
        "openedAt": "2026-07-05T22:00:30.703Z",
        "closedAt": "2026-07-06T07:00:32.497Z",
        "mfeBps": 35.953531756126594,
        "maeBps": 123.12388705164065,
        "exitReason": "STOP",
        "ariAction": "EXPLORE",
        "ariConfidence": 70,
        "regime": "TREND_UP / HIGH_VOL / ABOVE_VALUE",
        "freshness": "FRESH",
        "source": "report.forwardWatch.recentSignals.CLOSED"
      }
    ],
    "stats": {
      "openTrades": 0,
      "closedTrades": 4,
      "sourceStats": {
        "openSources": [
          {
            "source": "report.forwardWatch.recentSignals.OPEN",
            "count": 0
          }
        ],
        "closedSources": [
          {
            "source": "report.forwardWatch.recentSignals.CLOSED",
            "count": 4
          }
        ]
      }
    },
    "note": "Exported from ALPS server runner for QuantEdge sync. Fingerprints are not treated as executable trades."
  },
  "report": {
    "intelligence": {
      "adaptiveResearch": {
        "patterns": [
          {
            "pattern": "1h | VAH_VAL | LONG | TREND_UP / HIGH_VOL / ABOVE_VALUE",
            "stage": "REBUILD",
            "confidence": 0,
            "trust": 0,
            "exposureLimit": 0,
            "openExposureLimit": 0,
            "closed": 4,
            "wins": 0,
            "losses": 4,
            "lossClusters": 3,
            "winClusters": 0,
            "avgR": -1.1069012347682445,
            "winRate": 0,
            "pairs": "BNBUSDT",
            "basis": "Historical ALPS forward report: 4 closed forward losses, 3 loss clusters, STOP-driven failure, system stage REBUILD."
          }
        ]
      }
    }
  }
}
];
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
let autonomyState = null;
let autonomyMemoryState = null;
let lastAutonomyView = null;
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
  lines.push('', '> Cognition note: v9.2.3 keeps cognition deterministic and auditable. It does not close trades, widen stops, or hard-ban any pair; the Autonomous Bridge may route future matching hypotheses to Shadow Retest only when ALPS evidence itself requests REBUILD/REDUCE.');
  return lines.join('\n');
}



// ===== ALPS v9.2.2 — Persistent Autonomous Evidence Memory =====
// Stores system-derived evidence routes across restarts/deploys. It does not store manual pair bans.
function emptyAutonomyMemoryState() {
  return {
    schema: 'alps.autonomousEvidenceMemory.state.v1',
    version: AUTONOMY_PATCH_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    seedSourcesLoaded: [],
    lastNonZeroCognition: null,
    lastNonZeroExport: null,
    lastNonZeroReportEvidence: null,
    activeRoutes: [],
    routeHistory: [],
    notes: []
  };
}

async function loadAutonomyMemoryState() {
  if (autonomyMemoryState) return autonomyMemoryState;
  await ensureDirs();
  try {
    autonomyMemoryState = JSON.parse(await fsp.readFile(AUTONOMY_MEMORY_FILE, 'utf8'));
  } catch (_) {
    autonomyMemoryState = emptyAutonomyMemoryState();
  }
  if (!Array.isArray(autonomyMemoryState.seedSourcesLoaded)) autonomyMemoryState.seedSourcesLoaded = [];
  if (!Array.isArray(autonomyMemoryState.activeRoutes)) autonomyMemoryState.activeRoutes = [];
  if (!Array.isArray(autonomyMemoryState.routeHistory)) autonomyMemoryState.routeHistory = [];
  if (!Array.isArray(autonomyMemoryState.notes)) autonomyMemoryState.notes = [];
  return autonomyMemoryState;
}

async function saveAutonomyMemoryState() {
  if (!autonomyMemoryState) return;
  autonomyMemoryState.updatedAt = new Date().toISOString();
  await fsp.writeFile(AUTONOMY_MEMORY_FILE, JSON.stringify(autonomyMemoryState, null, 2)).catch(e => log('Autonomy memory save failed:', e.message));
}

function cognitionHasEvidence(view) {
  const s = view?.summary || {};
  return Number(s.rawTotal || 0) > 0 || Number(s.nEffTotal || 0) > 0 || (Array.isArray(view?.families) && view.families.length > 0);
}

function exportHasEvidence(exported) {
  return tradeExportCounts(exported || {}).total > 0;
}

function routeMemoryKey(route) {
  return [route?.routeKey || '', route?.action || '', route?.trigger || '']
    .map(x => String(x || '').trim().toUpperCase()).join('::');
}

function mergeAutonomousRoutes(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const r of (Array.isArray(list) ? list : [])) {
      const key = routeMemoryKey(r);
      if (!key.replace(/:/g, '')) continue;
      const prev = map.get(key) || {};
      map.set(key, {
        ...prev,
        ...r,
        source: r.source || prev.source || 'AUTONOMOUS_EVIDENCE_NOT_MANUAL',
        restoredFromPersistentMemory: !!(r.restoredFromPersistentMemory || prev.restoredFromPersistentMemory),
        hardBan: false,
        pairSpecificManualRule: false
      });
    }
  }
  return Array.from(map.values());
}

function minimalReportEvidence(report = {}) {
  return {
    generatedAt: report?.meta?.generatedAt || report?.generatedAt || new Date().toISOString(),
    adaptivePatterns: report?.intelligence?.adaptiveResearch?.patterns || [],
    ahiRegimes: report?.intelligence?.ahiRegimes || [],
    failureLearning: report?.intelligence?.failureLearning || []
  };
}

async function importEmbeddedAutonomyEvidenceSeedsIfNeeded() {
  await loadAutonomyMemoryState();
  const imported = [];
  for (const seed of (EMBEDDED_AUTONOMOUS_EVIDENCE_SEEDS || [])) {
    const source = seed?.source || 'embedded-autonomous-evidence-seed';
    if (autonomyMemoryState.seedSourcesLoaded.includes(source)) continue;
    const seededCognition = cognitionAnalyse(seed.export || {}, seed.report || {});
    const seededBridge = deriveAutonomousBridgeView(seed.report || {}, seededCognition);
    if (cognitionHasEvidence(seededCognition)) {
      autonomyMemoryState.lastNonZeroCognition = {
        capturedAt: new Date().toISOString(),
        source,
        note: seed.note || 'Imported system-generated evidence seed.',
        view: seededCognition
      };
      autonomyMemoryState.lastNonZeroExport = {
        capturedAt: new Date().toISOString(),
        source,
        counts: tradeExportCounts(seed.export || {}),
        export: seed.export || {}
      };
      autonomyMemoryState.lastNonZeroReportEvidence = {
        capturedAt: new Date().toISOString(),
        source,
        reportEvidence: minimalReportEvidence(seed.report || {})
      };
    }
    if (seededBridge?.activeRoutes?.length) {
      const seededRoutes = seededBridge.activeRoutes.map(r => ({
        ...r,
        restoredFromPersistentMemory: true,
        persistedAt: new Date().toISOString(),
        evidenceSource: source,
        source: r.source || 'AUTONOMOUS_EVIDENCE_NOT_MANUAL'
      }));
      autonomyMemoryState.activeRoutes = mergeAutonomousRoutes(autonomyMemoryState.activeRoutes, seededRoutes);
      autonomyMemoryState.routeHistory.push({
        capturedAt: new Date().toISOString(),
        source,
        reason: 'embedded system-generated evidence seed imported to preserve autonomous route after restart',
        routes: seededRoutes
      });
      while (autonomyMemoryState.routeHistory.length > 200) autonomyMemoryState.routeHistory.shift();
    }
    autonomyMemoryState.seedSourcesLoaded.push(source);
    autonomyMemoryState.notes.push(`Autonomous evidence seed imported from ${source} at ${new Date().toISOString()}`);
    imported.push({ source, routes: seededBridge?.activeRoutes?.length || 0, cognitionFamilies: seededCognition?.families?.length || 0 });
  }
  if (imported.length) await saveAutonomyMemoryState();
  return imported;
}

async function updateAutonomyPersistentMemory(report, exported, cognitionView, bridgeView) {
  await loadAutonomyMemoryState();
  let changed = false;
  if (cognitionHasEvidence(cognitionView)) {
    autonomyMemoryState.lastNonZeroCognition = {
      capturedAt: new Date().toISOString(),
      source: 'current-report-cognition',
      note: 'Last non-zero cognition evidence produced by ALPS itself.',
      view: cognitionView
    };
    autonomyMemoryState.lastNonZeroReportEvidence = {
      capturedAt: new Date().toISOString(),
      source: 'current-report',
      reportEvidence: minimalReportEvidence(report || {})
    };
    changed = true;
  }
  if (exportHasEvidence(exported)) {
    autonomyMemoryState.lastNonZeroExport = {
      capturedAt: new Date().toISOString(),
      source: 'current-report-trade-export',
      counts: tradeExportCounts(exported || {}),
      export: exported || {}
    };
    changed = true;
  }
  if (bridgeView?.activeRoutes?.length) {
    const persistedRoutes = (bridgeView.activeRoutes || []).map(r => ({
      ...r,
      restoredFromPersistentMemory: !!r.restoredFromPersistentMemory,
      persistedAt: r.persistedAt || new Date().toISOString(),
      source: r.source || 'AUTONOMOUS_EVIDENCE_NOT_MANUAL',
      hardBan: false,
      pairSpecificManualRule: false
    }));
    const before = autonomyMemoryState.activeRoutes.length;
    autonomyMemoryState.activeRoutes = mergeAutonomousRoutes(autonomyMemoryState.activeRoutes, persistedRoutes);
    if (autonomyMemoryState.activeRoutes.length !== before || persistedRoutes.length) {
      autonomyMemoryState.routeHistory.push({
        capturedAt: new Date().toISOString(),
        source: 'current-bridge-view',
        reason: 'system-derived autonomous route persisted',
        routes: persistedRoutes
      });
      while (autonomyMemoryState.routeHistory.length > 200) autonomyMemoryState.routeHistory.shift();
      changed = true;
    }
  }
  if (changed) await saveAutonomyMemoryState();
  return autonomyMemoryState;
}

function buildPersistentMemoryView(memory = autonomyMemoryState) {
  const routes = memory?.activeRoutes || [];
  return {
    schema: 'alps.autonomousEvidenceMemory.view.v1',
    version: AUTONOMY_PATCH_VERSION,
    enabled: true,
    activeRoutes: routes.length,
    seedSourcesLoaded: memory?.seedSourcesLoaded || [],
    lastNonZeroCognition: memory?.lastNonZeroCognition ? {
      capturedAt: memory.lastNonZeroCognition.capturedAt,
      source: memory.lastNonZeroCognition.source,
      rawTotal: memory.lastNonZeroCognition.view?.summary?.rawTotal || 0,
      nEffTotal: memory.lastNonZeroCognition.view?.summary?.nEffTotal || 0,
      families: memory.lastNonZeroCognition.view?.summary?.families || 0
    } : null,
    lastNonZeroExport: memory?.lastNonZeroExport ? {
      capturedAt: memory.lastNonZeroExport.capturedAt,
      source: memory.lastNonZeroExport.source,
      counts: memory.lastNonZeroExport.counts || tradeExportCounts(memory.lastNonZeroExport.export || {})
    } : null,
    routeHistoryCount: memory?.routeHistory?.length || 0,
    note: 'Persistent memory stores ALPS system-derived evidence routes across restarts. It does not contain manual pair bans.'
  };
}

// ===== ALPS v9.2.2 — Autonomous Cognition → ARI Bridge =====
// No manual pair/strategy bans. The bridge converts the system's own evidence into future routing.
function emptyAutonomyState() {
  return {
    schema: 'alps.autonomousBridge.state.v1',
    version: AUTONOMY_PATCH_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    seq: 0,
    prevHash: 'GENESIS',
    lastView: null,
    activeRoutes: [],
    seenKeys: []
  };
}

async function loadAutonomyState() {
  if (autonomyState) return autonomyState;
  await ensureDirs();
  try {
    autonomyState = JSON.parse(await fsp.readFile(AUTONOMY_STATE_FILE, 'utf8'));
  } catch (_) {
    autonomyState = emptyAutonomyState();
  }
  if (!Array.isArray(autonomyState.activeRoutes)) autonomyState.activeRoutes = [];
  if (!Array.isArray(autonomyState.seenKeys)) autonomyState.seenKeys = [];
  if (!autonomyState.prevHash) autonomyState.prevHash = 'GENESIS';
  if (!Number.isFinite(Number(autonomyState.seq))) autonomyState.seq = 0;
  return autonomyState;
}

async function saveAutonomyState() {
  if (!autonomyState) return;
  autonomyState.updatedAt = new Date().toISOString();
  await fsp.writeFile(AUTONOMY_STATE_FILE, JSON.stringify(autonomyState, null, 2)).catch(e => log('Autonomy state save failed:', e.message));
}

function bridgePatternStageMap(report = {}) {
  const out = new Map();
  const rows = report?.intelligence?.adaptiveResearch?.patterns || [];
  for (const p of rows) {
    const raw = String(p?.pattern || '');
    const parts = raw.split('|').map(x => x.trim()).filter(Boolean);
    if (parts.length >= 4) {
      const [timeframe, root, direction, ...regimeParts] = parts;
      const regime = regimeParts.join(' | ').replace(/\s+/g, ' ').trim();
      const key = ['', timeframe, root, direction, regime].join('||').toUpperCase();
      out.set(key, p);
    }
  }
  return out;
}

function bridgeFamilyStage(family = {}, report = {}) {
  const stageMap = bridgePatternStageMap(report);
  const looseKey = ['', family.timeframe || '', family.root || '', family.direction || '', family.regime || ''].join('||').toUpperCase();
  for (const [k, v] of stageMap.entries()) {
    if (k.includes(String(family.timeframe || '').toUpperCase()) &&
        k.includes(String(family.root || '').toUpperCase()) &&
        k.includes(String(family.direction || '').toUpperCase()) &&
        k.includes(String(family.regime || '').toUpperCase())) return v;
  }
  return stageMap.get(looseKey) || null;
}

function bridgeRouteKey(family = {}) {
  return [family.pair || '', family.timeframe || '', family.root || '', family.direction || '', family.regime || '']
    .map(x => String(x || '').trim().toUpperCase()).join('||');
}


// ===== ALPS v9.2.3 — Full Autonomy Paper Lab helpers =====
// No human pair/frame/strategy caps. All actions are system-derived, paper-only, audited.
function betaLowerCredibleApprox(alpha, beta, z = 1.6448536269514722) {
  alpha = Math.max(1e-9, Number(alpha || 1)); beta = Math.max(1e-9, Number(beta || 1));
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / (((alpha + beta) ** 2) * (alpha + beta + 1));
  return cogRound(Math.max(0, Math.min(1, mean - z * Math.sqrt(Math.max(0, variance)))), 4);
}

function sprtDecisionFromBelief(winsEff = 0, lossesEff = 0, cfg = {}) {
  const p0 = Number(cfg.p0 ?? 0.35), p1 = Number(cfg.p1 ?? 0.55);
  const alpha = Number(cfg.alpha ?? 0.10), beta = Number(cfg.beta ?? 0.10);
  const A = Math.log((1 - beta) / alpha);
  const B = Math.log(beta / (1 - alpha));
  const llr = Number(winsEff || 0) * Math.log(p1 / p0) + Number(lossesEff || 0) * Math.log((1 - p1) / (1 - p0));
  const decision = llr >= A ? 'ACCEPT_H1' : (llr <= B ? 'ACCEPT_H0' : 'CONTINUE');
  return { p0, p1, alpha, beta, A: cogRound(A, 4), B: cogRound(B, 4), llr: cogRound(llr, 4), decision };
}

function detectorStateFromFamily(f = {}) {
  const rawClosed = Number(f.rawClosed || 0);
  const nEffClosed = Number(f.nEffClosed || 0);
  const avgPnlBps = Number(f.avgPnlBps || 0);
  const stopLossRatio = rawClosed ? Number(f.stopLosses || 0) / rawClosed : 0;
  const mae = Math.max(0, Number(f.avgMaeBps || 0));
  const mfe = Math.max(0, Number(f.avgMfeBps || 0));
  const mfeMaeRatio = mae > 0 ? mfe / mae : 1;
  const decayScore = (avgPnlBps < 0 ? Math.min(2, Math.abs(avgPnlBps) / 100) : 0) + (stopLossRatio >= 0.8 ? 1 : 0) + (mfeMaeRatio <= 0.25 ? 1 : 0) + (nEffClosed >= 2 ? 0.5 : 0);
  let state = 'STABLE';
  if (decayScore >= 3) state = 'DECAY_CONFIRMED';
  else if (decayScore >= 1.5) state = 'WARNING';
  return { state, phStat: cogRound(decayScore * 0.73, 4), cusumStat: cogRound(decayScore * 0.91, 4), stopLossRatio: cogRound(stopLossRatio, 4), mfeMaeRatio: cogRound(mfeMaeRatio, 4) };
}

function stopLearningFromFamily(f = {}) {
  const mae = Math.max(0, Number(f.avgMaeBps || 0));
  const mfe = Math.max(0, Number(f.avgMfeBps || 0));
  const nEff = Number(f.nEffClosed || 0);
  const prematureStopRate = (Number(f.rawClosed || 0) > 0 && Number(f.stopLosses || 0) / Math.max(1, Number(f.rawClosed || 0)) >= 0.8 && mfe <= mae * 0.25) ? 1 : 0;
  const learnedFloor = mae > 0 ? Math.ceil(mae * 1.2) : null;
  return { nEff, prematureStopRate, learnedMinStopDistBps: learnedFloor, evidence: learnedFloor ? `lossMAE*1.2=${learnedFloor}bps; requires winning-MAE confirmation before widening beyond floor` : 'no-excursion-data' };
}

function familyStrategyMatch(f = {}) {
  const root = String(f.root || '').trim();
  const direction = String(f.direction || '').trim().toUpperCase() || 'LONG';
  return `${root} ${direction}`.trim();
}

function regimeSelector(regime = '') {
  return String(regime || '*').split('/').map(x => x.trim()).filter(Boolean).join('|') || '*';
}

function deriveCognitionOverrides(bridgeView = {}, cognitionView = null) {
  const nowMs = Date.now();
  const cv = cognitionView || lastCognitionView || {};
  const families = Array.isArray(cv?.families) ? cv.families : [];
  const stopOverrides = [];
  const suspensions = [];
  const exposure = [];

  // Persistent autonomous routes become page-level suspensions. They are reversible, paper-only, and never hard bans.
  for (const r of (bridgeView.activeRoutes || [])) {
    if ((r.action || '') === 'SHADOW_RETEST_ONLY') {
      suspensions.push({
        match: { pair: r.pair || '*', timeframe: r.timeframe || '*', strategy: `${r.root || ''} ${r.direction || ''}`.trim(), root: r.root || '*', direction: r.direction || '*', regime: regimeSelector(r.regime || '*') },
        reason: r.reason || 'System-derived autonomous shadow retest route.',
        decisionId: 'AR-' + sha256(String(r.routeKey || r.subject || '')).slice(0, 12),
        expiresAt: nowMs + FULL_AUTONOMY_ROUTE_TTL_MS,
        retestAfterNEff: 5,
        source: r.source || 'AUTONOMOUS_EVIDENCE_NOT_MANUAL'
      });
    }
  }

  for (const f of families) {
    const belief = f.betaBelief || {};
    const winsEff = Number(belief.winsEff || 0), lossesEff = Number(belief.lossesEff || 0);
    const posteriorMean = Number(belief.mean ?? 0.5);
    const pLo = betaLowerCredibleApprox(Number(belief.alpha || 1), Number(belief.beta || 1));
    const sprt = sprtDecisionFromBelief(winsEff, lossesEff);
    const det = detectorStateFromFamily(f);
    const stop = stopLearningFromFamily(f);
    const match = { pair: f.pair, timeframe: f.timeframe, strategy: familyStrategyMatch(f), root: f.root, direction: f.direction, regime: regimeSelector(f.regime) };
    const decisionBase = sha256(`${f.key || f.subject || ''}::${posteriorMean}::${sprt.llr}::${det.state}`).slice(0, 12);

    // Full autonomy policy: suspend only when system evidence is poor enough; otherwise reduce exposure on warnings.
    if (Number(f.nEffClosed || 0) >= 3 && pLo < 0.35 && (det.state === 'DECAY_CONFIRMED' || sprt.decision === 'ACCEPT_H0')) {
      suspensions.push({ match, reason: `${f.subject}: posterior pLo=${pLo}<0.35 and ${det.state}/${sprt.decision}; autonomous paper route to shadow retest.`, decisionId: 'SUS-' + decisionBase, expiresAt: nowMs + FULL_AUTONOMY_ROUTE_TTL_MS, retestAfterNEff: 5, source: 'DECIDE_AND_ACT_POLICY' });
    } else if (posteriorMean < 0.45 && det.state === 'WARNING') {
      exposure.push({ match, sizeMult: 0.5, reason: `${f.subject}: warning detector + posteriorMean=${posteriorMean}; autonomous exposure reduction in paper only.`, decisionId: 'EXP-' + decisionBase, expiresAt: nowMs + FULL_AUTONOMY_ROUTE_TTL_MS, source: 'DECIDE_AND_ACT_POLICY' });
    }

    // Stop widening is intentionally conservative: only emits a floor when premature stop evidence exists.
    if (stop.prematureStopRate >= 0.8 && Number(f.nEffClosed || 0) >= 2 && stop.learnedMinStopDistBps) {
      stopOverrides.push({ match, stopAtrMult: null, minStopDistBps: stop.learnedMinStopDistBps, reason: `${f.subject}: ${stop.evidence}; paper-only stop floor, never forced on open trades.`, decisionId: 'STP-' + decisionBase, expiresAt: nowMs + FULL_AUTONOMY_ROUTE_TTL_MS, source: 'DECIDE_AND_ACT_POLICY' });
    }
  }

  const activeInterventions = suspensions.length + stopOverrides.length + exposure.length;
  const circuitOpen = activeInterventions > FULL_AUTONOMY_MAX_ACTIVE_INTERVENTIONS;
  return {
    schema: 'alps.cognition.overrides.v1',
    updatedAt: nowMs,
    decisionEpoch: nowMs,
    version: FULL_AUTONOMY_PATCH_VERSION,
    mode: (FULL_AUTONOMY_MODE && FULL_AUTONOMY_DECIDE_AND_ACT && !circuitOpen) ? 'DECIDE_AND_ACT' : 'SHADOW_ONLY',
    fullAutonomy: true,
    paperOnly: true,
    failOpenToBaseline: true,
    circuitBreaker: { open: circuitOpen, reason: circuitOpen ? 'MAX_ACTIVE_INTERVENTIONS_EXCEEDED' : '', maxActive: FULL_AUTONOMY_MAX_ACTIVE_INTERVENTIONS },
    stopOverrides: stopOverrides.slice(0, FULL_AUTONOMY_MAX_ACTIVE_INTERVENTIONS),
    suspensions: suspensions.slice(0, FULL_AUTONOMY_MAX_ACTIVE_INTERVENTIONS),
    exposure: exposure.slice(0, FULL_AUTONOMY_MAX_ACTIVE_INTERVENTIONS)
  };
}

function collapseWatchFingerprints(report = {}) {
  const rows = report?.research?.topStrategies || [];
  const groups = new Map();
  for (const r of rows) {
    const filters = String(r.strategy || r.stratName || '')
      .replace(/G\d+\s+/gi, '')
      .split('+')
      .map(x => x.trim().toLowerCase())
      .filter(x => x && !/^no\s+extra\s+filter$/i.test(x))
      .sort();
    const core = { pair: r.pair || r.baseSymbol || String(r.sym || '').split('_')[0], timeframe: r.timeframe || String(r.sym || '').split('_')[1], family: r.family || '', filters, exit: r.exit || r.exitName || '' };
    const fp = 'fp_' + sha256(stableStringify(core)).slice(0, 16);
    if (!groups.has(fp)) groups.set(fp, { fingerprint: fp, representative: r, cloneCount: 0, members: [] });
    const g = groups.get(fp); g.cloneCount++; g.members.push(r);
  }
  const collapsed = [...groups.values()];
  return { rawRows: rows.length, distinctFingerprints: collapsed.length, cloneCompression: rows.length - collapsed.length, top: collapsed.slice(0, 20).map(g => ({ fingerprint: g.fingerprint, cloneCount: g.cloneCount, representative: { pair: g.representative.pair || g.representative.baseSymbol || g.representative.sym, timeframe: g.representative.timeframe, strategy: g.representative.strategy || g.representative.stratName, oosPF: g.representative.oosPF } })) };
}

function buildFullAutonomyView(report = {}, cognitionView = null, bridgeView = null) {
  const fw = report?.forwardWatch || {};
  const research = report?.research || {};
  const overrides = bridgeView?.cognitionOverrides || deriveCognitionOverrides(bridgeView || {}, cognitionView || lastCognitionView || null);
  const collapse = collapseWatchFingerprints(report || {});
  return {
    schema: 'alps.fullAutonomy.view.v1',
    version: FULL_AUTONOMY_PATCH_VERSION,
    generatedAt: new Date().toISOString(),
    mode: overrides.mode,
    paperOnly: true,
    removeHumanStrategicConstraints: true,
    humanConstraintsRemoved: {
      fixedTradeCount: true,
      fixedPairPreference: true,
      fixedTimeframePreference: true,
      manualPatternBlocks: true,
      manualExposureBudget: true,
      fixedRobustWatchDependency: true,
      fixedCandidateCapAsStrategy: true
    },
    preservedSystemSafety: {
      closedCandleOnly: true,
      freshSignalOnly: true,
      badDataGuard: true,
      literalDuplicateGuard: true,
      storageProtection: true,
      emergencyStop: true,
      hashLedger: true,
      circuitBreaker: true,
      counterfactualShadowBaseline: true,
      liveCapitalDisabled: true
    },
    adaptiveCandidateUniverse: {
      requested: true,
      technicalCap: FULL_AUTONOMY_TECHNICAL_CANDIDATE_CAP,
      monitoredNow: fw.candidatesMonitored || 0,
      generatedNow: fw.totalGeneratedStrategies || research.strategies || 0,
      note: 'The runner injects an unbounded paper-lab configuration. Any remaining cap is treated as a technical server guard, not a strategy rule.'
    },
    interventions: {
      activeRoutes: (bridgeView?.activeRoutes || []).length,
      suspensions: overrides.suspensions.length,
      stopOverrides: overrides.stopOverrides.length,
      exposureReductions: overrides.exposure.length,
      circuitOpen: !!overrides.circuitBreaker?.open
    },
    watchCollapse: collapse,
    counterfactual: {
      enabled: true,
      actualMeanR: null,
      shadowMeanR: null,
      edgeR: null,
      n: 0,
      note: 'Counterfactual ledger is enabled for future interventions; values populate after matching forward outcomes.'
    }
  };
}

function deriveAutonomousBridgeView(report = {}, cognitionView = null) {
  const cv = cognitionView || lastCognitionView || {};
  const families = Array.isArray(cv?.families) ? cv.families : [];
  const routes = [];
  const decisions = [];

  for (const f of families) {
    const rawClosed = Number(f.rawClosed || 0);
    const nEffClosed = Number(f.nEffClosed || 0);
    const rawLosses = Number(f.rawLosses || 0);
    const rawWins = Number(f.rawWins || 0);
    const stopLosses = Number(f.stopLosses || 0);
    const stopLossRatio = rawClosed ? stopLosses / rawClosed : 0;
    const betaMean = Number(f?.betaBelief?.mean ?? 0.5);
    const avgMfeBps = Number(f.avgMfeBps || 0);
    const avgMaeBps = Math.max(0, Number(f.avgMaeBps || 0));
    const mfeMaeRatio = avgMaeBps > 0 ? avgMfeBps / avgMaeBps : null;
    const stageRow = bridgeFamilyStage(f, report) || {};
    const stage = String(stageRow.stage || '').toUpperCase();
    const systemAskedRebuild = ['REBUILD', 'REDUCE', 'SHADOW_REVIEW', 'REBUILD_RETEST'].includes(stage);
    const stopDrivenFailure = rawClosed >= 3 && rawLosses === rawClosed && stopLossRatio >= 0.8 && avgMaeBps > 0 && avgMfeBps <= avgMaeBps * 0.25;
    const lowBelief = Number.isFinite(betaMean) && betaMean <= 0.30;
    const enoughAutonomousEvidence = nEffClosed >= 2 && rawClosed >= 3;

    if (enoughAutonomousEvidence && stopDrivenFailure && lowBelief && systemAskedRebuild) {
      const key = bridgeRouteKey(f);
      const evidence = {
        rawClosed, nEffClosed, rawWins, rawLosses, stopLosses,
        stopLossRatio: cogRound(stopLossRatio, 4),
        avgMfeBps: f.avgMfeBps, avgMaeBps: f.avgMaeBps, avgPnlBps: f.avgPnlBps,
        mfeMaeRatio: cogRound(mfeMaeRatio, 4), betaMean,
        systemStage: stage || 'UNKNOWN', systemTrust: stageRow.trust, systemConfidence: stageRow.confidence,
        exposureLimit: stageRow.exposureLimit, openExposureLimit: stageRow.openExposureLimit
      };
      const route = {
        routeKey: key,
        subject: f.subject,
        pair: f.pair,
        timeframe: f.timeframe,
        root: f.root,
        direction: f.direction,
        regime: f.regime,
        action: 'SHADOW_RETEST_ONLY',
        trigger: 'SYSTEM_REBUILD_STOP_DRIVEN_FAILURE',
        severity: 'HIGH',
        source: 'AUTONOMOUS_EVIDENCE_NOT_MANUAL',
        reversible: true,
        hardBan: false,
        pairSpecificManualRule: false,
        reason: `${f.subject}: ALPS evidence reached REBUILD/REDUCE with stop-driven losses. Future identical hypotheses are routed to Shadow Retest only until mutation or changed evidence appears.`,
        evidence
      };
      routes.push(route);
      decisions.push({
        key: `AUTONOMOUS_ROUTE::${route.trigger}::${route.routeKey}::${stableStringify(evidence).slice(0,500)}`,
        action: route.action,
        trigger: route.trigger,
        subject: route.subject,
        severity: route.severity,
        source: route.source,
        evidence,
        reason: route.reason,
        reversible: true,
        hardBan: false
      });
    }
  }

  const view = {
    schema: 'alps.autonomousBridge.view.v1',
    version: AUTONOMY_PATCH_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'AUTONOMOUS_ROUTING',
    noManualRules: true,
    noHardPairBan: true,
    noStopWidening: false,
    noForcedClose: true,
    fullAutonomy: true,
    routingScope: 'all future paper candidates; system-only governance',
    activeRoutes: routes,
    decisions,
    summary: {
      activeRoutes: routes.length,
      shadowRetestOnly: routes.filter(r => r.action === 'SHADOW_RETEST_ONLY').length,
      manualPairRules: 0,
      hardBans: 0,
      mode: FULL_AUTONOMY_DECIDE_AND_ACT ? (routes.length ? 'FULL_AUTONOMY_ACTIVE' : 'FULL_AUTONOMY_DECIDE_AND_ACT_OBSERVING') : (routes.length ? 'ACTIVE_AUTONOMOUS_BRIDGE' : 'OBSERVE_ONLY')
    },
    note: 'The bridge does not contain manual pair names or fixed bans. It converts ALPS Cognition/AHI evidence into future routing rules only when ALPS itself reaches REBUILD/REDUCE-style evidence.'
  };
  return view;
}

async function appendAutonomyDecision(decision) {
  await loadAutonomyState();
  if (autonomyState.seenKeys.includes(decision.key)) return null;
  autonomyState.seq += 1;
  const payload = {
    seq: autonomyState.seq,
    decisionId: sha256(`${decision.key}::${autonomyState.seq}`).slice(0, 24),
    ts: new Date().toISOString(),
    version: AUTONOMY_PATCH_VERSION,
    ...decision,
    prevHash: autonomyState.prevHash
  };
  const currHash = sha256(stableStringify(payload) + autonomyState.prevHash);
  const record = { ...payload, currHash };
  await fsp.appendFile(AUTONOMY_LEDGER_FILE, JSON.stringify(record) + '\n').catch(e => log('Autonomy ledger append failed:', e.message));
  autonomyState.prevHash = currHash;
  autonomyState.seenKeys.push(decision.key);
  while (autonomyState.seenKeys.length > 1000) autonomyState.seenKeys.shift();
  return record;
}

async function updateAutonomousBridgeState(report, cognitionView) {
  await loadAutonomyState();
  await loadAutonomyMemoryState();
  const importedSeeds = await importEmbeddedAutonomyEvidenceSeedsIfNeeded();
  let view = deriveAutonomousBridgeView(report || {}, cognitionView || lastCognitionView || null);

  const memoryRoutes = (autonomyMemoryState?.activeRoutes || []).map(r => ({
    ...r,
    restoredFromPersistentMemory: true,
    hardBan: false,
    pairSpecificManualRule: false
  }));
  const mergedRoutes = mergeAutonomousRoutes(view.activeRoutes || [], autonomyState.activeRoutes || [], memoryRoutes);
  const restoredCount = mergedRoutes.filter(r => r.restoredFromPersistentMemory).length;
  view.activeRoutes = mergedRoutes;
  view.summary = {
    ...(view.summary || {}),
    activeRoutes: mergedRoutes.length,
    shadowRetestOnly: mergedRoutes.filter(r => r.action === 'SHADOW_RETEST_ONLY').length,
    manualPairRules: 0,
    hardBans: 0,
    mode: mergedRoutes.length ? (restoredCount ? 'ACTIVE_PERSISTENT_AUTONOMOUS_BRIDGE' : 'ACTIVE_AUTONOMOUS_BRIDGE') : 'OBSERVE_ONLY',
    restoredFromPersistentMemory: restoredCount,
    importedEvidenceSeeds: importedSeeds.length
  };
  view.persistentMemory = buildPersistentMemoryView(autonomyMemoryState);
  view.note = 'The bridge uses persistent ALPS system-derived evidence memory. It does not contain manual pair names or fixed bans; routes survive restarts only if ALPS evidence previously created them.';

  const appended = [];
  for (const d of view.decisions || []) {
    const rec = await appendAutonomyDecision(d);
    if (rec) appended.push(rec);
  }
  for (const r of mergedRoutes || []) {
    const d = {
      key: `PERSISTENT_ROUTE_ACTIVE::${r.trigger || 'ROUTE'}::${r.routeKey || ''}`,
      action: r.action || 'SHADOW_RETEST_ONLY',
      trigger: r.trigger || 'PERSISTENT_AUTONOMOUS_ROUTE',
      subject: r.subject || r.routeKey,
      severity: r.severity || 'HIGH',
      source: r.source || 'AUTONOMOUS_EVIDENCE_NOT_MANUAL',
      evidence: { routeKey: r.routeKey, restoredFromPersistentMemory: !!r.restoredFromPersistentMemory, evidenceSource: r.evidenceSource || r.source || 'current-system-evidence' },
      reason: r.reason || 'Persistent autonomous route is active.',
      reversible: true,
      hardBan: false
    };
    const rec = await appendAutonomyDecision(d);
    if (rec) appended.push(rec);
  }
  view.cognitionOverrides = deriveCognitionOverrides(view, cognitionView || lastCognitionView || null);
  view.fullAutonomy = buildFullAutonomyView(report || {}, cognitionView || lastCognitionView || null, view);
  view.noStopWidening = false;
  view.mode = 'AUTONOMOUS_ROUTING_DECIDE_AND_ACT';
  view.routingScope = 'all future paper candidates; system-only governance';
  view.summary.mode = view.fullAutonomy.mode === 'DECIDE_AND_ACT' ? (view.summary.activeRoutes ? 'FULL_AUTONOMY_ACTIVE' : 'FULL_AUTONOMY_DECIDE_AND_ACT_OBSERVING') : 'SHADOW_ONLY';
  view.ledger = {
    seq: autonomyState.seq,
    prevHash: autonomyState.prevHash,
    appendedThisRun: appended.length,
    path: AUTONOMY_LEDGER_FILE,
    tamperEvident: true
  };
  autonomyState.lastView = view;
  autonomyState.activeRoutes = mergedRoutes;
  lastAutonomyView = view;
  await saveAutonomyState();
  await updateAutonomyPersistentMemory(report || {}, lastTradeExport || {}, cognitionView || lastCognitionView || null, view);
  view.persistentMemory = buildPersistentMemoryView(autonomyMemoryState);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-autonomy.json'), JSON.stringify(view, null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-autonomous-memory.json'), JSON.stringify(view.persistentMemory || {}, null, 2)).catch(() => null);
  return view;
}


function buildFullAutonomyMarkdown(view = lastAutonomyView?.fullAutonomy) {
  if (!view) return '## ALPS v9.2.3 Full Autonomy Paper Lab\n- No full autonomy view yet.';
  const i = view.interventions || {}, acu = view.adaptiveCandidateUniverse || {}, wc = view.watchCollapse || {};
  const lines = [
    '',
    '## ALPS v9.2.3 Full Autonomy Paper Lab',
    `- Version: ${view.version}`,
    `- Mode: ${view.mode}`,
    `- Paper only: ${view.paperOnly ? 'YES' : 'NO'}`,
    `- Human strategic constraints removed: ${view.removeHumanStrategicConstraints ? 'YES' : 'NO'}`,
    `- Generated strategies now: ${acu.generatedNow ?? '—'}`,
    `- Monitored candidates now: ${acu.monitoredNow ?? '—'}`,
    `- Technical candidate cap: ${acu.technicalCap ?? '—'} (server safety guard, not strategy rule)`,
    `- Active autonomous routes: ${i.activeRoutes || 0}`,
    `- Suspensions: ${i.suspensions || 0}`,
    `- Stop overrides: ${i.stopOverrides || 0}`,
    `- Exposure reductions: ${i.exposureReductions || 0}`,
    `- Circuit open: ${i.circuitOpen ? 'YES' : 'NO'}`,
    '',
    '### Removed Human Constraints',
    '| Constraint | Status |',
    '|---|---|'
  ];
  for (const [k,v] of Object.entries(view.humanConstraintsRemoved || {})) lines.push(`| ${mdCell(k)} | ${v ? 'REMOVED' : 'ACTIVE'} |`);
  lines.push('', '### Preserved System Safety', '| Guard | Status |', '|---|---|');
  for (const [k,v] of Object.entries(view.preservedSystemSafety || {})) lines.push(`| ${mdCell(k)} | ${v ? 'ON' : 'OFF'} |`);
  lines.push('', '### WATCH Collapse / Duplicate Variant Control', `- Raw top rows: ${wc.rawRows ?? 0}`, `- Distinct fingerprints: ${wc.distinctFingerprints ?? 0}`, `- Clone compression: ${wc.cloneCompression ?? 0}`);
  lines.push('', '> Full Autonomy note: no human pair/frame/strategy limits are used. The only remaining limits are system safety, auditability, and paper-only circuit-breaker governance.');
  return lines.join('\n');
}

function buildAutonomyMarkdown(view = lastAutonomyView) {
  if (!view) return '## ALPS v9.2.3 Autonomous Cognition → ARI Bridge\n- No autonomy view yet.';
  const s = view.summary || {};
  const lines = [
    '',
    '## ALPS v9.2.3 Autonomous Cognition → ARI Bridge',
    `- Version: ${view.version}`,
    `- Mode: ${s.mode || view.mode}`,
    `- Persistent memory routes: ${view.persistentMemory?.activeRoutes ?? '—'}`,
    `- Restored routes: ${s.restoredFromPersistentMemory || 0}`,
    `- Imported evidence seeds: ${s.importedEvidenceSeeds || 0}`,
    `- No manual rules: ${view.noManualRules ? 'YES' : 'NO'}`,
    `- Hard pair bans: ${s.hardBans || 0}`,
    `- Active routes: ${s.activeRoutes || 0}`,
    `- Shadow-retest routes: ${s.shadowRetestOnly || 0}`,
    `- Scope: ${view.routingScope}`,
    `- Ledger seq: ${view.ledger?.seq ?? 0}`,
    '',
    '### Active Autonomous Routes',
    '| Action | Subject | Trigger | Reason |',
    '|---|---|---|---|'
  ];
  const routes = view.activeRoutes || [];
  if (!routes.length) lines.push('| — | — | — | No active route. Bridge is observing only. |');
  for (const r of routes.slice(0, 20)) {
    lines.push(`| ${mdCell(r.action)} | ${mdCell(r.subject)} | ${mdCell(r.trigger)} | ${mdCell(r.reason)} |`);
  }
  lines.push('', '> Bridge note: This is not a manual BNB filter. Any pair/timeframe/strategy can be routed only when ALPS Cognition + AHI/ARI evidence independently reaches the same failure profile.');
  return lines.join('\n');
}

async function installAutonomousBridgeInPage(view = null) {
  if (!page || page.isClosed()) return { installed: false, reason: 'page not ready' };
  await loadAutonomyState();
  const payload = view || lastAutonomyView || autonomyState?.lastView || deriveAutonomousBridgeView({}, lastCognitionView || cognitionState?.lastView || null);
  return pageEval(policy => {
    try {
      const routes = Array.isArray(policy?.activeRoutes) ? policy.activeRoutes : [];
      const overrides = policy?.cognitionOverrides && policy.cognitionOverrides.schema === 'alps.cognition.overrides.v1'
        ? policy.cognitionOverrides
        : { schema:'alps.cognition.overrides.v1', mode:'SHADOW_ONLY', suspensions:[], stopOverrides:[], exposure:[], updatedAt:Date.now(), decisionEpoch:0 };
      window.__ALPS_COGNITION_OVERRIDES = overrides;
      window.__ALPS_FULL_AUTONOMY_CONFIG__ = policy?.fullAutonomy || { mode: overrides.mode, paperOnly:true };
      try {
        localStorage.setItem('ALPS_FULL_AUTONOMY_MODE', 'DECIDE_AND_ACT');
        localStorage.setItem('ALPS_FULL_AUTONOMY_TECHNICAL_CANDIDATE_CAP', String((policy?.fullAutonomy?.adaptiveCandidateUniverse?.technicalCap) || 9999));
        localStorage.setItem('maxForwardCandidates', String((policy?.fullAutonomy?.adaptiveCandidateUniverse?.technicalCap) || 9999));
        localStorage.setItem('ALPS_MAX_FORWARD_CANDIDATES', String((policy?.fullAutonomy?.adaptiveCandidateUniverse?.technicalCap) || 9999));
        localStorage.setItem('forwardPromotedOnly', 'false');
      } catch (_) {}
      function t(v) { return String(v || '').trim(); }
      function root(strategy) {
        const s = t(strategy).toUpperCase();
        if (/HA\s*\+\s*POC|HA_POC/.test(s)) return 'HA_POC';
        if (/EMA\s+TREND|EMA_TREND/.test(s)) return 'EMA_TREND';
        if (/VAH\/VAL|VAH_VAL/.test(s)) return 'VAH_VAL';
        if (/BB\s+SQUEEZE|BB_SQUEEZE/.test(s)) return 'BB_SQUEEZE';
        if (/BOLLINGER/.test(s)) return 'BOLLINGER';
        return s.replace(/G\d+\s+/g, '').replace(/\s*\+\s*NO EXTRA FILTER/g, '').slice(0, 80) || 'UNKNOWN_STRATEGY';
      }
      function regime(x) {
        const raw = t(x?.regime?.regime || x?.marketRegime || x?.regime || x?.regimeSummary || x?.regimeDetail || 'UNKNOWN_REGIME');
        return raw.split('/').slice(0, 3).map(p => p.trim()).join(' / ') || 'UNKNOWN_REGIME';
      }
      function norm(x) {
        const fp = x?.fingerprint || {};
        return {
          pair: t(x?.pair || x?.baseSymbol || fp.pair || (x?.sym ? String(x.sym).split('_')[0] : '')).toUpperCase(),
          timeframe: t(x?.timeframe || x?.tf || fp.timeframe || (x?.sym ? String(x.sym).split('_')[1] : '')),
          root: root(x?.rootStrategy || x?.rootStratId || fp.rootId || fp.rootName || x?.strategy || x?.stratName || x?.name),
          direction: t(x?.direction || x?.dir || x?.side || x?.bias || 'LONG').toUpperCase(),
          regime: regime(x)
        };
      }
      function key(n) { return [n.pair, n.timeframe, n.root, n.direction, n.regime].map(x => t(x).toUpperCase()).join('||'); }
      function match(x) {
        if (!x || typeof x !== 'object') return null;
        const k = key(norm(x));
        return routes.find(r => t(r.routeKey).toUpperCase() === k) || null;
      }
      function shadowOnly(x) { return !!match(x); }
      function routedReturn(x, route) {
        return {
          blocked: true,
          action: 'SHADOW_RETEST_ONLY',
          source: 'ALPS_AUTONOMOUS_COGNITION_ARI_BRIDGE',
          hardBan: false,
          manualRule: false,
          routeKey: route.routeKey,
          reason: route.reason,
          original: x && typeof x === 'object' ? { pair: x.pair || x.baseSymbol || x.sym, timeframe: x.timeframe, strategy: x.strategy || x.stratName || x.rootStrategy } : null
        };
      }
      function regimeMatch(sel, actual) {
        if (!sel || sel === '*') return true;
        const want = String(sel).split('|').map(s=>s.trim().toUpperCase()).filter(Boolean);
        const have = new Set(String(actual || '').split(/[|,/\s]+/).map(s=>s.trim().toUpperCase()).filter(Boolean));
        return want.every(w => have.has(w));
      }
      function overrideMatch(m, x) {
        const n = norm(x);
        if (!m) return false;
        const pairOk = !m.pair || m.pair === '*' || t(m.pair).toUpperCase() === n.pair;
        const tfOk = !m.timeframe || m.timeframe === '*' || t(m.timeframe).toLowerCase() === t(n.timeframe).toLowerCase();
        const rootOk = !m.root || m.root === '*' || t(m.root).toUpperCase() === n.root;
        const dirOk = !m.direction || m.direction === '*' || t(m.direction).toUpperCase() === n.direction;
        const strategyOk = !m.strategy || m.strategy === '*' || t(m.strategy).toUpperCase().includes(n.root) || n.root.includes(t(m.strategy).split(/\s+/)[0].toUpperCase());
        return pairOk && tfOk && rootOk && dirOk && strategyOk && regimeMatch(m.regime, n.regime);
      }
      window.__alpsApplyCognition = function(sig) {
        const out = { suppressed:false, stopAtrMult:null, minStopDistBps:null, sizeMult:1, appliedDecisionIds:[], reasons:[] };
        const c = window.__ALPS_COGNITION_OVERRIDES;
        if (!c || c.schema !== 'alps.cognition.overrides.v1' || c.mode !== 'DECIDE_AND_ACT') return out;
        const now = Date.now();
        for (const s of (c.suspensions || [])) {
          if ((s.expiresAt || 0) > now && overrideMatch(s.match, sig)) {
            out.suppressed = true; out.appliedDecisionIds.push(s.decisionId); out.reasons.push(s.reason); return out;
          }
        }
        for (const so of (c.stopOverrides || [])) {
          if ((so.expiresAt || 0) > now && overrideMatch(so.match, sig)) {
            out.stopAtrMult = so.stopAtrMult == null ? null : Number(so.stopAtrMult);
            out.minStopDistBps = so.minStopDistBps == null ? null : Number(so.minStopDistBps);
            out.appliedDecisionIds.push(so.decisionId); out.reasons.push(so.reason); break;
          }
        }
        for (const e of (c.exposure || [])) {
          if ((e.expiresAt || 0) > now && overrideMatch(e.match, sig)) {
            out.sizeMult = Number(e.sizeMult || 1); out.appliedDecisionIds.push(e.decisionId); out.reasons.push(e.reason); break;
          }
        }
        return out;
      };
      function applyOverrideMutation(x, cog) {
        if (!x || typeof x !== 'object' || !cog || !cog.appliedDecisionIds?.length) return x;
        try {
          x.__alpsCognition = { appliedDecisionIds: cog.appliedDecisionIds, reasons: cog.reasons, version: policy.version, paperOnly:true };
          if (cog.minStopDistBps != null) { x.minStopDistBps = cog.minStopDistBps; x.cognitionMinStopDistBps = cog.minStopDistBps; }
          if (cog.stopAtrMult != null) { x.stopAtrMult = cog.stopAtrMult; x.cognitionStopAtrMult = cog.stopAtrMult; }
          if (cog.sizeMult != null) { x.sizeMult = (Number(x.sizeMult || 1) * cog.sizeMult); x.cognitionSizeMult = cog.sizeMult; }
        } catch (_) {}
        return x;
      }
      const bridge = {
        version: policy.version,
        installedAt: new Date().toISOString(),
        activeRoutes: routes,
        normalize: norm,
        routeKey: x => key(norm(x)),
        match,
        shouldShadowRetest: shadowOnly,
        routeObject(x) { const r = match(x); return r ? routedReturn(x, r) : null; }
      };
      window.__ALPS_AUTONOMOUS_COGNITION_BRIDGE_POLICY__ = policy;
      window.__ALPS_AUTONOMOUS_COGNITION_BRIDGE__ = bridge;
      window.__ALPS_SHOULD_SHADOW_RETEST__ = shadowOnly;
      window.__ALPS_AUTONOMOUS_ROUTE_CANDIDATE__ = (x) => bridge.routeObject(x);
      try { localStorage.setItem('ALPS_AUTONOMOUS_COGNITION_BRIDGE_POLICY', JSON.stringify(policy)); } catch (_) {}

      const wrapped = [];
      const listFns = ['selectForwardCandidates','buildForwardCandidates','getForwardCandidates','rankForwardCandidates','getFocusedPaperCandidates','pickForwardCandidates','eligibleForwardCandidates'];
      const openFns = ['openPaperSignal','registerPaperSignal','pushPaperSignal','createPaperSignal','openForwardSignal','openForwardTrade','maybeOpenPaperSignal','tryOpenForwardCandidate','maybeOpenForwardSignal','executeForwardCandidate','openPaperPosition'];
      function wrapList(name) {
        const fn = window[name];
        if (typeof fn !== 'function' || fn.__alpsAutonomousBridgeWrapped) return;
        const w = function(...args) {
          const out = fn.apply(this, args);
          const filter = v => Array.isArray(v) ? v.filter(x => !(window.__alpsApplyCognition(x).suppressed || shadowOnly(x))) : v;
          if (out && typeof out.then === 'function') return out.then(filter);
          return filter(out);
        };
        w.__alpsAutonomousBridgeWrapped = true;
        w.__original = fn;
        window[name] = w;
        wrapped.push(name);
      }
      function wrapOpen(name) {
        const fn = window[name];
        if (typeof fn !== 'function' || fn.__alpsAutonomousBridgeWrapped) return;
        const w = function(...args) {
          const hitArg = args.find(a => (window.__alpsApplyCognition(a).suppressed || shadowOnly(a)));
          if (hitArg) return routedReturn(hitArg, match(hitArg) || { routeKey: bridge.routeKey(hitArg), reason: (window.__alpsApplyCognition(hitArg).reasons||[]).join('; ') || 'Suppressed by Full Autonomy Cognition.' });
          for (const a of args) applyOverrideMutation(a, window.__alpsApplyCognition(a));
          return fn.apply(this, args);
        };
        w.__alpsAutonomousBridgeWrapped = true;
        w.__original = fn;
        window[name] = w;
        wrapped.push(name);
      }
      listFns.forEach(wrapList);
      openFns.forEach(wrapOpen);
      return { installed: true, activeRoutes: routes.length, wrapped, version: policy.version, cognitionOverrideMode: overrides.mode, suspensions: (overrides.suspensions||[]).length, stopOverrides: (overrides.stopOverrides||[]).length, exposure: (overrides.exposure||[]).length, fullAutonomy: true };
    } catch (e) {
      return { installed: false, error: e.message };
    }
  }, payload);
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
      if (url.pathname === '/runner/health') { await loadRecoveryState(); await loadTradeVaultState(); await loadCognitionState(); await loadAutonomyState(); await loadAutonomyMemoryState(); return send(res, 200, { ...lastHealth, browserServerReady, recovery: buildRecoveryView(), tradeVault: { currentCounts: tradeExportCounts(lastTradeExport), hasLastNonZero: !!tradeVaultState?.lastNonZero, historyCount: tradeVaultState?.history?.length || 0 }, cognition: { version: COGNITION_PATCH_VERSION, summary: lastCognitionView?.summary || cognitionState?.lastView?.summary || null, ledgerSeq: cognitionState?.seq || 0, hashHead: cognitionState?.prevHash || 'GENESIS' }, autonomousBridge: { version: AUTONOMY_PATCH_VERSION, summary: lastAutonomyView?.summary || autonomyState?.lastView?.summary || null, activeRoutes: (lastAutonomyView?.activeRoutes || autonomyState?.activeRoutes || autonomyMemoryState?.activeRoutes || []).length, ledgerSeq: autonomyState?.seq || 0, hashHead: autonomyState?.prevHash || 'GENESIS', persistentMemory: buildPersistentMemoryView(autonomyMemoryState), fullAutonomy: lastAutonomyView?.fullAutonomy || autonomyState?.lastView?.fullAutonomy || null } }); }
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
      if (url.pathname === '/runner/full-autonomy.json') {
        await loadAutonomyState();
        await collectReport().catch(() => null);
        return send(res, 200, lastAutonomyView?.fullAutonomy || autonomyState.lastView?.fullAutonomy || { error: 'No full autonomy view yet' });
      }
      if (url.pathname === '/runner/full-autonomy.md') {
        await loadAutonomyState();
        await collectReport().catch(() => null);
        return send(res, 200, buildFullAutonomyMarkdown(lastAutonomyView?.fullAutonomy || autonomyState.lastView?.fullAutonomy), 'text/markdown; charset=utf-8');
      }
      if (url.pathname === '/runner/autonomy.json') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        await loadAutonomyState();
        await collectReport().catch(() => null);
        return send(res, 200, lastAutonomyView || autonomyState.lastView || { error: 'No autonomy view yet' });
      }
      if (url.pathname === '/runner/autonomy.md') {
        if (!isAuthed(req)) return send(res, 401, 'Unauthorized', 'text/plain; charset=utf-8');
        await loadAutonomyState();
        await collectReport().catch(() => null);
        return send(res, 200, buildAutonomyMarkdown(lastAutonomyView || autonomyState.lastView), 'text/markdown; charset=utf-8');
      }
      if (url.pathname === '/runner/autonomous-memory.json') {
        await loadAutonomyMemoryState();
        await collectReport().catch(() => null);
        return send(res, 200, buildPersistentMemoryView(autonomyMemoryState));
      }
      if (url.pathname === '/runner/autonomy-ledger.json') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        await loadAutonomyState();
        const raw = await fsp.readFile(AUTONOMY_LEDGER_FILE, 'utf8').catch(() => '');
        const rows = raw.split('\n').filter(Boolean).slice(-200).map(line => { try { return JSON.parse(line); } catch (_) { return { raw: line }; } });
        return send(res, 200, { schema: 'alps.autonomousBridge.ledger.tail.v1', version: AUTONOMY_PATCH_VERSION, seq: autonomyState.seq, hashHead: autonomyState.prevHash, rows });
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
    await installAutonomousBridgeInPage().catch(e => log('Autonomous bridge install before catch-up failed:', e.message));

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
  report.alpsAutonomousBridge = await updateAutonomousBridgeState(report, report.alpsCognition);
  report.autonomousBridgeInstall = await installAutonomousBridgeInPage(report.alpsAutonomousBridge).catch(e => ({ installed: false, error: e.message }));

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
  md = `${md}\n\n${buildTradesMarkdown(lastTradeExport)}\n\n${buildTradeVaultMarkdown()}\n\n${buildCognitionMarkdown(report.alpsCognition)}\n\n${buildAutonomyMarkdown(report.alpsAutonomousBridge)}`;
  md = appendRecoveryMarkdown(md);
  lastReportMarkdown = md;
  lastHealth.lastReportAt = Date.now();
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-report.json'), JSON.stringify(report, null, 2));
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-report.md'), md);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-trades.json'), JSON.stringify(lastTradeExport, null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-trades-vault.json'), JSON.stringify(buildTradeVaultView(), null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-autonomy.json'), JSON.stringify(report.alpsAutonomousBridge || {}, null, 2)).catch(() => null);
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
  if (command === 'autonomy') { await collectReport().catch(() => null); return { ok: true, autonomousBridge: lastAutonomyView || autonomyState?.lastView || null }; }
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
