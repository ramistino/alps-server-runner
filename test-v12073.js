'use strict';

const assert = require('assert');
const {
  INTEGRITY_PATCH_VERSION,
  TAXONOMY_HASH,
  POLICY_STATE_SCHEMA_VERSION,
  QUARANTINE_WATCH_THRESHOLD,
  materializePolicyState,
  canonicalPolicyStateVector,
  canonicalPolicyStateVectorFromEngineState,
  buildTaxonomySummary,
  rekeyComparisonRows,
  paginateRows,
} = require('./policy-shadow-integrity-v12073');

function fakeEngine() {
  return {
    scopesForOutcome(outcome) {
      const rows = [{ scopeType:'GLOBAL', scopeId:'GLOBAL' }];
      for (const id of outcome.memberHypothesisIds || []) {
        const m = /^CRYPTO-([^-]+)-([^-]+)-(.+)$/.exec(id);
        if (!m) continue;
        rows.push({ scopeType:'FAMILY_TIMEFRAME', scopeId:`${m[3]}|${m[2]}` });
        rows.push({ scopeType:'HYPOTHESIS', scopeId:id });
      }
      const seen = new Set();
      return rows.filter(row => {
        const key = `${row.scopeType}|${row.scopeId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  };
}

function arm({ entered = false, status = 'PENDING', hold = 0, resultR = null } = {}) {
  const leg = status === 'OPEN'
    ? { status:'OPEN', holdingBars:hold }
    : status === 'TIME_STOP_EXIT'
      ? { status:'TIME_STOP_EXIT', holdingBars:hold, resultR }
      : { status, holdingBars:hold, resultR };
  return {
    entered,
    resolved:true,
    expired:!entered,
    entryStatus:entered ? 'ENTERED' : 'EXPIRED',
    legs:{ R1:{ ...leg }, R2:{ ...leg }, R5:{ ...leg } },
  };
}

(function canonicalStateTests() {
  const left = {
    entryStatus:'ENTERED',
    entry:100,
    legs:{ R1:{ status:'OPEN', currentStop:95 } },
    schema:'ignored',
  };
  const reordered = {
    schema:'different ignored metadata',
    legs:{ R1:{ currentStop:95, status:'OPEN' } },
    entry:100,
    entryStatus:'ENTERED',
  };
  const a = canonicalPolicyStateVector(left);
  const b = canonicalPolicyStateVector(reordered);
  assert.strictEqual(a.policyStateSchemaVersion, POLICY_STATE_SCHEMA_VERSION);
  assert.strictEqual(a.canonicalPolicyStateHash, b.canonicalPolicyStateHash, 'key order or excluded metadata changed the canonical state');
  assert.strictEqual(a.policyStateShapeHash, b.policyStateShapeHash, 'equivalent shapes must match');

  const changed = canonicalPolicyStateVector({ ...left, newEconomicStateField:'ACTIVE' });
  assert.notStrictEqual(a.canonicalPolicyStateHash, changed.canonicalPolicyStateHash, 'new state field must change canonical hash');
  assert.notStrictEqual(a.policyStateShapeHash, changed.policyStateShapeHash, 'new state field must change shape hash');

  assert.throws(() => canonicalPolicyStateVector({ entryStatus:undefined }), /UNDEFINED_FORBIDDEN/);
  assert.throws(() => canonicalPolicyStateVector({ resultR:NaN }), /NON_FINITE_NUMBER/);

  const engineOptional = canonicalPolicyStateVectorFromEngineState({
    entryStatus:'PENDING',
    entry:undefined,
    legs:{ R1:{ status:'OPEN', resultR:undefined } },
  });
  assert.strictEqual(engineOptional.canonical.entry, null, 'engine-boundary undefined must materialize as explicit null');
  assert.strictEqual(engineOptional.canonical.legs.R1.resultR, null, 'nested engine-boundary undefined must materialize as explicit null');
  assert.deepStrictEqual(engineOptional.undefinedMaterializationPaths, ['$.entry', '$.legs.R1.resultR']);

  const explicitNull = canonicalPolicyStateVectorFromEngineState({
    entryStatus:'PENDING',
    entry:null,
    legs:{ R1:{ status:'OPEN', resultR:null } },
  });
  assert.strictEqual(engineOptional.canonicalPolicyStateHash, explicitNull.canonicalPolicyStateHash, 'undefined materialization must match explicit null');

  const newUndefinedField = canonicalPolicyStateVectorFromEngineState({
    entryStatus:'PENDING',
    entry:undefined,
    newEconomicStateField:undefined,
    legs:{ R1:{ status:'OPEN', resultR:undefined } },
  });
  assert.notStrictEqual(engineOptional.policyStateShapeHash, newUndefinedField.policyStateShapeHash, 'new undefined state field must remain visible in canonical shape');
  assert.ok(newUndefinedField.undefinedMaterializationPaths.includes('$.newEconomicStateField'));

  const materialized = materializePolicyState({ a:undefined, nested:{ b:undefined } });
  assert.deepStrictEqual(materialized.policyState, { a:null, nested:{ b:null } });
  assert.deepStrictEqual(materialized.undefinedPaths, ['$.a', '$.nested.b']);
})();

(function taxonomyTests() {
  const engine = fakeEngine();
  const outcomes = [
    {
      baseEvidenceClusterId:'PASS-1',
      sourceStatus:'PASS',
      symbolKey:'BTCUSDT',
      timeframe:'30m',
      memberHypothesisIds:['CRYPTO-BTCUSDT-30m-MEAN_REVERSION'],
      sourceReplayVarianceDiagnosticOnly:[{ reasons:['SETUP_ID_MISMATCH'] }],
      arms:{ E0_X0:arm(), E0_X1:arm(), E1_X0:arm(), E1_X1:arm(), E2_X0:arm(), E2_X1:arm() },
    },
    {
      baseEvidenceClusterId:'M-1',
      sourceStatus:'CERTIFIED_NOMINATION_AUTHORITY_DIVERGENCE',
      sourceDivergence:['CERTIFIED_MEMBER_ZONE_DIVERGENCE'],
      symbolKey:'BTCUSDT',
      timeframe:'30m',
      memberHypothesisIds:['CRYPTO-BTCUSDT-30m-MEAN_REVERSION'],
      arms:{},
    },
    {
      baseEvidenceClusterId:'D-1',
      sourceStatus:'WITNESS_AUTHORITY_CONFLICT',
      sourceDivergence:['MULTIPLE_COMMITTED_WITNESS_ROWS_FOR_SAME_FRAME_OPEN_TIME'],
      symbolKey:'ETHUSDT',
      timeframe:'15m',
      memberHypothesisIds:['CRYPTO-ETHUSDT-15m-TREND_CONTINUATION'],
      arms:{},
    },
  ];
  const summary = buildTaxonomySummary(engine, outcomes, '2026-07-26T12:00:00.000Z');
  assert.strictEqual(summary.sourceDivergenceCountHistoricalTotal, 2);
  assert.strictEqual(summary.historicalReplayVarianceDiagnosticOnlyCount, 1);
  assert.strictEqual(summary.economicSourceDivergenceCount, 2);
  assert.strictEqual(summary.permanentlyExcludedClusterCount, 1);
  assert.strictEqual(summary.unresolvedEconomicDivergenceCount, 1);
  assert.strictEqual(summary.byScope['GLOBAL|GLOBAL'].preQuarantineEligibleClusterCount, 1);
  assert.strictEqual(summary.events.filter(row => row.terminalClass === 'R_NOMINATION_REPLAY_VARIANCE_DIAGNOSTIC_ONLY').length, 1);
  assert.strictEqual(summary.events.filter(row => row.terminalClass === 'M_CLUSTER_MEMBER_ECONOMIC_DIVERGENCE').length, 1);
  assert.strictEqual(summary.events.filter(row => row.terminalClass === 'D_SOURCE_AUTHORITY_VIOLATION').length, 1);
})();

(function gateAndTailTests() {
  const engine = fakeEngine();
  const outcomes = [
    {
      baseEvidenceClusterId:'P-1', sourceStatus:'PASS', symbolKey:'BTCUSDT', timeframe:'30m', signalCandleOpenTime:1,
      memberHypothesisIds:['CRYPTO-BTCUSDT-30m-MEAN_REVERSION'],
      arms:{ E0_X0:arm({ entered:true, status:'OPEN', hold:60 }), E0_X1:arm({ entered:true, status:'TIME_STOP_EXIT', hold:24, resultR:0.1 }) },
    },
    {
      baseEvidenceClusterId:'P-2', sourceStatus:'PASS', symbolKey:'ETHUSDT', timeframe:'30m', signalCandleOpenTime:2,
      memberHypothesisIds:['CRYPTO-ETHUSDT-30m-MEAN_REVERSION'],
      arms:{ E0_X0:arm({ entered:true, status:'OPEN', hold:40 }), E0_X1:arm({ entered:true, status:'OPEN', hold:10 }) },
    },
  ];
  const taxonomy = buildTaxonomySummary(engine, outcomes, '2026-07-26T12:00:00.000Z');
  const baseRows = [{
    scopeType:'GLOBAL', scopeId:'GLOBAL', comparisonId:'E0_X0_VS_X1', comparisonKind:'EXIT_POLICY',
    leftArm:'E0_X0', rightArm:'E0_X1', leg:'R1', pairedClusterCount:60,
    reviewBlockers:['CLUSTER_MEMBER_OR_SOURCE_DIVERGENCE_PRESENT'], state:'SCREENING_ONLY',
  }];
  const rows = rekeyComparisonRows(engine, baseRows, outcomes, taxonomy);
  assert.deepStrictEqual(rows[0].reviewBlockers, [], 'legacy blocker must be retired when no unresolved economic divergence exists');
  assert.strictEqual(rows[0].state, 'STEP7_REVIEW_ELIGIBLE_NO_AUTOMATIC_PROMOTION');
  assert.strictEqual(rows[0].leftOpenClusterCount, 2);
  assert.strictEqual(rows[0].rightOpenClusterCount, 1);
  assert.strictEqual(rows[0].openCountDifference, -1);
  assert.strictEqual(rows[0].openCountReductionRate, 0.5);
  assert.strictEqual(rows[0].rightTimeStopExitCount, 1);
  assert.strictEqual(rows[0].timeStopExitCountDifference, 1);
})();

(function paginationTests() {
  const rows = Array.from({ length:125 }, (_, index) => ({ id:index + 1 }));
  const result = paginateRows(rows, { page:'2', pageSize:'50' });
  assert.strictEqual(result.rows.length, 50);
  assert.strictEqual(result.rows[0].id, 51);
  assert.strictEqual(result.pagination.totalRows, 125);
  assert.strictEqual(result.pagination.totalPages, 3);
  assert.strictEqual(result.pagination.hasNextPage, true);
  assert.strictEqual(result.pagination.hasPreviousPage, true);
})();

assert.ok(/^v12\.0\.7\.3/.test(INTEGRITY_PATCH_VERSION));
assert.strictEqual(typeof TAXONOMY_HASH, 'string');
assert.strictEqual(TAXONOMY_HASH.length, 64);
assert.strictEqual(QUARANTINE_WATCH_THRESHOLD, 0.20);

console.log('v12.0.7.3 taxonomy/reporting/memory integrity tests passed');
