'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const readline = require('readline');
const { URL } = require('url');
const v8 = require('v8');
const { EvidenceStatisticalScoringEngine } = require('./evidence-scoring-v1206');

const VERSION = 'v12.0.6-evidence-statistical-scoring';
const CANDIDATE_ENGINE_VERSION = 'v12.0.5.1-forward-time-integrity-guard';
const SCHEMA = 'alps.gen2.multiMarket.v1206';
const V11_ROOT_DEFAULT = '/var/data/alps/v11';
const V12_ROOT_DEFAULT = fs.existsSync('/var/data') ? '/var/data/alps/v12' : path.resolve(process.cwd(), 'data', 'v12');

const FOREX_PAIRS = Object.freeze([
  { canonical:'EUR/USD', key:'EURUSD', provider:'EUR/USD' },
  { canonical:'GBP/USD', key:'GBPUSD', provider:'GBP/USD' },
  { canonical:'USD/JPY', key:'USDJPY', provider:'USD/JPY' },
  { canonical:'USD/CHF', key:'USDCHF', provider:'USD/CHF' },
  { canonical:'USD/CAD', key:'USDCAD', provider:'USD/CAD' },
  { canonical:'AUD/USD', key:'AUDUSD', provider:'AUD/USD' },
  { canonical:'NZD/USD', key:'NZDUSD', provider:'NZD/USD' },
  { canonical:'EUR/JPY', key:'EURJPY', provider:'EUR/JPY' },
  { canonical:'GBP/JPY', key:'GBPJPY', provider:'GBP/JPY' },
]);

const CRYPTO_SYMBOLS = Object.freeze([
  { canonical:'BTC/USDT', key:'BTCUSDT', provider:'BTCUSDT' },
  { canonical:'ETH/USDT', key:'ETHUSDT', provider:'ETHUSDT' },
  { canonical:'SOL/USDT', key:'SOLUSDT', provider:'SOLUSDT' },
  { canonical:'BNB/USDT', key:'BNBUSDT', provider:'BNBUSDT' },
  { canonical:'XRP/USDT', key:'XRPUSDT', provider:'XRPUSDT' },
  { canonical:'DOGE/USDT', key:'DOGEUSDT', provider:'DOGEUSDT' },
  { canonical:'XAUT/USDT', key:'XAUTUSDT', provider:'XAUTUSDT' },
]);

const CRYPTO_FRAMES = Object.freeze([
  { key:'5m', provider:'5m', intervalMs:5 * 60_000 },
  { key:'15m', provider:'15m', intervalMs:15 * 60_000 },
  { key:'30m', provider:'30m', intervalMs:30 * 60_000 },
  { key:'1h', provider:'1h', intervalMs:60 * 60_000 },
  { key:'4h', provider:'4h', intervalMs:4 * 60 * 60_000 },
]);

function envNumber(name, fallback, min = -Infinity, max = Infinity) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0','false','no','off'].includes(String(raw).trim().toLowerCase());
}

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function randomId(prefix = 'lease') { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function utcDayKey(value = Date.now()) { return new Date(value).toISOString().slice(0, 10); }
function nextUtcDayResumeAt(value = Date.now()) {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5, 0, 0);
}
function coverageDays(candles) {
  return Array.isArray(candles) && candles.length > 1 ? Math.max(0, (candles.at(-1).t - candles[0].t) / 86_400_000) : 0;
}
function parseTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n < 10_000_000_000 ? Math.round(n * 1000) : Math.round(n);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

class MemoryTracker {
  constructor({ now = () => Date.now(), log = () => {} } = {}) {
    this.now = now; this.log = log;
    this.state = {
      rssMb:0, heapUsedMb:0, heapTotalMb:0, externalMb:0, arrayBuffersMb:0,
      heapLimitMb:Number((v8.getHeapStatistics().heap_size_limit / 1048576).toFixed(2)),
      peakHeapUsedMb:0, peakRssMb:0, memoryPhase:'CREATED', memoryPair:null, memoryFrame:null,
      updatedAt:iso(now()), checkpoints:0,
    };
    this.sample('CREATED');
  }
  sample(phase = null, pair = undefined, frame = undefined) {
    const m = process.memoryUsage();
    const mb = value => Number((Number(value || 0) / 1048576).toFixed(2));
    this.state.rssMb = mb(m.rss); this.state.heapUsedMb = mb(m.heapUsed); this.state.heapTotalMb = mb(m.heapTotal);
    this.state.externalMb = mb(m.external); this.state.arrayBuffersMb = mb(m.arrayBuffers);
    this.state.peakHeapUsedMb = Math.max(Number(this.state.peakHeapUsedMb || 0), this.state.heapUsedMb);
    this.state.peakRssMb = Math.max(Number(this.state.peakRssMb || 0), this.state.rssMb);
    if (phase != null) this.state.memoryPhase = String(phase);
    if (pair !== undefined) this.state.memoryPair = pair;
    if (frame !== undefined) this.state.memoryFrame = frame;
    this.state.updatedAt = iso(this.now()); this.state.checkpoints = Number(this.state.checkpoints || 0) + 1;
    return this.view();
  }
  async checkpoint(phase, pair = null, frame = null) {
    this.sample(phase, pair, frame);
    await new Promise(resolve => setImmediate(resolve));
    if (global.gc && process.env.ALPS_V12_EXPLICIT_GC === '1') { try { global.gc(); } catch (_) {} }
    return this.sample(phase, pair, frame);
  }
  view() { return { ...this.state }; }
}

function loadConfig() {
  const dataRoot = path.resolve(process.env.ALPS_V12_DATA_ROOT || V12_ROOT_DEFAULT);
  const legacyRoot = path.resolve(process.env.ALPS_V11_DATA_ROOT || V11_ROOT_DEFAULT);
  const hardDailyCredits = envNumber('ALPS_TD_DAILY_HARD_LIMIT', 600, 50, 799);
  return {
    version:VERSION,
    schema:SCHEMA,
    host:process.env.HOST || '0.0.0.0',
    port:envNumber('PORT', 8787, 1, 65535),
    token:String(process.env.ALPS_RUNNER_TOKEN || '').trim(),
    dataRoot,
    legacyRoot,
    paperOnly:true,
    legacyEngineEnabled:false,
    newsEnabled:false,
    forexEnabled:envBool('ALPS_FOREX_CORE_ENABLED', true),
    cryptoEnabled:envBool('ALPS_CRYPTO_CORE_ENABLED', true),
    forexPairs:FOREX_PAIRS,
    cryptoSymbols:CRYPTO_SYMBOLS,
    cryptoFrames:CRYPTO_FRAMES,
    forex:{
      apiKey:String(process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY || '').trim(),
      providerBaseUrl:'https://api.twelvedata.com',
      interval:'5min', intervalMs:5 * 60_000,
      refreshIntervalMs:envNumber('ALPS_V12_FOREX_REFRESH_MS', 30 * 60_000, 15 * 60_000, 4 * 60 * 60_000),
      minLiveRequestGapMs:envNumber('ALPS_V12_MIN_LIVE_REQUEST_GAP_MS', 25 * 60_000, 5 * 60_000, 4 * 60 * 60_000),
      interSymbolDelayMs:envNumber('ALPS_V12_INTER_SYMBOL_DELAY_MS', 8_000, 0, 60_000),
      requestTimeoutMs:envNumber('ALPS_V12_PROVIDER_TIMEOUT_MS', 20_000, 5_000, 60_000),
      leaseSafetyMarginMs:envNumber('ALPS_V12_FOREX_LEASE_MARGIN_MS', 25_000, 5_000, 5 * 60_000),
      persistTimeoutMs:envNumber('ALPS_V12_FOREX_PERSIST_TIMEOUT_MS', 10_000, 1_000, 60_000),
      watchdogIntervalMs:envNumber('ALPS_V12_FOREX_WATCHDOG_INTERVAL_MS', 30_000, 5_000, 5 * 60_000),
      backfillMaxRequestsPerCycle:envNumber('ALPS_V12_FOREX_BACKFILL_REQUESTS_PER_CYCLE', 3, 0, 20),
      backfillCycleYieldMarginMs:envNumber('ALPS_V12_FOREX_BACKFILL_YIELD_MARGIN_MS', 120_000, 30_000, 15 * 60_000),
      staleMarketDataMs:envNumber('ALPS_V12_STALE_MARKET_DATA_MS', 90 * 60_000, 30 * 60_000, 24 * 60 * 60_000),
      candleCloseBufferMs:envNumber('ALPS_V12_CANDLE_CLOSE_BUFFER_MS', 30_000, 5_000, 120_000),
      backfillCoverageDays:envNumber('ALPS_V12_BACKFILL_COVERAGE_DAYS', 180, 30, 3650),
      backfillOutputSize:envNumber('ALPS_V12_BACKFILL_OUTPUT_SIZE', 5000, 100, 5000),
      liveOutputSize:envNumber('ALPS_V12_LIVE_OUTPUT_SIZE', 500, 20, 5000),
      hardDailyCredits,
      scheduledCreditCeiling:envNumber('ALPS_TD_SCHEDULED_CEILING', Math.min(540, hardDailyCredits - 20), 1, hardDailyCredits),
      rawDir:path.join(dataRoot, 'raw'),
      cleanDir:path.join(dataRoot, 'clean'),
      stateFile:path.join(dataRoot, 'state', 'forex-core-state.json'),
      budgetFile:path.join(dataRoot, 'state', 'twelve-data-budget.json'),
      leaseFile:path.join(dataRoot, 'state', 'twelve-data-request-lease.json'),
      migrationFile:path.join(dataRoot, 'state', 'v11-readonly-import.json'),
      hypothesesFile:path.join(dataRoot, 'hypotheses', 'forex-hypotheses.json'),
    },
    crypto:{
      providerBaseUrl:String(process.env.ALPS_BINANCE_MARKET_DATA_URL || 'https://data-api.binance.vision').replace(/\/$/, ''),
      refreshIntervalMs:envNumber('ALPS_V12_CRYPTO_REFRESH_MS', 5 * 60_000, 60_000, 60 * 60_000),
      minLiveRequestGapMs:envNumber('ALPS_V12_CRYPTO_MIN_LIVE_GAP_MS', 4 * 60_000, 30_000, 60 * 60_000),
      interRequestDelayMs:envNumber('ALPS_V12_CRYPTO_INTER_REQUEST_DELAY_MS', 300, 100, 10_000),
      requestTimeoutMs:envNumber('ALPS_V12_CRYPTO_PROVIDER_TIMEOUT_MS', 15_000, 3_000, 60_000),
      staleMultiplier:envNumber('ALPS_V12_CRYPTO_STALE_MULTIPLIER', 3.25, 2, 12),
      candleCloseBufferMs:envNumber('ALPS_V12_CRYPTO_CLOSE_BUFFER_MS', 15_000, 2_000, 120_000),
      backfillCoverageDays:envNumber('ALPS_V12_CRYPTO_HISTORY_DAYS', 180, 30, 3650),
      liveLimit:envNumber('ALPS_V12_CRYPTO_LIVE_LIMIT', 500, 20, 1000),
      backfillLimit:envNumber('ALPS_V12_CRYPTO_BACKFILL_LIMIT', 1000, 100, 1000),
      backfillRequestsPerRun:envNumber('ALPS_V12_CRYPTO_BACKFILL_REQUESTS_PER_RUN', 70, 1, 300),
      maxCandlesPerFrame:envNumber('ALPS_V12_CRYPTO_MAX_CANDLES_PER_FRAME', 60000, 12000, 100000),
      rawDir:path.join(dataRoot, 'crypto', 'raw'),
      cleanDir:path.join(dataRoot, 'crypto', 'clean'),
      stateFile:path.join(dataRoot, 'state', 'crypto-core-state.json'),
      providerStateFile:path.join(dataRoot, 'state', 'binance-market-data-state.json'),
      migrationFile:path.join(dataRoot, 'state', 'v11-crypto-readonly-import.json'),
      hypothesesFile:path.join(dataRoot, 'hypotheses', 'crypto-hypotheses.json'),
      continuityFile:path.join(dataRoot, 'reports', 'crypto-continuity-audit.json'),
      forwardShadowFile:path.join(dataRoot, 'state', 'crypto-forward-shadow-foundation.json'),
      historicalEvidenceFile:path.join(dataRoot, 'evidence', 'legacy-crypto-paper-evidence.json'),
      provisionalCandidateStateFile:path.join(dataRoot, 'state', 'crypto-forward-shadow-candidate-engine.json'),
      provisionalCandidateLedgerFile:path.join(dataRoot, 'evidence', 'crypto-forward-shadow-ledger.ndjson'),
      certifiedCandidateStateFile:path.join(dataRoot, 'state', 'crypto-forward-shadow-candidate-engine-v12051.json'),
      certifiedCandidateLedgerFile:path.join(dataRoot, 'evidence', 'crypto-forward-shadow-ledger-v12051.ndjson'),
      provisionalCandidateManifestFile:path.join(dataRoot, 'evidence', 'crypto-forward-shadow-v1205-provisional-manifest.json'),
      candidateStateFile:path.join(dataRoot, 'state', 'crypto-forward-shadow-candidate-engine-v12051.json'),
      candidateLedgerFile:path.join(dataRoot, 'evidence', 'crypto-forward-shadow-ledger-v12051.ndjson'),
      candidateRecentClosedLimit:envNumber('ALPS_V12_FORWARD_RECENT_CLOSED_LIMIT', 200, 10, 5000),
      continuityMaxGapRanges:envNumber('ALPS_V12_CONTINUITY_MAX_GAP_RANGES', 25, 1, 250),
      evidenceMaxFiles:envNumber('ALPS_V12_EVIDENCE_MAX_FILES', 250, 1, 2000),
      evidenceMaxBytesPerFile:envNumber('ALPS_V12_EVIDENCE_MAX_BYTES_PER_FILE', 8 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    },
    scoring:{
      enabled:envBool('ALPS_V12_EVIDENCE_SCORING_ENABLED', true),
      certifiedLedgerFile:path.join(dataRoot, 'evidence', 'crypto-forward-shadow-ledger-v12051.ndjson'),
      clusterOutcomesFile:path.join(dataRoot, 'evidence', 'scoring', 'cluster-outcomes.ndjson'),
      hypothesisScoresFile:path.join(dataRoot, 'evidence', 'scoring', 'hypothesis-scores.ndjson'),
      snapshotsFile:path.join(dataRoot, 'evidence', 'statistical-scoring-snapshots.ndjson'),
      stateFile:path.join(dataRoot, 'state', 'evidence-scoring-state.json'),
      thresholds:{
        minScoredClusters:30, confidenceLevel:0.95, z:1.96, primaryLeg:'R1',
        entryModelStarvedRate:0.80, entryModelStarvedMinNominations:25,
      },
    },
    importLegacyOnStartup:envBool('ALPS_V12_IMPORT_V11_READONLY', true),
    maxLegacyFiles:envNumber('ALPS_V12_MAX_LEGACY_FILES', 3000, 100, 10000),
    maxLegacyFileBytes:envNumber('ALPS_V12_MAX_LEGACY_FILE_BYTES', 64 * 1024 * 1024, 1024, 512 * 1024 * 1024),
  };
}

class SafeStorage {
  constructor(config) { this.config = config; }
  async init() {
    const dirs = [
      this.config.dataRoot,
      this.config.forex.rawDir, this.config.forex.cleanDir,
      this.config.crypto.rawDir, this.config.crypto.cleanDir,
      path.join(this.config.dataRoot, 'state'),
      path.join(this.config.dataRoot, 'hypotheses'),
      path.join(this.config.dataRoot, 'reports'),
      path.join(this.config.dataRoot, 'evidence'),
      path.join(this.config.dataRoot, 'evidence', 'scoring'),
    ];
    await Promise.all(dirs.map(dir => fsp.mkdir(dir, { recursive:true })));
  }
  assertV12Write(target) {
    const resolved = path.resolve(target);
    const root = path.resolve(this.config.dataRoot) + path.sep;
    if (!(resolved + (resolved.endsWith(path.sep) ? '' : path.sep)).startsWith(root) && resolved !== path.resolve(this.config.dataRoot)) {
      throw new Error(`WRITE_OUTSIDE_V12_ROOT_BLOCKED:${resolved}`);
    }
    const legacy = path.resolve(this.config.legacyRoot);
    if (resolved === legacy || resolved.startsWith(legacy + path.sep)) throw new Error(`V11_WRITE_BLOCKED:${resolved}`);
  }
  async readJson(file, fallback = null) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return fallback; }
  }
  async writeJsonAtomic(file, payload) {
    this.assertV12Write(file);
    await fsp.mkdir(path.dirname(file), { recursive:true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(payload, null, 2));
    await fsp.rename(temp, file);
  }
  async readNdjson(file) {
    const rows = [];
    try {
      const input = fs.createReadStream(file, 'utf8');
      const rl = readline.createInterface({ input, crlfDelay:Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch (_) {}
      }
    } catch (_) {}
    return rows;
  }
  async writeNdjsonAtomic(file, rows, meta = null) {
    this.assertV12Write(file);
    await fsp.mkdir(path.dirname(file), { recursive:true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const text = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
    await fsp.writeFile(temp, text);
    await fsp.rename(temp, file);
    if (meta) await this.writeJsonAtomic(`${file}.meta.json`, meta);
  }
  async appendNdjson(file, row) {
    this.assertV12Write(file);
    await fsp.mkdir(path.dirname(file), { recursive:true });
    await fsp.appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
  }
  async appendNdjsonLines(file, lines) {
    this.assertV12Write(file);
    await fsp.mkdir(path.dirname(file), { recursive:true });
    const rows=(Array.isArray(lines)?lines:[lines]).map(line=>String(line).replace(/\n+$/g,'')).filter(Boolean);
    if(!rows.length)return;
    await fsp.appendFile(file, `${rows.join('\n')}\n`, 'utf8');
  }
  async readNdjsonTail(file, limit = 200, maxBytes = 1024 * 1024) {
    try {
      const stat=await fsp.stat(file);if(!stat.size)return[];
      const size=Math.min(stat.size,maxBytes);const start=Math.max(0,stat.size-size);const handle=await fsp.open(file,'r');
      try {
        const buffer=Buffer.alloc(size);await handle.read(buffer,0,size,start);
        let text=buffer.toString('utf8');if(start>0){const cut=text.indexOf('\n');text=cut>=0?text.slice(cut+1):'';}
        const rows=[];for(const line of text.split('\n')){if(!line.trim())continue;try{rows.push(JSON.parse(line));}catch(_){}}
        return rows.slice(-Math.max(1,limit));
      } finally {await handle.close();}
    } catch (_) {return[];}
  }
  forexFile(dir, key) { return path.join(dir, `${key}.ndjson`); }
  cryptoFile(dir, symbol, frame) { return path.join(dir, symbol, `${frame}.ndjson`); }
  readForex(dir, key) { return this.readNdjson(this.forexFile(dir, key)); }
  writeForex(dir, pair, rows, meta) { return this.writeNdjsonAtomic(this.forexFile(dir, pair.key), rows, { pair:pair.canonical, key:pair.key, ...meta, writtenAt:iso() }); }
  readCrypto(dir, symbol, frame) { return this.readNdjson(this.cryptoFile(dir, symbol, frame)); }
  writeCrypto(dir, symbol, frame, rows, meta) { return this.writeNdjsonAtomic(this.cryptoFile(dir, symbol, frame), rows, { symbol, frame, ...meta, writtenAt:iso() }); }
}

function normalizeCandle(row, intervalMs = 5 * 60_000) {
  if (Array.isArray(row)) {
    const [t,o,h,l,c,v,closeTime] = row;
    const parsedT=parseTimestamp(t);
    return {
      t:parsedT,o:finite(o),h:finite(h),l:finite(l),c:finite(c),v:finite(v),
      closeTime:parseTimestamp(closeTime)||(parsedT==null?null:parsedT+intervalMs-1),
      validForSignals:true,validForAggregation:true,flat:false,sourceFlatBars:0,
    };
  }
  if (!row || typeof row !== 'object') return null;
  const t = parseTimestamp(row.t ?? row.time ?? row.timestamp ?? row.datetime ?? row.date ?? row.openTime);
  return {
    t,
    o:finite(row.o ?? row.open), h:finite(row.h ?? row.high), l:finite(row.l ?? row.low), c:finite(row.c ?? row.close), v:finite(row.v ?? row.volume),
    closeTime:parseTimestamp(row.closeTime ?? row.close_time ?? row.endTime) || (t == null ? null : t + intervalMs - 1),
    validForSignals:row.validForSignals !== false,
    validForAggregation:row.validForAggregation !== false,
    flat:row.flat === true,
    sourceFlatBars:Number.isFinite(Number(row.sourceFlatBars)) ? Number(row.sourceFlatBars) : 0,
    containsNonSignalSource:row.containsNonSignalSource === true,
  };
}
function validOhlc(c) {
  return !!c && Number.isFinite(c.t) && [c.o,c.h,c.l,c.c].every(n => Number.isFinite(n) && n > 0) && c.h >= c.l && c.h >= Math.max(c.o,c.c) && c.l <= Math.min(c.o,c.c);
}
function isFlat(c) {
  const scale = Math.max(Math.abs(c.o),Math.abs(c.h),Math.abs(c.l),Math.abs(c.c),1);
  return Math.max(c.o,c.h,c.l,c.c) - Math.min(c.o,c.h,c.l,c.c) <= scale * 1e-12;
}
function mergeCandles(existing, incoming, intervalMs, maxRows = Infinity) {
  const map = new Map();
  for (const row of existing.concat(incoming)) {
    const c = normalizeCandle(row, intervalMs);
    if (!validOhlc(c)) continue;
    const prior = map.get(c.t);
    if (!prior || ((Number(c.v) || 0) >= (Number(prior.v) || 0))) map.set(c.t, c);
  }
  const rows = [...map.values()].sort((a,b) => a.t - b.t);
  return Number.isFinite(maxRows) && rows.length > maxRows ? rows.slice(-maxRows) : rows;
}


function latestClosedOpenTime(now, intervalMs, closeBufferMs) {
  const effectiveNow = Number(now) - Number(closeBufferMs || 0);
  return Math.floor(effectiveNow / intervalMs) * intervalMs - intervalMs;
}

function aggregateCanonicalCandles(candles, sourceIntervalMs, targetIntervalMs) {
  if (!Array.isArray(candles) || !candles.length) return [];
  if (!Number.isFinite(sourceIntervalMs) || !Number.isFinite(targetIntervalMs) || targetIntervalMs <= sourceIntervalMs || targetIntervalMs % sourceIntervalMs !== 0) {
    throw new Error('INVALID_CANONICAL_AGGREGATION_INTERVAL');
  }
  const expected = targetIntervalMs / sourceIntervalMs;
  const buckets = new Map();
  for (const row of candles) {
    const candle = normalizeCandle(row, sourceIntervalMs);
    if (!validOhlc(candle) || candle.validForAggregation === false) continue;
    const bucket = Math.floor(candle.t / targetIntervalMs) * targetIntervalMs;
    const list = buckets.get(bucket) || [];
    list.push(candle);
    buckets.set(bucket, list);
  }
  const output = [];
  for (const [bucket, list] of [...buckets.entries()].sort((a,b) => a[0] - b[0])) {
    list.sort((a,b) => a.t - b.t);
    if (list.length !== expected) continue;
    if (list[0].t !== bucket || list.at(-1).t !== bucket + targetIntervalMs - sourceIntervalMs) continue;
    let contiguous = true;
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].t - list[i - 1].t !== sourceIntervalMs) { contiguous = false; break; }
    }
    if (!contiguous) continue;
    const volumeValues = list.map(c => finite(c.v)).filter(Number.isFinite);
    const sourceFlatBars=list.filter(c=>c.flat===true||c.validForSignals===false).length;
    const aggregated={
      t:bucket,
      o:list[0].o,
      h:Math.max(...list.map(c => c.h)),
      l:Math.min(...list.map(c => c.l)),
      c:list.at(-1).c,
      v:volumeValues.length ? volumeValues.reduce((sum, value) => sum + value, 0) : null,
      closeTime:bucket + targetIntervalMs - 1,
      sourceFlatBars,
      containsNonSignalSource:sourceFlatBars>0,
      validForAggregation:true,
      validForSignals:true,
      flat:false,
    };
    if(isFlat(aggregated)){aggregated.flat=true;aggregated.validForSignals=false;}
    output.push(aggregated);
  }
  return output;
}

function auditContinuity(candles, intervalMs, { maxGapRanges=25 } = {}) {
  const map=new Map();
  for(const row of Array.isArray(candles)?candles:[]){
    const candle=normalizeCandle(row,intervalMs);
    if(!validOhlc(candle)||candle.validForAggregation===false)continue;
    map.set(candle.t,candle);
  }
  const rows=[...map.values()].sort((a,b)=>a.t-b.t);
  if(!rows.length)return{
    expectedBars:0,actualBars:0,missingBars:0,continuityRatio:0,continuityPercent:0,
    largestGapMinutes:null,gapRanges:[],gapRangesTruncated:false,firstAt:null,latestAt:null,
    aligned:true,continuityPassed:false,status:'FAIL_NO_DATA'
  };
  const first=rows[0].t;
  const last=rows.at(-1).t;
  const expectedBars=Math.floor((last-first)/intervalMs)+1;
  let missingBars=0;
  let largestGapMinutes=0;
  let irregularIntervals=0;
  const gapRanges=[];
  for(let i=1;i<rows.length;i+=1){
    const delta=rows[i].t-rows[i-1].t;
    if(delta===intervalMs)continue;
    if(delta<=0){irregularIntervals++;continue;}
    const steps=Math.round(delta/intervalMs);
    const exact=Math.abs(delta-steps*intervalMs)<1;
    if(!exact)irregularIntervals++;
    const missing=Math.max(0,steps-1);
    if(!missing)continue;
    missingBars+=missing;
    largestGapMinutes=Math.max(largestGapMinutes,(delta-intervalMs)/60_000);
    if(gapRanges.length<maxGapRanges){
      gapRanges.push({
        from:iso(rows[i-1].t+intervalMs),
        to:iso(rows[i].t-intervalMs),
        missingBars:missing,
        gapMinutes:Number(((delta-intervalMs)/60_000).toFixed(3)),
      });
    }
  }
  const actualBars=rows.length;
  const ratio=expectedBars>0?actualBars/expectedBars:0;
  const aligned=rows.every(row=>row.t%intervalMs===0);
  const continuityPassed=missingBars===0&&irregularIntervals===0&&actualBars===expectedBars&&aligned;
  return{
    expectedBars,actualBars,missingBars,
    continuityRatio:Number(ratio.toFixed(8)),
    continuityPercent:Number((ratio*100).toFixed(5)),
    largestGapMinutes:Number(largestGapMinutes.toFixed(3)),
    gapRanges,
    gapRangesTruncated:missingBars>gapRanges.reduce((sum,g)=>sum+g.missingBars,0),
    irregularIntervals,
    firstAt:iso(first),
    latestAt:iso(last),
    aligned,
    continuityPassed,
    status:continuityPassed?'PASS':'FAIL_GAPS_DETECTED',
  };
}

function isFxWeekend(ms) {
  const d = new Date(ms); const day = d.getUTCDay(); const hour = d.getUTCHours();
  return day === 6 || (day === 0 && hour < 21) || (day === 5 && hour >= 21);
}
function isFxMarketOpen(ms = Date.now()) { return !isFxWeekend(ms); }

function cleanCandles(rows, { now = Date.now(), intervalMs, closeBufferMs, staleMs, assetClass, removeFlat = false, preserveFlatForAggregation = false } = {}) {
  const stats = {
    input:Array.isArray(rows) ? rows.length : 0,
    invalid:0,futureOrOpen:0,weekend:0,flat:0,duplicates:0,output:0,
    signalEligible:0,aggregationEligible:0,
  };
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const c = normalizeCandle(row, intervalMs);
    if (!validOhlc(c)) { stats.invalid += 1; continue; }
    const closedAt = Number.isFinite(c.closeTime) ? c.closeTime : c.t + intervalMs - 1;
    if (c.t > now || closedAt > now - closeBufferMs) { stats.futureOrOpen += 1; continue; }
    if (assetClass === 'FOREX' && isFxWeekend(c.t)) { stats.weekend += 1; continue; }
    const flat=isFlat(c);
    c.flat=flat;
    c.validForAggregation=c.validForAggregation!==false;
    c.validForSignals=c.validForSignals!==false;
    if (flat) {
      stats.flat += 1;
      c.validForSignals=false;
      c.validForAggregation=true;
      if (removeFlat && !preserveFlatForAggregation) continue;
    }
    if (map.has(c.t)) stats.duplicates += 1;
    const prior = map.get(c.t);
    if (!prior || ((Number(c.v)||0) >= (Number(prior.v)||0))) map.set(c.t, c);
  }
  const candles = [...map.values()].sort((a,b) => a.t - b.t);
  stats.output = candles.length;
  stats.signalEligible=candles.filter(c=>c.validForSignals!==false).length;
  stats.aggregationEligible=candles.filter(c=>c.validForAggregation!==false).length;
  stats.coverageDays = Number(coverageDays(candles).toFixed(3));
  stats.firstAt = candles.length ? iso(candles[0].t) : null;
  stats.latestAt = candles.length ? iso(candles.at(-1).t) : null;
  const age = candles.length ? Math.max(0, now - (candles.at(-1).closeTime || candles.at(-1).t + intervalMs)) : Infinity;
  stats.staleAgeMinutes = Number.isFinite(age) ? Number((age / 60_000).toFixed(2)) : null;
  stats.marketOpen = assetClass === 'FOREX' ? isFxMarketOpen(now) : true;
  stats.stale = !candles.length || (stats.marketOpen && age > staleMs);
  stats.status = stats.stale ? 'STALE_PROVIDER_PRICE_REJECTED_FOR_FORWARD_USE' : 'CLEAN';
  return { candles, signalCandles:candles.filter(c=>c.validForSignals!==false), quality:stats };
}

async function awaitBounded(promise, ms) {
  // The caller may stop waiting; the underlying operation continues under queue control.
  let timer = null;
  const timed = new Promise(resolve => { timer = setTimeout(() => resolve({ ok:false, timedOut:true }), ms); timer.unref?.(); });
  const result = await Promise.race([promise, timed]);
  if (timer) clearTimeout(timer);
  return result;
}

