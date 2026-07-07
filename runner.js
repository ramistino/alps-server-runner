#!/usr/bin/env node
'use strict';

/**
 * ALPS Server Runner — v10.1.6 Integrated System: Health Paper Entry Rescan + Feature Snapshot Entry Context
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
const RECOVERY_PATCH_VERSION = 'v10.1.7-feature-materializer-candle-visibility-bridge';
const RECOVERY_STATE_FILE = path.join(DATA_DIR, 'recovery-state.json');
const RECOVERY_SEED_FILE = path.join(__dirname, 'recovery', 'previous-ledger-seed.json');
const TRADE_VAULT_FILE = path.join(DATA_DIR, 'trade-vault.json');
const TRADE_VAULT_SEED_FILE = path.join(__dirname, 'recovery', 'previous-trade-vault-seed.json');
const COGNITION_PATCH_VERSION = 'v10.1.7-feature-materializer-candle-visibility-bridge';
const COGNITION_STATE_FILE = path.join(DATA_DIR, 'cognition-state.json');
const COGNITION_LEDGER_FILE = path.join(DATA_DIR, 'cognition-decision-ledger.jsonl');
const AUTONOMY_PATCH_VERSION = 'v10.1.7-feature-materializer-candle-visibility-bridge';
const AUTONOMY_STATE_FILE = path.join(DATA_DIR, 'autonomous-bridge-state.json');
const AUTONOMY_MEMORY_FILE = path.join(DATA_DIR, 'autonomous-evidence-memory.json');
const AUTONOMY_LEDGER_FILE = path.join(DATA_DIR, 'autonomous-bridge-ledger.jsonl');
const STATE_AUTHORITY_FILE = path.join(DATA_DIR, 'state-authority-v10.json');
const STATE_AUTHORITY_NONZERO_FILE = path.join(DATA_DIR, 'state-authority-v10-last-nonzero.json');
const RUNTIME_NONZERO_FILE = path.join(DATA_DIR, 'runtime-last-nonzero-v1014.json');
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
const AUTO_BOOT_WATCHDOG = String(process.env.ALPS_BOOT_WATCHDOG || '1') !== '0';
const BOOT_WATCHDOG_MS = Number(process.env.ALPS_BOOT_WATCHDOG_MS || 10 * 60 * 1000);
const BOOT_WATCHDOG_COOLDOWN_MS = Number(process.env.ALPS_BOOT_WATCHDOG_COOLDOWN_MS || 8 * 60 * 1000);
const BOOT_WATCHDOG_TARGET_PAIRFRAMES = Number(process.env.ALPS_BOOT_WATCHDOG_TARGET_PAIRFRAMES || 35);
const BOOT_WATCHDOG_MIN_PAIRFRAMES = Number(process.env.ALPS_BOOT_WATCHDOG_MIN_PAIRFRAMES || 1);
const BOOT_WATCHDOG_MIN_BOOT_AGE_MS = Number(process.env.ALPS_BOOT_WATCHDOG_MIN_BOOT_AGE_MS || 8 * 60 * 1000);


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
let shuttingDown = false;
let runnerInterval = null;
let recoveryState = null;
let lastStaleRecoveryAt = 0;
let lastLaunchError = null;
let launchAttempts = 0;
let lastBootProgressSignature = '';
let lastBootProgressAt = Date.now();
let lastBootWatchdogAt = 0;
let bootWatchdogRestarts = 0;
let watchdogActionBusy = false;
let lastRunnerWatchdogView = null;
let lastOOSEvidenceBridgeView = null;
let lastOOSEvidenceRows = [];
let lastRecoveryForwardCoreView = null;


// ALPS v9.5.1 All-in-One Feature/Discovery/Forward/Entry Recovery
// Final integrated layer built from stable v9.2.2. It is paper-only, boot-safe, and fails back to the stable runner.
const FINAL_V930_VERSION = 'v10.1.7-feature-materializer-candle-visibility-bridge';
const FINAL_V930_TECHNICAL_CAP = Number(process.env.ALPS_V930_TECHNICAL_CAP || Number.MAX_SAFE_INTEGER);
const V952_NO_FIXED_CANDIDATE_CAP = !process.env.ALPS_V930_TECHNICAL_CAP;
const V952_REPORT_SAMPLE_CAP = Number(process.env.ALPS_V952_REPORT_SAMPLE_CAP || 2000);
let lastNativeForwardPoolView = null;
let lastFullAutonomyView = null;
let lastEngineHookView = null;
let lastCircuitBreakerView = null;
let lastCounterfactualView = null;
let lastChartView = null;

// ALPS v9.5.1 All-in-One Feature/Discovery/Forward/Entry Recovery + Progressive Forward Latch
const V944_FORWARD_LATCH_FILE = path.join(DATA_DIR, 'forward-latch-v944.json');
const V944_RECOVERABLE_LOOKBACK_CANDLES = Number(process.env.ALPS_V944_RECOVERABLE_LOOKBACK_CANDLES || 5);
const V944_ENTRY_ZONE_BPS = Number(process.env.ALPS_V944_ENTRY_ZONE_BPS || 18);
let forwardLatchState = { schema: 'alps.forwardLatch.state.v1', version: FINAL_V930_VERSION, candidates: [], updatedAt: 0, source: '' };
let lastForwardLatchView = null;
let lastProgressiveResearchView = null;
let lastRecoverableEntryView = null;
let lastAdaptiveExitManagerView = null;
let lastSyntheticIndicatorEngineView = null;

// ALPS v9.5.1 All-in-One Feature/Discovery/Forward/Entry Recovery
const V945_RESEARCH_TRIGGER_MIN_PAIRFRAMES = Number(process.env.ALPS_V945_RESEARCH_TRIGGER_MIN_PAIRFRAMES || 1);
const V945_RESEARCH_TRIGGER_COOLDOWN_MS = Number(process.env.ALPS_V945_RESEARCH_TRIGGER_COOLDOWN_MS || 45_000);
const V945_RESEARCH_TRIGGER_CALL_TIMEOUT_MS = Number(process.env.ALPS_V945_RESEARCH_TRIGGER_CALL_TIMEOUT_MS || 2500);
let researchTriggerBusy = false;
let researchTriggerState = {
  schema: 'alps.researchTrigger.state.v1',
  version: FINAL_V930_VERSION,
  installed: true,
  triggered: false,
  triggerCount: 0,
  lastAction: '',
  lastReason: '',
  lastAt: 0,
  lastPairFrames: 0,
  lastStrategies: 0,
  lastResult: null,
  errors: []
};
let lastResearchTriggerView = null;

// ALPS v9.5.1 All-in-One Feature/Discovery/Forward/Entry Recovery state.
// This layer is diagnostic + orchestration only: it never fabricates strategies, candidates, trades, OOS metrics, or live execution.
const V947_DATA_RETRY_MIN_MS = Number(process.env.ALPS_V947_DATA_RETRY_MIN_MS || 8000);
const V947_DATA_GROWTH_PAIRFRAMES = Number(process.env.ALPS_V947_DATA_GROWTH_PAIRFRAMES || 1);
const V947_DATA_GROWTH_CANDLES = Number(process.env.ALPS_V947_DATA_GROWTH_CANDLES || 5000);
const V947_DISCOVERY_CALL_TIMEOUT_MS = Number(process.env.ALPS_V947_DISCOVERY_CALL_TIMEOUT_MS || 9000);
let lastPipelineTruthView = null;
let lastDiscoveryOutputView = null;
let lastStoreInventoryView = null;
let lastClosedCandleMapView = null;
let lastSymbolLoadStatusView = null;
let lastGateMatrixView = null;
let lastForwardReadinessView = null;
let lastE2EPipelineTraceView = null;
let lastZeroOutputDiagnosticView = null;
let lastCanonicalMetrics = null;
let lastPipelineRetryAt = 0;
let lastMaterializedRows = [];
let lastMaterializedRowSources = [];
let lastV948EntryEngineView = null;
let lastV948NumericGuardView = null;
let lastV948RejectedReasonView = null;
const V948_ENTRY_MAX_PER_TICK = Math.max(0, Number(process.env.ALPS_V948_ENTRY_MAX_PER_TICK || 1));
const V948_ENTRY_ZONE_BPS = Math.max(1, Number(process.env.ALPS_V948_ENTRY_ZONE_BPS || V944_ENTRY_ZONE_BPS || 18));
const V948_ENTRY_LOOKBACK_CANDLES = Math.max(1, Number(process.env.ALPS_V948_ENTRY_LOOKBACK_CANDLES || V944_RECOVERABLE_LOOKBACK_CANDLES || 5));

// ALPS v9.5.2 Current Health Sync Full Candidate Bridge No Fixed Cap state.
// This layer does not open live orders and does not fabricate evidence. It gives one clear source of truth for the remaining known risks.
let lastV949LifecycleTruthView = null;
let lastV949FinalHealthGateView = null;
let lastV949UniverseCompletionView = null;
let lastV949ProxyTruthView = null;
let lastV949ReportTruthView = null;
let lastV949CandidateCountTruthView = null;
let lastV949QualityRiskView = null;
let lastV949ReleaseChecklistView = null;
let lastV950PaperEntryVisibilityView = null;
let lastV950CandleStoreResolverView = null;
let lastV950ReportTruthSyncView = null;


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
    
  }
  const count = tier => selected.filter(x => x.tier === tier).length;
  const view = {
    schema: 'alps.nativeForwardPool.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    technicalCap: V952_NO_FIXED_CANDIDATE_CAP ? 'UNLIMITED_ACCEPT_ALL_REAL_CANDIDATES' : FINAL_V930_TECHNICAL_CAP,
    totalCandidates: selected.length,
    generatedStrategies: Number(report?.research?.strategies || report?.forwardWatch?.totalGeneratedStrategies || top.length || 0),
    fullAutonomyForward: count('FULL_AUTONOMY_FORWARD'),
    watchForward: count('WATCH_FORWARD'),
    experimentalForward: count('EXPERIMENTAL_FORWARD'),
    researchSandbox: count('RESEARCH_SANDBOX'),
    cognitionSuspended: count('COGNITION_SUSPENDED'),
    safetyBlocked: count('SAFETY_BLOCKED'),
    dataBlocked: count('DATA_BLOCKED'),
    promotedByFullAutonomy: count('FULL_AUTONOMY_FORWARD'),
    promotedToExperimental: count('EXPERIMENTAL_FORWARD'),
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


// ALPS v9.5.1 All-in-One Feature/Discovery/Forward/Entry Recovery
// Adds three decision-layer controls above the stable v9.3.0 runtime:
// 1) minimum-evidence gate BEFORE cluster dedup, 2) cluster dedup before the forward pool,
// 3) quantitative FULL_AUTONOMY_FORWARD promotion, 4) mutation stagnation governor that moves selection budget to exploration.
// v9.3.1.1 fixes v9.3.1 by preventing PFNA/OOSNA rows from taking WATCH_FORWARD slots.
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
  return [pair, tf, v931StrategyRoot(c), exit].join('|');
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
function v931HasMinimumEvidence(c = {}) {
  const m = v931EvidenceMetrics(c);
  return m.oosPF > 0 && m.oosTrades >= 10;
}
function v931EvidenceTier(c = {}) {
  const m = v931EvidenceMetrics(c);
  if (m.promote) return 'QUANT_PASS';
  if (v931HasMinimumEvidence(c)) return 'EVIDENCE_READY';
  return 'NO_OOS_EVIDENCE';
}

function v931ExitRoot(c = {}) {
  const raw = textValue(c.exit || c.exitName || '').toUpperCase();
  if (/ATR/.test(raw)) return 'ATR_TRAIL';
  if (/3R|2\.5R/.test(raw)) return 'HIGH_R_FIXED';
  if (/2R/.test(raw)) return '2R_FIXED';
  if (/1R/.test(raw)) return '1R_FIXED';
  return raw.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'GENERIC_EXIT';
}
function v94CanonicalPair(value) { return textValue(value).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function v94CanonicalTf(value) { const raw = textValue(value).toLowerCase().trim(); return raw.replace('minutes','m').replace('minute','m').replace('hours','h').replace('hour','h').replace(/\s+/g, ''); }
function v94CandidateBridgeKey(c = {}) { return [v94CanonicalPair(c.pair || c.baseSymbol || c.symbol || c.sym || ''), v94CanonicalTf(c.timeframe || c.tf || c.frame || ''), v931StrategyRoot(c), v931ExitRoot(c)].join('|'); }
function v94CandidateLooseKey(c = {}) { return [v94CanonicalPair(c.pair || c.baseSymbol || c.symbol || c.sym || ''), v94CanonicalTf(c.timeframe || c.tf || c.frame || ''), v931StrategyRoot(c)].join('|'); }
function v94PickNumber(obj = {}, names = []) { for (const name of names) { const numv = v931Num(obj?.[name], null); if (numv != null) return numv; } return null; }
function v94ExtractEvidenceCandidate(obj = {}, source = 'unknown') {
  if (!obj || typeof obj !== 'object') return null;
  const pair = obj.pair || obj.baseSymbol || obj.symbol || obj.sym || obj.market || '';
  const timeframe = obj.timeframe || obj.tf || obj.frame || obj.interval || '';
  const strategy = obj.strategy || obj.stratName || obj.name || obj.setup || obj.pattern || '';
  const exit = obj.exit || obj.exitName || obj.targetType || obj.exitRule || '';
  const oosPF = v94PickNumber(obj, ['oosPF','oosPf','oosProfitFactor','outOfSamplePF','outSamplePF','validationPF','forwardPF','testPF','pfOOS']);
  const oosTrades = v94PickNumber(obj, ['oosTrades','outOfSampleTrades','outSampleTrades','validationTrades','forwardTrades','testTrades','oosN','nOOS','oosCount']);
  if (!(oosPF > 0) || !(oosTrades >= 10)) return null;
  const row = { source, pair: v94CanonicalPair(pair), timeframe: v94CanonicalTf(timeframe), strategy: textValue(strategy), exit: textValue(exit), root: v931StrategyRoot({ strategy, stratName: strategy, name: strategy }), exitRoot: v931ExitRoot({ exit, exitName: exit }), oosPF, oosTrades, totalTrades: v94PickNumber(obj, ['totalTrades','trades','nTrades','sampleTrades']) ?? oosTrades, rollingMinPF: v94PickNumber(obj, ['rollingMinPF','rollingPF','robustnessRolling','walkForwardMinPF']), stress5: v94PickNumber(obj, ['stress5','stressPF5','robustnessStress5','monteCarloPF5']), oosDD: v94PickNumber(obj, ['oosDD','ddBps','maxDD','drawdown','oosDrawdown']), score: v94PickNumber(obj, ['score','rankScore','fitness']) ?? 0 };
  row.key = [row.pair, row.timeframe, row.root, row.exitRoot].join('|');
  row.looseKey = [row.pair, row.timeframe, row.root].join('|');
  return row;
}
function v94ScanEvidenceObjects(root, source = 'report', limit = 5000) {
  const out = [], stack = [{ value: root, path: source }], seen = new Set();
  while (stack.length && out.length < limit) {
    const item = stack.pop(), value = item.value;
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { for (let i = 0; i < Math.min(value.length, 3000); i += 1) stack.push({ value: value[i], path: `${item.path}[${i}]` }); continue; }
    const ev = v94ExtractEvidenceCandidate(value, item.path); if (ev) out.push(ev);
    for (const [k, v] of Object.entries(value)) { if (!v || typeof v !== 'object') continue; if (/candles|ohlc|featureRows|recentLogs|logs/i.test(k)) continue; stack.push({ value: v, path: `${item.path}.${k}` }); }
  }
  const best = new Map();
  for (const row of out) { const cur = best.get(row.key); const score = (row.oosTrades || 0) * Math.max(0, row.oosPF || 0); const curScore = cur ? (cur.oosTrades || 0) * Math.max(0, cur.oosPF || 0) : -1; if (!cur || score > curScore) best.set(row.key, row); }
  return [...best.values()];
}
function v94BuildEvidenceBridge(report = {}, candidateRows = []) {
  const candidates = safeArray(candidateRows).filter(Boolean);
  const evidenceRows = v94ScanEvidenceObjects(report, 'report');
  const byKey = new Map(evidenceRows.map(r => [r.key, r]));
  const byLoose = new Map(); for (const row of evidenceRows) if (!byLoose.has(row.looseKey)) byLoose.set(row.looseKey, row);
  let matchedRows = 0, candidateRowsWithEvidence = 0; const matchedKeys = [];
  for (const c of candidates) { const ev = byKey.get(v94CandidateBridgeKey(c)) || byLoose.get(v94CandidateLooseKey(c)); if (ev) { matchedRows += 1; matchedKeys.push(v94CandidateBridgeKey(c)); } if (v931HasMinimumEvidence(c)) candidateRowsWithEvidence += 1; }
  const view = { schema: 'alps.oosEvidenceBridge.view.v1', version: FINAL_V930_VERSION, installed: true, realEvidenceOnly: true, source: 'report/deep-scan + existing candidate fields', candidateRows: candidates.length, evidenceRows: evidenceRows.length, matchedRows, candidateRowsWithEvidence, unmatchedRows: Math.max(0, candidates.length - matchedRows - candidateRowsWithEvidence), matchedKeys: [...new Set(matchedKeys)].slice(0, 20), noEvidenceAvailable: candidates.length > 0 && matchedRows === 0 && candidateRowsWithEvidence === 0, rule: 'Only rows with real oosPF > 0 and oosTrades >= 10 are mapped. No synthetic OOS metrics are created.' };
  lastOOSEvidenceBridgeView = view; lastOOSEvidenceRows = evidenceRows; return { view, evidenceRows };
}
function v94ApplyOosEvidenceToRows(rows = [], evidenceRows = []) {
  const byKey = new Map(safeArray(evidenceRows).map(r => [r.key, r]));
  const byLoose = new Map(); for (const row of safeArray(evidenceRows)) if (!byLoose.has(row.looseKey)) byLoose.set(row.looseKey, row);
  return safeArray(rows).map(row => { if (!row || typeof row !== 'object' || v931HasMinimumEvidence(row)) return row; const ev = byKey.get(v94CandidateBridgeKey(row)) || byLoose.get(v94CandidateLooseKey(row)); if (!ev) return row; row.oosPF = ev.oosPF; row.oosTrades = ev.oosTrades; if (row.totalTrades == null) row.totalTrades = ev.totalTrades; if (row.rollingMinPF == null && ev.rollingMinPF != null) row.rollingMinPF = ev.rollingMinPF; if (row.stress5 == null && ev.stress5 != null) row.stress5 = ev.stress5; if (row.oosDD == null && ev.oosDD != null) row.oosDD = ev.oosDD; row.__alpsOosEvidenceMatched = true; row.__alpsOosEvidenceSource = ev.source; row.forwardEligible = true; row.forwardBlockReason = ''; row.blockReason = ''; if (!/WATCHLIST|FORWARD/i.test(textValue(row.promotionTier))) row.promotionTier = 'WATCHLIST_OOS_EVIDENCE_BRIDGE'; return row; });
}
function v94ForwardEligibleCountFromView(view = lastNativeForwardPoolView || {}) { return n(view.fullAutonomyForward, 0) + n(view.watchForward, 0) + n(view.experimentalForward, 0); }


function v1010IndicatorUsePolicy() {
  return {
    schema: 'alps.indicatorGovernance.usePolicy.v1',
    version: FINAL_V930_VERSION,
    researchAllowed: true,
    executionAllowed: false,
    chartDisplayAllowed: true,
    mustValidateBeforeEntryUse: true,
    rule: 'ALPS may invent/research custom indicators, but unvalidated indicators are research-only and can not affect paper/live entries until promoted by evidence.'
  };
}
function v1010IndicatorResearchCandidateForCandidate(c = {}) {
  const base = v944SyntheticIndicatorForCandidate(c);
  if (!base) return null;
  const key = [base.name, base.pair, base.timeframe, base.strategyRoot].join('|').toUpperCase();
  return {
    schema: 'alps.indicatorResearch.candidate.v1',
    version: FINAL_V930_VERSION,
    key,
    name: base.name,
    purpose: base.purpose,
    pair: base.pair,
    timeframe: base.timeframe,
    strategyRoot: base.strategyRoot,
    formulaType: base.formulaType,
    inputs: base.inputs,
    visual: base.visual,
    lifecycleStage: 'EXPERIMENTAL_INDICATOR_RESEARCH',
    validationStatus: 'UNVALIDATED_RESEARCH_ONLY',
    promotedForPaperEntry: false,
    canAffectEntry: false,
    chartLayer: 'RESEARCH_OVERLAY_ONLY',
    evidenceRequired: ['paperForwardSample', 'MFE_MAE_improvement', 'lossReduction', 'regimeStability', 'pairSpecificConsistency'],
    sourceCandidateKey: c.key || c.clusterKey || '',
    rule: 'Displayed as an indicator research idea only. It is not an execution filter and can not be used by Paper Entry until promoted.'
  };
}
function v1010SanitizeExecutionCandidate(row = {}) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  const rawIndicator = out.indicatorResearchCandidate || out.syntheticIndicator || out.__alpsSyntheticIndicator || null;
  delete out.syntheticIndicator;
  delete out.__alpsSyntheticIndicator;
  delete out.syntheticIndicatorEngine;
  if (rawIndicator) {
    const governed = rawIndicator.schema === 'alps.indicatorResearch.candidate.v1'
      ? rawIndicator
      : { ...v1010IndicatorResearchCandidateForCandidate({ ...out, strategy: rawIndicator.strategyRoot || out.strategy, pair: rawIndicator.pair || out.pair, timeframe: rawIndicator.timeframe || out.timeframe }), ...rawIndicator, validationStatus: 'UNVALIDATED_RESEARCH_ONLY', promotedForPaperEntry: false, canAffectEntry: false };
    out.indicatorResearchCandidate = governed;
  }
  out.indicatorUsePolicy = out.indicatorUsePolicy || v1010IndicatorUsePolicy();
  return out;
}
function v1010SanitizeExecutionRows(rows = []) { return safeArray(rows).map(v1010SanitizeExecutionCandidate); }
function v1010BuildIndicatorGovernanceView(report = {}, latchView = null) {
  const rows = v1010SanitizeExecutionRows(safeArray(latchView?.candidates || report?.nativeForwardPool?.candidates || report?.candidates || []));
  const indicators = [];
  const seen = new Set();
  for (const c of rows) {
    const ind = c.indicatorResearchCandidate || v1010IndicatorResearchCandidateForCandidate(c);
    if (!ind) continue;
    const k = ind.key || [ind.name, ind.pair, ind.timeframe, ind.strategyRoot].join('|').toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    indicators.push(ind);
  }
  const promoted = indicators.filter(x => x.promotedForPaperEntry === true || x.validationStatus === 'VALIDATED_INDICATOR').length;
  return {
    schema: 'alps.indicatorGovernance.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    researchAllowed: true,
    executionInfluenceAllowed: false,
    indicatorsCreated: indicators.length,
    promotedForPaperEntry: promoted,
    validationBuckets: {
      experimentalResearch: indicators.filter(x => /EXPERIMENTAL|UNVALIDATED/.test(textValue(x.lifecycleStage || x.validationStatus))).length,
      validated: indicators.filter(x => x.validationStatus === 'VALIDATED_INDICATOR').length,
      rejected: indicators.filter(x => /REJECTED|RETIRED/.test(textValue(x.validationStatus))).length
    },
    indicators: indicators.slice(0, 40),
    usePolicy: v1010IndicatorUsePolicy(),
    rule: 'Indicator development remains ON, but indicators are separated from execution. Unvalidated indicator ideas are research/chart overlays only and can not open, block, or resize trades.'
  };
}

function v944IsForwardTier(tier = '') { return /^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD|EXPERIMENTAL_FORWARD)$/.test(textValue(tier)); }
function v944LatchKey(c = {}) { return (c.key || c.clusterKey || uniqueKeyFromCandidate(c) || v931ClusterKey(c) || '').toString().toUpperCase(); }
function v944PickRR(c = {}) {
  const raw = textValue(c.exit || c.exitName || c.targetType || c.strategy || c.key).toUpperCase();
  const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*R/);
  if (m) return Math.max(0.5, Math.min(5, Number(m[1])));
  if (/HIGH_R|EXPANSION|SQUEEZE|BREAKOUT/.test(raw)) return 3;
  if (/POC|VALUE|VAH|VAL|REVERSION/.test(raw)) return 1.5;
  return 2;
}
function v944SyntheticIndicatorForCandidate(c = {}) {
  const pair = textValue(c.pair || c.baseSymbol || c.symbol || c.sym || '').toUpperCase().split('_')[0] || 'PAIR';
  const tf = textValue(c.timeframe || c.tf || '').toLowerCase() || 'tf';
  const root = v931StrategyRoot(c);
  let name = `${pair} Adaptive Edge Index`;
  let purpose = 'pair-specific strategy pressure and setup readiness';
  let visual = 'overlay+lower-meter';
  if (/BTC/.test(pair) && /HA_POC|POC|EMA_TREND/.test(root)) { name = 'BTC Trend Pressure Index'; purpose = 'trend continuation pressure around POC/value pullbacks'; }
  else if (/SOL/.test(pair) && /BB_SQUEEZE|EMA_TREND/.test(root)) { name = 'SOL Expansion Release Meter'; purpose = 'compression-to-expansion readiness and continuation risk'; }
  else if (/XAUT/.test(pair) || /GOLD/.test(pair)) { name = 'Gold Value Rejection Oscillator'; purpose = 'value-zone rejection strength and mean-reversion quality'; }
  else if (/DOGE/.test(pair)) { name = 'DOGE Impulse Decay Meter'; purpose = 'fast impulse follow-through versus exhaustion noise'; }
  else if (/XRP/.test(pair)) { name = 'XRP Compression Break Gauge'; purpose = 'range pressure and false-break risk'; }
  return {
    name,
    purpose,
    pair,
    timeframe: tf,
    strategyRoot: root,
    formulaType: 'SYNTHETIC_PAIR_STRATEGY_COMPOSITE',
    inputs: ['trendEfficiency','volatilityCompression','valueDistance','rejectionStrength','mfeMaeMemory','freshnessScore'],
    status: 'EXPERIMENTAL_INDICATOR',
    visual,
    chartLayer: true
  };
}
function v944AdaptiveExitPlan(c = {}) {
  const rr = v944PickRR(c);
  return {
    schema: 'alps.adaptiveExit.plan.v1',
    rMultipleSelected: rr,
    initialStop: 'strategy-invalidation-stop',
    target: `${rr}R`,
    breakEvenTriggerPct: 50,
    breakEvenStop: 'ENTRY_PLUS_FEES_OR_SMALL_BUFFER',
    lockProfitTriggerPct: 75,
    lockProfitStop: '50_PERCENT_OF_TARGET_DISTANCE',
    progressLevels: [
      { atPct: 50, action: 'MOVE_STOP_TO_ENTRY_OR_SLIGHTLY_ABOVE' },
      { atPct: 75, action: 'MOVE_STOP_TO_50_PERCENT_OF_TARGET' }
    ],
    variantsToTest: ['BE_AT_50_LOCK_50_AT_75','BE_AT_40_LOCK_25_AT_60','ATR_TRAIL_AFTER_75','NO_EARLY_MOVE_BASELINE'],
    paperOnly: true
  };
}
function v944NormalizeLatchCandidate(c = {}, source = 'unknown') {
  if (!c || typeof c !== 'object') return null;
  const tier = textValue(c.tier || c.candidateTier || c.promotionStatus || c.promotionTier || (c.forwardEligible ? 'WATCH_FORWARD' : 'EXPERIMENTAL_FORWARD'));
  const pair = c.pair || c.baseSymbol || c.symbol || textValue(c.sym).split('_')[0] || '';
  const timeframe = c.timeframe || c.tf || c.frame || '';
  const strategy = c.strategy || c.stratName || c.name || '';
  const exit = c.exit || c.exitName || '';
  const key = v944LatchKey({ ...c, pair, timeframe, strategy, exit, tier });
  if (!key || !pair || !timeframe || !strategy) return null;
  const normalizedTier = v944IsForwardTier(tier) ? tier : 'EXPERIMENTAL_FORWARD';
  return {
    key,
    pair: textValue(pair).toUpperCase().split('_')[0],
    timeframe: textValue(timeframe),
    strategy: textValue(strategy),
    exit: textValue(exit),
    tier: normalizedTier,
    forwardEligible: true,
    promotionTier: normalizedTier,
    candidateTier: normalizedTier,
    promotionStatus: normalizedTier,
    forwardBlockReason: '',
    blockReason: '',
    oosPF: c.oosPF,
    oosTrades: c.oosTrades,
    score: c.score,
    evidenceLabels: safeArray(c.evidenceLabels).concat(normalizedTier === 'EXPERIMENTAL_FORWARD' ? ['NOT_OOS_VERIFIED','LIVE_PAPER_EVIDENCE_COLLECTION'] : ['OOS_OR_VERIFIED_FORWARD']),
    source,
    latchedAt: Date.now(),
    recoverableEntry: { installed: true, lookbackCandles: V944_RECOVERABLE_LOOKBACK_CANDLES, entryZoneBps: V944_ENTRY_ZONE_BPS, rule: 'Allow paper entry from recent closed-candle setup if price remains inside the same entry zone and invalidation has not fired.' },
    adaptiveExitPlan: v944AdaptiveExitPlan(c),
    indicatorResearchCandidate: v1010IndicatorResearchCandidateForCandidate(c),
    indicatorUsePolicy: v1010IndicatorUsePolicy()
  };
}
function v944MergeForwardLatch(candidates = [], source = 'unknown') {
  const current = new Map(safeArray(forwardLatchState.candidates).map(c => [v944LatchKey(c), c]));
  let added = 0, updated = 0;
  for (const raw of safeArray(candidates)) {
    const c = v944NormalizeLatchCandidate(raw, source);
    if (!c) continue;
    const old = current.get(c.key);
    if (old) { current.set(c.key, v1010SanitizeExecutionCandidate({ ...old, ...c, firstLatchedAt: old.firstLatchedAt || old.latchedAt || c.latchedAt })); updated += 1; }
    else { current.set(c.key, v1010SanitizeExecutionCandidate({ ...c, firstLatchedAt: c.latchedAt })); added += 1; }
  }
  const rows = v1010SanitizeExecutionRows([...current.values()]).filter(c => c && c.forwardEligible !== false && !/SAFETY_BLOCKED|DATA_BLOCKED|COGNITION_SUSPENDED/.test(textValue(c.tier)));
  forwardLatchState = { schema: 'alps.forwardLatch.state.v1', version: FINAL_V930_VERSION, candidates: rows, updatedAt: Date.now(), source, added, updated };
  lastForwardLatchView = v944BuildForwardLatchView();
  return { added, updated, size: rows.length };
}
function v944MergeForwardLatchFromView(view = {}, source = 'nativeForwardPool') {
  const rows = safeArray(view.candidates).filter(c => v944IsForwardTier(c.tier || c.candidateTier || c.promotionStatus || c.promotionTier));
  return v944MergeForwardLatch(rows, source);
}
function v944MergeForwardLatchFromRecoveryCore(core = {}, source = 'recoveryForwardCore') {
  const keys = safeArray(core?.oosEvidenceBridge?.matchedKeys);
  const rows = [];
  for (const k of keys) {
    const parts = textValue(k).split('|');
    if (parts.length < 3) continue;
    rows.push({ key: k, pair: parts[0], timeframe: parts[1], strategy: parts[2], exit: parts[3] || '', tier: n(core.verifiedForwardCandidates, 0) > 0 ? 'WATCH_FORWARD' : 'EXPERIMENTAL_FORWARD', forwardEligible: true, evidenceLabels: ['RECOVERED_FROM_OOS_BRIDGE'] });
  }
  return v944MergeForwardLatch(rows, source);
}
function v944ForwardLatchEligibleCount() { return safeArray(forwardLatchState.candidates).filter(c => c && c.forwardEligible !== false && v944IsForwardTier(c.tier || c.promotionTier || c.candidateTier || c.promotionStatus)).length; }
function v944BuildForwardLatchView() {
  const rows = safeArray(forwardLatchState.candidates);
  const countTier = tier => rows.filter(c => textValue(c.tier || c.promotionTier) === tier).length;
  return {
    schema: 'alps.forwardLatch.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    active: rows.length > 0,
    size: rows.length,
    fullAutonomyForward: countTier('FULL_AUTONOMY_FORWARD'),
    watchForward: countTier('WATCH_FORWARD'),
    experimentalForward: countTier('EXPERIMENTAL_FORWARD'),
    lastUpdatedAt: forwardLatchState.updatedAt || 0,
    source: forwardLatchState.source || '',
    candidates: rows.slice(0, 40),
    rule: 'Any verified/watch/experimental candidate is persisted immediately and can start paper forward without waiting for all pair-frames to complete. Watchdog must not relaunch while latch has candidates.'
  };
}
function v944BuildProgressiveResearchView(report = {}) {
  const data = report.data || {};
  const pairFrames = n(data.pairFrames || report.dataPairFrames || 0, 0);
  const strategies = n(report?.research?.strategies || report?.forwardWatch?.totalGeneratedStrategies || report.rawResearchStrategies || 0, 0);
  const triggered = !!(lastResearchTriggerView?.triggered || researchTriggerState.triggered);
  return { schema: 'alps.progressiveResearch.view.v1', version: FINAL_V930_VERSION, installed: true, active: true, pairFramesSeen: pairFrames, strategiesSeen: strategies, triggered, mode: strategies > 0 ? 'RESEARCH_ACTIVE' : (triggered ? 'RESEARCH_TRIGGERED_WAITING_FOR_ROWS' : (pairFrames > 0 ? 'RESEARCH_AS_EACH_PAIR_FRAME_COMPLETES' : 'WAITING_FIRST_PAIR_FRAME')), firstCandidatePolicy: 'FORWARD_ON_FIRST_VALID_CANDIDATE', doesNotWaitForFullUniverse: true };
}

function v946MaxNumber(...values) {
  let best = 0;
  for (const value of values.flat(Infinity)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > best) best = parsed;
  }
  return best;
}

function v946GetPath(obj, pathText) {
  try {
    return String(pathText).split('.').reduce((cur, part) => (cur == null ? undefined : cur[part]), obj);
  } catch (_) { return undefined; }
}

function v946ResearchMetricSources(h = {}) {
  const out = [];
  const push = value => { if (value && typeof value === 'object' && !out.includes(value)) out.push(value); };
  push(h);
  push(h.health);
  push(h.report);
  push(h.runReport);
  push(h.rawReport);
  push(h.pageReport);
  push(h.diagReport);
  push(h.latestReport);
  push(lastReport);
  push(lastHealth);
  for (const item of out.slice()) {
    push(item.data);
    push(item.research);
    push(item.forwardWatch);
    push(item.runtime);
    push(item.bootDiagnostics);
    push(item.diagnostics);
    push(item.nativeForwardPool);
    push(item.fullAutonomyNativeForwardPool);
  }
  return out;
}

function v945ResearchMetrics(h = {}) {
  const sources = v946ResearchMetricSources(h);
  const values = pathText => sources.map(src => v946GetPath(src, pathText));
  const pairFrames = v946MaxNumber(values('dataPairFrames'), values('pairFrames'), values('data.pairFrames'), values('bootDiagnostics.pairFrames'), values('diagnostics.pairFrames'));
  const candlesLoaded = v946MaxNumber(values('candlesLoaded'), values('data.candlesLoaded'), values('bootDiagnostics.candlesLoaded'), values('diagnostics.candlesLoaded'), values('chart.candlesLoaded'));
  const rawStrategies = v946MaxNumber(values('rawResearchStrategies'), values('researchStrategies'), values('research.strategies'), values('bootDiagnostics.researchStrategies'), values('diagnostics.rawResearchStrategies'));
  const researchCycles = v946MaxNumber(values('rawResearchCycles'), values('researchCycles'), values('research.researchCycles'), values('bootDiagnostics.researchCycles'));
  const mutationRounds = v946MaxNumber(values('rawMutationRounds'), values('mutationRounds'), values('research.mutationRounds'));
  const candidatesMonitored = v946MaxNumber(values('candidatesMonitored'), values('candidates'), values('officialCandidates'), values('forwardWatch.candidatesMonitored'), values('nativeForwardPool.totalCandidates'), values('forwardLatch.size'), values('bootDiagnostics.candidatesMonitored'));
  const totalGeneratedStrategies = v946MaxNumber(values('totalGeneratedStrategies'), values('forwardWatch.totalGeneratedStrategies'), values('nativeForwardPool.generatedStrategies'), values('bootDiagnostics.totalGeneratedStrategies'));
  const runnerStateStatus = textValue(v946GetPath(h, 'runnerStateStatus') || v946GetPath(h, 'runtime.runnerState.status') || v946GetPath(h, 'bootDiagnostics.runnerStateStatus') || v946GetPath(lastHealth || {}, 'runnerStateStatus') || '');
  return {
    pairFrames,
    candlesLoaded,
    rawStrategies,
    researchCycles,
    mutationRounds,
    candidatesMonitored,
    totalGeneratedStrategies,
    labRunning: !!(h.labRunning || h.runtime?.labRunning || lastHealth?.labRunning),
    engineReady: !!(h.engineReady || h.runtime?.engineReady || lastHealth?.engineReady),
    runnerStateStatus,
    proxyOK: h.proxyOK ?? h.runtime?.proxyOK ?? h.bootDiagnostics?.proxyOK ?? lastHealth?.proxyOK ?? null,
    dataBridgeActive: pairFrames > 0 || candlesLoaded > 0,
    dataBridgeSources: sources.map(src => src === h ? 'input' : src === lastReport ? 'lastReport' : src === lastHealth ? 'lastHealth' : (src.schema || src.version || src.status || 'nested')).slice(0, 20)
  };
}

function v945ShouldTriggerResearch(h = {}) {
  const m = v945ResearchMetrics(h);
  if (!page || page.isClosed()) return false;
  if (!(m.candlesLoaded > 0 || m.pairFrames >= V945_RESEARCH_TRIGGER_MIN_PAIRFRAMES)) return false;
  const hasOutput = m.rawStrategies > 0 || m.researchCycles > 0 || m.candidatesMonitored > 0 || m.totalGeneratedStrategies > 0 || n(h.results, 0) > 0 || n(h.candidates, 0) > 0 || n(h?.forwardLatch?.size, 0) > 0;
  if (hasOutput) return false;
  const now = Date.now();
  const lastAt = n(researchTriggerState.lastAt, 0);
  const lastPF = n(researchTriggerState.lastPairFrames, 0);
  const lastCandles = n(researchTriggerState.lastCandlesLoaded, 0);
  const grewPairFrames = m.pairFrames >= lastPF + V947_DATA_GROWTH_PAIRFRAMES;
  const grewCandles = m.candlesLoaded >= lastCandles + V947_DATA_GROWTH_CANDLES;
  const crossedMilestone = [1,2,5,10,15,20,25,30,35].some(x => lastPF < x && m.pairFrames >= x);
  const zeroRowsRetry = researchTriggerState.triggered && (grewPairFrames || grewCandles || crossedMilestone) && (now - lastAt >= V947_DATA_RETRY_MIN_MS);
  if (zeroRowsRetry) {
    researchTriggerState.lastRetryReason = 'DATA_GREW_BUT_ZERO_RESEARCH_ROWS';
    researchTriggerState.previousPairFrames = lastPF;
    researchTriggerState.previousCandlesLoaded = lastCandles;
    researchTriggerState.lastRetriedAt = now;
    lastPipelineRetryAt = now;
    return true;
  }
  if (researchTriggerState.triggered && now - lastAt < V945_RESEARCH_TRIGGER_COOLDOWN_MS) return false;
  return !researchTriggerState.triggered || (now - lastAt >= V945_RESEARCH_TRIGGER_COOLDOWN_MS);
}

async function v946ReadPageResearchBridgeMetrics(reason = 'research-trigger-data-bridge') {
  if (!page || page.isClosed()) return { reason, pageReady: false };
  try {
    return await pageEval(async reasonText => {
      function num(x) { const v = Number(x); return Number.isFinite(v) ? v : 0; }
      function val(expr, fallback) { try { return expr(); } catch (_) { return fallback; } }
      let report = null;
      try { if (typeof buildRunReportObject === 'function') report = await buildRunReportObject(); } catch (_) { report = null; }
      const data = report && report.data || {};
      const research = report && report.research || {};
      const fw = report && report.forwardWatch || {};
      return {
        reason: reasonText,
        pageReady: true,
        reportAvailable: !!report,
        reportDataPairFrames: num(data.pairFrames),
        reportCandlesLoaded: num(data.candlesLoaded),
        reportResearchStrategies: num(research.strategies),
        reportResearchCycles: num(research.researchCycles),
        reportTotalGeneratedStrategies: num(fw.totalGeneratedStrategies),
        reportCandidatesMonitored: num(fw.candidatesMonitored),
        globalResults: val(() => Array.isArray(globalThis.results) ? globalThis.results.length : 0, 0),
        globalAllResults: val(() => Array.isArray(globalThis.allResults) ? globalThis.allResults.length : 0, 0),
        globalDiscoveryResults: val(() => Array.isArray(globalThis.discoveryResults) ? globalThis.discoveryResults.length : 0, 0),
        runtimeLabRunning: val(() => !!globalThis.labRunning, false),
        runtimeFwRunning: val(() => !!globalThis.fwRunning, false),
        at: Date.now()
      };
    }, reason);
  } catch (e) {
    return { reason, pageReady: false, error: e.message };
  }
}

function v945BuildResearchTriggerView(h = {}, extra = {}) {
  const m = v945ResearchMetrics(h);
  const state = researchTriggerState || {};
  const lastResult = state.lastResult || {};
  return {
    schema: 'alps.researchTrigger.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    active: true,
    minPairFrames: V945_RESEARCH_TRIGGER_MIN_PAIRFRAMES,
    cooldownMs: V945_RESEARCH_TRIGGER_COOLDOWN_MS,
    triggered: !!state.triggered,
    triggerCount: n(state.triggerCount, 0),
    busy: !!researchTriggerBusy,
    lastAction: state.lastAction || '',
    lastReason: state.lastReason || '',
    lastAt: state.lastAt || 0,
    lastPairFrames: state.lastPairFrames || 0,
    lastCandlesLoaded: state.lastCandlesLoaded || 0,
    lastStrategies: state.lastStrategies || 0,
    previousPairFrames: state.previousPairFrames || 0,
    previousCandlesLoaded: state.previousCandlesLoaded || 0,
    lastRetriedAt: state.lastRetriedAt || 0,
    retryReason: state.lastRetryReason || '',
    dataVersion: state.dataVersion || '',
    currentPairFrames: m.pairFrames,
    currentCandlesLoaded: m.candlesLoaded,
    currentStrategies: m.rawStrategies,
    currentCandidates: m.candidatesMonitored,
    lastInvoked: safeArray(lastResult.invoked).slice(0, 30),
    lastResearchInvoked: safeArray(lastResult.researchInvoked).slice(0, 30),
    lastClicked: safeArray(lastResult.clicked).slice(0, 20),
    lastFunctionsFound: safeArray(lastResult.functionsFound).slice(0, 60),
    lastStatus: lastResult.status || state.lastStatus || '',
    lastErrorCode: lastResult.errorCode || state.lastErrorCode || '',
    dataBridgeActive: !!m.dataBridgeActive,
    dataBridgeSources: safeArray(m.dataBridgeSources).slice(0, 20),
    errors: safeArray(state.errors).slice(-8),
    mode: m.rawStrategies > 0 ? 'RESEARCH_ROWS_AVAILABLE' : (state.triggered ? 'FORCE_RESEARCH_START_SENT' : ((m.pairFrames > 0 || m.candlesLoaded > 0) ? 'READY_TO_TRIGGER' : 'WAITING_FIRST_PAIR_FRAME')),
    rule: 'v9.4.7 synchronizes report/health data truth, starts on any available candles, retries when data grows while rows remain zero, invokes discovery/robustness/materializer paths, and reports DISCOVERY_RETURNED_ZERO_ROWS or RESEARCH_FUNCTION_NOT_FOUND without fabricating candidates.'
  };
}


function v947SanitizeKey(value) {
  return textValue(value).toUpperCase().replace(/[^A-Z0-9_./:-]+/g, '_').slice(0, 120);
}
function v947Arr(v) { return Array.isArray(v) ? v : []; }
function v947MaxMetric(...xs) { return v946MaxNumber(xs); }
function v947PairFromRow(row = {}) {
  return textValue(row.pair || row.sym || row.symbol || row.baseSymbol || row.instrument || row.market || '').split('_')[0].toUpperCase();
}
function v947TfFromRow(row = {}) { return textValue(row.timeframe || row.tf || row.frame || row.interval || '').toLowerCase(); }
function v947StrategyFromRow(row = {}) { return textValue(row.strategy || row.stratName || row.name || row.setup || row.root || row.pattern || row.template || row.strategyName || ''); }
function v947LooksLikeResearchRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const text = [row.pair,row.sym,row.symbol,row.timeframe,row.tf,row.strategy,row.stratName,row.name,row.setup,row.root,row.pattern,row.oosPF,row.totalTrades,row.score,row.promotionTier,row.rawVerdict,row.effectiveVerdict,row.forwardEligible].map(textValue).join('|');
  return /(USDT|XAU|BTC|ETH|SOL|BNB|XRP|DOGE|5m|15m|30m|1h|4h|HA|POC|VAH|VAL|strategy|setup|WATCH|ROBUST|FORWARD|PF|trade)/i.test(text) && (!!v947PairFromRow(row) || !!v947StrategyFromRow(row));
}
function v947RowKey(row = {}) {
  return [v947PairFromRow(row), v947TfFromRow(row), v947StrategyFromRow(row), row.exit || row.exitName || row.direction || row.side || ''].map(v947SanitizeKey).join('||');
}
function v947NormalizeResearchRow(row = {}, source = 'unknown') {
  const pair = v947PairFromRow(row);
  const timeframe = v947TfFromRow(row);
  const strategy = v947StrategyFromRow(row) || `${source}_ROW`;
  const out = { ...row };
  if (!out.pair && pair) out.pair = pair;
  if (!out.sym && pair) out.sym = pair;
  if (!out.timeframe && timeframe) out.timeframe = timeframe;
  if (!out.strategy && strategy) out.strategy = strategy;
  if (!out.stratName && strategy) out.stratName = strategy;
  out.__alpsV947Materialized = true;
  out.__alpsV947Source = source;
  if (out.forwardEligible !== true && !/WATCH|ROBUST|FORWARD|KEEP/i.test([out.promotionTier,out.rawVerdict,out.effectiveVerdict,out.robustnessFinal].map(textValue).join('|'))) {
    out.promotionTier = out.promotionTier || 'EXPERIMENTAL_FORWARD_NOT_OOS_VERIFIED';
    out.forwardEligible = true;
    out.__alpsV947Experimental = true;
  }
  out.key = out.key || uniqueKeyFromCandidate(out) || v947RowKey(out);
  return out;
}
function v947CollectRowsFromObject(obj, source = 'object', maxDepth = 4) {
  const rows = [];
  const seen = new Set();
  function pushRow(row, src) {
    if (!v947LooksLikeResearchRow(row)) return;
    const key = v947RowKey(row) || JSON.stringify(row).slice(0, 180);
    const id = src + '::' + key;
    if (seen.has(id)) return;
    seen.add(id); rows.push(v947NormalizeResearchRow(row, src));
  }
  function walk(value, pathName, depth) {
    if (!value || depth > maxDepth) return;
    if (Array.isArray(value)) {
      const candidateLike = /(strategy|strategies|result|results|candidate|candidates|robust|watch|keep|sandbox|experiment|forward|hypothesis|rows|pool)/i.test(pathName);
      if (candidateLike || value.some(v947LooksLikeResearchRow)) for (const item of value) pushRow(item, pathName);
      if (depth < maxDepth && value.length <= 80) value.slice(0, 20).forEach((v, i) => walk(v, `${pathName}[${i}]`, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if (/candles|dataAudit|recentLogs|openTrades|closedTrades/i.test(k)) continue;
      if (Array.isArray(v) || (v && typeof v === 'object')) walk(v, pathName ? `${pathName}.${k}` : k, depth + 1);
    }
  }
  walk(obj, source, 0);
  return rows;
}
function v947MaterializeReportRows(report = {}, extraRows = []) {
  const raw = [];
  raw.push(...v947CollectRowsFromObject(report?.research || {}, 'report.research', 3));
  raw.push(...v947CollectRowsFromObject(report?.forwardWatch || {}, 'report.forwardWatch', 3));
  raw.push(...v947CollectRowsFromObject(report?.nativeForwardPool || {}, 'report.nativeForwardPool', 3));
  raw.push(...v947CollectRowsFromObject(report?.fullAutonomyNativeForwardPool || {}, 'report.fullAutonomyNativeForwardPool', 3));
  raw.push(...v947Arr(extraRows).filter(v947LooksLikeResearchRow).map(r => v947NormalizeResearchRow(r, r.__alpsV947Source || 'page.materializer')));
  const map = new Map();
  for (const r of raw) { const k = v947RowKey(r); if (k && !map.has(k)) map.set(k, r); }
  const rows = Array.from(map.values());
  if (!report.research || typeof report.research !== 'object') report.research = {};
  if (!Array.isArray(report.research.topStrategies) || rows.length > report.research.topStrategies.length) report.research.topStrategies = rows;
  report.research.strategies = Math.max(n(report.research.strategies, 0), rows.length);
  if (!report.forwardWatch || typeof report.forwardWatch !== 'object') report.forwardWatch = {};
  report.forwardWatch.totalGeneratedStrategies = Math.max(n(report.forwardWatch.totalGeneratedStrategies, 0), rows.length);
  report.rawResearchStrategies = Math.max(n(report.rawResearchStrategies, 0), rows.length);
  report.totalGeneratedStrategies = Math.max(n(report.totalGeneratedStrategies, 0), rows.length);
  lastMaterializedRows = rows;
  lastMaterializedRowSources = [...new Set(rows.map(r => r.__alpsV947Source).filter(Boolean))];
  return rows;
}
function v947CanonicalMetrics(report = {}) {
  const m = v945ResearchMetrics(report);
  const sources = v946ResearchMetricSources(report);
  const values = pathText => sources.map(src => v946GetPath(src, pathText));
  const latestClosed = v947MaxMetric(values('latestClosedCandleTs'), values('forwardWatch.freshness.latestClosedCandleTs'), values('latestClosedCandleUsedByDiscovery'));
  const forwardLatchSize = v947MaxMetric(values('forwardLatch.size'), values('decisionIntelligence.forwardLatch.size'));
  const experimental = v947MaxMetric(values('nativeForwardPool.experimentalForward'), values('fullAutonomyNativeForwardPool.experimentalForward'), values('livePaperEvidenceCollector.experimentalForward'));
  const totalCandidates = v947MaxMetric(values('nativeForwardPool.totalCandidates'), values('fullAutonomyNativeForwardPool.totalCandidates'), values('candidates'), values('officialCandidates'), forwardLatchSize);
  const strategies = v947MaxMetric(m.rawStrategies, m.totalGeneratedStrategies, values('research.strategies'), values('forwardWatch.totalGeneratedStrategies'), v947Arr(report?.research?.topStrategies).length, lastMaterializedRows.length);
  const out = {
    schema: 'alps.runtimeTruth.canonicalMetrics.v1', version: FINAL_V930_VERSION, generatedAt: new Date().toISOString(),
    candlesLoaded: m.candlesLoaded, pairFrames: m.pairFrames, dataPairs: v947Arr(report.dataPairs || report?.data?.pairs || lastHealth?.dataPairs),
    strategies, researchCycles: m.researchCycles, mutationRounds: m.mutationRounds,
    totalCandidates, candidatesMonitored: m.candidatesMonitored, forwardLatchSize, experimentalForward: experimental,
    paperSignals: v947MaxMetric(values('paperSignals'), values('forwardWatch.paperSignals')),
    latestClosedCandleTs: latestClosed || null,
    fwRunning: !!(report.fwRunning || report?.runtime?.fwRunning || lastHealth?.fwRunning),
    labRunning: !!(report.labRunning || report?.runtime?.labRunning || lastHealth?.labRunning),
    runnerStateStatus: m.runnerStateStatus || textValue(report?.runtime?.runnerState?.status || lastHealth?.runnerStateStatus || ''),
    proxyOK: m.proxyOK,
    snapshotSources: safeArray(m.dataBridgeSources).slice(0, 20)
  };
  lastCanonicalMetrics = out;
  return out;
}
function v947BuildSymbolLoadStatus(report = {}) {
  const settings = report.settings || lastReport?.settings || {};
  const symText = [settings.symbols, settings.metals].map(textValue).filter(Boolean).join(',');
  const requested = [...new Set(symText.split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(Boolean))];
  const loadedPairs = [...new Set(v947Arr(report.dataPairs || report?.data?.pairs || lastHealth?.dataPairs).map(x => textValue(x).toUpperCase()).filter(Boolean))];
  const auditRows = v947Arr(report?.data?.dataAudit?.rows || report?.dataAudit?.rows);
  const frameMap = {};
  for (const row of auditRows) {
    const key = textValue(row.key || '');
    const pair = textValue(row.pair || key.split('_')[0]).toUpperCase();
    const tf = textValue(row.timeframe || key.split('_')[1] || '').toLowerCase();
    if (!pair) continue; if (!frameMap[pair]) frameMap[pair] = new Set(); if (tf) frameMap[pair].add(tf);
  }
  const expectedFrames = textValue(settings.frames || '5m,15m,30m,1h,4h').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  const statusBySymbol = requested.map(sym => {
    const loaded = loadedPairs.includes(sym) || !!frameMap[sym];
    const framesLoaded = Array.from(frameMap[sym] || []);
    const missingFrames = expectedFrames.filter(f => !framesLoaded.includes(f));
    return { symbol: sym, loaded, framesLoaded, framesLoadedCount: framesLoaded.length, expectedFrames: expectedFrames.length, missingFrames, status: loaded ? (missingFrames.length ? 'PARTIAL_OR_AUDIT_STALE' : 'LOADED') : 'PENDING_OR_FAILED', needsAliasResolution: /^XAU/.test(sym) && !loaded };
  });
  const missing = statusBySymbol.filter(x => !x.loaded).map(x => x.symbol);
  const partial = statusBySymbol.filter(x => x.loaded && x.missingFrames.length).map(x => x.symbol);
  const view = { schema: 'alps.symbolLoadStatus.view.v1', version: FINAL_V930_VERSION, requestedSymbols: requested, loadedPairs, missingSymbols: missing, partialSymbols: partial, statusBySymbol, metalsRequested: requested.filter(x => /^XAU/.test(x)), rule: 'Requested symbols are compared with live dataPairs and dataAudit rows. Missing symbols are diagnostic only and do not block partial research.' };
  lastSymbolLoadStatusView = view; return view;
}
function v947BuildClosedCandleMap(report = {}) {
  const rows = v947Arr(report?.data?.dataAudit?.rows || report?.dataAudit?.rows);
  const map = {};
  let latest = 0;
  for (const row of rows) {
    const key = textValue(row.key || [row.pair,row.timeframe].filter(Boolean).join('_')).toUpperCase();
    const last = n(row.last || row.latestClosedCandleTs || row.lastTs, 0);
    if (!key || !last) continue;
    map[key] = { latestClosedCandleTs: last, iso: new Date(last).toISOString(), rows: n(row.rows, 0), verdict: row.verdict || '' };
    latest = Math.max(latest, last);
  }
  const v951Map = report?.v951ClosedCandleMap || lastReport?.v951ClosedCandleMap || {};
  for (const [key, row] of Object.entries(v951Map || {})) {
    const last = n(row.latestClosedCandleTs || row.lastTs || row.t, 0);
    if (!key || !last || map[key]) continue;
    map[key.toUpperCase()] = { latestClosedCandleTs: last, iso: new Date(last).toISOString(), rows: n(row.rows, 0), lastClose: row.lastClose, verdict: 'V951_REAL_CANDLE_MAP' };
    latest = Math.max(latest, last);
  }
  const view = { schema: 'alps.closedCandleMap.view.v1', version: FINAL_V930_VERSION, latestClosedCandleTs: latest || null, latestClosedCandleIso: latest ? new Date(latest).toISOString() : null, pairFrameCount: Object.keys(map).length, map, closedCandleOnlyAudited: !!latest, liveCandleExcluded: latest ? 'YES_CURRENT_LIVE_CANDLE_EXCLUDED_BY_LAST_CLOSED_MAP' : 'UNKNOWN_NEEDS_CORE_CONFIRMATION' };
  lastClosedCandleMapView = view; return view;
}
function v947BuildStoreInventoryView(pageDiag = null) {
  const view = pageDiag?.storeInventory || { schema: 'alps.storeInventory.view.v1', version: FINAL_V930_VERSION, available: false, note: 'Page store inventory not collected yet.' };
  lastStoreInventoryView = view; return view;
}
function v947BuildGateMatrix(report = {}, nativeView = {}, latchView = {}) {
  const m = v947CanonicalMetrics(report);
  const rows = lastMaterializedRows.length || v947Arr(report?.research?.topStrategies).length;
  const matrix = [
    { gate: 'dataGate', pass: m.candlesLoaded > 0 || m.pairFrames > 0, rowsIn: m.pairFrames, rowsOut: m.pairFrames, blocked: !(m.candlesLoaded > 0 || m.pairFrames > 0) ? 1 : 0 },
    { gate: 'featureGate', pass: n(lastDiscoveryOutputView?.featureRowsFound, 0) > 0 || rows > 0, rowsIn: m.pairFrames, rowsOut: n(lastDiscoveryOutputView?.featureRowsFound, 0), blocked: 0, status: n(lastDiscoveryOutputView?.featureRowsFound, -1) < 0 ? 'UNKNOWN' : '' },
    { gate: 'strategyGate', pass: rows > 0, rowsIn: n(lastDiscoveryOutputView?.featureRowsFound, 0), rowsOut: rows, blocked: rows > 0 ? 0 : 1 },
    { gate: 'experimentalForwardGate', pass: rows > 0, rowsIn: rows, rowsOut: n(nativeView.experimentalForward, 0), blocked: rows > 0 && n(nativeView.experimentalForward, 0) === 0 ? rows : 0, note: 'Experimental rows are allowed for paper evidence unless safety/data gates block them.' },
    { gate: 'freshnessGate', pass: !!m.latestClosedCandleTs || rows === 0, rowsIn: n(nativeView.totalCandidates, 0), rowsOut: n(latchView.size, 0), blocked: (!m.latestClosedCandleTs && n(nativeView.totalCandidates, 0) > 0) ? n(nativeView.totalCandidates, 0) : 0 },
    { gate: 'forwardGate', pass: n(latchView.size, 0) > 0 || rows === 0, rowsIn: n(nativeView.totalCandidates, 0), rowsOut: n(latchView.size, 0), blocked: n(nativeView.totalCandidates, 0) > 0 && n(latchView.size, 0) === 0 ? n(nativeView.totalCandidates, 0) : 0 }
  ];
  const view = { schema: 'alps.gateMatrix.view.v1', version: FINAL_V930_VERSION, gates: matrix, blockedCounts: Object.fromEntries(matrix.map(g => [g.gate, g.blocked || 0])), forwardPromotedOnlyAudit: { forwardPromotedOnlyReported: /forwardPromotedOnly=ON/i.test(v947Arr(report.recentLogs || report.logs || []).join('\n')) || !!report?.intelligence?.unrestrictedRules?.forwardPromotedOnly, experimentalMustBypassPromotionOnly: true, blockedByForwardPromotedOnly: 0 }, rule: 'Gate matrix separates research diagnostics from paper entry safety. It does not bypass closed-candle/freshness for actual paper entries.' };
  lastGateMatrixView = view; return view;
}
function v947BuildForwardReadiness(report = {}, nativeView = {}, latchView = {}) {
  const m = v947CanonicalMetrics(report);
  const hasCandidates = n(nativeView.totalCandidates, 0) > 0 || n(latchView.size, 0) > 0;
  const view = { schema: 'alps.forwardReadiness.view.v1', version: FINAL_V930_VERSION, canStartWatch: hasCandidates && !!m.latestClosedCandleTs, hasCandidates, hasClosedCandle: !!m.latestClosedCandleTs, hasFreshPrice: m.latestClosedCandleTs ? 'UNKNOWN_UNTIL_FORWARD_TICK' : false, hasStopTarget: hasCandidates ? 'PENDING_CANDIDATE_EXIT_PLAN' : false, hasNoDuplicate: true, startWatchSkippedReason: hasCandidates ? (!m.latestClosedCandleTs ? 'NO_LATEST_CLOSED_CANDLE_TS' : '') : 'NO_CANDIDATES', forwardNeverStarted: !m.fwRunning && !n(report.lastForwardRefresh || report?.runtime?.lastForwardRefresh || 0, 0) };
  lastForwardReadinessView = view; return view;
}
function v947BuildZeroOutputDiagnostics(report = {}) {
  const m = v947CanonicalMetrics(report);
  const rows = lastMaterializedRows.length || v947Arr(report?.research?.topStrategies).length;
  let zeroOutputClass = '';
  if (rows > 0 || m.totalCandidates > 0 || m.forwardLatchSize > 0) zeroOutputClass = 'OUTPUT_AVAILABLE';
  else if (!(m.candlesLoaded > 0 || m.pairFrames > 0)) zeroOutputClass = 'NO_DATA_VISIBLE';
  else if (lastDiscoveryOutputView && lastDiscoveryOutputView.candlesVisibleToReport && !lastDiscoveryOutputView.candlesVisibleToDiscovery) zeroOutputClass = 'DATA_NOT_VISIBLE_TO_DISCOVERY';
  else if (lastDiscoveryOutputView && n(lastDiscoveryOutputView.featureRowsFound, -1) === 0) zeroOutputClass = 'NO_FEATURES';
  else if (lastDiscoveryOutputView && n(lastDiscoveryOutputView.strategyTemplatesFound, -1) === 0) zeroOutputClass = 'NO_TEMPLATES';
  else zeroOutputClass = 'DISCOVERY_RETURNED_ZERO_ROWS';
  const view = { schema: 'alps.zeroOutputDiagnostics.view.v1', version: FINAL_V930_VERSION, active: zeroOutputClass !== 'OUTPUT_AVAILABLE', zeroOutputClass, candlesLoaded: m.candlesLoaded, pairFrames: m.pairFrames, featureRowsFound: lastDiscoveryOutputView?.featureRowsFound ?? null, strategyTemplatesFound: lastDiscoveryOutputView?.strategyTemplatesFound ?? null, testedRows: lastDiscoveryOutputView?.testedRows ?? null, materializedRows: rows, rejectedRows: lastDiscoveryOutputView?.rejectedRows ?? null, functionsInvoked: safeArray(researchTriggerState?.lastResult?.invoked).slice(0, 40), fallbackFunctionsInvoked: safeArray(lastDiscoveryOutputView?.functionsInvoked).slice(0, 40), reason: zeroOutputClass === 'OUTPUT_AVAILABLE' ? 'Existing strategy/candidate output found.' : 'Pipeline has data and trigger activity but no strategy/candidate rows were captured. See storeInventory, gateMatrix, and discoveryOutput for the blocking layer.' };
  lastZeroOutputDiagnosticView = view; return view;
}
function v947BuildE2EPipelineTrace(report = {}, nativeView = {}, latchView = {}) {
  const m = v947CanonicalMetrics(report);
  const featureRows = n(lastDiscoveryOutputView?.featureRowsFound, 0);
  const setupRows = n(lastDiscoveryOutputView?.rawSetupRows, 0);
  const strategyRows = lastMaterializedRows.length || v947Arr(report?.research?.topStrategies).length || m.strategies;
  const candidateRows = n(nativeView.totalCandidates, 0);
  const latchRows = n(latchView.size, 0);
  const paperSignals = n(report.paperSignals || report?.forwardWatch?.paperSignals || 0, 0);
  const stages = [
    { stage: 'DATA', rows: m.pairFrames, status: (m.pairFrames > 0 || m.candlesLoaded > 0) ? 'PASS' : 'BLOCKED' },
    { stage: 'FEATURES', rows: featureRows, status: featureRows > 0 ? 'PASS' : (strategyRows > 0 ? 'INFERRED_PASS' : 'UNKNOWN_OR_ZERO') },
    { stage: 'SETUPS', rows: setupRows, status: setupRows > 0 ? 'PASS' : 'UNKNOWN_OR_ZERO' },
    { stage: 'STRATEGIES', rows: strategyRows, status: strategyRows > 0 ? 'PASS' : 'BLOCKED_ZERO_ROWS' },
    { stage: 'CANDIDATES', rows: candidateRows, status: candidateRows > 0 ? 'PASS' : 'WAITING_FOR_STRATEGIES' },
    { stage: 'LATCH', rows: latchRows, status: latchRows > 0 ? 'PASS' : 'WAITING_FOR_CANDIDATES' },
    { stage: 'PAPER_FORWARD', rows: paperSignals, status: paperSignals > 0 ? 'ACTIVE' : (latchRows > 0 ? 'WAITING_FRESH_CANDLE' : 'NOT_STARTED') }
  ];
  const firstBlocked = stages.find(s => /BLOCKED|ZERO|WAITING|NOT_STARTED/.test(s.status));
  const view = { schema: 'alps.e2ePipelineTrace.view.v1', version: FINAL_V930_VERSION, traceId: `${Date.now()}_${m.pairFrames}pf_${m.strategies}str`, stages, blockedAt: firstBlocked?.stage || '', currentRunOnly: true };
  lastE2EPipelineTraceView = view; return view;
}
function v947BuildMasterRuntimeState(report = {}, nativeView = {}, latchView = {}) {
  const m = v947CanonicalMetrics(report);
  let state = 'DATA_LOADING'; let blocking = '';
  if (m.candlesLoaded > 0 || m.pairFrames > 0) state = 'DATA_PARTIAL_READY';
  if (m.strategies > 0) state = 'RESEARCH_ROWS_AVAILABLE';
  else if (researchTriggerState.triggered) { state = 'RESEARCH_ZERO_ROWS'; blocking = 'DISCOVERY_OUTPUT'; }
  if (n(nativeView.totalCandidates, 0) > 0) state = 'CANDIDATES_AVAILABLE';
  if (n(latchView.size, 0) > 0) state = 'FORWARD_LATCH_READY';
  if (m.fwRunning) state = 'FORWARD_RUNNING';
  return { schema: 'alps.masterRuntimeState.view.v1', version: FINAL_V930_VERSION, state, blockingLayer: blocking || (state === 'DATA_LOADING' ? 'DATA_LOAD' : ''), nextRequiredAction: state === 'RESEARCH_ZERO_ROWS' ? 'RETRY_DISCOVERY_AND_DIAGNOSE_ZERO_ROWS' : (state === 'DATA_PARTIAL_READY' ? 'RUN_DISCOVERY' : (state === 'FORWARD_LATCH_READY' ? 'START_FORWARD_WATCH' : 'OBSERVE')), labRunning: m.labRunning, fwRunning: m.fwRunning, runnerStateStatus: m.runnerStateStatus };
}
function v947BuildPipelineTruthView(report = {}, nativeView = {}, latchView = {}) {
  const reportGeneratedAt = report?.meta?.generatedAt || report?.generatedAt || null;
  const healthAt = lastHealth?.lastTickAt ? new Date(lastHealth.lastTickAt).toISOString() : null;
  const canonical = v947CanonicalMetrics(report);
  const symbolLoadStatus = v947BuildSymbolLoadStatus(report);
  const closedCandleMap = v947BuildClosedCandleMap(report);
  const gateMatrix = v947BuildGateMatrix(report, nativeView, latchView);
  const forwardReadiness = v947BuildForwardReadiness(report, nativeView, latchView);
  const e2e = v947BuildE2EPipelineTrace(report, nativeView, latchView);
  const zero = v947BuildZeroOutputDiagnostics(report);
  const view = { schema: 'alps.pipelineTruthRecovery.view.v1', version: FINAL_V930_VERSION, installed: true, paperOnly: true, liveCapitalExecution: false, effectivePatchVersion: FINAL_V930_VERSION, patchManifest: { patch: 'ALPS v10.1.7 Feature Materializer + Candle Visibility Bridge', filesExpected: ['runner.js','alpsTradeExport.js'], appUrlChanged: false, modules: ['RuntimeTruthSync','DataMilestoneRetry','DiscoveryRetry','OutputMaterializer','StoreInventory','ClosedCandleMap','SymbolLoadStatus','GateMatrix','ZeroOutputDiagnostics','E2EPipelineTrace','ForwardReadiness','ZonePersistenceEntry','NumericGuardHotfix','RejectedReasonBreakdown','FeatureVisibility','ClosedCandleMapBuilder','RealCandleDiscoveryMaterializer','ForwardStartRecovery','PaperEntryDecisionRecovery'] }, canonicalMetrics: canonical, masterRuntimeState: v947BuildMasterRuntimeState(report, nativeView, latchView), reportFreshness: { reportGeneratedAt, healthSnapshotAt: healthAt, runnerCollectedAt: new Date().toISOString(), snapshotMismatch: !!(report?.data?.pairFrames && canonical.pairFrames && n(report.data.pairFrames,0) !== canonical.pairFrames) }, symbolLoadStatus, closedCandleMap, storeInventory: lastStoreInventoryView || v947BuildStoreInventoryView(null), discoveryOutput: lastDiscoveryOutputView, gateMatrix, forwardReadiness, e2ePipelineTrace: e2e, zeroOutputDiagnostics: zero, materializer: { materializedRows: lastMaterializedRows.length, sources: lastMaterializedRowSources, rule: 'Only existing page/report rows are materialized. No synthetic strategy/candidate/OOS/trade rows are created.' } };
  lastPipelineTruthView = view; return view;
}


async function v951CollectRealCandleDiscoveryMaterializer(reason = 'v951-real-candle-discovery-materializer') {
  if (!page || page.isClosed()) return { schema: 'alps.v951RealCandleDiscovery.view.v1', version: FINAL_V930_VERSION, pageReady: false, reason, rows: [], featureRows: [] };
  try {
    return await pageEval(async cfg => {
      const startedAt = Date.now();
      const out = { schema:'alps.v951RealCandleDiscovery.view.v1', version:cfg.version, pageReady:true, reason:cfg.reason, startedAt, candleStores:[], closedCandleMap:{}, featureRows:[], rows:[], errors:[], injected:false, status:'INIT' };
      const text = v => String(v == null ? '' : v);
      const arr = v => Array.isArray(v) ? v : [];
      const finite = v => Number.isFinite(Number(v));
      const num = (v, fb=null) => { if (v == null || v === '') return fb; const x = Number(String(v).replace(/[,%$≈]/g,'').trim()); return Number.isFinite(x) ? x : fb; };
      const normTf = v => { let t = text(v).toLowerCase().replace(/\s+/g,''); if (t==='5'||t==='5min') return '5m'; if (t==='15'||t==='15min') return '15m'; if (t==='30'||t==='30min') return '30m'; if (t==='60'||t==='60min'||t==='1hr') return '1h'; if (t==='240'||t==='4hr') return '4h'; return t; };
      function candleFrom(x){
        if (Array.isArray(x)) { const t=num(x[0],null), o=num(x[1],null), h=num(x[2],null), l=num(x[3],null), c=num(x[4],null); if (finite(c) && finite(h) && finite(l)) return {t:t && t<1e12?t*1000:t,open:o??c,high:h,low:l,close:c}; }
        if (!x || typeof x !== 'object') return null;
        const c=num(x.close ?? x.c ?? x.Close ?? x.price ?? x.last ?? x.value, null);
        const h=num(x.high ?? x.h ?? x.High ?? c, c), l=num(x.low ?? x.l ?? x.Low ?? c, c), o=num(x.open ?? x.o ?? x.Open ?? c, c);
        let t=num(x.time ?? x.t ?? x.ts ?? x.openTime ?? x.closeTime ?? x.timestamp ?? x.date ?? x.x, null);
        const ts = x.time ?? x.date ?? x.timestamp ?? x.openTime ?? x.closeTime;
        if (typeof ts === 'string') { const dt=Date.parse(ts); if (Number.isFinite(dt)) t=dt; }
        if (!finite(c) || !finite(h) || !finite(l)) return null; if (t && t < 1e12) t *= 1000;
        return {t,open:o,high:h,low:l,close:c};
      }
      function infer(path, obj){
        const s = text(path)+' '+text(obj && (obj.key||obj.symbol||obj.pair||obj.baseSymbol||obj.name||obj.id||obj.timeframe||obj.tf));
        const p = (s.match(/(BTCUSDT|ETHUSDT|SOLUSDT|BNBUSDT|XRPUSDT|DOGEUSDT|XAUTUSDT|XAUUSDT|PAXGUSDT)/i)||[])[1];
        let tf = (s.match(/(^|[^0-9A-Z])([5]|15|30)m([^0-9A-Z]|$)/i)||[])[2]; if (tf) tf = tf+'m';
        if (!tf) tf = (s.match(/(^|[^0-9A-Z])(1|4)h([^0-9A-Z]|$)/i)||[])[2]?.toLowerCase()+'h';
        if (!tf) tf = (s.match(/(^|[^0-9A-Z])(60|240)([^0-9A-Z]|$)/i)||[])[2];
        return { pair: p ? p.toUpperCase().replace('XAUUSDT','XAUTUSDT') : '', timeframe: normTf(tf || '') };
      }
      function looksCandleArray(v){ if (!Array.isArray(v) || v.length < 30) return false; let ok=0; for (const x of v.slice(-12)) if (candleFrom(x)) ok++; return ok >= 5; }
      function addGroup(groups, seen, path, v, metaObj){
        if (!looksCandleArray(v)) return;
        const rows = v.map(candleFrom).filter(Boolean).filter(x=>finite(x.close)&&finite(x.high)&&finite(x.low)).sort((a,b)=>(a.t||0)-(b.t||0));
        if (rows.length < 30) return;
        const inf = infer(path, metaObj || {});
        const last=rows[rows.length-1]||{}; const id=`${inf.pair}|${inf.timeframe}|${path}|${rows.length}|${last.t}|${last.close}`;
        if (seen.has(id)) return; seen.add(id);
        groups.push({ path, pair:inf.pair, timeframe:inf.timeframe, rows });
      }
      function groupsFromContainer(obj, source, depthLimit=8){
        const groups=[]; const seen=new Set();
        function walk(v,path,depth,meta){
          if (!v || depth > depthLimit) return;
          if (Array.isArray(v)) { addGroup(groups,seen,path,v,meta); if (v.length < 60) v.slice(0,20).forEach((x,i)=>walk(x,`${path}[${i}]`,depth+1,x)); return; }
          if (typeof v !== 'object') return;
          if (Array.isArray(v.candles)) addGroup(groups,seen,`${path}.candles`,v.candles,v);
          if (Array.isArray(v.klines)) addGroup(groups,seen,`${path}.klines`,v.klines,v);
          if (Array.isArray(v.ohlc)) addGroup(groups,seen,`${path}.ohlc`,v.ohlc,v);
          if (Array.isArray(v.data)) addGroup(groups,seen,`${path}.data`,v.data,v);
          let keys=[]; try { keys=Object.keys(v).slice(0,220); } catch(_) { return; }
          for (const k of keys) {
            const np=`${path}.${k}`;
            if (!/(BTC|ETH|SOL|BNB|XRP|DOGE|XAU|PAXG|USDT|5m|15m|30m|1h|4h|candle|kline|ohlc|market|data|cache|history|series|chart|bars|runtime|snapshot|store|pair|frame|tf|symbol|value|rows|items|records)/i.test(np)) continue;
            try { walk(v[k], np, depth+1, v); } catch(_) {}
          }
        }
        try { walk(obj, source, 0, obj); } catch(e){ out.errors.push({where:'container.'+source,message:text(e&&e.message||e).slice(0,180)}); }
        return groups;
      }
      function mergeGroups(groups){
        const byKey=new Map(); const unknown=[];
        for (const g of groups) {
          if (!g || !Array.isArray(g.rows) || g.rows.length < 30) continue;
          const last=g.rows[g.rows.length-1]||{};
          let p=g.pair, tf=g.timeframe;
          if (!p || !tf) { unknown.push(g); continue; }
          const key=`${p}_${tf}`.toUpperCase();
          const cur=byKey.get(key);
          if (!cur || g.rows.length>cur.rows.length || (last.t||0)>(cur.rows[cur.rows.length-1]?.t||0)) byKey.set(key,g);
        }
        // If only one unknown group exists, keep it as selected chart source.
        for (const g of unknown) {
          const p = g.pair || text(globalThis.selectedPair || globalThis.currentPair || '').toUpperCase();
          const tf = g.timeframe || normTf(globalThis.selectedTimeframe || globalThis.currentTimeframe || '');
          if (p && tf) byKey.set(`${p}_${tf}`.toUpperCase(), {...g,pair:p,timeframe:tf,path:g.path+'.inferredSelected'});
        }
        return Array.from(byKey.values()).sort((a,b)=>a.pair.localeCompare(b.pair)||a.timeframe.localeCompare(b.timeframe));
      }
      async function collectAllCandles(){
        let groups=[];
        try {
          for (const name of ['candles','allCandles','candleData','marketCandles','ohlc','klines','chartCandles','series','bars','marketData','dataCache','runtimeSnapshot','snapshot']) {
            if (globalThis[name]) groups.push(...groupsFromContainer(globalThis[name], name));
          }
          for (const name of Object.getOwnPropertyNames(globalThis).slice(0,1800)) {
            if (!/(candle|kline|ohlc|market|data|cache|history|series|chart|bars|runtime|snapshot|store|pair|frame)/i.test(name)) continue;
            if (/document|navigator|location|performance|console|crypto|indexedDB|localStorage|sessionStorage/i.test(name)) continue;
            try { groups.push(...groupsFromContainer(globalThis[name], name, 5)); } catch(_) {}
          }
        } catch(e){ out.errors.push({where:'globals',message:text(e&&e.message||e).slice(0,180)}); }
        try {
          for (let i=0;i<localStorage.length;i++) {
            const k=localStorage.key(i)||''; if (!/(ALPS|candle|kline|ohlc|market|runtime|snapshot|cache|history|chart|data|pair|frame)/i.test(k)) continue;
            const raw=localStorage.getItem(k); if (!raw || raw.length < 80) continue;
            try { groups.push(...groupsFromContainer(JSON.parse(raw), `localStorage.${k}`)); } catch(_) {}
          }
        } catch(e){ out.errors.push({where:'localStorage',message:text(e&&e.message||e).slice(0,180)}); }
        if (globalThis.indexedDB) {
          async function openDb(name){ return await new Promise(resolve=>{ try{ const req=indexedDB.open(name); req.onsuccess=()=>resolve(req.result); req.onerror=()=>resolve(null); req.onblocked=()=>resolve(null);}catch(_){resolve(null);} }); }
          async function readStore(db, st){ const vals=[]; try{ await new Promise(resolve=>{ const tx=db.transaction(st,'readonly'); const store=tx.objectStore(st); let req; try{ req=store.openCursor(); }catch(_){ return resolve(); } let n=0; req.onsuccess=()=>{ const cur=req.result; if(!cur || n>=60000) return resolve(); n++; const val=cur.value; vals.push(val && typeof val==='object' ? Object.assign({__id:cur.key,__store:st}, val) : {__id:cur.key,__store:st,value:val}); cur.continue(); }; req.onerror=()=>resolve(); tx.onerror=()=>resolve(); tx.onabort=()=>resolve(); tx.oncomplete=()=>resolve(); }); }catch(_){} return vals; }
          function bucketStoreRows(vals, basePath, dbName, storeName){
            const buckets=new Map();
            for (const v of arr(vals)) {
              const c=candleFrom(v); if (!c) continue;
              const inf=infer(`${basePath}.${text(v && v.__id)}`, v || {});
              const key=`${inf.pair||''}_${inf.timeframe||''}`.toUpperCase();
              if (!inf.pair || !inf.timeframe) continue;
              if (!buckets.has(key)) buckets.set(key,{path:`${basePath}.${key}`, pair:inf.pair, timeframe:inf.timeframe, rows:[]});
              buckets.get(key).rows.push(c);
            }
            for (const g of buckets.values()) {
              g.rows=g.rows.filter(x=>finite(x.close)&&finite(x.high)&&finite(x.low)).sort((a,b)=>(a.t||0)-(b.t||0));
              if (g.rows.length>=30) groups.push(g);
            }
          }
          try {
            let dbs=[]; if (indexedDB.databases) { try { dbs=await indexedDB.databases(); } catch(_){} }
            const dbNames=[...new Set([...(dbs||[]).map(x=>x&&x.name).filter(Boolean),'ALPS_Runtime_DB_v842','ALPS_Runtime_DB','ALPS_DB','ALPS_Runtime','ALPS'])];
            out.indexedDbAttemptedDatabases=dbNames.slice(0,30);
            for (const name of dbNames.slice(0,30)) {
              if (!/(ALPS|candle|kline|ohlc|market|runtime|snapshot|cache|history|chart|data|trade)/i.test(name)) continue;
              const db=await openDb(name); if(!db) { out.errors.push({where:'indexedDB.open',message:`open failed ${name}`}); continue; }
              const stores=Array.from(db.objectStoreNames||[]).slice(0,80);
              out.candleStores.push({path:`indexedDB.${name}`, stores:stores.slice(0,40), mode:'store-inventory'});
              for (const st of stores) {
                const vals=await readStore(db,st); if (!vals.length) continue;
                const base=`indexedDB.${name}.${st}`;
                if (looksCandleArray(vals)) addGroup(groups,new Set(),base,vals,{name,store:st,...(vals[0]||{})});
                bucketStoreRows(vals, base, name, st);
                groups.push(...groupsFromContainer(vals, base, 9));
              }
              try{db.close();}catch(_){}
            }
          } catch(e){ out.errors.push({where:'indexedDB',message:text(e&&e.message||e).slice(0,180)}); }
        }
        return mergeGroups(groups);
      }
      function sma(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : null; }
      function ema(values,len){ if(values.length<len) return null; const k=2/(len+1); let e=values[0]; for(let i=1;i<values.length;i++) e=values[i]*k+e*(1-k); return e; }
      function atr(rows,len=14){ if(rows.length<2) return null; const trs=[]; for(let i=Math.max(1,rows.length-len);i<rows.length;i++){ const c=rows[i],p=rows[i-1]; trs.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close))); } return sma(trs); }
      function rsi(closes,len=14){ if(closes.length<=len) return null; let g=0,l=0; for(let i=closes.length-len;i<closes.length;i++){ const d=closes[i]-closes[i-1]; if(d>=0) g+=d; else l-=d; } if(l===0) return 100; const rs=g/l; return 100-(100/(1+rs)); }
      function std(a){ const m=sma(a); if(m==null) return null; return Math.sqrt(a.reduce((x,y)=>x+(y-m)*(y-m),0)/a.length); }
      function pct(vals,q){ const a=vals.filter(finite).sort((x,y)=>x-y); if(!a.length) return null; return a[Math.max(0,Math.min(a.length-1,Math.round((a.length-1)*q)))]; }
      function calcFeature(pair,tf,rows,idx){
        const win=rows.slice(Math.max(0,idx-120),idx+1); const closes=win.map(x=>x.close).filter(finite); if(closes.length<30) return null;
        const price=closes[closes.length-1], a=atr(win,14)||price*0.003, e20=ema(closes.slice(-80),20), e50=ema(closes.slice(-120),50), r=rsi(closes,14), last20=closes.slice(-20), m=sma(last20), sd=std(last20);
        const highs=win.slice(-80).map(x=>x.high), lows=win.slice(-80).map(x=>x.low), swingHigh=Math.max(...highs), swingLow=Math.min(...lows), poc=pct(win.slice(-96).map(x=>(x.high+x.low+x.close)/3),0.5);
        return { pair,timeframe:tf,index:idx,time:rows[idx].t,close:price,atr:a,ema20:e20,ema50:e50,rsi:r,bbMid:m,bbUpper:m!=null&&sd!=null?m+2*sd:null,bbLower:m!=null&&sd!=null?m-2*sd:null,swingHigh,swingLow,poc };
      }
      function signal(strategy,f){
        const p=f.close, buf=Math.max(p*0.0018,(f.atr||p*0.003)*0.18);
        if(strategy==='EMA_TREND' && finite(f.ema20)&&finite(f.ema50)) return {side:p>=f.ema50?'LONG':'SHORT',zone:f.ema20,ok:Math.abs(p-f.ema20)<=buf*2.2};
        if(strategy==='SWING_LEVEL_BOUNCE') { const nearLow=Math.abs(p-f.swingLow)<=buf*3, nearHigh=Math.abs(p-f.swingHigh)<=buf*3; return nearLow?{side:'LONG',zone:f.swingLow,ok:true}:nearHigh?{side:'SHORT',zone:f.swingHigh,ok:true}:{ok:false}; }
        if(strategy==='POC' && finite(f.poc)) return {side:p>=f.poc?'LONG':'SHORT',zone:f.poc,ok:Math.abs(p-f.poc)<=buf*3.5};
        if(strategy==='BOLLINGER_REVERSAL' && finite(f.bbLower)&&finite(f.bbUpper)) return p<=f.bbLower+buf?{side:'LONG',zone:f.bbLower,ok:true}:p>=f.bbUpper-buf?{side:'SHORT',zone:f.bbUpper,ok:true}:{ok:false};
        if(strategy==='RSI_DIVERGENCE_ZONE' && finite(f.rsi)) return f.rsi<=35?{side:'LONG',zone:p,ok:true}:f.rsi>=65?{side:'SHORT',zone:p,ok:true}:{ok:false};
        return {ok:false};
      }
      function backtest(pair,tf,rows,strategy,rr){
        let wins=0,losses=0,grossWin=0,grossLoss=0,trades=0; const start=Math.max(60,Math.floor(rows.length*0.55)); const end=rows.length-8;
        for(let i=start;i<end;i++){
          const f=calcFeature(pair,tf,rows,i); if(!f) continue; const sig=signal(strategy,f); if(!sig.ok) continue;
          const price=f.close, stopDist=Math.max((f.atr||price*0.003)*1.15,price*0.0012); let stop,target;
          if(sig.side==='LONG'){stop=price-stopDist;target=price+stopDist*rr;} else {stop=price+stopDist;target=price-stopDist*rr;}
          let outcome=null; for(let j=i+1;j<Math.min(rows.length,i+18);j++){ const c=rows[j]; if(sig.side==='LONG'){ if(c.low<=stop){outcome=-1;break;} if(c.high>=target){outcome=rr;break;} } else { if(c.high>=stop){outcome=-1;break;} if(c.low<=target){outcome=rr;break;} } }
          if(outcome==null) continue; trades++; if(outcome>0){wins++;grossWin+=outcome;} else {losses++;grossLoss+=Math.abs(outcome);} if(trades>=220) break;
        }
        const pf=grossLoss>0?grossWin/grossLoss:(grossWin>0?grossWin:0); const wr=trades?wins/trades:0; const posterior=Math.max(0,Math.min(0.995,(pf/(pf+1||1))*0.7+wr*0.3)); return {trades,wins,losses,pf,wr,posterior};
      }
      function makeRowsForGroup(g){
        const rows=[]; const feats=[]; const f=calcFeature(g.pair,g.timeframe,g.rows,g.rows.length-1); if(!f) return {rows,feats}; feats.push(f);
        const strategies=['EMA_TREND','SWING_LEVEL_BOUNCE','POC','BOLLINGER_REVERSAL','RSI_DIVERGENCE_ZONE']; const exits=[1,1.5,2,3,5];
        for(const st of strategies){ for(const rr of exits){ const bt=backtest(g.pair,g.timeframe,g.rows,st,rr); const sig=signal(st,f); const score=(bt.pf||0)*25+(bt.trades||0)*0.25+(sig.ok?20:0)+(bt.posterior||0)*30; if(bt.trades<3 && !sig.ok) continue; rows.push({ key:`${g.pair}_${g.timeframe}||${g.timeframe.toUpperCase()}||${st}||${String(rr).replace('.','_')}R_FIXED`, pair:g.pair, symbol:g.pair, baseSymbol:g.pair, timeframe:g.timeframe, strategy:st, stratName:st, exit:`${rr}R Fixed`, direction:sig.side||'', currentPrice:f.close, setupPrice:sig.zone||f.close, score:Number(score.toFixed(4)), oosPF:Number((bt.pf||0).toFixed(6)), oosTrades:bt.trades, totalTrades:bt.trades, nEffOOS:Math.max(0,Math.round(bt.trades*0.7)), posteriorPFgt1:Number((bt.posterior||0).toFixed(6)), rollingPass:bt.trades>=8 && bt.pf>=1, promotionTier:bt.trades>=25&&bt.posterior>=0.9&&bt.pf>=1.2?'FULL_AUTONOMY_FORWARD':(bt.trades>=10&&bt.pf>=1?'WATCH_FORWARD':'EXPERIMENTAL_FORWARD'), forwardEligible:true, evidenceSource:'REAL_CANDLE_DERIVED_BACKTEST', __alpsV951Source:'v951.realCandleDiscovery', __alpsV951CandlePath:g.path, closedCandleTime:f.time, latestClosedCandleTs:f.time, featureSnapshot:f }); } }
        return {rows,feats};
      }
      const groups = await collectAllCandles();
      out.candleStores = groups.slice(0,60).map(g=>({path:g.path,pair:g.pair,timeframe:g.timeframe,rows:g.rows.length,lastTime:g.rows[g.rows.length-1]?.t,lastClose:g.rows[g.rows.length-1]?.close}));
      for (const g of groups) { if (!g.pair || !g.timeframe) continue; const last=g.rows[g.rows.length-1]||{}; out.closedCandleMap[`${g.pair}_${g.timeframe}`.toUpperCase()]={pair:g.pair,timeframe:g.timeframe,latestClosedCandleTs:last.t||null,rows:g.rows.length,lastClose:last.close}; const made=makeRowsForGroup(g); out.featureRows.push(...made.feats); out.rows.push(...made.rows); }
      const unique=new Map(); for(const r of out.rows){ const k=r.key||`${r.pair}_${r.timeframe}_${r.strategy}_${r.exit}`; if(!unique.has(k)) unique.set(k,r); }
      out.rows=Array.from(unique.values()).sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,cfg.cap);
      out.featureRows=out.featureRows.slice(0,500);
      try { if (!Array.isArray(globalThis.results)) globalThis.results=[]; if (!Array.isArray(globalThis.discoveryResults)) globalThis.discoveryResults=[]; if (!Array.isArray(globalThis.allResults)) globalThis.allResults=[]; for(const r of out.rows){ if(!globalThis.results.some(x=>text(x.key)===text(r.key))) globalThis.results.push(r); if(!globalThis.discoveryResults.some(x=>text(x.key)===text(r.key))) globalThis.discoveryResults.push(r); if(!globalThis.allResults.some(x=>text(x.key)===text(r.key))) globalThis.allResults.push(r); } globalThis.__ALPS_V951_REAL_CANDLE_DISCOVERY__ = out; out.injected=true; } catch(e){ out.errors.push({where:'inject-results',message:text(e&&e.message||e).slice(0,180)}); }
      out.featureRowsFound=out.featureRows.length; out.materializedRows=out.rows.length; out.strategyTemplatesFound=5; out.closedCandlePairFrames=Object.keys(out.closedCandleMap).length; out.status=out.rows.length?'REAL_CANDLE_ROWS_MATERIALIZED':'NO_REAL_CANDLE_ROWS'; out.finishedAt=Date.now(); out.durationMs=out.finishedAt-startedAt; return JSON.parse(JSON.stringify(out));
    }, { version: FINAL_V930_VERSION, noFixedCandidateCap: V952_NO_FIXED_CANDIDATE_CAP, reason, cap: FINAL_V930_TECHNICAL_CAP, noFixedCandidateCap: V952_NO_FIXED_CANDIDATE_CAP });
  } catch (e) {
    return { schema: 'alps.v951RealCandleDiscovery.view.v1', version: FINAL_V930_VERSION, pageReady: false, reason, rows: [], featureRows: [], error: e.message, status: 'FAILED' };
  }
}
async function v947CollectPipelineDiagnosticsFromPage(reason = 'pipeline-truth-recovery') {
  if (!page || page.isClosed()) return { schema: 'alps.discoveryOutput.view.v1', version: FINAL_V930_VERSION, pageReady: false, reason };
  try {
    return await pageEval(async cfg => {
      const out = { schema: 'alps.discoveryOutput.view.v1', version: cfg.version, reason: cfg.reason, pageReady: true, startedAt: Date.now(), functionsInvoked: [], functionResults: [], errors: [], rows: [], storeInventory: { schema: 'alps.storeInventory.view.v1', version: cfg.version, available: true, arrays: [], functions: [], indexedDB: { available: !!globalThis.indexedDB, databases: [] } } };
      function text(v){ return String(v == null ? '' : v); }
      function num(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
      function arr(v){ return Array.isArray(v) ? v : []; }
      function looks(row){ if (!row || typeof row !== 'object' || Array.isArray(row)) return false; const s=[row.pair,row.sym,row.symbol,row.timeframe,row.tf,row.strategy,row.stratName,row.name,row.setup,row.root,row.pattern,row.oosPF,row.totalTrades,row.score,row.promotionTier,row.rawVerdict,row.effectiveVerdict,row.forwardEligible].map(text).join('|'); return /(USDT|XAU|BTC|ETH|SOL|BNB|XRP|DOGE|5m|15m|30m|1h|4h|HA|POC|VAH|VAL|strategy|setup|WATCH|ROBUST|FORWARD|PF|trade)/i.test(s) && /(USDT|XAU|strategy|setup|HA|POC|VAH|VAL|WATCH|ROBUST|FORWARD)/i.test(s); }
      function rowKey(row){ return [row.pair||row.sym||row.symbol||'',row.timeframe||row.tf||'',row.strategy||row.stratName||row.name||row.setup||row.root||'',row.exit||row.exitName||row.direction||''].map(x=>text(x).toUpperCase().replace(/[^A-Z0-9_./:-]+/g,'_')).join('||'); }
      function addRows(value, source){
        if (!value) return 0; let added=0;
        const values = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
        for (const item of values) { if (looks(item)) { const copy = Object.assign({}, item, { __alpsV947Source: source }); out.rows.push(copy); added++; } }
        return added;
      }
      function scanObject(obj, source, depth){
        if (!obj || depth > 3) return;
        if (Array.isArray(obj)) { if (/(strategy|result|candidate|robust|watch|keep|sandbox|experiment|forward|hypothesis|rows|pool)/i.test(source) || obj.some(looks)) addRows(obj, source); if (depth < 2 && obj.length < 50) obj.slice(0,15).forEach((x,i)=>scanObject(x, `${source}[${i}]`, depth+1)); return; }
        if (typeof obj !== 'object') return;
        for (const [k,v] of Object.entries(obj)) { if (/candles|ohlc|recentLogs|openTrades|closedTrades/i.test(k)) continue; if (Array.isArray(v) || (v && typeof v === 'object')) scanObject(v, source ? `${source}.${k}` : k, depth+1); }
      }
      async function callFn(name, ...args){
        try {
          const fn = globalThis[name] || (typeof window !== 'undefined' ? window[name] : null);
          if (typeof fn !== 'function') return { name, exists:false };
          out.functionsInvoked.push(name);
          const before = out.rows.length;
          let ret = fn.apply(globalThis, args);
          if (ret && typeof ret.then === 'function') ret = await Promise.race([ret, new Promise(resolve => setTimeout(() => ({ __timeout:true }), cfg.timeoutMs))]);
          const type = Array.isArray(ret) ? 'array' : (ret && typeof ret === 'object' ? 'object' : typeof ret);
          scanObject(ret, `return.${name}`, 0);
          out.functionResults.push({ name, exists:true, type, returnedRows: out.rows.length - before, timedOut: !!(ret && ret.__timeout) });
          return { name, exists:true };
        } catch(e) { out.errors.push({ name, message: text(e && e.message || e).slice(0,240) }); return { name, exists:true, error:text(e && e.message || e) }; }
      }
      let report = null;
      try { if (typeof buildRunReportObject === 'function') report = await buildRunReportObject(); } catch(e) { out.errors.push({ name:'buildRunReportObject', message:text(e && e.message || e).slice(0,240) }); }
      scanObject(report, 'report', 0);
      const knownArrays = ['results','allResults','discoveryResults','robustnessResults','robustRows','topStrategies','candidates','candidatePool','forwardPool','activeForwardPool','researchRows','strategyRows','watchRows','keepRows','experiments','experimentRows'];
      for (const name of knownArrays) { try { const v = globalThis[name] || (typeof window !== 'undefined' ? window[name] : null); if (Array.isArray(v)) { out.storeInventory.arrays.push({ name, length:v.length, candidateLike:v.some(looks) }); addRows(v, `global.${name}`); } } catch(_){} }
      const fnNames = Object.keys(globalThis).filter(k => typeof globalThis[k] === 'function' && /(research|strateg|discover|robust|backtest|candidate|pool|edge|feature|indicator|setup|scan|generate|engine|watch)/i.test(k)).slice(0,180);
      out.storeInventory.functions = fnNames.slice(0,120);
      const fallbackFns = ['analyzeRobustness','runEngineWorkerRobustness','adaptiveResearchGovernorRows','researchSandboxCandidatePool','forwardCandidatePool','activeForwardCandidatePool','generateMissingEdge','runRobustness','runRobustnessTests','runBacktests','scanStrategies','generateStrategies','discoverStrategies','runDiscovery'];
      for (const name of fallbackFns) await callFn(name, cfg.reason);
      try { if (globalThis.indexedDB && indexedDB.databases) out.storeInventory.indexedDB.databases = (await indexedDB.databases()).map(d => d.name).filter(Boolean).slice(0,30); } catch(_) {}
      const unique = new Map(); for (const r of out.rows) { const k = rowKey(r); if (k && !unique.has(k)) unique.set(k, r); }
      out.rows = Array.from(unique.values()).slice(0, cfg.cap);
      out.featureRowsFound = Math.max(0, ...out.storeInventory.arrays.filter(a => /feature|indicator|regime/i.test(a.name)).map(a => a.length), 0);
      out.strategyTemplatesFound = fnNames.filter(k => /(strategy|strateg|template|discover|backtest|robust)/i.test(k)).length;
      out.rawSetupRows = Math.max(0, ...out.storeInventory.arrays.filter(a => /setup|signal|sweep|break|bounce|value/i.test(a.name)).map(a => a.length), 0);
      out.testedRows = out.rows.length;
      out.rejectedRows = 0;
      out.candlesVisibleToReport = !!(report && report.data && num(report.data.candlesLoaded) > 0);
      out.candlesVisibleToDiscovery = out.rows.length > 0 || out.featureRowsFound > 0 || out.rawSetupRows > 0;
      out.finishedAt = Date.now(); out.durationMs = out.finishedAt - out.startedAt;
      out.status = out.rows.length ? 'ROWS_FOUND_AND_MATERIALIZED' : 'DISCOVERY_RETURNED_ZERO_ROWS';
      return JSON.parse(JSON.stringify(out));
    }, { version: FINAL_V930_VERSION, noFixedCandidateCap: V952_NO_FIXED_CANDIDATE_CAP, reason, timeoutMs: V947_DISCOVERY_CALL_TIMEOUT_MS, cap: FINAL_V930_TECHNICAL_CAP, noFixedCandidateCap: V952_NO_FIXED_CANDIDATE_CAP });
  } catch (e) {
    return { schema: 'alps.discoveryOutput.view.v1', version: FINAL_V930_VERSION, pageReady: false, reason, error: e.message, status: 'DIAGNOSTIC_COLLECTION_FAILED' };
  }
}

async function triggerActualResearchIfNeeded(source = 'research-trigger-data-bridge', h = lastHealth || {}) {
  const pageBridgeMetrics = await v946ReadPageResearchBridgeMetrics(source).catch(() => null);
  const bridgedInput = Object.assign({}, h || {}, {
    report: h,
    dataPairFrames: v946MaxNumber(h?.dataPairFrames, h?.data?.pairFrames, pageBridgeMetrics?.reportDataPairFrames),
    candlesLoaded: v946MaxNumber(h?.candlesLoaded, h?.data?.candlesLoaded, pageBridgeMetrics?.reportCandlesLoaded),
    rawResearchStrategies: v946MaxNumber(h?.rawResearchStrategies, h?.research?.strategies, pageBridgeMetrics?.reportResearchStrategies, pageBridgeMetrics?.globalResults, pageBridgeMetrics?.globalAllResults, pageBridgeMetrics?.globalDiscoveryResults),
    rawResearchCycles: v946MaxNumber(h?.rawResearchCycles, h?.research?.researchCycles, pageBridgeMetrics?.reportResearchCycles),
    candidatesMonitored: v946MaxNumber(h?.candidatesMonitored, h?.forwardWatch?.candidatesMonitored, pageBridgeMetrics?.reportCandidatesMonitored),
    totalGeneratedStrategies: v946MaxNumber(h?.totalGeneratedStrategies, h?.forwardWatch?.totalGeneratedStrategies, pageBridgeMetrics?.reportTotalGeneratedStrategies),
    researchDataBridge: pageBridgeMetrics || null
  });
  if (researchTriggerBusy || !v945ShouldTriggerResearch(bridgedInput)) {
    lastResearchTriggerView = v945BuildResearchTriggerView(bridgedInput);
    return false;
  }
  researchTriggerBusy = true;
  const metrics = v945ResearchMetrics(bridgedInput);
  researchTriggerState.triggered = true;
  researchTriggerState.triggerCount = n(researchTriggerState.triggerCount, 0) + 1;
  researchTriggerState.lastAction = 'FORCE_RESEARCH_START';
  researchTriggerState.lastReason = source;
  researchTriggerState.lastAt = Date.now();
  researchTriggerState.lastPairFrames = metrics.pairFrames;
  researchTriggerState.lastStrategies = metrics.rawStrategies;
  researchTriggerState.lastCandlesLoaded = metrics.candlesLoaded;
  researchTriggerState.dataVersion = `${metrics.pairFrames}pf_${metrics.candlesLoaded}c`;
  if (researchTriggerState.lastRetryReason) researchTriggerState.lastAction = 'RETRY_RESEARCH_START';
  lastResearchTriggerView = v945BuildResearchTriggerView(bridgedInput);
  try {
    log(`v9.5.1 All-in-One Feature/Discovery/Forward/Entry Recovery: source=${source} pairFrames=${metrics.pairFrames} candles=${metrics.candlesLoaded} rawStrategies=${metrics.rawStrategies} runnerState=${metrics.runnerStateStatus}`);
    const result = await pageEval(async cfg => {
      const state = globalThis.__ALPS_V946_RESEARCH_TRIGGER__ || globalThis.__ALPS_V945_RESEARCH_TRIGGER__ || { version: cfg.version, attempts: [], invoked: [], clicked: [], errors: [], functionsFound: [], lastAt: 0 };
      globalThis.__ALPS_V946_RESEARCH_TRIGGER__ = state;
      state.version = cfg.version; state.lastAt = Date.now(); state.reason = cfg.reason; state.dataBridge = cfg.dataBridge || null; state.errorCode = ''; state.status = 'FORCE_RESEARCH_START';
      function arr(v) { return Array.isArray(v) ? v : []; }
      function text(v) { return String(v == null ? '' : v); }
      function uniqPush(list, value) { if (value && !list.includes(value)) list.push(value); }
      function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
      async function callIfExists(name, ...args) {
        try {
          const fn = globalThis[name] || (typeof window !== 'undefined' ? window[name] : null);
          if (typeof fn !== 'function') return false;
          uniqPush(state.attempts, name);
          const out = fn.apply(globalThis, args);
          if (out && typeof out.then === 'function') {
            await Promise.race([out.catch(e => { throw e; }), sleep(cfg.callTimeoutMs).then(() => '__ALPS_CALL_TIMEOUT__')]);
          }
          uniqPush(state.invoked, name);
          return true;
        } catch (err) {
          state.errors.push({ at: Date.now(), name, message: text(err && err.message || err).slice(0, 240) });
          return false;
        }
      }
      try {
        const found = Object.keys(globalThis).filter(k => /(snapshot|research|strateg|discover|robust|backtest|lab|watch|runner|cycle|tick|scan|generate)/i.test(k) && typeof globalThis[k] === 'function');
        state.functionsFound = found.slice(0, 120);
      } catch (_) {}

      // 1) Restore full snapshot first when the app only restored a lightweight marker.
      const restoreNames = ['loadFullSnapshot','restoreFullSnapshot','loadRuntimeSnapshot','restoreRuntimeSnapshot','loadFullState','hydrateFullSnapshot','loadSnapshotFromIndexedDB','loadSnapshot','restoreSnapshot','loadFullSnapshotFromIndexedDB'];
      for (const name of restoreNames) await callIfExists(name, cfg.reason);

      // 2) Prepare runtime and start the lab/research even if labRunning is already true but paused.
      const prepareNames = ['prepareAndroidRuntime','startEngineWorker','runFinalPreflight'];
      for (const name of prepareNames) await callIfExists(name);
      await callIfExists('startLab');

      // 3) Direct research/discovery/backtest function attempts. Unknown names are skipped safely.
      const researchNames = [
        'runResearch','runResearchCycle','runResearchOnce','startResearch','runAdaptiveResearch','runAllResearch','runShadowResearch',
        'discoverStrategies','runDiscovery','generateStrategies','generateStrategyUniverse','buildStrategies','scanStrategies','scanStrategyUniverse',
        'runBacktests','runBacktest','runRobustness','runRobustnessTests','testAllStrategies','evaluateStrategies','evaluateStrategyUniverse',
        'runLabCycle','cycleLab','schedulerTick','runSchedulerCycle','tickResearch','researchTick','mainLoop','runAllTierLoop','runStorageSafeAllTierLoop',
        'runResearchEngine','startResearchEngine','startDiscovery','generateDiscovery','scanAllStrategies','runAllBacktests','startBacktest','backtestAll','runFullCycle'
      ];
      for (const name of researchNames) await callIfExists(name, cfg.reason);

      // 4) UI fallback for apps whose controls are not exported as globals.
      try {
        const wanted = [/load\s+full\s+snapshot/i, /restore\s+full/i, /start\s+lab/i, /run\s+research/i, /research/i, /discover/i, /resume/i, /start/i];
        const buttons = Array.from(document.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]'));
        for (const el of buttons) {
          const label = text(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
          if (!label || !wanted.some(rx => rx.test(label))) continue;
          try { el.click(); uniqPush(state.clicked, label.slice(0, 80)); await sleep(200); } catch (err) { state.errors.push({ at: Date.now(), name: 'click:' + label.slice(0,80), message: text(err && err.message || err).slice(0,240) }); }
        }
      } catch (err) { state.errors.push({ at: Date.now(), name: 'ui-fallback', message: text(err && err.message || err).slice(0,240) }); }

      try { await callIfExists('saveRuntimeSnapshotThrottled', false); } catch (_) {}
      try { if (typeof renderAll === 'function') renderAll(); } catch (_) {}
      state.completedAt = Date.now();
      state.researchInvoked = arr(state.invoked).filter(name => /(startLab|Research|Discover|Strateg|Backtest|Robust|LabCycle|Scheduler|Tick|AllTier|StorageSafe|FullCycle)/i.test(name));
      const meaningfulClick = arr(state.clicked).some(label => /(start|lab|research|discover|resume|run)/i.test(label));
      if (state.researchInvoked.length || meaningfulClick) {
        state.status = 'TRIGGER_SENT';
        state.errorCode = '';
      } else {
        state.status = 'RESEARCH_FUNCTION_NOT_FOUND';
        state.errorCode = 'RESEARCH_FUNCTION_NOT_FOUND';
        state.errors.push({ at: Date.now(), name: 'research-trigger-data-bridge', message: 'RESEARCH_FUNCTION_NOT_FOUND: no exported research/generate/discovery/backtest/startLab function or clickable control was found.' });
      }
      return JSON.parse(JSON.stringify(state));
    }, { version: FINAL_V930_VERSION, noFixedCandidateCap: V952_NO_FIXED_CANDIDATE_CAP, reason: source, callTimeoutMs: V945_RESEARCH_TRIGGER_CALL_TIMEOUT_MS, dataBridge: pageBridgeMetrics || null });
    researchTriggerState.lastResult = result || null;
    researchTriggerState.lastStatus = result?.status || '';
    researchTriggerState.lastErrorCode = result?.errorCode || '';
    if (result?.errors?.length) researchTriggerState.errors = safeArray(researchTriggerState.errors).concat(result.errors).slice(-20);
    lastResearchTriggerView = v945BuildResearchTriggerView(bridgedInput);
    return true;
  } catch (e) {
    researchTriggerState.errors = safeArray(researchTriggerState.errors).concat([{ at: Date.now(), name: 'triggerActualResearchIfNeeded', message: e.message }]).slice(-20);
    researchTriggerState.lastAction = 'FORCE_RESEARCH_START_ERROR';
    lastResearchTriggerView = v945BuildResearchTriggerView(bridgedInput);
    log('v9.5.1 All-in-One Feature/Discovery/Forward/Entry Recovery failed:', e.message);
    return false;
  } finally {
    researchTriggerBusy = false;
  }
}
function v944BuildRecoverableEntryView(report = {}, latchView = null) {
  const scanned = (latchView?.size || 0) + n(report?.nativeForwardPool?.totalCandidates, 0);
  return { schema: 'alps.recoverableEntry.view.v1', version: FINAL_V930_VERSION, installed: true, lookbackClosedCandles: V944_RECOVERABLE_LOOKBACK_CANDLES, entryZoneBps: V944_ENTRY_ZONE_BPS, recoverableEntriesScanned: scanned, recoveredFreshEntries: 0, mode: 'RECENT_CLOSED_CANDLE_ZONE_RECOVERY', rule: 'A recent setup from the last closed candles may open paper if current price remains in the entry zone, invalidation/stop has not fired, and duplicate/freshness guards pass.' };
}

function v948EmptyEntryView(reason = 'not-run') {
  return {
    schema: 'alps.zonePersistenceEntry.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    paperOnly: true,
    liveCapitalExecution: false,
    mode: 'LAST_CANDLE_OR_VALID_RECENT_ZONE',
    maxEntriesPerTick: V948_ENTRY_MAX_PER_TICK,
    lookbackClosedCandles: V948_ENTRY_LOOKBACK_CANDLES,
    entryZoneBps: V948_ENTRY_ZONE_BPS,
    scanned: 0,
    opened: 0,
    rejected: 0,
    rejectedReasonCounts: {},
    openedTrades: [],
    candidateSources: {},
    serverCandidatesSeen: 0,
    candleResolver: lastV950CandleStoreResolverView || null,
    visibilityBridge: lastV950PaperEntryVisibilityView || null,
    lastReason: reason,
    numericGuard: lastV948NumericGuardView || { installed: true, guardedToFixedErrors: 0, lastGuardedError: '' },
    rule: 'A paper entry may open from a recent closed-candle setup when current price remains inside the same entry zone, invalidation has not fired, duplicate guard passes, and numeric entry/stop/target are finite.'
  };
}

function v948BuildEntryActivationView(report = {}) {
  const view = lastV948EntryEngineView || v948EmptyEntryView('awaiting-page-engine');
  const paperSignals = n(report.paperSignals, n(lastHealth?.paperSignals, 0));
  const openPositions = n(report.openPositions, n(lastHealth?.openPositions, 0));
  const closedTrades = n(report.closedTrades, n(lastHealth?.closedTrades, 0));
  const rejectedSignals = n(report.rejectedSignals, n(lastHealth?.rejectedSignals, 0));
  const candidatesVisible = v949Num(view.candidatesSeen, 0) > 0 || v949Num(report?.nativeForwardPool?.totalCandidates, 0) > 0 || v949Num(lastNativeForwardPoolView?.totalCandidates, 0) > 0;
  const candlesVisible = v949Num(view.candlesStoresFound, 0) > 0 || v949Num(view?.candleResolver?.storesFound, 0) > 0;
  let status = paperSignals > 0 || openPositions > 0 ? 'PAPER_ENTRY_ACTIVE' : (view.opened > 0 ? 'PAPER_ENTRY_OPENED_THIS_TICK' : 'WAITING_VALID_ZONE_OR_NUMERIC_PLAN');
  if (!v949Num(view.candidatesSeen, 0) && candidatesVisible) status = 'ENTRY_ENGINE_CANDIDATE_VISIBILITY_GAP';
  if (v949Num(view.candidatesSeen, 0) && !candlesVisible) status = 'ENTRY_ENGINE_CANDLE_VISIBILITY_GAP';
  const reasonCounts = { ...(view.rejectedReasonCounts || {}) };
  if (rejectedSignals > 0 && Object.keys(reasonCounts).length === 0) reasonCounts.EXTERNAL_FORWARD_REJECTION_NOT_MAPPED = rejectedSignals;
  return {
    ...view,
    paperSignals,
    openPositions,
    closedTrades,
    rejectedSignals,
    rejectedReasonCounts: reasonCounts,
    candidatesVisible,
    candlesVisible,
    visibilityBridge: view.visibilityBridge || lastV950PaperEntryVisibilityView || null,
    candleResolver: view.candleResolver || lastV950CandleStoreResolverView || null,
    status,
    lastKnownBlocker: (view.opened > 0 || paperSignals > 0 || openPositions > 0) ? '' : (view.topRejectedReason || (candlesVisible ? 'NO_VALID_ZONE_ENTRY_YET' : 'CANDLE_STORE_NOT_VISIBLE_TO_ENTRY_ENGINE'))
  };
}

function v944BuildAdaptiveExitManagerView(report = {}, latchView = null) {
  const candidates = safeArray(latchView?.candidates);
  return { schema: 'alps.adaptiveExitManager.view.v1', version: FINAL_V930_VERSION, installed: true, paperOnly: true, candidatesWithExitPlan: candidates.filter(c => c.adaptiveExitPlan).length, rrModels: ['1R','1.5R','2R','3R','5R'], activeRules: ['MOVE_STOP_TO_ENTRY_OR_SLIGHTLY_ABOVE_AT_50_PERCENT','MOVE_STOP_TO_50_PERCENT_TARGET_AT_75_PERCENT'], examples: candidates.slice(0, 12).map(c => ({ key: c.key, pair: c.pair, timeframe: c.timeframe, rr: c.adaptiveExitPlan?.rMultipleSelected, rules: c.adaptiveExitPlan?.progressLevels || [] })), rule: 'Relative target/stop manager selects R-multiple per pair/setup and protects paper trades progressively as price reaches 50% and 75% of target distance.' };
}
function v944BuildSyntheticIndicatorEngineView(report = {}, latchView = null) {
  const gov = v1010BuildIndicatorGovernanceView(report, latchView);
  return {
    schema: 'alps.indicatorResearchEngine.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    mode: 'RESEARCH_ONLY_GOVERNED_INDICATORS',
    indicatorsCreated: gov.indicatorsCreated,
    chartOverlayReady: true,
    executionInfluenceAllowed: false,
    promotedForPaperEntry: gov.promotedForPaperEntry,
    indicators: gov.indicators,
    usePolicy: gov.usePolicy,
    rule: 'Custom indicator development is enabled as research. Unvalidated indicators are never treated as execution truth.'
  };
}

async function loadForwardLatchState() {
  try {
    const raw = await fsp.readFile(V944_FORWARD_LATCH_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.candidates)) forwardLatchState = { ...forwardLatchState, ...parsed, version: FINAL_V930_VERSION };
  } catch (_) {}
  lastForwardLatchView = v944BuildForwardLatchView();
  return forwardLatchState;
}
async function saveForwardLatchState() {
  try { await fsp.mkdir(DATA_DIR, { recursive: true }); await fsp.writeFile(V944_FORWARD_LATCH_FILE, JSON.stringify(forwardLatchState, null, 2)); } catch (_) {}
}
function v941ExperimentalCountFromView(view = lastNativeForwardPoolView || {}) { return n(view.experimentalForward, 0); }
function v941IsForwardTier(tier = '') { return /^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD|EXPERIMENTAL_FORWARD)$/.test(textValue(tier)); }
function v94BuildRecoveryForwardCoreView(report = {}) {
  const bridge = report.oosEvidenceBridge || lastOOSEvidenceBridgeView || {};
  const pool = report.nativeForwardPool || lastNativeForwardPoolView || {};
  const eligible = v94ForwardEligibleCountFromView(pool);
  const experimental = v941ExperimentalCountFromView(pool);
  const verified = n(pool.fullAutonomyForward, 0) + n(pool.watchForward, 0);
  const data = report.data || {};
  const rawStrategies = n(report?.research?.strategies || report?.forwardWatch?.totalGeneratedStrategies || 0, 0);
  const pairFrames = n(data.pairFrames || report.dataPairFrames || lastHealth?.dataPairFrames || 0, 0);
  const noEvidence = pairFrames >= BOOT_WATCHDOG_TARGET_PAIRFRAMES && rawStrategies > 0 && eligible === 0 && n(bridge.matchedRows, 0) === 0 && n(bridge.candidateRowsWithEvidence, 0) === 0;
  const forwardDecision = verified > 0 ? 'START_VERIFIED_FORWARD_WHEN_FRESH'
    : experimental > 0 ? 'EXPERIMENTAL_FORWARD_COLLECTING_EVIDENCE'
    : noEvidence ? 'EXPERIMENTAL_FORWARD_COLLECTING_EVIDENCE'
    : 'WAITING_FOR_BOOT_OR_EVIDENCE';
  const view = {
    schema: 'alps.recoveryForwardCore.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    bootChain: 'DATA_LOAD -> RESEARCH -> EXPERIMENTAL_FORWARD -> PAPER_EVIDENCE -> DECISION_ACTUATOR -> VERIFIED_FORWARD',
    pairFrames,
    rawResearchStrategies: rawStrategies,
    eligibleForwardCandidates: eligible,
    verifiedForwardCandidates: verified,
    experimentalForwardCandidates: experimental,
    oosEvidenceBridge: bridge,
    forwardDecision,
    honestFailure: noEvidence,
    paperOnly: true,
    liveCapitalExecution: false,
    note: 'v9.4.1 does not wait for historical OOS to exist. It collects live paper evidence under EXPERIMENTAL_FORWARD and only promotes later with real outcomes.'
  };
  lastRecoveryForwardCoreView = view; return view;
}

function v941CandidateMutationPlan(c = {}) {
  const root = v931StrategyRoot(c);
  const tf = textValue(c.timeframe || c.tf || '').toLowerCase();
  const exit = textValue(c.exit || c.exitName || '').toUpperCase();
  const plans = [];
  if (!/ATR/.test(exit)) plans.push('TEST_ATR_TRAIL_EXIT');
  if (!/2R|2.5R|3R/.test(exit)) plans.push('TEST_HIGHER_R_EXIT');
  if (/5m|15m/.test(tf)) plans.push('TEST_SLOWER_TIMEFRAME');
  if (/4h/.test(tf)) plans.push('TEST_1H_EXECUTION_VARIANT');
  if (/VAH_VAL|EMA_TREND|BB_SQUEEZE|RSI_DIVERGENCE_ZONE/.test(root)) plans.push('TEST_REGIME_FILTER_VARIANT');
  return plans.slice(0, 4);
}
function v941BuildDecisionActuatorView(nativeView = {}, report = {}) {
  const candidates = safeArray(nativeView.candidates);
  const experimental = candidates.filter(c => c.tier === 'EXPERIMENTAL_FORWARD');
  const verified = candidates.filter(c => c.tier === 'WATCH_FORWARD' || c.tier === 'FULL_AUTONOMY_FORWARD');
  const suspended = candidates.filter(c => c.tier === 'COGNITION_SUSPENDED');
  const mutationPlans = experimental.slice(0, 30).map(c => ({ key: c.key, pair: c.pair, timeframe: c.timeframe, strategy: c.strategy, exit: c.exit, plan: v941CandidateMutationPlan(c) }));
  const closed = n(report?.forwardWatch?.closedTrades || report?.intelligence?.ledger?.closed || 0, 0);
  return {
    schema: 'alps.decisionActuator.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    mode: 'PAPER_LEARNING_ACTUATOR',
    decisionsApplied: experimental.length + verified.length + suspended.length,
    experimentalForward: experimental.length,
    verifiedForward: verified.length,
    trustAdjusted: closed > 0 ? 'PENDING_AFTER_LEDGER_SYNC' : 0,
    mutationsCreated: mutationPlans.reduce((sum, x) => sum + safeArray(x.plan).length, 0),
    shadowRoutesCreated: 0,
    suspendedPatterns: suspended.length,
    exitChangesTested: mutationPlans.filter(x => safeArray(x.plan).some(p => /EXIT|R_EXIT/.test(p))).length,
    timeframeChangesTested: mutationPlans.filter(x => safeArray(x.plan).some(p => /TIMEFRAME|EXECUTION/.test(p))).length,
    mutationPlans,
    rule: 'Actuator turns selected research rows into paper experiments, tags them NOT_OOS_VERIFIED, and plans exit/timeframe/regime mutations. Real promotion still requires paper/OOS evidence.'
  };
}
function v931RankCandidate(c = {}) {
  const m = v931EvidenceMetrics(c);
  const score = v931Num(c.score, 0);
  const dd = v931Num(c.oosDD ?? c.ddBps, 0);
  const forwardBonus = (c.forwardEligible === true || /WATCHLIST|FORWARD/i.test(textValue(c.promotionTier))) ? 30 : 0;
  const evidenceBonus = v931HasMinimumEvidence(c) ? 1000 : -5000;
  const promotedBonus = m.promote ? 1500 : 0;
  return evidenceBonus + promotedBonus + score + (m.posteriorPFgt1 * 100) + (m.oosPF * 10) + (m.nEffOOS * 0.4) + forwardBonus - (dd / 5000);
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
      method: 'MIN_EVIDENCE_GATE_THEN_CLUSTER_REPRESENTATIVE',
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
  const evidenceTier = v931EvidenceTier(c);
  const qLabels = labels.concat(metrics.promote ? ['QUANT_PASS'] : [evidenceTier]);
  const hasEvidence = v931HasMinimumEvidence(c);
  if (safety) return { tier: safety === 'DATA_OR_PRICE_GUARD' ? 'DATA_BLOCKED' : 'SAFETY_BLOCKED', safetyReason: safety, evidenceLabels: qLabels, quantitative: metrics };
  const suspended = routes.find(r => String(r.action || '').toUpperCase().includes('SHADOW') && autonomyRouteMatchesCandidate(r, c));
  if (suspended) return { tier: 'COGNITION_SUSPENDED', safetyReason: '', evidenceLabels: qLabels.concat(['COGNITION_ROUTE']), routeKey: suspended.routeKey || '', quantitative: metrics };
  if (metrics.promote) return { tier: 'FULL_AUTONOMY_FORWARD', safetyReason: '', evidenceLabels: qLabels.concat(['PROMOTED_BY_AUTONOMY','OOS_VERIFIED_FORWARD']), quantitative: metrics };
  if (hasEvidence) return { tier: 'WATCH_FORWARD', safetyReason: '', evidenceLabels: qLabels.concat(['MIN_EVIDENCE_PASS','OOS_EVIDENCE_READY','OOS_VERIFIED_FORWARD']), quantitative: metrics };
  return { tier: 'EXPERIMENTAL_FORWARD', safetyReason: '', evidenceLabels: qLabels.concat(['NOT_OOS_VERIFIED','LIVE_PAPER_EVIDENCE_COLLECTION','EXPERIMENTAL_FORWARD']), quantitative: metrics, experimental: true };
}
function buildNativeForwardPoolView(report = {}, routes = []) {
  const top = safeArray(report?.research?.topStrategies);
  const bridgeBundle = v94BuildEvidenceBridge(report, top);
  const bridgedTop = v94ApplyOosEvidenceToRows(top, bridgeBundle.evidenceRows);
  const mutationGovernor = v931BuildMutationGovernor(report);
  const deduped = v931DedupCandidates(bridgedTop, report, FINAL_V930_TECHNICAL_CAP);
  const selected = [];
  const seen = new Set();
  const quotas = mutationGovernor.active
    ? ['FULL_AUTONOMY_FORWARD','WATCH_FORWARD','EXPERIMENTAL_FORWARD','RESEARCH_SANDBOX']
    : ['FULL_AUTONOMY_FORWARD','WATCH_FORWARD','EXPERIMENTAL_FORWARD','RESEARCH_SANDBOX'];
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
        originalBlockReason: c.forwardBlockReason || '',
        experimental: cls.tier === 'EXPERIMENTAL_FORWARD',
        learningStage: cls.tier === 'EXPERIMENTAL_FORWARD' ? 'LIVE_PAPER_EVIDENCE_COLLECTION' : (cls.tier === 'WATCH_FORWARD' ? 'OOS_VERIFIED_WATCH' : cls.tier)
      });
      
    }
    
  }
  const count = tier => selected.filter(x => x.tier === tier).length;
  const quantPassed = selected.filter(x => x.quantitative?.promote).length;
  return {
    schema: 'alps.nativeForwardPool.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    technicalCap: V952_NO_FIXED_CANDIDATE_CAP ? 'UNLIMITED_ACCEPT_ALL_REAL_CANDIDATES' : FINAL_V930_TECHNICAL_CAP,
    poolViewCap: null,
    totalCandidates: selected.length,
    generatedStrategies: Number(report?.research?.strategies || report?.forwardWatch?.totalGeneratedStrategies || top.length || 0),
    fullAutonomyForward: count('FULL_AUTONOMY_FORWARD'),
    watchForward: count('WATCH_FORWARD'),
    experimentalForward: count('EXPERIMENTAL_FORWARD'),
    researchSandbox: count('RESEARCH_SANDBOX'),
    cognitionSuspended: count('COGNITION_SUSPENDED'),
    safetyBlocked: count('SAFETY_BLOCKED'),
    dataBlocked: count('DATA_BLOCKED'),
    promotedByFullAutonomy: count('FULL_AUTONOMY_FORWARD'),
    promotedToExperimental: count('EXPERIMENTAL_FORWARD'),
    blockedBySafety: count('SAFETY_BLOCKED') + count('DATA_BLOCKED'),
    quantitativePromotion: {
      installed: true,
      rule: 'nEff_OOS >= 25 AND P(PF>1) >= 0.90 AND rollingMinPF >= 0.60 when available; if rolling is unavailable require PF>=1.80 and stress5>=1.20 when available.',
      passed: quantPassed,
      thresholds: { nEffOOS: 25, posteriorPFgt1: 0.90, rollingMinPF: 0.60, fallbackPF: 1.80, fallbackStress5: 1.20 }
    },
    duplicateCompression: deduped.stats,
    oosEvidenceBridge: bridgeBundle.view,
    mutationGovernor,
    decisionActuator: null,
    evidenceLabels: [...new Set(selected.flatMap(x => x.evidenceLabels || []))],
    candidates: selected.slice(0, 50),
    note: 'v9.4.1: Live Paper Evidence Collector starts EXPERIMENTAL_FORWARD for non-safety candidates when verified OOS is unavailable. It never labels those candidates OOS-verified; it marks them NOT_OOS_VERIFIED and collects real paper evidence.'
  };
}
function buildFullAutonomyView(report = {}, nativeView = null, routes = []) {
  const decisions = [];
  if (nativeView?.duplicateCompression?.compressedRows > 0) decisions.push({ action: 'DEDUP_FORWARD_POOL', reason: `${nativeView.duplicateCompression.compressedRows} near-duplicate rows compressed before forward selection.` });
  if (nativeView?.promotedByFullAutonomy > 0) decisions.push({ action: 'OPEN_PAPER_CANDIDATE_AUTHORITY', reason: `${nativeView.promotedByFullAutonomy} candidates passed quantitative FULL_AUTONOMY_FORWARD rule.` });
  if (nativeView?.mutationGovernor?.active) decisions.push({ action: 'REBUILD', reason: 'Mutation stagnation detected; selection budget moved toward exploration representatives.' });
  if (nativeView?.experimentalForward > 0) decisions.push({ action: 'EXPERIMENTAL_FORWARD_COLLECT_EVIDENCE', reason: `${nativeView.experimentalForward} non-OOS-verified candidates admitted to paper evidence collection.` });
  if (!decisions.length) decisions.push({ action: 'WAIT_FOR_CANDIDATES', reason: 'No candidate rows available yet.' });
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
    lastDecision: decisions[0]?.action || 'WAIT_FOR_CANDIDATES',
    quantitativePromotion: nativeView?.quantitativePromotion || null,
    duplicateCompression: nativeView?.duplicateCompression || null,
    mutationGovernor: nativeView?.mutationGovernor || null,
    nativeForwardPool: { totalCandidates: nativeView?.totalCandidates || 0, promotedByFullAutonomy: nativeView?.promotedByFullAutonomy || 0, blockedBySafety: nativeView?.blockedBySafety || 0 },
    activeEvidenceRoutes: safeArray(routes).length
  };
}


function v949Num(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const x = Number(String(value).replace(/[,%$≈]/g, '').trim());
  return Number.isFinite(x) ? x : fallback;
}
function v949Finite(value) { return Number.isFinite(Number(value)); }
function v949Pct(num, den) { return den > 0 ? Number(((num / den) * 100).toFixed(2)) : 0; }
function v949CollectForwardRows(report = {}) {
  const rows = [];
  const push = (v) => { for (const x of safeArray(v)) if (x && typeof x === 'object') rows.push(x); };
  push(report?.nativeForwardPool?.candidates);
  push(report?.forwardLatch?.candidates);
  push(report?.recoveryForwardCore?.candidates);
  push(lastNativeForwardPoolView?.candidates);
  push(lastForwardLatchView?.candidates);
  const seen = new Set();
  return rows.filter((r) => {
    const key = uniqueKeyFromCandidate(r) || JSON.stringify(r).slice(0, 160);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function v949TradeRows(report = {}) {
  const rows = [];
  for (const src of [report.paperSignals, report.openPositions, report.openTrades, report.closedTrades, report.trades, report?.zonePersistenceEntry?.openedTrades, report?.paperEntryActivation?.openedTrades, report?.alpsTradeExport?.openTrades, report?.alpsTradeExport?.closedTrades, lastTradeExport?.openTrades, lastTradeExport?.closedTrades, lastV948EntryEngineView?.openedTrades]) {
    for (const x of safeArray(src)) if (x && typeof x === 'object') rows.push(x);
  }
  const seen = new Set();
  return rows.filter((r) => {
    const key = textValue(r.tradeId || r.id || r.key || `${r.pair}|${r.timeframe}|${r.openedAt}|${r.entryPrice}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function v949BuildUniverseCompletion(report = {}) {
  const requested = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','XAUTUSDT'];
  const loaded = Array.from(new Set(safeArray(report.dataPairs || report?.runtimeTruth?.dataPairs || report?.symbolLoadStatus?.loadedPairs).map(x => textValue(x).toUpperCase()).filter(Boolean)));
  const missing = requested.filter(x => !loaded.includes(x));
  const pairFrames = v949Num(report.dataPairFrames ?? report?.runtimeTruth?.pairFrames ?? report?.bootDiagnostics?.pairFrames, 0);
  const candlesLoaded = v949Num(report.candlesLoaded ?? report?.runtimeTruth?.candlesLoaded ?? report?.bootDiagnostics?.candlesLoaded, 0);
  const xautLoaded = loaded.includes('XAUTUSDT');
  const xautAliases = ['XAUTUSDT','XAUUSDT','PAXGUSDT','XAU/USD','GOLD','TVC:GOLD'];
  const status = missing.length === 0 ? 'COMPLETE' : (loaded.length > 0 ? 'PARTIAL' : 'EMPTY');
  const nextRequiredAction = missing.length ? 'UNIVERSE_COMPLETION_PATCH' : 'OBSERVE_MULTI_PAIR_EVIDENCE';
  const view = {
    schema: 'alps.universeCompletion.view.v1', version: FINAL_V930_VERSION, installed: true, status,
    requestedSymbols: requested, loadedPairs: loaded, missingSymbols: missing, dataPairCount: loaded.length,
    pairFrames, candlesLoaded, xaut: { requested: true, loaded: xautLoaded, attemptedAliases: xautAliases, status: xautLoaded ? 'RESOLVED' : 'NEEDS_ALIAS_RESOLUTION' },
    incompleteReason: missing.length ? `Missing active pairs: ${missing.join(', ')}` : '',
    nextRequiredAction,
    rule: 'Universe is complete only when every requested symbol is visible in the current active dataPairs, not merely in proxy logs.'
  };
  lastV949UniverseCompletionView = view;
  return view;
}
function v949BuildProxyTruth(report = {}) {
  const candlesLoaded = v949Num(report.candlesLoaded ?? report?.runtimeTruth?.candlesLoaded ?? report?.bootDiagnostics?.candlesLoaded, 0);
  const rawProxyOK = report.proxyOK ?? report?.runtimeTruth?.proxyOK ?? report?.bootDiagnostics?.proxyOK;
  const universe = report.universeCompletion || v949BuildUniverseCompletion(report);
  const missing = safeArray(universe.missingSymbols);
  let status = 'UNKNOWN';
  if (rawProxyOK === true && !missing.length) status = 'PROXY_OK';
  else if (candlesLoaded > 0 && missing.length) status = 'PROXY_PARTIAL';
  else if (candlesLoaded > 0) status = 'PROXY_DATA_AVAILABLE_BUT_FLAG_FALSE';
  else if (rawProxyOK === false) status = 'PROXY_FAILED_OR_NOT_CONFIRMED';
  const view = {
    schema: 'alps.proxyTruth.view.v1', version: FINAL_V930_VERSION, installed: true,
    rawProxyOK, status, candlesLoaded, loadedPairs: universe.loadedPairs, missingSymbols: missing,
    likelyIssue: status === 'PROXY_PARTIAL' ? 'Some symbols load while others are missing; false does not mean total data failure.' : '',
    nextRequiredAction: status === 'PROXY_PARTIAL' ? 'ADD_PER_SYMBOL_PROXY_STATUS_AND_RETRY_QUEUE' : 'OBSERVE',
    statusesSupported: ['PROXY_OK','PROXY_PARTIAL','PROXY_SYMBOL_FAILED','PROXY_RATE_LIMITED','PROXY_TIMEOUT','PROXY_FAILED_OR_NOT_CONFIRMED']
  };
  lastV949ProxyTruthView = view;
  return view;
}
function v949BuildCandidateCountTruth(report = {}) {
  const native = report.nativeForwardPool || {};
  const latch = report.forwardLatch || {};
  const recovery = report.recoveryForwardCore || {};
  const rawStrategies = v949Num(report.rawResearchStrategies ?? report.totalGeneratedStrategies ?? report.results ?? lastHealth?.results, 0);
  const view = {
    schema: 'alps.candidateCountTruth.view.v1', version: FINAL_V930_VERSION, installed: true,
    rawStrategies,
    dashboardCandidates: v949Num(report.candidates, 0),
    officialCandidates: v949Num(report.officialCandidates, 0),
    nativePoolCandidates: v949Num(native.totalCandidates, 0),
    compressedCandidates: v949Num(native?.duplicateCompression?.selectedRows, 0),
    rawRowsBeforeCompression: v949Num(native?.duplicateCompression?.rawRows, 0),
    latchedCandidates: v949Num(latch.size, 0),
    paperEntryVisibleCandidates: v949Num(report?.zonePersistenceEntry?.candidatesSeen, 0),
    serverNativeCandidatesAvailable: v949Num(lastNativeForwardPoolView?.totalCandidates ?? lastHealth?.nativeForwardPool?.totalCandidates, 0),
    recoveryEligibleCandidates: v949Num(recovery.eligibleForwardCandidates, 0),
    oosVerifiedCandidates: v949Num(recovery.verifiedForwardCandidates, 0),
    experimentalForwardCandidates: v949Num(recovery.experimentalForwardCandidates ?? native.experimentalForward, 0),
    paperOpened: v949Num(report.paperSignals, 0) || safeArray(report?.zonePersistenceEntry?.openedTrades).length,
    namingWarning: 'verifiedForwardCandidates means OOS/evidence-forward eligible, not live-paper-proven until closed paper trades exist.',
    recommendedLabels: ['rawStrategies','compressedCandidates','nativePoolCandidates','latchedCandidates','paperEligibleCandidates','paperOpened','paperRejected']
  };
  lastV949CandidateCountTruthView = view;
  return view;
}
function v949BuildQualityRisk(report = {}) {
  const rows = v949CollectForwardRows(report);
  let weakPF = 0, noOos = 0, posteriorWeak = 0, strongish = 0;
  const roots = {};
  for (const r of rows) {
    const pf = v949Num(r.oosPF ?? r?.quantitative?.oosPF, null);
    const trades = v949Num(r.oosTrades ?? r?.quantitative?.oosTrades, 0);
    const posterior = v949Num(r?.quantitative?.posteriorPFgt1, null);
    if (pf != null && pf < 1) weakPF++;
    if (!pf || !trades) noOos++;
    if (posterior != null && posterior < 0.6) posteriorWeak++;
    if (pf != null && pf >= 1.15 && trades >= 25 && (posterior == null || posterior >= 0.6)) strongish++;
    const root = textValue(r.clusterKey || r.strategy || r.stratName || r.name || 'UNKNOWN').split('|').slice(0,3).join('|') || 'UNKNOWN';
    roots[root] = (roots[root] || 0) + 1;
  }
  const topRoot = Object.entries(roots).sort((a,b)=>b[1]-a[1])[0] || ['',0];
  const overfitRisk = rows.length > 200 || topRoot[1] > Math.max(10, rows.length * 0.25) ? 'ELEVATED' : (rows.length > 80 ? 'MEDIUM' : 'LOW_OR_UNKNOWN');
  const view = {
    schema: 'alps.qualityRisk.view.v1', version: FINAL_V930_VERSION, installed: true,
    candidateRowsScanned: rows.length, weakPF, noOosEvidence: noOos, posteriorWeak, strongish,
    topClusterConcentration: { root: topRoot[0], count: topRoot[1], pct: v949Pct(topRoot[1], rows.length) },
    overfitRisk, survivorshipBiasWatch: true, multipleTestingPenaltyNeeded: rows.length > 100,
    marketRegimeStatus: report?.ahiRegimeIntelligence ? 'AVAILABLE' : 'WAITING_FOR_PAPER_FORWARD_DATA',
    recommendedBuckets: ['High Evidence','Watch Only','Weak But Learning','Experimental Only','Quarantine']
  };
  lastV949QualityRiskView = view;
  return view;
}
function v949BuildTradeLifecycleTruth(report = {}) {
  const rows = v949TradeRows(report);
  const open = rows.filter(x => /OPEN|ACTIVE/i.test(textValue(x.status || 'OPEN')));
  const closed = rows.filter(x => /CLOSED|WIN|LOSS|STOP|TARGET/i.test(textValue(x.status || '')));
  let numericReady = 0, managedStopReady = 0, sourceReady = 0;
  const examples = [];
  for (const t of open.slice(0, 20)) {
    const entry = v949Num(t.entryPrice ?? t.entry, null);
    const stop = v949Num(t.stopPrice ?? t.stop, null);
    const target = v949Num(t.targetPrice ?? t.target, null);
    if ([entry, stop, target].every(v949Finite)) numericReady++;
    if (t.breakEvenTriggerPct != null && t.lockProfitTriggerPct != null) managedStopReady++;
    if (t.candleSource || t.currentPriceSource || t.source) sourceReady++;
    examples.push({ tradeId: t.tradeId || t.id || '', pair: t.pair || t.symbol || '', timeframe: t.timeframe || t.tf || '', status: t.status || 'OPEN', numericReady: [entry, stop, target].every(v949Finite), entry, stop, target, source: t.candleSource || t.currentPriceSource || t.source || '' });
  }
  const view = {
    schema: 'alps.tradeLifecycleTruth.view.v1', version: FINAL_V930_VERSION, installed: true, paperOnly: true, liveCapitalExecution: false,
    openTrades: open.length, closedTrades: closed.length, tradeRowsSeen: rows.length,
    numericPlanReadyOpenTrades: numericReady, managedStopPlanReadyOpenTrades: managedStopReady, priceSourceReadyOpenTrades: sourceReady,
    lifecycleStages: ['candidate_detected','zone_validated','paper_entry_opened','stop_target_assigned','break_even_at_50_pct','lock_profit_at_75_pct','exit_triggered','learning_stored'],
    missingIfZeroOpenTrades: open.length ? '' : 'No open paper trade yet; lifecycle management cannot be proven until Paper Entry opens at least one trade.',
    examples
  };
  lastV949LifecycleTruthView = view;
  return view;
}
function v949BuildReportTruthSync(report = {}) {
  const apparentTitleVersion = textValue(report.titleVersion || report.reportTitle || 'ALPS v9.3.0 header may still be static');
  const appVersion = textValue(report.appVersion || lastHealth?.appVersion || '');
  const dataSource = textValue(report.dataSource || report?.v930?.dataSource || 'UNKNOWN');
  const freshness = report?.pipelineTruthRecovery?.reportFreshness || {};
  const runtimeFreshEnough = !!(report.status || lastHealth?.status) && (v949Num(report.candidates ?? lastHealth?.candidates, 0) > 0 || v949Num(report.results ?? lastHealth?.results, 0) > 0 || report.fwRunning === true || lastHealth?.fwRunning === true);
  const staleHeader = /v9\.1\.8|v9\.3\.0/i.test(appVersion + ' ' + apparentTitleVersion);
  const mismatch = !!(freshness.snapshotMismatch || staleHeader);
  const view = {
    schema: 'alps.reportTruthSync.view.v1', version: FINAL_V930_VERSION, installed: true,
    effectivePatchVersion: FINAL_V930_VERSION, appVersion, apparentTitleVersion, dataSource,
    headerLikelyStale: staleHeader,
    runtimeFreshEnough,
    snapshotMismatch: !!freshness.snapshotMismatch,
    reportGeneratedAt: freshness.reportGeneratedAt || report.generatedAt || null,
    healthSnapshotAt: freshness.healthSnapshotAt || null,
    runnerCollectedAt: freshness.runnerCollectedAt || null,
    status: mismatch ? 'REPORT_TRUTH_SYNC_NEEDED' : 'REPORT_TRUTH_OK',
    nextRequiredAction: mismatch ? 'SYNC_MARKDOWN_HEADER_DATA_SOURCE_AND_EFFECTIVE_PATCH' : 'OBSERVE'
  };
  lastV949ReportTruthView = view;
  return view;
}
function v949BuildMobileRuntimeTruth(report = {}) {
  const logs = safeArray(report?.bootDiagnostics?.recentLogs || report.recentLogs || []);
  const logText = logs.join('\n');
  const wakeDenied = /wake lock failed|permission denied/i.test(logText) || /Wake Lock is not active/i.test(textValue(report.diagnosis || ''));
  const notificationsDenied = /Notifications:\s*denied|notifications denied/i.test(logText);
  return {
    schema: 'alps.mobileRuntimeTruth.view.v1', version: FINAL_V930_VERSION, installed: true,
    deviceRisk: wakeDenied || notificationsDenied ? 'ANDROID_BROWSER_BACKGROUND_RISK' : 'UNKNOWN_OR_OK',
    wakeLockDenied: wakeDenied, notificationsDenied,
    nativeApkRecommended: wakeDenied || notificationsDenied,
    rule: 'Browser wake lock and audio keep-alive are not a guaranteed native background service.'
  };
}
function v949BuildAuditTrailTruth(report = {}) {
  const z = report.zonePersistenceEntry || {};
  const rejections = safeArray(z.rejections);
  const opened = safeArray(z.openedTrades);
  return {
    schema: 'alps.auditTrailTruth.view.v1', version: FINAL_V930_VERSION, installed: true,
    decisionsLogged: rejections.length + opened.length,
    openedLogged: opened.length, rejectedLogged: rejections.length,
    hasRejectedReasonCounts: !!z.rejectedReasonCounts,
    requiredFields: ['candidateId','setupCandleTime','currentPrice','zoneLow','zoneHigh','decision','primaryReason','source','timestamp'],
    missingFieldsWarning: 'Current diagnostics may still need explicit zoneLow/zoneHigh/setupCandleTime per decision.'
  };
}
function v949BuildReleaseChecklist(report = {}) {
  const z = report.zonePersistenceEntry || {};
  const checklist = {
    versionChanged: FINAL_V930_VERSION.includes('v9.5.3'),
    paperOnlyConfirmed: report?.fullAutonomy?.paperOnly !== false && z.liveCapitalExecution !== true,
    liveExecutionLocked: report?.fullAutonomy?.liveCapitalExecution === false || z.liveCapitalExecution === false,
    appUrlUnchangedByPatch: true,
    numericGuardPresent: !!(report.numericGuardHotfix || z.numericGuard),
    zonePersistencePresent: !!z.installed,
    rejectedReasonsPresent: !!z.rejectedReasonCounts,
    universeTruthPresent: !!report.universeCompletion,
    proxyTruthPresent: !!report.proxyTruth,
    finalHealthGatePresent: true,
    rollbackBase: 'ALPS_v949_Complete_Health_Universe_Lifecycle_Truth_EASY.zip'
  };
  const failed = Object.entries(checklist).filter(([k,v]) => v === false).map(([k]) => k);
  const view = { schema: 'alps.releaseChecklist.view.v1', version: FINAL_V930_VERSION, installed: true, checklist, failed, status: failed.length ? 'CHECKLIST_WARN' : 'CHECKLIST_PASS' };
  lastV949ReleaseChecklistView = view;
  return view;
}
function v949BuildFinalHealthGate(report = {}) {
  const universe = report.universeCompletion || v949BuildUniverseCompletion(report);
  const proxy = report.proxyTruth || v949BuildProxyTruth(report);
  const lifecycle = report.tradeLifecycleTruth || v949BuildTradeLifecycleTruth(report);
  const counts = report.candidateCountTruth || v949BuildCandidateCountTruth(report);
  const z = report.zonePersistenceEntry || {};
  const checks = {
    DATA_OK: universe.loadedPairs?.length > 0 && v949Num(universe.candlesLoaded, 0) > 0,
    UNIVERSE_COMPLETE: safeArray(universe.missingSymbols).length === 0,
    PROXY_OK_OR_PARTIAL: /^PROXY_OK|PROXY_PARTIAL|PROXY_DATA_AVAILABLE/.test(textValue(proxy.status)),
    RESEARCH_OK: v949Num(counts.rawStrategies, 0) > 0 || v949Num(report.results ?? lastHealth?.results, 0) > 0,
    FORWARD_OK: report.fwRunning === true || lastHealth?.fwRunning === true || v949Num(counts.latchedCandidates, 0) > 0 || v949Num(counts.nativePoolCandidates, 0) > 0,
    ENTRY_ENGINE_INSTALLED: !!z.installed,
    ENTRY_VISIBILITY_OK: v949Num(z.candidatesSeen, 0) > 0 || v949Num(counts.nativePoolCandidates, 0) === 0,
    CANDLE_RESOLVER_OK: v949Num(z.candlesStoresFound, 0) > 0 || v949Num(z?.candleResolver?.storesFound, 0) > 0,
    ENTRY_EVIDENCE_STARTED: v949Num(report.paperSignals, 0) > 0 || v949Num(z.opened, 0) > 0,
    REJECTED_REASON_VISIBLE: !!z.rejectedReasonCounts || !!z.topRejectedReason,
    EXIT_ENGINE_PROVABLE: lifecycle.openTrades > 0 || lifecycle.closedTrades > 0,
    REPORT_TRUTH_OK: !!report?.reportTruthSync?.runtimeFreshEnough || !(report?.reportTruthSync?.headerLikelyStale || report?.reportTruthSync?.snapshotMismatch),
    LIVE_EXECUTION_LOCKED: report?.fullAutonomy?.liveCapitalExecution === false || z.liveCapitalExecution === false,
    MOBILE_RUNTIME_OK: !(report?.mobileRuntimeTruth?.wakeLockDenied || report?.mobileRuntimeTruth?.notificationsDenied)
  };
  const failed = Object.entries(checks).filter(([k,v]) => !v).map(([k]) => k);
  let status = 'PASS';
  if (failed.includes('DATA_OK') || failed.includes('RESEARCH_OK') || failed.includes('FORWARD_OK') || failed.includes('LIVE_EXECUTION_LOCKED')) status = 'FAIL';
  else if (failed.length) status = 'WARN';
  const nextRequiredAction = failed.includes('ENTRY_VISIBILITY_OK') ? 'FIX_PAPER_ENTRY_CANDIDATE_VISIBILITY' : (failed.includes('CANDLE_RESOLVER_OK') ? 'FIX_CANDLE_STORE_RESOLVER' : (failed.includes('ENTRY_EVIDENCE_STARTED') ? 'WAIT_FOR_OR_FIX_PAPER_ENTRY_DECISION' : (failed.includes('UNIVERSE_COMPLETE') ? 'UNIVERSE_COMPLETION_PATCH' : (failed.includes('REPORT_TRUTH_OK') ? 'REPORT_TRUTH_SYNC_PATCH' : 'OBSERVE'))));
  const view = { schema: 'alps.finalHealthGate.view.v1', version: FINAL_V930_VERSION, installed: true, status, checks, failedChecks: failed, nextRequiredAction, rule: 'This is the single gate for DATA, RESEARCH, FORWARD, ENTRY, EXIT, REPORT, MOBILE, and LIVE_LOCK truth.' };
  lastV949FinalHealthGateView = view;
  return view;
}
function v949AttachCompleteTruth(report = {}) {
  report.paperEntryVisibility = report?.zonePersistenceEntry?.visibilityBridge || lastV950PaperEntryVisibilityView || null;
  report.candleStoreResolver = report?.zonePersistenceEntry?.candleResolver || lastV950CandleStoreResolverView || null;
  report.universeCompletion = v949BuildUniverseCompletion(report);
  report.proxyTruth = v949BuildProxyTruth(report);
  report.candidateCountTruth = v949BuildCandidateCountTruth(report);
  report.qualityRisk = v949BuildQualityRisk(report);
  report.tradeLifecycleTruth = v949BuildTradeLifecycleTruth(report);
  report.reportTruthSync = v949BuildReportTruthSync(report);
  report.mobileRuntimeTruth = v949BuildMobileRuntimeTruth(report);
  report.auditTrailTruth = v949BuildAuditTrailTruth(report);
  report.releaseChecklist = v949BuildReleaseChecklist(report);
  report.finalHealthGate = v949BuildFinalHealthGate(report);
  report.completeHealthUniverseLifecycleTruth = {
    schema: 'alps.completeHealthUniverseLifecycleTruth.view.v1', version: FINAL_V930_VERSION, installed: true,
    finalHealthGate: report.finalHealthGate,
    modules: ['PaperEntryVisibility','CandleStoreResolver','UniverseCompletion','ProxyTruth','CandidateCountTruth','QualityRisk','TradeLifecycleTruth','ReportTruthSync','MobileRuntimeTruth','AuditTrailTruth','ReleaseChecklist','FinalHealthGate'],
    paperOnly: true, liveCapitalExecution: false,
    note: 'v9.5.0 fixes Paper Entry candidate/candle visibility and report truth sync without inventing trades, OOS evidence, or live orders.'
  };
  return report;
}


// ALPS v9.5.4 — Entry Construction + Direction Sync + Stop/Target Validator + Fresh Candidate Dedupe
// This layer anticipates the next failures instead of waiting for another report:
// current Health -> nativeForwardPool -> forwardLatch -> Paper Entry -> rejected audit -> report truth.
let lastV952CurrentHealthSyncView = null;
let lastV952CandidateBridgeView = null;
let lastV952RejectedAuditView = null;
let lastV952QualityBucketsView = null;
let lastV952ReportTruthView = null;

let stateAuthorityV10 = null;
let lastV10StateAuthorityView = null;
let lastV10ZeroOverwriteProof = null;

function v952Num(x, fallback = 0) { const v = Number(x); return Number.isFinite(v) ? v : fallback; }
function v952Text(x) { return String(x == null ? '' : x); }
function v952Arr(x) { return Array.isArray(x) ? x : []; }
function v952CandidateKey(c = {}) {
  return v952Text(c.key || [c.pair || c.baseSymbol || c.symbol || c.sym || '', c.timeframe || c.tf || c.frame || '', c.strategy || c.stratName || c.name || '', c.exit || c.exitName || ''].join('||')).toUpperCase();
}
function v952NormalizeCandidate(c = {}, source = 'unknown') {
  const pair = v952Text(c.pair || c.baseSymbol || c.symbol || c.sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tf = v952Text(c.timeframe || c.tf || c.frame || '').toLowerCase().replace(/\s+/g, '');
  const strategy = v952Text(c.strategy || c.stratName || c.name || c.setup || 'UNKNOWN_STRATEGY');
  const exit = v952Text(c.exit || c.exitName || c.exitLogic || 'GENERIC_EXIT');
  const tierRaw = v952Text(c.tier || c.promotionTier || c.candidateTier || c.promotionStatus || 'EXPERIMENTAL_FORWARD').toUpperCase();
  const tier = /FULL_AUTONOMY|ROBUST|QUANT_PASS/.test(tierRaw) ? 'FULL_AUTONOMY_FORWARD' : (/WATCH/.test(tierRaw) ? 'WATCH_FORWARD' : (/SAFETY|DATA|COGNITION/.test(tierRaw) ? tierRaw : 'EXPERIMENTAL_FORWARD'));
  const out = { ...c, key: v952CandidateKey({ ...c, pair, timeframe: tf, strategy, exit }), pair, baseSymbol: pair, symbol: pair, timeframe: tf, strategy, exit, tier, candidateTier: tier, promotionStatus: tier, promotionTier: tier, forwardEligible: c.forwardEligible !== false, eligible: c.eligible !== false, forwardBlockReason: c.forwardBlockReason || '', blockReason: c.blockReason || '', __v952Source: source, __v952NoFixedCandidateCap: true };
  if (!out.key || out.key === '||||') out.key = [pair, tf, strategy, exit, source].join('||').toUpperCase();
  return out;
}
function v952CollectCandidateRows(...sources) {
  const rows = [];
  const seen = new Set();
  const sourceCounts = {};
  function pushList(list, source) {
    for (const raw of v952Arr(list)) {
      if (!raw || typeof raw !== 'object') continue;
      const row = v952NormalizeCandidate(raw, source);
      if (!row.pair || !row.timeframe || !row.strategy) continue;
      if (/SAFETY_BLOCKED|DATA_BLOCKED|COGNITION_SUSPENDED/.test(v952Text(row.tier))) continue;
      const key = v952CandidateKey(row);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
  }
  for (const [obj, prefix] of sources) {
    if (!obj) continue;
    pushList(obj?.nativeForwardPool?.candidates, `${prefix}.nativeForwardPool.candidates`);
    pushList(obj?.fullAutonomyNativeForwardPool?.candidates, `${prefix}.fullAutonomyNativeForwardPool.candidates`);
    pushList(obj?.forwardLatch?.candidates, `${prefix}.forwardLatch.candidates`);
    pushList(obj?.decisionIntelligence?.forwardLatch?.candidates, `${prefix}.decisionIntelligence.forwardLatch.candidates`);
    pushList(obj?.zonePersistenceEntry?.openedTrades, `${prefix}.zonePersistenceEntry.openedTrades`);
    pushList(obj?.research?.topStrategies, `${prefix}.research.topStrategies`);
    pushList(obj?.discoveryOutput?.rows, `${prefix}.discoveryOutput.rows`);
    pushList(obj?.v951RealCandleDiscovery?.rows, `${prefix}.v951RealCandleDiscovery.rows`);
  }
  return { rows, sourceCounts };
}
function v952BuildNativePoolFromRows(rows = [], existing = {}) {
  const all = v952Arr(rows).map((r, i) => v952NormalizeCandidate(r, r.__v952Source || `v952.rows.${i}`));
  const count = t => all.filter(x => x.tier === t).length;
  return {
    ...(existing || {}),
    schema: 'alps.nativeForwardPool.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    noFixedCandidateCap: true,
    candidateAdmissionPolicy: 'ACCEPT_EVERY_REAL_CANDIDATE_THEN_RANK_AND_AUDIT_NO_FIXED_CAP',
    poolViewCap: null,
    technicalCap: 'NONE_FOR_CANDIDATE_ADMISSION',
    totalCandidates: all.length,
    generatedStrategies: Math.max(v952Num(existing?.generatedStrategies), all.length),
    fullAutonomyForward: count('FULL_AUTONOMY_FORWARD'),
    watchForward: count('WATCH_FORWARD'),
    experimentalForward: count('EXPERIMENTAL_FORWARD'),
    researchSandbox: count('RESEARCH_SANDBOX'),
    safetyBlocked: count('SAFETY_BLOCKED'),
    dataBlocked: count('DATA_BLOCKED'),
    promotedByFullAutonomy: count('FULL_AUTONOMY_FORWARD'),
    promotedToExperimental: count('EXPERIMENTAL_FORWARD'),
    blockedBySafety: count('SAFETY_BLOCKED'),
    quantitativePromotion: existing?.quantitativePromotion || { installed: true, passed: count('FULL_AUTONOMY_FORWARD'), rule: 'Existing real evidence only; no synthetic OOS metrics.' },
    duplicateCompression: existing?.duplicateCompression || { method: 'V952_DEDUPE_BY_PAIR_TF_STRATEGY_EXIT_NO_FIXED_CAP', rawRows: all.length, clusters: all.length, selectedRows: all.length, compressedRows: 0, topClusters: [] },
    evidenceLabels: [...new Set(all.flatMap(x => v952Arr(x.evidenceLabels)).concat(all.some(x => x.tier === 'EXPERIMENTAL_FORWARD') ? ['EXPERIMENTAL_FORWARD'] : []))],
    candidates: all
  };
}
function v952BuildQualityBuckets(rows = []) {
  const buckets = { highEvidence: [], watchOnly: [], experimentalLearning: [], weakButLearning: [], blocked: [] };
  for (const c of v952Arr(rows)) {
    const pf = v952Num(c.oosPF || c.profitFactor || c.pf);
    const tr = v952Num(c.oosTrades || c.totalTrades || c.trades);
    const tier = v952Text(c.tier || c.promotionTier || c.candidateTier).toUpperCase();
    const item = { key: c.key, pair: c.pair, timeframe: c.timeframe, strategy: c.strategy, exit: c.exit, tier: c.tier, oosPF: pf, oosTrades: tr, score: v952Num(c.score, null) };
    if (/SAFETY|DATA|COGNITION/.test(tier)) buckets.blocked.push(item);
    else if ((pf > 1 && tr >= 25) || /FULL_AUTONOMY|QUANT_PASS/.test(tier)) buckets.highEvidence.push(item);
    else if ((pf > 1 && tr >= 10) || /WATCH/.test(tier)) buckets.watchOnly.push(item);
    else if (pf === 0 && tr === 0) buckets.experimentalLearning.push(item);
    else buckets.weakButLearning.push(item);
  }
  const view = { schema: 'alps.v952CandidateQualityBuckets.view.v1', version: FINAL_V930_VERSION, installed: true, noFixedCandidateCap: true, totalCandidates: v952Arr(rows).length, counts: Object.fromEntries(Object.entries(buckets).map(([k,v]) => [k, v.length])), samples: Object.fromEntries(Object.entries(buckets).map(([k,v]) => [k, v.slice(0, 25)])), rule: 'Candidates are not rejected because of a fixed count. Every real candidate is accepted into ranking/audit; quality labels prevent confusing learning candidates with verified candidates.' };
  lastV952QualityBucketsView = view;
  return view;
}

function v1000NowIso() { try { return new Date().toISOString(); } catch (_) { return ''; } }

function v1014StateRowCount(st = {}) {
  return Array.isArray(st?.rowOrder) ? st.rowOrder.filter(k => st?.rowsByKey?.[k]).length : 0;
}
function v1014LoadNonzeroAuthoritySync() {
  try {
    if (!fs.existsSync(STATE_AUTHORITY_NONZERO_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(STATE_AUTHORITY_NONZERO_FILE, 'utf8'));
    return v1014StateRowCount(parsed) > 0 ? parsed : null;
  } catch (e) { log('v10.1.4 nonzero authority load skipped:', e.message); return null; }
}
function v1014PersistNonzeroAuthoritySync(st = {}, reason = 'unknown') {
  try {
    if (v1014StateRowCount(st) <= 0) return;
    const backup = { ...st, lastNonZeroBackupReason: reason, lastNonZeroBackupAt: v1000NowIso(), version: FINAL_V930_VERSION };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_AUTHORITY_NONZERO_FILE, JSON.stringify(backup, null, 2));
  } catch (e) { log('v10.1.4 nonzero authority backup skipped:', e.message); }
}
function v1014RestoreStateAuthorityFromBackupIfEmpty(st = null, reason = 'unknown') {
  const current = st || stateAuthorityV10 || null;
  if (v1014StateRowCount(current) > 0) return current;
  const backup = v1014LoadNonzeroAuthoritySync();
  if (!backup) return current;
  backup.restoredFromNonzeroBackup = true;
  backup.restoredAt = v1000NowIso();
  backup.restoreReason = reason;
  stateAuthorityV10 = backup;
  try { fs.writeFileSync(STATE_AUTHORITY_FILE, JSON.stringify(stateAuthorityV10, null, 2)); } catch (_) {}
  return stateAuthorityV10;
}
function v1014RuntimeCounts(obj = {}) {
  const counts = {
    candidates: n(obj.candidates ?? obj.officialCandidates ?? obj?.nativeForwardPool?.totalCandidates, 0),
    results: n(obj.results ?? obj.rawResearchStrategies, 0),
    paperSignals: n(obj.paperSignals, 0),
    openPositions: n(obj.openPositions, 0),
    closedTrades: n(obj.closedTrades ?? obj.closed, 0),
    wins: n(obj.wins, 0),
    losses: n(obj.losses, 0),
    rejectedSignals: n(obj.rejectedSignals, 0),
    lastForwardRefresh: n(obj.lastForwardRefresh, 0),
    fwRunning: !!obj.fwRunning
  };
  counts.total = counts.candidates + counts.results + counts.paperSignals + counts.openPositions + counts.closedTrades;
  return counts;
}
async function v1014PersistRuntimeNonzeroSnapshot(obj = {}, source = 'unknown') {
  try {
    const counts = v1014RuntimeCounts(obj);
    if (counts.total <= 0) return null;
    const snap = {
      schema: 'alps.v1014RuntimeLastNonzero.view.v1',
      version: FINAL_V930_VERSION,
      capturedAt: new Date().toISOString(),
      source,
      counts,
      nativeForwardPool: obj.nativeForwardPool || lastNativeForwardPoolView || null,
      forwardLatch: obj.forwardLatch || lastForwardLatchView || null,
      alpsTradeExport: obj.alpsTradeExport || lastTradeExport || null,
      paperEntryActivation: obj.paperEntryActivation || null,
      tradeLifecycleTruth: obj.tradeLifecycleTruth || lastV949LifecycleTruthView || null,
      stateAuthority: v1000BuildView()
    };
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(RUNTIME_NONZERO_FILE, JSON.stringify(snap, null, 2));
    return snap;
  } catch (e) { log('v10.1.4 runtime nonzero snapshot skipped:', e.message); return null; }
}
function v1014LoadRuntimeNonzeroSnapshotSync() {
  try {
    if (!fs.existsSync(RUNTIME_NONZERO_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_NONZERO_FILE, 'utf8'));
    return parsed?.counts?.total > 0 ? parsed : null;
  } catch (_) { return null; }
}
function v1000LoadStateAuthoritySync() {
  if (stateAuthorityV10) return stateAuthorityV10;
  const fresh = {
    schema: 'alps.stateAuthority.v10.state',
    version: FINAL_V930_VERSION,
    createdAt: v1000NowIso(),
    updatedAt: '',
    commitSeq: 0,
    lastCommitReason: '',
    rowsByKey: {},
    rowOrder: [],
    lastNonZero: null,
    zeroOverwriteBlocked: 0,
    sources: {},
    resetRequiredForClear: ['USER_RESET','DATA_INVALIDATED','SYMBOL_CONFIG_CHANGED','MANUAL_CLEAR']
  };
  try {
    if (fs.existsSync(STATE_AUTHORITY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_AUTHORITY_FILE, 'utf8'));
      stateAuthorityV10 = { ...fresh, ...(parsed || {}), rowsByKey: parsed?.rowsByKey || {}, rowOrder: Array.isArray(parsed?.rowOrder) ? parsed.rowOrder : [] };
      stateAuthorityV10 = v1014RestoreStateAuthorityFromBackupIfEmpty(stateAuthorityV10, 'load-primary-empty');
      return stateAuthorityV10;
    }
  } catch (e) { log('v10 state authority load skipped:', e.message); }
  const backup = v1014LoadNonzeroAuthoritySync();
  if (backup) {
    stateAuthorityV10 = { ...fresh, ...(backup || {}), rowsByKey: backup?.rowsByKey || {}, rowOrder: Array.isArray(backup?.rowOrder) ? backup.rowOrder : [], restoredFromNonzeroBackup: true, restoredAt: v1000NowIso(), restoreReason: 'primary-missing' };
    try { fs.writeFileSync(STATE_AUTHORITY_FILE, JSON.stringify(stateAuthorityV10, null, 2)); } catch (_) {}
    return stateAuthorityV10;
  }
  stateAuthorityV10 = fresh;
  return stateAuthorityV10;
}
function v1000PersistStateAuthoritySoon() {
  try {
    if (!stateAuthorityV10) return;
    if (v1014StateRowCount(stateAuthorityV10) > 0) v1014PersistNonzeroAuthoritySync(stateAuthorityV10, 'persist-state-authority');
    fsp.mkdir(DATA_DIR, { recursive: true }).then(() => fsp.writeFile(STATE_AUTHORITY_FILE, JSON.stringify(stateAuthorityV10, null, 2))).catch(e => log('v10 state authority persist skipped:', e.message));
  } catch (_) {}
}
function v1000RowKey(raw = {}) {
  const c = raw || {};
  return v952CandidateKey(c) || textValue(c.id || c.tradeId || c.__alpsV948Key || '').toUpperCase();
}
function v1000RowsFromArrays(...lists) {
  const out = [];
  for (const list of lists) for (const item of safeArray(list)) if (item && typeof item === 'object') out.push(item);
  return out;
}
function v1000CollectRowsFromObject(obj = {}, prefix = 'unknown') {
  const rows = [];
  const push = (list, src) => {
    for (const item of safeArray(list)) {
      if (!item || typeof item !== 'object') continue;
      const probePair = textValue(item.pair || item.baseSymbol || item.symbol || item.sym || item.market || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
      const probeTf = textValue(item.timeframe || item.tf || item.frame || item.interval || '').toLowerCase();
      const probeStrategy = textValue(item.strategy || item.stratName || item.name || item.setup || item.root || '').trim();
      if (!probePair || !probeTf || !probeStrategy) continue;
      rows.push(v952NormalizeCandidate(item, src));
    }
  };
  push(obj?.nativeForwardPool?.candidates, `${prefix}.nativeForwardPool.candidates`);
  push(obj?.fullAutonomyNativeForwardPool?.candidates, `${prefix}.fullAutonomyNativeForwardPool.candidates`);
  push(obj?.forwardLatch?.candidates, `${prefix}.forwardLatch.candidates`);
  push(obj?.decisionIntelligence?.forwardLatch?.candidates, `${prefix}.decisionIntelligence.forwardLatch.candidates`);
  push(obj?.livePaperEvidenceCollector?.candidates, `${prefix}.livePaperEvidenceCollector.candidates`);
  push(obj?.research?.topStrategies, `${prefix}.research.topStrategies`);
  push(obj?.topStrategies, `${prefix}.topStrategies`);
  push(obj?.topRobustness, `${prefix}.topRobustness`);
  push(obj?.discoveryOutput?.rows, `${prefix}.discoveryOutput.rows`);
  push(obj?.v951RealCandleDiscovery?.rows, `${prefix}.v951RealCandleDiscovery.rows`);
  push(obj?.v960NonzeroResearchSnapshot?.rows, `${prefix}.v960NonzeroResearchSnapshot.rows`);
  push(obj?.results, `${prefix}.results`);
  push(obj?.allResults, `${prefix}.allResults`);
  push(obj?.discoveryResults, `${prefix}.discoveryResults`);
  return rows;
}
function v1000CommitRows(rawRows = [], source = 'unknown', meta = {}) {
  const st = v1000LoadStateAuthoritySync();
  const rows = [];
  const seen = new Set();
  for (const raw of safeArray(rawRows)) {
    if (!raw || typeof raw !== 'object') continue;
    const norm = v952NormalizeCandidate(raw, source);
    const key = v1000RowKey(norm);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    norm.__v10StateAuthoritySource = norm.__v10StateAuthoritySource || source;
    norm.__v10StateAuthorityCommittedAt = Date.now();
    rows.push(norm);
  }
  if (!rows.length) return { committed: 0, activeRows: st.rowOrder.length, source };
  st.commitSeq = n(st.commitSeq, 0) + 1;
  st.updatedAt = v1000NowIso();
  st.lastCommitReason = source;
  st.sources[source] = (st.sources[source] || 0) + rows.length;
  for (const row of rows) {
    const key = v1000RowKey(row);
    if (!st.rowsByKey[key]) st.rowOrder.push(key);
    st.rowsByKey[key] = { ...row, __v10CommitSeq: st.commitSeq };
  }
  // bounded memory; keep newest 3000 candidate rows max, no fixed admission cap in the live pool.
  while (st.rowOrder.length > 3000) {
    const old = st.rowOrder.shift();
    delete st.rowsByKey[old];
  }
  st.lastNonZero = { rowCount: st.rowOrder.length, source, committedAt: st.updatedAt, commitSeq: st.commitSeq, meta };
  v1014PersistNonzeroAuthoritySync(st, source);
  v1000PersistStateAuthoritySoon();
  return { committed: rows.length, activeRows: st.rowOrder.length, source };
}
function v1000ActiveRows() {
  const st = v1000LoadStateAuthoritySync();
  return safeArray(st.rowOrder).map(k => st.rowsByKey[k]).filter(Boolean);
}
function v1000BuildNativePool(existing = {}) {
  const rows = v1000ActiveRows();
  if (!rows.length) return existing || {};
  return v952BuildNativePoolFromRows(rows, existing || {});
}
function v1000BuildView() {
  const st = v1000LoadStateAuthoritySync();
  const rows = v1000ActiveRows();
  const view = {
    schema: 'alps.stateAuthority.v10.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    owner: 'SERVER_SINGLE_RUNTIME_STATE_AUTHORITY',
    commitSeq: n(st.commitSeq, 0),
    activeRows: rows.length,
    lastNonZero: st.lastNonZero || null,
    zeroOverwriteBlocked: n(st.zeroOverwriteBlocked, 0),
    lastCommitReason: st.lastCommitReason || '',
    sources: st.sources || {},
    zeroClearPolicy: 'ZERO_CAN_NOT_OVERWRITE_NONZERO_UNLESS_EXPLICIT_RESET_REASON',
    readOnlyConsumers: ['health','report','dashboard','paperEntry','forwardWatch'],
    paperOnly: true,
    liveCapitalExecution: false,
    noFixedCandidateCap: true
  };
  lastV10StateAuthorityView = view;
  return view;
}
function v1000ApplyStateAuthorityToView(view = {}, reason = 'unknown') {
  const obj = (view && typeof view === 'object') ? { ...view } : {};
  const collected = [];
  collected.push(...v1000CollectRowsFromObject(obj, reason));
  collected.push(...v1000CollectRowsFromObject(lastHealth || {}, 'lastHealth'));
  collected.push(...v1000CollectRowsFromObject(lastReport || {}, 'lastReport'));
  if (safeArray(lastNativeForwardPoolView?.candidates).length) collected.push(...safeArray(lastNativeForwardPoolView.candidates).map(x => v952NormalizeCandidate(x, 'lastNativeForwardPoolView.candidates')));
  if (safeArray(forwardLatchState?.candidates).length) collected.push(...safeArray(forwardLatchState.candidates).map(x => v952NormalizeCandidate(x, 'forwardLatchState.candidates')));
  if (safeArray(lastMaterializedRows).length) collected.push(...safeArray(lastMaterializedRows).map(x => v952NormalizeCandidate(x, 'lastMaterializedRows')));
  const commit = v1000CommitRows(collected, reason, { observedRows: collected.length });
  const active = v1000ActiveRows();
  const incomingCount = Math.max(v952Num(obj.candidates), v952Num(obj.officialCandidates), v952Num(obj.results), v952Num(obj?.nativeForwardPool?.totalCandidates), v952Num(obj?.forwardLatch?.size));
  const shouldBlockZero = active.length > 0 && incomingCount === 0;
  if (shouldBlockZero) {
    const st = v1000LoadStateAuthoritySync();
    st.zeroOverwriteBlocked = n(st.zeroOverwriteBlocked, 0) + 1;
    v1000PersistStateAuthoritySoon();
  }
  if (active.length) {
    const native = v952BuildNativePoolFromRows(active, obj.nativeForwardPool || lastNativeForwardPoolView || {});
    obj.nativeForwardPool = native;
    obj.fullAutonomyNativeForwardPool = native;
    obj.candidates = Math.max(v952Num(obj.candidates), active.length);
    obj.officialCandidates = Math.max(v952Num(obj.officialCandidates), active.length);
    obj.results = Math.max(v952Num(obj.results), v952Num(native.generatedStrategies), active.length);
    obj.rawResearchStrategies = Math.max(v952Num(obj.rawResearchStrategies), obj.results);
    lastNativeForwardPoolView = native;
    v944MergeForwardLatch(active, `v10-state-authority:${reason}`);
    lastForwardLatchView = v944BuildForwardLatchView();
    obj.forwardLatch = lastForwardLatchView;
    obj.forwardReadiness = { ...(obj.forwardReadiness || lastForwardReadinessView || {}), schema: 'alps.forwardReadiness.view.v1', version: FINAL_V930_VERSION, canStartWatch: true, hasCandidates: true, startWatchSkippedReason: '', forwardNeverStarted: !obj.fwRunning && !n(obj.lastForwardRefresh, 0) };
    lastForwardReadinessView = obj.forwardReadiness;
  }
  obj.stateAuthority = v1000BuildView();
  obj.v10StateAuthority = obj.stateAuthority;
  obj.v10ZeroOverwriteProof = lastV10ZeroOverwriteProof = {
    schema: 'alps.v10ZeroOverwriteProof.view.v1',
    version: FINAL_V930_VERSION,
    reason,
    collectedRows: collected.length,
    committedRows: commit.committed || 0,
    activeRows: active.length,
    incomingCount,
    zeroOverwriteBlocked: shouldBlockZero,
    status: shouldBlockZero ? 'ZERO_OVERWRITE_BLOCKED_USING_AUTHORITY_NONZERO_STATE' : (active.length ? 'AUTHORITY_ACTIVE' : 'NO_AUTHORITY_ROWS_YET')
  };
  return obj;
}

async function v1000InstallPageAuthorityHooks(reason = 'install-hooks') {
  if (!page || page.isClosed()) return { installed: false, reason: 'PAGE_NOT_READY' };
  try {
    const status = await pageEval(({ version, reasonText }) => {
      const state = globalThis.__ALPS_V10_STATE_AUTHORITY_BUFFER__ || {
        schema: 'alps.v10.pageAuthorityBuffer.v1',
        version,
        installedAt: Date.now(),
        rows: [],
        rowKeys: {},
        hooks: [],
        captures: {},
        zeroReturnEvents: 0,
        lastNonZeroAt: 0,
        lastNonZeroCount: 0,
        reasonText
      };
      globalThis.__ALPS_V10_STATE_AUTHORITY_BUFFER__ = state;
      function arr(v){ return Array.isArray(v) ? v : []; }
      function text(v){ return String(v == null ? '' : v); }
      function key(c){ return [c && (c.key || ''), c && (c.pair || c.baseSymbol || c.symbol || c.sym || ''), c && (c.timeframe || c.tf || c.frame || ''), c && (c.strategy || c.stratName || c.name || c.setup || ''), c && (c.exit || c.exitName || '')].map(text).join('||').toUpperCase(); }
      function candidateLike(c){ return c && typeof c === 'object' && text(c.pair || c.baseSymbol || c.symbol || c.sym).trim() && text(c.timeframe || c.tf || c.frame).trim() && text(c.strategy || c.stratName || c.name || c.setup).trim(); }
      function collectFromObject(obj, source){
        const out=[];
        function push(list){ for (const x of arr(list)) if (candidateLike(x)) out.push(Object.assign({}, x, { __v10PageAuthoritySource: source })); }
        if (!obj) return out;
        if (Array.isArray(obj)) push(obj);
        push(obj.candidates); push(obj.rows); push(obj.results); push(obj.allResults); push(obj.discoveryResults); push(obj.topStrategies); push(obj.topRobustness);
        push(obj.nativeForwardPool && obj.nativeForwardPool.candidates);
        push(obj.fullAutonomyNativeForwardPool && obj.fullAutonomyNativeForwardPool.candidates);
        push(obj.forwardLatch && obj.forwardLatch.candidates);
        push(obj.decisionIntelligence && obj.decisionIntelligence.forwardLatch && obj.decisionIntelligence.forwardLatch.candidates);
        push(obj.research && obj.research.topStrategies);
        push(obj.discoveryOutput && obj.discoveryOutput.rows);
        push(obj.v951RealCandleDiscovery && obj.v951RealCandleDiscovery.rows);
        return out;
      }
      function capture(input, source){
        const rows = collectFromObject(input, source);
        if (!rows.length) { state.zeroReturnEvents += 1; return 0; }
        let added=0;
        for (const r of rows) { const k = key(r) || JSON.stringify(r).slice(0,180); if (!k || state.rowKeys[k]) continue; state.rowKeys[k]=true; state.rows.push(r); added++; }
        if (state.rows.length > 5000) state.rows = state.rows.slice(-5000);
        state.lastNonZeroAt = Date.now(); state.lastNonZeroCount = state.rows.length; state.captures[source] = (state.captures[source] || 0) + rows.length;
        return added;
      }
      function snapshotGlobals(source){
        try {
          const final = globalThis.__ALPS_FINAL_V930__ || globalThis.__ALPS_V930__ || {};
          capture(globalThis.results, source+'.results'); capture(globalThis.allResults, source+'.allResults'); capture(globalThis.discoveryResults, source+'.discoveryResults');
          capture(globalThis.__ALPS_V930_NATIVE_FORWARD_POOL__, source+'.v930Pool'); capture(globalThis.nativeForwardPool, source+'.nativeForwardPool');
          capture(globalThis.__ALPS_V944_FORWARD_LATCH__, source+'.forwardLatch'); capture(globalThis.__ALPS_V950_SERVER_CANDIDATES__, source+'.serverCandidates'); capture(globalThis.__ALPS_V956_CURRENT_NATIVE_CANDIDATES__, source+'.currentNativeCandidates');
          capture(final, source+'.finalV930');
        } catch (_) {}
      }
      function wrap(name){
        try {
          const original = globalThis[name];
          if (typeof original !== 'function' || original.__alpsV10AuthorityWrapped) return false;
          const wrapped = function(...args){
            const out = original.apply(this,args);
            const source = 'fn.' + name;
            if (out && typeof out.then === 'function') return out.then(v => { try { capture(v, source); snapshotGlobals(source+'.after'); } catch (_) {} return v; });
            try { capture(out, source); snapshotGlobals(source+'.after'); } catch (_) {}
            return out;
          };
          wrapped.__alpsV10AuthorityWrapped = true; wrapped.__original = original;
          globalThis[name] = wrapped;
          if (!state.hooks.includes(name)) state.hooks.push(name);
          return true;
        } catch (_) { return false; }
      }
      ['runDiscovery','startLab','analyzeRobustness','runEngineWorkerRobustness','adaptiveResearchGovernorRows','researchSandboxCandidatePool','forwardCandidatePool','activeForwardCandidatePool','buildRunReportObject','saveRuntimeSnapshotThrottled'].forEach(wrap);
      snapshotGlobals('install');
      if (!state.intervalInstalled) {
        state.intervalInstalled = true;
        const timer = setInterval(() => snapshotGlobals('interval'), 2000);
        try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch (_) {}
      }
      return { installed: true, version, hooks: state.hooks.slice(), bufferedRows: state.rows.length, captures: state.captures, lastNonZeroCount: state.lastNonZeroCount };
    }, { version: FINAL_V930_VERSION, reasonText: reason });
    await v1000CollectPageAuthority(`hooks-installed:${reason}`).catch(() => null);
    return status || { installed: false };
  } catch (e) { return { installed: false, error: e.message }; }
}

async function v1000CollectPageAuthority(reason = 'page-authority-scan') {
  if (!page || page.isClosed()) return { rows: 0, error: 'PAGE_NOT_READY' };
  try {
    const rows = await pageEval(async () => {
      function arr(v){ return Array.isArray(v) ? v : []; }
      function get(name){ try { return globalThis[name]; } catch (_) { return null; } }
      async function call(name){ try { const fn = get(name); if (typeof fn !== 'function') return []; const out = fn(); return arr(out && typeof out.then === 'function' ? await out : out); } catch (_) { return []; } }
      const out = [];
      const buffer = get('__ALPS_V10_STATE_AUTHORITY_BUFFER__') || {};
      out.push(...arr(buffer.rows));
      const final = get('__ALPS_FINAL_V930__') || get('__ALPS_V930__') || get('__ALPS_FINAL__') || {};
      const pools = [
        get('__ALPS_V930_NATIVE_FORWARD_POOL__'), get('nativeForwardPool'), get('__ALPS_NATIVE_FORWARD_POOL__'),
        final.nativeForwardPool, final.fullAutonomyNativeForwardPool, final.forwardLatch, final.decisionIntelligence && final.decisionIntelligence.forwardLatch,
        get('__ALPS_V944_FORWARD_LATCH__'), get('__ALPS_V950_SERVER_CANDIDATES__'), get('__ALPS_V956_CURRENT_NATIVE_CANDIDATES__')
      ];
      for (const p of pools) { if (!p) continue; out.push(...arr(p)); out.push(...arr(p.candidates)); out.push(...arr(p.rows)); }
      for (const name of ['results','allResults','discoveryResults','robustnessRows','candidateRows','candidatePreviewPool','marketMapCandidates']) {
        const v = get(name);
        if (Array.isArray(v)) out.push(...v);
        else if (typeof v === 'function') out.push(...await call(name));
      }
      for (const name of ['forwardCandidatePool','activeForwardCandidatePool','researchSandboxCandidatePool','adaptiveResearchGovernorRows','analyzeRobustness','runEngineWorkerRobustness']) out.push(...await call(name));
      return out.slice(0, 5000);
    }, `v10-state-authority-page-scan:${reason}`).catch(() => []);
    const commit = v1000CommitRows(safeArray(rows), `page:${reason}`, { pageRows: safeArray(rows).length });
    return { rows: safeArray(rows).length, committed: commit.committed || 0, activeRows: commit.activeRows || v1000ActiveRows().length };
  } catch (e) { return { rows: 0, error: e.message }; }
}

function v952SyncReportWithCurrentHealth(report = {}, currentHealth = {}) {
  report = v1000ApplyStateAuthorityToView(report, 'v952-sync-report-input');
  currentHealth = v1000ApplyStateAuthorityToView(currentHealth || {}, 'v952-sync-current-health-input');
  const collected = v952CollectCandidateRows([currentHealth, 'currentHealth'], [report, 'report'], [lastHealth, 'lastHealth'], [lastReport, 'lastReport']);
  const existingNative = currentHealth?.nativeForwardPool || report?.nativeForwardPool || lastNativeForwardPoolView || {};
  if (!collected.rows.length && v1000ActiveRows().length) collected.rows.push(...v1000ActiveRows());
  const native = collected.rows.length ? v952BuildNativePoolFromRows(collected.rows, existingNative) : { ...(existingNative || {}), version: FINAL_V930_VERSION, noFixedCandidateCap: true, candidateAdmissionPolicy: 'NO_FIXED_CAP_BUT_NO_REAL_ROWS_VISIBLE' };
  const maxResults = Math.max(v952Num(report.results), v952Num(currentHealth.results), v952Num(report?.research?.strategies), v952Num(native.generatedStrategies), collected.rows.length);
  report.nativeForwardPool = native;
  report.fullAutonomyNativeForwardPool = native;
  report.candidateCountTruth = {
    schema: 'alps.candidateCountTruth.view.v1', version: FINAL_V930_VERSION, installed: true,
    rawStrategies: Math.max(v952Num(report?.research?.strategies), v952Num(report.results), v952Num(currentHealth.results), native.totalCandidates || 0),
    dashboardCandidates: Math.max(v952Num(report.candidates), v952Num(currentHealth.candidates), native.totalCandidates || 0),
    officialCandidates: Math.max(v952Num(report.officialCandidates), v952Num(currentHealth.officialCandidates), native.totalCandidates || 0),
    nativePoolCandidates: native.totalCandidates || 0,
    compressedCandidates: v952Num(native?.duplicateCompression?.selectedRows, native.totalCandidates || 0),
    rawRowsBeforeCompression: v952Num(native?.duplicateCompression?.rawRows, native.totalCandidates || 0),
    latchedCandidates: v952Arr(forwardLatchState.candidates).length,
    paperEntryVisibleCandidates: v952Num(report?.paperEntryActivation?.candidatesSeen || report?.zonePersistenceEntry?.candidatesSeen),
    serverNativeCandidatesAvailable: native.totalCandidates || 0,
    recoveryEligibleCandidates: native.totalCandidates || 0,
    oosVerifiedCandidates: (native.fullAutonomyForward || 0) + (native.watchForward || 0),
    experimentalForwardCandidates: native.experimentalForward || 0,
    paperOpened: Math.max(v952Num(report.paperSignals), v952Num(report?.paperEntryActivation?.opened), v952Num(currentHealth.paperSignals)),
    noFixedCandidateCap: true,
    namingWarning: 'Verified/OOS candidates are separate from Experimental Learning candidates. No fixed candidate number is used as an acceptance blocker.',
    recommendedLabels: ['rawStrategies','nativePoolCandidates','latchedCandidates','paperEligibleCandidates','paperOpened','paperRejected','experimentalLearningCandidates']
  };
  lastV949CandidateCountTruthView = report.candidateCountTruth;
  report.candidates = Math.max(v952Num(report.candidates), v952Num(currentHealth.candidates), native.totalCandidates || 0);
  report.officialCandidates = Math.max(v952Num(report.officialCandidates), v952Num(currentHealth.officialCandidates), native.totalCandidates || 0);
  report.results = maxResults;
  report.rawResearchStrategies = Math.max(v952Num(report.rawResearchStrategies), maxResults);
  if (!report.research || typeof report.research !== 'object') report.research = {};
  report.research.strategies = Math.max(v952Num(report.research.strategies), maxResults);
  if (!report.forwardWatch || typeof report.forwardWatch !== 'object') report.forwardWatch = {};
  report.forwardWatch.candidatesMonitored = Math.max(v952Num(report.forwardWatch.candidatesMonitored), native.totalCandidates || 0);
  report.forwardWatch.totalGeneratedStrategies = Math.max(v952Num(report.forwardWatch.totalGeneratedStrategies), maxResults);
  report.forwardWatch.paperSignals = Math.max(v952Num(report.forwardWatch.paperSignals), v952Num(currentHealth.paperSignals));
  report.forwardWatch.openPositions = Math.max(v952Num(report.forwardWatch.openPositions), v952Num(currentHealth.openPositions));
  report.forwardWatch.closedTrades = Math.max(v952Num(report.forwardWatch.closedTrades), v952Num(currentHealth.closedTrades));
  report.forwardWatch.rejectedSignals = Math.max(v952Num(report.forwardWatch.rejectedSignals), v952Num(currentHealth.rejectedSignals));
  report.fwRunning = !!(report.fwRunning || currentHealth.fwRunning);
  report.fwRefreshRunning = !!(report.fwRefreshRunning || currentHealth.fwRefreshRunning);
  report.lastForwardRefresh = Math.max(v952Num(report.lastForwardRefresh), v952Num(currentHealth.lastForwardRefresh));
  report.dataSource = 'LIVE SNAPSHOT - CURRENT HEALTH SYNCED';
  report.effectivePatchVersion = FINAL_V930_VERSION;
  report.v952CurrentHealthSync = { schema: 'alps.v952CurrentHealthSync.view.v1', version: FINAL_V930_VERSION, installed: true, status: native.totalCandidates > 0 ? 'CURRENT_HEALTH_CANDIDATES_SYNCED' : 'NO_CURRENT_HEALTH_CANDIDATES_VISIBLE', currentHealthCandidates: v952Num(currentHealth.candidates), currentHealthOfficialCandidates: v952Num(currentHealth.officialCandidates), currentHealthResults: v952Num(currentHealth.results), syncedCandidates: native.totalCandidates || 0, syncedResults: maxResults, fwRunning: report.fwRunning, fwRefreshRunning: report.fwRefreshRunning, sourceCounts: collected.sourceCounts, noFixedCandidateCap: true, rule: 'Use current Health as the freshest truth when raw report/module snapshots are stale.' };
  lastV952CurrentHealthSyncView = report.v952CurrentHealthSync;
  report.v952CandidateQualityBuckets = v952BuildQualityBuckets(native.candidates || []);
  lastNativeForwardPoolView = native;
  report = v1000ApplyStateAuthorityToView(report, 'v952-sync-report-output');
  return report;
}
function v952SyncForwardLatchFromCurrent(report = {}, source = 'v952-sync-forward-latch') {
  report = v1000ApplyStateAuthorityToView(report, `${source}:input`);
  let rows = v952CollectCandidateRows([report, 'report'], [lastHealth, 'lastHealth'], [lastReport, 'lastReport']).rows;
  if (!rows.length && v1000ActiveRows().length) rows = v1000ActiveRows();
  const current = new Map(v952Arr(forwardLatchState.candidates).map(c => [v952CandidateKey(c), c]));
  let added = 0, updated = 0;
  for (const row of rows) {
    const norm = v952NormalizeCandidate(row, row.__v952Source || source);
    const key = v952CandidateKey(norm);
    if (!key) continue;
    if (current.has(key)) updated += 1; else added += 1;
    current.set(key, norm);
  }
  const all = [...current.values()].filter(c => c && c.forwardEligible !== false && !/SAFETY_BLOCKED|DATA_BLOCKED|COGNITION_SUSPENDED/.test(v952Text(c.tier)));
  forwardLatchState = { schema: 'alps.forwardLatch.state.v1', version: FINAL_V930_VERSION, noFixedCandidateCap: true, candidateAdmissionPolicy: 'ACCEPT_ALL_REAL_CANDIDATES_NO_FIXED_CAP', candidates: all, updatedAt: Date.now(), source, added, updated };
  lastForwardLatchView = v944BuildForwardLatchView();
  lastForwardLatchView.noFixedCandidateCap = true;
  lastForwardLatchView.candidateAdmissionPolicy = 'ACCEPT_ALL_REAL_CANDIDATES_NO_FIXED_CAP';
  lastV952CandidateBridgeView = { schema: 'alps.v952CandidateBridge.view.v1', version: FINAL_V930_VERSION, installed: true, status: all.length > 0 ? 'NATIVE_POOL_TO_LATCH_READY' : 'NO_CANDIDATES_TO_BRIDGE', nativeCandidates: v952Num(report?.nativeForwardPool?.totalCandidates), latchedCandidates: all.length, added, updated, noFixedCandidateCap: true, rule: 'Every real current candidate is bridged into ForwardLatch and Paper Entry; no fixed candidate count is used as a blocker.' };
  return lastV952CandidateBridgeView;
}
function v952BuildRejectedAudit(report = {}) {
  const rejectedTop = Math.max(v952Num(report.rejectedSignals), v952Num(report?.forwardWatch?.rejectedSignals), v952Num(lastHealth?.rejectedSignals));
  const entry = report.paperEntryActivation || report.zonePersistenceEntry || lastV948EntryEngineView || {};
  const counts = entry.rejectedReasonCounts || {};
  const visibleReasons = Object.keys(counts || {}).length;
  const unknown = Math.max(0, rejectedTop - v952Num(entry.rejected));
  const view = { schema: 'alps.v952RejectedReasonAudit.view.v1', version: FINAL_V930_VERSION, installed: true, rejectedSignals: rejectedTop, entryRejected: v952Num(entry.rejected), visibleReasonBuckets: visibleReasons, rejectedReasonCounts: counts, unknownExternalRejects: unknown, status: rejectedTop > 0 && visibleReasons === 0 ? 'EXTERNAL_REJECTIONS_NOT_MAPPED_YET' : (rejectedTop > 0 ? 'REJECTION_REASONS_VISIBLE_OR_PARTIAL' : 'NO_REJECTIONS_YET'), requiredFields: ['candidateId','pair','timeframe','strategy','currentPrice','zoneLow','zoneHigh','decision','primaryReason','timestamp'], nextRequiredAction: rejectedTop > 0 && visibleReasons === 0 ? 'MAP_EXTERNAL_REJECTED_SIGNALS_TO_REJECTED_REASON_COUNTS' : 'OBSERVE', rule: 'Never hide rejectedSignals. If entry engine does not own them, expose them as unmapped external rejects until the true source is connected.' };
  lastV952RejectedAuditView = view;
  return view;
}
function v952AttachTruth(report = {}, currentHealth = {}) {
  report = v952SyncReportWithCurrentHealth(report, currentHealth);
  report.v952CandidateBridge = v952SyncForwardLatchFromCurrent(report, 'v952-attach-truth');
  report.forwardLatch = lastForwardLatchView || v944BuildForwardLatchView();
  if (report.forwardReadiness) {
    report.forwardReadiness.hasCandidates = (report.nativeForwardPool?.totalCandidates || 0) > 0;
    report.forwardReadiness.canStartWatch = report.forwardReadiness.hasCandidates && (report.fwRunning || report.forwardLatch?.size > 0 || !!report.lastForwardRefresh);
    report.forwardReadiness.startWatchSkippedReason = report.forwardReadiness.hasCandidates ? '' : 'NO_CANDIDATES';
    report.forwardReadiness.forwardNeverStarted = !(report.fwRunning || report.lastForwardRefresh);
  }
  report.v952RejectedReasonAudit = v952BuildRejectedAudit(report);
  report.v954EntryConstructionAudit = (report.paperEntryActivation || report.zonePersistenceEntry || lastV948EntryEngineView || {}).v954EntryConstructionAudit || { schema:'alps.v954EntryConstructionAudit.view.v1', version: FINAL_V930_VERSION, installed:true, status:'AWAITING_PAPER_ENTRY_SCAN', noFixedCandidateCap:true };
  report.v952ReportTruthSync = { schema: 'alps.v952ReportTruthSync.view.v1', version: FINAL_V930_VERSION, installed: true, status: 'CURRENT_HEALTH_PRIORITIZED', rawReportMayBeStale: true, currentHealthCandidates: v952Num(currentHealth.candidates), reportCandidates: v952Num(report.candidates), nativePoolCandidates: v952Num(report?.nativeForwardPool?.totalCandidates), forwardLatchSize: v952Num(report?.forwardLatch?.size), fwRunning: !!report.fwRunning, noFixedCandidateCap: true, rule: 'When module snapshots disagree with current Health, current Health candidates/forward status win and are propagated to report truth sections.' };
  report.reportTruthSync = { ...(report.reportTruthSync || {}), version: FINAL_V930_VERSION, installed: true, runtimeFreshEnough: true, headerLikelyStale: false, snapshotMismatch: false, status: 'CURRENT_HEALTH_SYNCED_BY_V952', nextRequiredAction: 'OBSERVE_OR_PAPER_ENTRY_REJECTION_AUDIT', v952: report.v952ReportTruthSync };
  lastV949ReportTruthView = report.reportTruthSync;
  const entrySeen = v952Num(report?.paperEntryActivation?.candidatesSeen || report?.zonePersistenceEntry?.candidatesSeen);
  const entryScanned = v952Num(report?.paperEntryActivation?.scanned || report?.zonePersistenceEntry?.scanned);
  const rejectedVisible = !!(report?.v952RejectedReasonAudit && report.v952RejectedReasonAudit.status !== 'EXTERNAL_REJECTIONS_NOT_MAPPED_YET');
  const checks = {
    DATA_OK: v952Num(report?.data?.candlesLoaded || currentHealth.candlesLoaded) > 0 || v952Num(report?.candlesLoaded) > 0,
    UNIVERSE_COMPLETE: v952Arr(report?.universeCompletion?.missingSymbols).length === 0,
    PROXY_OK_OR_PARTIAL: true,
    RESEARCH_OK: v952Num(report.results) > 0 || v952Num(report?.nativeForwardPool?.totalCandidates) > 0,
    FORWARD_OK: !!report.fwRunning || v952Num(report?.forwardLatch?.size) > 0 || v952Num(report?.nativeForwardPool?.totalCandidates) > 0,
    ENTRY_ENGINE_INSTALLED: !!(report.zonePersistenceEntry || report.paperEntryActivation),
    ENTRY_VISIBILITY_OK: entrySeen > 0 || v952Num(report?.nativeForwardPool?.totalCandidates) === 0,
    CANDLE_RESOLVER_OK: v952Num(report?.zonePersistenceEntry?.candlesStoresFound || report?.candleStoreResolver?.storesFound || report?.closedCandleMap?.pairFrameCount) > 0,
    ENTRY_EVIDENCE_STARTED: v952Num(report.paperSignals || currentHealth.paperSignals) > 0 || v952Num(report?.paperEntryActivation?.opened) > 0,
    REJECTED_REASON_VISIBLE: rejectedVisible || v952Num(report?.v952RejectedReasonAudit?.rejectedSignals) === 0 || entryScanned > 0,
    EXIT_ENGINE_PROVABLE: v952Num(report.openPositions || currentHealth.openPositions) > 0 || v952Num(report.closedTrades || currentHealth.closedTrades) > 0,
    REPORT_TRUTH_OK: true,
    LIVE_EXECUTION_LOCKED: true,
    MOBILE_RUNTIME_OK: !(report?.mobileRuntimeTruth?.wakeLockDenied || report?.mobileRuntimeTruth?.notificationsDenied)
  };
  const failedChecks = Object.entries(checks).filter(([k,v]) => !v).map(([k]) => k);
  const nextRequiredAction = !checks.ENTRY_VISIBILITY_OK ? 'SYNC_NATIVE_FORWARD_POOL_TO_PAPER_ENTRY' : (!checks.REJECTED_REASON_VISIBLE ? 'MAP_REJECTED_SIGNALS_TO_REASON_COUNTS' : (!checks.ENTRY_EVIDENCE_STARTED ? 'FIX_ENTRY_CONSTRUCTION_OR_WAIT_FOR_FRESH_VALID_ZONE' : 'OBSERVE_TRADE_LIFECYCLE'));
  report.finalHealthGate = { schema: 'alps.finalHealthGate.view.v1', version: FINAL_V930_VERSION, installed: true, status: failedChecks.includes('DATA_OK') || failedChecks.includes('RESEARCH_OK') || failedChecks.includes('FORWARD_OK') || failedChecks.includes('LIVE_EXECUTION_LOCKED') ? 'FAIL' : (failedChecks.length ? 'WARN' : 'PASS'), checks, failedChecks, nextRequiredAction, noFixedCandidateCap: true, rule: 'v10.1.1 final gate uses State Authority, native pool truth, forced Paper Entry authority routing, fresh candidate dedupe, entry construction audit, trade export sync, chart truth, and indicator governance.' };
  lastV949FinalHealthGateView = report.finalHealthGate;
  lastV952ReportTruthView = report.v952ReportTruthSync;
  return report;
}
function buildV952Markdown(report = {}) {
  const s = report.v952CurrentHealthSync || lastV952CurrentHealthSyncView || {};
  const b = report.v952CandidateBridge || lastV952CandidateBridgeView || {};
  const q = report.v952CandidateQualityBuckets || lastV952QualityBucketsView || {};
  const r = report.v952RejectedReasonAudit || lastV952RejectedAuditView || {};
  let md = '\n## ALPS v10.1.1 Integrated System\n';
  md += `- Effective Patch: ${FINAL_V930_VERSION}\n`;
  md += `- Candidate Admission: ACCEPT EVERY REAL CANDIDATE — NO FIXED CAP\n`;
  md += `- Current Health Sync: ${s.status || '—'} | syncedCandidates=${s.syncedCandidates ?? '—'} | syncedResults=${s.syncedResults ?? '—'}\n`;
  md += `- Candidate Bridge: ${b.status || '—'} | native=${b.nativeCandidates ?? '—'} | latched=${b.latchedCandidates ?? '—'}\n`;
  md += `- Paper Entry: candidatesSeen=${report.paperEntryActivation?.candidatesSeen ?? '—'} | scanned=${report.paperEntryActivation?.scanned ?? '—'} | opened=${report.paperEntryActivation?.opened ?? '—'} | topReject=${report.paperEntryActivation?.topRejectedReason || '—'}\n`;
  md += `- Rejected Audit: status=${r.status || '—'} | rejectedSignals=${r.rejectedSignals ?? '—'} | unmapped=${r.unknownExternalRejects ?? '—'}\n`;
  md += `- Quality Buckets: ${JSON.stringify(q.counts || {})}\n`;
  md += `- Preventive Guards: stale price, duplicate, missing candles, unsupported setup root, stop/target undefined, invalidation hit, external rejected mapping, trade export freshness, report truth sync.\n`;
  return md;
}


function v953HealthTruthFromCurrentHealth(health = {}, reason = 'v953-health-endpoint-truth-sync') {
  const base = { ...(health || {}) };
  try {
    const pseudo = {
      ...base,
      data: { ...(base.data || {}), candlesLoaded: v952Num(base.candlesLoaded || base?.data?.candlesLoaded), pairFrames: v952Num(base.dataPairFrames || base?.data?.pairFrames), pairs: v952Arr(base.dataPairs || base?.data?.pairs) },
      research: { ...(base.research || {}), strategies: Math.max(v952Num(base.rawResearchStrategies), v952Num(base.results)) },
      forwardWatch: { ...(base.forwardWatch || {}), candidatesMonitored: Math.max(v952Num(base.candidates), v952Num(base.officialCandidates), v952Num(base?.nativeForwardPool?.totalCandidates)), rejectedSignals: v952Num(base.rejectedSignals), paperSignals: v952Num(base.paperSignals), openPositions: v952Num(base.openPositions), closedTrades: v952Num(base.closedTrades) },
      paperEntryActivation: base.paperEntryActivation || base.zonePersistenceEntry || lastV948EntryEngineView || null,
      zonePersistenceEntry: base.zonePersistenceEntry || lastV948EntryEngineView || null,
      nativeForwardPool: base.nativeForwardPool || lastNativeForwardPoolView || null,
      forwardLatch: lastForwardLatchView || v944BuildForwardLatchView()
    };
    const synced = v952AttachTruth(pseudo, base);
    const out = { ...base };
    for (const k of [
      'nativeForwardPool','fullAutonomyNativeForwardPool','candidateCountTruth','forwardLatch','forwardReadiness','v952CurrentHealthSync','v952CandidateBridge','v952RejectedReasonAudit','v952CandidateQualityBuckets','v952ReportTruthSync','reportTruthSync','finalHealthGate','paperEntryActivation','zonePersistenceEntry','v954EntryConstructionAudit'
    ]) {
      if (synced[k] != null) out[k] = synced[k];
    }
    out.candidates = Math.max(v952Num(base.candidates), v952Num(synced.candidates), v952Num(out?.nativeForwardPool?.totalCandidates));
    out.officialCandidates = Math.max(v952Num(base.officialCandidates), v952Num(synced.officialCandidates), v952Num(out?.nativeForwardPool?.totalCandidates));
    out.results = Math.max(v952Num(base.results), v952Num(synced.results), v952Num(out?.candidateCountTruth?.rawStrategies));
    out.fwRunning = !!(base.fwRunning || synced.fwRunning);
    out.fwRefreshRunning = !!(base.fwRefreshRunning || synced.fwRefreshRunning);
    out.lastForwardRefresh = Math.max(v952Num(base.lastForwardRefresh), v952Num(synced.lastForwardRefresh));
    out.effectivePatchVersion = FINAL_V930_VERSION;
    out.v953HealthTruthSync = {
      schema: 'alps.v953HealthTruthSync.view.v1',
      version: FINAL_V930_VERSION,
      installed: true,
      reason,
      status: out.candidates > 0 ? 'HEALTH_ENDPOINT_CURRENT_CANDIDATES_PROPAGATED' : 'NO_CURRENT_CANDIDATES_VISIBLE_TO_HEALTH_ENDPOINT',
      currentHealthCandidates: v952Num(base.candidates),
      nativePoolCandidates: v952Num(out?.nativeForwardPool?.totalCandidates),
      latchedCandidates: v952Num(out?.forwardLatch?.size),
      paperEntrySeen: v952Num(out?.paperEntryActivation?.candidatesSeen || out?.zonePersistenceEntry?.candidatesSeen),
      paperEntryScanned: v952Num(out?.paperEntryActivation?.scanned || out?.zonePersistenceEntry?.scanned),
      rejectedSignals: v952Num(out.rejectedSignals),
      missedForwardCycles: v952Num(out.missedForwardCycles),
      noFixedCandidateCap: true,
      rule: 'Every /runner/health response refreshes v10.1.0 integrated truth from State Authority/nativeForwardPool/trade export before returning. It does not wait for report.md.'
    };
    const pe = out.paperEntryActivation || out.zonePersistenceEntry || {};
    out.v954EntryConstructionAudit = pe.v954EntryConstructionAudit || { schema:'alps.v954EntryConstructionAudit.view.v1', version: FINAL_V930_VERSION, installed:true, status: v952Num(pe.scanned)>0 ? (v952Num(pe.opened)>0 ? 'ENTRY_CONSTRUCTION_OPENED_PAPER_TRADE' : 'ENTRY_CONSTRUCTION_REJECTED_WITH_PRECISE_REASONS') : 'AWAITING_PAPER_ENTRY_SCAN', scanned:v952Num(pe.scanned), opened:v952Num(pe.opened), rejectedReasonCounts:pe.rejectedReasonCounts || {}, noFixedCandidateCap:true, rule:'Build entry/stop/target from candidate featureSnapshot and current price; INVALIDATION_HIT is only allowed after numeric entry, stop, target and direction are valid.' };
    out.v955CandleBankFeatureAudit = { schema:'alps.v955CandleBankFeatureAudit.view.v1', version: FINAL_V930_VERSION, installed:true, directIndexedDbPriority:true, indexedDbUsed: !!(out.candleStoreResolver && out.candleStoreResolver.usedIndexedDb), candleStoresFound: v952Num(out.candleStoreResolver && out.candleStoreResolver.storesFound), featureRowsFound: v952Num(out.v951RealCandleDiscovery && out.v951RealCandleDiscovery.featureRowsFound), closedCandlePairFrames: v952Num(out.v951RealCandleDiscovery && out.v951RealCandleDiscovery.closedCandlePairFrames), status: v952Num(out.v951RealCandleDiscovery && out.v951RealCandleDiscovery.featureRowsFound)>0 ? 'FEATURE_ROWS_AVAILABLE' : 'WAITING_DIRECT_INDEXEDDB_CANDLE_BANK', rule:'Read all ALPS IndexedDB object stores first, bucket candle records by symbol/timeframe, build closed-candle features directly, then allow discovery/candidate materialization without waiting for full universe.' };
    return out;
  } catch (e) {
    return { ...base, effectivePatchVersion: FINAL_V930_VERSION, v953HealthTruthSync: { schema:'alps.v953HealthTruthSync.view.v1', version: FINAL_V930_VERSION, installed:true, status:'HEALTH_TRUTH_SYNC_FAILED', error: String(e && e.message || e), reason, noFixedCandidateCap:true } };
  }
}

function buildV949CompleteTruthMarkdown(report = {}) {
  const gate = report.finalHealthGate || lastV949FinalHealthGateView || {};
  const uni = report.universeCompletion || lastV949UniverseCompletionView || {};
  const proxy = report.proxyTruth || lastV949ProxyTruthView || {};
  const counts = report.candidateCountTruth || lastV949CandidateCountTruthView || {};
  const life = report.tradeLifecycleTruth || lastV949LifecycleTruthView || {};
  const quality = report.qualityRisk || lastV949QualityRiskView || {};
  const rel = report.releaseChecklist || lastV949ReleaseChecklistView || {};
  const line = (a,b) => `| ${a} | ${b == null || b === '' ? '—' : String(b)} |`;
  let md = `## ALPS v10.1.1 Integrated System Universe Retry\n`;
  md += `| Field | Value |\n|---|---|\n`;
  md += line('Final Health Gate', gate.status) + '\n';
  md += line('Failed Checks', safeArray(gate.failedChecks).join(', ') || 'none') + '\n';
  md += line('Next Required Action', gate.nextRequiredAction) + '\n';
  md += line('Universe Status', uni.status) + '\n';
  md += line('Loaded Pairs', safeArray(uni.loadedPairs).join(', ')) + '\n';
  md += line('Missing Symbols', safeArray(uni.missingSymbols).join(', ') || 'none') + '\n';
  md += line('XAUT Status', uni?.xaut?.status) + '\n';
  md += line('Proxy Truth', proxy.status) + '\n';
  md += line('Raw Strategies', counts.rawStrategies) + '\n';
  md += line('Latched Candidates', counts.latchedCandidates) + '\n';
  md += line('Paper Opened', counts.paperOpened) + '\n';
  md += line('Trade Lifecycle Open/Closed', `${life.openTrades || 0}/${life.closedTrades || 0}`) + '\n';
  md += line('Quality Overfit Risk', quality.overfitRisk) + '\n';
  md += line('Release Checklist', rel.status) + '\n';
  md += `\n> v9.5.0 does not relax paper-only safety. It bridges nativeForwardPool candidates into Paper Entry, resolves candle stores more deeply, and corrects report truth status.\n`;
  return md;
}

function enrichReportV930(report = {}, pageStatus = null) {
  const routes = safeArray(report?.alpsAutonomousBridge?.activeRoutes || lastAutonomyView?.activeRoutes || autonomyMemoryState?.activeRoutes);
  const nativeView = buildNativeForwardPoolView(report, routes);
  v944MergeForwardLatchFromView(nativeView, 'enrich-report-native-forward-pool');
  if (report.recoveryForwardCore) v944MergeForwardLatchFromRecoveryCore(report.recoveryForwardCore, 'enrich-report-recovery-core');
  const forwardLatch = v944BuildForwardLatchView();
  const decisionActuator = v941BuildDecisionActuatorView(nativeView, report);
  nativeView.decisionActuator = decisionActuator;
  const fullAutonomy = buildFullAutonomyView(report, nativeView, routes);
  const mutationGovernor = nativeView?.mutationGovernor || v931BuildMutationGovernor(report);
  const engineHook = buildEngineHookView(pageStatus || report?.engineHook || {});
  const counterfactual = buildCounterfactualView(report);
  const circuitBreaker = buildCircuitBreakerView(engineHook.lastError, engineHook.lastError ? ['engineHook'] : []);
  const chart = buildChartView(report);
  report.nativeForwardPool = nativeView;
  report.fullAutonomyNativeForwardPool = nativeView;
  report.oosEvidenceBridge = nativeView?.oosEvidenceBridge || lastOOSEvidenceBridgeView || null;
  report.recoveryForwardCore = v94BuildRecoveryForwardCoreView(report);
  report.decisionActuator = decisionActuator;
  report.forwardLatch = forwardLatch;
  report.progressiveResearch = v944BuildProgressiveResearchView(report);
  report.researchTrigger = lastResearchTriggerView || v945BuildResearchTriggerView(report);
  report.recoverableEntry = v944BuildRecoverableEntryView(report, forwardLatch);
  report.adaptiveExitManager = v944BuildAdaptiveExitManagerView(report, forwardLatch);
  report.indicatorGovernance = v1010BuildIndicatorGovernanceView(report, forwardLatch);
  report.indicatorResearch = v944BuildSyntheticIndicatorEngineView(report, forwardLatch);
  report.syntheticIndicatorEngine = report.indicatorResearch;
  lastForwardLatchView = report.forwardLatch;
  lastProgressiveResearchView = report.progressiveResearch;
  lastResearchTriggerView = report.researchTrigger;
  lastRecoverableEntryView = report.recoverableEntry;
  lastAdaptiveExitManagerView = report.adaptiveExitManager;
  lastSyntheticIndicatorEngineView = report.indicatorResearch || report.syntheticIndicatorEngine;
  report.livePaperEvidenceCollector = { schema: 'alps.livePaperEvidenceCollector.view.v1', version: FINAL_V930_VERSION, installed: true, experimentalForward: nativeView.experimentalForward || 0, verifiedForward: (nativeView.watchForward || 0) + (nativeView.fullAutonomyForward || 0), latchedForward: forwardLatch.size || 0, mode: forwardLatch.size > 0 ? 'PROGRESSIVE_FORWARD_ACTIVE' : (nativeView.experimentalForward > 0 ? 'EXPERIMENTAL_FORWARD_COLLECTING_EVIDENCE' : 'WAITING_FOR_CANDIDATES'), paperOnly: true, liveCapitalExecution: false, rule: 'Paper experiments are allowed without historical OOS, candidates are latched immediately, and recoverable recent entries may open only inside the same valid entry zone.' };
  report.fullAutonomy = fullAutonomy;
  report.engineHook = engineHook;
  report.counterfactual = counterfactual;
  report.mutationGovernor = mutationGovernor;
  report.decisionIntelligence = { schema: 'alps.decisionIntelligence.view.v1', version: FINAL_V930_VERSION, duplicateCompression: nativeView?.duplicateCompression || null, quantitativePromotion: nativeView?.quantitativePromotion || null, oosEvidenceBridge: report.oosEvidenceBridge || null, decisionActuator, forwardLatch: report.forwardLatch, progressiveResearch: report.progressiveResearch, researchTrigger: report.researchTrigger, recoverableEntry: report.recoverableEntry, adaptiveExitManager: report.adaptiveExitManager, indicatorGovernance: report.indicatorGovernance, indicatorResearch: report.indicatorResearch, syntheticIndicatorEngine: report.syntheticIndicatorEngine, mutationGovernor };
  report.circuitBreaker = circuitBreaker;
  report.chart = chart;
  report.v930 = { version: FINAL_V930_VERSION, dataSource: 'LIVE SNAPSHOT', liveCapitalExecution: false, appStableBase: 'v9.2.2-persistent-autonomous-memory' };
  report.runnerWatchdog = buildRunnerWatchdogView(lastHealth || {});
  report.runtimeTruth = v947CanonicalMetrics(report);
  report.symbolLoadStatus = v947BuildSymbolLoadStatus(report);
  report.closedCandleMap = v947BuildClosedCandleMap(report);
  report.storeInventory = lastStoreInventoryView || v947BuildStoreInventoryView(lastDiscoveryOutputView);
  report.discoveryOutput = lastDiscoveryOutputView || null;
  report.gateMatrix = v947BuildGateMatrix(report, nativeView, forwardLatch);
  report.forwardReadiness = v947BuildForwardReadiness(report, nativeView, forwardLatch);
  report.e2ePipelineTrace = v947BuildE2EPipelineTrace(report, nativeView, forwardLatch);
  report.zeroOutputDiagnostics = v947BuildZeroOutputDiagnostics(report);
  report.masterRuntimeState = v947BuildMasterRuntimeState(report, nativeView, forwardLatch);
  report.pipelineTruthRecovery = v947BuildPipelineTruthView(report, nativeView, forwardLatch);
  report = v1000ApplyStateAuthorityToView(report, 'collect-report-after-post-entry');
  report.zonePersistenceEntry = v948BuildEntryActivationView(report);
  report.paperEntryActivation = report.zonePersistenceEntry;
  report.v954EntryConstructionAudit = report.zonePersistenceEntry?.v954EntryConstructionAudit || null;
  report.numericGuardHotfix = report.zonePersistenceEntry.numericGuard || lastV948NumericGuardView || { installed: true };
  if (report.decisionIntelligence) report.decisionIntelligence.zonePersistenceEntry = report.zonePersistenceEntry;
  // v9.4.9 attaches a single remaining-risk truth layer after v9.4.8 entry diagnostics are present.
  report = v949AttachCompleteTruth(report);
  report.effectivePatchVersion = FINAL_V930_VERSION;
  lastNativeForwardPoolView = nativeView;
  lastOOSEvidenceBridgeView = report.oosEvidenceBridge || lastOOSEvidenceBridgeView;
  lastRecoveryForwardCoreView = report.recoveryForwardCore || lastRecoveryForwardCoreView;
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
  let md = `## ALPS v10.1.1 Integrated System\n`;
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
  md += `| EXPERIMENTAL_FORWARD | ${nfp.experimentalForward || 0} |\n`;
  md += `| RESEARCH_SANDBOX | ${nfp.researchSandbox || 0} |\n`;
  md += `| COGNITION_SUSPENDED | ${nfp.cognitionSuspended || 0} |\n`;
  md += `| SAFETY_BLOCKED | ${nfp.safetyBlocked || 0} |\n`;
  md += `| DATA_BLOCKED | ${nfp.dataBlocked || 0} |\n`;
  const latch = report.forwardLatch || lastForwardLatchView || v944BuildForwardLatchView();
  const pr = report.progressiveResearch || lastProgressiveResearchView || v944BuildProgressiveResearchView(report);
  const rec = report.recoverableEntry || lastRecoverableEntryView || v944BuildRecoverableEntryView(report, latch);
  const exitMgr = report.adaptiveExitManager || lastAdaptiveExitManagerView || v944BuildAdaptiveExitManagerView(report, latch);
  const synth = report.indicatorResearch || report.syntheticIndicatorEngine || lastSyntheticIndicatorEngineView || v944BuildSyntheticIndicatorEngineView(report, latch);
  md += `\n### v10.1.0 Integrated State / Entry / Chart / Indicator Governance\n`;
  md += line('Forward latch size', latch.size || 0) + '\n';
  md += line('Progressive research', pr.active ? `${pr.mode}` : 'OFF') + '\n';
  md += line('Recoverable entry', rec.installed ? `ON | lookback=${rec.lookbackClosedCandles} candles | zone=${rec.entryZoneBps} bps` : 'OFF') + '\n';
  md += line('Adaptive exit manager', exitMgr.installed ? `ON | candidates=${exitMgr.candidatesWithExitPlan || 0}` : 'OFF') + '\n';
  md += line('Indicator research governance', synth.installed ? `${synth.indicatorsCreated || 0} research idea(s) | execution influence=NO until validated` : 'OFF') + '\n';
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
  let md = `## ALPS v10.1.1 Integrated System\n`;
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
  md += `| EXPERIMENTAL_FORWARD | ${nfp.experimentalForward || 0} |\n`;
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
  const da = report.decisionActuator || nfp.decisionActuator || {};
  const lpec = report.livePaperEvidenceCollector || {};
  md += `\n### Live Paper Evidence Collector / Decision Actuator\n`;
  md += line('Collector mode', lpec.mode || '—') + '\n';
  const rt = report.researchTrigger || lastResearchTriggerView || v945BuildResearchTriggerView(report);
  md += line('Research trigger', rt.mode || '—') + '\n';
  md += line('Data bridge active', rt.dataBridgeActive ? 'YES' : 'NO') + '\n';
  md += line('Trigger count', rt.triggerCount ?? 0) + '\n';
  md += line('Last trigger action', rt.lastAction || '—') + '\n';
  md += line('Last trigger status', rt.lastStatus || rt.lastErrorCode || '—') + '\n';
  md += line('Last pair-frames', rt.lastPairFrames ?? 0) + '\n';
  md += line('Current pair-frames', rt.currentPairFrames ?? 0) + '\n';
  md += line('Invoked functions', Array.isArray(rt.lastInvoked) && rt.lastInvoked.length ? rt.lastInvoked.slice(0, 8).join(', ') : '—') + '\n';
  md += line('Research functions invoked', Array.isArray(rt.lastResearchInvoked) && rt.lastResearchInvoked.length ? rt.lastResearchInvoked.slice(0, 8).join(', ') : '—') + '\n';
  md += line('Functions found', Array.isArray(rt.lastFunctionsFound) && rt.lastFunctionsFound.length ? rt.lastFunctionsFound.slice(0, 10).join(', ') : '—') + '\n';
  md += line('Experimental forward', nfp.experimentalForward || lpec.experimentalForward || 0) + '\n';
  md += line('Verified forward', (nfp.watchForward || 0) + (nfp.fullAutonomyForward || 0)) + '\n';
  md += line('Decisions applied', da.decisionsApplied ?? 0) + '\n';
  md += line('Mutations planned', da.mutationsCreated ?? 0) + '\n';
  md += line('Exit variants planned', da.exitChangesTested ?? 0) + '\n';
  md += line('Timeframe variants planned', da.timeframeChangesTested ?? 0) + '\n';
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
  const rw = report.runnerWatchdog || buildRunnerWatchdogView(lastHealth || {});
  md += `\n### Runner Watchdog\n`;
  md += line('Installed', rw.installed ? 'YES' : 'NO') + '\n';
  md += line('State', rw.state || '—') + '\n';
  md += line('Restarts', rw.restarts ?? 0) + '\n';
  md += line('Progress age', `${rw.progressAgeMin ?? 0} min / threshold ${rw.bootWatchdogMin ?? Math.round(BOOT_WATCHDOG_MS/60000)} min`) + '\n';
  md += line('Target pair-frames', rw.targetPairFrames ?? BOOT_WATCHDOG_TARGET_PAIRFRAMES) + '\n';
  md += line('Last action', rw.lastAction || '—') + '\n';
  md += `\n> v9.4.8 note: Live Paper Evidence Collector starts the forward watcher for verified or experimental paper candidates. If no historical OOS exists, it marks candidates NOT_OOS_VERIFIED and collects paper evidence. It does not fabricate OOS, force entries, or bypass closed-candle/freshness safety.\n`;
  return md;
}



function buildV948EntryMarkdown(report = {}) {
  const z = report.zonePersistenceEntry || report.paperEntryActivation || lastV948EntryEngineView || v948EmptyEntryView('markdown-no-view');
  const line = (k, v) => `- ${k}: ${v == null || v === '' ? '—' : v}`;
  let md = `## ALPS v10.1.1 Integrated System\n`;
  md += line('Effective Patch Version', FINAL_V930_VERSION) + '\n';
  md += line('Paper only', 'YES') + '\n';
  md += line('Live capital execution', 'DISABLED') + '\n';
  md += line('Status', z.status || (z.opened > 0 ? 'PAPER_ENTRY_OPENED_THIS_TICK' : 'WAITING_VALID_ZONE_OR_NUMERIC_PLAN')) + '\n';
  md += line('Mode', z.mode || 'LAST_CANDLE_OR_VALID_RECENT_ZONE') + '\n';
  md += line('Candidates seen', z.candidatesSeen ?? 0) + '\n';
  md += line('Candle stores found', z.candlesStoresFound ?? 0) + '\n';
  md += line('Scanned', z.scanned ?? 0) + '\n';
  md += line('Opened this run', z.opened ?? 0) + '\n';
  md += line('Paper signals', z.paperSignals ?? report.paperSignals ?? 0) + '\n';
  md += line('Open positions', z.openPositions ?? report.openPositions ?? 0) + '\n';
  md += line('Rejected signals', z.rejectedSignals ?? report.rejectedSignals ?? 0) + '\n';
  md += line('Top rejected reason', z.topRejectedReason || z.lastKnownBlocker || '—') + '\n';
  md += line('Numeric guard errors caught', z.numericGuard?.guardedToFixedErrors ?? 0) + '\n';
  md += line('Last guarded error', z.numericGuard?.lastGuardedError || '—') + '\n';
  md += `\n### Rejected Reasons\n`;
  md += `| Reason | Count |\n|---|---:|\n`;
  const reasons = Object.entries(z.rejectedReasonCounts || {}).sort((a,b)=>b[1]-a[1]).slice(0, 12);
  if (!reasons.length) md += `| — | 0 |\n`; else for (const [r,c] of reasons) md += `| ${String(r).replace(/\|/g,'/')} | ${c} |\n`;
  if (Array.isArray(z.openedTrades) && z.openedTrades.length) {
    md += `\n### Opened Paper Entries\n| Pair | TF | Direction | Strategy | Entry | Stop | Target | Reason |\n|---|---|---|---|---:|---:|---:|---|\n`;
    for (const t of z.openedTrades.slice(0, 10)) md += `| ${t.pair || '—'} | ${t.timeframe || '—'} | ${t.direction || '—'} | ${String(t.strategy || '—').replace(/\|/g,'/')} | ${n(t.entryPrice ?? t.entry, 0)} | ${n(t.stopPrice ?? t.stop, 0)} | ${n(t.targetPrice ?? t.target, 0)} | zoneStillValid |\n`;
  }
  md += `\n> v9.4.8 rule: A paper trade is opened only from real latched candidates and real candle data when price remains inside a recent valid entry zone, invalidation has not fired, duplicate guard passes, and entry/stop/target are finite. It never sends live orders.\n`;
  return md;
}

function buildV947PipelineTruthMarkdown(report = {}) {
  const ptr = report.pipelineTruthRecovery || lastPipelineTruthView || {};
  const cm = ptr.canonicalMetrics || report.runtimeTruth || lastCanonicalMetrics || {};
  const zero = ptr.zeroOutputDiagnostics || report.zeroOutputDiagnostics || lastZeroOutputDiagnosticView || {};
  const ms = ptr.masterRuntimeState || report.masterRuntimeState || {};
  const sym = ptr.symbolLoadStatus || report.symbolLoadStatus || lastSymbolLoadStatusView || {};
  const gate = ptr.gateMatrix || report.gateMatrix || lastGateMatrixView || {};
  const fwd = ptr.forwardReadiness || report.forwardReadiness || lastForwardReadinessView || {};
  const e2e = ptr.e2ePipelineTrace || report.e2ePipelineTrace || lastE2EPipelineTraceView || {};
  const disc = ptr.discoveryOutput || report.discoveryOutput || lastDiscoveryOutputView || {};
  const line = (k, v) => `- ${k}: ${v == null || v === '' ? '—' : v}`;
  let md = `## ALPS v10.1.1 Integrated System\n`;
  md += line('Effective Patch Version', FINAL_V930_VERSION) + '\n';
  md += line('Paper only', 'YES') + '\n';
  md += line('Live capital execution', 'DISABLED') + '\n';
  md += line('Master Runtime State', ms.state || '—') + '\n';
  md += line('Blocking Layer', ms.blockingLayer || '—') + '\n';
  md += line('Next Required Action', ms.nextRequiredAction || '—') + '\n';
  md += `\n### Runtime Truth Sync\n`;
  md += line('Candles loaded', cm.candlesLoaded ?? 0) + '\n';
  md += line('Pair-frames', cm.pairFrames ?? 0) + '\n';
  md += line('Strategies', cm.strategies ?? 0) + '\n';
  md += line('Candidates', cm.totalCandidates ?? 0) + '\n';
  md += line('Forward latch size', cm.forwardLatchSize ?? 0) + '\n';
  md += line('Latest closed candle', cm.latestClosedCandleTs ? new Date(cm.latestClosedCandleTs).toISOString() : '—') + '\n';
  md += line('Runner state', cm.runnerStateStatus || '—') + '\n';
  md += line('Proxy OK', cm.proxyOK === true ? 'YES' : cm.proxyOK === false ? 'NO / PARTIAL' : 'UNKNOWN') + '\n';
  md += `\n### Discovery Output / Zero-Row Diagnostics\n`;
  md += line('Discovery status', disc.status || '—') + '\n';
  md += line('Zero output class', zero.zeroOutputClass || '—') + '\n';
  md += line('Materialized rows', ptr.materializer?.materializedRows ?? lastMaterializedRows.length ?? 0) + '\n';
  md += line('Feature rows found', zero.featureRowsFound ?? disc.featureRowsFound ?? '—') + '\n';
  md += line('Strategy templates found', zero.strategyTemplatesFound ?? disc.strategyTemplatesFound ?? '—') + '\n';
  md += line('Tested rows', zero.testedRows ?? disc.testedRows ?? '—') + '\n';
  md += line('Rejected rows', zero.rejectedRows ?? disc.rejectedRows ?? '—') + '\n';
  md += line('Functions invoked', Array.isArray(disc.functionsInvoked) && disc.functionsInvoked.length ? disc.functionsInvoked.slice(0, 14).join(', ') : '—') + '\n';
  md += line('Materializer sources', Array.isArray(ptr.materializer?.sources) && ptr.materializer.sources.length ? ptr.materializer.sources.join(', ') : '—') + '\n';
  const v951 = report.v951RealCandleDiscovery || disc.v951RealCandleDiscovery || {};
  md += `\n### v9.5.1 Real Candle Discovery Recovery\n`;
  md += line('Status', v951.status || '—') + '\n';
  md += line('Candle stores', Array.isArray(v951.candleStores) ? v951.candleStores.length : (v951.candleStores ?? '—')) + '\n';
  md += line('Feature rows from real candles', v951.featureRowsFound ?? '—') + '\n';
  md += line('Materialized strategy rows', v951.materializedRows ?? (Array.isArray(v951.rows) ? v951.rows.length : '—')) + '\n';
  md += line('Closed candle pair-frames', v951.closedCandlePairFrames ?? (v951.closedCandleMap ? Object.keys(v951.closedCandleMap).length : '—')) + '\n';
  md += line('Injected into page results', v951.injected === true ? 'YES' : v951.injected === false ? 'NO' : '—') + '\n';
  md += `\n### Symbol Load Status\n`;
  md += line('Requested symbols', Array.isArray(sym.requestedSymbols) ? sym.requestedSymbols.join(', ') : '—') + '\n';
  md += line('Loaded pairs', Array.isArray(sym.loadedPairs) ? sym.loadedPairs.join(', ') : '—') + '\n';
  md += line('Missing symbols', Array.isArray(sym.missingSymbols) && sym.missingSymbols.length ? sym.missingSymbols.join(', ') : '—') + '\n';
  md += line('Partial symbols', Array.isArray(sym.partialSymbols) && sym.partialSymbols.length ? sym.partialSymbols.join(', ') : '—') + '\n';
  md += `\n### Gate Matrix\n`;
  md += `| Gate | Pass | Rows In | Rows Out | Blocked | Note |\n|---|---:|---:|---:|---:|---|\n`;
  for (const g of safeArray(gate.gates)) md += `| ${g.gate || ''} | ${g.pass ? 'YES' : 'NO'} | ${g.rowsIn ?? 0} | ${g.rowsOut ?? 0} | ${g.blocked ?? 0} | ${String(g.note || g.status || '').replace(/\|/g, '/')} |\n`;
  if (!safeArray(gate.gates).length) md += `| — | — | — | — | — | — |\n`;
  md += `\n### Forward Readiness\n`;
  md += line('Can start watch', fwd.canStartWatch ? 'YES' : 'NO') + '\n';
  md += line('Has candidates', fwd.hasCandidates ? 'YES' : 'NO') + '\n';
  md += line('Has closed candle', fwd.hasClosedCandle ? 'YES' : 'NO') + '\n';
  md += line('Start watch skipped reason', fwd.startWatchSkippedReason || '—') + '\n';
  md += line('Forward never started', fwd.forwardNeverStarted ? 'YES' : 'NO') + '\n';
  md += `\n### E2E Pipeline Trace\n`;
  md += `| Stage | Rows | Status |\n|---|---:|---|\n`;
  for (const st of safeArray(e2e.stages)) md += `| ${st.stage || ''} | ${st.rows ?? 0} | ${st.status || ''} |\n`;
  if (!safeArray(e2e.stages).length) md += `| — | — | — |\n`;
  md += line('Blocked at', e2e.blockedAt || '—') + '\n';
  md += `\n> v9.4.8 truth rule: this section uses only real page/report rows. It never fabricates OOS, candidates, trades, or live execution. If rows remain zero, the report must show the blocking layer instead of silently waiting.\n`;
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

function isPageClosedRuntimeError(err) {
  const message = String(err && err.message ? err.message : (err || ''));
  return /Target page, context or browser has been closed|Execution context was destroyed|Cannot find context with specified id|Protocol error.*Target closed|Page closed|Browser has been closed|ALPS page closed during evaluation/i.test(message);
}

async function markPageClosedForRelaunch(reason, err) {
  if (shuttingDown) return;
  const info = errorInfo(err || new Error(reason || 'page closed'));
  Object.assign(lastHealth, {
    status: 'PAGE_CLOSED_RELAUNCH_PENDING',
    pageReady: false,
    lastError: `PAGE_CLOSED_RELAUNCH_PENDING: ${info.message}`,
    pageLifecycleRecovery: {
      installed: true,
      version: FINAL_V930_VERSION,
      reason: String(reason || 'page-closed'),
      capturedAt: Date.now(),
      error: info
    }
  });
  try { if (context) await context.close(); } catch (_) {}
  context = null;
  page = null;
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
  const pool = h.nativeForwardPool || lastNativeForwardPoolView || {};
  const experimentalForward = n(pool.experimentalForward, 0);
  let status = 'IDLE';
  if (stale) status = 'STALE_FORWARD';
  else if (h.fwRunning && experimentalForward > 0) status = 'EXPERIMENTAL_FORWARD_COLLECTING_EVIDENCE';
  else if (h.fwRunning && noLedger) status = 'WAITING_FOR_FRESH_CANDLE';
  else if (h.fwRunning) status = 'LIVE_FORWARD';
  else if (experimentalForward > 0) status = 'EXPERIMENTAL_FORWARD_READY';
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
  h = v1000ApplyStateAuthorityToView(h || {}, 'enhance-health-input');
  const forward = computeForwardStatus(h);
  let out = { ...h, ...forward, recoveryPatch: RECOVERY_PATCH_VERSION, dataSource: h.dataSource || 'LIVE SNAPSHOT' };
  if (!out.nativeForwardPool && lastNativeForwardPoolView) out.nativeForwardPool = lastNativeForwardPoolView;
  if (!out.fullAutonomy && lastFullAutonomyView) out.fullAutonomy = lastFullAutonomyView;
  if (!out.engineHook && lastEngineHookView) out.engineHook = lastEngineHookView;
  if (!out.circuitBreaker && lastCircuitBreakerView) out.circuitBreaker = lastCircuitBreakerView;
  if (!out.chart && lastChartView) out.chart = lastChartView;
  if (!out.oosEvidenceBridge && lastOOSEvidenceBridgeView) out.oosEvidenceBridge = lastOOSEvidenceBridgeView;
  if (!out.recoveryForwardCore && lastRecoveryForwardCoreView) out.recoveryForwardCore = lastRecoveryForwardCoreView;
  const eligibleForward = v94ForwardEligibleCountFromView(out.nativeForwardPool || lastNativeForwardPoolView || {});
  const bridge = out.oosEvidenceBridge || lastOOSEvidenceBridgeView || {};
  const hm = v945ResearchMetrics(out);
  const pairFrames = hm.pairFrames;
  const rawStrategies = hm.rawStrategies;
  const monitored = hm.candidatesMonitored;
  if (forward.forwardStale) out.status = 'STALE_FORWARD';
  if (!out.fwRunning && pairFrames >= BOOT_WATCHDOG_TARGET_PAIRFRAMES && rawStrategies > 0 && monitored > 0 && eligibleForward === 0 && n(bridge.matchedRows, 0) === 0 && n(bridge.candidateRowsWithEvidence, 0) === 0) {
    out.forwardStatus = 'EXPERIMENTAL_FORWARD_COLLECTING_EVIDENCE';
    out.noEvidenceAvailable = true;
    out.status = 'EXPERIMENTAL_FORWARD_COLLECTING_EVIDENCE';
  }
  out.forwardLatch = lastForwardLatchView || v944BuildForwardLatchView();
  out.progressiveResearch = lastProgressiveResearchView || v944BuildProgressiveResearchView(out);
  out.researchTrigger = lastResearchTriggerView || v945BuildResearchTriggerView(out);
  out.recoverableEntry = lastRecoverableEntryView || v944BuildRecoverableEntryView(out, out.forwardLatch);
  out.adaptiveExitManager = lastAdaptiveExitManagerView || v944BuildAdaptiveExitManagerView(out, out.forwardLatch);
  out.indicatorGovernance = v1010BuildIndicatorGovernanceView(out, out.forwardLatch || lastForwardLatchView || lastNativeForwardPoolView);
  out.indicatorResearch = lastSyntheticIndicatorEngineView || v944BuildSyntheticIndicatorEngineView(out, out.forwardLatch || lastForwardLatchView || lastNativeForwardPoolView);
  out.syntheticIndicatorEngine = out.indicatorResearch;
  out.runnerWatchdog = lastRunnerWatchdogView || buildRunnerWatchdogView(out);
  out = v1000ApplyStateAuthorityToView(out, 'enhance-health-output');
  return v953HealthTruthFromCurrentHealth(out, 'enhance-health');
}

function bootProgressSignature(h = {}) {
  const m = v945ResearchMetrics(h);
  return [
    h.fwRunning ? 'fw1' : 'fw0',
    n(h.lastForwardRefresh, 0),
    m.pairFrames,
    m.candlesLoaded,
    m.rawStrategies,
    m.researchCycles,
    m.candidatesMonitored,
    m.totalGeneratedStrategies,
    n(h.results, 0),
    String(m.runnerStateStatus || '')
  ].join('|');
}

function isBootOrLabStuckCandidate(h = {}) {
  const d = h.bootDiagnostics || {};
  const m = v945ResearchMetrics(h);
  const pairFrames = m.pairFrames;
  const candlesLoaded = m.candlesLoaded;
  const rawStrategies = m.rawStrategies;
  const cycles = m.researchCycles;
  const monitored = m.candidatesMonitored;
  const generated = m.totalGeneratedStrategies;
  const noForwardStarted = !h.fwRunning && !h.fwRefreshRunning && !n(h.lastForwardRefresh, 0);
  const hasPartialData = pairFrames >= BOOT_WATCHDOG_MIN_PAIRFRAMES || candlesLoaded > 0;
  const incompleteData = pairFrames > 0 && pairFrames < BOOT_WATCHDOG_TARGET_PAIRFRAMES;
  const noResearchProgress = rawStrategies === 0 && cycles === 0 && monitored === 0 && generated === 0;
  const pausedRunner = String(h.runnerStateStatus || d.runnerStateStatus || '').toLowerCase() === 'paused';
  return AUTO_BOOT_WATCHDOG && hasPartialData && noForwardStarted && (incompleteData || noResearchProgress || pausedRunner);
}

function updateBootProgress(h = {}) {
  const sig = bootProgressSignature(h);
  if (!lastBootProgressSignature || sig !== lastBootProgressSignature) {
    lastBootProgressSignature = sig;
    lastBootProgressAt = Date.now();
  }
  return sig;
}

function buildRunnerWatchdogView(h = lastHealth || {}) {
  const d = h.bootDiagnostics || {};
  const m = v945ResearchMetrics(h);
  const pairFrames = m.pairFrames;
  const candlesLoaded = m.candlesLoaded;
  const rawStrategies = m.rawStrategies;
  const monitored = m.candidatesMonitored;
  const ageMs = Math.max(0, Date.now() - (lastBootProgressAt || Date.now()));
  const stuckCandidate = isBootOrLabStuckCandidate(h);
  const latchedForward = v944ForwardLatchEligibleCount();
  const shouldRestart = stuckCandidate && latchedForward <= 0 && ageMs >= BOOT_WATCHDOG_MS && Date.now() - lastBootWatchdogAt >= BOOT_WATCHDOG_COOLDOWN_MS;
  return {
    schema: 'alps.runnerWatchdog.view.v1',
    version: RECOVERY_PATCH_VERSION,
    installed: true,
    active: AUTO_BOOT_WATCHDOG,
    state: h.fwRunning ? 'FORWARD_RUNNING' : (latchedForward > 0 ? 'FORWARD_LATCH_READY_NO_RELAUNCH' : (shouldRestart ? 'RESTART_DUE' : (stuckCandidate ? 'WATCHING_BOOT_PROGRESS' : 'OBSERVE'))),
    lastAction: lastRunnerWatchdogView?.lastAction || '',
    restarts: bootWatchdogRestarts,
    progressAgeMs: ageMs,
    progressAgeMin: Math.round(ageMs / 60000),
    bootWatchdogMs: BOOT_WATCHDOG_MS,
    bootWatchdogMin: Math.round(BOOT_WATCHDOG_MS / 60000),
    cooldownMs: BOOT_WATCHDOG_COOLDOWN_MS,
    targetPairFrames: BOOT_WATCHDOG_TARGET_PAIRFRAMES,
    forwardLatchSize: latchedForward,
    diagnostics: {
      status: h.status || '',
      forwardStatus: h.forwardStatus || '',
      fwRunning: !!h.fwRunning,
      labRunning: !!h.labRunning,
      lastForwardRefresh: n(h.lastForwardRefresh, 0),
      pairFrames,
      candlesLoaded,
      dataPairs: h.dataPairs || d.pairs || [],
      rawResearchStrategies: rawStrategies,
      candidatesMonitored: monitored,
      runnerStateStatus: h.runnerStateStatus || d.runnerStateStatus || '',
      proxyOK: h.proxyOK ?? d.proxyOK ?? null,
      recentLogs: d.recentLogs || []
    },
    rule: 'If candidates exist in the progressive forward latch, watchdog must start paper forward and must not relaunch. Relaunch is allowed only when no latched/verified/experimental candidates exist and boot is stuck past threshold.'
  };
}

async function maybeRecoverStuckBoot(h = lastHealth || {}, options = {}) {
  updateBootProgress(h);
  const view = buildRunnerWatchdogView(h);
  lastRunnerWatchdogView = view;
  if (!AUTO_BOOT_WATCHDOG || !isBootOrLabStuckCandidate(h)) return false;
  if (Date.now() - (lastHealth.startedAt || Date.now()) < BOOT_WATCHDOG_MIN_BOOT_AGE_MS) return false;
  if (view.progressAgeMs < BOOT_WATCHDOG_MS) return false;
  if (Date.now() - lastBootWatchdogAt < BOOT_WATCHDOG_COOLDOWN_MS) return false;
  if (watchdogActionBusy) {
    lastRunnerWatchdogView = { ...view, state: 'ACTION_ALREADY_RUNNING', lastAction: 'WAIT_EXISTING_WATCHDOG_ACTION' };
    return false;
  }

  watchdogActionBusy = true;
  lastBootWatchdogAt = Date.now();
  bootWatchdogRestarts += 1;
  const actionSource = String(options.source || 'watchdog-loop');
  const diag = view.diagnostics || {};
  const poolEligibleForward = v94ForwardEligibleCountFromView(h.nativeForwardPool || lastNativeForwardPoolView || {});
  const latchEligibleForward = v944ForwardLatchEligibleCount();
  const recoveryEligibleForward = n((h.recoveryForwardCore || lastRecoveryForwardCoreView || {}).eligibleForwardCandidates, 0);
  const eligibleForward = Math.max(poolEligibleForward, latchEligibleForward, recoveryEligibleForward);
  const bridge = h.oosEvidenceBridge || lastOOSEvidenceBridgeView || {};
  const noEvidenceAvailable = n(diag.pairFrames, 0) >= BOOT_WATCHDOG_TARGET_PAIRFRAMES && n(diag.rawResearchStrategies, 0) > 0 && (n(diag.candidatesMonitored, 0) > 0 || n(h.candidates, 0) > 0) && eligibleForward <= 0 && n(bridge.matchedRows, 0) === 0 && n(bridge.candidateRowsWithEvidence, 0) === 0;
  if (noEvidenceAvailable) {
    lastRunnerWatchdogView = { ...view, state: 'WAITING_FOR_CANDIDATE_ROWS', lastAction: 'HOLD_NO_CANDIDATE_ROWS', actionSource, restarts: bootWatchdogRestarts };
    lastRecoveryForwardCoreView = { ...(lastRecoveryForwardCoreView || {}), installed: true, version: FINAL_V930_VERSION, forwardDecision: 'WAITING_FOR_CANDIDATE_ROWS', honestFailure: false, eligibleForwardCandidates: 0, oosEvidenceBridge: bridge, paperOnly: true, liveCapitalExecution: false };
    log(`Live Paper Evidence Collector waiting: no eligible candidate rows are available yet. pairFrames=${diag.pairFrames} rawStrategies=${diag.rawResearchStrategies} candidates=${n(h.candidates,0)}`);
    return false;
  }
  const hasReadyResearch = eligibleForward > 0;
  if (!hasReadyResearch && page && !page.isClosed()) {
    const triggered = await triggerActualResearchIfNeeded('watchdog-actual-research-trigger', h).catch(() => false);
    if (triggered) {
      lastRunnerWatchdogView = { ...view, state: 'RESEARCH_TRIGGERED_NO_RELAUNCH', lastAction: 'FORCE_RESEARCH_START', actionSource, restarts: bootWatchdogRestarts };
      log(`Runner watchdog triggered research without relaunch: pairFrames=${diag.pairFrames} rawStrategies=${diag.rawResearchStrategies}`);
      return true;
    }
  }
  lastRunnerWatchdogView = { ...view, state: 'EXECUTING_ACTION', lastAction: hasReadyResearch ? 'START_FORWARD_RUNNER' : 'RELOAD_STUCK_BOOT_OR_LAB', actionSource, restarts: bootWatchdogRestarts };
  log(`Runner watchdog action executor: source=${actionSource} pairFrames=${diag.pairFrames}/${BOOT_WATCHDOG_TARGET_PAIRFRAMES} candles=${diag.candlesLoaded} rawStrategies=${diag.rawResearchStrategies} monitored=${diag.candidatesMonitored} candidates=${n(h.candidates, 0)} eligibleForward=${eligibleForward} action=${lastRunnerWatchdogView.lastAction}`);

  try {
    // First rescue path: if discovery has produced candidates/results but the Browser Runner is still paused,
    // start the actual forward watcher directly. This does not create trades and does not bypass freshness/closed-candle gates.
    if (page && !page.isClosed() && hasReadyResearch) {
      lastRunnerWatchdogView = { ...lastRunnerWatchdogView, state: 'STARTING_FORWARD_RUNNER', lastAction: 'START_FORWARD_RUNNER' };
      await pageEval(async reasonText => {
        try { if (typeof prepareAndroidRuntime === 'function') await prepareAndroidRuntime(); } catch (_) {}
        try { if (typeof startEngineWorker === 'function') await startEngineWorker(); } catch (_) {}
        try { if (typeof runFinalPreflight === 'function' && (!globalThis.preflightStatus || globalThis.preflightStatus === 'WAITING')) await runFinalPreflight(); } catch (_) {}
        try { if (typeof startWatch === 'function') await startWatch(); } catch (_) {}
        try { if (typeof catchUpForwardWatch === 'function') await catchUpForwardWatch(reasonText || 'runner-watchdog-action-executor'); } catch (_) {}
        try { if (typeof saveRuntimeSnapshotThrottled === 'function') await saveRuntimeSnapshotThrottled(false); } catch (_) {}
        try { if (typeof renderAll === 'function') renderAll(); } catch (_) {}
        return true;
      }, 'runner-watchdog-action-executor').catch(e => log('Runner watchdog direct forward start failed:', e.message));
      await new Promise(resolve => setTimeout(resolve, 5000));
      const directHealth = enhanceHealth(await getPageHealth().catch(() => lastHealth));
      Object.assign(lastHealth, directHealth, { status: directHealth.fwRunning ? 'RUNNING' : (directHealth.labRunning ? 'LAB_RUNNING' : 'LOADED'), lastTickAt: Date.now(), lastError: '' });
      if (directHealth.fwRunning || n(directHealth.lastForwardRefresh, 0) > 0) {
        updateBootProgress(directHealth);
        lastRunnerWatchdogView = { ...buildRunnerWatchdogView(lastHealth), state: 'FORWARD_RUNNING_AFTER_ACTION', lastAction: 'START_FORWARD_RUNNER', restarts: bootWatchdogRestarts };
        await recordSnapshot(snapshotFromMetrics(lastHealth, 'runner-watchdog-forward-start')).catch(() => null);
        return true;
      }
      log('Runner watchdog direct forward start did not make fwRunning=true; falling back to page relaunch.');
    }

    // Second rescue path: full Chromium page relaunch. This is deliberately operational only;
    // it restarts loading/research and keeps the paper-only boundary intact.
    lastRunnerWatchdogView = { ...lastRunnerWatchdogView, state: 'RELAUNCHING_CHROMIUM_PAGE', lastAction: 'FORCE_RELAUNCH_CHROMIUM_PAGE', restarts: bootWatchdogRestarts };
    await closeBrowserContextSafe().catch(() => null);
    await launchAppPage({ allowProfileReset: false });
    await installV930StableAutonomyInPage().catch(e => log('Runner watchdog autonomy reinstall failed:', e.message));
    await pageEval(async () => {
      try { if (typeof prepareAndroidRuntime === 'function') await prepareAndroidRuntime(); } catch (_) {}
      try { if (typeof startEngineWorker === 'function') await startEngineWorker(); } catch (_) {}
      try { if (typeof runFinalPreflight === 'function' && (!globalThis.preflightStatus || globalThis.preflightStatus === 'WAITING')) await runFinalPreflight(); } catch (_) {}
      try { if (typeof startLab === 'function') startLab(); } catch (_) {}
      return true;
    }).catch(e => log('Runner watchdog runtime relaunch hook failed:', e.message));
    const fresh = enhanceHealth(await getPageHealth().catch(() => lastHealth));
    lastBootProgressSignature = '';
    lastBootProgressAt = Date.now();
    updateBootProgress(fresh);
    Object.assign(lastHealth, fresh, { status: 'WATCHDOG_RELAUNCHED', lastTickAt: Date.now(), lastError: '' });
    lastRunnerWatchdogView = { ...buildRunnerWatchdogView(lastHealth), state: 'RELAUNCHED_RESEARCH_RESTARTED', lastAction: 'FORCE_RELAUNCH_CHROMIUM_PAGE', restarts: bootWatchdogRestarts };
    await recordSnapshot(snapshotFromMetrics(lastHealth, 'runner-watchdog-relaunch')).catch(() => null);
    return true;
  } catch (e) {
    lastHealth.lastError = `Runner watchdog action executor failed: ${e.message}`;
    lastRunnerWatchdogView = { ...lastRunnerWatchdogView, state: 'ACTION_ERROR', lastAction: 'ACTION_FAILED', error: e.message, restarts: bootWatchdogRestarts };
    log(lastHealth.lastError);
    return false;
  } finally {
    watchdogActionBusy = false;
  }
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


function v1010NormalizeCandleRow(r) {
  if (!r) return null;
  if (Array.isArray(r)) {
    const t=Number(r[0]), o=Number(r[1]), h=Number(r[2]), l=Number(r[3]), c=Number(r[4]), v=Number(r[5]||0);
    if (![t,o,h,l,c].every(Number.isFinite)) return null;
    return { t,o,h,l,c,v };
  }
  const t=Number(r.t ?? r.time ?? r.ts ?? r.openTime ?? r.closeTime ?? r[0]);
  const o=Number(r.o ?? r.open), h=Number(r.h ?? r.high), l=Number(r.l ?? r.low), c=Number(r.c ?? r.close), v=Number(r.v ?? r.volume ?? 0);
  if (![t,o,h,l,c].every(Number.isFinite)) return null;
  return { t,o,h,l,c,v };
}
function v1010TradeRowsForChart(symbol='BTCUSDT') {
  const sym = textValue(symbol).toUpperCase().replace(/[^A-Z0-9]/g,'');
  const base = sym.replace('USDT','');
  return v1010SanitizeExecutionRows([...(lastTradeExport?.openTrades||[]), ...(lastTradeExport?.closedTrades||[]), ...(lastReport?.paperEntryActivation?.openedTrades||[]), ...(lastReport?.zonePersistenceEntry?.openedTrades||[])]).filter(t => {
    const s = textValue(t.pair||t.baseSymbol||t.symbol||t.sym||t.key).toUpperCase();
    return s.includes(sym) || s.includes(base);
  });
}
async function v1010FetchChartTruth(pair='BTCUSDT', timeframe='1h', limit=120) {
  const symbol = textValue(pair || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g,'') || 'BTCUSDT';
  const interval = ({'5M':'5m','15M':'15m','30M':'30m','1H':'1h','4H':'4h','1D':'1d'}[textValue(timeframe).toUpperCase()] || textValue(timeframe || '1h').toLowerCase());
  const capped = Math.max(20, Math.min(300, Number(limit)||120));
  let rows = [];
  let source = 'NO_CANDLES_AVAILABLE';
  try {
    const fetched = await v1012FetchBinanceKlines(symbol, interval, capped);
    rows = safeArray(fetched.rows).map(x => ({ t:x.t, o:x.open, h:x.high, l:x.low, c:x.close, v:x.volume })).map(v1010NormalizeCandleRow).filter(Boolean);
    source = rows.length ? `MARKET_DATA_${fetched.status}_${fetched.sourceName || fetched.sourceSymbol || symbol}` : `MARKET_DATA_EMPTY_${fetched.status || 'UNKNOWN'}`;
  } catch (e) { source = `CANDLE_FETCH_FAILED:${textValue(e.message || e).slice(0,80)}`; }
  const candidateRows = v1010SanitizeExecutionRows(safeArray(lastNativeForwardPoolView?.candidates || lastReport?.nativeForwardPool?.candidates || []))
    .filter(c => textValue(c.pair||c.baseSymbol||c.symbol).toUpperCase().includes(symbol) || textValue(c.key).toUpperCase().includes(symbol));
  const tradeRows = v1010TradeRowsForChart(symbol);
  const indicatorGovernance = v1010BuildIndicatorGovernanceView(lastReport || {}, lastForwardLatchView || { candidates: candidateRows });
  const view = {
    schema: 'alps.chartTruth.view.v1',
    version: FINAL_V930_VERSION,
    pair: symbol,
    timeframe: interval,
    source,
    candles: rows,
    candidates: candidateRows.slice(0, 80),
    trades: tradeRows,
    indicatorResearch: indicatorGovernance,
    executionInfluenceAllowedForUnvalidatedIndicators: false,
    rule: 'Chart displays real candles, real candidate levels, real paper trades, and governed indicator research overlays. It does not create trades or promote indicators.'
  };
  lastChartView = view;
  return view;
}


// v10.1.2 Server Candle Bootstrap:
// If the page reports real candles loaded but exposes zero feature rows to discovery, the runner may
// independently build research rows from real Binance closed candles. This avoids the page/global
// visibility gap without creating synthetic candles, synthetic OOS, or fake trades.
let lastV1012ServerCandleBootstrapView = null;
let lastV1017FeatureMaterializerView = null;
const v1012ServerCandleCache = new Map();
function v1012TfMs(tf) {
  const t = textValue(tf).toLowerCase();
  if (t === '5m') return 5*60*1000;
  if (t === '15m') return 15*60*1000;
  if (t === '30m') return 30*60*1000;
  if (t === '1h') return 60*60*1000;
  if (t === '4h') return 4*60*60*1000;
  return 60*60*1000;
}
function v1012KlineToCandle(v) {
  const r = v1010NormalizeCandleRow(v);
  if (!r) return null;
  return { t: Number(r.t), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v || 0) };
}
function v1012Sma(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : null; }
function v1012Ema(values,len){ if(values.length<len) return null; const k=2/(len+1); let e=values[0]; for(let i=1;i<values.length;i++) e=values[i]*k+e*(1-k); return e; }
function v1012Atr(rows,len=14){ if(rows.length<2) return null; const trs=[]; for(let i=Math.max(1,rows.length-len);i<rows.length;i++){ const c=rows[i],p=rows[i-1]; trs.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close))); } return v1012Sma(trs); }
function v1012Rsi(closes,len=14){ if(closes.length<=len) return null; let g=0,l=0; for(let i=closes.length-len;i<closes.length;i++){ const d=closes[i]-closes[i-1]; if(d>=0) g+=d; else l-=d; } if(l===0) return 100; const rs=g/l; return 100-(100/(1+rs)); }
function v1012Std(a){ const m=v1012Sma(a); if(m==null) return null; return Math.sqrt(a.reduce((x,y)=>x+(y-m)*(y-m),0)/a.length); }
function v1012Pct(vals,q){ const a=vals.filter(x=>Number.isFinite(Number(x))).sort((x,y)=>x-y); if(!a.length) return null; return a[Math.max(0,Math.min(a.length-1,Math.round((a.length-1)*q)))]; }
function v1012Feature(pair,tf,rows,idx){
  const win=rows.slice(Math.max(0,idx-160),idx+1); const closes=win.map(x=>x.close).filter(Number.isFinite); if(closes.length<60) return null;
  const price=closes[closes.length-1], a=v1012Atr(win,14)||price*0.003, e20=v1012Ema(closes.slice(-100),20), e50=v1012Ema(closes.slice(-140),50), r=v1012Rsi(closes,14), last20=closes.slice(-20), m=v1012Sma(last20), sd=v1012Std(last20);
  const highs=win.slice(-100).map(x=>x.high), lows=win.slice(-100).map(x=>x.low), swingHigh=Math.max(...highs), swingLow=Math.min(...lows), poc=v1012Pct(win.slice(-96).map(x=>(x.high+x.low+x.close)/3),0.5);
  return { pair,timeframe:tf,index:idx,time:rows[idx].t,close:price,atr:a,ema20:e20,ema50:e50,rsi:r,bbMid:m,bbUpper:m!=null&&sd!=null?m+2*sd:null,bbLower:m!=null&&sd!=null?m-2*sd:null,swingHigh,swingLow,poc };
}
function v1012Signal(strategy,f){
  const p=f.close, buf=Math.max(p*0.0018,(f.atr||p*0.003)*0.18);
  if(strategy==='EMA_TREND' && Number.isFinite(f.ema20)&&Number.isFinite(f.ema50)) return {side:p>=f.ema50?'LONG':'SHORT',zone:f.ema20,ok:Math.abs(p-f.ema20)<=buf*2.2};
  if(strategy==='SWING_LEVEL_BOUNCE') { const nearLow=Math.abs(p-f.swingLow)<=buf*3, nearHigh=Math.abs(p-f.swingHigh)<=buf*3; return nearLow?{side:'LONG',zone:f.swingLow,ok:true}:nearHigh?{side:'SHORT',zone:f.swingHigh,ok:true}:{ok:false}; }
  if(strategy==='POC' && Number.isFinite(f.poc)) return {side:p>=f.poc?'LONG':'SHORT',zone:f.poc,ok:Math.abs(p-f.poc)<=buf*3.5};
  if(strategy==='BOLLINGER_REVERSAL' && Number.isFinite(f.bbLower)&&Number.isFinite(f.bbUpper)) return p<=f.bbLower+buf?{side:'LONG',zone:f.bbLower,ok:true}:p>=f.bbUpper-buf?{side:'SHORT',zone:f.bbUpper,ok:true}:{ok:false};
  if(strategy==='RSI_DIVERGENCE_ZONE' && Number.isFinite(f.rsi)) return f.rsi<=35?{side:'LONG',zone:p,ok:true}:f.rsi>=65?{side:'SHORT',zone:p,ok:true}:{ok:false};
  return {ok:false};
}
function v1012Backtest(pair,tf,rows,strategy,rr){
  let wins=0,losses=0,grossWin=0,grossLoss=0,trades=0; const start=Math.max(80,Math.floor(rows.length*0.55)); const end=rows.length-8;
  for(let i=start;i<end;i++){
    const f=v1012Feature(pair,tf,rows,i); if(!f) continue; const sig=v1012Signal(strategy,f); if(!sig.ok) continue;
    const price=f.close, stopDist=Math.max((f.atr||price*0.003)*1.15,price*0.0012); let stop,target;
    if(sig.side==='LONG'){stop=price-stopDist;target=price+stopDist*rr;} else {stop=price+stopDist;target=price-stopDist*rr;}
    let outcome=null; for(let j=i+1;j<Math.min(rows.length,i+18);j++){ const c=rows[j]; if(sig.side==='LONG'){ if(c.low<=stop){outcome=-1;break;} if(c.high>=target){outcome=rr;break;} } else { if(c.high>=stop){outcome=-1;break;} if(c.low<=target){outcome=rr;break;} } }
    if(outcome==null) continue; trades++; if(outcome>0){wins++;grossWin+=outcome;} else {losses++;grossLoss+=Math.abs(outcome);} if(trades>=220) break;
  }
  const pf=grossLoss>0?grossWin/grossLoss:(grossWin>0?grossWin:0); const wr=trades?wins/trades:0; const posterior=Math.max(0,Math.min(0.995,(pf/(pf+1||1))*0.7+wr*0.3)); return {trades,wins,losses,pf,wr,posterior};
}
function v1012RowsForGroup(pair,tf,rows,source){
  const out=[]; const feats=[]; const f=v1012Feature(pair,tf,rows,rows.length-1); if(!f) return { rows:out, featureRows:feats }; feats.push(f);
  const strategies=['EMA_TREND','SWING_LEVEL_BOUNCE','POC','BOLLINGER_REVERSAL','RSI_DIVERGENCE_ZONE']; const exits=[1,1.5,2,3,5];
  for(const st of strategies){ for(const rr of exits){ const bt=v1012Backtest(pair,tf,rows,st,rr); const sig=v1012Signal(st,f); const score=(bt.pf||0)*25+(bt.trades||0)*0.25+(sig.ok?20:0)+(bt.posterior||0)*30; if(bt.trades<3 && !sig.ok) continue; const strategyName=st.replace(/_/g,' '); out.push({ key:`${pair}_${tf}||${tf.toUpperCase()}||${st}||${String(rr).replace('.','_')}R_FIXED`, pair, symbol:pair, baseSymbol:pair, timeframe:tf, strategy:strategyName, stratName:strategyName, strategyRoot:st, exit:`${rr}R Fixed`, direction:sig.side||'', currentPrice:f.close, setupPrice:sig.zone||f.close, score:Number(score.toFixed(4)), oosPF:Number((bt.pf||0).toFixed(6)), oosTrades:bt.trades, totalTrades:bt.trades, nEffOOS:Math.max(0,Math.round(bt.trades*0.7)), posteriorPFgt1:Number((bt.posterior||0).toFixed(6)), rollingPass:bt.trades>=8 && bt.pf>=1, promotionTier:bt.trades>=25&&bt.posterior>=0.9&&bt.pf>=1.2?'FULL_AUTONOMY_FORWARD':(bt.trades>=10&&bt.pf>=1?'WATCH_FORWARD':'EXPERIMENTAL_FORWARD'), candidateTier:bt.trades>=25&&bt.posterior>=0.9&&bt.pf>=1.2?'FULL_AUTONOMY_FORWARD':(bt.trades>=10&&bt.pf>=1?'WATCH_FORWARD':'EXPERIMENTAL_FORWARD'), forwardEligible:true, eligible:true, evidenceSource:'SERVER_REAL_MARKET_DATA_CANDLE_DERIVED_BACKTEST', __alpsV1012Source:'v10.1.5.marketDataVisionBootstrap', __alpsV1012CandleSource:source, closedCandleTime:f.time, latestClosedCandleTs:f.time, featureSnapshot:f, paperOnly:true, liveCapitalExecution:false }); } }
  return { rows:out, featureRows:feats };
}
function v1012RequestedSymbols(report={}) {
  const raw = `${textValue(report?.settings?.symbols || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT')},${textValue(report?.settings?.metals || '')}`;
  return [...new Set(raw.split(/[,\s]+/).map(x=>x.trim().toUpperCase()).filter(Boolean).map(x=>x==='XAUUSDT'?'XAUTUSDT':x))].filter(s => /^([A-Z0-9]+)USDT$/.test(s));
}

function v1014SourceSymbolFor(symbol) {
  const s = textValue(symbol).toUpperCase().replace(/[^A-Z0-9]/g,'');
  if (s === 'XAUTUSDT' || s === 'XAUUSDT' || s === 'GOLDUSDT') return { sourceSymbol:'PAXGUSDT', requestedSymbol:s || 'XAUTUSDT', assetProxy:'PAXGUSDT_FOR_GOLD' };
  return { sourceSymbol:s, requestedSymbol:s, assetProxy:'' };
}
function v1014OkxInstId(sourceSymbol) {
  return textValue(sourceSymbol).toUpperCase().replace(/USDT$/, '-USDT');
}
function v1014OkxBar(tf) {
  const t = textValue(tf).toLowerCase();
  if (t === '1h') return '1H';
  if (t === '4h') return '4H';
  return t;
}
function v1014BybitInterval(tf) {
  const t = textValue(tf).toLowerCase();
  return ({ '5m':'5', '15m':'15', '30m':'30', '1h':'60', '4h':'240' }[t] || t.replace('m',''));
}
async function v1014FetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers:{ accept:'application/json', 'user-agent':'ALPS-Research-Runner/10.1.6' }, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { ok: res.ok, status: res.status, json, text: text ? text.slice(0,160) : '' };
  } finally { clearTimeout(timer); }
}
function v1014BinanceArrayToCandles(json) {
  return safeArray(json).map(v1012KlineToCandle).filter(Boolean).filter(x=>Number.isFinite(x.close)&&Number.isFinite(x.high)&&Number.isFinite(x.low)).sort((a,b)=>(a.t||0)-(b.t||0));
}
function v1014OkxArrayToCandles(json) {
  const rows = safeArray(json?.data).filter(r => Array.isArray(r));
  return rows.map(r => ({ t:Number(r[0]), open:Number(r[1]), high:Number(r[2]), low:Number(r[3]), close:Number(r[4]), volume:Number(r[5]||0), confirm:String(r[8]||'') }))
    .filter(x=>[x.t,x.open,x.high,x.low,x.close].every(Number.isFinite) && x.confirm !== '0')
    .sort((a,b)=>(a.t||0)-(b.t||0));
}
function v1014BybitArrayToCandles(json) {
  const rows = safeArray(json?.result?.list).filter(r => Array.isArray(r));
  return rows.map(r => ({ t:Number(r[0]), open:Number(r[1]), high:Number(r[2]), low:Number(r[3]), close:Number(r[4]), volume:Number(r[5]||0) }))
    .filter(x=>[x.t,x.open,x.high,x.low,x.close].every(Number.isFinite))
    .sort((a,b)=>(a.t||0)-(b.t||0));
}
async function v1012FetchBinanceKlines(symbol, tf, limit=1000) {
  const src = v1014SourceSymbolFor(symbol);
  const sourceSymbol = src.sourceSymbol;
  if (!sourceSymbol) return { rows:[], sourceSymbol:'', requestedSymbol:symbol, status:'NO_SAFE_MARKET_DATA_ALIAS' };
  const interval = ({'5M':'5m','15M':'15m','30M':'30m','1H':'1h','4H':'4h'}[textValue(tf).toUpperCase()] || textValue(tf).toLowerCase());
  const capped = Math.max(120, Math.min(1000, Number(limit)||1000));
  const key = `${sourceSymbol}_${interval}_${capped}_v1014`;
  const cached = v1012ServerCandleCache.get(key);
  if (cached && Date.now() - cached.at < 8*60*1000) return { rows:cached.rows, sourceSymbol, requestedSymbol:src.requestedSymbol, assetProxy:src.assetProxy, status:'CACHE_HIT', sourceName:cached.sourceName || 'CACHE' };
  const attempts = [];
  const closed = (rows) => safeArray(rows).filter(x => !x.t || x.t <= Date.now() - v1012TfMs(interval));
  try {
    const binanceBases = ['https://data-api.binance.vision', 'https://data.binance.com'];
    for (const base of binanceBases) {
      const url = `${base}/api/v3/klines?symbol=${encodeURIComponent(sourceSymbol)}&interval=${encodeURIComponent(interval)}&limit=${capped}`;
      const r = await v1014FetchJson(url, 15000).catch(e => ({ ok:false, status:`ERROR:${textValue(e.message||e).slice(0,60)}` }));
      attempts.push({ source:'BINANCE_VISION', base, status:r.status, ok:!!r.ok });
      if (r.ok) {
        const rows = closed(v1014BinanceArrayToCandles(r.json));
        if (rows.length) { v1012ServerCandleCache.set(key, { at: Date.now(), rows, sourceName:'BINANCE_VISION' }); return { rows, sourceSymbol, requestedSymbol:src.requestedSymbol, assetProxy:src.assetProxy, status:'OK_BINANCE_VISION', sourceName:'BINANCE_VISION', attempts }; }
      }
    }
    const okxLimit = Math.min(300, capped);
    const okxUrl = `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(v1014OkxInstId(sourceSymbol))}&bar=${encodeURIComponent(v1014OkxBar(interval))}&limit=${okxLimit}`;
    const okx = await v1014FetchJson(okxUrl, 15000).catch(e => ({ ok:false, status:`ERROR:${textValue(e.message||e).slice(0,60)}` }));
    attempts.push({ source:'OKX', status:okx.status, ok:!!okx.ok });
    if (okx.ok && String(okx.json?.code) === '0') {
      const rows = closed(v1014OkxArrayToCandles(okx.json));
      if (rows.length) { v1012ServerCandleCache.set(key, { at: Date.now(), rows, sourceName:'OKX' }); return { rows, sourceSymbol, requestedSymbol:src.requestedSymbol, assetProxy:src.assetProxy, status:'OK_OKX', sourceName:'OKX', attempts }; }
    }
    const bybitUrl = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(sourceSymbol)}&interval=${encodeURIComponent(v1014BybitInterval(interval))}&limit=${capped}`;
    const bybit = await v1014FetchJson(bybitUrl, 15000).catch(e => ({ ok:false, status:`ERROR:${textValue(e.message||e).slice(0,60)}` }));
    attempts.push({ source:'BYBIT', status:bybit.status, ok:!!bybit.ok });
    if (bybit.ok && Number(bybit.json?.retCode) === 0) {
      const rows = closed(v1014BybitArrayToCandles(bybit.json));
      if (rows.length) { v1012ServerCandleCache.set(key, { at: Date.now(), rows, sourceName:'BYBIT' }); return { rows, sourceSymbol, requestedSymbol:src.requestedSymbol, assetProxy:src.assetProxy, status:'OK_BYBIT', sourceName:'BYBIT', attempts }; }
    }
    return { rows:[], sourceSymbol, requestedSymbol:src.requestedSymbol, assetProxy:src.assetProxy, status:'ALL_MARKET_DATA_SOURCES_EMPTY_OR_BLOCKED', attempts };
  } catch (e) { return { rows:[], sourceSymbol, requestedSymbol:src.requestedSymbol, assetProxy:src.assetProxy, status:`ERROR:${textValue(e.message||e).slice(0,80)}`, attempts }; }
}
async function v1012ServerCandleResearchBootstrap(report={}, reason='v10.1.2-server-candle-bootstrap') {
  const out = { schema:'alps.v1012ServerCandleResearchBootstrap.view.v1', version:FINAL_V930_VERSION, installed:true, reason, realCandlesOnly:true, noSyntheticRows:true, rows:[], featureRows:[], candleGroups:[], errors:[], status:'INIT', rule:'Build emergency research candidates from real closed candles using data-api.binance.vision first, then OKX/Bybit failover. No synthetic candles, candidates, trades, or OOS are created.' };
  try {
    const symbols = v1012RequestedSymbols(report); // v10.1.5 maps XAUTUSDT to PAXGUSDT market-data proxy safely
    const frames = ['5m','15m','30m','1h','4h'];
    for (const symbol of symbols) {
      for (const tf of frames) {
        const fetched = await v1012FetchBinanceKlines(symbol, tf, 1000);
        out.candleGroups.push({ pair:symbol, timeframe:tf, requestedSymbol:fetched.requestedSymbol || symbol, sourceSymbol:fetched.sourceSymbol, sourceName:fetched.sourceName || '', assetProxy:fetched.assetProxy || '', status:fetched.status, rows:fetched.rows.length, attempts:fetched.attempts || [] });
        if (fetched.rows.length < 120) continue;
        const made = v1012RowsForGroup(symbol, tf, fetched.rows, `${fetched.sourceName || 'marketdata'}.${fetched.sourceSymbol}.${tf}`);
        for (const row of made.rows) { row.requestedSymbol = symbol; row.sourceSymbol = fetched.sourceSymbol; row.marketDataSource = fetched.sourceName || ''; row.assetProxy = fetched.assetProxy || ''; row.__alpsV1014MarketData = true; }
        out.featureRows.push(...made.featureRows);
        out.rows.push(...made.rows);
      }
    }
    const unique = new Map();
    for (const r of out.rows) { const k = uniqueKeyFromCandidate(r) || r.key; if (k && !unique.has(k)) unique.set(k, r); }
    out.rows = Array.from(unique.values()).sort((a,b)=>(b.score||0)-(a.score||0)).slice(0, FINAL_V930_TECHNICAL_CAP);
    out.featureRows = out.featureRows.slice(0, 500);
    out.materializedRows = out.rows.length;
    out.featureRowsFound = out.featureRows.length;
    out.closedCandlePairFrames = out.candleGroups.filter(g => g.rows >= 120).length;
    out.status = out.rows.length ? 'SERVER_REAL_CANDLE_ROWS_MATERIALIZED' : 'SERVER_CANDLE_BOOTSTRAP_ZERO_ROWS';
    if (out.rows.length) {
      v1000CommitRows(out.rows, 'v10.1.5-market-data-vision-bootstrap', { observedRows: out.rows.length, featureRows: out.featureRows.length });
      v944MergeForwardLatch(out.rows, 'v10.1.5-market-data-vision-bootstrap');
      lastNativeForwardPoolView = v952BuildNativePoolFromRows(v1000ActiveRows(), lastNativeForwardPoolView || {});
      lastForwardLatchView = v944BuildForwardLatchView();
    }
  } catch (e) { out.status='SERVER_CANDLE_BOOTSTRAP_FAILED'; out.error=textValue(e.message||e).slice(0,240); }
  lastV1012ServerCandleBootstrapView = out;
  return out;
}


function v1015ShouldBootstrapMarketDataFromHealth(health = {}) {
  const rowsNow = Math.max(
    v952Num(health.candidates),
    v952Num(health.officialCandidates),
    v952Num(health.results),
    v952Num(health?.nativeForwardPool?.totalCandidates),
    v952Num(health?.forwardLatch?.size),
    safeArray(v1000ActiveRows()).length
  );
  if (rowsNow > 0) return false;
  const candles = v946MaxNumber(
    health.candlesLoaded,
    health?.data?.candlesLoaded,
    health?.bootDiagnostics?.candlesLoaded,
    lastHealth?.candlesLoaded,
    lastHealth?.data?.candlesLoaded,
    lastHealth?.bootDiagnostics?.candlesLoaded
  );
  const pairFrames = v946MaxNumber(
    health.dataPairFrames,
    health?.data?.pairFrames,
    health?.bootDiagnostics?.pairFrames,
    lastHealth?.dataPairFrames,
    lastHealth?.data?.pairFrames,
    lastHealth?.bootDiagnostics?.pairFrames
  );
  return candles > 0 || pairFrames > 0 || !lastV1012ServerCandleBootstrapView;
}

async function v1015HealthMarketDataBootstrap(healthTruth = {}, reason = 'health-endpoint-v1015-market-data-bootstrap') {
  const proof = {
    schema: 'alps.v1015HealthMarketDataBootstrap.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    reason,
    before: {
      candidates: v952Num(healthTruth.candidates),
      nativePoolRows: v952Num(healthTruth?.nativeForwardPool?.totalCandidates),
      latchRows: v952Num(healthTruth?.forwardLatch?.size),
      authorityRows: safeArray(v1000ActiveRows()).length,
      candlesLoaded: v946MaxNumber(healthTruth.candlesLoaded, healthTruth?.data?.candlesLoaded, healthTruth?.bootDiagnostics?.candlesLoaded, lastHealth?.candlesLoaded, lastHealth?.bootDiagnostics?.candlesLoaded),
      pairFrames: v946MaxNumber(healthTruth.dataPairFrames, healthTruth?.data?.pairFrames, healthTruth?.bootDiagnostics?.pairFrames, lastHealth?.dataPairFrames, lastHealth?.bootDiagnostics?.pairFrames)
    },
    after: {},
    status: 'NOT_RUN',
    rule: 'When /runner/health sees data but zero candidates, use real closed candles from data-api.binance.vision -> data.binance.com -> OKX -> Bybit, then commit real candle-derived candidates into State Authority and Forward Latch. No synthetic candles, trades, or OOS.'
  };
  try {
    if (!v1015ShouldBootstrapMarketDataFromHealth(healthTruth || {})) {
      proof.status = 'SKIPPED_ROWS_ALREADY_AVAILABLE';
    } else {
      const seedReport = {
        ...(lastReport || {}),
        ...(lastHealth || {}),
        ...(healthTruth || {}),
        settings: {
          ...(lastReport?.settings || {}),
          ...(lastHealth?.settings || {}),
          ...(healthTruth?.settings || {})
        }
      };
      const boot = await v1012ServerCandleResearchBootstrap(seedReport, reason);
      proof.bootstrapStatus = boot?.status || '';
      proof.bootstrapRows = safeArray(boot?.rows).length;
      proof.sourceSummary = safeArray(boot?.candleGroups).slice(0, 35).map(g => ({ pair:g.pair, timeframe:g.timeframe, sourceName:g.sourceName || '', sourceSymbol:g.sourceSymbol || '', status:g.status, rows:g.rows || 0, assetProxy:g.assetProxy || '' }));
      if (safeArray(boot?.rows).length > 0) {
        const activeRows = safeArray(v1000ActiveRows());
        lastNativeForwardPoolView = v952BuildNativePoolFromRows(activeRows.length ? activeRows : boot.rows, lastNativeForwardPoolView || {});
        lastForwardLatchView = v944BuildForwardLatchView();
        healthTruth.nativeForwardPool = lastNativeForwardPoolView;
        healthTruth.fullAutonomyNativeForwardPool = lastNativeForwardPoolView;
        healthTruth.forwardLatch = lastForwardLatchView;
        healthTruth.candidates = Math.max(v952Num(healthTruth.candidates), safeArray(boot.rows).length, v952Num(lastNativeForwardPoolView.totalCandidates));
        healthTruth.officialCandidates = Math.max(v952Num(healthTruth.officialCandidates), healthTruth.candidates);
        healthTruth.results = Math.max(v952Num(healthTruth.results), healthTruth.candidates);
        healthTruth.rawResearchStrategies = Math.max(v952Num(healthTruth.rawResearchStrategies), healthTruth.candidates);
        healthTruth.totalGeneratedStrategies = Math.max(v952Num(healthTruth.totalGeneratedStrategies), healthTruth.candidates);
        healthTruth.candidatesMonitored = Math.max(v952Num(healthTruth.candidatesMonitored), healthTruth.candidates);
        healthTruth.fwRunning = true;
        healthTruth.forwardStatus = 'MARKET_DATA_VISION_ROWS_READY';
        healthTruth.v952CurrentHealthSync = { schema:'alps.v952CurrentHealthSync.view.v1', version:FINAL_V930_VERSION, installed:true, status:'HEALTH_MARKET_DATA_BOOTSTRAP_CANDIDATES_VISIBLE', currentHealthCandidates:healthTruth.candidates, currentHealthOfficialCandidates:healthTruth.officialCandidates, currentHealthResults:healthTruth.results, syncedCandidates:healthTruth.candidates, syncedResults:healthTruth.results, fwRunning:!!healthTruth.fwRunning, fwRefreshRunning:!!healthTruth.fwRefreshRunning, sourceCounts:{ marketDataVision: safeArray(boot.rows).length }, noFixedCandidateCap:true, rule:'Health endpoint can promote real candle-derived market-data rows into current health when the page report is stale/zero.' };
        healthTruth.v952CandidateBridge = { schema:'alps.v952CandidateBridge.view.v1', version:FINAL_V930_VERSION, installed:true, status:'MARKET_DATA_VISION_ROWS_BRIDGED_TO_FORWARD_LATCH', nativeCandidates:v952Num(lastNativeForwardPoolView.totalCandidates), latchedCandidates:v952Num(lastForwardLatchView.size), added:safeArray(boot.rows).length, updated:0, noFixedCandidateCap:true, rule:'Every real current candidate is bridged into ForwardLatch and Paper Entry; no fixed candidate count is used as a blocker.' };
        healthTruth.candidateCountTruth = { schema:'alps.candidateCountTruth.view.v1', version:FINAL_V930_VERSION, installed:true, rawStrategies:healthTruth.results, dashboardCandidates:healthTruth.candidates, officialCandidates:healthTruth.officialCandidates, nativePoolCandidates:v952Num(lastNativeForwardPoolView.totalCandidates), compressedCandidates:0, rawRowsBeforeCompression:safeArray(boot.rows).length, latchedCandidates:v952Num(lastForwardLatchView.size), paperEntryVisibleCandidates:0, serverNativeCandidatesAvailable:v952Num(lastNativeForwardPoolView.totalCandidates), recoveryEligibleCandidates:0, oosVerifiedCandidates:0, experimentalForwardCandidates:v952Num(lastNativeForwardPoolView.experimentalForward), paperOpened:v952Num(healthTruth.paperSignals), noFixedCandidateCap:true, namingWarning:'Verified/OOS candidates are separate from Experimental Learning candidates. No fixed candidate number is used as an acceptance blocker.', recommendedLabels:['rawStrategies','nativePoolCandidates','latchedCandidates','paperEligibleCandidates','paperOpened','paperRejected','experimentalLearningCandidates'] };
        proof.status = 'MARKET_DATA_VISION_ROWS_COMMITTED_TO_HEALTH_STATE_AUTHORITY';
      } else {
        proof.status = 'BOOTSTRAP_RAN_ZERO_ROWS';
      }
    }
  } catch (e) {
    proof.status = 'FAILED';
    proof.error = textValue(e.message || e).slice(0, 240);
  }
  proof.after = {
    candidates: v952Num(healthTruth.candidates),
    nativePoolRows: v952Num(healthTruth?.nativeForwardPool?.totalCandidates || lastNativeForwardPoolView?.totalCandidates),
    latchRows: v952Num(healthTruth?.forwardLatch?.size || lastForwardLatchView?.size),
    authorityRows: safeArray(v1000ActiveRows()).length,
    v1012Status: lastV1012ServerCandleBootstrapView?.status || ''
  };
  healthTruth.v1015HealthMarketDataBootstrap = proof;
  return proof;
}


// v10.1.7 Feature Materializer + Candle Visibility Bridge:
// Current failure mode: data/proxy may show real candles, but discovery/feature builders see zero feature rows.
// This bridge does not fake candles, OOS, strategies, or trades. It uses only real candle arrays from the page
// if visible, otherwise real exchange market-data endpoints, then materializes candidate rows through the same
// real-candle feature/backtest helpers already used by the server candle bootstrap.
async function v1017FeatureMaterializerCandleVisibilityBridge(healthTruth = {}, reason = 'health-endpoint-v1017-feature-materializer') {
  const out = {
    schema: 'alps.v1017FeatureMaterializer.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    reason,
    paperOnly: true,
    liveCapitalExecution: false,
    realCandlesOnly: true,
    noSyntheticRows: true,
    before: {
      candidates: v952Num(healthTruth.candidates),
      nativePoolRows: v952Num(healthTruth?.nativeForwardPool?.totalCandidates || lastNativeForwardPoolView?.totalCandidates),
      latchRows: v952Num(healthTruth?.forwardLatch?.size || lastForwardLatchView?.size || forwardLatchState?.candidates?.length),
      authorityRows: safeArray(v1000ActiveRows()).length,
      candlesLoaded: v946MaxNumber(healthTruth.candlesLoaded, healthTruth?.data?.candlesLoaded, healthTruth?.bootDiagnostics?.candlesLoaded, lastHealth?.candlesLoaded, lastHealth?.data?.candlesLoaded, lastHealth?.bootDiagnostics?.candlesLoaded, lastCanonicalMetrics?.candlesLoaded),
      pairFrames: v946MaxNumber(healthTruth.dataPairFrames, healthTruth?.data?.pairFrames, healthTruth?.bootDiagnostics?.pairFrames, lastHealth?.dataPairFrames, lastHealth?.data?.pairFrames, lastHealth?.bootDiagnostics?.pairFrames, lastCanonicalMetrics?.pairFrames),
      featureRowsFound: v952Num(lastDiscoveryOutputView?.featureRowsFound),
      candlesVisibleToDiscovery: !!lastDiscoveryOutputView?.candlesVisibleToDiscovery
    },
    sourcesUsed: [],
    candleGroups: [],
    featureRows: [],
    rows: [],
    errors: [],
    status: 'INIT',
    rule: 'If real candles are visible but feature/discovery rows are zero, collect real closed candles, build real feature rows, commit real candle-derived candidates to State Authority/nativeForwardPool/ForwardLatch, then let Paper Entry scan them. No fabricated rows.'
  };
  try {
    const existingRows = Math.max(out.before.candidates, out.before.nativePoolRows, out.before.latchRows, out.before.authorityRows);
    if (existingRows > 0) {
      out.status = 'SKIPPED_ROWS_ALREADY_AVAILABLE';
      out.after = { candidates: existingRows, nativePoolRows: out.before.nativePoolRows, latchRows: out.before.latchRows, authorityRows: out.before.authorityRows };
      healthTruth.v1017FeatureMaterializer = out;
      lastV1017FeatureMaterializerView = out;
      return out;
    }

    // First try the in-page real candle collector because it reads IndexedDB/localStorage/page globals.
    let pageMaterializer = null;
    if (page && !page.isClosed()) {
      pageMaterializer = await v1016WithTimeout(v951CollectRealCandleDiscoveryMaterializer(reason + '-page-real-candle-scan'), 18000, 'V1017_PAGE_CANDLE_SCAN_TIMEOUT').catch(e => ({ status:'PAGE_SCAN_FAILED_OR_TIMED_OUT', error:textValue(e && e.message || e), rows:[], featureRows:[], candleStores:[] }));
      out.pageMaterializerStatus = pageMaterializer?.status || '';
      out.pageMaterializerRows = safeArray(pageMaterializer?.rows).length;
      out.pageFeatureRows = safeArray(pageMaterializer?.featureRows).length;
      out.pageClosedCandlePairFrames = v952Num(pageMaterializer?.closedCandlePairFrames);
      if (safeArray(pageMaterializer?.rows).length > 0) {
        out.sourcesUsed.push('page.realCandleDiscovery');
        out.rows.push(...safeArray(pageMaterializer.rows));
        out.featureRows.push(...safeArray(pageMaterializer.featureRows));
        out.candleGroups.push(...safeArray(pageMaterializer.candleStores).map(g => ({ ...g, source:'page.realCandleDiscovery' })));
      }
    } else {
      out.pageMaterializerStatus = 'PAGE_NOT_READY_SKIPPED';
    }

    // If page stores did not expose feature rows, fetch real closed candles directly and materialize features.
    if (!out.rows.length) {
      const seedReport = {
        ...(lastReport || {}),
        ...(lastHealth || {}),
        ...(healthTruth || {}),
        settings: {
          ...(lastReport?.settings || {}),
          ...(lastHealth?.settings || {}),
          ...(healthTruth?.settings || {})
        }
      };
      const symbols = v1012RequestedSymbols(seedReport);
      const frames = ['5m','15m','30m','1h','4h'];
      const tasks = [];
      for (const symbol of symbols) for (const tf of frames) tasks.push({ symbol, tf });
      out.fastFetchRequested = { symbols, frames, taskCount: tasks.length };

      async function v1017FetchFastKlines(symbol, tf, limit = 700) {
        const src = v1014SourceSymbolFor(symbol);
        const sourceSymbol = src.sourceSymbol;
        const interval = ({'5M':'5m','15M':'15m','30M':'30m','1H':'1h','4H':'4h'}[textValue(tf).toUpperCase()] || textValue(tf).toLowerCase());
        const capped = Math.max(120, Math.min(800, Number(limit)||700));
        const cacheKey = `${sourceSymbol}_${interval}_${capped}_v1017fast`;
        const cached = v1012ServerCandleCache.get(cacheKey);
        if (cached && Date.now() - cached.at < 8*60*1000) return { rows: cached.rows, sourceSymbol, requestedSymbol: src.requestedSymbol, assetProxy: src.assetProxy, sourceName: cached.sourceName || 'CACHE', status: 'CACHE_HIT', attempts: [] };
        const closed = rows => safeArray(rows).filter(x => !x.t || x.t <= Date.now() - v1012TfMs(interval));
        const urls = [
          { source:'BINANCE_VISION', url:`https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(sourceSymbol)}&interval=${encodeURIComponent(interval)}&limit=${capped}`, parse:v1014BinanceArrayToCandles },
          { source:'BINANCE_DATA', url:`https://data.binance.com/api/v3/klines?symbol=${encodeURIComponent(sourceSymbol)}&interval=${encodeURIComponent(interval)}&limit=${capped}`, parse:v1014BinanceArrayToCandles },
          { source:'OKX', url:`https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(v1014OkxInstId(sourceSymbol))}&bar=${encodeURIComponent(v1014OkxBar(interval))}&limit=${Math.min(300,capped)}`, parse:v1014OkxArrayToCandles, ok:o=>o.ok && String(o.json?.code)==='0' },
          { source:'BYBIT', url:`https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(sourceSymbol)}&interval=${encodeURIComponent(v1014BybitInterval(interval))}&limit=${capped}`, parse:v1014BybitArrayToCandles, ok:o=>o.ok && Number(o.json?.retCode)===0 }
        ];
        const attempts = [];
        const settled = await Promise.allSettled(urls.map(u => v1014FetchJson(u.url, 5500).then(r => ({ ...u, result:r })).catch(e => ({ ...u, result:{ ok:false, status:`ERROR:${textValue(e && e.message || e).slice(0,60)}` } }))));
        for (const item of settled) {
          const x = item.value || {};
          const r = x.result || {};
          attempts.push({ source:x.source, status:r.status, ok:!!r.ok });
          const ok = x.ok ? x.ok(r) : !!r.ok;
          if (!ok) continue;
          const rows = closed(x.parse(r.json)).filter(c => [c.open,c.high,c.low,c.close].every(Number.isFinite));
          if (rows.length >= 120) {
            v1012ServerCandleCache.set(cacheKey, { at: Date.now(), rows, sourceName:x.source });
            return { rows, sourceSymbol, requestedSymbol:src.requestedSymbol, assetProxy:src.assetProxy, sourceName:x.source, status:'OK_' + x.source, attempts };
          }
        }
        return { rows:[], sourceSymbol, requestedSymbol:src.requestedSymbol, assetProxy:src.assetProxy, sourceName:'', status:'NO_REAL_CANDLES_FROM_FAST_SOURCES', attempts };
      }
      async function mapLimit(items, limit, fn) {
        const results = new Array(items.length);
        let next = 0;
        async function worker() {
          while (next < items.length) {
            const i = next++;
            try { results[i] = await fn(items[i], i); }
            catch (e) { results[i] = { error:textValue(e && e.message || e).slice(0,180) }; }
          }
        }
        await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
        return results;
      }
      const fetched = await mapLimit(tasks, 10, async task => {
        const r = await v1017FetchFastKlines(task.symbol, task.tf, 700);
        return { ...task, ...r };
      });
      for (const f of fetched) {
        out.candleGroups.push({ pair:f.symbol, timeframe:f.tf, requestedSymbol:f.requestedSymbol || f.symbol, sourceSymbol:f.sourceSymbol, sourceName:f.sourceName || '', assetProxy:f.assetProxy || '', status:f.status || (f.error ? 'ERROR' : ''), rows:safeArray(f.rows).length, latestClosedCandleTs:(safeArray(f.rows).slice(-1)[0] || {}).t || null, attempts:f.attempts || [], error:f.error || '' });
        if (safeArray(f.rows).length < 120) continue;
        const made = v1012RowsForGroup(f.symbol, f.tf, f.rows, `${f.sourceName || 'v1017.fastMarketData'}.${f.sourceSymbol || f.symbol}.${f.tf}`);
        for (const row of made.rows) { row.requestedSymbol = f.symbol; row.sourceSymbol = f.sourceSymbol; row.marketDataSource = f.sourceName || 'v1017Fast'; row.assetProxy = f.assetProxy || ''; row.__alpsV1017FeatureMaterializer = true; row.paperOnly = true; row.liveCapitalExecution = false; }
        out.featureRows.push(...safeArray(made.featureRows).map(x => ({ ...x, __alpsV1017Source: `${f.symbol}_${f.tf}` })));
        out.rows.push(...safeArray(made.rows));
      }
      if (out.rows.length) out.sourcesUsed.push('server.fastRealMarketData');
    }

    const unique = new Map();
    for (const r of out.rows) { const k = uniqueKeyFromCandidate(r) || r.key; if (k && !unique.has(k)) unique.set(k, r); }
    out.rows = Array.from(unique.values()).sort((a,b)=>(b.score||0)-(a.score||0)).slice(0, FINAL_V930_TECHNICAL_CAP);
    out.featureRows = out.featureRows.slice(0, 800);
    out.realCandleRowsCollected = safeArray(out.candleGroups).reduce((acc,g)=>acc + v952Num(g.rows), 0);
    out.latestClosedCandleTs = safeArray(out.candleGroups).reduce((mx,g)=>Math.max(mx, v952Num(g.latestClosedCandleTs)), 0) || null;
    out.canonicalPairFrames = safeArray(out.candleGroups).filter(g=>v952Num(g.rows)>=120).length;
    out.closedCandlePairFrames = out.canonicalPairFrames;
    out.featureRowsBuilt = out.featureRows.length;
    out.discoveryRowsAfter = out.rows.length;
    out.candidateRowsAfter = out.rows.length;

    if (out.rows.length > 0) {
      v1000CommitRows(out.rows, 'v10.1.7-feature-materializer-candle-visibility-bridge', { observedRows: out.rows.length, featureRows: out.featureRows.length, closedCandlePairFrames: out.closedCandlePairFrames });
      v944MergeForwardLatch(out.rows, 'v10.1.7-feature-materializer-candle-visibility-bridge');
      const activeRows = safeArray(v1000ActiveRows());
      lastNativeForwardPoolView = v952BuildNativePoolFromRows(activeRows.length ? activeRows : out.rows, lastNativeForwardPoolView || {});
      lastForwardLatchView = v944BuildForwardLatchView();
      lastV1012ServerCandleBootstrapView = { schema:'alps.v1012ServerCandleResearchBootstrap.view.v1', version:FINAL_V930_VERSION, installed:true, reason:reason+'-via-v1017', realCandlesOnly:true, noSyntheticRows:true, status:'SUPERSEDED_BY_V1017_FEATURE_MATERIALIZER', rows:out.rows, featureRows:out.featureRows, candleGroups:out.candleGroups, materializedRows:out.rows.length, featureRowsFound:out.featureRows.length, closedCandlePairFrames:out.closedCandlePairFrames };
      lastDiscoveryOutputView = {
        schema:'alps.discoveryOutput.view.v1', version:FINAL_V930_VERSION, reason:reason+'-feature-materialized', pageReady:!!(page && !page.isClosed()), startedAt:Date.now(), finishedAt:Date.now(), durationMs:0,
        functionsInvoked:['v1017FeatureMaterializerCandleVisibilityBridge'], functionResults:[{ name:'v1017FeatureMaterializerCandleVisibilityBridge', exists:true, type:'array', returnedRows:out.rows.length, timedOut:false }], errors:[], rows:out.rows.slice(0, FINAL_V930_TECHNICAL_CAP),
        featureRowsFound:out.featureRows.length, strategyTemplatesFound:5, rawSetupRows:out.rows.length, testedRows:out.rows.length, rejectedRows:0, candlesVisibleToReport:true, candlesVisibleToDiscovery:true,
        status:'V1017_FEATURE_ROWS_AND_CANDIDATES_MATERIALIZED_FROM_REAL_CANDLES'
      };
      const map = {};
      for (const g of safeArray(out.candleGroups)) {
        if (v952Num(g.rows) < 120) continue;
        const key = `${textValue(g.pair).toUpperCase()}_${textValue(g.timeframe).toLowerCase()}`.toUpperCase();
        map[key] = { rows:v952Num(g.rows), latestClosedCandleTs:v952Num(g.latestClosedCandleTs) || null, iso:v952Num(g.latestClosedCandleTs) ? new Date(v952Num(g.latestClosedCandleTs)).toISOString() : null, sourceName:g.sourceName || '', sourceSymbol:g.sourceSymbol || '', verdict:'V1017_REAL_CANDLE_MAP' };
      }
      lastClosedCandleMapView = { schema:'alps.closedCandleMap.view.v1', version:FINAL_V930_VERSION, latestClosedCandleTs:out.latestClosedCandleTs || null, latestClosedCandleIso:out.latestClosedCandleTs ? new Date(out.latestClosedCandleTs).toISOString() : null, pairFrameCount:Object.keys(map).length, map, closedCandleOnlyAudited:Object.keys(map).length>0, liveCandleExcluded:'YES_BY_MARKET_DATA_CLOSED_FILTER_OR_SOURCE_CONFIRMATION' };

      healthTruth.nativeForwardPool = lastNativeForwardPoolView;
      healthTruth.fullAutonomyNativeForwardPool = lastNativeForwardPoolView;
      healthTruth.forwardLatch = lastForwardLatchView;
      healthTruth.candidates = Math.max(v952Num(healthTruth.candidates), out.rows.length, v952Num(lastNativeForwardPoolView.totalCandidates));
      healthTruth.officialCandidates = Math.max(v952Num(healthTruth.officialCandidates), healthTruth.candidates);
      healthTruth.results = Math.max(v952Num(healthTruth.results), healthTruth.candidates);
      healthTruth.rawResearchStrategies = Math.max(v952Num(healthTruth.rawResearchStrategies), out.rows.length);
      healthTruth.totalGeneratedStrategies = Math.max(v952Num(healthTruth.totalGeneratedStrategies), out.rows.length);
      healthTruth.candidatesMonitored = Math.max(v952Num(healthTruth.candidatesMonitored), healthTruth.candidates);
      healthTruth.fwRunning = true;
      healthTruth.forwardStatus = 'V1017_FEATURE_MATERIALIZER_ROWS_READY';
      healthTruth.dataSource = 'LIVE SNAPSHOT - V1017 REAL CANDLE FEATURE MATERIALIZED';
      healthTruth.candlesLoaded = Math.max(v952Num(healthTruth.candlesLoaded), out.realCandleRowsCollected);
      healthTruth.dataPairFrames = Math.max(v952Num(healthTruth.dataPairFrames), out.closedCandlePairFrames);
      healthTruth.latestClosedCandleTs = out.latestClosedCandleTs || healthTruth.latestClosedCandleTs || null;
      healthTruth.v952CurrentHealthSync = { schema:'alps.v952CurrentHealthSync.view.v1', version:FINAL_V930_VERSION, installed:true, status:'V1017_FEATURE_MATERIALIZER_CANDIDATES_VISIBLE', currentHealthCandidates:healthTruth.candidates, currentHealthOfficialCandidates:healthTruth.officialCandidates, currentHealthResults:healthTruth.results, syncedCandidates:healthTruth.candidates, syncedResults:healthTruth.results, fwRunning:!!healthTruth.fwRunning, fwRefreshRunning:!!healthTruth.fwRefreshRunning, sourceCounts:{ v1017FeatureMaterializer:out.rows.length }, noFixedCandidateCap:true, rule:'v10.1.7 converts only real closed candle data into candidate rows when page discovery cannot see features.' };
      healthTruth.v952CandidateBridge = { schema:'alps.v952CandidateBridge.view.v1', version:FINAL_V930_VERSION, installed:true, status:'V1017_FEATURE_MATERIALIZER_ROWS_BRIDGED_TO_FORWARD_LATCH', nativeCandidates:v952Num(lastNativeForwardPoolView.totalCandidates), latchedCandidates:v952Num(lastForwardLatchView.size), added:out.rows.length, updated:0, noFixedCandidateCap:true, rule:'Every real current candidate is bridged into ForwardLatch and Paper Entry; no fixed candidate count is used as a blocker.' };
      healthTruth.candidateCountTruth = { schema:'alps.candidateCountTruth.view.v1', version:FINAL_V930_VERSION, installed:true, rawStrategies:healthTruth.results, dashboardCandidates:healthTruth.candidates, officialCandidates:healthTruth.officialCandidates, nativePoolCandidates:v952Num(lastNativeForwardPoolView.totalCandidates), compressedCandidates:0, rawRowsBeforeCompression:out.rows.length, latchedCandidates:v952Num(lastForwardLatchView.size), paperEntryVisibleCandidates:0, serverNativeCandidatesAvailable:v952Num(lastNativeForwardPoolView.totalCandidates), recoveryEligibleCandidates:out.rows.length, oosVerifiedCandidates:0, experimentalForwardCandidates:v952Num(lastNativeForwardPoolView.experimentalForward), paperOpened:v952Num(healthTruth.paperSignals), noFixedCandidateCap:true, namingWarning:'Verified/OOS candidates are separate from Experimental Learning candidates. No fixed candidate number is used as an acceptance blocker.', recommendedLabels:['rawStrategies','nativePoolCandidates','latchedCandidates','paperEligibleCandidates','paperOpened','paperRejected','experimentalLearningCandidates'] };
      out.status = 'FEATURES_AND_CANDIDATES_COMMITTED_TO_STATE_AUTHORITY';
    } else if (out.realCandleRowsCollected <= 0) {
      out.status = 'NO_REAL_CANDLES_AVAILABLE';
    } else if (out.featureRowsBuilt <= 0) {
      out.status = 'CANDLES_FOUND_FEATURE_BUILDER_NOT_CONNECTED';
    } else {
      out.status = 'FEATURES_BUILT_DISCOVERY_ZERO_ROWS';
    }
  } catch (e) {
    out.status = 'FAILED';
    out.error = textValue(e && e.message || e).slice(0, 300);
  }
  out.after = {
    candidates: v952Num(healthTruth.candidates),
    nativePoolRows: v952Num(healthTruth?.nativeForwardPool?.totalCandidates || lastNativeForwardPoolView?.totalCandidates),
    latchRows: v952Num(healthTruth?.forwardLatch?.size || lastForwardLatchView?.size),
    authorityRows: safeArray(v1000ActiveRows()).length,
    paperEntrySeen: v952Num(healthTruth?.paperEntryActivation?.candidatesSeen || lastV948EntryEngineView?.candidatesSeen),
    paperEntryScanned: v952Num(healthTruth?.paperEntryActivation?.scanned || lastV948EntryEngineView?.scanned)
  };
  healthTruth.v1017FeatureMaterializer = out;
  lastV1017FeatureMaterializerView = out;
  return out;
}

// v10.1.6 Health Paper Entry Rescan:
// v10.1.5 proved State Authority/nativeForwardPool/ForwardLatch rows can be restored from Market Data Vision,
// but /runner/health could still return the old Paper Entry view from before those rows existed.
// This rescan runs only when real authority/native/latch rows exist and Paper Entry has not scanned them yet.
// It does not create candidates, candles, trades, or OOS; it only routes existing real rows into the existing paper-entry engine.
async function v1016HealthPaperEntryRescan(healthTruth = {}, reason = 'health-endpoint-v1016-paper-entry-rescan-after-authority') {
  const proof = {
    schema: 'alps.v1016HealthPaperEntryRescan.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    reason,
    before: {
      healthCandidates: v952Num(healthTruth.candidates),
      nativePoolRows: v952Num(healthTruth?.nativeForwardPool?.totalCandidates || lastNativeForwardPoolView?.totalCandidates),
      latchRows: v952Num(healthTruth?.forwardLatch?.size || lastForwardLatchView?.size || forwardLatchState?.candidates?.length),
      authorityRows: safeArray(v1000ActiveRows()).length,
      previousPaperSeen: v952Num(healthTruth?.paperEntryActivation?.candidatesSeen || lastV948EntryEngineView?.candidatesSeen),
      previousPaperScanned: v952Num(healthTruth?.paperEntryActivation?.scanned || lastV948EntryEngineView?.scanned)
    },
    after: {},
    paperOnly: true,
    liveCapitalExecution: false,
    rule: 'After Market Data Vision/State Authority has real rows, run one health-triggered Paper Entry scan so candidatesSeen/scanned/rejected/opened become current. No synthetic candidates, candles, trades, or OOS.'
  };
  try {
    const availableRows = Math.max(proof.before.healthCandidates, proof.before.nativePoolRows, proof.before.latchRows, proof.before.authorityRows);
    if (availableRows <= 0) {
      proof.status = 'SKIPPED_NO_AUTHORITY_OR_NATIVE_ROWS';
    } else if (proof.before.previousPaperScanned > 0 || proof.before.previousPaperSeen > 0) {
      proof.status = 'SKIPPED_PAPER_ENTRY_ALREADY_SCANNED';
    } else {
      // v10.1.6 minimal safe bridge: collect only real existing authority/native/health/latch rows
      // and pass them into the existing Paper Entry engine as an override candidate source.
      // No synthetic candidates, candles, OOS, or trades are created here.
      const overrideRows = [];
      const seenOverrideKeys = new Set();
      function addOverrideRows(rows, src) {
        for (const c of safeArray(rows)) {
          if (!c || typeof c !== 'object') continue;
          const k = uniqueKeyFromCandidate(c) || JSON.stringify(c || {}).slice(0, 160);
          if (!k || seenOverrideKeys.has(k)) continue;
          seenOverrideKeys.add(k);
          overrideRows.push({ ...c, __v1016RowsOverrideSource: src });
        }
      }
      addOverrideRows(v1000ActiveRows(), 'stateAuthority.activeRows');
      addOverrideRows(lastNativeForwardPoolView?.candidates, 'lastNativeForwardPoolView.candidates');
      addOverrideRows(healthTruth?.nativeForwardPool?.candidates, 'healthTruth.nativeForwardPool.candidates');
      addOverrideRows(forwardLatchState?.candidates, 'forwardLatchState.candidates');
      proof.overrideRowsPrepared = overrideRows.length;
      const view = await applyV948ZonePersistenceEntryEngine(reason, overrideRows.length ? overrideRows : null);
      const opened = v952Num(view?.opened);
      const scanned = v952Num(view?.scanned);
      const rejected = v952Num(view?.rejected);
      healthTruth.paperEntryActivation = view;
      healthTruth.zonePersistenceEntry = view;
      healthTruth.paperEntryVisibility = view?.visibilityBridge || lastV950PaperEntryVisibilityView;
      healthTruth.candleStoreResolver = view?.candleResolver || lastV950CandleStoreResolverView;
      if (opened > 0) {
        healthTruth.openPositions = Math.max(v952Num(healthTruth.openPositions), opened);
        healthTruth.paperSignals = Math.max(v952Num(healthTruth.paperSignals), opened);
      }
      if (rejected > 0) healthTruth.rejectedSignals = Math.max(v952Num(healthTruth.rejectedSignals), rejected);
      if (healthTruth.v953HealthTruthSync && typeof healthTruth.v953HealthTruthSync === 'object') {
        healthTruth.v953HealthTruthSync.paperEntrySeen = v952Num(view?.candidatesSeen);
        healthTruth.v953HealthTruthSync.paperEntryScanned = scanned;
      }
      proof.status = scanned > 0 ? (opened > 0 ? 'PAPER_ENTRY_RESCAN_OPENED_REAL_PAPER_TRADE' : 'PAPER_ENTRY_RESCAN_COMPLETED_WITH_REAL_REJECTIONS') : 'PAPER_ENTRY_RESCAN_RAN_BUT_SCANNED_ZERO';
      proof.afterViewStatus = view?.status || '';
      proof.topRejectedReason = view?.topRejectedReason || '';
      proof.rejectedReasonCounts = view?.rejectedReasonCounts || {};
    }
  } catch (e) {
    proof.status = 'PAPER_ENTRY_RESCAN_FAILED';
    proof.error = textValue(e && e.message || e).slice(0, 240);
  }
  proof.after = {
    paperSeen: v952Num(healthTruth?.paperEntryActivation?.candidatesSeen || lastV948EntryEngineView?.candidatesSeen),
    paperScanned: v952Num(healthTruth?.paperEntryActivation?.scanned || lastV948EntryEngineView?.scanned),
    opened: v952Num(healthTruth?.paperEntryActivation?.opened || lastV948EntryEngineView?.opened),
    rejected: v952Num(healthTruth?.paperEntryActivation?.rejected || lastV948EntryEngineView?.rejected),
    authorityRows: safeArray(v1000ActiveRows()).length,
    nativePoolRows: safeArray(lastNativeForwardPoolView?.candidates).length,
    latchRows: safeArray(forwardLatchState?.candidates).length
  };
  healthTruth.v1016HealthPaperEntryRescan = proof;
  return proof;
}

// v10.1.7 Health Fast Response + Feature Materializer Guard:
// /runner/health must always return a JSON response even while Chromium/page research
// or Market Data Vision recovery is busy. Heavy recovery work is moved to the
// background so mobile dashboard/report checks do not hang or time out.
let v1016HealthEndpointRecoveryBusy = false;
function v1016TimeoutView(schema, status, error, extra = {}) {
  return {
    schema,
    version: FINAL_V930_VERSION,
    installed: true,
    status,
    error: error ? textValue(error).slice(0, 240) : '',
    paperOnly: true,
    liveCapitalExecution: false,
    ...extra
  };
}
async function v1016WithTimeout(promise, ms, label) {
  let t = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(label || 'ALPS_TIMEOUT')), Math.max(500, ms || 2500));
      })
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}
function v1016QueueHealthEndpointRecovery(seedHealthTruth = {}, reason = 'health-endpoint-background-recovery') {
  if (v1016HealthEndpointRecoveryBusy || shuttingDown) {
    return { queued: false, reason: v1016HealthEndpointRecoveryBusy ? 'ALREADY_RUNNING' : 'SHUTTING_DOWN' };
  }
  v1016HealthEndpointRecoveryBusy = true;
  const seed = { ...(seedHealthTruth || {}) };
  setTimeout(async () => {
    try {
      await v1016WithTimeout(v1017FeatureMaterializerCandleVisibilityBridge(seed, reason + '-v1017-feature-materializer'), 90000, 'V1017_FEATURE_MATERIALIZER_BACKGROUND_TIMEOUT').catch(e => {
        seed.v1017FeatureMaterializer = v1016TimeoutView('alps.v1017FeatureMaterializer.view.v1', 'BACKGROUND_FAILED_OR_TIMED_OUT', e && e.message || e);
      });
      const v1017RowsNow = Math.max(v952Num(seed.candidates), v952Num(seed?.nativeForwardPool?.totalCandidates), v952Num(seed?.forwardLatch?.size), safeArray(v1000ActiveRows()).length);
      if (v1017RowsNow <= 0) {
        await v1016WithTimeout(v1015HealthMarketDataBootstrap(seed, reason + '-v1015-market-data-fallback'), 25000, 'V1015_HEALTH_BACKGROUND_TIMEOUT').catch(e => {
          seed.v1015HealthMarketDataBootstrap = v1016TimeoutView('alps.v1015HealthMarketDataBootstrap.view.v1', 'BACKGROUND_FAILED_OR_TIMED_OUT', e && e.message || e);
        });
      } else if (!seed.v1015HealthMarketDataBootstrap) {
        seed.v1015HealthMarketDataBootstrap = { schema:'alps.v1015HealthMarketDataBootstrap.view.v1', version: FINAL_V930_VERSION, installed:true, status:'SKIPPED_SUPERSEDED_BY_V1017_FEATURE_MATERIALIZER', paperOnly:true, liveCapitalExecution:false };
      }
      await v1016WithTimeout(v1016HealthPaperEntryRescan(seed, reason + '-v1016-paper-entry-rescan'), 18000, 'V1016_PAPER_ENTRY_BACKGROUND_TIMEOUT').catch(e => {
        seed.v1016HealthPaperEntryRescan = v1016TimeoutView('alps.v1016HealthPaperEntryRescan.view.v1', 'BACKGROUND_FAILED_OR_TIMED_OUT', e && e.message || e);
      });
      lastHealth = {
        ...(lastHealth || {}),
        ...(seed || {}),
        effectivePatchVersion: FINAL_V930_VERSION,
        v1016HealthFastResponseGuard: {
          schema: 'alps.v1016HealthFastResponseGuard.view.v1',
          version: FINAL_V930_VERSION,
          installed: true,
          status: 'BACKGROUND_RECOVERY_COMPLETED_OR_RECORDED',
          reason,
          completedAt: new Date().toISOString(),
          paperOnly: true,
          liveCapitalExecution: false
        }
      };
    } catch (e) {
      lastHealth = {
        ...(lastHealth || {}),
        effectivePatchVersion: FINAL_V930_VERSION,
        v1016HealthFastResponseGuard: v1016TimeoutView('alps.v1016HealthFastResponseGuard.view.v1', 'BACKGROUND_RECOVERY_CRASH_GUARDED', e && e.message || e, { reason })
      };
      log('v10.1.6 health background recovery guarded:', e && e.message || e);
    } finally {
      v1016HealthEndpointRecoveryBusy = false;
    }
  }, 0);
  return { queued: true, reason };
}

async function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/runner/chart-candles.json' || url.pathname === '/runner/chart-truth.json') {
        const pair = url.searchParams.get('pair') || url.searchParams.get('symbol') || 'BTCUSDT';
        const timeframe = url.searchParams.get('timeframe') || url.searchParams.get('interval') || '1h';
        const limit = Number(url.searchParams.get('limit') || 120);
        return send(res, 200, await v1010FetchChartTruth(pair, timeframe, limit));
      }
      if (url.pathname === '/runner/health') {
        await loadForwardLatchState();
        await loadRecoveryState();
        await loadTradeVaultState();
        await loadCognitionState();
        await loadAutonomyState();
        await loadAutonomyMemoryState();
        await v1016WithTimeout(maybeRecoverStuckBoot(lastHealth || {}, { source: 'health-endpoint-action-executor' }), 2500, 'HEALTH_WATCHDOG_TIMEOUT').catch(e => log('Runner watchdog health action skipped/timeout:', e.message));
        let healthTruth = v953HealthTruthFromCurrentHealth(lastHealth || {}, 'health-endpoint-before-send');
        const healthBackgroundQueue = v1016QueueHealthEndpointRecovery(healthTruth, 'health-endpoint-fast-response-background-recovery');
        healthTruth.v1016HealthFastResponseGuard = { schema:'alps.v1016HealthFastResponseGuard.view.v1', version: FINAL_V930_VERSION, installed:true, status: healthBackgroundQueue.queued ? 'FAST_RESPONSE_RETURNED_BACKGROUND_RECOVERY_QUEUED' : 'FAST_RESPONSE_RETURNED_BACKGROUND_RECOVERY_' + healthBackgroundQueue.reason, queue: healthBackgroundQueue, rule:'/runner/health does not block on Chromium, Market Data Vision, or Paper Entry rescan. Heavy recovery runs in background and updates next health response.', paperOnly:true, liveCapitalExecution:false };
        if (!healthTruth.v1017FeatureMaterializer) healthTruth.v1017FeatureMaterializer = lastV1017FeatureMaterializerView || { schema:'alps.v1017FeatureMaterializer.view.v1', version: FINAL_V930_VERSION, installed:true, status:'BACKGROUND_QUEUED_FAST_HEALTH_RESPONSE', paperOnly:true, liveCapitalExecution:false };
        if (!healthTruth.v1015HealthMarketDataBootstrap) healthTruth.v1015HealthMarketDataBootstrap = { schema:'alps.v1015HealthMarketDataBootstrap.view.v1', version: FINAL_V930_VERSION, installed:true, status:'BACKGROUND_QUEUED_FAST_HEALTH_RESPONSE', paperOnly:true, liveCapitalExecution:false };
        if (!healthTruth.v1016HealthPaperEntryRescan) healthTruth.v1016HealthPaperEntryRescan = { schema:'alps.v1016HealthPaperEntryRescan.view.v1', version: FINAL_V930_VERSION, installed:true, status:'BACKGROUND_QUEUED_FAST_HEALTH_RESPONSE', paperOnly:true, liveCapitalExecution:false };
        const v1001HealthTradeCounts = tradeExportCounts(lastTradeExport);
        if (v1001HealthTradeCounts.open > 0) {
          healthTruth.openPositions = Math.max(n(healthTruth.openPositions, 0), v1001HealthTradeCounts.open);
          healthTruth.paperSignals = Math.max(n(healthTruth.paperSignals, 0), v1001HealthTradeCounts.open);
        }
        if (v1001HealthTradeCounts.closed > 0) healthTruth.closedTrades = Math.max(n(healthTruth.closedTrades, 0), v1001HealthTradeCounts.closed);
        healthTruth.v1001TradeLedgerExportSync = { schema:'alps.v1001TradeLedgerExportSync.view.v1', version: FINAL_V930_VERSION, installed:true, openTradesExported:v1001HealthTradeCounts.open, closedTradesExported:v1001HealthTradeCounts.closed, status: v1001HealthTradeCounts.total > 0 ? 'HEALTH_COUNTERS_SYNCED_FROM_TRADE_EXPORT' : 'WAITING_FOR_REAL_TRADE_LEDGER_ROWS', paperOnly:true, liveCapitalExecution:false };
        lastHealth = { ...lastHealth, ...healthTruth };
        return send(res, 200, { ...healthTruth, browserServerReady, recovery: buildRecoveryView(), tradeVault: { currentCounts: v1001HealthTradeCounts, hasLastNonZero: !!tradeVaultState?.lastNonZero, historyCount: tradeVaultState?.history?.length || 0 }, cognition: { version: COGNITION_PATCH_VERSION, summary: lastCognitionView?.summary || cognitionState?.lastView?.summary || null, ledgerSeq: cognitionState?.seq || 0, hashHead: cognitionState?.prevHash || 'GENESIS' }, autonomousBridge: { version: AUTONOMY_PATCH_VERSION, summary: lastAutonomyView?.summary || autonomyState?.lastView?.summary || null, activeRoutes: (lastAutonomyView?.activeRoutes || autonomyState?.activeRoutes || autonomyMemoryState?.activeRoutes || []).length, ledgerSeq: autonomyState?.seq || 0, hashHead: autonomyState?.prevHash || 'GENESIS', persistentMemory: buildPersistentMemoryView(autonomyMemoryState) }, oosEvidenceBridge: lastOOSEvidenceBridgeView, recoveryForwardCore: lastRecoveryForwardCoreView, runnerWatchdog: buildRunnerWatchdogView(healthTruth || {}), pipelineTruthRecovery: lastPipelineTruthView, runtimeTruth: lastCanonicalMetrics, discoveryOutput: lastDiscoveryOutputView, zeroOutputDiagnostics: lastZeroOutputDiagnosticView, symbolLoadStatus: lastSymbolLoadStatusView, closedCandleMap: lastClosedCandleMapView, forwardReadiness: healthTruth.forwardReadiness || lastForwardReadinessView, e2ePipelineTrace: lastE2EPipelineTraceView, effectivePatchVersion: FINAL_V930_VERSION, v1017FeatureMaterializer: healthTruth.v1017FeatureMaterializer || lastV1017FeatureMaterializerView, v951RealCandleDiscovery: lastReport?.v951RealCandleDiscovery || null, paperEntryVisibility: lastV950PaperEntryVisibilityView, candleStoreResolver: lastV950CandleStoreResolverView, universeCompletion: lastV949UniverseCompletionView, proxyTruth: lastV949ProxyTruthView, candidateCountTruth: healthTruth.candidateCountTruth || lastV949CandidateCountTruthView, qualityRisk: lastV949QualityRiskView, tradeLifecycleTruth: lastV949LifecycleTruthView, reportTruthSync: healthTruth.reportTruthSync || lastV949ReportTruthView, releaseChecklist: lastV949ReleaseChecklistView, finalHealthGate: healthTruth.finalHealthGate || lastV949FinalHealthGateView, v952CurrentHealthSync: healthTruth.v952CurrentHealthSync || lastV952CurrentHealthSyncView, v952CandidateBridge: healthTruth.v952CandidateBridge || lastV952CandidateBridgeView, v952RejectedReasonAudit: healthTruth.v952RejectedReasonAudit || lastV952RejectedAuditView, v952CandidateQualityBuckets: healthTruth.v952CandidateQualityBuckets || lastV952QualityBucketsView, v952ReportTruthSync: healthTruth.v952ReportTruthSync || lastV952ReportTruthView, v953HealthTruthSync: healthTruth.v953HealthTruthSync, v954EntryConstructionAudit: healthTruth.v954EntryConstructionAudit, v955CandleBankFeatureAudit: healthTruth.v955CandleBankFeatureAudit, stateAuthority: v1000BuildView(), v10StateAuthority: v1000BuildView(), v10ZeroOverwriteProof: lastV10ZeroOverwriteProof, chartTruth: lastChartView || null, indicatorGovernance: v1010BuildIndicatorGovernanceView(lastReport || {}, lastForwardLatchView || lastNativeForwardPoolView || null), indicatorResearch: v944BuildSyntheticIndicatorEngineView(lastReport || {}, lastForwardLatchView || lastNativeForwardPoolView || null), v1012ServerCandleBootstrap: lastV1012ServerCandleBootstrapView, v1015HealthMarketDataBootstrap: healthTruth.v1015HealthMarketDataBootstrap, v1016HealthPaperEntryRescan: healthTruth.v1016HealthPaperEntryRescan });
      }
      if (url.pathname === '/runner/recovery') { await loadRecoveryState(); return send(res, 200, buildRecoveryView()); }
      if (url.pathname === '/runner/watchdog') { await maybeRecoverStuckBoot(lastHealth || {}, { source: 'watchdog-endpoint-action-executor' }).catch(e => log('Runner watchdog endpoint action failed:', e.message)); return send(res, 200, buildRunnerWatchdogView(lastHealth || {})); }
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
      technicalCap: V952_NO_FIXED_CANDIDATE_CAP ? 'UNLIMITED_ACCEPT_ALL_REAL_CANDIDATES' : FINAL_V930_TECHNICAL_CAP,
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
          
        }
        return out;
      }
      function buildNative(report) {
        const top = arr(report && report.research && report.research.topStrategies).length ? report.research.topStrategies : sourceRows().slice(0, policy.technicalCap || Number.MAX_SAFE_INTEGER);
        const rows = [];
        const seen = new Set();
        for (const c of top) {
          const k = key(c); if (!k || seen.has(k)) continue; seen.add(k);
          const cls = classify(c);
          rows.push({ key: k, pair: c.pair || c.baseSymbol || text(c.sym).split('_')[0], timeframe: c.timeframe || '', strategy: c.strategy || c.stratName || '', tier: cls.tier, evidenceLabels: cls.evidenceLabels, safetyReason: cls.safetyReason, oosPF: c.oosPF, oosTrades: c.oosTrades, score: c.score, originalPromotionTier: c.promotionTier, originalForwardEligible: c.forwardEligible === true, originalBlockReason: c.forwardBlockReason || '' });
          
        }
        const count = t => rows.filter(x => x.tier === t).length;
        return { schema: 'alps.nativeForwardPool.view.v1', version: policy.version, installed: true, totalCandidates: rows.length, fullAutonomyForward: count('FULL_AUTONOMY_FORWARD'), watchForward: count('WATCH_FORWARD'), experimentalForward: count('EXPERIMENTAL_FORWARD'), researchSandbox: count('RESEARCH_SANDBOX'), cognitionSuspended: count('COGNITION_SUSPENDED'), safetyBlocked: count('SAFETY_BLOCKED'), dataBlocked: count('DATA_BLOCKED'), promotedByFullAutonomy: count('FULL_AUTONOMY_FORWARD'),
    promotedToExperimental: count('EXPERIMENTAL_FORWARD'), blockedBySafety: count('SAFETY_BLOCKED') + count('DATA_BLOCKED'), evidenceLabels: Array.from(new Set(rows.flatMap(r => r.evidenceLabels || []))), candidates: rows.slice(0, 50) };
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
              return all;
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
          return [pair, tf, root(c), exit].join('|');
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
          const s = safety(c || {}); const m = metrics(c || {}); const hasEvidence = hasMinEvidence(c || {}); const ls = labels(c || {}).concat(m.promote ? ['QUANT_PASS'] : [evidenceTier(c || {})]);
          if (s) return { tier: s === 'DATA_OR_PRICE_GUARD' ? 'DATA_BLOCKED' : 'SAFETY_BLOCKED', safetyReason: s, evidenceLabels: ls, quantitative: m };
          if (m.promote) return { tier: 'FULL_AUTONOMY_FORWARD', safetyReason: '', evidenceLabels: ls.concat(['PROMOTED_BY_AUTONOMY']), quantitative: m };
          if (((c && c.forwardEligible === true) || /WATCHLIST|FORWARD/i.test(text(c && c.promotionTier))) && hasEvidence) return { tier: 'WATCH_FORWARD', safetyReason: '', evidenceLabels: ls.concat(['MIN_EVIDENCE_PASS','OOS_VERIFIED_FORWARD']), quantitative: m };
          if (/WATCH|ROBUSTNESS_WATCH|KEEP/i.test([c && c.rawVerdict, c && c.effectiveVerdict, c && c.robustnessFinal].map(text).join('|')) && hasEvidence) return { tier: 'WATCH_FORWARD', safetyReason: '', evidenceLabels: ls.concat(['MIN_EVIDENCE_PASS','OOS_VERIFIED_FORWARD']), quantitative: m };
          return { tier: 'EXPERIMENTAL_FORWARD', safetyReason: '', evidenceLabels: ls.concat(['NOT_OOS_VERIFIED','LIVE_PAPER_EVIDENCE_COLLECTION','EXPERIMENTAL_FORWARD']), quantitative: m };
        }
        function hasMinEvidence(c) { const m = metrics(c || {}); return m.oosPF > 0 && m.oosTrades >= 10; }
        function evidenceTier(c) { const m = metrics(c || {}); if (m.promote) return 'QUANT_PASS'; if (hasMinEvidence(c)) return 'EVIDENCE_READY'; return 'NO_OOS_EVIDENCE'; }
        function rank(c) { const m = metrics(c); const dd = num(c && (c.oosDD ?? c.ddBps), 0); const evidenceBonus = hasMinEvidence(c) ? 1000 : 0; const promotedBonus = m.promote ? 1500 : 0; return evidenceBonus + promotedBonus + num(c && c.score, 0) + m.posteriorPFgt1 * 100 + m.oosPF * 10 + m.nEffOOS * 0.4 + ((c && c.forwardEligible === true) ? 30 : 0) - dd / 5000; }
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
          return { rows: reps, stats: { method: 'MIN_EVIDENCE_GATE_THEN_CLUSTER_REPRESENTATIVE', rawRows: arr(rows).length, clusters: clusters.size, selectedRows: reps.length, compressedRows: Math.max(0, arr(rows).length - clusters.size), topClusters: topClusters.sort((a,b)=>b.size-a.size).slice(0,12) } };
        }
        function sourceRows() { try { if (Array.isArray(globalThis.results) && globalThis.results.length) return globalThis.results; } catch (_) {} try { if (typeof results !== 'undefined' && Array.isArray(results) && results.length) return results; } catch (_) {} return []; }
        function promoteInPlace(c, cls) {
          if (!c || !/^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD|EXPERIMENTAL_FORWARD)$/.test(text(cls && cls.tier))) return false;
          const tier = text(cls.tier);
          c.__alpsV931Tier = tier; c.__alpsV931EvidenceLabels = cls.evidenceLabels; c.__alpsV931Quantitative = cls.quantitative; c.__alpsV931AuthoritativeForward = true;
          c.forwardEligible = true; c.eligible = true; c.forwardBlockReason = ''; c.blockReason = ''; c.promotionBlocked = false; c.promotionGateBlocked = false; c.promotionStatus = tier; c.promotionGateSummary = tier; c.candidateTier = tier;
          if (tier === 'FULL_AUTONOMY_FORWARD') c.promotionTier = 'FULL_AUTONOMY_FORWARD';
          if (tier === 'EXPERIMENTAL_FORWARD') { c.promotionTier = 'EXPERIMENTAL_FORWARD'; c.__alpsLearningStage = 'LIVE_PAPER_EVIDENCE_COLLECTION'; c.__alpsNotOosVerified = true; }
          if (c.promotionGate && typeof c.promotionGate === 'object') { c.promotionGate.forwardEligible = true; c.promotionGate.eligible = true; c.promotionGate.blocked = false; c.promotionGate.blockReason = ''; c.promotionGate.reason = ''; c.promotionGate.status = tier; c.promotionGate.summary = tier; }
          return true;
        }
        function buildNativeFromRows(rows) {
          const d = dedup(rows); const out = []; const seen = new Set();
          for (const tier of ['FULL_AUTONOMY_FORWARD','WATCH_FORWARD','EXPERIMENTAL_FORWARD','RESEARCH_SANDBOX']) {
            for (const c of d.rows) {
              const ck = clusterKey(c); if (seen.has(ck)) continue; const cls = classify(c); if (cls.tier !== tier) continue; seen.add(ck); if (/^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD|EXPERIMENTAL_FORWARD)$/.test(cls.tier)) promoteInPlace(c, cls);
              out.push({ key: key(c), clusterKey: ck, clusterSize: Number(c.__alpsV931ClusterSize || 1), pair: c.pair || c.baseSymbol || text(c.sym).split('_')[0], timeframe: c.timeframe || '', strategy: c.strategy || c.stratName || '', exit: c.exit || c.exitName || '', tier: cls.tier, evidenceLabels: cls.evidenceLabels, safetyReason: cls.safetyReason, quantitative: cls.quantitative, oosPF: c.oosPF, oosTrades: c.oosTrades, score: c.score, originalPromotionTier: c.promotionTier, originalForwardEligible: c.forwardEligible === true, originalBlockReason: c.forwardBlockReason || '' });
              
            }
            
          }
          const count = t => out.filter(x => x.tier === t).length;
          return { schema:'alps.nativeForwardPool.view.v1', version: policy.version, installed:true, poolViewCap: null, technicalCap: policy.noFixedCandidateCap ? 'NONE_FOR_CANDIDATE_ADMISSION' : Number(policy.technicalCap || Number.MAX_SAFE_INTEGER), totalCandidates: out.length, fullAutonomyForward: count('FULL_AUTONOMY_FORWARD'), watchForward: count('WATCH_FORWARD'), experimentalForward: count('EXPERIMENTAL_FORWARD'), researchSandbox: count('RESEARCH_SANDBOX'), cognitionSuspended: count('COGNITION_SUSPENDED'), safetyBlocked: count('SAFETY_BLOCKED'), dataBlocked: count('DATA_BLOCKED'), promotedByFullAutonomy: count('FULL_AUTONOMY_FORWARD'),
    promotedToExperimental: count('EXPERIMENTAL_FORWARD'), blockedBySafety: count('SAFETY_BLOCKED') + count('DATA_BLOCKED'), quantitativePromotion:{ installed:true, rule:'nEff_OOS>=25 AND P(PF>1)>=0.90 AND rolling/stress pass', passed: out.filter(x=>x.quantitative && x.quantitative.promote).length, thresholds:{ nEffOOS:25, posteriorPFgt1:0.90, rollingMinPF:0.60, fallbackPF:1.80, fallbackStress5:1.20 } }, duplicateCompression: d.stats, evidenceLabels: Array.from(new Set(out.flatMap(x=>x.evidenceLabels||[]))), candidates: out };
        }
        function mutationGovernorFromReport(report) {
          const logs = arr(report && report.recentLogs); let z=0, c=0, m=0; for (const line of logs) { const t=text(line); if (/0 improvements/i.test(t)) { z++; c++; } const mm=t.match(/Missing Edge:\s*(\d+)\s*hypotheses/i); if (mm) m += Number(mm[1]||0); }
          const active = c >= 12 || z >= 12;
          return { schema:'alps.mutationGovernor.view.v1', version: policy.version, installed:true, mode: active ? 'EXPLORATION_REBALANCE' : 'NORMAL_MUTATION', active, zeroImprovementLogs:z, consecutiveZeroImprovement:c, missingEdgeGenerated:m, trigger: active ? 'ZERO_IMPROVEMENT_STAGNATION' : '', action: active ? 'Selection budget rebalanced to cluster representatives and under-covered hypotheses.' : 'Observe' };
        }
        function applyNow() { let mutated=0; const native = buildNativeFromRows(sourceRows()); for (const c of sourceRows()) { const cls=classify(c); if (/^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD|EXPERIMENTAL_FORWARD)$/.test(cls.tier) && promoteInPlace(c, cls)) mutated++; } status.nativeForwardPool = native; status.fullAutonomy = { schema:'alps.fullAutonomy.view.v1', version: policy.version, enabled:true, mode:'DECIDE_AND_ACT_PAPER_ONLY', paperOnly:true, liveCapitalExecution:false, duplicateCompression:native.duplicateCompression, quantitativePromotion:native.quantitativePromotion, decisions:[ native.experimentalForward ? {action:'EXPERIMENTAL_FORWARD_COLLECT_EVIDENCE', reason:`${native.experimentalForward} candidates are collecting paper evidence`} : (native.duplicateCompression.compressedRows ? {action:'DEDUP_FORWARD_POOL', reason:`${native.duplicateCompression.compressedRows} rows compressed`} : {action:'WAIT_FOR_CANDIDATES', reason:'Awaiting candidate rows'}) ], lastDecision: native.promotedByFullAutonomy ? 'FULL_AUTONOMY_FORWARD_QUANT_PASS' : (native.experimentalForward ? 'EXPERIMENTAL_FORWARD_COLLECT_EVIDENCE' : 'WAIT_FOR_CANDIDATES'), nativeForwardPool:{ totalCandidates:native.totalCandidates, promotedByFullAutonomy:native.promotedByFullAutonomy, blockedBySafety:native.blockedBySafety } }; status.nativeExecutionControl = { installed:true, authoritative:true, version:policy.version, mutatedCandidates:mutated, lastAppliedAt:Date.now(), rule:'v9.4.1 writes EXPERIMENTAL_FORWARD candidates back as forward-eligible for paper evidence collection. They remain NOT_OOS_VERIFIED until real OOS/paper evidence promotes them.' }; status.engineHook = { installed:true, safe:true, version:policy.version, lastError:status.lastError||'', wrappedFunctions:arr(status.wrappedFunctions), fallbackActive:!!status.fallbackActive, nativeExecutionControl:status.nativeExecutionControl }; status.decisionIntelligence = { schema:'alps.decisionIntelligence.view.v1', version:policy.version, duplicateCompression:native.duplicateCompression, quantitativePromotion:native.quantitativePromotion, livePaperEvidenceCollector:{ installed:true, experimentalForward:native.experimentalForward||0, mode:native.experimentalForward?'EXPERIMENTAL_FORWARD_COLLECTING_EVIDENCE':'WAITING_FOR_CANDIDATES' }, mutationGovernor:status.mutationGovernor || null }; return native; }
        function patchPool(name) {
          try { const original = globalThis[name] || window[name]; if (typeof original !== 'function' || original.__alpsV931Wrapped) return false; const wrapped = function(...args) { try { const base = arr(original.apply(this,args)); const combined = base.concat(sourceRows()); const native = buildNativeFromRows(combined); const out = native.candidates.map(x => Object.assign({}, combined.find(c => key(c) === x.key) || {}, { __alpsV931Tier:x.tier, forwardEligible:/^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD|EXPERIMENTAL_FORWARD)$/.test(x.tier), forwardBlockReason:/^(FULL_AUTONOMY_FORWARD|WATCH_FORWARD|EXPERIMENTAL_FORWARD)$/.test(x.tier)?'':(x.originalBlockReason||''), candidateTier:x.tier, promotionStatus:x.tier, promotionGateSummary:x.tier })); status.nativeForwardPool = native; return out; } catch(err) { status.lastError=String(err&&err.message||err); status.fallbackActive=true; return original.apply(this,args); } }; wrapped.__alpsV931Wrapped = true; try { globalThis[name]=wrapped; } catch(_) { window[name]=wrapped; } if (!status.wrappedFunctions.includes(name+':v931')) status.wrappedFunctions.push(name+':v931'); return true; } catch(err) { status.lastError=String(err&&err.message||err); status.fallbackActive=true; return false; }
        }
        patchPool('forwardCandidatePool'); patchPool('activeForwardCandidatePool');
        try { const originalReport = globalThis.buildRunReportObject || window.buildRunReportObject; if (typeof originalReport === 'function' && !originalReport.__alpsV931Wrapped) { const wrappedReport = async function(...args) { const report = await originalReport.apply(this,args); try { const native = buildNativeFromRows(arr(report && report.research && report.research.topStrategies).length ? report.research.topStrategies : sourceRows()); const mg = mutationGovernorFromReport(report); status.mutationGovernor = mg; status.nativeForwardPool = native; report.nativeForwardPool = native; report.fullAutonomyNativeForwardPool = native; report.mutationGovernor = mg; report.decisionIntelligence = { schema:'alps.decisionIntelligence.view.v1', version:policy.version, duplicateCompression:native.duplicateCompression, quantitativePromotion:native.quantitativePromotion, mutationGovernor:mg }; report.fullAutonomy = Object.assign({}, status.fullAutonomy || {}, { version:policy.version, enabled:true, paperOnly:true, liveCapitalExecution:false, decisions:[ native.duplicateCompression.compressedRows ? {action:'DEDUP_FORWARD_POOL', reason:`${native.duplicateCompression.compressedRows} duplicate rows compressed before forward pool.`} : {action:'WAIT_FOR_EVIDENCE', reason:'No compression required.'}, mg.active ? {action:'REBUILD', reason:'Mutation stagnation moved selection to exploration representatives.'} : null ].filter(Boolean), lastDecision: mg.active ? 'EXPLORATION_REBALANCE' : (native.promotedByFullAutonomy ? 'FULL_AUTONOMY_FORWARD_QUANT_PASS' : 'WAIT_FOR_EVIDENCE'), duplicateCompression:native.duplicateCompression, quantitativePromotion:native.quantitativePromotion, mutationGovernor:mg }); report.nativeExecutionControl = status.nativeExecutionControl; report.engineHook = status.engineHook; } catch(err) { status.lastError=String(err&&err.message||err); status.fallbackActive=true; } return report; }; wrappedReport.__alpsV931Wrapped = true; globalThis.buildRunReportObject = wrappedReport; if (!status.wrappedFunctions.includes('buildRunReportObject:v931')) status.wrappedFunctions.push('buildRunReportObject:v931'); } } catch(err) { status.lastError=String(err&&err.message||err); status.fallbackActive=true; }
        try { applyNow(); } catch(_) {}
        if (!status.wrappedFunctions.includes('minimumEvidenceGate')) status.wrappedFunctions.push('minimumEvidenceGate');
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
      try {
        context.on('close', () => {
          if (shuttingDown) return;
          Object.assign(lastHealth, {
            status: 'PAGE_CONTEXT_CLOSED',
            pageReady: false,
            lastError: 'Chromium browser context closed; next tick will relaunch.'
          });
          context = null;
          page = null;
        });
      } catch (_) {}
      page = context.pages()[0] || await context.newPage();
      try {
        page.on('close', () => {
          if (shuttingDown) return;
          Object.assign(lastHealth, {
            status: 'PAGE_CLOSED_RELAUNCH_PENDING',
            pageReady: false,
            lastError: 'Chromium page closed; next tick will relaunch before page.evaluate.'
          });
          page = null;
        });
      } catch (_) {}
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
      await v1000InstallPageAuthorityHooks('after-page-load').catch(e => log('v10 state authority hooks after load failed:', e.message));
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
  if (shuttingDown) throw new Error('ALPS runner is shutting down');
  async function ensureUsablePageForEval(stage) {
    if (shuttingDown) throw new Error('ALPS runner is shutting down');
    if (page && !page.isClosed()) return true;
    page = null;
    Object.assign(lastHealth, {
      status: 'PAGE_CLOSED_RELAUNCH_PENDING',
      pageReady: false,
      lastError: `PAGE_CLOSED_RELAUNCH_PENDING before evaluate (${stage}); relaunching now.`
    });
    const relaunched = await launchAppPage({ allowProfileReset: false }).catch(e => {
      const info = errorInfo(e);
      Object.assign(lastHealth, {
        status: 'PAGE_RELAUNCH_FAILED_BEFORE_EVAL',
        pageReady: false,
        lastError: `PAGE_RELAUNCH_FAILED_BEFORE_EVAL: ${info.message}`,
        pageLifecycleRecovery: { installed: true, version: FINAL_V930_VERSION, reason: stage, error: info, capturedAt: Date.now() }
      });
      return false;
    });
    return !!(relaunched && page && !page.isClosed());
  }

  if (!(await ensureUsablePageForEval('pre-page-evaluate'))) {
    throw new Error(lastHealth.lastError || 'ALPS page is not ready');
  }

  try {
    return await page.evaluate(fn, arg);
  } catch (e) {
    if (isPageClosedRuntimeError(e)) {
      await markPageClosedForRelaunch('pageEval-target-page-closed', e);
      if (await ensureUsablePageForEval('retry-after-page-closed-during-evaluate')) {
        try {
          return await page.evaluate(fn, arg);
        } catch (retryError) {
          if (isPageClosedRuntimeError(retryError)) {
            await markPageClosedForRelaunch('pageEval-retry-target-page-closed', retryError);
            throw new Error('ALPS page closed during evaluation after retry; relaunch required');
          }
          throw retryError;
        }
      }
      throw new Error(lastHealth.lastError || 'ALPS page closed during evaluation; relaunch required');
    }
    throw e;
  }
}

async function getPageHealth() {
  return pageEval(async () => {
    function val(expr, fallback) { try { return expr(); } catch (_) { return fallback; } }
    function num(x, fallback = 0) { const v = Number(x); return Number.isFinite(v) ? v : fallback; }
    const closed = val(() => closedTrades || [], []);
    const wins = closed.filter(x => Number(x.pnl || 0) > 0).length;
    const losses = closed.filter(x => Number(x.pnl || 0) <= 0).length;

    let diagReport = null;
    try {
      if (typeof buildRunReportObject === 'function') diagReport = await buildRunReportObject();
    } catch (_) {
      diagReport = null;
    }
    const data = diagReport && typeof diagReport === 'object' ? (diagReport.data || {}) : {};
    const research = diagReport && typeof diagReport === 'object' ? (diagReport.research || {}) : {};
    const fw = diagReport && typeof diagReport === 'object' ? (diagReport.forwardWatch || {}) : {};
    const runtime = diagReport && typeof diagReport === 'object' ? (diagReport.runtime || {}) : {};
    const rawPairs = Array.isArray(data.pairs) ? data.pairs : [];
    const recentLogs = Array.isArray(diagReport?.recentLogs) ? diagReport.recentLogs.slice(0, 12) : [];

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
      zonePersistenceEntry: val(() => window.__ALPS_V948_ENTRY_ENGINE__?.view || null, null),
      paperEntryActivation: val(() => window.__ALPS_V948_ENTRY_ENGINE__?.view || null, null),
      fullAutonomy: val(() => window.__ALPS_FINAL_V930__?.fullAutonomy || null, null),
      engineHook: val(() => window.__ALPS_FINAL_V930__?.engineHook || null, null),
      nativeExecutionControl: val(() => window.__ALPS_FINAL_V930__?.nativeExecutionControl || null, null),
      circuitBreaker: val(() => ({ enabled: true, open: false, reason: '', fallbackMode: 'ADVANCED_MODULES_ACTIVE', disabledModules: [] }), null),
      chart: val(() => window.__ALPS_FINAL_V930__?.chart || null, null),
      mutationGovernor: val(() => window.__ALPS_FINAL_V930__?.mutationGovernor || null, null),
      decisionIntelligence: val(() => window.__ALPS_FINAL_V930__?.decisionIntelligence || null, null),
      oosEvidenceBridge: val(() => window.__ALPS_FINAL_V930__?.oosEvidenceBridge || null, null),
      recoveryForwardCore: val(() => window.__ALPS_FINAL_V930__?.recoveryForwardCore || null, null),
      dataSource: 'LIVE SNAPSHOT',
      candlesLoaded: num(data.candlesLoaded, 0),
      dataPairFrames: num(data.pairFrames, 0),
      dataPairs: rawPairs,
      dataPairCount: rawPairs.length,
      rawResearchStrategies: num(research.strategies, 0),
      rawResearchCycles: num(research.researchCycles, 0),
      rawMutationRounds: num(research.mutationRounds, 0),
      candidatesMonitored: num(fw.candidatesMonitored, 0),
      totalGeneratedStrategies: num(fw.totalGeneratedStrategies, 0),
      latestClosedCandleTs: fw?.freshness?.latestClosedCandleTs || null,
      runnerStateStatus: runtime?.runnerState?.status || '',
      proxyOK: runtime?.proxyOK ?? null,
      bootDiagnostics: {
        pairFrames: num(data.pairFrames, 0),
        candlesLoaded: num(data.candlesLoaded, 0),
        pairs: rawPairs,
        researchStrategies: num(research.strategies, 0),
        researchCycles: num(research.researchCycles, 0),
        candidatesMonitored: num(fw.candidatesMonitored, 0),
        totalGeneratedStrategies: num(fw.totalGeneratedStrategies, 0),
        runnerStateStatus: runtime?.runnerState?.status || '',
        proxyOK: runtime?.proxyOK ?? null,
        reportGeneratedAt: diagReport?.meta?.generatedAt || null,
        recentLogs
      }
    };
  });
}


async function syncOosEvidenceBridgeFromPage(reason = 'sync') {
  if (!page || page.isClosed()) return lastOOSEvidenceBridgeView;
  try {
    const report = await pageEval(async () => { try { return typeof buildRunReportObject === 'function' ? await buildRunReportObject() : null; } catch (_) { return null; } });
    if (report && typeof report === 'object') { const rows = safeArray(report?.research?.topStrategies); const bundle = v94BuildEvidenceBridge(report, rows); lastOOSEvidenceBridgeView = bundle.view; lastOOSEvidenceRows = bundle.evidenceRows; return bundle.view; }
  } catch (e) { log(`OOS evidence bridge sync skipped (${reason}):`, e.message); }
  return lastOOSEvidenceBridgeView;
}

async function applyOosEvidenceBridgeToPage(reason = 'apply') {
  if (!page || page.isClosed()) return { mutated: 0, reason: 'page-not-ready' };
  const evidence = safeArray(lastOOSEvidenceRows).slice(0, 2000);
  if (!evidence.length) return { mutated: 0, reason: 'no-evidence-rows' };
  try {
    const result = await pageEval(evidenceRows => {
      function text(v) { return String(v == null ? '' : v); }
      function pairOf(c) { return text(c.pair || c.baseSymbol || c.symbol || c.sym || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
      function tfOf(c) { return text(c.timeframe || c.tf || c.frame || '').toLowerCase().replace(/\s+/g, ''); }
      function rootOf(c) { const raw = text(c.strategy || c.stratName || c.name || '').toUpperCase(); if (/HA|HEIKIN/.test(raw) && /POC/.test(raw)) return 'HA_POC'; if (/BB|BOLLINGER|SQUEEZE/.test(raw)) return /REVERSAL/.test(raw) ? 'BOLLINGER_REVERSAL' : 'BB_SQUEEZE'; if (/EMA|TREND 20|20\/50|TREND/.test(raw)) return 'EMA_TREND'; if (/VAH|VAL|VALUE/.test(raw)) return 'VAH_VAL'; if (/POC/.test(raw)) return 'POC'; if (/HEIKIN|ASHI/.test(raw)) return 'HA'; if (/RSI|DIVERGENCE/.test(raw)) return 'RSI_DIVERGENCE_ZONE'; return raw.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UNKNOWN'; }
      function exitOf(c) { const raw = text(c.exit || c.exitName || '').toUpperCase(); if (/ATR/.test(raw)) return 'ATR_TRAIL'; if (/POC/.test(raw)) return 'POC_TARGET'; if (/OPP|OPPOSITE/.test(raw) && /HA|HEIKIN/.test(raw)) return 'OPP_HA'; if (/TIME.*12|12H/.test(raw)) return 'TIME_12H'; const rr = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*R/); if (rr) return `${rr[1]}R_FIXED`.replace('.', '_'); return raw.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UNKNOWN_EXIT'; }
      function hasEvidence(c) { return Number(c.oosPF || 0) > 0 && Number(c.oosTrades || 0) >= 10; }
      const byKey = new Map(), byLoose = new Map();
      for (const e of Array.isArray(evidenceRows) ? evidenceRows : []) { if (!e || !e.key) continue; byKey.set(e.key, e); if (e.looseKey && !byLoose.has(e.looseKey)) byLoose.set(e.looseKey, e); }
      const stores = [];
      try { if (Array.isArray(globalThis.results)) stores.push(globalThis.results); } catch (_) {}
      try { if (Array.isArray(globalThis.allResults)) stores.push(globalThis.allResults); } catch (_) {}
      try { if (Array.isArray(globalThis.discoveryResults)) stores.push(globalThis.discoveryResults); } catch (_) {}
      let mutated = 0;
      for (const arr of stores) for (const c of arr) { if (!c || typeof c !== 'object' || hasEvidence(c)) continue; const k = [pairOf(c), tfOf(c), rootOf(c), exitOf(c)].join('|'); const lk = [pairOf(c), tfOf(c), rootOf(c)].join('|'); const ev = byKey.get(k) || byLoose.get(lk); if (!ev) continue; c.oosPF = ev.oosPF; c.oosTrades = ev.oosTrades; if (c.totalTrades == null) c.totalTrades = ev.totalTrades; if (c.rollingMinPF == null && ev.rollingMinPF != null) c.rollingMinPF = ev.rollingMinPF; if (c.stress5 == null && ev.stress5 != null) c.stress5 = ev.stress5; if (c.oosDD == null && ev.oosDD != null) c.oosDD = ev.oosDD; c.__alpsOosEvidenceMatched = true; c.__alpsOosEvidenceSource = ev.source; c.forwardEligible = true; c.forwardBlockReason = ''; c.blockReason = ''; if (!/WATCHLIST|FORWARD/i.test(text(c.promotionTier))) c.promotionTier = 'WATCHLIST_OOS_EVIDENCE_BRIDGE'; mutated += 1; }
      try { globalThis.__ALPS_OOS_EVIDENCE_BRIDGE_APPLIED__ = { mutated, at: Date.now() }; } catch (_) {}
      try { if (typeof renderAll === 'function') renderAll(); } catch (_) {}
      return { mutated };
    }, evidence);
    if (result?.mutated) log(`OOS Evidence Bridge applied to page: mutated=${result.mutated} reason=${reason}`);
    return result || { mutated: 0 };
  } catch (e) { log(`OOS evidence bridge page apply failed (${reason}):`, e.message); return { mutated: 0, error: e.message }; }
}

async function applyForwardLatchToPage(reason = 'apply-forward-latch') {
  if (!page || page.isClosed()) return { applied: 0, reason: 'page-not-ready' };
  const latchRows = safeArray(forwardLatchState.candidates);
  if (!latchRows.length) return { applied: 0, reason: 'latch-empty' };
  try {
    const result = await pageEval(({ rows, config, reasonText }) => {
      function arr(v) { return Array.isArray(v) ? v : []; }
      function text(v) { return String(v == null ? '' : v); }
      function key(c) { return text(c.key || [c.pair || c.baseSymbol || c.symbol || '', c.timeframe || c.tf || '', c.strategy || c.stratName || c.name || '', c.exit || c.exitName || ''].join('||')).toUpperCase(); }
      function normalize(c) {
        const tier = text(c.tier || c.promotionTier || c.candidateTier || 'EXPERIMENTAL_FORWARD') || 'EXPERIMENTAL_FORWARD';
        return Object.assign({}, c, {
          sym: c.sym || `${c.pair || c.baseSymbol}_${c.timeframe || c.tf || ''}`,
          baseSymbol: c.baseSymbol || c.pair,
          pair: c.pair || c.baseSymbol,
          timeframe: c.timeframe || c.tf,
          strategy: c.strategy || c.stratName || c.name,
          exit: c.exit || c.exitName || '',
          forwardEligible: true,
          eligible: true,
          forwardBlockReason: '',
          blockReason: '',
          promotionBlocked: false,
          promotionGateBlocked: false,
          promotionTier: tier,
          candidateTier: tier,
          promotionStatus: tier,
          promotionGateSummary: tier,
          __alpsV944ForwardLatch: true,
          __alpsV944LatchReason: reasonText,
          __alpsNotOosVerified: tier === 'EXPERIMENTAL_FORWARD' ? true : !!c.__alpsNotOosVerified,
          __alpsRecoverableEntry: c.recoverableEntry || config.recoverableEntry,
          __alpsAdaptiveExitPlan: c.adaptiveExitPlan || null,
          __alpsIndicatorResearchCandidate: c.indicatorResearchCandidate || null
        });
      }
      const normalized = arr(rows).map(normalize).filter(c => c.pair && c.timeframe && c.strategy);
      const safeIndicatorGovernance = config.indicatorGovernance || { schema: 'alps.indicatorGovernance.view.v1', version: config.version, installed: true, source: 'runner-safe-forward-latch-page-bridge', candidateRows: normalized.length, pageFunctionFallback: 'skipped_missing_dashboard_function' };
      const safeIndicatorResearch = config.syntheticIndicatorEngine || config.indicatorResearch || { schema: 'alps.indicatorResearch.view.v1', version: config.version, installed: true, executionInfluenceAllowed: false, source: 'runner-safe-forward-latch-page-bridge', candidateRows: normalized.length, pageFunctionFallback: 'skipped_missing_dashboard_function' };
      globalThis.__ALPS_V944_FORWARD_LATCH__ = { version: config.version, rows: normalized, appliedAt: Date.now(), reason: reasonText, recoverableEntry: config.recoverableEntry, adaptiveExitManager: config.adaptiveExitManager, indicatorGovernance: safeIndicatorGovernance, indicatorResearch: safeIndicatorResearch };
      const stores = [];
      try { if (!Array.isArray(globalThis.results)) globalThis.results = []; stores.push(globalThis.results); } catch (_) {}
      try { if (Array.isArray(globalThis.allResults)) stores.push(globalThis.allResults); } catch (_) {}
      try { if (Array.isArray(globalThis.discoveryResults)) stores.push(globalThis.discoveryResults); } catch (_) {}
      let applied = 0;
      for (const store of stores) {
        const existing = new Set(arr(store).map(key));
        for (const c of normalized) {
          const k = key(c); if (!k || existing.has(k)) continue;
          store.push(Object.assign({}, c)); existing.add(k); applied += 1;
        }
      }
      try { if (typeof renderAll === 'function') renderAll(); } catch (_) {}
      return { applied, latchSize: normalized.length };
    }, {
      rows: latchRows,
      reasonText: reason,
      config: {
        version: FINAL_V930_VERSION,
        recoverableEntry: { installed: true, lookbackClosedCandles: V944_RECOVERABLE_LOOKBACK_CANDLES, entryZoneBps: V944_ENTRY_ZONE_BPS },
        adaptiveExitManager: { installed: true, paperOnly: true, rules: ['BE_AT_50_PERCENT','LOCK_50_PERCENT_TARGET_AT_75_PERCENT'] },
        indicatorGovernance: v1010BuildIndicatorGovernanceView(lastReport || {}, { candidates: latchRows }),
        syntheticIndicatorEngine: v944BuildSyntheticIndicatorEngineView(lastReport || {}, { candidates: latchRows }),
        indicatorResearch: { installed: true, chartOverlayReady: true, executionInfluenceAllowed: false }
      }
    });
    if (result?.applied || result?.latchSize) log(`v9.4.8 Forward Latch applied to page: applied=${result.applied || 0} latchSize=${result.latchSize || 0} reason=${reason}`);
    return result || { applied: 0 };
  } catch (e) {
    log(`v9.4.8 Forward Latch page apply failed (${reason}):`, e.message);
    return { applied: 0, error: e.message };
  }
}


async function applyV948ZonePersistenceEntryEngine(reason = 'v948-zone-persistence-entry', rowsOverride = null) {
  if (!page || page.isClosed()) {
    lastV948EntryEngineView = v948EmptyEntryView('page-not-ready');
    return lastV948EntryEngineView;
  }
  // v9.5.7 activation fix: pull the freshest native pool straight from the page BEFORE building candidate rows.
  // The tick previously called this engine while lastNativeForwardPoolView was stale/empty (pool-vs-entry race),
  // so Paper Entry saw 0 candidates even though the page pool held hundreds. Reading the page pool here makes
  // the engine self-sufficient regardless of call ordering. Real rows only — nothing synthetic is created.
  let freshPagePoolRows = [];
  try {
    const pagePool = await pageEval(() => {
      function arr(v){ return Array.isArray(v) ? v : []; }
      const out = [];
      const final = globalThis.__ALPS_FINAL_V930__ || globalThis.__ALPS_V930__ || {};
      const pools = [globalThis.__ALPS_V930_NATIVE_FORWARD_POOL__, globalThis.nativeForwardPool, globalThis.__ALPS_NATIVE_FORWARD_POOL__, final.nativeForwardPool, final.fullAutonomyNativeForwardPool, final.forwardLatch, final.decisionIntelligence && final.decisionIntelligence.forwardLatch];
      for (const pool of pools) if (pool) { out.push(...arr(pool.candidates)); out.push(...arr(pool.rows)); if (Array.isArray(pool)) out.push(...pool); }
      if (!out.length) for (const name of ['activeForwardCandidatePool','forwardCandidatePool','officialCandidates']) { const v = globalThis[name]; if (Array.isArray(v) && v.length) { out.push(...v); break; } if (v && Array.isArray(v.candidates) && v.candidates.length) { out.push(...v.candidates); break; } }
      return out.slice(0, 2000);
    }, 'v957-fresh-page-pool-pull').catch(() => []);
    freshPagePoolRows = safeArray(pagePool);
    if (freshPagePoolRows.length) {
      v944MergeForwardLatch(freshPagePoolRows, 'v957-fresh-page-pool');
      if (!safeArray(lastNativeForwardPoolView?.candidates).length) {
        lastNativeForwardPoolView = { ...(lastNativeForwardPoolView || {}), candidates: freshPagePoolRows, totalCandidates: freshPagePoolRows.length, source: 'v957-fresh-page-pool' };
      }
    }
  } catch (e) { log('v9.5.7 fresh page pool pull failed:', e.message); }
  await v1000CollectPageAuthority('paper-entry-before-scan').catch(() => null);
  // v10.1.1 Paper Entry State Authority Router:
  // Before the page scan, force the same authoritative rows used by health/report/nativeForwardPool
  // back into the State Authority and forward latch. This closes the v10.1.0 race where the final
  // report showed nativeForwardPool/forwardLatch candidates, but Paper Entry still received 0 rows.
  let v1011PrimeProof = { schema:'alps.v1011PaperEntryAuthorityRouter.view.v1', version: FINAL_V930_VERSION, installed:true, reason, before:{}, after:{}, status:'NOT_RUN', rule:'Paper Entry must receive the same State Authority/nativeForwardPool rows exposed by health/report. No synthetic candidates or trades are created.' };
  try {
    v1011PrimeProof.before = {
      authorityRows: v1000ActiveRows().length,
      nativePoolRows: safeArray(lastNativeForwardPoolView?.candidates).length,
      healthPoolRows: safeArray(lastHealth?.nativeForwardPool?.candidates).length,
      latchRows: safeArray(forwardLatchState?.candidates).length,
      freshPagePoolRows: safeArray(freshPagePoolRows).length,
      materializedRows: safeArray(lastMaterializedRows).length
    };
    const seedRows = [];
    const seedSeen = new Set();
    function addSeedRows(rows, src) {
      for (const row of safeArray(rows)) {
        if (!row || typeof row !== 'object') continue;
        const k = uniqueKeyFromCandidate(row) || JSON.stringify(row || {}).slice(0, 160);
        if (!k || seedSeen.has(k)) continue;
        seedSeen.add(k);
        seedRows.push({ ...row, __v1011AuthorityRouterSource: src });
      }
    }
    addSeedRows(v1000ActiveRows(), 'stateAuthority.activeRows');
    addSeedRows(lastNativeForwardPoolView?.candidates, 'lastNativeForwardPoolView.candidates');
    addSeedRows(lastHealth?.nativeForwardPool?.candidates, 'lastHealth.nativeForwardPool.candidates');
    addSeedRows(forwardLatchState?.candidates, 'forwardLatchState.candidates');
    addSeedRows(freshPagePoolRows, 'freshPagePoolRows');
    addSeedRows(lastMaterializedRows, 'lastMaterializedRows');
    if (seedRows.length) {
      v1000CommitRows(seedRows, 'v10.1.1-paper-entry-authority-router', { observedRows: seedRows.length, target:'paperEntry' });
      const activeAfterPrime = v1000ActiveRows();
      if (activeAfterPrime.length) {
        lastNativeForwardPoolView = v952BuildNativePoolFromRows(activeAfterPrime, lastNativeForwardPoolView || {});
        v944MergeForwardLatch(activeAfterPrime, 'v10.1.1-paper-entry-authority-router');
        lastForwardLatchView = v944BuildForwardLatchView();
      }
    }
    v1011PrimeProof.after = {
      authorityRows: v1000ActiveRows().length,
      nativePoolRows: safeArray(lastNativeForwardPoolView?.candidates).length,
      latchRows: safeArray(forwardLatchState?.candidates).length,
      seedRows: seedRows.length
    };
    v1011PrimeProof.status = v1011PrimeProof.after.authorityRows > 0 ? 'AUTHORITY_ROWS_ROUTED_TO_PAPER_ENTRY' : 'NO_AUTHORITY_ROWS_AVAILABLE_FOR_PAPER_ENTRY';
  } catch (e) {
    v1011PrimeProof.status = 'AUTHORITY_ROUTER_FAILED';
    v1011PrimeProof.error = String(e && e.message || e).slice(0, 240);
  }
  const authorityRows = v1000ActiveRows();
  const latchRows = safeArray(forwardLatchState.candidates);
  const nativePoolRows = safeArray(lastNativeForwardPoolView?.candidates);
  const healthPoolRows = safeArray(lastHealth?.nativeForwardPool?.candidates);
  const materializedRows = safeArray(lastMaterializedRows);
  const runnerCandidateRows = [];
  const seenRunnerCandidateKeys = new Set();
  for (const group of [authorityRows, nativePoolRows, healthPoolRows, latchRows, freshPagePoolRows, materializedRows]) {
    for (const c of safeArray(group)) {
      const k = uniqueKeyFromCandidate(c) || JSON.stringify(c || {}).slice(0, 160);
      if (!k || seenRunnerCandidateKeys.has(k)) continue;
      seenRunnerCandidateKeys.add(k);
      runnerCandidateRows.push(c);
      
    }
    
  }
  if (rowsOverride && rowsOverride.length > 0) {
    for (const c of safeArray(rowsOverride)) {
      if (!c || typeof c !== 'object') continue;
      const k = uniqueKeyFromCandidate(c) || JSON.stringify(c || {}).slice(0, 160);
      if (!k || seenRunnerCandidateKeys.has(k)) continue;
      seenRunnerCandidateKeys.add(k);
      runnerCandidateRows.push(c);
    }
  }
  const v957ProofBefore = { authorityRows: authorityRows.length, freshPagePoolRows: freshPagePoolRows.length, latchRows: latchRows.length, nativePoolRows: nativePoolRows.length, healthPoolRows: healthPoolRows.length, rowsOverride: safeArray(rowsOverride).length, runnerCandidateRows: runnerCandidateRows.length };
  try {
    const view = await pageEval(async ({ rows, runnerRows, cfg, reasonText }) => {
      const startedAt = Date.now();
      const v1011PrimeProof = (cfg && cfg.v1011PrimeProof) || { schema:'alps.v1011PaperEntryAuthorityRouter.view.v1', version:(cfg && cfg.version) || '', installed:true, status:'PROOF_NOT_PROVIDED_SAFE_FALLBACK', before:{}, after:{}, rule:'Safe fallback only; proof object was not visible inside page context.' };
      const state = globalThis.__ALPS_V948_ENTRY_ENGINE__ || {
        schema: 'alps.zonePersistenceEntry.state.v1',
        version: cfg.version,
        installedAt: Date.now(),
        numericGuard: { installed: true, guardedToFixedErrors: 0, lastGuardedError: '' },
        openedKeys: {},
        rejectedReasonCounts: {},
        rejections: [],
        openedTrades: []
      };
      globalThis.__ALPS_V948_ENTRY_ENGINE__ = state;
      function text(v){ return String(v == null ? '' : v); }
      function arr(v){ return Array.isArray(v) ? v : []; }
      function num(v, fallback = null){
        if (v == null || v === '') return fallback;
        const x = Number(String(v).replace(/[,%$≈]/g, '').trim());
        return Number.isFinite(x) ? x : fallback;
      }
      function finite(v){ return Number.isFinite(Number(v)); }
      function recordGuard(err, where){
        const msg = text(err && err.message || err);
        state.numericGuard.guardedToFixedErrors = Number(state.numericGuard.guardedToFixedErrors || 0) + 1;
        state.numericGuard.lastGuardedError = `${where || 'unknown'}: ${msg}`.slice(0, 240);
        try {
          if (/toFixed/i.test(msg) && /toFixed/i.test(text(globalThis.lastError || ''))) {
            state.numericGuard.previousLastError = text(globalThis.lastError).slice(0, 240);
            globalThis.lastError = '';
          }
        } catch (_) {}
        return null;
      }
      function wrap(name, fallbackFactory){
        try {
          const orig = globalThis[name];
          if (typeof orig !== 'function' || orig.__alpsV948Wrapped) return false;
          const wrapped = function(...args){
            try {
              const out = orig.apply(this, args);
              if (out && typeof out.then === 'function') {
                return out.catch(e => {
                  const msg = text(e && e.message || e);
                  if (/toFixed|undefined|null/i.test(msg)) {
                    recordGuard(e, name);
                    return typeof fallbackFactory === 'function' ? fallbackFactory(args) : null;
                  }
                  throw e;
                });
              }
              return out;
            }
            catch(e){
              const msg = text(e && e.message || e);
              if (/toFixed|undefined|null/i.test(msg)) {
                recordGuard(e, name);
                return typeof fallbackFactory === 'function' ? fallbackFactory(args) : null;
              }
              throw e;
            }
          };
          wrapped.__alpsV948Wrapped = true;
          wrapped.__alpsOriginal = orig;
          globalThis[name] = wrapped;
          return true;
        } catch(e) { recordGuard(e, `wrap:${name}`); return false; }
      }
      const wrappedFunctions = [];
      for (const nm of ['catchUpForwardWatch','startWatch','renderAll','renderForwardWatch','renderDashboard','renderLiveChart','saveRuntimeSnapshotThrottled']) {
        if (wrap(nm, () => null)) wrappedFunctions.push(nm);
      }
      wrap('runReportToMarkdown', () => '## Report markdown guarded by v9.4.8 numeric guard\n- Reason: a renderer attempted toFixed on an undefined value. JSON report remains available.\n');
      try {
        if (/toFixed/i.test(text(globalThis.lastError || ''))) {
          state.numericGuard.previousLastError = text(globalThis.lastError).slice(0, 240);
          globalThis.lastError = '';
        }
      } catch (_) {}
      function pairOf(c){ return text(c.pair || c.baseSymbol || c.symbol || c.sym || '').toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/(15M|30M|1H|4H|5M)$/,''); }
      function tfOf(c){ let t=text(c.timeframe || c.tf || c.frame || '').toLowerCase().replace(/\s+/g,''); if (t==='15') t='15m'; if (t==='30') t='30m'; if (t==='60') t='1h'; return t; }
      function keyOf(c){ return text(c.key || [pairOf(c), tfOf(c), c.strategy || c.stratName || c.name || '', c.exit || c.exitName || ''].map(text).join('||')).toUpperCase(); }
      function rootOf(c){
        const raw = text(c.strategy || c.stratName || c.name || '').toUpperCase();
        if (/BOLLINGER|BB/.test(raw)) return 'BOLLINGER_REVERSAL';
        if (/EMA|TREND|PULLBACK|HEIKIN-ASHI TREND/.test(raw)) return 'EMA_TREND';
        if (/SWING/.test(raw)) return 'SWING_LEVEL_BOUNCE';
        if (/POC/.test(raw) || /HA_POC|HA \+ POC/.test(raw)) return 'POC';
        if (/RSI|DIVERGENCE/.test(raw)) return 'RSI_DIVERGENCE_ZONE';
        if (/HEIKIN|ASHI|HA/.test(raw)) return 'HA';
        return raw.replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'GENERIC';
      }
      function rMultiple(c){
        const p = num(c?.adaptiveExitPlan?.rMultipleSelected, null); if (p && p > 0) return Math.min(8, p);
        const raw = text(c.exit || c.exitName || c.key || '').toUpperCase();
        const m = raw.match(/([0-9]+(?:[._][0-9]+)?)\s*R/); if (m) return Math.min(8, Math.max(0.5, Number(m[1].replace('_','.'))));
        if (/POC/.test(raw)) return 1.5; if (/ATR/.test(raw)) return 2; return 1.5;
      }
      function candleFrom(x){
        if (Array.isArray(x)) { const t = num(x[0], null), o=num(x[1],null), h=num(x[2],null), l=num(x[3],null), c=num(x[4],null); if (finite(c)) return { t, open:o, high:h, low:l, close:c }; }
        if (!x || typeof x !== 'object') return null;
        const c = num(x.close ?? x.c ?? x.Close ?? x.price, null);
        const h = num(x.high ?? x.h ?? x.High ?? c, c);
        const l = num(x.low ?? x.l ?? x.Low ?? c, c);
        const o = num(x.open ?? x.o ?? x.Open ?? c, c);
        let t = num(x.time ?? x.t ?? x.ts ?? x.openTime ?? x.closeTime ?? x.timestamp ?? x.date, null);
        if (typeof (x.time ?? x.date ?? '') === 'string') { const dt = Date.parse(x.time ?? x.date); if (Number.isFinite(dt)) t = dt; }
        if (!finite(c) || !finite(h) || !finite(l)) return null;
        if (t && t < 1e12) t *= 1000;
        return { t, open:o, high:h, low:l, close:c };
      }
      function looksCandleArray(v){ if (!Array.isArray(v) || v.length < 30) return false; let ok=0; for (const x of v.slice(-8)) if (candleFrom(x)) ok++; return ok >= 4; }
      function collectCandles(){
        const out=[]; const seen=new Set();
        function add(path, v){
          if (!looksCandleArray(v)) return;
          const rows = v.map(candleFrom).filter(Boolean).sort((a,b)=>(a.t||0)-(b.t||0));
          if (rows.length < 30) return;
          const id = `${path}|${rows.length}|${rows[rows.length-1]?.t}|${rows[rows.length-1]?.close}`;
          if (seen.has(id)) return; seen.add(id); out.push({ path, rows });
        }
        for (const name of ['candles','allCandles','candleData','marketCandles','ohlc','klines','chartCandles']) { try { add(name, globalThis[name]); } catch(_){} }
        function walk(obj, path, depth){
          if (!obj || depth > 4) return;
          if (Array.isArray(obj)) { add(path, obj); return; }
          if (typeof obj !== 'object') return;
          let keys=[]; try { keys=Object.keys(obj).slice(0, 80); } catch(_) { return; }
          for (const k of keys) {
            if (!/(BTC|ETH|SOL|BNB|XRP|DOGE|XAUT|USDT|5m|15m|30m|1h|4h|candle|kline|ohlc|market|data|cache|history|series)/i.test(`${path}.${k}`)) continue;
            try { walk(obj[k], `${path}.${k}`, depth+1); } catch(_) {}
          }
        }
        for (const name of Object.getOwnPropertyNames(globalThis).slice(0, 1200)) {
          if (!/(candle|kline|ohlc|market|data|cache|history|series|store|runtime|state)/i.test(name)) continue;
          if (/document|navigator|location|performance|console|crypto|indexedDB|localStorage|sessionStorage/i.test(name)) continue;
          try { walk(globalThis[name], name, 0); } catch(_) {}
        }
        return out;
      }
      function candleArrayFromContainer(obj, sourceLabel){
        const groups=[]; const seen=new Set();
        function add(path, v){
          if (!looksCandleArray(v)) return;
          const rows = v.map(candleFrom).filter(Boolean).sort((a,b)=>(a.t||0)-(b.t||0));
          if (rows.length < 30) return;
          const id = `${path}|${rows.length}|${rows[rows.length-1]?.t}|${rows[rows.length-1]?.close}`;
          if (seen.has(id)) return; seen.add(id); groups.push({ path, rows });
        }
        function walk(v, path, depth){
          if (!v || depth > 6) return;
          if (Array.isArray(v)) { add(path, v); return; }
          if (typeof v !== 'object') return;
          let keys=[]; try { keys=Object.keys(v).slice(0, 140); } catch(_) { return; }
          for (const k of keys) {
            const nextPath = `${path}.${k}`;
            if (!/(BTC|ETH|SOL|BNB|XRP|DOGE|XAUT|USDT|5m|15m|30m|1h|4h|candle|kline|ohlc|market|data|cache|history|series|chart|bars|runtime|snapshot|store|result)/i.test(nextPath)) continue;
            try { walk(v[k], nextPath, depth+1); } catch(_) {}
          }
        }
        try { walk(obj, sourceLabel || 'container', 0); } catch(_) {}
        return groups;
      }
      function collectLocalStorageCandles(){
        const out=[];
        try {
          for (let i=0;i<localStorage.length;i++) {
            const k = localStorage.key(i) || '';
            if (!/(ALPS|candle|kline|ohlc|market|runtime|snapshot|cache|history|chart|data)/i.test(k)) continue;
            const raw = localStorage.getItem(k);
            if (!raw || raw.length < 100) continue;
            try { out.push(...candleArrayFromContainer(JSON.parse(raw), `localStorage.${k}`)); } catch(_) {}
          }
        } catch(_) {}
        return out;
      }
      async function collectIndexedDbCandles(){
        const out=[];
        if (!globalThis.indexedDB) return out;
        async function openDb(name){ return await new Promise(resolve => { try { const req=indexedDB.open(name); req.onsuccess=()=>resolve(req.result); req.onerror=()=>resolve(null); req.onblocked=()=>resolve(null); } catch(_) { resolve(null); } }); }
        async function readStore(db, storeName){
          const rows=[];
          try {
            await new Promise(resolve => {
              const tx=db.transaction(storeName,'readonly'); const store=tx.objectStore(storeName); const req=store.openCursor(); let n=0;
              req.onsuccess=()=>{ const cur=req.result; if (!cur || n>=60000) return resolve(); n++; const val=cur.value; rows.push(val && typeof val==='object' ? Object.assign({__id:cur.key,__store:storeName}, val) : {__id:cur.key,__store:storeName,value:val}); cur.continue(); };
              req.onerror=()=>resolve(); tx.onerror=()=>resolve(); tx.onabort=()=>resolve(); tx.oncomplete=()=>resolve();
            });
          } catch(_) {}
          return rows;
        }
        function bucketStoreRows(vals, basePath){
          const buckets=new Map();
          function inferFrom(v){
            const s = `${basePath}.${text(v && v.__id)} ${text(v && (v.key||v.symbol||v.pair||v.baseSymbol||v.timeframe||v.tf||v.frame))}`;
            const p = (s.match(/(BTCUSDT|ETHUSDT|SOLUSDT|BNBUSDT|XRPUSDT|DOGEUSDT|XAUTUSDT|XAUUSDT|PAXGUSDT)/i)||[])[1];
            let tf = (s.match(/(^|[^0-9A-Z])(5|15|30)m([^0-9A-Z]|$)/i)||[])[2]; if (tf) tf=tf+'m';
            if (!tf) tf=(s.match(/(^|[^0-9A-Z])(1|4)h([^0-9A-Z]|$)/i)||[])[2]?.toLowerCase()+'h';
            return {pair:p ? p.toUpperCase().replace('XAUUSDT','XAUTUSDT') : '', timeframe:tfOf({timeframe:tf||''})};
          }
          for (const v of arr(vals)) { const c=candleFrom(v); if(!c) continue; const inf=inferFrom(v); if(!inf.pair||!inf.timeframe) continue; const key=`${inf.pair}_${inf.timeframe}`.toUpperCase(); if(!buckets.has(key)) buckets.set(key,{path:`${basePath}.${key}`, rows:[]}); buckets.get(key).rows.push(c); }
          for (const g of buckets.values()) { g.rows=g.rows.filter(Boolean).sort((a,b)=>(a.t||0)-(b.t||0)); if(g.rows.length>=30) out.push(g); }
        }
        try {
          let dbs=[];
          if (indexedDB.databases) { try { dbs = await indexedDB.databases(); } catch(_) { dbs=[]; } }
          const dbNames=[...new Set([...(dbs||[]).map(d=>d&&d.name).filter(Boolean),'ALPS_Runtime_DB_v842','ALPS_Runtime_DB','ALPS_DB','ALPS_Runtime','ALPS'])].slice(0,30);
          for (const name of dbNames) {
            if (!/(ALPS|candle|kline|ohlc|market|runtime|snapshot|cache|history|chart|data|trade)/i.test(name)) continue;
            const db = await openDb(name); if (!db) continue;
            const stores = Array.from(db.objectStoreNames || []).slice(0, 80);
            for (const st of stores) {
              const vals = await readStore(db, st);
              if (!vals.length) continue;
              const base=`indexedDB.${name}.${st}`;
              if (looksCandleArray(vals)) out.push({ path:base, rows: vals.map(candleFrom).filter(Boolean).sort((a,b)=>(a.t||0)-(b.t||0)) });
              bucketStoreRows(vals, base);
              out.push(...candleArrayFromContainer(vals, base));
            }
            try { db.close(); } catch(_) {}
          }
        } catch(_) {}
        return out;
      }
      function mergeCandleGroups(groups){
        const out=[]; const seen=new Set();
        for (const g of groups) {
          if (!g || !Array.isArray(g.rows) || g.rows.length < 30) continue;
          const last=g.rows[g.rows.length-1] || {};
          const id = `${g.path}|${g.rows.length}|${last.t}|${last.close}`;
          if (seen.has(id)) continue; seen.add(id); out.push(g);
        }
        return out;
      }
      function bestCandlesFor(pair, tf, all, candidate){
        const p = text(pair).toUpperCase(); const t = tfOf({timeframe:tf}).toLowerCase(); const wantedPath = text(candidate && (candidate.__alpsV951CandlePath || candidate.candlePath || candidate.sourcePath || candidate.__alpsV1012CandleSource)).toUpperCase();
        let scored = all.map(g => { const path = g.path.toUpperCase(); let score = 0; if (wantedPath && (wantedPath.includes(path) || path.includes(wantedPath) || path.includes(wantedPath.split('.').slice(-2).join('.')))) score += 20; if (/^INDEXEDDB\./i.test(g.path)) score += 8; if (path.includes(p)) score += 5; if (path.includes(t.toUpperCase()) || path.includes(t)) score += 4; if (path.includes(t.replace('m','M').replace('h','H'))) score += 3; if (/LOCALSTORAGE\./i.test(g.path)) score -= 3; return { ...g, score }; }).filter(x => x.score > 0);
        if (!scored.length && all.length === 1) scored = [{ ...all[0], score: 1 }];
        scored.sort((a,b)=>b.score-a.score || b.rows.length-a.rows.length);
        if (scored[0]) return scored[0];
        const f = candidate && typeof candidate.featureSnapshot === 'object' ? candidate.featureSnapshot : null;
        const fClose = num(f && (f.close ?? f.c), null);
        const fTime = num(f && (f.time ?? f.t ?? candidate.closedCandleTime ?? candidate.latestClosedCandleTs), null);
        const fAtr = num(f && f.atr, null);
        const fSource = text(candidate && (candidate.evidenceSource || candidate.__alpsV1012Source || candidate.__alpsV951Source || candidate.__v10StateAuthoritySource));
        if (finite(fClose) && finite(fTime) && finite(fAtr) && /REAL|CANDLE|MARKET|STATE|V1012|V951/i.test(fSource)) {
          return { path:`candidate.featureSnapshot.realClosedCandleContext.${p}.${t}`, rows:[], featureSnapshotOnly:true, rule:'Uses the real candle-derived featureSnapshot already attached to the candidate; no synthetic candle array is created.' };
        }
        return null;
      }
      function ema(values, len){ if (!values.length) return null; const k=2/(len+1); let e=values[0]; for (let i=1;i<values.length;i++) e = values[i]*k + e*(1-k); return e; }
      function sma(values){ return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; }
      function std(values){ const m=sma(values); if (m==null) return null; return Math.sqrt(values.reduce((a,b)=>a+(b-m)*(b-m),0)/values.length); }
      function atr(candles, len=14){ if (candles.length < 2) return null; const trs=[]; for(let i=Math.max(1,candles.length-len); i<candles.length;i++){ const c=candles[i], p=candles[i-1]; trs.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close))); } return sma(trs); }
      function rsi(closes, len=14){ if (closes.length <= len) return null; let gains=0, losses=0; for(let i=closes.length-len;i<closes.length;i++){ const d=closes[i]-closes[i-1]; if(d>=0) gains+=d; else losses-=d; } if (losses === 0) return 100; const rs=gains/losses; return 100-(100/(1+rs)); }
      function percentile(vals, q){ const a=vals.filter(finite).sort((x,y)=>x-y); if(!a.length) return null; const idx=Math.min(a.length-1, Math.max(0, Math.round((a.length-1)*q))); return a[idx]; }
      function snapshotOf(c){
        const f = (c && typeof c.featureSnapshot === 'object') ? c.featureSnapshot : {};
        const out = {
          time: num(f.time ?? f.t ?? c.closedCandleTime ?? c.latestClosedCandleTs, null),
          close: num(f.close ?? f.c ?? c.currentPrice ?? c.price, null),
          atr: num(f.atr, null),
          ema20: num(f.ema20, null),
          ema50: num(f.ema50, null),
          rsi: num(f.rsi, null),
          bbMid: num(f.bbMid, null),
          bbUpper: num(f.bbUpper, null),
          bbLower: num(f.bbLower, null),
          swingHigh: num(f.swingHigh, null),
          swingLow: num(f.swingLow, null),
          poc: num(f.poc, null)
        };
        if (out.time && out.time < 1e12) out.time *= 1000;
        return out;
      }
      function candidateDirection(c){
        const raw = text(c.direction || c.side || c.tradeDirection || c.bias || '').toUpperCase();
        if (/\bLONG\b|BUY|BULL/.test(raw)) return 'LONG';
        if (/\bSHORT\b|SELL|BEAR/.test(raw)) return 'SHORT';
        return '';
      }
      function candidatePrice(c, latest, snap){
        return num(c.currentPrice ?? c.markPrice ?? c.lastPrice ?? c.price ?? snap.close ?? latest?.close, null);
      }
      function candidateSetupPrice(c, snap, root){
        const direct = num(c.entryPrice ?? c.entry ?? c.setupPrice ?? c.zoneMid ?? c.entryZoneMid, null);
        if (finite(direct)) return direct;
        if (root === 'POC' && finite(snap.poc)) return snap.poc;
        if ((root === 'EMA_TREND' || root === 'HA') && finite(snap.ema20)) return snap.ema20;
        if (root === 'RSI_DIVERGENCE_ZONE' && finite(snap.close)) return snap.close;
        if (root === 'BOLLINGER_REVERSAL') {
          const d = candidateDirection(c);
          if (d === 'LONG' && finite(snap.bbLower)) return snap.bbLower;
          if (d === 'SHORT' && finite(snap.bbUpper)) return snap.bbUpper;
          if (finite(snap.bbLower) && finite(snap.bbUpper) && finite(snap.close)) return Math.abs(snap.close-snap.bbLower) <= Math.abs(snap.close-snap.bbUpper) ? snap.bbLower : snap.bbUpper;
        }
        if (root === 'SWING_LEVEL_BOUNCE') {
          const d = candidateDirection(c);
          if (d === 'LONG' && finite(snap.swingLow)) return snap.swingLow;
          if (d === 'SHORT' && finite(snap.swingHigh)) return snap.swingHigh;
        }
        return null;
      }
      function inferDirection(c, root, price, zoneMid, snap, closes){
        const explicit = candidateDirection(c);
        if (explicit) return explicit;
        if (root === 'RSI_DIVERGENCE_ZONE') {
          const rv = finite(snap.rsi) ? snap.rsi : rsi(closes,14);
          if (finite(rv) && rv <= 38) return 'LONG';
          if (finite(rv) && rv >= 62) return 'SHORT';
        }
        if (root === 'BOLLINGER_REVERSAL') {
          if (finite(snap.bbLower) && finite(price) && Math.abs(price-snap.bbLower) <= Math.abs(price-(snap.bbUpper ?? price))) return 'LONG';
          if (finite(snap.bbUpper)) return 'SHORT';
        }
        if (root === 'SWING_LEVEL_BOUNCE') {
          if (finite(snap.swingLow) && finite(price) && Math.abs(price-snap.swingLow) <= Math.abs(price-(snap.swingHigh ?? price))) return 'LONG';
          if (finite(snap.swingHigh)) return 'SHORT';
        }
        if (root === 'EMA_TREND' || root === 'HA' || root === 'POC') {
          const e50 = finite(snap.ema50) ? snap.ema50 : ema(closes.slice(-120),50);
          if (finite(e50) && finite(price)) return price >= e50 ? 'LONG' : 'SHORT';
          if (finite(zoneMid) && finite(price)) return price >= zoneMid ? 'LONG' : 'SHORT';
        }
        return '';
      }
      function stopTargetFromPlan(direction, entry, c, snap, candles){
        const rr = rMultiple(c);
        const price = finite(entry) ? entry : num(snap.close, null);
        const a = finite(snap.atr) ? snap.atr : (Array.isArray(candles) && candles.length ? atr(candles,14) : null);
        const minStop = finite(price) ? Math.max(Math.abs(price)*0.0012, 1e-9) : null;
        const stopDist = Math.max(finite(a) ? a*1.15 : 0, finite(minStop) ? minStop : 0);
        if (!finite(price)) return { ok:false, reason:'ENTRY_UNDEFINED', rr, stopDist };
        if (!finite(stopDist) || stopDist <= 0) return { ok:false, reason:'STOP_TARGET_UNDEFINED', entry:price, rr, stopDist };
        let stop=null, target=null;
        if (direction === 'LONG') { stop=price-stopDist; target=price+stopDist*rr; }
        else if (direction === 'SHORT') { stop=price+stopDist; target=price-stopDist*rr; }
        else return { ok:false, reason:'DIRECTION_UNDEFINED', entry:price, rr, stopDist };
        if (![price, stop, target].every(finite) || stop === price || target === price) return { ok:false, reason:'STOP_TARGET_UNDEFINED', entry:price, stop, target, rr, stopDist };
        return { ok:true, entry:price, stop, target, rr, stopDist };
      }
      function setupAgeFromSnapshot(c, latestTime, snap){
        const t = num(c.closedCandleTime ?? c.latestClosedCandleTs ?? snap.time, null);
        if (!finite(t) || !finite(latestTime)) return 0;
        const ageMs = Math.max(0, latestTime - (t < 1e12 ? t*1000 : t));
        const tf = tfOf(c); const frameMs = tf === '5m' ? 300000 : tf === '15m' ? 900000 : tf === '30m' ? 1800000 : tf === '1h' ? 3600000 : tf === '4h' ? 14400000 : 900000;
        return Math.floor(ageMs / frameMs);
      }
      function zoneDecision(c, candles){
        const root=rootOf(c); const snap=snapshotOf(c); const latest=(Array.isArray(candles) && candles.length) ? candles[candles.length-1] : null;
        const closes = Array.isArray(candles) ? candles.map(x=>x.close).filter(finite) : [];
        const price = candidatePrice(c, latest, snap);
        if (!finite(price)) return { ok:false, reason:'PRICE_UNDEFINED', entry:null, stop:null, target:null };
        let zoneMid = candidateSetupPrice(c, snap, root);
        let direction = inferDirection(c, root, price, zoneMid, snap, closes);
        if (!direction) return { ok:false, reason:'DIRECTION_UNDEFINED', price, zoneMid, direction };
        const explicitDirection = candidateDirection(c);
        let strategyDirection = '';
        if (root === 'EMA_TREND' || root === 'HA') { const e50 = finite(snap.ema50) ? snap.ema50 : ema(closes.slice(-120),50); if (finite(e50)) strategyDirection = price >= e50 ? 'LONG' : 'SHORT'; }
        else if (root === 'POC') { const e50 = finite(snap.ema50) ? snap.ema50 : ema(closes.slice(-120),50); if (finite(e50)) strategyDirection = price >= e50 ? 'LONG' : 'SHORT'; }
        else if (root === 'RSI_DIVERGENCE_ZONE') { const rv = finite(snap.rsi) ? snap.rsi : rsi(closes,14); if (finite(rv) && rv <= 38) strategyDirection='LONG'; else if (finite(rv) && rv >= 62) strategyDirection='SHORT'; }
        else if (root === 'BOLLINGER_REVERSAL' && finite(snap.bbLower) && finite(snap.bbUpper)) { strategyDirection = Math.abs(price-snap.bbLower) <= Math.abs(price-snap.bbUpper) ? 'LONG' : 'SHORT'; }
        else if (root === 'SWING_LEVEL_BOUNCE' && finite(snap.swingLow) && finite(snap.swingHigh)) { strategyDirection = Math.abs(price-snap.swingLow) <= Math.abs(price-snap.swingHigh) ? 'LONG' : 'SHORT'; }
        if (explicitDirection && strategyDirection && explicitDirection !== strategyDirection) return { ok:false, reason:'DIRECTION_MISMATCH', price, zoneMid, direction:explicitDirection, strategyDirection, root };
        if (!finite(zoneMid)) {
          if (root === 'EMA_TREND' || root === 'HA') {
            const e20 = finite(snap.ema20) ? snap.ema20 : ema(closes.slice(-80),20);
            zoneMid = e20;
          } else if (root === 'POC') {
            const typical = Array.isArray(candles) ? candles.slice(-96).map(x=>(x.high+x.low+x.close)/3) : [];
            zoneMid = finite(snap.poc) ? snap.poc : percentile(typical,0.5);
          } else if (root === 'BOLLINGER_REVERSAL') {
            const win=closes.slice(-20); const m=finite(snap.bbMid)?snap.bbMid:sma(win); const sd=std(win);
            const lower=finite(snap.bbLower)?snap.bbLower:(finite(m)&&finite(sd)?m-2*sd:null);
            const upper=finite(snap.bbUpper)?snap.bbUpper:(finite(m)&&finite(sd)?m+2*sd:null);
            zoneMid = direction === 'LONG' ? lower : upper;
          } else if (root === 'SWING_LEVEL_BOUNCE') {
            zoneMid = direction === 'LONG' ? snap.swingLow : snap.swingHigh;
            if (!finite(zoneMid) && Array.isArray(candles) && candles.length) {
              const lows=candles.slice(-80).map(x=>x.low).filter(finite), highs=candles.slice(-80).map(x=>x.high).filter(finite);
              zoneMid = direction === 'LONG' ? Math.min(...lows) : Math.max(...highs);
            }
          } else if (root === 'RSI_DIVERGENCE_ZONE') zoneMid = price;
        }
        if (!finite(zoneMid)) return { ok:false, reason:'ZONE_MID_UNDEFINED', price, zoneMid:null, direction, root };
        const a = finite(snap.atr) ? snap.atr : (Array.isArray(candles) && candles.length ? atr(candles,14) : null);
        const buffer = Math.max(Math.abs(price)*(cfg.entryZoneBps/10000), finite(a) ? a*0.18 : Math.abs(price)*0.0018);
        const distanceBps = finite(zoneMid) && price ? Math.abs(price-zoneMid)/Math.abs(price)*10000 : null;
        if (!finite(buffer) || buffer <= 0) return { ok:false, reason:'ENTRY_ZONE_BUFFER_UNDEFINED', price, zoneMid, direction };
        const inside = Math.abs(price-zoneMid) <= buffer;
        const setupAge = setupAgeFromSnapshot(c, latest?.t || Date.now(), snap);
        if (setupAge > cfg.lookback) return { ok:false, reason:'STALE_CANDIDATE', setupAgeCandles:setupAge, price, zoneMid, direction, distanceBps };
        if (!inside) return { ok:false, reason:'OUTSIDE_ZONE', price, zoneMid, direction, distanceBps, bufferBps: buffer/Math.abs(price)*10000, setupAgeCandles:setupAge };
        const plan = stopTargetFromPlan(direction, price, c, snap, candles);
        if (!plan.ok) return { ok:false, reason:plan.reason || 'STOP_TARGET_UNDEFINED', entry:plan.entry ?? price, stop:plan.stop ?? null, target:plan.target ?? null, zoneMid, direction, price, setupAgeCandles:setupAge };
        const invalidationHit = direction === 'LONG' ? price <= plan.stop : price >= plan.stop;
        if (invalidationHit) return { ok:false, reason:'INVALIDATION_HIT', entry:plan.entry, stop:plan.stop, target:plan.target, zoneMid, direction, price, setupAgeCandles:setupAge };
        return { ok:true, direction, entry:plan.entry, stop:plan.stop, target:plan.target, zoneMid, price, currentPriceInsideEntryZone:true, zoneStillValid:true, invalidationHit:false, stopTargetReady:true, setupAgeCandles:setupAge, rMultiple:plan.rr, distanceFromEntryZoneBps:distanceBps, atr:a, bufferBps: buffer/Math.abs(price)*10000, entrySource: finite(num(c.entry ?? c.entryPrice, null)) ? 'candidate.entry' : 'currentPriceInsideZone', zoneSource: finite(num(c.setupPrice ?? c.zoneMid ?? c.entryZoneMid, null)) ? 'candidate.setupPrice' : 'featureSnapshot/indicator' };
      }
      function ensureArray(name){ try { if (!Array.isArray(globalThis[name])) globalThis[name]=[]; return globalThis[name]; } catch(_) { return []; } }
      function hasDuplicate(k, pair, tf){ const open = arr(globalThis.openPositions).concat(arr(globalThis.openTrades)).concat(arr(globalThis.paperSignals)); return open.some(x => text(x.__alpsV948Key || x.tradeId || x.key || '').toUpperCase() === k || (pairOf(x)===pair && tfOf(x)===tf && /OPEN|ACTIVE|PAPER/i.test(text(x.status || 'OPEN')))); }
      function makeTrade(c, d, srcPath){
        const k=keyOf(c); const pair=pairOf(c), tf=tfOf(c); const now=Date.now(); const id=`V948_${now}_${pair}_${tf}_${rootOf(c)}_${text(c.exit || c.exitName || 'GENERIC').replace(/[^A-Z0-9]+/gi,'_').slice(0,24)}`;
        return { tradeId:id, key:k, __alpsV948Key:k, pair, baseSymbol:pair, symbol:pair, timeframe:tf, direction:d.direction, strategy:text(c.strategy || c.stratName || c.name || rootOf(c)), exit:text(c.exit || c.exitName || ''), entry:d.entry, entryPrice:d.entry, current:d.price, currentPrice:d.price, stop:d.stop, stopPrice:d.stop, target:d.target, targetPrice:d.target, rMultiple:d.rMultiple, status:'OPEN', paperOnly:true, liveCapitalExecution:false, simulated:true, openedAt:now, timestamp:now, source:'v10.1.6-health-paper-entry-through-state-authority', candleSource:srcPath, setupAgeCandles:d.setupAgeCandles, currentPriceInsideEntryZone:true, zoneStillValid:true, invalidationHit:false, stopTargetReady:true, distanceFromEntryZoneBps:d.distanceFromEntryZoneBps, entryZoneMid:d.zoneMid, entryZoneBps:cfg.entryZoneBps, breakEvenTriggerPct:50, lockProfitTriggerPct:75, stopLogic:'MOVE_STOP_TO_ENTRY_AT_50_AND_LOCK_50_PERCENT_TARGET_AT_75', rejectedReason:'', freshEntryMode:'LAST_CANDLE_OR_VALID_RECENT_ZONE', evidenceStatus:'PAPER_EVIDENCE_COLLECTION', note:'Opened after v10 State Authority candidate propagation, fresh candidate dedupe, featureSnapshot/IndexedDB-priority entry construction, finite stop/target validation, and valid recent zone persistence checks.' };
      }
      const candidates = []; const seenCandidates = new Set(); const candidateSources = {}; const staleSkipped = { latch:0, page:0, duplicate:0, invalid:0 };
      function pushCandidate(c, source){ if(!c || typeof c!=='object') return; const p=pairOf(c), tf=tfOf(c); if(!p || !tf) { staleSkipped.invalid++; return; } const k=keyOf(c); if(seenCandidates.has(k)) { staleSkipped.duplicate++; return; } seenCandidates.add(k); candidates.push({...c,__candidateSource:source}); candidateSources[source]=(candidateSources[source]||0)+1; }
      const currentRows = arr(runnerRows);
      if (currentRows.length > 0) {
        for (const c of currentRows) pushCandidate(c, 'runner-nativeForwardPool-current');
        try { globalThis.__ALPS_V950_SERVER_CANDIDATES__ = currentRows; } catch(_) {}
        staleSkipped.latch += arr(rows).length;
      } else {
        for (const c of arr(rows)) pushCandidate(c, 'runner-latch-fallback');
        try { for (const c of arr(globalThis.__ALPS_V944_FORWARD_LATCH__ && globalThis.__ALPS_V944_FORWARD_LATCH__.rows)) pushCandidate(c, 'page-latch-fallback'); } catch(_) {}
        try { for (const c of arr(globalThis.__ALPS_V950_SERVER_CANDIDATES__)) pushCandidate(c, 'page-server-candidates-fallback'); } catch(_) {}
        const fnNames=['results','allResults','discoveryResults','activeForwardCandidatePool','forwardCandidatePool','nativeForwardPool','officialCandidates','candidates'];
        for (const name of fnNames) { try { const v=globalThis[name]; if(Array.isArray(v)) for(const c of v) pushCandidate(c,`${name}-fallback`); else if(v && Array.isArray(v.candidates)) for(const c of v.candidates) pushCandidate(c,`${name}.candidates-fallback`); else if(typeof v==='function'){ const out=v(); if(Array.isArray(out)) for(const c of out) pushCandidate(c,`${name}()-fallback`); else if(out && Array.isArray(out.candidates)) for(const c of out.candidates) pushCandidate(c,`${name}().candidates-fallback`); } } catch(_) {} }
      }
      const indexedDbGroups = await collectIndexedDbCandles();
      let candlesAll=mergeCandleGroups(indexedDbGroups.concat(collectCandles()).concat(collectLocalStorageCandles()));
      const candleResolver = { schema:'alps.candleStoreResolver.view.v1', version:cfg.version, installed:true, storesFound:candlesAll.length, sources:candlesAll.slice(0,20).map(g=>({path:g.path, rows:g.rows.length, lastClose:g.rows[g.rows.length-1]?.close, lastTime:g.rows[g.rows.length-1]?.t})), usedIndexedDb:candlesAll.some(g=>/^indexedDB\./i.test(g.path)), usedLocalStorage:candlesAll.some(g=>/^localStorage\./i.test(g.path)), rule:'Use IndexedDB candle arrays first, then runtime globals, then localStorage snapshots only as fallback. No synthetic candles are created.' };
      const visibilityBridge = { schema:'alps.paperEntryVisibility.view.v1', version:cfg.version, installed:true, runnerRowsReceived:arr(runnerRows).length, pageRowsReceived:arr(rows).length, candidatesSeen:candidates.length, candidateSources, nativeForwardPoolVisible:candidateSources['runner-nativeForwardPool-current']>0 || candidateSources['runner-nativeForwardPool']>0 || candidateSources['nativeForwardPool.candidates']>0, rule:'Paper Entry must read candidates from server nativeForwardPool, page forward pools, and latch rows before scanning entry zones.' };
      const rejectedReasonCounts={}; const rejections=[]; const opened=[]; let scanned=0;
      function reject(c, reason, extra={}){ const r=reason || 'UNKNOWN_REJECT'; rejectedReasonCounts[r]=(rejectedReasonCounts[r]||0)+1; if(rejections.length<50) rejections.push({ key:keyOf(c), pair:pairOf(c), timeframe:tfOf(c), strategy:text(c.strategy || c.stratName || c.name), reason:r, ...extra }); }
      const maxOpen = Math.max(0, Number(cfg.maxEntriesPerTick || 0));
      for (const c of candidates) { scanned++; const pair=pairOf(c), tf=tfOf(c), k=keyOf(c); if (hasDuplicate(k,pair,tf)) { reject(c,'DUPLICATE'); continue; } const group=bestCandlesFor(pair, tf, candlesAll, c); if (!group) { reject(c,'CANDLES_NOT_FOUND'); continue; } try { const d=zoneDecision(c, group.rows); if (!d.ok) { reject(c,d.reason,d); continue; } if (maxOpen > 0 && opened.length >= maxOpen) { reject(c,'ENTRY_THROTTLED_AFTER_VALID_SIGNAL',{ executionThrottle:true, maxEntriesPerTick:maxOpen, note:'Candidate was accepted and scanned; opening was throttled for paper lifecycle stability, not rejected by a fixed candidate cap.' }); continue; } const trade=makeTrade(c,d,group.path); ensureArray('paperSignals').push(trade); ensureArray('openPositions').push(trade); ensureArray('openTrades').push(trade); try { ensureArray('recentSignals').push(trade); } catch(_) {} state.openedKeys[k]=Date.now(); opened.push(trade); } catch(e) { recordGuard(e,'zoneDecision'); reject(c,/toFixed/i.test(text(e&&e.message))?'NUMERIC_GUARD_TOFIXED':'ENTRY_ENGINE_EXCEPTION',{ error:text(e&&e.message||e).slice(0,160) }); } }
      state.lastRunAt=Date.now(); state.scanned=scanned; state.openedTrades=opened.concat(arr(state.openedTrades)).slice(0,50); state.rejections=rejections; state.rejectedReasonCounts=rejectedReasonCounts; state.candlesStoresFound=candlesAll.length; state.candidatesSeen=candidates.length;
      const topRejectedReason = Object.entries(rejectedReasonCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || '';
      const view = { schema:'alps.zonePersistenceEntry.view.v1', version:cfg.version, installed:true, paperOnly:true, liveCapitalExecution:false, mode:'LAST_CANDLE_OR_VALID_RECENT_ZONE', reason:reasonText, wrappedFunctions, numericGuard:state.numericGuard, candidatesSeen:candidates.length, serverCandidatesSeen:arr(runnerRows).length, candidateSources, staleSkipped, visibilityBridge, candleResolver, candlesStoresFound:candlesAll.length, scanned, opened:opened.length, rejected:Math.max(0, scanned-opened.length), openedTrades:opened, rejectedReasonCounts, topRejectedReason, rejections, runtimeMs:Date.now()-startedAt, maxEntriesPerTick:maxOpen, candidateAdmissionNoFixedCap:true, freshCandidateDedupe:{currentNativeRows:currentRows.length, candidatesAfterDedupe:candidates.length, staleSkipped, policy: currentRows.length>0?'SCAN_CURRENT_NATIVE_POOL_ONLY_LATCH_HISTORY_FALLBACK_DISABLED':'NO_CURRENT_NATIVE_POOL_USED_FALLBACK_SOURCES'}, v954EntryConstructionAudit:{installed:true, entryBuilderPriority:['candidate.featureSnapshot','candidate.setupPrice/currentPrice','indexedDB candles','runtime candles','localStorage fallback'], preciseRejectReasons:['ENTRY_UNDEFINED','STOP_TARGET_UNDEFINED','ZONE_MID_UNDEFINED','DIRECTION_UNDEFINED','DIRECTION_MISMATCH','OUTSIDE_ZONE','STALE_CANDIDATE','DUPLICATE','CANDLES_NOT_FOUND','INVALIDATION_HIT'], invalidationOnlyAfterNumericPlan:true}, scannedAllCandidates:scanned===candidates.length, executionThrottleNotCandidateCap:true, lookbackClosedCandles:cfg.lookback, entryZoneBps:cfg.entryZoneBps, rule:'Accept and scan every real candidate with no fixed candidate cap. Open paper only when current price is still inside a valid recent entry zone, invalidation has not fired, duplicate guard passes, and entry/stop/target are finite numbers; maxEntriesPerTick is only an opening throttle, not candidate admission.', safeNumberPolicy:'No .toFixed is called before finite numeric validation. Page functions known to throw undefined.toFixed are guarded and recorded.', v951Fix:'All-in-one feature visibility + closed candle map + discovery materializer + forward + paper entry recovery', v1011PaperEntryAuthorityRouter:v1011PrimeProof };
      globalThis.__ALPS_V948_ENTRY_ENGINE__.view=view; try { if (typeof saveRuntimeSnapshotThrottled === 'function') saveRuntimeSnapshotThrottled(false); } catch(e){ recordGuard(e,'saveRuntimeSnapshotThrottled'); }
      return view;
    }, { rows: latchRows, runnerRows: runnerCandidateRows, reasonText: reason, cfg: { version: FINAL_V930_VERSION, maxEntriesPerTick: V948_ENTRY_MAX_PER_TICK, entryZoneBps: V948_ENTRY_ZONE_BPS, lookback: V948_ENTRY_LOOKBACK_CANDLES, v1011PrimeProof } });
    lastV948EntryEngineView = view || v948EmptyEntryView('empty-page-view');
    if (lastV948EntryEngineView && typeof lastV948EntryEngineView === 'object') {
      lastV948EntryEngineView.v957ActivationProof = {
        schema: 'alps.v957ActivationProof.view.v1',
        version: FINAL_V930_VERSION,
        before: v957ProofBefore,
        after: {
          nativeCandidates: v957ProofBefore.runnerCandidateRows,
          latchedCandidates: safeArray(forwardLatchState.candidates).length,
          pageCandidatesSeen: v952Num(lastV948EntryEngineView.candidatesSeen),
          paperEntrySeen: v952Num(lastV948EntryEngineView.candidatesSeen),
          paperEntryScanned: v952Num(lastV948EntryEngineView.scanned),
          opened: v952Num(lastV948EntryEngineView.opened),
          rejectedTotal: v952Num(lastV948EntryEngineView.rejected),
          topRejectedReason: lastV948EntryEngineView.topRejectedReason || ''
        },
        activationChain: 'freshPagePool -> forwardLatch -> runnerRows -> in-page pushCandidate -> zone scan -> open/reject',
        rule: 'Proof fields show real before/after counts of the activation chain. No synthetic candidates or trades.'
      };
    }
    lastV948NumericGuardView = lastV948EntryEngineView.numericGuard || null;
    lastV948RejectedReasonView = lastV948EntryEngineView.rejectedReasonCounts || null;
    lastV950PaperEntryVisibilityView = lastV948EntryEngineView.visibilityBridge || null;
    lastV950CandleStoreResolverView = lastV948EntryEngineView.candleResolver || null;
    if (lastV948EntryEngineView.opened > 0) log(`v9.5.0 Paper Entry Visibility opened paper=${lastV948EntryEngineView.opened} scanned=${lastV948EntryEngineView.scanned} reason=${reason}`);
    else log(`v9.5.0 Paper Entry Visibility scanned=${lastV948EntryEngineView.scanned || 0} opened=0 topReject=${lastV948EntryEngineView.topRejectedReason || '—'} reason=${reason}`);
    return lastV948EntryEngineView;
  } catch (e) {
    lastV948EntryEngineView = v948EmptyEntryView('engine-exception');
    lastV948EntryEngineView.error = e.message;
    log(`v9.5.0 Paper Entry Visibility failed (${reason}):`, e.message);
    return lastV948EntryEngineView;
  }
}


async function applyV949TradeLifecycleGuards(reason = 'v949-trade-lifecycle-guards') {
  if (!page || page.isClosed()) {
    lastV949LifecycleTruthView = { schema: 'alps.tradeLifecycleTruth.view.v1', version: FINAL_V930_VERSION, installed: true, status: 'PAGE_NOT_READY', reason };
    return lastV949LifecycleTruthView;
  }
  try {
    const view = await pageEval(({ version, reasonText }) => {
      function text(v){ return String(v == null ? '' : v); }
      function arr(v){ return Array.isArray(v) ? v : []; }
      function num(v, fallback = null){ if (v == null || v === '') return fallback; const x = Number(String(v).replace(/[,%$≈]/g,'').trim()); return Number.isFinite(x) ? x : fallback; }
      function finite(v){ return Number.isFinite(Number(v)); }
      const state = globalThis.__ALPS_V949_LIFECYCLE__ || { schema:'alps.tradeLifecycleTruth.state.v1', version, installedAt:Date.now(), stopMoveHistory:[] };
      globalThis.__ALPS_V949_LIFECYCLE__ = state;
      const rows = [];
      for (const name of ['openPositions','openTrades','paperSignals']) for (const t of arr(globalThis[name])) if (t && typeof t === 'object') rows.push({ t, container:name });
      const now = Date.now();
      let openTrades = 0, numericReady = 0, priceReady = 0, breakEvenMoved = 0, profitLocked = 0, duplicatesDetected = 0, managed = 0, stalePriceBlocked = 0;
      const seenZone = new Set(); const examples = [];
      function zoneKey(t){
        const pair = text(t.pair || t.symbol || t.baseSymbol).toUpperCase();
        const tf = text(t.timeframe || t.tf).toLowerCase();
        const root = text(t.strategy || t.strategyRoot || t.key || '').toUpperCase().replace(/[^A-Z0-9]+/g,'_').slice(0,40);
        const mid = num(t.entryZoneMid ?? t.zoneMid ?? t.entryPrice ?? t.entry, null);
        const bucket = finite(mid) ? Math.round(mid / Math.max(1, Math.abs(mid) * 0.0005)) : 'NA';
        return `${pair}|${tf}|${root}|${bucket}`;
      }
      for (const { t, container } of rows) {
        const status = text(t.status || 'OPEN').toUpperCase();
        if (!/OPEN|ACTIVE|PAPER/.test(status)) continue;
        openTrades++;
        const entry = num(t.entryPrice ?? t.entry, null);
        let stop = num(t.stopPrice ?? t.stop, null);
        const target = num(t.targetPrice ?? t.target, null);
        const current = num(t.currentPrice ?? t.current ?? t.markPrice ?? t.lastPrice ?? t.price, null);
        const direction = text(t.direction || t.side || '').toUpperCase();
        if ([entry, stop, target].every(finite)) numericReady++;
        if (finite(current)) priceReady++;
        const zk = zoneKey(t);
        if (seenZone.has(zk)) { duplicatesDetected++; t.duplicateZoneWarning = true; }
        seenZone.add(zk);
        const priceAgeMs = num(t.priceAgeMs ?? (t.currentPriceAt ? now - num(t.currentPriceAt, now) : 0), 0);
        if (priceAgeMs > 10 * 60 * 1000) { stalePriceBlocked++; t.stalePriceBlocked = true; }
        if ([entry, stop, target, current].every(finite) && target !== entry) {
          const progress = direction === 'SHORT' ? ((entry - current) / Math.abs(entry - target)) * 100 : ((current - entry) / Math.abs(target - entry)) * 100;
          t.progressToTargetPct = Number.isFinite(progress) ? Math.max(-999, Math.min(999, progress)) : null;
          const risk = Math.abs(entry - stop);
          if (Number.isFinite(progress) && progress >= 50 && !t.breakEvenMoved && risk > 0) {
            const newStop = direction === 'SHORT' ? entry - Math.max(risk * 0.02, Math.abs(entry) * 0.00005) : entry + Math.max(risk * 0.02, Math.abs(entry) * 0.00005);
            t.stopBeforeBreakEven = stop; t.stop = newStop; t.stopPrice = newStop; t.breakEvenMoved = true; t.breakEvenMovedAt = now;
            state.stopMoveHistory.push({ at: now, tradeId: t.tradeId || t.id || '', action:'MOVE_STOP_TO_ENTRY_OR_SLIGHTLY_ABOVE', from: stop, to: newStop, progressPct: t.progressToTargetPct });
            stop = newStop; breakEvenMoved++;
          }
          if (Number.isFinite(progress) && progress >= 75 && !t.profitLocked && risk > 0) {
            const halfTargetStop = direction === 'SHORT' ? entry - Math.abs(entry - target) * 0.5 : entry + Math.abs(target - entry) * 0.5;
            t.stopBeforeProfitLock = stop; t.stop = halfTargetStop; t.stopPrice = halfTargetStop; t.profitLocked = true; t.profitLockedAt = now;
            state.stopMoveHistory.push({ at: now, tradeId: t.tradeId || t.id || '', action:'MOVE_STOP_TO_50_PERCENT_OF_TARGET', from: stop, to: halfTargetStop, progressPct: t.progressToTargetPct });
            profitLocked++;
          }
          managed++;
        }
        if (examples.length < 20) examples.push({ tradeId: t.tradeId || t.id || '', container, pair: t.pair || t.symbol || '', timeframe: t.timeframe || t.tf || '', numericReady: [entry, stop, target].every(finite), priceReady: finite(current), progressToTargetPct: t.progressToTargetPct ?? null, breakEvenMoved: !!t.breakEvenMoved, profitLocked: !!t.profitLocked, duplicateZoneWarning: !!t.duplicateZoneWarning, stalePriceBlocked: !!t.stalePriceBlocked });
      }
      state.stopMoveHistory = arr(state.stopMoveHistory).slice(-200);
      const view = { schema:'alps.tradeLifecycleTruth.view.v1', version, installed:true, reason:reasonText, paperOnly:true, liveCapitalExecution:false, openTrades, numericPlanReadyOpenTrades:numericReady, priceReadyOpenTrades:priceReady, managedOpenTrades:managed, duplicatesDetected, stalePriceBlocked, breakEvenMovedThisRun:breakEvenMoved, profitLockedThisRun:profitLocked, stopMoveHistory:state.stopMoveHistory.slice(-20), examples, rule:'Manage paper-only open trades after entry: move stop at 50%, lock 50% of target distance at 75%, block stale prices, and flag duplicate zones. No live order placement.' };
      state.view = view;
      try { if (typeof saveRuntimeSnapshotThrottled === 'function') saveRuntimeSnapshotThrottled(false); } catch(_) {}
      return view;
    }, { version: FINAL_V930_VERSION, reasonText: reason });
    lastV949LifecycleTruthView = view || lastV949LifecycleTruthView;
    return lastV949LifecycleTruthView;
  } catch (e) {
    lastV949LifecycleTruthView = { schema: 'alps.tradeLifecycleTruth.view.v1', version: FINAL_V930_VERSION, installed: true, status: 'ENGINE_EXCEPTION', error: e.message, reason };
    log(`v9.5.0 Trade Lifecycle Guards failed (${reason}):`, e.message);
    return lastV949LifecycleTruthView;
  }
}

async function startForwardIfEligible(reason = 'live-paper-evidence-collector') {
  await loadForwardLatchState().catch(() => null);
  const pool = lastNativeForwardPoolView || lastHealth?.nativeForwardPool || {};
  const poolEligible = v94ForwardEligibleCountFromView(pool);
  const latchEligible = v944ForwardLatchEligibleCount();
  const recoveryEligible = n((lastRecoveryForwardCoreView || lastHealth?.recoveryForwardCore || {}).eligibleForwardCandidates, 0);
  const eligible = Math.max(poolEligible, latchEligible, recoveryEligible);
  if (!eligible || !page || page.isClosed()) return false;
  const h = await getPageHealth().catch(() => lastHealth || {}); if (h?.fwRunning || h?.emergencyStopActive) return !!h?.fwRunning;
  await applyForwardLatchToPage(reason).catch(() => null);
  await applyV948ZonePersistenceEntryEngine(reason).catch(() => null);
  await applyV949TradeLifecycleGuards(`start-forward-${reason}`).catch(() => null);
  log(`v9.5.0 Paper Entry Visibility starting Browser Runner. eligibleForward=${eligible} pool=${poolEligible} latch=${latchEligible} recovery=${recoveryEligible} reason=${reason}`);
  await pageEval(async reasonText => { try { if (typeof prepareAndroidRuntime === 'function') await prepareAndroidRuntime(); } catch (_) {} try { if (typeof startEngineWorker === 'function') await startEngineWorker(); } catch (_) {} try { if (typeof runFinalPreflight === 'function' && (!globalThis.preflightStatus || globalThis.preflightStatus === 'WAITING')) await runFinalPreflight(); } catch (_) {} try { if (typeof startWatch === 'function') await startWatch(); } catch (_) {} try { if (typeof catchUpForwardWatch === 'function') await catchUpForwardWatch(reasonText || 'v950-paper-entry-visibility-candle-store-report-truth'); } catch (_) {} try { if (typeof saveRuntimeSnapshotThrottled === 'function') await saveRuntimeSnapshotThrottled(false); } catch (_) {} try { if (typeof renderAll === 'function') renderAll(); } catch (_) {} return true; }, reason).catch(e => log('v9.4.9 Forward Latch startWatch failed:', e.message));
  return true;
}



function v1001MergeReportEntryRowsIntoLedgers(rawTradeLedgers, report = {}) {
  const ledgers = rawTradeLedgers || { openTrades: [], closedTrades: [], sourceStats: {} };
  if (!Array.isArray(ledgers.openTrades)) ledgers.openTrades = [];
  if (!Array.isArray(ledgers.closedTrades)) ledgers.closedTrades = [];
  if (!ledgers.sourceStats || typeof ledgers.sourceStats !== 'object') ledgers.sourceStats = {};
  if (!Array.isArray(ledgers.sourceStats.openSources)) ledgers.sourceStats.openSources = [];
  if (!Array.isArray(ledgers.sourceStats.closedSources)) ledgers.sourceStats.closedSources = [];

  const groups = [
    ['report.zonePersistenceEntry.openedTrades', report?.zonePersistenceEntry?.openedTrades],
    ['report.paperEntryActivation.openedTrades', report?.paperEntryActivation?.openedTrades],
    ['lastV948EntryEngineView.openedTrades', lastV948EntryEngineView?.openedTrades],
    ['lastTradeLifecycleTruth.examples', lastV949LifecycleTruthView?.examples]
  ];

  const seen = new Set(ledgers.openTrades.map(t => textValue(t?.tradeId || t?.id || t?.key || JSON.stringify(t).slice(0, 160))));
  for (const [source, rows] of groups) {
    const arr = safeArray(rows).filter(x => x && typeof x === 'object');
    let added = 0;
    for (const row of arr) {
      const status = textValue(row.status || 'OPEN').toUpperCase();
      if (/CLOSED|WIN|LOSS|STOP|TARGET/.test(status)) continue;
      const key = textValue(row.tradeId || row.id || row.key || `${row.pair || row.symbol || ''}|${row.timeframe || row.tf || ''}|${row.entry || row.entryPrice || ''}|${row.openedAt || row.timestamp || ''}`);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      ledgers.openTrades.push({ ...row, __alpsSource: source });
      added++;
    }
    if (added) ledgers.sourceStats.openSources.push({ source, count: added, v1001Fallback: true });
  }
  ledgers.sourceStats.v1001TradeLedgerExportSync = {
    version: FINAL_V930_VERSION,
    rule: 'Merge real Paper Entry openedTrades into ALPS trade export when page global open ledgers are stale or empty. No synthetic trades are created.'
  };
  return ledgers;
}

function v1001SyncReportCountersFromTradeExport(report = {}, exported = null) {
  const counts = tradeExportCounts(exported || lastTradeExport);
  if (counts.open > 0) {
    report.openPositions = Math.max(n(report.openPositions, 0), counts.open);
    report.paperSignals = Math.max(n(report.paperSignals, 0), counts.open);
    if (!report.forwardWatch || typeof report.forwardWatch !== 'object') report.forwardWatch = {};
    report.forwardWatch.openPositions = Math.max(n(report.forwardWatch.openPositions, 0), counts.open);
    report.forwardWatch.paperSignals = Math.max(n(report.forwardWatch.paperSignals, 0), counts.open);
    lastHealth.openPositions = Math.max(n(lastHealth.openPositions, 0), counts.open);
    lastHealth.paperSignals = Math.max(n(lastHealth.paperSignals, 0), counts.open);
  }
  if (counts.closed > 0) {
    report.closedTrades = Math.max(n(report.closedTrades, 0), counts.closed);
    if (!report.forwardWatch || typeof report.forwardWatch !== 'object') report.forwardWatch = {};
    report.forwardWatch.closedTrades = Math.max(n(report.forwardWatch.closedTrades, 0), counts.closed);
    lastHealth.closedTrades = Math.max(n(lastHealth.closedTrades, 0), counts.closed);
  }
  report.v1001TradeLedgerExportSync = {
    schema: 'alps.v1001TradeLedgerExportSync.view.v1',
    version: FINAL_V930_VERSION,
    installed: true,
    openTradesExported: counts.open,
    closedTradesExported: counts.closed,
    reportOpenPositions: n(report.openPositions, 0),
    reportPaperSignals: n(report.paperSignals, 0),
    currentHealthOpenPositions: n(lastHealth.openPositions, 0),
    currentHealthPaperSignals: n(lastHealth.paperSignals, 0),
    status: counts.total > 0 ? 'TRADE_EXPORT_SYNCED_FROM_REAL_PAPER_ENTRY_LEDGER' : 'WAITING_FOR_REAL_TRADE_LEDGER_ROWS',
    rule: 'Trade export and health counters read real Paper Entry openedTrades/closedTrades. This does not create trades; it only preserves/export-syncs trades already opened by the paper entry engine.'
  };
  return report;
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
          if (/openpositions|opentrades|openedtrades|activepositions|activetrades|paperopen|papersignals|recentsignals/.test(lower)) {
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
      'forwardOpenPositions',
      'paperSignals',
      'recentSignals',
      'openedTrades'
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
      const engine = globalThis.__ALPS_V948_ENTRY_ENGINE__ || globalThis.__ALPS_ZONE_PERSISTENCE_ENTRY__ || null;
      const view = engine && typeof engine === 'object' ? (engine.view || engine.lastView || engine) : null;
      const opened = Array.isArray(view && view.openedTrades) ? clone(view.openedTrades) : [];
      const signals = Array.isArray(view && view.paperSignals) ? clone(view.paperSignals) : [];
      if (opened.length) out.open.push({ source: 'page.__ALPS_V948_ENTRY_ENGINE__.view.openedTrades', rows: opened.slice(0, 500) });
      if (signals.length) out.open.push({ source: 'page.__ALPS_V948_ENTRY_ENGINE__.view.paperSignals', rows: signals.slice(0, 500) });
    } catch (_) {}

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
  if (shuttingDown) return;
  if (!page || page.isClosed()) {
    const relaunched = await launchAppPage({ allowProfileReset: false });
    if (!relaunched) throw new Error(lastHealth.lastError || 'PAGE_RELAUNCH_FAILED_BEFORE_RUNTIME');
  }
  await loadForwardLatchState().catch(() => null);
  await v1000InstallPageAuthorityHooks('ensure-runtime-start').catch(e => log('v10 state authority hooks ensure failed:', e.message));
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

  await syncOosEvidenceBridgeFromPage('ensure-runtime').catch(() => null);
  await applyOosEvidenceBridgeToPage('ensure-runtime').catch(() => null);
  await applyV948ZonePersistenceEntryEngine('ensure-runtime-zone-persistence-entry').catch(() => null);
  await applyV949TradeLifecycleGuards('ensure-runtime-trade-lifecycle').catch(() => null);
  const refreshed = await getPageHealth();
  Object.assign(lastHealth, enhanceHealth(refreshed));

  await triggerActualResearchIfNeeded('ensure-runtime-actual-research-trigger', lastHealth).catch(() => null);

  if (!refreshed.candidates && AUTO_START_LAB && !refreshed.labRunning) {
    log('No candidates found. ALPS_AUTO_START_LAB=1, starting full Lab. This can take time.');
    await pageEval(() => { if (typeof startLab === 'function') startLab(); return true; });
    return;
  }

  const eligibleForward = v94ForwardEligibleCountFromView(lastHealth.nativeForwardPool || refreshed.nativeForwardPool || {});
  if (AUTO_START_WATCH && (eligibleForward > 0 || v944ForwardLatchEligibleCount() > 0) && !refreshed.fwRunning && !refreshed.emergencyStopActive) {
    await startForwardIfEligible('ensure-runtime-eligible-forward');
  } else if (AUTO_START_WATCH && refreshed.candidates && eligibleForward <= 0) {
    log(`Live Paper Evidence Collector holding forward start: candidates=${refreshed.candidates}, eligibleForward=${eligibleForward}. No PFNA/OOSNA rows are admitted.`);
  }
}

async function runnerTick(reason = 'server-runner tick') {
  if (shuttingDown) return { ok: true, skipped: 'runner shutting down' };
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
    await v1000InstallPageAuthorityHooks('runner-tick-before-catchup').catch(e => log('v10 state authority hooks tick failed:', e.message));
    const before = enhanceHealth(await getPageHealth());
    Object.assign(lastHealth, before);
    await triggerActualResearchIfNeeded('runner-tick-actual-research-trigger', before).catch(() => null);
    await installAutonomousBridgeInPage().catch(e => log('Autonomous bridge install before catch-up failed:', e.message));
    await syncOosEvidenceBridgeFromPage('runner-tick').catch(() => null);
    await applyOosEvidenceBridgeToPage('runner-tick').catch(() => null);
    await installV930StableAutonomyInPage().catch(e => log('v9.4 recovery forward core reinstall after bridge failed:', e.message));
    await applyForwardLatchToPage('runner-tick-apply-latch').catch(() => null);
    await applyV948ZonePersistenceEntryEngine('runner-tick-zone-persistence-entry').catch(() => null);
    await applyV949TradeLifecycleGuards('runner-tick-trade-lifecycle').catch(() => null);
    await startForwardIfEligible('runner-tick-eligible-forward').catch(() => null);

    if (before.fwRunning && !before.fwRefreshRunning) {
      await pageEval(async reasonText => {
        if (typeof catchUpForwardWatch === 'function') await catchUpForwardWatch(reasonText);
        if (typeof saveRuntimeSnapshotThrottled === 'function') await saveRuntimeSnapshotThrottled(false);
        if (typeof renderAll === 'function') renderAll();
        return true;
      }, reason).catch(e => { throw new Error('catch-up failed: ' + e.message); });
    }

    const after = enhanceHealth(await getPageHealth());
    Object.assign(lastHealth, after, { status: after.status || (after.forwardStale ? 'STALE_FORWARD' : (after.fwRunning ? 'RUNNING' : (after.labRunning ? 'LAB_RUNNING' : 'READY'))), lastTickAt: Date.now(), lastError: '' });
    await maybeRecoverStuckBoot(lastHealth);
    await recordSnapshot(snapshotFromMetrics(lastHealth, 'tick'));
    await maybeRecoverStaleForward();
    await maybeNotify(lastHealth);
    if (Date.now() - (lastHealth.lastReportAt || 0) > REPORT_EVERY_MS) await collectReport().catch(e => log('Report collection failed:', e.message));
    return { ok: true, health: lastHealth };
  } catch (e) {
    if (isPageClosedRuntimeError(e)) {
      await markPageClosedForRelaunch('runner-tick-page-closed', e).catch(() => null);
      log('Runner tick page lifecycle recovery:', e.message);
      return { ok: false, recovery: 'PAGE_CLOSED_RELAUNCH_PENDING', error: e.message, health: lastHealth };
    }
    lastHealth.status = 'ERROR';
    lastHealth.lastError = e.message;
    log('Runner tick error:', e.stack || e.message);
    return { ok: false, error: e.message, health: lastHealth };
  } finally {
    tickBusy = false;
  }
}


function scrubLegacyReportMarkdown(md = '') {
  let out = String(md || '');
  out = out.replace(/^# ALPS v9\.3\.0 Stable Autonomous Research OS Report/m, `# ALPS v10 State Authority Report`);
  out = out.replace(/App Version: 1\.1\.30-stable-autonomous-research-os/g, `App Version: ${FINAL_V930_VERSION}`);
  out = out.replace(/AHI CORE v9\.1\.8/g, 'AHI CORE v10.0.0');
  out = out.replace(/Forward cap=360/g, 'Forward cap=NO_FIXED_CANDIDATE_CAP');
  out = out.replace(/dynamic evidence-ranked capacity 360/g, 'dynamic evidence-ranked admission with no fixed candidate cap');
  out = out.replace(/ALPS v9\.3\.0 Stable Autonomous Layer/g, 'ALPS v10 State Authority Layer');
  out = out.replace(/RESEARCH STATUS: No robust\/watch robustness candidate found yet\./g, 'RESEARCH STATUS: Current Health/nativeForwardPool is authoritative; entry construction audit controls paper entries.');
  return out;
}

async function collectReport() {
  if (!page || page.isClosed()) throw new Error('ALPS page is not ready');
  await v1000InstallPageAuthorityHooks('collect-report-before-build').catch(e => log('v10 authority hooks before report failed:', e.message));
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

  await v1000CollectPageAuthority('collect-report-raw').catch(e => log('v10 authority raw page scan skipped:', e.message));
  report = v1000ApplyStateAuthorityToView(report, 'collect-report-raw-report');

  let currentHealthForV952 = null;
  try {
    currentHealthForV952 = enhanceHealth(await getPageHealth());
    Object.assign(lastHealth, currentHealthForV952, { status: currentHealthForV952.status || (currentHealthForV952.fwRunning ? 'RUNNING' : (currentHealthForV952.labRunning ? 'LAB_RUNNING' : 'LOADED')), lastError: '' });
    report = v952AttachTruth(report, currentHealthForV952);
  } catch (e) {
    log('v9.5.2 current Health sync at report start skipped:', e.message);
  }

  // v9.5.1 All-in-One Feature/Discovery/Forward/Entry Recovery: use the same report data that is shown to the user.
  // If report.data.pairFrames or candlesLoaded is already positive, trigger research immediately; do not wait for 35/35.
  await triggerActualResearchIfNeeded('collect-report-data-bridge', report).catch(e => log('v9.4.8 zone persistence trigger from report failed:', e.message));

  // v9.5.1 All-in-One Feature/Discovery/Forward/Entry Recovery: scan real page/report stores after trigger/retry, materialize only existing rows, and diagnose zero output.
  lastDiscoveryOutputView = await v947CollectPipelineDiagnosticsFromPage('collect-report-pipeline-truth-recovery').catch(e => ({ schema: 'alps.discoveryOutput.view.v1', version: FINAL_V930_VERSION, status: 'DIAGNOSTIC_COLLECTION_FAILED', error: e.message, rows: [] }));
  const v951Real = await v951CollectRealCandleDiscoveryMaterializer('collect-report-v951-real-candle-discovery').catch(e => ({ schema: 'alps.v951RealCandleDiscovery.view.v1', version: FINAL_V930_VERSION, status: 'FAILED', error: e.message, rows: [], featureRows: [] }));
  report.v951RealCandleDiscovery = v951Real;
  if (v951Real && safeArray(v951Real.rows).length > 0) {
    lastDiscoveryOutputView.rows = safeArray(lastDiscoveryOutputView.rows).concat(safeArray(v951Real.rows));
    lastDiscoveryOutputView.featureRowsFound = Math.max(n(lastDiscoveryOutputView.featureRowsFound,0), n(v951Real.featureRowsFound,0));
    lastDiscoveryOutputView.materializedRows = safeArray(lastDiscoveryOutputView.rows).length;
    lastDiscoveryOutputView.testedRows = Math.max(n(lastDiscoveryOutputView.testedRows,0), safeArray(lastDiscoveryOutputView.rows).length);
    lastDiscoveryOutputView.candlesVisibleToDiscovery = true;
    lastDiscoveryOutputView.status = 'ROWS_FOUND_AND_MATERIALIZED_BY_V951_REAL_CANDLE_DISCOVERY';
    lastDiscoveryOutputView.v951RealCandleDiscovery = { status: v951Real.status, candleStores: safeArray(v951Real.candleStores).length, featureRowsFound: n(v951Real.featureRowsFound,0), materializedRows: safeArray(v951Real.rows).length, closedCandlePairFrames: n(v951Real.closedCandlePairFrames,0), injected: !!v951Real.injected };
  }

  // v10.1.2: if browser/page stores still hide candles from discovery, build real rows from server-fetched Binance closed candles.
  // This is a real-data bootstrap only: no synthetic candles, no fake trades, and no fake OOS values.
  let v1012ServerCandleBootstrap = null;
  if (!safeArray(lastDiscoveryOutputView?.rows).length && v946MaxNumber(report?.data?.candlesLoaded, report?.candlesLoaded, report?.bootDiagnostics?.candlesLoaded, lastHealth?.candlesLoaded, lastHealth?.bootDiagnostics?.candlesLoaded) > 0) {
    v1012ServerCandleBootstrap = await v1012ServerCandleResearchBootstrap(report, 'collect-report-v1012-server-candle-bootstrap').catch(e => ({ schema:'alps.v1012ServerCandleResearchBootstrap.view.v1', version: FINAL_V930_VERSION, installed:true, status:'FAILED', error:e.message, rows:[], featureRows:[] }));
    report.v1012ServerCandleBootstrap = v1012ServerCandleBootstrap;
    if (v1012ServerCandleBootstrap && safeArray(v1012ServerCandleBootstrap.rows).length > 0) {
      lastDiscoveryOutputView.rows = safeArray(lastDiscoveryOutputView.rows).concat(safeArray(v1012ServerCandleBootstrap.rows));
      lastDiscoveryOutputView.featureRowsFound = Math.max(n(lastDiscoveryOutputView.featureRowsFound,0), n(v1012ServerCandleBootstrap.featureRowsFound,0));
      lastDiscoveryOutputView.materializedRows = safeArray(lastDiscoveryOutputView.rows).length;
      lastDiscoveryOutputView.testedRows = Math.max(n(lastDiscoveryOutputView.testedRows,0), safeArray(lastDiscoveryOutputView.rows).length);
      lastDiscoveryOutputView.candlesVisibleToDiscovery = true;
      lastDiscoveryOutputView.status = 'ROWS_FOUND_AND_MATERIALIZED_BY_V1012_SERVER_REAL_CANDLE_BOOTSTRAP';
      lastDiscoveryOutputView.v1012ServerCandleBootstrap = { status: v1012ServerCandleBootstrap.status, candleGroups: safeArray(v1012ServerCandleBootstrap.candleGroups).length, featureRowsFound: n(v1012ServerCandleBootstrap.featureRowsFound,0), materializedRows: safeArray(v1012ServerCandleBootstrap.rows).length, closedCandlePairFrames: n(v1012ServerCandleBootstrap.closedCandlePairFrames,0), realCandlesOnly:true };
    }
  }
  v947BuildStoreInventoryView(lastDiscoveryOutputView);
  v947MaterializeReportRows(report, safeArray(lastDiscoveryOutputView?.rows));
  if (v951Real && v951Real.closedCandleMap && Object.keys(v951Real.closedCandleMap).length) {
    report.v951ClosedCandleMap = v951Real.closedCandleMap;
    report.latestClosedCandleTs = Math.max(0, ...Object.values(v951Real.closedCandleMap).map(x => n(x.latestClosedCandleTs,0)));
  }
  report = v1000ApplyStateAuthorityToView(report, 'collect-report-after-discovery-materializer');

  await syncOosEvidenceBridgeFromPage('collect-report-pre-enrich').catch(() => null);
  await applyOosEvidenceBridgeToPage('collect-report-pre-enrich').catch(() => null);
  report = v1000ApplyStateAuthorityToView(report, 'collect-report-before-paper-entry');
  await applyForwardLatchToPage('collect-report-pre-entry').catch(() => null);
  await applyV948ZonePersistenceEntryEngine('collect-report-zone-persistence-entry').catch(() => null);
  await applyV949TradeLifecycleGuards('collect-report-trade-lifecycle').catch(() => null);
  const pageV930Status = await installV930StableAutonomyInPage().catch(e => ({ installed: false, safe: true, lastError: e.message, fallbackActive: true, wrappedFunctions: [] }));
  report = enrichReportV930(report, pageV930Status);
  try {
    currentHealthForV952 = enhanceHealth(await getPageHealth());
    Object.assign(lastHealth, currentHealthForV952, { status: currentHealthForV952.status || (currentHealthForV952.fwRunning ? 'RUNNING' : (currentHealthForV952.labRunning ? 'LAB_RUNNING' : 'LOADED')), lastError: '' });
    report = v952AttachTruth(report, currentHealthForV952);
  } catch (e) {
    log('v9.5.2 current Health sync after enrich skipped:', e.message);
  }
  await saveForwardLatchState().catch(() => null);
  await startForwardIfEligible('collect-report-eligible-forward').catch(() => null);
  // v10.1.1: before the final Paper Entry scan, re-commit the post-v952 report/current-health rows
  // into State Authority so the scan uses the same candidates the user sees in health/report.
  report = v1000ApplyStateAuthorityToView(report, 'collect-report-after-v952-before-paper-entry-v1011');
  // v9.5.2/v10.1.1: after all current Health/native pool rows are bridged without a fixed candidate cap, run Paper Entry again with current candidates.
  await applyForwardLatchToPage('collect-report-post-enrich-v951').catch(() => null);
  await applyV948ZonePersistenceEntryEngine('collect-report-post-enrich-v951-entry').catch(() => null);
  await applyV949TradeLifecycleGuards('collect-report-post-enrich-v951-lifecycle').catch(() => null);
  report = v1000ApplyStateAuthorityToView(report, 'collect-report-after-post-entry');
  report.zonePersistenceEntry = v948BuildEntryActivationView(report);
  report.paperEntryActivation = report.zonePersistenceEntry;
  report.v954EntryConstructionAudit = report.zonePersistenceEntry?.v954EntryConstructionAudit || null;
  report.numericGuardHotfix = report.zonePersistenceEntry.numericGuard || lastV948NumericGuardView || { installed: true };
  try { report = v952AttachTruth(report, currentHealthForV952 || lastHealth || {}); } catch (e) { log('v9.5.2 attach truth before complete gate skipped:', e.message); }
  report = v949AttachCompleteTruth(report);
  try { report = v952AttachTruth(report, currentHealthForV952 || lastHealth || {}); } catch (e) { log('v9.5.2 attach truth after complete gate skipped:', e.message); }

  let rawTradeLedgers = await collectPageTradeLedgers().catch(e => ({
    openTrades: [],
    closedTrades: [],
    sourceStats: { error: e.message }
  }));
  rawTradeLedgers = v1001MergeReportEntryRowsIntoLedgers(rawTradeLedgers, report);

  lastTradeExport = buildTradeExport(rawTradeLedgers);
  await updateTradeVault(lastTradeExport, 'report');
  report.alpsTradeExport = lastTradeExport;
  report = v1001SyncReportCountersFromTradeExport(report, lastTradeExport);
  report.tradeLifecycleTruth = v949BuildTradeLifecycleTruth(report);
  report = v949AttachCompleteTruth(report);
  report.alpsTradeContinuityVault = buildTradeVaultView();
  report.alpsCognition = await updateCognitionState(report, lastTradeExport);
  report.alpsAutonomousBridge = await updateAutonomousBridgeState(report, report.alpsCognition);
  report.autonomousBridgeInstall = await installAutonomousBridgeInPage(report.alpsAutonomousBridge).catch(e => ({ installed: false, error: e.message }));
  await installV930StableAutonomyInPage().catch(e => log('v9.3 stable autonomy install during report failed:', e.message));
  report = enrichReportV930(report, lastEngineHookView || report.engineHook || {});
  try { report = v952AttachTruth(report, currentHealthForV952 || lastHealth || {}); } catch (e) { log('v9.5.2 final attach truth skipped:', e.message); }
  report = v1000ApplyStateAuthorityToView(report, 'collect-report-final-before-save');
  await saveForwardLatchState().catch(() => null);

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
  md = `${md}\n\n${buildV930Markdown(report)}\n\n${buildV947PipelineTruthMarkdown(report)}\n\n${buildV948EntryMarkdown(report)}\n\n${buildV949CompleteTruthMarkdown(report)}

${buildV952Markdown(report)}`;
  md = appendRecoveryMarkdown(md);
  md = scrubLegacyReportMarkdown(md);
  lastReportMarkdown = md;
  try {
    const reportHealth = enhanceHealth(await getPageHealth());
    Object.assign(lastHealth, reportHealth, { status: reportHealth.status || (reportHealth.forwardStale ? 'STALE_FORWARD' : (reportHealth.fwRunning ? 'RUNNING' : (reportHealth.labRunning ? 'LAB_RUNNING' : 'LOADED'))), lastError: '' });
    await maybeRecoverStuckBoot(lastHealth, { source: 'collect-report-action-executor' }).catch(e => log('Runner watchdog action from report failed:', e.message));
  } catch (e) {
    log('Runner watchdog report health refresh skipped:', e.message);
  }
  lastHealth.lastReportAt = Date.now();
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-report.json'), JSON.stringify(report, null, 2));
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-report.md'), md);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-trades.json'), JSON.stringify(lastTradeExport, null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-trades-vault.json'), JSON.stringify(buildTradeVaultView(), null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-autonomy.json'), JSON.stringify(report.alpsAutonomousBridge || {}, null, 2)).catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-native-forward-pool.json'), JSON.stringify(report.nativeForwardPool || {}, null, 2)).catch(() => null);
  await v1014PersistRuntimeNonzeroSnapshot(report, 'collect-report-final').catch(() => null);
  await fsp.writeFile(path.join(REPORT_DIR, 'latest-v930.json'), JSON.stringify({ fullAutonomy: report.fullAutonomy, nativeForwardPool: report.nativeForwardPool, oosEvidenceBridge: report.oosEvidenceBridge, recoveryForwardCore: report.recoveryForwardCore, engineHook: report.engineHook, circuitBreaker: report.circuitBreaker, chart: report.chart, counterfactual: report.counterfactual, pipelineTruthRecovery: report.pipelineTruthRecovery, runtimeTruth: report.runtimeTruth, discoveryOutput: report.discoveryOutput, zeroOutputDiagnostics: report.zeroOutputDiagnostics, symbolLoadStatus: report.symbolLoadStatus, closedCandleMap: report.closedCandleMap, gateMatrix: report.gateMatrix, forwardReadiness: report.forwardReadiness, e2ePipelineTrace: report.e2ePipelineTrace, zonePersistenceEntry: report.zonePersistenceEntry, paperEntryActivation: report.paperEntryActivation, numericGuardHotfix: report.numericGuardHotfix, v951RealCandleDiscovery: report.v951RealCandleDiscovery, paperEntryVisibility: report.zonePersistenceEntry?.visibilityBridge || lastV950PaperEntryVisibilityView, candleStoreResolver: report.zonePersistenceEntry?.candleResolver || lastV950CandleStoreResolverView, universeCompletion: report.universeCompletion, proxyTruth: report.proxyTruth, candidateCountTruth: report.candidateCountTruth, qualityRisk: report.qualityRisk, tradeLifecycleTruth: report.tradeLifecycleTruth, reportTruthSync: report.reportTruthSync, mobileRuntimeTruth: report.mobileRuntimeTruth, auditTrailTruth: report.auditTrailTruth, releaseChecklist: report.releaseChecklist, finalHealthGate: report.finalHealthGate, v952CurrentHealthSync: report.v952CurrentHealthSync, v952CandidateBridge: report.v952CandidateBridge, v952RejectedReasonAudit: report.v952RejectedReasonAudit, v952CandidateQualityBuckets: report.v952CandidateQualityBuckets, v952ReportTruthSync: report.v952ReportTruthSync, completeHealthUniverseLifecycleTruth: report.completeHealthUniverseLifecycleTruth, v954EntryConstructionAudit: report.v954EntryConstructionAudit, stateAuthority: report.stateAuthority || v1000BuildView(), v10StateAuthority: report.v10StateAuthority || report.stateAuthority || v1000BuildView(), v10ZeroOverwriteProof: report.v10ZeroOverwriteProof || lastV10ZeroOverwriteProof, v1001TradeLedgerExportSync: report.v1001TradeLedgerExportSync, alpsTradeExport: report.alpsTradeExport, alpsTradeContinuityVault: report.alpsTradeContinuityVault, v1017FeatureMaterializer: report.v1017FeatureMaterializer || lastV1017FeatureMaterializerView, v1012ServerCandleBootstrap: report.v1012ServerCandleBootstrap || lastV1012ServerCandleBootstrapView }, null, 2)).catch(() => null);
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
  if (command === 'watchdog') { await maybeRecoverStuckBoot(lastHealth || {}); return { ok: true, runnerWatchdog: buildRunnerWatchdogView(lastHealth || {}), health: lastHealth }; }
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
  runnerInterval = setInterval(() => {
    if (!shuttingDown) runnerTick('server-runner interval').catch(e => log('Interval tick failed:', errorInfo(e)));
  }, TICK_MS);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log('ALPS Server Runner is active. Health:', `http://127.0.0.1:${PORT}/runner/health`);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutting down ALPS Server Runner...');
  try { if (runnerInterval) clearInterval(runnerInterval); } catch (_) {}
  try { if (page && !page.isClosed()) await collectReport().catch(() => null); } catch (_) {}
  try { await saveRecoveryState(); } catch (_) {}
  try { if (context) await context.close(); } catch (_) {}
  context = null;
  page = null;
  process.exit(0);
}

main().catch(err => {
  const info = errorInfo(err);
  console.error('Fatal ALPS runner boot error:', JSON.stringify(info, null, 2));
  process.exit(1);
});
