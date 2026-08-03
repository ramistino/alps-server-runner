'use strict';

const assert = require('assert');
const base = require('./policy-shadow-integrity-v120733');

require('./policy-shadow-bootstrap-v120733');

const patched = require('./policy-shadow-integrity-v12073');
const proto = patched.PolicyShadowEngine.prototype;

(async function runTests() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  try {
    let timerCreations = 0;

    global.setTimeout = (callback, delayMs) => {
      timerCreations += 1;
      return {
        callback,
        delayMs,
        unref() {},
      };
    };

    const scheduledEngine = {
      memoryGuards:{},
      now:() => Date.parse('2026-08-04T00:00:00.000Z'),
      state:{},
      inFlight:false,
      run:async () => null,
    };

    proto.scheduleHeapRetry.call(scheduledEngine, 'first');

    const firstTimer = scheduledEngine.heapGuardRetryTimer;
    const firstCount = scheduledEngine.memoryGuards.heapRetryCount;
    const firstDelay = scheduledEngine.memoryGuards.heapRetryDelayMs;

    proto.scheduleHeapRetry.call(scheduledEngine, 'duplicate');

    assert.strictEqual(timerCreations, 1);
    assert.strictEqual(scheduledEngine.heapGuardRetryTimer, firstTimer);
    assert.strictEqual(scheduledEngine.memoryGuards.heapRetryCount, firstCount);
    assert.strictEqual(scheduledEngine.memoryGuards.heapRetryDelayMs, firstDelay);
    assert.strictEqual(scheduledEngine.memoryGuards.heapRetryScheduled, true);

    const originalBaseRun = base.PolicyShadowEngine.prototype.run;
    const pendingTimer = { unref() {} };
    let clearedTimer = null;

    global.clearTimeout = timer => {
      clearedTimer = timer;
    };

    base.PolicyShadowEngine.prototype.run = async function successfulRun() {
      this.policyBoundaryTelemetry.lastRunOutcome = 'SUCCESS';
      return { ok:true };
    };

    try {
      const successfulEngine = {
        memoryGuards:{
          heapRetryScheduled:true,
          heapRetryCount:3,
          heapRetryDelayMs:60000,
          heapRetryScheduledAt:'2026-08-04T00:00:00.000Z',
        },
        heapGuardRetryTimer:pendingTimer,
        policyBoundaryTelemetry:{ lastRunOutcome:null },
        inFlight:true,
        cancelHeapRetry:proto.cancelHeapRetry,
      };

      const result = await proto.run.call(
        successfulEngine,
        'manual-success',
      );

      assert.deepStrictEqual(result, { ok:true });
      assert.strictEqual(clearedTimer, pendingTimer);
      assert.strictEqual(successfulEngine.heapGuardRetryTimer, null);
      assert.strictEqual(
        successfulEngine.memoryGuards.heapRetryScheduled,
        false,
      );
      assert.strictEqual(successfulEngine.memoryGuards.heapRetryCount, 0);
      assert.strictEqual(successfulEngine.memoryGuards.heapRetryDelayMs, 0);
      assert.strictEqual(
        successfulEngine.memoryGuards.heapRetryScheduledAt,
        null,
      );
    } finally {
      base.PolicyShadowEngine.prototype.run = originalBaseRun;
    }

    assert.strictEqual(
      patched.MEMORY_FIX_VERSION,
      'v12.0.7.3.3-m3-heap-retry-timer-lifecycle',
    );

    console.log(
      'v12.0.7.3.3 heap retry timer lifecycle tests passed',
    );
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
