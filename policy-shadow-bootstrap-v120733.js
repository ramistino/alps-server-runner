'use strict';

const crypto = require('crypto');
const Module = require('module');
const v8 = require('v8');

const target = require.resolve('./policy-shadow-integrity-v12073');
const base = require('./policy-shadow-integrity-v120733');
const v12072 = require('./policy-shadow-integrity-v12072');
const originalLoad = Module._load;

const MEMORY_FIX_VERSION = 'v12.0.7.3.3-m2-resumable-heap-guard';
const TELEMETRY_LIMIT = 16;
const HEAP_CHECK_BATCH = 16;
const SOFT_HEAP_MB = 196;
const HARD_HEAP_MB = 216;
const EXCLUSIONS = new Set([
  'schema','experimentEvidenceClusterId','baseEvidenceClusterId','memberCandidateIds',
  'memberHypothesisIds','families','paperOnly','liveCapitalExecution','promotionEnabled',
  'controlAnchor','controlParity','controlParityStatus','controlParityPolicyDomainExclusions',
  'candleWitnessSegmentHash','sourceReplayVarianceDiagnosticOnly',
]);

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function unique(values) { return [...new Set((values || []).filter(value => value != null && value !== ''))].sort(); }
function mb(value) { return Number((Number(value) / 1048576).toFixed(2)); }
function memory() {
  const value = process.memoryUsage();
  return { heapUsedMb:mb(value.heapUsed), heapTotalMb:mb(value.heapTotal), rssMb:mb(value.rss) };
}
function guards(engine) {
  const value = engine.memoryGuards && typeof engine.memoryGuards === 'object' ? engine.memoryGuards : (engine.memoryGuards = {});
  const heapLimitMb = mb(v8.getHeapStatistics().heap_size_limit);
  const configuredSoft = Number(process.env.ALPS_POLICY_SHADOW_HEAP_SOFT_LIMIT_MB);
  const configuredHard = Number(process.env.ALPS_POLICY_SHADOW_HEAP_HARD_LIMIT_MB);
  const soft = Number.isFinite(configuredSoft) && configuredSoft > 0 ? configuredSoft : Math.min(SOFT_HEAP_MB, heapLimitMb - 56);
  const hard = Number.isFinite(configuredHard) && configuredHard > soft ? configuredHard : Math.min(HARD_HEAP_MB, heapLimitMb - 36);
  Object.assign(value, {
    productionHeapLimitMb:heapLimitMb,
    heapSoftLimitMb:Math.max(96, soft),
    heapHardLimitMb:Math.max(Math.max(96, soft) + 8, hard),
    heapGuardMode:'STREAMING_CANONICAL_HASH_FRAME_RELEASE',
    heapGuardChecks:Number(value.heapGuardChecks || 0),
    heapSoftLimitCrossings:Number(value.heapSoftLimitCrossings || 0),
    heapHardLimitDeferrals:Number(value.heapHardLimitDeferrals || 0),
    releasedSnapshotCacheCount:Number(value.releasedSnapshotCacheCount || 0),
    releasedWitnessFrameCount:Number(value.releasedWitnessFrameCount || 0),
    telemetryRecordLimit:TELEMETRY_LIMIT,
    heapRetryScheduled:Boolean(value.heapRetryScheduled),
    heapRetryCount:Number(value.heapRetryCount || 0),
    heapRetryDelayMs:Number(value.heapRetryDelayMs || 0),
  });
  return value;
}
function metrics(engine) {
  const value = engine.reportingMetrics && typeof engine.reportingMetrics === 'object' ? engine.reportingMetrics : (engine.reportingMetrics = {});
  if (!Number.isFinite(Number(value.policyStateUndefinedMaterializations))) value.policyStateUndefinedMaterializations = 0;
  if (!Array.isArray(value.policyStateUndefinedPaths)) value.policyStateUndefinedPaths = [];
  if (!Array.isArray(value.policyStateUndefinedMaterializationRecords)) value.policyStateUndefinedMaterializationRecords = [];
  value.policyStateUndefinedPaths = value.policyStateUndefinedPaths.slice(-TELEMETRY_LIMIT);
  value.policyStateUndefinedMaterializationRecords = value.policyStateUndefinedMaterializationRecords.slice(-TELEMETRY_LIMIT);
  return value;
}
function context(engine, input = {}) {
  return {
    runId:input.runId || engine.policyBoundaryTelemetry && engine.policyBoundaryTelemetry.currentRunId || null,
    frameKey:input.frameKey || null,
    baseEvidenceClusterId:input.baseEvidenceClusterId || null,
    revisionIndex:Number.isFinite(Number(input.revisionIndex)) ? Number(input.revisionIndex) : null,
    clusterIndex:Number.isFinite(Number(input.clusterIndex)) ? Number(input.clusterIndex) : null,
    armId:input.armId || null,
    side:input.side || null,
  };
}
function recordUndefined(engine, pathFactory, input, observedAt) {
  const value = metrics(engine);
  value.policyStateUndefinedMaterializations += 1;
  if (value.policyStateUndefinedMaterializationRecords.length >= TELEMETRY_LIMIT && value.policyStateUndefinedPaths.length >= TELEMETRY_LIMIT) return;
  const resolved = context(engine, input);
  const undefinedPath = pathFactory();
  const recordKey = [resolved.runId,resolved.frameKey,resolved.baseEvidenceClusterId,resolved.revisionIndex,resolved.clusterIndex,resolved.armId,resolved.side,undefinedPath].join('|');
  if (value.policyStateUndefinedMaterializationRecords.length < TELEMETRY_LIMIT && !value.policyStateUndefinedMaterializationRecords.some(row => row.recordKey === recordKey)) {
    value.policyStateUndefinedMaterializationRecords.push({ recordKey, ...resolved, undefinedPath, observedAt });
  }
  const legacyPath = [resolved.frameKey || 'UNKNOWN_FRAME',resolved.baseEvidenceClusterId || 'UNKNOWN_CLUSTER',resolved.armId || 'UNKNOWN_ARM',resolved.side || 'UNKNOWN_SIDE',undefinedPath].join('|');
  if (value.policyStateUndefinedPaths.length < TELEMETRY_LIMIT && !value.policyStateUndefinedPaths.includes(legacyPath)) value.policyStateUndefinedPaths.push(legacyPath);
}
function canonicalHash(engine, policyState, input = {}) {
  const hash = crypto.createHash('sha256');
  const seen = new WeakSet();
  const path = [];
  const observedAt = iso(engine.now ? engine.now() : Date.now());
  const undefinedValue = () => { recordUndefined(engine, () => `$${path.join('')}`, input, observedAt); hash.update('null'); };
  const write = value => {
    if (value === undefined) return undefinedValue();
    if (value === null) return hash.update('null');
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return hash.update(JSON.stringify(value));
    if (type === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('POLICY_STATE_NON_FINITE_NUMBER');
      return hash.update(JSON.stringify(Object.is(value, -0) ? 0 : value));
    }
    if (type === 'function' || type === 'symbol' || type === 'bigint') throw new TypeError(`POLICY_STATE_UNSUPPORTED_TYPE:${type}`);
    if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) throw new TypeError(`POLICY_STATE_NON_PLAIN_OBJECT:${value.constructor.name}`);
    if (seen.has(value)) throw new TypeError('POLICY_STATE_CYCLE_FORBIDDEN');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        hash.update('[');
        for (let index = 0; index < value.length; index++) {
          if (index) hash.update(',');
          path.push(`[${index}]`);
          try { if (own(value, index)) write(value[index]); else undefinedValue(); }
          finally { path.pop(); }
        }
        return hash.update(']');
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('POLICY_STATE_NON_PLAIN_OBJECT');
      const keys = Object.keys(value).filter(key => !EXCLUSIONS.has(key)).sort();
      hash.update('{');
      for (let index = 0; index < keys.length; index++) {
        if (index) hash.update(',');
        const key = keys[index];
        hash.update(JSON.stringify(key)); hash.update(':'); path.push(`.${key}`);
        try { write(value[key]); } finally { path.pop(); }
      }
      return hash.update('}');
    } finally { seen.delete(value); }
  };
  write(policyState);
  return hash.digest('hex');
}

