#!/usr/bin/env node
'use strict';

/**
 * ALPS Server Runner — v9.3.1 Decision Intelligence Spec
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
const RECOVERY_PATCH_VERSION = 'v9.3.1-decision-intelligence-spec';
const RECOVERY_STATE_FILE = path.join(DATA_DIR, 'recovery-state.json');
const RECOVERY_SEED_FILE = path.join(__dirname, 'recovery', 'previous-ledger-seed.json');
const TRADE_VAULT_FILE = path.join(DATA_DIR, 'trade-vault.json');
const TRADE_VAULT_SEED_FILE = path.join(__dirname, 'recovery', 'previous-trade-vault-seed.json');
const COGNITION_PATCH_VERSION = 'v9.3.1-decision-intelligence-spec';
const COGNITION_STATE_FILE = path.join(DATA_DIR, 'cognition-state.json');
const COGNITION_LEDGER_FILE = path.join(DATA_DIR, 'cognition-decision-ledger.jsonl');
const AUTONOMY_PATCH_VERSION = 'v9.3.1-decision-intelligence-spec';
const AUTONOMY_STATE_FILE = path.join(DATA_DIR, 'autonomous-bridge-state.json');
const AUTONOMY_MEMORY_FILE = path.join(DATA_DIR, 'autonomous-evidence-memory.json');
const AUTONOMY_LEDGER_FILE = path.join(DATA_DIR, 'autonomous-bridge-ledger.jsonl');
const EMBEDDED_PREVIOUS_TRADE_VAULT_SEED = {
  "source": "ALPS_AHI_Command_Report_2026-07-03_13-18.md",
  "note": "Previous known ALPS paper-forward trades before ALPS trade export sync. Historical continuity only; not current positions.",
  "export": {
    "schema": "alps.runner.tradeExport.v1",
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
    "schema": "alps.runner.tradeExport.v1",
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
    "note": "Exported from ALPS server runner for ALPS reports. Fingerprints are not treated as executable trades."
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


// ALPS v9.3.1 Decision Intelligence Spec
// Final integrated layer built from stable v9.2.2. It is paper-only, boot-safe, and fails back to the stable runner.
const FINAL_V930_VERSION = 'v9.3.1-decision-intelligence-spec';
const FINAL_V930_TECHNICAL_CAP = Number(process.env.ALPS_V930_TECHNICAL_CAP || 360);
let lastNativeForwardPoolView = null;
let lastFullAutonomyView = null;
let lastEngineHookView = null;
let lastCircuitBreakerView = null;
let lastCounterfactualView = null;
let lastChartView = null;

function safeArray(value) { return Array.isArray(value) ? value : []; }
function textValue(value) { return String(value == null ? '' : value); }
function boolValue(value) { return !!value; }
function uniqueKeyFromCandidate(c = {}) {
  return [c.sym || c.pair || c.baseSymbol || '', c.timeframe || c.tf || '', c.strategy || c.stratName || c.name || '', c.exit || c.exitName || ''].map(textValue).join('||').toUpperCase();
}
function candidateEvidenceLabels(c = {}) {
  const raw = [c.forwardBlockReason, c.robustnessReason, c.sampleFlag, c.promotionTier, c.rawVerdict, c.effectiveVerdict, c.robustnessFinal]
    .concat(safeArray(c.promotionReasons)).map(textValue).filter(Boolean).join(' | ');
  const labels = [];
  if (/LAB_ONLY/i.test(raw)) labels.push('LAB_ONLY');
  if (/sample|LOW_SAMPLE|OOS/i.test(raw)) labels.push('SAMPLE');
  if (/DD|drawdown/i.test(raw)) labels.push('DRAWDOWN');
  if (/PF gate|PF/i.test(raw)) labels.push('PF_GATE');
  if (/WATCH/i.test(raw)) labels.push('WATCH');
  if (/DISCARD/i.test(raw)) labels.push('DISCARD_CONTEXT');
  if (/ROBUST/i.test(raw)) labels.push('ROBUSTNESS_CONTEXT');
  return [...new Set(labels)];
}
function candidateSafetyReason(c = {}) {
  const raw = [c.forwardBlockReason, c.lastRejectedReason, c.reason, c.blockReason, c.freshness, c.status, c.dataStatus]
    .concat(safeArray(c.promotionReasons)).map(textValue).join(' | ').toUpperCase();
  if (/EMERGENCY/.test(raw)) return 'EMERGENCY_STOP';
  if (/NOT_LATEST_CLOSED_CANDLE|STALE|FRESHNESS|DELAYED|TOO_OLD/.test(raw)) return 'FRESHNESS_OR_CLOSED_CANDLE';
  if (/BAD_DATA|DATA_FAIL|FAILED DATA|GAP|DUPLICATE CANDLE|MISSING_CANDLE|NO_CANDLE|INVALID_PRICE|NAN|INFINITE/.test(raw)) return 'DATA_OR_PRICE_GUARD';
  if (/DUPLICATE_SIGNAL|SAME_SETUP|LITERAL_DUPLICATE/.test(raw)) return 'DUPLICATE_SETUP_GUARD';
  return '';
}
function autonomyRouteMatchesCandidate(route = {}, c = {}) {
  const pair = textValue(c.pair || c.baseSymbol || c.symbol || c.sym).toUpperCase();
  const tf = textValue(c.timeframe || c.tf).toUpperCase();
  const strat = textValue(c.strategy || c.stratName || c.name).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const rpair = textValue(route.pair).toUpperCase();
  const rtf = textValue(route.timeframe).toUpperCase();
  const rroot = textValue(route.root || route.strategy).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return (!rpair || pair.includes(rpair)) && (!rtf || tf === rtf) && (!rroot || strat.includes(rroot));
}
function classifyCandidateV930(c = {}, routes = []) {
  const safety = candidateSafetyReason(c);
  const labels = candidateEvidenceLabels(c);
  if (safety) return { tier: safety === 'DATA_OR_PRICE_GUARD' ? 'DATA_BLOCKED' : 'SAFETY_BLOCKED', safetyReason: safety, evidenceLabels: labels };
  const suspended = routes.find(r => String(r.action || '').toUpperCase().includes('SHADOW') && autonomyRouteMatchesCandidate(r, c));
  if (suspended) return { tier: 'COGNITION_SUSPENDED', safetyReason: '', evidenceLabels: labels.concat(['COGNITION_ROUTE']), routeKey: suspended.routeKey || '' };
  if (c.forwardEligible === true || /WATCHLIST|FORWARD/i.test(textValue(c.promotionTier))) return { tier: 'WATCH_FORWARD', safetyReason: '', evidenceLabels: labels };
  if (/WATCH|ROBUSTNESS_WATCH|KEEP/i.test([c.rawVerdict, c.effectiveVerdict, c.robustnessFinal].map(textValue).join('|'))) return { tier: 'FULL_AUTONOMY_FORWARD', safetyReason: '', evidenceLabels: labels.concat(['PROMOTED_BY_AUTONOMY']) };
  if (/DISCARD/i.test([c.rawVerdict, c.effectiveVerdict].map(textValue).join('|')) && Number(c.oosPF || 0) > 1 && Number(c.oosTrades || 0) >= 10) return { tier: 'RESEARCH_SANDBOX', safetyReason: '', evidenceLabels: labels.concat(['SANDBOX_RETEST']) };
  return { tier: 'RESEARCH_SANDBOX', safetyReason: '', evidenceLabels: labels };
}
function buildNativeForwardPoolView(report = {}, routes = []) {
  const top = safeArray(report?.research?.topStrategies);
  const selected = [];
  const seen = new Set();
  for (const c of top) {
    const key = uniqueKeyFromCandidate(c);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cls = classifyCandidateV930(c, routes);
    selected.push({
      key,
      pair: c.pair || c.baseSymbol || (textValue(c.sym).split('_')[0] || ''),
      timeframe: c.timeframe || '',
      strategy: c.strategy || c.stratName || '',
      exit: c.exit || c.exitName || '',
      tier: cls.tier,
      safetyReason: cls.safetyReason,
      evidenceLabels: cls.evidenceLabels,
      oosPF: c.oosPF,
      oosTrades: c.oosTrades,
      totalTrades: c.totalTrades,
      ddBps: c.oosDD,
      score: c.score,
      originalPromotionTier: c.promotionTier,
      originalForwardEligible: c.forwardEligible === true,
      originalBlockReason: c.forwardBlockReason || ''
    });
    if (selected.length >= FINAL_V930_TECHNICAL_CAP) break;
  }
  const count = tier => selected.filter(x => x.tier === tier).length;
  const view = {
    schema: 'alps.nativeForwardPool.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    technicalCap: FINAL_V930_TECHNICAL_CAP,
    totalCandidates: selected.length,
    generatedStrategies: Number(report?.research?.strategies || report?.forwardWatch?.totalGeneratedStrategies || top.length || 0),
    fullAutonomyForward: count('FULL_AUTONOMY_FORWARD'),
    watchForward: count('WATCH_FORWARD'),
    researchSandbox: count('RESEARCH_SANDBOX'),
    cognitionSuspended: count('COGNITION_SUSPENDED'),
    safetyBlocked: count('SAFETY_BLOCKED'),
    dataBlocked: count('DATA_BLOCKED'),
    promotedByFullAutonomy: count('FULL_AUTONOMY_FORWARD'),
    blockedBySafety: count('SAFETY_BLOCKED') + count('DATA_BLOCKED'),
    evidenceLabels: [...new Set(selected.flatMap(x => x.evidenceLabels || []))],
    candidates: selected.slice(0, 50),
    note: 'Sample, DD, PF, LAB_ONLY and robustness labels are evidence tags. Only operational safety remains a hard block.'
  };
  return view;
}
function buildFullAutonomyView(report = {}, nativeView = null, routes = []) {
  return {
    schema: 'alps.fullAutonomy.view.v1',
    version: FINAL_V930_VERSION,
    enabled: true,
    mode: 'DECIDE_AND_ACT_PAPER_ONLY',
    paperOnly: true,
    liveCapitalExecution: false,
    humanStrategicRestrictionsRemoved: {
      fixedTradeCount: true,
      fixedPairPreference: true,
      fixedTimeframePreference: true,
      manualPatternBlocks: true,
      manualExposureBudget: true,
      fixedRobustWatchDependency: true,
      fixedCandidateCapAsStrategy: true
    },
    safetyGuardsPreserved: {
      closedCandleOnly: true,
      freshSignalOnly: true,
      badDataGuard: true,
      duplicateSignalGuard: true,
      storageProtection: true,
      emergencyStop: true,
      paperOnlyBoundary: true
    },
    allowedActions: ['OPEN_PAPER','HOLD','REDUCE_EXPOSURE','SHADOW_RETEST','REBUILD','SUSPEND_PATTERN','STOP_REVIEW','WAIT_FOR_EVIDENCE'],
    decisions: [],
    lastDecision: nativeView?.promotedByFullAutonomy ? 'FULL_AUTONOMY_FORWARD_POOL_READY' : 'WAIT_FOR_EVIDENCE',
    nativeForwardPool: {
      totalCandidates: nativeView?.totalCandidates || 0,
      promotedByFullAutonomy: nativeView?.promotedByFullAutonomy || 0,
      blockedBySafety: nativeView?.blockedBySafety || 0
    },
    activeEvidenceRoutes: safeArray(routes).length
  };
}
function buildEngineHookView(pageStatus = {}) {
  return {
    schema: 'alps.engineHook.view.v1',
    version: FINAL_V930_VERSION,
    installed: boolValue(pageStatus.installed),
    safe: pageStatus.safe !== false,
    lastError: pageStatus.lastError || '',
    wrappedFunctions: safeArray(pageStatus.wrappedFunctions),
    fallbackActive: boolValue(pageStatus.fallbackActive),
    bootSafe: true,
    reportSafe: true
  };
}
function buildCounterfactualView(report = {}) {
  const closed = Number(report?.forwardWatch?.closedTrades || report?.intelligence?.ledger?.closed || 0);
  return {
    schema: 'alps.counterfactual.view.v1',
    version: FINAL_V930_VERSION,
    enabled: true,
    actualMeanR: null,
    shadowMeanR: null,
    edgeR: null,
    n: closed,
    rollbackRecommended: false,
    note: 'Counterfactual values populate after matched autonomous and baseline paper outcomes.'
  };
}
function buildCircuitBreakerView(reason = '', disabledModules = []) {
  return {
    schema: 'alps.circuitBreaker.view.v1',
    version: FINAL_V930_VERSION,
    enabled: true,
    open: !!reason,
    reason: reason || '',
    lastTriggeredAt: reason ? new Date().toISOString() : null,
    fallbackMode: reason ? 'STABLE_PAPER_FORWARD' : 'ADVANCED_MODULES_ACTIVE',
    disabledModules: disabledModules || []
  };
}
function buildChartView(report = {}) {
  const fw = report?.forwardWatch || {};
  const trades = safeArray(fw.recentSignals);
  const first = trades[0] || safeArray(report?.research?.topStrategies)[0] || {};
  return {
    schema: 'alps.chart.view.v1',
    version: FINAL_V930_VERSION,
    ready: true,
    selectedPair: first.pair || first.baseSymbol || 'BTCUSDT',
    selectedTimeframe: first.timeframe || '1h',
    candlesLoaded: Number(report?.data?.candlesLoaded || 0),
    candidateTradesShown: safeArray(report?.research?.topStrategies).length,
    openTradesShown: Number(fw.openPositions || 0),
    closedTradesShown: Number(fw.closedTrades || 0),
    lastError: ''
  };
}


// ALPS v9.3.1 Decision Intelligence Spec
// Adds three decision-layer controls above the stable v9.3.0 runtime:
// 1) cluster dedup before the forward pool, 2) quantitative FULL_AUTONOMY_FORWARD promotion,
// 3) mutation stagnation governor that moves selection budget to exploration.
function v931Num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function v931Round(value, digits = 2) {
  const n = v931Num(value, null);
  if (n == null) return 'NA';
  const p = Math.pow(10, digits);
  return String(Math.round(n * p) / p);
}
function v931StrategyRoot(c = {}) {
  const raw = textValue(c.strategy || c.stratName || c.name || '').toUpperCase();
  if (/HA|HEIKIN/.test(raw) && /POC/.test(raw)) return 'HA_POC';
  if (/BB|BOLLINGER|SQUEEZE/.test(raw)) return /REVERSAL/.test(raw) ? 'BOLLINGER_REVERSAL' : 'BB_SQUEEZE';
  if (/EMA|TREND 20|20\/50|TREND/.test(raw)) return 'EMA_TREND';
  if (/VAH|VAL|VALUE/.test(raw)) return 'VAH_VAL';
  if (/POC/.test(raw)) return 'POC';
  if (/HEIKIN|ASHI/.test(raw)) return 'HEIKIN_ASHI';
  return raw.replace(/G\d+/g, ' ').replace(/NO EXTRA FILTER|SLOW FRAME|BELOW POC|ABOVE POC|NEAR SWING LOW|4H BEARISH|4H BULLISH|HA BEAR|HA BULL|HIGH VOLUME|NOT RANGE|EXPANSION|STRONG BEAR STACK|STRONG BULL STACK/g, ' ').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'GENERIC';
}
function v931ClusterKey(c = {}) {
  const pair = textValue(c.pair || c.baseSymbol || c.symbol || c.sym).toUpperCase().split('_')[0];
  const tf = textValue(c.timeframe || c.tf).toUpperCase();
  const exit = textValue(c.exit || c.exitName || '').toUpperCase().replace(/[^A-Z0-9.]+/g, '_').slice(0, 24);
  return [pair, tf, v931StrategyRoot(c), exit, 'PF' + v931Round(c.oosPF, 2), 'OOS' + v931Round(c.oosTrades, 0)].join('|');
}
function v931PosteriorPFProbability(pf, nEff) {
  const p = v931Num(pf, 0);
  const n = Math.max(0, v931Num(nEff, 0));
  if (!(p > 0) || !(n > 0)) return 0;
  const z = Math.log(Math.max(p, 0.0001)) * Math.sqrt(Math.max(1, n)) / 1.15;
  return Math.max(0, Math.min(1, 1 / (1 + Math.exp(-z))));
}
function v931AttachRobustnessMetrics(rows = [], report = {}) {
  const robustRows = safeArray(report?.research?.topRobustness);
  if (!robustRows.length) return rows;
  const byLooseKey = new Map();
  for (const r of robustRows) {
    const k = [r.baseSymbol || textValue(r.sym).split('_')[0] || '', r.timeframe || '', r.stratName || '', r.exitName || ''].map(textValue).join('||').toUpperCase();
    byLooseKey.set(k, r);
  }
  return rows.map(c => {
    const k = [c.pair || c.baseSymbol || textValue(c.sym).split('_')[0] || '', c.timeframe || '', c.strategy || c.stratName || '', c.exit || c.exitName || ''].map(textValue).join('||').toUpperCase();
    const r = byLooseKey.get(k);
    if (r) {
      if (c.rollingMinPF == null && r.rollingMinPF != null) c.rollingMinPF = r.rollingMinPF;
      if (c.stress5 == null && r.stress5 != null) c.stress5 = r.stress5;
      if (c.mcDD95 == null && r.mcDD95 != null) c.mcDD95 = r.mcDD95;
    }
    return c;
  });
}
function v931EvidenceMetrics(c = {}) {
  const oosPF = v931Num(c.oosPF, 0);
  const oosTrades = v931Num(c.oosTrades, 0);
  const totalTrades = v931Num(c.totalTrades, 0);
  const clusterSize = Math.max(1, v931Num(c.__alpsV931ClusterSize, 1));
  const nEffOOS = Math.max(0, Math.min(oosTrades || 0, Math.round((oosTrades || 0) / Math.sqrt(clusterSize))));
  const rolling = v931Num(c.rollingMinPF ?? c.rolling ?? c.robustnessRolling, null);
  const stress5 = v931Num(c.stress5 ?? c.robustnessStress5, null);
  const posteriorPFgt1 = v931PosteriorPFProbability(oosPF, nEffOOS);
  const rollingPass = rolling == null ? (oosPF >= 1.8 && (stress5 == null || stress5 >= 1.2)) : rolling >= 0.60;
  const posteriorPass = posteriorPFgt1 >= 0.90;
  const samplePass = nEffOOS >= 25;
  const pfPass = oosPF >= 1.25;
  const promote = samplePass && posteriorPass && rollingPass && pfPass;
  const reason = promote
    ? 'QUANT_PASS: nEff_OOS>=25, P(PF>1)>=0.90, rolling/stress pass'
    : `WAIT: nEff=${nEffOOS}/25, posterior=${posteriorPFgt1.toFixed(2)}/0.90, rollingPass=${rollingPass}, PF=${oosPF.toFixed(2)}`;
  return { oosPF, oosTrades, totalTrades, nEffOOS, clusterSize, rollingMinPF: rolling, stress5, posteriorPFgt1, rollingPass, posteriorPass, samplePass, pfPass, promote, reason };
}
function v931RankCandidate(c = {}) {
  const m = v931EvidenceMetrics(c);
  const score = v931Num(c.score, 0);
  const dd = v931Num(c.oosDD ?? c.ddBps, 0);
  const forwardBonus = (c.forwardEligible === true || /WATCHLIST|FORWARD/i.test(textValue(c.promotionTier))) ? 30 : 0;
  return score + (m.posteriorPFgt1 * 100) + (m.oosPF * 10) + (m.nEffOOS * 0.4) + forwardBonus - (dd / 5000);
}
function v931DedupCandidates(rows = [], report = {}, cap = FINAL_V930_TECHNICAL_CAP) {
  const enriched = v931AttachRobustnessMetrics(safeArray(rows).filter(Boolean), report);
  const clusters = new Map();
  for (const c of enriched) {
    const ck = v931ClusterKey(c);
    const current = clusters.get(ck);
    if (!current || v931RankCandidate(c) > v931RankCandidate(current.rep)) {
      clusters.set(ck, { key: ck, rep: c, members: current ? current.members.concat([c]) : [c] });
    } else {
      current.members.push(c);
    }
  }
  const selected = [];
  const clusterViews = [];
  for (const cluster of clusters.values()) {
    try {
      cluster.rep.__alpsV931ClusterKey = cluster.key;
      cluster.rep.__alpsV931ClusterSize = cluster.members.length;
      cluster.rep.__alpsV931ClusterRepresentative = true;
    } catch (_) {}
    selected.push(cluster.rep);
    if (cluster.members.length > 1) clusterViews.push({ key: cluster.key, size: cluster.members.length, representative: uniqueKeyFromCandidate(cluster.rep) });
  }
  selected.sort((a, b) => v931RankCandidate(b) - v931RankCandidate(a));
  return {
    rows: selected.slice(0, cap),
    stats: {
      method: 'CLUSTER_REPRESENTATIVE_BEFORE_FORWARD_POOL',
      rawRows: enriched.length,
      clusters: clusters.size,
      selectedRows: Math.min(selected.length, cap),
      compressedRows: Math.max(0, enriched.length - clusters.size),
      topClusters: clusterViews.sort((a, b) => b.size - a.size).slice(0, 12)
    }
  };
}
function v931BuildMutationGovernor(report = {}) {
  const logs = safeArray(report?.recentLogs || report?.logs || []);
  let zeroImprovementLogs = 0;
  let consecutiveZeroImprovement = 0;
  let missingEdgeGenerated = 0;
  for (const line of logs) {
    const text = textValue(line);
    if (/0 improvements/i.test(text)) {
      zeroImprovementLogs += 1;
      consecutiveZeroImprovement += 1;
    }
    const m = text.match(/Missing Edge:\s*(\d+)\s*hypotheses/i);
    if (m) missingEdgeGenerated += Number(m[1] || 0);
  }
  const active = consecutiveZeroImprovement >= 12 || zeroImprovementLogs >= 12;
  return {
    schema: 'alps.mutationGovernor.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    mode: active ? 'EXPLORATION_REBALANCE' : 'NORMAL_MUTATION',
    active,
    zeroImprovementLogs,
    consecutiveZeroImprovement,
    missingEdgeGenerated,
    trigger: active ? 'ZERO_IMPROVEMENT_STAGNATION' : '',
    action: active ? 'Reallocate forward-selection budget to cluster representatives, under-covered pairs/families/exits, and RESEARCH_SANDBOX representatives. Underlying research loop is not stopped unless the browser engine exposes a verified mutation control function.' : 'Observe',
    note: 'This governor controls decision/selection budget safely. It does not fake KEEP or force trades.'
  };
}

function classifyCandidateV930(c = {}, routes = []) {
  const safety = candidateSafetyReason(c);
  const labels = candidateEvidenceLabels(c);
  const metrics = v931EvidenceMetrics(c);
  const qLabels = labels.concat(metrics.promote ? ['QUANT_PASS'] : ['QUANT_WAIT']);
  if (safety) return { tier: safety === 'DATA_OR_PRICE_GUARD' ? 'DATA_BLOCKED' : 'SAFETY_BLOCKED', safetyReason: safety, evidenceLabels: qLabels, quantitative: metrics };
  const suspended = routes.find(r => String(r.action || '').toUpperCase().includes('SHADOW') && autonomyRouteMatchesCandidate(r, c));
  if (suspended) return { tier: 'COGNITION_SUSPENDED', safetyReason: '', evidenceLabels: qLabels.concat(['COGNITION_ROUTE']), routeKey: suspended.routeKey || '', quantitative: metrics };
  if (c.forwardEligible === true || /WATCHLIST|FORWARD/i.test(textValue(c.promotionTier))) return { tier: 'WATCH_FORWARD', safetyReason: '', evidenceLabels: qLabels, quantitative: metrics };
  if (metrics.promote) return { tier: 'FULL_AUTONOMY_FORWARD', safetyReason: '', evidenceLabels: qLabels.concat(['PROMOTED_BY_AUTONOMY']), quantitative: metrics };
  if (/WATCH|ROBUSTNESS_WATCH|KEEP/i.test([c.rawVerdict, c.effectiveVerdict, c.robustnessFinal].map(textValue).join('|'))) return { tier: 'RESEARCH_SANDBOX', safetyReason: '', evidenceLabels: qLabels.concat(['WAITING_FOR_QUANT_EVIDENCE']), quantitative: metrics };
  if (/DISCARD/i.test([c.rawVerdict, c.effectiveVerdict].map(textValue).join('|')) && Number(c.oosPF || 0) > 1 && Number(c.oosTrades || 0) >= 10) return { tier: 'RESEARCH_SANDBOX', safetyReason: '', evidenceLabels: qLabels.concat(['SANDBOX_RETEST']), quantitative: metrics };
  return { tier: 'RESEARCH_SANDBOX', safetyReason: '', evidenceLabels: qLabels, quantitative: metrics };
}
function buildNativeForwardPoolView(report = {}, routes = []) {
  const top = safeArray(report?.research?.topStrategies);
  const mutationGovernor = v931BuildMutationGovernor(report);
  const deduped = v931DedupCandidates(top, report, FINAL_V930_TECHNICAL_CAP);
  const selected = [];
  const seen = new Set();
  const quotas = mutationGovernor.active
    ? ['FULL_AUTONOMY_FORWARD','WATCH_FORWARD','RESEARCH_SANDBOX']
    : ['FULL_AUTONOMY_FORWARD','WATCH_FORWARD','RESEARCH_SANDBOX'];
  const classified = deduped.rows.map(c => ({ c, cls: classifyCandidateV930(c, routes), key: v931ClusterKey(c) }));
  for (const tier of quotas) {
    for (const item of classified) {
      if (item.cls.tier !== tier || seen.has(item.key)) continue;
      seen.add(item.key);
      const c = item.c, cls = item.cls;
      selected.push({
        key: uniqueKeyFromCandidate(c),
        clusterKey: item.key,
        clusterSize: Number(c.__alpsV931ClusterSize || 1),
        clusterRepresentative: true,
        pair: c.pair || c.baseSymbol || (textValue(c.sym).split('_')[0] || ''),
        timeframe: c.timeframe || '',
        strategy: c.strategy || c.stratName || '',
        exit: c.exit || c.exitName || '',
        tier: cls.tier,
        safetyReason: cls.safetyReason,
        evidenceLabels: cls.evidenceLabels,
        quantitative: cls.quantitative,
        oosPF: c.oosPF,
        oosTrades: c.oosTrades,
        totalTrades: c.totalTrades,
        ddBps: c.oosDD,
        score: c.score,
        originalPromotionTier: c.promotionTier,
        originalForwardEligible: c.forwardEligible === true,
        originalBlockReason: c.forwardBlockReason || ''
      });
      if (selected.length >= 20) break;
    }
    if (selected.length >= 20) break;
  }
  const count = tier => selected.filter(x => x.tier === tier).length;
  const quantPassed = selected.filter(x => x.quantitative?.promote).length;
  return {
    schema: 'alps.nativeForwardPool.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    technicalCap: FINAL_V930_TECHNICAL_CAP,
    poolViewCap: 20,
    totalCandidates: selected.length,
    generatedStrategies: Number(report?.research?.strategies || report?.forwardWatch?.totalGeneratedStrategies || top.length || 0),
    fullAutonomyForward: count('FULL_AUTONOMY_FORWARD'),
    watchForward: count('WATCH_FORWARD'),
    researchSandbox: count('RESEARCH_SANDBOX'),
    cognitionSuspended: count('COGNITION_SUSPENDED'),
    safetyBlocked: count('SAFETY_BLOCKED'),
    dataBlocked: count('DATA_BLOCKED'),
    promotedByFullAutonomy: count('FULL_AUTONOMY_FORWARD'),
    blockedBySafety: count('SAFETY_BLOCKED') + count('DATA_BLOCKED'),
    quantitativePromotion: {
      installed: true,
      rule: 'nEff_OOS >= 25 AND P(PF>1) >= 0.90 AND rollingMinPF >= 0.60 when available; if rolling is unavailable require PF>=1.80 and stress5>=1.20 when available.',
      passed: quantPassed,
      thresholds: { nEffOOS: 25, posteriorPFgt1: 0.90, rollingMinPF: 0.60, fallbackPF: 1.80, fallbackStress5: 1.20 }
    },
    duplicateCompression: deduped.stats,
    mutationGovernor,
    evidenceLabels: [...new Set(selected.flatMap(x => x.evidenceLabels || []))],
    candidates: selected.slice(0, 50),
    note: 'v9.3.1: forward pool is built from deduped cluster representatives first. Quantitative promotion is explicit; sample/DD/PF/LAB_ONLY remain evidence labels unless the quantitative rule passes.'
  };
}
function buildFullAutonomyView(report = {}, nativeView = null, routes = []) {
  const decisions = [];
  if (nativeView?.duplicateCompression?.compressedRows > 0) decisions.push({ action: 'DEDUP_FORWARD_POOL', reason: `${nativeView.duplicateCompression.compressedRows} near-duplicate rows compressed before forward selection.` });
  if (nativeView?.promotedByFullAutonomy > 0) decisions.push({ action: 'OPEN_PAPER_CANDIDATE_AUTHORITY', reason: `${nativeView.promotedByFullAutonomy} candidates passed quantitative FULL_AUTONOMY_FORWARD rule.` });
  if (nativeView?.mutationGovernor?.active) decisions.push({ action: 'REBUILD', reason: 'Mutation stagnation detected; selection budget moved toward exploration representatives.' });
  if (!decisions.length) decisions.push({ action: 'WAIT_FOR_EVIDENCE', reason: 'No non-eligible candidate passed quantitative promotion yet.' });
  return {
    schema: 'alps.fullAutonomy.view.v1',
    version: FINAL_V930_VERSION,
    enabled: true,
    mode: 'DECIDE_AND_ACT_PAPER_ONLY',
    paperOnly: true,
    liveCapitalExecution: false,
    humanStrategicRestrictionsRemoved: {
      fixedTradeCount: true, fixedPairPreference: true, fixedTimeframePreference: true, manualPatternBlocks: true, manualExposureBudget: true, fixedRobustWatchDependency: true, fixedCandidateCapAsStrategy: true
    },
    safetyGuardsPreserved: {
      closedCandleOnly: true, freshSignalOnly: true, badDataGuard: true, duplicateSignalGuard: true, storageProtection: true, emergencyStop: true, paperOnlyBoundary: true
    },
    allowedActions: ['OPEN_PAPER','HOLD','REDUCE_EXPOSURE','SHADOW_RETEST','REBUILD','SUSPEND_PATTERN','STOP_REVIEW','WAIT_FOR_EVIDENCE'],
    decisions,
    lastDecision: decisions[0]?.action || 'WAIT_FOR_EVIDENCE',
    quantitativePromotion: nativeView?.quantitativePromotion || null,
    duplicateCompression: nativeView?.duplicateCompression || null,
    mutationGovernor: nativeView?.mutationGovernor || null,
    nativeForwardPool: { totalCandidates: nativeView?.totalCandidates || 0, promotedByFullAutonomy: nativeView?.promotedByFullAutonomy || 0, blockedBySafety: nativeView?.blockedBySafety || 0 },
    activeEvidenceRoutes: safeArray(routes).length
  };
}

function enrichReportV930(report = {}, pageStatus = null) {
  const routes = safeArray(report?.alpsAutonomousBridge?.activeRoutes || lastAutonomyView?.activeRoutes || autonomyMemoryState?.activeRoutes);
  const nativeView = buildNativeForwardPoolView(report, routes);
  const fullAutonomy = buildFullAutonomyView(report, nativeView, routes);
  const mutationGovernor = nativeView?.mutationGovernor || v931BuildMutationGovernor(report);
  const engineHook = buildEngineHookView(pageStatus || report?.engineHook || {});
  const counterfactual = buildCounterfactualView(report);
  const circuitBreaker = buildCircuitBreakerView(engineHook.lastError, engineHook.lastError ? ['engineHook'] : []);
  const chart = buildChartView(report);
  report.nativeForwardPool = nativeView;
  report.fullAutonomyNativeForwardPool = nativeView;
  report.fullAutonomy = fullAutonomy;
  report.engineHook = engineHook;
  report.counterfactual = counterfactual;
  report.mutationGovernor = mutationGovernor;
  report.decisionIntelligence = { schema: 'alps.decisionIntelligence.view.v1', version: FINAL_V930_VERSION, duplicateCompression: nativeView?.duplicateCompression || null, quantitativePromotion: nativeView?.quantitativePromotion || null, mutationGovernor };
  report.circuitBreaker = circuitBreaker;
  report.chart = chart;
  report.v930 = { version: FINAL_V930_VERSION, dataSource: 'LIVE SNAPSHOT', liveCapitalExecution: false, appStableBase: 'v9.2.2-persistent-autonomous-memory' };
  lastNativeForwardPoolView = nativeView;
  lastFullAutonomyView = fullAutonomy;
  lastEngineHookView = engineHook;
  lastCounterfactualView = counterfactual;
  lastCircuitBreakerView = circuitBreaker;
  lastChartView = chart;
  return report;
}
function buildV930Markdown(report = {}) {
  const nfp = report.nativeForwardPool || lastNativeForwardPoolView || {};
  const fa = report.fullAutonomy || lastFullAutonomyView || {};
  const eh = report.engineHook || lastEngineHookView || {};
  const cb = report.circuitBreaker || lastCircuitBreakerView || {};
  const cf = report.counterfactual || lastCounterfactualView || {};
  const ch = report.chart || lastChartView || {};
  const line = (k, v) => `- ${k}: ${v == null || v === '' ? '—' : v}`;
  let md = `## ALPS v9.3.1 Decision Intelligence Spec\n`;
  md += line('Version', FINAL_V930_VERSION) + '\n';
  md += line('Paper only', fa.paperOnly === false ? 'NO' : 'YES') + '\n';
  md += line('Live capital execution', 'DISABLED') + '\n';
  md += line('Full Autonomy', fa.enabled ? `${fa.mode}` : 'OFF') + '\n';
  md += line('Native Forward Pool', nfp.installed ? 'INSTALLED' : 'NOT READY') + '\n';
  md += line('Engine Hook safe', eh.safe ? 'YES' : 'NO') + '\n';
  md += line('Circuit Breaker', cb.open ? `OPEN — ${cb.reason}` : 'CLOSED') + '\n';
  md += `\n### Native Forward Pool Classification\n`;
  md += `| Tier | Count |\n|---|---:|\n`;
  md += `| FULL_AUTONOMY_FORWARD | ${nfp.fullAutonomyForward || 0} |\n`;
  md += `| WATCH_FORWARD | ${nfp.watchForward || 0} |\n`;
  md += `| RESEARCH_SANDBOX | ${nfp.researchSandbox || 0} |\n`;
  md += `| COGNITION_SUSPENDED | ${nfp.cognitionSuspended || 0} |\n`;
  md += `| SAFETY_BLOCKED | ${nfp.safetyBlocked || 0} |\n`;
  md += `| DATA_BLOCKED | ${nfp.dataBlocked || 0} |\n`;
  md += `\n### Counterfactual Baseline\n`;
  md += line('Enabled', cf.enabled ? 'YES' : 'NO') + '\n';
  md += line('N', cf.n) + '\n';
  md += line('Edge R', cf.edgeR) + '\n';
  md += line('Rollback recommended', cf.rollbackRecommended ? 'YES' : 'NO') + '\n';
  md += `\n### Live Chart Status\n`;
  md += line('Ready', ch.ready ? 'YES' : 'NO') + '\n';
  md += line('Selected pair', ch.selectedPair) + '\n';
  md += line('Selected timeframe', ch.selectedTimeframe) + '\n';
  md += line('Candles loaded', ch.candlesLoaded) + '\n';
  md += `\n> v9.3.0 note: sample, drawdown, PF, LAB_ONLY and robustness are evidence labels, not fixed human blockers. Operational safety remains a hard boundary.\n`;
  return md;
}


function buildV930Markdown(report = {}) {
  const nfp = report.nativeForwardPool || lastNativeForwardPoolView || {};
  const fa = report.fullAutonomy || lastFullAutonomyView || {};
  const eh = report.engineHook || lastEngineHookView || {};
  const cb = report.circuitBreaker || lastCircuitBreakerView || {};
  const cf = report.counterfactual || lastCounterfactualView || {};
  const ch = report.chart || lastChartView || {};
  const mg = report.mutationGovernor || nfp.mutationGovernor || {};
  const dc = nfp.duplicateCompression || {};
  const qp = nfp.quantitativePromotion || {};
  const line = (k, v) => `- ${k}: ${v == null || v === '' ? '—' : v}`;
  let md = `## ALPS v9.3.1 Decision Intelligence Spec\n`;
  md += line('Version', FINAL_V930_VERSION) + '\n';
  md += line('Paper only', fa.paperOnly === false ? 'NO' : 'YES') + '\n';
  md += line('Live capital execution', 'DISABLED') + '\n';
  md += line('Full Autonomy', fa.enabled ? `${fa.mode}` : 'OFF') + '\n';
  md += line('Native Forward Pool', nfp.installed ? 'INSTALLED' : 'NOT READY') + '\n';
  md += line('Engine Hook safe', eh.safe ? 'YES' : 'NO') + '\n';
  md += line('Circuit Breaker', cb.open ? `OPEN — ${cb.reason}` : 'CLOSED') + '\n';
  md += `\n### Native Forward Pool Classification\n`;
  md += `| Tier | Count |\n|---|---:|\n`;
  md += `| FULL_AUTONOMY_FORWARD | ${nfp.fullAutonomyForward || 0} |\n`;
  md += `| WATCH_FORWARD | ${nfp.watchForward || 0} |\n`;
  md += `| RESEARCH_SANDBOX | ${nfp.researchSandbox || 0} |\n`;
  md += `| COGNITION_SUSPENDED | ${nfp.cognitionSuspended || 0} |\n`;
  md += `| SAFETY_BLOCKED | ${nfp.safetyBlocked || 0} |\n`;
  md += `| DATA_BLOCKED | ${nfp.dataBlocked || 0} |\n`;
  md += `\n### v9.3.1 Decision Intelligence\n`;
  md += line('Dedup before pool', dc.method || '—') + '\n';
  md += line('Raw rows / clusters / compressed', `${dc.rawRows ?? '—'} / ${dc.clusters ?? '—'} / ${dc.compressedRows ?? '—'}`) + '\n';
  md += line('Quantitative promotion rule', qp.rule || '—') + '\n';
  md += line('Quantitative passes', qp.passed ?? 0) + '\n';
  md += line('Mutation governor', mg.mode || '—') + '\n';
  md += line('Zero-improvement logs', mg.zeroImprovementLogs ?? 0) + '\n';
  md += line('Missing-edge hypotheses observed', mg.missingEdgeGenerated ?? 0) + '\n';
  if (Array.isArray(dc.topClusters) && dc.topClusters.length) {
    md += `\n#### Top Compressed Clusters\n| Size | Cluster |\n|---:|---|\n`;
    for (const c of dc.topClusters.slice(0, 8)) md += `| ${c.size} | ${String(c.key || '').replace(/\|/g, ' / ')} |\n`;
  }
  md += `\n### Counterfactual Baseline\n`;
  md += line('Enabled', cf.enabled ? 'YES' : 'NO') + '\n';
  md += line('N', cf.n) + '\n';
  md += line('Edge R', cf.edgeR) + '\n';
  md += line('Rollback recommended', cf.rollbackRecommended ? 'YES' : 'NO') + '\n';
  md += `\n### Live Chart Status\n`;
  md += line('Ready', ch.ready ? 'YES' : 'NO') + '\n';
  md += line('Selected pair', ch.selectedPair) + '\n';
  md += line('Selected timeframe', ch.selectedTimeframe) + '\n';
  md += line('Candles loaded', ch.candlesLoaded) + '\n';
  md += `\n> v9.3.1 note: the pool is deduped before forward selection, FULL_AUTONOMY_FORWARD requires explicit quantitative evidence, and stagnant mutation cycles trigger exploration rebalancing. Operational safety remains a hard boundary.\n`;
  return md;
}


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
  lines.push('', '> Cognition note: v9.2.2 keeps cognition deterministic and auditable. It does not close trades, widen stops, or hard-ban any pair; the Autonomous Bridge may route future matching hypotheses to Shadow Retest only when ALPS evidence itself requests REBUILD/REDUCE.');
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
    noStopWidening: true,
    noForcedClose: true,
    routingScope: 'future focused-paper candidates only',
    activeRoutes: routes,
    decisions,
    summary: {
      activeRoutes: routes.length,
      shadowRetestOnly: routes.filter(r => r.action === 'SHADOW_RETEST_ONLY').length,
      manualPairRules: 0,
      hardBans: 0,
      mode: routes.length ? 'ACTIVE_AUTONOMOUS_BRIDGE' : 'OBSERVE_ONLY'
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

function buildAutonomyMarkdown(view = lastAutonomyView) {
  if (!view) return '## ALPS v9.2.2 Autonomous Cognition → ARI Bridge\n- No autonomy view yet.';
  const s = view.summary || {};
  const lines = [
    '',
    '## ALPS v9.2.2 Autonomous Cognition → ARI Bridge',
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
          const filter = v => Array.isArray(v) ? v.filter(x => !shadowOnly(x)) : v;
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
          const hitArg = args.find(a => shadowOnly(a));
          if (hitArg) return routedReturn(hitArg, match(hitArg));
          return fn.apply(this, args);
        };
        w.__alpsAutonomousBridgeWrapped = true;
        w.__original = fn;
        window[name] = w;
        wrapped.push(name);
      }
      listFns.forEach(wrapList);
      openFns.forEach(wrapOpen);
      return { installed: true, activeRoutes: routes.length, wrapped, version: policy.version };
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
  const out = { ...h, ...forward, recoveryPatch: RECOVERY_PATCH_VERSION, dataSource: h.dataSource || 'LIVE SNAPSHOT' };
  if (!out.nativeForwardPool && lastNativeForwardPoolView) out.nativeForwardPool = lastNativeForwardPoolView;
  if (!out.fullAutonomy && lastFullAutonomyView) out.fullAutonomy = lastFullAutonomyView;
  if (!out.engineHook && lastEngineHookView) out.engineHook = lastEngineHookView;
  if (!out.circuitBreaker && lastCircuitBreakerView) out.circuitBreaker = lastCircuitBreakerView;
  if (!out.chart && lastChartView) out.chart = lastChartView;
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
      if (url.pathname === '/runner/health') { await loadRecoveryState(); await loadTradeVaultState(); await loadCognitionState(); await loadAutonomyState(); await loadAutonomyMemoryState(); return send(res, 200, { ...lastHealth, browserServerReady, recovery: buildRecoveryView(), tradeVault: { currentCounts: tradeExportCounts(lastTradeExport), hasLastNonZero: !!tradeVaultState?.lastNonZero, historyCount: tradeVaultState?.history?.length || 0 }, cognition: { version: COGNITION_PATCH_VERSION, summary: lastCognitionView?.summary || cognitionState?.lastView?.summary || null, ledgerSeq: cognitionState?.seq || 0, hashHead: cognitionState?.prevHash || 'GENESIS' }, autonomousBridge: { version: AUTONOMY_PATCH_VERSION, summary: lastAutonomyView?.summary || autonomyState?.lastView?.summary || null, activeRoutes: (lastAutonomyView?.activeRoutes || autonomyState?.activeRoutes || autonomyMemoryState?.activeRoutes || []).length, ledgerSeq: autonomyState?.seq || 0, hashHead: autonomyState?.prevHash || 'GENESIS', persistentMemory: buildPersistentMemoryView(autonomyMemoryState) } }); }
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
      if (url.pathname === '/runner/native-forward-pool.json') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        await collectReport().catch(() => null);
        return send(res, 200, lastNativeForwardPoolView || { error: 'No native forward pool view yet' });
      }
      if (url.pathname === '/runner/full-autonomy.json') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        await collectReport().catch(() => null);
        return send(res, 200, lastFullAutonomyView || { error: 'No full autonomy view yet' });
      }
      if (url.pathname === '/runner/v930.json') {
        if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });
        await collectReport().catch(() => null);
        return send(res, 200, { version: FINAL_V930_VERSION, fullAutonomy: lastFullAutonomyView, nativeForwardPool: lastNativeForwardPoolView, engineHook: lastEngineHookView, circuitBreaker: lastCircuitBreakerView, counterfactual: lastCounterfactualView, chart: lastChartView, dataSource: 'LIVE SNAPSHOT' });
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


async function installV930InitScripts() {
  if (!context) return;
  const content = `(() => {
    if (window.__ALPS_V930_BOOT_GUARD__) return;
    window.__ALPS_V930_BOOT_GUARD__ = true;
    window.__ALPS_V930_ERRORS__ = [];
    function safeColor(input) {
      const raw = String(input == null ? '' : input).trim();
      if (!raw) return 'rgba(0,0,0,0)';
      const badRgbaAlphaTypo = 'rgba' + 'a';
      if (new RegExp('^' + badRgbaAlphaTypo + '\\s*\\(', 'i').test(raw)) {
        const nums = raw.match(/[-+]?\d*\.?\d+/g) || [];
        const r = Math.max(0, Math.min(255, Number(nums[0] || 0)));
        const g = Math.max(0, Math.min(255, Number(nums[1] || 0)));
        const b = Math.max(0, Math.min(255, Number(nums[2] || 0)));
        const a = Math.max(0, Math.min(1, Number(nums[nums.length - 1] || 1)));
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      }
      return raw;
    }
    window.safeAddColorStop = function safeAddColorStop(gradient, offset, color) {
      try { gradient.addColorStop(offset, safeColor(color)); return true; }
      catch (err) {
        window.__ALPS_V930_ERRORS__.push({ at: Date.now(), type: 'addColorStop', message: String(err && err.message || err), color: String(color) });
        try { gradient.addColorStop(offset, 'rgba(0,0,0,0)'); return false; } catch (_) { return false; }
      }
    };
    try {
      const proto = window.CanvasGradient && window.CanvasGradient.prototype;
      if (proto && !proto.__alpsV930Patched) {
        const original = proto.addColorStop;
        proto.addColorStop = function(offset, color) {
          try { return original.call(this, offset, safeColor(color)); }
          catch (err) {
            window.__ALPS_V930_ERRORS__.push({ at: Date.now(), type: 'CanvasGradient.addColorStop', message: String(err && err.message || err), color: String(color) });
            try { return original.call(this, offset, 'rgba(0,0,0,0)'); } catch (_) { return undefined; }
          }
        };
        proto.__alpsV930Patched = true;
      }
    } catch (err) { window.__ALPS_V930_ERRORS__.push({ at: Date.now(), type: 'boot-guard', message: String(err && err.message || err) }); }
    window.safeCanvasDraw = function safeCanvasDraw(fn) { try { return typeof fn === 'function' ? fn() : null; } catch (err) { window.__ALPS_V930_ERRORS__.push({ at: Date.now(), type: 'canvas', message: String(err && err.message || err) }); return null; } };
    window.safeReportBuild = function safeReportBuild(fn) { try { return typeof fn === 'function' ? fn() : null; } catch (err) { window.__ALPS_V930_ERRORS__.push({ at: Date.now(), type: 'report', message: String(err && err.message || err) }); return null; } };
    window.safeBoot = function safeBoot(fn) { try { return typeof fn === 'function' ? fn() : null; } catch (err) { window.__ALPS_V930_ERRORS__.push({ at: Date.now(), type: 'boot', message: String(err && err.message || err) }); return null; } };
    window.safeModuleInit = window.safeBoot;
    window.safeJsonParse = function safeJsonParse(raw, fallback) { try { return JSON.parse(raw); } catch (_) { return fallback; } };
    window.safeDomUpdate = function safeDomUpdate(fn) { try { return typeof fn === 'function' ? fn() : null; } catch (err) { window.__ALPS_V930_ERRORS__.push({ at: Date.now(), type: 'dom', message: String(err && err.message || err) }); return null; } };
    window.addEventListener('error', ev => { try { window.__ALPS_V930_ERRORS__.push({ at: Date.now(), type: 'window.error', message: String(ev.message || ev.error || '') }); } catch (_) {} }, true);
    window.addEventListener('unhandledrejection', ev => { try { window.__ALPS_V930_ERRORS__.push({ at: Date.now(), type: 'unhandledrejection', message: String((ev.reason && ev.reason.message) || ev.reason || '') }); } catch (_) {} }, true);
  })();`;
  try { await context.addInitScript({ content }); } catch (_) {}
  try { if (page && !page.isClosed()) await page.addInitScript({ content }); } catch (_) {}
}

async function installV930StableAutonomyInPage() {
  if (!page || page.isClosed()) return { installed: false, safe: true, reason: 'page not ready' };
  try {
    const policy = {
      version: FINAL_V930_VERSION,
      technicalCap: FINAL_V930_TECHNICAL_CAP,
      routes: safeArray(lastAutonomyView?.activeRoutes || autonomyMemoryState?.activeRoutes || [])
    };
    const status = await pageEval(policy => {
      const status = window.__ALPS_FINAL_V930__ || {
        version: policy.version,
        installed: false,
        safe: true,
        wrappedFunctions: [],
        fallbackActive: false,
        lastError: '',
        nativeForwardPool: null,
        fullAutonomy: null,
        engineHook: null
      };
      window.__ALPS_FINAL_V930__ = status;
      status.version = policy.version;
      status.installed = true;
      status.safe = true;
      status.policy = { technicalCap: policy.technicalCap, routeCount: Array.isArray(policy.routes) ? policy.routes.length : 0 };
      function arr(v) { return Array.isArray(v) ? v : []; }
      function text(v) { return String(v == null ? '' : v); }
      function key(c) { return [c && (c.sym || c.pair || c.baseSymbol || ''), c && (c.timeframe || c.tf || ''), c && (c.strategy || c.stratName || c.name || ''), c && (c.exit || c.exitName || '')].map(text).join('||').toUpperCase(); }
      function evidenceLabels(c) {
        const raw = [c && c.forwardBlockReason, c && c.robustnessReason, c && c.sampleFlag, c && c.promotionTier, c && c.rawVerdict, c && c.effectiveVerdict, c && c.robustnessFinal].concat(arr(c && c.promotionReasons)).map(text).join(' | ');
        const labels = [];
        if (/LAB_ONLY/i.test(raw)) labels.push('LAB_ONLY');
        if (/sample|LOW_SAMPLE|OOS/i.test(raw)) labels.push('SAMPLE');
        if (/DD|drawdown/i.test(raw)) labels.push('DRAWDOWN');
        if (/PF/i.test(raw)) labels.push('PF_GATE');
        if (/WATCH/i.test(raw)) labels.push('WATCH');
        if (/DISCARD/i.test(raw)) labels.push('DISCARD_CONTEXT');
        return Array.from(new Set(labels));
      }
      function safetyReason(c) {
        const raw = [c && c.forwardBlockReason, c && c.lastRejectedReason, c && c.reason, c && c.blockReason, c && c.freshness, c && c.status, c && c.dataStatus].concat(arr(c && c.promotionReasons)).map(text).join(' | ').toUpperCase();
        if (/EMERGENCY/.test(raw)) return 'EMERGENCY_STOP';
        if (/NOT_LATEST_CLOSED_CANDLE|STALE|FRESHNESS|DELAYED|TOO_OLD/.test(raw)) return 'FRESHNESS_OR_CLOSED_CANDLE';
        if (/BAD_DATA|DATA_FAIL|FAILED DATA|GAP|DUPLICATE CANDLE|MISSING_CANDLE|NO_CANDLE|INVALID_PRICE|NAN|INFINITE/.test(raw)) return 'DATA_OR_PRICE_GUARD';
        if (/DUPLICATE_SIGNAL|SAME_SETUP|LITERAL_DUPLICATE/.test(raw)) return 'DUPLICATE_SETUP_GUARD';
        return '';
      }
      function routeMatch(route, c) {
        const pair = text(c && (c.pair || c.baseSymbol || c.symbol || c.sym)).toUpperCase();
        const tf = text(c && (c.timeframe || c.tf)).toUpperCase();
        const strat = text(c && (c.strategy || c.stratName || c.name)).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
        const rp = text(route && route.pair).toUpperCase();
        const rt = text(route && route.timeframe).toUpperCase();
        const rr = text(route && (route.root || route.strategy)).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
        return (!rp || pair.includes(rp)) && (!rt || tf === rt) && (!rr || strat.includes(rr));
      }
      function classify(c) {
        const safety = safetyReason(c || {});
        const labels = evidenceLabels(c || {});
        if (safety) return { tier: safety === 'DATA_OR_PRICE_GUARD' ? 'DATA_BLOCKED' : 'SAFETY_BLOCKED', safetyReason: safety, evidenceLabels: labels };
        const route = arr(policy.routes).find(r => /SHADOW|SUSPEND/i.test(text(r && r.action)) && routeMatch(r, c || {}));
        if (route) return { tier: 'COGNITION_SUSPENDED', safetyReason: '', evidenceLabels: labels.concat(['COGNITION_ROUTE']), routeKey: route.routeKey || '' };
        if ((c && c.forwardEligible === true) || /WATCHLIST|FORWARD/i.test(text(c && c.promotionTier))) return { tier: 'WATCH_FORWARD', safetyReason: '', evidenceLabels: labels };
        if (/WATCH|ROBUSTNESS_WATCH|KEEP/i.test([c && c.rawVerdict, c && c.effectiveVerdict, c && c.robustnessFinal].map(text).join('|'))) return { tier: 'FULL_AUTONOMY_FORWARD', safetyReason: '', evidenceLabels: labels.concat(['PROMOTED_BY_AUTONOMY']) };
        if (/DISCARD/i.test([c && c.rawVerdict, c && c.effectiveVerdict].map(text).join('|')) && Number(c && c.oosPF || 0) > 1 && Number(c && c.oosTrades || 0) >= 10) return { tier: 'RESEARCH_SANDBOX', safetyReason: '', evidenceLabels: labels.concat(['SANDBOX_RETEST']) };
        return { tier: 'RESEARCH_SANDBOX', safetyReason: '', evidenceLabels: labels };
      }
      function sourceRows() {
        try {
          if (Array.isArray(globalThis.results) && globalThis.results.length) return globalThis.results;
        } catch (_) {}
        try {
          if (typeof results !== 'undefined' && Array.isArray(results) && results.length) return results;
        } catch (_) {}
        return [];
      }
      function promotionPassTier(cls) {
        const tier = text(cls && cls.tier).toUpperCase();
        return tier === 'FULL_AUTONOMY_FORWARD' || tier === 'WATCH_FORWARD';
      }
      function promoteCandidateInPlace(c, cls) {
        if (!c || !promotionPassTier(cls)) return false;
        try {
          if (!c.__alpsV930Original) {
            try {
              c.__alpsV930Original = {
                forwardEligible: c.forwardEligible,
                forwardBlockReason: c.forwardBlockReason,
                blockReason: c.blockReason,
                promotionTier: c.promotionTier,
                promotionStatus: c.promotionStatus,
                promotionGateSummary: c.promotionGateSummary,
                candidateTier: c.candidateTier,
                promotionReasons: Array.isArray(c.promotionReasons) ? c.promotionReasons.slice() : c.promotionReasons,
                sampleFlag: c.sampleFlag
              };
            } catch (_) {}
          }
          const nativeTier = String(cls.tier || 'FULL_AUTONOMY_FORWARD');
          const originalReasons = Array.isArray(c.__alpsV930Original && c.__alpsV930Original.promotionReasons) ? c.__alpsV930Original.promotionReasons : [];
          c.__alpsV930Tier = nativeTier;
          c.__alpsV930EvidenceLabels = Array.from(new Set(cls.evidenceLabels || []));
          c.__alpsV930AuthoritativeForward = true;
          c.__alpsV930PromotionGateOverride = true;
          c.forwardEligible = true;
          c.eligible = true;
          c.forwardBlockReason = '';
          c.blockReason = '';
          c.promotionBlocked = false;
          c.promotionGateBlocked = false;
          c.promotionTier = nativeTier === 'WATCH_FORWARD' ? (c.promotionTier || 'WATCHLIST') : 'FULL_AUTONOMY_FORWARD';
          c.promotionStatus = nativeTier;
          c.promotionGateSummary = nativeTier;
          c.candidateTier = nativeTier;
          c.sampleFlag = c.sampleFlag || 'EVIDENCE_TAG';
          c.promotionReasons = [];
          c.__alpsV930EvidenceReasons = originalReasons;
          if (c.promotionGate && typeof c.promotionGate === 'object') {
            c.promotionGate.forwardEligible = true;
            c.promotionGate.eligible = true;
            c.promotionGate.blocked = false;
            c.promotionGate.blockReason = '';
            c.promotionGate.reason = '';
            c.promotionGate.status = nativeTier;
            c.promotionGate.summary = nativeTier;
          }
          return true;
        } catch (err) {
          try { status.lastError = String(err && err.message || err); } catch (_) {}
          return false;
        }
      }
      function applyAuthoritativeNativePool() {
        let mutated = 0;
        try {
          for (const c of sourceRows()) {
            const cls = classify(c || {});
            if (promoteCandidateInPlace(c, cls)) mutated += 1;
          }
          status.nativeExecutionControl = {
            installed: true,
            authoritative: true,
            version: policy.version,
            mutatedCandidates: mutated,
            lastAppliedAt: Date.now(),
            rule: 'FULL_AUTONOMY_FORWARD and WATCH_FORWARD candidates are written back into the real engine result objects; LAB_ONLY/sample/DD/PF remain evidence labels only.'
          };
          return mutated;
        } catch (err) {
          status.lastError = String(err && err.message || err);
          status.nativeExecutionControl = { installed: true, authoritative: false, lastError: status.lastError, fallbackActive: true };
          return mutated;
        }
      }
      function supplement(originalRows) {
        const out = [];
        const seen = new Set(arr(originalRows).map(key));
        for (const c of sourceRows()) {
          const k = key(c);
          if (!k || seen.has(k)) continue;
          const cls = classify(c);
          if (cls.tier === 'SAFETY_BLOCKED' || cls.tier === 'DATA_BLOCKED' || cls.tier === 'COGNITION_SUSPENDED') continue;
          promoteCandidateInPlace(c, cls);
          const copy = Object.assign({}, c, {
            __alpsV930Tier: cls.tier,
            __alpsV930EvidenceLabels: cls.evidenceLabels,
            __alpsV930AuthoritativeForward: true,
            promotionTier: cls.tier === 'FULL_AUTONOMY_FORWARD' ? 'FULL_AUTONOMY_FORWARD' : (c.promotionTier || cls.tier),
            promotionStatus: cls.tier,
            promotionGateSummary: cls.tier,
            candidateTier: cls.tier,
            forwardEligible: true,
            forwardBlockReason: '',
            blockReason: ''
          });
          out.push(copy); seen.add(k);
          if (out.length + arr(originalRows).length >= Number(policy.technicalCap || 360)) break;
        }
        return out;
      }
      function buildNative(report) {
        const top = arr(report && report.research && report.research.topStrategies).length ? report.research.topStrategies : sourceRows().slice(0, policy.technicalCap || 360);
        const rows = [];
        const seen = new Set();
        for (const c of top) {
          const k = key(c); if (!k || seen.has(k)) continue; seen.add(k);
          const cls = classify(c);
          rows.push({ key: k, pair: c.pair || c.baseSymbol || text(c.sym).split('_')[0], timeframe: c.timeframe || '', strategy: c.strategy || c.stratName || '', tier: cls.tier, evidenceLabels: cls.evidenceLabels, safetyReason: cls.safetyReason, oosPF: c.oosPF, oosTrades: c.oosTrades, score: c.score, originalPromotionTier: c.promotionTier, originalForwardEligible: c.forwardEligible === true, originalBlockReason: c.forwardBlockReason || '' });
          if (rows.length >= Number(policy.technicalCap || 360)) break;
        }
        const count = t => rows.filter(x => x.tier === t).length;
        return { schema: 'alps.nativeForwardPool.view.v1', version: policy.version, installed: true, totalCandidates: rows.length, fullAutonomyForward: count('FULL_AUTONOMY_FORWARD'), watchForward: count('WATCH_FORWARD'), researchSandbox: count('RESEARCH_SANDBOX'), cognitionSuspended: count('COGNITION_SUSPENDED'), safetyBlocked: count('SAFETY_BLOCKED'), dataBlocked: count('DATA_BLOCKED'), promotedByFullAutonomy: count('FULL_AUTONOMY_FORWARD'), blockedBySafety: count('SAFETY_BLOCKED') + count('DATA_BLOCKED'), evidenceLabels: Array.from(new Set(rows.flatMap(r => r.evidenceLabels || []))), candidates: rows.slice(0, 50) };
      }
      function patchPoolFunction(name) {
        try {
          const original = globalThis[name] || (typeof window !== 'undefined' ? window[name] : null);
          if (typeof original !== 'function' || original.__alpsV930Wrapped) return false;
          const wrapped = function(...args) {
            try {
              const base = arr(original.apply(this, args));
              const extra = supplement(base);
              const all = base.concat(extra);
              return all.slice(0, Number(policy.technicalCap || 360));
            } catch (err) {
              status.safe = true;
              status.fallbackActive = true;
              status.lastError = String(err && err.message || err);
              return original.apply(this, args);
            }
          };
          wrapped.__alpsV930Wrapped = true;
          try { globalThis[name] = wrapped; } catch (_) { window[name] = wrapped; }
          if (!status.wrappedFunctions.includes(name)) status.wrappedFunctions.push(name);
          return true;
        } catch (err) { status.lastError = String(err && err.message || err); status.fallbackActive = true; return false; }
      }
      patchPoolFunction('forwardCandidatePool');
      patchPoolFunction('activeForwardCandidatePool');
      try { applyAuthoritativeNativePool(); } catch (_) {}
      try {
        if (!status.__alpsV930AuthoritativeInterval) {
          status.__alpsV930AuthoritativeInterval = true;
          const timer = setInterval(() => { try { applyAuthoritativeNativePool(); } catch (_) {} }, 5000);
          try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch (_) {}
        }
      } catch (_) {}
      if (!status.wrappedFunctions.includes('nativeResultMutation')) status.wrappedFunctions.push('nativeResultMutation');
      if (!status.wrappedFunctions.includes('promotionGateOverride')) status.wrappedFunctions.push('promotionGateOverride');
      try {
        const originalReport = globalThis.buildRunReportObject || window.buildRunReportObject;
        if (typeof originalReport === 'function' && !originalReport.__alpsV930Wrapped) {
          const wrappedReport = async function(...args) {
            const report = await originalReport.apply(this, args);
            try {
              const nfp = buildNative(report || {});
              report.nativeForwardPool = nfp;
              report.fullAutonomyNativeForwardPool = nfp;
              report.fullAutonomy = { schema: 'alps.fullAutonomy.view.v1', version: policy.version, enabled: true, mode: 'DECIDE_AND_ACT_PAPER_ONLY', paperOnly: true, liveCapitalExecution: false, humanStrategicRestrictionsRemoved: true, safetyGuardsPreserved: true, executionControl: status.nativeExecutionControl || null, lastDecision: nfp.promotedByFullAutonomy ? 'FULL_AUTONOMY_FORWARD_POOL_AUTHORITATIVE' : 'WAIT_FOR_EVIDENCE' };
              report.engineHook = { schema: 'alps.engineHook.view.v1', version: policy.version, installed: true, safe: true, lastError: status.lastError || '', wrappedFunctions: status.wrappedFunctions.slice(), fallbackActive: !!status.fallbackActive, nativeExecutionControl: status.nativeExecutionControl || null };
              report.nativeExecutionControl = status.nativeExecutionControl || null;
              report.circuitBreaker = { schema: 'alps.circuitBreaker.view.v1', version: policy.version, enabled: true, open: false, reason: '', fallbackMode: 'ADVANCED_MODULES_ACTIVE', disabledModules: [] };
              report.chart = { schema: 'alps.chart.view.v1', version: policy.version, ready: true, selectedPair: (nfp.candidates[0] && nfp.candidates[0].pair) || 'BTCUSDT', selectedTimeframe: (nfp.candidates[0] && nfp.candidates[0].timeframe) || '1h', candlesLoaded: Number(report && report.data && report.data.candlesLoaded || 0), candidateTradesShown: nfp.totalCandidates, openTradesShown: Number(report && report.forwardWatch && report.forwardWatch.openPositions || 0), closedTradesShown: Number(report && report.forwardWatch && report.forwardWatch.closedTrades || 0), lastError: '' };
              report.v930 = { version: policy.version, dataSource: 'LIVE SNAPSHOT', liveCapitalExecution: false };
              status.nativeForwardPool = nfp;
              status.fullAutonomy = report.fullAutonomy;
              status.engineHook = report.engineHook;
            } catch (err) { status.lastError = String(err && err.message || err); status.fallbackActive = true; }
            return report;
          };
          wrappedReport.__alpsV930Wrapped = true;
          globalThis.buildRunReportObject = wrappedReport;
          if (!status.wrappedFunctions.includes('buildRunReportObject')) status.wrappedFunctions.push('buildRunReportObject');
        }
      } catch (err) { status.lastError = String(err && err.message || err); status.fallbackActive = true; }
      status.installed = true;
      status.safe = true;
      status.engineHook = { installed: true, safe: true, version: policy.version, lastError: status.lastError || '', wrappedFunctions: status.wrappedFunctions.slice(), fallbackActive: !!status.fallbackActive, nativeExecutionControl: status.nativeExecutionControl || null };
      return status;
    }, policy);

    // v9.3.1 browser-side decision intelligence overlay.
    // It wraps the already-stable v9.3.0 runtime and adds dedup, quantitative promotion, and mutation stagnation/exploration status.
    try {
      const status931 = await pageEval(policy => {
        const status = window.__ALPS_FINAL_V930__ || { wrappedFunctions: [], safe: true, lastError: '' };
        window.__ALPS_FINAL_V930__ = status;
        status.version = policy.version;
        function arr(v) { return Array.isArray(v) ? v : []; }
        function text(v) { return String(v == null ? '' : v); }
        function num(v, fallback = null) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
        function round(v, d = 2) { const n = num(v, null); if (n == null) return 'NA'; const p = Math.pow(10, d); return String(Math.round(n * p) / p); }
        function key(c) { return [c && (c.sym || c.pair || c.baseSymbol || ''), c && (c.timeframe || c.tf || ''), c && (c.strategy || c.stratName || c.name || ''), c && (c.exit || c.exitName || '')].map(text).join('||').toUpperCase(); }
        function root(c) {
          const raw = text(c && (c.strategy || c.stratName || c.name)).toUpperCase();
          if (/HA|HEIKIN/.test(raw) && /POC/.test(raw)) return 'HA_POC';
          if (/BB|BOLLINGER|SQUEEZE/.test(raw)) return /REVERSAL/.test(raw) ? 'BOLLINGER_REVERSAL' : 'BB_SQUEEZE';
          if (/EMA|TREND 20|20\/50|TREND/.test(raw)) return 'EMA_TREND';
          if (/VAH|VAL|VALUE/.test(raw)) return 'VAH_VAL';
          if (/POC/.test(raw)) return 'POC';
          return raw.replace(/G\d+/g, ' ').replace(/NO EXTRA FILTER|SLOW FRAME|BELOW POC|ABOVE POC|NEAR SWING LOW|4H BEARISH|4H BULLISH|HA BEAR|HA BULL|HIGH VOLUME|NOT RANGE|EXPANSION|STRONG BEAR STACK|STRONG BULL STACK/g, ' ').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0,40) || 'GENERIC';
        }
        function clusterKey(c) {
          const pair = text(c && (c.pair || c.baseSymbol || c.symbol || c.sym)).toUpperCase().split('_')[0];
          const tf = text(c && (c.timeframe || c.tf)).toUpperCase();
          const exit = text(c && (c.exit || c.exitName || '')).toUpperCase().replace(/[^A-Z0-9.]+/g, '_').slice(0, 24);
          return [pair, tf, root(c), exit, 'PF' + round(c && c.oosPF, 2), 'OOS' + round(c && c.oosTrades, 0)].join('|');
        }
        function posterior(pf, nEff) { const p = num(pf, 0), n = Math.max(0, num(nEff, 0)); if (!(p > 0) || !(n > 0)) return 0; const z = Math.log(Math.max(p, 0.0001)) * Math.sqrt(Math.max(1, n)) / 1.15; return Math.max(0, Math.min(1, 1 / (1 + Math.exp(-z)))); }
        function metrics(c) {
          const oosPF = num(c && c.oosPF, 0), oosTrades = num(c && c.oosTrades, 0), totalTrades = num(c && c.totalTrades, 0);
          const clusterSize = Math.max(1, num(c && c.__alpsV931ClusterSize, 1));
          const nEffOOS = Math.max(0, Math.min(oosTrades || 0, Math.round((oosTrades || 0) / Math.sqrt(clusterSize))));
          const rolling = num((c && (c.rollingMinPF ?? c.rolling ?? c.robustnessRolling)), null);
          const stress5 = num((c && (c.stress5 ?? c.robustnessStress5)), null);
          const posteriorPFgt1 = posterior(oosPF, nEffOOS);
          const rollingPass = rolling == null ? (oosPF >= 1.8 && (stress5 == null || stress5 >= 1.2)) : rolling >= 0.60;
          const promote = nEffOOS >= 25 && posteriorPFgt1 >= 0.90 && rollingPass && oosPF >= 1.25;
          return { oosPF, oosTrades, totalTrades, nEffOOS, clusterSize, rollingMinPF: rolling, stress5, posteriorPFgt1, rollingPass, promote, reason: promote ? 'QUANT_PASS' : `WAIT: nEff=${nEffOOS}/25 posterior=${posteriorPFgt1.toFixed(2)}/0.90 rollingPass=${rollingPass}` };
        }
        function labels(c) {
          const raw = [c && c.forwardBlockReason, c && c.robustnessReason, c && c.sampleFlag, c && c.promotionTier, c && c.rawVerdict, c && c.effectiveVerdict, c && c.robustnessFinal].concat(arr(c && c.promotionReasons)).map(text).join(' | ');
          const out = [];
          if (/LAB_ONLY/i.test(raw)) out.push('LAB_ONLY'); if (/sample|LOW_SAMPLE|OOS/i.test(raw)) out.push('SAMPLE'); if (/DD|drawdown/i.test(raw)) out.push('DRAWDOWN'); if (/PF/i.test(raw)) out.push('PF_GATE'); if (/WATCH/i.test(raw)) out.push('WATCH'); if (/DISCARD/i.test(raw)) out.push('DISCARD_CONTEXT'); if (/ROBUST/i.test(raw)) out.push('ROBUSTNESS_CONTEXT');
          return Array.from(new Set(out));
        }
        function safety(c) {
          const raw = [c && c.forwardBlockReason, c && c.lastRejectedReason, c && c.reason, c && c.blockReason, c && c.freshness, c && c.status, c && c.dataStatus].concat(arr(c && c.promotionReasons)).map(text).join(' | ').toUpperCase();
          if (/EMERGENCY/.test(raw)) return 'EMERGENCY_STOP';
          if (/NOT_LATEST_CLOSED_CANDLE|STALE|FRESHNESS|DELAYED|TOO_OLD/.test(raw)) return 'FRESHNESS_OR_CLOSED_CANDLE';
          if (/BAD_DATA|DATA_FAIL|FAILED DATA|GAP|DUPLICATE CANDLE|MISSING_CANDLE|NO_CANDLE|INVALID_PRICE|NAN|INFINITE/.test(raw)) return 'DATA_OR_PRICE_GUARD';
          if (/DUPLICATE_SIGNAL|SAME_SETUP|LITERAL_DUPLICATE/.test(raw)) return 'DUPLICATE_SETUP_GUARD';
          return '';
        }
        function classify(c) {
          const s = safety(c || {}); const m = metrics(c || {}); const ls = labels(c || {}).concat(m.promote ? ['QUANT_PASS'] : ['QUANT_WAIT']);
          if (s) return { tier: s === 'DATA_OR_PRICE_GUARD' ? 'DATA_BLOCKED' : 'SAFETY_BLOCKED', safetyReason: s, evidenceLabels: ls, quantitative: m };
          if ((c && c.forwardEligible === true) || /WATCHLIST|FORWARD/i.test(text(c && c.promotionTier))) return { tier: 'WATCH_FORWARD', safetyReason: '', evidenceLabels: ls, quantitative: m };
          if (m.promote) return { tier: 'FULL_AUTONOMY_FORWARD', safetyReason: '', evidenceLabels: ls.concat(['PROMOTED_BY_AUTONOMY']), quantitative: m };
          if (/WATCH|ROBUSTNESS_WATCH|KEEP/i.test([c && c.rawVerdict, c && c.effectiveVerdict, c && c.robustnessFinal].map(text).join('|'))) return { tier: 'RESEARCH_SANDBOX', safetyReason: '', evidenceLabels: ls.concat(['WAITING_FOR_QUANT_EVIDENCE']), quantitative: m };
          if (/DISCARD/i.test([c && c.rawVerdict, c && c.effectiveVerdict].map(text).join('|')) && Number(c && c.oosPF || 0) > 1 && Number(c && c.oosTrades || 0) >= 10) return { tier: 'RESEARCH_SANDBOX', safetyReason: '', evidenceLabels: ls.concat(['SANDBOX_RETEST']), quantitative: m };
          return { tier: 'RESEARCH_SANDBOX', safetyReason: '', evidenceLabels: ls, quantitative: m };
        }
        function rank(c) { const m = metrics(c); const dd = num(c && (c.oosDD ?? c.ddBps), 0); return num(c && c.score, 0) + m.posteriorPFgt1 * 100 + m.oosPF * 10 + m.nEffOOS * 0.4 + ((c && c.forwardEligible === true) ? 30 : 0) - dd / 5000; }
        function dedup(rows) {
          const clusters = new Map();
          for (const c of arr(rows).filter(Boolean)) {
            const ck = clusterKey(c); const cur = clusters.get(ck);
            if (!cur || rank(c) > rank(cur.rep)) clusters.set(ck, { key: ck, rep: c, members: cur ? cur.members.concat([c]) : [c] }); else cur.members.push(c);
          }
          const reps = [], topClusters = [];
          for (const cl of clusters.values()) {
            try { cl.rep.__alpsV931ClusterKey = cl.key; cl.rep.__alpsV931ClusterSize = cl.members.length; cl.rep.__alpsV931ClusterRepresentative = true; } catch (_) {}
            reps.push(cl.rep); if (cl.members.length > 1) topClusters.push({ key: cl.key, size: cl.members.length, representative: key(cl.rep) });
          }
          reps.sort((a,b) => rank(b) - rank(a));
          return { rows: reps, stats: { method: 'CLUSTER_REPRESENTATIVE_BEFORE_FORWARD_POOL', rawRows: arr(rows).length, clusters: clusters.size, selectedRows: reps.length, compressedRows: Math.max(0, arr(rows).length - clusters.size), topClusters: topClusters.sort((a,b)=>b.size-a.size).slice(0,12) } };
        }
        function sourceRows() { try { if (Array.isArray(globalThis.results) && globalThis.results.length) return globalThis.results; } catch (_) {} try { if (typeof results !== 'undefined' && Array.isArray(results) && results.length) return results; } catch (_) {} return []; }
        function promoteInPlace(c, cls) {
          if (!c || !/^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD)$/.test(text(cls && cls.tier))) return false;
          const tier = text(cls.tier);
          c.__alpsV931Tier = tier; c.__alpsV931EvidenceLabels = cls.evidenceLabels; c.__alpsV931Quantitative = cls.quantitative; c.__alpsV931AuthoritativeForward = true;
          c.forwardEligible = true; c.eligible = true; c.forwardBlockReason = ''; c.blockReason = ''; c.promotionBlocked = false; c.promotionGateBlocked = false; c.promotionStatus = tier; c.promotionGateSummary = tier; c.candidateTier = tier;
          if (tier === 'FULL_AUTONOMY_FORWARD') c.promotionTier = 'FULL_AUTONOMY_FORWARD';
          if (c.promotionGate && typeof c.promotionGate === 'object') { c.promotionGate.forwardEligible = true; c.promotionGate.eligible = true; c.promotionGate.blocked = false; c.promotionGate.blockReason = ''; c.promotionGate.reason = ''; c.promotionGate.status = tier; c.promotionGate.summary = tier; }
          return true;
        }
        function buildNativeFromRows(rows) {
          const d = dedup(rows); const out = []; const seen = new Set();
          for (const tier of ['FULL_AUTONOMY_FORWARD','WATCH_FORWARD','RESEARCH_SANDBOX']) {
            for (const c of d.rows) {
              const ck = clusterKey(c); if (seen.has(ck)) continue; const cls = classify(c); if (cls.tier !== tier) continue; seen.add(ck); if (/^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD)$/.test(cls.tier)) promoteInPlace(c, cls);
              out.push({ key: key(c), clusterKey: ck, clusterSize: Number(c.__alpsV931ClusterSize || 1), pair: c.pair || c.baseSymbol || text(c.sym).split('_')[0], timeframe: c.timeframe || '', strategy: c.strategy || c.stratName || '', exit: c.exit || c.exitName || '', tier: cls.tier, evidenceLabels: cls.evidenceLabels, safetyReason: cls.safetyReason, quantitative: cls.quantitative, oosPF: c.oosPF, oosTrades: c.oosTrades, score: c.score, originalPromotionTier: c.promotionTier, originalForwardEligible: c.forwardEligible === true, originalBlockReason: c.forwardBlockReason || '' });
              if (out.length >= 20) break;
            }
            if (out.length >= 20) break;
          }
          const count = t => out.filter(x => x.tier === t).length;
          return { schema:'alps.nativeForwardPool.view.v1', version: policy.version, installed:true, poolViewCap:20, totalCandidates: out.length, fullAutonomyForward: count('FULL_AUTONOMY_FORWARD'), watchForward: count('WATCH_FORWARD'), researchSandbox: count('RESEARCH_SANDBOX'), cognitionSuspended: count('COGNITION_SUSPENDED'), safetyBlocked: count('SAFETY_BLOCKED'), dataBlocked: count('DATA_BLOCKED'), promotedByFullAutonomy: count('FULL_AUTONOMY_FORWARD'), blockedBySafety: count('SAFETY_BLOCKED') + count('DATA_BLOCKED'), quantitativePromotion:{ installed:true, rule:'nEff_OOS>=25 AND P(PF>1)>=0.90 AND rolling/stress pass', passed: out.filter(x=>x.quantitative && x.quantitative.promote).length, thresholds:{ nEffOOS:25, posteriorPFgt1:0.90, rollingMinPF:0.60, fallbackPF:1.80, fallbackStress5:1.20 } }, duplicateCompression: d.stats, evidenceLabels: Array.from(new Set(out.flatMap(x=>x.evidenceLabels||[]))), candidates: out };
        }
        function mutationGovernorFromReport(report) {
          const logs = arr(report && report.recentLogs); let z=0, c=0, m=0; for (const line of logs) { const t=text(line); if (/0 improvements/i.test(t)) { z++; c++; } const mm=t.match(/Missing Edge:\s*(\d+)\s*hypotheses/i); if (mm) m += Number(mm[1]||0); }
          const active = c >= 12 || z >= 12;
          return { schema:'alps.mutationGovernor.view.v1', version: policy.version, installed:true, mode: active ? 'EXPLORATION_REBALANCE' : 'NORMAL_MUTATION', active, zeroImprovementLogs:z, consecutiveZeroImprovement:c, missingEdgeGenerated:m, trigger: active ? 'ZERO_IMPROVEMENT_STAGNATION' : '', action: active ? 'Selection budget rebalanced to cluster representatives and under-covered hypotheses.' : 'Observe' };
        }
        function applyNow() { let mutated=0; const native = buildNativeFromRows(sourceRows()); for (const c of sourceRows()) { const cls=classify(c); if (/^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD)$/.test(cls.tier) && promoteInPlace(c, cls)) mutated++; } status.nativeForwardPool = native; status.fullAutonomy = { schema:'alps.fullAutonomy.view.v1', version: policy.version, enabled:true, mode:'DECIDE_AND_ACT_PAPER_ONLY', paperOnly:true, liveCapitalExecution:false, duplicateCompression:native.duplicateCompression, quantitativePromotion:native.quantitativePromotion, decisions:[ native.duplicateCompression.compressedRows ? {action:'DEDUP_FORWARD_POOL', reason:`${native.duplicateCompression.compressedRows} rows compressed`} : {action:'WAIT_FOR_EVIDENCE', reason:'Awaiting fresh closed-candle signal'} ], lastDecision: native.promotedByFullAutonomy ? 'FULL_AUTONOMY_FORWARD_QUANT_PASS' : 'WAIT_FOR_EVIDENCE', nativeForwardPool:{ totalCandidates:native.totalCandidates, promotedByFullAutonomy:native.promotedByFullAutonomy, blockedBySafety:native.blockedBySafety } }; status.nativeExecutionControl = { installed:true, authoritative:true, version:policy.version, mutatedCandidates:mutated, lastAppliedAt:Date.now(), rule:'Deduped cluster representatives are selected first; only WATCH_FORWARD and quantitative FULL_AUTONOMY_FORWARD are written back as forward-eligible.' }; status.engineHook = { installed:true, safe:true, version:policy.version, lastError:status.lastError||'', wrappedFunctions:arr(status.wrappedFunctions), fallbackActive:!!status.fallbackActive, nativeExecutionControl:status.nativeExecutionControl }; status.decisionIntelligence = { schema:'alps.decisionIntelligence.view.v1', version:policy.version, duplicateCompression:native.duplicateCompression, quantitativePromotion:native.quantitativePromotion, mutationGovernor:status.mutationGovernor || null }; return native; }
        function patchPool(name) {
          try { const original = globalThis[name] || window[name]; if (typeof original !== 'function' || original.__alpsV931Wrapped) return false; const wrapped = function(...args) { try { const base = arr(original.apply(this,args)); const combined = base.concat(sourceRows()); const native = buildNativeFromRows(combined); const out = native.candidates.map(x => Object.assign({}, combined.find(c => key(c) === x.key) || {}, { __alpsV931Tier:x.tier, forwardEligible:/^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD)$/.test(x.tier), forwardBlockReason:/^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD)$/.test(x.tier)?'':(x.originalBlockReason||''), candidateTier:x.tier, promotionStatus:x.tier, promotionGateSummary:x.tier })); status.nativeForwardPool = native; return out.slice(0, Number(policy.technicalCap || 360)); } catch(err) { status.lastError=String(err&&err.message||err); status.fallbackActive=true; return original.apply(this,args); } }; wrapped.__alpsV931Wrapped = true; try { globalThis[name]=wrapped; } catch(_) { window[name]=wrapped; } if (!status.wrappedFunctions.includes(name+':v931')) status.wrappedFunctions.push(name+':v931'); return true; } catch(err) { status.lastError=String(err&&err.message||err); status.fallbackActive=true; return false; }
        }
        patchPool('forwardCandidatePool'); patchPool('activeForwardCandidatePool');
        try { const originalReport = globalThis.buildRunReportObject || window.buildRunReportObject; if (typeof originalReport === 'function' && !originalReport.__alpsV931Wrapped) { const wrappedReport = async function(...args) { const report = await originalReport.apply(this,args); try { const native = buildNativeFromRows(arr(report && report.research && report.research.topStrategies).length ? report.research.topStrategies : sourceRows()); const mg = mutationGovernorFromReport(report); status.mutationGovernor = mg; status.nativeForwardPool = native; report.nativeForwardPool = native; report.fullAutonomyNativeForwardPool = native; report.mutationGovernor = mg; report.decisionIntelligence = { schema:'alps.decisionIntelligence.view.v1', version:policy.version, duplicateCompression:native.duplicateCompression, quantitativePromotion:native.quantitativePromotion, mutationGovernor:mg }; report.fullAutonomy = Object.assign({}, status.fullAutonomy || {}, { version:policy.version, enabled:true, paperOnly:true, liveCapitalExecution:false, decisions:[ native.duplicateCompression.compressedRows ? {action:'DEDUP_FORWARD_POOL', reason:`${native.duplicateCompression.compressedRows} duplicate rows compressed before forward pool.`} : {action:'WAIT_FOR_EVIDENCE', reason:'No compression required.'}, mg.active ? {action:'REBUILD', reason:'Mutation stagnation moved selection to exploration representatives.'} : null ].filter(Boolean), lastDecision: mg.active ? 'EXPLORATION_REBALANCE' : (native.promotedByFullAutonomy ? 'FULL_AUTONOMY_FORWARD_QUANT_PASS' : 'WAIT_FOR_EVIDENCE'), duplicateCompression:native.duplicateCompression, quantitativePromotion:native.quantitativePromotion, mutationGovernor:mg }); report.nativeExecutionControl = status.nativeExecutionControl; report.engineHook = status.engineHook; } catch(err) { status.lastError=String(err&&err.message||err); status.fallbackActive=true; } return report; }; wrappedReport.__alpsV931Wrapped = true; globalThis.buildRunReportObject = wrappedReport; if (!status.wrappedFunctions.includes('buildRunReportObject:v931')) status.wrappedFunctions.push('buildRunReportObject:v931'); } } catch(err) { status.lastError=String(err&&err.message||err); status.fallbackActive=true; }
        try { applyNow(); } catch(_) {}
        if (!status.wrappedFunctions.includes('dedupBeforeForwardPool')) status.wrappedFunctions.push('dedupBeforeForwardPool');
        if (!status.wrappedFunctions.includes('quantitativePromotionRule')) status.wrappedFunctions.push('quantitativePromotionRule');
        if (!status.wrappedFunctions.includes('stagnationExplorationGovernor')) status.wrappedFunctions.push('stagnationExplorationGovernor');
        status.installed = true; status.safe = true;
        return status;
      }, policy);
      if (status931?.engineHook) lastEngineHookView = buildEngineHookView(status931.engineHook || status931 || {});
    } catch (v931Error) {
      try { console.error('v9.3.1 page overlay failed', v931Error); } catch (_) {}
    }

    lastEngineHookView = buildEngineHookView(status?.engineHook || status || {});
    return lastEngineHookView;
  } catch (e) {
    lastEngineHookView = buildEngineHookView({ installed: false, safe: true, lastError: e.message, fallbackActive: true, wrappedFunctions: [] });
    return lastEngineHookView;
  }
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
      await installV930InitScripts().catch(e => log('v9.3 boot guard install failed:', e.message));
      await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForLoadState('load', { timeout: 120_000 }).catch(() => null);
      await page.waitForFunction(() => typeof buildRunReportObject === 'function' || typeof startWatch === 'function', null, { timeout: 120_000 }).catch(() => null);
      await installV930StableAutonomyInPage().catch(e => log('v9.3 stable autonomy install after load failed:', e.message));
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
      engineReady: val(() => !!engineReady, false),
      nativeForwardPool: val(() => window.__ALPS_FINAL_V930__?.nativeForwardPool || null, null),
      fullAutonomy: val(() => window.__ALPS_FINAL_V930__?.fullAutonomy || null, null),
      engineHook: val(() => window.__ALPS_FINAL_V930__?.engineHook || null, null),
      nativeExecutionControl: val(() => window.__ALPS_FINAL_V930__?.nativeExecutionControl || null, null),
      circuitBreaker: val(() => ({ enabled: true, open: false, reason: '', fallbackMode: 'ADVANCED_MODULES_ACTIVE', disabledModules: [] }), null),
      chart: val(() => window.__ALPS_FINAL_V930__?.chart || null, null),
      mutationGovernor: val(() => window.__ALPS_FINAL_V930__?.mutationGovernor || null, null),
      decisionIntelligence: val(() => window.__ALPS_FINAL_V930__?.decisionIntelligence || null, null),
      dataSource: 'LIVE SNAPSHOT'
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
  await installV930StableAutonomyInPage().catch(e => log('v9.3 stable autonomy install before health failed:', e.message));
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
    await installV930StableAutonomyInPage().catch(e => log('v9.3 stable autonomy install before catch-up failed:', e.message));
    const before = enhanceHealth(await getPageHealth());
    await installAutonomousBridgeInPage().catch(e => log('Autonomous bridge install before catch-up failed:', e.message));
    await installV930StableAutonomyInPage().catch(e => log('v9.3 stable autonomy reinstall after bridge failed:', e.message));

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
  let report = await pageEval(async () => {
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

  const pageV930Status = await installV930StableAutonomyInPage().catch(e => ({ installed: false, safe: true, lastError: e.message, fallbackActive: true, wrappedFunctions: [] }));
  report = enrichReportV930(report, pageV930Status);

  const rawTradeLedgers = await collectPageTradeLedgers().catch(e => ({
    openTrades: [],
    closedTrades: [],
    sourceStats: { error: e.message }
  }));

  lastTradeExport = buildTradeExport(rawTradeLedgers);
  await updateTradeVault(lastTradeExport, 'report');
  report.alpsTradeExport = lastTradeExport;
  report.alpsTradeContinuityVault = buildTradeVaultView();
  report.alpsCognition = await updateCognitionState(report, lastTradeExport);
  report.alpsAutonomousBridge = await updateAutonomousBridgeState(report, report.alpsCognition);
  report.autonomousBridgeInstall = await installAutonomousBridgeInPage(report.alpsAutonomousBridge).catch(e => ({ installed: false, error: e.message }));
  await installV930StableAutonomyInPage().catch(e => log('v9.3 stable autonomy install during report failed:', e.message));
  report = enrichReportV930(report, lastEngineHookView || report.engineHook || {});

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
  md = `${md}\n\n${buildV930Markdown(report)}`;
  md = appendRecoveryMarkdown(md);
  lastReportMarkdown = md;
  lastHealth.lastReportAt = Date.now();
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-report.json'), JSON.stringify(report, null, 2));
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-report.md'), md);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-trades.json'), JSON.stringify(lastTradeExport, null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-trades-vault.json'), JSON.stringify(buildTradeVaultView(), null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-autonomy.json'), JSON.stringify(report.alpsAutonomousBridge || {}, null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-native-forward-pool.json'), JSON.stringify(report.nativeForwardPool || {}, null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-v930.json'), JSON.stringify({ fullAutonomy: report.fullAutonomy, nativeForwardPool: report.nativeForwardPool, engineHook: report.engineHook, circuitBreaker: report.circuitBreaker, chart: report.chart, counterfactual: report.counterfactual }, null, 2)).catch(() => null);
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
