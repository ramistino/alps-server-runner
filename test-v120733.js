'use strict';

const assert = require('assert');
const {
  materializePolicyStateAtBoundary,
  canonicalPolicyStateVectorAtBoundary,
  canonicalPolicyStateVector,
  INTEGRITY_PATCH_VERSION,
} = require('./policy-shadow-integrity-v120733');

function fakeEngine() {
  return {
    reportingMetrics:{},
    policyBoundaryTelemetry:{ currentRunId:'TEST-RUN' },
    now:() => Date.parse('2026-07-26T18:00:00.000Z'),
  };
}

(function materializesNestedUndefinedAndSparseArrays() {
  const source = {
    entry:undefined,
    legs:{ R1:{ resultR:undefined } },
    sparse:new Array(3),
  };
  source.sparse[1] = undefined;
  source.sparse[2] = { value:undefined };

  const result = materializePolicyStateAtBoundary(source);
  assert.deepStrictEqual(result.policyState, {
    entry:null,
    legs:{ R1:{ resultR:null } },
    sparse:[null, null, { value:null }],
  });
  assert.deepStrictEqual(result.undefinedPaths, [
    '$.entry',
    '$.legs.R1.resultR',
    '$.sparse[0]',
    '$.sparse[1]',
    '$.sparse[2].value',
  ]);
})();

(function canonicalizesAtFinalComparisonBoundary() {
  const engine = fakeEngine();
  const result = canonicalPolicyStateVectorAtBoundary(engine, {
    entryStatus:'PENDING',
    entry:undefined,
    legs:{ R1:{ status:'OPEN', resultR:undefined } },
  }, {
    frameKey:'BNBUSDT|15m',
    baseEvidenceClusterId:'cluster-1',
    revisionIndex:1,
    clusterIndex:4,
    armId:'E1_X1',
    side:'REVISED',
  });

  assert.strictEqual(result.canonical.entry, null);
  assert.strictEqual(result.canonical.legs.R1.resultR, null);
  assert.strictEqual(result.undefinedMaterializationCount, 2);
  assert.strictEqual(engine.reportingMetrics.policyStateUndefinedMaterializations, 2);
  assert.strictEqual(engine.reportingMetrics.policyStateUndefinedMaterializationRecords.length, 2);
  assert.strictEqual(engine.reportingMetrics.policyStateUndefinedMaterializationRecords[0].runId, 'TEST-RUN');
  assert.strictEqual(engine.reportingMetrics.policyStateUndefinedMaterializationRecords[0].frameKey, 'BNBUSDT|15m');
})();

(function strictCanonicalizerStillFailsClosed() {
  assert.throws(
    () => canonicalPolicyStateVector({ entry:undefined }),
    /POLICY_STATE_UNDEFINED_FORBIDDEN/,
  );
})();

(function unsupportedValuesRemainFailClosedWithContext() {
  const engine = fakeEngine();
  assert.throws(
    () => canonicalPolicyStateVectorAtBoundary(engine, { callback:() => true }, {
      frameKey:'BTCUSDT|5m',
      baseEvidenceClusterId:'cluster-2',
      armId:'E0_X0',
      side:'AUTHORITATIVE',
    }),
    /POLICY_STATE_CANONICALIZATION_FAILED:BTCUSDT\|5m:cluster-2:E0_X0:AUTHORITATIVE:POLICY_STATE_UNSUPPORTED_TYPE:function/,
  );
  assert.strictEqual(engine.reportingMetrics.policyStateCanonicalizationFailures, 1);
  assert.strictEqual(engine.reportingMetrics.lastPolicyStateCanonicalizationFailure.armId, 'E0_X0');
})();

assert.strictEqual(INTEGRITY_PATCH_VERSION, 'v12.0.7.3.3-policy-state-boundary-canonicalization-fix');
console.log('v12.0.7.3.3 policy-state boundary canonicalization tests passed');
