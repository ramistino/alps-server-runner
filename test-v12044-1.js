#!/usr/bin/env node
'use strict';

// v12.0.5.1-forward-time-integrity-guard — corrective suite.
// Proves: (1) a delayed REQUEST_RESERVED write cannot overwrite a newer HTTP 429 state,
// (2) a delayed lease-acquisition write cannot overwrite a newer released-lease state,
// (3) three writes completing physically in reverse delay order still leave the highest
// revision on disk, (4) a persistence timeout does not break scheduler progress,
// (5) an active 429 breaker remains persisted (and pending-retried) after delayed or
// failed older writes. Fully offline; no API keys.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SafeStorage, PersistenceQueue, RequestLease, BudgetGuard, TwelveDataProvider,
  ForexEngine, CRYPTO_FRAMES, VERSION,
} = require('./v1202-bundle');

const INTERVAL = 300000;
const FIXED_NOW = Date.UTC(2026, 6, 23, 12, 0, 0, 0); // Thursday — FX market open.
const sleep = ms => new Promise(res => setTimeout(res, ms));

function makeConfig(tempRoot, overrides = {}) {
  const dataRoot = path.join(tempRoot, 'v12');
  return {
    dataRoot, legacyRoot: path.join(tempRoot, 'v11'),
    forexPairs: [
      { canonical:'EUR/USD', key:'EURUSD', provider:'EUR/USD' },
      { canonical:'GBP/USD', key:'GBPUSD', provider:'GBP/USD' },
    ],
    cryptoSymbols: [], cryptoFrames: CRYPTO_FRAMES,
    forex: {
      apiKey:'test-key-not-real', providerBaseUrl:'https://api.twelvedata.example',
      interval:'5min', intervalMs:INTERVAL, refreshIntervalMs:30*60000,
      minLiveRequestGapMs:1, interSymbolDelayMs:0, requestTimeoutMs:120,
      leaseSafetyMarginMs:80, persistTimeoutMs:10, watchdogIntervalMs:30000,
      backfillMaxRequestsPerCycle:3, backfillCycleYieldMarginMs:60000,
      staleMarketDataMs:90*60000, candleCloseBufferMs:30000,
      backfillCoverageDays:180, backfillOutputSize:5000, liveOutputSize:500,
      hardDailyCredits:600, scheduledCreditCeiling:540,
      rawDir:path.join(dataRoot,'raw'), cleanDir:path.join(dataRoot,'clean'),
      stateFile:path.join(dataRoot,'state','forex-core-state.json'),
      budgetFile:path.join(dataRoot,'state','twelve-data-budget.json'),
      leaseFile:path.join(dataRoot,'state','twelve-data-request-lease.json'),
      migrationFile:path.join(dataRoot,'state','v11-readonly-import.json'),
      hypothesesFile:path.join(dataRoot,'hypotheses','forex-hypotheses.json'),
      ...overrides,
    },
    crypto: { rawDir:path.join(dataRoot,'crypto','raw'), cleanDir:path.join(dataRoot,'crypto','clean') },
    importLegacyOnStartup:false,
  };
}

// Delay-scripted storage: write N takes delays[N-1] ms (default fast), snapshots the
// payload at rename time, records commit order.
function delayedStorage(delays = {}) {
  let call = 0;
  const files = new Map();          // file -> last committed payload
  const commits = [];               // { call, file, status }
  return {
    call: () => call,
    files, commits,
    readJson: async () => null,
    writeJsonAtomic: async (file, payload) => {
      const id = ++call;
      const snapshot = JSON.parse(JSON.stringify(payload));
      const plan = delays[id];
      if (plan && plan.failWith) { await sleep(plan.delayMs || 0); throw new Error(plan.failWith); }
      await sleep((plan && plan.delayMs) || 2);
      files.set(file, snapshot);
      commits.push({ call:id, file, status:snapshot.status ?? snapshot.leaseActive ?? snapshot.marker ?? null });
    },
  };
}

function tdValues(endMs, count) {
  const rows = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const t = endMs - i * INTERVAL;
    rows.push({ t, o:1.10, h:1.12, l:1.09, c:1.11 + (i % 7) * 0.0001, v:1, closeTime:t + INTERVAL - 1 });
  }
  return rows;
}
function response({ status = 200, body = null }) {
  return { status, ok: status >= 200 && status < 300, headers:{ get: () => null }, text: async () => JSON.stringify(body) };
}