class PersistenceQueue {
  // v12.0.4.4.1 — serialized per-file persistence with monotonic revisions and
  // latest-state coalescing. Fixes the persistence-ordering race in v12.0.4.4 where a
  // timed-out (but still running) writeJsonAtomic could later rename stale state over a
  // newer file (e.g. REQUEST_RESERVED overwriting a committed HTTP 429 breaker).
  //
  // Guarantees:
  //   * Only one physical write per state file executes at a time.
  //   * Every enqueue captures an immutable deep snapshot plus a monotonic
  //     persistRevision at enqueue time; later in-memory mutation cannot leak in.
  //   * An older queued write never executes after a newer revision was committed:
  //     the writer always takes the single latest pending snapshot (coalescing), and
  //     because writes are serialized, on-disk revision is monotonically non-decreasing.
  //   * Callers may stop waiting after persistTimeoutMs (awaitBounded); ordering is
  //     preserved regardless, because the queue — not the caller — owns the write.
  //   * durable entries (the HTTP 429 circuit breaker) are retained on disk failure and
  //     the DISK persistence alone is retried asynchronously with backoff. This never
  //     retries any Twelve Data HTTP request.
  constructor({ storage, log = () => {}, retryDelayMs = 1000, maxRetryDelayMs = 30000 }) {
    this.storage = storage; this.log = log;
    this.retryDelayMs = retryDelayMs; this.maxRetryDelayMs = maxRetryDelayMs;
    this.files = new Map(); this.appendFiles = new Map(); this.shuttingDown = false;
  }
  entry(file) {
    let e = this.files.get(file);
    if (!e) {
      e = { revision:0, committedRevision:0, pending:null, writing:false, waiters:[],
        lastError:null, lastCommittedAt:null, writesStarted:0, writesCommitted:0,
        writesFailed:0, writesCoalesced:0, retryTimer:null, retryDelay:this.retryDelayMs, retries:0 };
      this.files.set(file, e);
    }
    return e;
  }
  snapshot(state) { try { return structuredClone(state); } catch (_) { return JSON.parse(JSON.stringify(state)); } }
  appendEntry(file) {
    let e=this.appendFiles.get(file);
    if(!e){e={revision:0,committedRevision:0,queue:[],writing:false,waiters:[],lastError:null,lastCommittedAt:null,writesStarted:0,writesCommitted:0,writesFailed:0,retryTimer:null,retryDelay:this.retryDelayMs,retries:0};this.appendFiles.set(file,e);}
    return e;
  }
  enqueueAppend(file, lines, { durable = true } = {}) {
    const e=this.appendEntry(file);e.revision+=1;const revision=e.revision;
    const immutable=(Array.isArray(lines)?lines:[lines]).map(line=>typeof line==='string'?String(line):JSON.stringify(this.snapshot(line)));
    e.queue.push({revision,lines:immutable,durable:durable===true});
    const done=new Promise(resolve=>e.waiters.push({revision,resolve}));
    this.drainAppend(file,e);return{revision,done};
  }
  resolveAppendCommitted(e) {
    const committed=e.committedRevision;e.waiters=e.waiters.filter(w=>{if(w.revision<=committed){w.resolve({ok:true,committedRevision:committed});return false;}return true;});
  }
  failAppend(e, revision, error) {
    e.waiters=e.waiters.filter(w=>{if(w.revision<=revision){w.resolve({ok:false,error});return false;}return true;});
  }
  drainAppend(file,e) {
    if(e.writing||!e.queue.length)return;e.writing=true;const job=e.queue[0];e.writesStarted+=1;
    this.storage.appendNdjsonLines(file,job.lines).then(()=>{
      e.queue.shift();e.committedRevision=Math.max(e.committedRevision,job.revision);e.lastCommittedAt=new Date().toISOString();e.lastError=null;e.writesCommitted+=1;e.retryDelay=this.retryDelayMs;this.resolveAppendCommitted(e);
    }).catch(error=>{
      e.lastError=String(error&&error.message||error).slice(0,240);e.writesFailed+=1;
      if(job.durable&&!this.shuttingDown){e.retries+=1;e.retryTimer=setTimeout(()=>{e.retryTimer=null;this.drainAppend(file,e);},e.retryDelay);e.retryTimer.unref?.();e.retryDelay=Math.min(this.maxRetryDelayMs,e.retryDelay*2);this.log(`[v12.0.6] durable append retry scheduled for ${file} (rev ${job.revision}): ${e.lastError}`);}
      else{e.queue.shift();this.failAppend(e,job.revision,e.lastError);}
    }).finally(()=>{e.writing=false;if(!e.retryTimer)this.drainAppend(file,e);});
  }
  enqueue(file, state, { durable = false } = {}) {
    const e = this.entry(file);
    e.revision += 1;
    const revision = e.revision;
    if (e.pending) e.writesCoalesced += 1; // obsolete pending revision replaced by the newest snapshot
    const inheritedDurable = durable || (e.pending && e.pending.durable === true);
    e.pending = { revision, snapshot:this.snapshot(state), durable:inheritedDurable };
    if (e.retryTimer) { clearTimeout(e.retryTimer); e.retryTimer = null; }
    const done = new Promise(resolve => e.waiters.push({ revision, resolve }));
    this.drain(file, e);
    return { revision, done };
  }
  resolveCommitted(e) {
    const committed = e.committedRevision;
    e.waiters = e.waiters.filter(w => {
      if (w.revision <= committed) { w.resolve({ ok:true, committedRevision:committed }); return false; }
      return true;
    });
  }
  failUpTo(e, revision, error) {
    e.waiters = e.waiters.filter(w => {
      if (w.revision <= revision) { w.resolve({ ok:false, error }); return false; }
      return true;
    });
  }
  drain(file, e) {
    if (e.writing || !e.pending) return;
    e.writing = true;
    const job = e.pending; e.pending = null; // always the single latest snapshot
    e.writesStarted += 1;
    this.storage.writeJsonAtomic(file, job.snapshot)
      .then(() => {
        e.committedRevision = Math.max(e.committedRevision, job.revision);
        e.lastCommittedAt = new Date().toISOString();
        e.lastError = null; e.writesCommitted += 1; e.retryDelay = this.retryDelayMs;
        this.resolveCommitted(e);
      })
      .catch(error => {
        e.lastError = String(error && error.message || error).slice(0, 240);
        e.writesFailed += 1;
        if (job.durable && !e.pending && !this.shuttingDown) {
          // Retain the durable snapshot (circuitBreakerPersistencePending stays true at
          // the owner) and retry ONLY the disk persistence, asynchronously.
          e.pending = job;
          e.retries += 1;
          e.retryTimer = setTimeout(() => { e.retryTimer = null; this.drain(file, e); }, e.retryDelay);
          e.retryTimer.unref?.();
          e.retryDelay = Math.min(this.maxRetryDelayMs, e.retryDelay * 2);
          this.log(`[v12.0.6] durable persistence retry scheduled for ${file} (rev ${job.revision}): ${e.lastError}`);
        } else {
          this.failUpTo(e, job.revision, e.lastError);
        }
      })
      .finally(() => {
        e.writing = false;
        if (!e.retryTimer) this.drain(file, e);
      });
  }
  hasWorkPending() {
    for (const e of this.files.values()) if (e.writing || e.pending) return true;
    for (const e of this.appendFiles.values()) if (e.writing || e.queue.length) return true;
    return false;
  }
  async flush(deadlineMs = 3000) {
    // Process-shutdown flushing with a bounded deadline: drain retry timers immediately
    // and wait for in-flight/pending writes to settle, but never past the deadline.
    this.shuttingDown = true;
    for (const [file, e] of this.files.entries()) {
      if (e.retryTimer) { clearTimeout(e.retryTimer); e.retryTimer = null; this.drain(file, e); }
    }
    for (const [file, e] of this.appendFiles.entries()) {
      if (e.retryTimer) { clearTimeout(e.retryTimer); e.retryTimer = null; this.drainAppend(file, e); }
    }
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      if (!this.hasWorkPending()) return { ok:true, flushed:true };
      await sleep(25);
    }
    return { ok:false, flushed:false, reason:'FLUSH_DEADLINE_REACHED' };
  }
  viewAppend(file) {
    const e=this.appendFiles.get(file);
    if(!e)return{revision:0,committedRevision:0,pendingRevisions:[],writing:false,lastError:null};
    return{revision:e.revision,committedRevision:e.committedRevision,pendingRevisions:e.queue.map(job=>job.revision),writing:e.writing,lastError:e.lastError,lastCommittedAt:e.lastCommittedAt,writesStarted:e.writesStarted,writesCommitted:e.writesCommitted,writesFailed:e.writesFailed,retries:e.retries};
  }
  view(file) {
    const e = this.files.get(file);
    if (!e) return { revision:0, committedRevision:0, pendingRevision:null, writing:false, lastError:null };
    return {
      revision:e.revision, committedRevision:e.committedRevision,
      pendingRevision:e.pending ? e.pending.revision : null, pendingDurable:e.pending ? e.pending.durable === true : false,
      writing:e.writing, lastError:e.lastError, lastCommittedAt:e.lastCommittedAt,
      writesStarted:e.writesStarted, writesCommitted:e.writesCommitted, writesFailed:e.writesFailed,
      writesCoalesced:e.writesCoalesced, retries:e.retries,
    };
  }
}

class RequestLease {
  // v12.0.4.4 — expiring, persisted, single-owner lease around every Twelve Data request.
  // Replaces the indefinite REQUEST_RESERVED condition: a lease that outlives
  // (requestTimeoutMs + leaseSafetyMarginMs) is considered abandoned and is recovered
  // automatically, both by the scheduler watchdog and at service startup.
  constructor({ config, storage, now = () => Date.now(), log = () => {}, persistQueue = null }) {
    this.config = config; this.storage = storage; this.now = now; this.log = log;
    this.persistQueue = persistQueue || new PersistenceQueue({ storage, log });
    this.state = this.empty();
    this.lastPersistError = null;
    this.startupRecovery = { occurred:false, reason:null, at:null, preservedValidLease:false };
  }
  durationMs() { return Number(this.config.forex.requestTimeoutMs) + Number(this.config.forex.leaseSafetyMarginMs); }
  empty() {
    return {
      schema:'alps.gen2.twelveDataRequestLease.v12044',
      leaseActive:false, leaseId:null, leaseAcquiredAt:null, leaseExpiresAt:null,
      leaseOwner:null, leasePurpose:null, currentPair:null, currentOperation:null,
      leaseRecovered:false, leaseRecoveryReason:null, leaseRecoveredAt:null,
      acquisitions:0, releases:0, recoveries:0, lastReleasedAt:null, lastReleaseReason:null,
    };
  }
  isExpired() {
    if (!this.state.leaseActive) return false;
    const expires = Date.parse(this.state.leaseExpiresAt || '');
    return !Number.isFinite(expires) || expires <= this.now();
  }
  async persistBounded() {
    // Ordered persistence (v12.0.4.4.1): the queue serializes physical writes per file
    // with monotonic revisions and latest-state coalescing, so a slow older write can
    // never rename a stale (e.g. still-active) lease over a newer released-lease state.
    // The caller stops waiting after persistTimeoutMs; ordering is preserved regardless.
    const { done } = this.persistQueue.enqueue(this.config.forex.leaseFile, { ...this.state, persistedAt:iso(this.now()) });
    done.then(result => { this.lastPersistError = result && result.ok ? null : (result && result.error || this.lastPersistError); }).catch(() => {});
    await awaitBounded(done, this.config.forex.persistTimeoutMs);
  }
  recover(reason) {
    const recovered = {
      leaseId:this.state.leaseId, leaseAcquiredAt:this.state.leaseAcquiredAt,
      leaseExpiresAt:this.state.leaseExpiresAt, leaseOwner:this.state.leaseOwner,
      leasePurpose:this.state.leasePurpose, currentPair:this.state.currentPair, currentOperation:this.state.currentOperation,
    };
    this.state.leaseActive = false;
    this.state.leaseId = null; this.state.leaseAcquiredAt = null; this.state.leaseExpiresAt = null;
    this.state.leaseOwner = null; this.state.leasePurpose = null; this.state.currentPair = null; this.state.currentOperation = null;
    this.state.leaseRecovered = true; this.state.leaseRecoveryReason = reason; this.state.leaseRecoveredAt = iso(this.now());
    this.state.recoveries = Number(this.state.recoveries || 0) + 1;
    return recovered;
  }
  async load() {
    const persisted = await this.storage.readJson(this.config.forex.leaseFile, null);
    if (persisted && typeof persisted === 'object') this.state = { ...this.empty(), ...persisted, schema:this.empty().schema };
    if (this.state.leaseActive) {
      if (this.isExpired()) {
        // The process restarted (or the file was persisted mid-request) while a lease was
        // active and it has since expired: recover it. Credits and any active 429 circuit
        // breaker are owned by BudgetGuard and are deliberately not touched here.
        const abandoned = this.recover('STARTUP_EXPIRED_LEASE_RECOVERED');
        this.startupRecovery = { occurred:true, reason:'STARTUP_EXPIRED_LEASE_RECOVERED', at:iso(this.now()), preservedValidLease:false, abandoned };
        this.log(`[v12.0.6] startup lease recovery: abandoned lease ${abandoned.leaseId || 'unknown'} (pair=${abandoned.currentPair || '—'} op=${abandoned.currentOperation || '—'})`);
      } else {
        // Genuinely still valid (acquired < duration ago) — preserve it; it will either be
        // released by its owner or recovered by the watchdog the moment it expires.
        this.startupRecovery = { occurred:false, reason:'STARTUP_VALID_LEASE_PRESERVED', at:iso(this.now()), preservedValidLease:true };
      }
    } else {
      this.startupRecovery = { occurred:false, reason:'STARTUP_NO_ACTIVE_LEASE', at:iso(this.now()), preservedValidLease:false };
    }
    await this.persistBounded();
  }
  acquire({ owner, purpose, pair = null, operation = null }) {
    // Atomic within the single-threaded event loop: check-and-set with no await between
    // the check and the mutation, so overlapping ownership is rejected cleanly and no
    // credits have been charged yet (BudgetGuard.reserve runs only after acquisition).
    if (this.state.leaseActive) {
      if (!this.isExpired()) {
        return { ok:false, reason:'FOREX_REQUEST_LEASE_HELD', heldBy:this.state.leaseOwner, leaseId:this.state.leaseId, leaseExpiresAt:this.state.leaseExpiresAt };
      }
      this.recover('EXPIRED_LEASE_AUTO_RECOVERED_ON_ACQUIRE');
    }
    const at = this.now();
    this.state.leaseActive = true;
    this.state.leaseId = randomId('td');
    this.state.leaseAcquiredAt = iso(at);
    this.state.leaseExpiresAt = iso(at + this.durationMs());
    this.state.leaseOwner = String(owner || 'forex-provider');
    this.state.leasePurpose = String(purpose || 'scheduled');
    this.state.currentPair = pair;
    this.state.currentOperation = operation;
    this.state.acquisitions = Number(this.state.acquisitions || 0) + 1;
    // Persist asynchronously (bounded); acquisition itself must not block on disk.
    this.persistBounded().catch(() => {});
    return { ok:true, leaseId:this.state.leaseId, leaseExpiresAt:this.state.leaseExpiresAt };
  }
  release(leaseId, reason = 'REQUEST_FINISHED') {
    // Guaranteed, idempotent, never-throwing release. Only the current owner's leaseId
    // clears the lease; a stale (already-recovered) leaseId is a no-op so an abandoned
    // request that eventually settles cannot clobber a newer lease.
    if (!this.state.leaseActive || this.state.leaseId !== leaseId) return { ok:false, reason:'LEASE_NOT_OWNED_OR_ALREADY_RECOVERED' };
    this.state.leaseActive = false;
    this.state.leaseId = null; this.state.leaseAcquiredAt = null; this.state.leaseExpiresAt = null;
    this.state.leaseOwner = null; this.state.leasePurpose = null; this.state.currentPair = null; this.state.currentOperation = null;
    this.state.releases = Number(this.state.releases || 0) + 1;
    this.state.lastReleasedAt = iso(this.now());
    this.state.lastReleaseReason = String(reason).slice(0, 120);
    this.persistBounded().catch(() => {});
    return { ok:true };
  }
  view() {
    const acquired = Date.parse(this.state.leaseAcquiredAt || '');
    return {
      schema:this.state.schema,
      leaseActive:this.state.leaseActive === true,
      leaseId:this.state.leaseId,
      leaseAcquiredAt:this.state.leaseAcquiredAt,
      leaseExpiresAt:this.state.leaseExpiresAt,
      leaseAgeMs:this.state.leaseActive && Number.isFinite(acquired) ? Math.max(0, this.now() - acquired) : null,
      leaseDurationMs:this.durationMs(),
      leaseExpired:this.isExpired(),
      leaseOwner:this.state.leaseOwner,
      leasePurpose:this.state.leasePurpose,
      currentPair:this.state.currentPair,
      currentOperation:this.state.currentOperation,
      leaseRecovered:this.state.leaseRecovered === true,
      leaseRecoveryReason:this.state.leaseRecoveryReason,
      leaseRecoveredAt:this.state.leaseRecoveredAt,
      acquisitions:this.state.acquisitions, releases:this.state.releases, recoveries:this.state.recoveries,
      lastReleasedAt:this.state.lastReleasedAt, lastReleaseReason:this.state.lastReleaseReason,
      startupRecovery:this.startupRecovery,
      lastPersistError:this.lastPersistError,
      persistence:this.persistQueue.view(this.config.forex.leaseFile),
    };
  }
}

class BudgetGuard {
  constructor({ config, storage, now = () => Date.now(), persistQueue = null }) {
    this.config = config; this.storage = storage; this.now = now; this.inFlight = new Set(); this.state = this.empty();
    this.persistQueue = persistQueue || new PersistenceQueue({ storage });
    this.lastPersistError = null;
    this.breakerRevision = null; // persistRevision of the last durable HTTP 429 breaker enqueue
  }
  empty() {
    return { schema:'alps.gen2.twelveDataBudget.v1204', day:utcDayKey(this.now()), usedCredits:0, blockedUntil:null, first429At:null, last429At:null, lastRequestAt:null, lastRequestByKey:{}, requests:[], status:'READY' };
  }
  rollDay() {
    const today = utcDayKey(this.now());
    if (this.state.day !== today) this.state = { ...this.empty(), day:today, status:'READY_NEW_UTC_DAY' };
    const until = Date.parse(this.state.blockedUntil || '');
    if (Number.isFinite(until) && until <= this.now()) { this.state.blockedUntil = null; this.state.status = 'READY_AFTER_COOLDOWN'; }
  }
  async load() {
    // Startup rule (v12.0.4.4): merge the persisted budget as-is. The daily credit
    // counter is NEVER reset here (only rollDay() on a genuine UTC day change), and an
    // active HTTP 429 circuit breaker (blockedUntil in the future) is NEVER cleared.
    this.state = { ...this.empty(), ...(await this.storage.readJson(this.config.forex.budgetFile, null) || {}) };
    if (!Array.isArray(this.state.requests)) this.state.requests = [];
    if (!this.state.lastRequestByKey || typeof this.state.lastRequestByKey !== 'object') this.state.lastRequestByKey = {};
    this.rollDay(); await this.persist();
  }
  async persist({ durable = false } = {}) {
    // Ordered persistence (v12.0.4.4.1): serialized per-file queue with monotonic
    // revisions and latest-state coalescing. A delayed REQUEST_RESERVED write can no
    // longer overwrite a newer HTTP 429 state — the queue always commits the latest
    // snapshot last, and the on-disk revision never moves backward.
    const { revision, done } = this.persistQueue.enqueue(this.config.forex.budgetFile, this.state, { durable });
    if (durable) this.breakerRevision = revision;
    done.then(result => { this.lastPersistError = result && result.ok ? null : (result && result.error || this.lastPersistError); }).catch(() => {});
    const result = await awaitBounded(done, this.config.forex.persistTimeoutMs);
    return result;
  }
  circuitBreakerPersistencePending() {
    // True while a durable HTTP 429 breaker enqueue has not yet been committed to disk.
    // The queue retains the durable snapshot and retries only the disk persistence
    // asynchronously; any later committed snapshot (revision >= breakerRevision) also
    // contains the breaker fields, which clears this flag.
    if (this.breakerRevision == null) return false;
    return this.persistQueue.view(this.config.forex.budgetFile).committedRevision < this.breakerRevision;
  }
  isBlocked() { this.rollDay(); const until = Date.parse(this.state.blockedUntil || ''); return Number.isFinite(until) && until > this.now(); }
  async reserve({ key, purpose='scheduled', cost=1, minGapMs=0, meta={} }) {
    this.rollDay();
    if (this.isBlocked()) return { ok:false, reason:'HTTP_429_DAY_STOP_ACTIVE' };
    if (Number(this.state.usedCredits||0) + cost > this.config.forex.hardDailyCredits) return { ok:false, reason:'DAILY_HARD_CREDIT_LIMIT_REACHED' };
    if ((purpose === 'scheduled' || purpose === 'backfill') && Number(this.state.usedCredits||0) + cost > this.config.forex.scheduledCreditCeiling) return { ok:false, reason:'SCHEDULED_CREDIT_CEILING_REACHED' };
    if (this.inFlight.has(key)) return { ok:false, reason:'IDENTICAL_REQUEST_ALREADY_IN_FLIGHT' };
    const last = Date.parse((this.state.lastRequestByKey||{})[key] || '');
    if (Number.isFinite(last) && this.now() - last < minGapMs) return { ok:false, reason:'MINIMUM_REQUEST_GAP_ACTIVE', retryAt:iso(last + minGapMs) };
    const at = iso(this.now()); this.state.usedCredits = Number(this.state.usedCredits||0)+cost; this.state.lastRequestAt = at; this.state.lastRequestByKey = this.state.lastRequestByKey || {}; this.state.lastRequestByKey[key]=at; this.inFlight.add(key);
    this.state.requests = Array.isArray(this.state.requests) ? this.state.requests : []; this.state.requests.push({ at,key,purpose,cost,...meta }); if (this.state.requests.length>250) this.state.requests=this.state.requests.slice(-250); this.state.status='REQUEST_RESERVED'; await this.persist(); return { ok:true };
  }
  async complete({ key, status, error=null }) {
    // v12.0.4.4.1: never throws and never hangs indefinitely. The in-memory release
    // (inFlight.delete + circuit-breaker fields) happens synchronously first. For an
    // HTTP 429, a DURABLE latest-state write is enqueued (and bounded-awaited) here —
    // i.e. strictly BEFORE the caller's finally block releases the request lease. If the
    // first disk attempt times out or fails, circuitBreakerPersistencePending() stays
    // true and the queue retries only the disk persistence asynchronously; the Twelve
    // Data HTTP request itself is never retried.
    try {
      this.inFlight.delete(key);
      const is429 = Number(status) === 429;
      if (is429) {
        const at=iso(this.now()); this.state.first429At=this.state.first429At||at; this.state.last429At=at; this.state.blockedUntil=iso(nextUtcDayResumeAt(this.now())); this.state.status='HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY';
      } else this.state.status = status >= 200 && status < 300 ? 'READY' : `LAST_HTTP_${status||0}`;
      if (!Array.isArray(this.state.requests)) this.state.requests = [];
      const last=[...this.state.requests].reverse().find(r=>r&&r.key===key&&!r.completedAt)||this.state.requests.at(-1);
      if(last){last.completedAt=iso(this.now());last.httpStatus=Number(status)||0;if(error)last.error=String(error).slice(0,240);}
      await this.persist({ durable:is429 });
    } catch (persistError) {
      this.lastPersistError = String(persistError && persistError.message || persistError).slice(0, 240);
    }
  }
  view() {
    this.rollDay(); const used=Number(this.state.usedCredits||0);
    return { schema:this.state.schema, day:this.state.day, usedCredits:used, hardLimit:this.config.forex.hardDailyCredits, scheduledCeiling:this.config.forex.scheduledCreditCeiling, remainingHard:Math.max(0,this.config.forex.hardDailyCredits-used), remainingScheduled:Math.max(0,this.config.forex.scheduledCreditCeiling-used), blocked:this.isBlocked(), blockedUntil:this.state.blockedUntil, first429At:this.state.first429At, last429At:this.state.last429At, status:this.state.status, lastRequestAt:this.state.lastRequestAt, requestCount:Array.isArray(this.state.requests)?this.state.requests.length:0, lastPersistError:this.lastPersistError, circuitBreakerPersistencePending:this.circuitBreakerPersistencePending(), persistence:this.persistQueue.view(this.config.forex.budgetFile), rule:'First Twelve Data HTTP 429 opens a persisted global circuit until 00:05 UTC on the next day. No automatic retry.' };
  }
}

async function listLegacyFiles(root, { maxFiles=3000, maxDepth=8 }={}) {
  const files=[];
  async function walk(dir, depth) {
    if(files.length>=maxFiles || depth>maxDepth) return;
    let entries=[]; try{entries=await fsp.readdir(dir,{withFileTypes:true});}catch(_){return;}
    for(const entry of entries){ if(files.length>=maxFiles)break; const full=path.join(dir,entry.name); if(entry.isDirectory())await walk(full,depth+1); else if(/\.(json|jsonl|ndjson|csv)$/i.test(entry.name))files.push(full); }
  }
  await walk(root,0); return files;
}
function inferFrame(text) {
  const s=String(text).toLowerCase();
  if(/(^|[^a-z0-9])5(?:m|min)([^a-z0-9]|$)/.test(s))return '5m';
  if(/(^|[^a-z0-9])15(?:m|min)([^a-z0-9]|$)/.test(s))return '15m';
  if(/(^|[^a-z0-9])30(?:m|min)([^a-z0-9]|$)/.test(s))return '30m';
  if(/(^|[^a-z0-9])(?:1h|60m|60min)([^a-z0-9]|$)/.test(s))return '1h';
  if(/(^|[^a-z0-9])(?:4h|240m|240min)([^a-z0-9]|$)/.test(s))return '4h';
  return null;
}
function normalizedToken(text){return String(text).toUpperCase().replace(/[^A-Z0-9]/g,'');}
function inferSymbol(file, symbols) { const token=normalizedToken(file); return symbols.find(s=>token.includes(s.key)) || null; }
function inferForexPair(file, pairs) { const token=normalizedToken(file); return pairs.find(p=>token.includes(p.key)) || null; }
function splitCsvLine(line) { const out=[];let cur='';let quoted=false;for(const ch of line){if(ch==='"')quoted=!quoted;else if(ch===','&&!quoted){out.push(cur);cur='';}else cur+=ch;}out.push(cur);return out.map(v=>v.trim().replace(/^"|"$/g,'')); }
function collectCandleArrays(value, arrays, depth=0) { if(depth>8||value==null)return;if(Array.isArray(value)){if(value.length&&((Array.isArray(value[0])&&value[0].length>=5)||(typeof value[0]==='object')))arrays.push(value);for(const item of value.slice(0,20))collectCandleArrays(item,arrays,depth+1);}else if(typeof value==='object'){for(const [k,v] of Object.entries(value)){if(['candles','rows','values','data','klines','bars','history'].includes(k.toLowerCase())&&Array.isArray(v))arrays.push(v);collectCandleArrays(v,arrays,depth+1);}} }
async function parseLegacyFile(file, intervalMs, maxBytes) {
  let stat; try{stat=await fsp.stat(file);}catch(_){return [];} if(stat.size<=0||stat.size>maxBytes)return [];
  if(/\.csv$/i.test(file)){
    const rows=[];const input=fs.createReadStream(file,'utf8');const rl=readline.createInterface({input,crlfDelay:Infinity});let headers=null;
    for await(const line of rl){if(!line.trim())continue;const fields=splitCsvLine(line);if(!headers){headers=fields.map(v=>v.toLowerCase());continue;}const obj={};headers.forEach((h,i)=>obj[h]=fields[i]);const c=normalizeCandle(obj,intervalMs);if(validOhlc(c))rows.push(c);}return rows;
  }
  if(/\.(jsonl|ndjson)$/i.test(file)){
    const rows=[];const input=fs.createReadStream(file,'utf8');const rl=readline.createInterface({input,crlfDelay:Infinity});
    for await(const line of rl){if(!line.trim())continue;try{const payload=JSON.parse(line);const c=normalizeCandle(payload,intervalMs);if(validOhlc(c))rows.push(c);else{const arrays=[];collectCandleArrays(payload,arrays);for(const arr of arrays)for(const r of arr){const x=normalizeCandle(r,intervalMs);if(validOhlc(x))rows.push(x);}}}catch(_){}}
    return rows;
  }
  try{const payload=JSON.parse(await fsp.readFile(file,'utf8'));const arrays=[];collectCandleArrays(payload,arrays);if(Array.isArray(payload))arrays.unshift(payload);const rows=[];for(const arr of arrays)for(const r of arr){const c=normalizeCandle(r,intervalMs);if(validOhlc(c))rows.push(c);}return rows;}catch(_){return [];}
}

class TwelveDataProvider {
  constructor({ config, budget, lease=null, fetchImpl=global.fetch, now=()=>Date.now() }) { this.config=config;this.budget=budget;this.lease=lease;this.fetchImpl=fetchImpl;this.now=now;this.lastTimeoutAt=null;this.lastFailureCode=null; }
  async fetch(pair,{purpose='scheduled',outputsize=500,endDate=null}={}){
    if(!this.config.forex.apiKey)return{ok:false,status:0,reason:'TWELVE_DATA_API_KEY_MISSING',rows:[]};
    const backfill=purpose==='backfill';
    // Validate and format everything fallible BEFORE the lease and budget are touched,
    // so a bad argument can never strand a reservation (v12.0.4.3 built the end_date
    // string after reserve() and outside try/finally — one of the leak paths).
    let endDateParam=null;
    if(endDate!=null){
      const endMs=Number(endDate);
      if(!Number.isFinite(endMs))return{ok:false,status:0,reason:'INVALID_BACKFILL_END_DATE',rows:[]};
      endDateParam=new Date(endMs).toISOString().replace('T',' ').replace('Z','');
    }
    const key=backfill?`time_series:${pair.key}:backfill`:`time_series:${pair.key}:live`;
    // 1) Acquire the exclusive expiring request lease. Rejection is clean: no credits
    //    have been charged and nothing needs releasing.
    const lease=this.lease?this.lease.acquire({owner:'twelve-data-provider',purpose:backfill?'backfill':'scheduled',pair:pair.canonical,operation:backfill?'HISTORICAL_BACKFILL':'LIVE_REFRESH'}):{ok:true,leaseId:null};
    if(!lease.ok)return{ok:false,status:0,reason:lease.reason,leaseExpiresAt:lease.leaseExpiresAt||null,rows:[]};
    let reserved=false;let completed=false;let timedOut=false;
    const controller=new AbortController();
    const timeout=setTimeout(()=>{timedOut=true;controller.abort();},this.config.forex.requestTimeoutMs);
    try{
      // 2) Reserve budget only while holding the lease; a failed reservation charges
      //    nothing and falls through to the guaranteed release in finally.
      const gate=await this.budget.reserve({key,purpose:backfill?'backfill':'scheduled',cost:1,minGapMs:backfill?60_000:this.config.forex.minLiveRequestGapMs,meta:{pair:pair.canonical,endpoint:'/time_series',leaseId:lease.leaseId}});
      if(!gate.ok)return{ok:false,status:0,reason:gate.reason,retryAt:gate.retryAt||null,rows:[]};
      reserved=true;
      const params=new URLSearchParams({symbol:pair.provider,interval:this.config.forex.interval,outputsize:String(clamp(outputsize,1,5000)),timezone:'UTC',order:'ASC',apikey:this.config.forex.apiKey});
      if(endDateParam)params.set('end_date',endDateParam);
      // 3) Abortable request: the AbortController signal covers connection, headers, and
      //    body read, so a hung provider cannot block the scheduler past requestTimeoutMs.
      const response=await this.fetchImpl(`${this.config.forex.providerBaseUrl}/time_series?${params}`,{headers:{accept:'application/json','user-agent':`ALPS/${VERSION}`},signal:controller.signal});
      const text=await response.text();let payload=null;try{payload=text?JSON.parse(text):null;}catch(_){}
      const status=response.status===429||Number(payload&&payload.code)===429?429:response.status;
      // 4) Budget completion (including the persisted 429 circuit breaker) happens here,
      //    strictly BEFORE the lease is released in finally.
      await this.budget.complete({key,status,error:status>=400?(payload&&(payload.message||payload.status)||text.slice(0,180)):null});
      completed=true;
      if(status===429){this.lastFailureCode='HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY';return{ok:false,status,reason:'HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY',rows:[]};}
      if(!response.ok||!payload||payload.status==='error'){this.lastFailureCode=`HTTP_${status}`;return{ok:false,status,reason:String(payload&&(payload.message||payload.status)||`HTTP_${status}`).slice(0,240),rows:[]};}
      this.lastFailureCode=null;
      return{ok:true,status,rows:Array.isArray(payload.values)?payload.values:[],meta:payload.meta||{}};
    }catch(error){
      const isTimeout=timedOut||(error&&error.name==='AbortError');
      const code=isTimeout?'TWELVE_DATA_REQUEST_TIMEOUT':`TWELVE_DATA_NETWORK_ERROR:${String(error&&error.message||error).slice(0,160)}`;
      if(isTimeout)this.lastTimeoutAt=iso(this.now());
      this.lastFailureCode=isTimeout?'TWELVE_DATA_REQUEST_TIMEOUT':'TWELVE_DATA_NETWORK_ERROR';
      if(reserved&&!completed){await this.budget.complete({key,status:0,error:code});completed=true;}
      // No automatic retry of the timed-out request in this cycle: the reservation's
      // lastRequestByKey min-gap and the cycle loop guarantee the next attempt waits.
      return{ok:false,status:0,reason:code,rows:[]};
    }finally{
      clearTimeout(timeout);
      // 5) GUARANTEED release on every path: success, non-200, 429, timeout, abort,
      //    network error, JSON parse failure, validation rejection, persistence failure,
      //    early return. complete() cannot throw, and lease.release() cannot throw.
      if(reserved&&!completed)await this.budget.complete({key,status:0,error:'COMPLETION_FALLBACK_FINALLY'});
      if(this.lease&&lease.leaseId)this.lease.release(lease.leaseId,'REQUEST_FINISHED');
    }
  }
}

