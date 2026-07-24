#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  cleanCandles,
  aggregateCanonicalCandles,
  auditContinuity,
  SafeStorage,
  updateForwardShadowFoundation,
  CRYPTO_SYMBOLS,
  CRYPTO_FRAMES,
} = require('./v1202-bundle');

function candle(t, price, flat = false) {
  if (flat) return { t, o:price, h:price, l:price, c:price, v:1, closeTime:t+300000-1 };
  return { t, o:price, h:price+2, l:price-2, c:price+1, v:1, closeTime:t+300000-1 };
}

(async () => {
  const interval5m = 300000;
  const interval15m = 900000;
  const start = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
  const now = start + 40 * interval5m;
  const raw = Array.from({ length:36 }, (_, i) => candle(start + i*interval5m, 100+i, i === 10));

  const cleaned = cleanCandles(raw, {
    now,
    intervalMs:interval5m,
    closeBufferMs:15000,
    staleMs:interval5m*4,
    assetClass:'CRYPTO',
    removeFlat:true,
    preserveFlatForAggregation:true,
  });
  assert.equal(cleaned.candles.length, 36, 'flat bar must remain in the canonical timeline');
  assert.equal(cleaned.quality.flat, 1);
  assert.equal(cleaned.quality.signalEligible, 35);
  assert.equal(cleaned.quality.aggregationEligible, 36);
  assert.equal(cleaned.candles[10].validForSignals, false);
  assert.equal(cleaned.candles[10].validForAggregation, true);

  const baseAudit = auditContinuity(cleaned.candles, interval5m);
  assert.equal(baseAudit.continuityPassed, true);
  assert.equal(baseAudit.missingBars, 0);
  assert.equal(baseAudit.expectedBars, 36);
  assert.equal(baseAudit.actualBars, 36);

  const derived15m = aggregateCanonicalCandles(cleaned.candles, interval5m, interval15m);
  assert.equal(derived15m.length, 12, 'flat 5m source must not break 15m rollup');
  const derivedClean = cleanCandles(derived15m, {
    now,
    intervalMs:interval15m,
    closeBufferMs:15000,
    staleMs:interval15m*4,
    assetClass:'CRYPTO',
    removeFlat:true,
    preserveFlatForAggregation:true,
  });
  const derivedAudit = auditContinuity(derivedClean.candles, interval15m);
  assert.equal(derivedAudit.continuityPassed, true);
  assert.equal(derivedAudit.missingBars, 0);

  const withGap = cleaned.candles.filter((_, i) => i !== 20);
  const gapAudit = auditContinuity(withGap, interval5m);
  assert.equal(gapAudit.continuityPassed, false);
  assert.equal(gapAudit.missingBars, 1);
  assert.equal(gapAudit.gapRanges.length, 1);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v12043-'));
  const config = {
    dataRoot:path.join(tempRoot, 'v12'),
    legacyRoot:path.join(tempRoot, 'v11'),
    forex:{rawDir:path.join(tempRoot,'v12','raw'),cleanDir:path.join(tempRoot,'v12','clean')},
    crypto:{
      rawDir:path.join(tempRoot,'v12','crypto','raw'),
      cleanDir:path.join(tempRoot,'v12','crypto','clean'),
      forwardShadowFile:path.join(tempRoot,'v12','state','crypto-forward-shadow-foundation.json'),
    },
    cryptoSymbols:CRYPTO_SYMBOLS,
    cryptoFrames:CRYPTO_FRAMES,
  };
  const storage = new SafeStorage(config);
  await storage.init();
  assert.throws(() => storage.assertV12Write(path.join(config.legacyRoot, 'blocked.json')), /V11_WRITE_BLOCKED|WRITE_OUTSIDE_V12_ROOT_BLOCKED/);

  const epochAt = new Date(start + 5*interval5m).toISOString();
  const foundation = {
    schema:'alps.gen2.cryptoForwardShadowFoundation.v12043',
    version:'v12.0.4.3-continuity-forward-shadow-foundation',
    epochAt,
    mode:'OBSERVATION_ONLY',
    executionEnabled:false,
    promotionEnabled:false,
    frames:{},
  };
  const data = {};
  const frameState = {};
  const continuity = { frames:{} };
  for (const symbol of CRYPTO_SYMBOLS) {
    for (const frame of CRYPTO_FRAMES) {
      const key = `${symbol.key}:${frame.key}`;
      data[key] = [];
      frameState[key] = { cleanRows:0, stale:true };
      continuity.frames[key] = { continuityPassed:false };
    }
  }
  data['BTCUSDT:5m'] = cleaned.candles;
  frameState['BTCUSDT:5m'] = { cleanRows:cleaned.candles.length, stale:false };
  continuity.frames['BTCUSDT:5m'] = { continuityPassed:true };
  const updated = await updateForwardShadowFoundation({
    config,
    storage,
    now:() => now,
    foundation,
    data,
    frameState,
    continuity,
  });
  assert(updated.frames['BTCUSDT:5m'].observationCount > 0, 'post-epoch closed candles must be recorded');
  assert.equal(updated.frames['BTCUSDT:5m'].forwardShadowEligible, false);
  assert.equal(updated.forwardShadowEligible, 0);
  assert.equal(updated.executionEnabled, false);
  assert.equal(updated.activationVersionRequired, 'v12.0.5');

  console.log(JSON.stringify({
    status:'PASS',
    version:'v12.0.4.3-continuity-forward-shadow-foundation',
    flatPreserved:true,
    canonicalContinuity:baseAudit.status,
    derivedContinuity:derivedAudit.status,
    gapDetection:gapAudit.status,
    forwardFoundation:updated.status,
    v11WriteGuard:true,
  }, null, 2));
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