class HeapGuardDeferral extends Error {
  constructor(snapshot, reason) {
    super(`POLICY_SHADOW_HEAP_GUARD_DEFERRED:${reason}:${snapshot.heapUsedMb}MB`);
    this.code = 'POLICY_SHADOW_HEAP_GUARD_DEFERRED';
  }
}
async function checkHeap(engine, reason) {
  const guard = guards(engine);
  guard.heapGuardChecks += 1;
  let snapshot = memory();
  guard.lastHeapUsedMb = snapshot.heapUsedMb;
  guard.lastHeapCheckAt = iso(engine.now ? engine.now() : Date.now());
  if (snapshot.heapUsedMb < guard.heapSoftLimitMb) return;
  guard.heapSoftLimitCrossings += 1;
  guard.memoryGuardState = 'HEAP_SOFT_GUARD_ACTIVE';
  guard.lastHeapGuardReason = reason;
  metrics(engine);
  if (engine.latestFullSnapshot) { engine.latestFullSnapshot = null; guard.releasedSnapshotCacheCount += 1; }
  await engine.yieldForHealth('POLICY_SHADOW_HEAP_SOFT_GUARD', { phase:'HEAP_SOFT_GUARD', heapUsedMb:snapshot.heapUsedMb });
  snapshot = memory();
  guard.lastHeapUsedMb = snapshot.heapUsedMb;
  if (snapshot.heapUsedMb >= guard.heapHardLimitMb) {
    guard.heapHardLimitDeferrals += 1;
    guard.memoryGuardState = 'HEAP_HARD_GUARD_CYCLE_DEFERRED';
    guard.lastHeapGuardDeferralAt = iso(engine.now ? engine.now() : Date.now());
    throw new HeapGuardDeferral(snapshot, reason);
  }
}
function scopeKeys(engine, outcome) {
  try { return engine.scopesForOutcome(outcome).map(scope => `${scope.scopeType}|${scope.scopeId}`); }
  catch (_) { return ['GLOBAL|GLOBAL']; }
}
function classification(revision, decisionChanged, affectedClusterIds, keys, nowAt) {
  const evidence = { frameKey:revision.frameKey,symbolKey:revision.symbolKey,timeframe:revision.timeframe,candleOpenTime:revision.row.t,firstRowHash:revision.firstRowHash,revisedRowHash:revision.revisedRowHash,changedFields:revision.changedFields,affectedClusterIds:unique(affectedClusterIds),decisionChanged };
  const sourceRecordHash = base.stableHash(evidence);
  const classificationSubjectKey = base.stableHash({ sourceRecordHash,taxonomyHash:base.TAXONOMY_HASH,classificationAlgorithmVersion:base.CLASSIFICATION_ALGORITHM_VERSION });
  const evidenceFingerprint = base.stableHash({ ...evidence,policyCodeFingerprint:base.SHADOW_VERSION });
  const status = decisionChanged ? 'EXCLUSION_VERIFIED' : 'INFORMATIONAL';
  return {
    schema:'alps.gen2.sourceDivergenceClassificationEvent.v12073',serviceVersion:base.SERVICE_VERSION,integrityPatchVersion:base.INTEGRITY_PATCH_VERSION,taxonomyHash:base.TAXONOMY_HASH,classificationAlgorithmVersion:base.CLASSIFICATION_ALGORITHM_VERSION,policyCodeFingerprint:base.SHADOW_VERSION,sourceRecordHash,classificationSubjectKey,classificationEventKey:base.stableHash({ classificationSubjectKey,classificationSequence:1,classificationStatus:status,evidenceFingerprint }),classificationSequence:1,previousClassificationEventKey:null,originType:'WITNESS_ROW_REVISION',terminalClass:decisionChanged?'C_DECISION_CHANGING':'C_NO_CHANGE',classificationStatus:status,transitionReason:'FIRST_COMMITTED_WITNESS_ROW_RETAINED_AND_REVISED_PATH_RECOMPUTED',evidenceFingerprint,observedAt:revision.observedAt || nowAt,classifiedAt:nowAt,timing:Date.parse(revision.observedAt || nowAt) < Date.parse('2026-07-25T18:24:51.000Z') ? 'PRE_PATCH' : 'POST_PATCH',symbolKey:revision.symbolKey,timeframe:revision.timeframe,candleOpenTime:revision.row.t,changedFields:revision.changedFields,affectedClusterIds:unique(affectedClusterIds),scopeKeys:unique(keys),decisionChanged,resolution:'ABSORBED_BY_WITNESS',paperOnly:true,promotionEnabled:false,
  };
}