async function importForexReadonly({config,storage,log}){
  const previous=await storage.readJson(config.forex.migrationFile,null);
  const existingCounts={};let existingTotal=0;
  for(const pair of config.forexPairs){const rows=await storage.readForex(config.forex.rawDir,pair.key);existingCounts[pair.key]=rows.length;existingTotal+=rows.length;}
  if(previous&&previous.importedRows>0&&existingTotal>0)return{...previous,status:'ALREADY_IMPORTED_READ_ONLY'};
  const result={schema:'alps.gen2.v11ReadonlyImport.v1204',startedAt:iso(),completedAt:null,legacyRoot:config.legacyRoot,readOnly:true,v11Writes:0,scannedFiles:0,importedFiles:0,skippedFiles:0,importedRows:0,perPair:{},errors:[],status:'NOT_STARTED'};
  if(!config.importLegacyOnStartup)return{...result,status:'DISABLED_BY_CONFIG'};
  if(!fs.existsSync(config.legacyRoot))return{...result,status:'V11_ROOT_NOT_FOUND'};
  const files=await listLegacyFiles(config.legacyRoot,{maxFiles:config.maxLegacyFiles});const byPair=new Map(config.forexPairs.map(p=>[p.key,[]]));
  for(const file of files){result.scannedFiles++;const pair=inferForexPair(file,config.forexPairs);if(!pair){result.skippedFiles++;continue;}const frame=inferFrame(file);if(frame&&frame!=='5m'){result.skippedFiles++;continue;}try{const rows=await parseLegacyFile(file,config.forex.intervalMs,config.maxLegacyFileBytes);if(!rows.length){result.skippedFiles++;continue;}byPair.get(pair.key).push(...rows);result.importedFiles++;result.importedRows+=rows.length;}catch(error){result.errors.push({file:path.relative(config.legacyRoot,file),error:String(error.message||error).slice(0,240)});}}
  for(const pair of config.forexPairs){const existing=await storage.readForex(config.forex.rawDir,pair.key);const merged=mergeCandles(existing,byPair.get(pair.key)||[],config.forex.intervalMs);const cleaned=cleanCandles(merged,{intervalMs:config.forex.intervalMs,closeBufferMs:config.forex.candleCloseBufferMs,staleMs:config.forex.staleMarketDataMs,assetClass:'FOREX',removeFlat:true});await storage.writeForex(config.forex.rawDir,pair,merged,{source:'V11_READ_ONLY_IMPORT_PLUS_EXISTING_V12'});await storage.writeForex(config.forex.cleanDir,pair,cleaned.candles,{source:'V11_READ_ONLY_IMPORT_CLEANED_COPY',quality:cleaned.quality});result.perPair[pair.key]={importedRows:(byPair.get(pair.key)||[]).length,rawRows:merged.length,cleanRows:cleaned.candles.length,quality:cleaned.quality};}
  result.completedAt=iso();result.status='COMPLETED';result.errors=result.errors.slice(0,100);await storage.writeJsonAtomic(config.forex.migrationFile,result);log(`[v12.0.6] forex v11 read-only import files=${result.importedFiles} rows=${result.importedRows}`);return result;
}

function mean(values){return values.length?values.reduce((a,b)=>a+b,0)/values.length:0;}
function stdev(values){if(values.length<2)return 0;const m=mean(values);return Math.sqrt(mean(values.map(v=>(v-m)**2)));}
function candleReturns(candles){const out=[];for(let i=1;i<candles.length;i++){if(candles[i-1].c>0&&candles[i].c>0)out.push(((candles[i].c/candles[i-1].c)-1)*10000);}return out;}
function createMetricAccumulator(){return{samples:0,mean:0,m2:0,positive:0};}
function addMetricValue(acc,value){if(!Number.isFinite(value))return acc;acc.samples++;const delta=value-acc.mean;acc.mean+=delta/acc.samples;acc.m2+=delta*(value-acc.mean);if(value>0)acc.positive++;return acc;}
function addCandleReturnsToAccumulator(candles,acc=createMetricAccumulator()){
  let previous=null;
  for(const row of Array.isArray(candles)?candles:[]){const candle=normalizeCandle(row,300000);if(!validOhlc(candle))continue;if(previous&&previous.c>0&&candle.c>0)addMetricValue(acc,((candle.c/previous.c)-1)*10000);previous=candle;}
  return acc;
}
function finalizeMetricAccumulator(acc){const n=Number(acc.samples||0);const variance=n?Number(acc.m2||0)/n:0;return{samples:n,averageBps:Number(Number(acc.mean||0).toFixed(6)),volatilityBps:Number(Math.sqrt(Math.max(0,variance)).toFixed(6)),positiveRate:n?Number((Number(acc.positive||0)/n*100).toFixed(3)):0};}
function sampleMetrics(candles){return finalizeMetricAccumulator(addCandleReturnsToAccumulator(candles));}
async function rebuildForexHypotheses(config,storage,pairMetrics,globalMetrics){
  const families=['TREND_CONTINUATION','MEAN_REVERSION','VOLATILITY_COMPRESSION_RELEASE','LONDON_OPEN_MOMENTUM','NEW_YORK_OVERLAP_REVERSAL'];
  const global=['USD_BREADTH_CONTINUATION','JPY_CROSS_CONFIRMATION','EUR_CROSS_CONFIRMATION','GBP_CROSS_CONFIRMATION','ASIA_TO_LONDON_HANDOFF','LONDON_TO_NEW_YORK_HANDOFF','CROSS_PAIR_DISPERSION','VOLATILITY_CLUSTERING','WEEK_OPEN_GAP_NORMALIZATION','SESSION_COMPRESSION_RELEASE'];
  const hypotheses=[];const generatedAt=iso();
  for(const pair of config.forexPairs){const metrics=pairMetrics[pair.key]||finalizeMetricAccumulator(createMetricAccumulator());for(const family of families)hypotheses.push({id:`FX-${pair.key}-${family}`,scope:'PAIR',family,sourcePairs:[pair.canonical],dataMode:'FOREX_PRICE_ONLY',metrics,evidenceStatus:metrics.samples>=500?'POST_CLEAN_PRICE_EVIDENCE_AVAILABLE':'INSUFFICIENT_CLEAN_SAMPLE',promotionStatus:'RESEARCH_ONLY',forwardShadowEligible:false,paperOnly:true,liveCapitalExecution:false,generatedAt});}
  const pooled=globalMetrics||finalizeMetricAccumulator(createMetricAccumulator());
  for(const family of global)hypotheses.push({id:`FX-GLOBAL-${family}`,scope:'GLOBAL_FOREX',family,sourcePairs:config.forexPairs.map(p=>p.canonical),dataMode:'FOREX_PRICE_ONLY',metrics:pooled,promotionStatus:'RESEARCH_ONLY',forwardShadowEligible:false,paperOnly:true,liveCapitalExecution:false,generatedAt});
  const payload={schema:'alps.gen2.forexHypotheses.v120442',version:VERSION,generatedAt,count:hypotheses.length,researchOnly:hypotheses.length,forwardShadowEligible:0,metricAggregation:'STREAMING_POOLED_PER_PAIR_RETURNS',hypotheses};
  await storage.writeJsonAtomic(config.forex.hypothesesFile,payload);return payload;
}

class ForexEngine {
  constructor({config,storage,now=()=>Date.now(),log=console.log,memory=null}){
    this.config=config;this.storage=storage;this.now=now;this.log=log;this.memory=memory||new MemoryTracker({now,log});
    this.persistQueue=new PersistenceQueue({storage,log});
    this.budget=new BudgetGuard({config,storage,now,persistQueue:this.persistQueue});
    this.lease=new RequestLease({config,storage,now,log,persistQueue:this.persistQueue});
    this.provider=new TwelveDataProvider({config,budget:this.budget,lease:this.lease,now});
    this.state={
      schema:'alps.gen2.forexCoreState.v120442',version:VERSION,startedAt:null,generatedAt:iso(),status:'CREATED',
      gen2WorkerOnline:false,markets:{},lastRefreshStartedAt:null,lastRefreshCompletedAt:null,nextRefreshAt:null,
      lastCleanRebuildAt:null,refreshSequence:0,providerCallsThisRun:0,lastError:null,
      scheduler:{
        schedulerRunning:false,schedulerHeartbeatAt:null,watchdogHeartbeatAt:null,nextScheduledAt:null,
        lastCycleStartedAt:null,lastSuccessfulCycleAt:null,lastCycleCompletedAt:null,
        cycleInFlight:false,cycleToken:null,consecutiveFailures:0,lastFailureAt:null,lastFailureCode:null,
        liveRefreshAttemptedPairs:0,liveRefreshCompletedPairs:0,liveRefreshFailedPairs:0,liveRefreshSkippedPairs:0,
        liveRefreshAttemptedList:[],liveRefreshCompletedList:[],liveRefreshFailedList:[],liveRefreshSkippedList:[],liveRefreshReleasedAt:null,
        watchdogRecoveries:0,lastWatchdogRecoveryAt:null,lastWatchdogRecoveryReason:null,
        abandonedCycles:0,lastAbandonedCycleAt:null,startupRecovery:null,
      },
      backfill:{day:null,creditsUsedToday:0,pairsProcessedToday:0,perPair:{}},
    };
    this.hypotheses=null;this.migration=null;this.running=false;this.inFlight=false;this.timer=null;this.watchdogTimer=null;
    this.cycleToken=null;this.cycleStartedMs=null;this.lastPersistError=null;
    // Hard ceiling for one full cycle (live + bounded backfill + rebuild) before the
    // watchdog declares it abandoned: generous multiple of the worst provider path,
    // but always well under the refresh interval so recovery lands before the next slot.
    const pairs=this.config.forexPairs.length;
    const perRequest=this.config.forex.requestTimeoutMs+this.config.forex.interSymbolDelayMs;
    this.cycleHardLimitMs=clamp(2*pairs*perRequest+180_000,5*60_000,Math.max(5*60_000,this.config.forex.refreshIntervalMs-30_000));
  }
  async init(){
    await this.memory.checkpoint('FOREX_STARTUP_LOAD_GUARDS');
    await this.budget.load();
    await this.lease.load();
    this.state.scheduler.startupRecovery=this.lease.startupRecovery;
    this.state.startedAt=iso(this.now());this.state.status='INITIALIZING';
    this.migration=await importForexReadonly({config:this.config,storage:this.storage,log:this.log}).catch(e=>({status:'FAILED',error:String(e.message||e),readOnly:true,v11Writes:0}));
    // Supervision starts before the startup cycle, so a slow provider or rebuild is
    // visible and recoverable. The former duplicate pre-cycle clean/rebuild is removed:
    // runCycle performs the single canonical rebuild after live refresh/backfill.
    this.running=true;this.state.scheduler.schedulerRunning=true;this.startWatchdog();
    await this.runCycle('startup');
    this.state.gen2WorkerOnline=true;this.state.status=this.budget.isBlocked()?'BUDGET_STOP_ACTIVE':'ONLINE';
    this.schedule();await this.persist();await this.memory.checkpoint('FOREX_STARTUP_COMPLETE');
  }
  async cleanAndRebuild(reason='manual'){
    const pairMetrics={};const globalAccumulator=createMetricAccumulator();
    for(const pair of this.config.forexPairs){
      await this.memory.checkpoint('FOREX_REBUILD_READ',pair.canonical,'5m');
      const raw=await this.storage.readForex(this.config.forex.rawDir,pair.key);const rawRows=raw.length;
      const cleaned=cleanCandles(raw,{now:this.now(),intervalMs:this.config.forex.intervalMs,closeBufferMs:this.config.forex.candleCloseBufferMs,staleMs:this.config.forex.staleMarketDataMs,assetClass:'FOREX',removeFlat:true});
      raw.length=0;
      pairMetrics[pair.key]=sampleMetrics(cleaned.candles);addCandleReturnsToAccumulator(cleaned.candles,globalAccumulator);
      await this.storage.writeForex(this.config.forex.cleanDir,pair,cleaned.candles,{source:'V12_0_4_4_2_MEMORY_BOUNDED_FOREX_CLEANER',reason,quality:cleaned.quality});
      const old=this.state.markets[pair.key]||{};this.state.markets[pair.key]={...old,pair:pair.canonical,key:pair.key,enabled:true,assetClass:'FOREX',source:'TWELVE_DATA_PRICE_ONLY',rawRows,cleanRows:cleaned.candles.length,coverageDays:cleaned.quality.coverageDays,historicalComplete:cleaned.quality.coverageDays>=this.config.forex.backfillCoverageDays,backfillEnabled:cleaned.quality.coverageDays<this.config.forex.backfillCoverageDays,latestAt:cleaned.quality.latestAt,stale:cleaned.quality.stale,quality:cleaned.quality};
      cleaned.signalCandles.length=0;cleaned.candles.length=0;await this.memory.checkpoint('FOREX_REBUILD_PAIR_RELEASED',pair.canonical,'5m');
    }
    this.hypotheses=await rebuildForexHypotheses(this.config,this.storage,pairMetrics,finalizeMetricAccumulator(globalAccumulator));
    this.state.lastCleanRebuildAt=iso(this.now());await this.persist();await this.memory.checkpoint('FOREX_REBUILD_COMPLETE');return this.hypotheses;
  }
  async refreshPair(pair,{purpose='scheduled',endDate=null,outputsize=null}={}){if(this.budget.isBlocked())return{ok:false,reason:'HTTP_429_DAY_STOP_ACTIVE'};const response=await this.provider.fetch(pair,{purpose,outputsize:Number.isFinite(outputsize)?outputsize:(purpose==='backfill'?this.config.forex.backfillOutputSize:this.config.forex.liveOutputSize),endDate});if(response.status)this.state.providerCallsThisRun++;const market=this.state.markets[pair.key]||{pair:pair.canonical,key:pair.key};market.lastProviderStatus=response.ok?`HTTP_${response.status}`:response.reason;market.lastProviderAttemptAt=iso(this.now());if(!response.ok){market.lastProviderError=response.reason;this.state.markets[pair.key]=market;return response;}const incoming=response.rows.map(r=>normalizeCandle(r,this.config.forex.intervalMs)).filter(validOhlc);const existing=await this.storage.readForex(this.config.forex.rawDir,pair.key);const merged=mergeCandles(existing,incoming,this.config.forex.intervalMs);const cleaned=cleanCandles(merged,{now:this.now(),intervalMs:this.config.forex.intervalMs,closeBufferMs:this.config.forex.candleCloseBufferMs,staleMs:this.config.forex.staleMarketDataMs,assetClass:'FOREX',removeFlat:true});if(cleaned.quality.stale&&isFxMarketOpen(this.now())){market.stale=true;market.lastProviderError='STALE_PROVIDER_PRICE_NOT_COMMITTED';this.state.markets[pair.key]=market;return{ok:false,status:response.status,reason:'STALE_PROVIDER_PRICE_NOT_COMMITTED'};}await this.storage.writeForex(this.config.forex.rawDir,pair,merged,{source:'TWELVE_DATA_TIME_SERIES_PRICE_ONLY',purpose,noNews:true});await this.storage.writeForex(this.config.forex.cleanDir,pair,cleaned.candles,{source:'V12_0_4_FOREX_CLEANER',purpose,quality:cleaned.quality});this.state.markets[pair.key]={...market,pair:pair.canonical,key:pair.key,enabled:true,assetClass:'FOREX',source:'TWELVE_DATA_PRICE_ONLY',rawRows:merged.length,cleanRows:cleaned.candles.length,coverageDays:cleaned.quality.coverageDays,historicalComplete:cleaned.quality.coverageDays>=this.config.forex.backfillCoverageDays,backfillEnabled:cleaned.quality.coverageDays<this.config.forex.backfillCoverageDays,latestAt:cleaned.quality.latestAt,stale:cleaned.quality.stale,quality:cleaned.quality,lastUpdateAt:iso(this.now()),lastProviderError:null};return{ok:true,status:response.status,rowsAdded:incoming.length};}
  rollBackfillDay(){
    const today=utcDayKey(this.now());
    if(this.state.backfill.day!==today){
      // Per-pair progress (earliest reached, provider-exhausted ranges) is kept across
      // days; only the daily credit accounting resets on the UTC day change.
      this.state.backfill={day:today,creditsUsedToday:0,pairsProcessedToday:0,perPair:this.state.backfill.perPair||{}};
    }
  }
  backfillOutputSizeFor(earliestMs){
    // Never request data beyond the required 180-day target: size the chunk to what is
    // still missing (5% margin for weekend-gapped bars), clamped to provider limits.
    const targetStart=this.now()-this.config.forex.backfillCoverageDays*86_400_000;
    if(!Number.isFinite(earliestMs)||earliestMs<=targetStart)return this.config.forex.backfillOutputSize;
    const neededBars=Math.ceil(((earliestMs-targetStart)/this.config.forex.intervalMs)*1.05);
    return clamp(neededBars,100,this.config.forex.backfillOutputSize);
  }
  async backfillIncomplete(reason='scheduled',{deadlineMs=null,maxRequests=null}={}){
    // Controlled historical backfill. Runs ONLY after live refresh in a cycle, never
    // exceeds the scheduled/hard daily credit ceilings (enforced again inside
    // BudgetGuard.reserve), stops on the first HTTP 429 until the next UTC day, skips
    // ranges the provider has already proven unavailable, and yields before the next
    // live refresh is due.
    this.rollBackfillDay();
    if(this.budget.isBlocked())return{status:'HTTP_429_DAY_STOP_ACTIVE',rows:[]};
    const deadline=Number.isFinite(deadlineMs)?deadlineMs:this.now()+10*60_000;
    const requestBudget=Number.isFinite(maxRequests)?maxRequests:this.config.forex.backfillMaxRequestsPerCycle;
    const rows=[];let requestsUsed=0;let hit429=false;
    for(const pair of this.config.forexPairs){
      if(requestsUsed>=requestBudget){rows.push({pair:pair.canonical,status:'YIELDED_CYCLE_REQUEST_CAP'});continue;}
      if(this.now()>=deadline){rows.push({pair:pair.canonical,status:'YIELDED_BEFORE_NEXT_LIVE_REFRESH'});continue;}
      if(this.budget.isBlocked()||hit429){rows.push({pair:pair.canonical,status:'HTTP_429_DAY_STOP_ACTIVE'});continue;}
      if(this.budget.view().remainingScheduled<=0){rows.push({pair:pair.canonical,status:'SCHEDULED_CREDIT_CEILING_REACHED'});continue;}
      const clean=await this.storage.readForex(this.config.forex.cleanDir,pair.key);
      const days=coverageDays(clean);
      const progress=this.state.backfill.perPair[pair.key]||{};
      if(days>=this.config.forex.backfillCoverageDays){
        this.state.backfill.perPair[pair.key]={...progress,status:'COVERAGE_COMPLETE',coverageDays:Number(days.toFixed(3)),lastAttemptAt:progress.lastAttemptAt||null};
        rows.push({pair:pair.canonical,status:'STOPPED_COVERAGE_AT_OR_ABOVE_180_DAYS',coverageDays:Number(days.toFixed(3))});continue;
      }
      const earliestT=clean.length?clean[0].t:null;
      if(progress.providerHistoryExhausted&&progress.exhaustedAtEarliest===earliestT){
        rows.push({pair:pair.canonical,status:'MAX_PROVIDER_HISTORY_REACHED_RANGE_SKIPPED',coverageDays:Number(days.toFixed(3))});continue;
      }
      const endDate=earliestT!=null?earliestT-this.config.forex.intervalMs:null;
      const result=await this.refreshPair(pair,{purpose:'backfill',endDate,outputsize:this.backfillOutputSizeFor(earliestT)});
      requestsUsed++;
      this.state.backfill.creditsUsedToday++;
      this.state.backfill.pairsProcessedToday++;
      const after=await this.storage.readForex(this.config.forex.cleanDir,pair.key);
      const afterEarliest=after.length?after[0].t:null;
      const afterDays=coverageDays(after);
      const entry={status:result.ok?'BACKFILL_CHUNK_COMMITTED':result.reason,coverageDays:Number(afterDays.toFixed(3)),earliestAt:afterEarliest!=null?iso(afterEarliest):null,lastAttemptAt:iso(this.now()),providerHistoryExhausted:false,exhaustedAtEarliest:null};
      if(result.ok&&earliestT!=null&&afterEarliest!=null&&afterEarliest>=earliestT){
        entry.status='MAX_PROVIDER_HISTORY_REACHED_NO_EARLIER_DATA';
        entry.providerHistoryExhausted=true;entry.exhaustedAtEarliest=afterEarliest;
      }
      this.state.backfill.perPair[pair.key]=entry;
      rows.push({pair:pair.canonical,status:entry.status,coverageDays:entry.coverageDays});
      if(!result.ok&&result.status===429){hit429=true;}
      if(this.config.forex.interSymbolDelayMs)await sleep(this.config.forex.interSymbolDelayMs);
    }
    return{status:hit429?'HTTP_429_DAY_STOP_ACTIVE':'COMPLETED',requestsUsed,rows};
  }
  async runCycle(reason='scheduled',{includeBackfill=true}={}){
    // One supervised Forex cycle with strict priority order:
    //   1) refresh stale live prices  2) validate + persist closed candles (inside
    //   refreshPair)  3) release the live-refresh operation  4) historical backfill
    //   only with the remaining scheduled budget, yielding before the next live slot.
    const s=this.state.scheduler;
    if(this.inFlight||s.cycleInFlight)return{status:'CYCLE_ALREADY_IN_FLIGHT'};
    s.schedulerHeartbeatAt=iso(this.now());
    if(reason==='scheduled'&&!isFxMarketOpen(this.now()))return{status:'FX_WEEKEND_NO_PROVIDER_CALLS'};
    if(this.budget.isBlocked())return{status:'HTTP_429_DAY_STOP_ACTIVE'};
    const token=randomId('cycle');
    this.inFlight=true;this.cycleToken=token;this.cycleStartedMs=this.now();
    s.cycleInFlight=true;s.cycleToken=token;s.lastCycleStartedAt=iso(this.now());
    s.liveRefreshAttemptedPairs=0;s.liveRefreshCompletedPairs=0;s.liveRefreshFailedPairs=0;s.liveRefreshSkippedPairs=0;
    s.liveRefreshAttemptedList=[];s.liveRefreshCompletedList=[];s.liveRefreshFailedList=[];s.liveRefreshSkippedList=[];s.liveRefreshReleasedAt=null;
    this.state.lastRefreshStartedAt=iso(this.now());this.state.refreshSequence++;
    const rows=[];let backfillSummary=null;
    try{
      // Phase 1+2 — live refresh with validation/persistence of closed candles.
      for(const pair of this.config.forexPairs){
        if(this.budget.isBlocked())break;
        s.liveRefreshAttemptedPairs++;s.liveRefreshAttemptedList.push(pair.canonical);
        await this.memory.checkpoint('FOREX_LIVE_REFRESH',pair.canonical,'5m');
        const result=await this.refreshPair(pair,{purpose:'scheduled'});
        const localSkip=['MINIMUM_REQUEST_GAP_ACTIVE','FOREX_REQUEST_LEASE_HELD','IDENTICAL_REQUEST_ALREADY_IN_FLIGHT','DAILY_HARD_CREDIT_LIMIT_REACHED','SCHEDULED_CREDIT_CEILING_REACHED','HTTP_429_DAY_STOP_ACTIVE'].includes(String(result.reason||''));
        if(result.ok){s.liveRefreshCompletedPairs++;s.liveRefreshCompletedList.push(pair.canonical);}
        else if(localSkip){s.liveRefreshSkippedPairs++;s.liveRefreshSkippedList.push(pair.canonical);}
        else{s.liveRefreshFailedPairs++;s.liveRefreshFailedList.push(pair.canonical);
          if(String(result.reason||'').includes('TWELVE_DATA_REQUEST_TIMEOUT')){s.lastFailureCode='TWELVE_DATA_REQUEST_TIMEOUT';s.lastFailureAt=iso(this.now());}}
        rows.push({pair:pair.canonical,status:result.ok?'UPDATED':result.reason,classification:result.ok?'COMPLETED':localSkip?'SKIPPED':'FAILED'});
        if(this.config.forex.interSymbolDelayMs&&!localSkip)await sleep(this.config.forex.interSymbolDelayMs);
      }
      // Phase 3 — live refresh operation released before any backfill work starts.
      s.liveRefreshReleasedAt=iso(this.now());
      // Phase 4 — controlled backfill with what remains, deadline-bounded so it can
      // never delay the next live refresh.
      if(includeBackfill&&!this.budget.isBlocked()){
        const nextMs=Date.parse(this.state.nextRefreshAt||'');
        const deadlineMs=(Number.isFinite(nextMs)?nextMs:this.now()+this.config.forex.refreshIntervalMs)-this.config.forex.backfillCycleYieldMarginMs;
        backfillSummary=await this.backfillIncomplete(reason,{deadlineMs});
      }
      await this.memory.checkpoint('FOREX_CYCLE_REBUILD');
      await this.cleanAndRebuild(`cycle-${reason}`);
      if(this.cycleToken===token){
        this.state.status=this.budget.isBlocked()?'BUDGET_STOP_ACTIVE':'ONLINE';
        this.state.lastError=null;
        s.lastSuccessfulCycleAt=iso(this.now());
        s.consecutiveFailures=0;
      }
      return{status:this.state.status,rows,backfill:backfillSummary};
    }catch(e){
      if(this.cycleToken===token){
        this.state.status='DEGRADED';
        this.state.lastError=String(e.stack||e).slice(0,1200);
        s.consecutiveFailures=Number(s.consecutiveFailures||0)+1;
        s.lastFailureAt=iso(this.now());
        s.lastFailureCode=String(e.code||e.message||'FOREX_CYCLE_FAILED').slice(0,120);
      }
      return{status:'FAILED',error:String(e.message||e).slice(0,600),rows};
    }finally{
      if(this.cycleToken===token){
        // Normal completion path.
        this.inFlight=false;this.cycleToken=null;this.cycleStartedMs=null;
        s.cycleInFlight=false;s.cycleToken=null;
        s.lastCycleCompletedAt=iso(this.now());
        this.state.lastRefreshCompletedAt=iso(this.now());
        await this.persist();
      }else{
        // This cycle was abandoned by the watchdog while a step was stalled and has now
        // finally settled: never clobber the state of the newer cycle.
        s.lastAbandonedCycleAt=iso(this.now());
      }
    }
  }
  async refreshAll(reason='manual'){
    // Kept for the private command endpoint and API compatibility: a live-refresh-only
    // cycle (no backfill phase).
    return this.runCycle(reason,{includeBackfill:false});
  }
  nextDelay(){const interval=this.config.forex.refreshIntervalMs;const now=this.now();const next=Math.ceil((now+1000)/interval)*interval+20000;return Math.max(60000,next-now);}
  schedule(){
    if(!this.running)return;
    if(this.timer)clearTimeout(this.timer);
    const delay=this.nextDelay();
    this.state.nextRefreshAt=iso(this.now()+delay);
    this.state.scheduler.nextScheduledAt=this.state.nextRefreshAt;
    this.timer=setTimeout(async()=>{
      this.timer=null;
      try{await this.runCycle('scheduled');}
      catch(e){this.state.lastError=String(e.message||e);}
      this.schedule();
    },delay);
    this.timer.unref?.();
  }
  watchdogTick(){
    // Scheduler watchdog: recovers stalled state safely without restarting the process
    // and without ever creating overlapping cycles (the runCycle token guard plus the
    // single-owner request lease make an abandoned cycle inert).
    const s=this.state.scheduler;
    s.watchdogHeartbeatAt=iso(this.now());
    // 1) Expired request lease → recover it.
    if(this.lease.state.leaseActive&&this.lease.isExpired()){
      const abandoned=this.lease.recover('WATCHDOG_EXPIRED_LEASE_RECOVERED');
      this.lease.persistBounded().catch(()=>{});
      s.watchdogRecoveries++;s.lastWatchdogRecoveryAt=iso(this.now());s.lastWatchdogRecoveryReason='FOREX_REQUEST_LEASE_EXPIRED';
      s.lastFailureAt=iso(this.now());s.lastFailureCode='FOREX_REQUEST_LEASE_EXPIRED';
      this.log(`[v12.0.6] watchdog recovered expired Twelve Data lease (pair=${abandoned.currentPair||'—'} op=${abandoned.currentOperation||'—'})`);
    }
    // 2) Cycle in flight far too long → declare it abandoned so the scheduler can move on.
    if(s.cycleInFlight&&Number.isFinite(this.cycleStartedMs)&&this.now()-this.cycleStartedMs>this.cycleHardLimitMs){
      this.log(`[v12.0.6] watchdog abandoning stalled forex cycle ${this.cycleToken} ageMs=${this.now()-this.cycleStartedMs}`);
      this.cycleToken=null;this.cycleStartedMs=null;this.inFlight=false;
      s.cycleInFlight=false;s.cycleToken=null;
      s.abandonedCycles=Number(s.abandonedCycles||0)+1;
      s.consecutiveFailures=Number(s.consecutiveFailures||0)+1;
      s.lastFailureAt=iso(this.now());s.lastFailureCode='FOREX_SCHEDULER_STALLED';
      s.watchdogRecoveries++;s.lastWatchdogRecoveryAt=iso(this.now());s.lastWatchdogRecoveryReason='FOREX_SCHEDULER_STALLED_CYCLE_ABANDONED';
      this.persist().catch(()=>{});
    }
    // 3) Timer lost or next-run timestamp stale/missing while idle → re-arm the schedule.
    if(this.running&&!s.cycleInFlight){
      const nextMs=Date.parse(this.state.scheduler.nextScheduledAt||'');
      const stale=!this.timer||!Number.isFinite(nextMs)||nextMs<this.now()-90_000;
      if(stale){
        s.watchdogRecoveries++;s.lastWatchdogRecoveryAt=iso(this.now());s.lastWatchdogRecoveryReason='SCHEDULE_REARMED';
        this.log('[v12.0.6] watchdog re-armed forex schedule (timer missing or nextScheduledAt stale)');
        this.schedule();
      }
    }
  }
  startWatchdog(){
    if(this.watchdogTimer)clearInterval(this.watchdogTimer);
    this.watchdogTimer=setInterval(()=>{try{this.watchdogTick();}catch(e){this.state.lastError=String(e.message||e).slice(0,600);}},this.config.forex.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }
  start(){this.running=true;this.state.gen2WorkerOnline=true;this.state.scheduler.schedulerRunning=true;if(!this.watchdogTimer)this.startWatchdog();if(!this.timer&&!this.state.scheduler.cycleInFlight)this.schedule();}
  async stop(){this.running=false;this.state.scheduler.schedulerRunning=false;if(this.timer)clearTimeout(this.timer);if(this.watchdogTimer)clearInterval(this.watchdogTimer);this.state.gen2WorkerOnline=false;await this.persist();await this.flushPersistence(3000);}
  liveMarkets(){const now=this.now();return this.config.forexPairs.map(pair=>{const m=this.state.markets[pair.key]||{pair:pair.canonical,key:pair.key,cleanRows:0,rawRows:0,coverageDays:0,historicalComplete:false,backfillEnabled:true,quality:{}};const latest=Date.parse(m.latestAt||'');const age=Number.isFinite(latest)?Math.max(0,now-(latest+this.config.forex.intervalMs)):Infinity;const stale=m.quality?.marketOpen===false?false:age>this.config.forex.staleMarketDataMs;return{...m,stale,quality:{...(m.quality||{}),stale,staleAgeMinutes:Number.isFinite(age)?Number((age/60000).toFixed(2)):null,status:stale?'STALE_PROVIDER_PRICE_REJECTED_FOR_FORWARD_USE':'CLEAN'}};});}
  schedulerView(){
    const s=this.state.scheduler;
    const lease=this.lease.view();
    const cycleAgeMs=s.cycleInFlight&&Number.isFinite(this.cycleStartedMs)?Math.max(0,this.now()-this.cycleStartedMs):null;
    return{
      // Lease
      leaseActive:lease.leaseActive,leaseId:lease.leaseId,leaseAcquiredAt:lease.leaseAcquiredAt,
      leaseExpiresAt:lease.leaseExpiresAt,leaseAgeMs:lease.leaseAgeMs,leaseExpired:lease.leaseExpired,
      leaseDurationMs:lease.leaseDurationMs,leaseRecovered:lease.leaseRecovered,leaseRecoveryReason:lease.leaseRecoveryReason,
      leaseRecoveredAt:lease.leaseRecoveredAt,leaseStartupRecovery:lease.startupRecovery,
      currentPair:lease.currentPair,currentOperation:lease.currentOperation,
      // Scheduler
      schedulerRunning:this.running===true,schedulerHeartbeatAt:s.schedulerHeartbeatAt,watchdogHeartbeatAt:s.watchdogHeartbeatAt,
      nextScheduledAt:s.nextScheduledAt||this.state.nextRefreshAt,
      lastCycleStartedAt:s.lastCycleStartedAt,lastSuccessfulCycleAt:s.lastSuccessfulCycleAt,lastCycleCompletedAt:s.lastCycleCompletedAt,
      cycleInFlight:s.cycleInFlight===true,cycleAgeMs,cycleHardLimitMs:this.cycleHardLimitMs,
      consecutiveFailures:Number(s.consecutiveFailures||0),lastFailureAt:s.lastFailureAt,lastFailureCode:s.lastFailureCode,
      // Live refresh
      liveRefreshAttemptedPairs:Number(s.liveRefreshAttemptedPairs||0),
      liveRefreshCompletedPairs:Number(s.liveRefreshCompletedPairs||0),
      liveRefreshFailedPairs:Number(s.liveRefreshFailedPairs||0),
      liveRefreshSkippedPairs:Number(s.liveRefreshSkippedPairs||0),
      liveRefreshAttemptedList:s.liveRefreshAttemptedList||[],liveRefreshCompletedList:s.liveRefreshCompletedList||[],
      liveRefreshFailedList:s.liveRefreshFailedList||[],liveRefreshSkippedList:s.liveRefreshSkippedList||[],liveRefreshReleasedAt:s.liveRefreshReleasedAt,
      // Backfill
      backfillCreditsUsedToday:Number(this.state.backfill?.creditsUsedToday||0),
      backfillPairsProcessed:Number(this.state.backfill?.pairsProcessedToday||0),
      backfillDay:this.state.backfill?.day||null,backfillPerPair:this.state.backfill?.perPair||{},
      // Watchdog
      watchdogRecoveries:Number(s.watchdogRecoveries||0),lastWatchdogRecoveryAt:s.lastWatchdogRecoveryAt,
      lastWatchdogRecoveryReason:s.lastWatchdogRecoveryReason,abandonedCycles:Number(s.abandonedCycles||0),
      lastAbandonedCycleAt:s.lastAbandonedCycleAt,
      persistErrors:{forexState:this.lastPersistError,budget:this.budget.lastPersistError,lease:this.lease.lastPersistError},
      circuitBreakerPersistencePending:this.budget.circuitBreakerPersistencePending(),
      persistence:{forexState:this.persistQueue.view(this.config.forex.stateFile),budget:this.persistQueue.view(this.config.forex.budgetFile),lease:this.persistQueue.view(this.config.forex.leaseFile)},
      memory:this.memory.view(),
    };
  }
  problems(){
    const p=[];
    if(!this.config.forex.apiKey)p.push({priority:'P0',market:'FOREX',code:'TWELVE_DATA_API_KEY_MISSING',status:'OPEN'});
    if(this.budget.isBlocked())p.push({priority:'P0',market:'FOREX',code:'HTTP_429_DAY_STOP_ACTIVE',blockedUntil:this.budget.view().blockedUntil,status:'OPEN'});
    const sv=this.schedulerView();
    // Operational diagnostics (v12.0.4.4). Real stale prices below are never hidden.
    if(sv.leaseActive&&sv.leaseExpired)p.push({priority:'P1',market:'FOREX',code:'FOREX_REQUEST_LEASE_EXPIRED',leaseId:sv.leaseId,leaseExpiresAt:sv.leaseExpiresAt,currentPair:sv.currentPair,currentOperation:sv.currentOperation,status:'OPEN'});
    const lastOk=Date.parse(sv.lastSuccessfulCycleAt||'');
    const startedMs=Date.parse(this.state.startedAt||'');
    const sinceOk=Number.isFinite(lastOk)?this.now()-lastOk:(Number.isFinite(startedMs)?this.now()-startedMs:null);
    if(sv.schedulerRunning&&isFxMarketOpen(this.now())&&Number.isFinite(sinceOk)&&sinceOk>2*this.config.forex.refreshIntervalMs&&!this.budget.isBlocked()){
      p.push({priority:'P1',market:'FOREX',code:'FOREX_SCHEDULER_STALLED',lastSuccessfulCycleAt:sv.lastSuccessfulCycleAt,cycleInFlight:sv.cycleInFlight,cycleAgeMs:sv.cycleAgeMs,nextScheduledAt:sv.nextScheduledAt,status:'OPEN'});
    }
    const lastTimeout=Date.parse(this.provider.lastTimeoutAt||'');
    if(Number.isFinite(lastTimeout)&&this.now()-lastTimeout<=this.config.forex.refreshIntervalMs){
      p.push({priority:'P2',market:'FOREX',code:'FOREX_REQUEST_TIMEOUT',lastTimeoutAt:this.provider.lastTimeoutAt,timeoutMs:this.config.forex.requestTimeoutMs,retryPolicy:'NO_RETRY_IN_SAME_CYCLE',status:'OPEN'});
    }
    const lastCycleDone=Date.parse(sv.lastCycleCompletedAt||'');
    if(!sv.cycleInFlight&&Number.isFinite(lastCycleDone)&&this.now()-lastCycleDone<=2*this.config.forex.refreshIntervalMs&&sv.liveRefreshFailedPairs>0){
      p.push({priority:'P1',market:'FOREX',code:'FOREX_LIVE_REFRESH_INCOMPLETE',failedPairs:sv.liveRefreshFailedList,completedPairs:sv.liveRefreshCompletedPairs,attemptedPairs:sv.liveRefreshAttemptedPairs,status:'OPEN'});
    }
    if(sv.cycleInFlight&&Number.isFinite(sv.cycleAgeMs)&&sv.cycleAgeMs<=this.cycleHardLimitMs){
      // A temporarily active request/cycle is context, not an incident: it must not be
      // misread as nine stale-market failures during a normal cycle.
      p.push({priority:'INFO',market:'FOREX',code:'FOREX_CYCLE_IN_FLIGHT',cycleAgeMs:sv.cycleAgeMs,currentPair:sv.currentPair,currentOperation:sv.currentOperation,status:'EXPECTED'});
    }
    for(const m of this.liveMarkets()){
      if(!m.cleanRows)p.push({priority:'P1',market:'FOREX',code:'NO_CLEAN_FOREX_DATA',pair:m.pair,status:'OPEN'});
      else if(!m.historicalComplete)p.push({priority:'P2',market:'FOREX',code:'HISTORY_BELOW_180_DAYS',pair:m.pair,coverageDays:m.coverageDays,status:'OPEN'});
      if(m.stale)p.push({priority:'P1',market:'FOREX',code:'LATEST_PRICE_STALE',pair:m.pair,latestAt:m.latestAt,status:'OPEN'});
    }
    p.push({priority:'INFO',market:'FOREX',code:'UKOIL_TEMPORARILY_DISABLED',status:'EXPECTED'});
    return p;
  }
  async persist(){
    // Ordered persistence (v12.0.4.4.1): serialized + revision-ordered so a delayed
    // older write can never roll persisted scheduler state backward.
    this.state.generatedAt=iso(this.now());
    const {done}=this.persistQueue.enqueue(this.config.forex.stateFile,this.state);
    done.then(result=>{this.lastPersistError=result&&result.ok?null:(result&&result.error||this.lastPersistError);}).catch(()=>{});
    await awaitBounded(done,this.config.forex.persistTimeoutMs);
  }
  async flushPersistence(deadlineMs=3000){return this.persistQueue.flush(deadlineMs);}
  view(){const markets=this.liveMarkets();return{...this.state,generatedAt:iso(this.now()),status:this.budget.isBlocked()?'BUDGET_STOP_ACTIVE':this.state.status,running:this.running,inFlight:this.inFlight,scheduler:this.schedulerView(),lease:this.lease.view(),paperOnly:true,newsLayer:'REMOVED',dataMode:'FOREX_PRICE_ONLY',markets,universe:{mode:'FOREX_PRICE_ONLY',enabledMarkets:this.config.forexPairs.map(p=>p.canonical),enabledCount:this.config.forexPairs.length,disabledMarkets:[{canonical:'UKOIL',reason:'TEMPORARILY_DISABLED_PROVIDER_ACCESS_AND_BUDGET_PROTECTION'}],ukOilEnabled:false},provider:{name:'Twelve Data',allowedEndpoint:'/time_series',newsLayer:'REMOVED',fmpEnabled:false,tradingEconomicsEnabled:false,retriesOn429:0,refreshIntervalMinutes:this.config.forex.refreshIntervalMs/60000},budget:this.budget.view(),hypotheses:this.hypotheses?{count:this.hypotheses.count,researchOnly:this.hypotheses.researchOnly,forwardShadowEligible:0,generatedAt:this.hypotheses.generatedAt}:{count:0,researchOnly:0,forwardShadowEligible:0},migration:this.migration,v11Protection:{root:this.config.legacyRoot,mode:'READ_ONLY',writes:0,v12WriteRoot:this.config.dataRoot},memory:this.memory.view(),problems:this.problems()};}
}

class BinanceMarketDataProvider {
  constructor({config,storage,fetchImpl=global.fetch,now=()=>Date.now()}){this.config=config;this.storage=storage;this.fetchImpl=fetchImpl;this.now=now;this.state=this.empty();this.inFlight=new Set();}
  empty(){return{schema:'alps.gen2.binanceMarketDataState.v1204',blockedUntil:null,last429At:null,last418At:null,lastRequestAt:null,lastRequestByKey:{},requestCount:0,lastHttpStatus:null,lastError:null,usedWeight1m:null,status:'READY'};}
  async load(){this.state={...this.empty(),...(await this.storage.readJson(this.config.crypto.providerStateFile,null)||{})};this.clearExpired();await this.persist();}
  clearExpired(){const until=Date.parse(this.state.blockedUntil||'');if(Number.isFinite(until)&&until<=this.now()){this.state.blockedUntil=null;this.state.status='READY_AFTER_COOLDOWN';}}
  isBlocked(){this.clearExpired();const until=Date.parse(this.state.blockedUntil||'');return Number.isFinite(until)&&until>this.now();}
  async persist(){await this.storage.writeJsonAtomic(this.config.crypto.providerStateFile,this.state);}
  gate(key,minGapMs){if(this.isBlocked())return{ok:false,reason:'BINANCE_PROVIDER_COOLDOWN_ACTIVE',retryAt:this.state.blockedUntil};if(this.inFlight.has(key))return{ok:false,reason:'IDENTICAL_REQUEST_ALREADY_IN_FLIGHT'};const last=Date.parse((this.state.lastRequestByKey||{})[key]||'');if(Number.isFinite(last)&&this.now()-last<minGapMs)return{ok:false,reason:'MINIMUM_REQUEST_GAP_ACTIVE',retryAt:iso(last+minGapMs)};return{ok:true};}
  async fetchKlines(symbol,frame,{purpose='scheduled',limit=500,endTime=null}={}){
    const key=`klines:${symbol}:${frame}:${purpose}`;const minGap=purpose==='scheduled'?this.config.crypto.minLiveRequestGapMs:500;
    const gate=this.gate(key,minGap);if(!gate.ok)return{ok:false,status:0,reason:gate.reason,retryAt:gate.retryAt||null,rows:[]};
    const params=new URLSearchParams({symbol,interval:frame,limit:String(clamp(limit,1,1000))});if(endTime)params.set('endTime',String(Math.floor(endTime)));
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),this.config.crypto.requestTimeoutMs);const at=iso(this.now());this.inFlight.add(key);this.state.lastRequestAt=at;this.state.lastRequestByKey=this.state.lastRequestByKey||{};this.state.lastRequestByKey[key]=at;this.state.requestCount=Number(this.state.requestCount||0)+1;await this.persist();
    try{
      const response=await this.fetchImpl(`${this.config.crypto.providerBaseUrl}/api/v3/klines?${params}`,{headers:{accept:'application/json','user-agent':`ALPS/${VERSION}`},signal:controller.signal});
      const text=await response.text();let payload=null;try{payload=text?JSON.parse(text):null;}catch(_){}
      this.state.lastHttpStatus=response.status;this.state.usedWeight1m=finite(response.headers.get('x-mbx-used-weight-1m'));
      if(response.status===429||response.status===418){const retry=finite(response.headers.get('retry-after'));const fallback=response.status===418?60*60_000:60_000;const until=this.now()+(retry!=null?retry*1000:fallback);this.state.blockedUntil=iso(until);if(response.status===429)this.state.last429At=iso(this.now());else this.state.last418At=iso(this.now());this.state.status=response.status===418?'HTTP_418_IP_BAN_COOLDOWN':'HTTP_429_RATE_LIMIT_COOLDOWN';this.state.lastError=String(payload&&payload.msg||text||`HTTP_${response.status}`).slice(0,240);await this.persist();return{ok:false,status:response.status,reason:this.state.status,retryAt:this.state.blockedUntil,rows:[]};}
      if(!response.ok||!Array.isArray(payload)){this.state.status=`LAST_HTTP_${response.status}`;this.state.lastError=String(payload&&payload.msg||text||`HTTP_${response.status}`).slice(0,240);await this.persist();return{ok:false,status:response.status,reason:this.state.lastError,rows:[]};}
      this.state.status='READY';this.state.lastError=null;await this.persist();return{ok:true,status:response.status,rows:payload};
    }catch(error){this.state.lastHttpStatus=0;this.state.status=error&&error.name==='AbortError'?'PROVIDER_TIMEOUT_NO_RETRY':'PROVIDER_ERROR';this.state.lastError=String(error&&error.message||error).slice(0,240);await this.persist();return{ok:false,status:0,reason:this.state.status,rows:[]};}
    finally{clearTimeout(timeout);this.inFlight.delete(key);}
  }
  view(){this.clearExpired();return{...this.state,blocked:this.isBlocked(),baseUrl:this.config.crypto.providerBaseUrl,publicMarketDataOnly:true,apiKeyRequired:false,allowedEndpoint:'/api/v3/klines'};}
}

