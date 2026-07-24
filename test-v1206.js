#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  SafeStorage,
  PersistenceQueue,
  EvidenceStatisticalScoringEngine,
  MultiMarketServer,
  VERSION,
  CANDIDATE_ENGINE_VERSION,
} = require('./v1202-bundle');
const { DEFAULT_THRESHOLDS } = require('./evidence-scoring-v1206');

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}
function config(root) {
  const dataRoot = path.join(root, 'v12');
  const legacyRoot = path.join(root, 'v11');
  return {
    version: VERSION,
    dataRoot,
    legacyRoot,
    forex: { rawDir: path.join(dataRoot, 'raw'), cleanDir: path.join(dataRoot, 'clean') },
    crypto: {
      rawDir: path.join(dataRoot, 'crypto', 'raw'),
      cleanDir: path.join(dataRoot, 'crypto', 'clean'),
      certifiedCandidateLedgerFile: path.join(dataRoot, 'evidence', 'crypto-forward-shadow-ledger-v12051.ndjson'),
    },
    scoring: {
      enabled: true,
      certifiedLedgerFile: path.join(dataRoot, 'evidence', 'crypto-forward-shadow-ledger-v12051.ndjson'),
      clusterOutcomesFile: path.join(dataRoot, 'evidence', 'scoring', 'cluster-outcomes.ndjson'),
      hypothesisScoresFile: path.join(dataRoot, 'evidence', 'scoring', 'hypothesis-scores.ndjson'),
      snapshotsFile: path.join(dataRoot, 'evidence', 'statistical-scoring-snapshots.ndjson'),
      stateFile: path.join(dataRoot, 'state', 'evidence-scoring-state.json'),
      thresholds: { ...DEFAULT_THRESHOLDS },
    },
  };
}
function certifiedEvent(sequence, type, payload = {}) {
  const observedAt = payload.observedAt || new Date(Date.UTC(2026, 6, 24, 10, 0, sequence)).toISOString();
  const copy = { ...payload };
  delete copy.observedAt;
  return {
    schema: 'alps.gen2.cryptoForwardShadowLedgerEvent.v12051',
    version: CANDIDATE_ENGINE_VERSION,
    sequence,
    eventId: `TEST-E${sequence}`,
    type,
    evidenceClass: 'CERTIFIED_FORWARD_V12051',
    paperOnly: true,
    liveCapitalExecution: false,
    ...copy,
    observedAt,
    at: observedAt,
  };
}
function nomination(sequence, { candidateId, clusterId, hypothesisId, family, direction = 'LONG', symbol = 'BTC/USDT', timeframe = '5m', signalMs = Date.UTC(2026, 6, 24, 9, 55) }) {
  return certifiedEvent(sequence, 'CANDIDATE_NOMINATED', {
    candidateId, evidenceClusterId: clusterId, hypothesisId, family, direction, symbol, timeframe,
    signalCandleOpenAt: new Date(signalMs).toISOString(), signalCandleCloseAt: new Date(signalMs + 299999).toISOString(),
    nominatedAt: new Date(signalMs + 360000).toISOString(), entryZoneLow: 99, entryZoneHigh: 101, plannedInitialStop: direction === 'LONG' ? 99 : 101,
  });
}
function opened(sequence, base, { entry = 100, stop = 99, entryMs = Date.UTC(2026, 6, 24, 10, 5) } = {}) {
  const risk = Math.abs(entry - stop);
  const long = base.direction !== 'SHORT';
  return certifiedEvent(sequence, 'CANDIDATE_FORWARD_ENTRY_OPENED', {
    candidateId: base.candidateId, evidenceClusterId: base.clusterId, hypothesisId: base.hypothesisId, family: base.family,
    direction: base.direction || 'LONG', symbol: base.symbol || 'BTC/USDT', timeframe: base.timeframe || '5m',
    nominatedAt: new Date(entryMs - 300000).toISOString(), entryCandleOpenAt: new Date(entryMs).toISOString(),
    entryCandleCloseAt: new Date(entryMs + 299999).toISOString(), paperEntryAt: new Date(entryMs + 299999).toISOString(),
    entry, initialStop: stop,
    targets: [1, 2, 5].map(rr => ({ rr, target: long ? entry + risk * rr : entry - risk * rr })),
  });
}
function leg(sequence, base, rr, resultR, type = 'LEG_STOP_HIT', closeMs = Date.UTC(2026, 6, 24, 10, 15)) {
  return certifiedEvent(sequence, type, {
    candidateId: base.candidateId, evidenceClusterId: base.clusterId, rr,
    candleOpenAt: new Date(closeMs).toISOString(), candleCloseAt: new Date(closeMs + 299999).toISOString(),
    exitPrice: type === 'LEG_CLOSED_AMBIGUOUS' ? undefined : 100 + Number(resultR || 0),
    resultR: type === 'LEG_CLOSED_AMBIGUOUS' ? undefined : resultR,
    closeReason: type,
  });
}
function expired(sequence, base, closeMs = Date.UTC(2026, 6, 24, 10, 10)) {
  return certifiedEvent(sequence, 'CANDIDATE_ENTRY_EXPIRED', {
    candidateId: base.candidateId, evidenceClusterId: base.clusterId,
    reason: 'ENTRY_ZONE_EXPIRED_BEFORE_FORWARD_ENTRY', candleOpenAt: new Date(closeMs).toISOString(), candleCloseAt: new Date(closeMs + 299999).toISOString(),
  });
}
async function makeScorer(root) {
  const c = config(root);
  const storage = new SafeStorage(c);
  await storage.init();
  const queue = new PersistenceQueue({ storage, log: () => {} });
  const scorer = new EvidenceStatisticalScoringEngine({ config: c, storage, persistQueue: queue, log: () => {} });
  await scorer.init();
  return { c, storage, queue, scorer };
}
async function appendEvents(storage, file, events) {
  for (const event of events) await storage.appendNdjson(file, event);
}