class MemoryBoundedPolicyShadowEngine extends base.PolicyShadowEngine {
  constructor(...args) { super(...args); guards(this); metrics(this); }
  async init() { await super.init(); guards(this); metrics(this); return this.view(); }

  async processFrameClusters(frameClusters, source, controlStates, controlCutoffMs, witnessEvents) {
    const outcomes = await v12072.PolicyShadowEngine.prototype.processFrameClusters.call(this, frameClusters, source, controlStates, controlCutoffMs, witnessEvents);
    if (!Array.isArray(frameClusters) || !frameClusters.length) return outcomes;
    const frameKey = `${frameClusters[0].symbolKey}|${frameClusters[0].timeframe}`;
    await this.yieldForHealth('FRAME_BASE_PROCESS_COMPLETE', { phase:'FRAME_BASE_PROCESS_COMPLETE',frameKey,clusterCount:frameClusters.length });
    await checkHeap(this, `FRAME_BASE:${frameKey}`);
    const revisions = this.witnessRevisionRecordsByFrame.get(frameKey) || [];
    if (!revisions.length) {
      this.cooperativeYield.lastCompletedFrameKey = frameKey;
      if (this.witnessRowsByFrame.delete(frameKey)) guards(this).releasedWitnessFrameCount += 1;
      return outcomes;
    }
    const rowsRaw = await this.storage.readCrypto(this.config.crypto.cleanDir, frameClusters[0].symbolKey, frameClusters[0].timeframe);
    const authoritativeCandles = this.frameCandles(frameClusters[0].symbolKey, frameClusters[0].timeframe, frameClusters[0].intervalMs, rowsRaw, controlCutoffMs);
    const outcomeById = new Map(outcomes.map(outcome => [outcome.baseEvidenceClusterId,outcome]));
    const total = revisions.length * frameClusters.length;
    let processed = 0, sinceYield = 0, lastYield = Date.now();
    Object.assign(this.cooperativeYield, { inProgress:true,phase:'WITNESS_REVISION_RECOMPUTE',frameKey,revisionCount:revisions.length,clusterCount:frameClusters.length,processedClusterEvaluations:0,totalClusterEvaluations:total,lastProgressAt:iso(this.now()) });
    try {
      for (let revisionIndex = 0; revisionIndex < revisions.length; revisionIndex++) {
        const revision = revisions[revisionIndex];
        await this.yieldForHealth('WITNESS_REVISION_BEGIN', { phase:'WITNESS_REVISION_RECOMPUTE',frameKey,revisionIndex:revisionIndex + 1,revisionCount:revisions.length,clusterIndex:0,clusterCount:frameClusters.length,processedClusterEvaluations:processed,totalClusterEvaluations:total });
        await checkHeap(this, `REVISION_BEGIN:${frameKey}:${revisionIndex + 1}`);
        sinceYield = 0; lastYield = Date.now();
        const revisedCandles = authoritativeCandles.slice();
        const rowIndex = revisedCandles.findIndex(row => row.t === revision.row.t);
        if (rowIndex >= 0) revisedCandles[rowIndex] = { ...revision.row };
        const affected = [], keys = new Set(['GLOBAL|GLOBAL']);
        let changed = false;
        try {
          for (let clusterIndex = 0; clusterIndex < frameClusters.length; clusterIndex++) {
            if (sinceYield && base.shouldCooperativeYield({ processedSinceYield:sinceYield,elapsedMs:Date.now() - lastYield,batchSize:this.cooperativeYield.clusterBatchSize,maxBlockMs:this.cooperativeYield.maxBlockMs })) {
              await this.yieldForHealth('WITNESS_REVISION_CLUSTER_BATCH', { phase:'WITNESS_REVISION_RECOMPUTE',frameKey,revisionIndex:revisionIndex + 1,revisionCount:revisions.length,clusterIndex:clusterIndex + 1,clusterCount:frameClusters.length,processedClusterEvaluations:processed,totalClusterEvaluations:total });
              sinceYield = 0; lastYield = Date.now();
            }
            if (clusterIndex % HEAP_CHECK_BATCH === 0) await checkHeap(this, `CLUSTER:${frameKey}:${revisionIndex + 1}:${clusterIndex + 1}`);
            const cluster = frameClusters[clusterIndex];
            let revisedArms = null;
            try {
              const outcome = outcomeById.get(cluster.baseEvidenceClusterId);
              if (!outcome || outcome.sourceStatus !== 'PASS' || !outcome.arms) continue;
              revisedArms = this.simulateClusterArmsForCandles(cluster, revisedCandles, controlStates, outcome.candleWitnessSegmentHash || base.stableHash({ frameKey,revision:revision.revisedRowHash }));
              if (!revisedArms) {
                changed = true; affected.push(cluster.baseEvidenceClusterId); for (const key of scopeKeys(this,outcome)) keys.add(key);
                outcome.sourceStatus = 'CLASS_C_DECISION_CHANGING_EXCLUSION_VERIFIED';
                outcome.sourceDivergence = unique([...(outcome.sourceDivergence || []),'WITNESS_REVISION_RECOMPUTE_CHANGED_OR_UNAVAILABLE']);
                continue;
              }
              let equal = true;
              for (const armId of unique([...Object.keys(outcome.arms),...Object.keys(revisedArms)])) {
                if (!outcome.arms[armId] || !revisedArms[armId]) { equal = false; break; }
                const input = { frameKey,baseEvidenceClusterId:cluster.baseEvidenceClusterId,revisionIndex:revisionIndex + 1,clusterIndex:clusterIndex + 1,armId };
                if (canonicalHash(this,outcome.arms[armId],{ ...input,side:'AUTHORITATIVE' }) !== canonicalHash(this,revisedArms[armId],{ ...input,side:'REVISED' })) { equal = false; break; }
              }
              if (!equal) {
                changed = true; affected.push(cluster.baseEvidenceClusterId); for (const key of scopeKeys(this,outcome)) keys.add(key);
                outcome.sourceStatus = 'CLASS_C_DECISION_CHANGING_EXCLUSION_VERIFIED';
                outcome.sourceDivergence = unique([...(outcome.sourceDivergence || []),'WITNESS_REVISION_DECISION_CHANGING']);
              }
            } finally {
              if (revisedArms) for (const armId of Object.keys(revisedArms)) revisedArms[armId] = null;
              processed += 1; sinceYield += 1;
              Object.assign(this.cooperativeYield, { clusterIndex:clusterIndex + 1,processedClusterEvaluations:processed,lastProgressAt:iso(this.now()) });
            }
          }
          this.currentWitnessClassifications.push(classification(revision,changed,affected,[...keys],iso(this.now())));
        } finally { revisedCandles.length = 0; affected.length = 0; keys.clear(); }
        await this.yieldForHealth('WITNESS_REVISION_COMPLETE', { phase:'WITNESS_REVISION_RECOMPUTE',frameKey,revisionIndex:revisionIndex + 1,revisionCount:revisions.length,clusterIndex:frameClusters.length,clusterCount:frameClusters.length,processedClusterEvaluations:processed,totalClusterEvaluations:total });
        await checkHeap(this, `REVISION_COMPLETE:${frameKey}:${revisionIndex + 1}`);
        sinceYield = 0; lastYield = Date.now();
      }
    } finally {
      outcomeById.clear(); rowsRaw.length = 0; authoritativeCandles.length = 0;
      this.witnessRevisionRecordsByFrame.delete(frameKey);
      if (this.witnessRowsByFrame.delete(frameKey)) guards(this).releasedWitnessFrameCount += 1;
      Object.assign(this.cooperativeYield, { inProgress:false,phase:'FRAME_COMPLETE',lastCompletedFrameKey:frameKey,lastProgressAt:iso(this.now()) });
      await this.yieldForHealth('WITNESS_FRAME_RECOMPUTE_COMPLETE', { phase:'FRAME_COMPLETE',frameKey,revisionIndex:revisions.length,revisionCount:revisions.length,clusterIndex:frameClusters.length,clusterCount:frameClusters.length,processedClusterEvaluations:processed,totalClusterEvaluations:total });
    }
    return outcomes;
  }