async function importCryptoReadonly({config,storage,log}){
  const previous=await storage.readJson(config.crypto.migrationFile,null);let existingTotal=0;
  for(const symbol of config.cryptoSymbols)for(const frame of config.cryptoFrames)existingTotal+=(await storage.readCrypto(config.crypto.rawDir,symbol.key,frame.key)).length;
  if(previous&&previous.importedRows>0&&existingTotal>0)return{...previous,status:'ALREADY_IMPORTED_READ_ONLY'};
  const result={schema:'alps.gen2.v11CryptoReadonlyImport.v1204',startedAt:iso(),completedAt:null,legacyRoot:config.legacyRoot,readOnly:true,v11Writes:0,scannedFiles:0,importedFiles:0,skippedFiles:0,importedRows:0,perFrame:{},errors:[],status:'NOT_STARTED'};
  if(!config.importLegacyOnStartup)return{...result,status:'DISABLED_BY_CONFIG'};
  if(!fs.existsSync(config.legacyRoot))return{...result,status:'V11_ROOT_NOT_FOUND'};
  const files=await listLegacyFiles(config.legacyRoot,{maxFiles:config.maxLegacyFiles});const buckets=new Map();for(const symbol of config.cryptoSymbols)for(const frame of config.cryptoFrames)buckets.set(`${symbol.key}:${frame.key}`,[]);
  for(const file of files){result.scannedFiles++;const symbol=inferSymbol(file,config.cryptoSymbols);if(!symbol){result.skippedFiles++;continue;}let frameKey=inferFrame(file);if(!frameKey&&/(candle|kline|market|ohlc)/i.test(file))frameKey='5m';const frame=config.cryptoFrames.find(f=>f.key===frameKey);if(!frame){result.skippedFiles++;continue;}try{const rows=await parseLegacyFile(file,frame.intervalMs,config.maxLegacyFileBytes);if(!rows.length){result.skippedFiles++;continue;}buckets.get(`${symbol.key}:${frame.key}`).push(...rows);result.importedFiles++;result.importedRows+=rows.length;}catch(error){result.errors.push({file:path.relative(config.legacyRoot,file),error:String(error.message||error).slice(0,240)});}}
  for(const symbol of config.cryptoSymbols)for(const frame of config.cryptoFrames){const k=`${symbol.key}:${frame.key}`;const existing=await storage.readCrypto(config.crypto.rawDir,symbol.key,frame.key);const merged=mergeCandles(existing,buckets.get(k)||[],frame.intervalMs,config.crypto.maxCandlesPerFrame);const cleaned=cleanCandles(merged,{intervalMs:frame.intervalMs,closeBufferMs:config.crypto.candleCloseBufferMs,staleMs:frame.intervalMs*config.crypto.staleMultiplier,assetClass:'CRYPTO',removeFlat:true,preserveFlatForAggregation:true});await storage.writeCrypto(config.crypto.rawDir,symbol.key,frame.key,merged,{source:'V11_READ_ONLY_IMPORT_PLUS_EXISTING_V12'});await storage.writeCrypto(config.crypto.cleanDir,symbol.key,frame.key,cleaned.candles,{source:'V11_READ_ONLY_IMPORT_CLEANED_COPY',quality:cleaned.quality});result.perFrame[k]={importedRows:(buckets.get(k)||[]).length,rawRows:merged.length,cleanRows:cleaned.candles.length,quality:cleaned.quality};}
  result.completedAt=iso();result.status='COMPLETED';result.errors=result.errors.slice(0,100);await storage.writeJsonAtomic(config.crypto.migrationFile,result);log(`[v12.0.6] crypto v11 read-only import files=${result.importedFiles} rows=${result.importedRows}`);return result;
}


function countEvidenceArrays(value, depth=0) {
  if(depth>8||value==null)return 0;
  if(Array.isArray(value))return value.length;
  if(typeof value!=='object')return 0;
  let best=0;
  for(const [key,item] of Object.entries(value)){
    if(['trades','closedtrades','papertrades','positions','signals','ledger','rows','entries','records'].includes(String(key).toLowerCase())&&Array.isArray(item))best=Math.max(best,item.length);
    else best=Math.max(best,countEvidenceArrays(item,depth+1));
  }
  return best;
}

async function estimateEvidenceRecords(file,maxBytes){
  let stat=null;
  try{stat=await fsp.stat(file);}catch(_){return{sizeBytes:0,recordEstimate:0,estimation:'UNREADABLE'};}
  const sizeBytes=stat.size;
  if(sizeBytes>maxBytes)return{sizeBytes,recordEstimate:null,estimation:'SIZE_ONLY_OVER_READ_LIMIT',modifiedAt:iso(stat.mtimeMs)};
  let text='';
  try{text=await fsp.readFile(file,'utf8');}catch(_){return{sizeBytes,recordEstimate:0,estimation:'READ_FAILED',modifiedAt:iso(stat.mtimeMs)};}
  const ext=path.extname(file).toLowerCase();
  if(ext==='.ndjson'||ext==='.jsonl')return{sizeBytes,recordEstimate:text.split(/\r?\n/).filter(line=>line.trim()).length,estimation:'NON_EMPTY_LINES',modifiedAt:iso(stat.mtimeMs)};
  if(ext==='.csv')return{sizeBytes,recordEstimate:Math.max(0,text.split(/\r?\n/).filter(line=>line.trim()).length-1),estimation:'CSV_DATA_LINES',modifiedAt:iso(stat.mtimeMs)};
  try{const payload=JSON.parse(text);return{sizeBytes,recordEstimate:countEvidenceArrays(payload),estimation:'JSON_ARRAY_DISCOVERY',modifiedAt:iso(stat.mtimeMs)};}
  catch(_){return{sizeBytes,recordEstimate:text.split(/\r?\n/).filter(line=>line.trim()).length,estimation:'TEXT_LINES_FALLBACK',modifiedAt:iso(stat.mtimeMs)};}
}

async function catalogLegacyCryptoPaperEvidence({config,storage,log}){
  const previous=await storage.readJson(config.crypto.historicalEvidenceFile,null);
  if(previous&&previous.schema==='alps.gen2.legacyCryptoPaperEvidence.v12043'&&previous.v11Writes===0)return{...previous,status:'ALREADY_CATALOGED_READ_ONLY'};
  const result={
    schema:'alps.gen2.legacyCryptoPaperEvidence.v12043',version:VERSION,generatedAt:iso(),
    legacyRoot:config.legacyRoot,readOnly:true,v11Writes:0,historicalEvidenceOnly:true,replayed:false,
    countedAsV12Trades:false,eligibleForCurrentPerformance:false,catalogedFiles:0,estimatedRecords:0,
    files:[],errors:[],status:'NOT_STARTED',
  };
  if(!fs.existsSync(config.legacyRoot)){result.status='V11_ROOT_NOT_FOUND';await storage.writeJsonAtomic(config.crypto.historicalEvidenceFile,result);return result;}
  const files=await listLegacyFiles(config.legacyRoot,{maxFiles:config.maxLegacyFiles});
  const candidates=files.filter(file=>{
    const rel=path.relative(config.legacyRoot,file).toLowerCase();
    const evidence=/(paper|trade|ledger|closed|position|signal|forward|execution)/.test(rel);
    const marketData=/(candle|kline|ohlc|market[\/_-]|generation2[\/_-]market)/.test(rel);
    return evidence&&!marketData;
  }).slice(0,config.crypto.evidenceMaxFiles);
  for(const file of candidates){
    try{
      const estimate=await estimateEvidenceRecords(file,config.crypto.evidenceMaxBytesPerFile);
      const rel=path.relative(config.legacyRoot,file);
      const token=normalizedToken(rel);
      const symbols=config.cryptoSymbols.filter(symbol=>token.includes(symbol.key)).map(symbol=>symbol.canonical);
      const category=/closed/.test(rel.toLowerCase())?'CLOSED_LEDGER':/signal/.test(rel.toLowerCase())?'SIGNAL_EVIDENCE':/position/.test(rel.toLowerCase())?'POSITION_EVIDENCE':/forward/.test(rel.toLowerCase())?'FORWARD_EVIDENCE':'PAPER_TRADE_EVIDENCE';
      result.files.push({path:rel,category,symbols,...estimate,readOnly:true,replayed:false});
      result.catalogedFiles++;
      if(Number.isFinite(estimate.recordEstimate))result.estimatedRecords+=estimate.recordEstimate;
    }catch(error){result.errors.push({path:path.relative(config.legacyRoot,file),error:String(error.message||error).slice(0,240)});}
  }
  result.status=result.catalogedFiles?'CATALOGED_AS_HISTORICAL_EVIDENCE_READ_ONLY':'NO_LEGACY_PAPER_EVIDENCE_FILES_FOUND';
  result.errors=result.errors.slice(0,100);
  await storage.writeJsonAtomic(config.crypto.historicalEvidenceFile,result);
  log(`[v12.0.6] legacy crypto paper evidence files=${result.catalogedFiles} estimatedRecords=${result.estimatedRecords}`);
  return result;
}

async function loadForwardShadowFoundation(config,storage,now){
  const previous=await storage.readJson(config.crypto.forwardShadowFile,null);
  const base={
    schema:'alps.gen2.cryptoForwardShadow.v12051',version:VERSION,epochAt:iso(now()),
    mode:'PAPER_FORWARD_SHADOW',candidateEngineEnabled:true,paperExecutionEnabled:true,executionEnabled:false,promotionEnabled:false,liveCapitalExecution:false,
    activationVersionRequired:null,frames:{},observedClosedCandles:0,framesWithPostDeployObservation:0,
    continuityPassedFrames:0,cleanFrames:0,forwardShadowEligible:0,lastEvaluatedAt:null,
    status:'CANDIDATE_ENGINE_INITIALIZING',
  };
  const compatible=previous&&['alps.gen2.cryptoForwardShadowFoundation.v12043','alps.gen2.cryptoForwardShadow.v1205','alps.gen2.cryptoForwardShadow.v12051'].includes(previous.schema);
  return compatible?{...base,...previous,schema:base.schema,version:VERSION,epochAt:previous.epochAt||base.epochAt,mode:'PAPER_FORWARD_SHADOW',candidateEngineEnabled:true,paperExecutionEnabled:true,executionEnabled:false,promotionEnabled:false,liveCapitalExecution:false,activationVersionRequired:null}:{...base};
}

async function updateForwardShadowFoundation({config,storage,now,foundation,data,frameState,continuity}){
  const epochMs=Date.parse(foundation.epochAt||'');
  const frames={...(foundation.frames||{})};
  let observedClosedCandles=0;
  let framesWithPostDeployObservation=0;
  let continuityPassedFrames=0;
  let cleanFrames=0;
  for(const symbol of config.cryptoSymbols)for(const frame of config.cryptoFrames){
    const key=`${symbol.key}:${frame.key}`;
    const candles=(data[key]||[]).map(row=>normalizeCandle(row,frame.intervalMs)).filter(c=>validOhlc(c)&&c.validForSignals!==false);
    const prior=frames[key]||{observationCount:0,lastObservedCandleAt:null};
    const lastObservedMs=Date.parse(prior.lastObservedCandleAt||'');
    const threshold=Number.isFinite(lastObservedMs)?lastObservedMs:-Infinity;
    const freshRows=candles.filter(c=>{
      const closeAt=Number.isFinite(c.closeTime)?c.closeTime:c.t+frame.intervalMs-1;
      return Number.isFinite(epochMs)&&closeAt>epochMs&&c.t>threshold;
    });
    const latestNew=freshRows.at(-1);
    const state=frameState[key]||{};
    const audit=continuity.frames?.[key]||{};
    const observationCount=Number(prior.observationCount||0)+freshRows.length;
    const cleanData=Number(state.cleanRows||0)>0&&!state.stale;
    const continuityPassed=audit.continuityPassed===true;
    const freshClosedCandle=observationCount>0;
    frames[key]={
      symbol:symbol.canonical,symbolKey:symbol.key,timeframe:frame.key,
      observationCount,lastObservedCandleAt:latestNew?iso(latestNew.t):prior.lastObservedCandleAt||null,
      cleanData,continuityPassed,freshClosedCandle,duplicateSignal:false,entryStopTargetValid:false,
      candidateProduced:false,forwardShadowEligible:false,
      status:cleanData&&continuityPassed&&freshClosedCandle?'READY_FOR_V12_0_5_CANDIDATE_ENGINE':'COLLECTING_POST_DEPLOY_CLOSED_CANDLES',
      blockedReason:'V12_0_5_CANDIDATE_ENGINE_NOT_ACTIVE',
    };
    observedClosedCandles+=observationCount;
    if(freshClosedCandle)framesWithPostDeployObservation++;
    if(continuityPassed)continuityPassedFrames++;
    if(cleanData)cleanFrames++;
  }
  const totalFrames=config.cryptoSymbols.length*config.cryptoFrames.length;
  const updated={
    ...foundation,version:VERSION,frames,observedClosedCandles,framesWithPostDeployObservation,
    continuityPassedFrames,cleanFrames,forwardShadowEligible:0,lastEvaluatedAt:iso(now()),
    mode:'OBSERVATION_ONLY',executionEnabled:false,promotionEnabled:false,liveCapitalExecution:false,
    activationVersionRequired:'v12.0.5',
    status:framesWithPostDeployObservation===totalFrames?'FOUNDATION_READY_AWAITING_V12_0_5_EXECUTION':'COLLECTING_POST_DEPLOY_CLOSED_CANDLES',
    rule:'Only candles whose close time is later than epochAt count as forward evidence. Historical candles are never replayed as forward observations.',
  };
  await storage.writeJsonAtomic(config.crypto.forwardShadowFile,updated);
  return updated;
}

function cryptoFamilyMetricsAll(candles){
  const sample=(Array.isArray(candles)?candles:[]).slice(-12000);const ret=candleReturns(sample);
  const families=['TREND_CONTINUATION','MEAN_REVERSION','BREAKOUT_CONTINUATION','VOLATILITY_EXPANSION','MOMENTUM_REVERSAL'];
  const acc=Object.fromEntries(families.map(name=>[name,createMetricAccumulator()]));
  if(!ret.length)return Object.fromEntries(families.map(name=>[name,finalizeMetricAccumulator(acc[name])]));
  const baseAcc=ret.reduce((a,v)=>(addMetricValue(a,v),a),createMetricAccumulator());const threshold=Math.sqrt(baseAcc.samples?baseAcc.m2/baseAcc.samples:0)*1.5;
  let sum50=0,sum30Abs=0,sum12=0;
  for(let i=0;i<ret.length;i++){
    const v=ret[i];
    if(Math.abs(v)>threshold)addMetricValue(acc.BREAKOUT_CONTINUATION,Math.abs(v));
    if(i<50)sum50+=v;else{addMetricValue(acc.TREND_CONTINUATION,v*Math.sign((sum50/50)||1));addMetricValue(acc.MEAN_REVERSION,-v*Math.sign((sum50/50)||1));sum50+=v-ret[i-50];}
    const av=Math.abs(v);if(i<30)sum30Abs+=av;else{addMetricValue(acc.VOLATILITY_EXPANSION,av-(sum30Abs/30));sum30Abs+=av-Math.abs(ret[i-30]);}
    if(i<12)sum12+=v;else{addMetricValue(acc.MOMENTUM_REVERSAL,-v*Math.sign(sum12||1));sum12+=v-ret[i-12];}
  }
  return Object.fromEntries(families.map(name=>[name,finalizeMetricAccumulator(acc[name])]));
}
function cryptoFamilyMetrics(family,candles){return cryptoFamilyMetricsAll(candles)[family]||finalizeMetricAccumulator(createMetricAccumulator());}
async function rebuildCryptoHypotheses(config,storage,data,{continuity=null,forwardShadow=null}={}){
  const families=['TREND_CONTINUATION','MEAN_REVERSION','BREAKOUT_CONTINUATION','VOLATILITY_EXPANSION','MOMENTUM_REVERSAL'];
  const hypotheses=[];
  const generatedAt=iso();
  let continuityPassedHypotheses=0;
  let forwardObservationReady=0;
  for(const symbol of config.cryptoSymbols)for(const frame of config.cryptoFrames){
    const key=`${symbol.key}:${frame.key}`;
    const candles=(data[key]||[]).filter(c=>normalizeCandle(c,frame.intervalMs)?.validForSignals!==false);
    const metricsByFamily=cryptoFamilyMetricsAll(candles);const audit=continuity?.frames?.[key]||{};const forwardFrame=forwardShadow?.frames?.[key]||{};
    for(const family of families){const metrics=metricsByFamily[family];const gates={cleanData:metrics.samples>=500,continuityPassed:audit.continuityPassed===true,freshClosedCandle:forwardFrame.freshClosedCandle===true,duplicateSignal:false,entryStopTargetValid:false,candidateProduced:false};if(gates.continuityPassed)continuityPassedHypotheses++;if(gates.cleanData&&gates.continuityPassed&&gates.freshClosedCandle)forwardObservationReady++;hypotheses.push({id:`CRYPTO-${symbol.key}-${frame.key}-${family}`,scope:'SYMBOL_TIMEFRAME',family,symbol:symbol.canonical,timeframe:frame.key,dataMode:'CRYPTO_PRICE_ONLY',modelWindowBars:Math.min(12000,candles.length),metrics,evidenceStatus:!gates.cleanData?'INSUFFICIENT_CLEAN_SAMPLE':!gates.continuityPassed?'CONTINUITY_AUDIT_FAILED':'POST_CLEAN_CONTINUITY_AUDITED_PRICE_EVIDENCE',promotionStatus:gates.continuityPassed?'RESEARCH_ONLY_CONTINUITY_AUDITED':'BLOCKED_CONTINUITY_GAP',forwardGates:gates,forwardShadowEligible:false,forwardBlockedReason:'V12_0_5_CANDIDATE_ENTRY_STOP_TARGET_ENGINE_NOT_ACTIVE',paperOnly:true,liveCapitalExecution:false,generatedAt});}
  }
  const payload={
    schema:'alps.gen2.cryptoHypotheses.v12043',version:VERSION,generatedAt,count:hypotheses.length,
    researchOnly:hypotheses.length,continuityPassedHypotheses,forwardObservationReady,forwardShadowEligible:0,
    rule:'Price-only crypto research. Closed candles, continuity audited, no account access, no order endpoints, no live-capital execution. Forward promotion remains disabled until v12.0.5.',
    hypotheses,
  };
  await storage.writeJsonAtomic(config.crypto.hypothesesFile,payload);
  return payload;
}


