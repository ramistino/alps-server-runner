#!/usr/bin/env node
'use strict';

// v12.0.4.4-forex-request-lease-scheduler-recovery — regression suite.
// Covers: normal success, timeout, HTTP 429, network failure, JSON parse failure,
// persistence failure, expired persisted lease at startup, valid active lease at
// startup, watchdog recovery, no overlapping cycles, live-refresh priority over
// backfill, budget limits, zero writes to the v11 root, unchanged Crypto behavior.
// No network access and no API keys are used: the provider fetch is mocked.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SafeStorage, RequestLease, BudgetGuard, TwelveDataProvider, ForexEngine,
  cleanCandles, aggregateCanonicalCandles, auditContinuity, loadConfig,
  CRYPTO_FRAMES, FOREX_PAIRS, VERSION,
} = require('./v1202-bundle');

const INTERVAL = 300000;
const FIXED_NOW = Date.UTC(2026, 6, 23, 12, 0, 0, 0); // Thursday — FX market open.

function makeConfig(tempRoot, overrides = {}) {
  const dataRoot = path.join(tempRoot, 'v12');
  const legacyRoot = path.join(tempRoot, 'v11');
  return {
    dataRoot, legacyRoot,
    forexPairs: [
      { canonical:'EUR/USD', key:'EURUSD', provider:'EUR/USD' },
      { canonical:'GBP/USD', key:'GBPUSD', provider:'GBP/USD' },
    ],
    cryptoSymbols: [], cryptoFrames: CRYPTO_FRAMES,
    forex: {
      apiKey:'test-key-not-real',
      providerBaseUrl:'https://api.twelvedata.example',
      interval:'5min', intervalMs:INTERVAL,
      refreshIntervalMs:30*60000,
      minLiveRequestGapMs:1,
      interSymbolDelayMs:0,
      requestTimeoutMs:120,
      leaseSafetyMarginMs:80,
      persistTimeoutMs:2000,
      watchdogIntervalMs:30000,
      backfillMaxRequestsPerCycle:3,
      backfillCycleYieldMarginMs:60000,
      staleMarketDataMs:90*60000,
      candleCloseBufferMs:30000,
      backfillCoverageDays:180,
      backfillOutputSize:5000,
      liveOutputSize:500,
      hardDailyCredits:600,
      scheduledCreditCeiling:540,
      rawDir:path.join(dataRoot,'raw'),
      cleanDir:path.join(dataRoot,'clean'),
      stateFile:path.join(dataRoot,'state','forex-core-state.json'),
      budgetFile:path.join(dataRoot,'state','twelve-data-budget.json'),
      leaseFile:path.join(dataRoot,'state','twelve-data-request-lease.json'),
      migrationFile:path.join(dataRoot,'state','v11-readonly-import.json'),
      hypothesesFile:path.join(dataRoot,'hypotheses','forex-hypotheses.json'),
      ...overrides,
    },
    crypto: {
      rawDir:path.join(dataRoot,'crypto','raw'),
      cleanDir:path.join(dataRoot,'crypto','clean'),
    },
    importLegacyOnStartup:false,
  };
}

function tdValues(endMs, count) {
  // Twelve Data rows are normalized via normalizeCandle; supplying epoch-ms `t`
  // fields keeps the tests timezone-independent.
  const rows = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const t = endMs - i * INTERVAL;
    rows.push({ t, o:1.10, h:1.12, l:1.09, c:1.11 + (i % 7) * 0.0001, v:1, closeTime:t + INTERVAL - 1 });
  }
  return rows;
}

function response({ status = 200, body = null, text = null }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => (text != null ? text : JSON.stringify(body)),
  };
}

function pair(i = 0) { return makeConfig('/tmp').forexPairs[i]; }

async function freshHarness(overrides = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v12044-'));
  const config = makeConfig(tempRoot, overrides);
  const storage = new SafeStorage(config);
  await storage.init();
  const now = () => Date.now();
  const lease = new RequestLease({ config, storage, now, log: () => {} });
  const budget = new BudgetGuard({ config, storage, now });
  await budget.load();
  await lease.load();
  return { tempRoot, config, storage, lease, budget, now };
}

