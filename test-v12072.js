#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  PolicyShadowEngine,
  INTEGRITY_PATCH_VERSION,
  PREVIOUS_INTEGRITY_PATCH_VERSION,
} = require('./policy-shadow-integrity-v12072');

const FRAME = 300000;
const START = Date.parse('2026-07-25T00:00:00.000Z');

function candles(count = 90) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i * 0.02;
    rows.push({
      t:START + i * FRAME,
      o:base,
      h:base + 0.4,
      l:base - 0.4,
      c:base + (i % 2 ? -0.05 : 0.05),
      v:1000 + i,
      closeTime:START + (i + 1) * FRAME - 1,
      validForSignals:true,
      validForAggregation:true,
    });
  }
  return rows;
}

function queue() {
  return {
    files:new Map(),
    appendFiles:new Map(),
    view:() => ({ revision:0, committedRevision:0, writesStarted:0, writesCommitted:0, writesFailed:0, writing:false }),
    viewAppend:() => ({ revision:0, committedRevision:0, writesStarted:0, writesCommitted:0, writesFailed:0, writing:false }),
  };
}

function nomination({ candidateId, hypothesisId, clusterId, signalIndex, nominatedAt, direction = 'LONG', low = 100.8, high = 101.1, stop = 99.5 }) {
  return {
    schema:'alps.gen2.cryptoForwardShadowLedgerEvent.v12051',
    evidenceClass:'CERTIFIED_FORWARD_V12051',
    type:'CANDIDATE_NOMINATED',
    candidateId,
    hypothesisId,
    evidenceClusterId:clusterId,
    symbol:'BTC/USDT',
    timeframe:'5m',
    family:hypothesisId.split('-').slice(3).join('-'),
    direction,
    signalCandleOpenAt:new Date(START + signalIndex * FRAME).toISOString(),
    signalCandleCloseAt:new Date(START + (signalIndex + 1) * FRAME - 1).toISOString(),
    nominatedAt,
    entryZoneLow:low,
    entryZoneHigh:high,
    plannedInitialStop:stop,
    setupId:`intentionally-not-replayable-${candidateId}`,
    observedAt:nominatedAt,
  };
}

function controlEntered(candidateId, entryCandle, entry = 101, stop = 99.5) {
  const risk = entry - stop;
  return {
    candidateId,
    status:'OPEN_PAPER',
    entry,
    initialStop:stop,
    targets:[1, 2, 5].map(rr => ({ rr, target:entry + risk * rr })),
    entryCandleOpenAt:new Date(entryCandle.t).toISOString(),
    entryCandleCloseAt:new Date(entryCandle.closeTime).toISOString(),
    legs:{
      R1:{ status:'OPEN', target:entry + risk, currentStop:stop, stopStage:'INITIAL' },
      R2:{ status:'OPEN', target:entry + risk * 2, currentStop:stop, stopStage:'INITIAL' },
      R5:{ status:'OPEN', target:entry + risk * 5, currentStop:stop, stopStage:'INITIAL' },
    },
  };
}

function controlPending(candidateId) {
  return {
    candidateId,
    status:'PENDING_FORWARD_ENTRY',
    entry:null,
    initialStop:null,
    targets:[],
    legs:{ R1:{status:'OPEN'}, R2:{status:'OPEN'}, R5:{status:'OPEN'} },
  };
}