const CRYPTO_HYPOTHESIS_FAMILIES=Object.freeze(['TREND_CONTINUATION','MEAN_REVERSION','BREAKOUT_CONTINUATION','VOLATILITY_EXPANSION','MOMENTUM_REVERSAL']);

function roundMarketPrice(value){
  const n=Number(value);if(!Number.isFinite(n))return null;
  return Number(n.toPrecision(12));
}
function candleTrueRange(candle,priorClose){
  if(!candle)return 0;
  if(!Number.isFinite(priorClose))return Math.max(0,candle.h-candle.l);
  return Math.max(candle.h-candle.l,Math.abs(candle.h-priorClose),Math.abs(candle.l-priorClose));
}
function averageTrueRange(candles,period=14){
  const rows=Array.isArray(candles)?candles:[];if(rows.length<period+1)return null;
  let sum=0;const start=rows.length-period;
  for(let i=start;i<rows.length;i++)sum+=candleTrueRange(rows[i],rows[i-1]?.c);
  const atr=sum/period;return Number.isFinite(atr)&&atr>0?atr:null;
}
function exponentialMovingAverage(candles,period){
  const rows=Array.isArray(candles)?candles:[];if(rows.length<period)return null;
  const start=Math.max(0,rows.length-period*4);const seed=rows.slice(start,start+period);
  let ema=seed.reduce((sum,c)=>sum+c.c,0)/seed.length;const alpha=2/(period+1);
  for(let i=start+period;i<rows.length;i++)ema=rows[i].c*alpha+ema*(1-alpha);
  return Number.isFinite(ema)?ema:null;
}
function rollingMeanStd(candles,period){
  const rows=(Array.isArray(candles)?candles:[]).slice(-period);if(rows.length<period)return null;
  const mean=rows.reduce((sum,c)=>sum+c.c,0)/period;const variance=rows.reduce((sum,c)=>sum+(c.c-mean)**2,0)/period;
  return{mean,std:Math.sqrt(Math.max(0,variance))};
}
function setupSignature(parts){return parts.map(part=>String(part)).join('|');}

function deriveCryptoCandidateSetup({family,candles,symbol,frame,epochMs}){
  const rows=(Array.isArray(candles)?candles:[]).map(row=>normalizeCandle(row,frame.intervalMs)).filter(c=>validOhlc(c)&&c.validForSignals!==false).slice(-240);
  if(rows.length<60)return{produced:false,reason:'INSUFFICIENT_SIGNAL_WINDOW'};
  const latest=rows.at(-1);const closeAt=Number.isFinite(latest.closeTime)?latest.closeTime:latest.t+frame.intervalMs-1;
  if(!Number.isFinite(epochMs)||closeAt<=epochMs)return{produced:false,reason:'LATEST_CANDLE_NOT_POST_FORWARD_EPOCH'};
  const atr=averageTrueRange(rows,14);if(!Number.isFinite(atr)||atr<=0)return{produced:false,reason:'ATR_NOT_AVAILABLE'};
  const atrRatio=atr/latest.c;let direction=null;const features={atr:roundMarketPrice(atr),atrRatio:Number(atrRatio.toFixed(8))};
  if(family==='TREND_CONTINUATION'){
    const ema20=exponentialMovingAverage(rows,20),ema50=exponentialMovingAverage(rows,50);const reference=rows.at(-9)?.c;const momentum8=reference?latest.c/reference-1:0;
    Object.assign(features,{ema20:roundMarketPrice(ema20),ema50:roundMarketPrice(ema50),momentum8:Number(momentum8.toFixed(8))});
    if(ema20>ema50&&latest.c>ema20&&latest.c>latest.o&&momentum8>atrRatio*0.3)direction='LONG';
    else if(ema20<ema50&&latest.c<ema20&&latest.c<latest.o&&momentum8<-atrRatio*0.3)direction='SHORT';
  }else if(family==='MEAN_REVERSION'){
    const stats=rollingMeanStd(rows,20);const z=stats&&stats.std>0?(latest.c-stats.mean)/stats.std:0;Object.assign(features,{mean20:roundMarketPrice(stats?.mean),std20:roundMarketPrice(stats?.std),zScore:Number(z.toFixed(6))});
    if(z<=-1.5)direction='LONG';else if(z>=1.5)direction='SHORT';
  }else if(family==='BREAKOUT_CONTINUATION'){
    const prior=rows.slice(-21,-1);const priorHigh=Math.max(...prior.map(c=>c.h));const priorLow=Math.min(...prior.map(c=>c.l));Object.assign(features,{prior20High:roundMarketPrice(priorHigh),prior20Low:roundMarketPrice(priorLow)});
    if(latest.c>priorHigh)direction='LONG';else if(latest.c<priorLow)direction='SHORT';
  }else if(family==='VOLATILITY_EXPANSION'){
    const tr=candleTrueRange(latest,rows.at(-2)?.c);const body=Math.abs(latest.c-latest.o);Object.assign(features,{trueRange:roundMarketPrice(tr),atrMultiple:Number((tr/atr).toFixed(5)),bodyShare:Number((body/Math.max(tr,Number.EPSILON)).toFixed(5))});
    if(tr>=atr*1.5&&body>=tr*0.45)direction=latest.c>latest.o?'LONG':latest.c<latest.o?'SHORT':null;
  }else if(family==='MOMENTUM_REVERSAL'){
    const reference=rows.at(-13)?.c;const momentum12=reference?latest.c/reference-1:0;const prior=rows.at(-2);Object.assign(features,{momentum12:Number(momentum12.toFixed(8))});
    if(momentum12>atrRatio*1.25&&latest.c<latest.o&&latest.c<prior.c)direction='SHORT';
    else if(momentum12<-atrRatio*1.25&&latest.c>latest.o&&latest.c>prior.c)direction='LONG';
  }
  if(!direction)return{produced:false,reason:'NO_FAMILY_SIGNAL_ON_LATEST_CLOSED_CANDLE',features};
  const structural=rows.slice(-10);const entry=latest.c;const structuralDistance=direction==='LONG'?entry-Math.min(...structural.map(c=>c.l)):Math.max(...structural.map(c=>c.h))-entry;
  const risk=Math.min(atr*3,Math.max(atr*0.8,structuralDistance));if(!Number.isFinite(risk)||risk<=0)return{produced:false,reason:'INVALID_RISK_DISTANCE',features};
  const stop=direction==='LONG'?entry-risk:entry+risk;const zoneHalf=atr*0.15;const entryZoneLow=entry-zoneHalf;const entryZoneHigh=entry+zoneHalf;
  const targets=[1,2,5].map(rr=>({rr,target:direction==='LONG'?entry+risk*rr:entry-risk*rr}));
  const valid=[entry,stop,entryZoneLow,entryZoneHigh,...targets.map(t=>t.target)].every(v=>Number.isFinite(v)&&v>0)&&
    (direction==='LONG'?stop<entry&&targets.every(t=>t.target>entry):stop>entry&&targets.every(t=>t.target<entry));
  if(!valid)return{produced:false,reason:'ENTRY_STOP_TARGET_VALIDATION_FAILED',features};
  const hypothesisId=`CRYPTO-${symbol.key}-${frame.key}-${family}`;const signalCandleAt=iso(latest.t);const signature=setupSignature([hypothesisId,latest.t,direction,roundMarketPrice(entry),roundMarketPrice(stop)]);
  return{
    produced:true,reason:null,hypothesisId,family,symbol:symbol.canonical,symbolKey:symbol.key,timeframe:frame.key,intervalMs:frame.intervalMs,
    direction,signalCandleAt,signalCandleOpenTime:latest.t,signalCandleCloseAt:iso(closeAt),entry:roundMarketPrice(entry),entryZoneLow:roundMarketPrice(entryZoneLow),entryZoneHigh:roundMarketPrice(entryZoneHigh),
    initialStop:roundMarketPrice(stop),riskDistance:roundMarketPrice(risk),targets:targets.map(t=>({rr:t.rr,target:roundMarketPrice(t.target)})),features,signature,
    entryStopTargetValid:true,entryStillInsideZone:entry>=entryZoneLow&&entry<=entryZoneHigh,
  };
}

function emptyCandidatePerformance(){
  return{
    totalCandidates:0,totalOpened:0,activeCandidates:0,closedCandidates:0,totalLegs:0,openLegs:0,
    targetHits:0,stopHits:0,ambiguousLegs:0,scoredLegs:0,wins:0,losses:0,breakeven:0,netR:0,
    byRiskReward:{R1:{rr:1,opened:0,open:0,targetHits:0,stopHits:0,ambiguous:0,netR:0},R2:{rr:2,opened:0,open:0,targetHits:0,stopHits:0,ambiguous:0,netR:0},R5:{rr:5,opened:0,open:0,targetHits:0,stopHits:0,ambiguous:0,netR:0}},
  };
}
function normalizeCandidatePerformance(value){
  const base=emptyCandidatePerformance();const merged={...base,...(value||{})};merged.byRiskReward={...base.byRiskReward,...((value&&value.byRiskReward)||{})};for(const key of ['R1','R2','R5'])merged.byRiskReward[key]={...base.byRiskReward[key],...(merged.byRiskReward[key]||{})};return merged;
}

class CryptoForwardShadowCandidateEngine {
  constructor({ config, storage, now = () => Date.now(), log = () => {} }) {
    this.config = config;
    this.storage = storage;
    this.now = now;
    this.log = log;
    this.state = null;
    this.lastError = null;

    const stateDir = path.join(this.config.dataRoot, 'state');
    const evidenceDir = path.join(this.config.dataRoot, 'evidence');
    this.provisionalStateFile = this.config.crypto.provisionalCandidateStateFile || this.config.crypto.candidateStateFile || path.join(stateDir, 'crypto-forward-shadow-candidate-engine.json');
    this.provisionalLedgerFile = this.config.crypto.provisionalCandidateLedgerFile || this.config.crypto.candidateLedgerFile || path.join(evidenceDir, 'crypto-forward-shadow-ledger.ndjson');
    this.activeStateFile = this.config.crypto.certifiedCandidateStateFile || path.join(stateDir, 'crypto-forward-shadow-candidate-engine-v12051.json');
    this.activeLedgerFile = this.config.crypto.certifiedCandidateLedgerFile || path.join(evidenceDir, 'crypto-forward-shadow-ledger-v12051.ndjson');
    this.provisionalManifestFile = this.config.crypto.provisionalCandidateManifestFile || path.join(evidenceDir, 'crypto-forward-shadow-v1205-provisional-manifest.json');
    this.config.crypto.candidateStateFile = this.activeStateFile;
    this.config.crypto.candidateLedgerFile = this.activeLedgerFile;
    if (!Number.isFinite(Number(this.config.crypto.candidateRecentClosedLimit))) this.config.crypto.candidateRecentClosedLimit = 200;
    this.recentExpiredLimit = Math.max(10, Math.min(1000, Number(this.config.crypto.candidateRecentClosedLimit || 200)));
  }

  empty(foundationEpochAt) {
    const candidateEngineEpochAt = iso(this.now());
    return {
      schema: 'alps.gen2.cryptoForwardShadowCandidateEngine.v12051',
      version: CANDIDATE_ENGINE_VERSION,
      foundationEpochAt: foundationEpochAt || null,
      candidateEngineEpochAt,
      epochAt: candidateEngineEpochAt,
      evidenceClass: 'CERTIFIED_FORWARD_V12051',
      mode: 'PAPER_FORWARD_SHADOW',
      status: 'CANDIDATE_ENGINE_ACTIVE_STRICT_FORWARD_PAPER_ONLY',
      candidateEngineEnabled: true,
      paperExecutionEnabled: true,
      executionEnabled: false,
      liveCapitalExecution: false,
      promotionEnabled: false,
      setupPolicy: {
        closedCandlesOnly: true,
        strictForwardTimeIntegrity: true,
        nominationRequiresPostEngineEpochSignal: true,
        entryRequiresFirstFullyPostNominationClosedCandle: true,
        entryMustRemainInsideZone: true,
        paperEntryAtUsesEntryCandleClose: true,
        noCandidateCap: true,
        noOpenCandidateCap: true,
        duplicateRule: 'SAME_HYPOTHESIS_SAME_CANDLE_SAME_SETUP_BLOCKED',
        repeatedSignalsAllowedWhenSetupDiffers: true,
        historicalCatchupAllowed: false,
      },
      riskPolicy: {
        riskRewardLegs: [1, 2, 5],
        moveStopToBreakevenAtProgress: 0.5,
        moveStopToHalfTargetAtProgress: 0.75,
        intrabarAmbiguity: 'BOTH_STOP_AND_TARGET_TOUCHED_IS_UNSCORED_AMBIGUOUS',
      },
      provisionalV1205Ledger: {
        classification: 'PROVISIONAL_V1205_LEDGER',
        preserved: true,
        deleted: false,
        countedInCertifiedPerformance: false,
        sourceStateFile: this.provisionalStateFile,
        sourceLedgerFile: this.provisionalLedgerFile,
        available: false,
        totalCandidates: 0,
        netR: 0,
        ledgerBytes: 0,
      },
      temporalIntegrity: {
        status: 'PASS',
        violations: 0,
        lastViolationAt: null,
        lastViolation: null,
        rule: 'paperEntryAt >= createdAt; entry candle opens after nomination; lifecycle candles are fully closed and occur after paper entry.',
      },
      lastEvaluatedAt: null,
      lastEvaluatedCandleByFrame: {},
      lastSetupByHypothesis: {},
      pendingCandidates: {},
      openCandidates: {},
      recentClosedCandidates: [],
      recentExpiredCandidates: [],
      performance: {
        ...emptyCandidatePerformance(),
        totalNominations: 0,
        pendingEntries: 0,
        entryExpired: 0,
        certifiedForwardOnly: true,
      },
      cycle: {
        reason: null,
        startedAt: null,
        completedAt: null,
        framesEvaluated: 0,
        hypothesesEvaluated: 0,
        candidatesProduced: 0,
        nominationsProduced: 0,
        entriesOpened: 0,
        entryExpired: 0,
        duplicatesBlocked: 0,
        lifecycleEvents: 0,
        temporalViolations: 0,
      },
      eventSequence: 0,
      lastLedgerEventAt: null,
      lastError: null,
    };
  }

  async provisionalSummary() {
    const prior = await this.storage.readJson(this.provisionalStateFile, null);
    let ledgerBytes = 0;
    try { ledgerBytes = Number((await fsp.stat(this.provisionalLedgerFile)).size || 0); } catch (_) {}
    const totalCandidates = Number(prior?.performance?.totalCandidates || 0);
    const netR = Number(prior?.performance?.netR || 0);
    return {
      classification: 'PROVISIONAL_V1205_LEDGER',
      preserved: true,
      deleted: false,
      countedInCertifiedPerformance: false,
      sourceStateFile: this.provisionalStateFile,
      sourceLedgerFile: this.provisionalLedgerFile,
      available: Boolean(prior || ledgerBytes > 0),
      sourceSchema: prior?.schema || null,
      sourceVersion: prior?.version || null,
      totalCandidates,
      activeCandidates: Number(prior?.performance?.activeCandidates || 0),
      closedCandidates: Number(prior?.performance?.closedCandidates || 0),
      scoredLegs: Number(prior?.performance?.scoredLegs || 0),
      netR,
      ledgerBytes,
      classifiedAt: iso(this.now()),
    };
  }

  async load(foundationEpochAt) {
    const prior = await this.storage.readJson(this.activeStateFile, null);
    const base = this.empty(foundationEpochAt);
    if (prior && prior.schema === base.schema) {
      this.state = {
        ...base,
        ...prior,
        version: CANDIDATE_ENGINE_VERSION,
        foundationEpochAt: prior.foundationEpochAt || foundationEpochAt || null,
        candidateEngineEpochAt: prior.candidateEngineEpochAt || prior.epochAt || base.candidateEngineEpochAt,
        epochAt: prior.candidateEngineEpochAt || prior.epochAt || base.candidateEngineEpochAt,
        performance: { ...base.performance, ...normalizeCandidatePerformance(prior.performance), ...(prior.performance || {}) },
        pendingCandidates: prior.pendingCandidates && typeof prior.pendingCandidates === 'object' ? prior.pendingCandidates : {},
        openCandidates: prior.openCandidates && typeof prior.openCandidates === 'object' ? prior.openCandidates : {},
        recentClosedCandidates: Array.isArray(prior.recentClosedCandidates) ? prior.recentClosedCandidates : [],
        recentExpiredCandidates: Array.isArray(prior.recentExpiredCandidates) ? prior.recentExpiredCandidates : [],
        lastSetupByHypothesis: prior.lastSetupByHypothesis && typeof prior.lastSetupByHypothesis === 'object' ? prior.lastSetupByHypothesis : {},
        lastEvaluatedCandleByFrame: prior.lastEvaluatedCandleByFrame && typeof prior.lastEvaluatedCandleByFrame === 'object' ? prior.lastEvaluatedCandleByFrame : {},
        temporalIntegrity: { ...base.temporalIntegrity, ...(prior.temporalIntegrity || {}) },
      };
    } else {
      this.state = base;
      this.state.provisionalV1205Ledger = await this.provisionalSummary();
      await this.storage.writeJsonAtomic(this.provisionalManifestFile, {
        schema: 'alps.gen2.cryptoForwardShadowProvisionalLedgerManifest.v12051',
        version: VERSION,
        certifiedCandidateEngineEpochAt: this.state.candidateEngineEpochAt,
        ...this.state.provisionalV1205Ledger,
      });
    }
    this.state.mode = 'PAPER_FORWARD_SHADOW';
    this.state.status = 'CANDIDATE_ENGINE_ACTIVE_STRICT_FORWARD_PAPER_ONLY';
    this.state.candidateEngineEnabled = true;
    this.state.paperExecutionEnabled = true;
    this.state.executionEnabled = false;
    this.state.liveCapitalExecution = false;
    this.state.promotionEnabled = false;
    this.state.evidenceClass = 'CERTIFIED_FORWARD_V12051';
    this.state.performance = { ...this.state.performance, certifiedForwardOnly: true };
    this.validateTemporalIntegrity();
    await this.persist();
    return this.state;
  }

  beginCycle(reason) {
    this.state.lastError = null;
    this.lastError = null;
    this.state.cycle = {
      reason,
      startedAt: iso(this.now()),
      completedAt: null,
      framesEvaluated: 0,
      hypothesesEvaluated: 0,
      candidatesProduced: 0,
      nominationsProduced: 0,
      entriesOpened: 0,
      entryExpired: 0,
      duplicatesBlocked: 0,
      lifecycleEvents: 0,
      temporalViolations: 0,
    };
  }

  async appendEvent(type, payload = {}) {
    this.state.eventSequence = Number(this.state.eventSequence || 0) + 1;
    const observedAt = iso(this.now());
    const event = {
      schema: 'alps.gen2.cryptoForwardShadowLedgerEvent.v12051',
      version: CANDIDATE_ENGINE_VERSION,
      sequence: this.state.eventSequence,
      eventId: `FS51-E${String(this.state.eventSequence).padStart(10, '0')}`,
      type,
      evidenceClass: 'CERTIFIED_FORWARD_V12051',
      candidateEngineEpochAt: this.state.candidateEngineEpochAt,
      paperOnly: true,
      liveCapitalExecution: false,
      ...payload,
      observedAt,
      at: observedAt,
    };
    await this.storage.appendNdjson(this.activeLedgerFile, event);
    this.state.lastLedgerEventAt = observedAt;
    this.state.cycle.lifecycleEvents = Number(this.state.cycle.lifecycleEvents || 0) + 1;
    return event;
  }

  performanceView() {
    const normalized = normalizeCandidatePerformance(this.state?.performance);
    const p = { ...normalized, ...(this.state?.performance || {}) };
    const scored = Math.max(0, Number(p.scoredLegs || 0));
    return {
      ...p,
      totalNominations: Number(p.totalNominations || 0),
      pendingEntries: Object.keys(this.state?.pendingCandidates || {}).length,
      entryExpired: Number(p.entryExpired || 0),
      certifiedForwardOnly: true,
      netR: Number(Number(p.netR || 0).toFixed(6)),
      winRate: scored ? Number((Number(p.wins || 0) / scored * 100).toFixed(3)) : null,
      byRiskReward: Object.fromEntries(Object.entries(p.byRiskReward).map(([key, row]) => [key, { ...row, netR: Number(Number(row.netR || 0).toFixed(6)) }])),
    };
  }

  async persist() {
    this.state.version = CANDIDATE_ENGINE_VERSION;
    this.state.epochAt = this.state.candidateEngineEpochAt;
    this.state.lastEvaluatedAt = this.state.lastEvaluatedAt || iso(this.now());
    this.state.performance = { ...normalizeCandidatePerformance(this.state.performance), ...this.state.performance, certifiedForwardOnly: true };
    this.state.performance.pendingEntries = Object.keys(this.state.pendingCandidates || {}).length;
    this.validateTemporalIntegrity();
    await this.storage.writeJsonAtomic(this.activeStateFile, this.state);
  }

  candidateResultBase(reason) {
    return {
      candidateProduced: false,
      nominationProduced: false,
      entryOpened: false,
      duplicateSignal: false,
      entryStopTargetValid: false,
      forwardShadowEligible: false,
      blockedReason: reason,
      candidateId: null,
      direction: null,
    };
  }

  clusterId(setup) {
    return setupSignature([
      'EC51',
      setup.symbolKey,
      setup.timeframe,
      setup.signalCandleOpenTime,
      setup.direction,
      roundMarketPrice(setup.entry),
      roundMarketPrice(setup.initialStop),
    ]);
  }

  async nominateCandidate(setup) {
    const candidateId = `FS51-${setup.symbolKey}-${setup.timeframe}-${setup.family}-${setup.signalCandleOpenTime}-${setup.direction}`;
    const nominatedAt = iso(this.now());
    const candidate = {
      schema: 'alps.gen2.cryptoForwardShadowCandidate.v12051',
      version: CANDIDATE_ENGINE_VERSION,
      evidenceClass: 'CERTIFIED_FORWARD_V12051',
      candidateId,
      setupId: setup.signature,
      evidenceClusterId: this.clusterId(setup),
      hypothesisId: setup.hypothesisId,
      family: setup.family,
      symbol: setup.symbol,
      symbolKey: setup.symbolKey,
      timeframe: setup.timeframe,
      intervalMs: setup.intervalMs,
      direction: setup.direction,
      signalCandleAt: setup.signalCandleAt,
      signalCandleOpenTime: setup.signalCandleOpenTime,
      signalCandleCloseAt: setup.signalCandleCloseAt,
      nominatedAt,
      createdAt: nominatedAt,
      paperEntryAt: null,
      openedAt: null,
      entryObservedAt: null,
      referenceEntry: setup.entry,
      entry: null,
      entryZoneLow: setup.entryZoneLow,
      entryZoneHigh: setup.entryZoneHigh,
      entryValidation: 'AWAITING_FIRST_FULLY_POST_NOMINATION_CLOSED_CANDLE',
      plannedInitialStop: setup.initialStop,
      initialStop: null,
      riskDistance: null,
      plannedTargets: setup.targets,
      features: setup.features,
      status: 'PENDING_FORWARD_ENTRY',
      entryCandleOpenAt: null,
      entryCandleCloseAt: null,
      firstEligibleLifecycleCandleOpenAt: null,
      lastProcessedCandleOpenAt: null,
      lastProcessedCandleCloseAt: null,
      lastProcessedObservedAt: null,
      legs: [],
      paperOnly: true,
      liveCapitalExecution: false,
    };
    this.state.pendingCandidates[candidateId] = candidate;
    this.state.lastSetupByHypothesis[setup.hypothesisId] = {
      signature: setup.signature,
      signalCandleAt: setup.signalCandleAt,
      candidateId,
      nominatedAt,
    };
    this.state.performance.totalNominations = Number(this.state.performance.totalNominations || 0) + 1;
    this.state.cycle.candidatesProduced++;
    this.state.cycle.nominationsProduced++;
    await this.appendEvent('CANDIDATE_NOMINATED', {
      candidateId,
      hypothesisId: setup.hypothesisId,
      evidenceClusterId: candidate.evidenceClusterId,
      symbol: setup.symbol,
      timeframe: setup.timeframe,
      family: setup.family,
      direction: setup.direction,
      signalCandleOpenAt: setup.signalCandleAt,
      signalCandleCloseAt: setup.signalCandleCloseAt,
      nominatedAt,
      entryZoneLow: setup.entryZoneLow,
      entryZoneHigh: setup.entryZoneHigh,
      plannedInitialStop: setup.initialStop,
      setupId: setup.signature,
    });
    return candidate;
  }

  recordLegResult(leg, resultR) {
    const p = this.state.performance;
    const key = `R${leg.rr}`;
    p.openLegs = Math.max(0, Number(p.openLegs || 0) - 1);
    p.byRiskReward[key].open = Math.max(0, Number(p.byRiskReward[key].open || 0) - 1);
    if (resultR == null) {
      p.ambiguousLegs++;
      p.byRiskReward[key].ambiguous++;
      return;
    }
    p.scoredLegs++;
    p.netR += resultR;
    p.byRiskReward[key].netR += resultR;
    if (resultR > 0) p.wins++;
    else if (resultR < 0) p.losses++;
    else p.breakeven++;
  }

  candleCloseMs(candle, intervalMs) {
    return Number.isFinite(candle?.closeTime) ? Number(candle.closeTime) : Number(candle?.t) + intervalMs - 1;
  }

  async expirePending(candidate, candle, reason) {
    const observedAt = iso(this.now());
    const closeMs = this.candleCloseMs(candle, candidate.intervalMs);
    candidate.status = reason;
    candidate.entryValidation = reason;
    candidate.expiredAt = observedAt;
    candidate.expiryCandleOpenAt = iso(candle.t);
    candidate.expiryCandleCloseAt = iso(closeMs);
    candidate.expiryObservedAt = observedAt;
    delete this.state.pendingCandidates[candidate.candidateId];
    this.state.recentExpiredCandidates.unshift(candidate);
    if (this.state.recentExpiredCandidates.length > this.recentExpiredLimit) this.state.recentExpiredCandidates.length = this.recentExpiredLimit;
    this.state.performance.entryExpired = Number(this.state.performance.entryExpired || 0) + 1;
    this.state.cycle.entryExpired++;
    await this.appendEvent('CANDIDATE_ENTRY_EXPIRED', {
      candidateId: candidate.candidateId,
      evidenceClusterId: candidate.evidenceClusterId,
      reason,
      candleOpenAt: iso(candle.t),
      candleCloseAt: iso(closeMs),
      entryZoneLow: candidate.entryZoneLow,
      entryZoneHigh: candidate.entryZoneHigh,
      observedClose: candle.c,
    });
  }