(async () => {
  const passed = [];
  const T = async (name, fn) => { await fn(); passed.push(name); };

  await T('release identity and candidate-engine isolation', async () => {
    assert.equal(VERSION, 'v12.0.6-evidence-statistical-scoring');
    assert.equal(CANDIDATE_ENGINE_VERSION, 'v12.0.5.1-forward-time-integrity-guard');
  });
  await T('frozen thresholds', async () => {
    assert.deepEqual(DEFAULT_THRESHOLDS, {
      minScoredClusters: 30, confidenceLevel: 0.95, z: 1.96, primaryLeg: 'R1',
      entryModelStarvedRate: 0.80, entryModelStarvedMinNominations: 25,
    });
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v1206-main-'));
  const { c, storage, scorer } = await makeScorer(root);
  const H1 = 'CRYPTO-BTCUSDT-5m-TREND_CONTINUATION';
  const H2 = 'CRYPTO-BTCUSDT-5m-BREAKOUT_CONTINUATION';
  const H3 = 'CRYPTO-BTCUSDT-5m-MEAN_REVERSION';
  const H4 = 'CRYPTO-BTCUSDT-5m-MOMENTUM_REVERSAL';
  let seq = 1;
  const events = [];
  // Four candidates share one economic cluster. Three attribute to H1, one to H2.
  for (const base of [
    { candidateId: 'A1', clusterId: 'C-DEDUPE', hypothesisId: H1, family: 'TREND_CONTINUATION', direction: 'LONG' },
    { candidateId: 'A2', clusterId: 'C-DEDUPE', hypothesisId: H1, family: 'TREND_CONTINUATION', direction: 'LONG' },
    { candidateId: 'A3', clusterId: 'C-DEDUPE', hypothesisId: H1, family: 'TREND_CONTINUATION', direction: 'LONG' },
    { candidateId: 'A4', clusterId: 'C-DEDUPE', hypothesisId: H2, family: 'BREAKOUT_CONTINUATION', direction: 'LONG' },
  ]) {
    events.push(nomination(seq++, base), opened(seq++, base), leg(seq++, base, 1, 0.5));
  }
  // Opposite direction on the same signal candle creates a conflict group.
  const opp = { candidateId: 'B1', clusterId: 'C-OPPOSITE', hypothesisId: H3, family: 'MEAN_REVERSION', direction: 'SHORT' };
  events.push(nomination(seq++, opp), opened(seq++, opp, { entry: 100, stop: 101 }), leg(seq++, opp, 1, -1));
  // Ambiguous is recorded but excluded from realized statistics.
  const amb = { candidateId: 'C1', clusterId: 'C-AMB', hypothesisId: H4, family: 'MOMENTUM_REVERSAL', direction: 'LONG', signalMs: Date.UTC(2026, 6, 24, 10, 20) };
  events.push(nomination(seq++, amb), opened(seq++, amb, { entryMs: Date.UTC(2026, 6, 24, 10, 30) }), leg(seq++, amb, 1, null, 'LEG_CLOSED_AMBIGUOUS', Date.UTC(2026, 6, 24, 10, 40)));
  // Expired and open clusters feed only funnel/open-tail diagnostics.
  const exp = { candidateId: 'D1', clusterId: 'C-EXP', hypothesisId: H4, family: 'MOMENTUM_REVERSAL', direction: 'LONG', signalMs: Date.UTC(2026, 6, 24, 10, 45) };
  events.push(nomination(seq++, exp), expired(seq++, exp, Date.UTC(2026, 6, 24, 10, 55)));
  const open = { candidateId: 'E1', clusterId: 'C-OPEN', hypothesisId: H4, family: 'MOMENTUM_REVERSAL', direction: 'LONG', signalMs: Date.UTC(2026, 6, 24, 11, 0) };
  events.push(nomination(seq++, open), opened(seq++, open, { entryMs: Date.UTC(2026, 6, 24, 11, 10) }));
  // Advance ledger authority time deterministically without changing the open cluster.
  const pending = { candidateId: 'F1', clusterId: 'C-PENDING', hypothesisId: H4, family: 'MOMENTUM_REVERSAL', direction: 'LONG', signalMs: Date.UTC(2026, 6, 24, 12, 0) };
  events.push(nomination(seq++, pending));
  await appendEvents(storage, c.scoring.certifiedLedgerFile, events);
  await fsp.mkdir(path.dirname(c.scoring.certifiedLedgerFile), { recursive: true });
  const provisionalFile = path.join(c.dataRoot, 'evidence', 'crypto-forward-shadow-ledger.ndjson');
  await storage.appendNdjson(provisionalFile, { schema: 'alps.gen2.cryptoForwardShadowLedgerEvent.v1205', evidenceClass: 'PROVISIONAL_V1205_LEDGER', type: 'LEG_TARGET_HIT', resultR: 999 });
  const candidateState = path.join(c.dataRoot, 'state', 'crypto-forward-shadow-candidate-engine-v12051.json');
  await storage.writeJsonAtomic(candidateState, { immutable: true, openCandidates: 123 });
  const ledgerBefore = sha(c.scoring.certifiedLedgerFile);
  const candidateStateBefore = sha(candidateState);
  const first = await scorer.run('test-main');

  await T('cluster is the statistical unit and family attribution is preserved', async () => {
    assert.equal(first.independentEvaluatedClustersByLeg.R1, 2);
    const h1 = first.latestScores.find(row => row.hypothesisId === H1);
    const h2 = first.latestScores.find(row => row.hypothesisId === H2);
    assert(h1 && h2);
    assert.equal(h1.perLeg.R1.n, 1);
    assert.equal(h2.perLeg.R1.n, 1);
    assert.equal(h1.perLeg.R1.realizedNetR, 0.5);
    assert.equal(h1.candidateMemberCount, 3);
    assert.equal(h2.candidateMemberCount, 1);
    assert.deepEqual(h1.clusterIds, ['C-DEDUPE']);
  });
  await T('positive locked stop is a win and open R is excluded', async () => {
    const h1 = first.latestScores.find(row => row.hypothesisId === H1);
    assert.equal(h1.perLeg.R1.wins, 1);
    assert.equal(h1.perLeg.R1.losses, 0);
    assert.equal(h1.perLeg.R1.netR, 0.5);
    assert.equal(h1.perLeg.R2.netR, 0);
    assert.equal(h1.perLeg.R2.openR, null);
  });
  await T('conflicting directions are diagnostic, not invalidated', async () => {
    const diag = first.diagnostics.conflictBySymbolTimeframe.find(row => row.symbolKey === 'BTCUSDT' && row.timeframe === '5m');
    assert(diag);
    assert(diag.conflictClusters >= 2);
    const h3 = first.latestScores.find(row => row.hypothesisId === H3);
    assert.equal(h3.perLeg.R1.n, 1);
    assert.equal(h3.perLeg.R1.losses, 1);
  });
  await T('ambiguous legs are excluded but measured', async () => {
    const h4 = first.latestScores.find(row => row.hypothesisId === H4);
    assert(h4);
    assert.equal(h4.perLeg.R1.n, 0);
    assert.equal(h4.perLeg.R1.ambiguousClusters, 1);
    assert.equal(h4.perLeg.R1.realizedNetR, 0);
  });
  await T('expired, pending, and open remain funnel diagnostics only', async () => {
    const h4 = first.latestScores.find(row => row.hypothesisId === H4);
    assert.equal(h4.funnel.nominations, 4);
    assert.equal(h4.funnel.entries, 2);
    assert.equal(h4.funnel.expired, 1);
    assert.equal(h4.funnel.pending, 1);
    assert(h4.funnel.openLegs > 0);
    assert(Number.isFinite(h4.funnel.openTailAgeP50Candles));
  });
  await T('sample gate blocks all premature judgments and ranking', async () => {
    for (const row of first.latestScores) {
      assert.equal(row.compositeEvidenceState, 'INSUFFICIENT_EVIDENCE');
      assert.equal(row.judgmentEligible, false);
      assert.equal(row.rankingEligible, false);
      assert.equal(row.promotionEligible, false);
    }
  });
  await T('certified ledger and candidate state are immutable', async () => {
    assert.equal(sha(c.scoring.certifiedLedgerFile), ledgerBefore);
    assert.equal(sha(candidateState), candidateStateBefore);
  });
  await T('provisional ledger is not consumed', async () => {
    assert.equal(first.certifiedOnly, true);
    assert.equal(first.provisionalExcluded, true);
    assert(!stable(first.latestScores).includes('999'));
  });
  await T('writes stay inside scoring outputs and v12 state', async () => {
    const expected = new Set([
      path.resolve(c.scoring.certifiedLedgerFile), path.resolve(provisionalFile), path.resolve(candidateState),
      path.resolve(c.scoring.clusterOutcomesFile), path.resolve(c.scoring.hypothesisScoresFile),
      path.resolve(c.scoring.snapshotsFile), path.resolve(c.scoring.stateFile),
    ]);
    const files = [];
    async function walk(dir) {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(p); else files.push(path.resolve(p));
      }
    }
    await walk(c.dataRoot);
    assert.deepEqual(files.filter(f => !expected.has(f)), []);
    assert.equal(fs.existsSync(c.legacyRoot), false);
  });
  await T('deterministic replay gives identical snapshot and score bytes', async () => {
    const scoreBytes = stable(first.latestScores);
    const secondRootView = await makeScorer(root);
    const second = await secondRootView.scorer.run('determinism-replay');
    assert.equal(second.lastSnapshotId, first.lastSnapshotId);
    assert.equal(stable(second.latestScores), scoreBytes);
    const snapshots = await storage.readNdjson(c.scoring.snapshotsFile);
    assert.equal(snapshots.length, 1, 'same bytes must not append a duplicate snapshot');
  });

  await T('n=29 is insufficient and n=30 activates the confidence judgment', async () => {
    const gateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v1206-gate-'));
    const gate = await makeScorer(gateRoot);
    const H = 'CRYPTO-ETHUSDT-5m-TREND_CONTINUATION';
    let s = 1;
    const first29 = [];
    for (let i = 0; i < 29; i++) {
      const base = { candidateId: `G${i}`, clusterId: `GC${i}`, hypothesisId: H, family: 'TREND_CONTINUATION', direction: 'LONG', symbol: 'ETH/USDT', signalMs: Date.UTC(2026, 6, 25, 0, i * 5) };
      first29.push(nomination(s++, base), opened(s++, base, { entryMs: Date.UTC(2026, 6, 25, 3, i * 5) }), leg(s++, base, 1, 1, 'LEG_TARGET_HIT', Date.UTC(2026, 6, 25, 6, i * 5)));
    }
    await appendEvents(gate.storage, gate.c.scoring.certifiedLedgerFile, first29);
    let view = await gate.scorer.run('n29');
    let row = view.latestScores.find(x => x.hypothesisId === H);
    assert.equal(row.perLeg.R1.n, 29);
    assert.equal(row.perLeg.R1.evidenceState, 'INSUFFICIENT_EVIDENCE');
    const base30 = { candidateId: 'G29', clusterId: 'GC29', hypothesisId: H, family: 'TREND_CONTINUATION', direction: 'LONG', symbol: 'ETH/USDT', signalMs: Date.UTC(2026, 6, 25, 2, 25) };
    await appendEvents(gate.storage, gate.c.scoring.certifiedLedgerFile, [nomination(s++, base30), opened(s++, base30, { entryMs: Date.UTC(2026, 6, 25, 5, 0) }), leg(s++, base30, 1, 1, 'LEG_TARGET_HIT', Date.UTC(2026, 6, 25, 8, 0))]);
    view = await gate.scorer.run('n30');
    row = view.latestScores.find(x => x.hypothesisId === H);
    assert.equal(row.perLeg.R1.n, 30);
    assert.equal(row.perLeg.R1.evidenceState, 'POSITIVE_EVIDENCE');
    assert.equal(row.compositeEvidenceState, 'POSITIVE_EVIDENCE');
    assert.equal(row.perLeg.R1.meanR_LB95, 1);
    assert(row.perLeg.R1.winRateLB95 > 0.88 && row.perLeg.R1.winRateLB95 < 0.90);
    assert.equal((await gate.storage.readNdjson(gate.c.scoring.snapshotsFile)).length, 2);
  });

  await T('ENTRY_MODEL_STARVED uses the frozen cluster funnel threshold', async () => {
    const starvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v1206-starved-'));
    const starved = await makeScorer(starvedRoot);
    const H = 'CRYPTO-SOLUSDT-5m-MEAN_REVERSION';
    let s = 1;
    const rows = [];
    for (let i = 0; i < 25; i++) {
      const base = { candidateId: `S${i}`, clusterId: `SC${i}`, hypothesisId: H, family: 'MEAN_REVERSION', direction: 'LONG', symbol: 'SOL/USDT', signalMs: Date.UTC(2026, 6, 26, 0, i * 5) };
      rows.push(nomination(s++, base));
      if (i < 20) rows.push(expired(s++, base, Date.UTC(2026, 6, 26, 4, i * 5)));
    }
    await appendEvents(starved.storage, starved.c.scoring.certifiedLedgerFile, rows);
    const view = await starved.scorer.run('starved');
    assert.equal(view.diagnostics.entryModelStarved.length, 1);
    assert.equal(view.diagnostics.entryModelStarved[0].expiryRate, 0.8);
    assert(starved.scorer.problems().some(p => p.code === 'ENTRY_MODEL_STARVED' && p.diagnosticOnly === true));
  });

  await T('PersistenceQueue preserves append order', async () => {
    const committed = [];
    const fakeStorage = { appendNdjsonLines: async (_file, lines) => { if (!committed.length) await new Promise(r => setTimeout(r, 20)); committed.push(...lines); }, writeJsonAtomic: async () => {} };
    const q = new PersistenceQueue({ storage: fakeStorage, log: () => {} });
    const a = q.enqueueAppend('/tmp/a.ndjson', ['A']);
    const b = q.enqueueAppend('/tmp/a.ndjson', ['B']);
    assert((await a.done).ok);
    assert((await b.done).ok);
    assert.deepEqual(committed, ['A', 'B']);
  });

  await T('evidence endpoint exposes v1206 without live or promotion controls', async () => {
    const fakeEngine = { crypto: { evidenceScorer: scorer } };
    const server = new MultiMarketServer({ config: { host: '127.0.0.1', port: 0, token: '' }, engine: fakeEngine, log: () => {} });
    await server.start();
    const port = server.server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/runner/forward-shadow/evidence`);
    const body = await response.json();
    await server.stop();
    assert.equal(response.status, 200);
    assert.equal(body.schema, 'alps.gen2.evidenceScoringState.v1206');
    assert.equal(body.paperOnly, true);
    assert.equal(body.liveCapitalExecution, false);
    assert.equal(body.promotionEnabled, false);
    assert.equal(body.rankingEnabled, false);
  });

  await T('scoring runs asynchronously after candidate cycles and cannot block them', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'v1202-bundle.js'), 'utf8');
    assert(source.includes('this.evidenceScorer.schedule(`candidate-cycle-complete:${reason}`)'));
    assert(!source.includes('await this.evidenceScorer.schedule(`candidate-cycle-complete:${reason}`)'));
  });

  console.log(JSON.stringify({
    status: 'PASS',
    version: VERSION,
    candidateEngineVersion: CANDIDATE_ENGINE_VERSION,
    tests: passed.length,
    names: passed,
    snapshotId: first.lastSnapshotId,
    independentEvaluatedClustersByLeg: first.independentEvaluatedClustersByLeg,
    byState: first.byState,
  }, null, 2));
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
