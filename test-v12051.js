#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const {
  SafeStorage,
  CryptoForwardShadowCandidateEngine,
  deriveCryptoCandidateSetup,
  CRYPTO_HYPOTHESIS_FAMILIES,
  VERSION,
  CANDIDATE_ENGINE_VERSION,
} = require('./v1202-bundle');

const INTERVAL = 300000;
const START = Date.UTC(2026, 6, 24, 0, 0, 0, 0);
function bar(t, o, h, l, c) { return { t, o, h, l, c, v: 1, closeTime: t + INTERVAL - 1, validForSignals: true, validForAggregation: true }; }
function breakoutSeries() {
  const rows = [];
  let close = 100;
  for (let i = 0; i < 79; i++) {
    const o = close;
    close = 100 + i * 0.005;
    rows.push(bar(START + i * INTERVAL, o, Math.max(o, close) + 0.12, Math.min(o, close) - 0.12, close));
  }
  const t = START + 79 * INTERVAL;
  rows.push(bar(t, 100.38, 102.2, 100.3, 102));
  return rows;
}
function config(root) {
  const dataRoot = path.join(root, 'v12');
  return {
    dataRoot,
    legacyRoot: path.join(root, 'v11'),
    forex: { rawDir: path.join(dataRoot, 'raw'), cleanDir: path.join(dataRoot, 'clean') },
    crypto: {
      rawDir: path.join(dataRoot, 'crypto', 'raw'),
      cleanDir: path.join(dataRoot, 'crypto', 'clean'),
      provisionalCandidateStateFile: path.join(dataRoot, 'state', 'crypto-forward-shadow-candidate-engine.json'),
      provisionalCandidateLedgerFile: path.join(dataRoot, 'evidence', 'crypto-forward-shadow-ledger.ndjson'),
      certifiedCandidateStateFile: path.join(dataRoot, 'state', 'crypto-forward-shadow-candidate-engine-v12051.json'),
      certifiedCandidateLedgerFile: path.join(dataRoot, 'evidence', 'crypto-forward-shadow-ledger-v12051.ndjson'),
      provisionalCandidateManifestFile: path.join(dataRoot, 'evidence', 'crypto-forward-shadow-v1205-provisional-manifest.json'),
      candidateRecentClosedLimit: 200,
    },
    cryptoFrames: [{ key: '5m', provider: '5m', intervalMs: INTERVAL }],
  };
}