  async activatePending(candidate, candle) {
    const closeMs = this.candleCloseMs(candle, candidate.intervalMs);
    const paperEntryAt = iso(closeMs);
    const entryObservedAt = iso(this.now());
    const entry = roundMarketPrice(candle.c);
    const stop = roundMarketPrice(candidate.plannedInitialStop);
    const long = candidate.direction === 'LONG';
    const validSide = Number.isFinite(entry) && Number.isFinite(stop) && (long ? stop < entry : stop > entry);
    if (!validSide) {
      await this.expirePending(candidate, candle, 'ENTRY_STOP_INVALID_AT_FORWARD_ENTRY');
      return null;
    }
    const riskDistance = roundMarketPrice(Math.abs(entry - stop));
    if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
      await this.expirePending(candidate, candle, 'ENTRY_RISK_DISTANCE_INVALID_AT_FORWARD_ENTRY');
      return null;
    }
    const targets = [1, 2, 5].map(rr => ({ rr, target: roundMarketPrice(long ? entry + riskDistance * rr : entry - riskDistance * rr) }));
    candidate.paperEntryAt = paperEntryAt;
    candidate.openedAt = paperEntryAt;
    candidate.entryObservedAt = entryObservedAt;
    candidate.entry = entry;
    candidate.initialStop = stop;
    candidate.riskDistance = riskDistance;
    candidate.entryValidation = 'FIRST_FULLY_POST_NOMINATION_CLOSED_CANDLE_CLOSE_INSIDE_ENTRY_ZONE';
    candidate.status = 'OPEN_PAPER';
    candidate.entryCandleOpenAt = iso(candle.t);
    candidate.entryCandleCloseAt = paperEntryAt;
    candidate.firstEligibleLifecycleCandleOpenAt = iso(candle.t + candidate.intervalMs);
    candidate.lastProcessedCandleOpenAt = iso(candle.t);
    candidate.lastProcessedCandleCloseAt = paperEntryAt;
    candidate.lastProcessedObservedAt = entryObservedAt;
    candidate.legs = targets.map(t => ({
      legId: `${candidate.candidateId}-R${t.rr}`,
      rr: t.rr,
      target: t.target,
      currentStop: stop,
      stopStage: 'INITIAL',
      status: 'OPEN',
      openedAt: paperEntryAt,
      openedObservedAt: entryObservedAt,
      closedAt: null,
      closedObservedAt: null,
      closeReason: null,
      exitPrice: null,
      resultR: null,
      lastManagementAt: null,
      lastManagementObservedAt: null,
      exitCandleOpenAt: null,
      exitCandleCloseAt: null,
    }));
    delete this.state.pendingCandidates[candidate.candidateId];
    this.state.openCandidates[candidate.candidateId] = candidate;
    const p = this.state.performance;
    p.totalCandidates++;
    p.totalOpened++;
    p.activeCandidates++;
    p.totalLegs += candidate.legs.length;
    p.openLegs += candidate.legs.length;
    for (const leg of candidate.legs) {
      const key = `R${leg.rr}`;
      p.byRiskReward[key].opened++;
      p.byRiskReward[key].open++;
    }
    this.state.cycle.entriesOpened++;
    await this.appendEvent('CANDIDATE_FORWARD_ENTRY_OPENED', {
      candidateId: candidate.candidateId,
      hypothesisId: candidate.hypothesisId,
      evidenceClusterId: candidate.evidenceClusterId,
      symbol: candidate.symbol,
      timeframe: candidate.timeframe,
      family: candidate.family,
      direction: candidate.direction,
      nominatedAt: candidate.nominatedAt,
      entryCandleOpenAt: candidate.entryCandleOpenAt,
      entryCandleCloseAt: candidate.entryCandleCloseAt,
      paperEntryAt,
      entry,
      initialStop: stop,
      targets,
    });
    return candidate;
  }

  async processPendingForFrame(symbolKey, timeframe, candles) {
    const intervalMs = this.config.cryptoFrames.find(f => f.key === timeframe)?.intervalMs || 300000;
    const rows = (Array.isArray(candles) ? candles : [])
      .map(row => normalizeCandle(row, intervalMs))
      .filter(c => validOhlc(c) && c.validForSignals !== false)
      .sort((a, b) => a.t - b.t);
    let changed = false;
    const pending = Object.values(this.state.pendingCandidates).filter(c => c.symbolKey === symbolKey && c.timeframe === timeframe && c.status === 'PENDING_FORWARD_ENTRY');
    for (const candidate of pending) {
      const nominatedMs = Date.parse(candidate.nominatedAt || candidate.createdAt || '');
      const entryCandle = rows.find(c => Number.isFinite(nominatedMs) && c.t >= nominatedMs && c.t > candidate.signalCandleOpenTime);
      if (!entryCandle) continue;
      const inside = entryCandle.c >= candidate.entryZoneLow && entryCandle.c <= candidate.entryZoneHigh;
      if (!inside) await this.expirePending(candidate, entryCandle, 'ENTRY_ZONE_EXPIRED_BEFORE_FORWARD_ENTRY');
      else await this.activatePending(candidate, entryCandle);
      changed = true;
    }
    return changed;
  }

  async closeLeg(candidate, leg, candle, type, payload = {}) {
    const candleCloseMs = this.candleCloseMs(candle, candidate.intervalMs);
    const observedAt = iso(this.now());
    leg.closedAt = iso(candleCloseMs);
    leg.closedObservedAt = observedAt;
    leg.exitCandleOpenAt = iso(candle.t);
    leg.exitCandleCloseAt = iso(candleCloseMs);
    await this.appendEvent(type, {
      candidateId: candidate.candidateId,
      legId: leg.legId,
      rr: leg.rr,
      evidenceClusterId: candidate.evidenceClusterId,
      candleOpenAt: iso(candle.t),
      candleCloseAt: iso(candleCloseMs),
      ...payload,
    });
  }

  async processOpenForFrame(symbolKey, timeframe, candles) {
    const intervalMs = this.config.cryptoFrames.find(f => f.key === timeframe)?.intervalMs || 300000;
    const rows = (Array.isArray(candles) ? candles : [])
      .map(row => normalizeCandle(row, intervalMs))
      .filter(c => validOhlc(c) && c.validForSignals !== false)
      .sort((a, b) => a.t - b.t);
    let changed = false;
    const candidates = Object.values(this.state.openCandidates).filter(c => c.symbolKey === symbolKey && c.timeframe === timeframe && c.status === 'OPEN_PAPER');
    for (const candidate of candidates) {
      const lastProcessedClose = Date.parse(candidate.lastProcessedCandleCloseAt || candidate.paperEntryAt || '');
      const firstLifecycleOpen = Date.parse(candidate.firstEligibleLifecycleCandleOpenAt || '');
      const newRows = rows.filter(c => {
        const closeMs = this.candleCloseMs(c, intervalMs);
        return Number.isFinite(firstLifecycleOpen) && c.t >= firstLifecycleOpen && (!Number.isFinite(lastProcessedClose) || closeMs > lastProcessedClose);
      });
      for (const candle of newRows) {
        const candleCloseMs = this.candleCloseMs(candle, intervalMs);
        for (const leg of candidate.legs.filter(l => l.status === 'OPEN')) {
          const long = candidate.direction === 'LONG';
          const stopTouched = long ? candle.l <= leg.currentStop : candle.h >= leg.currentStop;
          const targetTouched = long ? candle.h >= leg.target : candle.l <= leg.target;
          if (stopTouched && targetTouched) {
            leg.status = 'AMBIGUOUS_BOTH_TOUCHED';
            leg.closeReason = 'AMBIGUOUS_BOTH_STOP_AND_TARGET_TOUCHED';
            leg.exitPrice = null;
            leg.resultR = null;
            this.recordLegResult(leg, null);
            await this.closeLeg(candidate, leg, candle, 'LEG_CLOSED_AMBIGUOUS', { stop: leg.currentStop, target: leg.target });
            changed = true;
            continue;
          }
          if (targetTouched) {
            leg.status = 'TARGET_HIT';
            leg.closeReason = 'TARGET_HIT';
            leg.exitPrice = leg.target;
            leg.resultR = leg.rr;
            this.recordLegResult(leg, leg.resultR);
            this.state.performance.targetHits++;
            this.state.performance.byRiskReward[`R${leg.rr}`].targetHits++;
            await this.closeLeg(candidate, leg, candle, 'LEG_TARGET_HIT', { exitPrice: leg.target, resultR: leg.resultR });
            changed = true;
            continue;
          }
          if (stopTouched) {
            leg.status = 'STOP_HIT';
            leg.closeReason = `STOP_HIT_${leg.stopStage}`;
            leg.exitPrice = leg.currentStop;
            leg.resultR = long ? (leg.currentStop - candidate.entry) / candidate.riskDistance : (candidate.entry - leg.currentStop) / candidate.riskDistance;
            leg.resultR = Number(leg.resultR.toFixed(6));
            this.recordLegResult(leg, leg.resultR);
            this.state.performance.stopHits++;
            this.state.performance.byRiskReward[`R${leg.rr}`].stopHits++;
            await this.closeLeg(candidate, leg, candle, 'LEG_STOP_HIT', { stopStage: leg.stopStage, exitPrice: leg.currentStop, resultR: leg.resultR });
            changed = true;
            continue;
          }
          const favorable = long ? candle.h - candidate.entry : candidate.entry - candle.l;
          const targetDistance = Math.abs(leg.target - candidate.entry);
          const progress = targetDistance > 0 ? favorable / targetDistance : 0;
          let newStop = null;
          let newStage = null;
          if (progress >= 0.75) {
            newStop = long ? candidate.entry + targetDistance * 0.5 : candidate.entry - targetDistance * 0.5;
            newStage = 'HALF_TARGET_LOCK';
          } else if (progress >= 0.5) {
            newStop = candidate.entry;
            newStage = 'BREAKEVEN';
          }
          const improves = newStop != null && (long ? newStop > leg.currentStop : newStop < leg.currentStop);
          if (improves) {
            leg.currentStop = roundMarketPrice(newStop);
            leg.stopStage = newStage;
            leg.lastManagementAt = iso(candleCloseMs);
            leg.lastManagementObservedAt = iso(this.now());
            await this.appendEvent(newStage === 'BREAKEVEN' ? 'STOP_MOVED_TO_BREAKEVEN' : 'STOP_MOVED_TO_HALF_TARGET', {
              candidateId: candidate.candidateId,
              legId: leg.legId,
              rr: leg.rr,
              evidenceClusterId: candidate.evidenceClusterId,
              candleOpenAt: iso(candle.t),
              candleCloseAt: iso(candleCloseMs),
              newStop: leg.currentStop,
              progress: Number(progress.toFixed(6)),
            });
            changed = true;
          }
        }
        candidate.lastProcessedCandleOpenAt = iso(candle.t);
        candidate.lastProcessedCandleCloseAt = iso(candleCloseMs);
        candidate.lastProcessedObservedAt = iso(this.now());
      }
      if (candidate.legs.every(leg => leg.status !== 'OPEN')) {
        candidate.status = 'CLOSED_PAPER';
        const latestClose = candidate.legs.map(l => Date.parse(l.closedAt || '')).filter(Number.isFinite).sort((a, b) => b - a)[0];
        candidate.closedAt = Number.isFinite(latestClose) ? iso(latestClose) : iso(this.now());
        candidate.closedObservedAt = iso(this.now());
        delete this.state.openCandidates[candidate.candidateId];
        this.state.recentClosedCandidates.unshift(candidate);
        if (this.state.recentClosedCandidates.length > this.config.crypto.candidateRecentClosedLimit) this.state.recentClosedCandidates.length = this.config.crypto.candidateRecentClosedLimit;
        this.state.performance.activeCandidates = Math.max(0, this.state.performance.activeCandidates - 1);
        this.state.performance.closedCandidates++;
        await this.appendEvent('CANDIDATE_CLOSED', {
          candidateId: candidate.candidateId,
          evidenceClusterId: candidate.evidenceClusterId,
          symbol: candidate.symbol,
          timeframe: candidate.timeframe,
          family: candidate.family,
          closedAt: candidate.closedAt,
          legs: candidate.legs.map(l => ({ rr: l.rr, status: l.status, resultR: l.resultR })),
        });
        changed = true;
      }
    }
    return changed;
  }

  registerTemporalViolation(code, details = {}) {
    const observedAt = iso(this.now());
    this.state.temporalIntegrity.status = 'FAIL';
    this.state.temporalIntegrity.violations = Number(this.state.temporalIntegrity.violations || 0) + 1;
    this.state.temporalIntegrity.lastViolationAt = observedAt;
    this.state.temporalIntegrity.lastViolation = { code, observedAt, ...details };
    this.state.cycle.temporalViolations = Number(this.state.cycle.temporalViolations || 0) + 1;
  }

  validateTemporalIntegrity() {
    if (!this.state) return { status: 'NOT_LOADED', violations: 0 };
    const failures = [];
    const candidates = [
      ...Object.values(this.state.pendingCandidates || {}),
      ...Object.values(this.state.openCandidates || {}),
      ...(this.state.recentClosedCandidates || []),
    ];
    for (const candidate of candidates) {
      const created = Date.parse(candidate.createdAt || candidate.nominatedAt || '');
      const entry = Date.parse(candidate.paperEntryAt || '');
      const entryOpen = Date.parse(candidate.entryCandleOpenAt || '');
      if (candidate.status !== 'PENDING_FORWARD_ENTRY') {
        if (!Number.isFinite(created) || !Number.isFinite(entry) || entry < created) failures.push({ code: 'PAPER_ENTRY_BEFORE_CREATION', candidateId: candidate.candidateId });
        if (!Number.isFinite(entryOpen) || !Number.isFinite(created) || entryOpen < created) failures.push({ code: 'ENTRY_CANDLE_OPENED_BEFORE_NOMINATION', candidateId: candidate.candidateId });
      }
      for (const leg of candidate.legs || []) {
        const opened = Date.parse(leg.openedAt || '');
        const closed = Date.parse(leg.closedAt || '');
        const managed = Date.parse(leg.lastManagementAt || '');
        if (Number.isFinite(opened) && Number.isFinite(created) && opened < created) failures.push({ code: 'LEG_OPENED_BEFORE_CREATION', candidateId: candidate.candidateId, legId: leg.legId });
        if (Number.isFinite(closed) && Number.isFinite(opened) && closed < opened) failures.push({ code: 'LEG_CLOSED_BEFORE_OPEN', candidateId: candidate.candidateId, legId: leg.legId });
        if (Number.isFinite(managed) && Number.isFinite(opened) && managed < opened) failures.push({ code: 'STOP_MANAGED_BEFORE_OPEN', candidateId: candidate.candidateId, legId: leg.legId });
      }
    }
    if (failures.length) {
      const first = failures[0];
      const existing = this.state.temporalIntegrity.lastViolation;
      if (!existing || existing.code !== first.code || existing.candidateId !== first.candidateId || existing.legId !== first.legId) this.registerTemporalViolation(first.code, first);
      return { status: 'FAIL', violations: failures.length, first };
    }
    this.state.temporalIntegrity.status = 'PASS';
    return { status: 'PASS', violations: 0 };
  }

  async evaluateFrame({ symbol, frame, candles, audit, frameState }) {
    if (!this.state) throw new Error('CANDIDATE_ENGINE_NOT_LOADED');
    const key = `${symbol.key}:${frame.key}`;
    this.state.cycle.framesEvaluated++;
    this.state.cycle.hypothesesEvaluated += CRYPTO_HYPOTHESIS_FAMILIES.length;
    let changed = await this.processPendingForFrame(symbol.key, frame.key, candles);
    changed = (await this.processOpenForFrame(symbol.key, frame.key, candles)) || changed;

    const signalCandles = (Array.isArray(candles) ? candles : []).map(row => normalizeCandle(row, frame.intervalMs)).filter(c => validOhlc(c) && c.validForSignals !== false);
    const latest = signalCandles.at(-1);
    const cleanData = Number(frameState.cleanRows || 0) > 0 && !frameState.stale;
    const continuityPassed = audit.continuityPassed === true;
    const results = {};
    if (!latest || !cleanData || !continuityPassed) {
      const reason = !latest ? 'NO_SIGNAL_CANDLES' : !cleanData ? 'CLEAN_DATA_GATE_FAILED' : 'CONTINUITY_GATE_FAILED';
      for (const family of CRYPTO_HYPOTHESIS_FAMILIES) results[family] = this.candidateResultBase(reason);
      if (changed) await this.persist();
      return results;
    }

    const priorFrameAt = Date.parse(this.state.lastEvaluatedCandleByFrame[key] || '');
    const newCandle = !Number.isFinite(priorFrameAt) || latest.t > priorFrameAt;
    const candidateEpochMs = Date.parse(this.state.candidateEngineEpochAt || '');
    for (const family of CRYPTO_HYPOTHESIS_FAMILIES) {
      if (!newCandle) {
        results[family] = this.candidateResultBase('NO_NEW_CLOSED_CANDLE_SINCE_LAST_EVALUATION');
        continue;
      }
      const setup = deriveCryptoCandidateSetup({ family, candles: signalCandles, symbol, frame, epochMs: candidateEpochMs });
      if (!setup.produced) {
        results[family] = this.candidateResultBase(setup.reason);
        continue;
      }
      const prior = this.state.lastSetupByHypothesis[setup.hypothesisId];
      const duplicate = prior && prior.signature === setup.signature;
      if (duplicate) {
        this.state.cycle.duplicatesBlocked++;
        results[family] = { ...this.candidateResultBase('DUPLICATE_SETUP_BLOCKED'), duplicateSignal: true, entryStopTargetValid: true, direction: setup.direction };
        continue;
      }
      const nomination = await this.nominateCandidate(setup);
      changed = true;
      results[family] = {
        candidateProduced: true,
        nominationProduced: true,
        entryOpened: false,
        duplicateSignal: false,
        entryStopTargetValid: true,
        forwardShadowEligible: true,
        blockedReason: 'AWAITING_FIRST_FULLY_POST_NOMINATION_CLOSED_CANDLE',
        candidateId: nomination.candidateId,
        direction: nomination.direction,
        entry: nomination.referenceEntry,
        stop: nomination.plannedInitialStop,
        targets: nomination.plannedTargets,
      };
    }
    if (newCandle) {
      this.state.lastEvaluatedCandleByFrame[key] = iso(latest.t);
      changed = true;
    }
    signalCandles.length = 0;
    if (changed) {
      this.state.lastEvaluatedAt = iso(this.now());
      await this.persist();
    }
    return results;
  }

  async completeCycle() {
    this.state.cycle.completedAt = iso(this.now());
    this.state.lastEvaluatedAt = this.state.cycle.completedAt;
    this.validateTemporalIntegrity();
    await this.persist();
    return this.view();
  }

  view() {
    const pending = Object.values(this.state?.pendingCandidates || {});
    const open = Object.values(this.state?.openCandidates || {});
    return {
      schema: this.state?.schema || 'alps.gen2.cryptoForwardShadowCandidateEngine.v12051',
      version: CANDIDATE_ENGINE_VERSION,
      foundationEpochAt: this.state?.foundationEpochAt || null,
      candidateEngineEpochAt: this.state?.candidateEngineEpochAt || null,
      epochAt: this.state?.candidateEngineEpochAt || null,
      evidenceClass: 'CERTIFIED_FORWARD_V12051',
      mode: 'PAPER_FORWARD_SHADOW',
      status: this.state?.status || 'INITIALIZING',
      candidateEngineEnabled: true,
      paperExecutionEnabled: true,
      executionEnabled: false,
      liveCapitalExecution: false,
      promotionEnabled: false,
      setupPolicy: this.state?.setupPolicy || {},
      riskPolicy: this.state?.riskPolicy || {},
      provisionalV1205Ledger: this.state?.provisionalV1205Ledger || null,
      temporalIntegrity: this.state?.temporalIntegrity || null,
      lastEvaluatedAt: this.state?.lastEvaluatedAt || null,
      lastLedgerEventAt: this.state?.lastLedgerEventAt || null,
      pendingCandidateCount: pending.length,
      pendingCandidates: pending,
      openCandidateCount: open.length,
      openCandidates: open,
      recentClosedCandidates: this.state?.recentClosedCandidates || [],
      recentExpiredCandidates: this.state?.recentExpiredCandidates || [],
      performance: this.state ? this.performanceView() : emptyCandidatePerformance(),
      cycle: this.state?.cycle || {},
      lastError: this.state?.lastError || this.lastError,
    };
  }

  summaryView() {
    const view = this.view();
    return {
      schema: view.schema,
      version: view.version,
      foundationEpochAt: view.foundationEpochAt,
      candidateEngineEpochAt: view.candidateEngineEpochAt,
      epochAt: view.epochAt,
      evidenceClass: view.evidenceClass,
      mode: view.mode,
      status: view.status,
      candidateEngineEnabled: true,
      paperExecutionEnabled: true,
      executionEnabled: false,
      liveCapitalExecution: false,
      promotionEnabled: false,
      lastEvaluatedAt: view.lastEvaluatedAt,
      lastLedgerEventAt: view.lastLedgerEventAt,
      pendingCandidateCount: view.pendingCandidateCount,
      openCandidateCount: view.openCandidateCount,
      performance: view.performance,
      cycle: view.cycle,
      riskPolicy: view.riskPolicy,
      setupPolicy: view.setupPolicy,
      provisionalV1205Ledger: view.provisionalV1205Ledger,
      temporalIntegrity: view.temporalIntegrity,
      lastError: view.lastError,
    };
  }

  async ledgerTail(limit = 200) {
    return this.storage.readNdjsonTail(this.activeLedgerFile, Math.max(1, Math.min(1000, Number(limit) || 200)));
  }
}

function buildCryptoFrameEvidence({config,symbol,frame,candles,audit,frameState,foundationFrame,epochMs,generatedAt,candidateResults={}}){
  const signalCandles=[];let freshCount=0;let latestNew=null;const lastObservedMs=Date.parse(foundationFrame?.lastObservedCandleAt||'');const threshold=Number.isFinite(lastObservedMs)?lastObservedMs:-Infinity;
  for(const row of Array.isArray(candles)?candles:[]){const c=normalizeCandle(row,frame.intervalMs);if(!validOhlc(c)||c.validForSignals===false)continue;signalCandles.push(c);const closeAt=Number.isFinite(c.closeTime)?c.closeTime:c.t+frame.intervalMs-1;if(Number.isFinite(epochMs)&&closeAt>epochMs&&c.t>threshold){freshCount++;latestNew=c;}}
  const observationCount=Number(foundationFrame?.observationCount||0)+freshCount;const cleanData=Number(frameState.cleanRows||0)>0&&!frameState.stale;const continuityPassed=audit.continuityPassed===true;const freshClosedCandle=observationCount>0;
  const produced=Object.values(candidateResults).filter(result=>result?.candidateProduced===true);const eligibleCount=produced.length;
  const forwardFrame={symbol:symbol.canonical,symbolKey:symbol.key,timeframe:frame.key,observationCount,lastObservedCandleAt:latestNew?iso(latestNew.t):foundationFrame?.lastObservedCandleAt||null,cleanData,continuityPassed,freshClosedCandle,duplicateSignal:Object.values(candidateResults).some(result=>result?.duplicateSignal===true),entryStopTargetValid:produced.every(result=>result.entryStopTargetValid===true),candidateProduced:eligibleCount>0,candidateCount:eligibleCount,candidateIds:produced.map(result=>result.candidateId),lastCandidateAt:eligibleCount?generatedAt:foundationFrame?.lastCandidateAt||null,forwardShadowEligible:eligibleCount,status:cleanData&&continuityPassed&&freshClosedCandle?'PAPER_CANDIDATE_ENGINE_ACTIVE':'COLLECTING_POST_DEPLOY_CLOSED_CANDLES',blockedReason:eligibleCount?null:'NO_ELIGIBLE_FAMILY_SIGNAL_ON_LATEST_CLOSED_CANDLE'};
  const metricsByFamily=cryptoFamilyMetricsAll(signalCandles);const hypotheses=[];
  for(const family of CRYPTO_HYPOTHESIS_FAMILIES){const metrics=metricsByFamily[family];const result=candidateResults[family]||{};const gates={cleanData:metrics.samples>=500,continuityPassed,freshClosedCandle,duplicateSignal:result.duplicateSignal===true,entryStopTargetValid:result.entryStopTargetValid===true,candidateProduced:result.candidateProduced===true};const eligible=gates.cleanData&&gates.continuityPassed&&gates.freshClosedCandle&&!gates.duplicateSignal&&gates.entryStopTargetValid&&gates.candidateProduced;hypotheses.push({id:`CRYPTO-${symbol.key}-${frame.key}-${family}`,scope:'SYMBOL_TIMEFRAME',family,symbol:symbol.canonical,timeframe:frame.key,dataMode:'CRYPTO_PRICE_ONLY',modelWindowBars:Math.min(12000,signalCandles.length),metrics,evidenceStatus:!gates.cleanData?'INSUFFICIENT_CLEAN_SAMPLE':!gates.continuityPassed?'CONTINUITY_AUDIT_FAILED':'POST_CLEAN_CONTINUITY_AUDITED_PRICE_EVIDENCE',promotionStatus:eligible?'PAPER_FORWARD_SHADOW_CANDIDATE_ACTIVE':gates.continuityPassed?'RESEARCH_ONLY_CONTINUITY_AUDITED':'BLOCKED_CONTINUITY_GAP',forwardGates:gates,forwardShadowEligible:eligible,forwardBlockedReason:eligible?null:(result.blockedReason||(!gates.cleanData?'CLEAN_DATA_GATE_FAILED':!gates.continuityPassed?'CONTINUITY_GATE_FAILED':!gates.freshClosedCandle?'NO_POST_EPOCH_CLOSED_CANDLE':'NO_ELIGIBLE_CANDIDATE')),candidateId:result.candidateId||null,direction:result.direction||null,paperOnly:true,paperExecutionEnabled:true,liveCapitalExecution:false,generatedAt});}
  signalCandles.length=0;return{forwardFrame,hypotheses,observationCount,cleanData,continuityPassed,freshClosedCandle,eligibleCount};
}