(async () => {
  const rows = candles();
  const storage = {
    readCrypto:async () => rows.map(x => ({ ...x })),
    readNdjson:async () => [],
    readJson:async () => null,
  };
  const engine = new PolicyShadowEngine({
    config:{ dataRoot:'/tmp/alps-v12072-test', crypto:{ cleanDir:'/tmp/clean' } },
    storage,
    persistQueue:queue(),
    now:() => START + 90 * FRAME,
  });
  engine.state.experimentEpochAt = new Date(START).toISOString();
  engine.state.witnessHashes = {};
  engine.manifest = { knownUntestedInteractions:[] };

  const signalIndex = 65;
  const clusterId = 'EC51|BTCUSDT|5m|authority-test';
  const firstNomination = new Date(rows[66].t + 1000).toISOString();
  const secondNomination = new Date(rows[66].t + 2500).toISOString();
  const nominations = [
    nomination({ candidateId:'C-A', hypothesisId:'CRYPTO-BTCUSDT-5m-TREND_CONTINUATION', clusterId, signalIndex, nominatedAt:firstNomination }),
    nomination({ candidateId:'C-B', hypothesisId:'CRYPTO-BTCUSDT-5m-VOLATILITY_EXPANSION', clusterId, signalIndex, nominatedAt:secondNomination }),
  ];
  const [cluster] = engine.groupClusters(nominations);
  assert.equal(cluster.nominatedAtMinMs, Date.parse(firstNomination));
  assert.equal(cluster.nominatedAtMaxMs, Date.parse(secondNomination));
  assert.equal(cluster.nominatedAtMs, Date.parse(firstNomination), 'cluster timing anchor must be first certified nomination');

  const entryCandle = rows[68];
  const controlStates = new Map([
    ['C-A', controlEntered('C-A', entryCandle)],
    ['C-B', controlPending('C-B')],
  ]);
  const source = {
    inputFingerprint:{ candidateEngineEpochAt:new Date(START).toISOString() },
    eventsByCandidate:new Map(),
  };
  const witnessEvents = [];
  const outcomes = await engine.processFrameClusters([cluster], source, controlStates, rows.at(-1).closeTime, witnessEvents);
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0];
  assert.equal(outcome.sourceStatus, 'PASS', 'historical setup replay variance must not reject certified nomination authority');
  assert.equal(Object.keys(outcome.arms).length, 6, 'all six frozen arms must be produced');
  assert.equal(outcome.arms.E0_X0.entryStatus, 'ENTERED');
  assert.equal(outcome.arms.E0_X0.entry, 101);
  assert.equal(outcome.arms.E0_X0.controlParityStatus, 'PASS');
  assert.equal(outcome.arms.E0_X0.controlAnchor.anchorCandidateId, 'C-A');
  assert.equal(outcome.arms.E0_X1.entry, outcome.arms.E0_X0.entry, 'time-stop arm must inherit the certified E0 entry decision');
  assert.ok(outcome.sourceReplayVarianceDiagnosticOnly.length > 0, 'replay mismatch must remain visible as diagnostic-only evidence');

  const diagnostics = engine.diagnostics(outcomes, engine.armStatistics(outcomes));
  assert.equal(diagnostics.controlParity.length, 0, 'certified control anchoring removes false cluster/member entry-status parity failures');
  assert.equal(diagnostics.sourceDivergence.length, 0, 'certified nomination authority removes mutable historical replay as a source blocker');
  assert.equal(diagnostics.controlAnchorTimingVarianceDiagnosticOnly.length, 1, 'member timing variance remains transparent');
  assert.ok(diagnostics.sourceReplayVarianceDiagnosticOnly.length > 0);

  const frameKey = 'BTCUSDT|5m';
  const witnessed = { ...rows[10], c:88.88, h:101, l:88, o:100 };
  engine.witnessRowsByFrame.set(frameKey, new Map([[witnessed.t, witnessed]]));
  const merged = engine.frameCandles('BTCUSDT', '5m', FRAME, rows, rows.at(-1).closeTime);
  assert.equal(merged.find(c => c.t === witnessed.t).c, 88.88, 'first committed witness must override a changed current clean row');
  assert.ok(engine.witnessAuthority.currentRowsOverriddenByWitness >= 1);

  assert.equal(INTEGRITY_PATCH_VERSION, 'v12.0.7.2-witness-authority-control-anchor');
  assert.equal(PREVIOUS_INTEGRITY_PATCH_VERSION, 'v12.0.7.1-policy-shadow-integrity-diagnostics');

  console.log(JSON.stringify({
    status:'PASS',
    version:INTEGRITY_PATCH_VERSION,
    tests:5,
    names:[
      'cluster timing uses the first certified nomination rather than a maximum member timestamp',
      'certified nomination fields produce all six arms despite historical strategy replay variance',
      'E0_X0 is anchored to the certified control cluster fold and E0_X1 inherits the exact entry decision',
      'member timing variance and historical replay variance remain visible but diagnostic-only',
      'first committed candle witness overrides mutable current-clean history',
    ],
  }, null, 2));
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