  scheduleHeapRetry(reason = 'heap-guard-retry') {
    const guard = guards(this);
    guard.heapRetryScheduled = true;
    guard.heapRetryCount = Number(guard.heapRetryCount || 0) + 1;
    const delayMs = Math.min(120000, 15000 * (2 ** Math.min(3, Math.max(0, guard.heapRetryCount - 1))));
    guard.heapRetryDelayMs = delayMs;
    guard.heapRetryScheduledAt = iso(this.now ? this.now() : Date.now());
    if (this.heapGuardRetryTimer) return;
    this.heapGuardRetryTimer = setTimeout(() => {
      this.heapGuardRetryTimer = null;
      guard.heapRetryScheduled = false;
      if (this.inFlight) return this.scheduleHeapRetry(reason);
      Promise.resolve(this.run(reason)).catch(error => {
        this.state.lastError = String(error && error.stack || error).slice(0, 2400);
      });
    }, delayMs);
    if (typeof this.heapGuardRetryTimer.unref === 'function') this.heapGuardRetryTimer.unref();
  }

  async settleHeapDeferral(reason, error) {
    const completedAt = iso(this.now ? this.now() : Date.now());
    this.inFlight = false;
    this.pendingReason = null;
    if (this.cooperativeYield && typeof this.cooperativeYield === 'object') {
      Object.assign(this.cooperativeYield, {
        inProgress:false,
        phase:'HEAP_GUARD_DEFERRED_RETRY_PENDING',
        runCompletedAt:completedAt,
        lastYieldReason:'HEAP_GUARD_DEFERRED',
        lastProgressAt:completedAt,
      });
    }
    Object.assign(this.policyBoundaryTelemetry, {
      currentRunId:null,
      currentRunStartedAt:null,
      lastErrorAt:null,
      lastErrorRunId:null,
      lastError:null,
      lastRunOutcome:'DEFERRED_HEAP_GUARD',
    });
    this.state.status = 'POLICY_SHADOW_HEAP_GUARD_DEFERRED_RETRY_PENDING';
    this.state.lastError = null;
    this.state.lastRunCompletedAt = completedAt;
    this.state.lastRunReason = reason;
    this.state.policyBoundaryTelemetry = {
      lastSuccessfulRunId:this.policyBoundaryTelemetry.lastSuccessfulRunId || null,
      lastSuccessfulRunCompletedAt:this.policyBoundaryTelemetry.lastSuccessfulRunCompletedAt || null,
      lastErrorAt:null,
      lastErrorRunId:null,
      lastError:null,
      lastRunOutcome:'DEFERRED_HEAP_GUARD',
    };
    if (Array.isArray(this.currentWitnessClassifications)) this.currentWitnessClassifications.length = 0;
    if (this.latestFullSnapshot) { this.latestFullSnapshot = null; guards(this).releasedSnapshotCacheCount += 1; }
    await this.yieldForHealth('POLICY_SHADOW_HEAP_GUARD_SETTLED', {
      phase:'HEAP_GUARD_DEFERRED_RETRY_PENDING',
      reason,
      error:error && error.message || null,
    }).catch(() => {});
    await this.persistState().catch(() => {});
    this.scheduleHeapRetry('heap-guard-retry');
    return this.view();
  }