class CryptoEngine {
  constructor({config,storage,now=()=>Date.now(),log=console.log,memory=null}) {
    this.config=config;
    this.storage=storage;
    this.now=now;
    this.log=log;
    this.memory=memory||new MemoryTracker({now,log});
    this.provider=new BinanceMarketDataProvider({config,storage,now});
    this.state={
      schema:'alps.gen2.cryptoCoreState.v1206',version:VERSION,startedAt:null,generatedAt:iso(),status:'CREATED',workerOnline:false,frames:{},
      lastRefreshStartedAt:null,lastRefreshCompletedAt:null,nextRefreshAt:null,lastCleanRebuildAt:null,refreshSequence:0,providerCallsThisRun:0,lastError:null,
      lastRefreshSummary:null,canonicalTimeframe:'5m',derivedTimeframes:['15m','30m','1h','4h'],directProviderFrames:['5m'],
    };
    this.hypotheses=null;
    this.migration=null;
    this.continuity=null;
    this.forwardShadow=null;
    this.historicalEvidence=null;
    this.candidateEngine=new CryptoForwardShadowCandidateEngine({config,storage,now,log});
    this.scoringPersistQueue=new PersistenceQueue({storage,log});
    this.evidenceScorer=new EvidenceStatisticalScoringEngine({config,storage,persistQueue:this.scoringPersistQueue,now,log});
    this.running=false;
    this.inFlight=false;
    this.backfillInFlight=false;
    this.lastBackfillSummary=null;
    this.timer=null;
    this.backgroundBackfillStarted=false;
  }
  frameKey(symbol,frame){return`${symbol.key}:${frame.key}`;}
  baseFrame(){return this.config.cryptoFrames.find(frame=>frame.key==='5m')||this.config.cryptoFrames[0];}
  derivedFrames(){const base=this.baseFrame();return this.config.cryptoFrames.filter(frame=>frame.key!==base.key);}
  async init(){
    await this.memory.checkpoint('CRYPTO_STARTUP_PROVIDER_LOAD');
    await this.provider.load();
    this.state.startedAt=iso(this.now());this.state.status='INITIALIZING';
    this.migration=await importCryptoReadonly({config:this.config,storage:this.storage,log:this.log}).catch(e=>({status:'FAILED',error:String(e.message||e),readOnly:true,v11Writes:0}));
    this.historicalEvidence=await catalogLegacyCryptoPaperEvidence({config:this.config,storage:this.storage,log:this.log}).catch(e=>({schema:'alps.gen2.legacyCryptoPaperEvidence.v12043',status:'FAILED',error:String(e.message||e),readOnly:true,v11Writes:0,replayed:false}));
    this.forwardShadow=await loadForwardShadowFoundation(this.config,this.storage,this.now);
    await this.candidateEngine.load(this.forwardShadow.epochAt);
    await this.evidenceScorer.init();
    // The previous startup canonical rebuild was duplicated by refreshAll. Keep the
    // single post-refresh rebuild only; existing clean files remain available to the
    // live preflight and first-time imports already write their clean copies.
    await this.refreshAll('startup-live-first');
    this.state.workerOnline=true;this.state.status=this.provider.isBlocked()?'PROVIDER_COOLDOWN_ACTIVE':'ONLINE';
    await this.persist();await this.memory.checkpoint('CRYPTO_STARTUP_COMPLETE');
  }
  startBackgroundBackfill(){
    if(this.backgroundBackfillStarted)return;this.backgroundBackfillStarted=true;
    const timer=setTimeout(()=>{this.backfillIncomplete('startup-background').then(summary=>{this.lastBackfillSummary=summary;}).catch(error=>{this.state.lastError=String(error&&error.stack||error).slice(0,1200);this.log('[v12.0.6] background crypto backfill failed',this.state.lastError);}).finally(()=>this.persist().catch(()=>{}));},60_000);timer.unref?.();
  }
  async cleanAndRebuild(reason='manual') {
    if(!this.candidateEngine.state)await this.candidateEngine.load(this.forwardShadow?.epochAt||iso(this.now()));
    const continuityFrames={};const hypothesisRows=[];const forwardFrames={...((this.forwardShadow&&this.forwardShadow.frames)||{})};
    const base=this.baseFrame();const generatedAt=iso(this.now());const epochMs=Date.parse(this.forwardShadow?.epochAt||this.candidateEngine?.state?.epochAt||'');
    let continuityPassedHypotheses=0,forwardObservationReady=0,forwardShadowEligible=0,observedClosedCandles=0,framesWithPostDeployObservation=0,continuityPassedFrames=0,cleanFrames=0;
    this.candidateEngine.beginCycle(reason);
    const evaluateCandidates=async args=>{try{return await this.candidateEngine.evaluateFrame(args);}catch(error){const message=String(error&&error.stack||error).slice(0,1200);this.candidateEngine.lastError=message;if(this.candidateEngine.state)this.candidateEngine.state.lastError=message;this.log('[v12.0.6] paper candidate evaluation failed',message);return Object.fromEntries(CRYPTO_HYPOTHESIS_FAMILIES.map(family=>[family,{candidateProduced:false,duplicateSignal:false,entryStopTargetValid:false,forwardShadowEligible:false,blockedReason:'CANDIDATE_ENGINE_ERROR',candidateId:null,direction:null}]));}};
    const processEvidence=(symbol,frame,candles,audit,key,candidateResults)=>{const evidence=buildCryptoFrameEvidence({config:this.config,symbol,frame,candles,audit,frameState:this.state.frames[key],foundationFrame:forwardFrames[key]||{},epochMs,generatedAt,candidateResults});forwardFrames[key]=evidence.forwardFrame;hypothesisRows.push(...evidence.hypotheses);observedClosedCandles+=evidence.observationCount;if(evidence.freshClosedCandle)framesWithPostDeployObservation++;if(evidence.continuityPassed)continuityPassedFrames++;if(evidence.cleanData)cleanFrames++;forwardShadowEligible+=evidence.eligibleCount;for(const h of evidence.hypotheses){if(h.forwardGates.continuityPassed)continuityPassedHypotheses++;if(h.forwardGates.cleanData&&h.forwardGates.continuityPassed&&h.forwardGates.freshClosedCandle)forwardObservationReady++;}};
    for(const symbol of this.config.cryptoSymbols) {
      await this.memory.checkpoint('CRYPTO_REBUILD_5M_READ',symbol.canonical,base.key);
      const baseKey=this.frameKey(symbol,base);const raw5m=await this.storage.readCrypto(this.config.crypto.rawDir,symbol.key,base.key);const raw5mRows=raw5m.length;
      const clean5m=cleanCandles(raw5m,{now:this.now(),intervalMs:base.intervalMs,closeBufferMs:this.config.crypto.candleCloseBufferMs,staleMs:base.intervalMs*this.config.crypto.staleMultiplier,assetClass:'CRYPTO',removeFlat:true,preserveFlatForAggregation:true});raw5m.length=0;
      const baseAudit=auditContinuity(clean5m.candles,base.intervalMs,{maxGapRanges:this.config.crypto.continuityMaxGapRanges});continuityFrames[baseKey]={symbol:symbol.canonical,symbolKey:symbol.key,timeframe:base.key,intervalMs:base.intervalMs,...baseAudit};
      await this.storage.writeCrypto(this.config.crypto.cleanDir,symbol.key,base.key,clean5m.candles,{source:'V12_0_5_CANONICAL_5M_PAPER_FORWARD',reason,quality:clean5m.quality,continuity:baseAudit,flatPolicy:'PRESERVE_FOR_AGGREGATION_EXCLUDE_FROM_SIGNALS'});
      const oldBase=this.state.frames[baseKey]||{};const baseComplete=clean5m.quality.coverageDays>=this.config.crypto.backfillCoverageDays&&baseAudit.continuityPassed;
      this.state.frames[baseKey]={...oldBase,symbol:symbol.canonical,symbolKey:symbol.key,timeframe:base.key,intervalMs:base.intervalMs,enabled:true,assetClass:'CRYPTO',source:'CANONICAL_5M_MERGED_HISTORY',canonicalAuthority:true,providerCallsRequired:true,rawRows:raw5mRows,cleanRows:clean5m.candles.length,signalEligibleRows:clean5m.quality.signalEligible,aggregationEligibleRows:clean5m.quality.aggregationEligible,coverageDays:clean5m.quality.coverageDays,historicalComplete:baseComplete,backfillEnabled:clean5m.quality.coverageDays<this.config.crypto.backfillCoverageDays,historyStatus:baseComplete?'COMPLETE_CANONICAL_5M_CONTINUITY_VERIFIED':baseAudit.continuityPassed?'CANONICAL_5M_HISTORY_BUILDING':'CANONICAL_5M_CONTINUITY_GAP',latestAt:clean5m.quality.latestAt,stale:clean5m.quality.stale,quality:clean5m.quality,continuity:baseAudit};
      const baseCandidateResults=await evaluateCandidates({symbol,frame:base,candles:clean5m.candles,audit:baseAudit,frameState:this.state.frames[baseKey],epochMs});
      processEvidence(symbol,base,clean5m.candles,baseAudit,baseKey,baseCandidateResults);
      for(const frame of this.derivedFrames()) {
        await this.memory.checkpoint('CRYPTO_REBUILD_DERIVE',symbol.canonical,frame.key);
        const key=this.frameKey(symbol,frame);const derivedRaw=aggregateCanonicalCandles(clean5m.candles,base.intervalMs,frame.intervalMs);const rawRows=derivedRaw.length;
        const cleaned=cleanCandles(derivedRaw,{now:this.now(),intervalMs:frame.intervalMs,closeBufferMs:this.config.crypto.candleCloseBufferMs,staleMs:frame.intervalMs*this.config.crypto.staleMultiplier,assetClass:'CRYPTO',removeFlat:true,preserveFlatForAggregation:true});
        const audit=auditContinuity(cleaned.candles,frame.intervalMs,{maxGapRanges:this.config.crypto.continuityMaxGapRanges});continuityFrames[key]={symbol:symbol.canonical,symbolKey:symbol.key,timeframe:frame.key,intervalMs:frame.intervalMs,...audit};
        await this.storage.writeCrypto(this.config.crypto.rawDir,symbol.key,frame.key,derivedRaw,{source:'DERIVED_FROM_CANONICAL_5M_CLOSED',canonicalSourceTimeframe:'5m',reason,flatSourcePolicy:'VALID_FOR_AGGREGATION_NOT_DIRECT_5M_SIGNALS'});
        await this.storage.writeCrypto(this.config.crypto.cleanDir,symbol.key,frame.key,cleaned.candles,{source:'V12_0_5_MEMORY_BOUNDED_LOCAL_ROLLUP',canonicalSourceTimeframe:'5m',reason,quality:cleaned.quality,continuity:audit});
        const old=this.state.frames[key]||{};const complete=cleaned.quality.coverageDays>=this.config.crypto.backfillCoverageDays&&audit.continuityPassed;
        this.state.frames[key]={...old,symbol:symbol.canonical,symbolKey:symbol.key,timeframe:frame.key,intervalMs:frame.intervalMs,enabled:true,assetClass:'CRYPTO',source:'DERIVED_FROM_CANONICAL_5M_CLOSED',canonicalAuthority:false,canonicalSourceTimeframe:'5m',providerCallsRequired:false,rawRows,cleanRows:cleaned.candles.length,signalEligibleRows:cleaned.quality.signalEligible,aggregationEligibleRows:cleaned.quality.aggregationEligible,coverageDays:cleaned.quality.coverageDays,historicalComplete:complete,backfillEnabled:false,backfillDelegatedTo:'5m',historyStatus:complete?'COMPLETE_FROM_CANONICAL_5M_CONTINUITY_VERIFIED':audit.continuityPassed?'WAITING_FOR_CANONICAL_5M_HISTORY':'DERIVED_CONTINUITY_GAP',latestAt:cleaned.quality.latestAt,stale:cleaned.quality.stale,quality:cleaned.quality,continuity:audit,lastProviderStatus:'LOCAL_DERIVED_FROM_5M',lastProviderAttemptAt:null,lastUpdateAt:iso(this.now()),lastProviderError:null};
        const candidateResults=await evaluateCandidates({symbol,frame,candles:cleaned.candles,audit,frameState:this.state.frames[key],epochMs});
        processEvidence(symbol,frame,cleaned.candles,audit,key,candidateResults);derivedRaw.length=0;cleaned.signalCandles.length=0;cleaned.candles.length=0;await this.memory.checkpoint('CRYPTO_REBUILD_FRAME_RELEASED',symbol.canonical,frame.key);
      }
      clean5m.signalCandles.length=0;clean5m.candles.length=0;await this.memory.checkpoint('CRYPTO_REBUILD_SYMBOL_RELEASED',symbol.canonical,null);
    }
    const audits=Object.values(continuityFrames);const passed=audits.filter(a=>a.continuityPassed).length;const missingBars=audits.reduce((sum,a)=>sum+Number(a.missingBars||0),0);
    this.continuity={schema:'alps.gen2.cryptoContinuityAudit.v12043',version:VERSION,generatedAt:iso(this.now()),reason,pairFrames:audits.length,passedFrames:passed,failedFrames:audits.length-passed,totalMissingBars:missingBars,allPassed:audits.length>0&&passed===audits.length,frames:continuityFrames,rule:'Coverage alone is insufficient. Every crypto pair-frame must have zero missing bars and exact interval continuity.'};
    await this.storage.writeJsonAtomic(this.config.crypto.continuityFile,this.continuity);
    let candidateView;try{candidateView=await this.candidateEngine.completeCycle();}catch(error){const message=String(error&&error.stack||error).slice(0,1200);this.candidateEngine.lastError=message;if(this.candidateEngine.state)this.candidateEngine.state.lastError=message;candidateView=this.candidateEngine.view();this.log('[v12.0.6] paper candidate cycle persistence failed',message);}const totalFrames=this.config.cryptoSymbols.length*this.config.cryptoFrames.length;
    this.forwardShadow={...(this.forwardShadow||{}),schema:'alps.gen2.cryptoForwardShadow.v12051',version:VERSION,frames:forwardFrames,observedClosedCandles,framesWithPostDeployObservation,continuityPassedFrames,cleanFrames,forwardShadowEligible,lastEvaluatedAt:iso(this.now()),mode:'PAPER_FORWARD_SHADOW',candidateEngineEnabled:true,paperExecutionEnabled:true,executionEnabled:false,promotionEnabled:false,liveCapitalExecution:false,activationVersionRequired:null,status:framesWithPostDeployObservation===totalFrames?'CANDIDATE_ENGINE_ACTIVE_STRICT_FORWARD_PAPER_ONLY':'CANDIDATE_ENGINE_ACTIVE_COLLECTING_FRAME_EVIDENCE',candidateEngineEpochAt:candidateView.candidateEngineEpochAt,evidenceClass:'CERTIFIED_FORWARD_V12051',temporalIntegrity:candidateView.temporalIntegrity,provisionalV1205Ledger:candidateView.provisionalV1205Ledger,candidates:{pendingCandidateCount:candidateView.pendingCandidateCount,openCandidateCount:candidateView.openCandidateCount,performance:candidateView.performance,cycle:candidateView.cycle,lastLedgerEventAt:candidateView.lastLedgerEventAt},rule:'Signals must close after candidateEngineEpochAt. A nomination cannot enter until the first fully post-nomination candle closes inside the entry zone. Lifecycle candles begin only after paperEntryAt. V12.0.5 evidence is preserved as provisional and excluded from certified performance.'};
    await this.storage.writeJsonAtomic(this.config.crypto.forwardShadowFile,this.forwardShadow);
    this.evidenceScorer.schedule(`candidate-cycle-complete:${reason}`);
    this.hypotheses={schema:'alps.gen2.cryptoHypotheses.v1206',version:VERSION,generatedAt,count:hypothesisRows.length,researchOnly:hypothesisRows.length,continuityPassedHypotheses,forwardObservationReady,forwardShadowEligible,paperForwardActive:hypothesisRows.filter(row=>row.forwardShadowEligible).length,rule:'Price-only crypto paper-forward research. Closed candles, continuity audited, deterministic entry/stop/1R/2R/5R targets, no account access, no order endpoints, no live-capital execution.',hypotheses:hypothesisRows};
    await this.storage.writeJsonAtomic(this.config.crypto.hypothesesFile,this.hypotheses);this.state.lastCleanRebuildAt=iso(this.now());await this.persist();await this.memory.checkpoint('CRYPTO_REBUILD_COMPLETE');return{hypotheses:this.hypotheses,continuity:this.continuity,forwardShadow:this.forwardShadow,candidates:candidateView};
  }
  async refreshFrame(symbol,frame,{purpose='scheduled'}={}) {
    const base=this.baseFrame();
    if(frame.key!==base.key)return{ok:false,reason:'DIRECT_HIGHER_TIMEFRAME_PROVIDER_CALL_DISABLED'};
    if(this.provider.isBlocked())return{ok:false,reason:'BINANCE_PROVIDER_COOLDOWN_ACTIVE'};
    const key=this.frameKey(symbol,frame);
    const existingClean=await this.storage.readCrypto(this.config.crypto.cleanDir,symbol.key,frame.key);
    if(purpose==='scheduled'&&existingClean.length) {
      const expectedLatest=latestClosedOpenTime(this.now(),frame.intervalMs,this.config.crypto.candleCloseBufferMs);
      if(existingClean.at(-1).t>=expectedLatest)return{ok:false,reason:'ALREADY_HAVE_LATEST_CLOSED_5M'};
    }
    const endTime=purpose==='backfill'&&existingClean.length?existingClean[0].t-1:null;
    const response=await this.provider.fetchKlines(symbol.provider,frame.provider,{purpose,limit:purpose==='backfill'?this.config.crypto.backfillLimit:this.config.crypto.liveLimit,endTime});
    if(response.status)this.state.providerCallsThisRun++;
    const old=this.state.frames[key]||{symbol:symbol.canonical,symbolKey:symbol.key,timeframe:frame.key};
    old.lastProviderStatus=response.ok?`HTTP_${response.status}`:response.reason;
    old.lastProviderAttemptAt=iso(this.now());
    if(!response.ok){old.lastProviderError=response.reason;this.state.frames[key]=old;return response;}
    const incoming=response.rows.map(r=>normalizeCandle(r,frame.intervalMs)).filter(validOhlc);
    const existing=await this.storage.readCrypto(this.config.crypto.rawDir,symbol.key,frame.key);
    const merged=mergeCandles(existing,incoming,frame.intervalMs,this.config.crypto.maxCandlesPerFrame);
    const cleaned=cleanCandles(merged,{now:this.now(),intervalMs:frame.intervalMs,closeBufferMs:this.config.crypto.candleCloseBufferMs,staleMs:frame.intervalMs*this.config.crypto.staleMultiplier,assetClass:'CRYPTO',removeFlat:true,preserveFlatForAggregation:true});
    const continuity=auditContinuity(cleaned.candles,frame.intervalMs,{maxGapRanges:this.config.crypto.continuityMaxGapRanges});
    await this.storage.writeCrypto(this.config.crypto.rawDir,symbol.key,frame.key,merged,{source:'BINANCE_PUBLIC_KLINES_5M_LIVE',purpose,endpoint:'/api/v3/klines'});
    await this.storage.writeCrypto(this.config.crypto.cleanDir,symbol.key,frame.key,cleaned.candles,{source:'V12_0_4_3_CANONICAL_5M_CONTINUITY_CLEANER',purpose,quality:cleaned.quality,continuity,flatPolicy:'PRESERVE_FOR_AGGREGATION_EXCLUDE_FROM_SIGNALS'});
    const complete=cleaned.quality.coverageDays>=this.config.crypto.backfillCoverageDays&&continuity.continuityPassed;
    this.state.frames[key]={...old,symbol:symbol.canonical,symbolKey:symbol.key,timeframe:frame.key,intervalMs:frame.intervalMs,enabled:true,assetClass:'CRYPTO',source:'CANONICAL_5M_MERGED_HISTORY',canonicalAuthority:true,providerCallsRequired:true,rawRows:merged.length,cleanRows:cleaned.candles.length,signalEligibleRows:cleaned.quality.signalEligible,aggregationEligibleRows:cleaned.quality.aggregationEligible,coverageDays:cleaned.quality.coverageDays,historicalComplete:complete,backfillEnabled:cleaned.quality.coverageDays<this.config.crypto.backfillCoverageDays,historyStatus:complete?'COMPLETE_CANONICAL_5M_CONTINUITY_VERIFIED':continuity.continuityPassed?'CANONICAL_5M_HISTORY_BUILDING':'CANONICAL_5M_CONTINUITY_GAP',latestAt:cleaned.quality.latestAt,stale:cleaned.quality.stale,quality:cleaned.quality,continuity,lastUpdateAt:iso(this.now()),lastProviderError:null};
    return{ok:true,status:response.status,rowsAdded:incoming.length};
  }
  async backfillIncomplete(reason='scheduled') {
    if(this.backfillInFlight)return{status:'BACKFILL_ALREADY_IN_FLIGHT',requestsUsed:0,remainingIncomplete:0,rows:[]};
    if(this.inFlight)return{status:'REFRESH_IN_FLIGHT_BACKFILL_DEFERRED',requestsUsed:0,remainingIncomplete:0,rows:[]};
    if(this.provider.isBlocked())return{status:'BINANCE_PROVIDER_COOLDOWN_ACTIVE',requestsUsed:0,remainingIncomplete:0,rows:[]};
    this.backfillInFlight=true;
    const base=this.baseFrame();
    let remaining=this.config.crypto.backfillRequestsPerRun;
    let requestsUsed=0;
    const queue=[];
    const summary=new Map();
    try {
      for(const symbol of this.config.cryptoSymbols) {
        const clean=await this.storage.readCrypto(this.config.crypto.cleanDir,symbol.key,base.key);
        const days=coverageDays(clean);
        if(days>=this.config.crypto.backfillCoverageDays)summary.set(symbol.key,{symbol:symbol.key,timeframe:'5m',status:'STOPPED_CANONICAL_5M_COVERAGE_AT_OR_ABOVE_180_DAYS',coverageDays:Number(days.toFixed(3)),requestsUsed:0});
        else {queue.push({symbol,beforeFirst:clean[0]?.t||null});summary.set(symbol.key,{symbol:symbol.key,timeframe:'5m',status:'CANONICAL_5M_BACKFILL_PENDING',coverageDays:Number(days.toFixed(3)),requestsUsed:0});}
      }
      while(remaining>0&&queue.length&&!this.provider.isBlocked()) {
        const item=queue.shift();
        const before=await this.storage.readCrypto(this.config.crypto.cleanDir,item.symbol.key,base.key);
        const beforeFirst=before[0]?.t??null;
        const result=await this.refreshFrame(item.symbol,base,{purpose:'backfill'});
        remaining--;
        requestsUsed++;
        const after=await this.storage.readCrypto(this.config.crypto.cleanDir,item.symbol.key,base.key);
        const afterFirst=after[0]?.t??null;
        const days=coverageDays(after);
        const row=summary.get(item.symbol.key);
        row.requestsUsed++;
        row.coverageDays=Number(days.toFixed(3));
        if(!result.ok)row.status=result.reason;
        else if(days>=this.config.crypto.backfillCoverageDays)row.status='STOPPED_CANONICAL_5M_COVERAGE_AT_OR_ABOVE_180_DAYS';
        else if(beforeFirst!=null&&afterFirst!=null&&afterFirst>=beforeFirst)row.status='MAX_PROVIDER_HISTORY_REACHED_NO_EARLIER_5M';
        else {row.status='CANONICAL_5M_BACKFILL_CHUNK_COMMITTED';queue.push({symbol:item.symbol,beforeFirst:afterFirst});}
        if(this.config.crypto.interRequestDelayMs)await sleep(this.config.crypto.interRequestDelayMs);
        if(!result.ok&&['BINANCE_PROVIDER_COOLDOWN_ACTIVE','HTTP_429_RATE_LIMIT_COOLDOWN','HTTP_418_IP_BAN_COOLDOWN'].includes(result.reason))break;
      }
      if(requestsUsed>0)await this.cleanAndRebuild(`backfill-${reason}`);
      const rows=[...summary.values()];
      const remainingIncomplete=this.frameViews().filter(frame=>frame.timeframe==='5m'&&!frame.historicalComplete).length;
      const result={status:this.provider.isBlocked()?'PROVIDER_COOLDOWN_ACTIVE':requestsUsed?'COMPLETED':'NO_BACKFILL_REQUIRED',requestsUsed,remainingIncomplete,rows};
      this.lastBackfillSummary=result;
      return result;
    } finally {
      this.backfillInFlight=false;
      await this.persist();
    }
  }
  async refreshAll(reason='scheduled') {
    if(this.inFlight)return{status:'REFRESH_ALREADY_IN_FLIGHT'};
    if(this.backfillInFlight)return{status:'BACKFILL_IN_FLIGHT_REFRESH_DEFERRED'};
    if(this.provider.isBlocked())return{status:'BINANCE_PROVIDER_COOLDOWN_ACTIVE'};
    this.inFlight=true;
    this.state.lastRefreshStartedAt=iso(this.now());
    this.state.refreshSequence++;
    const rows=[];
    const base=this.baseFrame();
    const callsBefore=Number(this.provider.state?.requestCount||0);
    let resultPayload=null;
    try {
      for(const symbol of this.config.cryptoSymbols) {
        if(this.provider.isBlocked())break;
        const result=await this.refreshFrame(symbol,base,{purpose:'scheduled'});
        rows.push({symbol:symbol.key,timeframe:'5m',status:result.ok?'UPDATED':result.reason});
        if(this.config.crypto.interRequestDelayMs)await sleep(this.config.crypto.interRequestDelayMs);
      }
      await this.cleanAndRebuild(`refresh-${reason}`);
      this.state.status=this.provider.isBlocked()?'PROVIDER_COOLDOWN_ACTIVE':'ONLINE';
      this.state.lastError=null;
      resultPayload={status:this.state.status,providerFramesRequested:['5m'],derivedFramesRebuilt:this.derivedFrames().map(frame=>frame.key),rows};
      return resultPayload;
    } catch(e) {
      this.state.status='DEGRADED';
      this.state.lastError=String(e.stack||e).slice(0,1200);
      resultPayload={status:'FAILED',error:this.state.lastError,rows};
      return resultPayload;
    } finally {
      this.state.lastRefreshCompletedAt=iso(this.now());
      const callsAfter=Number(this.provider.state?.requestCount||0);
      const providerCallsUsed=Math.max(0,callsAfter-callsBefore);
      this.state.lastRefreshSummary={
        reason,startedAt:this.state.lastRefreshStartedAt,completedAt:this.state.lastRefreshCompletedAt,
        providerCallsUsed,maximumProviderCallsPerCycle:this.config.cryptoSymbols.length,
        withinCallGuard:providerCallsUsed<=this.config.cryptoSymbols.length,
        requestedTimeframes:['5m'],derivedLocally:this.derivedFrames().map(frame=>frame.key),
        rowStatuses:rows,
      };
      this.inFlight=false;
      await this.persist();
    }
  }
  nextDelay(){const interval=this.config.crypto.refreshIntervalMs;const now=this.now();const next=Math.ceil((now+1000)/interval)*interval+25000;return Math.max(60000,next-now);}
  schedule() {
    if(!this.running)return;
    if(this.timer)clearTimeout(this.timer);
    const delay=this.nextDelay();
    const scheduledFor=this.now()+delay;
    this.state.nextRefreshAt=iso(scheduledFor);
    this.timer=setTimeout(async()=>{
      this.timer=null;
      this.state.nextRefreshAt=iso(Math.max(scheduledFor+this.config.crypto.refreshIntervalMs,this.now()+60000));
      try {
        await this.refreshAll('scheduled');
        const incompleteCanonical=this.frameViews().some(frame=>frame.timeframe==='5m'&&!frame.historicalComplete);
        if(incompleteCanonical)await this.backfillIncomplete('scheduler');
      } catch(e) {this.state.lastError=String(e.message||e);}
      this.schedule();
    },delay);
    this.timer.unref?.();
  }
  start(){this.running=true;this.state.workerOnline=true;this.schedule();}
  async stop(){this.running=false;if(this.timer)clearTimeout(this.timer);this.state.workerOnline=false;await this.evidenceScorer.stop().catch(()=>{});await this.persist();}
  frameViews() {
    const now=this.now();
    const out=[];
    for(const symbol of this.config.cryptoSymbols)for(const frame of this.config.cryptoFrames) {
      const key=this.frameKey(symbol,frame);
      const f=this.state.frames[key]||{symbol:symbol.canonical,symbolKey:symbol.key,timeframe:frame.key,intervalMs:frame.intervalMs,cleanRows:0,rawRows:0,coverageDays:0,historicalComplete:false,backfillEnabled:frame.key==='5m',quality:{}};
      const latest=Date.parse(f.latestAt||'');
      const age=Number.isFinite(latest)?Math.max(0,now-(latest+frame.intervalMs)):Infinity;
      const stale=age>frame.intervalMs*this.config.crypto.staleMultiplier;
      out.push({...f,stale,quality:{...(f.quality||{}),stale,staleAgeMinutes:Number.isFinite(age)?Number((age/60000).toFixed(2)):null,status:stale?'STALE_PROVIDER_PRICE_REJECTED_FOR_FORWARD_USE':'CLEAN'}});
    }
    return out;
  }
  symbolsView() {
    const frames=this.frameViews();
    return this.config.cryptoSymbols.map(symbol=>{
      const rows=frames.filter(frame=>frame.symbolKey===symbol.key);
      const ready=rows.filter(frame=>frame.historicalComplete&&!frame.stale).length;
      const latest=rows.map(frame=>Date.parse(frame.latestAt||'')).filter(Number.isFinite).sort((a,b)=>b-a)[0];
      return{symbol:symbol.canonical,symbolKey:symbol.key,enabled:true,assetClass:'CRYPTO',frames:rows,frameCount:rows.length,readyFrames:ready,historicalComplete:rows.every(frame=>frame.historicalComplete),stale:rows.some(frame=>frame.stale),latestAt:Number.isFinite(latest)?iso(latest):null,totalCleanRows:rows.reduce((sum,frame)=>sum+Number(frame.cleanRows||0),0),minimumCoverageDays:rows.length?Math.min(...rows.map(frame=>Number(frame.coverageDays||0))):0};
    });
  }
  problems() {
    const p=[];
    const provider=this.provider.view();
    if(provider.blocked)p.push({priority:'P1',market:'CRYPTO',code:'BINANCE_PROVIDER_COOLDOWN_ACTIVE',blockedUntil:provider.blockedUntil,status:'OPEN'});
    for(const frame of this.frameViews()) {
      if(!frame.cleanRows)p.push({priority:'P1',market:'CRYPTO',code:'NO_CLEAN_CRYPTO_DATA',symbol:frame.symbol,timeframe:frame.timeframe,status:'OPEN'});
      if(frame.timeframe==='5m'&&Number(frame.coverageDays||0)<this.config.crypto.backfillCoverageDays)p.push({priority:'P2',market:'CRYPTO',code:'CRYPTO_CANONICAL_5M_HISTORY_BELOW_180_DAYS',symbol:frame.symbol,timeframe:'5m',coverageDays:frame.coverageDays,status:'OPEN'});
      if(frame.continuity?.continuityPassed!==true)p.push({priority:'P1',market:'CRYPTO',code:'CRYPTO_CANDLE_CONTINUITY_GAP',symbol:frame.symbol,timeframe:frame.timeframe,missingBars:Number(frame.continuity?.missingBars||0),largestGapMinutes:frame.continuity?.largestGapMinutes??null,status:'OPEN'});
      if(frame.stale)p.push({priority:'P1',market:'CRYPTO',code:'CRYPTO_LATEST_PRICE_STALE',symbol:frame.symbol,timeframe:frame.timeframe,latestAt:frame.latestAt,status:'OPEN'});
    }
    if(this.historicalEvidence?.catalogedFiles>0)p.push({priority:'INFO',market:'CRYPTO',code:'LEGACY_CRYPTO_PAPER_LEDGER_CATALOGED_AS_HISTORICAL_EVIDENCE',catalogedFiles:this.historicalEvidence.catalogedFiles,estimatedRecords:this.historicalEvidence.estimatedRecords,replayed:false,status:'EXPECTED'});
    else p.push({priority:'P2',market:'CRYPTO',code:'LEGACY_CRYPTO_PAPER_EVIDENCE_NOT_CATALOGED',evidenceStatus:this.historicalEvidence?.status||'NOT_AVAILABLE',status:'OPEN'});
    p.push({priority:'INFO',market:'CRYPTO',code:'CRYPTO_CANONICAL_5M_AUTHORITY_ACTIVE',derivedTimeframes:['15m','30m','1h','4h'],status:'EXPECTED'});
    p.push({priority:'INFO',market:'CRYPTO',code:'CRYPTO_CONTINUITY_AUDIT_ACTIVE',passedFrames:this.continuity?.passedFrames||0,pairFrames:this.continuity?.pairFrames||35,status:'EXPECTED'});
    const candidateSummary=this.candidateEngine?.summaryView?.()||null;
    if(candidateSummary?.lastError)p.push({priority:'P1',market:'CRYPTO',code:'CRYPTO_FORWARD_SHADOW_CANDIDATE_ENGINE_ERROR',error:candidateSummary.lastError,status:'OPEN'});
    if(candidateSummary?.temporalIntegrity?.status==='FAIL'||Number(candidateSummary?.temporalIntegrity?.violations||0)>0)p.push({priority:'P1',market:'CRYPTO',code:'FORWARD_TEMPORAL_INTEGRITY_VIOLATION',candidateEngineEpochAt:candidateSummary?.candidateEngineEpochAt||null,violations:Number(candidateSummary?.temporalIntegrity?.violations||0),lastViolation:candidateSummary?.temporalIntegrity?.lastViolation||null,status:'OPEN'});
    p.push({priority:'INFO',market:'CRYPTO',code:'PROVISIONAL_V1205_LEDGER_PRESERVED_EXCLUDED_FROM_CERTIFIED_PERFORMANCE',available:candidateSummary?.provisionalV1205Ledger?.available===true,totalCandidates:Number(candidateSummary?.provisionalV1205Ledger?.totalCandidates||0),netR:Number(candidateSummary?.provisionalV1205Ledger?.netR||0),countedInCertifiedPerformance:false,status:'EXPECTED'});
    p.push({priority:'INFO',market:'CRYPTO',code:'CRYPTO_FORWARD_SHADOW_CANDIDATE_ENGINE_ACTIVE',foundationEpochAt:this.forwardShadow?.epochAt||null,candidateEngineEpochAt:candidateSummary?.candidateEngineEpochAt||null,observedClosedCandles:this.forwardShadow?.observedClosedCandles||0,pendingCandidates:candidateSummary?.pendingCandidateCount||0,openCandidates:candidateSummary?.openCandidateCount||0,totalCandidates:candidateSummary?.performance?.totalCandidates||0,totalNominations:candidateSummary?.performance?.totalNominations||0,evidenceClass:'CERTIFIED_FORWARD_V12051',paperExecutionEnabled:true,liveCapitalExecution:false,status:'EXPECTED'});
    p.push({priority:'INFO',market:'CRYPTO',code:'CRYPTO_FORWARD_SHADOW_RISK_POLICY_ACTIVE',riskRewardLegs:[1,2,5],moveStopToBreakevenAtProgress:0.5,moveStopToHalfTargetAtProgress:0.75,status:'EXPECTED'});
    p.push(...this.evidenceScorer.problems());
    p.push({priority:'INFO',market:'CRYPTO',code:'CRYPTO_PAPER_FORWARD_ONLY_NO_LIVE_CAPITAL',status:'EXPECTED'});
    return p;
  }
  async persist(){this.state.generatedAt=iso(this.now());await this.storage.writeJsonAtomic(this.config.crypto.stateFile,this.state);}
  view() {
    const frames=this.frameViews();
    const symbols=this.symbolsView();
    let nextRefreshAt=this.state.nextRefreshAt;
    const nextMs=Date.parse(nextRefreshAt||'');
    if(this.running&&(!Number.isFinite(nextMs)||nextMs<=this.now()))nextRefreshAt=iso(this.now()+this.nextDelay());
    const pairFrames=this.config.cryptoSymbols.length*this.config.cryptoFrames.length;
    const pairFramesReady=frames.filter(frame=>frame.historicalComplete&&!frame.stale&&frame.continuity?.continuityPassed===true).length;
    const continuity=this.continuity?{
      schema:this.continuity.schema,generatedAt:this.continuity.generatedAt,pairFrames:this.continuity.pairFrames,
      passedFrames:this.continuity.passedFrames,failedFrames:this.continuity.failedFrames,totalMissingBars:this.continuity.totalMissingBars,
      allPassed:this.continuity.allPassed,
    }:{schema:'alps.gen2.cryptoContinuityAudit.v12043',pairFrames,passedFrames:0,failedFrames:pairFrames,totalMissingBars:null,allPassed:false};
    const candidateSummary=this.candidateEngine?this.candidateEngine.summaryView():null;
    const forwardShadow=this.forwardShadow?{
      schema:this.forwardShadow.schema,version:this.forwardShadow.version,epochAt:this.forwardShadow.epochAt,foundationEpochAt:this.forwardShadow.epochAt,candidateEngineEpochAt:candidateSummary?.candidateEngineEpochAt||this.forwardShadow.candidateEngineEpochAt||null,evidenceClass:'CERTIFIED_FORWARD_V12051',mode:this.forwardShadow.mode,
      status:this.forwardShadow.status,candidateEngineEnabled:true,paperExecutionEnabled:true,executionEnabled:false,promotionEnabled:false,liveCapitalExecution:false,activationVersionRequired:null,
      observedClosedCandles:this.forwardShadow.observedClosedCandles,framesWithPostDeployObservation:this.forwardShadow.framesWithPostDeployObservation,
      continuityPassedFrames:this.forwardShadow.continuityPassedFrames,cleanFrames:this.forwardShadow.cleanFrames,forwardShadowEligible:this.forwardShadow.forwardShadowEligible||0,
      temporalIntegrity:candidateSummary?.temporalIntegrity||this.forwardShadow.temporalIntegrity||null,provisionalV1205Ledger:candidateSummary?.provisionalV1205Ledger||this.forwardShadow.provisionalV1205Ledger||null,
      lastEvaluatedAt:this.forwardShadow.lastEvaluatedAt,candidates:candidateSummary,
    }:{schema:'alps.gen2.cryptoForwardShadow.v12051',status:'INITIALIZING',candidateEngineEnabled:true,paperExecutionEnabled:true,executionEnabled:false,promotionEnabled:false,liveCapitalExecution:false,activationVersionRequired:null,evidenceClass:'CERTIFIED_FORWARD_V12051',candidateEngineEpochAt:candidateSummary?.candidateEngineEpochAt||null,temporalIntegrity:candidateSummary?.temporalIntegrity||null,forwardShadowEligible:0,candidates:candidateSummary};
    const historicalEvidence=this.historicalEvidence?{
      schema:this.historicalEvidence.schema,status:this.historicalEvidence.status,catalogedFiles:this.historicalEvidence.catalogedFiles,
      estimatedRecords:this.historicalEvidence.estimatedRecords,historicalEvidenceOnly:true,replayed:false,countedAsV12Trades:false,
      v11Writes:this.historicalEvidence.v11Writes,
    }:{schema:'alps.gen2.legacyCryptoPaperEvidence.v12043',status:'INITIALIZING',catalogedFiles:0,estimatedRecords:0,historicalEvidenceOnly:true,replayed:false,countedAsV12Trades:false,v11Writes:0};
    return{
      ...this.state,generatedAt:iso(this.now()),status:this.provider.isBlocked()?'PROVIDER_COOLDOWN_ACTIVE':this.state.status,
      running:this.running,inFlight:this.inFlight,backfillInFlight:this.backfillInFlight,nextRefreshAt,lastBackfillSummary:this.lastBackfillSummary,
      paperOnly:true,dataMode:'CRYPTO_PRICE_ONLY',
      dataAuthority:{
        canonicalTimeframe:'5m',historyProvenance:['V11_READONLY_IMPORT_IF_PRESENT','BINANCE_PUBLIC_5M_LIVE'],
        directProviderFrames:['5m'],derivedTimeframes:this.derivedFrames().map(frame=>frame.key),
        derivationRule:'ONLY_COMPLETE_CONTIGUOUS_CLOSED_5M_BUCKETS',
        flatCandleRule:'PRESERVE_FOR_AGGREGATION_EXCLUDE_FROM_DIRECT_SIGNAL_EVIDENCE',
        continuityRule:'ZERO_MISSING_BARS_REQUIRED_IN_EACH_PAIR_FRAME',
        maximumProviderCallsPerScheduledCycle:this.config.cryptoSymbols.length,
      },
      readiness:{pairFramesReady,pairFrames,allPairFramesReady:pairFramesReady===pairFrames,p0:this.problems().filter(p=>p.priority==='P0').length,p1:this.problems().filter(p=>p.priority==='P1').length},
      symbols,frames,
      universe:{mode:'CRYPTO_PRICE_ONLY',enabledMarkets:this.config.cryptoSymbols.map(symbol=>symbol.canonical),enabledCount:this.config.cryptoSymbols.length,timeframes:this.config.cryptoFrames.map(frame=>frame.key),pairFrames},
      provider:{...this.provider.view(),requestPolicy:'5M_ONLY_HIGHER_FRAMES_LOCAL',maximumScheduledCallsPerCycle:this.config.cryptoSymbols.length},
      continuity,forwardShadow,historicalEvidence,candidates:candidateSummary,evidenceScoring:this.evidenceScorer.view(),
      hypotheses:this.hypotheses?{
        count:this.hypotheses.count,researchOnly:this.hypotheses.researchOnly,
        continuityPassedHypotheses:this.hypotheses.continuityPassedHypotheses,
        forwardObservationReady:this.hypotheses.forwardObservationReady,
        forwardShadowEligible:this.hypotheses.forwardShadowEligible||0,paperForwardActive:this.hypotheses.paperForwardActive||0,generatedAt:this.hypotheses.generatedAt,
      }:{count:0,researchOnly:0,continuityPassedHypotheses:0,forwardObservationReady:0,forwardShadowEligible:0,paperForwardActive:0},
      migration:this.migration,
      v11Protection:{root:this.config.legacyRoot,mode:'READ_ONLY',writes:0,v12WriteRoot:this.config.dataRoot},
      memory:this.memory.view(),
      problems:this.problems(),
    };
  }
}