(async () => {
  const tests = [];
  const T = async (name, fn) => { await fn(); tests.push(name); };
  await T('release and candidate-engine versions', async () => { assert.equal(VERSION, 'v12.0.6-evidence-statistical-scoring'); assert.equal(CANDIDATE_ENGINE_VERSION, 'v12.0.5.1-forward-time-integrity-guard'); });
  await T('five hypothesis families preserved', async () => assert.deepEqual(CRYPTO_HYPOTHESIS_FAMILIES, ['TREND_CONTINUATION', 'MEAN_REVERSION', 'BREAKOUT_CONTINUATION', 'VOLATILITY_EXPANSION', 'MOMENTUM_REVERSAL']));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v12051-'));
  const c = config(root);
  const storage = new SafeStorage(c);
  await storage.init();
  await storage.writeJsonAtomic(c.crypto.provisionalCandidateStateFile, {
    schema: 'alps.gen2.cryptoForwardShadowCandidateEngine.v1205',
    version: 'v12.0.5-forward-shadow-candidate-engine',
    performance: { totalCandidates: 191, activeCandidates: 143, closedCandidates: 48, scoredLegs: 228, netR: 64 },
  });
  await storage.appendNdjson(c.crypto.provisionalCandidateLedgerFile, { schema: 'alps.gen2.cryptoForwardShadowLedgerEvent.v1205', type: 'CANDIDATE_OPENED' });

  const symbol = { canonical: 'BTC/USDT', key: 'BTCUSDT', provider: 'BTCUSDT' };
  const frame = c.cryptoFrames[0];
  const candles = breakoutSeries();
  const signal = candles.at(-1);
  let now = signal.t;
  const foundationEpochAt = new Date(START - INTERVAL).toISOString();
  const engine = new CryptoForwardShadowCandidateEngine({ config: c, storage, now: () => now, log: () => {} });
  await engine.load(foundationEpochAt);

  await T('v1205 ledger is preserved and excluded', async () => {
    assert.equal(engine.state.provisionalV1205Ledger.classification, 'PROVISIONAL_V1205_LEDGER');
    assert.equal(engine.state.provisionalV1205Ledger.totalCandidates, 191);
    assert.equal(engine.state.provisionalV1205Ledger.netR, 64);
    assert.equal(engine.state.performance.totalCandidates, 0);
    assert.equal(engine.state.performance.netR, 0);
    assert.equal(fs.existsSync(c.crypto.provisionalCandidateStateFile), true);
    assert.equal(fs.existsSync(c.crypto.provisionalCandidateLedgerFile), true);
    assert.equal(fs.existsSync(c.crypto.provisionalCandidateManifestFile), true);
  });
  await T('candidate engine has a new independent epoch', async () => {
    assert.equal(engine.state.foundationEpochAt, foundationEpochAt);
    assert.equal(engine.state.candidateEngineEpochAt, new Date(signal.t).toISOString());
    assert.notEqual(engine.state.candidateEngineEpochAt, foundationEpochAt);
  });

  engine.beginCycle('pre-epoch');
  const pre = await engine.evaluateFrame({ symbol, frame, candles: candles.slice(0, -1), audit: { continuityPassed: true }, frameState: { cleanRows: candles.length - 1, stale: false } });
  await engine.completeCycle();
  await T('historical pre-engine candle is not nominated', async () => {
    assert.equal(engine.performanceView().totalNominations, 0);
    assert.equal(pre.BREAKOUT_CONTINUATION.candidateProduced, false);
  });

  now = signal.closeTime + 1000;
  const setup = deriveCryptoCandidateSetup({ family: 'BREAKOUT_CONTINUATION', candles, symbol, frame, epochMs: Date.parse(engine.state.candidateEngineEpochAt) });
  assert.equal(setup.produced, true);
  engine.beginCycle('nominate');
  const nominatedResults = await engine.evaluateFrame({ symbol, frame, candles, audit: { continuityPassed: true }, frameState: { cleanRows: candles.length, stale: false } });
  await engine.completeCycle();
  const candidateId = nominatedResults.BREAKOUT_CONTINUATION.candidateId;
  let candidate = engine.state.pendingCandidates[candidateId];
  await T('post-epoch signal creates nomination only', async () => {
    assert(candidate);
    assert.equal(candidate.status, 'PENDING_FORWARD_ENTRY');
    assert.equal(candidate.paperEntryAt, null);
    assert.equal(engine.performanceView().totalCandidates, 0);
    assert.equal(engine.performanceView().totalNominations >= 1, true);
  });
  await T('nomination is never backdated', async () => {
    assert.equal(candidate.createdAt, candidate.nominatedAt);
    assert(Date.parse(candidate.createdAt) > Date.parse(candidate.signalCandleCloseAt));
  });

  const partialStart = signal.t + INTERVAL;
  const partial = bar(partialStart, setup.entry, setup.entry * 1.0002, setup.entry * 0.9998, setup.entry);
  now = partial.closeTime + 1000;
  engine.beginCycle('partial-candle-must-not-enter');
  await engine.evaluateFrame({ symbol, frame, candles: [...candles, partial], audit: { continuityPassed: true }, frameState: { cleanRows: candles.length + 1, stale: false } });
  await engine.completeCycle();
  await T('candle that began before nomination cannot open entry', async () => {
    assert(engine.state.pendingCandidates[candidateId]);
    assert.equal(engine.state.openCandidates[candidateId], undefined);
  });

  const entryStart = partialStart + INTERVAL;
  const entryCandle = bar(entryStart, setup.entry, setup.entry * 1.0002, setup.entry * 0.9998, setup.entry);
  now = entryCandle.closeTime + 1000;
  engine.beginCycle('strict-forward-entry');
  await engine.evaluateFrame({ symbol, frame, candles: [...candles, partial, entryCandle], audit: { continuityPassed: true }, frameState: { cleanRows: candles.length + 2, stale: false } });
  await engine.completeCycle();
  candidate = engine.state.openCandidates[candidateId];
  await T('first fully post-nomination closed candle opens paper entry', async () => {
    assert(candidate);
    assert.equal(candidate.entryValidation, 'FIRST_FULLY_POST_NOMINATION_CLOSED_CANDLE_CLOSE_INSIDE_ENTRY_ZONE');
    assert.equal(candidate.paperEntryAt, new Date(entryCandle.closeTime).toISOString());
    assert.equal(candidate.entryCandleOpenAt, new Date(entryCandle.t).toISOString());
  });
  await T('entry and legs satisfy temporal integrity', async () => {
    assert(Date.parse(candidate.paperEntryAt) >= Date.parse(candidate.createdAt));
    assert(Date.parse(candidate.entryCandleOpenAt) >= Date.parse(candidate.createdAt));
    for (const leg of candidate.legs) assert(Date.parse(leg.openedAt) >= Date.parse(candidate.createdAt));
    assert.equal(engine.state.temporalIntegrity.status, 'PASS');
    assert.equal(engine.state.temporalIntegrity.violations, 0);
  });
  await T('economic evidence cluster is independent of family', async () => {
    const sibling = { ...setup, family: 'VOLATILITY_EXPANSION', hypothesisId: 'CRYPTO-BTCUSDT-5m-VOLATILITY_EXPANSION' };
    assert.equal(engine.clusterId(setup), engine.clusterId(sibling));
  });

  const risk = candidate.riskDistance;
  const lifecycleStart = entryStart + INTERVAL;
  const both = bar(lifecycleStart, candidate.entry, candidate.legs.find(l => l.rr === 1).target + risk * 0.01, candidate.initialStop - risk * 0.01, candidate.entry);
  now = both.closeTime + 1000;
  engine.beginCycle('strict-lifecycle');
  await engine.evaluateFrame({ symbol, frame, candles: [...candles, partial, entryCandle, both], audit: { continuityPassed: true }, frameState: { cleanRows: candles.length + 3, stale: false } });
  await engine.completeCycle();
  const closed = engine.state.recentClosedCandidates.find(x => x.candidateId === candidateId);
  await T('intrabar both-touched remains unscored', async () => {
    assert(closed);
    const r1 = closed.legs.find(l => l.rr === 1);
    assert.equal(r1.status, 'AMBIGUOUS_BOTH_TOUCHED');
    assert.equal(r1.resultR, null);
  });
  await T('closures use candle close time and observation time separately', async () => {
    const r1 = closed.legs.find(l => l.rr === 1);
    assert.equal(r1.closedAt, new Date(both.closeTime).toISOString());
    assert.notEqual(r1.closedAt, new Date(both.t).toISOString());
    assert(Date.parse(r1.closedObservedAt) >= Date.parse(r1.closedAt));
    const events = await engine.ledgerTail(1000);
    const event = events.find(e => e.type === 'LEG_CLOSED_AMBIGUOUS' && e.candidateId === candidateId);
    assert(event);
    assert.equal(event.candleOpenAt, new Date(both.t).toISOString());
    assert.equal(event.candleCloseAt, new Date(both.closeTime).toISOString());
    assert(Date.parse(event.observedAt) >= Date.parse(event.candleCloseAt));
  });

  await T('certified state and epoch survive restart', async () => {
    await engine.persist();
    now += INTERVAL;
    const restored = new CryptoForwardShadowCandidateEngine({ config: c, storage, now: () => now, log: () => {} });
    await restored.load(foundationEpochAt);
    assert.equal(restored.state.candidateEngineEpochAt, engine.state.candidateEngineEpochAt);
    assert.equal(restored.performanceView().totalCandidates, engine.performanceView().totalCandidates);
    assert.equal(restored.state.temporalIntegrity.status, 'PASS');
  });

  await T('entry zone expiry is recorded instead of backdated opening', async () => {
    const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v12051-expiry-'));
    const c3 = config(root3);
    const s3 = new SafeStorage(c3);
    await s3.init();
    let n3 = signal.t;
    const e3 = new CryptoForwardShadowCandidateEngine({ config: c3, storage: s3, now: () => n3 });
    await e3.load(foundationEpochAt);
    n3 = signal.closeTime + 1000;
    e3.beginCycle('expiry-nomination');
    const nomination = await e3.nominateCandidate(setup);
    const expiryStart = signal.t + 2 * INTERVAL;
    const outsideClose = setup.entryZoneHigh + Math.max(setup.riskDistance, 1);
    const outside = bar(expiryStart, outsideClose, outsideClose * 1.0001, outsideClose * 0.9999, outsideClose);
    n3 = outside.closeTime + 1000;
    await e3.processPendingForFrame(symbol.key, frame.key, [outside]);
    await e3.completeCycle();
    assert.equal(e3.state.openCandidates[nomination.candidateId], undefined);
    assert.equal(e3.state.pendingCandidates[nomination.candidateId], undefined);
    const expired = e3.state.recentExpiredCandidates.find(x => x.candidateId === nomination.candidateId);
    assert(expired);
    assert.equal(expired.status, 'ENTRY_ZONE_EXPIRED_BEFORE_FORWARD_ENTRY');
    assert.equal(e3.performanceView().entryExpired, 1);
  });

  await T('temporal guard detects injected backdating', async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v12051-violation-'));
    const c2 = config(root2);
    const s2 = new SafeStorage(c2);
    await s2.init();
    let n2 = START;
    const e2 = new CryptoForwardShadowCandidateEngine({ config: c2, storage: s2, now: () => n2 });
    await e2.load(foundationEpochAt);
    e2.state.openCandidates.BAD = {
      candidateId: 'BAD', status: 'OPEN_PAPER', createdAt: new Date(START + INTERVAL).toISOString(), nominatedAt: new Date(START + INTERVAL).toISOString(),
      paperEntryAt: new Date(START).toISOString(), entryCandleOpenAt: new Date(START).toISOString(), legs: [],
    };
    const result = e2.validateTemporalIntegrity();
    assert.equal(result.status, 'FAIL');
    assert.equal(e2.state.temporalIntegrity.status, 'FAIL');
    assert.equal(e2.state.temporalIntegrity.lastViolation.code, 'PAPER_ENTRY_BEFORE_CREATION');
  });

  await T('v11 remains read-only', async () => assert.throws(() => storage.assertV12Write(path.join(c.legacyRoot, 'blocked.json')), /V11_WRITE_BLOCKED|WRITE_OUTSIDE_V12_ROOT_BLOCKED/));
  await T('no live order endpoint exists', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'v1202-bundle.js'), 'utf8');
    assert(!source.includes('/api/v3/order'));
    assert(!source.includes('/fapi/v1/order'));
    assert(source.includes('FORWARD_TEMPORAL_INTEGRITY_VIOLATION'));
  });

  console.log(JSON.stringify({
    status: 'PASS',
    version: VERSION,
    tests: tests.length,
    names: tests,
    candidateEngineEpochAt: engine.state.candidateEngineEpochAt,
    temporalIntegrity: engine.state.temporalIntegrity,
    performance: engine.performanceView(),
    provisionalV1205Ledger: engine.state.provisionalV1205Ledger,
  }, null, 2));
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