(async () => {
  const results = [];
  const T = async (name, fn) => { await fn(); results.push(name); };

  // ---------------------------------------------------------------- provider paths
  await T('normal request success releases lease and completes budget', async () => {
    const h = await freshHarness();
    const provider = new TwelveDataProvider({
      config: h.config, budget: h.budget, lease: h.lease,
      fetchImpl: async () => response({ body: { meta:{}, values: tdValues(Date.now() - 10 * INTERVAL, 20) } }),
    });
    const out = await provider.fetch(pair(0), { purpose:'scheduled' });
    assert.equal(out.ok, true);
    assert.equal(out.rows.length, 20);
    assert.equal(h.lease.view().leaseActive, false, 'lease must be released after success');
    assert.equal(h.budget.inFlight.size, 0);
    assert.equal(h.budget.view().usedCredits, 1);
    assert.equal(h.budget.view().status, 'READY');
  });

  await T('hung request hits abortable timeout, reports TWELVE_DATA_REQUEST_TIMEOUT, releases lease', async () => {
    const h = await freshHarness();
    const provider = new TwelveDataProvider({
      config: h.config, budget: h.budget, lease: h.lease,
      fetchImpl: (url, opts) => new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name:'AbortError' })));
      }),
    });
    const started = Date.now();
    const out = await provider.fetch(pair(0), { purpose:'scheduled' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'TWELVE_DATA_REQUEST_TIMEOUT');
    assert(Date.now() - started < 5000, 'timeout must fire quickly, not hang the chain');
    assert.equal(h.lease.view().leaseActive, false, 'lease released after timeout');
    assert.equal(h.budget.inFlight.size, 0, 'budget reservation completed after timeout');
    assert.equal(provider.lastFailureCode, 'TWELVE_DATA_REQUEST_TIMEOUT');
    // No automatic retry in the same cycle: the min-gap on the same key blocks it.
    const retry = await h.budget.reserve({ key:`time_series:${pair(0).key}:live`, purpose:'scheduled', cost:1, minGapMs:60000 });
    assert.equal(retry.ok, false);
    assert.equal(retry.reason, 'MINIMUM_REQUEST_GAP_ACTIVE');
  });

  await T('HTTP 429 persists circuit breaker before lease release and blocks the day', async () => {
    const h = await freshHarness();
    const provider = new TwelveDataProvider({
      config: h.config, budget: h.budget, lease: h.lease,
      fetchImpl: async () => response({ status:429, body:{ code:429, message:'rate limited' } }),
    });
    const out = await provider.fetch(pair(0), { purpose:'scheduled' });
    assert.equal(out.ok, false);
    assert.equal(out.status, 429);
    assert.equal(out.reason, 'HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY');
    assert.equal(h.budget.isBlocked(), true);
    assert(h.budget.view().first429At, 'first429At recorded');
    const persisted = JSON.parse(fs.readFileSync(h.config.forex.budgetFile, 'utf8'));
    assert(persisted.blockedUntil, '429 breaker persisted to disk');
    assert.equal(h.lease.view().leaseActive, false, 'lease released after breaker persisted');
    const next = await provider.fetch(pair(1), { purpose:'scheduled' });
    assert.equal(next.ok, false, 'no automatic retry while blocked');
    assert.equal(h.budget.view().usedCredits, 1, 'blocked request charged nothing');
  });

  await T('network failure releases lease and completes budget', async () => {
    const h = await freshHarness();
    const provider = new TwelveDataProvider({
      config: h.config, budget: h.budget, lease: h.lease,
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    });
    const out = await provider.fetch(pair(0), { purpose:'scheduled' });
    assert.equal(out.ok, false);
    assert(out.reason.startsWith('TWELVE_DATA_NETWORK_ERROR'));
    assert.equal(h.lease.view().leaseActive, false);
    assert.equal(h.budget.inFlight.size, 0);
  });

  await T('JSON parse failure releases lease and completes budget', async () => {
    const h = await freshHarness();
    const provider = new TwelveDataProvider({
      config: h.config, budget: h.budget, lease: h.lease,
      fetchImpl: async () => response({ status:200, text:'<html>not json</html>' }),
    });
    const out = await provider.fetch(pair(0), { purpose:'scheduled' });
    assert.equal(out.ok, false, 'unparseable body must be rejected');
    assert.equal(h.lease.view().leaseActive, false);
    assert.equal(h.budget.inFlight.size, 0);
  });

  await T('persistence failure cannot strand the lease or the budget reservation', async () => {
    const h = await freshHarness();
    let failWrites = true;
    const originalWrite = h.storage.writeJsonAtomic.bind(h.storage);
    h.storage.writeJsonAtomic = async (file, payload) => {
      if (failWrites) throw new Error('EIO simulated persistence failure');
      return originalWrite(file, payload);
    };
    const provider = new TwelveDataProvider({
      config: h.config, budget: h.budget, lease: h.lease,
      fetchImpl: async () => response({ body: { meta:{}, values: tdValues(Date.now() - 10 * INTERVAL, 5) } }),
    });
    const out = await provider.fetch(pair(0), { purpose:'scheduled' });
    assert.equal(out.ok, true, 'request itself still succeeds');
    assert.equal(h.lease.view().leaseActive, false, 'lease released despite persist failure');
    assert.equal(h.budget.inFlight.size, 0, 'reservation completed despite persist failure');
    assert(h.budget.lastPersistError, 'persist error surfaced, not swallowed silently');
    failWrites = false;
  });

  await T('invalid backfill end date is rejected before any lease or credit is taken', async () => {
    const h = await freshHarness();
    const provider = new TwelveDataProvider({ config:h.config, budget:h.budget, lease:h.lease, fetchImpl: async () => { throw new Error('must not be called'); } });
    const out = await provider.fetch(pair(0), { purpose:'backfill', endDate:'not-a-date' });
    assert.equal(out.reason, 'INVALID_BACKFILL_END_DATE');
    assert.equal(h.lease.view().leaseActive, false);
    assert.equal(h.budget.view().usedCredits, 0, 'no credit charged');
  });

  await T('failed lease acquisition charges no credits and rejects overlap cleanly', async () => {
    const h = await freshHarness();
    const first = h.lease.acquire({ owner:'test', purpose:'scheduled', pair:'EUR/USD', operation:'LIVE_REFRESH' });
    assert.equal(first.ok, true);
    const provider = new TwelveDataProvider({ config:h.config, budget:h.budget, lease:h.lease, fetchImpl: async () => { throw new Error('must not be called'); } });
    const out = await provider.fetch(pair(1), { purpose:'scheduled' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'FOREX_REQUEST_LEASE_HELD');
    assert.equal(h.budget.view().usedCredits, 0, 'no double charge on failed acquisition');
    h.lease.release(first.leaseId, 'TEST_DONE');
    assert.equal(h.lease.view().leaseActive, false);
  });

  // ---------------------------------------------------------------- startup recovery
  await T('expired persisted lease is recovered at startup; credits and 429 breaker untouched', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v12044-'));
    const config = makeConfig(tempRoot);
    const storage = new SafeStorage(config); await storage.init();
    const past = Date.now() - 10 * 60000;
    await storage.writeJsonAtomic(config.forex.leaseFile, {
      schema:'alps.gen2.twelveDataRequestLease.v12044', leaseActive:true, leaseId:'td-stale-1',
      leaseAcquiredAt:new Date(past).toISOString(), leaseExpiresAt:new Date(past + 200).toISOString(),
      leaseOwner:'twelve-data-provider', leasePurpose:'scheduled', currentPair:'EUR/USD', currentOperation:'LIVE_REFRESH',
    });
    const blockedUntil = new Date(Date.now() + 6 * 3600000).toISOString();
    await storage.writeJsonAtomic(config.forex.budgetFile, {
      schema:'alps.gen2.twelveDataBudget.v1204', day:new Date().toISOString().slice(0,10),
      usedCredits:214, blockedUntil, first429At:new Date(past).toISOString(), last429At:new Date(past).toISOString(),
      lastRequestAt:null, lastRequestByKey:{}, requests:[], status:'HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY',
    });
    const lease = new RequestLease({ config, storage, now:() => Date.now(), log:() => {} });
    const budget = new BudgetGuard({ config, storage, now:() => Date.now() });
    await budget.load(); await lease.load();
    assert.equal(lease.view().leaseActive, false, 'expired lease recovered');
    assert.equal(lease.startupRecovery.occurred, true);
    assert.equal(lease.startupRecovery.reason, 'STARTUP_EXPIRED_LEASE_RECOVERED');
    assert.equal(budget.view().usedCredits, 214, 'daily credit counter never reset at startup');
    assert.equal(budget.isBlocked(), true, 'active 429 circuit breaker never cleared at startup');
  });

  await T('genuinely valid persisted lease is preserved at startup', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v12044-'));
    const config = makeConfig(tempRoot, { requestTimeoutMs:60000, leaseSafetyMarginMs:60000 });
    const storage = new SafeStorage(config); await storage.init();
    const nowMs = Date.now();
    await storage.writeJsonAtomic(config.forex.leaseFile, {
      schema:'alps.gen2.twelveDataRequestLease.v12044', leaseActive:true, leaseId:'td-live-1',
      leaseAcquiredAt:new Date(nowMs - 1000).toISOString(), leaseExpiresAt:new Date(nowMs + 90000).toISOString(),
      leaseOwner:'twelve-data-provider', leasePurpose:'scheduled', currentPair:'GBP/USD', currentOperation:'LIVE_REFRESH',
    });
    const lease = new RequestLease({ config, storage, now:() => Date.now(), log:() => {} });
    await lease.load();
    assert.equal(lease.view().leaseActive, true, 'valid lease preserved');
    assert.equal(lease.view().leaseId, 'td-live-1');
    assert.equal(lease.startupRecovery.preservedValidLease, true);
    assert.equal(lease.startupRecovery.occurred, false);
  });

  // ---------------------------------------------------------------- engine cycles
  const engineHarness = async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v12044-'));
    const config = makeConfig(tempRoot);
    const storage = new SafeStorage(config); await storage.init();
    let virtualNow = FIXED_NOW;
    const engine = new ForexEngine({ config, storage, now:() => virtualNow, log:() => {} });
    await engine.budget.load(); await engine.lease.load();
    engine.state.startedAt = new Date(virtualNow).toISOString();
    return { tempRoot, config, storage, engine, setNow:(v) => { virtualNow = v; }, getNow:() => virtualNow };
  };

  await T('cycle runs live refresh with priority over backfill and yields within limits', async () => {
    const h = await engineHarness();
    const calls = [];
    h.engine.provider.fetchImpl = async (url) => {
      const u = new URL(url);
      const isBackfill = u.searchParams.has('end_date');
      calls.push(isBackfill ? 'backfill' : 'live');
      const end = h.getNow() - 2 * INTERVAL;
      return response({ body:{ meta:{}, values: tdValues(isBackfill ? h.getNow() - 500 * INTERVAL : end, isBackfill ? 200 : 60) } });
    };
    const out = await h.engine.runCycle('scheduled');
    assert.equal(out.status, 'ONLINE');
    const liveCalls = calls.filter(c => c === 'live').length;
    assert.equal(liveCalls, 2, 'both pairs refreshed live');
    const firstBackfill = calls.indexOf('backfill');
    assert(firstBackfill === -1 || firstBackfill >= liveCalls, 'every live refresh precedes any backfill request');
    const sv = h.engine.schedulerView();
    assert.equal(sv.cycleInFlight, false, 'cycleInFlight false after completion');
    assert.equal(sv.leaseActive, false, 'leaseActive false after completion');
    assert.equal(sv.liveRefreshCompletedPairs, 2);
    assert.equal(sv.consecutiveFailures, 0);
    assert(sv.lastSuccessfulCycleAt, 'lastSuccessfulCycleAt recorded');
    assert(sv.liveRefreshReleasedAt, 'live refresh operation explicitly released before backfill');
    assert(sv.backfillCreditsUsedToday <= h.config.forex.backfillMaxRequestsPerCycle, 'backfill bounded per cycle');
    for (const p of h.config.forexPairs) {
      assert(h.engine.state.markets[p.key].latestAt, `market ${p.key} progressed`);
    }
  });

  await T('no overlapping cycles: second runCycle is rejected while one is in flight', async () => {
    const h = await engineHarness();
    let releaseGate; const gate = new Promise(res => { releaseGate = res; });
    h.engine.provider.fetchImpl = async () => { await gate; return response({ body:{ meta:{}, values: tdValues(h.getNow() - 2 * INTERVAL, 30) } }); };
    const first = h.engine.runCycle('scheduled');
    await new Promise(res => setTimeout(res, 20));
    const second = await h.engine.runCycle('scheduled');
    assert.equal(second.status, 'CYCLE_ALREADY_IN_FLIGHT');
    releaseGate();
    const firstOut = await first;
    assert.equal(firstOut.status, 'ONLINE');
    assert.equal(h.engine.schedulerView().cycleInFlight, false);
  });

  await T('watchdog recovers a stalled cycle and an expired lease without overlap', async () => {
    const h = await engineHarness();
    // Simulate the v12.0.4.3 failure: a cycle stuck in flight far past the hard limit
    // with an abandoned (expired) lease still held.
    const stale = h.engine.lease.acquire({ owner:'twelve-data-provider', purpose:'scheduled', pair:'EUR/USD', operation:'LIVE_REFRESH' });
    h.engine.inFlight = true;
    h.engine.cycleToken = 'cycle-stuck';
    h.engine.cycleStartedMs = h.getNow();
    h.engine.state.scheduler.cycleInFlight = true;
    h.setNow(h.getNow() + h.engine.cycleHardLimitMs + h.engine.lease.durationMs() + 1000);
    h.engine.running = true;
    h.engine.watchdogTick();
    const sv = h.engine.schedulerView();
    assert.equal(sv.leaseActive, false, 'expired lease recovered by watchdog');
    assert.equal(sv.cycleInFlight, false, 'stalled cycle abandoned by watchdog');
    assert(sv.watchdogRecoveries >= 2, 'watchdog recoveries recorded');
    assert.equal(sv.lastFailureCode === 'FOREX_SCHEDULER_STALLED' || sv.lastFailureCode === 'FOREX_REQUEST_LEASE_EXPIRED', true);
    assert(stale.leaseId, 'stale lease id existed');
    // The abandoned cycle must be able to run again immediately, with no overlap issues.
    h.engine.provider.fetchImpl = async () => response({ body:{ meta:{}, values: tdValues(h.getNow() - 2 * INTERVAL, 30) } });
    const out = await h.engine.runCycle('scheduled');
    assert.equal(out.status, 'ONLINE');
    h.engine.running = false;
  });

  await T('watchdog re-arms a lost schedule timer', async () => {
    const h = await engineHarness();
    h.engine.running = true;
    h.engine.timer = null;
    h.engine.state.scheduler.nextScheduledAt = new Date(h.getNow() - 10 * 60000).toISOString();
    h.engine.watchdogTick();
    assert(h.engine.timer, 'schedule timer re-armed');
    assert.equal(h.engine.schedulerView().lastWatchdogRecoveryReason, 'SCHEDULE_REARMED');
    clearTimeout(h.engine.timer);
    h.engine.running = false;
  });

  await T('budget limits: scheduled ceiling (incl. backfill) and hard daily limit enforced', async () => {
    const h = await freshHarness({ hardDailyCredits:600, scheduledCreditCeiling:540 });
    h.budget.state.usedCredits = 539;
    let g = await h.budget.reserve({ key:'k1', purpose:'scheduled', cost:1 });
    assert.equal(g.ok, true, '540th scheduled credit allowed');
    await h.budget.complete({ key:'k1', status:200 });
    g = await h.budget.reserve({ key:'k2', purpose:'scheduled', cost:1 });
    assert.equal(g.reason, 'SCHEDULED_CREDIT_CEILING_REACHED');
    g = await h.budget.reserve({ key:'k3', purpose:'backfill', cost:1 });
    assert.equal(g.reason, 'SCHEDULED_CREDIT_CEILING_REACHED', 'backfill counts against the 540 scheduled ceiling');
    h.budget.state.usedCredits = 600;
    g = await h.budget.reserve({ key:'k4', purpose:'manual', cost:1 });
    assert.equal(g.reason, 'DAILY_HARD_CREDIT_LIMIT_REACHED', '600 hard limit is absolute');
    assert.equal(h.budget.view().usedCredits, 600, 'rejected reservations charge nothing');
  });

  // ---------------------------------------------------------------- safety rails
  await T('zero writes to /var/data/alps/v11 (v11 root untouched by all forex paths)', async () => {
    const h = await engineHarness();
    h.engine.provider.fetchImpl = async () => response({ body:{ meta:{}, values: tdValues(h.getNow() - 2 * INTERVAL, 30) } });
    await h.engine.runCycle('scheduled');
    assert.throws(() => h.storage.assertV12Write(path.join(h.config.legacyRoot, 'x.json')), /V11_WRITE_BLOCKED|WRITE_OUTSIDE_V12_ROOT_BLOCKED/);
    assert.equal(fs.existsSync(h.config.legacyRoot), false, 'no file or directory ever created under the v11 root');
  });

  await T('crypto behavior unchanged: canonical 5m, local derivation, continuity, config policy', async () => {
    const start = Date.UTC(2026, 0, 1);
    const raw = Array.from({ length:36 }, (_, i) => ({ t:start + i*INTERVAL, o:100+i, h:102+i, l:98+i, c:101+i, v:1, closeTime:start + i*INTERVAL + INTERVAL - 1 }));
    const cleaned = cleanCandles(raw, { now:start + 40*INTERVAL, intervalMs:INTERVAL, closeBufferMs:15000, staleMs:INTERVAL*4, assetClass:'CRYPTO', removeFlat:true, preserveFlatForAggregation:true });
    assert.equal(cleaned.candles.length, 36);
    const audit = auditContinuity(cleaned.candles, INTERVAL);
    assert.equal(audit.continuityPassed, true);
    assert.equal(audit.missingBars, 0);
    const derived = aggregateCanonicalCandles(cleaned.candles, INTERVAL, 900000);
    assert.equal(derived.length, 12, '15m still derived locally from complete closed 5m buckets');
    assert.deepEqual(CRYPTO_FRAMES.map(f => f.key), ['5m','15m','30m','1h','4h']);
    const cfg = loadConfig();
    assert.equal(cfg.crypto.backfillCoverageDays >= 30, true);
    assert.equal(cfg.paperOnly, true);
    assert.equal(cfg.legacyEngineEnabled, false);
    assert.equal(cfg.newsEnabled, false);
    assert.equal(FOREX_PAIRS.length, 9, 'nine forex markets unchanged');
    assert.equal(FOREX_PAIRS.some(p => /UKOIL/i.test(p.canonical)), false, 'UKOIL stays disabled');
  });

  await T('version and problem codes are v12.0.4.4', async () => {
    assert.equal(VERSION, 'v12.0.6-evidence-statistical-scoring');
    const h = await engineHarness();
    // Force diagnostics: expired lease + old successful cycle → operational problems.
    h.engine.lease.acquire({ owner:'twelve-data-provider', purpose:'scheduled', pair:'EUR/USD', operation:'LIVE_REFRESH' });
    h.engine.running = true;
    h.setNow(h.getNow() + h.engine.lease.durationMs() + 5000);
    h.engine.state.scheduler.lastSuccessfulCycleAt = new Date(h.getNow() - 3 * h.config.forex.refreshIntervalMs).toISOString();
    const codes = h.engine.problems().map(p => p.code);
    assert(codes.includes('FOREX_REQUEST_LEASE_EXPIRED'), 'FOREX_REQUEST_LEASE_EXPIRED emitted');
    assert(codes.includes('FOREX_SCHEDULER_STALLED'), 'FOREX_SCHEDULER_STALLED emitted');
    h.engine.running = false;
    const rec = h.engine.lease.recover('TEST_CLEANUP');
    assert(rec, 'cleanup');
  });

  console.log(JSON.stringify({ status:'PASS', version:VERSION, tests:results.length, names:results }, null, 2));
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
