'use strict';

const { ageSec, asArray, bool, finite, firstDefined, iso, text, timestamp } = require('./utils');

function latestEvidence(...values) {
  let best = null;
  let bestTs = 0;
  for (const value of values) {
    const ts = timestamp(value);
    if (ts > bestTs) {
      bestTs = ts;
      best = value;
    }
  }
  return best;
}

function layer({ name, evidenceField, evidenceAt, maxAgeSec, ready = true, detail = {}, now = Date.now() }) {
  const age = ageSec(evidenceAt, now);
  const hasEvidence = Number.isFinite(age);
  const fresh = Boolean(ready && hasEvidence && age <= maxAgeSec);
  return {
    name,
    fresh,
    ready:Boolean(ready),
    evidenceField,
    evidenceAt:evidenceAt ? iso(evidenceAt) : null,
    ageSec:Number.isFinite(age) ? Math.round(age * 1000) / 1000 : null,
    maxAgeSec,
    status:fresh ? 'FRESH' : (!ready ? 'NOT_READY' : (hasEvidence ? 'STALE' : 'NO_EVIDENCE')),
    ...detail,
  };
}

function deriveFreshness({
  legacyVersion,
  live,
  candidateAuthority,
  candleDepth,
  chartTruth,
  serverFeatures,
  runtimeMeta = {},
  adapterStatus = {},
  strategyHeartbeat = {},
  candidateCohort = {},
  now = Date.now(),
  config,
}) {
  const current = live && live.currentHealth || {};
  const learning = live && live.adaptiveEvidenceLearning || current.adaptiveEvidenceLearning || {};

  const processAt = firstDefined(runtimeMeta.fastLastSuccessAt, runtimeMeta.liveLastSuccessAt, runtimeMeta.versionLastSuccessAt);
  const sentinelAt = firstDefined(
    current.sentinelLastTickAt,
    live && live.currentHealthFreshness && live.currentHealthFreshness.latestEvidenceAt
  );
  const candidateAt = latestEvidence(
    candidateCohort && candidateCohort.lastSeenAt,
    candidateAuthority && candidateAuthority.generatedAt,
    current.candidateAuthorityGeneratedAt,
    processAt
  );
  const strategyAt = firstDefined(
    strategyHeartbeat && strategyHeartbeat.lastHealthyAt,
    current.runtimeObservationAt,
    live && live.runtimeObservationAt
  );
  const researchAt = firstDefined(
    strategyHeartbeat && strategyHeartbeat.lastResearchCycleAt,
    strategyAt
  );
  const serverFeatureAt = firstDefined(
    serverFeatures && serverFeatures.lastRefreshCompletedAt,
    serverFeatures && serverFeatures.generatedAt
  );
  const pendingProofAt = asArray(current.pendingEntryProof)
    .map(row => row && row.priceAt)
    .filter(Boolean)
    .sort()
    .slice(-1)[0];
  const paperAt = latestEvidence(
    current.paperEntryLastScanAt,
    current.pendingEntryLastScanAt,
    current.paperEntryVisibilityLastScanAt,
    pendingProofAt,
    current.sentinelLastPriceFetchAt,
    sentinelAt
  );
  const learningAt = firstDefined(learning.generatedAt, current.learningGeneratedAt);
  const candleAt = firstDefined(serverFeatureAt, candleDepth && candleDepth.generatedAt, researchAt);
  const chartAt = firstDefined(serverFeatureAt, chartTruth && chartTruth.generatedAt, current.chartTruthGeneratedAt);

  const required = Math.max(1, finite(
    serverFeatures && serverFeatures.requiredPairFrames,
    finite(live && live.requiredFeaturePairFrames, config.expectedPairFrames)
  ));
  const featureRows = Math.max(0, finite(serverFeatures && serverFeatures.freshFeaturePairFrames, 0));
  const featureReady = bool(serverFeatures && serverFeatures.ready) && featureRows >= required;
  const candleFrames = Math.max(0, finite(
    serverFeatures && serverFeatures.loaded,
    finite(current.canonicalCandlePairFrames, candleDepth && candleDepth.pairFrames || 0)
  ));
  const candleReady = candleFrames >= required;

  const processReady = Boolean(
    adapterStatus && adapterStatus.running &&
    legacyVersion && typeof legacyVersion === 'object' &&
    live && typeof live === 'object'
  );
  const sentinelReady = text(current.sentinelRuntimeStatus).includes('RUNNING') ||
    text(current.priceSentinelStatus).includes('RUNNING');
  const candidateReady = finite(live && live.forwardLatchSize, 0) > 0 &&
    finite(live && live.nativePoolCandidates, 0) > 0;
  const paperReady = finite(live && live.openPositions, 0) >= 0 &&
    finite(current.watchedPendingEntries, current.pendingEntries || 0) >= 0;
  const learningReady = bool(learning.installed) && text(learning.status).includes('ACTIVE');
  const strategyReady = Boolean(
    strategyHeartbeat &&
    strategyHeartbeat.labRunning &&
    strategyHeartbeat.researchReady
  );
  const researchReady = Boolean(featureReady && strategyReady && strategyHeartbeat.candidateFlowReady);
  const chartReady = featureReady || (bool(current.chartTruthReady) && finite(current.chartCandles, 0) > 0);

  return {
    process:layer({
      name:'process',
      evidenceField:'controlPlane.fastPoll.lastSuccessAt',
      evidenceAt:processAt,
      maxAgeSec:config.processFreshMaxSec,
      ready:processReady,
      now,
      detail:{
        adapterRunning:Boolean(adapterStatus && adapterStatus.running),
        runtimeBootReady:bool(legacyVersion && legacyVersion.runtimeBootReady),
        browserServerReady:bool(legacyVersion && legacyVersion.browserServerReady),
      },
    }),
    candleBank:layer({
      name:'candleBank',
      evidenceField:'v102ServerFeatureEngine.lastRefreshCompletedAt',
      evidenceAt:candleAt,
      maxAgeSec:config.researchFreshMaxSec,
      ready:candleReady,
      now,
      detail:{ pairFrames:candleFrames, requiredPairFrames:required, authority:'SERVER_CLOSED_CANDLE_BANK' },
    }),
    featureEngine:layer({
      name:'featureEngine',
      evidenceField:'v102ServerFeatureEngine.lastRefreshCompletedAt',
      evidenceAt:serverFeatureAt,
      maxAgeSec:config.researchFreshMaxSec,
      ready:featureReady,
      now,
      detail:{
        freshPairFrames:featureRows,
        requiredPairFrames:required,
        coverageStatus:text(serverFeatures && serverFeatures.status, 'UNKNOWN'),
        authority:'V102_SERVER_FEATURE_ENGINE',
      },
    }),
    strategyEngine:layer({
      name:'strategyEngine',
      evidenceField:'controlPlane.strategyHeartbeat.lastHealthyAt',
      evidenceAt:strategyAt,
      maxAgeSec:config.researchFreshMaxSec,
      ready:strategyReady,
      now,
      detail:{
        strategyHeartbeat,
        rawLabRunning:bool(live && live.labRunning),
        adapterOnly:true,
        authority:'FAST_LIVE_RESEARCH_HEARTBEAT',
      },
    }),
    researchCycle:layer({
      name:'researchCycle',
      evidenceField:'controlPlane.strategyHeartbeat.lastResearchCycleAt',
      evidenceAt:researchAt,
      maxAgeSec:config.researchFreshMaxSec,
      ready:researchReady,
      now,
      detail:{
        researchReady,
        serverFeaturesReady:featureReady,
        strategyEngineReady:strategyReady,
        candidateFlowReady:Boolean(strategyHeartbeat && strategyHeartbeat.candidateFlowReady),
        authority:'FAST_RESEARCH_CONTROL_HEARTBEAT',
      },
    }),
    candidatePipeline:layer({
      name:'candidatePipeline',
      evidenceField:'candidateCohort.lastSeenAt',
      evidenceAt:candidateAt,
      maxAgeSec:config.researchFreshMaxSec,
      ready:candidateReady,
      now,
      detail:{
        candidates:finite(live && live.candidates, 0),
        nativePoolCandidates:finite(live && live.nativePoolCandidates, 0),
        forwardLatchSize:finite(live && live.forwardLatchSize, 0),
        cohortStatus:text(candidateCohort && candidateCohort.status, 'WAITING_FOR_COHORT'),
        cohortId:candidateCohort && candidateCohort.cohortId || null,
      },
    }),
    paperEntry:layer({
      name:'paperEntry',
      evidenceField:'paperEntryLastScanAt/sentinelLastPriceFetchAt',
      evidenceAt:paperAt,
      maxAgeSec:config.paperFreshMaxSec,
      ready:paperReady,
      now,
      detail:{
        visibilitySeen:finite(live && live.paperEntryVisibilityCandidatesSeen, 0),
        pendingEntries:finite(current.pendingEntries, 0),
        openPositions:finite(live && live.openPositions, 0),
      },
    }),
    sentinel:layer({
      name:'sentinel',
      evidenceField:'sentinelLastTickAt',
      evidenceAt:sentinelAt,
      maxAgeSec:config.sentinelFreshMaxSec,
      ready:sentinelReady,
      now,
      detail:{
        consecutiveFailures:finite(current.sentinelConsecutiveFailures, 0),
        lastError:text(current.sentinelLastError),
      },
    }),
    learning:layer({
      name:'learning',
      evidenceField:'adaptiveEvidenceLearning.generatedAt',
      evidenceAt:learningAt,
      maxAgeSec:config.learningFreshMaxSec,
      ready:learningReady,
      now,
      detail:{
        closedFamilies:finite(learning.independentExperimentFamilies, 0),
        status:text(learning.status, 'UNKNOWN'),
      },
    }),
    chart:layer({
      name:'chart',
      evidenceField:'chartTruth.generatedAt',
      evidenceAt:chartAt,
      maxAgeSec:config.researchFreshMaxSec,
      ready:chartReady,
      now,
      detail:{
        chartTruthReady:chartReady,
        chartCandles:featureReady ? 300 : finite(current.chartCandles, 0),
        authority:featureReady ? 'V102_SERVER_FEATURE_CANDLES' : 'LEGACY_CHART',
      },
    }),
  };
}

module.exports = { deriveFreshness, layer, latestEvidence };