(async () => {
  const results = [];
  const T = async (name, fn) => { await fn(); results.push(name); };

  await T('delayed REQUEST_RESERVED write cannot overwrite a newer HTTP 429 state', async () => {
    // Write #1 (REQUEST_RESERVED) delayed 100 ms; persistTimeoutMs = 10 ms; the 429
    // completion write takes 5 ms. Ordering guard must leave the 429 on disk.
    const config = makeConfig('/tmp-x', { persistTimeoutMs:10 });
    const storage = delayedStorage({ 1:{ delayMs:100 }, 2:{ delayMs:5 } });
    const now = () => Date.parse('2026-07-23T12:00:00.000Z');
    const budget = new BudgetGuard({ config, storage, now });
    budget.state = budget.empty();
    await budget.reserve({ key:'time_series:EURUSD:live', purpose:'scheduled', cost:1 });
    await budget.complete({ key:'time_series:EURUSD:live', status:429, error:'rate limited' });
    await sleep(200);
    const persisted = storage.files.get(config.forex.budgetFile);
    assert.equal(budget.state.status, 'HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY');
    assert.equal(persisted.status, 'HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY', `stale write must not win (got ${persisted.status})`);
    assert(persisted.blockedUntil, 'blockedUntil must remain persisted');
    assert.equal(budget.circuitBreakerPersistencePending(), false, 'breaker durably committed');
    // The queue serialized: the slow write finished first, THEN the newer revision was
    // written — never the reverse.
    assert.equal(storage.commits.at(-1).status, 'HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY');
  });

  await T('delayed lease-acquisition write cannot overwrite a newer released-lease state', async () => {
    const config = makeConfig('/tmp-x', { persistTimeoutMs:10 });
    const storage = delayedStorage({ 1:{ delayMs:100 }, 2:{ delayMs:5 } });
    const lease = new RequestLease({ config, storage, now:() => Date.now(), log:() => {} });
    const got = lease.acquire({ owner:'twelve-data-provider', purpose:'scheduled', pair:'EUR/USD', operation:'LIVE_REFRESH' }); // write #1 (active), 100 ms
    assert.equal(got.ok, true);
    lease.release(got.leaseId, 'REQUEST_FINISHED'); // write #2 (released), 5 ms
    await sleep(200);
    const persisted = storage.files.get(config.forex.leaseFile);
    assert.equal(lease.view().leaseActive, false);
    assert.equal(persisted.leaseActive, false, 'stale active-lease snapshot must not overwrite released state');
    assert.equal(persisted.leaseId, null);
  });

  await T('three writes completing physically in reverse delay order still leave the highest revision on disk', async () => {
    const storage = delayedStorage({ 1:{ delayMs:120 }, 2:{ delayMs:60 }, 3:{ delayMs:5 } });
    const queue = new PersistenceQueue({ storage });
    const file = '/tmp-x/v12/state/ordering.json';
    const r1 = queue.enqueue(file, { marker:'rev-A' });
    // Serialized queue: write #1 starts immediately; rev-B is coalesced away by rev-C
    // while #1 is still on the "disk"; only rev-C is physically written afterward.
    const r2 = queue.enqueue(file, { marker:'rev-B' });
    const r3 = queue.enqueue(file, { marker:'rev-C' });
    assert(r1.revision < r2.revision && r2.revision < r3.revision, 'monotonic persistRevision');
    const done = await r3.done;
    assert.equal(done.ok, true);
    await sleep(50);
    assert.equal(storage.files.get(file).marker, 'rev-C', 'highest revision wins on disk');
    const v = queue.view(file);
    assert.equal(v.committedRevision, r3.revision);
    assert(v.writesCoalesced >= 1, 'obsolete pending revision replaced by newest snapshot');
    assert(v.writesStarted <= 2, 'only one physical write per file at a time, older pending coalesced');
  });

  await T('a persistence timeout does not break scheduler progress', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v12441-'));
    const config = makeConfig(tempRoot, { persistTimeoutMs:5 });
    const storage = new SafeStorage(config); await storage.init();
    // Every real disk write is slowed past persistTimeoutMs.
    const realWrite = storage.writeJsonAtomic.bind(storage);
    storage.writeJsonAtomic = async (file, payload) => { await sleep(25); return realWrite(file, payload); };
    let virtualNow = FIXED_NOW;
    const engine = new ForexEngine({ config, storage, now:() => virtualNow, log:() => {} });
    await engine.budget.load(); await engine.lease.load();
    engine.state.startedAt = new Date(virtualNow).toISOString();
    engine.provider.fetchImpl = async () => response({ body:{ meta:{}, values: tdValues(virtualNow - 2 * INTERVAL, 30) } });
    const out = await engine.runCycle('scheduled');
    assert.equal(out.status, 'ONLINE', 'cycle completes despite every persist timing out for its caller');
    const sv = engine.schedulerView();
    assert.equal(sv.cycleInFlight, false);
    assert.equal(sv.leaseActive, false);
    assert.equal(sv.liveRefreshCompletedPairs, 2);
    const flushed = await engine.flushPersistence(3000);
    assert.equal(flushed.ok, true, 'bounded shutdown flush drains queued writes');
    const onDisk = JSON.parse(fs.readFileSync(config.forex.stateFile, 'utf8'));
    assert(onDisk.scheduler, 'latest scheduler state reached disk after flush');
  });

  await T('active 429 breaker remains persisted after delayed and failed older writes (durable retry, no HTTP retry)', async () => {
    const config = makeConfig('/tmp-x', { persistTimeoutMs:10 });
    // Write #1: reserve persist, slow. Write #2: the durable 429 write FAILS. Write #3:
    // the queue's asynchronous DISK retry succeeds.
    const storage = delayedStorage({ 1:{ delayMs:80 }, 2:{ delayMs:5, failWith:'EIO durable attempt failed' }, 3:{ delayMs:5 } });
    const now = () => Date.parse('2026-07-23T12:00:00.000Z');
    const queue = new PersistenceQueue({ storage, retryDelayMs:20 });
    const budget = new BudgetGuard({ config, storage, now, persistQueue:queue });
    budget.state = budget.empty();
    let httpCalls = 0;
    const lease = new RequestLease({ config, storage:{ readJson:async()=>null, writeJsonAtomic:async()=>{} }, now, log:() => {} });
    const provider = new TwelveDataProvider({
      config, budget, lease,
      fetchImpl: async () => { httpCalls++; return response({ status:429, body:{ code:429, message:'rate limited' } }); },
    });
    const out = await provider.fetch({ canonical:'EUR/USD', key:'EURUSD', provider:'EUR/USD' }, { purpose:'scheduled' });
    assert.equal(out.status, 429);
    assert.equal(lease.view().leaseActive, false, 'lease released after durable enqueue');
    // Immediately after the failed first attempt the breaker is pending, not lost.
    assert.equal(budget.circuitBreakerPersistencePending(), true, 'circuitBreakerPersistencePending retained after failed disk attempt');
    await sleep(250); // allow queued slow write #1 + async durable retry #3
    assert.equal(budget.circuitBreakerPersistencePending(), false, 'disk retry committed the breaker');
    const persisted = storage.files.get(config.forex.budgetFile);
    assert.equal(persisted.status, 'HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY');
    assert(persisted.blockedUntil, 'breaker durable on disk');
    assert.equal(httpCalls, 1, 'only the DISK persistence was retried — never the Twelve Data HTTP request');
    assert.equal(budget.isBlocked(), true);
  });

  await T('shutdown flush honors a bounded deadline even with a wedged disk', async () => {
    const storage = { readJson:async()=>null, writeJsonAtomic:() => new Promise(() => {}) }; // never settles
    const queue = new PersistenceQueue({ storage });
    queue.enqueue('/tmp-x/wedged.json', { marker:'x' });
    const started = Date.now();
    const flushed = await queue.flush(150);
    assert.equal(flushed.ok, false);
    assert.equal(flushed.reason, 'FLUSH_DEADLINE_REACHED');
    assert(Date.now() - started < 1500, 'flush returns at the deadline, never hangs shutdown');
  });

  await T('version is v12.0.4.4.2', async () => {
    assert.equal(VERSION, 'v12.0.6-evidence-statistical-scoring');
  });

  console.log(JSON.stringify({ status:'PASS', version:VERSION, tests:results.length, names:results }, null, 2));
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