  async run(reason = 'scheduled') {
    if (!this.inFlight) {
      try { await checkHeap(this, `RUN_PREFLIGHT:${reason}`); }
      catch (error) {
        if (error && error.code === 'POLICY_SHADOW_HEAP_GUARD_DEFERRED') return this.settleHeapDeferral(reason, error);
        throw error;
      }
    }
    try {
      const result = await base.PolicyShadowEngine.prototype.run.call(this, reason);
      const telemetry = this.policyBoundaryTelemetry || {};
      if (telemetry.lastRunOutcome === 'SUCCESS') {
        const guard = guards(this);
        guard.heapRetryCount = 0;
        guard.heapRetryScheduled = false;
        guard.heapRetryDelayMs = 0;
      }
      return result;
    } catch (error) {
      if (error && error.code === 'POLICY_SHADOW_HEAP_GUARD_DEFERRED') return this.settleHeapDeferral(reason, error);
      throw error;
    } finally {
      if ((this.policyBoundaryTelemetry || {}).lastRunOutcome === 'DEFERRED_HEAP_GUARD') this.inFlight = false;
    }
  }

  view() {
    const value = super.view();
    const guard = guards(this), report = metrics(this), telemetry = this.policyBoundaryTelemetry || {};
    return {
      ...value,
      status:telemetry.lastRunOutcome === 'DEFERRED_HEAP_GUARD' && !this.inFlight ? 'DEFERRED_HEAP_GUARD' : value.status,
      memoryFixVersion:MEMORY_FIX_VERSION,
      lastError:telemetry.lastError || null,
      memoryGuards:{ ...guard },
      reportingMetrics:{ ...report,policyStateUndefinedPaths:[...report.policyStateUndefinedPaths],policyStateUndefinedMaterializationRecords:[...report.policyStateUndefinedMaterializationRecords] },
      policyStateCanonicalization:{ ...(value.policyStateCanonicalization || {}),source:'STREAMING_CANONICAL_SHA256_WITH_FROZEN_METADATA_EXCLUSIONS',memoryMode:'NO_CANONICAL_OBJECT_NO_CANONICAL_JSON_STRING_NO_SHAPE_TREE',telemetryRecordLimit:TELEMETRY_LIMIT,undefinedMaterializationPaths:[...report.policyStateUndefinedPaths],undefinedMaterializationRecords:[...report.policyStateUndefinedMaterializationRecords] },
    };
  }
}

const patched = { ...base, PolicyShadowEngine:MemoryBoundedPolicyShadowEngine, MEMORY_FIX_VERSION };
Module._load = function patchedPolicyShadowLoad(request, parent, isMain) {
  let resolved = null;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) {}
  if (resolved === target) return patched;
  return originalLoad.apply(this, arguments);
};