class MultiMarketEngine {
  constructor({config,log=console.log,now=()=>Date.now()}){this.config=config;this.log=log;this.now=now;this.storage=new SafeStorage(config);this.memory=new MemoryTracker({now,log});this.forex=new ForexEngine({config,storage:this.storage,log,now,memory:this.memory});this.crypto=new CryptoEngine({config,storage:this.storage,log,now,memory:this.memory});this.startedAt=null;this.status='CREATED';this.initializing=false;this.lastError=null;}
  async init(){
    this.initializing=true;this.startedAt=iso(this.now());this.status='INITIALIZING';await this.storage.init();const failures=[];
    // Strictly sequential startup: no simultaneous Forex and Crypto full-history arrays.
    // Crypto is initialized first, then released, then Forex. Schedulers/background
    // backfill start only after the memory-heavy initialization phases are complete.
    if(this.config.cryptoEnabled){try{await this.memory.checkpoint('MULTI_STARTUP_CRYPTO');await this.crypto.init();}catch(e){failures.push(e);this.crypto.state.status='DEGRADED';this.crypto.state.lastError=String(e.stack||e).slice(0,1200);}await this.memory.checkpoint('MULTI_STARTUP_CRYPTO_RELEASED');}
    if(this.config.forexEnabled){try{await this.memory.checkpoint('MULTI_STARTUP_FOREX');await this.forex.init();}catch(e){failures.push(e);this.forex.state.status='DEGRADED';this.forex.state.lastError=String(e.stack||e).slice(0,1200);}await this.memory.checkpoint('MULTI_STARTUP_FOREX_RELEASED');}
    if(this.config.cryptoEnabled)this.crypto.start();if(this.config.forexEnabled)this.forex.start();
    if(this.config.cryptoEnabled)this.crypto.startBackgroundBackfill();
    if(failures.length){this.status='DEGRADED';this.lastError=failures.map(e=>String(e&&e.stack||e)).join('\n').slice(0,2400);}else this.status='ONLINE';this.initializing=false;await this.memory.checkpoint('MULTI_STARTUP_COMPLETE');return this.view();
  }
  async stop(){if(this.config.forexEnabled)await this.forex.stop();if(this.config.cryptoEnabled)await this.crypto.stop();this.status='STOPPED';await this.memory.checkpoint('MULTI_STOPPED');}
  problems(){return[...(this.config.forexEnabled?this.forex.problems():[]),...(this.config.cryptoEnabled?this.crypto.problems():[])];}
  statusValue(){if(this.initializing)return'INITIALIZING';const fx=this.config.forexEnabled?this.forex.view().status:'DISABLED';const cr=this.config.cryptoEnabled?this.crypto.view().status:'DISABLED';if([fx,cr].some(s=>/DEGRADED|FAILED/.test(s)))return'DEGRADED';if([fx,cr].some(s=>/BUDGET_STOP|COOLDOWN/.test(s)))return'PARTIAL_PROVIDER_GUARD';if([fx,cr].every(s=>s==='ONLINE'||s==='DISABLED'))return'ONLINE';return this.status;}
  view(){const forex=this.forex.view();const crypto=this.crypto.view();const problems=this.problems();return{schema:'alps.gen2.multiMarketState.v1206',version:VERSION,generatedAt:iso(this.now()),startedAt:this.startedAt,status:this.statusValue(),initializing:this.initializing,gen2Enabled:true,gen2WorkerOnline:(!this.config.forexEnabled||forex.gen2WorkerOnline)&&(!this.config.cryptoEnabled||crypto.workerOnline),legacyEngineEnabled:false,paperOnly:true,liveCapitalExecution:false,newsLayer:'REMOVED',dataMode:'MULTI_MARKET_PRICE_ONLY',forexCoreEnabled:this.config.forexEnabled,cryptoCoreEnabled:this.config.cryptoEnabled,forex,crypto,markets:forex.markets,budget:forex.budget,hypotheses:{forex:forex.hypotheses,crypto:crypto.hypotheses,total:Number(forex.hypotheses?.count||0)+Number(crypto.hypotheses?.count||0),forwardShadowEligible:Number(forex.hypotheses?.forwardShadowEligible||0)+Number(crypto.hypotheses?.forwardShadowEligible||0)},continuity:crypto.continuity,forwardShadow:crypto.forwardShadow,historicalEvidence:crypto.historicalEvidence,readiness:{cryptoPairFramesReady:crypto.readiness?.pairFramesReady||0,cryptoPairFrames:crypto.readiness?.pairFrames||35,cryptoAllPairFramesReady:crypto.readiness?.allPairFramesReady===true,p0:problems.filter(p=>p.priority==='P0').length,p1:problems.filter(p=>p.priority==='P1').length},universe:{forexMarkets:this.config.forexPairs.map(p=>p.canonical),cryptoMarkets:this.config.cryptoSymbols.map(s=>s.canonical),cryptoTimeframes:this.config.cryptoFrames.map(f=>f.key),enabledMarketCount:this.config.forexPairs.length+this.config.cryptoSymbols.length,enabledPairFrames:this.config.forexPairs.length+this.config.cryptoSymbols.length*this.config.cryptoFrames.length,ukOilEnabled:false},v11Protection:{root:this.config.legacyRoot,mode:'READ_ONLY',writes:0,v12WriteRoot:this.config.dataRoot},memory:this.memory.view(),problems,lastError:this.lastError};}
}

const DASHBOARD_HTML=String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#08090c"><title>ALPS Multi-Market Command Center</title><style>
:root{color-scheme:dark;--bg:#08090c;--panel:#111319;--panel2:#171a21;--line:#292e38;--text:#f5f7fb;--muted:#929aaa;--ok:#61e4a8;--warn:#ffd166;--bad:#ff707c;--blue:#7ba9ff;--violet:#b89cff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 100% 0,rgba(123,169,255,.12),transparent 28rem),var(--bg);color:var(--text);font:500 14px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}.shell{width:min(1180px,100%);margin:auto;padding:16px 13px 70px}.top{position:sticky;top:0;z-index:10;margin:-16px -13px 14px;padding:13px;display:flex;justify-content:space-between;align-items:center;background:rgba(8,9,12,.88);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,.06)}.brand{display:flex;gap:10px;align-items:center;min-width:0}.mark{width:38px;height:38px;border:1px solid #424856;border-radius:12px;display:grid;place-items:center;font-weight:950;background:#11141a}.title{font-size:14px;font-weight:900;letter-spacing:.05em}.sub{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions{display:flex;align-items:center;gap:9px}.dot{width:9px;height:9px;border-radius:50%;background:var(--muted)}.dot.ok{background:var(--ok);box-shadow:0 0 16px var(--ok)}.dot.warn{background:var(--warn);box-shadow:0 0 16px var(--warn)}.dot.bad{background:var(--bad);box-shadow:0 0 16px var(--bad)}button{border:1px solid #353b46;background:#171a20;color:var(--text);padding:9px 12px;border-radius:10px;font-weight:800}.hero,.panel,.metric,.card{border:1px solid var(--line);background:linear-gradient(150deg,rgba(255,255,255,.048),rgba(255,255,255,.015));border-radius:19px}.hero{padding:20px}.eyebrow{font-size:10px;color:var(--muted);font-weight:900;letter-spacing:.15em;text-transform:uppercase}.hero h1{font-size:clamp(27px,8vw,50px);line-height:1.02;letter-spacing:-.045em;margin:8px 0}.hero p{color:#c9ced8;margin:0}.pills{display:flex;gap:7px;flex-wrap:wrap;margin-top:15px}.pill,.state,.frame{font-size:9px;font-weight:900;border:1px solid #343a45;border-radius:999px;padding:5px 8px;color:var(--muted)}.pill.ok,.state.ok,.frame.ok{color:var(--ok);border-color:rgba(97,228,168,.3);background:rgba(97,228,168,.07)}.pill.warn,.state.warn,.frame.warn{color:var(--warn);border-color:rgba(255,209,102,.3);background:rgba(255,209,102,.07)}.tabs{display:flex;gap:7px;overflow:auto;padding:14px 0 4px;scrollbar-width:none}.tab{white-space:nowrap;background:#111319}.tab.active{background:#f2f4f8;color:#090a0d;border-color:#f2f4f8}.view{display:none}.view.active{display:block}.grid{display:grid;gap:11px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:12px}.metric{padding:14px;min-height:100px;background:var(--panel)}.label{font-size:9px;color:var(--muted);font-weight:900;letter-spacing:.1em;text-transform:uppercase}.value{font-size:24px;font-weight:950;letter-spacing:-.04em;margin-top:8px;overflow-wrap:anywhere}.note{font-size:10px;color:var(--muted);margin-top:5px}.section{margin-top:22px}.head{display:flex;justify-content:space-between;align-items:end;gap:10px;margin:0 2px 9px}.head h2{margin:0;font-size:18px}.head span{font-size:10px;color:var(--muted);text-align:right}.panel{padding:15px;background:var(--panel)}.cards{grid-template-columns:1fr}.card{padding:14px;background:#0f1116}.cardtop{display:flex;justify-content:space-between;align-items:center;gap:8px}.pair{font-size:17px;font-weight:950}.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:11px}.stats div{padding:9px;background:#171a21;border-radius:10px}.stats b{display:block;font-size:13px}.stats span{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.frames{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.fresh{font-size:9px;color:var(--muted);margin-top:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.budget{display:grid;gap:12px}.bar{height:10px;border-radius:99px;background:#282d36;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--violet));width:0}.miniGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.mini{padding:10px;background:#0e1014;border:1px solid #282d36;border-radius:11px}.mini b{display:block;font-size:15px}.mini span{font-size:8px;color:var(--muted);text-transform:uppercase}.problem{display:grid;grid-template-columns:auto 1fr;gap:9px;padding:10px;border:1px solid #2b3039;border-radius:12px;background:#0e1014;margin-top:7px}.prio{font-size:8px;font-weight:950;border-radius:6px;padding:4px 6px;height:max-content}.P0{color:var(--bad);background:rgba(255,112,124,.12)}.P1{color:var(--warn);background:rgba(255,209,102,.1)}.P2{color:var(--blue);background:rgba(123,169,255,.1)}.INFO{color:var(--muted);background:rgba(146,154,170,.1)}.problem b{display:block;font-size:11px;overflow-wrap:anywhere}.problem small{color:var(--muted)}.empty{padding:25px;text-align:center;color:var(--muted);border:1px dashed #343a45;border-radius:13px}.error{display:none;padding:11px;margin-top:10px;border:1px solid rgba(255,112,124,.4);border-radius:11px;color:#ffb2b9}.footer{font-size:9px;color:var(--muted);margin-top:25px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.footer a{color:#cfd4de;text-decoration:none}@media(min-width:700px){.shell{padding:22px 20px 80px}.top{margin:-22px -20px 18px;padding:14px 20px}.metrics{grid-template-columns:repeat(4,minmax(0,1fr))}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.budget{grid-template-columns:1.1fr .9fr}}@media(min-width:1030px){.cards{grid-template-columns:repeat(3,minmax(0,1fr))}}
</style></head><body><main class="shell"><header class="top"><div class="brand"><div class="mark">A2</div><div><div class="title">ALPS COMMAND CENTER</div><div class="sub" id="version">Multi-Market · loading</div></div></div><div class="actions"><span class="dot" id="dot"></span><button id="refresh">Refresh</button></div></header>
<section class="hero"><div class="eyebrow">Generation 2 · Forex + Crypto</div><h1 id="status">Connecting to runtime truth…</h1><p>Paper-only price research with isolated providers, closed-candle safety, read-only v11 migration, and no live-capital execution.</p><div class="pills" id="pills"></div></section>
<nav class="tabs"><button class="tab active" data-tab="overview">Overview</button><button class="tab" data-tab="crypto">Crypto</button><button class="tab" data-tab="forex">Forex</button><button class="tab" data-tab="research">Research</button><button class="tab" data-tab="problems">Problems</button></nav><div class="error" id="error"></div>
<section class="view active" id="view-overview"><div class="grid metrics" id="metrics"></div><div class="section"><div class="head"><h2>Provider Guardrails</h2><span>Independent Forex and Crypto controls</span></div><div class="panel budget" id="guards"></div></div><div class="section"><div class="head"><h2>Market Readiness</h2><span id="readinessNote"></span></div><div class="grid cards" id="overviewCards"></div></div></section>
<section class="view" id="view-crypto"><div class="section"><div class="head"><h2>Crypto Core</h2><span>7 symbols · canonical 5m · local 15m/30m/1h/4h</span></div><div class="grid cards" id="cryptoCards"></div></div></section>
<section class="view" id="view-forex"><div class="section"><div class="head"><h2>Forex Core</h2><span>9 markets · Twelve Data price-only</span></div><div class="grid cards" id="forexCards"></div></div></section>
<section class="view" id="view-research"><div class="section"><div class="head"><h2>Research Evidence</h2><span>All hypotheses remain paper-only</span></div><div class="panel" id="research"></div></div></section>
<section class="view" id="view-problems"><div class="section"><div class="head"><h2>Known Problems</h2><span id="problemCount"></span></div><div id="problems"></div></div></section>
<footer class="footer"><span id="updated">Waiting for first refresh</span><span><a href="/runner/live" target="_blank">Combined JSON</a> · <a href="/runner/crypto" target="_blank">Crypto JSON</a> · <a href="/runner/forex" target="_blank">Forex JSON</a> · <a href="/runner/continuity" target="_blank">Continuity</a> · <a href="/runner/forward-shadow" target="_blank">Forward</a></span></footer></main><script>
(function(){'use strict';var $=function(id){return document.getElementById(id)},state=null;function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}function num(v){return Number(v||0).toLocaleString()}function fixed(v,n){return Number(v||0).toFixed(n)}function time(v){if(!v)return'—';var d=new Date(v);return isNaN(d)?'—':d.toLocaleString()}function statusClass(ok,warn){return ok?'ok':warn?'warn':''}function fetchJson(url){return fetch(url,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(url+' HTTP '+r.status);return r.json()})}
function tab(name){document.querySelectorAll('.tab').forEach(function(b){b.classList.toggle('active',b.dataset.tab===name)});document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('active',v.id==='view-'+name)})}document.querySelectorAll('.tab').forEach(function(b){b.addEventListener('click',function(){tab(b.dataset.tab)})});
function renderHero(s){$('version').textContent=s.version;var online=s.status==='ONLINE';$('status').textContent=s.status.replace(/_/g,' ');$('dot').className='dot '+(online?'ok':s.initializing?'warn':'warn');$('pills').innerHTML=[['FOREX',s.forexCoreEnabled],['CRYPTO',s.cryptoCoreEnabled],['PAPER ONLY',s.paperOnly],['NEWS REMOVED',s.newsLayer==='REMOVED'],['V11 READ ONLY',(s.v11Protection||{}).writes===0]].map(function(x){return'<span class="pill '+(x[1]?'ok':'warn')+'">'+x[0]+'</span>'}).join('')}
function renderMetrics(s){var fx=s.forex||{},cr=s.crypto||{},frames=cr.frames||[],readyFrames=frames.filter(function(f){return f.historicalComplete&&!f.stale}).length,readyFx=(fx.markets||[]).filter(function(m){return m.historicalComplete&&!m.stale}).length;var cards=[['Workers',(fx.gen2WorkerOnline?'1':'0')+' + '+(cr.workerOnline?'1':'0'),'Forex + Crypto'],['Ready markets',readyFx+' / '+(fx.markets||[]).length,'Forex'],['Ready frames',readyFrames+' / '+frames.length,'Crypto pair-frames'],['Research',num((s.hypotheses||{}).total),'Research-only hypotheses']];$('metrics').innerHTML=cards.map(function(c){return'<article class="metric"><div class="label">'+c[0]+'</div><div class="value">'+c[1]+'</div><div class="note">'+c[2]+'</div></article>'}).join('')}
function renderGuards(s){var b=(s.forex||{}).budget||{},p=(s.crypto||{}).provider||{},pct=b.hardLimit?Math.min(100,Number(b.usedCredits||0)/Number(b.hardLimit)*100):0;$('guards').innerHTML='<div><div class="label">Twelve Data Daily Budget</div><div class="value">'+num(b.usedCredits)+' / '+num(b.hardLimit)+'</div><div class="bar"><i style="width:'+pct+'%"></i></div><div class="note">'+esc(b.status||'—')+(b.blockedUntil?' · resumes '+esc(time(b.blockedUntil)):'')+'</div></div><div class="miniGrid"><div class="mini"><b>'+esc(p.status||'—')+'</b><span>Binance provider</span></div><div class="mini"><b>'+num(p.requestCount)+'</b><span>Crypto requests</span></div><div class="mini"><b>'+num(p.usedWeight1m)+'</b><span>Used weight 1m</span></div><div class="mini"><b>'+(p.blocked?'BLOCKED':'READY')+'</b><span>Crypto circuit</span></div></div>'}
function cryptoCard(x){var frames=x.frames||[];return'<article class="card"><div class="cardtop"><div class="pair">'+esc(x.symbol)+'</div><span class="state '+statusClass(!x.stale&&x.historicalComplete,!x.historicalComplete)+'">'+(x.stale?'STALE':x.historicalComplete?'READY':'BUILDING')+'</span></div><div class="stats"><div><b>'+x.readyFrames+' / '+x.frameCount+'</b><span>Ready frames</span></div><div><b>'+fixed(x.minimumCoverageDays,1)+'d</b><span>Min coverage</span></div><div><b>'+num(x.totalCleanRows)+'</b><span>Clean bars</span></div><div><b>'+time(x.latestAt).split(',')[0]+'</b><span>Latest date</span></div></div><div class="frames">'+frames.map(function(f){return'<span class="frame '+statusClass(f.historicalComplete&&!f.stale,!f.historicalComplete)+'">'+esc(f.timeframe)+' · '+fixed(f.coverageDays,0)+'d</span>'}).join('')+'</div><div class="fresh">Latest: '+esc(time(x.latestAt))+'</div></article>'}
function forexCard(m){var q=m.quality||{};return'<article class="card"><div class="cardtop"><div class="pair">'+esc(m.pair)+'</div><span class="state '+statusClass(m.historicalComplete&&!m.stale,!m.historicalComplete)+'">'+(m.stale?'STALE':m.historicalComplete?'READY':'BUILDING')+'</span></div><div class="stats"><div><b>'+fixed(m.coverageDays,1)+'d</b><span>Coverage</span></div><div><b>'+num(m.cleanRows)+'</b><span>Clean bars</span></div><div><b>'+num(m.rawRows)+'</b><span>Raw bars</span></div><div><b>'+(m.backfillEnabled?'ON':'OFF')+'</b><span>Backfill</span></div></div><div class="frames"><span class="frame">Weekend −'+num(q.weekend)+'</span><span class="frame">Flat −'+num(q.flat)+'</span><span class="frame">Duplicate −'+num(q.duplicates)+'</span></div><div class="fresh">Latest: '+esc(time(m.latestAt))+'</div></article>'}
function renderMarkets(s){var crypto=(s.crypto||{}).symbols||[],forex=(s.forex||{}).markets||[];$('cryptoCards').innerHTML=crypto.length?crypto.map(cryptoCard).join(''):'<div class="empty">Crypto state is initializing.</div>';$('forexCards').innerHTML=forex.length?forex.map(forexCard).join(''):'<div class="empty">Forex state is initializing.</div>';var summary=[];crypto.slice(0,4).forEach(function(x){summary.push(cryptoCard(x))});forex.slice(0,2).forEach(function(x){summary.push(forexCard(x))});$('overviewCards').innerHTML=summary.join('')||'<div class="empty">Market state is initializing.</div>';$('readinessNote').textContent=(crypto.length+forex.length)+' enabled markets'}
function renderResearch(s){var fx=(s.forex||{}).hypotheses||{},cr=(s.crypto||{}).hypotheses||{},fm=(s.forex||{}).migration||{},cm=(s.crypto||{}).migration||{},co=(s.crypto||{}).continuity||{},fs=(s.crypto||{}).forwardShadow||{},he=(s.crypto||{}).historicalEvidence||{};$('research').innerHTML='<div class="miniGrid"><div class="mini"><b>'+num(fx.count)+'</b><span>Forex hypotheses</span></div><div class="mini"><b>'+num(cr.count)+'</b><span>Crypto hypotheses</span></div><div class="mini"><b>'+num(co.passedFrames)+' / '+num(co.pairFrames)+'</b><span>Continuity passed</span></div><div class="mini"><b>'+num(fs.observedClosedCandles)+'</b><span>Forward observations</span></div><div class="mini"><b>'+num(he.catalogedFiles)+'</b><span>Legacy evidence files</span></div><div class="mini"><b>'+num(cr.forwardShadowEligible)+'</b><span>Forward eligible</span></div></div><div class="fresh">Continuity: '+esc(co.allPassed?'ALL PASSED':'AUDITING')+' · Forward: '+esc(fs.status||'INITIALIZING')+' · Evidence: '+esc(he.status||'INITIALIZING')+' · v11 writes: '+num((s.v11Protection||{}).writes)+'</div><div class="fresh">Forex migration: '+esc(fm.status||'—')+' · Crypto migration: '+esc(cm.status||'—')+' · paper candidate engine: active</div>'}
function renderProblems(s){var list=s.problems||[];$('problemCount').textContent=list.length+' current items';$('problems').innerHTML=list.length?list.map(function(x){var d=[x.market,x.pair||x.symbol,x.timeframe,x.status].filter(Boolean).join(' · ');return'<div class="problem"><span class="prio '+esc(x.priority||'INFO')+'">'+esc(x.priority||'INFO')+'</span><div><b>'+esc((x.code||'UNKNOWN').replace(/_/g,' '))+'</b><small>'+esc(d)+'</small></div></div>'}).join(''):'<div class="empty">No current problems.</div>'}
function render(s){state=s;renderHero(s);renderMetrics(s);renderGuards(s);renderMarkets(s);renderResearch(s);renderProblems(s);$('updated').textContent='Last refreshed '+new Date().toLocaleTimeString()+' · auto refresh 15s'}
function refresh(){var b=$('refresh');b.disabled=true;b.textContent='Refreshing…';$('error').style.display='none';fetchJson('/api/snapshot').then(render).catch(function(e){$('error').textContent='Dashboard refresh failed: '+e.message;$('error').style.display='block';$('dot').className='dot bad'}).finally(function(){b.disabled=false;b.textContent='Refresh'})}$('refresh').addEventListener('click',refresh);refresh();setInterval(refresh,15000)})();
</script></body></html>`;

function sendJson(res,status,body){const text=JSON.stringify(body,null,2);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(text),'cache-control':'no-store','access-control-allow-origin':'*','x-content-type-options':'nosniff'});res.end(text);}
function sendHtml(res,status,body){res.writeHead(status,{'content-type':'text/html; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store, no-cache, must-revalidate','content-security-policy':"default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer'});res.end(body);}
function readBody(req,maxBytes=64*1024){return new Promise((resolve,reject)=>{let data='';req.setEncoding('utf8');req.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>maxBytes)reject(new Error('REQUEST_BODY_TOO_LARGE'));});req.on('end',()=>{if(!data)return resolve({});try{resolve(JSON.parse(data));}catch(_){reject(new Error('INVALID_JSON'));}});req.on('error',reject);});}

class MultiMarketServer {
  constructor({config,engine,log=console.log}){this.config=config;this.engine=engine;this.log=log;this.server=null;}
  authorized(req){if(!this.config.token)return false;const auth=String(req.headers.authorization||'');const header=String(req.headers['x-alps-token']||'');return auth===`Bearer ${this.config.token}`||header===this.config.token;}
  async handle(req,res){const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'authorization,x-alps-token,content-type'});return res.end();}
    if(req.method==='GET'&&['/','/dashboard'].includes(url.pathname))return sendHtml(res,200,DASHBOARD_HTML);
    if(req.method==='GET'&&['/health','/runner/version'].includes(url.pathname)){const view=this.engine.view();return sendJson(res,200,{schema:'alps.runner.version.v1206',version:VERSION,candidateEngineVersion:CANDIDATE_ENGINE_VERSION,status:view.status,generatedAt:view.generatedAt,gen2Enabled:true,gen2WorkerOnline:view.gen2WorkerOnline,legacyEngineEnabled:false,paperOnly:true,dataMode:'MULTI_MARKET_PRICE_ONLY',forexCoreEnabled:this.config.forexEnabled,cryptoCoreEnabled:this.config.cryptoEnabled,newsLayer:'REMOVED',ukOilEnabled:false,dashboard:{installed:true,url:'/',refreshSeconds:15,mode:'LIVE_NO_CACHE',tabs:['overview','crypto','forex','research','problems']},readiness:view.readiness,cryptoContinuity:view.crypto.continuity,cryptoForwardShadow:view.crypto.forwardShadow,forexBudget:view.forex.budget,forexScheduler:view.forex.scheduler,forexLease:view.forex.lease,cryptoProvider:view.crypto.provider,evidenceScoring:view.crypto.evidenceScoring,memory:view.memory});}
    if(req.method==='GET'&&['/runner/live','/runner/health-lite','/runner/data-health','/api/snapshot'].includes(url.pathname))return sendJson(res,200,this.engine.view());
    if(req.method==='GET'&&url.pathname==='/runner/forex')return sendJson(res,200,this.engine.forex.view());
    if(req.method==='GET'&&url.pathname==='/runner/crypto')return sendJson(res,200,this.engine.crypto.view());
    if(req.method==='GET'&&url.pathname==='/runner/budget')return sendJson(res,200,this.engine.forex.budget.view());
    if(req.method==='GET'&&url.pathname==='/runner/forex/scheduler')return sendJson(res,200,{schema:'alps.gen2.forexScheduler.v120442',generatedAt:iso(),...this.engine.forex.schedulerView()});
    if(req.method==='GET'&&url.pathname==='/runner/continuity')return sendJson(res,200,this.engine.crypto.continuity||{schema:'alps.gen2.cryptoContinuityAudit.v12043',status:'NOT_AVAILABLE'});
    if(req.method==='GET'&&url.pathname==='/runner/forward-shadow')return sendJson(res,200,this.engine.crypto.view().forwardShadow||{schema:'alps.gen2.cryptoForwardShadow.v12051',status:'NOT_AVAILABLE'});
    if(req.method==='GET'&&url.pathname==='/runner/forward-shadow/candidates')return sendJson(res,200,this.engine.crypto.candidateEngine.view());
    if(req.method==='GET'&&url.pathname==='/runner/forward-shadow/open')return sendJson(res,200,{schema:'alps.gen2.cryptoForwardShadowOpenCandidates.v12051',version:CANDIDATE_ENGINE_VERSION,releaseVersion:VERSION,generatedAt:iso(),paperOnly:true,liveCapitalExecution:false,candidates:this.engine.crypto.candidateEngine.view().openCandidates});
    if(req.method==='GET'&&url.pathname==='/runner/forward-shadow/performance')return sendJson(res,200,{schema:'alps.gen2.cryptoForwardShadowPerformance.v12051',version:CANDIDATE_ENGINE_VERSION,releaseVersion:VERSION,generatedAt:iso(),paperOnly:true,liveCapitalExecution:false,...this.engine.crypto.candidateEngine.performanceView()});
    if(req.method==='GET'&&url.pathname==='/runner/forward-shadow/ledger')return sendJson(res,200,{schema:'alps.gen2.cryptoForwardShadowLedgerTail.v12051',version:CANDIDATE_ENGINE_VERSION,releaseVersion:VERSION,generatedAt:iso(),paperOnly:true,liveCapitalExecution:false,events:await this.engine.crypto.candidateEngine.ledgerTail(url.searchParams.get('limit')||200)});
    if(req.method==='GET'&&['/runner/evidence-scoring','/runner/forward-shadow/evidence'].includes(url.pathname))return sendJson(res,200,this.engine.crypto.evidenceScorer.view());
    if(req.method==='GET'&&url.pathname==='/runner/evidence-scoring/hypotheses')return sendJson(res,200,this.engine.crypto.evidenceScorer.hypothesesView());
    if(req.method==='GET'&&url.pathname==='/runner/evidence-scoring/diagnostics')return sendJson(res,200,this.engine.crypto.evidenceScorer.diagnosticsView());
    if(req.method==='GET'&&url.pathname==='/runner/evidence-scoring/snapshots')return sendJson(res,200,{schema:'alps.gen2.evidenceStatisticalSnapshotsTail.v1206',version:VERSION,generatedAt:iso(),snapshots:await this.engine.crypto.evidenceScorer.snapshotsTail(url.searchParams.get('limit')||100)});
    if(req.method==='GET'&&url.pathname==='/runner/historical-evidence')return sendJson(res,200,this.engine.crypto.historicalEvidence||{schema:'alps.gen2.legacyCryptoPaperEvidence.v12043',status:'NOT_AVAILABLE'});
    if(req.method==='GET'&&url.pathname==='/runner/memory')return sendJson(res,200,{schema:'alps.gen2.memory.v1206',generatedAt:iso(),...this.engine.memory.view()});
    if(req.method==='GET'&&url.pathname==='/runner/problems')return sendJson(res,200,{schema:'alps.gen2.problems.v1206',generatedAt:iso(),problems:this.engine.problems()});
    if(req.method==='GET'&&url.pathname==='/runner/hypotheses'){const market=String(url.searchParams.get('market')||'summary').toLowerCase();if(market==='forex')return sendJson(res,200,this.engine.forex.hypotheses||{status:'FOREX_HYPOTHESES_NOT_AVAILABLE'});if(market==='crypto')return sendJson(res,200,this.engine.crypto.hypotheses||{status:'CRYPTO_HYPOTHESES_NOT_AVAILABLE'});return sendJson(res,200,{schema:'alps.gen2.hypothesesSummary.v1206',generatedAt:iso(),forex:this.engine.forex.view().hypotheses,crypto:this.engine.crypto.view().hypotheses});}
    if(req.method==='POST'&&url.pathname==='/runner/command'){if(!this.authorized(req))return sendJson(res,403,{status:'FORBIDDEN'});try{const body=await readBody(req);const command=String(body.command||'').trim().toLowerCase();if(command==='refresh-all')return sendJson(res,200,{forex:await this.engine.forex.refreshAll('private-command'),crypto:await this.engine.crypto.refreshAll('private-command')});if(command==='refresh-forex')return sendJson(res,200,await this.engine.forex.refreshAll('private-command'));if(command==='refresh-crypto')return sendJson(res,200,await this.engine.crypto.refreshAll('private-command'));if(command==='clean-rebuild')return sendJson(res,200,{forex:await this.engine.forex.cleanAndRebuild('private-command'),crypto:await this.engine.crypto.cleanAndRebuild('private-command')});if(command==='backfill')return sendJson(res,200,{forex:await this.engine.forex.backfillIncomplete('private-command'),crypto:await this.engine.crypto.backfillIncomplete('private-command')});if(command==='score-evidence')return sendJson(res,200,await this.engine.crypto.evidenceScorer.run('private-command'));return sendJson(res,400,{status:'UNKNOWN_COMMAND',allowed:['refresh-all','refresh-forex','refresh-crypto','clean-rebuild','backfill','score-evidence']});}catch(error){return sendJson(res,400,{status:'COMMAND_FAILED',error:String(error.message||error)});}}
    return sendJson(res,404,{status:'NOT_FOUND',path:url.pathname});}
  start(){return new Promise((resolve,reject)=>{this.server=http.createServer((req,res)=>this.handle(req,res).catch(error=>sendJson(res,500,{status:'INTERNAL_ERROR',error:String(error.message||error)})));this.server.once('error',reject);this.server.listen(this.config.port,this.config.host,()=>{this.log(`[v12.0.6] server listening on ${this.config.host}:${this.config.port}`);resolve();});});}
  stop(){if(!this.server)return Promise.resolve();return new Promise(resolve=>this.server.close(resolve));}
}

async function main(){const config=loadConfig();const log=(...args)=>console.log(new Date().toISOString(),...args);log(`[v12.0.6] starting ${VERSION}`);log(`[v12.0.6] mode=MULTI_MARKET_PRICE_ONLY forex=${config.forexEnabled} crypto=${config.cryptoEnabled} paperOnly=true legacy=false`);log(`[v12.0.6] roots v12=${config.dataRoot} v11=${config.legacyRoot} (read-only)`);const engine=new MultiMarketEngine({config,log});const server=new MultiMarketServer({config,engine,log});let stopping=false;const shutdown=async signal=>{if(stopping)return;stopping=true;log(`[v12.0.6] shutdown ${signal}`);await engine.stop().catch(e=>log('engine stop failed',e));await server.stop().catch(e=>log('server stop failed',e));};process.once('SIGTERM',()=>shutdown('SIGTERM'));process.once('SIGINT',()=>shutdown('SIGINT'));process.once('uncaughtException',e=>{log('uncaughtException',e.stack||e);process.exitCode=1;shutdown('uncaughtException');});process.once('unhandledRejection',e=>{log('unhandledRejection',e&&e.stack||e);process.exitCode=1;shutdown('unhandledRejection');});await server.start();engine.status='CONTROL_PLANE_READY_INITIALIZING';log('[v12.0.6] control plane ready; Forex and Crypto initialization continue in background');(async()=>{try{await engine.init();if(!stopping)log(`[v12.0.6] multi-market workers online status=${engine.statusValue()}`);}catch(error){engine.status='DEGRADED_INITIALIZATION_FAILED';engine.lastError=String(error.stack||error).slice(0,2400);log('[v12.0.6] initialization failed',error.stack||error);}})();return{config,engine,server};}

module.exports={main,loadConfig,SafeStorage,MemoryTracker,PersistenceQueue,awaitBounded,cleanCandles,mergeCandles,aggregateCanonicalCandles,auditContinuity,latestClosedOpenTime,catalogLegacyCryptoPaperEvidence,loadForwardShadowFoundation,updateForwardShadowFoundation,deriveCryptoCandidateSetup,CryptoForwardShadowCandidateEngine,EvidenceStatisticalScoringEngine,CRYPTO_HYPOTHESIS_FAMILIES,RequestLease,BudgetGuard,TwelveDataProvider,ForexEngine,CryptoEngine,MultiMarketEngine,MultiMarketServer,CRYPTO_SYMBOLS,CRYPTO_FRAMES,FOREX_PAIRS,DASHBOARD_HTML,VERSION,CANDIDATE_ENGINE_VERSION};
