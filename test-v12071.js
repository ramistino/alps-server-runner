#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  PolicyShadowEngine,
  INTEGRITY_PATCH_VERSION,
  compareControlIntegrity,
} = require('./policy-shadow-integrity-v12071');

function openLeg(rr, overrides = {}) {
  return {
    rr,
    status:'OPEN',
    target:100 + rr * 10,
    currentStop:90,
    stopStage:'INITIAL',
    resultR:null,
    exitPrice:null,
    closeReason:null,
    exitCandleOpenAt:null,
    exitCandleCloseAt:null,
    ...overrides,
  };
}

function enteredArm(overrides = {}) {
  return {
    entryStatus:'ENTERED',
    entry:100,
    initialStop:90,
    entryCandleOpenAt:'2026-07-25T00:00:00.000Z',
    entryCandleCloseAt:'2026-07-25T00:04:59.999Z',
    legs:{ R1:openLeg(1), R2:openLeg(2), R5:openLeg(5) },
    ...overrides,
  };
}

function enteredControl(overrides = {}) {
  return {
    status:'OPEN_PAPER',
    entry:100,
    initialStop:90,
    entryCandleOpenAt:'2026-07-25T00:00:00.000Z',
    entryCandleCloseAt:'2026-07-25T00:04:59.999Z',
    legs:{ R1:openLeg(1), R2:openLeg(2), R5:openLeg(5) },
    ...overrides,
  };
}

(function testMinimumRiskDomainExclusion() {
  const sim = enteredArm({
    entryStatus:'INVALID_RISK_DISTANCE',
    invalidReason:'RISK_DISTANCE_BELOW_025_ATR',
    entryRiskDistanceATR:0.18,
    legs:undefined,
  });
  const result = compareControlIntegrity(sim, enteredControl());
  assert.equal(result.status, 'PASS');
  assert.equal(result.policyDomainExclusion.code, 'MINIMUM_ENTRY_RISK_DISTANCE_ATR_GUARD');
})();

(function testClosedTargetIgnoresNonEconomicStaleStopTelemetry() {
  const closed = {
    status:'TARGET_HIT',
    target:110,
    resultR:1,
    exitPrice:110,
    closeReason:'TARGET_HIT',
    exitCandleOpenAt:'2026-07-25T00:05:00.000Z',
    exitCandleCloseAt:'2026-07-25T00:09:59.999Z',
  };
  const sim = enteredArm({ legs:{ R1:{...closed,currentStop:100,stopStage:'BREAKEVEN'}, R2:openLeg(2), R5:openLeg(5) } });
  const control = enteredControl({ legs:{ R1:{...closed,currentStop:90,stopStage:'INITIAL'}, R2:openLeg(2), R5:openLeg(5) } });
  assert.equal(compareControlIntegrity(sim, control).status, 'PASS');
  control.legs.R1.resultR = -1;
  assert.equal(compareControlIntegrity(sim, control).status, 'CONTROL_PARITY_DIVERGENCE');
})();

(function testOneTimePersistenceNormalization() {
  const file = '/tmp/policy-state.json';
  const stale = { writing:true, writesStarted:1, writesCommitted:1, writesFailed:0, pending:null, retryTimer:null };
  const queue = {
    files:new Map([[file, stale]]),
    appendFiles:new Map(),
    view:() => ({ revision:1, committedRevision:1, writing:stale.writing, writesStarted:1, writesCommitted:1, writesFailed:0 }),
    viewAppend:() => ({ revision:0, committedRevision:0, writing:false, writesStarted:0, writesCommitted:0, writesFailed:0 }),
  };
  const engine = new PolicyShadowEngine({
    config:{ dataRoot:'/tmp/alps-v12-test', crypto:{} },
    storage:{},
    persistQueue:queue,
    now:() => Date.parse('2026-07-25T00:00:00.000Z'),
  });
  engine.repairPersistenceInvariant();
  const once = engine.state.persistenceInvariantRepairs;
  assert.equal(once, 1);
  stale.writing = true;
  engine.repairPersistenceInvariant();
  assert.equal(engine.state.persistenceInvariantRepairs, once, 'same file must not inflate the counter again');
  assert.equal(engine.state.persistenceInvariantRepairsSincePatch, 1);
})();

assert.equal(INTEGRITY_PATCH_VERSION, 'v12.0.7.1-policy-shadow-integrity-diagnostics');
console.log(JSON.stringify({
  status:'PASS',
  version:INTEGRITY_PATCH_VERSION,
  tests:3,
  names:[
    '0.25 ATR control-policy domain exclusion is transparent and non-divergent',
    'semantic closed-leg parity ignores non-economic stale stop telemetry',
    'persistence repair telemetry normalizes each file at most once',
  ],
}, null, 2));
